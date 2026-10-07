"""Write data/mission_dro.json as a stylized electric (low-thrust) spiral from LEO out to a DRO.

  python spiral_mission.py [--turns 5] [--accel-mm-s2 0.5] [--spiral-km 150000]

Placeholder until the company's own trajectory replaces it. Single core, runs in about a second.
- Spiral: Archimedean in the Earth-Moon rotating frame, LEO -> --spiral-km in --turns revolutions (a real
  spiral at this acceleration has hundreds; the caption says so). Delta-v and time follow Edelbaum's
  circle-to-circle result: dv = v_LEO - v(r), t = dv / a.
- Lunar transfer: smooth Hermite arc from the spiral's end into the DRO (also Edelbaum to lunar distance,
  plus a small capture allowance).
- DRO: the properly shot retrograde orbit from placeholder_dro.py.
"""
import argparse, json
from pathlib import Path

import numpy as np

from placeholder_dro import DATA, L, MU, MU_E, R_E, R_M, T, dro, point

MU_M = 4902.8
R_LEO = R_E + 400
V_MOON = np.sqrt(MU_E / L)
CAPTURE = 0.05                                       # km/s allowance for the final DRO capture


def row(x, y, t_h, phase, dv, v_e, v_m):
    return {'x': round(x, 1), 'y': round(y, 1), 't_h': round(t_h, 3), 'phase': phase, 'dv': round(dv, 4),
            'v_earth': round(v_e, 4), 'v_moon': round(v_m, 4), 'r_earth': round(np.hypot(x, y) - R_E, 1),
            'r_moon': round(np.hypot(x - L, y) - R_M, 1)}


def circ_speeds(x, y, th):
    """Inertial speeds of a circular prograde Earth orbit at (x, y): rel. Earth and rel. Moon."""
    v = np.sqrt(MU_E / np.hypot(x, y))
    return v, np.hypot(-np.sin(th) * v, np.cos(th) * v - V_MOON)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--turns', type=float, default=5)
    ap.add_argument('--accel-mm-s2', type=float, default=0.5, help='thrust acceleration, mm/s^2')
    ap.add_argument('--spiral-km', type=float, default=150000, help='radius where the spiral hands over')
    ap.add_argument('--end-deg', type=float, default=-100, help='spiral end angle (0 = toward the Moon)')
    ap.add_argument('--dro-km', type=float, default=70000)
    a = ap.parse_args()
    acc = a.accel_mm_s2 * 1e-6                       # km/s^2
    v_leo = np.sqrt(MU_E / R_LEO)
    dv_of = lambda r: v_leo - np.sqrt(MU_E / r)
    t_h_of = lambda dv: dv / acc / 3600

    pts = []
    # LEO: half a parking orbit before thrusting starts
    th_end = np.radians(a.end_deg); th0 = th_end - 2 * np.pi * a.turns
    for th in np.linspace(th0 - np.pi, th0, 40):
        x, y = R_LEO * np.cos(th), R_LEO * np.sin(th)
        pts.append(row(x, y, 0, 'leo', 0, *circ_speeds(x, y, th)))
    # spiral
    for th in np.linspace(th0, th_end, 1200)[1:]:
        r = R_LEO + (a.spiral_km - R_LEO) * (th - th0) / (th_end - th0)
        x, y = r * np.cos(th), r * np.sin(th)
        dv = dv_of(r)
        pts.append(row(x, y, t_h_of(dv), 'spiral', dv, *circ_speeds(x, y, th)))
    dv_s, t_s = pts[-1]['dv'], pts[-1]['t_h']
    p_s = np.array([pts[-1]['x'], pts[-1]['y']])
    tan_s = np.array([-np.sin(th_end), np.cos(th_end)])

    # DRO and the gentlest insertion point
    sol, P = dro(a.dro_km)
    unit = lambda v: v / np.linalg.norm(v)
    km = lambda s: np.array([(s[0] + MU) * L, s[1] * L])
    best = None
    for ph in np.linspace(0, P, 360, endpoint=False):
        s = sol.sol(ph); c = km(s) - p_s
        cost = np.arccos(np.clip(tan_s @ unit(c), -1, 1)) + np.arccos(np.clip(unit(c) @ unit(s[2:]), -1, 1))
        if best is None or cost < best[0]:
            best = (cost, ph)
    ph = best[1]; s_i = sol.sol(ph); p_i = km(s_i)
    chord = np.linalg.norm(p_i - p_s)
    m0, m1 = tan_s * chord, unit(s_i[2:]) * chord
    dv_t = (np.sqrt(MU_E / a.spiral_km) - V_MOON) + CAPTURE          # rest of the Edelbaum climb + capture
    t_t = dv_t / acc / 3600
    v0 = circ_speeds(*p_s, th_end); v1 = point(s_i, 0, 'dro', 0)
    for u in np.linspace(0, 1, 200)[1:]:
        h00, h10, h01, h11 = 2*u**3 - 3*u**2 + 1, u**3 - 2*u**2 + u, -2*u**3 + 3*u**2, u**3 - u**2
        x, y = h00 * p_s + h10 * m0 + h01 * p_i + h11 * m1
        pts.append(row(x, y, t_s + u * t_t, 'transfer', dv_s + u * dv_t,
                       (1 - u) * v0[0] + u * v1['v_earth'], (1 - u) * v0[1] + u * v1['v_moon']))
    t_i, total = t_s + t_t, dv_s + dv_t
    for k in np.linspace(0, P, 400)[1:]:
        q = point(sol.sol((ph + k) % P), t_i + k * T / 3600, 'dro', total)
        pts.append(q)

    revs = (v_leo ** 4 - np.sqrt(MU_E / a.spiral_km) ** 4) / (4 * MU_E * acc) / (2 * np.pi)
    out = {
        'about': 'PLACEHOLDER electric-propulsion mission: stylized low-thrust spiral LEO 400 km -> DRO. Earth-Moon '
                 'rotating frame, km, Earth at (0,0), Moon at (384400,0), +y = direction of the Moon\'s motion. '
                 f'Edelbaum delta-v/time at {a.accel_mm_s2} mm/s^2; spiral drawn with {a.turns:g} turns.',
        'caption': f'STYLIZED LOW-THRUST SPIRAL · REAL SPIRAL ≈ {round(revs, -1):.0f} REVOLUTIONS AT {a.accel_mm_s2:g} MM/S² · PLACEHOLDER',
        'L_km': L, 'R_earth_km': R_E, 'R_moon_km': R_M, 'leo_alt_km': 400, 'flyby_alt_km': a.dro_km,
        'dro': {'far_side_km': a.dro_km, 'period_days': round(P * T / 86400, 3),
                'points': [[round(v, 1) for v in km(s)] for s in sol.sol(np.linspace(0, P, 400)).T]},
        'events': [
            {'name': 'spiral', 'label': 'Electric spiral', 'x': pts[40]['x'], 'y': pts[40]['y'], 't_h': 0,
             'dv_kms': round(dv_s, 4)},
            {'name': 'dri', 'label': 'DRO insertion', 'x': round(p_i[0], 1), 'y': round(p_i[1], 1),
             't_h': round(t_i, 3), 'dv_kms': round(dv_t, 4)},
        ],
        'total_dv_kms': round(total, 4),
        'transfer_days': round(t_i / 24, 1),
        'points': pts,
    }
    DATA.write_text(json.dumps(out, separators=(',', ':')))
    print(f'wrote {DATA.name}: {len(pts)} points  spiral {dv_s:.2f} + transfer {dv_t:.2f} = {total:.2f} km/s  '
          f'{t_i / 24:.0f} days  (real spiral ~{revs:.0f} revs)')


if __name__ == '__main__':
    main()
