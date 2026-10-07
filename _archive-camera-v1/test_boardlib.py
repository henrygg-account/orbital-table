"""Synthetic tests for boardlib (run: .venv/bin/python test_boardlib.py)."""
import numpy as np
from boardlib import OneEuroFilter, PieceTracker, cell_hysteresis, cell_name, FeedSender, Board

def test_filter():
    rng = np.random.default_rng(0)
    f = OneEuroFilter(); outs = [f([10 + rng.normal(0, .2), 5 + rng.normal(0, .2)], i / 25) for i in range(200)]
    assert np.std([o[0] for o in outs[50:]]) < 0.12            # jitter reduced from 0.2
    f.reset(); assert np.allclose(f([1, 2], 0), [1, 2])
    for i in range(1, 30): o = f([30, 2], i / 25)               # fast move gets followed
    assert abs(o[0] - 30) < 1.5

def test_hysteresis():
    args = (48, 36, 8, 6)                                       # cell 6x6 in
    assert cell_hysteresis(5.9, 3, None, *args) == (0, 0)
    assert cell_hysteresis(6.5, 3, (0, 0), *args) == (0, 0)     # < 0.9 in past edge: stays
    assert cell_hysteresis(7.0, 3, (0, 0), *args) == (1, 0)
    assert cell_hysteresis(5.5, 3, (1, 0), *args) == (1, 0)
    assert cell_name(2, 2) == 'C3'

def run(tr, frames, t0=100.0, dt=0.04, start=0):
    evs = []; pcs = {}
    for i, d in enumerate(frames):
        pcs, e = tr.update(d, t0 + (start + i) * dt); evs += e
    return pcs, evs

def test_state_machine():
    tr = PieceTracker()
    D = lambda x, y: {'blue': (x, y, .9)}
    pcs, ev = run(tr, [D(15, 15)] * 4)
    assert pcs == {} and ev == []                               # needs 5 frames
    pcs, ev = run(tr, [D(15, 15)], start=4)
    assert pcs['blue']['state'] == 'tracked' and pcs['blue']['cell'] == 'C3' and [e['type'] for e in ev] == ['placed']
    assert tr.search('blue')[2] == 3.0
    # broken streak does not place
    t2 = PieceTracker(); pcs, ev = run(t2, [D(1, 1)] * 3 + [{}] + [D(1, 1)] * 3); assert pcs == {}
    # held then recovers with no event
    pcs, ev = run(tr, [{}] * 10, start=5)
    assert pcs['blue']['state'] == 'held' and pcs['blue']['seen_ago'] > 0.3 and ev == []
    pcs, ev = run(tr, [D(15.2, 15)], start=15)
    assert pcs['blue']['state'] == 'tracked' and ev == []
    # lost -> lifted once
    pcs, ev = run(tr, [{}] * 45, start=16)
    assert pcs['blue']['state'] == 'lost' and [e['type'] for e in ev] == ['lifted'] and pcs['blue']['cell'] == 'C3'
    assert tr.search('blue') is None
    # reappear: placed again after 5 frames
    pcs, ev = run(tr, [D(40, 30)] * 5, start=61)
    assert [e['type'] for e in ev] == ['placed'] and pcs['blue']['cell'] == 'G6'

def test_jump_and_move():
    tr = PieceTracker(); D = lambda x, y: {'blue': (x, y, .9)}
    run(tr, [D(15, 15)] * 6)
    # single-frame outlier (> 4 in) ignored
    pcs, ev = run(tr, [D(30, 15)], start=6)
    assert ev == [] and pcs['blue']['x_in'] < 16 and pcs['blue']['state'] == 'held'
    # normal move to adjacent cell (~7 in: < 1.5 cells, moves gradually through frames <= 4 in)
    evs = []
    for k in range(1, 8):
        pcs, e = run(tr, [D(15 + k * 1.0, 15)] * 3, start=7 + k * 3); evs += e
    moved = [e for e in evs if e['type'] == 'moved']
    assert moved and all(not e['jump'] for e in moved) and moved[-1]['cell'] == 'D3' and moved[0]['from'] == 'C3'
    # relocation after missing > 0.3 s and > 1.5 cells -> jump
    pcs, ev = run(tr, [{}] * 12, start=40)
    pcs, ev = run(tr, [D(40, 30)], start=52)
    assert ev and ev[0]['type'] == 'moved' and ev[0]['jump'] and ev[0]['cell'] == 'G6'
    assert abs(pcs['blue']['x_in'] - 40) < .01                  # filter reset to new spot
    # held but near: no jump event
    run(tr, [{}] * 10, start=53)
    pcs, ev = run(tr, [D(40.5, 30)], start=63); assert ev == []

def test_feed():
    b = Board({'corners': None}, path='/nonexistent/x.json')
    m = FeedSender('t').build(b, 24.96, {'ok': True}, {}, [], 1.0)
    assert m['v'] == 1 and m['seq'] == 1 and m['calibrated'] is False and m['fps'] == 25.0 and 'events' in m

for n, f in list(globals().items()):
    if n.startswith('test_'): f(); print('ok', n)
