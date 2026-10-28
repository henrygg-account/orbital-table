// orbits-geo.js — geometry and transfer maths for the ORBITS (kiosk) view. No DOM, no three.js, so node can test it
// (tools/test_orbits_geo.mjs). Table coordinates are mm, origin top-left, y down; angles are CCW with y up
// (th = atan2(-(y - cy), x - cx)), so prograde motion runs CCW as seen from above.
//
// Earth and the Moon are wherever their pieces are. Default (SCALE.true): altitude is to scale, measured from the
// figures' edges (the figures are bigger than scale), with the scale set so the Moon piece sits at the Moon's true
// altitude; GEO is then always the same true fraction of the way out, above LEO. Directions are true. Within the Moon
// zone (its sphere of influence, r_SOI = D (mu_M / mu_E)^0.4) everything is Moon-centred: patched conics, a Seldon
// there orbits the Moon, in a distant retrograde orbit (DRO, see droStretch). Transfers are drawn the way real ones look
// (user, Oct 12: thrust happens near periapsis, so the orbits stretch into ellipses rather than staying circular),
// schematically: the delta-v, fuel and time figures come from the simple formulas below, not from the drawn shapes.

export const MU_E = 398600.4418, MU_M = 4902.8, R_E = 6378.1, R_M = 1737.4, D_EM = 384400, G0 = 9.80665;
export const R_SOI = D_EM * (MU_M / MU_E) ** .4;             // 66,180 km
const TAU = Math.PI * 2;
const wrap = a => { a %= TAU; return a < 0 ? a + TAU : a; };

export const R_LEO = R_E + 400, R_GEO = 42164;
// default zoom of the LEO / GEO view (Earth on the table, Moon off): km of altitude per mm, so GEO fills the table's height
export const ZOOM = { leoGeo: 160 };
export const LAYOUT = { earth: [230, 400], moon: [1200, 400] };   // demo / test default (Earth-Moon 970 mm: the Moon zone stays on the table)
// leoMm: LEO's radius on the table; geoShare: GEO at most this share of the Earth-Moon distance; p: compression from
// GEO to the Moon; aM, zone: Moon-centred map (radius at zero altitude, zone radius, mm)
// TRUE (default): one linear scale for ALTITUDE, measured from the figures' edges (the figures are bigger than scale):
// a Seldon's centre at altitude h stands FIG.body + h * k from the body's centre, so zero altitude = the figure's edge
// (the lowest orbits hug the figures; a Seldon piece touching a figure reads FIG.S / k higher, about 6,000 km at 970 mm).
// k is set by the Moon piece: its centre is at the Moon's true altitude above Earth (378,022 km). Otherwise the older
// squeezed scale below.
export const SCALE = { true: true, leoMm: 70, geoShare: .6, p: .45, aM: 55, zone: 190, pM: .35, noMoonMm: 1140 };
// FIG: radius of the Earth and Moon figures and of a Seldon's base (mm). FLOOR_ALT: lowest altitude a piece reads as
// (touching Earth = LEO-ish 400 km, touching the Moon = 100 km). Orbit rings always pass through the piece.
export const FIG = { E: 31, M: 22, S: 15 };
export const FLOOR_ALT = { E: 400, M: 100 };
export const MIN_SPAN = 60;                                       // mm of altitude scale kept even when the Moon is very close
const V = await import('./vehicle.js' + new URL(import.meta.url).search);   // the one set of vehicle numbers (all modes); cache-busted as this file was (Oct 26: a stale cached vehicle.js)
export const VEH = { dry: V.SELDON.dry, prop: V.SELDON.prop };
export const PROP_MODES = [
  { id: 'ET', name: 'ELECTRIC', isp: V.SELDON.isp, thrust: V.SELDON.thrust, how: 'low thrust, many small burns (near periapsis, then apoapsis): drawn as a few loops' },
  { id: 'GT', name: 'CHEMICAL', isp: V.TUG.isp, how: 'two burns (Hohmann transfer)' },
];

export function makeMaps(earth = LAYOUT.earth, moon = LAYOUT.moon, S = SCALE) {
  const [ex, ey] = earth, Dmm = moon ? Math.hypot(moon[0] - ex, moon[1] - ey) : null;
  if (S.true) {
    const offE = FIG.E, offM = FIG.M;
    const k = Math.max(MIN_SPAN, (Dmm || S.noMoonMm) - offE) / (D_EM - R_E);  // mm per km of altitude, everywhere
    const lin = (cx, cy, mu, R, off) => withXY({ cx, cy, mu, R, off, rho: r => off + (r - R) * k, r: rho => R + (rho - off) / k });
    const thM = moon ? Math.atan2(-(moon[1] - ey), moon[0] - ex) : 0, zone = moon ? offM + (R_SOI - R_M) * k : 0;
    let E = lin(ex, ey, MU_E, R_E, offE), near = false;
    if (S.view && Dmm) {                                          // enlarged LEO / GEO (DRO_VIEW), the rest as before from GEO out
      // GEO at least gapMm outside LEO (Oct 25: a close Moon's share put it inside LEO below 189 mm); near: the Moon so close
      // that its zone comes within 10 mm of that GEO, no map to draw (modes.js asks for the Moon further away; below ~160 mm)
      const a = S.view.leoMm, g = Math.max(a + S.view.gapMm, Math.min(S.view.geoMm, S.view.maxShare * Dmm)), kg = (g - a) / (R_GEO - R_LEO), ko = (Dmm - g) / (D_EM - R_GEO);
      near = Dmm - zone < g + 10;
      E = withXY({ cx: ex, cy: ey, mu: MU_E, R: R_E, off: offE,
        rho: r => r <= R_LEO ? Math.max(offE, a * r / R_LEO) : r <= R_GEO ? a + (r - R_LEO) * kg : g + (r - R_GEO) * ko,
        r: rho => rho <= a ? R_LEO : rho <= g ? R_LEO + (rho - a) / kg : R_GEO + (rho - g) / ko });
    }
    return { E, M: moon && droStretch(lin(moon[0], moon[1], MU_M, R_M, offM), thM), Dmm, zone, k, true: true, thM, near };
  }
  const k = Math.min(S.leoMm / R_LEO, Dmm ? S.geoShare * Dmm / R_GEO : Infinity), rhoG = k * R_GEO;   // mm per km inside GEO
  const far = Dmm && Dmm > rhoG;
  const E = withXY({ cx: ex, cy: ey, mu: MU_E, R: R_E,
    rho: r => r <= R_GEO || !far ? k * r : rhoG + (Dmm - rhoG) * Math.pow((r - R_GEO) / (D_EM - R_GEO), S.p),
    r: rho => rho <= rhoG || !far ? rho / k : R_GEO + (D_EM - R_GEO) * Math.pow((rho - rhoG) / (Dmm - rhoG), 1 / S.p) });
  const zone = moon ? Math.max(80, Math.min(S.zone, far ? (Dmm - rhoG) * .7 : 80)) : 0, altS = R_SOI - R_M;
  const M = moon && withXY({ cx: moon[0], cy: moon[1], mu: MU_M, R: R_M, dir: -1,
    rho: r => S.aM + (zone - S.aM) * Math.pow(Math.max(0, r - R_M) / altS, S.pM),
    r: rho => R_M + altS * Math.pow(Math.max(0, rho - S.aM) / (zone - S.aM), 1 / S.pM) });
  return { E, M, Dmm, zone, k, thM: moon ? Math.atan2(-(moon[1] - ey), moon[0] - ex) : 0 };
}
// ---- LEO TO GEO / LEO TO DRO views (modes 'geo', 'dro') ----
// geo: Earth alone, drawn as the old squeezed map: LEO well clear of the 66 mm base, GEO at geoMm, linear in radius between.
export const GEO_VIEW = { leoMm: 100, geoMm: 500 };   // LEO 100 mm, GEO 500 (owner, Oct 26: "extend leo and geo out a good bit": a Seldon at the Earth piece, ~60 mm, glitched; it now reads as LEO with clear table to the ring. Then "make geo 500mm": wider than the table is tall, GEO runs off the long edges and reads at the table ends)
// LEO TO DRO: Earth's own neighbourhood enlarged (not to scale) so LEO and GEO read: LEO where a Seldon touching the Earth piece
// stands, GEO well out; from GEO to the Moon the true-ish scale carries on (owner, Oct 13). geoMm is capped at maxShare of Earth-Moon,
// but kept at least gapMm outside LEO.
export const DRO_VIEW = { leoMm: 66, geoMm: 180, maxShare: .35, gapMm: 40 };
export function makeGeoMaps(earth, S = GEO_VIEW) {
  const [ex, ey] = earth, a = S.leoMm, kk = (S.geoMm - a) / (R_GEO - R_LEO);
  const E = withXY({ cx: ex, cy: ey, mu: MU_E, R: R_E, rho: r => r >= R_LEO ? a + (r - R_LEO) * kk : a * r / R_LEO, r: rho => rho >= a ? R_LEO + (rho - a) / kk : rho / a * R_LEO });
  return { E, M: null, Dmm: null, zone: 0, k: kk, thM: 0 };
}
// true scale: one linear mm-per-km for everything, the Earth-Moon distance (mm) sets it; nothing is enlarged. noZone: no Moon zone (geo)
export function makeTrueMaps(earth, moon, S = {}) {
  const [ex, ey] = earth, Dmm = Math.hypot(moon[0] - ex, moon[1] - ey), k = Dmm / D_EM, thM = Math.atan2(-(moon[1] - ey), moon[0] - ex);
  const lin = (cx, cy, mu, R) => withXY({ cx, cy, mu, R, off: 0, rho: r => r * k, r: rho => rho / k });
  // Earth's map draws at true scale (LEO hugs the disc, ~1 mm above it). Reading a piece is different: a physical Seldon touching the
  // Earth disc stands foot (mm) + the disc's radius from Earth's centre (rho0), ~10,000 km up at this scale. So a piece inside rho0
  // is in LEO (400 km) and the altitude grows from there at true scale; its orbit is drawn where that altitude truly is.
  const rho0 = Math.max(R_LEO * k, R_E * k + (S.foot || 0)), E = lin(ex, ey, MU_E, R_E);
  if (S.foot > 0) Object.assign(E, { rho0, r: rho => rho > rho0 ? R_LEO + (rho - rho0) / k : R_LEO });
  return { E, M: droStretch(lin(moon[0], moon[1], MU_M, R_M), thM), Dmm, zone: S.noZone ? 0 : R_SOI * k, k, thM, scaleTrue: true };
}
// lock bands: `band` mm to snap, 1.4 x band to hold once locked; cap: the farthest a locked ring may be drawn from the piece's
// centre (Oct 25: under its base; a 40 mm band held at 56 put it 23 mm outside): the hold is never more, the snap at most 85% of it
const lockW = (band, was, cap = Infinity) => was ? Math.min(band * 1.4, cap) : Math.min(band, cap * .85);
// GEO lock: a body within the band (drawn mm) of the GEO ring snaps onto it. True scale (a footprint, makeTrueMaps foot): its
// orbit is drawn ~35 mm inside the piece, so it locks from the piece itself (seen) a band inside the ring out to its orbit a band
// outside it; below that it reads under GEO, beyond it over (Oct 25: the window ran -5 / +75 mm; centred on the ring, a piece
// just outside the window read below GEO again)
export function lockGeo(maps, b, was, band, cap) {
  if (b.prim !== 'E') return b;
  const rg = maps.E.rho(R_GEO), w = lockW(band, was, cap);
  return (maps.E.rho0 != null && b.seen != null ? b.seen > rg - w && b.rho < rg + w : Math.abs(b.rho - rg) < w) ? { ...b, r: R_GEO, rho: rg, n: Math.sqrt(MU_E / R_GEO ** 3), locked: true } : b;
}
// LEO lock: a body within the band outside the LEO ring is in LEO; flagged leo, not locked (it still has somewhere to go: the
// transfer to GEO is drawn from there)
export function lockLeo(maps, b, was, band, cap) {
  if (b.prim !== 'E') return b;
  const rl = maps.E.rho(R_LEO);
  return b.rho - rl < lockW(band, was, cap) ? { ...b, r: R_LEO, rho: rl, n: Math.sqrt(MU_E / R_LEO ** 3), leo: true } : b;
}
// DRO lock: a body generally near the Moon (inside its zone, which is not drawn; 12% more once locked) is in the DRO of size rDro km
export function lockDro(maps, x, y, b, was, rDro) {
  const M = maps.M;
  if (!M || !(maps.zone > 0)) return b;
  const dm = Math.hypot(x - M.cx, y - M.cy), de = Math.hypot(x - maps.E.cx, y - maps.E.cy);
  if (!(dm < maps.zone * (was ? 1.12 : 1) && dm < de)) return b;
  return { prim: 'M', B: M, rho: M.rho(rDro), th: M.inv(x, y).th, r: rDro, n: Math.sqrt(MU_M / rDro ** 3), dir: M.dir, locked: true };
}
// where a body `a` is heading: the circular orbit of radius r km about prim ('E' or 'M'). Earth to Earth, the phase is set
// so the transfer has no wait.
export function targetBody(maps, a, prim, r) {
  const B = prim === 'M' ? maps.M : maps.E, n = Math.sqrt(B.mu / r ** 3);
  return { prim, B, rho: B.rho(r), th: prim === 'E' && a.prim === 'E' ? a.th + Math.PI - n * hoh(MU_E, a.r, r).tof : a.th, r, n, dir: B.dir, virtual: true };
}
// a body's drawing frame: xy(rho, th) -> table point for drawn radius rho at angle th (CCW, math axes); inv(x, y) -> { rho, th }.
// dir: the way its orbits run (+1 anticlockwise; the Moon's are retrograde DROs, -1)
function withXY(B) {
  return Object.assign({ dir: 1, xy: (rho, th) => [B.cx + rho * Math.cos(th), B.cy - rho * Math.sin(th)],
    inv: (x, y) => ({ rho: Math.hypot(x - B.cx, y - B.cy), th: Math.atan2(-(y - B.cy), x - B.cx) }) }, B);
}
// Orbits in the Moon zone are distant retrograde orbits (the LEO -> DRO mission's destination): clockwise as seen from
// above, and in the Earth-Moon frame stretched across the Earth-Moon line (along the Moon's motion) by
// 1 + .30 (r / DRO_A0)^2.2, r the size in km (Oct 25, fitted to the restricted three-body DROs: 1.07:1 at 36,000 km,
// the LEO -> DRO mission's, about 1.3:1 at the edge of the zone, as data/mission_dro.json's 68,000 x 89,000 km); held at
// its 1.2 DRO_A0 value beyond (no runaway stretch; the drawn size still grows with r, so inv() stays one-to-one).
// Everything about the Moon is drawn in this stretched frame, so its transfers bend the same way.
export const DRO_A0 = 70000;
function droStretch(M, thM) {
  const ax = [Math.cos(thM), -Math.sin(thM)], pp = [-Math.sin(thM), -Math.cos(thM)];   // table axes: Earth -> Moon, and the Moon's motion
  const asp = rho => { const r = Math.max(0, M.r(rho)); return 1 + .30 * Math.min(r / DRO_A0, 1.2) ** 2.2; };
  return Object.assign(M, { dir: -1, asp,
    xy: (rho, th) => { const ps = th - thM, u = rho * Math.cos(ps), v = rho * Math.sin(ps) * asp(rho); return [M.cx + u * ax[0] + v * pp[0], M.cy + u * ax[1] + v * pp[1]]; },
    inv: (x, y) => {                                         // undo the stretch: rho solves rho^2 = u^2 + (v / asp(rho))^2 (bisection; f rises with rho)
      const dx = x - M.cx, dy = y - M.cy, u = dx * ax[0] + dy * ax[1], v = dx * pp[0] + dy * pp[1];
      let lo = Math.abs(u), hi = Math.hypot(u, v) + 1e-9;
      for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (m * m < u * u + (v / asp(m)) ** 2) lo = m; else hi = m; }
      const rho = (lo + hi) / 2;
      return { rho, th: thM + Math.atan2(v / asp(rho), u) };
    } });
}

const vc = (mu, r) => Math.sqrt(mu / r);
const hoh = (mu, r1, r2) => { const a = (r1 + r2) / 2; return { a, v1t: Math.sqrt(mu * (2 / r1 - 1 / a)), v2t: Math.sqrt(mu * (2 / r2 - 1 / a)), tof: Math.PI * Math.sqrt(a ** 3 / mu) }; };
const hypBurn = (mu, r, vinf) => Math.sqrt(vinf * vinf + 2 * mu / r) - vc(mu, r);   // circular orbit at r <-> hyperbolic with v_inf
// time to wait until body 2 leads body 1 by the angle a transfer of duration tof needs
const waitFor = (n1, th1, n2, th2, tof) => { const dn = n2 - n1; if (Math.abs(dn) < 1e-12) return 0; const d = wrap(Math.PI - n2 * tof - (th2 - th1)); return d < 1e-9 ? 0 : dn > 0 ? d / dn : (d - TAU) / dn; };
export const propFor = (pm, dvKms) => V.propFor(pm.isp, dvKms);
// the presenter's Isp per engine (show.isp, Oct 26: "allow isp changes (should adjust fuel necessary automatically)"): every path's
// fuel and electric burn time is priced with it from then on; null or a bad value: vehicle.js's
export function setIsp(o) { const [ET, GT] = PROP_MODES, n = v => typeof v === 'number' && isFinite(v) && v > 0 ? v : null; ET.isp = n(o?.et) ?? V.SELDON.isp; GT.isp = n(o?.gt) ?? V.TUG.isp; }
export const burnTime = (pm, mp) => V.burnTime(mp, pm);
export const dvMax = pm => V.dvMax({ ...V.SELDON, isp: pm.isp });   // km/s a full tank gives

// a body on the table -> its orbit. Inside the Moon zone it orbits the Moon. seen: the piece's own distance from the body's centre (mm)
export function bodyAt(maps, x, y) {
  const { E, M } = maps, dm = M ? Math.hypot(x - M.cx, y - M.cy) : Infinity, de = Math.hypot(x - E.cx, y - E.cy);
  // the Moon's only if inside its zone, nearer the Moon, and not touching the Earth figure (a close Moon's zone can reach Earth)
  const touchE = de < FIG.E + FIG.S + 2, B = dm < maps.zone && dm < de && !touchE ? M : E, prim = B === M ? 'M' : 'E', { rho, th } = B.inv(x, y), floor = B.R + FLOOR_ALT[prim];
  if (maps.true) {
    const r = Math.max(floor, B.r(rho));
    return { prim, B, rho: Math.max(B.off, rho), th, r, n: Math.sqrt(B.mu / r ** 3), dir: B.dir, seen: rho };
  }
  const r = Math.max(floor, B.r(rho));
  return { prim, B, rho: B.rho(r), th, r, n: Math.sqrt(B.mu / r ** 3), dir: B.dir, seen: rho };
}
// a DRO's period (s) for its size r km: the restricted three-body DROs (audit, Oct 25: 2.68 / 5.88 / 8.91 / 13.21 days at
// 20,000 / 36,000 / 50,000 / 70,000 km), log-log between them and beyond, but never longer than Kepler's 2 pi sqrt(r^3 / mu_M)
// (7.1 d at 36,000 km): close in the Earth hardly matters, and the two meet near 11,000 km
const DRO_T = [[20000, 2.68], [36000, 5.88], [50000, 8.91], [70000, 13.21]];
export function droPeriod(r) {
  const i = Math.max(0, Math.min(DRO_T.length - 2, DRO_T.filter(([q]) => q <= r).length - 1)), [r0, t0] = DRO_T[i], [r1, t1] = DRO_T[i + 1];
  return Math.min(t0 * (r / r0) ** (Math.log(t1 / t0) / Math.log(r1 / r0)) * 86400, TAU * Math.sqrt(r ** 3 / MU_M));
}
export function moonBody(maps) { const r = D_EM; return { prim: 'E', B: maps.E, rho: maps.Dmm, th: maps.thM, r, n: Math.sqrt(MU_E / r ** 3), dir: 1 }; }
// a body's whole orbit (ring) and its position at angle th, as table points. On a pass (onPass) th is a mean anomaly, so a dot
// riding it at a steady rate keeps a Kepler-like pace (fastest at periapsis; ell.ep, softened); its ring is sampled evenly in eccentric anomaly
export const orbitPts = (b, n = 256) => Array.from({ length: n + 1 }, (_, i) => b.ell ? ellXY(b.ell, i / n * TAU) : b.B.xy(b.rho, i / n * TAU));
export const orbitXY = (b, th) => b.ell ? ellXY(b.ell, keplerE(wrap(th), b.ell.ep)) : b.B.xy(b.rho, th);

// ---- transfer shapes (drawn mm, in a body's frame; s = turning sense, +1 anticlockwise) ----
const sweepTo = (from, to, s) => s > 0 ? wrap(to - from) : -wrap(from - to);   // angle from `from` to `to`, going the s way
// along a circular orbit of drawn radius rho from angle th0 through the signed angle d (a coast, or waiting for the burn point)
function coastArc(B, rho, th0, d) {
  const n = Math.min(4000, Math.max(2, Math.ceil(Math.abs(d) * rho * (B.asp ? B.asp(rho) : 1) / 1.5)));
  return Array.from({ length: n + 1 }, (_, j) => B.xy(rho, th0 + d * j / n));
}
// Thrust near periapsis raises the far side: from a circular orbit rho1, with the periapsis toward thP, each turn's
// apoapsis is higher, and the periapsis stays put. Sweeps s * (2 pi N + pi) and ends at apoapsis rho2 (toward thP + pi).
// ET (steps = false): the apoapsis grows around each periapsis pass (at the rate 1 + cos phi) and not at all at an
// apoapsis, so every loop's far point lies on the one apse line, as real periapsis burns leave it, and the last is
// reached level (Oct 25: it grew all the way round, which turned the loops and kinked the hand-over); GT (steps = true):
// N whole ellipses, one per burn, then the last half. Apoapsis progress goes as (fraction of the climb)^RAISE_Q.
// Then (periRaise) thrust near apoapsis, by the same law, raises the periapsis, apoapsis held at rho2, until the orbit is circular there.
const RAISE_Q = 1.3, burnt = (phi, PHI) => (phi + Math.sin(phi)) / PHI;   // share of the climb done by phi, burning around phi = 0, 2 pi, ...
function conicRun(B, phiEnd, s, th0, rhoAt) {                   // sample rho(phi) for phi 0..phiEnd at about 2 mm steps
  const out = [];
  for (let phi = 0; ; ) {
    const rho = rhoAt(phi);
    out.push(B.xy(rho, th0 + s * phi));
    if (phi >= phiEnd) break;
    const d = 1e-3, slope = (rhoAt(Math.min(phiEnd, phi + d)) - rho) / d, ds = Math.hypot(rho, slope) * (B.asp ? B.asp(rho) : 1);
    phi = Math.min(phiEnd, phi + Math.min(.05, 2 / Math.max(ds, 1e-3)));
  }
  return out;
}
function apoRaise(B, rho1, rho2, thP, s, N, steps) {
  const PHI = TAU * N + Math.PI;
  const apo = phi => rho1 + (rho2 - rho1) * (steps ? ((Math.min(N, Math.floor(phi / TAU)) + 1) / (N + 1)) : burnt(phi, PHI)) ** RAISE_Q;
  return conicRun(B, PHI, s, thP, phi => { const A = apo(phi), e = (A - rho1) / (A + rho1); return rho1 * (1 + e) / (1 + e * Math.cos(phi)); });
}
function periRaise(B, rho1, rho2, thA, s, N) {
  const PSI = TAU * N;
  return conicRun(B, PSI, s, thA, psi => { const P = rho1 + (rho2 - rho1) * burnt(psi, PSI) ** RAISE_Q, e = (rho2 - P) / (rho2 + P); return rho2 * (1 - e) / (1 - e * Math.cos(psi)); });
}
// how many turns: ET winds more than GT; GT is a plain Hohmann for short climbs, a few burns (Chandrayaan-style) for long ones
export const LOOPS = { etMm: 120, etMax: 6, gtMm: 350, gtMax: 2, gtMin: 0 };   // (gtMin: LEO TO GEO / LEO TO DRO's chemical, pulsed, never a bare Hohmann: modes.js)
const loopsFor = (kind, span) => kind === 'gt' ? Math.max(LOOPS.gtMin, Math.min(LOOPS.gtMax, Math.floor(span / LOOPS.gtMm))) : Math.max(1, Math.min(LOOPS.etMax, Math.round(span / LOOPS.etMm)));
// A climb between two circular orbits of one body: periapsis burns raise the apoapsis to rho2, and (ET) apoapsis burns
// then raise the periapsis until the orbit is circular there. It starts at angle th1 and ends on the rho2 orbit at
// th1 + s * sweep(kind, ...): wherever the climb happens to finish, not at a chosen point.
function climbPlan(kind, span) { const N = loopsFor(kind, span), N2 = kind === 'et' ? Math.max(1, Math.round(N / 2)) : 0; return { N, N2, sweep: TAU * N + Math.PI + TAU * N2 }; }
function climb(B, rho1, th1, rho2, s, kind) {
  const { N, N2, sweep } = climbPlan(kind, rho2 - rho1), pts = apoRaise(B, rho1, rho2, th1, s, N, kind === 'gt');
  if (N2) pts.push(...periRaise(B, rho1, rho2, th1 + s * (TAU * N + Math.PI), s, N2).slice(1));
  pts[pts.length - 1] = B.xy(rho2, th1 + s * sweep);
  return pts;
}
// the tip a quarter turn on, along the orbit just joined (Oct 25): an ET climb comes round circular right where it
// handed over from raising the apoapsis to raising the periapsis, and a lowering ends on the periapsis all its loops
// share, so a path that stopped right there put its arrowhead on a fork
const TIP = Math.PI / 2;
// ... or 3/8 turn where a quarter would put the arrowhead beside the target piece itself (a lowering's shared periapsis can be under it)
const tipOn = (B, b, th) => { if (b.virtual) return TIP; const P = B.xy(b.rho, b.th), far = d => { const q = B.xy(b.rho, th + B.dir * d); return Math.hypot(q[0] - P[0], q[1] - P[1]); };
  return far(TIP) > 60 || far(TIP) >= far(3 * Math.PI / 4) ? TIP : 3 * Math.PI / 4; };
// on a DRO: 3 pi / 8 on (67.5 deg), or the nearest pi / 8 step that keeps the arrowhead off the "DRO" label on its far side
// and off the Moon's orbit ring, which crosses it a quarter turn either side of that
const droTip = (thM, th0, sm) => [3, 4, 2, 5].map(k => sm * k * Math.PI / 8).find(d => [0, 1, -1].every(c => Math.abs(Math.atan2(Math.sin(th0 + d - thM - c * Math.PI / 2), Math.cos(th0 + d - thM - c * Math.PI / 2))) > .35)) ?? sm * TIP;
// Realistic ends (user, Oct 12): a transfer starts at its first burn and ends where it joins Seldon-2's orbit (then the
// TIP); meeting Seldon-2 itself would be a separate phasing step. Where the first burn is not at Seldon-1, a coast (`lead`)
// shows Seldon-1 riding its own orbit to it. Within one body the first burn is at Seldon-1 itself: a raise starts there; a
// lowering is a raise that ends at Seldon-1, built the other way round and reversed.
function sameBody(B, a, b, kind) {
  if (b.rho >= a.rho) {
    const { N2, sweep } = climbPlan(kind, b.rho - a.rho), path = climb(B, a.rho, a.th, b.rho, B.dir, kind);
    if (N2) path.push(...coastArc(B, b.rho, a.th + B.dir * sweep, B.dir * tipOn(B, b, a.th + B.dir * sweep)).slice(1));
    return { lead: [], path: [path] };
  }
  const s = -B.dir, { N, sweep } = climbPlan(kind, a.rho - b.rho), th1 = a.th - s * sweep, path = climb(B, b.rho, th1, a.rho, s, kind).reverse();
  if (N) path.push(...coastArc(B, b.rho, th1, B.dir * tipOn(B, b, th1)).slice(1));
  return { lead: [], path: [path] };
}
// Earth orbit e <-> DRO m. Built outward (s = +1: Earth -> Moon); s = -1 builds the mirror image, which reversed is the
// trip back. From the periapsis opposite the Moon, apoapsis-raising loops lined up with the Moon, the last apoapsis on
// the DRO's Earth side (Dmm - m.rho from Earth: droStretch leaves the Earth-Moon line as it is), reached level, so there
// it already runs the DRO's way; the path then follows the DRO itself to its tip (droTip; Oct 25: the capture curve this
// replaces met the zone heading at the Moon and hooked back toward Earth); a Seldon already beyond GEO: direct. Returns
// the Earth-side coast from e to the periapsis, the path, the angle where it leaves the DRO and (thE) the periapsis all
// its loops share.
function lunarLegs(maps, e, m, s, kind) {
  const { E, M } = maps, thP = maps.thM + Math.PI, sm = M.dir * s, rho2 = maps.Dmm - m.rho;
  if (e.rho > E.rho(R_GEO) + 1 || rho2 < e.rho + 20) return direct(maps, e, m, s);
  const earth = apoRaise(E, e.rho, rho2, thP, s, loopsFor(kind, rho2 - e.rho), kind === 'gt');
  const d = droTip(maps.thM, thP, sm);
  return { lead: coastArc(E, e.rho, e.th, sweepTo(e.th, thP, s)), path: [earth, coastArc(M, m.rho, thP, d)], thDro: thP + d, thE: thP };
}
// a Seldon already beyond GEO, partway out (Oct 25: its lap to the burn point and the loops ran mostly off the table):
// no wait and no loops, one curve from it onto the DRO, then along the DRO to its tip. The curve is a parabola (its two
// end tangents meet at X), so it turns one way only; it joins the DRO where it turns least on the shortest way without
// cutting through the DRO or LEO or swinging wide (legs to X over 2.5 x the chord: a near-parallel join put X metres off),
// leaving along the Seldon's own orbit or, where that would loop back, straight at the DRO, the turn hidden under the piece.
// First choice: only along its orbit on the trip back (which then ends on Seldon-2's orbit and takes a short tip along it,
// thE) and in true scale (its orbit is drawn ~35 mm inside the piece, so a turn there would show); then either; each time
// leaving forward (not against its own motion) with no bend tighter than 25 mm radius outside the piece. Failing all that,
// any way (on the trip back then no tip, it would double back over the path: it stops at the piece's edge instead, so its
// arrowhead shows, pointing at it). room (the LEO TO DRO profile's, hybrid): those first choices again, the curve kept inside it
// (no farther out than the piece; Oct 26, near a rail it ran 25 mm in), before any that leaves it (the DRO itself is the layout's).
// On a pass (onPass) "its orbit" is its ellipse: it leaves from the piece along that.
// both (LEO TO DRO, owner, Oct 26: "nearest point any direction"): it may join the DRO either way round, the way it is already going (the
// DRO runs clockwise, against an Earth orbit everywhere but on its Earth side: a clockwise join elsewhere is a U-turn by the Moon)
function direct(maps, e, m, s, room, perRad = 460, both = false) {
  const { E, M } = maps, P0 = e.ell ? e.ell.pt : E.xy(e.rho, e.th), t0 = e.ell ? e.ell.tan.map(c => c * s) : [-s * Math.sin(e.th), -s * Math.cos(e.th)], sm = M.dir * s, rl = E.rho(R_LEO), pc = e.pc ?? E.xy(e.seen ?? e.rho, e.th);   // (pc: the piece; hybrid's ride: where it leaves its ellipse, nothing hidden there)
  const cr = (u, v) => u[0] * v[1] - u[1] * v[0], turn = (u, v) => Math.atan2(cr(u, v), u[0] * v[0] + u[1] * v[1]), sub = (p, q) => [p[0] - q[0], p[1] - q[1]];
  const bez = (X, Q, n) => Array.from({ length: n + 1 }, (_, j) => { const t = j / n, u = 1 - t; return [0, 1].map(q => u * u * P0[q] + 2 * u * t * X[q] + t * t * Q[q]); });
  const tight = B => B.some((p, j) => j > 0 && j < B.length - 1 && Math.hypot(...sub(p, pc)) > 33 && Math.abs(turn(sub(p, B[j - 1]), sub(B[j + 1], p))) * 2 / (Math.hypot(...sub(p, B[j - 1])) + Math.hypot(...sub(B[j + 1], p))) > 1 / 25);
  let best = { cost: Infinity, th: maps.thM + Math.PI };
  const outR = room && (q => Math.max(room.x0 - q[0], q[0] - room.x1, room.y0 - q[1], q[1] - room.y1)), tolR = room && Math.max(.5, outR(P0) + .5), f0 = s > 0 && E.rho0 == null ? [0, 1] : [0];
  for (const [frees, strict, inR] of [...(room ? [[f0, true, true], [[0, 1], true, true]] : []), [f0, true], [[0, 1], true], [[0, 1], false]]) {
    for (let i = 0; i < 72 * (both ? 2 : 1); i++) {
      const dj = i < 72 ? sm : -sm, th = i % 72 / 72 * TAU, Q = M.xy(m.rho, th), q2 = M.xy(m.rho, th + dj * 1e-3), c = sub(Q, P0), L = Math.hypot(...c), tl = Math.hypot(...sub(q2, Q));
      const tq = [(q2[0] - Q[0]) / tl, (q2[1] - Q[1]) / tl], a2 = turn(c, tq);
      for (const free of frees) {   // leaving along its orbit, or straight at the DRO (symmetric: the chord halves the turn; not from a ride: no piece hides that turn)
        if (free && e.pc) continue;
        const t = free ? [(c[0] * Math.cos(a2) + c[1] * Math.sin(a2)) / L, (c[1] * Math.cos(a2) - c[0] * Math.sin(a2)) / L] : t0, d = cr(t, tq), u = cr(c, tq) / d, w = cr(t, c) / d;
        if (!(u > 0 && w > 0) || u + w > 2.5 * L || (strict && free && t[0] * t0[0] + t[1] * t0[1] < 0) || (e.pc && u < .2 * L)) continue;   // X = P0 + t u = Q - tq w, ahead of both ends (from a ride: X well ahead, or it leaves at a corner)
        const X = [P0[0] + t[0] * u, P0[1] + t[1] * u], cost = Math.abs(turn(t, tq)) + free * 1.6 + (u + w) / perRad, B = cost < best.cost && bez(X, Q, 48);   // (1 rad ~ perRad mm of way: 460; LEO TO DRO, HYB.perRad)
        if (!B || B.slice(0, -1).some(p => M.inv(p[0], p[1]).rho < m.rho - .3 || Math.hypot(p[0] - E.cx, p[1] - E.cy) < rl) || (strict && tight(B)) || (inR && B.some(p => outR(p) > tolR))) continue;
        best = { cost, th, dj, Q, X, n: Math.min(2000, Math.ceil((u + w) / 1.5)), fwd: t[0] * t0[0] + t[1] * t0[1] > 0 };
      }
    }
    if (best.X) break;
  }
  const Q = best.Q || M.xy(m.rho, best.th), X = best.X || [(P0[0] + Q[0]) / 2, (P0[1] + Q[1]) / 2];   // (nothing fits: straight)
  const dt = droTip(maps.thM, best.th, best.dj ?? sm), B = bez(X, Q, best.n || 60), cut = s < 0 && !best.fwd ? Math.max(0, B.findIndex(p => Math.hypot(...sub(p, pc)) > 60)) : 0;
  return { lead: [], path: [B.slice(cut), coastArc(M, m.rho, best.th, dt)], thDro: best.th + dt, thE: best.fwd ? e.th : null, tipE: Math.min(TIP, 90 / e.rho), fit: !!best.X };   // (tipE: 90 mm on a big orbit)
}

// ---- LEO TO DRO: the mission's own profile (owner, Oct 26), whichever engine is picked ----
// About ten apoapsis-raising passes from LEO, all sharing the periapsis opposite the Moon: burns 1-3 chemical (impulsive, at
// periapsis), 4-10 electric (low thrust around periapsis), the tenth out to the DRO's Earth side; then on along the DRO.
// Pass k's apoapsis (km, hybApo): the chemical three evenly from LEO to HYB.chemKm (16,500 / 26,300 / 36,000 km: a GTO-like
// ellipse just inside GEO, where the well is deep and high thrust pays), the electric seven evenly from there to the DRO's Earth
// side (80,600 ... 348,400 km for a 36,000 km DRO). A Seldon already out (its apoapsis, or a circular orbit's r) skips the passes
// whose apoapsis is not beyond that by HYB.skip of that pass's step (a loop just outside its own orbit read as a lap of dashes over
// it; Oct 26) (past pass 3: electric only; at least the last, unless it is on the last already).
// Where it starts (owner, Oct 26: "in DRO mode just presume our orbit is already elliptical"): in LEO (LEO lock) or on GEO (GEO lock,
// owner, Oct 26: "it doesn't snap to geo any more") its orbit is circular, and it coasts along it to the periapsis opposite the Moon
// first, and so right behind Earth (onPass: no pass reaches there); anywhere else it is ON one of the passes (onPass): its orbit is
// the member of the passes' own family through the piece (off the passes, the ellipse through it nearest the last pass), and it rides
// that to the next periapsis (drawn, in the colour of the next pass's engine; its periapsis raised off the passes, theirs with it),
// then does the passes left. With only the last pass left (or none), or by the Moon: short of its apoapsis it goes straight on to the
// DRO, raising its apoapsis onto the DRO's Earth side on the way, if that is gentle, else one curve onto the DRO (direct(), from its
// ellipse); past its apoapsis by the Moon (HYB.near) that curve too; away from the Moon a lap back to the periapsis first.
// Numbers: chemical = vis-viva at the periapsis, from the Seldon's own ellipse (P x Q; circular r: r x r) to the pass-3 ellipse
// (periapsis burns that hold the periapsis telescope: the passes' burns add up to the one burn to A3); electric = vehicle.js lunarDv's
// low-thrust estimate (as every ET figure here) from the circular orbit of the same energy (the ellipse's semi-major axis) to the
// Moon's distance, plus the capture into the DRO. So a pass's numbers run on from LEO's (Q -> LEO: the circle).
// Fuel stage by stage: the electric propellant on the dry mass (it is burnt last), then the chemical on the dry mass plus that.
// Time: the chemical passes' periods, then the electric burn time (propellant / mass flow: continuous thrust, as the ET estimate
// everywhere; its coasts are not counted). Drawn: the remaining passes' apoapses on the map's own scale, stretched from the Seldon's
// orbit (a pass: the family's) to the DRO's Earth side; chemical loops whole ellipses (one burn each), electric ones growing around each
// periapsis (apoRaise's rate); each side of the Earth-Moon line is squeezed across it by one factor (the loops stay nested and evenly
// spaced, and keep their tangents: they cross the line square), to wMax mm at most (the widest is sqrt(periapsis x apoapsis)) and to
// the room that side has inside maps.room (modes.js: the table between its rails, clear of the end notes; else HYB.room, the same with
// both rails), wherever the Earth-Moon line lies (Oct 26: a fixed cap ran the loops of an off-centre pair through the rails); a start
// on a pass takes the LEO start's squeeze, as its ring does (its passes no more than that, a raised periapsis's wider ones less). The coast of a circular start is on its own ring while that stays in the
// room (LEO; GEO at 970 mm apart, centred). A ring too big for it (GEO with Earth by the table's end, or in true scale) is drawn the
// same way, eased in along the line behind Earth (x / (1 + c x) from Earth, C1 there, so no kink; the periapsis on the room's edge,
// less what a tilted line's loops still poke out, never inside LEO) and squeezed across the line by as little as keeps it in (its own
// factor a side), the passes eased in with it; the coast keeps to the Seldon's ring until the ring nears the table's edge, then joins
// the eased one over ~70 degrees (smoothstep). A long coast (more than half a lap) is kept: honest. Time leaves out the coast, a
// pass's ride to its periapsis and the loops' laps (continuous thrust, as above), which would jump as the Seldon passes the burn point.
// (direct: a circular start past that share of the way to the Moon, now only other views' and tests'; near: the Moon's neighbourhood,
// in Moon-zone radii; pace: the riding dot's eccentricity at most; behind: rad off the line behind Earth inside which a start off the
// passes is circular, and from which it rounds off (onPass); gentle: hybrid's straight-on raise, at most this share of a0 per radian; perRad: direct()'s mm of way a radian of turn is worth here, so it takes the DRO where it is nearest)
export const HYB = { passes: 10, chem: 3, chemKm: 36000, wMax: 300, skip: .3, direct: .72, near: 1.6, pace: .5, behind: [25 * Math.PI / 180, 65 * Math.PI / 180], gentle: .4, perRad: 150, room: { x0: 40, y0: 104, x1: 1388.5, y1: 699.5 } };
const hybApo = rDro => Array.from({ length: HYB.passes }, (_, i) => i < HYB.chem ? R_LEO + (HYB.chemKm - R_LEO) * (i + 1) / HYB.chem
  : HYB.chemKm + (D_EM - rDro - HYB.chemKm) * (i + 1 - HYB.chem) / (HYB.passes - HYB.chem));
// Q: the apoapsis (km) of a start on a pass (onPass: P x Q, P its periapsis, LEO but off the passes); else circular at r
export function hybridNumbers(r, rDro, direct = false, Q = null, P = R_LEO) {
  const A = hybApo(rDro), rq = Q ?? r, rp = Q == null ? r : P, rest = direct ? [] : A.map((q, i) => [q, i]).filter(([q, i]) => q > rq + HYB.skip * (q - (i ? A[i - 1] : R_LEO))), chem = rest.filter(([, i]) => i < HYB.chem);
  const [ET, GT] = PROP_MODES, vp = ra => Math.sqrt(MU_E * (2 / rp - 2 / (rp + ra))), a = (rp + (chem.length ? A[HYB.chem - 1] : rq)) / 2;   // vp: speed at the periapsis of rp x ra; a: the orbit the electric part starts from (semi-major axis)
  const dvC = chem.length ? vp(A[HYB.chem - 1]) - vp(rq) : 0, dvE = V.lunarDv(a, rDro).et;
  const mpE = propFor(ET, dvE), mpC = V.propFor(GT.isp, dvC, V.SELDON.dry + mpE), tC = Math.max(chem.reduce((t, [q]) => t + TAU * Math.sqrt(((rp + q) / 2) ** 3 / MU_E), 0), dvC > 0 ? V.pulseTime(dvC) : 0), tE = burnTime(ET, mpE);
  return { dv: dvC + dvE, mp: mpC + mpE, t: tC + tE, wait: 0, chem: { dv: dvC, mp: mpC, t: tC, n: chem.length }, elec: { dv: dvE, mp: mpE, t: tE, n: Math.max(1, rest.length - chem.length) }, apo: rest.map(([q]) => q) };
}
// The passes' family: periapsis LEO (rp mm) opposite the Moon, apoapsis A (mm) from rp (LEO itself) out to rho2 (the last pass), in
// the frame the passes are drawn in (x from Earth toward the periapsis, y across it the prograde way, y squeezed by sq a side: the LEO
// start's, hybrid), so a Seldon's ring and its route are one curve. Per layout, cached (it builds the LEO start's route once).
const famC = { key: null, F: null };
function family(maps, rDro) {
  const { E, M } = maps, bx = maps.room || HYB.room, key = [E.cx, E.cy, M.cx, M.cy, maps.Dmm, E.rho(R_LEO), E.rho(R_GEO), E.rho(D_EM / 2), bx.x0, bx.y0, bx.x1, bx.y1, rDro].join();
  if (famC.key === key) return famC.F;
  const thP = maps.thM + Math.PI, rp = E.rho(R_LEO), leo = { prim: 'E', B: E, rho: rp, th: thP, r: R_LEO, n: Math.sqrt(MU_E / R_LEO ** 3), dir: 1, leo: true };
  const m = targetBody(maps, leo, 'M', rDro), h = hybrid(maps, leo, m), rho2 = maps.Dmm - m.rho;
  famC.key = key; famC.F = h.sq ? { E, rp, rho2, sq: h.sq, kD: (rho2 - rp) / (E.rho(hybApo(rDro).at(-1)) - rp), ecMax: (rho2 - rp) / (rho2 + rp),   // kD: drawn apoapsis per mm of the map (hybrid's D)
    o: [E.cx, E.cy], u: [Math.cos(thP), -Math.sin(thP)], v: [-Math.sin(thP), -Math.cos(thP)] } : null;
  return famC.F;
}
// member L (rp, A: drawn apsides, mm; ec; s: squeeze a side) at eccentric anomaly E0 -> table point; the eccentric anomaly at mean
// anomaly Mn (Newton from pi: safe for any e < 1); true -> eccentric
const ellXY = (L, E0) => { const F = L.F, a = (L.rp + L.A) / 2, x = a * (Math.cos(E0) - L.ec), y = a * Math.sqrt(1 - L.ec * L.ec) * Math.sin(E0), s = y > 0 ? L.s[0] : L.s[1]; return [F.o[0] + x * F.u[0] + s * y * F.v[0], F.o[1] + x * F.u[1] + s * y * F.v[1]]; };
const keplerE = (Mn, ec) => { let E0 = Math.PI; for (let i = 0; i < 30; i++) { const d = (E0 - ec * Math.sin(E0) - Mn) / (1 - ec * Math.cos(E0)); E0 -= d; if (Math.abs(d) < 1e-12) break; } return E0; };
const eccOf = (nu, ec) => wrap(2 * Math.atan2(Math.sqrt(1 - ec) * Math.sin(nu / 2), Math.sqrt(1 + ec) * Math.cos(nu / 2)));
// LEO TO DRO: a Seldon not in LEO, on GEO or in the DRO is on one of the passes (owner, Oct 26). Its orbit (ell) is an ellipse about
// Earth, periapsis opposite the Moon and apoapsis toward it, drawn squeezed as the passes, through the piece (its drawn point: in true
// scale ~35 mm inside it, as every ring there). In the family's frame (x along the line toward the periapsis, y across, un-squeezed),
// from the passes' own rp0 (LEO) and R2 (the last pass's apoapsis): where a pass reaches it, that pass (a conic with this focus and
// periapsis through a point: e = (rho - rp0) / (rp0 - x); the members nest outward with e: the bisection's answer, exactly). Beyond the
// last pass (review, Oct 26: behind Earth past a parabola through LEO, and wide of the line, a third of the table, took the last pass as
// it was, its ring up to 346 mm off the piece) the ellipse through it nearest the last pass (least log(rp / rp0) + log(A / R2)): toward
// the Moon, its apoapsis raised; wide of the line, the piece at the end of its minor axis (rp + A = 2 rho, both apsides out); nearer
// Earth, its periapsis raised under the last pass's apoapsis. One surface, continuous across the three and onto the passes. Where that
// ring would run into a rail (more than the piece does), its apoapsis comes in (bisection; the ring narrows to the piece's own width at
// the minor-axis one, or a circle behind Earth; the piece's side, the other is next); and behind Earth it rounds off, within HYB.behind of the line opposite the Moon, into
// the circle through it (log A eased, smoothstep in the angle): a Seldon there is in a circular orbit and does the whole trip, coasting
// to the burn point as from LEO (onPass leaves it circular, hybrid's circular start; review, Oct 26: just past the LEO band it read as
// the last pass, apogee 342,000 km). The ring's other half (across the line from the piece) is squeezed as much more as keeps it
// off that rail (an off-centre or tilted pair's far starts ran it 300 mm through it). The riding dot's pace is Kepler's with e at most
// HYB.pace (Kepler's 13 : 1 on the long passes crossed periapsis 40 mm a frame).
// near: in the Moon's neighbourhood (within HYB.near zone radii, 12% more once there: was); beyond: past the DRO's Earth side along the line
// ell: F, rp, A (drawn apsides, mm), ec, nu (true anomaly from the periapsis, prograde), Q, rpK (apsides, km: the apoapsis read as the
// passes' are, the periapsis as the map's), ep, m0 (the dot's pace's e, and its mean anomaly at the piece: orbitXY), off (mm, piece to
// ring), pt, tan (that point on the ring and the prograde direction there), near, beyond; n: its mean motion
export function onPass(maps, b, rDro, was = false) {
  if (b.prim !== 'E' || b.locked || b.leo || !maps.M) return b;
  const F = family(maps, rDro); if (!F) return b;
  const P = b.B.xy(b.rho, b.th), pc = b.B.xy(b.seen ?? b.rho, b.th), dx = P[0] - F.o[0], dy = P[1] - F.o[1], x = dx * F.u[0] + dy * F.u[1], yd = dx * F.v[0] + dy * F.v[1];
  const y = yd / (yd > 0 ? F.sq[0] : F.sq[1]), rho = Math.hypot(x, y), r0 = F.rp, R2 = F.rho2, e0 = rho <= r0 ? 0 : r0 - x > 1e-9 ? (rho - r0) / (r0 - x) : Infinity;
  const mk = (rp, A) => ({ F, rp, A, ec: (A - rp) / (A + rp), s: F.sq.slice(), nu: wrap(Math.atan2(y, x)) }), rpOf = A => A * (rho + x) / (2 * A - rho + x);   // (the member with apoapsis A through the piece)
  const bx = maps.room || HYB.room, rail = q => Math.max(bx.y0 - q[1], q[1] - bx.y1), tol = Math.max(0, rail(P)) + .5, ip = yd > 0 ? 0 : 1;
  const over = (M, i) => { let w = -Infinity; for (let j = 1; j < 48; j++) w = Math.max(w, rail(ellXY(M, (i + j / 48) * Math.PI))); return w; };   // (side i's half: 0 the y > 0 one)
  let L;
  if (e0 <= F.ecMax) L = mk(r0, r0 * (1 + e0) / (1 - e0));                    // a pass
  else if (rho + x <= r0) L = mk(r0, r0 * (rho - x) / (2 * r0 - rho - x));    // apoapsis raised
  else if (rho - x >= R2) L = mk(rho + x, rho - x);                           // on its minor axis
  else {                                                                       // periapsis raised
    const ov = A => over(mk(rpOf(A), A), ip), lo0 = x > 0 ? rho : rho - x, ps = Math.acos(Math.max(-1, Math.min(1, x / (rho || 1)))), c1 = Math.cos(HYB.behind[0]), c2 = Math.cos(HYB.behind[1]);
    let A = R2;
    if (ov(A) > tol) { let lo = lo0, hi = R2; for (let i = 0; i < 24; i++) { const m = (lo + hi) / 2; if (ov(m) > tol) hi = m; else lo = m; } A = lo; }
    const w = x > 0 ? (t => t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t))((Math.cos(ps) - c2) / (c1 - c2)) : 0;   // (behind Earth: round off)
    if (w >= 1) return b;                                                      // the circle: a circular start
    A = Math.exp(Math.log(A) * (1 - w) + Math.log(rho) * w); L = mk(Math.min(rpOf(A), A), A);
  }
  if (over(L, 1 - ip) > .5) { let lo = .2, hi = L.s[1 - ip]; for (let i = 0; i < 18; i++) { L.s[1 - ip] = (lo + hi) / 2; if (over(L, 1 - ip) > .5) hi = L.s[1 - ip]; else lo = L.s[1 - ip]; } L.s[1 - ip] = lo; }
  const E0 = eccOf(L.nu, L.ec), q = ellXY(L, E0), a = (L.rp + L.A) / 2, s = Math.sin(E0) > 0 ? L.s[0] : L.s[1], tx = -a * Math.sin(E0), ty = a * Math.sqrt(1 - L.ec * L.ec) * Math.cos(E0) * s;
  const t = [tx * F.u[0] + ty * F.v[0], tx * F.u[1] + ty * F.v[1]], tl = Math.hypot(...t) || 1;
  const kmOf = want => { let lo = R_LEO, hi = 1.5 * D_EM; for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (F.E.rho(m) < want) lo = m; else hi = m; } return (lo + hi) / 2; };   // (bisection; rho rises with r)
  const Q = kmOf(r0 + (L.A - r0) / F.kD), rpK = L.rp > r0 + 1e-9 ? kmOf(L.rp) : R_LEO, aK = (rpK + Q) / 2, ep = Math.min(L.ec, HYB.pace);
  const beyond = -x > R2, near = beyond || Math.hypot(pc[0] - maps.M.cx, pc[1] - maps.M.cy) < HYB.near * maps.zone * (was ? 1.12 : 1);
  return { ...b, n: Math.sqrt(MU_E / aK ** 3), ell: { ...L, Q, rpK, ep, m0: E0 - ep * Math.sin(E0), off: Math.hypot(q[0] - P[0], q[1] - P[1]), pt: q, tan: [t[0] / tl, t[1] / tl], near, beyond } };
}
// Earth orbit e -> DRO m along the profile: numbers and shape (lead, path, kinds: 'gt' / 'et' per path segment; sq: the passes'
// squeeze, family; how, a pass's: 'passes', 'on' or 'direct'). A circular start's coast is the (unshown) lead with chemical passes left,
// else the path's first stretch; a pass rides its own ellipse as the path's first stretch
export function hybrid(maps, e, m) {
  const { E, M } = maps, thP = maps.thM + Math.PI, rho2 = maps.Dmm - m.rho, el = e.ell;
  const straight = () => { const L = direct(maps, e, m, 1, maps.room || HYB.room, HYB.perRad, true); return { ...hybridNumbers(e.r, m.r, true, el?.Q, el?.rpK), lead: L.lead, path: L.path, kinds: L.path.map(() => 'et'), how: 'direct' }; };
  if (!el && (e.rho > HYB.direct * maps.Dmm || rho2 < e.rho + 20 || e.r >= D_EM - m.r)) return straight();
  const N = hybridNumbers(e.r, m.r, false, el?.Q, el?.rpK), rp = el ? el.rp : e.rho, r0 = el ? el.F.rp : rp, u0 = E.rho(el ? R_LEO : e.r), u1 = E.rho(hybApo(m.r).at(-1)), fin = !!el && !N.apo.length;   // fin: on the last pass already
  const D = fin ? [rho2] : N.apo.map((q, i) => i === N.apo.length - 1 ? rho2 : r0 + (E.rho(q) - u0) * (rho2 - r0) / (u1 - u0));   // drawn apoapses (mm; a pass: the family's, as its own A)
  const u = [Math.cos(thP), -Math.sin(thP)], v = [-Math.sin(thP), -Math.cos(thP)], o = [E.cx, E.cy];
  const T = ([x, y]) => [o[0] + x * u[0] + y * v[0], o[1] + x * u[1] + y * v[1]], S = t => t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
  // a pass (el): from its own point (true anomaly ph0) round its own ellipse (apoapsis a0) to the next periapsis (phB), then the passes
  // from there. With the last pass left at most, or by the Moon (arrive; review, Oct 26: 80% of the way out it rode a whole lap back
  // round Earth first): short of its apoapsis, on to it instead (on), its apoapsis raised (or lowered) onto the DRO's Earth side on the
  // way, if that is gentle (HYB.gentle: at most that share of its radius per radian left; a big raise in the last few degrees drew a
  // hook); else, short of its apoapsis or by the Moon, one curve from it onto the DRO (direct()); else (past its apoapsis, away from the
  // Moon) the lap back to the periapsis first. Past the DRO's Earth side along the line (beyond): direct()
  const nc = fin ? 0 : N.chem.n, ne = D.length - nc, a0 = el ? el.A : rp, L0 = nc ? D[nc - 1] : a0;
  const ph0 = el && el.nu > 1e-3 ? el.nu : 0, phB = ph0 ? TAU : 0, before = ph0 > 0 && ph0 <= Math.PI, arrive = !!el && (fin || D.length === 1 || el.near);
  const on = arrive && before && Math.abs(rho2 - a0) <= HYB.gentle * (Math.PI - ph0) * a0, phE = phB + TAU * nc, phEnd = phE + Math.PI + TAU * (ne - 1);
  // an apoapsis at or past the DRO's Earth side (owner, Oct 26: "it always hits left side of the moon ... it should do that for any point
  // where the apogee is at or to the right of the leftmost part of the DRO"): its own orbit reaches the DRO, so no passes and no swing round
  // to the Earth side: it rides its ellipse until it is by the Moon (HYB.near zone radii), then one curve onto the DRO where that turns least
  // (direct(): the easiest point to reach); by the Moon already, that curve from the piece. (At the last pass exactly, that point is the Earth
  // side: on, as before.)
  if (el && el.A > rho2 + 1 && !el.near) {
    const nr = HYB.near * maps.zone, by = p => Math.hypot(p[0] - M.cx, p[1] - M.cy) < nr, E0 = eccOf(el.nu, el.ec), ride = [el.pt];
    let E1 = E0, L = null;
    const step = () => { const p = ride.at(-1), q = ellXY(el, E1 + 1e-3), ds = Math.hypot(q[0] - p[0], q[1] - p[1]) / 1e-3; E1 += Math.min(.02, 3 / Math.max(ds, 1e-3)); ride.push(ellXY(el, E1)); };
    const bx = maps.room || HYB.room, out = q => Math.max(bx.x0 - q[0], q[0] - bx.x1, bx.y0 - q[1], q[1] - bx.y1), tolO = Math.max(0, out(el.pt)) + 1;
    while (E1 < E0 + TAU && !by(ride.at(-1)) && out(ride.at(-1)) <= tolO) step();   // (by the Moon, or about to leave the table: from there if a curve fits)
    while (E1 < E0 + TAU) {   // (from where the ride leaves its ellipse no turn is hidden: it leaves along it, so a little farther on if no curve fits yet)
      const p = ride.at(-1), q = ride.at(-2), l = Math.hypot(p[0] - q[0], p[1] - q[1]) || 1;
      L = direct(maps, { ...e, ell: { ...el, pt: p, tan: [(p[0] - q[0]) / l, (p[1] - q[1]) / l] }, pc: [Infinity, Infinity] }, m, 1, maps.room || HYB.room, HYB.perRad, true);
      if (L.fit) break; for (let j = 0; j < 4; j++) step(); L = null;
    }
    if (L) { const path = [ride, ...L.path]; return { ...hybridNumbers(e.r, m.r, true, el.Q, el.rpK), lead: [], path, kinds: path.map(() => 'et'), sq: el.F.sq, how: 'ride' }; }
  }
  if (el && (el.beyond || el.A > rho2 + 1 || (arrive && !on && (before || el.near)))) return straight();
  const apo = phi => {
    if (phi < phB) return on ? a0 + (rho2 - a0) * S((phi - ph0) / (Math.PI - ph0)) : a0;      // its own ellipse
    if (phi < phE) return D[Math.min(nc - 1, Math.floor((phi - phB) / TAU))];             // chemical: one ellipse per burn
    const t = phi - phE; if (t <= Math.PI) return L0 + (D[nc] - L0) * (t + Math.sin(t)) / Math.PI;   // electric: grows around each periapsis
    const i = Math.min(ne - 1, Math.floor((t + Math.PI) / TAU)), c = t - TAU * i;          // (centred on the i-th periapsis after the hand-over)
    return D[nc + i - 1] + (D[nc + i] - D[nc + i - 1]) * (c + Math.PI + Math.sin(c)) / TAU;
  };
  const loc = phi => { const A = apo(phi), ec = (A - rp) / (A + rp), rho = rp * (1 + ec) / (1 + ec * Math.cos(phi)); return [rho * Math.cos(phi), rho * Math.sin(phi)]; };   // (x toward the periapsis, y across)
  const run = (p0, p1) => { const out = []; for (let p = p0; ; ) { const q = loc(p); out.push(q); if (p >= p1) break; const q2 = loc(Math.min(p1, p + 1e-3)), ds = Math.hypot(q2[0] - q[0], q2[1] - q[1]) / 1e-3; p = Math.min(p1, p + Math.min(.05, 3 / Math.max(ds, 1e-3))); } return out; };   // ~3 mm steps
  const R = on ? [run(ph0, Math.PI)] : [...(ph0 ? [run(ph0, phB)] : []), ...(nc ? [run(phB, phE)] : []), run(phE, phEnd)];
  const dro = () => coastArc(M, m.rho, thP, droTip(maps.thM, thP, M.dir));
  if (el) {   // a pass: its ride on its own ellipse, squeezed as its ring (el.s: the same curve); then the passes from its periapsis (LEO,
    // or raised: wider), each side squeezed as much more as keeps them off its rail (sR; the ride and they meet square to the line, at
    // the periapsis: tangent whatever the squeeze), straight on eased from the one to the other over the first half of its rise; its periapsis never eased behind Earth
    const sq = el.F.sq, bx = maps.room || HYB.room, ride = i => !on && i === 0 && ph0 > 0;
    const fitY = ([x, y]) => { const b0 = o[1] + x * u[1], dd = y * v[1]; return dd > 1e-9 ? Math.max(0, bx.y1 - b0) / dd : dd < -1e-9 ? Math.min(0, bx.y0 - b0) / dd : Infinity; };   // (the most squeeze that keeps it off the rail)
    const sR = [0, 1].map(k => { let s = sq[k]; R.forEach((g, i) => { if (!ride(i)) for (const p of g) if ((k ? -p[1] : p[1]) > 1) s = Math.min(s, fitY(p)); }); return Math.max(.2, s); });
    const runs = R.map((g, i) => g.map(([x, y], j) => { const k = y > 0 ? 0 : 1, w = ride(i) ? 0 : on ? S(2 * (wrap(Math.atan2(y, x)) - ph0) / (Math.PI - ph0)) : 1; return T([x, (el.s[k] + (sR[k] - el.s[k]) * w) * y]); })), end = runs.at(-1);
    end[end.length - 1] = E.xy(rho2, maps.thM);   // (on the Earth-Moon line exactly)
    const kinds = on ? ['et'] : [...(ph0 ? [nc ? 'gt' : 'et'] : []), ...(nc ? ['gt'] : []), 'et'];   // (its ride in the next pass's colour)
    return { ...N, lead: [], path: [...runs, dro()], kinds: [...kinds, 'et'], sq, how: on ? 'on' : 'passes' };
  }
  // a circular start (LEO, GEO): the frame (above) onto the table: W eases x in behind Earth so the periapsis lands on Xt (x / (1 + c x)
  // from Earth: C1 there, and the gentlest; Oct 26, eased from the Seldon's own x it folded a tilted pair's loops; easing y with it drew
  // the loops' ends as points), and squeezes y by s = [y > 0 side, y < 0 side].
  // The coast: its own orbit prograde from the Seldon to the periapsis, on that ring while the ring stays in the room, then onto W's
  // (smoothstep over CB rad, done by Ax, where the ring leaves the room; Oct 26, it had left the ring at the piece: a GEO coast ran 90 mm
  // inside GEO); a ring that leaves within CB of the Seldon: the Seldon's offset from W's ring fades out over CB instead (mx between
  // the two). A short coast's blend is begun before the Seldon only as far as keeps its start under the base (Oct 26: the whole offset
  // in a few mm turned it 80 degrees)
  const bx = maps.room || HYB.room, lim = [[bx.x0, bx.x1], [bx.y0, bx.y1]];
  const out = q => Math.max(lim[0][0] - q[0], q[0] - lim[0][1], lim[1][0] - q[1], q[1] - lim[1][1]);   // mm outside the room (< 0: inside)
  const P = E.xy(e.rho, e.th), pc = E.xy(e.seen ?? e.rho, e.th), al = e.th - thP, d = sweepTo(e.th, thP, 1), n = Math.max(2, Math.ceil(d * rp / 1.5)), CB = 1.2, tolP = Math.max(0, out(P));
  const loc0 = Array.from({ length: n + 1 }, (_, j) => j === n ? [rp, 0] : [rp * Math.cos(al + d * j / n), rp * Math.sin(al + d * j / n)]), ring = loc0.map(T);
  const tol = j => .25 + tolP * Math.max(0, 1 - d * j / n / CB);   // (a Seldon outside the room: its first stretch no worse than it)
  const jx = ring.findIndex((q, j) => out(q) > tol(j)), Ax = jx < 0 ? d : d * jx / n, A1 = Math.max(Ax, Math.min(d, CB)), mx = S(2 * Ax / CB - 1), side = p => p[1] > 0 ? 0 : 1, i0 = side(loc0[0]);
  // Xt: the room behind Earth along the line (then less what still pokes out: a tilted line, the loops' sides near the periapsis), never
  // inside LEO (Oct 26: from LEO with Earth by the table's end the first burn went in under the Earth piece; its loops spill as before)
  const Xm = Math.max(40, E.rho(R_LEO));
  let Xt = Math.max(Xm, Math.min(...[0, 1].map(k => u[k] > 1e-9 ? (lim[k][1] - o[k]) / u[k] : u[k] < -1e-9 ? (lim[k][0] - o[k]) / u[k] : Infinity)) - 2);
  const build = Xt => {
    const c = rp > Xt ? 1 / Xt - 1 / rp : 0, fx = x => x > 0 ? x / (1 + c * x) : x;
    const W = ([x, y], s) => T([fx(x), (y > 0 ? s[0] : s[1]) * y]);
    const fit = ([x, y]) => Math.min(...[0, 1].map(k => { const b = o[k] + fx(x) * u[k], dd = y * v[k]; return b < lim[k][0] || b > lim[k][1] ? Infinity : dd > 1e-9 ? (lim[k][1] - b) / dd : dd < -1e-9 ? (lim[k][0] - b) / dd : Infinity; }));   // (a point whose foot on the line is out already, Xt floored at LEO: no squeeze brings it in)
    const base = p => Math.max(0, out(T([fx(p[0]), 0])));
    let g, sc, L = CB;
    const coastOf = s => { const w0 = W(loc0[0], s); return loc0.map((p, j) => { const w = W(p, s), r = ring[j], k = 1 - g[j]; return [0, 1].map(q => w[q] + ((r[q] - w[q]) * mx + (P[q] - w0[q]) * (1 - mx)) * k); }); };
    const sideOk = i => coastOf(sc).every((q, j) => Math.abs(loc0[j][1]) < 1e-9 || side(loc0[j]) !== i || out(q) <= tol(j) + base(loc0[j]));
    for (;;) {   // the blend's length, and the coast's own squeeze for it (a Seldon by where its ring leaves the room: shorter, so it starts on it)
      g = loc0.map((_, j) => S((d * j / n - A1 + L) / L)); sc = [1, 1];
      for (const i of [i0, 1 - i0]) if (!sideOk(i)) { let lo = .1, hi = 1; for (let k = 0; k < 18; k++) { sc[i] = (lo + hi) / 2; if (sideOk(i)) lo = sc[i]; else hi = sc[i]; } sc[i] = lo; }
      const q = coastOf(sc)[0]; if (L <= A1 + 1e-6 || Math.hypot(q[0] - pc[0], q[1] - pc[1]) <= 16) break; L = Math.max(A1, L * .7);
    }
    // the passes: each side squeezed across the line by one factor, to wMax at most and to the room
    const sq = [1, -1].map(sg => { let s = Math.min(1, HYB.wMax / Math.sqrt(rp * rho2)); for (const seg of R) for (const p of seg) if (p[1] * sg > 1) s = Math.min(s, fit(p)); return Math.max(.2, s); });   // (from LEO at 970 mm apart, centred: none; .2: a line 80 mm from a rail, from GEO)
    const runs = R.map(seg => seg.map(p => W(p, sq))), cst = coastOf(sc);
    const worst = Math.max(...runs.flat().slice(0, -1).map(out), ...(nc ? [] : cst.map((q, j) => out(q) - tol(j) + .25)));
    return { runs, cst, worst, sq };
  };
  let B = build(Xt);
  for (let i = 0; i < 4 && B.worst > .5 && Xt > Xm; i++) B = build(Xt = Math.max(Xm, Xt - B.worst - 1));
  const elec = B.runs.at(-1); elec[elec.length - 1] = E.xy(rho2, maps.thM);   // (on the Earth-Moon line exactly)
  const path = [...(nc ? [B.runs[0]] : d > 1e-3 ? [B.cst] : []), elec, dro()];
  return { ...N, lead: nc ? B.cst : [], path, kinds: path.map((_, i) => nc && i === 0 ? 'gt' : 'et'), sq: B.sq };
}

// ---- the reach view (owner, Oct 26: "show the importance of having high delta v - using our figures") ----
// What one full tank (vehicle.js: 160 kg on the 200 kg dry mass) reaches from a circular orbit r0 (km), for our electric engine and
// for a chemical one on the same tank: dv (km/s, the tank's), the band of circular Earth orbits it can get to [lo, hi] (km; hi Infinity:
// all of them out from r0), and whether the DRO is in reach. Electric: the coplanar low-thrust cost |v(r0) - v(r)| (as every ET figure
// here). Chemical: the cheaper of a Hohmann transfer and the bi-parabolic one (out to escape, (sqrt 2 - 1) v(r0), and back in to r,
// (sqrt 2 - 1) v(r)); that cost rises out to 11.94 r0 (where the two cross, 0.534 v(r0)) and then falls back toward the escape burn,
// so below that peak the band ends where the cost meets the tank (Oct 26, Isp 435 s / 235 kg: "can escape" had read as "reaches every
// orbit out", GEO included, at 3.31 km/s against GEO's 3.85). Never below LEO. The DRO: lunarDv's estimates from r0 (a pure-engine
// comparison; the mission's own profile mixes the two). An ellipse (onPass) reads as the circular orbit of the same energy.
const BIPARA = 11.94;                                             // r / r0 past which the bi-parabolic transfer beats the Hohmann
// reachCost(r0, r, k): the DELTA-V (km/s) from circular r0 to circular r for engine k ('et' / 'gt') as reach() counts it (the gradient's value)
export function reachCost(r0, r, k) {
  const v0 = vc(MU_E, r0), v = vc(MU_E, r); if (k === 'et') return Math.abs(v0 - v);
  const h = hoh(MU_E, r0, r);
  return Math.min(Math.abs(h.v1t - v0) + Math.abs(v - h.v2t), (Math.SQRT2 - 1) * (v0 + v));
}
// veh (the presenter's sliders, Oct 26): { isp: { et, gt } (s), tank (kg of propellant) }, the dry mass vehicle.js's; else vehicle.js's
export function reach(r0, rDro = V.DRO_KM, veh = null) {
  const mu = MU_E, v0 = vc(mu, r0), [ET, GT] = PROP_MODES, tank = veh?.tank ?? V.SELDON.prop, dvOf = (pm, k) => G0 * (veh?.isp?.[k] ?? pm.isp) * Math.log((V.SELDON.dry + tank) / V.SELDON.dry) / 1000;
  const bis = (f, lo, hi) => { for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (f(m)) lo = m; else hi = m; } return lo; };   // the last m where f holds, f true at lo
  const L = V.lunarDv(r0, rDro), out = {}, cG = r => reachCost(r0, r, 'gt');
  { const dv = dvOf(ET, 'et'); out.et = { dv, lo: Math.max(R_LEO, mu / (v0 + dv) ** 2), hi: dv >= v0 ? Infinity : mu / (v0 - dv) ** 2, dro: L.et <= dv }; }
  { const dv = dvOf(GT, 'gt'), lo = r0 <= R_LEO || cG(R_LEO) <= dv ? R_LEO : 1 / bis(u => cG(1 / u) <= dv, 1 / r0, 1 / R_LEO);
    out.gt = { dv, lo, hi: dv >= cG(BIPARA * r0) ? Infinity : bis(r => cG(r) <= dv, r0, BIPARA * r0), dro: L.gt <= dv }; }
  out.isp = { et: veh?.isp?.et ?? ET.isp, gt: veh?.isp?.gt ?? GT.isp }; out.tank = tank;
  return out;
}

// Seldon-1 (a) -> Seldon-2 (b). Returns numbers for both propulsion modes and the drawn paths (arrays of [x, y] mm):
// lead (Seldon-1 coasting to the first burn; may be empty) and path (first burn -> Seldon-2's orbit, in segments);
// Earth -> Moon also the hybrid profile (hy, as hybrid()).
export function transfer(maps, a, b) {
  if (a.prim === b.prim && Math.abs(a.r - b.r) / Math.max(a.r, b.r) < .0015) return null;
  const legs = a.prim + b.prim, Mo = moonBody(maps), { E, M } = maps;
  const shape = kind => {
    if (legs === 'EE' || legs === 'MM') return sameBody(a.B, a, b, kind);
    if (legs === 'EM') { const L = lunarLegs(maps, a, b, 1, kind); return { lead: L.lead, path: L.path }; }
    const L = lunarLegs(maps, b, a, -1, kind), path = L.path.map(seg => seg.slice().reverse()).reverse();   // DRO -> Earth: the mirror trip reversed; Seldon-1 rides its DRO to the departure point
    if (L.thE != null) path.push(coastArc(E, b.rho, L.thE, E.dir * (L.tipE ?? tipOn(E, b, L.thE))));   // and the TIP past where it joins Seldon-2's orbit
    return { lead: coastArc(M, a.rho, a.th, sweepTo(a.th, L.thDro, M.dir)), path };
  };
  let gt, et;
  if (legs === 'EE' || legs === 'MM') {
    const B = a.B, h = hoh(B.mu, a.r, b.r), tw = waitFor(a.n, a.th, b.n, b.th, h.tof);
    gt = { dv: Math.abs(h.v1t - vc(B.mu, a.r)) + Math.abs(vc(B.mu, b.r) - h.v2t), wait: tw, tof: h.tof };
    et = { dv: Math.abs(vc(B.mu, a.r) - vc(B.mu, b.r)) };
    if (a.ell) {   // from a pass (onPass: P x Q) to a circular orbit R2 (LEO TO DRO, GEO picked: numbers only, modes.js): chemical, a burn at the
      // apsis on R2's near side puts the other on R2, then one there makes it circular; electric, from the circular orbit of the same energy
      const rp = a.ell.rpK ?? R_LEO, Q = a.ell.Q, R2 = b.r, w = (r, s) => Math.sqrt(MU_E * (2 / r - 2 / s)), lo = Q <= R2;   // w: speed at r on the ellipse whose apsides sum to s
      gt = { dv: lo ? w(rp, rp + R2) - w(rp, rp + Q) + vc(MU_E, R2) - w(R2, rp + R2) : Math.abs(w(Q, R2 + Q) - w(Q, rp + Q)) + Math.abs(w(R2, R2 + Q) - vc(MU_E, R2)), wait: 0, tof: Math.PI * Math.sqrt(((lo ? rp : Q) + R2) ** 3 / 8 / MU_E) };   // (abs: a periapsis raised past GEO comes down to it)
      et = { dv: Math.abs(Math.sqrt(2 * MU_E / (rp + Q)) - vc(MU_E, R2)) };
    }
  } else if (legs === 'EM') {   // Earth orbit -> Hohmann out to the Moon's distance -> captured into Seldon-2's lunar orbit
    const h = hoh(MU_E, a.r, D_EM), L = V.lunarDv(a.r, b.r), tw = waitFor(a.n, a.th, Mo.n, Mo.th, h.tof);   // vehicle.js: shared with COMPETITOR
    gt = { dv: L.gt, wait: tw, tof: h.tof };
    et = { dv: L.et };
  } else {                      // lunar orbit -> escape -> Hohmann from the Moon's distance to Seldon-2's Earth orbit
    const h = hoh(MU_E, D_EM, b.r), vinf = Math.abs(h.v1t - vc(MU_E, D_EM));
    gt = { dv: hypBurn(MU_M, a.r, vinf) + Math.abs(vc(MU_E, b.r) - h.v2t), wait: 0, tof: h.tof };
    et = { dv: (vc(MU_M, a.r) - vc(MU_M, R_SOI)) + Math.abs(vc(MU_E, D_EM) - vc(MU_E, b.r)) };
  }
  Object.assign(gt, shape('gt')); Object.assign(et, shape('et'));
  const [ET, GT] = PROP_MODES;
  gt.mp = propFor(GT, gt.dv); gt.t = Math.max(gt.wait + gt.tof, V.pulseTime(gt.dv));   // (our chemical thruster's burns, 25 m/s every 12 h: vehicle.js)
  et.mp = propFor(ET, et.dv); et.t = burnTime(ET, et.mp);
  return { legs, gt, et, hy: legs === 'EM' ? hybrid(maps, a, b) : null };   // hy: the LEO TO DRO profile (chemical, then electric)
}
