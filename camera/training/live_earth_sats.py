"""Saved demo (Oct 2): Earth + two satellites on the stand-in pieces. Run: python live_earth_sats.py

  python live.py [--weights runs/yolo11s-960/weights/best.pt] [--index N] [--conf 0.4] [--port 8780]

Keys: q quits, s saves the current frame to data/raw (to add to training later).
Also serves the 3D orbit demo at http://localhost:8780 (../orbit3d/index.html), fed by
/events: SSE of {"t", "fps", "frame": [w, h], "pieces": {name: {"u", "v", "conf", "seen_ago"}}}
where u, v are 0-1 fractions of the camera frame (x right, y down) at each piece's last sighting.
"""
import argparse, json, threading, time, webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import cv2
from ultralytics import YOLO

HERE = Path(__file__).parent
COLORS = {'ball': (60, 230, 230), 'tape': (0, 200, 255), 'marker': (60, 60, 240)}
PAGE = HERE.parent / 'orbit3d' / 'earth-sats.html'   # saved version: Earth = tape, satellites = ball/marker
state = {'fps': 0.0, 'frame': [1920, 1080], 'seen': {}}   # seen: name -> (u, v, conf, time)
lock = threading.Lock()


def snapshot():
    now = time.time()
    with lock:
        return {'t': now, 'fps': round(state['fps'], 1), 'frame': state['frame'],
                'pieces': {n: {'u': round(u, 4), 'v': round(v, 4), 'conf': round(c, 2), 'seen_ago': round(now - t, 2)}
                           for n, (u, v, c, t) in state['seen'].items()}}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

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
            elif path in ('/', '/index.html'):
                body = PAGE.read_bytes()
                self.send_response(200)
                self.send_header('Content-Type', 'text/html; charset=utf-8'); self.send_header('Cache-Control', 'no-store')
                self.send_header('Content-Length', str(len(body))); self.end_headers()
                self.wfile.write(body)
            else:
                self.send_error(404)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass


def serve(port):
    srv = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()


def find_iphone():
    """OpenCV index of the iPhone (Continuity Camera). OpenCV's numbering differs from ffmpeg's,
    so identify it by its 4:3 1920x1440 mode, which Mac webcams don't offer."""
    for i in range(4):
        c = cv2.VideoCapture(i, cv2.CAP_AVFOUNDATION)
        if not c.isOpened():
            break
        c.set(cv2.CAP_PROP_FRAME_WIDTH, 1920); c.set(cv2.CAP_PROP_FRAME_HEIGHT, 1440)
        for _ in range(3):   # the first frames can arrive before the mode switch
            ok, f = c.read()
        c.release()
        if ok and f.shape[:2] == (1440, 1920):
            return i
    raise SystemExit('iPhone camera not found: is it nearby, locked and on the same Apple ID?')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--weights', default=str(HERE / 'runs/yolo11s-960/weights/best.pt'))
    ap.add_argument('--index', type=int, help='OpenCV camera index (default: find the iPhone)')
    ap.add_argument('--conf', type=float, default=0.4)
    ap.add_argument('--imgsz', type=int, default=960)
    ap.add_argument('--port', type=int, default=8780)
    ap.add_argument('--no-browser', action='store_true')
    a = ap.parse_args()
    serve(a.port)

    idx = a.index if a.index is not None else find_iphone()
    dev = f'camera {idx}'
    cap = cv2.VideoCapture(idx, cv2.CAP_AVFOUNDATION)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1920); cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 1080)
    if not cap.isOpened():
        raise SystemExit(f'could not open {dev}')
    model = YOLO(a.weights)
    print(f'{dev} -> {a.weights}   (q quit, s save frame)   orbit demo: http://localhost:{a.port}')
    if not a.no_browser:
        webbrowser.open(f'http://localhost:{a.port}')

    fps, last, ms = 0.0, time.time(), 0.0
    while True:
        ok, frame = cap.read()
        if not ok:
            continue
        t0 = time.time()
        r = model.predict(frame, imgsz=a.imgsz, conf=a.conf, device='mps', verbose=False)[0]
        ms = 0.9 * ms + 0.1 * (time.time() - t0) * 1000
        # best box per class: each piece exists once
        best = {}
        for (x1, y1, x2, y2), c, s in zip(r.boxes.xyxy.tolist(), r.boxes.cls.int().tolist(), r.boxes.conf.tolist()):
            if c not in best or s > best[c][1]:
                best[c] = ((int(x1), int(y1), int(x2), int(y2)), s)
        H, W = frame.shape[:2]
        with lock:
            state['frame'] = [W, H]
            for c, ((x1, y1, x2, y2), sc) in best.items():
                state['seen'][r.names[c]] = ((x1 + x2) / 2 / W, (y1 + y2) / 2 / H, sc, time.time())
        view = frame.copy()
        for c, ((x1, y1, x2, y2), s) in best.items():
            name = r.names[c]; col = COLORS.get(name, (255, 255, 255))
            cv2.rectangle(view, (x1, y1), (x2, y2), col, 4)
            cv2.circle(view, ((x1 + x2) // 2, (y1 + y2) // 2), 6, col, -1)
            cv2.putText(view, f'{name} {s:.2f}', (x1, max(30, y1 - 12)), cv2.FONT_HERSHEY_SIMPLEX, 1.3, col, 3)
        now = time.time(); fps = 0.9 * fps + 0.1 / max(1e-3, now - last); last = now
        state['fps'] = fps
        cv2.putText(view, f'{fps:4.1f} fps  model {ms:4.0f} ms', (20, 50), cv2.FONT_HERSHEY_SIMPLEX, 1.4, (255, 0, 255), 3)
        cv2.imshow('pieces', cv2.resize(view, (1280, 720)))
        k = cv2.waitKey(1) & 0xFF
        if k == ord('q'):
            break
        if k == ord('s'):
            p = HERE / 'data/raw' / f'live_{time.strftime("%Y%m%d-%H%M%S")}.jpg'
            cv2.imwrite(str(p), frame, [cv2.IMWRITE_JPEG_QUALITY, 95]); print('saved', p.name)


if __name__ == '__main__':
    main()
