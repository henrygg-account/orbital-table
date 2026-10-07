# Table demo: detector ↔ page contract

Pieces are 3D-printed models standing on the TV glass, seen by an overhead camera.
The page renders on the TV underneath them, so everything is in **screen millimetres**
(origin top-left of the TV's active area, x right, y down). Scale of the world: 1 mm = 300 km.

## pieces.json (next to live.py)
```json
{
  "screen_mm": [1428.5, 803.5],
  "camera_height_mm": 1500,
  "map":   {"tape": "earth", "ball": "moon", "marker": "seldon"},
  "roles": {
    "earth":  {"count": 1, "height_mm": 30},
    "moon":   {"count": 1, "height_mm": 15},
    "seldon": {"count": 2, "height_mm": 45},
    "iss":    {"count": 1, "height_mm": 45}
  }
}
```
- `map`: detector class → role. Today's model has stand-in classes (tape/ball/marker); once the printed
  pieces are trained, the classes are simply `earth`, `moon`, `seldon`, `iss` (identity map).
- `count > 1` → ids `seldon-1`, `seldon-2`, kept stable frame to frame by nearest-neighbour matching.
- `height_mm`: height of the visible part of the model above the glass, for parallax correction.

## Feed — `GET /events` (SSE, ~30 Hz)
```json
{ "t": 1790980875.49, "fps": 13.5, "calibrated": true, "screen_mm": [1428.5, 803.5],
  "pieces": { "earth": {"role": "earth", "x_mm": 512.3, "y_mm": 401.0, "u": 0.40, "v": 0.56, "conf": 0.79, "seen_ago": 0.01},
              "seldon-1": {"role": "seldon", ...} } }
```
- `u, v`: raw 0–1 camera-frame position. `x_mm, y_mm`: screen position after homography + parallax.
- Uncalibrated: `x_mm = u * W_mm`, `y_mm = v * H_mm`.
- A piece stays listed with its last position until `seen_ago > 10`.

## Calibration — `POST /calibrate`
The page draws ArUco markers (DICT_4X4_50) on screen and posts their layout:
```json
{"markers": [{"id": 0, "x_mm": 70, "y_mm": 70, "size_mm": 80}, ...]}
```
(`x_mm, y_mm` = marker centre, `size_mm` = black square side). The detector looks for them for up to 3 s,
computes camera px → screen mm from all detected marker corners (needs ≥ 3 markers), saves `calib.json`,
and replies `{"ok": true, "markers_found": 4, "rms_mm": 1.8}` or `{"ok": false, "error": "..."}`.
`GET /marker/<id>.png` returns the marker image: **exactly the black square, no white border** (600 px). The page must
add its own white quiet border (>= 1 marker cell, i.e. size_mm/6) around it; `size_mm` is the black square side.

## Parallax
Camera nadir `N` = screen point under the camera ≈ homography of the image centre. A model whose visible top is
`h` mm above the glass, detected at screen point `p`, is really at `N + (p − N) · (H − h) / H`, `H = camera_height_mm`.
