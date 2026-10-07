#!/usr/bin/env python
"""Lens-distortion calibration with a printed checkerboard -> lens.json.

  python lens.py make-board                       # markers/checkerboard_9x6.png (letter landscape, 25 mm squares, 300 dpi)
  python lens.py capture [--out lens_shots]       # interactive: SPACE grabs when board found, q finishes
  python lens.py solve --images DIR --board 9x6 --square-mm 25
Board size = number of INNER corners (9x6 -> 10x7 squares).
API: load_lens() -> dict or None; undistort_points(pts, lens) -> Nx2 float32 (undistorted camera px).
"""
import argparse
import glob
import json
import os
import sys

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
LENS_JSON = os.path.join(HERE, "lens.json")


def load_lens(path=LENS_JSON):
    """Return {'K': 3x3, 'dist': (1,n), 'size': (w,h), 'rms': float} or None."""
    if not os.path.exists(path):
        return None
    try:
        d = json.load(open(path))
        return {"K": np.array(d["K"], np.float64), "dist": np.array(d["dist"], np.float64).reshape(1, -1),
                "size": tuple(d["size"]), "rms": d.get("rms")}
    except Exception:
        return None


def undistort_points(pts, lens):
    """Remove lens distortion from Nx2 camera-pixel points; output stays in camera pixels."""
    p = np.asarray(pts, np.float64).reshape(-1, 1, 2)
    if lens is None or p.size == 0:
        return p.reshape(-1, 2).astype(np.float32)
    out = cv2.undistortPoints(p, lens["K"], lens["dist"], P=lens["K"])
    return out.reshape(-1, 2).astype(np.float32)


def _parse_board(s):
    c, r = s.lower().split("x")
    return int(c), int(r)


def make_board(cols=9, rows=6, square_mm=25, dpi=300):
    """Letter-size landscape page, checkerboard of (cols+1)x(rows+1) squares centered; square size exact."""
    W, H = int(11 * dpi), int(8.5 * dpi)  # landscape
    sq = square_mm / 25.4 * dpi
    nx, ny = cols + 1, rows + 1
    page = np.full((H, W), 255, np.uint8)
    x0, y0 = (W - nx * sq) / 2, (H - ny * sq) / 2
    assert x0 > 0 and y0 > 0, "board does not fit on letter"
    for j in range(ny):
        for i in range(nx):
            if (i + j) % 2 == 0:
                a = (int(round(x0 + i * sq)), int(round(y0 + j * sq)))
                b = (int(round(x0 + (i + 1) * sq)), int(round(y0 + (j + 1) * sq)))
                page[a[1]:b[1], a[0]:b[0]] = 0
    cv2.putText(page, "Print at 100%% (no scaling). Squares = %d mm. Inner corners %dx%d." % (square_mm, cols, rows),
                (int(0.4 * dpi), H - int(0.4 * dpi)), cv2.FONT_HERSHEY_SIMPLEX, 0.7 * dpi / 300, 0, 2)
    os.makedirs(os.path.join(HERE, "markers"), exist_ok=True)
    out = os.path.join(HERE, "markers", "checkerboard_%dx%d.png" % (cols, rows))
    cv2.imwrite(out, page)
    print("wrote", out)


def capture(board, out_dir):
    """Interactive grab. Tape the printed board FLAT on something rigid; show it at many angles/positions."""
    os.makedirs(out_dir, exist_ok=True)
    cap = cv2.VideoCapture(0, cv2.CAP_AVFOUNDATION)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1920)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 1080)
    n = len(glob.glob(os.path.join(out_dir, "*.png")))
    while True:
        ok, f = cap.read()
        if not ok:
            continue
        g = cv2.cvtColor(f, cv2.COLOR_BGR2GRAY)
        found, c = cv2.findChessboardCorners(g, board, cv2.CALIB_CB_FAST_CHECK)
        v = f.copy()
        if found:
            cv2.drawChessboardCorners(v, board, c, True)
        cv2.putText(v, "%d saved | SPACE=grab (needs board) q=done" % n, (20, 40),
                    cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 255, 0) if found else (0, 0, 255), 2)
        cv2.imshow("lens capture", cv2.resize(v, None, fx=0.5, fy=0.5))
        k = cv2.waitKey(1) & 0xFF
        if k == ord("q"):
            break
        if k == ord(" ") and found:
            cv2.imwrite(os.path.join(out_dir, "shot_%02d.png" % n), f)
            n += 1
    cap.release()
    cv2.destroyAllWindows()
    print("saved %d images in %s" % (n, out_dir))


def calibrate(obj_pts, img_pts, size):
    """Run calibrateCamera; returns (rms, K, dist). Uses k1,k2,p1,p2 (k3 fixed at 0: stable for ordinary lenses)."""
    rms, K, dist, _, _ = cv2.calibrateCamera(obj_pts, img_pts, size, None, None, flags=cv2.CALIB_FIX_K3)
    return rms, K, dist


def solve(images, board, square_mm, out=LENS_JSON):
    files = sorted(sum((glob.glob(os.path.join(images, e)) for e in ("*.png", "*.jpg", "*.jpeg")), []))
    objp = np.zeros((board[0] * board[1], 3), np.float32)
    objp[:, :2] = np.mgrid[0:board[0], 0:board[1]].T.reshape(-1, 2) * square_mm
    op, ip, size = [], [], None
    crit = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 40, 0.001)
    for fn in files:
        g = cv2.imread(fn, cv2.IMREAD_GRAYSCALE)
        if g is None:
            continue
        size = (g.shape[1], g.shape[0])
        ok, c = cv2.findChessboardCorners(g, board)
        if not ok:
            print("  no board in", os.path.basename(fn))
            continue
        c = cv2.cornerSubPix(g, c, (11, 11), (-1, -1), crit)
        op.append(objp)
        ip.append(c)
    if len(op) < 8:
        sys.exit("need >= 8 usable images, got %d" % len(op))
    rms, K, dist = calibrate(op, ip, size)
    json.dump({"K": K.tolist(), "dist": dist.reshape(-1).tolist(), "size": list(size), "rms": float(rms)},
              open(out, "w"), indent=1)
    print("%d images, RMS reprojection error %.3f px (good < 0.5)\nK=\n%s\ndist=%s\nsaved %s"
          % (len(op), rms, K.round(2), dist.round(4), out))
    return rms, K, dist


def _selftest():
    import tempfile
    size, board, sq = (1920, 1080), (9, 6), 25.0
    K = np.array([[1400, 0, 975], [0, 1390, 530], [0, 0, 1]], np.float64)
    dist = np.array([-0.12, 0.05, 0.001, -0.0007, -0.01])
    objp = np.zeros((54, 3), np.float32)
    objp[:, :2] = np.mgrid[0:9, 0:6].T.reshape(-1, 2) * sq
    rng = np.random.default_rng(1)
    d = tempfile.mkdtemp()
    ops, ips = [], []
    for _ in range(40):
        rvec = rng.uniform(-0.5, 0.5, 3)
        tvec = np.array([-100 + rng.uniform(-200, 200), -60 + rng.uniform(-120, 120), rng.uniform(380, 650)])
        p, _ = cv2.projectPoints(objp, rvec, tvec, K, dist)
        p = p.reshape(-1, 2) + rng.normal(0, 0.1, (54, 2))
        if p.min() < 0 or p[:, 0].max() > size[0] or p[:, 1].max() > size[1]:
            continue
        ops.append(objp)
        ips.append(p.astype(np.float32).reshape(-1, 1, 2))
    print(len(ops), "poses")
    rms, K2, d2 = calibrate(ops, ips, size)
    print("rms %.3f\nK\n%s\ndist %s" % (rms, K2.round(1), d2.round(4)))
    # compare via the property that matters: undistorting distorted points
    ideal = np.array([[100, 100], [1800, 200], [960, 540], [300, 1000], [1700, 950]], np.float64)
    xn = np.linalg.inv(K) @ np.vstack([ideal.T, np.ones(5)])
    xyz = np.hstack([(xn[:2] / xn[2]).T, np.ones((5, 1))])
    dpts, _ = cv2.projectPoints(xyz, np.zeros(3), np.zeros(3), K, dist)
    lens = {"K": K2, "dist": d2.reshape(1, -1)}
    back = undistort_points(dpts.reshape(-1, 2), lens)
    err = np.linalg.norm(back - ideal, axis=1)
    print("distorted->undistorted err px", err.round(3))
    assert abs(K2[0, 0] - K[0, 0]) / K[0, 0] < 0.02 and abs(K2[0, 2] - K[0, 2]) < 10
    assert err.max() < 1.0, err
    # round-trip through lens.json
    p = os.path.join(d, "lens.json")
    json.dump({"K": K2.tolist(), "dist": d2.reshape(-1).tolist(), "size": list(size), "rms": rms}, open(p, "w"))
    l = load_lens(p)
    assert np.allclose(undistort_points(dpts.reshape(-1, 2), l), back, atol=1e-3)
    assert load_lens(os.path.join(d, "nope.json")) is None
    print("selftest OK")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("make-board")
    c = sub.add_parser("capture")
    c.add_argument("--board", default="9x6")
    c.add_argument("--out", default=os.path.join(HERE, "lens_shots"))
    s = sub.add_parser("solve")
    s.add_argument("--images", required=True)
    s.add_argument("--board", default="9x6")
    s.add_argument("--square-mm", type=float, default=25)
    sub.add_parser("selftest")
    a = ap.parse_args()
    if a.cmd == "make-board":
        make_board()
    elif a.cmd == "capture":
        capture(_parse_board(a.board), a.out)
    elif a.cmd == "solve":
        solve(a.images, _parse_board(a.board), a.square_mm)
    else:
        _selftest()


if __name__ == "__main__":
    main()
