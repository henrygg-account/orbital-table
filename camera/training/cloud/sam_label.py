"""Runs on the GPU VM. Re-label the frame sequence with SAM 2, prompted by the current YOLO model.

  python3 sam_label.py --frames seq --weights prev.pt --out sam_out

1. YOLO (the current, "sort of works" model) finds each piece; its boxes with conf >= 0.8 become prompts.
   --prompts <json> adds boxes from elsewhere (color_prompts.py: colour + stability filtered); they win over YOLO.
2. SAM 2 tracks every piece through the sequence in chunks (forward from the prompts, then backward to
   cover frames before the first prompt), giving a precise mask per piece per frame.
3. Each mask -> tight box -> YOLO label. If a confident YOLO box clearly disagrees with SAM (IoU < 0.3),
   the frame is flagged and the YOLO box is used for that piece. ("Confident" = --prompt-conf, 0.8.)
Outputs: <out>/labels/<frame>.txt, <out>/preview/*.jpg (every 25th frame, mask outlines), <out>/report.json
"""
import argparse, json, os, shutil
from pathlib import Path

import cv2
import numpy as np
import torch
from ultralytics import YOLO
from sam2.build_sam import build_sam2_video_predictor

CLASSES = ['earth', 'moon', 'seldon-1', 'seldon-2']
COLORS = [(255, 170, 60), (230, 230, 230), (40, 210, 255), (200, 60, 255)]


def iou(a, b):
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0])); iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    return inter / max(1e-9, (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter)


def mask_box(m, min_px):
    """Tight box around the largest connected part of a mask (drops SAM's stray specks)."""
    m = m.astype(np.uint8)
    n, lab, st, _ = cv2.connectedComponentsWithStats(m)
    if n < 2:
        return None
    k = 1 + int(np.argmax(st[1:, cv2.CC_STAT_AREA]))
    x, y, w, h, a = st[k]
    return None if a < min_px else (int(x), int(y), int(x + w), int(y + h)), (lab == k)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--frames', default='seq')
    ap.add_argument('--weights', default='prev.pt')
    ap.add_argument('--out', default='sam_out')
    ap.add_argument('--chunk', type=int, default=150)
    ap.add_argument('--prompt-conf', type=float, default=0.8)
    ap.add_argument('--prompt-every', type=int, default=15, help='at most one prompt per piece per this many frames')
    ap.add_argument('--prompts', help='extra prompt boxes: {"<frame>": {"<class>": [x1, y1, x2, y2]}} (frame px)')
    ap.add_argument('--ckpt', default='sam2.1_hiera_large.pt')
    ap.add_argument('--cfg', default='configs/sam2.1/sam2.1_hiera_l.yaml')
    a = ap.parse_args()

    frames = sorted(Path(a.frames).glob('[0-9]*.jpg'))                         # skip macOS ._ metadata files
    names = json.loads((Path(a.frames) / 'names.json').read_text())          # seq index -> original stem
    out = Path(a.out); (out / 'labels').mkdir(parents=True, exist_ok=True); (out / 'preview').mkdir(exist_ok=True)
    H, W = cv2.imread(str(frames[0])).shape[:2]

    # 1. YOLO pass: best box per class per frame
    yolo = YOLO(a.weights)
    det = [dict() for _ in frames]
    for i in range(0, len(frames), 32):
        for j, r in enumerate(yolo.predict([str(f) for f in frames[i:i + 32]], imgsz=960, conf=0.25,
                                           agnostic_nms=True, verbose=False, device=0)):
            for (x1, y1, x2, y2), c, s in zip(r.boxes.xyxy.tolist(), r.boxes.cls.int().tolist(), r.boxes.conf.tolist()):
                if c not in det[i + j] or s > det[i + j][c][1]:
                    det[i + j][c] = ((x1, y1, x2, y2), s)
    print('yolo pass done', flush=True)
    extra = json.loads(Path(a.prompts).read_text()) if a.prompts else {}
    pr = [{c: v for c, v in det[i].items() if v[1] >= a.prompt_conf} for i in range(len(frames))]   # prompt boxes
    for i, d in extra.items():
        for c, b in d.items():
            pr[int(i)][int(c)] = (tuple(b), 1.0)
    print('prompt frames per class:', {CLASSES[c]: sum(c in p for p in pr) for c in range(len(CLASSES))}, flush=True)

    # 2. SAM 2 per chunk
    pred = build_sam2_video_predictor(a.cfg, a.ckpt, device='cuda')
    sam = [dict() for _ in frames]                                              # frame -> cls -> (box, mask)
    tmp = Path('chunk');
    for c0 in range(0, len(frames), a.chunk):
        idx = list(range(c0, min(len(frames), c0 + a.chunk)))
        shutil.rmtree(tmp, ignore_errors=True); tmp.mkdir()
        for k, i in enumerate(idx):
            os.symlink(frames[i].resolve(), tmp / f'{k:05d}.jpg')
        with torch.inference_mode(), torch.autocast('cuda', dtype=torch.bfloat16):
            st = pred.init_state(video_path=str(tmp), offload_video_to_cpu=True)
            prompted = set()
            for c in range(len(CLASSES)):
                last = -10**9
                for k, i in enumerate(idx):
                    if c in pr[i] and k - last >= a.prompt_every:
                        pred.add_new_points_or_box(inference_state=st, frame_idx=k, obj_id=c, box=np.array(pr[i][c][0], np.float32))
                        prompted.add(c); last = k
            if prompted:
                for reverse in (False, True):
                    for k, obj_ids, logits in pred.propagate_in_video(st, reverse=reverse):
                        i = idx[k]
                        for o, lg in zip(obj_ids, logits):
                            mb = mask_box((lg[0] > 0).cpu().numpy(), min_px=60)
                            if mb:
                                sam[i][o] = mb
            pred.reset_state(st)
        print(f'sam chunk {c0}-{idx[-1]}: prompted {sorted(CLASSES[c] for c in prompted)}', flush=True)

    # 3. labels
    flagged, counts = 0, [0] * len(CLASSES)
    for i, f in enumerate(frames):
        lines, view = [], None
        if i % 25 == 0:
            view = cv2.imread(str(f))
        for c in range(len(CLASSES)):
            box = sam[i][c][0] if c in sam[i] else None
            if c in det[i] and det[i][c][1] >= a.prompt_conf:
                yb = tuple(int(v) for v in det[i][c][0])
                if box is None or iou(box, yb) < 0.3:
                    flagged += box is not None
                    if box is None or not extra:     # with --prompts, SAM (prompted by trusted boxes) wins disagreements
                        box = yb
            if box is None:
                continue
            x1, y1, x2, y2 = box
            lines.append(f'{c} {(x1 + x2) / 2 / W:.6f} {(y1 + y2) / 2 / H:.6f} {(x2 - x1) / W:.6f} {(y2 - y1) / H:.6f}')
            counts[c] += 1
            if view is not None:
                if c in sam[i]:
                    cnts = cv2.findContours(sam[i][c][1].astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[0]
                    cv2.drawContours(view, cnts, -1, COLORS[c], 2)
                cv2.rectangle(view, (x1, y1), (x2, y2), COLORS[c], 1)
                cv2.putText(view, CLASSES[c], (x1, max(20, y1 - 6)), cv2.FONT_HERSHEY_SIMPLEX, .7, COLORS[c], 2)
        (out / 'labels' / f'{names[i]}.txt').write_text(''.join(l + '\n' for l in lines))
        if view is not None:
            cv2.imwrite(str(out / 'preview' / f'{names[i]}.jpg'), view, [cv2.IMWRITE_JPEG_QUALITY, 80])
    rep = {'frames': len(frames), 'boxes': dict(zip(CLASSES, counts)), 'flagged_disagreements': flagged}
    (out / 'report.json').write_text(json.dumps(rep, indent=2)); print(rep, flush=True)


if __name__ == '__main__':
    main()
