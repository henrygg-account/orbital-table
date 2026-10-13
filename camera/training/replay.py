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


# ---------------------------------------------------------------- round-4 bench (hand gate)
def dcache(a):
    """Run live.py's detection path (screen crop, seg model, person outlines, colour scores) over a recording on the CPU
    and keep per frame: every detection and every person outline (camera px). Replays then cost nothing."""
    import pickle
    import live
    from ultralytics import YOLO
    from colorcheck import ROLES, colour_scores
    vid = Path(a.video)
    meta = json.loads(vid.with_suffix('.json').read_text())
    H = np.array(meta['H'], dtype=np.float64).reshape(3, 3)
    model = YOLO(a.weights, task='segment')
    cap = cv2.VideoCapture(str(vid))
    fw, fh = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    crop = live.screen_crop(H, (fw, fh), meta['screen_mm'])
    sz = live.crop_imgsz(crop, (fw, fh), 960)
    x0, y0, x1, y1 = crop
    frames, i, t0 = [], 0, time.time()
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        r = model.predict(np.ascontiguousarray(frame[y0:y1, x0:x1]), imgsz=sz, conf=0.05, agnostic_nms=True, verbose=False,
                          device='cpu')[0]
        boxes = [[b[0] + x0, b[1] + y0, b[2] + x0, b[3] + y0] for b in r.boxes.xyxy.tolist()]
        sc = colour_scores(frame, boxes)
        polys = [p + np.float32([x0, y0]) for p in r.masks.xy] if getattr(r, 'masks', None) is not None else [None] * len(boxes)
        dets = [{'name': r.names[c], 'conf': s, 'box': tuple(b), 'colour': dict(zip(ROLES, sc[k])),
                 'poly': np.float32(polys[k]) if r.names[c] == 'person' and polys[k] is not None else None}
                for k, (b, c, s) in enumerate(zip(boxes, r.boxes.cls.int().tolist(), r.boxes.conf.tolist()))]
        frames.append(dets)
        i += 1
        if i % 50 == 0:
            print(f'{vid.name} {i}/{meta["frames"]} {time.time() - t0:.0f}s', flush=True)
    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    pickle.dump({'meta': meta, 'wh': (fw, fh), 'frames': frames}, (out / (vid.stem + '.pkl')).open('wb'))
    print('done', vid.name, len(frames), f'{time.time() - t0:.0f}s')


PAGE = {'tau': 0.24, 'tau_move': 0.6, 'lead': 0.6}     # live.py PAGE_KNOBS (demo.html's easing); overridden by --set page_tau_s=...
HAND_PERSON_CONF = 0.4


def run_tracker(rec, cfg, knobs, fps=None):
    """Feed one dcache pickle through a Tracker. -> per frame {'t', 'pub': {id: feed entry}, 'dets': [...], 'hands': [mm polys]}."""
    import live
    from tracker import Tracker
    meta, wh = rec['meta'], rec['wh']
    H = np.array(meta['H'], dtype=np.float64).reshape(3, 3)
    trk = Tracker(cfg)
    for k, v in knobs.items():
        if hasattr(trk, k):
            setattr(trk, k, type(getattr(trk, k))(v))
    fps = fps or meta['fps']
    out = []
    for n, frame in enumerate(rec['frames']):
        now = n / fps
        dets, polys = [], []
        for r in frame:
            role = cfg['map'].get(r['name'], r['name'])
            if role == 'person':
                if r['conf'] >= HAND_PERSON_CONF and r['poly'] is not None:
                    polys.append(r['poly'])
                continue
            if role not in cfg['roles']:
                continue
            x1, y1, x2, y2 = r['box']
            u, v = (x1 + x2) / 2 / wh[0], (y1 + y2) / 2 / wh[1]
            x_mm, y_mm = live.to_screen(u, v, wh, cfg, role, H)
            if not live.on_screen(x_mm, y_mm, cfg):
                continue
            dets.append({'role': role, 'x_mm': x_mm, 'y_mm': y_mm, 'u': u, 'v': v, 'conf': r['conf'], 'box': r['box'],
                         'colour': r['colour'], 'size_mm': live.box_size_mm(r['box'], wh, H)})
        hands = live.polys_to_mm(polys, H)
        trk.step(dets, now, hands)
        out.append({'t': now, 'pub': trk.feed(now), 'dets': dets, 'hands': hands, 'cand': {r: (c['n'], round(c['x']), round(c['y'])) for r, c in trk.cand.items()}})
    return out


def page_view(series, t_end, knobs):
    """What demo.html draws: each piece eased toward the feed (tau by speed, lead along velocity), at 30 fps.
    series: [(t, {id: feed entry})]. -> {id: [(t, x, y)]}"""
    tau, tau_m, lead = knobs.get('page_tau_s', PAGE['tau']), knobs.get('page_tau_move_s', PAGE['tau_move']), knobs.get('page_lead_s', PAGE['lead'])
    view, out, j, dt, t = {}, {}, 0, 1 / 30, 0.0
    cur = {}
    while t <= t_end:
        while j < len(series) and series[j][0] <= t:
            cur = series[j][1]; j += 1
        for i, p in cur.items():
            f = min(1.0, np.hypot(p['vx'], p['vy']) / 150)
            a = 1 - np.exp(-dt / max(.001, tau + (tau_m - tau) * f))
            tx, ty = p['x_mm'] + p['vx'] * lead, p['y_mm'] + p['vy'] * lead
            if i not in view:
                view[i] = [tx, ty]
            view[i][0] += (tx - view[i][0]) * a; view[i][1] += (ty - view[i][1]) * a
            out.setdefault(i, []).append((t, view[i][0], view[i][1]))
        for i in [i for i in view if i not in cur]:
            del view[i]
        t += dt
    return out


def events(series, hands_by_t, move_mm=10.0):
    """Published displacement events of one piece. series: [(t, x, y)] (consecutive, gaps = piece absent).
    -> [{t0, t1, a, b, d, hand}] where hand = min distance (mm) from the piece to any hand outline during the event."""
    ev, i, n = [], 0, len(series)
    while i < n:
        t0, x0, y0 = series[i]
        j = i
        while j + 1 < n and series[j + 1][0] - series[j][0] < 0.5 and np.hypot(series[j + 1][1] - x0, series[j + 1][2] - y0) <= move_mm:
            j += 1
        if j + 1 >= n or series[j + 1][0] - series[j][0] >= 0.5:
            i = j + 1; continue
        k = j + 1                                                # first frame beyond move_mm: the event starts; ends when it stops
        while k + 1 < n and series[k + 1][0] - series[k][0] < 0.5 and not (
                series[k + 1][0] - series[k][0] > 0 and series[min(n - 1, k + 8)][0] - series[k][0] < 1.5
                and max(np.hypot(s[1] - series[k][1], s[2] - series[k][2]) for s in series[k:k + 9]) < 3.0):
            k += 1
        hd = min(hands_by_t(series[m][0], series[m][1], series[m][2]) for m in range(max(i, j - 4), min(n, k + 1)))
        ev.append({'t0': series[j][0], 't1': series[k][0], 'a': (x0, y0), 'b': (series[k][1], series[k][2]),
                   'd': float(np.hypot(series[k][1] - x0, series[k][2] - y0)), 'hand': hd})
        i = k
    return ev


def synth(cfg, knobs, fps=18.0, seed=1):
    """A locked piece with detector noise (sigma 2 mm, 4% outliers of 20-40 mm), then pushed 50 mm in 0.25 s with no hand.
    -> (published rms wobble while still, s until published is within 10 mm, s until the page's view is, mean 'moving' flag while still)"""
    from tracker import Tracker
    rng = np.random.default_rng(seed)
    trk = Tracker(cfg)
    for k, v in knobs.items():
        if hasattr(trk, k):
            setattr(trk, k, type(getattr(trk, k))(v))
    base, push_t, n = np.array([700.0, 400.0]), 10.0, int(14 * fps)
    pub, series, still = [], [], []
    for k in range(n):
        t = k / fps
        s = min(1.0, max(0.0, (t - push_t) / 0.25))
        z = base + np.array([50.0 * s, 0.0]) + rng.normal(0, 2.0, 2)
        if rng.random() < 0.04:
            z = z + rng.normal(0, 1, 2) / 1.4 * rng.choice([20, 30, 40])
        trk.step([{'role': 'seldon-1', 'x_mm': z[0], 'y_mm': z[1], 'u': 0, 'v': 0, 'conf': 0.8, 'colour': None}], t)
        f = trk.feed(t)
        if 'seldon-1' in f:
            p = f['seldon-1']; pub.append((t, p['x_mm'], p['y_mm'])); series.append((t, f))
            if 2.5 < t < push_t - 0.5:
                still.append((p['x_mm'], p['y_mm'], p['moving']))
    pv = page_view([(t, {'seldon-1': f['seldon-1']}) for t, f in series], (n - 1) / fps, knobs)['seldon-1']
    st = np.array(still)
    wob = float(np.sqrt(np.mean(np.sum((st[:, :2] - np.median(st[:, :2], 0)) ** 2, 1))))
    def reach(ser):
        for q in ser:
            if q[0] >= push_t and abs(q[1] - (base[0] + 50)) < 10:
                return q[0] - push_t
        return float('nan')
    return wob, reach(pub), reach(pv), float(st[:, 2].mean())


def bench(a):
    import pickle
    import live
    cfg = live.load_config()
    knobs = {}
    for kv in a.set:
        k, v = kv.split('=')
        knobs[k] = float(v)
    wob, lp, lv, mv = np.mean([synth(cfg, knobs, seed=s) for s in range(1, 6)], 0) if True else (0, 0, 0, 0)
    print(f'synthetic locked piece (noise 2 mm + 4% outliers), pushed 50 mm in 0.25 s: wobble {wob:.2f} mm rms, '
          f'push reaches 10 mm: published {lp:.2f} s, page view {lv:.2f} s, "moving" while still {mv * 100:.1f}%')
    tot = {'jit': [], 'raw_jit': [], 'still_s': 0.0, 'ev': 0, 'ev_hand': 0, 'ev_ret': 0, 'ev_ret_hand': 0, 'lag': [],
           'seg': 0, 'phantom': 0, 'drop': 0, 'pieces_s': 0.0, 'page_jit': [], 'mov_ep': 0, 'mov_idle': 0, 'carry': [], 'pub_frames': 0, 'bridged': 0, 'late': 0}
    rows = []
    for path in a.cache:
        rec = pickle.load(open(path, 'rb'))
        run = run_tracker(rec, cfg, knobs)
        fps = rec['meta']['fps']
        by_id, roles, mov = {}, {}, {}
        for fr in run:
            for i, p in fr['pub'].items():
                by_id.setdefault(i, []).append((fr['t'], p['x_mm'], p['y_mm'])); roles[i] = p['role']
                mov.setdefault(i, []).append(p['moving'])
        for i, ser in by_id.items():                             # 'moving' episodes that went nowhere: the page eases / leads on noise
            m, k = mov[i], 0
            while k < len(m):
                if m[k]:
                    j = k
                    while j + 1 < len(m) and m[j + 1]:
                        j += 1
                    tot['mov_ep'] += 1
                    tot['mov_idle'] += float(np.hypot(ser[j][1] - ser[max(0, k - 1)][1], ser[j][2] - ser[max(0, k - 1)][2])) < 20
                    k = j
                k += 1

        def hand_d(t, x, y, run=run, fps=fps):
            fr = run[min(len(run) - 1, int(round(t * fps)))]
            return min([live_hd(h, x, y) for h in fr['hands']] or [np.inf])
        name = Path(path).stem.replace('rec_20261012-', '')
        pv = page_view([(fr['t'], fr['pub']) for fr in run], run[-1]['t'], knobs)
        for i, ser in by_id.items():
            # presence segments
            segs, cur = [], [ser[0]]
            for s in ser[1:]:
                if s[0] - cur[-1][0] > 0.35:
                    segs.append(cur); cur = []
                cur.append(s)
            segs.append(cur)
            tot['seg'] += len(segs)
            tot['phantom'] += sum(1 for s in segs if s[-1][0] - s[0][0] < 1.5 and len(s) < 15)
            for s0, s1 in zip(segs, segs[1:]):
                if s1[0][0] - s0[-1][0] < 10:
                    tot['drop'] += 1
            tot['pieces_s'] += sum(s[-1][0] - s[0][0] for s in segs)
            # jitter in 2 s windows: raw detection steady (piece truly still) -> published / page wobble
            pxy = np.array([[s[1], s[2]] for s in ser]); pt = np.array([s[0] for s in ser])
            w = int(2 * fps)
            for k in range(0, len(ser) - w, w):
                blk, tb = pxy[k:k + w], pt[k:k + w]
                if tb[-1] - tb[0] > 2.4:
                    continue
                med = np.median(blk, 0)
                raw = []
                for fr in run[int(tb[0] * fps):int(tb[0] * fps) + w]:
                    c = [d for d in fr['dets'] if d['role'] == roles[i] and d['conf'] >= 0.2
                         and np.hypot(d['x_mm'] - med[0], d['y_mm'] - med[1]) < 60]
                    if c:
                        c = min(c, key=lambda d: np.hypot(d['x_mm'] - med[0], d['y_mm'] - med[1]))
                        raw.append((c['x_mm'], c['y_mm']))
                if len(raw) < 0.7 * w:
                    continue
                raw = np.array(raw); rm = np.median(raw, 0)
                if np.percentile(np.hypot(raw[:, 0] - rm[0], raw[:, 1] - rm[1]), 90) > 15:
                    continue                                     # the raw detection itself moved: not a still piece
                tot['jit'].append(np.sqrt(np.mean(np.sum((blk - med) ** 2, 1))))
                tot['raw_jit'].append(np.sqrt(np.mean(np.sum((raw - rm) ** 2, 1))))
                tot['still_s'] += tb[-1] - tb[0]
                pg = np.array([[q[1], q[2]] for q in pv.get(i, []) if tb[0] <= q[0] <= tb[-1]])
                if len(pg):
                    tot['page_jit'].append(np.sqrt(np.mean(np.sum((pg - np.median(pg, 0)) ** 2, 1))))
            for ev in events(ser, hand_d):
                tot['ev'] += 1
                near = ev['hand'] < 90
                tot['ev_hand'] += near
                rows.append([name, i, ev, near, False])
                if ev['d'] >= 50:                                # carry error: published vs the piece's own confident detection
                    for n in range(max(0, int((ev['t0'] - 0.5) * fps)), min(len(run), int((ev['t1'] + 1.5) * fps))):
                        fr = run[n]
                        c = [d for d in fr['dets'] if d['role'] == roles[i] and d['conf'] >= 0.5]
                        q = fr['pub'].get(i)
                        if c and q:
                            c = max(c, key=lambda d: d['conf'])
                            tot['carry'].append(np.hypot(c['x_mm'] - q['x_mm'], c['y_mm'] - q['y_mm']))
        # coverage: published while no confident detection of that piece is near it (bridged), and a confident detection of a
        # role with no published piece for a second or more (late)
        late = {}
        for fr in run:
            for i, p in fr['pub'].items():
                tot['pub_frames'] += 1
                if not any(d['role'] == p['role'] and d['conf'] >= 0.3 and np.hypot(d['x_mm'] - p['x_mm'], d['y_mm'] - p['y_mm']) < 60
                           for d in fr['dets']):
                    tot['bridged'] += 1
            have = {p['role'] for p in fr['pub'].values()}
            for r in {d['role'] for d in fr['dets'] if d['conf'] >= 0.5}:
                late[r] = late.get(r, 0) + 1 if r not in have else 0
                tot['late'] += late[r] == int(fps)               # counted once per second-long stretch
            for r in [r for r in late if r in have]:
                late[r] = 0
        # returned events: a later event of the same piece ends within 15 mm of this one's start within 6 s
        by_piece = {}
        for r in rows:
            if r[0] == name:
                by_piece.setdefault(r[1], []).append(r)
        for i, lst in by_piece.items():
            for r, nxt in zip(lst, lst[1:]):
                ret = nxt[2]['t0'] - r[2]['t1'] < 6 and np.hypot(nxt[2]['b'][0] - r[2]['a'][0], nxt[2]['b'][1] - r[2]['a'][1]) < 15
                r[4] = ret
                if ret:
                    tot['ev_ret'] += 1; tot['ev_ret_hand'] += r[3]
    big = [r for r in rows if r[2]['d'] >= 50]
    j = np.array(tot['jit']) if tot['jit'] else np.array([np.nan])
    pj = np.array(tot['page_jit']) if tot['page_jit'] else np.array([np.nan])
    print(f'knobs {knobs}')
    print(f'still windows {tot["still_s"]:.0f} s: published jitter rms median {np.median(j):.2f} mm, p90 {np.percentile(j, 90):.2f}, '
          f'page view median {np.median(pj):.2f} / p90 {np.percentile(pj, 90):.2f}  (raw detection {np.median(tot["raw_jit"] or [np.nan]):.2f})')
    print(f'moves >10 mm: {tot["ev"]}  with a hand within 90 mm: {tot["ev_hand"]}  returned to start within 6 s (false): {tot["ev_ret"]}'
          f' (hand {tot["ev_ret_hand"]})   moves >= 50 mm: {len(big)}')
    blips = [r for r in rows if r[2]['d'] < 15]
    print(f'blips (jumped > 10 mm, ended < 15 mm from where it started: false moves): {len(blips)}, with a hand within 90 mm: '
          f'{sum(1 for r in blips if r[3])}')
    cy = np.array(tot['carry'] or [np.nan])
    print(f'carry error (published vs the confident detection, around moves >= 50 mm; lower = follows the hand): '
          f'mean {np.nanmean(cy):.1f} mm, p90 {np.nanpercentile(cy, 90):.1f}, frames > 60 mm off {np.mean(cy > 60) * 100:.1f}%')
    print(f'"moving" episodes {tot["mov_ep"]}, of which went nowhere (< 20 mm net) {tot["mov_idle"]}')
    print(f'presence segments {tot["seg"]}  phantoms (<1.5 s) {tot["phantom"]}  dropouts (gone and back < 10 s) {tot["drop"]}  '
          f'piece-seconds {tot["pieces_s"]:.0f}')
    print(f'published with no confident detection near it (bridged): {tot["bridged"] / max(1, tot["pub_frames"]) * 100:.1f}% of '
          f'piece-frames;  a role confidently detected for 1 s with nothing published (late): {tot["late"]}')
    if a.verbose:
        for name, i, ev, near, ret in rows:
            print(f'  {name} {i:<9} t {ev["t0"]:6.1f}-{ev["t1"]:6.1f}  ({ev["a"][0]:5.0f},{ev["a"][1]:4.0f}) -> ({ev["b"][0]:5.0f},{ev["b"][1]:4.0f})'
                  f'  {ev["d"]:5.0f} mm  hand {ev["hand"]:6.0f}  {"RETURNED" if ret else ""}')


def live_hd(poly, x, y):
    return -cv2.pointPolygonTest(np.asarray(poly, np.float32).reshape(-1, 1, 2), (float(x), float(y)), True)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('cmd', choices=['cache', 'score', 'dcache', 'bench'])
    ap.add_argument('--video', default=str(VIDEO))
    ap.add_argument('--weights', default=str(HERE / 'runs/tv-pol-yolo11s-960/weights/best.pt'))
    ap.add_argument('--stride', type=int, default=2)
    ap.add_argument('--tracker', default='both', choices=['old', 'new', 'both'])
    ap.add_argument('-v', '--verbose', action='store_true')
    ap.add_argument('--out', default='replay_cache', help='dcache: folder for the per-video pickles')
    ap.add_argument('--cache', nargs='*', default=[], help='bench: dcache pickles')
    ap.add_argument('--set', nargs='*', default=[], help='bench: Tracker knobs, e.g. BAND_STILL_MM=8')
    a = ap.parse_args()
    globals()[a.cmd](a)
