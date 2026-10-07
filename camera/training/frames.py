"""Split an iPhone video into training frames.

  python frames.py VIDEO [--set tv] [--every 0.5] [--out DIR]

Keeps one frame every `--every` seconds, skipping blurry frames (motion blur) and
frames that barely differ from the last one kept (nothing moved).
"""
import argparse, subprocess, sys
from pathlib import Path

import cv2
import numpy as np

from sets import SETS


def sharpness(gray):
    return cv2.Laplacian(gray, cv2.CV_64F).var()


def open_video(path):
    cap = cv2.VideoCapture(str(path))
    if cap.isOpened() and cap.read()[0]:
        cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
        return cap, path
    # OpenCV can't decode it (e.g. HEVC .MOV): convert to H.264 once with ffmpeg.
    conv = path.with_suffix('.h264.mp4')
    if not conv.exists():
        print(f'converting {path.name} to H.264 ...')
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(path), '-c:v', 'libx264',
                        '-crf', '16', '-an', str(conv)], check=True)
    return cv2.VideoCapture(str(conv)), conv


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('video', type=Path)
    ap.add_argument('--every', type=float, default=0.5, help='seconds between kept frames')
    ap.add_argument('--set', default='standins', choices=list(SETS), help='dataset to add frames to (tv = printed pieces)')
    ap.add_argument('--out', type=Path, help='output folder (default: <set>/raw)')
    ap.add_argument('--blur', type=float, default=0.5, help='drop frames sharper than less than this fraction of the median')
    ap.add_argument('--same', type=float, default=2.0, help='drop frames whose mean pixel change from the last kept is below this')
    a = ap.parse_args()
    a.out = a.out or SETS[a.set]['dir'] / 'raw'

    cap, src = open_video(a.video)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    step = max(1, round(fps * a.every))
    a.out.mkdir(parents=True, exist_ok=True)
    print(f'{src.name}: {total} frames @ {fps:.1f} fps, sampling every {step} frames')

    # Pass 1: read candidate frames and their sharpness (pick the sharpest frame in each window).
    cands, best, i = [], None, 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        g = cv2.cvtColor(cv2.resize(frame, (480, 270)), cv2.COLOR_BGR2GRAY)
        s = sharpness(g)
        if best is None or s > best[0]:
            best = (s, i, frame, g)
        i += 1
        if i % step == 0:
            cands.append(best); best = None
    if best:
        cands.append(best)
    if not cands:
        sys.exit('no frames read')

    med = float(np.median([c[0] for c in cands]))
    kept = blurry = same = 0
    last = None
    for s, idx, frame, g in cands:
        if s < a.blur * med:
            blurry += 1; continue
        if last is not None and cv2.absdiff(g, last).mean() < a.same:
            same += 1; continue
        last = g
        cv2.imwrite(str(a.out / f'{a.video.stem}_{idx:06d}.jpg'), frame, [cv2.IMWRITE_JPEG_QUALITY, 95])
        kept += 1
    print(f'kept {kept} -> {a.out}   (skipped {blurry} blurry, {same} unchanged)')


if __name__ == '__main__':
    main()
