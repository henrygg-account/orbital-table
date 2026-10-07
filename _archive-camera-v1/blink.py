"""Find blinking lights (LEDs) by how they change over time and identify pieces by blink rate.

Run:  .venv/bin/python blink.py [--camera NAME|INDEX] [--grid 8x6] [--board 48x36] [--headless]
                                [--rise 30] [--rises-per-sec 1.5] [--tolerance 25] [--min-share 0.6]
                                [--exposure 8.3] [--gain 0] [--focus N] [--no-camset]

A static scene barely changes between frames; a blinking light jumps up in brightness over and over at the
same spot. Each pixel counts its brightness "rises" over the last ~1.2 s, and spots with several rises are
candidates. Each candidate's blink rate comes from an FFT of its brightness: A=2 Hz, B=3, C=5, D=7.
Periodicity check: the FFT peak must hold >= --min-share (default 0.6) of the non-DC spectral energy and the rise count must
roughly match the measured rate, so moving hands / random flicker are rejected.
Needs ~1.2 s of history before the first detection (the tracker's HOLD time covers dropouts).

Keys:  c  recalibrate corners    q  quit
Commands (UDP 5006): SPEC geometry/camera commands plus {"cmd":"set_param","name":"rise|rises_per_sec|tolerance|min_share","value":N}.
Every frame a v1 JSON message goes to UDP 127.0.0.1:5005 (source tracker:blink). Only events are printed.
"""
import argparse, sys, time
import cv2
import numpy as np
from boardlib import Board, PieceTracker, FeedSender, CommandReceiver, PreviewWriter, FrameCapturer
import camera as cam
import tracker as trk          # shared drawing helpers

DS = 3                      # detect on a 1/3-size image (640x360) for speed
WINDOW = 30                 # frames of history (~1.2 s at 25 fps; guarantees >= 2 rises of a 2 Hz blink)
RATES = {'A': 2.0, 'B': 3.0, 'C': 5.0, 'D': 7.0}   # blink rate (Hz) -> piece name
COLORS = {'A': (60, 220, 60), 'B': (255, 160, 40), 'C': (40, 60, 255), 'D': (0, 220, 255), '?': (200, 200, 200)}
REGULAR = 0.8               # fraction of rise-to-rise intervals that must sit within +-40% of the median
MAX_BLOB = 2000             # px (small image): bigger regions are lighting changes / people, not LEDs
DEFAULTS = {'rise': 30, 'rises_per_sec': 1.5, 'tolerance': 25, 'min_share': 0.6}
ALIASES = {'rise_size': 'rise', 'rate_tolerance': 'tolerance', 'share': 'min_share'}


def spectrum(series, dt):
    """(rate Hz, peak share) of a brightness series. Share = power in the peak bin and its two neighbours
    over all non-DC power (1.0 = pure tone, ~0.2-0.3 = noise / sweeps / random flicker)."""
    s = series - series.mean()
    if s.std() < 1e-3:
        return 0.0, 0.0
    p = np.abs(np.fft.rfft(s * np.hanning(len(s)))) ** 2
    p[0] = 0
    k = int(np.argmax(p))
    share = float(p[max(k - 1, 1):k + 2].sum() / max(p.sum(), 1e-9))
    mag = np.sqrt(p)
    frac = 0.0                                       # parabolic interpolation for sub-bin accuracy
    if 1 < k < len(p) - 1:
        a, b, c = mag[k - 1], mag[k], mag[k + 1]
        if a - 2 * b + c < 0:
            frac = float(np.clip(0.5 * (a - c) / (a - 2 * b + c), -0.5, 0.5))
    return float((k + frac) / (len(s) * dt)), share


def regularity(rise_series):
    """Fraction of intervals between rise frames within +-40% of the median interval (1.0 for a steady blink;
    random flicker scores low). Fewer than 2 intervals -> 1.0 (nothing to judge)."""
    iv = np.diff(np.nonzero(rise_series)[0])
    if len(iv) < 2:
        return 1.0
    return float(np.mean(np.abs(iv - np.median(iv)) <= 0.4 * np.median(iv)))


def identify(rate, tol):
    """Piece name whose rate is within tol (fraction) of `rate`, else '?'."""
    best = min(RATES, key=lambda k: abs(RATES[k] - rate))
    return best if abs(RATES[best] - rate) <= tol * RATES[best] else '?'


class BlinkDetector:
    """Temporal blink detector on a stream of BGR frames: push(frame, t), then detect(mask)."""

    def __init__(self, shape, params=None):
        self.params = dict(DEFAULTS, **(params or {}))
        h, w = shape[:2]
        self.sh, self.sw = h // DS, w // DS
        self.hist = np.zeros((WINDOW, self.sh, self.sw), np.float32)    # brightness history (small image)
        self.rises = np.zeros((WINDOW, self.sh, self.sw), np.uint8)     # 1 where brightness jumped up
        self.times = np.zeros(WINDOW)
        self.idx = self.filled = 0
        self.prev = None
        self.count = np.zeros((self.sh, self.sw), np.uint8)

    def push(self, frame, t):
        small = cv2.resize(frame, (self.sw, self.sh), interpolation=cv2.INTER_AREA).max(axis=2).astype(np.float32)
        self.hist[self.idx], self.times[self.idx] = small, t
        self.rises[self.idx] = (small - self.prev > self.params['rise']) if self.prev is not None else 0
        self.prev = small
        self.idx = (self.idx + 1) % WINDOW
        self.filled = min(self.filled + 1, WINDOW)

    def small_mask(self, board, shape):
        """Board polygon at detection resolution."""
        return cv2.resize(board.mask(shape), (self.sw, self.sh), interpolation=cv2.INTER_NEAREST)

    def detect(self, mask=None):
        """Blinking blobs -> list of dicts {name, rate, share, rises, regular, px (full-res centroid), conf}.
        Needs a full window of history. `mask` = small-resolution board mask (255 inside)."""
        P = self.params
        if self.filled < WINDOW:
            return []
        order = (self.idx + np.arange(WINDOW)) % WINDOW                # oldest -> newest
        t = self.times[order]
        span = max(t[-1] - t[0], 1e-3)
        dt = span / (WINDOW - 1)
        self.count = self.rises.sum(axis=0)
        need = max(1, int(round(P['rises_per_sec'] * span)))
        cand = (self.count >= need)
        if mask is not None:
            cand &= mask > 0
        cand = cv2.dilate(cand.astype(np.uint8) * 255, np.ones((5, 5), np.uint8))
        n, labels, stats, cents = cv2.connectedComponentsWithStats(cand)
        out = []
        for i in range(1, n):
            if stats[i, 4] > MAX_BLOB:
                continue
            x0, y0, w, h = stats[i, :4]
            sub = labels[y0:y0 + h, x0:x0 + w] == i
            core = sub & (self.count[y0:y0 + h, x0:x0 + w] >= need)    # pixels that actually blinked
            ys, xs = np.nonzero(core if core.any() else sub)
            series = self.hist[order][:, y0 + ys, x0 + xs].mean(axis=1)
            rate, share = spectrum(series, dt)
            rises = float(np.median(self.count[y0 + ys, x0 + xs]))
            name = identify(rate, P['tolerance'] / 100)
            # periodicity: the peak must dominate the spectrum, and the rise count must match the rate
            expect = rate * span
            reg = regularity(self.rises[order][:, y0 + ys, x0 + xs].mean(axis=1) >= 0.5)
            ok = (name != '?' and share >= P['min_share'] and 0.5 * expect - 0.5 <= rises <= 1.5 * expect + 1
                  and reg >= REGULAR)
            cx, cy = cents[i] * DS
            out.append({'name': name if ok else '?', 'rate': rate, 'share': share, 'rises': rises, 'regular': reg,
                        'px': (float(cx), float(cy)),
                        'conf': float(min(1.0, share / 0.8) * (1 - min(abs(rate - RATES[name]) / RATES[name], 1) if name != '?' else 0))})
        return out


def to_dets(blobs, board, near=None):
    """Accepted blobs -> ({name: (x_in, y_in, conf)}, {name: px}). One blob per name: nearest the last
    position (PieceTracker.search) if known, else the most confident."""
    best = {}
    for b in blobs:
        if b['name'] == '?':
            continue
        x, y = board.to_board([b['px']])[0]
        s = near.get(b['name']) if near else None
        d = float(np.hypot(x - s[0], y - s[1])) if s else None
        key = (0, d) if s and d <= s[2] else (1, -b['conf'])
        if b['name'] not in best or key < best[b['name']][0]:
            best[b['name']] = (key, (float(x), float(y), b['conf']), b['px'])
    return {n: v[1] for n, v in best.items()}, {n: v[2] for n, v in best.items()}


def main():
    sys.stdout.reconfigure(line_buffering=True)
    ap = argparse.ArgumentParser()
    ap.add_argument('--camera', default='HD USB Camera', help='camera name, or an index')
    ap.add_argument('--grid', help='columns x rows, e.g. 8x6')
    ap.add_argument('--board', help='board size in inches, e.g. 48x36')
    ap.add_argument('--headless', action='store_true', help='no OpenCV windows (preview.jpg still written)')
    ap.add_argument('--rise', type=int, default=DEFAULTS['rise'], help='brightness jump counted as a rise (default 30)')
    ap.add_argument('--rises-per-sec', type=float, default=DEFAULTS['rises_per_sec'], help='rises/s a pixel needs (default 1.5)')
    ap.add_argument('--tolerance', type=float, default=DEFAULTS['tolerance'], help='rate tolerance in %% (default 25)')
    ap.add_argument('--min-share', type=float, default=DEFAULTS['min_share'], help='min FFT peak share of non-DC energy (default 0.6)')
    ap.add_argument('--exposure', type=float, default=8.3, help='exposure in ms (default 8.3)')
    ap.add_argument('--gain', type=int, default=0)
    ap.add_argument('--focus', type=int, default=None, help='focus-abs (default: leave as is)')
    ap.add_argument('--no-camset', action='store_true', help='do not touch UVC camera settings')
    args = ap.parse_args()
    headless = args.headless

    board = Board(None, trk.parse_dims(args.grid, int), trk.parse_dims(args.board, float))
    cam_name = cam.DEFAULT_NAME if args.camera.isdigit() else args.camera
    cap = cam.open_camera(cam_name, int(args.camera) if args.camera.isdigit() else 0)
    cam_info = cam.read_settings(cam_name) if args.no_camset else cam.apply_settings(args.exposure, args.gain, args.focus, cam_name)
    print(f'Camera settings: {cam_info}')
    ok, frame = cap.read()
    if not ok:
        raise SystemExit('Camera gave no frames. Is another program using it?')
    FH, FW = frame.shape[:2]

    feed = FeedSender('tracker:blink')
    cmds = CommandReceiver()
    capturer = FrameCapturer()
    feed.capture = capturer
    preview = PreviewWriter()
    watch = cam.FpsWatchdog()
    tracker = PieceTracker(board.board_in, board.grid)
    det = BlinkDetector(frame.shape, {'rise': args.rise, 'rises_per_sec': args.rises_per_sec,
                                      'tolerance': args.tolerance, 'min_share': args.min_share})
    state = {'mode': 'calibrate' if not board.calibrated and not headless else 'track', 'clicks': []}
    PAD, VIEW = trk.PAD, trk.VIEW
    mask_key, smask = None, None

    def on_mouse(event, x, y, flags, _):
        if event == cv2.EVENT_LBUTTONDOWN and state['mode'] == 'calibrate':
            state['clicks'].append([x / VIEW - PAD, y / VIEW - PAD])
            if len(state['clicks']) == 4:
                board.set_corners(state['clicks'])
                state.update(clicks=[], mode='track')
                print('Corners saved to board.json')

    if not headless:
        cv2.namedWindow('camera')
        cv2.setMouseCallback('camera', on_mouse)

    fails = 0
    try:
        while True:
            ok, frame = cap.read()
            now = time.time()
            if not ok:                                   # keep the heartbeat alive while the camera is down
                fails += 1
                cam_info = dict(cam_info, ok=False)
                feed.send(board, 0.0, cam_info, tracker.pieces(now), [], now)
                if fails > 250:
                    break
                time.sleep(0.04)
                continue
            fails = 0
            fps = watch.tick(now)
            det.push(frame, now)                         # history always fills, even while uncalibrated

            # ---- commands
            for c in cmds.poll():
                name = c.get('cmd')
                if board.handle(c, frame):
                    tracker.set_grid(board.grid, board.board_in)
                elif capturer.handle(c):
                    pass
                elif name == 'set_param':
                    key = ALIASES.get(c.get('name'), c.get('name'))
                    try:
                        if key not in det.params:
                            raise KeyError(key)
                        det.params[key] = float(c['value'])
                        print(f'{key} = {det.params[key]}')
                    except (KeyError, TypeError, ValueError) as e:
                        print(f'bad set_param: {e}')
                elif name == 'camera':
                    cam_info = cam.apply_settings(c.get('exposure_ms', cam_info.get('exposure_ms') or args.exposure),
                                                  c.get('gain', cam_info.get('gain') or 0), c.get('focus'), cam_name)
                    print(f'Camera settings: {cam_info}')
                elif name == 'learn_background':
                    print('learn_background: not needed for the blink detector (no-op)')
                else:
                    print(f'unknown command: {c}')
            capturer.tick(frame, now)
            board.tick_auto(frame, now)

            # ---- detect
            blobs, dets, px_of = [], {}, {}
            if board.calibrated and state['mode'] != 'calibrate':
                key = (tuple(map(tuple, board.cfg['corners'])), frame.shape)
                if key != mask_key:
                    mask_key, smask = key, det.small_mask(board, frame.shape)
                blobs = det.detect(smask)
                dets, px_of = to_dets(blobs, board, {n: tracker.search(n) for n in RATES})
            pieces, events = tracker.update(dets, now)
            for e in events:
                print(f"{time.strftime('%H:%M:%S', time.localtime(e['t']))} {e['type']:>6} {e['piece']:>2} "
                      f"{e['cell']}" + (f" (from {e['from']})" if e['from'] else '') + (' [jump]' if e['jump'] else ''))
            feed.send(board, fps, cam_info, pieces, events, now)

            # ---- view (window and/or preview)
            if not headless or preview.due(now):
                view = cv2.copyMakeBorder(frame, PAD, PAD, PAD, PAD, cv2.BORDER_CONSTANT, value=(24, 24, 24))
                if board.calibrated and state['mode'] != 'calibrate':
                    trk.draw_grid(view, board)
                    for b in blobs:                      # rejected blobs show grey with their rate/share
                        px = (int(b['px'][0] + PAD), int(b['px'][1] + PAD))
                        col = COLORS[b['name']]
                        cv2.circle(view, px, 34, col, 3, cv2.LINE_AA)
                        cv2.putText(view, f"{b['name']} {b['rate']:.1f}Hz {b['share']:.2f}", (px[0] + 40, px[1] - 10),
                                    cv2.FONT_HERSHEY_SIMPLEX, .9, col, 2, cv2.LINE_AA)
                    for name, r in pieces.items():
                        bp = board.to_camera([[r['x_in'], r['y_in']]])[0]
                        col = (80, 80, 255) if r['state'] == 'lost' else COLORS[name]
                        cv2.putText(view, f"{name} {r['cell']}" + ('' if r['state'] == 'tracked' else f" ({r['state']})"),
                                    (int(bp[0] + PAD) + 46, int(bp[1] + PAD) + 40), cv2.FONT_HERSHEY_SIMPLEX, .9, col, 2, cv2.LINE_AA)
                if state['mode'] == 'calibrate':
                    for p in state['clicks']:
                        cv2.circle(view, (int(p[0] + PAD), int(p[1] + PAD)), 10, (0, 200, 255), -1)
                    msg = f"Click the board's {trk.CORNER_NAMES[len(state['clicks'])]} corner  ({len(state['clicks']) + 1}/4)"
                elif not board.calibrated:
                    msg = 'Not calibrated: waiting for corners'
                else:
                    msg = f"{fps:4.1f} fps   " + '   '.join(f"{n}: {r['cell']}" for n, r in pieces.items()) + (
                        '   BUMPED' if board.bumped else '') + ('' if pieces else '   waiting for a blinking light') + "   c: corners   q: quit"
                cv2.putText(view, msg, (20, 60), cv2.FONT_HERSHEY_SIMPLEX, 1.3, (0, 0, 0), 6, cv2.LINE_AA)
                cv2.putText(view, msg, (20, 60), cv2.FONT_HERSHEY_SIMPLEX, 1.3, (255, 255, 255), 2, cv2.LINE_AA)
                if preview.due(now):
                    preview.write(view, PAD, FW, FH, now)
                if not headless:
                    if board.calibrated and state['mode'] != 'calibrate':
                        cv2.imshow('top-down', trk.draw_top(frame, board, pieces, COLORS))
                        cv2.imshow('blink heat', cv2.applyColorMap(cv2.convertScaleAbs(det.count, alpha=255 / WINDOW), cv2.COLORMAP_INFERNO))
                    cv2.imshow('camera', cv2.resize(view, None, fx=VIEW, fy=VIEW, interpolation=cv2.INTER_AREA))
                    k = cv2.waitKey(1) & 0xFF
                    if k == ord('q'):
                        break
                    if k == ord('c'):
                        state.update(mode='calibrate', clicks=[])
    except KeyboardInterrupt:
        pass
    finally:
        cap.release()
        cv2.destroyAllWindows()


if __name__ == '__main__':
    main()
