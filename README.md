# Orbital table

General Galactic investor demo: a 65" TV lying flat as a table, 3D-printed Earth, Moon and Seldon pieces tracked by an
overhead camera, and a three.js page that draws orbits around them.

- `camera/orbit3d/` — the table page (`demo.html` + `modes.js`; orbits view maths in `orbits-geo.js`, tested by
  `node tools/test_orbits_geo.mjs`), laptop control page (`control.html`), engagement sim bridge
  (`tools/engage_server.py`, needs the separate `gengalactic-demos` repo), design notes (`DESIGN.md`), feed contract (`FEED.md`).
- `camera/training/` — detector: `live.py` (camera → YOLO → `/events` feed, calibration, recording), labelling
  (`color_prompts.py`, `cloud/sam_label.py`), training (`cloud/run.sh`, `train.py`).
- `camera/stickers/` — printable ArUco marker / chip PDFs. `_archive-camera-v1/` — the first camera prototype.

Not in the repo (large, kept locally): training videos, frames, labels, model weights, Python environments, and the
sky tile pyramid (`camera/orbit3d/assets/sky/`, rebuild with `camera/orbit3d/tools/make_sky_tiles.py` from NASA SVS
Deep Star Maps 2020; credit NASA/GSFC SVS, Gaia DR2: ESA/Gaia/DPAC).

Run the live table: `cd camera/training && .venv/bin/python live.py --camera arducam --size 2048x1536`, then open
http://localhost:8780/demo.html (launch from Terminal: it needs camera permission).

Windows: `.venv\Scripts\python live.py --camera arducam --size 2048x1536` (DirectShow; needs `pygrabber`, and runs
`best.onnx` on DirectML when it exists with `onnxruntime-directml` installed, else `best.pt` on CPU).
Tracking smoothness (deadbands, lock-in time, smoothing, confidence) is tuned live at http://localhost:8780/tune.html
and kept in `camera/training/tuning.json`.
