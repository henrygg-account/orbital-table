"""Open the overhead camera by name, apply UVC settings, and watch the frame rate."""
import re, subprocess, time
from pathlib import Path
import cv2

HERE = Path(__file__).parent
UVC = str(HERE / 'uvc-util')
FFMPEG = '/opt/homebrew/bin/ffmpeg'
DEFAULT_NAME = 'HD USB Camera'


def find_index(name=DEFAULT_NAME, fallback=0):
    """Map a camera name to its AVFoundation index (same order OpenCV uses)."""
    try:
        r = subprocess.run([FFMPEG, '-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''],
                           capture_output=True, text=True, timeout=10)
        for line in r.stderr.splitlines():
            if 'audio devices' in line:
                break                                   # video devices are listed first
            m = re.search(r'\[(\d+)\]\s+(.*)$', line)
            if m and name.lower() in m.group(2).lower():
                return int(m.group(1))
    except Exception as e:
        print(f'camera: ffmpeg device lookup failed ({e}); using index {fallback}')
    return fallback


def open_camera(name=DEFAULT_NAME, fallback_index=0):
    """Open `name` at 1920x1080 @ 25 fps. Returns cv2.VideoCapture."""
    cap = cv2.VideoCapture(find_index(name, fallback_index), cv2.CAP_AVFOUNDATION)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1920)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 1080)
    cap.set(cv2.CAP_PROP_FPS, 25)
    return cap


def _uvc(*args):
    r = subprocess.run([UVC, *args], capture_output=True, text=True, timeout=8)
    return r.returncode == 0, r.stdout


def _uvc_index(name):
    """Device index from `uvc-util -d` (None if not found)."""
    ok, out = _uvc('-d')
    for line in out.splitlines():
        m = re.match(r'\s*(\d+)\s+0x\S+\s+0x\S+\s+\S+\s+(.*)$', line)
        if m and name.lower() in m.group(2).lower():
            return int(m.group(1))
    return None


def read_settings(name=DEFAULT_NAME):
    """Read back exposure/gain/focus. Returns the camera-info dict (ok False on failure)."""
    info = {'name': name, 'ok': False, 'exposure_ms': None, 'gain': None, 'focus': None}
    try:
        idx = _uvc_index(name)
        if idx is None:
            return info
        vals = {}
        for ctl in ('exposure-time-abs', 'gain', 'focus-abs'):
            ok, out = _uvc('-I', str(idx), '-g', ctl)
            m = re.search(r'=\s*(-?\d+)', out)
            if ok and m:
                vals[ctl] = int(m.group(1))
        if 'exposure-time-abs' in vals:
            info['exposure_ms'] = round(vals['exposure-time-abs'] / 10, 2)
        info['gain'] = vals.get('gain')
        info['focus'] = vals.get('focus-abs')
        info['ok'] = len(vals) == 3
    except Exception as e:
        print(f'camera: uvc-util read failed ({e})')
    return info


def apply_settings(exposure_ms=8.3, gain=0, focus=None, name=DEFAULT_NAME):
    """Lock manual exposure/gain (and optionally focus) via uvc-util. Never raises."""
    info = {'name': name, 'ok': False, 'exposure_ms': None, 'gain': None, 'focus': None}
    try:
        idx = _uvc_index(name)
        if idx is None:
            print('camera: uvc-util could not find the camera; settings not applied')
            return info
        args = ['-I', str(idx), '-s', 'auto-exposure-mode=1']
        if exposure_ms is not None:
            args += ['-s', f'exposure-time-abs={int(round(exposure_ms * 10))}']
        if gain is not None:
            args += ['-s', f'gain={int(gain)}']
        args += ['-s', 'power-line-frequency=2', '-s', 'auto-white-balance-temp=false', '-s', 'auto-focus=false']
        if focus is not None:
            args += ['-s', f'focus-abs={int(focus)}']
        ok, _ = _uvc(*args)
        if not ok:
            print('camera: uvc-util set failed')
        info = read_settings(name)
        info['ok'] = info['ok'] and ok
    except Exception as e:
        print(f'camera: apply_settings failed ({e})')
    return info


class FpsWatchdog:
    """Rolling fps over the last ~2 s; prints a warning if fps < 20 for more than 3 s."""
    def __init__(self, min_fps=20.0, grace=3.0, window=2.0):
        self.min_fps, self.grace, self.window = min_fps, grace, window
        self.times, self.fps, self.low_since, self.warned = [], 0.0, None, False

    def tick(self, now=None):
        """Call once per frame; returns the current fps."""
        now = time.time() if now is None else now
        self.times.append(now)
        while self.times and now - self.times[0] > self.window:
            self.times.pop(0)
        if len(self.times) > 2:
            self.fps = (len(self.times) - 1) / max(self.times[-1] - self.times[0], 1e-6)
        if self.fps and self.fps < self.min_fps:
            self.low_since = self.low_since or now
            if now - self.low_since > self.grace and not self.warned:
                print(f'WARNING: camera fps {self.fps:.1f} < {self.min_fps:g} for {now - self.low_since:.0f}s '
                      '(is another program using the camera?)')
                self.warned = True
        else:
            self.low_since, self.warned = None, False
        return self.fps
