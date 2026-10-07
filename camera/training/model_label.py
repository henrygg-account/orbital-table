"""Label frames with a trained model (round 2+): fills in the frames the rule-based labeller skipped.

  python model_label.py [--set tv] [--weights runs/tv-yolo11s-960/weights/best.pt] [--conf 0.4]

Speed doesn't matter here, so it runs at a high input size. Frames that already have a label file are
left alone unless --overwrite. Each class keeps at most max_per_class boxes (two Seldons).
Labels -> <set>/labels, previews (model boxes drawn dashed-free in class colours) -> <set>/preview_model.
"""
import argparse
from pathlib import Path

import cv2
from ultralytics import YOLO

from sets import SETS

HERE = Path(__file__).parent
COLORS = [(255, 170, 60), (230, 230, 230), (60, 200, 255)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--set', default='tv', choices=list(SETS))
    ap.add_argument('--weights')
    ap.add_argument('--conf', type=float, default=0.25)
    ap.add_argument('--imgsz', type=int, default=1280)
    ap.add_argument('--overwrite', action='store_true')
    a = ap.parse_args()
    S = SETS[a.set]
    weights = a.weights or HERE / 'runs' / f'{a.set}-yolo11s-960' / 'weights' / 'best.pt'
    raw, labels, prev = S['dir'] / 'raw', S['dir'] / 'labels', S['dir'] / 'preview_model'
    labels.mkdir(parents=True, exist_ok=True); prev.mkdir(parents=True, exist_ok=True)
    model = YOLO(str(weights))
    new, kept_old, counts = 0, 0, [0] * len(S['classes'])
    for f in sorted(raw.glob('*.jpg')):
        out = labels / f'{f.stem}.txt'
        if out.exists() and not a.overwrite:
            kept_old += 1
            continue
        r = model.predict(str(f), imgsz=a.imgsz, conf=a.conf, device='mps', agnostic_nms=True, verbose=False)[0]   # one box per object, whatever the class
        kept = []
        for (x, y, w, h), c, s in sorted(zip(r.boxes.xywhn.tolist(), r.boxes.cls.int().tolist(), r.boxes.conf.tolist()), key=lambda d: -d[2]):
            if sum(k[1] == c for k in kept) < S['max_per_class'][c]:
                kept.append(((x, y, w, h), c, s))
        out.write_text(''.join(f'{c} {x:.6f} {y:.6f} {w:.6f} {h:.6f}\n' for (x, y, w, h), c, s in kept))
        img = cv2.imread(str(f)); H, W = img.shape[:2]
        for (x, y, w, h), c, s in kept:
            counts[c] += 1
            p1, p2 = (int((x - w / 2) * W), int((y - h / 2) * H)), (int((x + w / 2) * W), int((y + h / 2) * H))
            cv2.rectangle(img, p1, p2, COLORS[c], 4)
            cv2.putText(img, f'{S["classes"][c]} {s:.2f}', (p1[0], max(30, p1[1] - 10)), cv2.FONT_HERSHEY_SIMPLEX, 1.1, COLORS[c], 3)
        cv2.imwrite(str(prev / f.name), cv2.resize(img, (960, 540)), [cv2.IMWRITE_JPEG_QUALITY, 75])
        new += 1
    print(f'model-labelled {new} frames, kept {kept_old} existing |',
          ', '.join(f'{n}: {k}' for n, k in zip(S['classes'], counts)))


if __name__ == '__main__':
    main()
