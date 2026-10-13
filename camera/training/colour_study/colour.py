"""colour.py — find the coloured pieces by colour alone, as blobs, for fusing with the YOLO detector.

Why it is not colorcheck.py: that scores a box the model already drew. This looks at the whole screen, so it can
find a piece the model missed and say which Seldon a box is. Built from the round-4 labels (COLOUR-STUDY.md):
  * a pixel counts only if it is its colour AND brighter than its surroundings (white top-hat of V): the screen's blue
    glow and the starfield are broad and smooth, a piece is a small bright spot;
  * blobs must be piece-sized, compact and on the screen (screen mask optional, hands excluded optional);
  * Earth (blue) is the weak one; Moon (white) and the Seldons are the strong ones, see the study for numbers.
detect(frame_bgr, screen=None, hands=None) -> [{'role', 'x', 'y', 'box', 'area', 'score'}] in frame pixels.
"""
import cv2
import numpy as np

SW = 640                                   # work width (px); pieces are ~12-25 px across here
ROLES = ('earth', 'moon', 'seldon-1', 'seldon-2')

# per role: hue range (lo, hi; lo > hi wraps), s_min, s_max, v_min, top-hat min, area range at SW=640, max aspect
PARAMS = {
    'earth':    dict(h=(60, 110), s=(70, 255), v=28, th=14, area=(12, 600), aspect=2.0, close=3),
    'moon':     dict(h=None, s=(0, 70), v=110, th=40, area=(25, 700), aspect=1.7, close=3),
    'seldon-1': dict(h=(12, 34), s=(100, 255), v=40, th=14, area=(6, 500), aspect=6.0, close=5),
    'seldon-2': dict(h=(160, 8), s=(90, 255), v=32, th=12, area=(6, 500), aspect=6.0, close=5),
}
TOPHAT_K = 17                              # top-hat kernel (px at SW): bigger than any piece, smaller than a glow


def prepare(frame, width=SW):
    """BGR frame -> dict of small H, S, V and top-hat(V) images, and the scale back to frame pixels."""
    fh, fw = frame.shape[:2]
    sc = width / fw
    sm = cv2.resize(frame, (width, round(fh * sc)), interpolation=cv2.INTER_AREA) if sc != 1 else frame
    hsv = cv2.cvtColor(sm, cv2.COLOR_BGR2HSV)
    v = hsv[..., 2]
    th = cv2.morphologyEx(v, cv2.MORPH_TOPHAT, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (TOPHAT_K, TOPHAT_K)))
    return {'h': hsv[..., 0], 's': hsv[..., 1], 'v': v, 'th': th, 'scale': sc, 'shape': v.shape}


def pixel_mask(P, role, prm):
    h, s, v, th = P['h'], P['s'], P['v'], P['th']
    m = (s >= prm['s'][0]) & (s <= prm['s'][1]) & (v >= prm['v']) & (th >= prm['th'])
    if prm['h'] is not None:
        lo, hi = prm['h']
        m &= ((h >= lo) & (h <= hi)) if lo <= hi else ((h >= lo) | (h <= hi))
    return m


def blobs(P, role, prm=None, screen=None, hands=None):
    """Candidate blobs for one role: [{'x','y','box','area','score'}] in work pixels."""
    prm = prm or PARAMS[role]
    m = pixel_mask(P, role, prm)
    if screen is not None:
        m &= screen
    if hands is not None:
        m &= ~hands
    m = m.astype(np.uint8)
    k = prm['close']
    if k > 1:
        m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((k, k), np.uint8))
    n, lab, st, cen = cv2.connectedComponentsWithStats(m, connectivity=8)
    out = []
    a0, a1 = prm['area']
    for i in range(1, n):
        x, y, w, h, a = st[i]
        if not (a0 <= a <= a1) or max(w, h) > prm['aspect'] * max(1, min(w, h)):
            continue
        # fill: the share of the box that is the colour; a ring or a smear scores low
        score = a / float(w * h)
        out.append({'x': float(x + w / 2), 'y': float(y + h / 2), 'box': (int(x), int(y), int(x + w), int(y + h)), 'area': int(a), 'score': score})
    return out


def detect(frame, screen=None, hands=None, params=None, P=None):
    """frame BGR. screen / hands: optional boolean masks at the frame's size (screen area to look in, hands to skip)."""
    P = P or prepare(frame)
    sc = P['scale']
    if screen is not None and screen.shape != P['shape']:
        screen = cv2.resize(screen.astype(np.uint8), P['shape'][::-1], interpolation=cv2.INTER_NEAREST) > 0
    if hands is not None and hands.shape != P['shape']:
        hands = cv2.resize(hands.astype(np.uint8), P['shape'][::-1], interpolation=cv2.INTER_NEAREST) > 0
    res = []
    for role in ROLES:
        for b in blobs(P, role, (params or PARAMS).get(role), screen, hands):
            x1, y1, x2, y2 = b['box']
            res.append({'role': role, 'x': b['x'] / sc, 'y': b['y'] / sc, 'box': (x1 / sc, y1 / sc, x2 / sc, y2 / sc),
                        'area': b['area'] / sc ** 2, 'score': b['score']})
    return res
