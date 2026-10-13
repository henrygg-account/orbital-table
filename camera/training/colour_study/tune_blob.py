import sys, copy, json, numpy as np, cv2
from evalcore import *
import colour as C
split = sys.argv[1]; step = int(sys.argv[2]); LAM = float(sys.argv[3])
idx, smask, gt = load_split(split)
fs = sorted(gt)[::step]
Ps, scrs = [], []
for f in fs:
    Ps.append(C.prepare(img(split, f)))
    scrs.append(cv2.resize(smask[idx[f]], (640, 480), interpolation=cv2.INTER_NEAREST) > 0)
print('frames', len(fs), flush=True)
role_i = {r: i for i, r in enumerate(C.ROLES)}   # colour.ROLES order: earth, moon, seldon-1, seldon-2 == class ids
sc = 640 / W


def score(role, prm):
    c = role_i[role]; tp = miss = ph = 0
    for f, P, scr in zip(fs, Ps, scrs):
        bl = C.blobs(P, role, prm, scr)
        dets = [(c, b['score'], (b['box'][0] / sc, b['box'][1] / sc, b['box'][2] / sc, b['box'][3] / sc)) for b in bl]
        gts = [g for g in gt[f]['gt'] if g['c'] == c and g['on_scr']]
        res, p = match(dets, gts)
        tp += sum(r[0] == 'tp' for r in res); miss += sum(r[0] != 'tp' for r in res); ph += len(p)
    n = max(1, tp + miss)
    return tp / n, ph / len(fs)


def J(r): return r[0] - LAM * r[1]


GRID = {'s': lambda p: [(a, 255) for a in (40, 55, 70, 85, 100, 115, 130, 150, 170, 190)] if p['s'][1] == 255 else [(0, a) for a in (30, 40, 50, 60, 70, 85, 100)],
        'v': lambda p: [20, 28, 36, 45, 55, 70, 85, 100, 115, 130],
        'th': lambda p: [4, 8, 12, 16, 22, 30, 40, 55, 70, 85, 100],
        'close': lambda p: [1, 3, 5, 7],
        'area': lambda p: [(a, b) for a in (4, 8, 12, 20, 30) for b in (200, 400, 700, 1200)],
        'aspect': lambda p: [1.5, 2.0, 3.0, 6.0],
        'h': lambda p: [] if p['h'] is None else [(lo, hi) for lo in range(max(0, p['h'][0] - 6), min(179, p['h'][0] + 7), 3) for hi in range(max(0, p['h'][1] - 6), min(179, p['h'][1] + 7), 3)]}
final = {}
for role in [sys.argv[4]]:
    prm = copy.deepcopy(C.PARAMS[role]); r0 = score(role, prm); cur = J(r0)
    print(role, 'start', r0, flush=True)
    for it in range(2):
        for key in ('th', 'v', 's', 'h', 'area', 'close', 'aspect'):
            best = (cur, prm[key], r0)
            for val in GRID[key](prm):
                if key == 'h' and val[0] == val[1]: continue
                q = copy.deepcopy(prm); q[key] = val
                r = score(role, q)
                if J(r) > best[0] + 1e-9: best = (J(r), val, r)
            if best[1] != prm[key]:
                prm[key] = best[1]; cur = best[0]; r0 = best[2]
        print(role, 'iter', it, prm, 'recall %.3f phantoms/frame %.3f' % r0, flush=True)
    final[role] = prm
json.dump(final, open(R + rf'\colour\params_{sys.argv[4]}_{LAM}.json', 'w'))
