"""Evaluate model / current colour rules / new colour detector / fusions on a split. usage: run_eval.py val [params.json]"""
import sys, json, pickle, time, numpy as np, cv2
from collections import defaultdict
from evalcore import *
import colour as C
import colorcheck as CC
from tracker import Tracker

split = sys.argv[1]
newp = dict(C.PARAMS)
if len(sys.argv) > 2:
    newp.update(json.load(open(sys.argv[2])))
idx, smask, gt = load_split(split)
pred = json.load(open(R + rf'\colour\pred_{split}.json'))
fs = sorted(gt)
sc640 = 640 / W
cfg = {'roles': {'earth': {'count': 1}, 'moon': {'count': 1}, 'seldon-1': {'count': 1}, 'seldon-2': {'count': 1}}, 'screen_mm': (1428.5, 803.5)}
TK = Tracker(cfg)
ROLE = ['earth', 'moon', 'seldon-1', 'seldon-2']
OLDP = {'earth': dict(h=(85, 118), s=(71, 255), v=29, th=-1, area=(12, 600), aspect=3.0, close=3),
        'moon': dict(h=None, s=(0, 79), v=111, th=-1, area=(25, 700), aspect=3.0, close=3),
        'seldon-1': dict(h=(15, 31), s=(101, 255), v=46, th=-1, area=(6, 500), aspect=6.0, close=3),
        'seldon-2': dict(h=(165, 6), s=(111, 255), v=36, th=-1, area=(6, 500), aspect=6.0, close=3)}


def inb(b, scr):
    x = int(np.clip((b[0] + b[2]) / 2, 0, W - 1)); y = int(np.clip((b[1] + b[3]) / 2, 0, H - 1))
    return scr[y, x]


def centre(b): return ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)


def model_dets(f, t, scr):
    return [(c, s, tuple(b)) for c, s, b in pred[f] if c < 4 and s >= t and inb(b, scr)]


DEF = {k: getattr(TK, k) for k in ('COLOUR_RATIO', 'COLOUR_PLACE', 'COLOUR_NONE', 'PLACE_MIN_MM')}


def tracker_rules(img_, dets, scr, fix=True, none=True, place=True, attrs=None, fix_below=1.1, none_below=1.1):
    """The tracker's colour logic, per frame: colour_fix, colourless halving, placeable() (each switchable)."""
    for k, v in DEF.items(): setattr(TK, k, v)
    for k, v in (attrs or {}).items(): setattr(TK, k, v)
    boxes = [d[2] for d in dets]
    sc = CC.colour_scores(img_, boxes) if boxes else []
    out = []
    for (c, s, b), cs in zip(dets, sc):
        d = {'role': ROLE[c], 'conf': s, 'colour': dict(zip(CC.ROLES, cs)),
             'size_mm': float(np.hypot(b[2] - b[0], b[3] - b[1]) * MM_PER_PX)}
        if not TK.size_ok(d): continue
        if fix and s < fix_below: d = TK.colour_fix(d)
        if none and s < none_below and TK.colourless(d): d = {**d, 'conf': d['conf'] * 0.5}
        if d['conf'] < TK.CONF_TRACK: continue
        if place:
            if TK.placeable(d): out.append((ROLE.index(d['role']), d['conf'], b))
        elif d['conf'] >= TK.CONF_NEW: out.append((ROLE.index(d['role']), d['conf'], b))
    return out


def colour_blobs(P, scr640, params, topk):
    out = []
    for c, role in enumerate(ROLE):
        bl = C.blobs(P, role, params[role], scr640)
        bl.sort(key=lambda b: -b['area'] * b['score'])
        for b in (bl[:1] if topk else bl):
            out.append((c, b['score'], tuple(v / sc640 for v in b['box'])))
    return out


def overlaps(b, dets, r=None):
    cx, cy = centre(b)
    r = r or 0.5 * max(b[2] - b[0], b[3] - b[1]) + 8
    return [d for d in dets if np.hypot(centre(d[2])[0] - cx, centre(d[2])[1] - cy) <= r]


METHODS = ['model>=0.25', 'model>=0.5', 'tracker colour rules (conf>=0.05)', 'old colour blobs', 'new colour blobs (all)', 'new colour (top-1/class)',
           'F1 model>=0.25 OR colour', 'F2 model>=0.25 confirmed by colour', 'F3 model>=0.25 + colour identity', 'F4 model>=0.5 OR (model>=0.1 + colour) OR colour-only', 'F5 = F4 without Earth colour-only',
           'model>=0.30', 'rules: colour_fix only', 'rules: colourless-halving only', 'rules: placement only', 'model>=0.1', 'model>=0.05',
           'var: placement, no Earth size floor', 'var: placement, Earth floor 45 mm', 'var: placement, no colour placement', 'var: placement, no colourless block',
           'var: colour_fix only if conf<0.5', 'var: colour_fix ratio 6', 'var: RECOMMENDED rules']
CONF = defaultdict(lambda: defaultdict(int)); PHD = []
S = {m: defaultdict(lambda: defaultdict(float)) for m in METHODS}   # S[method][class or 'all'][counter]
errs = {m: defaultdict(list) for m in METHODS}
t0 = time.time()
for n, f in enumerate(fs):
    im = img(split, f)
    scr = screen_full(split, f, idx, smask)
    scr640 = cv2.resize(smask[idx[f]], (640, 480), interpolation=cv2.INTER_NEAREST) > 0
    G = gt[f]['gt']; gts = [g for g in G if g['on_scr']]
    P = C.prepare(im)
    # person distance (for phantoms)
    pm = np.zeros((H, W), np.uint8)
    for c, p in labels(split, f):
        if c == 4: cv2.fillPoly(pm, [p.astype(np.int32)], 1)
    hd = cv2.distanceTransform(1 - pm, cv2.DIST_L2, 3) if pm.any() else None
    vch = P['v']
    m25, m50, m10 = model_dets(f, .25, scr), model_dets(f, .5, scr), model_dets(f, .1, scr)
    m05 = model_dets(f, .05, scr)
    nb = colour_blobs(P, scr640, newp, False)
    tk = colour_blobs(P, scr640, newp, True)
    ob = colour_blobs(P, scr640, OLDP, False)
    # fusions
    F1 = list(m25)
    for d in nb:
        if not any(x[0] == d[0] for x in m25) and not overlaps(d[2], m25): F1.append(d)
    F2 = [d for d in m25 if any(x[0] == d[0] for x in overlaps(d[2], nb))]
    F3 = []
    for d in m25:
        ov = [x for x in overlaps(d[2], nb) if x[0] in (2, 3) and d[0] in (2, 3)]
        F3.append((ov[0][0], d[1], d[2]) if ov and ov[0][0] != d[0] else d)
    def f4(earth_colour_only):
        out = []
        for d in m10:
            if d[1] >= .5 or any(x[0] == d[0] for x in overlaps(d[2], nb)): out.append(d)
        for d in tk:
            if d[0] == 0 and not earth_colour_only: continue
            if not any(x[0] == d[0] for x in out) and not overlaps(d[2], out): out.append(d)
        return out
    F4, F5 = f4(True), f4(False)
    runs = {'model>=0.25': m25, 'model>=0.5': m50, 'tracker colour rules (conf>=0.05)': tracker_rules(im, m05, scr),
            'old colour blobs': ob, 'new colour blobs (all)': nb, 'new colour (top-1/class)': tk, 'F1 model>=0.25 OR colour': F1,
            'F2 model>=0.25 confirmed by colour': F2, 'F3 model>=0.25 + colour identity': F3, 'F4 model>=0.5 OR (model>=0.1 + colour) OR colour-only': F4,
            'F5 = F4 without Earth colour-only': F5,
            'model>=0.30': model_dets(f, .30, scr), 'rules: colour_fix only': tracker_rules(im, m05, scr, True, False, False),
            'rules: colourless-halving only': tracker_rules(im, m05, scr, False, True, False),
            'rules: placement only': tracker_rules(im, m05, scr, False, False, True), 'model>=0.1': m10, 'model>=0.05': m05,
            'var: placement, no Earth size floor': tracker_rules(im, m05, scr, False, False, True, {'PLACE_MIN_MM': {}}),
            'var: placement, Earth floor 45 mm': tracker_rules(im, m05, scr, False, False, True, {'PLACE_MIN_MM': {'earth': 45.0}}),
            'var: placement, no colour placement': tracker_rules(im, m05, scr, False, False, True, {'COLOUR_PLACE': 9}),
            'var: placement, no colourless block': tracker_rules(im, m05, scr, False, False, True, {'COLOUR_NONE': -1}),
            'var: colour_fix only if conf<0.5': tracker_rules(im, m05, scr, True, False, False, None, .5),
            'var: colour_fix ratio 6': tracker_rules(im, m05, scr, True, False, False, {'COLOUR_RATIO': 6.0}),
            'var: RECOMMENDED rules': tracker_rules(im, m05, scr, True, True, True, {'COLOUR_RATIO': 6.0, 'COLOUR_PLACE': 9, 'PLACE_MIN_MM': {'earth': 45.0}}, .5, .5)}
    for m, dets in runs.items():
        dets = [d for d in dets if inb(d[2], scr)]
        res, ph = match(dets, gts)
        offs = [g for g in G if not g['on_scr']]            # pieces just past the screen mask edge are not phantoms
        ph = [i for i in ph if not any(np.hypot(centre(dets[i][2])[0] - g['cx'], centre(dets[i][2])[1] - g['cy']) <= radius(g) for g in offs)]
        s = S[m]
        if m in ('model>=0.25', 'new colour blobs (all)'):
            for g, r in zip(gts, res):
                if r[0] == 'id': CONF[m][f'{ROLE[g["c"]]}->{ROLE[r[1]]}'] += 1
            if m == 'model>=0.25':
                for i in ph: PHD.append([f, dets[i][0], dets[i][1], [round(v) for v in dets[i][2]]])
        for g, r in zip(gts, res):
            cl = ROLE[g['c']]
            near = 'hand' if g['hand'] <= 20 else 'free' if g['hand'] > 60 else None
            bright = 'bright' if g['ringv'] > 40 else 'dark'
            keys = [cl, 'all'] + ([f'{cl}|{near}', f'all|{near}'] if near else []) + [f'{cl}|{bright}', f'all|{bright}']
            for k in keys:
                s[k]['n'] += 1
                if r[0] == 'tp': s[k]['tp'] += 1
                elif r[0] == 'id':
                    s[k]['id'] += 1
                    if g['c'] in (2, 3) and r[1] in (2, 3): s[k]['seldon_swap'] += 1
            if r[0] == 'tp':
                errs[m][cl].append(r[1]); errs[m]['all'].append(r[1])
        for i in ph:
            c, sco, b = dets[i]
            cl = ROLE[c]
            cx, cy = centre(b)
            near = hd is not None and hd[int(np.clip(cy, 0, H - 1)), int(np.clip(cx, 0, W - 1))] <= 40
            vv = float(np.median(vch[max(0, int(cy * sc640) - 8):int(cy * sc640) + 9, max(0, int(cx * sc640) - 8):int(cx * sc640) + 9])) if True else 0
            bright = vv > 40
            for k in (cl, 'all'):
                s[k]['ph'] += 1
                if near: s[k]['ph_hand'] += 1
                if bright: s[k]['ph_bright'] += 1
        s['all']['frames'] = n + 1
    if n % 200 == 0: print(n, len(fs), round(time.time() - t0), flush=True)
out = {m: {k: dict(v) for k, v in S[m].items()} for m in METHODS}
for m in METHODS:
    for k, e in errs[m].items():
        out[m].setdefault(k, {})['err_med'] = float(np.median(e)) if e else None
        out[m][k]['err_mean'] = float(np.mean(e)) if e else None
out['_conf'] = {m: dict(v) for m, v in CONF.items()}; out['_phantoms_model25'] = PHD
tag = sys.argv[3] if len(sys.argv) > 3 else ''
json.dump(out, open(R + rf'\colour\result_{split}{tag}.json', 'w'), indent=1)
print('done')
