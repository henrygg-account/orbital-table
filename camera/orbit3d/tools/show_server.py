"""The pages plus live.py's show state, without the camera: the phone remote (presenter.html) drives the laptop demo.

Serves this folder on the network (the phone loads presenter.html from it), /show (live.py's own show_update, so the same
validation; not saved to show.json) and /events (the show state only: no pieces, so the demo keeps its stand-ins with
?keepdemo). For trying the phone page and rehearsing without the table; live.py does all of this and the camera on the table.

  python tools/show_server.py [--port 8800]
  laptop: http://localhost:8800/demo.html?keepdemo      phone (same Wi-Fi): http://<laptop ip>:8800/presenter.html
"""
import argparse, json, socket, sys, time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PAGES = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PAGES.parent / 'training'))
import live   # show_update / show_get (importing it starts nothing)


class H(SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def end_headers(self):   # no caching, as live.py: a page that imports a module statically (vehicle.js) kept an old copy (Oct 26: reach did nothing)
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def _json(self, o):
        b = json.dumps(o).encode()
        self.send_response(200); self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)

    def do_GET(self):
        p = self.path.split('?')[0]
        if p == '/events':
            self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
            try:
                while True:
                    msg = {'t': time.time(), 'screen_mm': [1428.5, 803.5], 'calibrated': True, 'fps': 0, 'pieces': {}, 'hands': [], 'show': live.show_get()}
                    self.wfile.write(b'data: ' + json.dumps(msg).encode() + b'\n\n'); self.wfile.flush(); time.sleep(1 / 20)
            except OSError:
                pass
        elif p == '/show':
            self._json(live.show_get())
        elif p == '/calib.json':   # the phone's Recalibrate: there is no camera here
            self._json({'H': None, 'last': {'ok': False, 'error': 'no camera (show_server.py): recalibrate on the table', 't': time.time()}})
        else:
            super().do_GET()

    def do_POST(self):
        if self.path.split('?')[0] != '/show':
            return self.send_error(404)
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')
        self._json(live.show_update(body, save=False))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8800)
    a = ap.parse_args()
    srv = ThreadingHTTPServer(('0.0.0.0', a.port), partial(H, directory=str(PAGES)))
    srv.daemon_threads = True
    ips = sorted({i[4][0] for i in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)})
    print(f'laptop: http://localhost:{a.port}/demo.html?keepdemo', flush=True)
    for ip in ips:
        print(f'phone:  http://{ip}:{a.port}/presenter.html', flush=True)
    srv.serve_forever()


if __name__ == '__main__':
    main()
