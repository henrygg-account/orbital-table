"""The model in its own process (Windows, DirectML), so a GPU hang costs the table a frame, not a restart.

DirectML on the ThinkPad's Radeon sometimes stops answering mid-predict (DXGI 887A0006, "the GPU will not respond to more
commands": four times on Oct 27 alone, then four in two minutes). A new session in the same process falls back to the CPU,
so live.py used to exit and be restarted, losing the camera, the tracker and the pages' connection for 10-20 s each time.
Here the model runs in a worker process with a second one loaded and waiting: a failed or silent predict kills the worker
(TerminateProcess: a hung device's own teardown can block for hours), the spare takes the next frame, and a new spare loads.
The camera, server and tracker never notice beyond the frames that get no detections.

Frames go through shared memory (a 1280x960 crop is 2-3 MB: too much to pickle at 30 fps); results come back as plain lists.
"""
import multiprocessing as mp
import os
import time
from multiprocessing import shared_memory

import numpy as np

MAX_BYTES = 2048 * 1536 * 3     # the largest crop (the Arducam's biggest mode)
WAIT_S = 3.0                    # a predict takes 20-35 ms; one that has not answered in this long is a hung GPU
START_S = 90.0                  # a worker that is not loaded and warmed up in this long is killed and started again


def plain(r):
    """An ultralytics result as plain lists (what live.py's main loop reads), in the crop's pixels."""
    b = r.boxes
    polys = [p.astype(np.float32) for p in r.masks.xy] if getattr(r, 'masks', None) is not None else None
    return {'xyxy': b.xyxy.tolist(), 'cls': b.cls.int().tolist(), 'conf': b.conf.tolist(), 'polys': polys,
            'speed': dict(r.speed)}


def _serve(conn, shm_name, weights, task, warm_hw):
    os.environ.setdefault('YOLO_AUTOINSTALL', 'false')
    from live import use_directml
    use_directml()
    from ultralytics import YOLO
    model = YOLO(weights, task=task)
    model.predict(np.zeros((*warm_hw, 3), np.uint8), verbose=False)          # loads the session and compiles the graph
    try:
        prov = model.predictor.model.session.get_providers()
    except AttributeError:
        prov = []
    shm = shared_memory.SharedMemory(name=shm_name)
    conn.send(('ready', {'names': model.names, 'providers': prov}))
    try:
        while True:
            msg = conn.recv()                                                   # (EOF when live.py is gone: exit with it)
            if msg is None:
                break
            shape, imgsz, conf = msg
            img = np.ndarray(shape, np.uint8, shm.buf)
            try:
                r = model.predict(img, imgsz=imgsz, conf=conf, agnostic_nms=True, verbose=False)[0]   # one class per object
            except Exception as e:
                conn.send(('error', str(e).strip().splitlines()[-1][-160:]))
                break
            del img
            conn.send(('ok', plain(r)))
    except (EOFError, OSError):
        pass
    if os.name == 'nt':                 # skip the (possibly hung) device's teardown
        import ctypes
        k32 = ctypes.windll.kernel32
        k32.TerminateProcess(ctypes.c_void_p(k32.GetCurrentProcess()), 0)
    os._exit(0)


class _Worker:
    def __init__(self, ctx, shm_name, weights, task, warm_hw):
        self.conn, child = ctx.Pipe()
        self.proc = ctx.Process(target=_serve, args=(child, shm_name, weights, task, warm_hw), daemon=True)
        self.proc.start()
        child.close()
        self.t0, self.info = time.time(), None

    def ready(self):
        try:
            if self.info is None and self.conn.poll(0):
                kind, val = self.conn.recv()
                self.info = val if kind == 'ready' else None
        except (EOFError, OSError):     # (a worker that died while loading)
            pass
        return self.info is not None

    def dead(self):
        return not self.proc.is_alive() or (self.info is None and time.time() - self.t0 > START_S)

    def kill(self):
        try:
            self.proc.kill()            # TerminateProcess on Windows
        except Exception:
            pass
        self.conn.close()


class ModelWorkers:
    """predict(crop, imgsz, conf) -> plain() dict, or None while no worker is ready (that frame gets no detections)."""

    def __init__(self, weights, task, warm_hw=(512, 736), log=print):
        self.ctx = mp.get_context('spawn')
        self.shm = shared_memory.SharedMemory(create=True, size=MAX_BYTES)
        self.args = (self.shm.name, weights, task, warm_hw)
        self.log, self.fails = log, 0
        self.cur, self.spare = self._new(), None
        self.names, self.providers = None, []

    def _new(self):
        return _Worker(self.ctx, *self.args)

    def wait_ready(self, timeout=START_S):
        t = time.time()
        while not self.cur.ready():
            if self.cur.dead() or time.time() - t > timeout:
                raise RuntimeError('the model worker did not start')
            time.sleep(0.05)
        self._took(self.cur)

    def _took(self, w):
        self.names, self.providers = w.info['names'], w.info['providers']

    def _fail(self, why):
        self.fails += 1
        if self.spare and self.spare.dead():
            self.spare.kill(); self.spare = None
        self.log(f'{time.strftime("%H:%M:%S")} model failed ({why}): worker replaced'
                 f'{" by the spare" if self.spare and self.spare.ready() else ", a new one loading"} ({self.fails} so far)')
        self.cur.kill()
        self.cur, self.spare = (self.spare, None) if self.spare else (self._new(), None)

    def predict(self, img, imgsz, conf):
        if self.spare is None and self.cur.ready():
            self.spare = self._new()    # loaded and waiting, after the current one is up (both at once: twice the start-up)
        elif self.spare is not None and self.spare.dead():
            self.spare.kill(); self.spare = self._new()
        if not self.cur.ready():
            if self.cur.dead():
                self._fail('the worker did not start')
            return None
        if self.names is None or self.cur.info['names'] is not self.names:
            self._took(self.cur)
        if img.nbytes > MAX_BYTES:
            raise ValueError(f'crop {img.shape} is larger than the shared frame buffer')
        np.ndarray(img.shape, np.uint8, self.shm.buf)[:] = img
        try:
            self.cur.conn.send((img.shape, imgsz, conf))
            if not self.cur.conn.poll(WAIT_S):
                self._fail(f'no answer in {WAIT_S:.0f} s')
                return None
            kind, val = self.cur.conn.recv()
        except (EOFError, OSError, BrokenPipeError) as e:
            self._fail(f'worker gone: {e!r}'[:120])
            return None
        if kind != 'ok':
            self._fail(val)
            return None
        return val

    def close(self):
        for w in (self.cur, self.spare):
            if w:
                w.kill()
        try:
            self.shm.close(); self.shm.unlink()
        except Exception:
            pass
