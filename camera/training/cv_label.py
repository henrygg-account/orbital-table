"""Label the printed pieces with plain colour/shape rules (no model), for the first training round.

  python cv_label.py [--set tv]

The camera never moves, so the per-pixel median of the video is the empty screen. Pieces are the
grey regions noticeably darker than it, inside the screen; sort them by size and shape:
  moon = small round blob, earth = large round blob, Seldon = long or ragged blob (the wings);
yellow wraps = seldon-1, magenta wraps = seldon-2.
Frames where a hand touches a piece, or the blobs don't make sense, are skipped (no label file),
so the model never learns a half-hidden piece as background. Previews go to <set>/preview/.
"""
import argparse
from pathlib import Path

import cv2
import numpy as np

from sets import SETS

COLORS = {'earth': (255, 170, 60), 'moon': (230, 230, 230), 'seldon-1': (40, 210, 255), 'seldon-2': (200, 60, 255)}


def background(raw, every=5):
    """Per-pixel median over the video = the empty screen (pieces and hands move, the camera doesn't)."""
    fs = sorted(raw.glob('*.jpg'))[::every]
    return np.median(np.stack([cv2.resize(cv2.imread(str(f)), (960, 540)) for f in fs]), axis=0).astype(np.uint8)


def screen_mask(bg_hsv):
    """The screen in the empty-scene image: the largest navy region, or (dark demo page) the largest dark one."""
    def largest(mask, min_frac):
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((15, 15), np.uint8))   # cut off cables touching the screen
        n, lab, stats, _ = cv2.connectedComponentsWithStats(mask)
        if n < 2:
            return None
        k = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
        return (lab == k).astype(np.uint8) if stats[k, cv2.CC_STAT_AREA] > min_frac * mask.size else None
    comp = largest(cv2.inRange(bg_hsv, (100, 40, 15), (180, 255, 255)), 0.15)      # navy page
    if comp is None:
        comp = largest(cv2.inRange(bg_hsv, (0, 0, 0), (180, 70, 125)), 0.10)       # near-black page (floor is far brighter)
    hull = cv2.convexHull(cv2.findNonZero(comp))
    m = np.zeros(bg_hsv.shape[:2], np.uint8); cv2.fillConvexPoly(m, hull, 255)
    return cv2.erode(m, np.ones((7, 7), np.uint8))


def label_frame(img, bg, scr, a):
    """Boxes in half-res (960x540) px, or (None, reason). bg = (hsv, lab) of the empty screen."""
    bg_hsv, bg_lab = bg
    small = cv2.resize(img, (960, 540))
    hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
    lap = np.abs(cv2.Laplacian(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY), cv2.CV_32F))   # surface detail
    lab_d = np.linalg.norm(cv2.cvtColor(small, cv2.COLOR_BGR2LAB).astype(np.float32) - bg_lab, axis=2)
    darker = cv2.subtract(bg_hsv[:, :, 2], hsv[:, :, 2])
    # a piece differs in colour from the empty screen (grey vs blue), or is clearly darker and grey
    piece = ((lab_d > a.color_diff) | ((darker > a.dark) & (hsv[:, :, 1] < a.max_sat))).astype(np.uint8) * 255
    piece = cv2.bitwise_and(piece, scr)
    piece = cv2.morphologyEx(piece, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))   # join lattice wings / speckle
    piece = cv2.morphologyEx(piece, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    # hands: big skin-coloured regions on the screen
    skin = cv2.inRange(hsv, (0, 50, 110), (25, 200, 255))
    skin = cv2.bitwise_and(skin, cv2.dilate(scr, np.ones((41, 41), np.uint8)))
    n, lab, st, _ = cv2.connectedComponentsWithStats(skin)
    big = np.isin(lab, [k for k in range(1, n) if st[k, cv2.CC_STAT_AREA] > a.hand_area]).astype(np.uint8) * 255
    hand = cv2.dilate(big, np.ones((15, 15), np.uint8))
    edge = cv2.subtract(scr, cv2.erode(scr, np.ones((9, 9), np.uint8)))            # rim of the screen
    n, lab, st, _ = cv2.connectedComponentsWithStats(piece)
    blobs = []
    for k in range(1, n):
        x, y, w, h, area = st[k]
        if area < a.min_area or min(w, h) < a.min_side:
            continue
        m = (lab == k).astype(np.uint8)
        if cv2.countNonZero(cv2.bitwise_and(m, edge // 255)) > 0.2 * area:
            continue                                                               # bezel / screen-edge artefact
        near_hand = cv2.countNonZero(cv2.bitwise_and(m, hand // 255))
        if near_hand:
            if area - near_hand < 3 * a.min_area:
                continue                                                           # the hand itself
            return None, 'hand on piece'                                           # a piece in or under a hand
        if lap[y:y + h, x:x + w][m[y:y + h, x:x + w] > 0].mean() < a.min_texture:
            continue                                                               # smooth = exposure drift, not a print
        c = max(cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[0], key=cv2.contourArea)
        (_, _), (rw, rh), _ = cv2.minAreaRect(c)
        ca = cv2.contourArea(c)
        px = hsv[y:y + h, x:x + w][(m[y:y + h, x:x + w] > 0) & (hsv[y:y + h, x:x + w, 1] > 90)]   # saturated pixels
        yellow = np.count_nonzero((px[:, 0] >= 15) & (px[:, 0] <= 40)) if len(px) else 0
        magenta = np.count_nonzero((px[:, 0] >= 140) & (px[:, 0] <= 175)) if len(px) else 0
        blobs.append(dict(box=(x, y, w, h), area=ca, elong=max(rw, rh) / max(1, min(rw, rh)),
                          solid=ca / max(1, cv2.contourArea(cv2.convexHull(c))), yellow=yellow, magenta=magenta))
    winged = [b for b in blobs if b['elong'] > a.wing_elong or b['solid'] < a.min_solid]
    round_ = [b for b in blobs if b not in winged]
    for b in winged:
        if max(b['yellow'], b['magenta']) < a.min_color_px:
            return None, 'seldon colour unclear'
        b['cls'] = 'seldon-1' if b['yellow'] > b['magenta'] else 'seldon-2'
    for b in round_:
        b['cls'] = 'moon' if b['area'] < a.moon_max_area else 'earth'
    if any(sum(b['cls'] == c for b in blobs) > 1 for c in COLORS):
        return None, 'too many blobs'
    return winged + round_, 'ok'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--set', default='tv', choices=list(SETS))
    ap.add_argument('--color-diff', type=float, default=14, help='Lab distance from the empty screen')
    ap.add_argument('--dark', type=int, default=18, help='a piece pixel is this much darker than the empty screen')
    ap.add_argument('--max-sat', type=int, default=110, help='pieces are greyer than this')
    ap.add_argument('--min-area', type=int, default=40, help='half-res px; smaller blobs are noise')
    ap.add_argument('--min-side', type=int, default=8, help='half-res px; thinner blobs are edge slivers')
    ap.add_argument('--moon-max-area', type=int, default=1600, help='half-res px; round blobs smaller than this are the Moon (~700), larger are Earth (~3500)')
    ap.add_argument('--min-texture', type=float, default=5.0, help='mean |Laplacian| inside a blob; prints are detailed, exposure drift is smooth')
    ap.add_argument('--wing-elong', type=float, default=1.8)
    ap.add_argument('--min-color-px', type=int, default=30, help='saturated yellow/magenta pixels needed to tell the Seldons apart')
    ap.add_argument('--min-solid', type=float, default=0.8, help='round pieces are this convex; the wings make Seldons less so')
    ap.add_argument('--hand-area', type=int, default=1500, help='half-res px of skin that counts as a hand')
    a = ap.parse_args()
    S = SETS[a.set]
    raw, labels, prev = S['dir'] / 'raw', S['dir'] / 'labels', S['dir'] / 'preview'
    labels.mkdir(parents=True, exist_ok=True); prev.mkdir(parents=True, exist_ok=True)
    for old in labels.glob('*.txt'):
        old.unlink()
    names = S['classes']
    counts, skipped = {c: 0 for c in names}, {}
    files = sorted(raw.glob('*.jpg'))
    bg = background(raw); cv2.imwrite(str(S['dir'] / 'background.png'), bg)
    bg_hsv = cv2.cvtColor(bg, cv2.COLOR_BGR2HSV); scr = screen_mask(bg_hsv)
    bgs = (bg_hsv, cv2.cvtColor(bg, cv2.COLOR_BGR2LAB).astype(np.float32))
    for f in files:
        img = cv2.imread(str(f)); H, W = img.shape[:2]
        dets, why = label_frame(img, bgs, scr, a)
        view = img.copy()
        if dets is None:
            skipped[why] = skipped.get(why, 0) + 1
            cv2.putText(view, 'SKIP: ' + why, (30, 60), cv2.FONT_HERSHEY_SIMPLEX, 1.6, (0, 0, 255), 4)
        else:
            lines = []
            for d in dets:
                x, y, w, h = [2 * v for v in d['box']]; c = d['cls']   # half-res -> full
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
