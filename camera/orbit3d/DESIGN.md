# Orbital table — redesign plan (first principles)

Date: 2026-10-05. Scope: the three-mode display in `demo.html` + `modes.js` (drag-and-drop demo now, live `index.html` later). Physics, data files and the `createModes` API stay as they are.

## 1. What the display is for

- **Who:** investors standing around a 65" TV lying flat on a table, while a presenter from General Galactic narrates.
- **Takeaway:** the LEO → DRO electric mission is planned and credible, and Δv is the currency that makes orbital mobility matter.
- **Viewing:** people on all sides. There is no "top of the screen".
- **Pieces:** Earth and Moon are movable and the display reflows live. Two Seldons (150 mm span) and a mode chip move freely.
- **Idle:** ambient motion only. Nothing narrative plays by itself.
- **Brand:** General Galactic design system (`~/Downloads/general-galactic-design-system`). Editorial minimal.

## 2. Why the current screens feel off

- **A monitor layout laid flat.** HUD top-left, tabs bottom-right, caption bottom-left. Read from the far long side it is all upside down, and from the short ends it is sideways. The pieces say "map on a table", the text says "dashboard".
- **Three different apps.** Mission and Intercept sit on pure black; ΔV Map has a filled floor. Intercept uses a different radial scale (170 km/mm) from Mission and Map (piece spacing with a warp), so the same GEO ring is a different size per mode.
- **Sized for a desk.** Labels at 5–6 mm and captions at 5 mm are below what a standing viewer reads at a metre. Lines are thin and low contrast on black, so the route floats.
- **Mixed rendering languages.** Lit textured Earth and Moon spheres next to flat slate Seldon silhouettes and a stock lavender/ivory palette with no relation to the brand.
- **Loose details.** Units on some values and not others, mixed casing, hard-coded chip positions, event names in code that the data no longer has.

## 3. Principles

1. **It is a map, not a monitor.** Everything on the map is anchored to the pieces. The only screen-anchored elements are two mirrored edge rails and the chip boxes at the presenter's end.
2. **Readable from both long sides.** The rails are duplicated and rotated 180° (two-player board). On-map labels run along their curve, and numbers face the nearest long edge.
3. **One world.** One km→mm mapping shared by every mode. One Δv floor under every mode. One line language, one type scale.
4. **The floor tells the Δv story.** The Δv field is the terrain the railroad is built on. It is always there, dimmed; ΔV MAP mode turns it up and labels it.
5. **Few, large words.** The presenter talks. The screen shows one hero number per side, two supporting numbers, and at most four labels on the map.
6. **Brand, restrained.** Mint is the route and nothing else. Violet lives only in the floor. Grain and a faint dot grid give the surface a material. No bold, ever.

## 4. The system

### Tokens (new file `gg-table.css`, values copied from the design system so the demo runs offline)
| Role | Token | Value |
|---|---|---|
| Surface | `--gg-black` | #0a0d0d |
| Rail scrim | `--gg-ink-900` | #0d1113 |
| Route (primary) | `--gg-mint-500` | #0ee3a6 |
| Route under-stroke | `--gg-mint-900` | #063f30 |
| Target orbit / markers | `--gg-white` | #f6f8f8 |
| Reference orbit, contours | `--gg-fog-300` | #8a969a |
| Text | `--gg-fog-100` / `--gg-fog-200` | #dde3e4 / #b8c1c3 |
| Floor ramp (cheap → dear) | ink-900 → violet-900 (2 km/s) → violet-700 (8 km/s) | #0d1113 → #1c1740 → #332968 (amber and violet-400 dropped after review: brown around the Moon, and a flat saturated field in Mission) |
| Hairline | `--border-default` | rgba(246,248,248,.14) |

### Type (sizes in TV mm; px floors for small windows)
| Element | Face | Size | Treatment |
|---|---|---|---|
| Eyebrow (mode, metric labels) | Space Mono 400 | 7 mm | uppercase, 0.14em tracking, square bullet before the mode name |
| Hero number | General Sans 500 | 40 mm | tabular, unit at 12 mm in fog-200 |
| Metric value | General Sans 500 | 16 mm | unit at 60% |
| Map label | Space Mono 400 | 8 mm | uppercase, along the curve or facing the nearest long edge |
| Contour number | Space Mono 400 | 7 mm | along the contour, ink scrim behind |
| State message | General Sans 400 | 12 mm | sentence case with a period: "Place Seldon-1." |

Fonts are served locally from `assets/fonts/` (General Sans 400/500, Space Mono 400) so the TV never depends on wifi. Weights 400 and 500 only. Space Mono has no Greek, so the display always writes DELTA-V, never the Δ glyph (the brand's own wall screens spell it out too).

### Lines (widths at 1.34 px/mm, scaled with the window)
- **Route:** mint-500, 2 mm, with a 3.5 mm mint-900 under-stroke at 50% as the only glow in the system. Opacity ramps 40% → 100% along the route.
- **Target orbit:** white, 1.2 mm, 70%.
- **Reference orbit (GEO, LEO, Δv = 0):** fog-300, 0.8 mm, dashed 4/4 mm, 40%.
- **Contours:** fog-300 hairline; major (1 km/s) 30%, minor (0.5 km/s) 12%.
- **Markers:** 4 mm open circle, white hairline, 3 mm leader to the label.

### Floor
- Full-screen shader as today (`modes.js` ΔV ShaderMaterial), re-ramped to the brand stops above, hypsometric bands every 0.5 km/s, hillshade ≤ 10%.
- Strength per mode: MISSION 55%, INTERCEPT 55%, ΔV MAP 100%. Origin: LEO in MISSION (the spiral climbs the hill it has to pay for), Seldon-1 in the other two.
- Fades to ink under both rails (60 mm vertical mask) so rail text is always on a clean ground.
- Brand grain over the whole canvas (CSS layer, `feTurbulence`, 12% overlay, static). Dot grid at 20 mm spacing, 8% white, drawn in the floor shader as graph paper and a scale cue. The Moon's sphere-of-influence blend is 25,000 km wide so the cost model's seam doesn't show as a hard disc.
- Stars: ~150 faint points, 15% mint-tinted, unchanged otherwise.

### Layout (1428.5 × 803.5 mm)
```
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ ■ MISSION · LEO TO DRO                 s/ɯʞ ɔǝs 551  ·  0ㄥ˙9   (rail, far side, rotated 180°)
 │  6.70 km/s                                           155 d  SPIRAL      │
 │                                                                     ┌──┐│
 │        ( Earth piece )  ~~~ spiral ~~~  ( Moon piece )  ( DRO )     │M │ │  chip boxes,
 │                                                                     ├──┤ │  presenter's
 │                 map zone: anchored to the pieces                    │I │ │  end, labels
 │                                                                     ├──┤ │  rotated 90°
 │                                                                     │ΔV│ │
 │ ■ MISSION · LEO TO DRO                                              └──┘│
 │  6.70 km/s                                           155 d  SPIRAL      │  (rail, near side)
 └──────────────────────────────────────────────────────────────────────────┘
```
- **Rails:** one along each long edge, 56 mm tall inside the 24 mm margin, mirrored. Left block = eyebrow + hero. Right block = two metrics. Centre = empty, or the state message. Each rail reads correctly from its own side.
- **Chip boxes:** three 64 mm squares stacked vertically at the presenter's short end (`?end=right` default, `left` supported), labels rotated to read from that end. The small GG lockup (logomark + wordmark, fog-200, 60 mm) sits below them along the same edge.
- **Map zone:** everything between the rails. Pieces may sit anywhere, including on the rails; the placer treats rail blocks and chip boxes as obstacles.

### Orientation rules
- Orbit names and contour numbers are set along their curve (CSS rotate on the existing label divs).
- Point labels (burns, events, Seldon names) rotate 180° when their anchor is more than 40 mm above the centre line, so they face the nearest long edge; inside that 40 mm band they keep the near-side orientation so labels at the Moon's height don't flip on a hair.
- The two rails are the only text that is duplicated.

### Motion (ambient only)
- Orbit dots drift on reference and target orbits at speed-warped rates (existing code), 2.5 mm fog-100.
- The route carries a slow dash drift in the direction of travel at low contrast (3 mm/s). Switchable off if it reads as narrative.
- Floor intensity breathes ±5% over 44 s. Grain is static. Mode crossfade 400 ms with the brand's standard ease. Nothing bounces.

### Voice
Brand copy rules: terse, sentence case for messages, uppercase mono only for eyebrows. "Place Seldon-1." "Place both Seldons." "Move Seldon-1 onto the path to scrub." Mode names: MISSION · LEO TO DRO, INTERCEPT · SELDON-1 TO SELDON-2, ΔV MAP · FROM SELDON-1.

## 5. Per-mode content

**MISSION.** Floor from LEO at 55%. Reference: GEO ring. Route: spiral + transfer in mint. Target: DRO loop in white with "DRO" along it. Markers: ELECTRIC SPIRAL, DRO INSERTION. Rails: hero = total Δv; metrics = TIME, SPIRAL Δv. When Seldon-1 is within 40 mm of the route the route highlights up to that point and the rails switch to Δv USED / DAY / PHASE. Caption (placeholder notice) moves to a 7 mm mono line along the presenter's end.

**INTERCEPT.** Floor from Seldon-1 at 45%. Reference: GEO ring and Seldon-1's orbit. Target: Seldon-2's orbit in white. Route: Hohmann half-ellipse in mint. Markers: BURN 1, BURN 2. Wait arc dashed. Rails: hero = total Δv; metrics = TRANSFER, NEXT WINDOW. Readouts never move with the pieces.

**ΔV MAP.** Floor from Seldon-1 at 100% with contour numbers along the 1 km/s contours. Reference: Δv = 0 orbit through Seldon-1 (dashed), GEO. Points of interest with cost: GEO, L1, L2, LLO, DRO, labels along their curves. Route to Seldon-2 in mint, starting at Seldon-1's actual position and sweeping the shorter angular way (phasing is ignored on this map, so the direction is cosmetic and it keeps the route on screen). Rails: hero = Δv to Seldon-2; metrics = TIME (Edelbaum at 0.5 mm/s²), ROUTE.

## 6. One world: mapping and placement

- Replace the two radial mappings with one `kmToMm(r)` used by all three modes: the existing Mission warp (`modes.js` ~218–238, LEO pushed out of the Earth base at RHO0) extended outward with the piece-spacing scale. Intercept orbits and Δv then come from the same function, so GEO is one ring everywhere.
- Label placer obstacles become the true footprints: Earth and Moon discs 33 mm + 6 mm, Seldons an oriented 150 × 50 mm rectangle, chip 56 mm square, plus rail blocks and chip boxes.
- Reflow is continuous: no snapping, no mode-dependent positions; `MODE_SPOTS` goes away.

## 7. Demo page

- Stand-in pieces stay but drop to 70% opacity with a hairline outline so they read as placeholders for the physical pieces and the floor shows through.
- URL params: existing `s1,s2,earth,moon,chip,nomoon,mission` plus `end=left|right`. Keys M, 1, 2, 3 unchanged; `T` toggles the training backgrounds in `index.html` only.
- Before the polarizer film arrives the camera can still see the screen; the demo page has no camera, so mint is safe there. If the old detector is ever run against the new page before the film, add `?safe=1` to swap mint for fog-200.

## 8. Build order — DONE 2026-10-05 (rounds A, B and a review pass; backups modes-v1.js / demo-v2.html hold the pre-redesign files)

1. **Tokens and fonts.** Add `gg-table.css` (tokens above, `.mt-*` classes rewritten on Space Mono / General Sans, no weight above 500). Download woff2 files into `assets/fonts/`. Copy `gg-logomark` into `assets/`. Replace the Inter/JetBrains link in `modes.js`.
2. **Skeleton.** Rails (mirrored, `place()` gets a rotation), chip boxes at the head end with rotated labels and the lockup, caption relocated. Remove the top-left HUD and bottom-right selector. `boxRect` keeps its signature so `demo.html` chip placement still works.
3. **Floor everywhere.** Lift the shader quad from the ΔV group into chrome; add `uStrength`, `uOrigin` and the rail mask; re-ramp to brand stops; add grain and dot-grid layers; contour numbers only when ΔV MAP is active.
4. **One mapping.** Introduce `kmToMm` and port Intercept's `rhoOf` and the ΔV map to it. Re-check Hohmann numbers against the old 170 km/mm figures and the GEO ring radius.
5. **Line and label language.** Restyle `STYLES`, add the under-stroke, curve-aligned labels, nearest-edge facing, true-footprint obstacles, ambient dash drift.
6. **Per-mode content pass** to section 5, including state messages in brand voice.
7. **Cleanup.** Remove dead `EV_NAME`/`PHASE_NAME` entries, `fmtT`, unused `ctx` fields, stale constants in `demo.html`; units and casing made uniform.

Later, outside this plan: wire `modes.js` into the live `index.html`, chip detection from the camera, retraining after the polarizer film.

## 8b. Revisions after the first look (2026-10-05, late)
- **Floor only in the map.** The user rejected the Δv floor as a background for Mission and Intercept ("terrible"). Those modes are now stars on ink; the floor fades in only in DELTA-V MAP, always measured from Seldon-1. Principle 4 is withdrawn for now.
- **Corner text only.** All on-map labels (orbit names, burn and event markers' text, contour numbers, L1/L2 text), the foot captions, the demo note, the Seldon name tags and the chip-box labels are hidden. Only the rail corner blocks remain (eyebrow + hero at one corner, metrics or a state message at the other, mirrored on the far rail) plus the lockup. `?text=all` restores everything for later review.
- Sky (2026-10-06, second pass): the panorama (ESO/S. Brunier, CC BY 4.0, credit required in public material) is now mapped on the inside of a sphere in its own scene, seen through a perspective camera, with ~2,600 near stars at mixed depths (twinkling points) in front of it. The camera rolls so the galactic band follows the Earth–Moon axis, pans and tilts with Earth, narrows its field of view as the pieces close in, and slides sideways so the near stars drift against the galaxy (true parallax). A very slow idle drift keeps it alive. No tint, no grain, no dot grid: just the photo. The dome fills any window aspect, so Mac fullscreen is covered. Map floor stays 86% opaque over it.
- Slider (2026-10-06): the chip is a delta-v budget slider. The track runs the head-end column (0 at the lockup end, 8 km/s at the far-rail end, ticks every 1 km/s, numbers every 2). The chip's position sets the budget from Seldon-1: the floor keeps its ramp and rings up to that cost, everything dearer falls back toward ink, and a fog-100 frontier line marks the reach; contour numbers above the budget hide. The readout follows the chip. Chip off the track = topography off. Keys: `[` / `]` step the budget by 0.5 km/s.

## 9. Verification

- Screenshots at 1920×1080 of each mode in three arrangements (default; Moon at the far right; Seldons parked on the rails), taken one at a time.
- Flip each screenshot 180° and confirm the far rail reads correctly.
- Grep the CSS for weights above 500 and for the old lavender/ivory hex values: both must be empty.
- Measure: no text under 7 mm, hero at 40 mm, route 2 mm, rails inside the 24 mm margin, contour numbers only in ΔV MAP.
- Drag every piece across the rails and chip boxes and confirm labels relocate and readouts stay fixed.
- Load the page with wifi off and confirm the fonts still render.

## 10. Decisions you can still veto

- Chip boxes at the **right** short end by default.
- **Mirrored rails** (hero number appears twice, once per long side) rather than a single readout.
- **Dot grid** on at 8%; easy to turn off.
- The **dash drift** on the route counts as ambient; say so if it reads as a flight.
- Reach, not topography (2026-10-06, later): the ramp, rings and contour numbers are gone from the floor (the code stays behind `REACH = false`). The floor now answers one question: can Seldon-1 reach this point with the budget on the slider? It is drawn as one semi-transparent violet-400 region (22%), soft-edged, no outline (a mint frontier line and an inner glow were tried and dropped). Around Earth a hole appears, because dropping to a lower orbit costs delta-v too.
- Sky sharpness: the 6000x3000 ESO "large" JPEG (`assets/milkyway-6k.jpg`, the biggest they publish) is the default on GPUs with 8k textures (`?sky=4k` falls back); the field of view is clamped to 44..68 deg so the photo is never magnified past ~1.6x; the near stars zoom with the sky. A black-level/gamma grade on the dome (`?skyblack=`, `?skygamma=`) pulls the photo's grey floor down to ink.
- Engagement mode (2026-10-06): the real General Galactic Engagement Lab sim, not a re-implementation. `tools/engage_server.py` (start with `tools/engage.sh`, port 8791) runs the wargame runner + Orbital Engagement Lab physics unmodified, from `../gengalactic-demos/apps/orbital-sim` (cloned, venv in `orbital-engagement-lab-main/.venv`). A run is exactly what the web app's Run builds at its defaults: GG-1 base card for us, a mirrored GG-1 adversary (airframe + 2.5 km sensor), scenario doctrine and criteria, seed 0. Only difference: the opening comes from the table (Seldon-2's offset from Seldon-1 in Seldon-1's frame, R away from the body it orbits, I along its orbit counter-clockwise, 200 mm = 1 km, clamped to the web app's 0.5-20 km), and the ±0.4 km seed jitter is off. The runner sizes react range and guidance times from the in-track offset only; the server applies the same two rules with the true distance hypot(R, I). Verified: at the authored opening every metric matches a plain upstream campaign. Page: `?mode=engage` or key `m`; `?scenario=pursue_evader` for the Pursue engagement; `?kmpermm=` changes the scale. Seldon-1 = ours (mint), Seldon-2 = adversary (red), faint full paths, solid trails, keepout/capture ring that floods on breach/capture, corners show range, time, our delta-v and the verdict. Playback 60x, re-runs when the pieces hold still for 0.5 s after moving.
- Engagement mode, Earth-centred (2026-10-06, later): Earth is fixed at the table centre for this mode and the Moon is set aside (the demo snaps/parks its stand-ins; on the real table, put Earth in the middle). Each Seldon's distance from Earth sets a circular, coplanar starting orbit, shown as a ring through the piece before the run; the sim's chaser gets the matching circular drift rate (Hill: di/dt = -1.5 n R). Cross-track manoeuvring is banned: the server swaps the scenarios' CommonSenseEvader for PlanarEvader (same doctrine, in-plane perpendicular dodge only) in its own process; upstream files untouched. Playback is a two-scale view: the pair's midpoint goes round Earth at the true orbital rate and drifts at 50 mm per km (softly compressed toward Earth and the edge), while each craft's offset from that midpoint is drawn at 200 mm per km (softly capped at 230 mm), so the fight stays legible and on the table, and both craft start exactly on their pieces. Solid = what the sim flew; dashed = each craft's orbit from that moment if it never burned again (Hill coast), drawn to the end of the engagement (at least 4 min). Keepout/capture ring drawn through the same mapping.
- Thrust vectors + free placement (2026-10-06): the server now returns each craft's applied thrust from the OEL result (read-only capture of SimulationResult.applied_thrust, rotated into the reference orbit's R/I axes); the page draws a white arrow from each craft along the push, length by fraction of full thrust, hidden under 4%. Starting rings always pass through the pieces, even past the table edge (the old clamp is gone); the playback's outer soft limit grows to the outermost piece. Dashed no-burn paths end where they leave the readable zone around the fight instead of being squashed. Openings past 2.5 km show the Lab's blind-sensor warning.
- No sensor limit (2026-10-06): per the user, both craft see each other at all times. The server sets both sensors to 1,000,000 km range, no line-of-sight requirement; the blind-sensor warning is gone.
- Engagement consoles (2026-10-06): one console per craft at the short ends (ours at the presenter's end, the adversary's at the other), read from that end like a mixing console. Rows, nearest first: header (name + DELTA-V USED / full-tank capacity), FUEL LEFT gauge, then one track per parameter with a printed code (chip) on it: THRUST, FUEL, DRY MASS, ISP, and on ours the KEEPOUT/CAPTURE RING. Ranges are the Engagement Lab's own bounds (thrust 0.05-50 N, fuel 0.5-200 kg, dry 50-2000 kg log; Isp 100-400 s; ring 0.02-2 km log); values snap to 2 significant figures (Isp to 5 s). Moving any code re-runs the real sim after 0.5 s still. Gauges come from each craft's own mass history in the sim. The ring slider moves the Lab's criteria and scales each craft's doctrine distance (keepout_km / capture_range_km) by the same factor; each provider's Isp follows its craft. Thrust arrows scale to each craft's own full thrust. Code ids for the camera tracker: sl:o:thrust, sl:o:fuel, sl:o:dry, sl:o:isp, sl:o:ring, sl:a:thrust, sl:a:fuel, sl:a:dry, sl:a:isp (demo: draggable stand-ins; `?sl=o:thrust:0.3,a:fuel:20` test hook). The corner rails now show range, time and result.
- Line weights (2026-10-06): Seldon orbit/trail lines 2.4 px, dashed no-burn paths 1.8 px, slider fills 3 px, dots 3.8 mm.
- Setup bar (2026-10-06): a neutral bar centred on the presenter's long edge, on neither player's console, with two codes: TIME (300 s to 12,000 s, log; the Lab's survive / time-limit tunable, which also sets both craft's clocks and the simulated window) and KEEPOUT / CAPTURE ZONE (moved off our console). Codes sl:s:time, sl:s:ring. Playback speeds up so any length plays in about 30 s.
- Distance from Earth, redone (2026-10-06): the hard floor and the fisheye are gone (user: a floor is not a solution). The pair now rides its orbit at TRUE scale: distance from Earth on the table is the orbit radius, and the real altitude change (a few km of ~7,000 km) is applied at true scale, so the pair never leaves its circle. Only the separation between the two craft is magnified, linearly, in a lens that travels with them: 200 mm per km at the start, zooming OUT smoothly (never in, eased, started a minute early) whenever the fight would otherwise reach within 78 mm of Earth's centre, past the table edge, or more than 1.1 rad along the orbit. A scale bar above the setup bar shows the current separation scale. Dashed no-burn paths stop where they leave the lens.
- Sky follows table zoom (2026-10-06): the sky is now a full-screen shader (not a sphere mesh) that zooms by angle, and the near stars use the same angular zoom. When the engagement lens zooms out by a factor, the sky zooms out by the same factor (tracked within ~0.1 s), up to the point where about 80% of the whole sky fills the view; past that the sky holds while the lens keeps going. At normal zoom the picture is identical to the old sphere.
- Panels, one slider each (2026-10-06): too many tracks, so each of the three panels (ours, adversary, SETUP) now shows all its numbers in a row of boxes and has ONE slider. Two codes per panel: a selector code placed in a field's box chooses what the slider changes, and a value code on the slider sets it. Pickup like a mixing-desk fader: after a new selection the slider does nothing until the value code reaches that field's mark (a tick on the track; the caption says SLIDE TO THE MARK), so values never jump. Codes: sl:o:sel, sl:o:val, sl:a:sel, sl:a:val, sl:s:sel, sl:s:val. SETUP fields: TIME, KEEPOUT/CAPTURE ZONE, PLAYBACK (0.25-4x, does not re-run), ZOOM (50-800 mm of table per km of separation, default 200; sets how far apart the pieces are in km before the run and the lens's starting scale; the sky zooms with it). Test hook ?sl=o:thrust:0.5,s:zoom:400.
- Sky v3, zoom pyramid (2026-10-06): the ESO photo only exists at 6000 x 3000, so it blurred when zoomed in. The sky is now NASA/GSFC SVS Deep Star Maps 2020 (galactic, built from Gaia DR2; credit "NASA/Goddard Space Flight Center Scientific Visualization Studio. Gaia DR2: ESA/Gaia/DPAC."), cut by tools/make_sky_tiles.py into assets/sky/: base.jpg (whole sky, 4096 px) plus 2048 px tiles of the sky at 8k (L1), 16k (L2) and 32k (L3). Like a map or PDF viewer, the page works out the sharpness the current zoom needs, finds the tiles on screen (9 x 9 ray grid), loads them in the background and draws them over the base (up to 8 at once; least-recently-used tiles are dropped past 48). The procedural near-star layer is gone. Exposure 1.0 matches NASA's own preview.
- Sky grade (2026-10-06): the raw Gaia map looked brown and flat next to the ESO photo (true star colours, low contrast). assets/sky/grade.png is a per-channel lookup made by histogram-matching the Gaia base image to the ESO photo as it was displayed; it is now BAKED into the tiles at full precision by tools/make_sky_tiles.py (tools/sky_grade_lut.png, 85%), because applying it in the shader amplified JPEG noise in the darks. ?grade= adds an extra shader grade on top (default 0).
- Seamless sky zoom (2026-10-06): all tile JPEGs (283 MB at quality 92) are fetched into memory at startup, coarse levels first, so showing a tile is an off-thread decode (createImageBitmap), never a network wait. When the zoom gets within a third of a level of the next one, that level's on-screen tiles are decoded ahead of time. Tiles cross-fade in (~0.35 s); coarser tiles stay underneath until all the sharper ones are ready, then fade out. Up to 12 tiles drawn at once; up to ~48 decoded tiles kept on the GPU (about 1 GB); holding all 168 decoded would need ~3.5 GB.
- Laptop control (2026-10-06): every parameter moved off the table to control.html (open in a laptop tab: http://<host>:8790/control.html): scenario (Defend/Pursue), both craft (thrust, fuel, dry mass, Isp; the Lab's bounds), engagement time, keepout/capture zone, playback speed, START and RESET, plus a live status strip (table phase, range, time, both craft's delta-v and fuel, result). The table runs nothing until START: it flies exactly the placement, zoom and laptop values at that moment, and any change afterwards (pieces, values, zoom) sends it back to the setup view (starting rings + "Ready. Start the run on the laptop.") until the next START. Shared state lives on the sim server: GET/POST /control (laptop writes, table polls every 250 ms), POST /status (table reports every 0.5 s). Enter on the table page or the control page also presses START.
- The only table control is ZOOM, set by hand: a track centred on the presenter's long edge (50-800 mm per km). The table reads the camera's 'hand' position (feed.hand = {x_mm, y_mm}; the model still has to be trained to report it); when the hand is on the track the zoom follows it (smoothed, 2 significant figures); it is locked while a run plays. Demo: a draggable hand stand-in resting on the track. The per-craft panels, selector codes and the setup panel are gone from the table; each craft's header now shows its spec line and delta-v used, beside its fuel gauge.


### Orbits kiosk mode (2026-10-06)
- New default mode `orbits`: Earth, Moon, Seldon-1 (mint) and Seldon-2 (white), each with its circular orbit about Earth through the piece; Moon's orbit dashed. A dot rides each orbit at its Kepler rate (sped up, fastest lap 8 s). No delta-v anywhere (no floor, no budget chip).
- One hand-set ZOOM slider (same track and camera key `hand` as engagement): 0.25×–8× around 1 mm = 300 km. The rings stay through the pieces; the scale changes altitudes, periods, the GEO reference ring, the scale bar and the sky.
- INTERCEPT archived (code kept, `ARCHIVED` set in modes.js; not reachable even by `?mode=`). `m` toggles orbits ↔ engagement; `?mode=dvmap|mission` still reopen those.
- Sky: optional cool split-tone in the dome shader (`?cool=0..1`, default 0.7): warm dust swung toward violet, teal in the darks.
- Orbits mode, transfer (2026-10-06 later): Seldon-1 → Seldon-2 for our vehicle (200 kg dry + 160 kg propellant, `VEH` in modes.js) in both propulsion modes (`PROP_MODES`): ET 1000 s / 50 mN = Edelbaum spiral (Δv = |v1−v2|, time = propellant ÷ mass flow, phasing not included; drawn as a dashed schematic spiral, ≤4 turns); GT 425 s / 100 N = Hohmann (time = phasing wait from the piece angles + half ellipse; drawn as the mint route with depart/arrive marks). Propellant from the rocket equation off the full tank; red OVER if it exceeds 160 kg. The bottom-left / bottom-right rail text is replaced by the ET block (left) and GT block (right); the far rail mirrors it.
- Sky brightness (2026-10-06 later): view-adaptive highlight compression. demo.html estimates the on-screen mean linear luminance from a 256×128 copy of base.jpg each frame; above `?skytarget=` (0.008, ~80th percentile of views) the shader applies L/(1+kL) so the view mean drops to (target/mean)^0.75 (floor `?skyfloor=` 0.3). Faint sky is untouched; dark views are unchanged.
- Orbits view v2 (2026-10-06 later): Earth and Moon FIXED across the table (`LAYOUT` in orbits-geo.js: Earth 360,370 mm; Moon 1100,370); no zoom for now. Distance from each body is a power law in altitude (p 0.35): LEO 108 mm, GEO 350, Moon 740 (its true 384,400 km), lunar 100 km orbit 69 mm from the Moon, Moon zone (SOI 66,180 km) 190 mm. Directions true; a footnote says distances are stretched. Patched conics: a Seldon inside the zone orbits the Moon. Transfers EE/MM/EM/ME for ET (Edelbaum + SOI spiral; drawn with v^4 turning so most turns are deep in the well) and GT (Hohmann + hyperbolic capture/escape at the Moon; drawn arriving at the Moon piece). Joins at the zone edge are filleted. All geometry/maths in orbits-geo.js, checked by `node tools/test_orbits_geo.mjs` (numbers, on-screen, joins, corners).
- Standard case LEO 400 km → 100 km lunar orbit: GT 3.90 km/s, 5.0 days + wait, 219 kg; ET 8.01 km/s, 456 days, 201 kg. Both exceed the 160 kg tank (ET max 5.76 km/s, GT max 2.45 km/s), shown in red with what the tank gives.
- Colours (readability first, colour-blind-safe): Seldon-1 #56b4e9, Seldon-2 #e69f00, Moon grey, ET #f0e442, GT #ff5fd2; all text on dark plates; tags nudged apart. Sky exposure calibrated over live-like camera poses (pitch ±0.3 rad), brightest ~8% of frames only, uniform scale (floor 0.55).
- Orbits view v3 (2026-10-06 later): ET/GT transfer display removed (maths kept in orbits-geo.js, unused). Earth and Moon follow their pieces again. Scale: linear (true proportions) out to GEO with LEO 70 mm from Earth's centre, capped so GEO ≤ 0.6 × the Earth–Moon distance; compressed (power 0.45) from GEO to the Moon so the Moon lands on its piece. LEO and GEO dashed reference rings with labels. If the Moon is closer than ~740 mm, LEO no longer clears the Earth piece and the table says to move the Moon farther. Footnote states the scale.
- Orbits view v3b (2026-10-06): per user, removed the Moon-zone caption, the scale footnote, the "move the Moon farther" hint, the Moon label and the company lockup (orbits view only). Remaining text: Seldon tags, LEO and GEO labels. The Moon zone circle stays, unlabelled.
- Orbits view v4 (2026-10-06): user: figures need not be to scale (they can be remade small), so the view is ONE TRUE SCALE (SCALE.true in orbits-geo.js): k = Earth–Moon mm / 384,400 km; Earth and Moon models drawn at true size for that k (demo.html scales the meshes; Moon min 3 mm), Seldon models 30 mm span (?seldonscale=), base rings hidden. A piece touching Earth reads as LEO (400 km), touching the Moon as a 100 km lunar orbit (FLOOR_ALT). At 970 mm apart: Earth 16 mm radius, LEO 17 mm, GEO 106 mm, Moon 4.4 mm, Moon zone 167 mm. The squeezed scale is still there (SCALE.true = false).
- Orbits view v5 (2026-10-06): true scale kept for orbits; figures bigger than scale (FIG in orbits-geo.js: Earth 31 mm, Moon 22 mm radius, Seldon base 15 mm; Seldon models 50 mm span, ?seldonscale=). A Seldon within FIG+S+SNAP(12) of a body reads as its lowest orbit (LEO 400 km / 100 km lunar); rings pass through the piece; the LEO ring sits where an Earth-hugging Seldon stands. Footnote: "Figures are bigger than scale. Orbits are to scale." Consequence: altitudes between LEO and ~17,000 km (inside the figure size) cannot be placed.
- Orbits view v6 (2026-10-06) — supersedes v5's SNAP rule and its 17,000 km gap: altitude is to scale and measured from the figures' edges (user: "0 is where the earth model stops"). Earth-centred radius r is drawn at FIG.E + FIG.S + (r − R_E)·k; Moon-centred at FIG.M + FIG.S + (r − R_M)·k; k = max(60, Earth–Moon mm − FIG.E − FIG.S) / 378,022 km, so the Moon piece sits at its true altitude and GEO is always 9.5% of the way out (never below LEO or inside Earth). Seldon altitude rises continuously from touching (floored at 400 km / 100 km). LEO ring hidden when it would be within 14 mm of GEO (Moon closer than ~120 mm). A Seldon touching the Earth figure always orbits Earth; otherwise it orbits the Moon only if inside the Moon zone and nearer the Moon. `node tools/test_orbits_geo.mjs` now asserts all of this over Moon distances 53–1300 mm (exit 1 on failure). Footnote: "Figures are bigger than scale. Altitudes are to scale, measured from their edges."
- Orbits view v7 (2026-10-06) — supersedes v6's zero point: altitude zero is the figure's edge itself, so the lowest orbits hug the Earth and Moon icons (Earth-centred radius = FIG.E + (r − R_E)·k, Moon-centred = FIG.M + (r − R_M)·k, k = max(60, Earth–Moon mm − FIG.E) / 378,022 km). Icons stay at FIG size (31 / 22 mm). Consequence on the real table: a Seldon piece touching a figure stands FIG.S (15 mm) out, so it reads FIG.S / k high (~6,000 km at 970 mm apart), not LEO / 100 km; LEO and low lunar orbit can only be shown by the rings, not by a touching piece. The Earth-touch rule (always orbits Earth) still uses FIG.E + FIG.S. Demo stand-in Seldon-1 still sits on LEO (overlapping the Earth icon).
- Transfer back (2026-10-06): orbits view draws Seldon-1 → Seldon-2 for both engines from OGEO.transfer: GT dashed white (Hohmann / patched conics), ET mint (low-thrust spiral). Readout = two rows at the bottom centre, delta-v and fuel only (fuel from the 200 dry + 160 kg wet vehicle; flags over the tank). Delta-v differs by engine on purpose: the spiral loses the impulsive (Oberth) advantage, e.g. LEO→GEO GT 3.85 vs ET 4.59 km/s. No transfer times shown.
- Transfer lines v2 (2026-10-06): GT red #ff5a4f, ET purple #b67dff (user asked; brighter than brand violet), solid line + light dashes running toward Seldon-2 at 12 mm/s + arrowhead at the end.
- Timed burns (2026-10-06): every transfer path ends exactly on Seldon-2 (burns assumed timed). EE/MM GT: Hohmann arc departs from b.th − π on Seldon-1's orbit. ME GT: Hohmann from the Moon down to Seldon-2's orbit (arriving opposite the Moon), then drawn along Seldon-2's orbit to the piece; delta-v stays the Hohmann minimum. ET spirals and EM already ended on Seldon-2. Tested in tools/test_orbits_geo.mjs.
