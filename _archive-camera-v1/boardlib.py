"""Shared board plumbing for the overhead detectors (tracker.py, dots.py, blink.py).

Config (board.json), homography + lens, grid cells with hysteresis, One Euro filter,
the PieceTracker state machine, and the UDP protocol (feed out on 5005, commands in on 5006)
plus the preview writer. See SPEC.md for the contract.
"""
import json, math, os, queue, socket, threading, time
from pathlib import Path
import cv2
import numpy as np

HERE = Path(__file__).parent
CONFIG = HERE / 'board.json'
RUN_DIR = HERE / 'run'
FEED_ADDR = ('127.0.0.1', 5005)
CMD_ADDR = ('127.0.0.1', 5006)

# Tracking constants (SPEC "Tracking behavior")
HOLD = 1.5            # s a missing piece stays "held" before it is lost
PLACE_FRAMES = 5      # consecutive detections needed to place a piece
JUMP_IN = 4.0         # in: single-frame jumps larger than this are ignored while tracked
JUMP_MISSING = 0.3    # s: ...unless the piece has been missing this long
RELOC_CELLS = 1.5     # cells: reappearing farther than this is a relocation (moved, jump)
SEARCH_IN = 3.0       # in: "keep" radius around the last position
HYST = 0.15           # fraction of a cell the position must pass an edge before the cell changes
AUTO_PERIOD = 2.0     # s between auto-calibration checks in markers mode
BUMP_PX = 8.0         # px a corner may move before the board counts as bumped

try:                  # optional hooks, written by another module
    import calib
except Exception:
    calib = None
try:
    import lens
except Exception:
    lens = None


# ---------------------------------------------------------------- config

def load_config(path=CONFIG, defaults=None):
    """Read board.json over `defaults`; unknown keys are kept."""
    cfg = {'corners': None, 'grid': [8, 6], 'board_in': [48, 36]}
    cfg.update(defaults or {})
    try:
        cfg.update(json.loads(Path(path).read_text()))
    except (OSError, ValueError):
        pass
    return cfg


def save_config(cfg, path=CONFIG):
    """Write board.json atomically. Re-reads the file first so keys written by other
    programs (and sections we don't own) survive; our keys win."""
    path = Path(path)
    try:
        disk = json.loads(path.read_text())
    except (OSError, ValueError):
        disk = {}
    disk.update(cfg)
    tmp = path.with_name(path.name + '.tmp')
    tmp.write_text(json.dumps(disk, indent=2))
    os.replace(tmp, path)


# ---------------------------------------------------------------- geometry

def cell_name(col, row):
    """A1 = top-left, letter = column, number = row."""
    return f'{chr(65 + col)}{row + 1}'


def cell_hysteresis(x, y, cur, bw, bh, cols, rows, frac=HYST):
    """Cell (col,row) for board position (x,y) in inches. Stays in `cur` until the point is
    more than `frac` of a cell past its edge. `cur` None -> plain lookup."""
    cw, ch = bw / cols, bh / rows
    def axis(v, c, size, n):
        if c is not None and c * size - frac * size <= v < (c + 1) * size + frac * size:
            return c
        return int(min(max(v // size, 0), n - 1))
    return (axis(x, cur[0] if cur else None, cw, cols), axis(y, cur[1] if cur else None, ch, rows))


class Board:
    """Config + geometry + calibration state. Detectors call to_board() on camera-pixel points."""

    def __init__(self, defaults=None, grid=None, board_in=None, path=CONFIG):
        self.path = path
        self.cfg = load_config(path, defaults)
        if grid:
            self.cfg['grid'] = list(grid)
        if board_in:
            self.cfg['board_in'] = list(board_in)
        self.lens = None
        if lens is not None:
            try:
                self.lens = lens.load_lens()
            except Exception as e:
                print(f'boardlib: lens load failed ({e})')
        self.bumped = False
        self._last_auto = 0.0
        self._build()

    # -- geometry
    @property
    def calibrated(self):
        return bool(self.cfg.get('corners'))

    @property
    def grid(self):
        return self.cfg['grid']

    @property
    def board_in(self):
        return self.cfg['board_in']

    @property
    def cell_in(self):
        """(cell width, cell height) in inches."""
        return self.board_in[0] / self.grid[0], self.board_in[1] / self.grid[1]

    def _undist(self, pts):
        pts = np.float32(pts).reshape(-1, 2)
        if self.lens is not None and lens is not None:
            try:
                return np.float32(lens.undistort_points(pts, self.lens)).reshape(-1, 2)
            except Exception:
                pass
        return pts

    def _build(self):
        self.H = self.Hinv = self.Hdraw = self.Hdraw_inv = None
        if not self.calibrated:
            return
        bw, bh = self.board_in
        dst = np.float32([[0, 0], [bw, 0], [bw, bh], [0, bh]])
        raw = np.float32(self.cfg['corners'])
        self.H = cv2.getPerspectiveTransform(self._undist(raw), dst)
        self.Hinv = np.linalg.inv(self.H)
        # drawing on the raw (distorted) frame uses the raw corners
        self.Hdraw = cv2.getPerspectiveTransform(raw, dst)
        self.Hdraw_inv = np.linalg.inv(self.Hdraw)

    def to_board(self, px_pts):
        """Camera px (Nx2) -> board inches (Nx2), lens-corrected if a lens is loaded."""
        pts = self._undist(px_pts).reshape(-1, 1, 2)
        return cv2.perspectiveTransform(pts, self.H).reshape(-1, 2)

    def to_camera(self, board_pts):
        """Board inches -> camera px, for drawing on the raw frame."""
        pts = np.float32(board_pts).reshape(-1, 1, 2)
        return cv2.perspectiveTransform(pts, self.Hdraw_inv).reshape(-1, 2)

    def mask(self, shape):
        """Filled board polygon (uint8 255 inside) for a frame of (h, w)."""
        m = np.zeros(shape[:2], np.uint8)
        if self.calibrated:
            cv2.fillPoly(m, [np.int32(self.cfg['corners'])], 255)
        return m

    # -- changes
    def set_corners(self, corners, calib_mode='manual', save=True):
        self.cfg['corners'] = [[float(x), float(y)] for x, y in corners]
        self.cfg['calib'] = calib_mode
        self.bumped = False
        self._build()
        if save:
            save_config(self.cfg, self.path)

    def set_grid(self, grid=None, board_in=None):
        if grid:
            self.cfg['grid'] = [int(v) for v in grid]
        if board_in:
            self.cfg['board_in'] = [float(v) for v in board_in]
        self._build()
        save_config(self.cfg, self.path)

    def save(self):
        save_config(self.cfg, self.path)

    # -- auto calibration
    def detect_corners(self, frame):
        """calib.detect_board_corners(frame) -> (4,2) array or None; None if calib is missing."""
        if calib is None:
            return None
        try:
            c = calib.detect_board_corners(frame)
            return None if c is None else np.asarray(c, float).reshape(4, 2)
        except Exception as e:
            print(f'boardlib: calib.detect_board_corners failed ({e})')
            return None

    def auto_corners(self, frame):
        """Calibrate from markers now. Returns True if corners were found and saved."""
        c = self.detect_corners(frame)
        if c is None:
            print('auto_corners: markers not found' if calib else 'auto_corners: calib module unavailable')
            return False
        self.set_corners(c, 'markers')
        print('Corners set from markers')
        return True

    def tick_auto(self, frame, now=None):
        """In markers mode, re-detect every ~2 s: calibrate if uncalibrated, set `bumped` if corners
        moved > 8 px from the saved ones."""
        now = time.time() if now is None else now
        if self.cfg.get('calib') != 'markers' or now - self._last_auto < AUTO_PERIOD:
            return
        self._last_auto = now
        c = self.detect_corners(frame)
        if c is None:
            return
        if not self.calibrated:
            self.set_corners(c, 'markers')
        elif np.linalg.norm(c - np.float32(self.cfg['corners']), axis=1).max() > BUMP_PX:
            if not self.bumped:
                print('Board moved: corners differ from saved by > 8 px (bumped)')
            self.bumped = True

    def handle(self, cmd, frame=None):
        """Handle the geometry commands (set_corners, auto_corners, set_grid). True if handled."""
        name = cmd.get('cmd')
        try:
            if name == 'set_corners' and len(cmd['corners']) == 4:
                self.set_corners(cmd['corners'])
                print('Corners set')
            elif name == 'auto_corners':
                if frame is not None:
                    self.auto_corners(frame)
            elif name == 'set_grid':
                self.set_grid(cmd.get('grid'), cmd.get('board_in'))
                print(f"Grid set: {self.grid} board {self.board_in}")
            else:
                return False
        except (KeyError, TypeError, ValueError) as e:
            print(f'bad {name} command: {e}')
        return True


# ---------------------------------------------------------------- One Euro filter

class OneEuroFilter:
    """2D One Euro filter (Casiez et al.): smooth when slow, responsive when fast."""

    def __init__(self, min_cutoff=1.0, beta=0.05, d_cutoff=1.0):
        self.min_cutoff, self.beta, self.d_cutoff = min_cutoff, beta, d_cutoff
        self.reset()

    def reset(self):
        self.t = self.x = self.dx = None

    @staticmethod
    def _alpha(cutoff, dt):
        tau = 1.0 / (2 * math.pi * cutoff)
        return 1.0 / (1.0 + tau / dt)

    def __call__(self, pt, t):
        pt = np.asarray(pt, float)
        if self.x is None:
            self.t, self.x, self.dx = t, pt, np.zeros(2)
            return self.x.copy()
        dt = max(t - self.t, 1e-3)
        a_d = self._alpha(self.d_cutoff, dt)
        dx = (pt - self.x) / dt
        self.dx = a_d * dx + (1 - a_d) * self.dx
        cutoff = self.min_cutoff + self.beta * float(np.linalg.norm(self.dx))
        a = self._alpha(cutoff, dt)
        self.x = a * pt + (1 - a) * self.x
        self.t = t
        return self.x.copy()


# ---------------------------------------------------------------- piece state machine

class _Piece:
    def __init__(self):
        self.placed = False        # has been placed (listed in output)
        self.lost = False
        self.streak = 0            # consecutive detections (candidates / reacquiring)
        self.raw = None            # last raw detection (x, y)
        self.pos = None            # filtered position
        self.cell = None           # (col, row)
        self.conf = 0.0
        self.last_seen = 0.0
        self.filt = OneEuroFilter()


class PieceTracker:
    """Per-frame detections -> stable pieces + events.

    update(dets, now): dets = {name: (x_in, y_in, conf)} (omit names not seen). Returns
    (pieces, events) in the SPEC feed format. Call it every frame, even with empty dets.
    """

    def __init__(self, board_in=(48, 36), grid=(8, 6), hold=HOLD):
        self.hold = hold
        self.p = {}
        self.set_grid(grid, board_in)

    def set_grid(self, grid, board_in):
        self.grid, self.board_in = tuple(grid), tuple(board_in)

    def _cell(self, x, y, cur):
        return cell_hysteresis(x, y, cur, *self.board_in, *self.grid)

    def _cell_in(self):
        return min(self.board_in[0] / self.grid[0], self.board_in[1] / self.grid[1])

    def search(self, name):
        """(x_in, y_in, radius_in) to look near for `name` with loose thresholds, or None
        when it is not currently tracked/held (use strict thresholds anywhere then)."""
        s = self.p.get(name)
        if s is None or s.raw is None or s.lost:
            return None
        pos = s.pos if s.placed else s.raw
        return float(pos[0]), float(pos[1]), SEARCH_IN

    def _event(self, events, typ, name, s, frm, now, jump=False):
        events.append({'type': typ, 'piece': name, 'cell': cell_name(*s.cell), 'from': frm, 'jump': jump, 't': now})

    def update(self, dets, now):
        events = []
        for name, (x, y, conf) in dets.items():
            self.p.setdefault(name, _Piece())
        for name, s in self.p.items():
            self._step(name, s, dets.get(name), now, events)
        return self.pieces(now), events

    def _step(self, name, s, det, now, events):
        gap = now - s.last_seen
        if det is not None:
            xy = np.array(det[:2], float)
            # jump gating: a far single-frame detection while tracked is treated as not seen
            if s.placed and not s.lost and gap <= JUMP_MISSING and np.linalg.norm(xy - s.pos) > JUMP_IN:
                det = None
        if det is None:
            if not s.placed or s.lost:
                s.streak = 0                         # candidate/reacquire needs *consecutive* frames
            elif gap >= self.hold:
                s.lost = True
                s.streak = 0
                self._event(events, 'lifted', name, s, None, now)
            return
        conf = det[2]
        # candidates / re-acquisition after lost: need PLACE_FRAMES consecutive, nearby detections
        if not s.placed or s.lost:
            if s.streak and s.raw is not None and np.linalg.norm(xy - s.raw) > JUMP_IN:
                s.streak = 0
            s.streak += 1
            s.raw, s.conf, s.last_seen = xy, conf, now
            if s.streak >= PLACE_FRAMES:
                s.filt.reset()
                s.pos = s.filt(xy, now)
                s.cell = self._cell(*s.pos, None)
                s.placed, s.lost = True, False
                self._event(events, 'placed', name, s, None, now)
            return
        # tracked / held piece
        s.raw, s.conf = xy, conf
        old = s.cell
        if np.linalg.norm(xy - s.pos) > RELOC_CELLS * self._cell_in():
            s.filt.reset()                           # relocation: snap, glide handled by display
            s.pos = s.filt(xy, now)
            s.cell = self._cell(*s.pos, None)
            s.last_seen = now
            self._event(events, 'moved', name, s, cell_name(*old), now, jump=True)
            return
        s.pos = s.filt(xy, now)
        s.last_seen = now
        s.cell = self._cell(*s.pos, old)
        if s.cell != old:
            self._event(events, 'moved', name, s, cell_name(*old), now)

    def pieces(self, now):
        """Current `pieces` dict for the feed (placed pieces only)."""
        out = {}
        bw, bh = self.board_in
        for name, s in self.p.items():
            if not s.placed:
                continue
            ago = max(now - s.last_seen, 0.0)
            state = 'lost' if s.lost else ('tracked' if ago < 1e-6 else 'held')
            x, y = float(s.pos[0]), float(s.pos[1])
            out[name] = {'state': state, 'cell': cell_name(*s.cell), 'col': s.cell[0], 'row': s.cell[1],
                         'x_in': round(x, 2), 'y_in': round(y, 2), 'u': round(x / bw, 4), 'v': round(y / bh, 4),
                         'conf': round(float(s.conf), 2), 'seen_ago': round(ago, 2)}
        return out


# ---------------------------------------------------------------- protocol

class FeedSender:
    """Sends the v1 feed to UDP 127.0.0.1:5005. Call send() every frame (heartbeat)."""

    def __init__(self, source, addr=FEED_ADDR):
        self.source, self.addr, self.seq = source, addr, 0
        self.capture = None                      # optional FrameCapturer: adds the "capture" feed field
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

    def build(self, board, fps, camera_info, pieces, events, t=None):
        self.seq += 1
        msg = {'v': 1, 'seq': self.seq, 't': round(time.time() if t is None else t, 3), 'fps': round(float(fps), 1),
                'source': self.source, 'calibrated': board.calibrated, 'calib': board.cfg.get('calib') or 'manual',
                'bumped': bool(board.bumped), 'grid': list(board.grid), 'board_in': list(board.board_in),
                'camera': camera_info, 'pieces': pieces, 'events': events}
        if self.capture is not None:
            msg['capture'] = self.capture.status()
        return msg

    def send(self, board, fps, camera_info, pieces, events, t=None):
        msg = self.build(board, fps, camera_info, pieces, events, t)
        try:
            self.sock.sendto(json.dumps(msg).encode(), self.addr)
        except OSError:
            pass
        return msg


class CommandReceiver:
    """Non-blocking UDP listener on 127.0.0.1:5006. poll() -> list of command dicts."""

    def __init__(self, addr=CMD_ADDR):
        self.sock = None
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind(addr)
            s.setblocking(False)
            self.sock = s
        except OSError as e:
            print(f'boardlib: cannot listen for commands on {addr} ({e})')

    def poll(self):
        cmds = []
        while self.sock is not None:
            try:
                data, _ = self.sock.recvfrom(65536)
            except (BlockingIOError, InterruptedError):
                break
            except OSError:
                break
            try:
                c = json.loads(data.decode())
                if isinstance(c, dict) and 'cmd' in c:
                    cmds.append(c)
            except (ValueError, UnicodeDecodeError):
                print('boardlib: ignoring malformed command')
        return cmds


class FrameCapturer:
    """Saves RAW camera frames (no overlay, JPEG q95) to dataset/raw/YYYYmmdd-HHMMSS-mmm.jpg for
    training a detector, from the process that already holds the camera. Encoding and writing run on a
    background thread fed by a small queue (a frame is dropped if the queue is full).
    Commands: {"cmd":"capture"} (next frame once), {"cmd":"capture_auto","interval":s} (0 stops).
    Call handle(cmd) for each command and tick(frame, now) once per frame."""

    def __init__(self, out_dir=None, quality=95, qsize=4):
        self.dir = Path(out_dir) if out_dir else HERE / 'dataset' / 'raw'
        self.quality = quality
        self.auto, self.interval, self.count = False, 0.0, 0
        self._once, self._next = False, 0.0
        self._q = queue.Queue(maxsize=qsize)
        self._thread = None

    def status(self):
        return {'auto': self.auto, 'interval': self.interval, 'count': self.count}

    def handle(self, c):
        """True if `c` was a capture command."""
        name = c.get('cmd')
        if name == 'capture':
            self._once = True
            return True
        if name == 'capture_auto':
            try:
                iv = float(c.get('interval', 0))
            except (TypeError, ValueError):
                iv = 0.0
            self.auto, self.interval, self._next = iv > 0, max(iv, 0.0), 0.0
            print(f'capture_auto: ' + (f'every {iv:g} s' if self.auto else 'off'))
            return True
        return False

    def due(self, now):
        return self._once or (self.auto and now >= self._next)

    def tick(self, frame, now=None):
        """Queue `frame` for saving if a capture is due. Returns True if queued."""
        now = time.time() if now is None else now
        if not self.due(now):
            return False
        self._once = False
        if self.auto:
            self._next = now + self.interval
        return self.submit(frame, now)

    def submit(self, frame, t=None):
        t = time.time() if t is None else t
        if self._thread is None:
            self._thread = threading.Thread(target=self._run, daemon=True)
            self._thread.start()
        try:
            self._q.put_nowait((frame.copy(), t))
            return True
        except queue.Full:
            print('capture: queue full, frame dropped')
            return False

    @staticmethod
    def filename(t):
        return time.strftime('%Y%m%d-%H%M%S', time.localtime(t)) + f'-{int(t * 1000) % 1000:03d}.jpg'

    def _run(self):
        while True:
            frame, t = self._q.get()
            try:
                self.dir.mkdir(parents=True, exist_ok=True)
                path = self.dir / self.filename(t)
                if cv2.imwrite(str(path), frame, [cv2.IMWRITE_JPEG_QUALITY, self.quality]):
                    self.count += 1
                else:
                    print(f'capture: could not write {path}')
            except Exception as e:
                print(f'capture failed: {e}')
            finally:
                self._q.task_done()

    def flush(self):
        self._q.join()


class PreviewWriter:
    """Writes run/preview.jpg (~5 Hz, ~960 px wide, atomic) and run/preview.json."""

    def __init__(self, run_dir=RUN_DIR, width=960, hz=25.0):
        self.dir, self.width, self.period, self._t = Path(run_dir), width, 1.0 / hz, 0.0
        self.dir.mkdir(exist_ok=True)

    def due(self, now=None):
        return (time.time() if now is None else now) - self._t >= self.period

    def write(self, view, pad, frame_w, frame_h, now=None):
        """`view` = camera frame plus `pad` px margin on every side (same as the window)."""
        self._t = time.time() if now is None else now
        s = self.width / view.shape[1]
        small = cv2.resize(view, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
        try:
            tmp = self.dir / 'preview.tmp.jpg'
            cv2.imwrite(str(tmp), small, [cv2.IMWRITE_JPEG_QUALITY, 75])
            os.replace(tmp, self.dir / 'preview.jpg')
            tmpj = self.dir / 'preview.json.tmp'
            tmpj.write_text(json.dumps({'scale': s, 'pad': pad, 'frame_w': frame_w, 'frame_h': frame_h}))
            os.replace(tmpj, self.dir / 'preview.json')
        except OSError as e:
            print(f'preview write failed: {e}')
