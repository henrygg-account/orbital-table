"""label5.py — round 5 labelling on the GPU VM: the Oct 12 passive recordings (pruned), outlined by SAM 2.

Classes as round 4: 0 earth, 1 moon, 2 seldon-1, 3 seldon-2, 4 person (any hand, arm or body).
Input: r5/seq (frames + names.json + runs.json: seq index ranges that are one continuous stretch of one recording),
prev.pt (the round-4 model). Stages (r5_spot.sh runs each on every GPU with --shard k --nshards N):
  detect  round-4 YOLO (boxes, every class) + Grounding DINO on every frame          -> work/det_<k>.json
  fuse    vote per frame and piece; person prompts from both                       -> work/prompts.json, report
  sam     pieces: SAM 2 video propagation per chunk (chunks never cross a run); people: per frame from the boxes
                                                                                    -> labels/<name>.txt (YOLO-seg)
  review  contact sheets of evenly spaced frames with the outlines (sheets/*.jpg)    -> report.json
Voting (pieces), aimed at the round-4 model's two failures on the table (misses, and phantoms on the TV's own picture):
every model / DINO box must first hold its piece's colour (label4.colour_ok). Then a piece is prompted when
  - the model is confident (>= 0.6), or
  - the model is weaker (>= 0.25) and DINO sees the same piece on the same spot (IoU >= 0.3), or
  - DINO alone sees it (>= 0.4) in this frame and both neighbouring frames on the same spot (a model miss, recovered).
One prompt per piece per frame (the best). Person prompts: DINO person boxes >= 0.35 plus model person boxes >= 0.4,
merged where they overlap (IoU >= 0.5).
"""
import argparse, json, os, shutil
from pathlib import Path

import cv2
import numpy as np

from label4 import CLASSES, DRAW, DINO_TEXT, DINO_KIND, iou, colour_ok as colour_ok4, colour_of, polygons

SEQ = Path('r5/seq')


def colour_ok(img, c, b):
    """label4's colour check, but the Seldons as they look on the table on Oct 12: Seldon-1's yellow much paler (saturation
    ~100, not ~190; COLOUR-STUDY.md), Seldon-2's magenta much darker in the evening (value p90 ~80). label4's thresholds threw
    away most correct model boxes of Seldon-1 (870 prompt frames vs 2,790 for Seldon-2) and many of Seldon-2 at night."""
    if c not in (2, 3):
        return colour_ok4(img, c, b)
    x1, y1, x2, y2 = (int(v) for v in b)
    hsv = cv2.cvtColor(img[max(0, y1):y2, max(0, x1):x2], cv2.COLOR_BGR2HSV)
    if hsv.size == 0:
        return False
    h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    m = (h >= 12) & (h <= 35) & (s > 45) & (v > 45) if c == 2 else ((h >= 160) | (h <= 6)) & (s > 70) & (v > 25)
    return m.mean() >= .04


def seq():
    return sorted(SEQ.glob('[0-9]*.jpg')), json.loads((SEQ / 'names.json').read_text()), json.loads((SEQ / 'runs.json').read_text())


# ------------------------------------------------------------------ detect
def detect(a):
    import torch
    from ultralytics import YOLO
    from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor
    from PIL import Image
    yolo = YOLO('prev.pt')
    proc = AutoProcessor.from_pretrained('IDEA-Research/grounding-dino-base')
    dino = AutoModelForZeroShotObjectDetection.from_pretrained('IDEA-Research/grounding-dino-base').to('cuda').eval()
    frames, _, _ = seq()
    work = Path('work'); work.mkdir(exist_ok=True)
    done, part = work / f'det_{a.shard}.json', work / f'det_{a.shard}.part.json'   # resumable: Spot VMs get reclaimed
    if done.exists():
        return
    mine = list(range(a.shard, len(frames), a.nshards))
    out = {int(k): v for k, v in json.loads(part.read_text()).items()} if part.exists() else {}
    mine = [i for i in mine if i not in out]
    for b0 in range(0, len(mine), 16):
        idx = mine[b0:b0 + 16]
        imgs = [cv2.imread(str(frames[i])) for i in idx]
        for i, r in zip(idx, yolo.predict(imgs, imgsz=960, conf=0.2, agnostic_nms=True, verbose=False, device=0)):
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
            dl = []
            for b, s, t in zip(r['boxes'].tolist(), r['scores'].tolist(), r.get('text_labels', r.get('labels'))):
                kind = next((v for k, v in DINO_KIND.items() if k in str(t)), None)
                if kind == 'seldon':
                    kind = colour_of(im, b)
                if kind is not None:
                    dl.append([kind, round(s, 3), [round(v, 1) for v in b]])
            out[i]['D'] = dl
        if b0 % 320 == 0:
            print(f'detect shard {a.shard}: {b0}/{len(mine)}', flush=True)
            part.write_text(json.dumps(out))
    done.write_text(json.dumps(out)); part.unlink(missing_ok=True)


# ------------------------------------------------------------------ fuse
def fuse(a):
    frames, names, runs = seq()
    det = {}
    for f in Path('work').glob('det_*.json'):
        if 'part' not in f.name:
            det.update({int(k): v for k, v in json.loads(f.read_text()).items()})
    H, W = cv2.imread(str(frames[0])).shape[:2]
    run_of = {i: k for k, (s, e) in enumerate(runs) for i in range(s, e)}
    checked = {}

    def boxes(i):                                               # colour-checked model and DINO boxes of frame i
        if i not in checked:
            img = cv2.imread(str(frames[i])) if 0 <= i < len(frames) else None
            dt = det.get(i, {})
            checked[i] = {'Y': [y for y in dt.get('Y', []) if y[0] == 4 or colour_ok(img, y[0], y[2])],
                          'D': [x for x in dt.get('D', []) if x[0] == 4 or colour_ok(img, x[0], x[2])]} if img is not None else {'Y': [], 'D': []}
        return checked[i]

    def dino_at(j, c, b):
        return run_of.get(j) is not None and any(x[0] == c and x[1] >= .3 and iou(x[2], b) >= .3 for x in boxes(j)['D'])

    prompts, votes = {}, {c: [0, 0, 0] for c in range(4)}
    for i in range(len(frames)):
        bx, P = boxes(i), {}
        for c in range(4):
            Ys = sorted((y for y in bx['Y'] if y[0] == c), key=lambda y: -y[1])
            Ds = sorted((x for x in bx['D'] if x[0] == c), key=lambda x: -x[1])
            Y, D = (Ys[0] if Ys else None), (Ds[0] if Ds else None)
            if Y and Y[1] >= .6:
                P[c] = Y[2]; votes[c][0] += 1
            elif Y and Y[1] >= .25 and D and iou(Y[2], D[2]) >= .3:
                P[c] = Y[2]; votes[c][1] += 1
            elif D and D[1] >= .4 and all(run_of.get(j) == run_of[i] and dino_at(j, c, D[2]) for j in (i - 1, i + 1)):
                if c != 0 or (D[2][2] - D[2][0]) * (D[2][3] - D[2][1]) < .05 * W * H:   # (DINO calls the TV's picture of Earth a globe)
                    P[c] = D[2]; votes[c][2] += 1
        persons = [x[2] for x in bx['D'] if x[0] == 4 and x[1] >= .35 and (x[2][2] - x[2][0]) * (x[2][3] - x[2][1]) < .6 * W * H]
        for y in bx['Y']:
            if y[0] == 4 and y[1] >= .4 and not any(iou(y[2], p) >= .5 for p in persons):
                persons.append(y[2])
        prompts[i] = {'pieces': P, 'persons': persons}
    Path('work/prompts.json').write_text(json.dumps(prompts))
    rep = {'frames': len(frames), 'prompt frames per class': {CLASSES[c]: sum(c in p['pieces'] for p in prompts.values()) for c in range(4)},
           'person frames': sum(bool(p['persons']) for p in prompts.values()),
           'votes [model confident, weak model + DINO, DINO steady (model missed)]': {CLASSES[c]: v for c, v in votes.items()}}
    Path('work/fuse_report.json').write_text(json.dumps(rep, indent=1)); print(rep, flush=True)


def invalidate(a):
    frames, names, runs = seq()
    prev, cur = (json.loads(Path(f'work/{f}').read_text()) for f in ('prompts_prev.json', 'prompts.json'))
    chunks = [(c0, min(e, c0 + a.chunk)) for s, e in runs for c0 in range(s, e, a.chunk)]
    changed = [c for c in chunks if any(prev.get(str(i)) != cur.get(str(i)) for i in range(*c))]
    for c0, c1 in changed:
        for i in range(c0, c1):
            (Path('labels') / f'{names[i]}.txt').unlink(missing_ok=True)
    print('chunks to redo:', len(changed), 'of', len(chunks), flush=True)


# ------------------------------------------------------------------ sam
def sam(a):
    import torch
    from sam2.build_sam import build_sam2, build_sam2_video_predictor
    from sam2.sam2_image_predictor import SAM2ImagePredictor
    cfg, ckpt = 'configs/sam2.1/sam2.1_hiera_l.yaml', 'sam2.1_hiera_large.pt'
    pred = build_sam2_video_predictor(cfg, ckpt, device='cuda')
    img_pred = SAM2ImagePredictor(build_sam2(cfg, ckpt, device='cuda'))
    frames, names, runs = seq()
    prompts = {int(k): v for k, v in json.loads(Path('work/prompts.json').read_text()).items()}
    lab_dir = Path('labels'); lab_dir.mkdir(exist_ok=True)
    H, W = cv2.imread(str(frames[0])).shape[:2]
    chunks = [(c0, min(e, c0 + a.chunk)) for s, e in runs for c0 in range(s, e, a.chunk)]   # never across two runs
    for c0, c1 in chunks[a.shard::a.nshards]:
        idx = list(range(c0, c1))
        if all((lab_dir / f'{names[i]}.txt').exists() for i in idx):
            continue                                            # done before a reclaim
        tmp = Path(f'chunk_{a.shard}'); shutil.rmtree(tmp, ignore_errors=True); tmp.mkdir()
        for k, i in enumerate(idx):
            os.symlink(frames[i].resolve(), tmp / f'{k:05d}.jpg')
        masks = {i: {} for i in idx}
        with torch.inference_mode(), torch.autocast('cuda', dtype=torch.bfloat16):
            st = pred.init_state(video_path=str(tmp), offload_video_to_cpu=True)
            any_prompt, last = False, {}
            for k, i in enumerate(idx):
                for c, b in prompts.get(i, {'pieces': {}})['pieces'].items():   # re-prompted every 5 frames (pruned
                    c = int(c)                                              # recordings skip still stretches)
                    if k - last.get(c, -99) >= 5:
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
            for i in idx:
                bs = prompts.get(i, {}).get('persons', [])[:8]
                if bs:
                    img_pred.set_image(cv2.cvtColor(cv2.imread(str(frames[i])), cv2.COLOR_BGR2RGB))
                    ms, _, _ = img_pred.predict(box=np.array(bs, np.float32), multimask_output=False)
                    for j, m in enumerate(ms.reshape(len(bs), -1, *ms.shape[-2:])[:, 0]):
                        masks[i][100 + j] = m > 0
        for i in idx:
            lines = []
            for c in range(4):
                if c in masks[i]:
                    for poly in polygons(masks[i][c], 60, True):
                        lines.append(f'{c} ' + ' '.join(f'{x / W:.5f} {y / H:.5f}' for x, y in poly))
            pm = np.zeros((H, W), bool)
            for o, m in masks[i].items():
                if o >= 100:
                    pm |= m
            for c in range(4):
                if c in masks[i]:
                    pm &= ~masks[i][c]
            for poly in polygons(pm, 400, False):
                lines.append('4 ' + ' '.join(f'{x / W:.5f} {y / H:.5f}' for x, y in poly))
            (lab_dir / f'{names[i]}.txt').write_text(''.join(l + '\n' for l in lines))
        print(f'sam shard {a.shard}: chunk {c0}-{c1 - 1} done', flush=True)


# ------------------------------------------------------------------ review
def review(a):
    frames, names, _ = seq()
    cnt = [0] * 5
    for n in names:
        p = Path('labels') / f'{n}.txt'
        for line in (p.read_text().split('\n') if p.exists() else []):
            if line.strip():
                cnt[int(line.split()[0])] += 1
    rep = {'frames': len(frames), 'outlines': dict(zip(CLASSES, cnt)), **json.loads(Path('work/fuse_report.json').read_text())}
    Path('report.json').write_text(json.dumps(rep, indent=1)); print(rep, flush=True)
    out = Path('sheets'); shutil.rmtree(out, ignore_errors=True); out.mkdir()
    pick = np.linspace(0, len(frames) - 1, 16 * 12).astype(int)  # 12 sheets of 4x4, evenly through the recordings
    for s in range(12):
        tiles = []
        for i in pick[s * 16:(s + 1) * 16]:
            img = cv2.imread(str(frames[i])); H, W = img.shape[:2]
            p = Path('labels') / f'{names[i]}.txt'
            for line in (p.read_text().split('\n') if p.exists() else []):
                if line.strip():
                    v = line.split(); c = int(v[0]); pts = (np.array(v[1:], float).reshape(-1, 2) * [W, H]).astype(np.int32)
                    cv2.polylines(img, [pts], True, DRAW[c], 4)
                    x, y = pts.min(0); cv2.putText(img, CLASSES[c], (int(x), max(30, int(y) - 8)), cv2.FONT_HERSHEY_SIMPLEX, 1.4, DRAW[c], 3)
            cv2.putText(img, names[i], (20, 60), cv2.FONT_HERSHEY_SIMPLEX, 1.8, (0, 255, 255), 4)
            tiles.append(cv2.resize(img, (640, 480)))
        rows = [np.hstack(tiles[r * 4:(r + 1) * 4]) for r in range(4)]
        cv2.imwrite(str(out / f'sheet_{s:02d}.jpg'), np.vstack(rows), [cv2.IMWRITE_JPEG_QUALITY, 80])


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('stage', choices=['detect', 'fuse', 'invalidate', 'sam', 'review'])
    ap.add_argument('--shard', type=int, default=0)
    ap.add_argument('--nshards', type=int, default=1)
    ap.add_argument('--chunk', type=int, default=150)
    a = ap.parse_args()
    {'detect': detect, 'fuse': fuse, 'invalidate': invalidate, 'sam': sam, 'review': review}[a.stage](a)
