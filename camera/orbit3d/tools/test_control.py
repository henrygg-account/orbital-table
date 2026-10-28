"""Presenter control test: FREEZE, RESET, PAUSE and SEEK on the real page, against a stub live.py.

Serves this folder's pages plus a stub /events (pieces that move on request) and /show (live.py's own show_update, so its
validation is the real one), opens demo.html?testhook in headless Edge, and lets tools/test_control_drive.js check what the page
draws (the eased piece positions, the film clocks, the drawn-out transfer and the phone's path / engine picks). Prints one line per check; exit code 1 on a failure.

  python test_control.py [--port 8821] [--edge <msedge.exe>] [--profile <dir>]
"""
import argparse, json, math, shutil, subprocess, sys, tempfile, threading, time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
PAGES = HERE.parent
sys.path.insert(0, str(PAGES.parent / 'training'))
import live   # show_update / show_get: the real show-state validation (importing it starts nothing)

EDGE = r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
stub = {'move': True, 't0': time.time()}
result = {'data': None}
done = threading.Event()
progress = {'section': None}
T0 = time.time()


def s1_pos(now):
    """Seldon-1: sweeping to and fro while stub['move'], else parked (at stub['s1_at'] if given)."""
    if not stub['move']:
        x, y = stub.get('s1_at') or (350.0, 400.0)
        return float(x), float(y), 0.0
    ph = 2 * math.pi * (now - stub['t0']) / 6
    return 600 + 150 * math.sin(ph), 550.0, 150 * 2 * math.pi / 6 * math.cos(ph)


def feed_message():
    now = time.time(); x, y, vx = s1_pos(now)
    pc = lambda x, y, **k: {'x_mm': x, 'y_mm': y, 'seen_ago': 0, 'moving': False, 'vx': 0, 'vy': 0, **k}
    pieces = {'earth': pc(230, 400), 'moon': pc(1200, 400), 'seldon-1': pc(x, y, moving=stub['move'], vx=vx), 'seldon-2': pc(230, 200)}
    if stub.get('earth_only'):   # the table with just the Earth piece on it
        pieces = {'earth': pieces['earth']}
    for k in stub.get('drop', []):   # pieces taken off the table (e.g. Seldon-2, while it is the path's target)
        pieces.pop(k, None)
    return {'t': now, 'screen_mm': [1428.5, 803.5], 'calibrated': True, 'fps': 20, 'show': live.show_get(), 'pieces': pieces}


class H(SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, o, code=200):
        b = json.dumps(o).encode()
        self.send_response(code); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(b)))
        self.send_header('Cache-Control', 'no-store'); self.end_headers(); self.wfile.write(b)

    def _body(self):
        return json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')

    def do_GET(self):
        p = self.path.split('?')[0]
        if p == '/events':
            self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.send_header('Cache-Control', 'no-store'); self.end_headers()
            try:
                while not done.is_set():
                    self.wfile.write(b'data: ' + json.dumps(feed_message()).encode() + b'\n\n'); self.wfile.flush(); time.sleep(0.05)
            except OSError:
                pass
        elif p == '/show':
            self._json(live.show_get())
        elif p == '/stub':
            self._json({'s1': s1_pos(time.time())[:2], 'calibrations': stub.get('calibrations', 0)})
        elif p == '/demo.html':   # the page, with the driver script appended
            b = (PAGES / 'demo.html').read_text(encoding='utf-8').replace('</body>', '<script type="module" src="/tools/test_control_drive.js"></script></body>').encode()
            self.send_response(200); self.send_header('Content-Type', 'text/html; charset=utf-8'); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
        else:
            super().do_GET()

    def do_POST(self):
        p = self.path.split('?')[0]
        if p == '/show':
            self._json(live.show_update(self._body(), save=False))
        elif p == '/stub':
            stub.update(self._body()); self._json({'ok': True})
        elif p == '/progress':   # one line per section / check as it happens, so a stall shows where it is
            o = self._body(); t = time.time() - T0
            if 'section' in o: progress['section'] = o['section']; print('%5.0f s  -- %s' % (t, o['section']), flush=True)
            else: r = o['check']; print('%5.0f s  %s %s%s' % (t, 'ok  ' if r['ok'] else 'FAIL', r['name'], ' - ' + r['detail'] if r['detail'] else ''), flush=True)
            self._json({'ok': True})
        elif p == '/calibrate':   # the page's marker calibration (the phone's Recalibrate bumps show.calib)
            stub['calibrations'] = stub.get('calibrations', 0) + 1; self._body()
            self._json({'ok': True, 'markers_found': 5, 'rms_mm': 0.5})
        elif p == '/result':
            result['data'] = self._body(); self._json({'ok': True}); done.set()
        else:
            self.send_error(404)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8821)
    ap.add_argument('--edge', default=EDGE)
    ap.add_argument('--profile', default=None, help='browser profile dir (default: a fresh one per run, deleted after)')
    ap.add_argument('--timeout', type=int, default=240)
    a = ap.parse_args()
    # a fresh profile every run: a browser left over from an interrupted run keeps its profile, and a new launch on that
    # profile hands the page to the old (possibly hung) browser and exits, so the run waits for nothing
    tmp = None if a.profile else tempfile.mkdtemp(prefix='orbit-test-control-')
    a.profile = a.profile or tmp
    srv = ThreadingHTTPServer(('127.0.0.1', a.port), partial(H, directory=str(PAGES)))
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    edge = subprocess.Popen([a.edge, '--headless=new', f'--user-data-dir={a.profile}', '--window-size=640,400', '--use-angle=swiftshader',
                             '--enable-unsafe-swiftshader', '--no-first-run', '--autoplay-policy=no-user-gesture-required', f'http://127.0.0.1:{a.port}/demo.html?testhook'],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        finished = done.wait(a.timeout)
    finally:
        # only the browser this run started. By its profile, not its pid: Edge relaunches itself on start, so the pid's tree
        # misses the real browser, which then went on drawing the page in software for good (Oct 25: two of them took the
        # detector from 20 fps to 2)
        subprocess.run(['taskkill', '/F', '/T', '/PID', str(edge.pid)], capture_output=True)
        subprocess.run(['powershell', '-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"name='msedge.exe'\" | "
                        f"Where-Object {{ $_.CommandLine -like '*{a.profile}*' }} | ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force }}"],
                       capture_output=True)
        done.set(); srv.shutdown()
        if tmp: shutil.rmtree(tmp, ignore_errors=True)
    if not finished:
        print('FAIL: stalled for %d s in: %s' % (a.timeout, progress['section'] or 'loading the page (no WebGL, no network for three.js, or the driver crashed)')); return 1
    bad = sum(not r['ok'] for r in result['data'])   # (each check was printed as it came)
    print('%d checks, %d failed, %.0f s' % (len(result['data']), bad, time.time() - T0))
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
