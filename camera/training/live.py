"""Run the trained detector live on a camera (iPhone by default) and feed the orbit3d pages.

  python live.py [--weights runs/yolo11s-960/weights/best.pt] [--camera arducam --size 2048x1536] [--index N]
                 [--conf 0.4] [--port 8780] [--no-window]

Recording training video while the page runs: GET /record?min=10 starts, /record/stop stops (files in videos/).

Keys: q quits, s saves the current frame to data/raw (to add to training later).
Contract with the pages (pieces.json, /events, /calibrate, /marker/<id>.png): ../orbit3d/FEED.md.
Everything outside main() is importable without a camera (see test_live.py).
"""
import argparse, json, re, threading, time, webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).parent
WEB = HERE.parent / 'orbit3d'
PIECES_JSON = HERE / 'pieces.json'
CALIB_JSON = HERE / 'calib.json'
COLORS = {'earth': (0, 200, 255), 'moon': (60, 230, 230), 'seldon': (60, 60, 240), 'iss': (255, 200, 60)}
DROP_AFTER = 10.0        # seconds unseen before a piece leaves the feed
CALIB_WINDOW = 3.0       # seconds the main loop looks for markers
ARUCO_DICT = cv2.aruco.DICT_4X4_50

lock = threading.Lock()
state = {'fps': 0.0, 'cfg': None, 'H': None, 'pieces': {}, 'pending': None}


# ---------------------------------------------------------------- config / geometry
def load_config(path=PIECES_JSON):
    cfg = json.loads(Path(path).read_text())
    cfg['screen_mm'] = [float(cfg['screen_mm'][0]), float(cfg['screen_mm'][1])]
    return cfg


def load_calib(path=None):
    try:
        return np.array(json.loads(Path(path or CALIB_JSON).read_text())['H'], dtype=np.float64).reshape(3, 3)
    except (OSError, ValueError, KeyError):
        return None


def apply_h(H, x, y):
    """Camera px -> screen mm through a 3x3 homography."""
    p = H @ np.array([x, y, 1.0])
    return float(p[0] / p[2]), float(p[1] / p[2])


def parallax_correct(p, nadir, cam_h, h):
    """A model top h mm above the glass seen at screen point p is really at N + (p-N)*(H-h)/H."""
    k = (cam_h - h) / cam_h
    return nadir[0] + (p[0] - nadir[0]) * k, nadir[1] + (p[1] - nadir[1]) * k


def to_screen(u, v, frame_wh, cfg, role, H=None):
    """u, v: 0-1 camera-frame position -> (x_mm, y_mm). Uncalibrated: u*W, v*H, no parallax."""
    W, Hh = cfg['screen_mm']
    if H is None:
        return u * W, v * Hh
    fw, fh = frame_wh
    p = apply_h(H, u * fw, v * fh)
    nadir = apply_h(H, fw / 2, fh / 2)
    return parallax_correct(p, nadir, cfg['camera_height_mm'], cfg['roles'][role].get('height_mm', 0))


# ---------------------------------------------------------------- id tracking
class Tracker:
    """Keeps the last sighting of every piece id; count>1 roles get stable ids by nearest neighbour."""

    NEAR_MM = 45        # a detection this close to a piece's last position is that piece
    JUMP_FRAMES = 20    # a far-away detection must repeat this many frames (~1 s) before the piece moves there
    STALE_S = 2.0       # ...unless the piece hasn't been seen for this long (it was picked up and put down)
    # Stillness lock: the published position only moves when the (smoothed) detection leaves a deadband
    # around it. Moving pieces use a small band; once a piece has sat still STILL_S, the band widens so
    # detector jitter can't nudge it and the orbits on screen stop completely.
    SMOOTH = 0.3        # EMA weight of each new detection
    BAND_MOVING_MM = 2.0
    BAND_STILL_MM = 15.0
    STILL_S = 1.0       # still = the smoothed position has stayed within REST_MM of one spot this long
    REST_MM = 15.0

    def __init__(self, cfg):
        self.cfg = cfg
        self.pieces = {}    # id -> {role, x_mm, y_mm, u, v, conf, t}
        self.cand = {}      # id -> (x_mm, y_mm, frames) far-away detection waiting to be confirmed

    def ids_for(self, role):
        n = self.cfg['roles'][role]['count']
        return [role] if n == 1 else [f'{role}-{i + 1}' for i in range(n)]

    def update(self, role, dets, now):
        """dets: list of dicts with x_mm, y_mm, u, v, conf (more may be passed than count).
        Returns [(id, det)] for the detections kept (top `count` by confidence)."""
        ids = self.ids_for(role)
        if len(ids) == 1:
            return self._update_one(ids[0], role, dets, now)
        dets = sorted(dets, key=lambda d: -d['conf'])[:len(ids)]
        known = [i for i in ids if i in self.pieces]
        pairs = sorted((np.hypot(d['x_mm'] - self.pieces[i]['x_mm'], d['y_mm'] - self.pieces[i]['y_mm']), di, i)
                       for di, d in enumerate(dets) for i in known)
        used_d, used_i, out = set(), set(), []
        for _, di, i in pairs:
            if di in used_d or i in used_i:
                continue
            used_d.add(di); used_i.add(i); out.append((i, dets[di]))
        free = [i for i in ids if i not in self.pieces and i not in used_i]
        for di, d in enumerate(dets):
            if di not in used_d and free:
                out.append((free.pop(0), d))
        for i, d in out:
            self.pieces[i] = {'role': role, 'x_mm': d['x_mm'], 'y_mm': d['y_mm'], 'u': d['u'], 'v': d['v'],
                              'conf': d['conf'], 't': now}
        return out

    def _update_one(self, i, role, dets, now):
        """Single-piece role: stick to the detection nearest the last position; only jump to a far one
        that keeps showing up (a stray false detection, e.g. of the page's own graphics, never wins)."""
        if not dets:
            return []
        cur = self.pieces.get(i)
        dist = (lambda d: np.hypot(d['x_mm'] - cur['x_mm'], d['y_mm'] - cur['y_mm'])) if cur else None
        if cur is None or now - cur['t'] > self.STALE_S:
            d = max(dets, key=lambda d: d['conf'])
        else:
            near = [d for d in dets if dist(d) < self.NEAR_MM]
            if near:
                d = min(near, key=dist)
                self.cand.pop(i, None)
            else:
                far = max(dets, key=lambda d: d['conf'])
                cx, cy, n = self.cand.get(i, (far['x_mm'], far['y_mm'], 0))
                n = n + 1 if np.hypot(far['x_mm'] - cx, far['y_mm'] - cy) < self.NEAR_MM else 1
                self.cand[i] = (far['x_mm'], far['y_mm'], n)
                if n < self.JUMP_FRAMES:
                    return []
                d = far
                self.cand.pop(i, None)
        prev = self.pieces.get(i)
        if prev is None or now - prev['t'] > self.STALE_S or 'ex' not in prev or \
                np.hypot(d['x_mm'] - prev['x_mm'], d['y_mm'] - prev['y_mm']) >= self.NEAR_MM:
            ex, ey = ax, ay = d['x_mm'], d['y_mm']                                       # new or relocated
            rest = (ex, ey, now)
        else:
            ex = prev['ex'] + self.SMOOTH * (d['x_mm'] - prev['ex'])
            ey = prev['ey'] + self.SMOOTH * (d['y_mm'] - prev['ey'])
            ax, ay, rest = prev['x_mm'], prev['y_mm'], prev['rest']
            if np.hypot(ex - rest[0], ey - rest[1]) > self.REST_MM:
                rest = (ex, ey, now)                                                      # it's moving
            band = self.BAND_STILL_MM if now - rest[2] > self.STILL_S else self.BAND_MOVING_MM
            if np.hypot(ex - ax, ey - ay) > band:
                ax, ay = ex, ey
        self.pieces[i] = {'role': role, 'x_mm': ax, 'y_mm': ay, 'ex': ex, 'ey': ey, 'rest': rest,
                          'u': d['u'], 'v': d['v'], 'conf': d['conf'], 't': now}
        return [(i, d)]

    def expire(self, now):
        for i in [i for i, p in self.pieces.items() if now - p['t'] > DROP_AFTER]:
            del self.pieces[i]

    def feed(self, now):
        return {i: {'role': p['role'], 'x_mm': round(p['x_mm'], 1), 'y_mm': round(p['y_mm'], 1),
                    'u': round(p['u'], 4), 'v': round(p['v'], 4), 'conf': round(p['conf'], 2),
                    'seen_ago': round(now - p['t'], 2)} for i, p in self.pieces.items()}


# ---------------------------------------------------------------- aruco calibration
def marker_png(mid, px=600):
    """Marker image. Choice: exactly the black square (no white border); the page adds the quiet border."""
    img = cv2.aruco.generateImageMarker(cv2.aruco.getPredefinedDictionary(ARUCO_DICT), int(mid), px)
    ok, buf = cv2.imencode('.png', img)
    return buf.tobytes()


def make_detector():
    return cv2.aruco.ArucoDetector(cv2.aruco.getPredefinedDictionary(ARUCO_DICT), cv2.aruco.DetectorParameters())


def detect_markers(detector, img):
    """-> {id: 4x2 float array of corners TL,TR,BR,BL in camera px}"""
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
    corners, ids, _ = detector.detectMarkers(gray)
    if ids is None:
        return {}
    return {int(i): c.reshape(4, 2) for i, c in zip(ids.flatten(), corners)}


def marker_corners_mm(m):
    cx, cy, s = float(m['x_mm']), float(m['y_mm']), float(m['size_mm']) / 2
    return np.array([[cx - s, cy - s], [cx + s, cy - s], [cx + s, cy + s], [cx - s, cy + s]])


def compute_calibration(layout, found):
    """layout: [{id, x_mm, y_mm, size_mm}], found: {id: 4x2 px corners}.
    -> (H camera px -> mm, rms_mm over all corners, n_markers) or raises ValueError."""
    src, dst, n = [], [], 0
    for m in layout:
        if int(m['id']) in found:
            src.append(found[int(m['id'])]); dst.append(marker_corners_mm(m)); n += 1
    if n < 3:
        raise ValueError(f'only {n} markers found, need at least 3')
    src = np.concatenate(src).astype(np.float64); dst = np.concatenate(dst).astype(np.float64)
    H, _ = cv2.findHomography(src, dst, cv2.RANSAC, 5.0)
    if H is None:
        raise ValueError('homography failed')
    proj = cv2.perspectiveTransform(src.reshape(-1, 1, 2), H).reshape(-1, 2)
    return H, float(np.sqrt(np.mean(np.sum((proj - dst) ** 2, axis=1)))), n


def compute_point_calibration(points, frame_wh, cfg):
    """Manual calibration from pieces stood on known screen points (when the camera can't see the screen, e.g. under
    the polarizer). points: [{u, v, x_mm, y_mm, role}]. The camera sees the piece's top, so each target is first moved
    out from the nadir by the parallax factor; the nadir comes from the fit itself, so iterate.
    -> (H camera px -> glass mm, rms_mm after parallax correction) or raises ValueError."""
    if len(points) < 4:
        raise ValueError(f'need at least 4 points, got {len(points)}')
    fw, fh = frame_wh
    cam_h = cfg['camera_height_mm']
    src = np.array([[p['u'] * fw, p['v'] * fh] for p in points], dtype=np.float64)
    dst = np.array([[p['x_mm'], p['y_mm']] for p in points], dtype=np.float64)
    k = np.array([(cam_h - cfg['roles'].get(p.get('role', ''), {}).get('height_mm', 0)) / cam_h for p in points])
    nadir = dst.mean(axis=0)
    for _ in range(20):
        seen = nadir + (dst - nadir) / k[:, None]            # where each piece's top appears on the glass plane
        H, _ = cv2.findHomography(src, seen, 0)
        if H is None:
            raise ValueError('homography failed')
        nadir = np.array(apply_h(H, fw / 2, fh / 2))
    pred = np.array([parallax_correct(apply_h(H, x, y), nadir, cam_h, cam_h * (1 - kk)) for (x, y), kk in zip(src, k)])
    return H, float(np.sqrt(np.mean(np.sum((pred - dst) ** 2, axis=1))))


def corner_calibration(corners, bezel, screen_mm):
    """Manual calibration from four clicked camera-px points, in screen order TL, TR, BR, BL (screen top = far from the
    logo edge). bezel {side, top, bottom} mm: the points are the TV body's outer corners that far outside the screen
    (all 0 = the screen's own corners). -> H camera px -> screen mm."""
    W, Hh = screen_mm
    sd, tp, bt = (float(bezel.get(k, 0)) for k in ('side', 'top', 'bottom'))
    mm = np.float32([[-sd, -tp], [W + sd, -tp], [W + sd, Hh + bt], [-sd, Hh + bt]])
    return cv2.getPerspectiveTransform(np.float32(corners).reshape(4, 2), mm)


def save_calib(H, screen_mm, path=None):
    Path(path or CALIB_JSON).write_text(json.dumps({'H': np.asarray(H).tolist(), 'screen_mm': screen_mm, 't': time.time()}))


class CalibRequest:
    """Posted by the HTTP thread, serviced by the main loop (which owns the camera)."""

    def __init__(self, layout, window=CALIB_WINDOW):
        self.layout, self.deadline = layout, time.time() + window
        self.found, self.done, self.result = {}, threading.Event(), None

    def feed_frame(self, detector, frame, cfg):
        """Called by the main loop per frame. Returns True when finished (result set, done signalled)."""
        want = {int(m['id']) for m in self.layout}
        for i, c in detect_markers(detector, frame).items():
            if i in want:
                self.found[i] = c
        if len(self.found) < len(want) and time.time() < self.deadline:
            return False
        try:
            H, rms, n = compute_calibration(self.layout, self.found)
            save_calib(H, cfg['screen_mm'])
            with lock:
                state['H'] = H
            self.result = {'ok': True, 'markers_found': n, 'rms_mm': round(rms, 2)}
        except ValueError as e:
            self.result = {'ok': False, 'error': str(e), 'markers_found': len(self.found)}
        self.done.set()
        return True


# ---------------------------------------------------------------- http
def snapshot():
    now = time.time()
    with lock:
        cfg, trk = state['cfg'], state['tracker']
        return {'t': now, 'fps': round(state['fps'], 1), 'calibrated': state['H'] is not None,
                'screen_mm': cfg['screen_mm'], 'pieces': trk.feed(now),
                'rec': state['rec'].status() if state.get('rec') else None}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, body, ctype, code=200):
        self.send_response(code)
        self.send_header('Content-Type', ctype); self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body))); self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split('?')[0]
        try:
            if path == '/events':
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream'); self.send_header('Cache-Control', 'no-store')
                self.end_headers()
                while True:
                    self.wfile.write(f'data: {json.dumps(snapshot())}\n\n'.encode()); self.wfile.flush()
                    time.sleep(1 / 30)
            elif path == '/record':
                q = dict(kv.split('=', 1) for kv in self.path.partition('?')[2].split('&') if '=' in kv)
                with lock:
                    if state.get('rec') and state['rec'].status()['recording']:
                        res = {'ok': False, 'error': 'already recording', **state['rec'].status()}
                    else:
                        state['rec'] = Recorder(state['grab'], float(q.get('min', 10)))
                        res = {'ok': True, **state['rec'].status()}
                self._send(json.dumps(res).encode(), 'application/json')
            elif path == '/record/stop':
                if state.get('rec'):
                    state['rec'].stop = True
                self._send(json.dumps({'ok': True}).encode(), 'application/json')
            elif path == '/frame.jpg':          # newest raw camera frame, full size, no overlays (calib-click.html)
                f = state['grab'].frame if state.get('grab') else None
                if f is None:
                    return self.send_error(503, 'no camera frame yet')
                self._send(cv2.imencode('.jpg', f, [cv2.IMWRITE_JPEG_QUALITY, 85])[1].tobytes(), 'image/jpeg')
            elif path == '/calib.json':         # current calibration, for the click page to start from
                self._send(json.dumps({'H': None if state['H'] is None else np.asarray(state['H']).tolist(),
                                       'screen_mm': state['cfg']['screen_mm'], 'frame_wh': state.get('frame_wh')}).encode(),
                           'application/json')
            elif path == '/snapshot.jpg':
                self._send(state.get('snap') or b'', 'image/jpeg')
            elif path in ('/', '/index.html'):
                self._send((WEB / 'index.html').read_bytes(), 'text/html; charset=utf-8')
            elif re.fullmatch(r'/[\w-]+\.html', path) and (WEB / path[1:]).is_file():
                self._send((WEB / path[1:]).read_bytes(), 'text/html; charset=utf-8')
            elif re.fullmatch(r'/marker/\d+\.png', path):
                self._send(marker_png(int(path[8:-4])), 'image/png')
            elif (f := static_file(path)):   # the pages' scripts, styles, fonts and sky tiles (demo.html needs them)
                self._send(f.read_bytes(), STATIC_TYPES[f.suffix.lower()])
            else:
                self.send_error(404)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass

    def do_POST(self):
        try:
            if self.path.split('?')[0] == '/calibrate_corners':  # manual: corners dragged on the camera image
                try:
                    body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')
                    H = corner_calibration(body['corners'], body.get('bezel', {}), state['cfg']['screen_mm'])
                    save_calib(H, state['cfg']['screen_mm'])
                    with lock:
                        state['H'] = H
                    res = {'ok': True}
                except Exception as e:
                    res = {'ok': False, 'error': str(e)}
                return self._send(json.dumps(res).encode(), 'application/json')
            if self.path.split('?')[0] == '/calibrate_points':   # manual: pieces on known points (calib-points.html)
                try:
                    pts = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')['points']
                    H, rms = compute_point_calibration(pts, state['frame_wh'], state['cfg'])
                    save_calib(H, state['cfg']['screen_mm'])
                    with lock:
                        state['H'] = H
                    res = {'ok': True, 'points': len(pts), 'rms_mm': round(rms, 2)}
                except Exception as e:
                    res = {'ok': False, 'error': str(e)}
                return self._send(json.dumps(res).encode(), 'application/json')
            if self.path.split('?')[0] != '/calibrate':
                return self.send_error(404)
            try:
                body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')
                layout = body['markers']
                assert layout and all({'id', 'x_mm', 'y_mm', 'size_mm'} <= set(m) for m in layout)
            except Exception:
                return self._send(json.dumps({'ok': False, 'error': 'bad request: need {"markers": [...]}'}).encode(),
                                  'application/json', 400)
            req = CalibRequest(layout)
            with lock:
                busy = state['pending'] is not None
                if not busy:
                    state['pending'] = req
            if busy:
                res = {'ok': False, 'error': 'calibration already in progress'}
            elif req.done.wait(CALIB_WINDOW + 5):
                res = req.result
            else:
                with lock:
                    state['pending'] = None
                res = {'ok': False, 'error': 'detector not producing frames'}
            self._send(json.dumps(res).encode(), 'application/json')
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass


STATIC_TYPES = {'.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
                '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff',
                '.otf': 'font/otf', '.ttf': 'font/ttf', '.svg': 'image/svg+xml'}


def static_file(path):
    """A file under orbit3d/ with a known type, or None (no escaping the folder)."""
    try:
        f = (WEB / path.lstrip('/')).resolve()
        return f if f.is_file() and f.suffix.lower() in STATIC_TYPES and f.is_relative_to(WEB.resolve()) else None
    except (OSError, ValueError):
        return None


def serve(port):
    srv = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()


def on_screen(x_mm, y_mm, cfg, margin=25):
    """Pieces stand on the screen; anything mapped well outside it is something else in the room."""
    W_, H_ = cfg['screen_mm']
    return -margin <= x_mm <= W_ + margin and -margin <= y_mm <= H_ + margin


def find_camera(name='iphone'):
    """OpenCV index of the camera whose name contains `name`. OpenCV's AVFoundation backend numbers cameras
    in uniqueID order, so list them the same way and match by name."""
    import AVFoundation as AV
    devs = sorted(AV.AVCaptureDevice.devicesWithMediaType_(AV.AVMediaTypeVideo), key=lambda d: d.uniqueID())
    for i, d in enumerate(devs):
        if name.lower() in d.localizedName().lower():
            return i, d.localizedName()
    found = ', '.join(d.localizedName() for d in devs)
    raise SystemExit(f'no camera matching "{name}" (found: {found}). iPhone: nearby, unlocked once, same Apple ID?')


class Recorder:
    """Writes every new camera frame to an .mp4 on its own thread, for a fixed time (training video)."""
    def __init__(self, grab, minutes, fps=30):
        f = grab.frame
        self.path = HERE / 'videos' / f'rec_{time.strftime("%Y%m%d-%H%M%S")}.mp4'
        self.path.parent.mkdir(exist_ok=True)
        self.out = cv2.VideoWriter(str(self.path), cv2.VideoWriter_fourcc(*'avc1'), fps, (f.shape[1], f.shape[0]))
        self.grab, self.t0, self.end, self.n, self.stop = grab, time.time(), time.time() + 60 * minutes, 0, False
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self):
        seq = 0
        while not self.stop and time.time() < self.end:
            seq, f = self.grab.next(seq)
            if f is not None:
                self.out.write(f); self.n += 1
        self.out.release()
        print(f'recording done: {self.path.name}, {self.n} frames in {time.time() - self.t0:.0f} s', flush=True)

    def status(self):
        live = not self.stop and time.time() < self.end
        return {'file': self.path.name, 'frames': self.n, 'recording': live,
                'left_s': round(max(0, self.end - time.time())) if live else 0}


class LatestFrame:
    """Reads the camera on its own thread and keeps only the newest frame, so inference never waits
    on capture and never works on a stale, queued frame."""
    def __init__(self, cap):
        self.cap, self.frame, self.seq = cap, None, 0
        self.cv = threading.Condition()
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self):
        while True:
            ok, f = self.cap.read()
            if ok:
                with self.cv:
                    self.frame, self.seq = f, self.seq + 1
                    self.cv.notify_all()

    def next(self, after):
        """Newest frame with seq > after (waits for one)."""
        with self.cv:
            self.cv.wait_for(lambda: self.seq > after, timeout=1.0)
            return self.seq, self.frame


def main():
    ap = argparse.ArgumentParser()
    run = HERE / 'runs/tv-sam-yolo11s-960/weights'          # printed pieces, SAM 2 labels (GCP, Oct 5)
    ml = run / 'best.mlpackage'                               # Core ML export, if present
    ap.add_argument('--weights', default=str(ml if ml.exists() else run / 'best.pt'))
    ap.add_argument('--index', type=int, help='OpenCV camera index (default: find --camera by name)')
    ap.add_argument('--camera', default='iphone', help='camera name to look for, e.g. arducam')
    ap.add_argument('--size', default='1920x1080', help='capture size WxH (Arducam: 2048x1536 at 30 fps)')
    ap.add_argument("--conf", type=float, default=0.15)   # low is fine: the tracker ignores one-off far detections
    ap.add_argument('--imgsz', type=int, default=960)
    ap.add_argument('--port', type=int, default=8780)
    ap.add_argument('--no-browser', action='store_true')
    ap.add_argument('--no-window', action='store_true', help='no OpenCV preview (headless)')
    a = ap.parse_args()
    from ultralytics import YOLO
    cfg = load_config()
    state['cfg'] = cfg; state['H'] = load_calib(); state['tracker'] = Tracker(cfg)
    trk, detector = state['tracker'], make_detector()
    serve(a.port)

    idx, name = (a.index, f'camera {a.index}') if a.index is not None else find_camera(a.camera)
    dev = f'camera {idx} ({name})'
    cw, ch = map(int, a.size.lower().split('x'))
    cap = cv2.VideoCapture(idx, cv2.CAP_AVFOUNDATION)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, cw); cap.set(cv2.CAP_PROP_FRAME_HEIGHT, ch)
    if not cap.isOpened():
        raise SystemExit(f'could not open {dev}')
    model = YOLO(a.weights, task='detect')
    dev_kw = {} if a.weights.endswith('.mlpackage') else {'device': 'mps'}
    grab = state['grab'] = LatestFrame(cap)
    seq = 0
    print(f'{dev} -> {a.weights}   (q quit, s save frame)   calibrated: {state["H"] is not None}   '
          f'orbit demo: http://localhost:{a.port}')
    if not a.no_browser:
        webbrowser.open(f'http://localhost:{a.port}')

    fps, last, ms, shown, snapped = 0.0, time.time(), 0.0, 0.0, 0.0
    while True:
        seq, frame = grab.next(seq)
        if frame is None:
            continue
        req = state['pending']
        if req is not None and req.feed_frame(detector, frame, cfg):
            with lock:
                state['pending'] = None
        t0 = time.time()
        r = model.predict(frame, imgsz=a.imgsz, conf=a.conf, agnostic_nms=True, verbose=False, **dev_kw)[0]   # one class per object
        ms = 0.9 * ms + 0.1 * (time.time() - t0) * 1000
        fh, fw = frame.shape[:2]
        state['frame_wh'] = (fw, fh)
        Hm = state['H']
        per_role, raw = {}, []
        for (x1, y1, x2, y2), c, s in zip(r.boxes.xyxy.tolist(), r.boxes.cls.int().tolist(), r.boxes.conf.tolist()):
            role = cfg['map'].get(r.names[c], r.names[c])
            if role not in cfg['roles']:
                continue
            u, v = (x1 + x2) / 2 / fw, (y1 + y2) / 2 / fh
            x_mm, y_mm = to_screen(u, v, (fw, fh), cfg, role, Hm)
            if Hm is not None and not on_screen(x_mm, y_mm, cfg):
                raw.append(((int(x1), int(y1), int(x2), int(y2)), f'{role} {s:.2f} off-screen', (90, 90, 90)))
                continue
            raw.append(((int(x1), int(y1), int(x2), int(y2)), f'{role} {s:.2f}', COLORS.get(role, (255, 255, 255))))
            per_role.setdefault(role, []).append({'x_mm': x_mm, 'y_mm': y_mm, 'u': u, 'v': v, 'conf': s,
                                                  'box': (int(x1), int(y1), int(x2), int(y2))})
        now = time.time()
        kept = []
        with lock:
            for role, dets in per_role.items():
                kept += [(i, role, d) for i, d in trk.update(role, dets, now)]
            trk.expire(now)
        fps = 0.9 * fps + 0.1 / max(1e-3, now - last); last = now
        state['fps'] = fps
        if now - snapped > .5:             # /snapshot.jpg: what the camera sees + every raw detection
            snapped = now
            snap = frame.copy()
            if Hm is not None:             # outline of the screen, from the calibration
                Hinv = np.linalg.inv(np.array(Hm, dtype=float))
                W_, H_ = cfg['screen_mm']
                quad = cv2.perspectiveTransform(np.float32([[[0, 0], [W_, 0], [W_, H_], [0, H_]]]), Hinv)[0]
                cv2.polylines(snap, [quad.astype(np.int32)], True, (0, 255, 0), 3)
            for (x1, y1, x2, y2), txt, col in raw:
                cv2.rectangle(snap, (x1, y1), (x2, y2), col, 4)
                cv2.putText(snap, txt, (x1, max(30, y1 - 12)), cv2.FONT_HERSHEY_SIMPLEX, 1.2, col, 3)
            state['snap'] = cv2.imencode('.jpg', cv2.resize(snap, (1280, 1280 * fh // fw)), [cv2.IMWRITE_JPEG_QUALITY, 80])[1].tobytes()
        if a.no_window:
            continue
        if now - shown < 1 / 8:            # the preview is for setup; redrawing it every frame costs ~6 fps
            if cv2.waitKey(1) & 0xFF == ord('q'):
                break
            continue
        shown = now
        view = frame.copy()
        for pid, role, d in kept:
            x1, y1, x2, y2 = d['box']; col = COLORS.get(role, (255, 255, 255))
            cv2.rectangle(view, (x1, y1), (x2, y2), col, 4)
            cv2.circle(view, ((x1 + x2) // 2, (y1 + y2) // 2), 6, col, -1)
            cv2.putText(view, f'{pid} {d["conf"]:.2f}', (x1, max(30, y1 - 12)), cv2.FONT_HERSHEY_SIMPLEX, 1.3, col, 3)
        tag = 'calibrated' if Hm is not None else 'UNCALIBRATED'
        cv2.putText(view, f'{fps:4.1f} fps  model {ms:4.0f} ms  {tag}', (20, 50), cv2.FONT_HERSHEY_SIMPLEX, 1.4, (255, 0, 255), 3)
        cv2.imshow('pieces', cv2.resize(view, (1280, 1280 * fh // fw)))
        k = cv2.waitKey(1) & 0xFF
        if k == ord('q'):
            break
        if k == ord('s'):
            p = HERE / 'data/raw' / f'live_{time.strftime("%Y%m%d-%H%M%S")}.jpg'
            cv2.imwrite(str(p), frame, [cv2.IMWRITE_JPEG_QUALITY, 95]); print('saved', p.name)


if __name__ == '__main__':
    main()
