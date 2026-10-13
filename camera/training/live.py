"""Run the trained detector live on a camera (iPhone by default) and feed the orbit3d pages.

  python live.py [--weights runs/yolo11s-960/weights/best.pt] [--camera arducam --size 2048x1536] [--index N]
                 [--conf 0.4] [--port 8780] [--no-window] [--idle-hz 5]

Once calibrated the model only sees the screen (screen_crop). While nothing on the table moves it runs --idle-hz
times a second, back to full speed as soon as a piece moves or a hand comes in (keeps laptops cool, Oct 12).
Fastest on each laptop: export.py writes best.mlpackage (Mac, Neural Engine) and best.onnx (Windows, DirectML).

Recording training video while the page runs: GET /record?min=10 starts, /record/stop stops (files in videos/);
record-guide.html walks through a shot list and POSTs /record/log (step times, saved as videos/<rec>.steps.json).
A day of passive collection: GET /record?min=1440&active=1 (only while hands or pieces move, 10 fps, 15 min files).

Keys: q quits, s saves the current frame to data/raw (to add to training later).
Contract with the pages (pieces.json, /events, /calibrate, /marker/<id>.png): ../orbit3d/FEED.md.
Everything outside main() is importable without a camera (see test_live.py).
"""
import argparse, json, math, os, re, sys, threading, time, webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

if sys.platform == 'win32':
    # Before torch loads (ultralytics, in main): its OpenMP workers otherwise spin for a while after every small CPU op
    # of predict()'s pre/postprocessing, keeping all 8 cores busy, and on the ThinkPad's APU (CPU and Radeon share one
    # power budget and memory bus) that slowed the DirectML model from 33 to 95 ms a frame. Sleeping workers: no cost.
    os.environ.setdefault('OMP_WAIT_POLICY', 'PASSIVE')

import cv2
import numpy as np

from colorcheck import ROLES as COLOUR_ROLES, colour_scores
from tracker import Tracker as PieceTracker   # the live tracker (rules: tracker.py); Tracker below is the earlier one (replay.py compares)

HERE = Path(__file__).parent
WEB = HERE.parent / 'orbit3d'
PIECES_JSON = HERE / 'pieces.json'
CALIB_JSON = HERE / 'calib.json'
TUNING_JSON = HERE / 'tuning.json'
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


def load_calib(path=None, frame_wh=None):
    """H (camera px -> screen mm) for frames of frame_wh. A calibration saved at another capture size (its 'frame_wh')
    is rescaled, so e.g. the ThinkPad can capture 1280x960 with a calibration made at 2048x1536 (same field of view).
    Files without 'frame_wh' (older ones) are used as they are."""
    try:
        c = json.loads(Path(path or CALIB_JSON).read_text())
        H = np.array(c['H'], dtype=np.float64).reshape(3, 3)
    except (OSError, ValueError, KeyError):
        return None
    if frame_wh and c.get('frame_wh') and tuple(c['frame_wh']) != tuple(frame_wh):
        H = H @ np.diag([c['frame_wh'][0] / frame_wh[0], c['frame_wh'][1] / frame_wh[1], 1.0])
    return H


def apply_h(H, x, y):
    """Camera px -> screen mm through a 3x3 homography."""
    p = H @ np.array([x, y, 1.0])
    return float(p[0] / p[2]), float(p[1] / p[2])


def parallax_correct(p, nadir, cam_h, h):
    """A model top h mm above the glass seen at screen point p is really at N + (p-N)*(H-h)/H."""
    k = (cam_h - h) / cam_h
    return nadir[0] + (p[0] - nadir[0]) * k, nadir[1] + (p[1] - nadir[1]) * k


def box_size_mm(box, frame_wh, H):
    """Diagonal of a camera-pixel box on the screen plane (mm); None when uncalibrated."""
    if H is None:
        return None
    x1, y1, x2, y2 = box
    a, b = apply_h(H, x1, y1), apply_h(H, x2, y2)
    return float(np.hypot(b[0] - a[0], b[1] - a[1]))


PERSON_CONF = 0.4        # person outlines used for fingertips
ENTRY_MM = 50            # the arm's way in: its outline within this band outside the screen (inside the crop, CROP_MM)


def fingertips(polys, H, screen_mm):
    """Person outlines (camera px polygons) -> fingertip points on the screen (mm): for every outline that reaches onto
    the screen, the point on the screen farthest from where the arm comes in (the outline just outside the screen edge,
    else all of it off the screen, else the outline's centre). Hands touch the glass, so no parallax correction.
    Only the band next to the screen sets the anchor, so the screen crop (CROP_MM) gives the same tips as a full frame."""
    W, Hh = screen_mm
    out = []
    for poly in polys:
        if poly is None or len(poly) < 3:
            continue
        mm = cv2.perspectiveTransform(np.float32(poly).reshape(-1, 1, 2), np.asarray(H, np.float64)).reshape(-1, 2)
        inside = (mm[:, 0] >= 0) & (mm[:, 0] <= W) & (mm[:, 1] >= 0) & (mm[:, 1] <= Hh)
        if not inside.any():
            continue
        b = ENTRY_MM
        entry = ~inside & (mm[:, 0] >= -b) & (mm[:, 0] <= W + b) & (mm[:, 1] >= -b) & (mm[:, 1] <= Hh + b)
        anchor = mm[entry].mean(0) if entry.any() else mm[~inside].mean(0) if (~inside).any() else mm.mean(0)
        pts = mm[inside]
        tip = pts[np.argmax(np.hypot(pts[:, 0] - anchor[0], pts[:, 1] - anchor[1]))]
        out.append({'x_mm': round(float(tip[0]), 1), 'y_mm': round(float(tip[1]), 1)})
    return out


def polys_to_mm(polys, H, tol=3.0):
    """Person outlines (camera px polygons) -> simplified polygons on the screen plane (mm), for the tracker's hand gate."""
    out = []
    for poly in polys:
        if poly is None or len(poly) < 3:
            continue
        mm = cv2.perspectiveTransform(np.float32(poly).reshape(-1, 1, 2), np.asarray(H, np.float64))
        out.append(cv2.approxPolyDP(mm, tol, True).reshape(-1, 2))
    return out


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
    JUMP_FRAMES = 1     # a far-away detection must repeat this many frames before the piece moves there (tune.html, Oct 7)
    STALE_S = 2.0       # ...unless the piece hasn't been seen for this long (it was picked up and put down)
    # Stillness lock: the published position only moves when the (smoothed) detection leaves a deadband
    # around it. Moving pieces use a small band; once a piece has sat still STILL_S, the band widens so
    # detector jitter can't nudge it and the orbits on screen stop completely.
    SMOOTH = 1.0        # EMA weight of each new detection (1 = none here; demo.html eases instead, PAGE_TAU_S)
    BAND_MOVING_MM = 0.0
    BAND_STILL_MM = 5.0
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


# ---------------------------------------------------------------- live tuning (tune.html)
# Jitter vs. responsiveness knobs, changed while running via GET/POST /tuning and kept in tuning.json:
# the Tracker constants above, the detector's confidence threshold, and the pages' easing time (sent in /events).
TRACKER_KNOBS = ('SMOOTH', 'BAND_MOVING_MM', 'BAND_STILL_MM', 'STILL_S', 'REST_MM',      # tracker.py
                 'GATE_MM', 'VMAX_MM_S', 'ROLE_PENALTY_MM', 'CONF_NEW', 'CONFIRM_FRAMES', 'RELOCATE_S', 'EDGE_MM', 'LEAVE_S', 'HOLD_S',
                 'UNLOCK_FRAMES', 'UNLOCK_S', 'HAND_NEAR_MM', 'HAND_PUSH_MM', 'HAND_PUSH_S', 'HAND_PUSH_FRAMES', 'HAND_HOLD_MM', 'HAND_RELOC_S',
                 'HAND_CAND_MM')
PAGE_TAU_S = 0.35        # demo.html eases each still piece toward the feed with this time constant...
PAGE_TAU_MOVE_S = 0.6    # ...and a moving one with this (tune.html, Oct 9)
PAGE_LEAD_S = 0.6        # a moving piece is drawn this far ahead along its velocity (tune.html, Oct 9; cancels the moving easing's lag)
PAGE_KNOBS = {'page_tau_s': PAGE_TAU_S, 'page_tau_move_s': PAGE_TAU_MOVE_S, 'page_lead_s': PAGE_LEAD_S}


def default_tuning(conf):
    return {**{k: getattr(PieceTracker, k) for k in TRACKER_KNOBS}, 'conf': conf, **PAGE_KNOBS}


def set_tuning(changes, save=True):
    """Apply {knob: value} (unknown knobs ignored) to the running tracker; -> the full current tuning."""
    with lock:
        t = state['tune']
        for k, v in changes.items():
            if k in t:
                t[k] = int(round(float(v))) if isinstance(state['tune_default'][k], int) else float(v)
        for k in TRACKER_KNOBS:
            setattr(state['tracker'], k, t[k])
        if save:
            TUNING_JSON.write_text(json.dumps(t, indent=1))
        return dict(t)


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


def save_calib(H, screen_mm, path=None, frame_wh=None):
    c = {'H': np.asarray(H).tolist(), 'screen_mm': screen_mm, 't': time.time()}
    if frame_wh:
        c['frame_wh'] = [int(frame_wh[0]), int(frame_wh[1])]   # the capture size H is in (load_calib rescales)
    Path(path or CALIB_JSON).write_text(json.dumps(c))


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
            save_calib(H, cfg['screen_mm'], frame_wh=(frame.shape[1], frame.shape[0]))
            with lock:
                state['H'] = H
            self.result = {'ok': True, 'markers_found': n, 'rms_mm': round(rms, 2)}
        except ValueError as e:
            self.result = {'ok': False, 'error': str(e), 'markers_found': len(self.found)}
        self.done.set()
        return True


# ---------------------------------------------------------------- show state
# The presenter's controls (presenter.html, or keys on the TV page): one object, broadcast in every /events message.
# Kept in memory and in show.json (gitignored) so a restart of live.py keeps the mode. Contract: NIGHT-AGENTS.md.
SHOW_JSON = HERE / 'show.json'
SHOW_DEFAULT = {'mode': 'geo', 'scale': 'show', 'freeze': False, 'sky': 'still', 'reset': 0, 'mode_opts': {}}
SHOW_CHOICES = {'mode': ('geo', 'capture', 'dro', 'competitor'), 'scale': ('show', 'true'), 'sky': ('still', 'slow', 'off')}
show = json.loads(json.dumps(SHOW_DEFAULT))
show_lock = threading.Lock()


def show_load():
    try:
        saved = json.loads(SHOW_JSON.read_text())
        show_update({k: v for k, v in saved.items() if k != 'reset'}, save=False)   # a restart is not a reset
        show['reset'] = int(saved.get('reset', 0))
    except (OSError, ValueError, AttributeError):
        pass


def show_update(patch, save=True):
    """Merge a partial update (bad values are ignored; reset: true bumps the counter; mode_opts merge per mode); returns the state."""
    with show_lock:
        for k, ok in SHOW_CHOICES.items():
            if patch.get(k) in ok:
                show[k] = patch[k]
        if isinstance(patch.get('freeze'), bool):
            show['freeze'] = patch['freeze']
        if patch.get('reset') is True:
            show['reset'] += 1
        if isinstance(patch.get('mode_opts'), dict):
            for m, o in patch['mode_opts'].items():
                if isinstance(o, dict):
                    show['mode_opts'][m] = {**show['mode_opts'].get(m, {}), **o}
        out = json.loads(json.dumps(show))
    if save:
        try:
            SHOW_JSON.write_text(json.dumps(out))
        except OSError:
            pass
    return out


def show_get():
    with show_lock:
        return json.loads(json.dumps(show))


# ---------------------------------------------------------------- http
def snapshot():
    now = time.time()
    with lock:
        cfg, trk = state['cfg'], state['tracker']
        return {'t': now, 'fps': round(state['fps'], 1), 'model_ms': round(state.get('model_ms', 0)), 'model_parts': state.get('model_parts'), 'backend': state.get('backend'),
                'idle': state.get('idle', False), 'calibrated': state['H'] is not None,
                'screen_mm': cfg['screen_mm'], 'pieces': trk.feed(now), 'hands': state.get('hands', []),
                'rec': state['rec'].status() if state.get('rec') else None, 'show': show_get(),
                **{k: state.get('tune', {}).get(k, v) for k, v in PAGE_KNOBS.items()}}


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
            elif path == '/show':
                self._send(json.dumps(show_get()).encode(), 'application/json')
            elif path == '/record':
                q = dict(kv.split('=', 1) for kv in self.path.partition('?')[2].split('&') if '=' in kv)
                with lock:
                    if state.get('rec') and state['rec'].status()['recording']:
                        res = {'ok': False, 'error': 'already recording', **state['rec'].status()}
                    else:
                        active = q.get('active') == '1'          # ?active=1: busy frames only, 10 fps, 15 min files
                        state['rec'] = Recorder(state['grab'], float(q.get('min', 10)),
                                                fps=float(q.get('fps', 10 if active else 30)), active=active)
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
            elif path == '/tuning':
                with lock:
                    res = {'values': dict(state['tune']), 'defaults': state['tune_default']}
                self._send(json.dumps(res).encode(), 'application/json')
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
            if self.path.split('?')[0] == '/show':               # presenter.html / demo.html keys: a partial update, merged
                try:
                    res = show_update(json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}'))
                except ValueError:
                    return self._send(b'{"error":"bad json"}', 'application/json', 400)
                return self._send(json.dumps(res).encode(), 'application/json')
            if self.path.split('?')[0] == '/record/log':         # record-guide.html: the shot list with each step's times
                try:
                    body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')
                    rec = state.get('rec')
                    name = (rec.path.stem if rec else time.strftime('rec_%Y%m%d-%H%M%S')) + '.steps.json'
                    (HERE / 'videos' / name).write_text(json.dumps(body, indent=1))
                    res = {'ok': True, 'file': name}
                except Exception as e:
                    res = {'ok': False, 'error': str(e)}
                return self._send(json.dumps(res).encode(), 'application/json')
            if self.path.split('?')[0] == '/tuning':             # tune.html: {knob: value, ...}
                try:
                    res = {'ok': True, 'values': set_tuning(json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}'))}
                except Exception as e:
                    res = {'ok': False, 'error': str(e)}
                return self._send(json.dumps(res).encode(), 'application/json')
            if self.path.split('?')[0] == '/calibrate_corners':  # manual: corners dragged on the camera image
                try:
                    body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')
                    H = corner_calibration(body['corners'], body.get('bezel', {}), state['cfg']['screen_mm'])
                    save_calib(H, state['cfg']['screen_mm'], frame_wh=state.get('frame_wh'))
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
                    save_calib(H, state['cfg']['screen_mm'], frame_wh=state.get('frame_wh'))
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


def serve(port, lan=True):
    # 0.0.0.0 by default: the presenter's tablet (presenter.html) is another device on the LAN. --local-only keeps it on
    # this machine. (Windows asks once to allow Python through the firewall; the POST routes are open to the LAN too.)
    srv = ThreadingHTTPServer(('0.0.0.0' if lan else '127.0.0.1', port), Handler)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()


def on_screen(x_mm, y_mm, cfg, margin=25):
    """Pieces stand on the screen; anything mapped well outside it is something else in the room."""
    W_, H_ = cfg['screen_mm']
    return -margin <= x_mm <= W_ + margin and -margin <= y_mm <= H_ + margin


CROP_MM = 60             # the model sees the screen plus this margin (pieces on the bezel, arms reaching in), not the room


def screen_crop(H, frame_wh, screen_mm, margin=CROP_MM):
    """Camera-px box (x0, y0, x1, y1) around the screen plus margin, from the calibration; the whole frame uncalibrated.
    The model then spends its time on the table rather than the floor around it (about 2.4x less work, Oct 12)."""
    fw, fh = frame_wh
    if H is None:
        return 0, 0, fw, fh
    W_, H_, m = *screen_mm, margin
    q = cv2.perspectiveTransform(np.float32([[[-m, -m], [W_ + m, -m], [W_ + m, H_ + m], [-m, H_ + m]]]),
                                 np.linalg.inv(np.asarray(H, np.float64)))[0]
    x0, y0 = max(0, int(q[:, 0].min())), max(0, int(q[:, 1].min()))
    x1, y1 = min(fw, int(np.ceil(q[:, 0].max()))), min(fh, int(np.ceil(q[:, 1].max())))
    return (x0, y0, x1, y1) if x1 - x0 > 64 and y1 - y0 > 64 else (0, 0, fw, fh)


def crop_imgsz(crop, frame_wh, imgsz):
    """Model input size for a crop at the pixels per mm the model was trained at (the whole frame at imgsz), rounded up
    to the stride."""
    x0, y0, x1, y1 = crop
    return math.ceil(imgsz * max(x1 - x0, y1 - y0) / max(frame_wh) / 32) * 32


def find_camera(name='iphone'):
    """OpenCV index of the camera whose name contains `name`. OpenCV's AVFoundation backend numbers cameras
    in uniqueID order, so list them the same way and match by name. Windows: DirectShow order, via pygrabber."""
    if sys.platform == 'win32':
        from pygrabber.dshow_graph import FilterGraph
        devs = FilterGraph().get_input_devices()
        for i, d in enumerate(devs):
            if name.lower() in d.lower():
                return i, d
        raise SystemExit(f'no camera matching "{name}" (found: {", ".join(devs)})')
    import AVFoundation as AV
    devs = sorted(AV.AVCaptureDevice.devicesWithMediaType_(AV.AVMediaTypeVideo), key=lambda d: d.uniqueID())
    for i, d in enumerate(devs):
        if name.lower() in d.localizedName().lower():
            return i, d.localizedName()
    found = ', '.join(d.localizedName() for d in devs)
    raise SystemExit(f'no camera matching "{name}" (found: {found}). iPhone: nearby, unlocked once, same Apple ID?')


class ChangeGate:
    """Passive recording keeps a frame only if the table area (screen_crop) visibly changed since the last frame kept:
    the share of pixels that moved by more than LEVEL grey levels, on a 320 px wide blurred copy, above SHARE. The
    tracker's 'busy' alone wasn't enough: at dusk the gain rose, the detections jittered and a still table was 'moving',
    and 12 of every 15 minutes got recorded. Measured on those files (Oct 12): consecutive frames of a still table
    0.000% (99th percentile), hands and moving pieces 0.5-1.8% (median); 0.3% splits them. prune.py uses it too."""
    LEVEL, SHARE = 20, 0.003

    def __init__(self, H=None):
        self.H, self.ref, self.crop = H, None, None

    def small(self, f):
        fh, fw = f.shape[:2]
        if self.crop is None or self.crop[0] != (fw, fh):
            mm = (state.get('cfg') or load_config())['screen_mm']
            self.crop = ((fw, fh), screen_crop(self.H, (fw, fh), mm) if self.H is not None else (0, 0, fw, fh))
        x0, y0, x1, y1 = self.crop[1]
        g = cv2.cvtColor(f[y0:y1, x0:x1], cv2.COLOR_BGR2GRAY)
        g = cv2.resize(g, (320, max(1, round(320 * (y1 - y0) / (x1 - x0)))), interpolation=cv2.INTER_AREA)
        return cv2.GaussianBlur(g, (5, 5), 0)

    def changed(self, f, H=None):
        """True (and f becomes the new reference) if f differs visibly from the last frame that passed."""
        if H is not None and H is not self.H:              # recalibrated: new crop, new reference
            self.H, self.ref, self.crop = H, None, None
        s = self.small(f)
        if self.ref is not None and s.shape == self.ref.shape and                 (cv2.absdiff(s, self.ref) > self.LEVEL).mean() <= self.SHARE:
            return False
        self.ref = s
        return True


class Recorder:
    """Writes new camera frames to a video (.mp4 H.264; Windows: .avi MJPEG on the CPU) on its own thread, for a fixed time (training video).

    Default: every frame, one file (record-guide.html's shot list). active=True (GET /record?active=1, for a day of
    passive collection): only frames while the table is busy (not state['idle']) and visibly changed (ChangeGate), at
    most `fps` a second, in SEGMENT_MIN files; a segment that caught nothing is deleted, so idle time costs no disk.
    Each kept segment gets <name>.json with the calibration it was shot under (for labelling)."""
    SEGMENT_MIN = 15

    def __init__(self, grab, minutes, fps=30, active=False):
        self.grab, self.fps, self.active = grab, fps, active
        self.t0, self.end, self.stop = time.time(), time.time() + 60 * minutes, False
        self.n, self.kept, self.dropped, self.out = 0, [], 0, None
        self.gate = ChangeGate()
        (HERE / 'videos').mkdir(exist_ok=True)
        self._open()
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _open(self):
        f = self.grab.frame
        size, name = (f.shape[1], f.shape[0]), f'rec_{time.strftime("%Y%m%d-%H%M%S")}'
        if sys.platform == 'win32':    # MJPEG .avi, encoded by OpenCV on the CPU: Windows' H.264 encoder runs on the GPU,
            self.path = HERE / 'videos' / f'{name}.avi'   # and when a GPU fault hung DirectML (Oct 12) it froze with it
            self.out = cv2.VideoWriter(str(self.path), cv2.CAP_OPENCV_MJPEG, cv2.VideoWriter_fourcc(*'MJPG'), self.fps, size)
            self.out.set(cv2.VIDEOWRITER_PROP_QUALITY, 90)
        else:
            self.path = HERE / 'videos' / f'{name}.mp4'
            self.out = cv2.VideoWriter(str(self.path), cv2.VideoWriter_fourcc(*'avc1'), self.fps, size)
        self.seg_t0, self.seg_n = time.time(), 0

    def _close(self):
        self.out.release()
        if self.seg_n == 0:                                    # nothing happened: no file
            self.path.unlink(missing_ok=True); self.dropped += 1
            return
        self.kept.append(self.path.name)
        if self.active:
            H = state.get('H')
            self.path.with_suffix('.json').write_text(json.dumps({
                'frames': self.seg_n, 'fps': self.fps, 'active_only': True, 'frame_wh': state.get('frame_wh'),
                'H': None if H is None else np.asarray(H).tolist(), 'screen_mm': state['cfg']['screen_mm'],
                'start': self.seg_t0, 'end': time.time()}))
        print(f'recording: kept {self.path.name}, {self.seg_n} frames', flush=True)

    def _run(self):
        seq, last = 0, 0.0
        while not self.stop and time.time() < self.end:
            seq, f = self.grab.next(seq)
            if f is None:
                continue
            now = time.time()
            if self.active:
                if now - self.seg_t0 > 60 * self.SEGMENT_MIN:
                    self._close(); self._open()
                if state.get('idle') or now - last < 1 / self.fps or not self.gate.changed(f, state.get('H')):
                    continue
                last = now
            self.out.write(f); self.n += 1; self.seg_n += 1
        self._close()
        print(f'recording done: {self.n} frames in {time.time() - self.t0:.0f} s, files {self.kept}', flush=True)

    def finish(self, timeout=5):
        """Stop and wait for the current file to be closed."""
        self.stop = True
        self.thread.join(timeout)

    def status(self):
        live = not self.stop and time.time() < self.end
        return {'file': self.path.name, 'frames': self.n, 'recording': live, 'active_only': self.active,
                'files_kept': len(self.kept) + (1 if live and self.seg_n else 0), 'segments_dropped': self.dropped,
                'left_s': round(max(0, self.end - time.time())) if live else 0}


class LatestFrame:
    """Reads the camera on its own thread and keeps only the newest frame, so inference never waits
    on capture and never works on a stale, queued frame."""
    def __init__(self, cap, exposure=None):
        self.cap, self.frame, self.seq, self.exposure = cap, None, 0, exposure   # exposure: FixedRateExposure (Windows)
        self.cv = threading.Condition()
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self):
        while True:
            ok, f = self.cap.read()
            if ok:
                if self.exposure:
                    self.exposure.step(f)
                with self.cv:
                    self.frame, self.seq = f, self.seq + 1
                    self.cv.notify_all()


    def next(self, after):
        """Newest frame with seq > after (waits for one)."""
        with self.cv:
            self.cv.wait_for(lambda: self.seq > after, timeout=1.0)
            return self.seq, self.frame


class FixedRateExposure:
    """Windows (DirectShow): in room light the Arducam's auto exposure lengthens each frame to ~1/14 s, so it delivers
    14 fps, not 30. Instead: take the brightness auto exposure settles on, lock the exposure at the longest that still
    gives 30 fps (2^-5 s ~ 31 ms) and steer the gain to hold that brightness: the same picture, at 30 fps. Measured on
    the table (Oct 12): auto 14.2 fps / brightness 86; locked -5 with gain 64: 30.5 fps / 92. Runs on the capture thread,
    the only one that touches the camera."""
    EXPOSURE = -5
    GAIN_MAX = 100
    PER_GAIN = 0.75          # brightness per gain step (gain 32 -> 68, 64 -> 92)

    def __init__(self, cap):
        self.cap = cap
        cap.set(cv2.CAP_PROP_GAIN, 0)                              # auto first, at the default gain (a previous run
        cap.set(cv2.CAP_PROP_AUTO_EXPOSURE, 0.75)                 # may have left both locked; auto doesn't reset gain)
        t, means = time.time(), []
        while time.time() - t < 2.0:
            ok, f = cap.read()
            if ok:
                means.append(float(f[::8, ::8].mean()))
        self.target = float(np.mean(means[-8:])) if means else 90.0
        cap.set(cv2.CAP_PROP_AUTO_EXPOSURE, 0.25)
        cap.set(cv2.CAP_PROP_EXPOSURE, self.EXPOSURE)
        self.gain = float(np.clip(64 + (self.target - 92) / self.PER_GAIN, 0, self.GAIN_MAX))
        cap.set(cv2.CAP_PROP_GAIN, self.gain)
        self.n = 0
        print(f'camera: exposure locked at 2^{self.EXPOSURE} s for 30 fps, gain steered to brightness {self.target:.0f} '
              f'(auto exposure: {len(means) / 2:.0f} fps)')

    def step(self, f):
        self.n += 1
        if self.n % 15:                                            # twice a second
            return
        err = self.target - float(f[::8, ::8].mean())
        if abs(err) > 2:
            self.gain = float(np.clip(self.gain + 0.5 * err / self.PER_GAIN, 0, self.GAIN_MAX))
            self.cap.set(cv2.CAP_PROP_GAIN, self.gain)


def use_directml():
    """Windows without CUDA: ultralytics only asks ONNX Runtime for CUDA or CPU, so open its sessions on DirectML
    (any DX12 GPU; ~2.5x the CPU on a Radeon iGPU). Needs onnxruntime-directml in place of onnxruntime."""
    import onnxruntime as ort
    if 'DmlExecutionProvider' not in ort.get_available_providers():
        return False
    base = ort.InferenceSession

    def session(path, opts=None, providers=None, **kw):
        opts = opts or ort.SessionOptions()
        opts.enable_mem_pattern = False                    # DirectML requirements
        opts.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        return base(path, opts, providers=['DmlExecutionProvider', 'CPUExecutionProvider'], **kw)
    ort.InferenceSession = session
    return True


IDLE_AFTER_S = 1.5       # nothing moved and no hand seen for this long -> the model runs at --idle-hz


def main():
    ap = argparse.ArgumentParser()
    run = HERE / 'runs/r4-seg-yolo11s-960/weights'          # round 4: + Moon + person, outlines (Oct 9)
    for older in ('tv-pol-yolo11s-960', 'tv-sam-yolo11s-960'):   # round 3 (polarized), round 2 (SAM 2 labels)
        if not run.exists():
            run = HERE / 'runs' / older / 'weights'
    ml = run / 'best.mlpackage'                               # Core ML export, if present
    onnx = run / 'best.onnx'                                  # Windows: ONNX export, run on DirectML
    dflt = ml if ml.exists() else onnx if sys.platform == 'win32' and onnx.exists() else run / 'best.pt'
    ap.add_argument('--weights', default=str(dflt))
    ap.add_argument('--index', type=int, help='OpenCV camera index (default: find --camera by name)')
    ap.add_argument('--camera', default='iphone', help='camera name to look for, e.g. arducam')
    ap.add_argument('--size', default='1920x1080', help='capture size WxH (Arducam: 2048x1536 at 30 fps)')
    ap.add_argument("--conf", type=float, default=0.05)   # low is fine: the tracker ignores one-off far detections
    ap.add_argument('--imgsz', type=int, default=960)
    ap.add_argument('--port', type=int, default=8780)
    ap.add_argument('--local-only', action='store_true', help='listen on 127.0.0.1 only (default: the LAN, for the presenter tablet)')
    ap.add_argument('--no-browser', action='store_true')
    ap.add_argument('--no-window', action='store_true', help='no OpenCV preview (headless)')
    ap.add_argument('--record', type=float, default=0, metavar='MIN',
                    help='start passive recording at launch for MIN minutes (as GET /record?active=1&min=MIN)')
    ap.add_argument('--exposure', choices=('fixed', 'auto'), default='fixed',
                    help="Windows: 'fixed' = 30 fps with the gain holding auto exposure's brightness (FixedRateExposure); "
                         "'auto' = the camera's own (drops to ~14 fps in room light)")
    ap.add_argument('--idle-hz', type=float, default=5, help='model runs per second while nothing moves (0: always full speed)')
    a = ap.parse_args()
    if sys.platform == 'win32':            # it would "fix" onnxruntime-directml by installing the CPU onnxruntime over it
        os.environ.setdefault('YOLO_AUTOINSTALL', 'false')
    from ultralytics import YOLO
    cfg = load_config()
    state['cfg'] = cfg; state['H'] = load_calib(); state['tracker'] = PieceTracker(cfg)
    state['tracker'].LOG = str(HERE / 'tracker_events.log')
    trk, detector = state['tracker'], make_detector()
    state['tune_default'] = default_tuning(a.conf); state['tune'] = dict(state['tune_default'])
    try:
        set_tuning(json.loads(TUNING_JSON.read_text()), save=False)
        print('tuning from', TUNING_JSON.name)
    except (OSError, ValueError):
        set_tuning({}, save=False)
    show_load()
    serve(a.port, lan=not a.local_only)

    idx, name = (a.index, f'camera {a.index}') if a.index is not None else find_camera(a.camera)
    dev = f'camera {idx} ({name})'
    cw, ch = map(int, a.size.lower().split('x'))
    win = sys.platform == 'win32'
    if not win:                            # the Arducam can hang at 2048x1536 after a process that had it exits: opening it
        wake = cv2.VideoCapture(idx, cv2.CAP_AVFOUNDATION)   # once at its default size first clears that (Oct 9)
        for _ in range(5):
            wake.read()
        wake.release()
    cap = cv2.VideoCapture(idx, cv2.CAP_DSHOW if win else cv2.CAP_AVFOUNDATION)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, cw); cap.set(cv2.CAP_PROP_FRAME_HEIGHT, ch)
    if win:                                # UVC: MJPG, after the size and with no CAP_PROP_FPS: any other order, or
        cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*'MJPG'))   # setting the fps, gives raw YUY2 at 5 fps at 1280x960
    if not cap.isOpened():
        raise SystemExit(f'could not open {dev}')
    exposure = FixedRateExposure(cap) if win and a.exposure == 'fixed' else None
    state['H'] = load_calib(frame_wh=(int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))))
    dml = win and a.weights.endswith('.onnx') and use_directml()
    model = YOLO(a.weights, task='segment' if '-seg' in str(a.weights) else 'detect')   # round 4 is an outline (segment) model
    if a.weights.endswith(('.mlpackage', '.onnx')):
        dev_kw = {}
    elif win:
        import torch
        dev_kw = {'device': 0 if torch.cuda.is_available() else 'cpu'}
    else:
        dev_kw = {'device': 'mps'}
    backend = ('Core ML' if a.weights.endswith('.mlpackage') else f"ONNX on {'DirectML' if dml else 'the CPU'}"
               if a.weights.endswith('.onnx') else f"PyTorch on {dev_kw['device']}")
    state['backend'] = backend
    grab = state['grab'] = LatestFrame(cap, exposure)
    seq = 0
    print(f'{dev} -> {a.weights} ({backend})   (q quit, s save frame)   calibrated: {state["H"] is not None}   '
          f'orbit demo: http://localhost:{a.port}')
    if win and backend.lower().endswith('cpu'):
        print('WARNING: the model is running on the CPU (slow, and it heats the laptop). Use the best.onnx next to best.pt '
              '(export.py) with onnxruntime-directml installed.')
    if not a.no_browser:
        webbrowser.open(f'http://localhost:{a.port}')
    if a.record:                           # passive collection from the start (and again after a restart)
        grab.next(0)
        state['rec'] = Recorder(grab, a.record, fps=10, active=True)

    fps, last, ms, shown, snapped, t0, busy_t = 0.0, time.time(), 0.0, 0.0, 0.0, 0.0, time.time()
    crop_for, crop, sz = None, None, a.imgsz
    while True:
        state['idle'] = a.idle_hz > 0 and time.time() - busy_t > IDLE_AFTER_S
        if state['idle']:                  # all still: look a few times a second, not every frame
            time.sleep(max(0.0, t0 + 1 / a.idle_hz - time.time()))
        seq, frame = grab.next(seq)
        if frame is None:
            continue
        req = state['pending']
        if req is not None and req.feed_frame(detector, frame, cfg):
            with lock:
                state['pending'] = None
        fh, fw = frame.shape[:2]
        state['frame_wh'] = (fw, fh)
        Hm = state['H']
        if crop_for is None or crop_for[0] is not Hm or crop_for[1] != (fw, fh):   # calibrated, recalibrated or resized
            crop_for, crop = (Hm, (fw, fh)), screen_crop(Hm, (fw, fh), cfg['screen_mm'])
            sz = crop_imgsz(crop, (fw, fh), a.imgsz)                 # exported models keep their own fixed size (export.py)
        cx0, cy0, cx1, cy1 = crop
        t0 = time.time()
        try:
            r = model.predict(np.ascontiguousarray(frame[cy0:cy1, cx0:cx1]), imgsz=sz, conf=state['tune']['conf'],
                              agnostic_nms=True, verbose=False, **dev_kw)[0]   # one class per object
        except Exception as e:             # Windows: a GPU fault/reset kills the DirectML session (DXGI 887A0006, Oct 12):
            if not dml:                    # open a new one and carry on; if that fails too, main() exits and gets restarted
                raise
            print(f'{time.strftime("%H:%M:%S")} model failed ({str(e).strip().splitlines()[-1][-160:]}): reloading', flush=True)
            time.sleep(2)
            model = YOLO(a.weights, task='segment' if '-seg' in str(a.weights) else 'detect')
            continue
        ms = 0.9 * ms + 0.1 * (time.time() - t0) * 1000
        state['model_ms'] = ms
        state['model_parts'] = {k: round(0.9 * (state.get('model_parts') or {}).get(k, v) + 0.1 * v, 1)   # ultralytics' own split
                                for k, v in r.speed.items()}
        per_role, raw = {}, []
        boxes = [[x1 + cx0, y1 + cy0, x2 + cx0, y2 + cy0] for x1, y1, x2, y2 in r.boxes.xyxy.tolist()]   # crop -> frame px
        scores = colour_scores(frame, boxes)                       # second opinion on identity (colorcheck.py)
        polys = [p + np.float32([cx0, cy0]) for p in r.masks.xy] if getattr(r, 'masks', None) is not None else [None] * len(boxes)
        people = []
        for k, ((x1, y1, x2, y2), c, s) in enumerate(zip(boxes, r.boxes.cls.int().tolist(), r.boxes.conf.tolist())):
            role = cfg['map'].get(r.names[c], r.names[c])
            if role == 'person' and s >= PERSON_CONF:            # round 4: outlines of hands / arms -> fingertips (zoom slider)
                people.append(polys[k])
                raw.append(((int(x1), int(y1), int(x2), int(y2)), f'person {s:.2f}', (60, 220, 90)))
            if role not in cfg['roles']:
                continue
            u, v = (x1 + x2) / 2 / fw, (y1 + y2) / 2 / fh
            x_mm, y_mm = to_screen(u, v, (fw, fh), cfg, role, Hm)
            if Hm is not None and not on_screen(x_mm, y_mm, cfg):
                raw.append(((int(x1), int(y1), int(x2), int(y2)), f'{role} {s:.2f} off-screen', (90, 90, 90)))
                continue
            raw.append(((int(x1), int(y1), int(x2), int(y2)), f'{role} {s:.2f}', COLORS.get(role, (255, 255, 255))))
            per_role.setdefault(role, []).append({'role': role, 'x_mm': x_mm, 'y_mm': y_mm, 'u': u, 'v': v, 'conf': s,
                                                  'box': (int(x1), int(y1), int(x2), int(y2)),
                                                  'colour': dict(zip(COLOUR_ROLES, scores[k])),
                                                  'size_mm': box_size_mm((x1, y1, x2, y2), (fw, fh), Hm)})
        now = time.time()
        state['hands'] = fingertips(people, Hm, cfg['screen_mm']) if Hm is not None and people else []
        kept = []
        hand_polys = polys_to_mm(people, Hm) if Hm is not None and people else []   # the tracker keeps still pieces still near these
        with lock:
            trk.step([d for dets in per_role.values() for d in dets], now, hand_polys)
            kept = [(d['role'], d['role'], d) for dets in per_role.values() for d in dets]   # preview: every on-screen detection
            if state['hands'] or state['pending'] is not None or any(p['moving'] for p in trk.feed(now).values()):
                busy_t = now                                        # a hand over the screen, a moving piece or a calibration: full speed
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
                cv2.rectangle(snap, (cx0, cy0), (cx1 - 1, cy1 - 1), (120, 120, 120), 2)   # what the model sees
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
    try:
        main()
    except BaseException:                  # exit for real, so a supervisor loop can restart it: a crashed main loop used to
        import traceback                   # leave the camera, server and recorder threads running with no detector
        traceback.print_exc()
        if state.get('rec'):
            state['rec'].finish()          # close the current file properly (a video never closed can't be read)
        os._exit(1)
