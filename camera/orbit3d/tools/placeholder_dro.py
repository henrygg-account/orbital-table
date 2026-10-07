"""Patch data/mission_dro.json with a proper DRO and a smooth placeholder flyby -> DRO leg.

  python placeholder_dro.py [--dro-km 70000]

Keeps the solver's LEO and coast phases (real CR3BP propagation to a 130 km lunar flyby). Replaces the
DRO with a correctly shot retrograde orbit that encircles the Moon (single core, a few seconds), and the
flyby -> DRO leg with a cubic Hermite blend (visual placeholder, not propagated). Burn values for the flyby
and DRO insertion are Artemis I-like placeholders. The company's real trajectory replaces all of this.
"""
import argparse, json
from pathlib import Path

import numpy as np
from scipy.integrate import solve_ivp
from scipy.optimize import brentq

MU_E, MU_M, L = 398600.4418, 4902.800, 384400.0
MU = MU_M / (MU_E + MU_M)
T = np.sqrt(L ** 3 / (MU_E + MU_M)); V = L / T
R_E, R_M = 6378.1, 1737.4
DATA = Path(__file__).resolve().parent.parent / 'data' / 'mission_dro.json'
OPF, DRI = 0.21, 0.11                                    # km/s, Artemis I-like placeholders


def f(t, s):
    x, y, vx, vy = s
    r1 = np.hypot(x + MU, y); r2 = np.hypot(x - 1 + MU, y)
    return [vx, vy, 2 * vy + x - (1 - MU) * (x + MU) / r1 ** 3 - MU * (x - 1 + MU) / r2 ** 3,
            -2 * vx + y - (1 - MU) * y / r1 ** 3 - MU * y / r2 ** 3]


def dro(dx_km):
    """Start on the far side going -y (clockwise = retrograde); the next y=0 crossing must be on the near
    side of the Moon and perpendicular (vx = 0)."""
    x0 = 1 - MU + dx_km / L

    def cross(vy0):
        ev = lambda t, s: s[1]; ev.terminal, ev.direction = True, 1
        sol = solve_ivp(f, (0, 3), [x0, 0, 0, vy0], events=ev, rtol=1e-10, atol=1e-12, method='DOP853')
        return (sol.t_events[0][0], sol.y_events[0][0]) if len(sol.t_events[0]) else (None, None)

    def miss(vy0):
        t, s = cross(vy0)
        return s[2] if s is not None and s[0] < 1 - MU else np.nan

    grid = np.linspace(-0.2, -1.2, 101)
    vals = [miss(v) for v in grid]
    for a, b, fa, fb in zip(grid, grid[1:], vals, vals[1:]):
        if np.isfinite(fa) and np.isfinite(fb) and np.sign(fa) != np.sign(fb):
            vy0 = brentq(lambda v: miss(v), a, b, xtol=1e-12)
            P = 2 * cross(vy0)[0]
            sol = solve_ivp(f, (0, P), [x0, 0, 0, vy0], dense_output=True, rtol=1e-10, atol=1e-12, method='DOP853')
            return sol, P
    raise SystemExit('no DRO found')


def speeds(s):
    x, y, vx, vy = s
    return np.hypot(vx - y, vy + (x + MU)) * V, np.hypot(vx - y, vy + (x - 1 + MU)) * V


def point(s, t_h, phase, dv):
    ve, vm = speeds(s)
    return {'x': round((s[0] + MU) * L, 1), 'y': round(s[1] * L, 1), 't_h': round(t_h, 3), 'phase': phase,
            'dv': round(dv, 4), 'v_earth': round(ve, 4), 'v_moon': round(vm, 4),
            'r_earth': round(np.hypot(s[0] + MU, s[1]) * L - R_E, 1),
            'r_moon': round(np.hypot(s[0] - 1 + MU, s[1]) * L - R_M, 1)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dro-km', type=float, default=70000)
    ap.add_argument('--leg-days', type=float, default=4.0, help='flyby -> DRO insertion coast')
    a = ap.parse_args()
    d = json.loads(DATA.read_text())
    keep = [p for p in d['points'] if p['phase'] in ('leo', 'coast')]
    tli = next(e['dv_kms'] for e in d['events'] if e['name'] == 'tli')

    sol, P = dro(a.dro_km)
    print(f'DRO {a.dro_km:.0f} km: period {P * T / 86400:.2f} d')

    # flyby state (end of coast), in nondim rotating-frame units, velocity by finite difference
    p1, p0 = keep[-1], keep[-2]
    dt = (p1['t_h'] - p0['t_h']) * 3600 / T
    r_f = np.array([p1['x'] / L - MU, p1['y'] / L])
    v_f = (r_f - np.array([p0['x'] / L - MU, p0['y'] / L])) / dt
    # insertion: the DRO point the flyby can turn into most gently (direction change along the chord)
    unit = lambda v: v / np.linalg.norm(v)
    best = None
    for ph in np.linspace(0, P, 360, endpoint=False):
        s = sol.sol(ph)
        c = s[:2] - r_f
        if np.linalg.norm(c) < 0.05:
            continue
        cost = np.arccos(np.clip(unit(v_f) @ unit(c), -1, 1)) + np.arccos(np.clip(unit(c) @ unit(s[2:]), -1, 1))
        if best is None or cost < best[0]:
            best = (cost, ph)
    ph = best[1]; s_i = sol.sol(ph)
    chord = np.linalg.norm(s_i[:2] - r_f)
    m0, m1 = unit(v_f) * chord, unit(s_i[2:]) * chord          # tangents scaled to the chord: no overshoot
    e0, e1 = speeds(np.r_[r_f, v_f]), speeds(s_i)

    pts = list(keep)
    t0 = p1['t_h']
    for u in np.linspace(0, 1, 160)[1:]:                 # cubic Hermite from flyby to insertion
        h00, h10, h01, h11 = 2*u**3 - 3*u**2 + 1, u**3 - 2*u**2 + u, -2*u**3 + 3*u**2, u**3 - u**2
        r = h00 * r_f + h10 * m0 + h01 * s_i[:2] + h11 * m1
        q = point(np.r_[r, 0, 0], t0 + u * a.leg_days * 24, 'flyby-to-dro', tli + OPF)
        q['v_earth'] = round((1 - u) * e0[0] + u * e1[0], 4); q['v_moon'] = round((1 - u) * e0[1] + u * e1[1], 4)
        pts.append(q)
    t1 = t0 + a.leg_days * 24
    for k in np.linspace(0, P, 400)[1:]:
        pts.append(point(sol.sol((ph + k) % P), t1 + k * T / 3600, 'dro', tli + OPF + DRI))

    xy = lambda s: [round((s[0] + MU) * L, 1), round(s[1] * L, 1)]
    for e in d['events']:
        if e['name'] == 'opf':
            e.update(dv_kms=OPF)
        if e['name'] == 'dri':
            e.update(dv_kms=DRI, x=xy(s_i)[0], y=xy(s_i)[1], t_h=round(t1, 3))
    d['dro'] = {'far_side_km': a.dro_km, 'period_days': round(P * T / 86400, 3),
                'points': [xy(s) for s in sol.sol(np.linspace(0, P, 400)).T]}
    d['points'] = pts
    d['total_dv_kms'] = round(tli + OPF + DRI, 4)
    d['transfer_days'] = round((t1 - keep[0]['t_h'] - (keep[[p['phase'] for p in keep].index('coast')]['t_h'] - keep[0]['t_h'])) / 24, 3)
    d['about'] += ' PLACEHOLDER: flyby->DRO leg is a smooth blend and OPF/DRI are Artemis I-like values.'
    DATA.write_text(json.dumps(d, separators=(',', ':')))
    xs = [p[0] - L for p in d['dro']['points']]; ys = [p[1] for p in d['dro']['points']]
    print(f'DRO extent rel. Moon x {min(xs):.0f}..{max(xs):.0f}  y {min(ys):.0f}..{max(ys):.0f}')
    print(f'wrote {DATA.name}: {len(pts)} points, total {d["total_dv_kms"]} km/s, transfer {d["transfer_days"]} d')


if __name__ == '__main__':
    main()
