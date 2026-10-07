"""Pre-label <set>/raw/*.jpg with an open-vocabulary detector (YOLO-World), writing YOLO-format
labels to <set>/labels/<name>.txt. Also draws previews to <set>/preview/ for review.

  python autolabel.py [--set tv]
"""
import argparse
from pathlib import Path

import cv2
from ultralytics import YOLOWorld

from sets import SETS

COLORS = [(60, 230, 230), (0, 200, 255), (60, 60, 240)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--set', default='standins', choices=list(SETS))
    ap.add_argument('--model', default='yolov8x-worldv2.pt')
    a = ap.parse_args()
    S = SETS[a.set]
    CLASSES, PROMPTS, MIN_CONF, MAXN = S['classes'], S['prompts'], S['min_conf'], S['max_per_class']

    raw, labels, prev = S['dir'] / 'raw', S['dir'] / 'labels', S['dir'] / 'preview'
    labels.mkdir(parents=True, exist_ok=True); prev.mkdir(parents=True, exist_ok=True)
    model = YOLOWorld(a.model)
    model.set_classes(PROMPTS)

    files = sorted(raw.glob('*.jpg'))
    counts = [0] * len(CLASSES)
    for i, f in enumerate(files):
        r = model.predict(str(f), conf=min(MIN_CONF), imgsz=1280, device='mps', verbose=False)[0]
        # keep the best MAXN[c] boxes per class (e.g. two Seldons), skipping boxes centred inside a kept one
        kept = []
        dets = sorted(zip(r.boxes.xywhn.tolist(), r.boxes.cls.int().tolist(), r.boxes.conf.tolist()), key=lambda d: -d[2])
        for (x, y, w, h), c, s in dets:
            same = [k for k in kept if k[1] == c]
            if s < MIN_CONF[c] or len(same) >= MAXN[c]:
                continue
            if any(abs(x - kx) < kw / 2 and abs(y - ky) < kh / 2 for (kx, ky, kw, kh), _, _ in same):
                continue
            kept.append(((x, y, w, h), c, s))
        lines, img = [], cv2.imread(str(f))
        H, W = img.shape[:2]
        for (x, y, w, h), c, s in sorted(kept, key=lambda k: k[1]):
            lines.append(f'{c} {x:.6f} {y:.6f} {w:.6f} {h:.6f}')
            counts[c] += 1
            p1 = (int((x - w / 2) * W), int((y - h / 2) * H)); p2 = (int((x + w / 2) * W), int((y + h / 2) * H))
            cv2.rectangle(img, p1, p2, COLORS[c], 4)
            cv2.putText(img, f'{CLASSES[c]} {s:.2f}', (p1[0], max(30, p1[1] - 10)), cv2.FONT_HERSHEY_SIMPLEX, 1.2, COLORS[c], 3)
        (labels / f'{f.stem}.txt').write_text('\n'.join(lines) + ('\n' if lines else ''))
        cv2.imwrite(str(prev / f.name), cv2.resize(img, (960, 540)), [cv2.IMWRITE_JPEG_QUALITY, 80])
        if (i + 1) % 25 == 0:
            print(f'{i + 1}/{len(files)}')
    print('frames', len(files), '|', ', '.join(f'{n}: {k}' for n, k in zip(CLASSES, counts)))


if __name__ == '__main__':
    main()
