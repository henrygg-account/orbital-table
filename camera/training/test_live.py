"""Camera-free tests for live.py: python test_live.py"""
import json, time, tempfile
import cv2, numpy as np
import live

cfg = live.load_config()
cfg["screen_mm"] = [1428.5, 803.5]; cfg["camera_height_mm"] = 1500   # tests use fixed values, whatever pieces.json says
cfg["map"] = {"tape": "earth", "ball": "moon", "marker": "seldon"}
cfg["roles"] = {"earth": {"count": 1, "height_mm": 30}, "moon": {"count": 1, "height_mm": 15}, "seldon": {"count": 2, "height_mm": 45}}   # exercises count>1 id tracking
assert cfg['roles']['seldon']['count'] == 2 and cfg['map']['tape'] == 'earth'

# --- id assignment stability
def D(x, y, c=0.9): return {'x_mm': x, 'y_mm': y, 'u': x / 1428.5, 'v': y / 803.5, 'conf': c}
t = live.Tracker(cfg); now = 100.0
r = dict(t.update('seldon', [D(300, 300), D(900, 500)], now))
a, b = [i for i, d in r.items() if d['x_mm'] == 300][0], [i for i, d in r.items() if d['x_mm'] == 900][0]
assert {a, b} == {'seldon-1', 'seldon-2'}
for k in range(1, 40):                       # swap listing order, cross paths in small steps
    now += 0.1
    p1, p2 = (300 + 15 * k, 300), (900 - 15 * k, 360)   # pass 60 mm apart
    out = dict(t.update('seldon', [D(*p2), D(*p1)], now))
    assert out[a]['x_mm'] == p1[0] and out[b]['x_mm'] == p2[0], k
# one disappears: the other keeps its id, then reappearing takes the free one
out = dict(t.update('seldon', [D(*p1)], now + 0.1)); assert list(out) == [a]
out = dict(t.update('seldon', [D(*p1), D(1000, 100)], now + 0.2)); assert out[b]['x_mm'] == 1000
# extra detections are capped to count, best confidence wins
assert len(t.update('seldon', [D(1, 1, .5), D(2, 2, .9), D(3, 3, .7)], now + .3)) == 2
assert [i for i, _ in t.update('earth', [D(5, 5)], now)] == ['earth']
f = t.feed(now + 0.3); assert f['earth']['role'] == 'earth' and 'seen_ago' in f['earth']
t.expire(now + 10.2); assert 'earth' not in t.feed(now + 10.2) and 'seldon-1' in t.feed(now + 10.2)
t.expire(now + 12); assert not t.pieces

# --- parallax
x, y = live.parallax_correct((1000, 500), (700, 400), 1500, 45)
assert abs(x - (700 + 300 * 1455 / 1500)) < 1e-9 and abs(y - (400 + 100 * 0.97)) < 1e-9
assert live.parallax_correct((700, 400), (700, 400), 1500, 45) == (700, 400)   # at nadir: no shift
assert live.parallax_correct((10, 20), (700, 400), 1500, 0) == (10, 20)        # on the glass

# --- uncalibrated fallback
x, y = live.to_screen(0.25, 0.5, (1920, 1080), cfg, 'earth', None)
assert abs(x - 1428.5 * .25) < 1e-9 and abs(y - 803.5 * .5) < 1e-9

# --- synthetic calibration: markers at known mm, warped into a camera image
layout = [{'id': i, 'x_mm': x, 'y_mm': y, 'size_mm': 80}
          for i, (x, y) in enumerate([(100, 100), (1328, 100), (1328, 700), (100, 700), (714, 400)])]
S = 0.9   # px per mm on the "screen canvas"
canvas = np.full((int(803.5 * S) + 1, int(1428.5 * S) + 1), 255, np.uint8)
for m in layout:
    px = int(m['size_mm'] * S); q = px // 6 * 6       # multiple of 6 cells
    img = cv2.aruco.generateImageMarker(cv2.aruco.getPredefinedDictionary(live.ARUCO_DICT), m['id'], q)
    pad = q // 6                                      # white quiet border of one cell
    x0, y0 = int(m['x_mm'] * S - q / 2), int(m['y_mm'] * S - q / 2)
    canvas[y0 - pad:y0 + q + pad, x0 - pad:x0 + q + pad] = 255
    canvas[y0:y0 + q, x0:x0 + q] = img
# canvas px -> camera px: mild perspective + scale + offset
src = np.float32([[0, 0], [canvas.shape[1], 0], [canvas.shape[1], canvas.shape[0]], [0, canvas.shape[0]]])
dst = np.float32([[150, 90], [1780, 140], [1700, 1020], [210, 1000]])
Wp = cv2.getPerspectiveTransform(src, dst)
cam = cv2.warpPerspective(canvas, Wp, (1920, 1080), borderValue=128)
found = live.detect_markers(live.make_detector(), cam)
assert set(found) == {0, 1, 2, 3, 4}, found.keys()
H, rms, n = live.compute_calibration(layout, found)
assert n == 5 and rms < 2.0, rms
# a point at known screen mm round-trips through the camera
mm = np.array([[[500., 300.]]]); cam_px = cv2.perspectiveTransform(mm * S, Wp)[0, 0]
bx, by = live.apply_h(H, *cam_px); assert np.hypot(bx - 500, by - 300) < 2.0, (bx, by)
# calibrated to_screen uses nadir parallax
u, v = cam_px[0] / 1920, cam_px[1] / 1080
x, y = live.to_screen(u, v, (1920, 1080), cfg, 'seldon', H)
nx, ny = live.apply_h(H, 960, 540)
assert abs(x - (nx + (bx - nx) * 1455 / 1500)) < 1e-6
# too few markers
try: live.compute_calibration(layout, {0: found[0], 1: found[1]}); assert False
except ValueError: pass
# CalibRequest end-to-end + save/load
with tempfile.TemporaryDirectory() as d:
    live.save_calib(H, cfg['screen_mm'], d + '/c.json')
    assert np.allclose(live.load_calib(d + '/c.json'), H) and live.load_calib(d + '/none.json') is None
live.CALIB_JSON = live.HERE / 'calib_test_tmp.json'
req = live.CalibRequest(layout, 3.0)
assert req.feed_frame(live.make_detector(), cam, cfg) and req.result['ok'] and req.result['markers_found'] == 5
live.CALIB_JSON.unlink()
live.state['H'] = None
req = live.CalibRequest(layout, 3.0); req.deadline = 0
assert req.feed_frame(live.make_detector(), np.zeros((100, 100, 3), np.uint8), cfg) and not req.result['ok']

# --- marker png
png = cv2.imdecode(np.frombuffer(live.marker_png(3), np.uint8), 0)
assert png.shape == (600, 600) and png[0, 0] == 0
print('ok')


# single-piece roles: a one-frame stray detection far away never moves the piece; a persistent one does
cfg1 = dict(cfg, roles={'earth': {'count': 1, 'height_mm': 30}})
T = live.Tracker(cfg1)
T.update('earth', [D(100, 100)], 0.0)
for k in range(1, 4):                                   # real Earth + a brighter stray far away
    T.update('earth', [D(101, 100, .8), D(400, 300, .95)], k * .05)
assert abs(T.pieces['earth']['x_mm'] - 100) < 2      # stays put (the far stray is ignored; 1 mm is inside the deadband)
for k in range(4, 4 + live.Tracker.JUMP_FRAMES + 1):    # Earth really moved: only the far detection now
    T.update('earth', [D(400, 300)], k * .05)
assert abs(T.pieces['earth']['x_mm'] - 400) < 1e-6
print('ok')

# stillness lock: jitter on a resting piece never moves it; a real move does
T = live.Tracker(cfg1)
rng = np.random.default_rng(0)
for k in range(60):                                     # 3 s at rest with ±3 mm detector jitter
    T.update('earth', [D(200 + rng.uniform(-3, 3), 150 + rng.uniform(-3, 3))], k * .05)
x0 = T.pieces['earth']['x_mm']
for k in range(60, 120):
    T.update('earth', [D(200 + rng.uniform(-3, 3), 150 + rng.uniform(-3, 3))], k * .05)
assert T.pieces['earth']['x_mm'] == x0                  # frozen
for k in range(120, 140):                               # slid 30 mm (within NEAR, so no jump logic)
    T.update('earth', [D(200 + min(30, (k - 119) * 3), 150)], k * .05)
assert abs(T.pieces['earth']['x_mm'] - 230) < 4, T.pieces['earth']['x_mm']
print('ok')
