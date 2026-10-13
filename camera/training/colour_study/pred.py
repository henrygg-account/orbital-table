"""Run the r4 model on CPU over a split and cache boxes. usage: pred.py <split> [every]"""
import sys, os, json, time
import torch
torch.set_num_threads(4)
from ultralytics import YOLO
from common import R
HERE = os.path.dirname(os.path.abspath(__file__))
split = sys.argv[1]; every = int(sys.argv[2]) if len(sys.argv) > 2 else 1
d = R + rf'\ds\images\{split}'
fs = sorted(os.listdir(d))[::every]
m = YOLO(os.path.join(HERE, '..', 'runs', 'r4-seg-yolo11s-960', 'weights', 'best.pt'))
out = {}; t = time.time()
cp = R + rf'\colour\pred_{split}.json'
if os.path.exists(cp): out = json.load(open(cp))
for i, f in enumerate(fs):
    if f in out: continue
    r = m.predict(d + '\\' + f, imgsz=960, conf=0.05, agnostic_nms=True, device='cpu', verbose=False, retina_masks=False)[0]
    out[f] = [[int(c), round(s, 3), [round(v, 1) for v in b]] for c, s, b in zip(r.boxes.cls.tolist(), r.boxes.conf.tolist(), r.boxes.xyxy.tolist())]
    if i % 50 == 0:
        print(i, len(fs), time.time() - t, flush=True)
        json.dump(out, open(R + rf'\colour\pred_{split}.json', 'w'))
json.dump(out, open(R + rf'\colour\pred_{split}.json', 'w'))
print('done')
