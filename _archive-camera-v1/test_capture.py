"""Tests for FrameCapturer (run: .venv/bin/python test_capture.py)."""
import tempfile
from pathlib import Path
import numpy as np
from boardlib import FrameCapturer

def frame():
    return np.full((1080, 1920, 3), 120, np.uint8)

def test_single_capture():
    with tempfile.TemporaryDirectory() as d:
        c = FrameCapturer(Path(d) / 'raw')
        assert not c.tick(frame(), 10.0)                       # nothing requested
        assert c.handle({'cmd': 'capture'}) and c.tick(frame(), 10.0)
        assert not c.tick(frame(), 10.1)                       # once only
        c.flush()
        files = list((Path(d) / 'raw').glob('*.jpg'))
        assert len(files) == 1 and c.count == 1 and c.status() == {'auto': False, 'interval': 0.0, 'count': 1}
        import cv2
        assert cv2.imread(str(files[0])).shape == (1080, 1920, 3)

def test_auto_interval():
    with tempfile.TemporaryDirectory() as d:
        c = FrameCapturer(d)
        assert c.handle({'cmd': 'capture_auto', 'interval': 1.0}) and c.status()['auto']
        hits = [c.tick(frame(), 100 + i * 0.04) for i in range(75)]   # 3 s at 25 fps
        assert sum(hits) == 3 and hits[0]
        c.handle({'cmd': 'capture_auto', 'interval': 0})
        assert not c.status()['auto'] and not c.tick(frame(), 200.0)
        assert not c.handle({'cmd': 'camera'})

def test_drop_when_full_and_filename():
    c = FrameCapturer(tempfile.mkdtemp(), qsize=1)
    c._thread = object()                                       # no worker: queue fills
    assert c.submit(frame(), 1.0) and not c.submit(frame(), 2.0)
    assert FrameCapturer.filename(1790971279.8).endswith('-800.jpg')

for n, f in list(globals().items()):
    if n.startswith("test_"): f(); print("ok", n)
