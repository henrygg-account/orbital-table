"""prune.py — strip the near-duplicate frames out of passive recordings (videos/rec_*.mp4|avi).

  .venv/Scripts/python prune.py [FILES ...]      (default: every videos/rec_* except the one live.py is writing)

Keeps a frame only if the table area visibly changed since the last frame kept (live.ChangeGate, the same test the
recorder now applies as it records), so a still table costs nothing. Each file is rewritten as an MJPEG .avi (CPU
only; quality 90), checked by reading it back, and only then replaces the original; its .json sidecar gets the new
frame count. An H.264 .mp4 is only rewritten if that makes it smaller (most of it dropped). A file with nothing
left is deleted with its sidecar. Files recorded through record-guide.html (with a .steps.json) are left alone:
their step times index the original frames.
"""
import argparse, glob, json, os, urllib.request
from pathlib import Path

import cv2
import numpy as np

import live

HERE = Path(__file__).parent
MP4_KEEP_MAX = 0.25      # an H.264 .mp4 is rewritten only if at most this share of its frames is kept


def writing_now():
    """The file live.py's recorder has open, if it is running."""
    try:
        line = urllib.request.urlopen('http://127.0.0.1:8780/events', timeout=3).readline().decode()
        rec = json.loads(line[6:]).get('rec') or {}
        return rec.get('file') if rec.get('recording') else None
    except Exception:
        return None


def prune(path):
    side = path.with_suffix('.json')
    meta = json.loads(side.read_text()) if side.exists() else {}
    H = np.array(meta['H']) if meta.get('H') else live.load_calib(frame_wh=meta.get('frame_wh'))
    cap = cv2.VideoCapture(str(path))
    fps = cap.get(cv2.CAP_PROP_FPS) or 10
    gate, keep, n, out, tmp = live.ChangeGate(H), 0, 0, None, path.with_name(path.stem + '.pruning.avi')
    while True:
        ok, f = cap.read()
        if not ok:
            break
        n += 1
        if not gate.changed(f):
            continue
        if out is None:
            out = cv2.VideoWriter(str(tmp), cv2.CAP_OPENCV_MJPEG, cv2.VideoWriter_fourcc(*'MJPG'), fps, (f.shape[1], f.shape[0]))
            out.set(cv2.VIDEOWRITER_PROP_QUALITY, 90)
        out.write(f); keep += 1
    cap.release()
    if out is not None:
        out.release()
    if path.suffix == '.mp4' and keep > MP4_KEEP_MAX * n:   # MJPEG is ~3.5x H.264 per frame: only worth it if most goes
        tmp.unlink(missing_ok=True)
        return n, n, f'left as is ({keep} changed: mostly real activity, an MJPEG rewrite would be bigger)'
    if keep == 0:
        path.unlink(); side.unlink(missing_ok=True)
        return n, 0, 'deleted (nothing changed)'
    back = cv2.VideoCapture(str(tmp)); m = 0
    while back.read()[0]:
        m += 1
    back.release()
    if m != keep:                                  # never replace a recording with something unreadable
        tmp.unlink()
        return n, keep, f'NOT replaced: rewrite reads back {m} frames, expected {keep}'
    final = path.with_suffix('.avi')
    if path != final:
        path.unlink()
    os.replace(tmp, final)
    if meta:
        meta.update(frames=keep, pruned=True, frames_before_prune=meta.get('frames_before_prune', n))
        side.write_text(json.dumps(meta))
    return n, keep, f'-> {final.name}'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('files', nargs='*')
    a = ap.parse_args()
    busy = writing_now()
    files = [Path(p) for p in (a.files or sorted(glob.glob(str(HERE / 'videos' / 'rec_*.mp4')) + glob.glob(str(HERE / 'videos' / 'rec_*.avi'))))]
    tot_n = tot_k = 0
    for p in files:
        side = p.with_suffix('.json')
        done = side.exists() and json.loads(side.read_text()).get('pruned')   # a second pass would only re-encode it
        if p.name == busy or p.name.endswith('.pruning.avi') or p.with_suffix('.steps.json').exists() or done:
            print(f'{p.name}: skipped' + (' (being recorded)' if p.name == busy else ' (already pruned)' if done else ''))
            continue
        n, k, what = prune(p)
        tot_n += n; tot_k += k
        print(f'{p.name}: {n} -> {k} frames {what}', flush=True)
    print(f'total {tot_n} -> {tot_k} frames')


if __name__ == '__main__':
    main()
