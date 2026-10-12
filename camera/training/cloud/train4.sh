#!/bin/bash
# Round 4, GPU VM part 2 (after the label review): dataset from labels/, YOLO11s-seg on every GPU. Re-running resumes.
set -e
export PATH=$HOME/.local/bin:$PATH
cd ~
python3 - <<'PY'
import json, os, shutil
from pathlib import Path
d = Path('ds'); shutil.rmtree(d, ignore_errors=True)
for ds in ('r4', 'r3'):
    names = json.loads(Path(f'{ds}/seq/names.json').read_text())
    for i, n in enumerate(names):
        lab = Path(f'labels/{ds}/{n}.txt')
        if not lab.exists():
            continue
        s = 'val' if (i // 50) % 6 == 5 else 'train'          # whole 50-frame blocks: no near-duplicate leaks into val
        for sub in ('images', 'labels'): (d / sub / s).mkdir(parents=True, exist_ok=True)
        os.symlink(Path(f'{ds}/seq/{i:05d}.jpg').resolve(), d / 'images' / s / f'{n}.jpg')
        shutil.copy(lab, d / 'labels' / s / f'{n}.txt')
(d / 'data.yaml').write_text(f"path: {d.resolve()}\ntrain: images/train\nval: images/val\nnames:\n  0: earth\n  1: moon\n  2: seldon-1\n  3: seldon-2\n  4: person\n")
print({s: len(list((d / 'images' / s).glob('*.jpg'))) for s in ('train', 'val')})
PY
N=$(nvidia-smi -L | wc -l); DEV=$(seq -s, 0 $((N - 1)))
LAST=$HOME/runs/r4-seg-yolo11s-960/weights/last.pt
if [ -f "$LAST" ]; then
  yolo segment train resume model=$LAST
else
  yolo segment train model=yolo11s-seg.pt data=$HOME/ds/data.yaml imgsz=960 epochs=100 patience=25 batch=$((16 * N)) cache=ram workers=8 \
       device=$DEV degrees=180 fliplr=0.5 flipud=0.5 save_period=5 project=$HOME/runs name=r4-seg-yolo11s-960 exist_ok=True
fi
echo ALL_DONE
