#!/bin/bash
# Round 4 training on a Spot GPU VM, safe against reclaims. Runs as the VM's startup script (root), so a reclaimed VM
# that is started again, or a fresh VM in another zone with this startup script, carries on by itself:
#   data (dataset, built locally by build_ds4.py) and checkpoints live in gs://gengalactic-tools-table-cv/r4;
#   on boot: pull data + any checkpoints, resume from last.pt if there is one, else start; push runs/ every 3 min.
# Done when gs://.../r4/ALL_DONE exists.
B=gs://gengalactic-tools-table-cv/r4
W=/opt/train
mkdir -p $W && cd $W
exec >> $W/train.log 2>&1
echo "=== boot $(date)"
gsutil -q stat $B/ALL_DONE && { echo "already done"; exit 0; }
python3 -c "import ultralytics" 2>/dev/null || python3 -m pip install -q ultralytics
python3 -m pip uninstall -y -q opencv-python || true            # no libGL on the VM: headless OpenCV only
python3 -m pip install -q --force-reinstall --no-deps opencv-python-headless
python3 -m pip uninstall -y -q torchaudio || true
until gsutil -q stat $B/data/READY; do sleep 30; done           # the dataset is uploaded last-file-READY
mkdir -p $W/data && gsutil -m -q rsync -r $B/data $W/data
mkdir -p $W/runs && gsutil -m -q rsync -r $B/runs $W/runs 2>/dev/null || true
( while true; do sleep 180; gsutil -m -q rsync -r $W/runs $B/runs; gsutil -q cp $W/train.log $B/train.log; done ) &
N=$(nvidia-smi -L | wc -l); DEV=$(seq -s, 0 $((N - 1)))
echo "GPUS $N"
LAST=$W/runs/r4-seg/weights/last.pt
if [ -f "$LAST" ]; then
  echo "resuming from $LAST"
  yolo segment train resume model=$LAST device=$DEV batch=$((16 * N)) workers=8
else
  yolo segment train model=yolo11s-seg.pt data=$W/data/ds/data.yaml imgsz=960 epochs=100 patience=25 batch=$((16 * N)) cache=ram \
       workers=8 device=$DEV degrees=180 fliplr=0.5 flipud=0.5 project=$W/runs name=r4-seg exist_ok=True
fi
gsutil -m -q rsync -r $W/runs $B/runs
if [ -f $W/runs/r4-seg/weights/best.pt ] && grep -q "epochs completed" $W/train.log; then
  date > $W/ALL_DONE; gsutil -q cp $W/ALL_DONE $B/ALL_DONE; echo ALL_DONE
fi
gsutil -q cp $W/train.log $B/train.log
