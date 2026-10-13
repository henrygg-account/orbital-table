"""Live-recording probe: model vs new colour detector on frames with the real page on the screen (no labels)."""
import sys, os, json, glob, numpy as np, cv2, time
import torch
torch.set_num_threads(4)
from ultralytics import YOLO
from evalcore import *
import colour as C
HERE = os.path.dirname(os.path.abspath(__file__))
V = os.path.join(HERE, '..', 'videos')
recs = sys.argv[1].split(','); N = int(sys.argv[2])
newp = dict(C.PARAMS); newp.update(json.load(open(R + r'\colour\params_all_0.5.json')))
m = YOLO(os.path.join(HERE, '..', 'runs', 'r4-seg-yolo11s-960', 'weights', 'best.pt'))
out = {}
os.makedirs(R + r'\colour\probe', exist_ok=True)
for rec in recs:
    meta = json.load(open(V + rf'\rec_{rec}.json')); Hm = np.array(meta['H'])
    path = glob.glob(V + rf'\rec_{rec}.*')
    path = [p for p in path if not p.endswith('.json')][0]
    cap = cv2.VideoCapture(path); nf = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    quad = cv2.perspectiveTransform(np.float32([[[-30, -30], [1428.5 + 30, -30], [1428.5 + 30, 803.5 + 30], [-30, 803.5 + 30]]]), np.linalg.inv(Hm))[0]
    scr = np.zeros((960, 1280), np.uint8); cv2.fillConvexPoly(scr, quad.astype(np.int32), 1); scr = scr > 0
    print(rec, nf, flush=True)
    for k in range(N):
        i = int((k + .5) * nf / N)
        cap.set(cv2.CAP_PROP_POS_FRAMES, i); ok, fr = cap.read()
        if not ok: continue
        fr = cv2.resize(fr, (1280, 960)) if fr.shape[1] != 1280 else fr
        name = f'{rec}_{i:05d}'
        cv2.imwrite(R + rf'\colour\probe\{name}.jpg', fr)
        r = m.predict(fr, imgsz=960, conf=0.05, agnostic_nms=True, device='cpu', verbose=False)[0]
        md = [[int(c), round(s, 3), [round(v, 1) for v in b]] for c, s, b in zip(r.boxes.cls.tolist(), r.boxes.conf.tolist(), r.boxes.xyxy.tolist())]
        cd = C.detect(fr, screen=scr, params=newp)
        out[name] = {'model': md, 'colour': [{'role': d['role'], 'x': d['x'], 'y': d['y'], 'box': d['box'], 'area': d['area'], 'score': d['score']} for d in cd],
                     'scr_mean_v': float(cv2.cvtColor(fr, cv2.COLOR_BGR2HSV)[..., 2][scr].mean())}
    json.dump(out, open(R + r'\colour\probe.json', 'w'))
print('done')
