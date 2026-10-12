"""tracker.py — piece tracking built on physical rules, so a bad frame can't make the table glitch.

The detector is treated as a noisy sensor; the tracker decides what is true, under these rules:
  1. Identity comes from continuity, not from the class label. A detection is matched to the piece whose predicted
     position it is near (one joint assignment over all pieces and detections per frame). The label only adds a cost
     when it disagrees, so one mislabelled frame can't swap Seldon-1 and Seldon-2.
  2. Colour is a second opinion. A box whose colour clearly belongs to another coloured piece is relabelled.
  3. Pieces can't overlap. A detection on top of another piece is that piece (or noise), never a second piece.
  4. Pieces can't teleport. A detection beyond a piece's reach (gate grows with hand speed x time unseen) only
     counts after it repeats CONFIRM_FRAMES frames in one spot, and only moves a piece that has been unseen for
     RELOCATE_S at its old spot (picked up and put down elsewhere). A piece that is being seen is never pulled away.
  5. Pieces don't vanish in place. Unseen, a piece holds its position (it is covered). It only leaves the table
     when it was last seen near the screen edge, or after HOLD_S.
  6. New pieces need a confident detection (CONF_NEW) repeated CONFIRM_FRAMES; known pieces are kept on weak ones, but
     only for WEAK_S after their last confident one (a phantom on the screen's own glow fades out). Earth (blue) is never
     placed on colour alone: the screen glows blue through the film.
  7. Size: a box far bigger or smaller than the piece can be (a hand, an arm, a reflection) is ignored.
Published positions keep the stillness lock (deadband) of the earlier tracker; demo.html eases toward them.
Interface used by live.py and replay.py: step(dets, now), feed(now). Every knob is a class attribute (tune.html).
"""
import time

import numpy as np
from scipy.optimize import linear_sum_assignment

BIG = 1e9


class Tracker:
    # association
    GATE_MM = 50.0          # a detection this close to a piece's predicted position can be that piece...
    VMAX_MM_S = 1500.0      # ...plus hand speed x time since it was last seen
    GATE_MAX_MM = 220.0
    ROLE_PENALTY_MM = 40.0  # extra cost for matching a detection whose label is another piece's
    FOOTPRINT_MM = 45.0     # pieces can't be closer than this
    # new pieces and relocations
    CONF_TRACK = 0.05       # weakest detection that keeps a known piece
    CONF_NEW = 0.30         # weakest detection that can place a piece
    CONFIRM_FRAMES = 5      # consecutive frames a far / new detection must repeat...
    CONFIRM_MM = 40.0       # ...within this distance of itself
    RELOCATE_S = 0.25       # a piece moves to a confirmed far detection only after being unseen this long
    # leaving the table
    EDGE_MM = 40.0          # last seen this close to the screen edge: it may have been taken off
    LEAVE_S = 2.9           # ...and is dropped after this long unseen (tune.html, Oct 9)
    HOLD_S = 3.0            # anywhere else a piece is covered, not gone: held this long (backstop if it was really taken away)
    # identity checks
    COLOUR_MIN = 0.04       # colour fraction that counts as evidence
    COLOUR_RATIO = 3.0      # relabel only when the other piece's colour is this many times stronger
    COLOUR_PLACE = 0.10     # a weak detection with this much of its own colour (and little of the others) may place a piece
    COLOUR_NONE = 0.01      # below this much of its own colour, a coloured piece's detection counts as half as confident
    NO_COLOUR_PLACE = ('earth',)   # pieces whose colour alone can't place them (blue light from the screen fools it, Oct 9)
    WEAK_S = 2.0            # weak detections (< CONF_NEW) keep a piece only this long after its last confident one
    PLACE_MIN_MM = {'earth': 64.0}   # smallest box (diagonal) that can place a piece: Earth measures ~77-79, screen glow 48-61
    LOG = None              # path: every placement / relocation is appended here (what put a piece where, Oct 9)
    SIZE_MIN_MM, SIZE_MAX_MM = 15.0, 170.0   # box diagonal on the screen plane
    # publishing (stillness lock, as before)
    SMOOTH = 1.0
    BAND_MOVING_MM = 0.0
    BAND_STILL_MM = 5.0
    STILL_S = 1.0
    REST_MM = 15.0

    def __init__(self, cfg):
        self.cfg = cfg
        self.W, self.H = cfg['screen_mm']
        self.pieces = {}    # id -> track dict
        self.cand = {}      # role -> {x, y, n, t, d}
        self.colour_roles = ('earth', 'seldon-1', 'seldon-2')

    def ids_for(self, role):
        n = self.cfg['roles'][role]['count']
        return [role] if n == 1 else [f'{role}-{i + 1}' for i in range(n)]

    # ------------------------------------------------------------ per-detection checks
    def colour_fix(self, d):
        sc = d.get('colour')
        if not sc or d['role'] not in sc:
            return d
        best = max(sc, key=sc.get)
        if best != d['role'] and best in self.cfg['roles'] and sc[best] >= self.COLOUR_MIN and sc[best] > self.COLOUR_RATIO * sc[d['role']]:
            return {**d, 'role': best, 'conf': d['conf'] * 0.8, 'recoloured': True}
        return d

    def size_ok(self, d):
        s = d.get('size_mm')
        return s is None or self.SIZE_MIN_MM <= s <= self.SIZE_MAX_MM

    def placeable(self, d):
        """Strong enough to put a piece on the table: a confident detection, or a weak one whose colour is clearly its own."""
        sc = d.get('colour') or {}
        own = sc.get(d['role'])
        if self.colourless(d):                                   # none of its own colour: never places that piece (a person 'Earth')
            return False
        lo = self.PLACE_MIN_MM.get(d['role'])
        if lo and d.get('size_mm') is not None and d['size_mm'] < lo:
            return False                                         # too small to be that piece (the glow of on-screen text)
        if d['role'] in self.NO_COLOUR_PLACE:                    # blue: the screen glows blue through the film (readout text)
            return d['conf'] >= self.CONF_NEW
        return d['conf'] >= self.CONF_NEW or (own is not None and own >= self.COLOUR_PLACE and own >= self.COLOUR_RATIO * max(
            [v for k, v in sc.items() if k != d['role']] or [0]))

    def colourless(self, d):
        """A coloured piece's label on a box with none of its colour (e.g. a person labelled Earth)."""
        sc = d.get('colour') or {}
        return d['role'] in sc and sc[d['role']] < self.COLOUR_NONE

    def near_edge(self, x, y):
        return min(x, self.W - x, y, self.H - y) < self.EDGE_MM

    # ------------------------------------------------------------ one frame
    def step(self, dets, now):
        """dets: [{role, x_mm, y_mm, u, v, conf, colour?, size_mm?}] for one frame (already on-screen)."""
        dets = [self.colour_fix(d) for d in dets if d['role'] in self.cfg['roles'] and self.size_ok(d)]
        dets = [{**d, 'conf': d['conf'] * 0.5} if self.colourless(d) else d for d in dets]
        dets = [d for d in dets if d['conf'] >= self.CONF_TRACK]
        ids = list(self.pieces)
        # 1. joint assignment of detections to the pieces we know
        C = np.full((len(ids), len(dets)), BIG)
        for ti, i in enumerate(ids):
            p = self.pieces[i]
            unseen = now - p['t']
            k = min(unseen, 0.15)                                # predict a little way along the motion, then stop
            px, py = p['ex'] + p['vx'] * k, p['ey'] + p['vy'] * k
            gate = min(self.GATE_MAX_MM, self.GATE_MM + self.VMAX_MM_S * unseen)
            weak_ok = now - p.get('strong_t', p['t']) < self.WEAK_S   # a phantom kept alive only by weak hits fades out
            for di, d in enumerate(dets):
                if d['conf'] < self.CONF_NEW and not weak_ok:
                    continue
                dist = np.hypot(d['x_mm'] - px, d['y_mm'] - py)
                same = d['role'] == p['role']
                if dist < (gate if same else self.GATE_MM):      # another piece's label only right on top (a mislabel),
                    C[ti, di] = dist + (0.0 if same else self.ROLE_PENALTY_MM)   # never via the widened search
        matched_d, matched_t = set(), set()
        if ids and dets:
            for ti, di in zip(*linear_sum_assignment(C)):
                if C[ti, di] < BIG:
                    self._observe(ids[ti], dets[di], now)
                    matched_d.add(di); matched_t.add(ti)
        # 2. leftovers: new pieces or relocations, confirmed over several frames
        best = {}
        for di, d in enumerate(dets):
            if di in matched_d or not self.placeable(d):
                continue
            if any(np.hypot(d['x_mm'] - p['x_mm'], d['y_mm'] - p['y_mm']) < self.FOOTPRINT_MM for p in self.pieces.values()):
                continue                                         # on top of another piece: never a second piece
            if d['role'] not in best or d['conf'] > best[d['role']]['conf']:
                best[d['role']] = d
        for role, d in best.items():
            c = self.cand.get(role)
            if c and np.hypot(d['x_mm'] - c['x'], d['y_mm'] - c['y']) < self.CONFIRM_MM and now - c['t'] < 0.3:
                c.update(x=d['x_mm'], y=d['y_mm'], n=c['n'] + 1, t=now, d=d)
            else:
                c = self.cand[role] = {'x': d['x_mm'], 'y': d['y_mm'], 'n': 1, 't': now, 'd': d}
            if c['n'] < self.CONFIRM_FRAMES:
                continue
            ids_r = self.ids_for(role)
            free = [i for i in ids_r if i not in self.pieces]
            if free:                                             # a new piece on the table
                self._place(free[0], role, d, now); self.cand.pop(role)
            else:                                                # relocate the one unseen longest, if it's really gone from its spot
                i = min(ids_r, key=lambda i: self.pieces[i]['t'])
                if now - self.pieces[i]['t'] >= self.RELOCATE_S:
                    self._place(i, role, d, now); self.cand.pop(role)
        for role in [r for r, c in self.cand.items() if now - c['t'] > 0.3]:
            del self.cand[role]
        # 3. unseen pieces hold still; they leave only over the edge (or after HOLD_S)
        for i in [i for i, p in self.pieces.items() if now - p['t'] > 0.15]:
            self.pieces[i]['vx'] = self.pieces[i]['vy'] = 0.0
        for i in [i for i, p in self.pieces.items()
                  if (now - p['t'] > self.LEAVE_S and self.near_edge(p['ex'], p['ey'])) or now - p['t'] > self.HOLD_S]:
            del self.pieces[i]

    def _place(self, i, role, d, now):
        x, y = d['x_mm'], d['y_mm']
        if self.LOG:
            try:
                with open(self.LOG, 'a') as f:
                    f.write(f"{time.strftime('%H:%M:%S')} {'move' if i in self.pieces else 'place'} {i} at ({x:.0f}, {y:.0f}) mm "
                            f"conf {d['conf']:.2f} size {d.get('size_mm') or 0:.0f} mm colour {d.get('colour')}\n")
            except OSError:
                pass
        self.pieces[i] = {'role': role, 'x_mm': x, 'y_mm': y, 'ex': x, 'ey': y, 'vx': 0.0, 'vy': 0.0, 'rest': (x, y, now),
                          'u': d['u'], 'v': d['v'], 'conf': d['conf'], 't': now, 'strong_t': now}

    def _observe(self, i, d, now):
        p = self.pieces[i]
        dt = max(1 / 60, now - p['t'])
        zx, zy = d['x_mm'], d['y_mm']
        p['vx'] = 0.6 * p['vx'] + 0.4 * (zx - p['ex']) / dt
        p['vy'] = 0.6 * p['vy'] + 0.4 * (zy - p['ey']) / dt
        ex = p['ex'] + self.SMOOTH * (zx - p['ex'])
        ey = p['ey'] + self.SMOOTH * (zy - p['ey'])
        ax, ay, rest = p['x_mm'], p['y_mm'], p['rest']
        if np.hypot(ex - rest[0], ey - rest[1]) > self.REST_MM:
            rest = (ex, ey, now)                                 # it's moving
        band = self.BAND_STILL_MM if now - rest[2] > self.STILL_S else self.BAND_MOVING_MM
        if np.hypot(ex - ax, ey - ay) > band:
            ax, ay = ex, ey
        p.update(x_mm=ax, y_mm=ay, ex=ex, ey=ey, rest=rest, u=d['u'], v=d['v'], conf=d['conf'], t=now)
        if d['conf'] >= self.CONF_NEW:
            p['strong_t'] = now

    # ------------------------------------------------------------ output (pieces.json feed)
    def feed(self, now):
        return {i: {'role': p['role'], 'x_mm': round(p['x_mm'], 1), 'y_mm': round(p['y_mm'], 1),
                    'u': round(p['u'], 4), 'v': round(p['v'], 4), 'conf': round(p['conf'], 2),
                    'seen_ago': round(now - p['t'], 2), **self._motion(p, now)}
                for i, p in self.pieces.items()}

    def _motion(self, p, now):
        """moving + velocity (mm/s) for the page's easing and lead; velocity only while really moving and seen, so a
        still piece's detection jitter never leaks into the picture."""
        moving = now - p['rest'][2] < 0.3
        live = moving and now - p['t'] < 0.15
        return {'moving': moving, 'vx': round(p['vx'], 1) if live else 0.0, 'vy': round(p['vy'], 1) if live else 0.0}
