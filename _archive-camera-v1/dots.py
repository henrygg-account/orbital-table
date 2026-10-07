"""Identify pieces by how many bright dots they carry (1, 2 or 3) and report their grid cell.

Run:  .venv/bin/python dots.py [--camera NAME|INDEX] [--grid 8x6] [--board 48x36] [--headless]
                               [--threshold 235] [--min-dot 6] [--max-dot 800] [--cluster 2.0]
                               [--exposure 8.3] [--gain 0] [--focus N] [--no-camset]

Uses the board corners saved in board.json (tracker.py / orbit control panel). Each piece is a cluster of
bright dots: dots closer than the cluster distance (inches) belong to the same piece, so keep a piece's
LEDs within ~1" of each other and pieces 3"+ apart. Piece names are dots1, dots2, dots3.

Keys:  b  learn background glare (press with no pieces on the board)
       c  recalibrate corners      q  quit
Windowed mode has trackbars for the settings; commands (SPEC) arrive on UDP 5006, including
{"cmd":"set_param","name":"threshold|min_dot|max_dot|cluster","value":N} and learn_background.
Every frame a v1 JSON message goes to UDP 127.0.0.1:5005 (source tracker:dots). Only events are printed.
"""
import argparse, sys, time
import cv2
import numpy as np
from boardlib import Board, PieceTracker, FeedSender, CommandReceiver, PreviewWriter, FrameCapturer
import camera as cam
import tracker as trk          # shared drawing helpers (grid, top-down view, PAD/VIEW)

NAMES = {1: 'dots1', 2: 'dots2', 3: 'dots3'}
COLORS = {'dots1': (60, 220, 60), 'dots2': (255, 160, 40), 'dots3': (40, 60, 255)}   # BGR
DEFAULTS = {'threshold': 235, 'min_dot': 6, 'max_dot': 800, 'cluster': 2.0}          # cluster in inches
ALIASES = {'min_dot_px': 'min_dot', 'max_dot_px': 'max_dot', 'cluster_in': 'cluster', 'cluster_distance': 'cluster'}
GLARE_MARGIN = 15  # background threshold sits this far below the detection threshold
TRACKBARS = [('threshold', 'threshold', 255, 1), ('min dot px', 'min_dot', 200, 1),
             ('max dot px', 'max_dot', 4000, 1), ('cluster x0.1in', 'cluster', 60, 0.1)]


def cluster(points, radius):
    """Group points (board inches) whose chain distance is under radius. Returns lists of indices (union-find)."""
    parent = list(range(len(points)))
    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]; i = parent[i]
        return i
    for i in range(len(points)):
        for j in range(i + 1, len(points)):
            if np.hypot(*(points[i] - points[j])) < radius:
                parent[find(i)] = find(j)
    groups = {}
    for i in range(len(points)):
        groups.setdefault(find(i), []).append(i)
    return list(groups.values())


def learn_background(frame, params):
    """Mask (uint8 255) of bright glare to ignore: slightly lower threshold, dilated."""
    _, bg = cv2.threshold(frame.max(axis=2), max(0, params['threshold'] - GLARE_MARGIN), 255, cv2.THRESH_BINARY)
    return cv2.dilate(bg, np.ones((9, 9), np.uint8))


def _conf(areas, spread, radius, min_dot):
    """Cluster consistency: similar dot sizes, tight spread, dots not barely above the size floor."""
    ratio = min(areas) / max(areas)
    return float(min(1.0, np.mean(areas) / (3 * min_dot)) * (0.5 + 0.5 * ratio) * (1 - 0.3 * min(spread / radius, 1)))


def detect_dots(frame, board, params, background=None, near=None, bmask=None):
    """Find dot clusters of size 1-3 in a BGR frame.
    Returns (dets, px_of, dots_px, mask): dets = {name: (x_in, y_in, conf)}, px_of = {name: dot pixels (k,2)}.
    `near` = {name: (x, y, radius)} (PieceTracker.search): the cluster nearest the last position wins,
    otherwise the most consistent cluster of that size."""
    bmask = board.mask(frame.shape) if bmask is None else bmask
    _, m = cv2.threshold(frame.max(axis=2), params['threshold'], 255, cv2.THRESH_BINARY)   # brightest channel: coloured LEDs count too
    m &= bmask
    if background is not None:
        m &= ~background
    n, _, stats, cents = cv2.connectedComponentsWithStats(m)
    keep = [i for i in range(1, n) if max(1, params['min_dot']) <= stats[i, 4] <= max(2, params['max_dot'])]
    dets, px_of = {}, {}
    if not keep:
        return dets, px_of, np.zeros((0, 2), np.float32), m
    dots_px = np.float32([cents[i] for i in keep])
    areas = np.float32([stats[i, 4] for i in keep])
    dots_in = board.to_board(dots_px)
    best = {}
    for g in cluster(dots_in, params['cluster']):
        k = len(g)
        if k not in NAMES:
            continue
        pts = dots_in[g]
        ctr = pts.mean(axis=0)
        spread = max((np.hypot(*(a - b)) for a in pts for b in pts), default=0.0)
        conf = _conf(areas[g], spread, params['cluster'], params['min_dot'])
        s = near.get(NAMES[k]) if near else None
        d = float(np.hypot(ctr[0] - s[0], ctr[1] - s[1])) if s else None
        key = (0, d) if s and d <= s[2] else (1, -conf)          # near the last position first, else most consistent
        if k not in best or key < best[k][0]:
            best[k] = (key, ctr, conf, dots_px[g])
    for k, (_, ctr, conf, px) in best.items():
        dets[NAMES[k]] = (float(ctr[0]), float(ctr[1]), conf)
        px_of[NAMES[k]] = px
    return dets, px_of, dots_px, m


def main():
    sys.stdout.reconfigure(line_buffering=True)
    ap = argparse.ArgumentParser()
    ap.add_argument('--camera', default='HD USB Camera', help='camera name, or an index')
    ap.add_argument('--grid', help='columns x rows, e.g. 8x6')
    ap.add_argument('--board', help='board size in inches, e.g. 48x36')
    ap.add_argument('--headless', action='store_true', help='no OpenCV windows (preview.jpg still written)')
    ap.add_argument('--threshold', type=int, default=DEFAULTS['threshold'], help='brightest-channel threshold (default 235)')
    ap.add_argument('--min-dot', type=int, default=DEFAULTS['min_dot'], help='min dot area px (default 6)')
    ap.add_argument('--max-dot', type=int, default=DEFAULTS['max_dot'], help='max dot area px (default 800)')
    ap.add_argument('--cluster', type=float, default=DEFAULTS['cluster'], help='cluster distance in inches (default 2.0)')
    ap.add_argument('--exposure', type=float, default=8.3, help='exposure in ms (default 8.3)')
    ap.add_argument('--gain', type=int, default=0)
    ap.add_argument('--focus', type=int, default=None, help='focus-abs (default: leave as is)')
    ap.add_argument('--no-camset', action='store_true', help='do not touch UVC camera settings')
    args = ap.parse_args()
    headless = args.headless
    params = {'threshold': args.threshold, 'min_dot': args.min_dot, 'max_dot': args.max_dot, 'cluster': args.cluster}

    board = Board(None, trk.parse_dims(args.grid, int), trk.parse_dims(args.board, float))
    cam_name = cam.DEFAULT_NAME if args.camera.isdigit() else args.camera
    cap = cam.open_camera(cam_name, int(args.camera) if args.camera.isdigit() else 0)
    cam_info = cam.read_settings(cam_name) if args.no_camset else cam.apply_settings(args.exposure, args.gain, args.focus, cam_name)
    print(f'Camera settings: {cam_info}')
    ok, frame = cap.read()
    if not ok:
        raise SystemExit('Camera gave no frames. Is another program using it?')
    FH, FW = frame.shape[:2]

    feed = FeedSender('tracker:dots')
    cmds = CommandReceiver()
    capturer = FrameCapturer()
    feed.capture = capturer
    preview = PreviewWriter()
    watch = cam.FpsWatchdog()
    tracker = PieceTracker(board.board_in, board.grid)
    state = {'mode': 'calibrate' if not board.calibrated and not headless else 'track', 'clicks': []}
    background = None
    PAD, VIEW = trk.PAD, trk.VIEW

    def on_mouse(event, x, y, flags, _):
        if event == cv2.EVENT_LBUTTONDOWN and state['mode'] == 'calibrate':
            state['clicks'].append([x / VIEW - PAD, y / VIEW - PAD])
            if len(state['clicks']) == 4:
                board.set_corners(state['clicks'])
                state.update(clicks=[], mode='track')
                print('Corners saved to board.json')

    if not headless:                       # trackbars only in windowed mode
        cv2.namedWindow('controls')
        cv2.resizeWindow('controls', 420, 200)
        for label, key, mx, scale in TRACKBARS:
            cv2.createTrackbar(label, 'controls', int(round(params[key] / scale)), mx, lambda v: None)
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
            if not headless:
                for label, key, _, scale in TRACKBARS:
                    params[key] = cv2.getTrackbarPos(label, 'controls') * scale if key == 'cluster' else cv2.getTrackbarPos(label, 'controls')
                params['cluster'] = max(params['cluster'], 0.1)

            # ---- commands
            for c in cmds.poll():
                name = c.get('cmd')
                if board.handle(c, frame):
                    tracker.set_grid(board.grid, board.board_in)
                elif capturer.handle(c):
                    pass
                elif name == 'learn_background':
                    background = learn_background(frame, params)
                    print(f'Background glare learned ({int(background.sum() / 255)} px ignored)')
                elif name == 'set_param':
                    key = ALIASES.get(c.get('name'), c.get('name'))
                    try:
                        if key not in params:
                            raise KeyError(key)
                        params[key] = float(c['value']) if key == 'cluster' else int(c['value'])
                        if not headless:
                            lab, _, _, scale = next(t for t in TRACKBARS if t[1] == key)
                            cv2.setTrackbarPos(lab, 'controls', int(round(params[key] / scale)))
                        print(f'{key} = {params[key]}')
                    except (KeyError, TypeError, ValueError) as e:
                        print(f'bad set_param: {e}')
                elif name == 'camera':
                    cam_info = cam.apply_settings(c.get('exposure_ms', cam_info.get('exposure_ms') or args.exposure),
                                                  c.get('gain', cam_info.get('gain') or 0), c.get('focus'), cam_name)
                    print(f'Camera settings: {cam_info}')
                else:
                    print(f'unknown command: {c}')
            capturer.tick(frame, now)
            board.tick_auto(frame, now)

            # ---- detect
            dets, px_of, dots_px, m = {}, {}, np.zeros((0, 2)), None
            if board.calibrated and state['mode'] != 'calibrate':
                near = {n: tracker.search(n) for n in NAMES.values()}
                dets, px_of, dots_px, m = detect_dots(frame, board, params, background, near)
            pieces, events = tracker.update(dets, now)
            for e in events:
                print(f"{time.strftime('%H:%M:%S', time.localtime(e['t']))} {e['type']:>6} {e['piece']:>6} "
                      f"{e['cell']}" + (f" (from {e['from']})" if e['from'] else '') + (' [jump]' if e['jump'] else ''))
            feed.send(board, fps, cam_info, pieces, events, now)

            # ---- view (window and/or preview)
            if not headless or preview.due(now):
                view = cv2.copyMakeBorder(frame, PAD, PAD, PAD, PAD, cv2.BORDER_CONSTANT, value=(24, 24, 24))
                if board.calibrated and state['mode'] != 'calibrate':
                    trk.draw_grid(view, board)
                    for d in dots_px:
                        cv2.circle(view, (int(d[0] + PAD), int(d[1] + PAD)), 9, (255, 255, 255), 2, cv2.LINE_AA)
                    for name, px in px_of.items():
                        col = COLORS[name]
                        cv2.circle(view, (int(px[:, 0].mean() + PAD), int(px[:, 1].mean() + PAD)), 40, col, 3, cv2.LINE_AA)
                        if len(px) > 1:
                            cv2.polylines(view, [np.int32(px + PAD)], len(px) > 2, col, 2, cv2.LINE_AA)
                    for name, r in pieces.items():
                        bp = board.to_camera([[r['x_in'], r['y_in']]])[0]
                        col = (80, 80, 255) if r['state'] == 'lost' else COLORS[name]
                        cv2.putText(view, f"{name} {r['cell']}" + ('' if r['state'] == 'tracked' else f" ({r['state']})"),
                                    (int(bp[0] + PAD) + 46, int(bp[1] + PAD) + 8), cv2.FONT_HERSHEY_SIMPLEX, .9, col, 2, cv2.LINE_AA)
                if state['mode'] == 'calibrate':
                    for p in state['clicks']:
                        cv2.circle(view, (int(p[0] + PAD), int(p[1] + PAD)), 10, (0, 200, 255), -1)
                    msg = f"Click the board's {trk.CORNER_NAMES[len(state['clicks'])]} corner  ({len(state['clicks']) + 1}/4)"
                elif not board.calibrated:
                    msg = 'Not calibrated: waiting for corners'
                else:
                    msg = f"{fps:4.1f} fps   {len(dots_px)} dots   " + '   '.join(f"{n}: {r['cell']}" for n, r in pieces.items()) + (
                        '   BUMPED' if board.bumped else '') + ('' if background is not None else '   b: learn glare') + "   c: corners   q: quit"
                cv2.putText(view, msg, (20, 60), cv2.FONT_HERSHEY_SIMPLEX, 1.3, (0, 0, 0), 6, cv2.LINE_AA)
                cv2.putText(view, msg, (20, 60), cv2.FONT_HERSHEY_SIMPLEX, 1.3, (255, 255, 255), 2, cv2.LINE_AA)
                if preview.due(now):
                    preview.write(view, PAD, FW, FH, now)
                if not headless:
                    if board.calibrated and state['mode'] != 'calibrate':
                        cv2.imshow('top-down', trk.draw_top(frame, board, pieces, COLORS))
                        cv2.imshow('dots mask', cv2.resize(m, None, fx=.35, fy=.35))
                    cv2.imshow('camera', cv2.resize(view, None, fx=VIEW, fy=VIEW, interpolation=cv2.INTER_AREA))
                    k = cv2.waitKey(1) & 0xFF
                    if k == ord('q'):
                        break
                    if k == ord('c'):
                        state.update(mode='calibrate', clicks=[])
                    if k == ord('b') and state['mode'] == 'track':
                        background = learn_background(frame, params)
                        print(f'Background glare learned ({int(background.sum() / 255)} px ignored)')
    except KeyboardInterrupt:
        pass
    finally:
        cap.release()
        cv2.destroyAllWindows()


if __name__ == '__main__':
    main()
