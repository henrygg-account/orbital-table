# Colour vs the round-4 model: is colour more reliable?

Short answer: no. On the round-4 labels the model beats colour on every piece, in every condition we could measure,
and the tracker's current colour rules cost a little recall and add phantoms rather than removing them. Colour is
also fragile across exposure: today's live frames look different from the labelled ones (Seldon-1 yellow is
S~98 live vs S~191 in the labels), so any threshold tuned on the dataset breaks. Recommendation: keep colour as weak
evidence only (changes at the bottom), do not rely on it more.

Setup: round-4 **val** split, 1517 frames (two sessions, contiguous blocks), 4956 labelled on-screen pieces. r4
model run on CPU (960 px, whole frame, cached), colour detectors on the same frames. "Phantom" = a detection that is
not on any labelled piece (per 1000 frames). "Swap" = Seldon-1 called Seldon-2 or the reverse. Centre error is ~1.5 mm
for the model; colour blobs are 2-13 mm off (loose operating point 2.5 mm). Colour rows are per-frame, no tracker.
Scripts: `camera/training/colour_study/` (run order: pred, scr, gt, tune_blob, merge, run_eval, report).

## Headline (all four pieces together)

| method | recall | phantoms /1000 fr | S1<->S2 swaps | notes |
|---|---|---|---|---|
| model conf >= 0.25 | 97.2% | 45 | 2 | |
| model conf >= 0.5 | 94.7% | 22 | 6 | |
| model conf >= 0.10 | 98.0% | 92 | 1 | |
| tracker's colour rules, per frame (colour_fix + colourless halving + placeable) | 95.3% | 71 | 4 | worse than plain model >= 0.30 (97.0% / 40 / 3) |
| the same rules as blobs on the screen (no extra tuning) | 94.6% | 23758 | 4 | useless without strict gating |
| new colour detector, strict (top-hat + tuned HSV + blob limits) | 78.3% | 73 | 13 | tuned on train labels |
| new colour detector, mid | 88.0% | 243 | 6 | |
| new colour detector, loose | 90.0% | 433 | 1 | |
| fusion: model OR colour (strict) | 98.0% | 101 | 2 | +0.8 pt recall, +56 phantoms |
| fusion: model confirmed by colour | 77.5% | 18 | 16 | kills recall |
| fusion: colour overrides Seldon identity | 96.9% | 45 | 20 | 10x the swaps |
| fusion: model >= 0.5, or >= 0.1 with colour, or colour only | 95.9% | 80 | 6 | |

## Per piece (val)

| piece | model 0.25: recall / phantoms / id-err | tracker colour rules | colour strict (all blobs) | colour loose (top-1) |
|---|---|---|---|---|
| Earth | 92.1% / 21 / 33 | 86.7% / 16 / 48 | 81.1% / 75 / 37 | 90.6% / 192 / 18 |
| Moon | 99.3% / 7 / 4 | 99.3% / 7 / 4 | 90.9% / 27 / 0 | 82.3% / 159 / 0 |
| Seldon-1 | 98.9% / 9 / 2 | 96.1% / 13 / 5 | 81.0% / 9 / 4 | 85.8% / 54 / 9 |
| Seldon-2 | 98.7% / 8 / 0 | 99.3% / 35 / 0 | 65.4% / 1 / 34 | 98.4% / 28 / 0 |

(id-err counts a detection of another piece sitting on the labelled one with no detection of the right class: for
Earth it is mostly Earth missed while the Moon or a Seldon is held beside it.) Seldon-2 loose colour is the only
colour result that matches the model's recall, at 3.5x the phantoms and with live thresholds that don't transfer.

## By condition (recall, all pieces)

| method | piece near/under hand (n=1283) | free (n=3322) | dark surround (n=4764) | bright surround (n=192) | phantoms near a hand |
|---|---|---|---|---|---|
| model 0.25 | 94.9% | 97.9% | 97.3% | 96.4% | 45 of 69 |
| model 0.5 | 86.3% | 97.5% | 94.7% | 95.8% | 14 of 34 |
| model 0.10 | 97.7% | 98.0% | 98.1% | 96.4% | 97 of 140 |
| tracker colour rules | 88.4% | 97.6% | 95.2% | 96.4% | 83 of 108 |
| colour strict, top-1 | 46.6% | 90.2% | 78.9% | 63.5% | |
| colour loose, top-1 | 73.5% | 95.6% | 91.5% | 53.1% | |

Colour is worst exactly where the owner wants help: a piece in a hand (fingers cover it, skin is hue-adjacent to
yellow and red). Skin also makes most phantoms for both (the model's phantoms are mostly fingertips labelled Seldon,
0.3-0.75 confidence); colour does not remove them. "Bright" is only 192 instances (Earth 67, Moon 125, no Seldons):
the labelled data is almost all a black screen, so **the bright-page / blue-glow case cannot be validated here**.

## Live check (no labels): 160 frames from 4 of today's recordings, real page on the screen

Model >= 0.25 vs the colour detector, screen from the recording's calibration:

| colour setting | agree (E / M / S1 / S2) | colour-only blobs (E / M / S1 / S2) | model-only (E / M / S1 / S2) |
|---|---|---|---|
| strict | 39 / 91 / 0 / 54 | 29 / 166 / 0 / 44 | 69 / 179 / 220 / 158 |
| loose | 100 / 166 / 7 / 164 | 145 / 205 / 0 / 344 | 15 / 104 / 215 / 42 |

Looking at the colour-only crops: blue readout digits on the page (Earth), hands, a shoe and table edge (Moon),
the orange cable (Seldon-2). Seldon-1 is almost never found by colour: confident model detections (>= 0.6) have core
colour S~98, V~135 live vs S~191, V~93 in the labels. With the tracker's own rules (yellow: hue 15-31, S > 100) 39 of
172 confident live Seldon-1 detections have under 1% of their own colour, so `colourless()` halves their confidence
(Earth: 0 of 88, Seldon-2: 2 of 159).

## What worked / what did not

- Colour never beats the model on recall or phantoms, anywhere. Model low-confidence detections already give the
  recall colour could add (model >= 0.10: Earth in hand 95% vs 64% with the tracker's rules).
- Colour identity is worse than the model's: 2 swaps in 2798 Seldon pieces for the model; letting colour override it gives 20-34, and colour alone 13 (strict) at its best.
- The two controlled gains: Earth +3 pt recall from "model OR colour" at the price of 55 extra Earth phantoms per
  1000 frames (live: most colour-only Earth blobs are readout digits), and Seldon-2 loose colour matching the model.
  Neither is a clear win.
- Per-frame ablation of the tracker's colour rules vs plain model >= 0.30 (97.0% / 40 / 3 swaps):

| rule | recall | phantoms | effect |
|---|---|---|---|
| colour_fix (relabel) | 96.9% | 41 | 4 swaps, no gain |
| colourless halving | 96.6% | 34 | Seldon-1 -1 pt, live 23% of Seldon-1 halved |
| colour placement (COLOUR_PLACE) | -- | +28 Seldon-2 | +1 pt Seldon-2 recall for 6x the Seldon-2 phantoms |
| Earth size floor 64 mm | -- | 0 here | Earth recall -4 pt (-19 pt in hand): 25% of in-hand Earths are < 64 mm |
| all rules together | 95.3% | 71 | |

The size floor was added for the readout-text glow (48-61 mm), which is not in the labelled data, so its benefit is
not testable here; its cost is.

## What the tracker should do

1. Colour stays a weak, optional signal. Do not place or confirm any piece on colour alone (Earth never; Seldons not
   without the model's weak detection as well).
2. `COLOUR_PLACE`: disable (set 9). Keep weak placement on the model's own confidence: `CONF_NEW` 0.30 is fine (0.25
   gives +0.2 pt recall and +5 phantoms, not worth it).
3. `colourless()` halving: apply only when conf < 0.5 (or remove). It misfires on today's exposure.
4. `colour_fix`: only when conf < 0.5 and `COLOUR_RATIO` 6 (neutral on val, removes one-frame flips of confident boxes);
   continuity (rule 1) already gives identity.
5. `PLACE_MIN_MM['earth']`: keep 64 for new placements until checked with replay.py on a recording that shows
   readout text; if glow phantoms turn out rare, use 45 (recovers about 3 pt of Earth recall, mostly held pieces).
6. If colour is wanted as extra evidence, make it self-calibrating: keep a running median HSV of each piece's
   confident (>= 0.8) boxes and score weak boxes against that, instead of fixed thresholds. That removes the
   exposure problem but is untested; fixed thresholds are not safe.
7. To settle the bright-page question, record ~5 minutes with the page on (stars, orbits, readouts) and pieces
   standing still, label them, and rerun `colour_study/run_eval.py`. Until then Earth colour must stay banned.

## Caveats

- Val frames are contiguous blocks from the same sessions as train (neighbouring blocks): flatters the model.
- The labels were made by a vote of DINO, SAM and the colour boxes (`prompts.json`, `colour_ok`): flatters colour.
  Colour still loses, so the direction is robust.
- Screen mask for the labelled set is the median-dark hull per session, not the calibration; phantom counts are
  approximate. Matching radius is half the label box plus 8 px (1280 px frame, ~1.75 mm/px).
- Per-frame only; the tracker's holds, confirmations and gating are not in these numbers.
- The labelled data is Oct 6-7 exposure; the live check is Oct 12.
