"""colorcheck.py — second opinion on a detection's identity from colour alone.

The coloured pieces are dim but saturated through the polarizer film. Per box, the fraction of its pixels that pass
each piece's HSV rule (the rules color_prompts.py uses to prompt SAM, tuned on the Oct 6 polarized video):
  Seldon-1 yellow  hue 15-31, s > 100, v > 45
  Seldon-2 red     hue >= 165 or <= 6, s > 110, v > 35
  Earth blue       hue 85-118, s > 70, v > 28
The tracker uses the scores to confirm or correct the model's class (tracker.py, Tracker.colour_fix).
"""
import cv2
import numpy as np

SW = 640                                   # work width (px): one small HSV image per frame
ROLES = ('earth', 'seldon-1', 'seldon-2')


def masks(hsv):
    h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    return {'earth': (h >= 85) & (h <= 118) & (s > 70) & (v > 28),
            'seldon-1': (h >= 15) & (h <= 31) & (s > 100) & (v > 45),
            'seldon-2': ((h >= 165) | (h <= 6)) & (s > 110) & (v > 35)}


def colour_scores(frame, boxes, step=3):
    """frame BGR (any size), boxes [(x1, y1, x2, y2)] in its pixels -> [[earth, seldon-1, seldon-2] fractions].
    Only the pixels inside each box are read (every `step`-th row and column): well under a millisecond per frame."""
    fh, fw = frame.shape[:2]
    out = []
    for x1, y1, x2, y2 in boxes:
        a, b = max(0, int(x1)), max(0, int(y1))
        c, d = min(fw, max(a + 1, int(round(x2)))), min(fh, max(b + 1, int(round(y2))))
        crop = np.ascontiguousarray(frame[b:d:step, a:c:step])
        if crop.size == 0:
            out.append([0.0, 0.0, 0.0]); continue
        m = masks(cv2.cvtColor(crop, cv2.COLOR_BGR2HSV))
        out.append([round(float(m[k].mean()), 3) for k in ROLES])
    return out
