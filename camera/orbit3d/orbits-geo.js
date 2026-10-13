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
import * as V from './vehicle.js';                              // the one set of vehicle numbers (all modes)
export const VEH = { dry: V.SELDON.dry, prop: V.SELDON.prop };
export const PROP_MODES = [
  { id: 'ET', name: 'ELECTRIC', isp: V.SELDON.isp, thrust: V.SELDON.thrust, how: 'low-thrust spiral, engine on the whole way' },
  { id: 'GT', name: 'CHEMICAL', isp: V.TUG.isp, how: 'two burns (Hohmann transfer)' },
];

export function makeMaps(earth = LAYOUT.earth, moon = LAYOUT.moon, S = SCALE) {
  const [ex, ey] = earth, Dmm = moon ? Math.hypot(moon[0] - ex, moon[1] - ey) : null;
  if (S.true) {
    const offE = FIG.E, offM = FIG.M;
    const k = Math.max(MIN_SPAN, (Dmm || S.noMoonMm) - offE) / (D_EM - R_E);  // mm per km of altitude, everywhere
    const lin = (cx, cy, mu, R, off) => withXY({ cx, cy, mu, R, off, rho: r => off + (r - R) * k, r: rho => R + (rho - off) / k });
    const thM = moon ? Math.atan2(-(moon[1] - ey), moon[0] - ex) : 0;
    return { E: lin(ex, ey, MU_E, R_E, offE), M: moon && droStretch(lin(moon[0], moon[1], MU_M, R_M, offM), thM), Dmm, zone: moon ? offM + (R_SOI - R_M) * k : 0, k, true: true, thM };
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
export const GEO_VIEW = { leoMm: 78, geoMm: 250 };
export function makeGeoMaps(earth, S = GEO_VIEW) {
  const [ex, ey] = earth, a = S.leoMm, kk = (S.geoMm - a) / (R_GEO - R_LEO);
  const E = withXY({ cx: ex, cy: ey, mu: MU_E, R: R_E, rho: r => r >= R_LEO ? a + (r - R_LEO) * kk : a * r / R_LEO, r: rho => rho >= a ? R_LEO + (rho - a) / kk : rho / a * R_LEO });
  return { E, M: null, Dmm: null, zone: 0, k: kk, thM: 0 };
}
// true scale: one linear mm-per-km for everything, the Earth-Moon distance (mm) sets it; nothing is enlarged. noZone: no Moon zone (geo)
export function makeTrueMaps(earth, moon, S = {}) {
  const [ex, ey] = earth, Dmm = Math.hypot(moon[0] - ex, moon[1] - ey), k = Dmm / D_EM, thM = Math.atan2(-(moon[1] - ey), moon[0] - ex);
  const lin = (cx, cy, mu, R) => withXY({ cx, cy, mu, R, off: 0, rho: r => r * k, r: rho => rho / k });
  return { E: lin(ex, ey, MU_E, R_E), M: droStretch(lin(moon[0], moon[1], MU_M, R_M), thM), Dmm, zone: S.noZone ? 0 : R_SOI * k, k, thM, scaleTrue: true };
}
// GEO lock: a body within `band` mm (drawn) of the GEO ring snaps onto it; once locked it holds until 1.4 x band away
export function lockGeo(maps, b, was, band) {
  if (b.prim !== 'E') return b;
  const rg = maps.E.rho(R_GEO);
  return Math.abs(b.rho - rg) < band * (was ? 1.4 : 1) ? { ...b, r: R_GEO, rho: rg, n: Math.sqrt(MU_E / R_GEO ** 3), locked: true } : b;
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
// above, and in the Earth-Moon frame stretched across the Earth-Moon line (along the Moon's motion) by 1 + r / (r + DRO_A0),
// r the size in km: near-circular close in, about 4:3 at the edge of the zone, as data/mission_dro.json's DRO
// (68,000 x 89,000 km). Everything about the Moon is drawn in this stretched frame, so its transfers bend the same way.
export const DRO_A0 = 136000;
function droStretch(M, thM) {
  const ax = [Math.cos(thM), -Math.sin(thM)], pp = [-Math.sin(thM), -Math.cos(thM)];   // table axes: Earth -> Moon, and the Moon's motion
  const asp = rho => { const r = Math.max(0, M.r(rho)); return 1 + r / (r + DRO_A0); };
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
export const burnTime = (pm, mp) => V.burnTime(mp, pm);
export const dvMax = pm => V.dvMax({ ...V.SELDON, isp: pm.isp });   // km/s a full tank gives

// a body on the table -> its orbit. Inside the Moon zone it orbits the Moon.
export function bodyAt(maps, x, y) {
  const { E, M } = maps, dm = M ? Math.hypot(x - M.cx, y - M.cy) : Infinity, de = Math.hypot(x - E.cx, y - E.cy);
  // the Moon's only if inside its zone, nearer the Moon, and not touching the Earth figure (a close Moon's zone can reach Earth)
  const touchE = de < FIG.E + FIG.S + 2, B = dm < maps.zone && dm < de && !touchE ? M : E, prim = B === M ? 'M' : 'E', { rho, th } = B.inv(x, y), floor = B.R + FLOOR_ALT[prim];
  if (maps.true) {
    const r = Math.max(floor, B.r(rho));
    return { prim, B, rho: Math.max(B.off, rho), th, r, n: Math.sqrt(B.mu / r ** 3), dir: B.dir };
  }
  const r = Math.max(floor, B.r(rho));
  return { prim, B, rho: B.rho(r), th, r, n: Math.sqrt(B.mu / r ** 3), dir: B.dir };
}
export function moonBody(maps) { const r = D_EM; return { prim: 'E', B: maps.E, rho: maps.Dmm, th: maps.thM, r, n: Math.sqrt(MU_E / r ** 3), dir: 1 }; }
// a body's whole orbit (ring) and its position at angle th, as table points
export const orbitPts = (b, n = 256) => Array.from({ length: n + 1 }, (_, i) => b.B.xy(b.rho, i / n * TAU));
export const orbitXY = (b, th) => b.B.xy(b.rho, th);

const pt = (B, r, th) => B.xy(B.rho(r), th);
// half a transfer ellipse about B from angle th0 (radius r1) to th0 + pi (radius r2)
// sweep: drawn angle covered (pi = the true half ellipse; other values stretch the same shape, still tangent at both ends)
function hohArc(B, r1, r2, th0, n = 160, sweep = Math.PI) {
  const up = r2 > r1, e = Math.abs(r2 - r1) / (r1 + r2), p = (r1 + r2) / 2 * (1 - e * e), out = [];
  n = Math.max(n, Math.ceil(n * sweep / Math.PI));
  for (let j = 0; j <= n; j++) { const f = j / n, nu = (up ? 0 : Math.PI) + Math.PI * f; out.push(pt(B, p / (1 + e * Math.cos(nu)), th0 + sweep * f)); }
  return out;
}
// low-thrust spiral about B from r1 to r2, sweeping dth (exactly; ends exactly at r2). Schematic: evenly spaced loops
// (drawn radius grows as t^SPIRAL.q along the sweep, q a little over 1 so it leaves the start orbit gently), with only
// as many turns as it takes to read the direction. Not the physical v^4 spiral, which bunches every turn against the
// start orbit and then runs straight (user, Oct 9: spirals more consistent, not all right next to Earth; going off the
// table is fine). Smooth by construction (no inflections). Inward spirals are built outward and reversed.
export const SPIRAL = { q: 1.25 };
function spiral(B, r1, r2, th0, dth, n0 = 4000) {
  const rho1 = B.rho(r1), rho2 = B.rho(r2);
  if (rho2 < rho1) return spiral(B, r2, r1, th0 + dth, -dth, n0).reverse();
  const T = Math.abs(dth), sg = Math.sign(dth) || 1, D = rho2 - rho1, q = SPIRAL.q, out = [];
  for (let t = 0; ; ) {
    const rho = rho1 + D * t ** q, th = th0 + sg * T * t;
    out.push(B.xy(rho, th));
    if (t >= 1) break;
    const ds = Math.hypot(D * q * Math.max(t, 1e-6) ** (q - 1), rho * T) * (B.asp ? B.asp(rho) : 1);   // mm of path per unit t
    t = Math.min(1, t + Math.min(1 / n0, 1.5 / ds));                      // steps of at most 1.5 mm
  }
  out[out.length - 1] = pt(B, r2, th0 + dth);
  return out;
}
// Earth-centred paths stop at the Moon zone: clipEnd cuts a path where it first enters it, clipStart drops the part
// before it last leaves it
const inZone = (maps, p) => Math.hypot(p[0] - maps.M.cx, p[1] - maps.M.cy) < maps.zone;
// the exact zone-edge point on segment p (outside) -> q (inside), by bisection
function edgePt(maps, p, q) {
  let lo = 0, hi = 1;
  for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (inZone(maps, [p[0] + (q[0] - p[0]) * m, p[1] + (q[1] - p[1]) * m])) hi = m; else lo = m; }
  return [p[0] + (q[0] - p[0]) * hi, p[1] + (q[1] - p[1]) * hi];
}
function clipEnd(maps, path) { const k = path.findIndex(p => inZone(maps, p)); return k <= 0 ? path : [...path.slice(0, k), edgePt(maps, path[k - 1], path[k])]; }
function clipStart(maps, path) { let k = -1; path.forEach((p, i) => { if (inZone(maps, p)) k = i; }); return k < 0 || k >= path.length - 1 ? path : [edgePt(maps, path[k + 1], path[k]), ...path.slice(k + 1)]; }
// arrival curve inside the Moon zone: from a zone-edge point P0, travelling along dir0, onto body b's orbit (rEnd) at
// angle thEnd, turning sg (+1 anticlockwise, -1 clockwise) in the Moon's DRO frame, meeting the orbit tangentially.
// Angle linear, radius a cubic whose start slope matches dir0 when dir0 already turns that way (else fillet rounds it).
function zoneCurve(maps, P0, dir0, rEnd, thEnd, sg, n = 160) {
  const { M } = maps, q0 = M.inv(P0[0], P0[1]), rho0 = q0.rho, phi0 = q0.th, rho1 = M.rho(rEnd);
  const rx = P0[0] - M.cx, ry = -(P0[1] - M.cy), rr = Math.hypot(rx, ry) || 1, dx = dir0[0], dy = -dir0[1];
  const vr = (dx * rx + dy * ry) / rr, vt = (-dx * ry + dy * rx) / rr;   // radial / anticlockwise parts of dir0 (math axes)
  let d = sweepTo(phi0, thEnd, sg);
  if (Math.abs(d) < Math.PI / 2) d += sg * TAU;
  const want = sg * vt > 1e-6 ? vr / Math.abs(vt) * rho0 * Math.abs(d) : -3 * (rho0 - rho1);
  const s0 = Math.abs(rho1 - rho0) < 1e-6 ? 0 : Math.max(0, Math.min(3, want / (rho1 - rho0)));
  const out = [];
  for (let j = 0; j <= n; j++) {
    const f = j / n, g = s0 * (f - 2 * f * f + f ** 3) + (3 * f * f - 2 * f ** 3);
    out.push(M.xy(rho0 + (rho1 - rho0) * g, phi0 + d * f));
  }
  return out;
}
const dirAt = (path, end) => { const n = path.length, p = end ? path[n - 1] : path[0], q = end ? path[n - 2] : path[1], l = Math.hypot(p[0] - q[0], p[1] - q[1]) || 1; return end ? [(p[0] - q[0]) / l, (p[1] - q[1]) / l] : [(q[0] - p[0]) / l, (q[1] - p[1]) / l]; };

// round the corner where segment A ends and segment B starts: trim each by `trim` mm and bridge with a cubic Bezier
// that leaves A and joins B along their own directions (no visible corner at a patched-conic hand-over)
// the handover between two legs: the shortest blend (from 70 mm each side, longer as needed) whose tightest bend is no
// sharper than FILLET_BEND (rad per 3 mm, about the inner spiral loops), so it never shows as a corner (Oct 9)
const FILLET_BEND = .13;
function fillet(A, B) {
  let best = null;
  for (const trim of [70, 100, 140, 190, 250]) {
    const r = filletAt(A, B, trim), j = r[0].length - 1;
    const bend = maxBend([...r[0].slice(Math.max(0, j - 200)), ...r[1].slice(0, 200)]);
    if (!best || bend < best.bend) best = { r, bend };
    if (bend <= FILLET_BEND) break;
  }
  return best.r;
}
function maxBend(pts) {                                       // largest heading change over 3 mm of path (rad)
  const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const at = sv => { let i = cum.findIndex(c => c >= sv); if (i <= 0) i = 1; const u = (sv - cum[i - 1]) / Math.max(1e-9, cum[i] - cum[i - 1]); return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * u, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * u]; };
  let worst = 0, prev = null;
  for (let sv = 0; sv + 3 <= cum.at(-1); sv += 3) { const p = at(sv), q = at(sv + 3), h = Math.atan2(q[1] - p[1], q[0] - p[0]); if (prev !== null) worst = Math.max(worst, Math.abs(Math.atan2(Math.sin(h - prev), Math.cos(h - prev)))); prev = h; }
  return worst;
}
function filletAt(A, B, trim, n = 80) {
  const back = (P, fromEnd) => {   // index and point `trim` mm from one end
    let acc = 0;
    for (let k = 1; k < P.length; k++) {
      const i = fromEnd ? P.length - 1 - k : k, j = fromEnd ? i + 1 : i - 1;
      acc += Math.hypot(P[i][0] - P[j][0], P[i][1] - P[j][1]);
      if (acc >= trim) return i;
    }
    return fromEnd ? 0 : P.length - 1;
  };
  const ia = Math.max(1, back(A, true)), ib = Math.min(B.length - 2, back(B, false));
  const a0 = A[ia], b0 = B[ib], ta = dirAt(A.slice(0, ia + 1), true), tb = dirAt(B.slice(ib), false);
  const L = Math.hypot(b0[0] - a0[0], b0[1] - a0[1]) * .4, c1 = [a0[0] + ta[0] * L, a0[1] + ta[1] * L], c2 = [b0[0] - tb[0] * L, b0[1] - tb[1] * L];
  const bz = [];
  for (let j = 1; j < n; j++) { const t = j / n, u = 1 - t; bz.push([0, 1].map(q => u * u * u * a0[q] + 3 * u * u * t * c1[q] + 3 * u * t * t * c2[q] + t * t * t * b0[q])); }
  return [[...A.slice(0, ia + 1), ...bz, b0], B.slice(ib)];
}

// ---- transfer shapes (drawn mm, in a body's frame; s = turning sense, +1 anticlockwise) ----
const sweepTo = (from, to, s) => s > 0 ? wrap(to - from) : -wrap(from - to);   // angle from `from` to `to`, going the s way
// along a circular orbit of drawn radius rho from angle th0 through the signed angle d (a coast, or waiting for the burn point)
function coastArc(B, rho, th0, d) {
  const n = Math.min(4000, Math.max(2, Math.ceil(Math.abs(d) * rho * (B.asp ? B.asp(rho) : 1) / 1.5)));
  return Array.from({ length: n + 1 }, (_, j) => B.xy(rho, th0 + d * j / n));
}
// Thrust near periapsis raises the far side: from a circular orbit rho1, with the periapsis toward thP, each turn's
// apoapsis is higher, and the periapsis stays put. Sweeps s * (2 pi N + pi) and ends at apoapsis rho2 (toward thP + pi).
// ET (steps = false): the apoapsis grows a little every turn; GT (steps = true): N whole ellipses, one per burn, then the
// last half. Apoapsis progress goes as (fraction of the climb)^RAISE_Q.
// Then (periRaise) thrust near apoapsis raises the periapsis, apoapsis held at rho2, until the orbit is circular there.
const RAISE_Q = 1.3;
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
  const apo = phi => rho1 + (rho2 - rho1) * (steps ? ((Math.min(N, Math.floor(phi / TAU)) + 1) / (N + 1)) : phi / PHI) ** RAISE_Q;
  return conicRun(B, PHI, s, thP, phi => { const A = apo(phi), e = (A - rho1) / (A + rho1); return rho1 * (1 + e) / (1 + e * Math.cos(phi)); });
}
function periRaise(B, rho1, rho2, thA, s, N) {
  const PSI = TAU * N;
  return conicRun(B, PSI, s, thA, psi => { const P = rho1 + (rho2 - rho1) * (psi / PSI) ** RAISE_Q, e = (rho2 - P) / (rho2 + P); return rho2 * (1 - e) / (1 - e * Math.cos(psi)); });
}
// how many turns: ET winds more than GT; GT is a plain Hohmann for short climbs, a few burns (Chandrayaan-style) for long ones
export const LOOPS = { etMm: 120, etMax: 6, gtMm: 350, gtMax: 2 };
const loopsFor = (kind, span) => kind === 'gt' ? Math.max(0, Math.min(LOOPS.gtMax, Math.floor(span / LOOPS.gtMm))) : Math.max(1, Math.min(LOOPS.etMax, Math.round(span / LOOPS.etMm)));
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
// Realistic ends (user, Oct 12): a transfer starts at its first burn and ends where it joins Seldon-2's orbit; meeting
// Seldon-2 itself would be a separate phasing step. Where the first burn is not at Seldon-1, a coast (`lead`) shows
// Seldon-1 riding its own orbit to it. Within one body the first burn is at Seldon-1 itself: a raise starts there; a
// lowering is a raise that ends at Seldon-1, built the other way round and reversed.
function sameBody(B, a, b, kind) {
  if (b.rho >= a.rho) return { lead: [], path: [climb(B, a.rho, a.th, b.rho, B.dir, kind)] };
  const s = -B.dir, th1 = a.th - s * climbPlan(kind, a.rho - b.rho).sweep;
  return { lead: [], path: [climb(B, b.rho, th1, a.rho, s, kind).reverse()] };
}
// Earth orbit e <-> DRO m. Built outward (s = +1: Earth -> Moon); s = -1 builds the mirror image, which reversed is the
// trip back. From the periapsis opposite the Moon, apoapsis-raising loops lined up with the Moon, the last apoapsis at
// the Moon. Where they enter the Moon zone (its Earth side, already heading the DRO's way) a capture curve joins m's DRO:
// a retrograde spiral for ET (1.25 turns), one curve for GT (half a turn). Returns the Earth-side coast from e to the
// periapsis, the path, and the angle where it meets the DRO.
function lunarLegs(maps, e, m, s, kind) {
  const { E, M } = maps, thP = maps.thM + Math.PI, N = loopsFor(kind, maps.Dmm - e.rho), sm = M.dir * s;
  const earth = clipEnd(maps, apoRaise(E, e.rho, maps.Dmm, thP, s, N, kind === 'gt'));
  const P0 = earth[earth.length - 1], q0 = M.inv(P0[0], P0[1]);
  const thDro = q0.th + sm * (kind === 'gt' ? Math.PI : TAU * 1.25);
  const moon = kind === 'gt' ? zoneCurve(maps, P0, dirAt(earth, true), m.r, thDro, sm) : spiral(M, M.r(q0.rho), m.r, q0.th, thDro - q0.th);
  return { lead: coastArc(E, e.rho, e.th, sweepTo(e.th, thP, s)), path: fillet(earth, moon), thDro };
}

// Seldon-1 (a) -> Seldon-2 (b). Returns numbers for both propulsion modes and the drawn paths (arrays of [x, y] mm):
// lead (Seldon-1 coasting to the first burn; may be empty) and path (first burn -> Seldon-2's orbit, in segments).
export function transfer(maps, a, b) {
  if (a.prim === b.prim && Math.abs(a.r - b.r) / Math.max(a.r, b.r) < .0015) return null;
  const legs = a.prim + b.prim, Mo = moonBody(maps), { E, M } = maps;
  const shape = kind => {
    if (legs === 'EE' || legs === 'MM') return sameBody(a.B, a, b, kind);
    if (legs === 'EM') { const L = lunarLegs(maps, a, b, 1, kind); return { lead: L.lead, path: L.path }; }
    const L = lunarLegs(maps, b, a, -1, kind);   // DRO -> Earth: the mirror trip reversed; Seldon-1 rides its DRO to the departure point
    return { lead: coastArc(M, a.rho, a.th, sweepTo(a.th, L.thDro, M.dir)), path: L.path.map(seg => seg.slice().reverse()).reverse() };
  };
  let gt, et;
  if (legs === 'EE' || legs === 'MM') {
    const B = a.B, h = hoh(B.mu, a.r, b.r), tw = waitFor(a.n, a.th, b.n, b.th, h.tof);
    gt = { dv: Math.abs(h.v1t - vc(B.mu, a.r)) + Math.abs(vc(B.mu, b.r) - h.v2t), wait: tw, tof: h.tof };
    et = { dv: Math.abs(vc(B.mu, a.r) - vc(B.mu, b.r)) };
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
  gt.mp = propFor(GT, gt.dv); gt.t = gt.wait + gt.tof;
  et.mp = propFor(ET, et.dv); et.t = burnTime(ET, et.mp);
  return { legs, gt, et };
}
// spirals still used for ET's capture into the DRO (the Moon's frame)
