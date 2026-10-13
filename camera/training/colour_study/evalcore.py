import sys, pickle, numpy as np, cv2
import os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
from common import *

MM_PER_PX = 1.75   # screen mm per 1280-px pixel (calib H of the day's recordings: ~1.75)


def screen_full(split, f, idx, smask):
    return cv2.resize(smask[idx[f]], (W, H), interpolation=cv2.INTER_NEAREST) > 0


def load_split(split):
    idx, smask = pickle.load(open(R + rf'\colour\scr_{split}.pkl', 'rb'))
    gt = pickle.load(open(R + rf'\colour\gt_{split}.pkl', 'rb'))
    return idx, smask, gt


def radius(g):
    b = g['box']
    return 0.5 * max(b[2] - b[0], b[3] - b[1]) + 8


def match(dets, gts, scr=None):
    """dets: [(cls, conf, box)] frame px; gts: GT dicts. Returns per-GT results and the unmatched dets.
    GT result: ('tp', err_px) | ('id', det_cls) | ('miss',). Det result: 'phantom' | 'dup'."""
    used = set(); res = []
    for g in gts:
        r = radius(g)
        cand = []
        for i, (c, s, b) in enumerate(dets):
            d = np.hypot((b[0] + b[2]) / 2 - g['cx'], (b[1] + b[3]) / 2 - g['cy'])
            if d <= r: cand.append((d, i, c))
        same = [x for x in cand if x[2] == g['c']]
        if same:
            d, i, _ = min(same); used.add(i); res.append(('tp', d))
            for d2, i2, c2 in cand:
                if i2 != i and c2 == g['c']: used.add(i2)    # duplicates on the same piece are not counted as phantoms
        elif cand:
            d, i, c = min(cand); used.add(i); res.append(('id', c))
        else:
            res.append(('miss',))
    ph = [i for i in range(len(dets)) if i not in used]
    return res, ph
