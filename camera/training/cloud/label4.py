"""label4.py — round 4 labelling on the GPU VM: three prompt sources vote, SAM 2 draws the outlines.

Classes: 0 earth, 1 moon, 2 seldon-1, 3 seldon-2, 4 person (any hand, arm or body; several at once).
Datasets (each a frame sequence dir with names.json):
  r4   the Oct 9 recording, every 3rd frame (tags.json: shot-list step per frame; colour prompts in prompts.json)
  r3   the Oct 6 polarized frames; their reviewed boxes (labels_fixed) are the piece prompts on every frame
Stages (run4.sh runs each stage on every GPU at once with --shard k --nshards N):
  detect  round-3 YOLO + Grounding DINO on every frame               -> work/<ds>/det_<k>.json
  fuse    vote per frame and piece; person boxes from DINO           -> work/<ds>/prompts.json, disagreements.json
  sam     pieces: SAM 2 video propagation per 150-frame chunk; people: SAM 2 per frame from DINO's boxes
          (chunks split over shards)                                    -> labels/<ds>/<name>.txt (YOLO-seg polygons)
  review  4x time-lapse of r4 with the outlines + report             -> review_r4.mp4, report.json
Voting (pieces): sources C (colour rule), Y (round-3 model, conf >= 0.5), D (DINO: blue globe / white ball / toy
satellite, identity by colour inside the box). A prompt needs two sources agreeing on the spot (IoU >= 0.3) and the class,
or one very confident model box (>= 0.85) that no colour contradicts. Every model / DINO box must first contain its
piece's own colour (the round-3 model calls people 'Earth'). Identity conflicts and lone confident boxes go to
disagreements.json for the review. Also accepted alone: a weak model box (>= 0.3) with DINO on the same spot, a stable
colour box nothing contradicts, and for the Moon a confident DINO white ball (it is the only one; covers it in a hand).
"""
import argparse, json, os, shutil
from pathlib import Path

import cv2
import numpy as np

CLASSES = ['earth', 'moon', 'seldon-1', 'seldon-2', 'person']
DRAW = [(255, 170, 60), (235, 235, 235), (40, 210, 255), (200, 60, 255), (60, 220, 90)]
DINO_TEXT = 'a person. a hand. an arm. a white ball. a blue globe. a toy satellite.'
DINO_KIND = {'person': 4, 'hand': 4, 'arm': 4, 'white ball': 1, 'blue globe': 0, 'toy satellite': 'seldon'}
DATASETS = {'r4': 'r4/seq', 'r3': 'r3/seq'}


def iou(a, b):
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0])); iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    return inter / max(1e-9, (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter)


def colour_ok(img, c, b):
    """Does a box labelled c (0-3) contain that piece's own colour? Earth blue, Moon white, Seldon yellow / red."""
    x1, y1, x2, y2 = (int(v) for v in b)
    hsv = cv2.cvtColor(img[max(0, y1):y2, max(0, x1):x2], cv2.COLOR_BGR2HSV)
    if hsv.size == 0:
        return False
    h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    m = {0: (h >= 85) & (h <= 118) & (s > 70) & (v > 28), 1: (s < 80) & (v > 110),
         2: (h >= 15) & (h <= 31) & (s > 100) & (v > 45), 3: ((h >= 165) | (h <= 6)) & (s > 110) & (v > 35)}[c]
    return m.mean() >= .04


def colour_of(img, b):
    """Fraction of yellow (seldon-1) / red (seldon-2) pixels in a box -> 2, 3 or None."""
    x1, y1, x2, y2 = (int(v) for v in b)
    hsv = cv2.cvtColor(img[max(0, y1):y2, max(0, x1):x2], cv2.COLOR_BGR2HSV)
    if hsv.size == 0:
        return None
    h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    y = ((h >= 15) & (h <= 31) & (s > 100) & (v > 45)).mean(); r = (((h >= 165) | (h <= 6)) & (s > 110) & (v > 35)).mean()
    return 2 if y > max(.03, 2 * r) else 3 if r > max(.03, 2 * y) else None


def seq(ds):
    d = Path(DATASETS[ds])
    return d, sorted(d.glob('[0-9]*.jpg')), json.loads((d / 'names.json').read_text())


# ------------------------------------------------------------------ detect
def detect(a):
    import torch
    from ultralytics import YOLO
    from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor
    from PIL import Image
    yolo = YOLO('prev.pt')
    proc = AutoProcessor.from_pretrained('IDEA-Research/grounding-dino-base')
    dino = AutoModelForZeroShotObjectDetection.from_pretrained('IDEA-Research/grounding-dino-base').to('cuda').eval()
    for ds in DATASETS:
        d, frames, _ = seq(ds)
        mine = list(range(a.shard, len(frames), a.nshards))
        out, work = {}, Path('work') / ds; work.mkdir(parents=True, exist_ok=True)
        part = work / f'det_{a.shard}.part.json'                   # resumable (Spot VMs get reclaimed): saved every 320 frames
        if (work / f'det_{a.shard}.json').exists():
            continue
        if part.exists():
            out = {int(k): v for k, v in json.loads(part.read_text()).items()}
            mine = [i for i in mine if i not in out]
        for b0 in range(0, len(mine), 16):
            idx = mine[b0:b0 + 16]
            imgs = [cv2.imread(str(frames[i])) for i in idx]
            for i, r in zip(idx, yolo.predict(imgs, imgsz=960, conf=0.25, agnostic_nms=True, verbose=False, device=0)):
                out.setdefault(i, {})['Y'] = [[int(c), round(s, 3), [round(v, 1) for v in b]] for b, c, s in
                                              zip(r.boxes.xyxy.tolist(), r.boxes.cls.int().tolist(), r.boxes.conf.tolist())]
            pil = [Image.fromarray(cv2.cvtColor(im, cv2.COLOR_BGR2RGB)) for im in imgs]
            with torch.inference_mode():
                inp = proc(images=pil, text=[DINO_TEXT] * len(pil), return_tensors='pt').to('cuda')
                o = dino(**inp)
            sizes = [im.shape[:2] for im in imgs]
            try:
                res = proc.post_process_grounded_object_detection(o, inp.input_ids, threshold=0.3, text_threshold=0.25, target_sizes=sizes)
            except TypeError:
                res = proc.post_process_grounded_object_detection(o, inp.input_ids, box_threshold=0.3, text_threshold=0.25, target_sizes=sizes)
            for i, r, im in zip(idx, res, imgs):
                labels = r.get('text_labels', r.get('labels'))
                dl = []
                for b, s, t in zip(r['boxes'].tolist(), r['scores'].tolist(), labels):
                    kind = next((v for k, v in DINO_KIND.items() if k in str(t)), None)
                    if kind is None:
                        continue
                    if kind == 'seldon':
                        kind = colour_of(im, b)
                        if kind is None:
                            continue
                    dl.append([kind, round(s, 3), [round(v, 1) for v in b]])
                out[i]['D'] = dl
            if b0 % 320 == 0:
                print(f'detect {ds} shard {a.shard}: {b0}/{len(mine)}', flush=True)
                part.write_text(json.dumps(out))
        (work / f'det_{a.shard}.json').write_text(json.dumps(out)); part.unlink(missing_ok=True)


# ------------------------------------------------------------------ fuse
def fuse(a):
    for ds in DATASETS:
        d, frames, names = seq(ds)
        work = Path('work') / ds
        det = {}
        for f in [f for f in work.glob('det_*.json') if 'part' not in f.name]:
            det.update({int(k): v for k, v in json.loads(f.read_text()).items()})
        H, W = cv2.imread(str(frames[0])).shape[:2]
        colour = {int(k): {int(c): b for c, b in v.items()} for k, v in json.loads((d / 'prompts.json').read_text()).items()} \
            if (d / 'prompts.json').exists() and ds == 'r4' else {}
        tags = json.loads((d / 'tags.json').read_text()) if (d / 'tags.json').exists() else {}
        fixed = Path('r3/labels_fixed')
        prompts, dis, votes = {}, [], {c: [0, 0, 0, 0, 0] for c in range(4)}

        def steady(i, c, b):                                        # the model sees the same box in the frames before and after
            near = lambda o: max(abs(o[k] - b[k]) for k in range(4)) < 12
            return all(any(y[0] == c and y[1] >= .5 and near(y[2]) for y in det.get(j, {}).get('Y', [])) for j in (i - 1, i + 1))   # (the box itself is colour-checked)
        for i in range(len(frames)):
            dt = det.get(i, {}); P = {}
            if ds == 'r4':                                          # identity check: model / DINO boxes must hold their piece's colour
                img = cv2.imread(str(frames[i]))
                dt = {**dt, 'Y': [y for y in dt.get('Y', []) if colour_ok(img, y[0], y[2])],
                      'D': [x for x in dt.get('D', []) if x[0] == 4 or colour_ok(img, x[0], x[2])]}
            if ds == 'r3':                                          # reviewed boxes: trusted on every frame
                p = fixed / f'{names[i]}.txt'
                for line in (p.read_text().split('\n') if p.exists() else []):
                    if line.strip():
                        c, u, v, w, h = map(float, line.split())
                        P[int(c)] = [(u - w / 2) * W, (v - h / 2) * H, (u + w / 2) * W, (v + h / 2) * H]
            else:                                                   # (the 'empty' steps still have pieces on the side table)
                for c in range(4):
                    C = colour.get(i, {}).get(c)                    # colour box, already stable over neighbouring frames
                    Ys = [y for y in dt.get('Y', []) if y[0] == c]
                    Y = max((y for y in Ys if y[1] >= .5), key=lambda y: y[1], default=None)
                    Yw = max((y for y in Ys if y[1] >= .3), key=lambda y: y[1], default=None)
                    D = max((x for x in dt.get('D', []) if x[0] == c), key=lambda x: x[1], default=None)
                    src = [s for s in (C and ('C', C), Y and ('Y', Y[2]), D and ('D', D[2])) if s]
                    agree = [(s, t) for k, s in enumerate(src) for t in src[k + 1:] if iou(s[1], t[1]) >= .3]
                    other = [c2 for c2, b2 in colour.get(i, {}).items() if c2 != c and Y and iou(b2, Y[2]) >= .3]
                    contra_C = C and (any(c2 != c and iou(b2, C) >= .3 for c2, b2 in colour.get(i, {}).items())
                                      or any(y[0] != c and y[1] >= .5 and iou(y[2], C) >= .3 for y in dt.get('Y', [])))
                    if agree:
                        P[c] = Y[2] if Y else (C or D[2]); votes[c][0] += 1
                    elif Yw and D and iou(Yw[2], D[2]) >= .3:       # weak model box + DINO on the same spot (dim, off the screen)
                        P[c] = Yw[2]; votes[c][1] += 1
                    elif Y and (Y[1] >= .85 or (Y[1] >= .7 and steady(i, c, Y[2]))) and not other:
                        P[c] = Y[2]; votes[c][2] += 1                # confident, or steady across neighbouring frames
                    elif Y and Y[1] >= .85:
                        dis.append({'frame': i, 'name': names[i], 'class': CLASSES[c], 'why': f'model says {CLASSES[c]}, colour says {CLASSES[other[0]]}'})
                    elif C and not contra_C:                        # a stable colour box nothing contradicts
                        P[c] = C; votes[c][3] += 1
                    elif c == 1 and D and D[1] >= .4 and max(D[2][2] - D[2][0], D[2][3] - D[2][1]) <= 90:
                        P[c] = D[2]; votes[c][4] += 1               # the Moon in a hand: the only white ball around
            persons = [x[2] for x in dt.get('D', []) if x[0] == 4 and x[1] >= .35
                       and (x[2][2] - x[2][0]) * (x[2][3] - x[2][1]) < .6 * W * H]
            prompts[i] = {'pieces': P, 'persons': persons}
        (work / 'prompts.json').write_text(json.dumps(prompts))
        (work / 'disagreements.json').write_text(json.dumps(dis, indent=1))
        print(ds, 'prompt frames per class:', {CLASSES[c]: sum(c in p['pieces'] for p in prompts.values()) for c in range(4)},
              'person frames:', sum(bool(p['persons']) for p in prompts.values()),
              'votes [agreed, weak model+DINO, confident or steady model, stable colour, moon by DINO]:', {CLASSES[c]: v for c, v in votes.items()},
              'disagreements:', len(dis), flush=True)


# ------------------------------------------------------------------ sam
def polygons(mask, min_px, single):
    """Mask -> YOLO-seg polygons (frame px): the largest part for a piece, every sizeable part for people."""
    n, lab, st, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8))
    parts = sorted(range(1, n), key=lambda k: -st[k, cv2.CC_STAT_AREA])
    out = []
    for k in parts[:1] if single else parts:
        if st[k, cv2.CC_STAT_AREA] < min_px:
            break
        cs, _ = cv2.findContours((lab == k).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        c = max(cs, key=cv2.contourArea)
        c = cv2.approxPolyDP(c, 1.5, True)
        if len(c) >= 3:
            out.append(c.reshape(-1, 2))
    return out


def sam(a):
    import torch
    from sam2.build_sam import build_sam2, build_sam2_video_predictor
    from sam2.sam2_image_predictor import SAM2ImagePredictor
    cfg, ckpt = 'configs/sam2.1/sam2.1_hiera_l.yaml', 'sam2.1_hiera_large.pt'
    pred = build_sam2_video_predictor(cfg, ckpt, device='cuda')          # pieces: tracked through each chunk
    img_pred = SAM2ImagePredictor(build_sam2(cfg, ckpt, device='cuda'))  # people: outlined frame by frame from DINO's boxes
    for ds in DATASETS:
        d, frames, names = seq(ds)
        prompts = {int(k): v for k, v in json.loads((Path('work') / ds / 'prompts.json').read_text()).items()}
        lab_dir = Path('labels') / ds; lab_dir.mkdir(parents=True, exist_ok=True)
        H, W = cv2.imread(str(frames[0])).shape[:2]
        chunks = list(range(0, len(frames), a.chunk))
        for c0 in chunks[a.shard::a.nshards]:
            idx = list(range(c0, min(len(frames), c0 + a.chunk)))
            if all((lab_dir / f'{names[i]}.txt').exists() for i in idx):
                continue                                            # done before a reclaim
            tmp = Path(f'chunk_{a.shard}'); shutil.rmtree(tmp, ignore_errors=True); tmp.mkdir()
            for k, i in enumerate(idx):
                os.symlink(frames[i].resolve(), tmp / f'{k:05d}.jpg')
            masks = {i: {} for i in idx}                            # frame -> obj id -> bool mask
            with torch.inference_mode(), torch.autocast('cuda', dtype=torch.bfloat16):
                st = pred.init_state(video_path=str(tmp), offload_video_to_cpu=True)
                any_prompt, last = False, {}
                for k, i in enumerate(idx):
                    p = prompts.get(i, {'pieces': {}, 'persons': []})
                    for c, b in p['pieces'].items():                # pieces: one object each, re-prompted every 10 frames
                        c = int(c)
                        if k - last.get(c, -99) >= 10:
                            pred.add_new_points_or_box(inference_state=st, frame_idx=k, obj_id=c, box=np.array(b, np.float32))
                            last[c] = k; any_prompt = True
                if any_prompt:
                    for reverse in (False, True):
                        for k, obj_ids, logits in pred.propagate_in_video(st, reverse=reverse):
                            for o, lg in zip(obj_ids, logits):
                                m = (lg[0] > 0).cpu().numpy()
                                if m.any():
                                    masks[idx[k]][o] = masks[idx[k]].get(o, False) | m
                pred.reset_state(st)
                for i in idx:                                       # people: every frame with DINO person boxes
                    boxes = prompts.get(i, {}).get('persons', [])[:8]
                    if boxes:
                        img_pred.set_image(cv2.cvtColor(cv2.imread(str(frames[i])), cv2.COLOR_BGR2RGB))
                        ms, _, _ = img_pred.predict(box=np.array(boxes, np.float32), multimask_output=False)
                        ms = ms.reshape(len(boxes), -1, *ms.shape[-2:])[:, 0]
                        for j, m in enumerate(ms):
                            masks[i][100 + j] = m > 0
            for i in idx:                                           # labels: pieces as given; people = union of every person object
                lines = []
                for c in range(4):
                    if c in masks[i]:
                        for poly in polygons(masks[i][c], 60, True):
                            lines.append(f'{c} ' + ' '.join(f'{x / W:.5f} {y / H:.5f}' for x, y in poly))
                pm = np.zeros((H, W), bool)
                for o, m in masks[i].items():
                    if o >= 100:
                        pm |= m
                for c in range(4):                                  # a piece is never part of a person
                    if c in masks[i]:
                        pm &= ~masks[i][c]
                for poly in polygons(pm, 400, False):
                    lines.append('4 ' + ' '.join(f'{x / W:.5f} {y / H:.5f}' for x, y in poly))
                (lab_dir / f'{names[i]}.txt').write_text(''.join(l + '\n' for l in lines))
            print(f'sam {ds} shard {a.shard}: chunk {c0}-{idx[-1]} done', flush=True)


# ------------------------------------------------------------------ review
def review(a):
    rep = {}
    for ds in DATASETS:
        d, frames, names = seq(ds)
        cnt = [0] * 5
        for n in names:
            p = Path('labels') / ds / f'{n}.txt'
            for line in (p.read_text().split('\n') if p.exists() else []):
                if line.strip():
                    cnt[int(line.split()[0])] += 1
        rep[ds] = {'frames': len(frames), 'outlines': dict(zip(CLASSES, cnt)),
                   'disagreements': len(json.loads((Path('work') / ds / 'disagreements.json').read_text()))}
    Path('report.json').write_text(json.dumps(rep, indent=1)); print(rep, flush=True)
    d, frames, names = seq('r4')                                    # time-lapse: every frame of the seq (every 3rd of the video)
    tags = json.loads((d / 'tags.json').read_text())
    dis = {x['frame'] for x in json.loads((Path('work/r4/disagreements.json')).read_text())}
    vw = cv2.VideoWriter('review_r4.mp4', cv2.VideoWriter_fourcc(*'mp4v'), 36, (960, 720))     # ~4x real time
    for i, f in enumerate(frames):
        img = cv2.imread(str(f)); H, W = img.shape[:2]
        p = Path('labels/r4') / f'{names[i]}.txt'
        for line in (p.read_text().split('\n') if p.exists() else []):
            if line.strip():
                v = line.split(); c = int(v[0]); pts = (np.array(v[1:], float).reshape(-1, 2) * [W, H]).astype(np.int32)
                cv2.polylines(img, [pts], True, DRAW[c], 3)
                x, y = pts.min(0); cv2.putText(img, CLASSES[c], (int(x), max(24, int(y) - 8)), cv2.FONT_HERSHEY_SIMPLEX, .9, DRAW[c], 2)
        cv2.putText(img, f'{i}  {tags.get(str(i), {}).get("step", "")}' + ('  DISAGREEMENT' if i in dis else ''), (20, 50),
                    cv2.FONT_HERSHEY_SIMPLEX, 1.4, (0, 0, 255) if i in dis else (0, 255, 255), 3)
        vw.write(cv2.resize(img, (960, 720)))
    vw.release()


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('stage', choices=['detect', 'fuse', 'sam', 'review'])
    ap.add_argument('--shard', type=int, default=0)
    ap.add_argument('--nshards', type=int, default=1)
    ap.add_argument('--chunk', type=int, default=150)
    a = ap.parse_args()
    {'detect': detect, 'fuse': fuse, 'sam': sam, 'review': review}[a.stage](a)
