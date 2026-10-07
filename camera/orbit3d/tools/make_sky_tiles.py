"""make_sky_tiles.py — cut NASA's Deep Star Maps 2020 (galactic, equirectangular EXR) into a zoom pyramid for demo.html.

Source: https://svs.gsfc.nasa.gov/4851  starmap_2020_<N>k_gal.exr
Credit: NASA/Goddard Space Flight Center Scientific Visualization Studio. Gaia DR2: ESA/Gaia/DPAC.

Output (assets/sky/):
  base.jpg              level 0, the whole sky at 4096 x 2048
  L<l>/<row>_<col>.jpg  level l >= 1: the sky at 4096*2^l x 2048*2^l, cut into 2048 px square tiles
  meta.json             { levels, tile, base: [w, h], credit }

Reads the EXR in 512-row strips (never the whole image), downsamples in linear light, then encodes sRGB with the
exposure fitted to NASA's own preview (1.0). Usage: python tools/make_sky_tiles.py <starmap_gal.exr> [out_dir]
"""
import json
import sys
from pathlib import Path

import Imath
import numpy as np
import OpenEXR
from PIL import Image

EXPOSURE = 1.0
TILE = 2048
STRIP = 512
QUALITY = 92
# colour grade, baked in at full precision BEFORE JPEG (doing it in the shader amplified compression noise in the darks):
# a per-channel lookup that matches the Gaia map's colour distribution to the ESO photo's, blended at GRADE_AMT
GRADE_LUT = Path(__file__).resolve().parent / "sky_grade_lut.png"
GRADE_AMT = 0.85
_lut = np.asarray(Image.open(GRADE_LUT).convert("RGB"), np.float32)[0] / 255.0 if GRADE_LUT.exists() else None


def enc(lin):
    lin = np.clip(lin * EXPOSURE, 0.0, 1.0)
    s = np.where(lin <= 0.0031308, 12.92 * lin, 1.055 * np.power(lin, 1 / 2.4) - 0.055)
    if _lut is not None and GRADE_AMT > 0:
        xs = np.arange(256, dtype=np.float32) / 255.0
        g = np.stack([np.interp(s[..., c], xs, _lut[:, c]) for c in range(3)], -1)
        s = s + (g - s) * GRADE_AMT
    return (np.clip(s, 0, 1) * 255 + 0.5).astype(np.uint8)


def down2(a):
    h, w, c = a.shape
    return a.reshape(h // 2, 2, w // 2, 2, c).mean((1, 3))


def main(src, out):
    OpenEXR.set_global_thread_count(2)          # gentle on the laptop
    f = OpenEXR.InputFile(str(src))
    dw = f.header()["dataWindow"]
    W, H = dw.max.x - dw.min.x + 1, dw.max.y - dw.min.y + 1
    top = int(round(np.log2(W / 4096)))         # top level index (32k -> 3)
    assert W == 4096 * 2 ** top and H == W // 2, (W, H)
    out = Path(out); out.mkdir(parents=True, exist_ok=True)
    half = Imath.PixelType(Imath.PixelType.HALF)
    # uint8 canvases for every level below the top (top-level tiles are written band by band)
    canv = {l: np.zeros((2048 * 2 ** l, 4096 * 2 ** l, 3), np.uint8) for l in range(top)}
    band = np.zeros((TILE, W, 3), np.uint8)
    for y0 in range(0, H, STRIP):
        y1 = min(H, y0 + STRIP) - 1
        lin = np.stack([np.frombuffer(f.channel(c, half, y0, y1), np.float16).reshape(-1, W).astype(np.float32) for c in "RGB"], -1)
        band[(y0 % TILE):(y0 % TILE) + lin.shape[0]] = enc(lin)
        a, l = lin, top
        while l > 0:                            # lower levels, averaged in linear light
            a, l = down2(a), l - 1
            f_ = 2 ** (top - l)
            canv[l][y0 // f_:y0 // f_ + a.shape[0]] = enc(a)
        if (y0 + STRIP) % TILE == 0 or y1 == H - 1:
            r = y0 // TILE
            (out / f"L{top}").mkdir(exist_ok=True)
            for c in range(W // TILE):
                Image.fromarray(band[:, c * TILE:(c + 1) * TILE]).save(out / f"L{top}" / f"{r}_{c}.jpg", quality=QUALITY)
            print(f"rows {y0 + STRIP}/{H}", flush=True)
    for l in range(1, top):
        (out / f"L{l}").mkdir(exist_ok=True)
        img = canv[l]
        for r in range(img.shape[0] // TILE):
            for c in range(img.shape[1] // TILE):
                Image.fromarray(img[r * TILE:(r + 1) * TILE, c * TILE:(c + 1) * TILE]).save(out / f"L{l}" / f"{r}_{c}.jpg", quality=QUALITY)
    Image.fromarray(canv[0] if top > 0 else band[:2048]).save(out / "base.jpg", quality=92)
    (out / "meta.json").write_text(json.dumps({"levels": top, "tile": TILE, "base": [4096, 2048],
        "credit": "NASA/Goddard Space Flight Center Scientific Visualization Studio. Gaia DR2: ESA/Gaia/DPAC."}))
    print("done", out)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else Path(__file__).resolve().parent.parent / "assets" / "sky")
