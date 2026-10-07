# Overhead tabletop tracker — operator guide

One camera ("HD USB Camera") watches the board; a tracker sends piece positions
to a bridge, which serves the orbit demo and the control panel. See `SPEC.md` for the data contract.

## Setup (once)
```
./ops setup
```

## Run
```
./ops start                      # color detector, magnets, opens the control panel
./ops start --pieces leds        # LED pieces
./ops start --detector dots      # or: blink
./ops start --no-browser
./ops status                     # processes + feed age, fps, calibration, camera, pieces (exit 1 if unhealthy)
./ops restart                    # same args as last start
./ops stop
./ops logs [tracker|bridge]      # tail -f
```
Logs and pid files live in `run/` (logs rotate at 5 MB, 3 kept). `start` always stops anything running first.

- Control panel: http://localhost:8765/control
- Orbit demo: http://localhost:8765/
- Raw status: http://localhost:8765/status

## Calibrate
In the control panel, click the four board corners on the preview (TL, TR, BR, BL), or use ArUco
corner markers: print the sheet from `calib.py`, place them at the corners, then press
"auto corners" (or run `calib.py`). Calibration is saved to `board.json`.

## Collecting training images
The tracker owns the camera, so it saves the raw frames itself: in the control panel's Dataset section press
Capture (one frame) or toggle "Auto every 1 s". Files go to `dataset/raw/YYYYmmdd-HHMMSS-mmm.jpg`
(full resolution, no overlay, JPEG q95). From scripts: `{"cmd":"capture"}` / `{"cmd":"capture_auto","interval":1.0}` to UDP 5006.

## Camera settings
```
./ops camera 8.3 0 488           # exposure ms, gain, focus (all optional)
```
Goes through the bridge when it is up, otherwise runs `./camset.sh` directly.
8.3 ms is flicker-safe under 60 Hz lighting.

## Troubleshooting
- **Low fps / slow camera** — only one program may use the camera. `./ops stop`, make sure nothing else
  (camview, Photo Booth, browser tabs, other Python) has it, then `./ops start`.
- **Exposure/focus reset after replugging the camera** — run `./ops camera` again.
- **Browser shows an old page** — hard refresh (Cmd+Shift+R).
- **`status` says feed stale/unreachable** — `./ops logs tracker` and `./ops logs bridge`; then `./ops restart`.
- **Pieces drift or flicker** — re-run calibration; check the camera was not bumped (status shows `bumped`).
