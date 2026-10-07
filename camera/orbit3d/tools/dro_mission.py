"""Design the LEO -> DRO reference mission in the Earth-Moon rotating frame (circular restricted 3-body
problem) and write ../data/mission_dro.json for the Mission mode.

  python dro_mission.py [--dro-km 70000] [--plot]

1. DRO: a planar periodic retrograde orbit around the Moon, found by shooting on its far-side x-axis
   crossing (perpendicular crossing again half a period later).
2. LEO 400 km -> TLI: a tangential burn whose timing (departure angle) is solved so the coast passes the
   Moon at a 130 km periapsis.
3. Outbound powered flyby (OPF) at that periapsis, then DRO insertion (DRI) where the coast meets the DRO.
   OPF vector, coast time and DRO phase are optimised for the least OPF + DRI.
Output is in km with Earth at (0, 0) and the Moon at (384400, 0); y is the direction the Moon moves.
"""
import argparse, json
from pathlib import Path

import numpy as np
from scipy.integrate import solve_ivp
from scipy.optimize import brentq, minimize

MU_E, MU_M = 398600.4418, 4902.800                # km^3/s^2
L = 384400.0                                      # km, Earth-Moon distance
MU = MU_M / (MU_E + MU_M)                         # mass ratio, ~0.01215
T = np.sqrt(L ** 3 / (MU_E + MU_M))               # s per nondim time unit (~4.34 days / 2pi... per radian)
V = L / T                                         # km/s per nondim velocity unit
R_E, R_M = 6378.1, 1737.4
LEO_ALT, FLYBY_ALT = 400.0, 130.0
OUT = Path(__file__).resolve().parent.parent / 'data' / 'mission_dro.json'


def f(t, s):
    x, y, vx, vy = s
    r1 = np.hypot(x + MU, y); r2 = np.hypot(x - 1 + MU, y)
    ax = 2 * vy + x - (1 - MU) * (x + MU) / r1 ** 3 - MU * (x - 1 + MU) / r2 ** 3
    ay = -2 * vx + y - (1 - MU) * y / r1 ** 3 - MU * y / r2 ** 3
    return [vx, vy, ax, ay]


TOL = {'rtol': 1e-11, 'atol': 1e-12}


def prop(s0, tf, **kw):
    return solve_ivp(f, (0, tf), s0, dense_output=True, method='DOP853', **TOL, **kw)


def moon_dist(s):
    return np.hypot(s[0] - 1 + MU, s[1])


# ---------------------------------------------------------------- 1. DRO
def dro(dx_km):
    x0 = 1 - MU + dx_km / L

    def half(vy0):
        ev = lambda t, s: s[1]; ev.terminal, ev.direction = True, 1        # back across y = 0 from below
        sol = prop([x0, 0, 0, vy0], 20, events=ev)
        return sol, sol.y_events[0][0] if len(sol.t_events[0]) else None

    def miss(vy0):
        _, se = half(vy0)
        return se[2] if se is not None else 1.0                             # vx at the crossing

    grid = np.linspace(-0.05, -1.5, 300)
    vals = [miss(v) for v in grid]
    for a, b, fa, fb in zip(grid, grid[1:], vals, vals[1:]):
        if np.sign(fa) != np.sign(fb) and abs(fa) < .5 and abs(fb) < .5:
            vy0 = brentq(miss, a, b, xtol=1e-13)
            sol, se = half(vy0)
            P = 2 * sol.t_events[0][0]
            full = prop([x0, 0, 0, vy0], P)
            return np.array([x0, 0, 0, vy0]), P, full
    raise SystemExit('no DRO found')


# ---------------------------------------------------------------- 2. LEO -> TLI -> periapsis
def leo_state(theta, dv):
    r = (R_E + LEO_ALT) / L
    vc = np.sqrt(MU_E / (R_E + LEO_ALT)) / V
    c, s = np.cos(theta), np.sin(theta)
    rho = np.array([r * c, r * s])
    v = (vc + dv / V) * np.array([-s, c]) - np.array([-rho[1], rho[0]])     # rotating-frame velocity
    return np.array([-MU + rho[0], rho[1], v[0], v[1]])


def to_periapsis(s0, tmax_days=9.0):
    """Coast until the first lunar periapsis (inside 40,000 km). Returns (sol, state, t) or None."""
    ev = lambda t, s: (s[0] - 1 + MU) * s[2] + s[1] * s[3]                  # d(dist to Moon)/dt = 0
    ev.terminal, ev.direction = False, 1
    sol = prop(s0, tmax_days * 86400 / T, events=ev)
    for t, st in zip(sol.t_events[0], sol.y_events[0]):
        if moon_dist(st) < 40000 / L:
            return sol, st, t
    return None


def periapsis_alt(theta, dv):
    r = to_periapsis(leo_state(theta, dv))
    return (moon_dist(r[1]) * L - R_M) if r else np.nan


def solve_tli(dv):
    """Departure angles giving a FLYBY_ALT periapsis, both ways round the Moon (sign of h)."""
    th = np.linspace(-np.pi, np.pi, 181)
    alts = [periapsis_alt(t, dv) - FLYBY_ALT for t in th]
    best = []
    for a, b, fa, fb in zip(th, th[1:], alts, alts[1:]):
        if np.isfinite(fa) and np.isfinite(fb) and np.sign(fa) != np.sign(fb) and abs(fa - fb) < 20000:
            t0 = brentq(lambda t: periapsis_alt(t, dv) - FLYBY_ALT, a, b, xtol=1e-12)
            sol, st, tp = to_periapsis(leo_state(t0, dv))
            h = (st[0] - 1 + MU) * st[3] - st[1] * st[2]                       # angular momentum about the Moon
            best.append((t0, st, tp, np.sign(h)))
    return best


# ---------------------------------------------------------------- 3. OPF + DRI
_DRO = {}


def _solve_start(args):
    """One SLSQP start (runs in a worker process)."""
    dro_s0, P, peri, x0, tol = args
    TOL.update(tol)
    key = tuple(dro_s0)
    if key not in _DRO:
        _DRO[key] = prop(dro_s0, P)
    dro_sol = _DRO[key]

    def leg(x):
        dvx, dvy, tf, tau = x
        s = peri + np.array([0, 0, dvx, dvy])
        e = prop(s, tf).y[:, -1]
        d = dro_sol.sol(tau % P)
        return e, d

    def cost(x):
        e, d = leg(x)
        return np.hypot(x[0], x[1]) + np.hypot(*(d[2:] - e[2:]))

    def eq(x):
        e, d = leg(x)
        return (d[:2] - e[:2]) * 100

    try:
        r = minimize(cost, x0, constraints=[{'type': 'eq', 'fun': eq}], method='SLSQP',
                     bounds=[(-.6 / V, .6 / V)] * 2 + [(.5 * 86400 / T, 9 * 86400 / T), (-P, 2 * P)],
                     options={'maxiter': 60, 'ftol': 1e-8})
    except Exception:
        return None
    if r.success and np.abs(eq(r.x)).max() < 1e-4:
        return r.fun, list(r.x)
    return None


def design(dro_s0, P, peri, pool):
    vdir = peri[2:] / np.linalg.norm(peri[2:])
    starts = [[vdir[0] * dvm / V, vdir[1] * dvm / V, tf_days * 86400 / T, k * P / 8]
              for tf_days in (3, 5) for k in range(4) for dvm in (-.2,)]   # quick: placeholder trajectory
    res = [r for r in pool.map(_solve_start, [(dro_s0, P, peri, x0, dict(TOL)) for x0 in starts]) if r]
    if not res:
        raise SystemExit('OPF/DRI design failed')
    fun, x = min(res)

    class R: pass
    best = R(); best.fun, best.x = fun, np.array(x)
    return best, prop(dro_s0, P)


# ---------------------------------------------------------------- output helpers
def km(s):
    return [(s[0] + MU) * L, s[1] * L]


def speeds(s):
    x, y, vx, vy = s
    ve = np.hypot(vx - y, vy + (x + MU)) * V                 # inertial, relative to Earth
    vm = np.hypot(vx - y, vy + (x - 1 + MU)) * V             # inertial, relative to the Moon
    return ve, vm


def sample(sol, t0, t1, phase, dv_so_far, t_offset, step_km=1500, max_dt_h=2.0):
    """Points spaced by arc length (dense near Earth/Moon where it moves fast), at most max_dt_h apart."""
    ts = np.linspace(t0, t1, 20000)
    st = sol.sol(ts)
    xy = np.c_[(st[0] + MU) * L, st[1] * L]
    seg = np.r_[0, np.cumsum(np.hypot(*np.diff(xy, axis=0).T))]
    keep, last_s, last_t = [0], 0, ts[0]
    for i in range(1, len(ts)):
        if seg[i] - last_s >= step_km or (ts[i] - last_t) * T / 3600 >= max_dt_h:
            keep.append(i); last_s, last_t = seg[i], ts[i]
    if keep[-1] != len(ts) - 1:
        keep.append(len(ts) - 1)
    pts = []
    for i in keep:
        s = st[:, i]; ve, vm = speeds(s)
        pts.append({'x': round(xy[i, 0], 1), 'y': round(xy[i, 1], 1),
                    't_h': round(t_offset + (ts[i] - t0) * T / 3600, 3), 'phase': phase,
                    'dv': round(dv_so_far, 4), 'v_earth': round(ve, 4), 'v_moon': round(vm, 4),
                    'r_earth': round(np.hypot(s[0] + MU, s[1]) * L - R_E, 1),
                    'r_moon': round(moon_dist(s) * L - R_M, 1)})
    return pts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dro-km', type=float, default=70000, help='DRO far-side distance from the Moon')
    ap.add_argument('--tli', type=float, default=3.13, help='TLI burn, km/s')
    ap.add_argument('--plot', action='store_true')
    a = ap.parse_args()

    s_dro, P, dro_full = dro(a.dro_km)
    print(f'DRO: period {P * T / 86400:.2f} d, vy0 {s_dro[3] * V:.4f} km/s')

    plans = []
    TOL.update(rtol=1e-7, atol=1e-9)                            # design at lower precision, final legs at full
    from concurrent.futures import ProcessPoolExecutor
    pool = ProcessPoolExecutor()
    cands = solve_tli(a.tli)
    print(f'{len(cands)} TLI candidates', flush=True)
    for th, peri, tp, side in cands:
            try:
                opt, dro_sol = design(s_dro, P, peri, pool)
            except SystemExit:
                continue
            plans.append((opt.fun * V, side, th, peri, tp, opt, dro_sol))
            print(f'  side {int(side):+d} theta {np.degrees(th):7.2f}  coast {tp * T / 86400:.2f} d  OPF+DRI {opt.fun * V * 1000:.0f} m/s', flush=True)
    if not plans:
        raise SystemExit('no transfer found')
    tot, side, th, peri, tp, opt, dro_sol = min(plans, key=lambda p: p[0])
    TOL.update(rtol=1e-11, atol=1e-12)
    sol, peri, tp = to_periapsis(leo_state(th, a.tli))
    dvx, dvy, tf, tau = opt.x
    opf = np.hypot(dvx, dvy) * V
    s_opf = peri + np.array([0, 0, dvx, dvy])
    coast2 = prop(s_opf, tf)
    e = coast2.y[:, -1]; d = dro_sol.sol(tau % P)
    dri = np.hypot(*(d[2:] - e[2:])) * V
    print(f'chosen: TLI {a.tli:.3f}  OPF {opf * 1000:.0f} m/s  DRI {dri * 1000:.0f} m/s  total {a.tli + opf + dri:.3f} km/s')

    # LEO: one parking orbit ending at the TLI point
    s_tli = leo_state(th, a.tli)
    vc = np.sqrt(MU_E / (R_E + LEO_ALT)); Pleo = 2 * np.pi * (R_E + LEO_ALT) / vc / T
    leo_end = leo_state(th, 0.0)
    leo_back = solve_ivp(f, (0, -Pleo), leo_end, dense_output=True, method='DOP853', **TOL)
    coast1 = prop(s_tli, tp)
    # DRO from the insertion phase, one full period
    dro_from = prop(d, P)

    t_leo = Pleo * T / 3600
    pts = []
    lts = np.linspace(-Pleo, 0, 120)
    leo_pts = []
    for tt in lts:
        s = leo_back.sol(tt); ve, vm = speeds(s); xy = km(s)
        leo_pts.append({'x': round(xy[0], 1), 'y': round(xy[1], 1), 't_h': round((tt + Pleo) * T / 3600, 3),
                        'phase': 'leo', 'dv': 0.0, 'v_earth': round(ve, 4), 'v_moon': round(vm, 4),
                        'r_earth': round(np.hypot(s[0] + MU, s[1]) * L - R_E, 1), 'r_moon': round(moon_dist(s) * L - R_M, 1)})
    pts += leo_pts
    pts += sample(coast1, 0, tp, 'coast', a.tli, t_leo)[1:]
    t1 = t_leo + tp * T / 3600
    pts += sample(coast2, 0, tf, 'flyby-to-dro', a.tli + opf, t1)[1:]
    t2 = t1 + tf * T / 3600
    pts += sample(dro_from, 0, P, 'dro', a.tli + opf + dri, t2, step_km=2500)[1:]

    def ev(name, label, s, t_h, dv):
        xy = km(s)
        return {'name': name, 'label': label, 'x': round(xy[0], 1), 'y': round(xy[1], 1), 't_h': round(t_h, 3),
                'dv_kms': round(dv, 4)}
    events = [ev('tli', 'Trans-lunar injection', s_tli, t_leo, a.tli),
              ev('opf', 'Outbound powered flyby', peri, t1, opf),
              ev('dri', 'DRO insertion', e, t2, dri)]
    dro_pts = [km(s) for s in dro_full.sol(np.linspace(0, P, 400)).T]
    out = {
        'about': 'LEO 400 km -> DRO reference mission, Earth-Moon circular restricted 3-body problem, planar. '
                 'km, Earth at (0,0), Moon at (384400,0), +y = direction of the Moon\'s motion. Rotating frame.',
        'L_km': L, 'R_earth_km': R_E, 'R_moon_km': R_M, 'leo_alt_km': LEO_ALT, 'flyby_alt_km': FLYBY_ALT,
        'dro': {'far_side_km': a.dro_km, 'period_days': round(P * T / 86400, 3),
                'points': [[round(x, 1), round(y, 1)] for x, y in dro_pts]},
        'events': events,
        'total_dv_kms': round(a.tli + opf + dri, 4),
        'transfer_days': round((t2 - t_leo) / 24, 3),
        'points': pts,
    }
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(out, separators=(',', ':')))
    print(f'wrote {OUT} ({len(pts)} points, {OUT.stat().st_size / 1024:.0f} KB)  transfer {out["transfer_days"]:.2f} d')

    if a.plot:
        import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
        fig, ax = plt.subplots(figsize=(12, 8))
        P_ = np.array([[p['x'], p['y']] for p in pts]); D_ = np.array(dro_pts)
        ax.plot(*P_.T, lw=.8); ax.plot(*D_.T, 'k--', lw=.6)
        for e_ in events:
            ax.plot(e_['x'], e_['y'], 'ro'); ax.annotate(f"{e_['name']} {e_['dv_kms'] * 1000:.0f} m/s", (e_['x'], e_['y']))
        ax.add_patch(plt.Circle((0, 0), R_E, color='b')); ax.add_patch(plt.Circle((L, 0), R_M, color='gray'))
        ax.set_aspect('equal'); fig.savefig(OUT.with_suffix('.png'), dpi=110)
        print('plot', OUT.with_suffix('.png'))


if __name__ == '__main__':
    main()
