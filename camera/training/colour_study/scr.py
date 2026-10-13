import sys, numpy as np, cv2, pickle
from common import *
split = sys.argv[1]; WIN = int(sys.argv[2]); every = int(sys.argv[3])
fs = files(split)[::every]
SW = 320


def small(f):
    return cv2.resize(img(split, f), (SW, SW * 3 // 4), interpolation=cv2.INTER_AREA)


def mask_of(frames):
    bg = np.median(np.stack(frames), axis=0).astype(np.uint8)
    hsv = cv2.cvtColor(bg, cv2.COLOR_BGR2HSV)
    dark = cv2.inRange(hsv, (0, 0, 0), (180, 255, 24))
    dark = cv2.morphologyEx(dark, cv2.MORPH_OPEN, np.ones((15, 15), np.uint8))   # cut arms and chair legs off the screen
    n, lab, st, _ = cv2.connectedComponentsWithStats(dark)
    k = 1 + int(np.argmax(st[1:, cv2.CC_STAT_AREA]))
    m = np.zeros(dark.shape, np.uint8)
    hull = cv2.convexHull(cv2.findNonZero((lab == k).astype(np.uint8)))
    per = cv2.arcLength(hull, True)
    cv2.fillConvexPoly(m, cv2.approxPolyDP(hull, 0.004 * per, True), 1)
    m = cv2.dilate(m, np.ones((5, 5), np.uint8))
    return m


# 1. window masks, 2. merge consecutive windows with the same mask (same camera setup), 3. recompute from many frames
wins = [fs[s:s + WIN] for s in range(0, len(fs), WIN)]
sm = [small(f) for f in fs]; pos = {f: i for i, f in enumerate(fs)}
wm = [mask_of([sm[pos[f]] for f in w[::max(1, len(w) // 15)]]) for w in wins]
groups = [[]]                                   # one camera setup per source video prefix (fixed rig)
for i in range(len(wins)):
    if groups[-1] and wins[i][0].split('_')[0] != wins[groups[-1][0]][0].split('_')[0]: groups.append([])
    groups[-1].append(i)
idx, masks = {}, []
for g in groups:
    allf = [f for i in g for f in wins[i]]
    sel = allf[::max(1, len(allf) // 150)]
    masks.append(mask_of([sm[pos[f]] for f in sel]))
    for f in allf: idx[f] = len(masks) - 1
pickle.dump((idx, np.stack(masks)), open(R + rf'\colour\scr_{split}.pkl', 'wb'))
tiles = []
for gi, g in enumerate(groups):
    f = wins[g[len(g) // 2]][0]
    t = img(split, f).copy(); t = cv2.resize(t, (SW, SW * 3 // 4))
    cs, _ = cv2.findContours(masks[gi], cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cv2.drawContours(t, cs, -1, (0, 255, 0), 1); tiles.append(t)
rows = [np.hstack(tiles[i:i + 6] + [np.zeros_like(tiles[0])] * (6 - len(tiles[i:i + 6]))) for i in range(0, len(tiles), 6)]
cv2.imwrite(R + rf'\colour\scr_{split}.jpg', np.vstack(rows))
print(len(fs), len(wins), len(groups), [len(g) for g in groups])
