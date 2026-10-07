"""Bridge the tracker's UDP feed to the web pages.

Run:  ../.venv/bin/python orbit_server.py      then open http://localhost:8765
  /          orbit demo            /control   operator panel
  /events    SSE: latest feed ~30 Hz + every UDP `events` entry exactly once per client
  /status    JSON: latest feed + age + uptime + SSE client count
  /preview.jpg, /preview.json   from ../run/
  POST /cmd  JSON {"cmd": ...} relayed as UDP to 127.0.0.1:5006
Standard library only.
"""
import json, socket, threading, time
from collections import deque
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path

HERE = Path(__file__).resolve().parent
RUN = (HERE.parent / 'run').resolve()
START = time.time()
latest = {}
clients = []             # per-client event queues (deque)
lock = threading.Lock()
cmd_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)


def udp_listener():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(('127.0.0.1', 5005))
    while True:
        try:
            data, _ = s.recvfrom(65536)
            msg = json.loads(data)
            if not isinstance(msg, dict):
                continue
        except Exception:
            continue
        msg['recv'] = time.time()
        evs = msg.get('events')
        with lock:
            latest.clear(); latest.update(msg)
            if isinstance(evs, list) and evs:
                for q in clients:
                    q.extend(evs)


def snapshot():
    with lock:
        return dict(latest)


def with_age(msg):
    r = msg.get('recv')
    msg['age'] = round(time.time() - r, 3) if r else None
    return msg


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code, obj):
        self._send(code, json.dumps(obj).encode(), 'application/json')

    def _file(self, path, ctype):
        try:
            body = path.read_bytes()
        except OSError:
            return self._json(404, {'ok': False, 'error': 'not found'})
        self._send(200, body, ctype)

    def do_GET(self):
        try:
            p = self.path.split('?', 1)[0]
            if p in ('/', '/index.html'):
                self._file(HERE / 'index.html', 'text/html; charset=utf-8')
            elif p in ('/control', '/control.html'):
                self._file(HERE / 'control.html', 'text/html; charset=utf-8')
            elif p == '/preview.jpg':
                self._file(RUN / 'preview.jpg', 'image/jpeg')
            elif p == '/preview.mjpg':
                self.mjpeg()
            elif p == '/preview.json':
                self._file(RUN / 'preview.json', 'application/json')
            elif p == '/status':
                st = with_age(snapshot())
                with lock:
                    n = len(clients)
                self._json(200, {'feed': st, 'age': st['age'], 'uptime': round(time.time() - START, 1), 'clients': n,
                                 **{k: v for k, v in st.items() if k not in ('age',)}})
            elif p == '/events':
                self.sse()
            else:
                self._json(404, {'ok': False, 'error': 'not found'})
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            self.close_connection = True

    def do_POST(self):
        try:
            if self.path.split('?', 1)[0] != '/cmd':
                return self._json(404, {'ok': False, 'error': 'not found'})
            n = int(self.headers.get('Content-Length') or 0)
            if n <= 0 or n > 65536:
                return self._json(400, {'ok': False, 'error': 'bad length'})
            try:
                obj = json.loads(self.rfile.read(n))
            except ValueError:
                return self._json(400, {'ok': False, 'error': 'bad json'})
            if not isinstance(obj, dict) or not isinstance(obj.get('cmd'), str) or not obj['cmd']:
                return self._json(400, {'ok': False, 'error': 'missing cmd'})
            cmd_sock.sendto(json.dumps(obj).encode(), ('127.0.0.1', 5006))
            self._json(200, {'ok': True})
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            self.close_connection = True

    def mjpeg(self):
        """Stream run/preview.jpg as multipart MJPEG, sending each new frame once."""
        self.close_connection = True
        try:
            self.send_response(200)
            self.send_header('Content-Type', 'multipart/x-mixed-replace; boundary=frame')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Connection', 'close')
            self.end_headers()
            last = None
            while True:
                try:
                    m = (RUN / 'preview.jpg').stat().st_mtime_ns
                    if m != last:
                        body = (RUN / 'preview.jpg').read_bytes()
                        last = m
                        self.wfile.write(b'--frame\r\nContent-Type: image/jpeg\r\nContent-Length: '
                                         + str(len(body)).encode() + b'\r\n\r\n' + body + b'\r\n')
                        self.wfile.flush()
                except FileNotFoundError:
                    pass
                time.sleep(0.015)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            pass

    def sse(self):
        q = deque(maxlen=2000)
        with lock:
            clients.append(q)
        self.close_connection = True
        try:
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Connection', 'close')
            self.end_headers()
            while True:
                with lock:
                    msg = dict(latest)
                    evs = list(q); q.clear()
                # `events` here = events queued since last tick (each delivered exactly once)
                msg['events'] = evs
                with_age(msg)
                self.wfile.write(f'data: {json.dumps(msg)}\n\n'.encode())
                self.wfile.flush()
                time.sleep(1 / 30)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            pass
        finally:
            with lock:
                if q in clients:
                    clients.remove(q)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def handle_error(self, request, client_address):
        pass


if __name__ == '__main__':
    threading.Thread(target=udp_listener, daemon=True).start()
    print('Orbit demo: http://localhost:8765  control: /control  (tracker feed UDP 5005, commands UDP 5006)')
    Server(('127.0.0.1', 8765), Handler).serve_forever()
