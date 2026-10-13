"""prep5.py — round 5, local step 1: the Oct 12 passive recordings (pruned) -> data_r5/seq for the labelling VM.

  .venv/Scripts/python prep5.py [--day 20261012] [--every 2]

Every --every-th frame of each finished recording of that day (not the one live.py is writing) -> data_r5/seq/00000.jpg ...,
names.json (seq index -> 'r5_<recording>_<frame>'), runs.json ([start, end) seq ranges, one per recording: label5.py's SAM 2
chunks never cross one). Pruned recordings only skip frames where nothing visible changed, so a run has no hidden moves.
"""
import argparse, glob, json
from pathlib import Path

import cv2

import prune

HERE = Path(__file__).parent


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--day', default='20261012')
    ap.add_argument('--every', type=int, default=2)
    ap.add_argument('--out', default=str(HERE / 'data_r5/seq'))
    a = ap.parse_args()
    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    busy = prune.writing_now()
    names, runs = [], []
    for p in sorted(glob.glob(str(HERE / 'videos' / f'rec_{a.day}-*.*'))):
        p = Path(p)
        if p.suffix not in ('.mp4', '.avi') or p.name == busy or p.name.endswith('.pruning.avi'):
            continue
        cap, k, s = cv2.VideoCapture(str(p)), -1, len(names)
        while True:
            ok, f = cap.read()
            if not ok:
                break
            k += 1
            if k % a.every == 0:
                cv2.imwrite(str(out / f'{len(names):05d}.jpg'), f, [cv2.IMWRITE_JPEG_QUALITY, 95])
                names.append(f'r5_{p.stem[4:]}_{k}')
        if len(names) > s:
            runs.append([s, len(names)])
        print(p.name, len(names) - s, flush=True)
    (out / 'names.json').write_text(json.dumps(names)); (out / 'runs.json').write_text(json.dumps(runs))
    print('frames', len(names), 'runs', len(runs))


if __name__ == '__main__':
    main()
