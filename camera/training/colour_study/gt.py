"""GT facts per frame: piece boxes, hand distance, ring brightness, pixel samples. usage: gt.py split every"""
import sys, pickle, numpy as np, cv2
from common import *
split = sys.argv[1]; every = int(sys.argv[2])
idx, smask = pickle.load(open(R + rf'\colour\scr_{split}.pkl', 'rb'))
rng = np.random.default_rng(0)
out = {}
for f in files(split)[::every]:
    im = img(split, f); hsv = cv2.cvtColor(im, cv2.COLOR_BGR2HSV)
    L = labels(split, f)
    scr = cv2.resize(smask[idx[f]], (W, H), interpolation=cv2.INTER_NEAREST) > 0
    pm = np.zeros((H, W), np.uint8); allp = np.zeros((H, W), np.uint8)
    for c, p in L:
        m = poly_mask(p); allp |= m
        if c == 4: pm |= m
    hd = cv2.distanceTransform(1 - pm, cv2.DIST_L2, 3) if pm.any() else None
    bgv = hsv[..., 2]
    rec = {'gt': [], 'scr_frac': float(scr.mean())}
    for c, p in L:
        if c == 4: continue
        m = poly_mask(p); b = bbox(p)
        ys, xs = np.nonzero(m)
        if len(ys) == 0: continue
        k = rng.choice(len(ys), min(300, len(ys)), replace=False)
        dil = cv2.dilate(m, np.ones((17, 17), np.uint8))
        ring = (dil > 0) & (allp == 0)
        rv = float(np.median(bgv[ring])) if ring.any() else -1
        rec['gt'].append({'c': c, 'box': b, 'cx': (b[0] + b[2]) / 2, 'cy': (b[1] + b[3]) / 2, 'area': int(m.sum()),
                          'hand': float(hd[m > 0].min()) if hd is not None else 9999.0, 'ringv': rv,
                          'on_scr': bool(scr[int(np.clip((b[1] + b[3]) / 2, 0, H - 1)), int(np.clip((b[0] + b[2]) / 2, 0, W - 1))]),
                          'hsv': hsv[ys[k], xs[k]]})
    free = scr & (cv2.dilate(allp, np.ones((9, 9), np.uint8)) == 0) if True else scr
    pcs = allp & (1 - pm)
    pool = scr & (cv2.dilate(pcs, np.ones((9, 9), np.uint8)) == 0)   # background incl. persons (skin), no pieces
    ys, xs = np.nonzero(pool)
    if len(ys):
        k = rng.choice(len(ys), min(1500, len(ys)), replace=False)
        rec['neg'] = hsv[ys[k], xs[k]]; rec['neg_person'] = (pm[ys[k], xs[k]] > 0)
    out[f] = rec
pickle.dump(out, open(R + rf'\colour\gt_{split}.pkl', 'wb'))
print(len(out))
