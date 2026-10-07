"""Synthetic tests for dots.py (no camera): .venv/bin/python test_dots.py"""
import cv2, numpy as np
from boardlib import Board, PieceTracker
import dots

board = Board()                                     # corners from board.json (read-only here)
P = dict(dots.DEFAULTS)
OFFS = {1: [(0, 0)], 2: [(-0.4, 0), (0.4, 0)], 3: [(-0.5, 0.3), (0.5, 0.3), (0, -0.5)]}   # dot offsets in inches


def frame_with(clusters, glare=()):
    """1920x1080 frame; clusters = [(k, x_in, y_in)], glare = [(x_in, y_in)] static 3-dot blobs."""
    f = np.random.default_rng(1).integers(0, 60, (1080, 1920, 3), dtype=np.uint8)
    pts = [(x + dx, y + dy) for k, x, y in clusters for dx, dy in OFFS[k]]
    for gx, gy in glare:
        pts += [(gx + dx, gy + dy) for dx, dy in OFFS[3]]
    for (cx, cy) in board.to_camera(pts):
        cv2.circle(f, (int(round(cx)), int(round(cy))), 4, (255, 255, 255), -1)
    return f


def test_ids_and_positions():
    cl = [(1, 6, 6), (2, 24, 18), (3, 40, 30)]
    dets, px_of, dp, _ = dots.detect_dots(frame_with(cl), board, P)
    assert set(dets) == {'dots1', 'dots2', 'dots3'} and len(dp) == 6
    for k, x, y in cl:
        dx, dy, conf = dets[dots.NAMES[k]]
        assert abs(dx - x) < 0.3 and abs(dy - y) < 0.3, (k, dx, dy)
        assert conf > 0.5
    assert len(px_of['dots3']) == 3


def test_glare_background():
    f = frame_with([(2, 24, 18)], glare=[(10, 25)])
    dets, *_ = dots.detect_dots(f, board, P)
    assert 'dots3' in dets                           # glare looks like a 3-dot piece
    bg = dots.learn_background(frame_with([], glare=[(10, 25)]), P)
    dets, *_ = dots.detect_dots(f, board, P, background=bg)
    assert set(dets) == {'dots2'}


def test_outside_board_and_cluster_size():
    dets, *_ = dots.detect_dots(frame_with([(1, 24, 18)]) | 0, board, P, bmask=np.zeros((1080, 1920), np.uint8))
    assert not dets
    # four dots in one cluster is not a piece
    f = frame_with([(3, 20, 20), (1, 20.9, 20.9)])
    dets, *_ = dots.detect_dots(f, board, P)
    assert 'dots3' not in dets


def test_tracker_placed_then_moved():
    tr = PieceTracker(board.board_in, board.grid)
    events, t = [], 0.0
    x = 20.0
    for i in range(60):                              # settle, then walk 0.5 in/frame across a cell edge (x=24)
        if i >= 10:
            x = min(20.0 + 0.5 * (i - 10), 28.0)
        dets, *_ = dots.detect_dots(frame_with([(2, x, 20)]), board, P, near={n: tr.search(n) for n in dots.NAMES.values()})
        pieces, ev = tr.update(dets, t)
        events += ev; t += 0.04
    kinds = [(e['type'], e['piece'], e['jump']) for e in events]
    assert kinds[0] == ('placed', 'dots2', False), kinds
    assert ('moved', 'dots2', False) in kinds, kinds
    assert pieces['dots2']['state'] == 'tracked' and pieces['dots2']['cell'] == 'E4', pieces

    # teleport: gated at first, then a relocation after > 0.3 s
    for i in range(20):
        dets, *_ = dots.detect_dots(frame_with([(2, 8, 30)]), board, P)
        pieces, ev = tr.update(dets, t); events += ev; t += 0.04
    assert any(e['type'] == 'moved' and e['jump'] for e in events), events
    assert pieces['dots2']['cell'] == 'B6', pieces


if __name__ == '__main__':
    for n, fn in list(globals().items()):
        if n.startswith('test_'):
            fn(); print('ok', n)
