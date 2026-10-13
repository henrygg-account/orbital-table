import os, json, cv2, numpy as np
R = os.environ.get('COLOUR_STUDY_DIR', r'C:\study')   # holds ds\ (the r4 dataset), colour\ (caches and results)
W, H = 1280, 960
NAMES = ['earth', 'moon', 'seldon-1', 'seldon-2', 'person']


def files(split):
    return sorted(os.listdir(R + rf'\ds\images\{split}'))


def img(split, f):
    return cv2.imread(R + rf'\ds\images\{split}\{f}')


def labels(split, f):
    """-> list of (cls, polygon px Nx2)"""
    p = R + rf'\ds\labels\{split}\{f[:-4]}.txt'
    out = []
    for line in open(p).read().split('\n'):
        t = line.split()
        if len(t) < 7:
            continue
        a = np.array(t[1:], float).reshape(-1, 2) * [W, H]
        out.append((int(t[0]), a))
    return out


def bbox(poly):
    return [poly[:, 0].min(), poly[:, 1].min(), poly[:, 0].max(), poly[:, 1].max()]


def poly_mask(poly, shape=(H, W)):
    m = np.zeros(shape, np.uint8); cv2.fillPoly(m, [poly.astype(np.int32)], 1); return m


def screen_mask_from(frames_bgr, sw=320):
    """The screen = largest dark region of the median of several frames (as color_prompts.py), filled hull."""
    imgs = [cv2.resize(f, (sw, sw * 3 // 4), interpolation=cv2.INTER_AREA) for f in frames_bgr]
    bg = np.median(np.stack(imgs), axis=0).astype(np.uint8)
    hsv = cv2.cvtColor(bg, cv2.COLOR_BGR2HSV)
    dark = cv2.inRange(hsv, (0, 0, 0), (180, 255, 24))
    dark = cv2.morphologyEx(dark, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    n, lab, st, _ = cv2.connectedComponentsWithStats(dark)
    k = 1 + int(np.argmax(st[1:, cv2.CC_STAT_AREA]))
    m = np.zeros(dark.shape, np.uint8)
    cv2.fillConvexPoly(m, cv2.convexHull(cv2.findNonZero((lab == k).astype(np.uint8))), 255)
    m = cv2.resize(m, (W, H), interpolation=cv2.INTER_NEAREST)
    return m > 0

