#!/bin/bash
# Round 5 on one Spot GPU VM, start to finish: label the Oct 12 frames (label5.py), build the dataset (round 4's + the new
# frames), fine-tune the round-4 model, evaluate both on the validation frames, export ONNX (fp16, the ThinkPad's crop
# shape). Runs as the VM's startup script (root) and resumes after a reclaim: every stage leaves a marker in the bucket
# and pushes its output there. Done when gs://.../r5/ALL_DONE exists (supervise5.sh then deletes the VM).
B=gs://gengalactic-tools-table-cv/r5
W=/opt/r5
mkdir -p $W && cd $W
exec >> $W/r5.log 2>&1
echo "=== boot $(date)"
done_() { gsutil -q stat $B/markers/$1; }
mark() { echo ok | gsutil -q cp - $B/markers/$1; echo "=== $1 $(date)"; }
fail() { echo "FAILED: $1"; gsutil -q cp $W/r5.log $B/r5.log; echo "$1" | gsutil -q cp - $B/markers/FAILED; shutdown -h now; exit 1; }
done_ ALL_DONE && { echo "already done"; exit 0; }
( while true; do sleep 120; gsutil -q cp $W/r5.log $B/r5.log; done ) &
export PATH=$HOME/.local/bin:$PATH
python3 -c "import ultralytics, transformers, sam2" 2>/dev/null || {
  python3 -m pip install -q ultralytics "transformers>=4.45,<5" accelerate onnx onnxslim onnxconverter-common
  python3 -m pip uninstall -y -q torchaudio || true
  SAM2_BUILD_CUDA=0 python3 -m pip install -q "git+https://github.com/facebookresearch/sam2.git"
  python3 -m pip uninstall -y -q opencv-python || true; python3 -m pip install -q --force-reinstall --no-deps opencv-python-headless
}
[ -f sam2.1_hiera_large.pt ] || wget -q https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_large.pt
until gsutil -q stat $B/in/READY; do sleep 30; done
mkdir -p r5/seq && gsutil -m -q rsync -r $B/in/seq r5/seq
gsutil -q cp $B/in/prev.pt $B/in/label4.py $B/in/label5.py .
N=$(nvidia-smi -L | wc -l); echo "GPUS $N"
stage() {   # one label5 stage on every GPU; outputs synced to the bucket
  pids=""
  for k in $(seq 0 $((N - 1))); do CUDA_VISIBLE_DEVICES=$k python3 label5.py $1 --shard $k --nshards $N > log_$1_$k.txt 2>&1 & pids="$pids $!"; done
  wait $pids                                                     # (a bare wait would also wait for the log-push loop: forever)
  if grep -l Traceback log_$1_*.txt; then cat log_$1_*.txt | tail -30; fail "stage $1"; fi
}
gsutil -m -q rsync -r $B/work work 2>/dev/null; gsutil -m -q rsync -r $B/labels labels 2>/dev/null
if gsutil -q stat $B/markers/REDO; then                         # re-vote with a fixed label5.py: keep the detections, redo the
  echo "=== REDO $(date)"                                       # SAM chunks whose prompts change, rebuild, retrain from scratch
  cp work/prompts.json work/prompts_prev.json
  for m in fuse sam review dataset train eval export; do gsutil -q rm $B/markers/$m 2>/dev/null; done
  gsutil -m -q rm -r $B/runs 2>/dev/null; rm -rf runs
  gsutil -q rm $B/markers/REDO
fi
done_ detect || { ( while true; do sleep 180; gsutil -m -q rsync -r work $B/work; done ) & P=$!; stage detect; kill $P; gsutil -m -q rsync -r work $B/work; mark detect; }
done_ fuse || { python3 label5.py fuse && { [ ! -f work/prompts_prev.json ] || python3 label5.py invalidate; } && gsutil -m -q rsync -r work $B/work && mark fuse || fail fuse; }
done_ sam || { ( while true; do sleep 180; gsutil -m -q rsync -r labels $B/labels; done ) & P=$!; stage sam; kill $P; gsutil -m -q rsync -r labels $B/labels; mark sam; }
done_ review || { python3 label5.py review && gsutil -m -q rsync -r sheets $B/sheets && gsutil -q cp report.json $B/report.json && mark review; }

# dataset: round 4's (as it was) + the new frames; new validation = every 6th block of 50 frames, as round 4
if ! done_ dataset; then
  mkdir -p r4 && gsutil -m -q rsync -r gs://gengalactic-tools-table-cv/r4/data r4
  python3 - <<'PY'
import json, os, shutil
from pathlib import Path
d = Path('ds'); shutil.rmtree(d, ignore_errors=True)
n = {}
for s in ('train', 'val'):
    for sub in ('images', 'labels'):
        (d / sub / s).mkdir(parents=True, exist_ok=True)
    for im in (Path('r4/ds/images') / s).glob('*.jpg'):
        lab = Path('r4/ds/labels') / s / (im.stem + '.txt')
        if lab.exists():
            os.symlink(im.resolve(), d / 'images' / s / im.name); shutil.copy(lab, d / 'labels' / s / lab.name)
            n[f'r4 {s}'] = n.get(f'r4 {s}', 0) + 1
names = json.loads(Path('r5/seq/names.json').read_text())
for i, name in enumerate(names):
    lab = Path('labels') / f'{name}.txt'
    if not lab.exists():
        continue
    s = 'val' if (i // 50) % 6 == 5 else 'train'
    os.symlink(Path(f'r5/seq/{i:05d}.jpg').resolve(), d / 'images' / s / f'{name}.jpg'); shutil.copy(lab, d / 'labels' / s / lab.name)
    n[f'r5 {s}'] = n.get(f'r5 {s}', 0) + 1
(d / 'data.yaml').write_text(f"path: {d.resolve()}\ntrain: images/train\nval: images/val\nnames:\n  0: earth\n  1: moon\n  2: seldon-1\n  3: seldon-2\n  4: person\n")
for s in ('val',):                                     # the new frames' validation on their own, for the r4 vs r5 comparison
    e = Path('ds_r5val'); shutil.rmtree(e, ignore_errors=True)
    for sub in ('images', 'labels'):
        (e / sub / s).mkdir(parents=True, exist_ok=True)
    for im in (d / 'images' / s).glob('r5_*.jpg'):
        os.symlink(os.path.realpath(im), e / 'images' / s / im.name); shutil.copy(d / 'labels' / s / (im.stem + '.txt'), e / 'labels' / s)
    (e / 'data.yaml').write_text((d / 'data.yaml').read_text().replace(str(d.resolve()), str(e.resolve())).replace('train: images/train', 'train: images/val'))
print(n)
PY
  mark dataset
fi

# fine-tune from round 4 (resumes from last.pt after a reclaim); runs/ pushed every 3 min
mkdir -p runs && gsutil -m -q rsync -r $B/runs runs 2>/dev/null
if ! done_ train; then
  ( while true; do sleep 180; gsutil -m -q rsync -r runs $B/runs; done ) & P=$!
  DEV=$(seq -s, 0 $((N - 1))); LAST=runs/r5-seg/weights/last.pt
  if [ -f $LAST ]; then yolo segment train resume model=$LAST
  else yolo segment train model=prev.pt data=$W/ds/data.yaml imgsz=960 epochs=60 patience=15 batch=$((16 * N)) cache=ram workers=8 \
         device=$DEV degrees=180 fliplr=0.5 flipud=0.5 project=$W/runs name=r5-seg exist_ok=True; fi
  kill $P; gsutil -m -q rsync -r runs $B/runs
  [ -f runs/r5-seg/weights/best.pt ] && mark train || fail train
fi

# r4 vs r5 on the new validation frames and on everything held out; ONNX fp16 at the ThinkPad crop (512x736)
if ! done_ eval; then
  python3 - <<'PY' 2>&1 | tee eval.txt
from ultralytics import YOLO
for data in ('ds_r5val/data.yaml', 'ds/data.yaml'):
    for w in ('prev.pt', 'runs/r5-seg/weights/best.pt'):
        m = YOLO(w).val(data=data, imgsz=960, split='val', verbose=False, plots=False)
        per = {m.names[c]: round(float(m.seg.maps[c]), 3) for c in range(len(m.names))}
        print(f'{data:22s} {w:32s} box mAP50 {m.box.map50:.3f} mAP50-95 {m.box.map:.3f}  mask mAP50-95 {m.seg.map:.3f}  '
              f'P {m.box.mp:.3f} R {m.box.mr:.3f}  per-class mask mAP50-95 {per}', flush=True)
PY
  gsutil -q cp eval.txt $B/eval.txt && mark eval
fi
if ! done_ export; then
  python3 - <<'PY'
import shutil
import onnx
from onnxconverter_common import float16
from ultralytics import YOLO
out = YOLO('runs/r5-seg/weights/best.pt', task='segment').export(format='onnx', imgsz=[512, 736], opset=17, simplify=True, dynamic=False)
m = onnx.load(out); del m.graph.value_info[:]
m = float16.convert_float_to_float16(m, keep_io_types=True, op_block_list=['Resize']); del m.graph.value_info[:]
onnx.checker.check_model(m); onnx.save(m, out); print('exported', out)
PY
  gsutil -q cp runs/r5-seg/weights/best.onnx $B/runs/r5-seg/weights/best.onnx && mark export
fi
gsutil -q cp $W/r5.log $B/r5.log
mark ALL_DONE
shutdown -h now
