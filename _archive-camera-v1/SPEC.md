# Overhead tracking system — shared spec (v1)

All work lives in `camera/` (this folder). Python: `camera/.venv/bin/python` (3.9, OpenCV 5, numpy).
Camera: "HD USB Camera" (UVC, VID 0x32e4 PID 0x8430). Fast mode = 1920x1080 @ 25 fps.
`./uvc-util` (built, in this folder) sets UVC controls: `./uvc-util -I 0 -s exposure-time-abs=83 ...`
(exposure in 0.1 ms units, 1–5000; gain 0–100; focus-abs 0–1023; auto-exposure-mode 1=manual 8=auto;
power-line-frequency 2=60 Hz; auto-focus / auto-white-balance-temp booleans). `./uvc-util -d` lists devices.
`./camset.sh [ms] [gain] [focus]` is the existing one-liner.
Only ONE process may hold the camera at a time (sharing it drops fps badly).

## Files and ownership

| File | Purpose |
|---|---|
| `boardlib.py` | Shared: config load/save (`board.json`), homography, grid, cell hysteresis, One Euro filter, piece state machine, events, protocol sender, command receiver, preview writer |
| `camera.py` | Open camera by name, apply UVC settings at startup, fps watchdog |
| `calib.py` | ArUco corner markers: generate printable sheet, detect board corners, bump detection |
| `lens.py` | Lens-distortion calibration (checkerboard) → `lens.json`; `load_lens()`, `undistort_points()` |
| `tracker.py` | Color detector (magnets / LEDs) on top of boardlib |
| `dots.py`, `blink.py` | Dot-count and blink-rate detectors on top of boardlib |
| `orbit/orbit_server.py` | Bridge: UDP feed → SSE, command relay, control panel, status |
| `orbit/index.html` | Orbit demo display |
| `orbit/control.html` | Operator control panel |
| `ops` | Launcher: start/stop/status/logs |
| `requirements.txt` | Pinned deps |
| `run/` | Runtime: pid files, logs, `preview.jpg` (gitignore-style scratch) |

## Data feed — UDP JSON to 127.0.0.1:5005, every frame (~25 Hz), ALWAYS sent (heartbeat), even uncalibrated or with no pieces

```json
{
  "v": 1, "seq": 1234, "t": 1790971279.8, "fps": 24.8,
  "source": "tracker:color",
  "calibrated": true, "calib": "manual|markers", "bumped": false,
  "grid": [8, 6], "board_in": [48, 36],
  "capture": {"auto": false, "interval": 0, "count": 0},
  "camera": {"name": "HD USB Camera", "ok": true, "exposure_ms": 8.3, "gain": 0, "focus": 488},
  "pieces": {
    "blue": {"state": "tracked", "cell": "C3", "col": 2, "row": 2,
             "x_in": 12.9, "y_in": 15.5, "u": 0.269, "v": 0.431, "conf": 0.93, "seen_ago": 0.0}
  },
  "events": [
    {"type": "placed|moved|lifted", "piece": "blue", "cell": "C3", "from": "B3", "jump": false, "t": 1790971279.8}
  ]
}
```
- `state`: `tracked` (seen this frame), `held` (missing < HOLD seconds, position frozen at last known), `lost` (missing ≥ HOLD; still listed with last known position so displays can ghost it).
- Pieces that have never been seen are omitted.
- `events` lists only events that occurred in this frame (usually empty). `jump: true` on a `moved` event means the piece reappeared far (> 1.5 cells) from where it vanished — displays should glide it.
- `u`,`v` are 0–1 board fractions (x right, y down from the board's top-left corner).

## Commands — UDP JSON to 127.0.0.1:5006 (tracker listens, non-blocking)

```json
{"cmd": "set_corners", "corners": [[x,y],[x,y],[x,y],[x,y]]}      // camera px, TL,TR,BR,BL
{"cmd": "auto_corners"}                                             // calibrate from ArUco markers now
{"cmd": "learn_color", "piece": "blue", "x": 812, "y": 177}         // camera px
{"cmd": "camera", "exposure_ms": 8.3, "gain": 0, "focus": 488}     // any subset
{"cmd": "learn_background"}
{"cmd": "capture"}                                                  // save the next raw frame once
{"cmd": "capture_auto", "interval": 1.0}                            // save a raw frame every N s; 0 stops
{"cmd": "set_grid", "grid": [8, 6], "board_in": [48, 36]}
```

Captures are the RAW full-resolution frame (no overlay, JPEG q95) saved by the tracker process itself to
`dataset/raw/YYYYmmdd-HHMMSS-mmm.jpg` (background thread, dropped if the queue is full), for training a detector
without opening the camera twice. The feed's `capture.count` is the number of files saved this session.

## Preview
Tracker writes `run/preview.jpg` ~5 Hz (atomic: write tmp then `os.replace`), ~960 px wide, full camera frame
plus PAD margin overlay identical to its window (grid, detections), and `run/preview.json`:
`{"scale": s, "pad": p, "frame_w": 1920, "frame_h": 1080}` so a click at preview pixel (px,py) maps to
camera px = (px / s - p, py / s - p).

## Tracking behavior (boardlib)
- **Jitter**: One Euro filter on board-inch positions (min_cutoff ≈ 1.0 Hz, beta ≈ 0.05, d_cutoff 1.0).
- **Cell hysteresis**: stay in the current cell until the filtered position is > 15% of a cell past its edge.
- **Acquire / keep**: detectors get two threshold sets; a piece is acquired anywhere on the board with strict
  thresholds and kept with looser ones inside a search radius (~3 in) around its last position.
- **Jump gating**: while tracked, a detection > 4 in from the last position in one frame is ignored
  (unless the piece has been missing > 0.3 s).
- **Placed**: needs 5 consecutive frames. **Held** up to HOLD = 1.5 s, then **lost** → `lifted` event.
- **Relocation**: reappearing > 1.5 cells away → `moved` event with `jump: true`, filter reset to new spot.

## Display behavior (orbit page)
- Render each piece from a critically damped spring toward its reported position (settle ≈ 0.4 s) with a
  max speed (≈ 0.6 board-widths/s), so big relocations glide with a trail instead of teleporting.
- Recompute orbit predictions only when the spring has settled or the cell changes (not on every jitter).
- Show per-piece state: tracked / held (dim, pulsing) / lost (red ghost) and tracker health (fps, calibrated, bumped).

## HTTP (orbit_server.py, 127.0.0.1:8765)
- `/` orbit demo, `/control` control panel, `/events` SSE of the latest feed (~30 Hz) **plus** every event
  delivered exactly once per client, `/status` JSON (latest feed + age + server uptime),
  `/preview.jpg` and `/preview.json` (from `run/`), `POST /cmd` (JSON body → relayed to UDP 5006).
- `Cache-Control: no-store` on everything.
