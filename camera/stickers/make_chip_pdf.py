"""Printable mode chips: ArUco DICT_4X4_50 markers (ids 10-12; 0-4 are the on-screen calibration markers).

  python make_chip_pdf.py  ->  mode_chips.pdf (US Letter, print at 100% / "actual size")

Each chip is a 40 mm marker with a 8 mm white border (56 mm square, cut on the grey line). One chip is all
the table needs; the other two are spares. A 100 mm bar checks the print scale.
"""
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

DPI = 600
mm = lambda v: int(round(v / 25.4 * DPI))
W, H = mm(215.9), mm(279.4)
MARK, BORDER = 40, 8
IDS = [10, 11, 12]

page = Image.new('L', (W, H), 255)
d = ImageDraw.Draw(page)
try:
    font = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf', mm(4))
    small = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf', mm(3))
except OSError:
    font = small = ImageFont.load_default()

cell = mm(MARK) // 6                                  # 4x4 bits + 1-cell black frame each side
side = cell * 6
chip = mm(MARK + 2 * BORDER)
x0, y0 = mm(25), mm(30)
d.text((x0, mm(12)), 'MODE CHIP  -  print at 100% (actual size), cut on the grey lines', font=font, fill=0)
for k, mid in enumerate(IDS):
    cx, cy = x0 + k * (chip + mm(8)), y0
    d.rectangle([cx, cy, cx + chip, cy + chip], outline=150, width=mm(.3))
    m = cv2.aruco.generateImageMarker(cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50), mid, side)
    off = (chip - side) // 2
    page.paste(Image.fromarray(m), (cx + off, cy + off))
    d.text((cx, cy + chip + mm(2)), f'id {mid}' + ('  (use this one)' if k == 0 else '  spare'), font=small, fill=0)

by = y0 + chip + mm(20)
d.rectangle([x0, by, x0 + mm(100), by + mm(3)], fill=0)
d.text((x0, by + mm(5)), 'this bar must measure exactly 100 mm', font=small, fill=0)
d.text((x0, by + mm(14)), 'Tip: glue the chip to card or a thin printed disc so it lies flat; keep the marker uncovered.',
       font=small, fill=0)
out = Path(__file__).with_name('mode_chips.pdf')
page.save(out, resolution=DPI)
print('wrote', out, f'marker {side / DPI * 25.4:.1f} mm')
