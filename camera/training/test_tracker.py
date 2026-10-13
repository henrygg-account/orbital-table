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
run(T, [[det('seldon-2', 600, 400, conf=.4, colour=yellow), det('seldon-1', 900, 400, conf=.4, colour=red)]] * 6)
check('colour relabels a weak wrong class', pos(T, 'seldon-1') == (600, 400) and pos(T, 'seldon-2') == (900, 400))
T = Tracker(CFG)
run(T, [[det('seldon-2', 600, 400, colour=yellow), det('seldon-1', 900, 400, colour=red)]] * 6)
check('colour never overrides a confident class (COLOUR-STUDY.md: 20 identity swaps vs 2)', pos(T, 'seldon-2') == (600, 400) and pos(T, 'seldon-1') == (900, 400))

T, t = placed()
for k in range(9):                                     # 1.2 m/s hand move (60 mm per frame), seen every frame
    t = run(T, [[det('seldon-1', 600 - 60 * k, 400), det('seldon-2', 720, 700), det('earth', 1200, 200)]], t)
check('a fast hand move is followed frame by frame', pos(T, 'seldon-1')[0] < 200)

T, t = placed()
t = run(T, [[det('earth', 300, 400)]] * 4, t)          # both Seldons covered by an arm for 0.2 s
t = run(T, [[det('seldon-1', 610, 402), det('seldon-2', 715, 398), det('earth', 300, 400)]], t)
check('uncovered pieces pick up where they were', abs(pos(T, 'seldon-1')[0] - 610) < 5 and abs(pos(T, 'seldon-2')[0] - 715) < 5)
T = Tracker(CFG)
run(T, [[det('earth', 600, 400, conf=.4, colour={'earth': 0, 'seldon-1': 0, 'seldon-2': 0})]] * 20)
check('a weak box with none of its colour never places the piece (a person called Earth)', 'earth' not in T.pieces)
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

# ---- hands (person outlines in screen mm): a hand near a still piece must not move it
def box(x, y, w=120, h=100):
    return [(x - w / 2, y - h / 2), (x + w / 2, y - h / 2), (x + w / 2, y + h / 2), (x - w / 2, y + h / 2)]


def run_h(T, frames, t0):
    """frames: [(dets, hands)] one per 1/FPS s."""
    t = t0
    for dets, hands in frames:
        T.step(dets, t, hands); t += 1 / FPS
    return t


def settled():
    T, t = placed()
    return T, run(T, [[det('seldon-1', 600, 400), det('seldon-2', 720, 400), det('earth', 300, 400)]] * (2 * FPS), t)   # locked


others = [det('seldon-2', 720, 400), det('earth', 300, 400)]
T, t = settled()
t = run_h(T, [([det('seldon-1', 600 + 25 * (k % 2), 400 + 30 * (k % 3 - 1))] + others, [box(480, 400, 100, 100)]) for k in range(2 * FPS)], t)
check('hand waving over a still piece: detection jitter does not move it', pos(T, 'seldon-1') == (600, 400))
t = run_h(T, [([det('seldon-1', 600 + 45, 400)] + others, [box(480, 400, 100, 100)]) for k in range(2 * FPS)], t)
check('...nor a detection that drifts 45 mm and stays (hand not holding it)', pos(T, 'seldon-1') == (600, 400))
t = run_h(T, [([det('seldon-1', 600, 400)] + others, None) for k in range(FPS)], t)
check('...and once the hand is gone it is still where it was', pos(T, 'seldon-1') == (600, 400))

T, t = settled()
t = run_h(T, [([det('seldon-1', 600, 400)] + others, None)] * 2 + [([det('seldon-1', 600, 400)] + others, [box(1000, 100)])] * 3, t)
t = run_h(T, [([det('seldon-1', 600 + 4 * k, 400)] + others, [box(1000, 100)]) for k in range(10)], t)
check('a far-away hand does not hold a piece: a slow push is followed', pos(T, 'seldon-1')[0] > 625)

T, t = settled()
t = run_h(T, [([det('seldon-1', 600 + 20 * k, 400)] + others, [box(600 + 20 * k, 400, 160, 120)]) for k in range(15)], t)   # carried 280 mm
check('a hand carrying the piece (outline on it) moves it along', pos(T, 'seldon-1')[0] > 700)
t = run_h(T, [([det('seldon-1', 880, 400)] + others, None)] * FPS, t)
check('...and it settles where it is put down', abs(pos(T, 'seldon-1')[0] - 880) < 1)

T, t = settled()                                                         # picked up, hand holds it, put down 300 mm away
t = run_h(T, [(others, [box(600, 400)])] * 6, t)                          # covered by the hand
t = run_h(T, [([det('seldon-1', 900, 400)] + others, [box(900, 400)])] * (FPS // 2), t)   # reappears under the hand
check('a piece under a hand is not relocated while the hand is on it', pos(T, 'seldon-1') == (600, 400))
t = run_h(T, [([det('seldon-1', 900, 400)] + others, None)] * FPS, t)
check('...it settles at the new spot once the hand is gone', pos(T, 'seldon-1') == (900, 400))

T, t = settled()
t = run_h(T, [(others + [det('seldon-1', 1100, 200)], [box(1100, 200)])] * (FPS // 2), t)    # a hand called Seldon-1, half a second
check('a hand labelled as a piece for half a second does not relocate it', pos(T, 'seldon-1') == (600, 400))
t = run_h(T, [(others + [det('seldon-1', 1100 + 20 * k, 200)], [box(1100 + 20 * k, 200)]) for k in range(2 * FPS)], t)
check('...but a piece that keeps moving with the hand for 2 s is followed', pos(T, 'seldon-1')[0] > 1100)

T, t = settled()
t = run(T, [[det('seldon-1', 600 + 3 * k, 400)] + others for k in range(20)], t)           # a deliberate push, 57 mm, no hand
check('a push with no hand near follows within 1 s', pos(T, 'seldon-1')[0] > 640)
T, t = settled()
t = run(T, [[det('seldon-1', 650, 400)] + others] + [[det('seldon-1', 600, 400)] + others] * 10, t)
check('a one-frame outlier 50 mm away does not move a locked piece (no hand needed)', pos(T, 'seldon-1') == (600, 400))
print('all tracker rules hold')
