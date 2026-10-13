# Overnight, Oct 12 → 13: from tech demo to presentation tool

Everything is on `night/*` branches, pushed to GitHub. **`night/integration` has all of it merged and working together.**
`main` and the TV were not touched: live.py kept running from `night/base` (main plus the GPU-fault fixes) and kept recording.

## Try it (5 minutes)
1. Stop the running live.py (the restart loop in the terminal), then: `git switch night/integration`
2. Start live.py the usual way (`--camera arducam --size 1280x960 --no-browser --no-window`). Windows will ask once to
   allow it on the network: allow **private** networks (the tablet needs it).
3. TV: reopen the kiosk on `http://localhost:8780/demo.html` (it opens in LEO TO GEO).
4. Tablet (laptop for now): `http://<laptop IP>:8780/presenter.html` (`ipconfig` for the IP), or `localhost` on the laptop.
5. Laptop keys on the TV page: `1`-`4` modes, `T` true scale, `F` freeze, `R` reset, `S` sky (still/slow/off), Space pause/play.
   (Fullscreen and topography moved to Shift+F / Shift+T.) On presenter.html, left/right arrows step the run of show.

To go back: `git switch night/base` (or `main`) and restart live.py.

## Your list → what was done
| You asked | Done | Where |
|---|---|---|
| Four modes | LEO TO GEO, CAPTURE / DEFEND, LEO TO DRO, COMPETITOR, one visual language (rails readable from both long sides, mint = us, violet = chemical tug, white = target) | modes.js, capture-geo.js |
| Lock to GEO near GEO | Seldon within 40 mm of the GEO ring snaps onto it (releases at 56 mm, no flicker) | geo |
| Near the Moon → DRO, no SOI | SOI no longer drawn; anywhere near the Moon puts the Seldon on the DRO loop, moving | dro |
| LEO → DRO, one satellite | One Seldon, path from where it sits to the DRO | dro |
| CAPTURE / DEFEND incl. same-orbit | Chaser burns to a lower/higher phasing orbit and comes back to meet the target; transfers between orbits; DEFEND: target maneuvers away. Moving dots, burn markers, live phase and T+ | capture |
| COMPETITOR | Us (electric spiral) vs "Typical chemical tug" (Hohmann) to the altitude you place the Seldon at (or GEO/DRO presets): propellant, DELTA-V, trip time. LEO→GEO: 120 kg vs 483 kg | competitor |
| Scale doesn't matter / "Not to scale" | LEO pushed well clear of the Earth piece; disclaimer reads "Not to scale." | all |
| True-scale button | Earth and Moon drawn at true size at fixed spots, their pieces ignored, satellites still move | presenter + geo/dro |
| Tablet control panel | presenter.html: 4 mode buttons, true scale, FREEZE (hands can't disturb the table while you make a point), reset, sky, per-mode options, **run of show** (11 beats with what to do, points to make, key numbers) and **audience-question cards** (15, some with an action e.g. "Is this to scale?" → true scale) | presenter.html, show-notes.json |
| Stop the table to answer a question | PAUSE/PLAY and a scrub slider on the tablet hold or rewind any film (capture, competitor, transfers) on the exact frame you need; FREEZE stops piece movement. Covered by an automated test (`camera/orbit3d/tools/test_control.py`, 24 checks) | presenter.html, modes.js |
| Vertigo | Sky is still by default (no pan/roll/zoom); optional slow drift at 1/5 speed; off | demo.html |
| Too fluid / smoothness | Tracker: pieces lock unless deliberately moved (jitter while still 0.32 → 0 mm); page ignores < 2.5 mm feed jitter and glides between 18 Hz feed updates | tracker.py, demo.html |
| Hand waving moves pieces | Hand gate: a still piece near a hand only moves on a real carry. False moves near hands 22 → 4 on today's recordings | tracker.py |
| Rely more on colour? | **Measured: no.** Model 97.2% recall / 45 phantoms per 1000 frames vs colour rules 95.3% / 71; colour is worst with pieces in hands, and Seldon-1's yellow is much paler on the table than in the labels. So the tracker now relies *less* on colour (COLOUR-STUDY.md) | tracker.py |
| New model from today's data | See "Round 5 model" below | cloud/ |
| Pruning | 14,590 → 10,835 frames (1.8 GB); idle footage gone; the recorder now keeps only frames where something changed | prune.py |

## Round 5 model
Trained overnight on a Spot A100: round 4's frames + 5,422 frames from today's recordings (pruned to the moments where
something changed: the sky page, evening light, lots of hands), labelled by the round-4 model + Grounding DINO voting with
SAM 2 outlines (cloud/label5.py). It is **live.py's default on this branch** (`runs/r5-seg-yolo11s-960/weights/best.onnx`).

| Held-out frames | | Round 4 | Round 5 |
|---|---|---|---|
| Today's (900 frames) | recall (pieces found) | 0.838 | **0.954** |
| | precision (no phantoms) | 0.912 | **0.954** |
| | mask mAP50-95 | 0.553 | **0.665** |
| | hands / people (mask mAP50-95) | 0.358 | **0.838** |
| All (2,417 frames, incl. round 4's) | recall | 0.897 | **0.942** |
| | precision | 0.942 | **0.958** |

Checked on this laptop: it loads and runs on DirectML (live.py `--video` on a recording). On that same recording, where round 4 saw the Earth at ~0.06 confidence (so the page said "Place Earth."), round 5 sees it at 0.87, Seldon-1 at 0.84, Seldon-2 at 0.88.
Earth, Moon and Seldons individually move only ±0.02-0.05 in mask quality; the gains are fewer misses and phantoms, and
hands (which the new hand gate uses). Caveat: the labels are machine-made with round 4 as one of the voters, so this is
agreement with a stronger labelling pipeline, not human ground truth. Known label flaw: a dark round stool off the table is
labelled Earth in a few frames. **On the Mac**: export it first (`export.py --weights runs/r5-seg-yolo11s-960/weights/best.pt
--formats coreml`); until then the Mac keeps round 4's Core ML model.
Labelling found a real problem worth knowing: on the table, Seldon-1's yellow is far paler and Seldon-2's magenta far
darker in the evening than the colour rules assumed, so a first labelling pass dropped most Seldon-1s (caught on the
contact sheets, fixed, re-labelled before training).

## Decisions for you
- **Numbers are placeholders.** One file holds them: `camera/orbit3d/vehicle.js` (Seldon Isp 1000 s, 50 mN, 200 kg dry; chemical
  Isp 320 s). The run-of-show notes have `[fill in: ...]` boxes where the repo had no real figure (real Isp/thrust/mass,
  whether the DRO mission is real, customer scenarios). Electric propellant to DRO (198 kg) exceeds the 160 kg tank placeholder.
- **LAN access.** live.py now listens on the network by default so the tablet can reach it (`--local-only` restores
  localhost). That also exposes calibrate/record/tuning to anyone on the same Wi-Fi.
- **Old modes** (mission, DELTA-V map, engagement sim, orbits) still open via `?mode=` but are out of the rotation.
- If a saved `tuning.json` exists on the TV laptop it overrides the new steadier tracker defaults.

## Not proven / known gaps
- Nothing was tried on the real TV with the camera (main stayed live). Rehearsed on a second live.py fed a recording.
- The tablet's scrub slider and PAUSE button haven't been tried on a real tablet (only headless).
- The new page costs the same GPU time as the old one on this laptop (±4 ms), measured at idle only.

## Branches
| Branch | What |
|---|---|
| night/base | main + GPU-fault recovery, CPU MJPEG recorder, change-gated recording, prune.py (what ran overnight) |
| night/visual | calm sky, smoothing, "Not to scale" |
| night/presenter | /show state, presenter.html, keys |
| night/runofshow | run of show + question cards |
| night/modes-transfer | geo, dro, true scale |
| night/modes-engage | capture, competitor |
| night/tracker | hand gate, steadier defaults, replay bench |
| night/cohesion | one visual language, stand-ins, real options |
| night/polish | vehicle.js, polish, live.py --video, rehearsal |
| night/colour | colour study |
| night/control2 | pause/scrub, freeze/reset/pause test, true-scale LEO footprint |
| night/integration | all of the above + colour-based tracker change + round 5 model |

Cloud spend: one Spot A100 (a2-highgpu-1g), about 3.6 h, roughly $5; deleted when done.
