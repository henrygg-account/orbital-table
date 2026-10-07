"""Track colored pieces on a board seen by the overhead camera and report their grid cell.

Run:  .venv/bin/python tracker.py [--pieces magnets|leds] [--camera NAME|INDEX] [--grid 8x6] [--board 48x36]
                                  [--headless] [--exposure 8.3] [--gain 0] [--focus N] [--no-camset]

First run asks you to click the board's four corners (top-left, top-right,
bottom-right, bottom-left). A corner outside the camera view can be clicked in
the dark margin around the image. Calibration is saved to board.json.

Keys:  c  recalibrate corners      1 / 2  then click a piece to relearn its color
       q  quit
Every frame a v1 JSON message goes to UDP 127.0.0.1:5005 (see SPEC.md); commands arrive on 5006.
Only placed / moved / lifted events are printed.
"""
import argparse, sys, time
import cv2
import numpy as np
import boardlib
from boardlib import Board, PieceTracker, FeedSender, CommandReceiver, PreviewWriter, FrameCapturer
import camera as cam

PAD = 160          # margin around the camera image, so off-frame corners can be clicked
VIEW = 0.62        # display scale for the camera window
TOP_W = 720        # width of the top-down window in px
CORNER_NAMES = ['top-left', 'top-right', 'bottom-right', 'bottom-left']
LOOSE = 0.7        # "keep" thresholds: saturation / value lows scaled by this

# LED pieces: bright and saturated. A hue range whose low end is above its high end
# wraps around 0 (needed for red, which sits at both ends of OpenCV's 0-179 hue scale).
PIECE_SETS = {
    'magnets': [
        {'name': 'blue',   'lo': [92, 90, 60],   'hi': [112, 255, 255], 'draw': [255, 140, 40]},
        {'name': 'purple', 'lo': [145, 55, 70],  'hi': [172, 255, 255], 'draw': [200, 60, 220]},
    ],
    # Black isn't a hue: it's "dark and not very colorful" (any hue, low value) against the white board.
    'purple_black': [
        {'name': 'purple', 'lo': [145, 55, 70],  'hi': [172, 255, 255], 'draw': [200, 60, 220]},
        {'name': 'black',  'lo': [0, 0, 0],      'hi': [179, 120, 55],  'draw': [40, 40, 40]},
    ],
    'leds': [
        {'name': 'green', 'lo': [40, 70, 150],  'hi': [90, 255, 255], 'draw': [60, 220, 60]},
        {'name': 'red',   'lo': [170, 70, 150], 'hi': [10, 255, 255], 'draw': [40, 40, 255]},
    ],
}
# (min blob area px, max blob area px) per piece set
AREAS = {'magnets': (60, 6000), 'purple_black': (60, 6000), 'leds': (25, 2500)}


def color_mask(hsv, lo, hi):
    if lo[0] <= hi[0]:
        return cv2.inRange(hsv, np.array(lo), np.array(hi))
    return (cv2.inRange(hsv, np.array(lo), np.array([179, hi[1], hi[2]])) |
            cv2.inRange(hsv, np.array([0, lo[1], lo[2]]), np.array(hi)))


def loosen(lo):
    return [lo[0], int(lo[1] * LOOSE), int(lo[2] * LOOSE)]


KERNEL = np.ones((3, 3), np.uint8)


def blobs(mask, min_area, max_area):
    """Contours of `mask` as (cx, cy, area, fill) within the area limits."""
    m = cv2.morphologyEx(mask, cv2.MORPH_OPEN, KERNEL)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, KERNEL, iterations=2)
    cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    out = []
    for c in cnts:
        a = cv2.contourArea(c)
        if a < min_area or a > max_area:
            continue
        M = cv2.moments(c)
        (_, _), r = cv2.minEnclosingCircle(c)
        out.append((M['m10'] / M['m00'], M['m01'] / M['m00'], a, min(1.0, a / max(np.pi * r * r, 1))))
    return out


def detect(hsv, board, piece, search, min_area, max_area, board_mask):
    """Best blob for one piece -> (px, (x_in, y_in, conf)) or None.
    Keep: loose thresholds near `search` (x, y, radius). Acquire: strict thresholds anywhere on the board."""
    cands = []
    if search is not None:
        sx, sy, rad = search
        m = color_mask(hsv, loosen(piece['lo']), piece['hi']) & board_mask
        for cx, cy, a, fill in blobs(m, min_area * 0.6, max_area):
            bx, by = board.to_board([[cx, cy]])[0]
            d = float(np.hypot(bx - sx, by - sy))
            if d <= rad:
                cands.append((d, cx, cy, bx, by, a, fill))
        if cands:
            _, cx, cy, bx, by, a, fill = min(cands)          # nearest to last position
            return (cx, cy), (float(bx), float(by), _conf(a, fill, min_area))
    m = color_mask(hsv, piece['lo'], piece['hi']) & board_mask
    bl = blobs(m, min_area, max_area)
    if not bl:
        return None
    cx, cy, a, fill = max(bl, key=lambda b: b[2])
    bx, by = board.to_board([[cx, cy]])[0]
    return (cx, cy), (float(bx), float(by), _conf(a, fill, min_area))


def _conf(area, fill, min_area):
    return float(min(1.0, area / (3 * min_area)) * (0.5 + 0.5 * fill))


def learn_color(hsv, piece, x, y):
    patch = hsv[max(0, y - 5):y + 6, max(0, x - 5):x + 6].reshape(-1, 3).astype(int)
    ang = patch[:, 0] * np.pi / 90                       # circular mean, so red near 0/179 averages correctly
    h = int(round(np.arctan2(np.sin(ang).mean(), np.cos(ang).mean()) * 90 / np.pi)) % 180
    s = int(np.percentile(patch[:, 1], 20)); v = int(np.percentile(patch[:, 2], 20))
    piece['lo'] = [(h - 10) % 180, max(40, s - 40), max(40, v - 50)]
    piece['hi'] = [(h + 10) % 180, 255, 255]
    print(f"Learned {piece['name']}: hue {h}, min saturation {piece['lo'][1]}")


def draw_grid(view, board):
    """Grid lines and A-H / 1-6 labels on the padded camera view."""
    P = lambda p: (int(p[0] + PAD), int(p[1] + PAD))
    bw, bh = board.board_in; cols, rows = board.grid
    cw, ch = board.cell_in
    for i in range(cols + 1):
        a, b = board.to_camera([[i * cw, 0], [i * cw, bh]])
        edge = i in (0, cols)
        cv2.line(view, P(a), P(b), (0, 200, 255) if edge else (200, 200, 200), 2 if edge else 1, cv2.LINE_AA)
    for j in range(rows + 1):
        a, b = board.to_camera([[0, j * ch], [bw, j * ch]])
        edge = j in (0, rows)
        cv2.line(view, P(a), P(b), (0, 200, 255) if edge else (200, 200, 200), 2 if edge else 1, cv2.LINE_AA)
    for i in range(cols):
        p = board.to_camera([[(i + .5) * cw, ch * .12]])[0]
        cv2.putText(view, chr(65 + i), P(p), cv2.FONT_HERSHEY_SIMPLEX, .6, (90, 90, 90), 2, cv2.LINE_AA)
    for j in range(rows):
        p = board.to_camera([[cw * .08, (j + .5) * ch]])[0]
        cv2.putText(view, str(j + 1), P(p), cv2.FONT_HERSHEY_SIMPLEX, .6, (90, 90, 90), 2, cv2.LINE_AA)


def draw_top(frame, board, pieces, colors):
    """Top-down warped view with the tracked pieces."""
    bw, bh = board.board_in; cols, rows = board.grid; cw, ch = board.cell_in
    s = TOP_W / bw
    top = cv2.warpPerspective(frame, np.float32([[s, 0, 0], [0, s, 0], [0, 0, 1]]) @ board.Hdraw, (TOP_W, int(TOP_W * bh / bw)))
    for i in range(1, cols):
        cv2.line(top, (int(i * cw * s), 0), (int(i * cw * s), top.shape[0]), (180, 180, 180), 1)
    for j in range(1, rows):
        cv2.line(top, (0, int(j * ch * s)), (TOP_W, int(j * ch * s)), (180, 180, 180), 1)
    for name, r in pieces.items():
        col = colors.get(name, (255, 255, 255))
        cx, cy = int(r['x_in'] * s), int(r['y_in'] * s)
        if r['state'] == 'lost':
            continue
        cv2.rectangle(top, (int(r['col'] * cw * s), int(r['row'] * ch * s)), (int((r['col'] + 1) * cw * s), int((r['row'] + 1) * ch * s)), col, 3)
        cv2.circle(top, (cx, cy), 10, col, -1, cv2.LINE_AA)
        cv2.putText(top, f"{name} {r['cell']}", (cx + 14, cy + 6), cv2.FONT_HERSHEY_SIMPLEX, .6, (20, 20, 20), 2, cv2.LINE_AA)
    return top


def parse_dims(s, cast):
    return [cast(v) for v in s.lower().split('x')] if s else None


def main():
    sys.stdout.reconfigure(line_buffering=True)   # events show up in log files immediately
    ap = argparse.ArgumentParser()
    ap.add_argument('--camera', default='HD USB Camera', help='camera name, or an index')
    ap.add_argument('--grid', help='columns x rows, e.g. 8x6')
    ap.add_argument('--board', help='board size in inches, e.g. 48x36')
    ap.add_argument('--pieces', choices=list(PIECE_SETS), default='magnets', help='magnets (blue/purple), purple_black, or leds (green/red)')
    ap.add_argument('--headless', action='store_true', help='no OpenCV windows (preview.jpg still written)')
    ap.add_argument('--exposure', type=float, default=8.3, help='exposure in ms (default 8.3)')
    ap.add_argument('--gain', type=int, default=0)
    ap.add_argument('--focus', type=int, default=None, help='focus-abs (default: leave as is)')
    ap.add_argument('--no-camset', action='store_true', help='do not touch UVC camera settings')
    args = ap.parse_args()
    headless = args.headless
    min_area, max_area = AREAS[args.pieces]

    board = Board({'pieces': PIECE_SETS[args.pieces]}, parse_dims(args.grid, int), parse_dims(args.board, float))
    if [p['name'] for p in board.cfg['pieces']] != [p['name'] for p in PIECE_SETS[args.pieces]]:
        board.cfg['pieces'] = PIECE_SETS[args.pieces]       # tracked pieces changed since the last save
    pieces_cfg = board.cfg['pieces']
    colors = {p['name']: tuple(p['draw']) for p in pieces_cfg}

    cam_name = cam.DEFAULT_NAME if args.camera.isdigit() else args.camera
    cap = cam.open_camera(cam_name, int(args.camera) if args.camera.isdigit() else 0)
    cam_info = cam.read_settings(cam_name) if args.no_camset else cam.apply_settings(args.exposure, args.gain, args.focus, cam_name)
    print(f'Camera settings: {cam_info}')
    ok, frame = cap.read()
    if not ok:
        raise SystemExit('Camera gave no frames. Is another program using it?')
    FH, FW = frame.shape[:2]

    feed = FeedSender('tracker:color')
    cmds = CommandReceiver()
    capturer = FrameCapturer()
    feed.capture = capturer
    preview = PreviewWriter()
    watch = cam.FpsWatchdog()
    tracker = PieceTracker(board.board_in, board.grid)
    state = {'mode': 'calibrate' if not board.calibrated and not headless else 'track', 'clicks': [], 'sample': None}
    hsv = None

    def on_mouse(event, x, y, flags, _):
        if event != cv2.EVENT_LBUTTONDOWN:
            return
        fx, fy = x / VIEW - PAD, y / VIEW - PAD      # display -> camera pixel coords
        if state['mode'] == 'calibrate':
            state['clicks'].append([fx, fy])
            if len(state['clicks']) == 4:
                board.set_corners(state['clicks'])
                state.update(clicks=[], mode='track')
                print('Corners saved to board.json')
        elif state['mode'] == 'sample' and 0 <= fx < FW and 0 <= fy < FH:
            state['sample_at'] = (int(fx), int(fy))

    if not headless:
        cv2.namedWindow('camera')
        cv2.setMouseCallback('camera', on_mouse)

    def learn(name, x, y):
        for p in pieces_cfg:
            if p['name'] == name and hsv is not None:
                learn_color(hsv, p, int(x), int(y))
                board.cfg['pieces'] = pieces_cfg
                board.save()
                return
        print(f'learn_color: unknown piece {name!r}')

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
            hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)

            # ---- commands
            for c in cmds.poll():
                name = c.get('cmd')
                if board.handle(c, frame):
                    tracker.set_grid(board.grid, board.board_in)
                elif capturer.handle(c):
                    pass
                elif name == 'learn_color':
                    try:
                        learn(c['piece'], c['x'], c['y'])
                    except (KeyError, TypeError, ValueError) as e:
                        print(f'bad learn_color: {e}')
                elif name == 'camera':
                    cam_info = cam.apply_settings(c.get('exposure_ms', cam_info.get('exposure_ms') or args.exposure),
                                                  c.get('gain', cam_info.get('gain') or 0), c.get('focus'), cam_name)
                    print(f'Camera settings: {cam_info}')
                elif name == 'learn_background':
                    print('learn_background: not needed for the color tracker (no-op)')
                else:
                    print(f'unknown command: {c}')
            if state.get('sample_at'):
                x, y = state.pop('sample_at')
                learn(pieces_cfg[state['sample']]['name'], x, y)
                state['mode'] = 'track'
            capturer.tick(frame, now)
            board.tick_auto(frame, now)

            # ---- detect
            dets, px_of = {}, {}
            if board.calibrated and state['mode'] != 'calibrate':
                bmask = board.mask(frame.shape)
                for piece in pieces_cfg:
                    r = detect(hsv, board, piece, tracker.search(piece['name']), min_area, max_area, bmask)
                    if r:
                        px_of[piece['name']], dets[piece['name']] = r
            pieces, events = tracker.update(dets, now)
            for e in events:
                print(f"{time.strftime('%H:%M:%S', time.localtime(e['t']))} {e['type']:>6} {e['piece']:>7} "
                      f"{e['cell']}" + (f" (from {e['from']})" if e['from'] else '') + (' [jump]' if e['jump'] else ''))
            feed.send(board, fps, cam_info, pieces, events, now)

            # ---- view (window and/or preview)
            if not headless or preview.due(now):
                view = cv2.copyMakeBorder(frame, PAD, PAD, PAD, PAD, cv2.BORDER_CONSTANT, value=(24, 24, 24))
                if board.calibrated and state['mode'] != 'calibrate':
                    draw_grid(view, board)
                    for name, px in px_of.items():
                        cv2.circle(view, (int(px[0] + PAD), int(px[1] + PAD)), 22, colors[name], 3, cv2.LINE_AA)
                    for name, r in pieces.items():
                        bp = board.to_camera([[r['x_in'], r['y_in']]])[0]
                        col = (80, 80, 255) if r['state'] == 'lost' else colors[name]
                        cv2.putText(view, f"{name} {r['cell']}" + ('' if r['state'] == 'tracked' else f" ({r['state']})"),
                                    (int(bp[0] + PAD) + 28, int(bp[1] + PAD) + 8), cv2.FONT_HERSHEY_SIMPLEX, .9, col, 2, cv2.LINE_AA)
                if state['mode'] == 'calibrate':
                    for p in state['clicks']:
                        cv2.circle(view, (int(p[0] + PAD), int(p[1] + PAD)), 10, (0, 200, 255), -1)
                    msg = f"Click the board's {CORNER_NAMES[len(state['clicks'])]} corner  ({len(state['clicks']) + 1}/4)"
                elif state['mode'] == 'sample':
                    msg = f"Click the {pieces_cfg[state['sample']]['name']} piece to learn its color"
                elif not board.calibrated:
                    msg = 'Not calibrated: waiting for corners'
                else:
                    msg = f"{fps:4.1f} fps   " + '   '.join(f"{n}: {r['cell']}" for n, r in pieces.items()) + (
                        '   BUMPED' if board.bumped else '') + "     c: corners   1/2: relearn color   q: quit"
                cv2.putText(view, msg, (20, 60), cv2.FONT_HERSHEY_SIMPLEX, 1.4, (0, 0, 0), 6, cv2.LINE_AA)
                cv2.putText(view, msg, (20, 60), cv2.FONT_HERSHEY_SIMPLEX, 1.4, (255, 255, 255), 2, cv2.LINE_AA)
                if preview.due(now):
                    preview.write(view, PAD, FW, FH, now)
                if not headless:
                    if board.calibrated and state['mode'] != 'calibrate':
                        cv2.imshow('top-down', draw_top(frame, board, pieces, colors))
                    cv2.imshow('camera', cv2.resize(view, None, fx=VIEW, fy=VIEW, interpolation=cv2.INTER_AREA))
                    k = cv2.waitKey(1) & 0xFF
                    if k == ord('q'):
                        break
                    if k == ord('c'):
                        state.update(mode='calibrate', clicks=[])
                    if k in (ord('1'), ord('2')) and int(chr(k)) <= len(pieces_cfg):
                        state.update(mode='sample', sample=int(chr(k)) - 1)
    except KeyboardInterrupt:
        pass
    finally:
        cap.release()
        cv2.destroyAllWindows()


if __name__ == '__main__':
    main()
