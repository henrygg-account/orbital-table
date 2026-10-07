"""Synthetic tests for blink.py (no camera): .venv/bin/python test_blink.py"""
import cv2, numpy as np
from boardlib import Board, PieceTracker
import blink

board = Board()
FPS, N = 25, 75
POS = {'A': (8, 8), 'B': (20, 12), 'C': (32, 8), 'D': (40, 28)}       # board inches
RAND = (10, 28)                                                       # randomly flickering spot


def frames(n=N, leds=POS, hand=True, rand=True, seed=0):
    """Yield (frame, t): static noisy bg, LEDs blinking at their rates, a sweeping hand, a random flicker."""
    rng = np.random.default_rng(seed)
    bg = rng.integers(20, 80, (1080, 1920, 3), dtype=np.uint8)
    cam = {k: board.to_camera([v])[0] for k, v in {**leds, 'R': RAND}.items()}
    for i in range(n):
        t = i / FPS
        f = bg.copy()
        f += rng.integers(0, 6, f.shape, dtype=np.uint8)               # sensor noise
        for k in leds:
            if np.sin(2 * np.pi * blink.RATES[k] * t + 0.7 * ord(k)) > 0:
                cv2.circle(f, tuple(int(round(v)) for v in cam[k]), 8, (255, 255, 255), -1)
        if rand and rng.random() < 0.5:
            cv2.circle(f, tuple(int(round(v)) for v in cam['R']), 8, (255, 255, 255), -1)
        if hand:                                                       # 300x210 bright blob sweeping at 40 px/frame
            x = 600 + 40 * i
            f[470:680, x:x + 300] = 190
        yield f, t


def run(**kw):
    det = blink.BlinkDetector((1080, 1920))
    mask = det.small_mask(board, (1080, 1920))
    out = []
    for f, t in frames(**kw):
        det.push(f, t)
        out.append(det.detect(mask))
    return out


def test_rates_identified_and_rejects():
    out = run()
    assert out[blink.WINDOW - 2] == []                                 # needs a full window
    late = out[40:]
    for k, (x, y) in POS.items():
        for blobs in late:                                             # each LED found in every frame
            hits = [b for b in blobs if b['name'] == k]
            assert len(hits) == 1, (k, [(b['name'], round(b['rate'], 2), round(b['share'], 2)) for b in blobs])
            bx, by = board.to_board([hits[0]['px']])[0]
            assert abs(bx - x) < 0.5 and abs(by - y) < 0.5, (k, bx, by)
    # nothing but the four LEDs is ever accepted (hand sweep and random flicker rejected)
    bad = [(i, b) for i, blobs in enumerate(out) for b in blobs if b['name'] != '?' and b['name'] not in POS]
    assert not bad
    for i, blobs in enumerate(out):
        for b in blobs:
            if b['name'] != '?':
                bx, by = board.to_board([b['px']])[0]
                assert min(np.hypot(bx - x, by - y) for x, y in POS.values()) < 1.0, (i, b)


def test_random_flicker_rejected_many_seeds():
    acc = 0
    for seed in range(6):
        for blobs in run(leds={}, hand=False, seed=seed)[30:]:
            acc += sum(b['name'] != '?' for b in blobs)
    assert acc == 0, acc


def test_hand_only_rejected():
    assert all(b['name'] == '?' for blobs in run(leds={}, rand=False) for b in blobs)


def test_tracker_integration():
    det = blink.BlinkDetector((1080, 1920)); mask = det.small_mask(board, (1080, 1920))
    tr = PieceTracker(board.board_in, board.grid); events = []
    for f, t in frames():
        det.push(f, t)
        dets, _ = blink.to_dets(det.detect(mask), board, {n: tr.search(n) for n in blink.RATES})
        pieces, ev = tr.update(dets, t); events += ev
    assert sorted(e['piece'] for e in events if e['type'] == 'placed') == ['A', 'B', 'C', 'D'], events
    assert set(pieces) == set(blink.RATES) and all(p['state'] in ('tracked', 'held') for p in pieces.values())
    assert pieces['A']['cell'] == 'B2' and pieces['D']['cell'] == 'G5', pieces


if __name__ == '__main__':
    for n, fn in list(globals().items()):
        if n.startswith('test_'):
            fn(); print('ok', n)
