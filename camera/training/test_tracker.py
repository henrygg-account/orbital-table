"""test_tracker.py — the rules in tracker.py, one synthetic scene each. Run: .venv/bin/python test_tracker.py"""
from tracker import Tracker

CFG = {'screen_mm': [1428.5, 803.5], 'roles': {'earth': {'count': 1}, 'seldon-1': {'count': 1}, 'seldon-2': {'count': 1}}}
FPS = 20


def det(role, x, y, conf=0.8, colour=None):
    return {'role': role, 'x_mm': x, 'y_mm': y, 'u': 0, 'v': 0, 'conf': conf, 'colour': colour}


def run(T, frames, t0=0.0):
    """frames: list of detection lists, one per 1/FPS s. Returns the time after the last frame."""
    t = t0
    for dets in frames:
        T.step(dets, t); t += 1 / FPS
    return t


def pos(T, i):
    p = T.feed(0).get(i)
    return None if p is None else (p['x_mm'], p['y_mm'])


def check(name, cond):
    print(('ok   ' if cond else 'FAIL ') + name)
    assert cond, name


def placed():
    T = Tracker(CFG)
    t = run(T, [[det('seldon-1', 600, 400), det('seldon-2', 720, 400), det('earth', 300, 400)]] * 6)
    return T, t


T, t = placed()
check('pieces appear after CONFIRM_FRAMES', set(T.pieces) == {'seldon-1', 'seldon-2', 'earth'})

T = Tracker(CFG)
run(T, [[det('seldon-1', 600, 400)]] * 3)
check('not before', 'seldon-1' not in T.pieces)
T = Tracker(CFG)
run(T, [[det('seldon-1', 600, 400, conf=0.2)]] * 20)
check('weak detections never place a piece', 'seldon-1' not in T.pieces)

T, t = placed()
t = run(T, [[det('seldon-2', 600, 400), det('seldon-1', 720, 400), det('earth', 300, 400)]] * 3, t)   # labels swapped
check('swapped labels do not swap pieces', pos(T, 'seldon-1') == (600, 400) and pos(T, 'seldon-2') == (720, 400))

T, t = placed()
t = run(T, [[det('seldon-1', 600, 400), det('seldon-2', 720, 400), det('earth', 300, 400), det('seldon-1', 1100, 200)]] * 30, t)
check('a piece being seen is never pulled to a persistent far detection', pos(T, 'seldon-1') == (600, 400))

T, t = placed()
t = run(T, [[det('seldon-2', 720, 400), det('earth', 300, 400)]] * 10, t)                         # seldon-1 covered
t = run(T, [[det('seldon-2', 720, 400), det('earth', 300, 400), det('seldon-1', 1100, 200)]] * 2, t)   # a 2-frame stray
check('a covered piece ignores a short stray elsewhere', pos(T, 'seldon-1') == (600, 400))
t = run(T, [[det('seldon-2', 720, 400), det('earth', 300, 400), det('seldon-1', 1100, 200)]] * 5, t)
check('...but follows a confirmed move (picked up, put down)', pos(T, 'seldon-1') == (1100, 200))

T, t = placed()
t = run(T, [[det('seldon-2', 720, 400), det('earth', 300, 400)]] * (FPS * 2), t)
check('covered mid-table: still there after 2 s', pos(T, 'seldon-1') == (600, 400))
t = run(T, [[det('seldon-2', 720, 400), det('earth', 300, 400)]] * (FPS * 2), t)
check('...but gone after HOLD_S (3 s), in case it was really taken away', 'seldon-1' not in T.pieces)

T = Tracker(CFG)
t = run(T, [[det('seldon-1', 1390, 400), det('earth', 300, 400)]] * 6)
t = run(T, [[det('earth', 300, 400)]] * (3 * FPS), t)
check('last seen at the edge: gone after LEAVE_S', 'seldon-1' not in T.pieces)

T, t = placed()
t = run(T, [[det('seldon-1', 600, 400), det('seldon-2', 720, 400), det('earth', 300, 400), det('seldon-2', 610, 405)]] * 10, t)
check('no second piece on top of another', pos(T, 'seldon-2') == (720, 400))

T = Tracker(CFG)
yellow, red = {'earth': 0, 'seldon-1': .3, 'seldon-2': 0}, {'earth': 0, 'seldon-1': 0, 'seldon-2': .3}
run(T, [[det('seldon-2', 600, 400, colour=yellow), det('seldon-1', 900, 400, colour=red)]] * 6)
check('colour relabels a wrong class', pos(T, 'seldon-1') == (600, 400) and pos(T, 'seldon-2') == (900, 400))

T, t = placed()
for k in range(9):                                     # 1.2 m/s hand move (60 mm per frame), seen every frame
    t = run(T, [[det('seldon-1', 600 - 60 * k, 400), det('seldon-2', 720, 700), det('earth', 1200, 200)]], t)
check('a fast hand move is followed frame by frame', pos(T, 'seldon-1')[0] < 150)

T, t = placed()
t = run(T, [[det('earth', 300, 400)]] * 4, t)          # both Seldons covered by an arm for 0.2 s
t = run(T, [[det('seldon-1', 610, 402), det('seldon-2', 715, 398), det('earth', 300, 400)]], t)
check('uncovered pieces pick up where they were', abs(pos(T, 'seldon-1')[0] - 610) < 1 and abs(pos(T, 'seldon-2')[0] - 715) < 1)
T = Tracker(CFG)
run(T, [[det('earth', 600, 400, conf=.9, colour={'earth': 0, 'seldon-1': 0, 'seldon-2': 0})]] * 20)
check('a confident box with none of its colour never places the piece (a person called Earth)', 'earth' not in T.pieces)
T = Tracker(CFG)
blue = {'earth': .6, 'seldon-1': 0, 'seldon-2': 0}
run(T, [[det('earth', 800, 70, conf=.13, colour=blue)]] * 40)
check('weak blue glow (the readout text) never places Earth', 'earth' not in T.pieces)
T, t = placed()
t = run(T, [[det('seldon-1', 600, 400), det('seldon-2', 720, 400), det('earth', 300, 400, conf=.08)]] * (FPS * 6), t)
check('a piece seen only weakly for 6 s fades out (phantom)', 'earth' not in T.pieces)
T, t = placed()
t = run(T, [[det('seldon-1', 600, 400), det('seldon-2', 720, 400), det('earth', 300, 400, conf=.08 if k % 10 else .9)] for k in range(FPS * 6)], t)
check('...but a real piece with an occasional confident hit stays', pos(T, 'earth') == (300, 400))
print('all tracker rules hold')
