"""Colour boxes for every frame of a sequence, as extra SAM prompts (cloud/sam_label.py --prompts).

  python color_prompts.py data_tv_pol/seq [--sheet out.jpg]

Tuned for the polarized Arducam view (camera and TV fixed): the pieces are dim but saturated (Seldon-1 yellow hue
~15-31, Seldon-2 pink/red hue >= 165 or <= 6, Earth blue hue ~85-118). A median of frames across the video gives the
empty table; the screen is its largest near-black region; a piece is a blob of its colour inside the screen that is
brighter than the empty table.
Writes <seq>/prompts.json: {"<frame index>": {"<class index>": [x1, y1, x2, y2]}} in frame px. Moon skipped.
"""
import argparse, json
from pathlib import Path

import cv2
import numpy as np

CLASSES = ['earth', 'moon', 'seldon-1', 'seldon-2']
COL = {0: (255, 170, 60), 2: (40, 210, 255), 3: (200, 60, 255)}
SW = 640                                                     # work width (px)


def background(frames, n=60):
    """Per-pixel median of n frames spread over the video: the empty table (pieces and hands move, the TV and
    camera do not)."""
    pick = [frames[int(i)] for i in np.linspace(0, len(frames) - 1, n)]
    imgs = [cv2.resize(cv2.imread(str(f)), (SW, round(SW * 3 / 4)), interpolation=cv2.INTER_AREA) for f in pick]
    return np.median(np.stack(imgs), axis=0).astype(np.uint8)


def screen_mask(bg_hsv):
    """The screen = the largest near-black region of the background, as a filled, slightly shrunk hull."""
    dark = cv2.inRange(bg_hsv, (0, 0, 0), (180, 255, 18))
    dark = cv2.morphologyEx(dark, cv2.MORPH_OPEN, np.ones((7, 7), np.uint8))
    n, lab, st, _ = cv2.connectedComponentsWithStats(dark)
    k = 1 + int(np.argmax(st[1:, cv2.CC_STAT_AREA]))
    m = np.zeros(dark.shape, np.uint8)
    cv2.fillConvexPoly(m, cv2.convexHull(cv2.findNonZero((lab == k).astype(np.uint8))), 255)
    return cv2.erode(m, np.ones((5, 5), np.uint8))


def blob(mask, close, amin, amax, max_aspect=3.0):
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((close, close), np.uint8))
    n, lab, st, _ = cv2.connectedComponentsWithStats(mask)
    best, ba = None, 0
    for k in range(1, n):
        x, y, w, h, a = st[k]
        if amin <= a <= amax and max(w, h) <= max_aspect * min(w, h) and a > ba:
            best, ba = (x, y, w, h), a
    return best


def frame_boxes(img, scr, bg_v):
    H, W = img.shape[:2]
    hsv = cv2.cvtColor(cv2.resize(img, (SW, round(SW * H / W)), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2HSV)
    h, s, v = cv2.split(hsv)
    glow = float((v.astype(np.int16) - bg_v)[scr > 0].mean()) > 4     # the page shows through the film (blue frames)
    on = (scr > 0) & (v.astype(np.int16) - bg_v > 10)          # inside the screen and brighter than the empty table
    masks = {
        2: (h >= 15) & (h <= 31) & (s > 100) & (v > 45),
        3: ((h >= 165) | (h <= 6)) & (s > 110) & (v > 35),
        0: (h >= 85) & (h <= 118) & (s > 70) & (v > 28),
    }
    out, f = {}, W / SW
    for c, m in masks.items():
        if c == 0 and glow:
            continue                                            # Earth's blue is lost in a glowing blue page
        b = blob(((m & on).astype(np.uint8)) * 255, 5, 20, 1500)
        if b:
            x, y, w, hh = b
            out[c] = [x * f, y * f, (x + w) * f, (y + hh) * f]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('seq', type=Path)
    ap.add_argument('--sheet', type=Path, help='write a contact sheet of 16 frames with the kept boxes')
    a = ap.parse_args()
    frames = sorted(a.seq.glob('[0-9]*.jpg'))
    bg = background(frames)
    bg_hsv = cv2.cvtColor(bg, cv2.COLOR_BGR2HSV)
    scr, bg_v = screen_mask(bg_hsv), bg_hsv[:, :, 2].astype(np.int16)
    print('screen covers', round(100 * (scr > 0).mean()), '% of the frame')
    raw = {}
    for i, f in enumerate(frames):
        boxes = frame_boxes(cv2.imread(str(f)), scr, bg_v)
        if boxes:
            raw[i] = {c: [round(v, 1) for v in b] for c, b in boxes.items()}
    print('colour boxes found:', {CLASSES[c]: sum(c in b for b in raw.values()) for c in (0, 2, 3)})
    # keep only trustworthy boxes (they become SAM prompts): size near the class's median, and the same box (within
    # 12 px) in the previous and the next frame
    near = lambda b, o: o is not None and max(abs(b[k] - o[k]) for k in range(4)) < 12
    kept = {}
    for c in (0, 2, 3):
        sizes = np.array([[b[c][2] - b[c][0], b[c][3] - b[c][1]] for b in raw.values() if c in b])
        mw, mh = np.median(sizes, axis=0)
        for i in range(1, len(frames) - 1):
            b = raw.get(i, {}).get(c)
            if b is None or not (0.6 < (b[2] - b[0]) / mw < 1.6 and 0.6 < (b[3] - b[1]) / mh < 1.6):
                continue
            if near(b, raw.get(i - 1, {}).get(c)) and near(b, raw.get(i + 1, {}).get(c)):
                kept.setdefault(i, {})[c] = b
    print('kept as prompts:', {CLASSES[c]: sum(c in b for b in kept.values()) for c in (0, 2, 3)})
    (a.seq / 'prompts.json').write_text(json.dumps({str(i): {str(c): b for c, b in d.items()} for i, d in kept.items()}))
    if a.sheet:
        tiles = []
        for i in np.linspace(50, len(frames) - 30, 16).astype(int):
            img = cv2.imread(str(frames[i]))
            cs, _ = cv2.findContours(cv2.resize(scr, (img.shape[1], img.shape[0])), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            cv2.drawContours(img, cs, -1, (0, 255, 0), 2)
            for c, (x1, y1, x2, y2) in kept.get(int(i), {}).items():
                cv2.rectangle(img, (int(x1) - 4, int(y1) - 4), (int(x2) + 4, int(y2) + 4), COL[c], 3)
            t = cv2.resize(img, (480, 360)); cv2.putText(t, frames[i].stem, (8, 24), cv2.FONT_HERSHEY_SIMPLEX, .7, (0, 255, 255), 2)
            tiles.append(t)
        cv2.imwrite(str(a.sheet), np.vstack([np.hstack(tiles[r:r + 4]) for r in range(0, 16, 4)]), [cv2.IMWRITE_JPEG_QUALITY, 85])


if __name__ == '__main__':
    main()
