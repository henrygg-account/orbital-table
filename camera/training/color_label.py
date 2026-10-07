"""Label the wrapped pieces by colour, frame by frame (no background model, so a moving camera is fine).

  python color_label.py [--set tv]

The demo page is near-black and every piece wears a distinct wrap:
  seldon-1 yellow (hue ~26-30), seldon-2 pink (hue ~170-179), earth blue ocean (hue ~106-110) + green land,
  moon white. Skin sits at hue ~5-20, between yellow and pink, so hands don't match any class.
For each class: colour mask inside the screen -> close small gaps (wing panels + body) -> largest blob.
A piece partly under a hand is labelled by what's visible. Previews -> <set>/preview/.
"""
import argparse

import cv2
import numpy as np

from sets import SETS

COLORS = {'earth': (255, 170, 60), 'moon': (230, 230, 230), 'seldon-1': (40, 210, 255), 'seldon-2': (200, 60, 255)}


def screen_mask(hsv):
    """Largest dark (page) region, cables cut off, as a filled hull — the pieces are holes in it."""
    dark = cv2.inRange(hsv, (0, 0, 0), (180, 70, 125))
    dark = cv2.morphologyEx(dark, cv2.MORPH_OPEN, np.ones((15, 15), np.uint8))
    n, lab, st, _ = cv2.connectedComponentsWithStats(dark)
    if n < 2:
        return None
    k = 1 + int(np.argmax(st[1:, cv2.CC_STAT_AREA]))
    if st[k, cv2.CC_STAT_AREA] < 0.08 * dark.size:
        return None
    m = np.zeros(dark.shape, np.uint8)
    cv2.fillConvexPoly(m, cv2.convexHull(cv2.findNonZero((lab == k).astype(np.uint8))), 255)
    return cv2.dilate(m, np.ones((9, 9), np.uint8))          # pieces right at the edge still count


def biggest(mask, close, min_area, max_area=10**9, max_aspect=3.5, roundest=False):
    """Best blob: the largest (or, for the Moon, the roundest) whose box isn't a long thin strip
    (the page's own orange status text runs along one edge)."""
    if close:
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((close, close), np.uint8))
    n, lab, st, _ = cv2.connectedComponentsWithStats(mask)
    best, score = None, -1
    for k in range(1, n):
        x, y, w, h, a = st[k]
        if not (min_area <= a <= max_area) or max(w, h) > max_aspect * min(w, h):
            continue
        if roundest:
            c = max(cv2.findContours((lab[y:y + h, x:x + w] == k).astype(np.uint8), cv2.RETR_EXTERNAL,
                                     cv2.CHAIN_APPROX_NONE)[0], key=cv2.contourArea)
            per = cv2.arcLength(c, True)
            sc = 4 * np.pi * cv2.contourArea(c) / (per * per) if per else 0
            if sc < 0.55:
                continue
        else:
            sc = a
        if sc > score:
            best, score = k, sc
    return None if best is None else tuple(int(v) for v in st[best, :4])


def label_frame(img, a):
    small = cv2.resize(img, (960, 540))
    hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
    scr = screen_mask(hsv)
    if scr is None:
        return None, 'no screen'
    h, s, v = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]
    on = scr > 0
    masks = {
        'seldon-1': (h >= 23) & (h <= 31) & (s > 65) & (v > 110),   # tennis ball is greener (hue 32+)
        'seldon-2': ((h >= 165) | (h <= 3)) & (s > 45) & (v > 110),
        'earth': (((h >= 95) & (h <= 118)) | ((h >= 38) & (h <= 90))) & (s > 40) & (v > 80),
        'moon': (s < 45) & (v > 175),
    }
    out = []
    for cls, m in masks.items():
        m = ((m & on).astype(np.uint8)) * 255
        if cls == 'moon':                      # white also shows on Earth's ice and the Seldon number discs
            for other in out:
                x, y, w, hh = other['box']; m[max(0, y - 6):y + hh + 6, max(0, x - 6):x + w + 6] = 0
            box = biggest(m, 3, a.moon_min, a.moon_max, max_aspect=1.8, roundest=True)
        elif cls == 'earth':
            box = biggest(m, 7, a.earth_min, max_aspect=2.0)
        else:
            box = biggest(m, 9, a.seldon_min)
        if box:
            out.append({'cls': cls, 'box': box})
    return out, 'ok'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--set', default='tv', choices=list(SETS))
    ap.add_argument('--seldon-min', type=int, default=120, help='half-res px')
    ap.add_argument('--earth-min', type=int, default=150)
    ap.add_argument('--moon-min', type=int, default=12)
    ap.add_argument('--moon-max', type=int, default=400)
    a = ap.parse_args()
    S = SETS[a.set]
    raw, labels, prev = S['dir'] / 'raw', S['dir'] / 'labels', S['dir'] / 'preview'
    labels.mkdir(parents=True, exist_ok=True); prev.mkdir(parents=True, exist_ok=True)
    for old in labels.glob('*.txt'):
        old.unlink()
    names = S['classes']
    counts, skipped = {c: 0 for c in names}, {}
    files = sorted(raw.glob('*.jpg'))
    for f in files:
        img = cv2.imread(str(f)); H, W = img.shape[:2]
        dets, why = label_frame(img, a)
        view = img.copy()
        if dets is None:
            skipped[why] = skipped.get(why, 0) + 1
            cv2.putText(view, 'SKIP: ' + why, (30, 60), cv2.FONT_HERSHEY_SIMPLEX, 1.6, (0, 0, 255), 4)
        else:
            lines = []
            for d in dets:
                x, y, w, h = [2 * v for v in d['box']]; c = d['cls']      # half-res -> full
                lines.append(f'{names.index(c)} {(x + w / 2) / W:.6f} {(y + h / 2) / H:.6f} {w / W:.6f} {h / H:.6f}')
                counts[c] += 1
                cv2.rectangle(view, (x, y), (x + w, y + h), COLORS[c], 4)
                cv2.putText(view, c, (x, max(30, y - 10)), cv2.FONT_HERSHEY_SIMPLEX, 1.2, COLORS[c], 3)
            (labels / f'{f.stem}.txt').write_text('\n'.join(lines) + ('\n' if lines else ''))
        cv2.imwrite(str(prev / f.name), cv2.resize(view, (960, 540)), [cv2.IMWRITE_JPEG_QUALITY, 75])
    kept = len(list(labels.glob('*.txt')))
    print(f'{len(files)} frames: labelled {kept}, skipped {len(files) - kept} {skipped}')
    print('boxes:', counts)


if __name__ == '__main__':
    main()
