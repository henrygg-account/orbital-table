"""Static 4K backgrounds for the table (demo.html ?bg=<name>, key B cycles them), one JPEG each in assets/bg/.

Real-sky options are flat (gnomonic) views cut from the same NASA/Gaia star map tiles the moving sky uses
(assets/sky/L<l>/<row>_<col>.jpg: galactic equirectangular, l = 0 at the centre, increasing to the left). Only the tiles a
view needs are read. The rest are drawn.

  python tools/make_backgrounds.py            all of them
  python tools/make_backgrounds.py deep ink   some
"""
import sys
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent.parent
SKY = HERE / 'assets' / 'sky'
OUT = HERE / 'assets' / 'bg'
W, H = 3840, 2160
INK = np.array([10, 13, 13], np.float32) / 255          # gg-table.css page ink (#0a0d0d), RGB


def sky_view(l0, b0, vfov, roll=0.0, level=3):
    """A flat view of the star map centred on galactic (l0, b0) degrees, vfov degrees tall, rolled by roll degrees."""
    sw, sh = 4096 * 2 ** level, 2048 * 2 ** level
    f = (H / 2) / np.tan(np.radians(vfov) / 2)
    X, Y = np.meshgrid((np.arange(W) - W / 2 + .5) / f, (H / 2 - np.arange(H) - .5) / f)
    l0r, b0r, rr = np.radians(l0), np.radians(b0), np.radians(roll)
    c = np.array([np.cos(b0r) * np.cos(l0r), np.cos(b0r) * np.sin(l0r), np.sin(b0r)])
    e = np.array([-np.sin(l0r), np.cos(l0r), 0.0])                  # increasing l
    n = np.array([-np.sin(b0r) * np.cos(l0r), -np.sin(b0r) * np.sin(l0r), np.cos(b0r)])
    right, up = -e * np.cos(rr) + n * np.sin(rr), n * np.cos(rr) + e * np.sin(rr)   # seen from inside: east is left
    d = c + X[..., None] * right + Y[..., None] * up
    d /= np.linalg.norm(d, axis=-1, keepdims=True)
    lon, lat = np.degrees(np.arctan2(d[..., 1], d[..., 0])), np.degrees(np.arcsin(d[..., 2]))
    x = ((180 - lon) / 360 % 1) * sw
    y = (90 - lat) / 180 * sh
    xc = (180 - l0) / 360 % 1 * sw                                   # unwrap around the view centre
    x = (x - xc + sw / 2) % sw - sw / 2 + xc
    T = 2048
    c0, c1 = int(np.floor(x.min() / T)), int(np.floor(x.max() / T))
    r0, r1 = max(0, int(y.min() // T)), min(sh // T - 1, int(y.max() // T))
    mos = np.zeros(((r1 - r0 + 1) * T, (c1 - c0 + 1) * T, 3), np.uint8)
    for r in range(r0, r1 + 1):
        for cc in range(c0, c1 + 1):
            t = cv2.imread(str(SKY / f'L{level}' / f'{r}_{cc % (sw // T)}.jpg'))
            mos[(r - r0) * T:(r - r0 + 1) * T, (cc - c0) * T:(cc - c0 + 1) * T] = t
    img = cv2.remap(mos, (x - c0 * T - .5).astype(np.float32), (y - r0 * T - .5).astype(np.float32), cv2.INTER_CUBIC)
    return img[..., ::-1].astype(np.float32) / 255                    # RGB 0..1 (display-encoded)


def grade(img, black=0.0, gain=1.0, gamma=1.0, sat=1.0):
    """Black point, gain, gamma, saturation on a display-encoded image; returns it floored at the page ink."""
    img = np.clip((img - black) / (1 - black), 0, 1) ** gamma * gain
    g = img.mean(-1, keepdims=True)
    img = g + (img - g) * sat
    return np.clip(np.maximum(img, 0) + INK * (1 - np.clip(img.max(-1, keepdims=True) * 4, 0, 1)), 0, 1)


def vignette(strength=.35, cx=.5, cy=.5):
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    r = np.hypot((xx / W - cx) * W / H, yy / H - cy) / np.hypot(.5 * W / H, .5)
    return (1 - strength * r ** 2)[..., None]


def stars(n, seed, bright=1.0, size=1.0):
    """n drawn stars: brightness from a steep power law (most faint, a few bright), slight colour, sub-pixel placement."""
    rng = np.random.default_rng(seed)
    acc = np.zeros((H, W, 3), np.float32)
    mag = rng.pareto(2.2, n) + 1                                     # 1 .. long tail
    xs, ys = rng.uniform(0, W, n), rng.uniform(0, H, n)
    temp = rng.normal(0, 1, n)
    for x, y, m, t in zip(xs, ys, mag, temp):
        a = min(1.0, .05 * m ** 1.3) * bright
        col = np.array([1 + .08 * t, 1, 1 - .12 * t], np.float32).clip(.7, 1.1)
        s = .55 * size * (1 + .25 * np.log(m))                       # gaussian sigma in px
        k = int(np.ceil(3 * s)) + 1
        ix, iy = int(x), int(y)
        x0, x1, y0, y1 = max(0, ix - k), min(W, ix + k + 1), max(0, iy - k), min(H, iy + k + 1)
        gx, gy = np.meshgrid(np.arange(x0, x1) + .5 - x, np.arange(y0, y1) + .5 - y)
        acc[y0:y1, x0:x1] += (a * np.exp(-(gx ** 2 + gy ** 2) / (2 * s * s)))[..., None] * col
    return acc


def linear(c): return np.where(c <= .04045, c / 12.92, ((c + .055) / 1.055) ** 2.4)
def encode(c): return np.where(c <= .0031308, c * 12.92, 1.055 * np.clip(c, 0, None) ** (1 / 2.4) - .055)


def glow_bg(centre, edge, cx=.5, cy=.5, power=1.6):
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    r = np.clip(np.hypot((xx / W - cx) * W / H, yy / H - cy) / np.hypot(.5 * W / H, .5), 0, 1)[..., None] ** power
    return linear(np.array(centre, np.float32) / 255) * (1 - r) + linear(np.array(edge, np.float32) / 255) * r


def dither(img, seed=0):   # fine noise, half a code value: no banding in the dark gradients
    return img + np.random.default_rng(seed).uniform(-.5, .5, img.shape).astype(np.float32) / 255


def save(name, img):
    OUT.mkdir(parents=True, exist_ok=True)
    out = np.clip(dither(img) * 255 + .5, 0, 255).astype(np.uint8)
    cv2.imwrite(str(OUT / f'{name}.jpg'), out[..., ::-1], [cv2.IMWRITE_JPEG_QUALITY, 93])
    print(name, out.mean().round(1), (OUT / f'{name}.jpg').stat().st_size // 1024, 'KB')


def deep():      # real stars, far from the Milky Way (Lynx / Ursa Major, b ~ +40): sparse, no band, the haze taken out
    img = sky_view(165, 42, 30, roll=0)
    save('deep', grade(img, black=.05, gain=1.0, gamma=1.05, sat=.6) * vignette(.25))


def band():      # the Milky Way kept, but quiet: the outer galaxy (Cassiopeia-Perseus), dimmed, desaturated, soft
    img = sky_view(120, 0, 42, roll=-22, level=2)
    img = cv2.GaussianBlur(img, (0, 0), 1.2)
    save('band', grade(img, black=.04, gain=.8, gamma=1.15, sat=.5) * vignette(.35))


def ink():       # drawn: the page ink, a faint lift in the middle, 1,800 small stars
    base = glow_bg((16, 21, 24), (6, 8, 9))
    s = stars(1800, 7, bright=2.2)
    save('ink', np.clip(encode(base + linear(np.clip(s, 0, 1)) * .9), 0, 1))


def studio():    # drawn: a deep blue glow behind the middle, near black at the corners, a few hundred faint stars
    base = glow_bg((14, 26, 40), (4, 5, 7), power=1.3)
    s = stars(450, 11, bright=1.6)
    save('studio', np.clip(encode(base + linear(np.clip(s, 0, 1)) * .8), 0, 1))


def black():     # nothing: near-black, flat (the graphics are all there is)
    save('black', np.clip(encode(glow_bg((9, 11, 12), (6, 7, 8))), 0, 1))


ALL = {'deep': deep, 'band': band, 'ink': ink, 'studio': studio, 'black': black}
if __name__ == '__main__':
    for k in (sys.argv[1:] or ALL):
        ALL[k]()
