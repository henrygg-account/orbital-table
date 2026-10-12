"""prep4.py — round 4, local step 1: the Oct 9 recording -> data_r4/seq (every 3rd frame, 1280x960) + per-frame step tags.

  .venv/bin/python prep4.py [--video videos/rec_20261009-104621.mp4] [--every 3]

Writes data_r4/seq/00000.jpg ..., names.json (seq index -> 'r4_<video frame>'), tags.json (seq index -> the shot-list
step's tags, from record-guide.html's step log). The step log is in real seconds; the camera delivered fewer than the
30 fps the file is stamped with, so real time maps to frames by frames / logged duration.
"""
import argparse, json
from pathlib import Path

import cv2

HERE = Path(__file__).parent


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--video', default=str(HERE / 'videos/rec_20261009-104621.mp4'))
    ap.add_argument('--every', type=int, default=3)
    ap.add_argument('--out', default=str(HERE / 'data_r4/seq'))
    a = ap.parse_args()
    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    steps = json.loads(Path(a.video).with_suffix('.steps.json').read_text())['steps']
    cap = cv2.VideoCapture(a.video)
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    real_s = max(s['end'] or s['start'] for s in steps)
    per_s = n / real_s                                          # frames per real second (~27)
    names, tags, i, k = [], {}, -1, 0
    while True:
        ok = cap.grab(); i += 1
        if not ok:
            break
        if i % a.every:
            continue
        ok, f = cap.retrieve()
        if not ok:
            break
        cv2.imwrite(str(out / f'{k:05d}.jpg'), cv2.resize(f, (1280, 960), interpolation=cv2.INTER_AREA), [cv2.IMWRITE_JPEG_QUALITY, 92])
        t = i / per_s
        st = next((s for s in steps if s['start'] <= t < (s['end'] or 1e9)), steps[-1])
        names.append(f'r4_{i:05d}'); tags[k] = {'step': st['title'], 'tags': st['tags']}
        k += 1
        if k % 500 == 0:
            print(k, flush=True)
    (out / 'names.json').write_text(json.dumps(names))
    (out / 'tags.json').write_text(json.dumps(tags))
    print('done', k, 'frames', flush=True)


if __name__ == '__main__':
    main()
