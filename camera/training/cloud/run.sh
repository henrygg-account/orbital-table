#!/bin/bash
# GPU VM: install SAM 2 + ultralytics, SAM-label the sequence, then train YOLO11s on the new labels.
set -e
export PATH=$HOME/.local/bin:$PATH
cd ~
python3 -m pip install -q --upgrade pip
python3 -m pip install -q ultralytics
SAM2_BUILD_CUDA=0 python3 -m pip install -q "git+https://github.com/facebookresearch/sam2.git"
# no libGL on the VM: headless OpenCV only (force-reinstall: removing opencv-python deletes the shared cv2 files)
python3 -m pip uninstall -y -q opencv-python || true
python3 -m pip install -q --force-reinstall --no-deps opencv-python-headless
python3 -c "import cv2, sam2; print('cv2', cv2.__version__)"
[ -f sam2.1_hiera_large.pt ] || wget -q https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_large.pt
python3 sam_label.py --frames seq --weights prev.pt --out sam_out
echo SAM_DONE
# dataset: blocks of 50 consecutive frames, every 6th block is validation
python3 - <<'PY'
import json, os
from pathlib import Path
names = json.loads(Path('seq/names.json').read_text()); d = Path('ds')
for i, n in enumerate(names):
    s = 'val' if (i // 50) % 6 == 5 else 'train'
    for sub in ('images', 'labels'): (d / sub / s).mkdir(parents=True, exist_ok=True)
    os.symlink(Path(f'seq/{i:05d}.jpg').resolve(), d / 'images' / s / f'{n}.jpg')
    (d / 'labels' / s / f'{n}.txt').write_text(Path(f'sam_out/labels/{n}.txt').read_text())
(d / 'data.yaml').write_text(f"path: {d.resolve()}\ntrain: images/train\nval: images/val\nnames:\n  0: earth\n  1: moon\n  2: seldon-1\n  3: seldon-2\n")
PY
yolo detect train model=yolo11s.pt data=$HOME/ds/data.yaml imgsz=960 epochs=100 patience=25 batch=32 cache=ram workers=8 device=0 \
     degrees=180 fliplr=0.5 flipud=0.5 project=$HOME/runs name=tv-sam-yolo11s-960 exist_ok=True
echo ALL_DONE
