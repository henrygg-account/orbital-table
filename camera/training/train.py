"""Split data/raw + data/labels into train/val and fine-tune a YOLO11 detector.

  python train.py [--set tv] [--model yolo11s.pt] [--imgsz 960] [--epochs 60]

Val frames are taken as whole blocks of consecutive frames so neighbours of a training frame
(nearly identical) don't leak into validation. Output: runs/<name>/weights/best.pt
"""
import argparse, shutil
from pathlib import Path

from ultralytics import YOLO

HERE = Path(__file__).parent
from sets import SETS
BLOCK = 20          # consecutive frames per block
VAL_EVERY = 6       # every 6th block goes to val (~17%)


def build_split(S):
    ds = S['dir'] / 'yolo'
    if ds.exists():
        shutil.rmtree(ds)
    files = sorted((S['dir'] / 'raw').glob('*.jpg'))
    n = {'train': 0, 'val': 0}
    for i, f in enumerate(files):
        split = 'val' if (i // BLOCK) % VAL_EVERY == VAL_EVERY - 1 else 'train'
        lab = S['dir'] / 'labels' / f'{f.stem}.txt'
        if S.get('only_labeled') and not lab.exists():
            continue                     # unlabelled = unknown (e.g. skipped by the labeller), not "empty"
        for sub in ('images', 'labels'):
            (ds / sub / split).mkdir(parents=True, exist_ok=True)
        (ds / 'images' / split / f.name).symlink_to(f.resolve())
        shutil.copy(lab, ds / 'labels' / split / lab.name) if lab.exists() else (ds / 'labels' / split / lab.name).touch()
        n[split] += 1
    yaml = ds / 'data.yaml'
    yaml.write_text(f'path: {ds.resolve()}\ntrain: images/train\nval: images/val\nnames:\n'
                    + ''.join(f'  {i}: {c}\n' for i, c in enumerate(S['classes'])))
    print(f"split: {n['train']} train / {n['val']} val")
    return yaml


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--set', default='standins', choices=list(SETS))
    ap.add_argument('--model', default='yolo11s.pt')
    ap.add_argument('--imgsz', type=int, default=960)
    ap.add_argument('--epochs', type=int, default=60)
    ap.add_argument('--batch', type=int, default=8)
    a = ap.parse_args()

    yaml = build_split(SETS[a.set])
    name = f'{a.set}-{Path(a.model).stem}-{a.imgsz}'
    YOLO(a.model).train(data=str(yaml), imgsz=a.imgsz, epochs=a.epochs, batch=a.batch, device='mps',
                        project=str(HERE / 'runs'), name=name, exist_ok=True, patience=20,
                        fliplr=0.5, flipud=0.5, degrees=180, mosaic=1.0, workers=4, plots=True)


if __name__ == '__main__':
    main()
