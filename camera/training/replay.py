"""replay.py — test bench for the tracker: recorded video -> cached detections -> tracker -> glitch metrics.

  cache:  .venv/bin/python replay.py cache  [--video videos/rec_20261006-170922.mp4] [--stride 2]
          runs the detector over the video once (MPS) and writes replay/<video>.dets.jsonl: per frame, every box with
          its class, confidence, pixel box and the colour score of each coloured piece inside the box.
  score:  .venv/bin/python replay.py score  [--tracker new|old|both]
          feeds the cached detections through the tracker at the recorded timing and scores the published positions
          against the reviewed SAM labels (sam_out/labels_fixed, every 5th video frame):
            wrong   published > WRONG_MM from the labelled position (a teleport or a swap)
            miss    labelled but not published (dropout)
            jumps   published position moved > JUMP_MM between consecutive frames
            jitter  median frame-to-frame motion while the labelled piece is still (mm)
Detections are mapped with the current calib.json (the camera has barely moved since the recording).
"""
import argparse, json, sys, time
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
OUT = HERE / 'replay'
VIDEO = HERE / 'videos/rec_20261006-170922.mp4'
LABELS = HERE / 'runs/tv-pol-yolo11s-960/sam_out/labels_fixed'
LABEL_STRIDE = 5                 # data_tv_pol/seq frame k = video frame 5k
LABEL_ROLE = {0: 'earth', 1: 'moon', 2: 'seldon-1', 3: 'seldon-2'}
WRONG_MM, JUMP_MM = 60.0, 80.0


def cache(a):
    from ultralytics import YOLO
    from colorcheck import colour_scores
    model = YOLO(a.weights, task='detect')
    cap = cv2.VideoCapture(str(a.video))
    n, fps = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)), cap.get(cv2.CAP_PROP_FPS)
    OUT.mkdir(exist_ok=True)
    out = (OUT / (Path(a.video).stem + '.dets.jsonl')).open('w')
    out.write(json.dumps({'video': str(a.video), 'fps': fps, 'n': n, 'stride': a.stride, 'names': model.names}) + '\n')
    t0, i = time.time(), -1
    while True:
        ok = cap.grab(); i += 1
        if not ok:
            break
        if i % a.stride:
            continue
        ok, frame = cap.retrieve()
        if not ok:
            break
        r = model.predict(frame, imgsz=960, conf=0.03, agnostic_nms=True, verbose=False, device='mps')[0]
        boxes = r.boxes.xyxy.tolist()
        sc = colour_scores(frame, boxes)
        dets = [[model.names[c], round(s, 3), *[round(v, 1) for v in b], *sc[k]]
                for k, (b, c, s) in enumerate(zip(boxes, r.boxes.cls.int().tolist(), r.boxes.conf.tolist()))]
        out.write(json.dumps({'i': i, 'wh': [frame.shape[1], frame.shape[0]], 'dets': dets}) + '\n')
        if i % 600 == 0:
            out.flush(); print(f'{i}/{n}  {time.time() - t0:.0f}s', flush=True)
    out.close()
    print('done', time.time() - t0)


def load_labels(i, wh, cfg, H, to_screen):
    p = LABELS / f'pol1017_{i // LABEL_STRIDE:05d}.txt'
    if not p.exists():
        return None
    out = {}
    for line in p.read_text().split('\n'):
        if line.strip():
            c, u, v, w, h = line.split()
            role = LABEL_ROLE[int(c)]
            if role in cfg['roles']:
                xy = to_screen(float(u), float(v), wh, cfg, role, H)
                if 0 <= xy[0] <= cfg['screen_mm'][0] and 0 <= xy[1] <= cfg['screen_mm'][1]:   # on the table only
                    out[role] = xy
    return out


def score(a):
    import live
    from tracker import Tracker as NewTracker
    cfg, H = live.load_config(), live.load_calib()
    lines = (OUT / (Path(a.video).stem + '.dets.jsonl')).read_text().split('\n')
    meta, frames = json.loads(lines[0]), []
    for x in lines[1:]:
        try:
            frames.append(json.loads(x))
        except ValueError:
            break                                              # the cache is still being written
    fps = meta['fps']
    kinds = ['old', 'new'] if a.tracker == 'both' else [a.tracker]
    for kind in kinds:
        trk = live.Tracker(cfg) if kind == 'old' else NewTracker(cfg)
        if kind == 'old':
            for k, v in (json.loads(live.TUNING_JSON.read_text()) if live.TUNING_JSON.exists() else {}).items():
                if hasattr(trk, k):
                    setattr(trk, k, v)
        conf = 0.05 if kind == 'old' else 0.0
        st = {r: {'wrong': 0, 'miss': 0, 'n': 0, 'jumps': 0, 'still': [], 'ghost': 0} for r in cfg['roles']}
        prev, prev_lab, worst = {}, {}, []
        for f in frames:
            now = f['i'] / fps
            wh = f['wh']
            per_role, alld = {}, []
            for name, c, x1, y1, x2, y2, *sc in f['dets']:
                if c < conf:
                    continue
                role = cfg['map'].get(name, name)
                if role not in cfg['roles']:
                    continue
                u, v = (x1 + x2) / 2 / wh[0], (y1 + y2) / 2 / wh[1]
                x_mm, y_mm = live.to_screen(u, v, wh, cfg, role, H)
                if not live.on_screen(x_mm, y_mm, cfg):
                    continue
                d = {'x_mm': x_mm, 'y_mm': y_mm, 'u': u, 'v': v, 'conf': c, 'box': (x1, y1, x2, y2), 'role': role,
                     'colour': dict(zip(('earth', 'seldon-1', 'seldon-2'), sc)),
                     'size_mm': live.box_size_mm((x1, y1, x2, y2), wh, H) if hasattr(live, 'box_size_mm') else None}
                per_role.setdefault(role, []).append(d); alld.append(d)
            if kind == 'old':
                for role, dets in per_role.items():
                    trk.update(role, dets, now)
                trk.expire(now)
            else:
                trk.step(alld, now)
            pub = {k: (p['x_mm'], p['y_mm']) for k, p in trk.feed(now).items()}
            for k, xy in pub.items():
                if k in prev and np.hypot(xy[0] - prev[k][0], xy[1] - prev[k][1]) > JUMP_MM:
                    st[k]['jumps'] += 1
            lab = load_labels(f['i'], wh, cfg, H, live.to_screen) if f['i'] % LABEL_STRIDE == 0 else None
            if lab is not None:
                for r in cfg['roles']:
                    if r in lab:
                        st[r]['n'] += 1
                        if r not in pub:
                            st[r]['miss'] += 1
                        else:
                            e = np.hypot(pub[r][0] - lab[r][0], pub[r][1] - lab[r][1])
                            if e > WRONG_MM:
                                st[r]['wrong'] += 1; worst.append((round(e), r, f['i']))
                            if r in prev_lab and np.hypot(lab[r][0] - prev_lab[r][0], lab[r][1] - prev_lab[r][1]) < 3 and r in prev:
                                st[r]['still'].append(np.hypot(pub[r][0] - prev[r][0], pub[r][1] - prev[r][1]))
                    elif r in pub:
                        st[r]['ghost'] += 1
                prev_lab = lab
            prev = pub
        print(f'\n== {kind} tracker  ({len(frames)} frames at {fps / meta["stride"]:.0f} fps)')
        print(f'{"piece":<10}{"labelled":>9}{"wrong":>7}{"miss":>6}{"jumps":>7}{"ghost":>7}{"jitter mm":>11}')
        for r, s in st.items():
            j = np.median(s['still']) if s['still'] else float('nan')
            print(f'{r:<10}{s["n"]:>9}{s["wrong"]:>7}{s["miss"]:>6}{s["jumps"]:>7}{s["ghost"]:>7}{j:>11.2f}')
        if a.verbose and worst:
            print('worst:', sorted(worst, reverse=True)[:15])


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('cmd', choices=['cache', 'score'])
    ap.add_argument('--video', default=str(VIDEO))
    ap.add_argument('--weights', default=str(HERE / 'runs/tv-pol-yolo11s-960/weights/best.pt'))
    ap.add_argument('--stride', type=int, default=2)
    ap.add_argument('--tracker', default='both', choices=['old', 'new', 'both'])
    ap.add_argument('-v', '--verbose', action='store_true')
    a = ap.parse_args()
    cache(a) if a.cmd == 'cache' else score(a)
