import sys, json, numpy as np, cv2
from collections import Counter
from evalcore import *
import colour as C
import os
V = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'videos')
P = json.load(open(R + r'\colour\probe.json'))
for tag in ('0.5', '0.1', '0.02'):
    newp = dict(C.PARAMS); newp.update(json.load(open(R + rf'\colour\params_all_{tag}.json')))
    agree, conly, monly = Counter(), Counter(), Counter(); masks = {}
    for name, d in P.items():
        rec = name.rsplit('_', 1)[0]
        if rec not in masks:
            Hm = np.array(json.load(open(V + rf'\rec_{rec}.json'))['H'])
            quad = cv2.perspectiveTransform(np.float32([[[-30, -30], [1458.5, -30], [1458.5, 833.5], [-30, 833.5]]]), np.linalg.inv(Hm))[0]
            s = np.zeros((960, 1280), np.uint8); cv2.fillConvexPoly(s, quad.astype(np.int32), 1); masks[rec] = s > 0
        im = cv2.imread(R + rf'\colour\probe\{name}.jpg')
        cd = [(NAMES.index(x['role']), x['box']) for x in C.detect(im, screen=masks[rec], params=newp)]
        md = [(c, b) for c, s, b in d['model'] if c < 4 and s >= .25]
        ctr = lambda b: ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)
        for c, b in cd:
            if any(m[0] == c and np.hypot(ctr(m[1])[0] - ctr(b)[0], ctr(m[1])[1] - ctr(b)[1]) < 25 for m in md): agree[NAMES[c]] += 1
            else: conly[NAMES[c]] += 1
        for c, b in md:
            if not any(x[0] == c and np.hypot(ctr(x[1])[0] - ctr(b)[0], ctr(x[1])[1] - ctr(b)[1]) < 25 for x in cd): monly[NAMES[c]] += 1
    print(tag, 'agree', dict(agree), '| colour-only', dict(conly), '| model-only', dict(monly))
