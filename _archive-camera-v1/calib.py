#!/usr/bin/env python
"""ArUco corner-marker calibration: make printable markers, detect the board corners.

PLACEMENT CONVENTION (important):
  DICT_4X4_50, ids 0,1,2,3 = TL, TR, BR, BL corner of the BOARD (playing area).
  Each marker sits just INSIDE its board corner, with the marker's OUTER corner
  touching the board corner. The board corner is therefore:
      id0 (TL) -> marker's top-left corner      id1 (TR) -> marker's top-right corner
      id3 (BL) -> marker's bottom-left corner   id2 (BR) -> marker's bottom-right corner
  Markers must be printed upright (not rotated) with the black border edge flush
  with the board edges. Printed size is irrelevant to detection, only to fit.

Usage:
  python calib.py make [--size-in 2.0] [--dpi 300]   # writes markers/*.png
  python calib.py test <image>                       # prints detected corners
"""
import argparse
import os
import sys

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "markers")
DICT = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
NAMES = ["TL", "TR", "BR", "BL"]  # index == marker id == marker corner index used

_params = cv2.aruco.DetectorParameters()
_params.cornerRefinementMethod = cv2.aruco.CORNER_REFINE_SUBPIX
_params.cornerRefinementWinSize = 5
_detector = cv2.aruco.ArucoDetector(DICT, _params)


def detect_board_corners(frame_bgr):
    """Return float32 (4,2) board corners TL,TR,BR,BL in camera px, or None.
    Requires all four markers (a 3-of-4 guess is not accurate under perspective)."""
    if frame_bgr is None:
        return None
    gray = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY) if frame_bgr.ndim == 3 else frame_bgr
    corners, ids, _ = _detector.detectMarkers(gray)
    if ids is None:
        return None
    found = {}
    for c, i in zip(corners, ids.flatten()):
        if 0 <= i <= 3 and i not in found:
            # marker corner k (TL,TR,BR,BL) of marker k is the board corner
            found[int(i)] = np.asarray(c, np.float32).reshape(4, 2)[int(i)]
    if len(found) < 4:
        return None
    out = np.array([found[k] for k in range(4)], np.float32)
    # sanity: quad must be convex-ish and consistently ordered (TL,TR,BR,BL clockwise)
    area = 0.5 * np.sum(out[:, 0] * np.roll(out[:, 1], -1) - np.roll(out[:, 0], -1) * out[:, 1])
    if area < 100:
        return None
    return out


def _marker(id_, px):
    return cv2.aruco.generateImageMarker(DICT, id_, px)


def make(size_in, dpi):
    os.makedirs(OUT_DIR, exist_ok=True)
    px = int(round(size_in * dpi))
    W, H = int(8.5 * dpi), int(11 * dpi)
    sheet = np.full((H, W), 255, np.uint8)
    font = cv2.FONT_HERSHEY_SIMPLEX
    fs = dpi / 300.0
    pad = int(0.15 * dpi)  # white margin inside cut line
    for k in range(4):
        m = _marker(k, px)
        cv2.imwrite(os.path.join(OUT_DIR, "marker_%d_%s.png" % (k, NAMES[k])), m)
        cx, cy = (W // 4) * (1 + 2 * (k % 2)), (H // 4) * (1 + 2 * (k // 2))
        x0, y0 = cx - px // 2, cy - px // 2
        sheet[y0:y0 + px, x0:x0 + px] = m
        # dashed cut line around marker
        a, b = (x0 - pad, y0 - pad), (x0 + px + pad, y0 + px + pad)
        for x in range(a[0], b[0], 20):
            for y in (a[1], b[1]):
                cv2.line(sheet, (x, y), (min(x + 10, b[0]), y), 0, 1)
        for y in range(a[1], b[1], 20):
            for x in (a[0], b[0]):
                cv2.line(sheet, (x, y), (x, min(y + 10, b[1])), 0, 1)
        cv2.putText(sheet, "%s id%d" % (NAMES[k], k), (a[0], b[1] + int(40 * fs)), font, 1.0 * fs, 0, max(1, int(2 * fs)))
    cv2.putText(sheet, "Print at 100%% (no scaling): each marker = %.2f in. Cut on dashed line." % size_in,
                (int(0.4 * dpi), H - int(0.4 * dpi)), font, 0.7 * fs, 0, max(1, int(fs)))
    cv2.imwrite(os.path.join(OUT_DIR, "corner_markers_sheet.png"), sheet,
                [cv2.IMWRITE_PNG_COMPRESSION, 9])
    print("wrote 4 marker PNGs + corner_markers_sheet.png in %s (%dpx = %.2f in @ %d dpi)" % (OUT_DIR, px, size_in, dpi))


def _selftest():
    """Synthetic perspective test + no-marker test."""
    BW, BH, M = 1000, 700, 110  # flat board (units) and marker size
    flat = np.full((BH + 100, BW + 100), 255, np.uint8)  # 50 unit white margin
    o = 50
    pos = {0: (o, o), 1: (o + BW - M, o), 2: (o + BW - M, o + BH - M), 3: (o, o + BH - M)}
    for k, (x, y) in pos.items():
        flat[y:y + M, x:x + M] = _marker(k, M)
    board = np.float32([[o, o], [o + BW, o], [o + BW, o + BH], [o, o + BH]])
    truth = np.float32([[430, 190], [1540, 150], [1700, 880], [260, 940]])  # tilted quad
    H = cv2.getPerspectiveTransform(board, truth)
    img = cv2.warpPerspective(flat, H, (1920, 1080), borderValue=255)
    img = cv2.GaussianBlur(img, (0, 0), 1.2).astype(np.float32)
    img += np.random.default_rng(0).normal(0, 4, img.shape)
    img = cv2.cvtColor(np.clip(img, 0, 255).astype(np.uint8), cv2.COLOR_GRAY2BGR)
    got = detect_board_corners(img)
    assert got is not None and got.shape == (4, 2) and got.dtype == np.float32, "no detection"
    err = np.linalg.norm(got - truth, axis=1)
    print("truth", truth.tolist(), "\ngot  ", got.round(2).tolist(), "\nerr px", err.round(2))
    assert err.max() < 2.0, "error too big"
    assert detect_board_corners(np.full((1080, 1920, 3), 255, np.uint8)) is None
    # missing one marker -> None
    cv2.rectangle(img, (0, 0), (700, 400), (255, 255, 255), -1)
    assert detect_board_corners(img) is None
    print("selftest OK")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    m = sub.add_parser("make")
    m.add_argument("--size-in", type=float, default=2.0)
    m.add_argument("--dpi", type=int, default=300)
    t = sub.add_parser("test")
    t.add_argument("image", nargs="?")
    a = ap.parse_args()
    if a.cmd == "make":
        make(a.size_in, a.dpi)
    elif a.image:
        img = cv2.imread(a.image)
        if img is None:
            sys.exit("cannot read %s" % a.image)
        print(detect_board_corners(img))
    else:
        _selftest()


if __name__ == "__main__":
    main()
