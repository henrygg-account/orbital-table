// orbits-geo.js — geometry and transfer maths for the ORBITS (kiosk) view. No DOM, no three.js, so node can test it
// (tools/test_orbits_geo.mjs). Table coordinates are mm, origin top-left, y down; angles are CCW with y up
// (th = atan2(-(y - cy), x - cx)), so prograde motion runs CCW as seen from above.
//
// Earth and the Moon are wherever their pieces are. Default (SCALE.true): altitude is to scale, measured from the
// figures' edges (the figures are bigger than scale), with the scale set so the Moon piece sits at the Moon's true
// altitude; GEO is then always the same true fraction of the way out, above LEO. Directions are true. Within the Moon
// zone (its sphere of influence, r_SOI = D (mu_M / mu_E)^0.4) everything is Moon-centred: patched conics, a Seldon
// there orbits the Moon. (The ET / GT transfer maths below is kept but not shown at the moment.)

export const MU_E = 398600.4418, MU_M = 4902.8, R_E = 6378.1, R_M = 1737.4, D_EM = 384400, G0 = 9.80665;
export const R_SOI = D_EM * (MU_M / MU_E) ** .4;             // 66,180 km
const TAU = Math.PI * 2;
const wrap = a => { a %= TAU; return a < 0 ? a + TAU : a; };

export const R_LEO = R_E + 400, R_GEO = 42164;
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
export const VEH = { dry: 200, prop: 160 };                   // kg: dry mass + propellant (full tank)
export const PROP_MODES = [
  { id: 'ET', name: 'ELECTRIC', isp: 1000, thrust: .05, how: 'low-thrust spiral, engine on the whole way' },
  { id: 'GT', name: 'CHEMICAL', isp: 425, thrust: 100, how: 'two burns (Hohmann transfer)' },
];

export function makeMaps(earth = LAYOUT.earth, moon = LAYOUT.moon, S = SCALE) {
  const [ex, ey] = earth, Dmm = moon ? Math.hypot(moon[0] - ex, moon[1] - ey) : null;
  if (S.true) {
    const offE = FIG.E, offM = FIG.M;
    const k = Math.max(MIN_SPAN, (Dmm || S.noMoonMm) - offE) / (D_EM - R_E);  // mm per km of altitude, everywhere
    const lin = (cx, cy, mu, R, off) => ({ cx, cy, mu, R, off, rho: r => off + (r - R) * k, r: rho => R + (rho - off) / k });
    return { E: lin(ex, ey, MU_E, R_E, offE), M: moon && lin(moon[0], moon[1], MU_M, R_M, offM), Dmm, zone: moon ? offM + (R_SOI - R_M) * k : 0, k, true: true,
      thM: moon ? Math.atan2(-(moon[1] - ey), moon[0] - ex) : 0 };
  }
  const k = Math.min(S.leoMm / R_LEO, Dmm ? S.geoShare * Dmm / R_GEO : Infinity), rhoG = k * R_GEO;   // mm per km inside GEO
  const far = Dmm && Dmm > rhoG;
  const E = { cx: ex, cy: ey, mu: MU_E, R: R_E,
    rho: r => r <= R_GEO || !far ? k * r : rhoG + (Dmm - rhoG) * Math.pow((r - R_GEO) / (D_EM - R_GEO), S.p),
    r: rho => rho <= rhoG || !far ? rho / k : R_GEO + (D_EM - R_GEO) * Math.pow((rho - rhoG) / (Dmm - rhoG), 1 / S.p) };
  const zone = moon ? Math.max(80, Math.min(S.zone, far ? (Dmm - rhoG) * .7 : 80)) : 0, altS = R_SOI - R_M;
  const M = moon && { cx: moon[0], cy: moon[1], mu: MU_M, R: R_M,
    rho: r => S.aM + (zone - S.aM) * Math.pow(Math.max(0, r - R_M) / altS, S.pM),
    r: rho => R_M + altS * Math.pow(Math.max(0, rho - S.aM) / (zone - S.aM), 1 / S.pM) };
  return { E, M, Dmm, zone, k, thM: moon ? Math.atan2(-(moon[1] - ey), moon[0] - ex) : 0 };
}

const vc = (mu, r) => Math.sqrt(mu / r);
const hoh = (mu, r1, r2) => { const a = (r1 + r2) / 2; return { a, v1t: Math.sqrt(mu * (2 / r1 - 1 / a)), v2t: Math.sqrt(mu * (2 / r2 - 1 / a)), tof: Math.PI * Math.sqrt(a ** 3 / mu) }; };
const hypBurn = (mu, r, vinf) => Math.sqrt(vinf * vinf + 2 * mu / r) - vc(mu, r);   // circular orbit at r <-> hyperbolic with v_inf
// time to wait until body 2 leads body 1 by the angle a transfer of duration tof needs
const waitFor = (n1, th1, n2, th2, tof) => { const dn = n2 - n1; if (Math.abs(dn) < 1e-12) return 0; const d = wrap(Math.PI - n2 * tof - (th2 - th1)); return d < 1e-9 ? 0 : dn > 0 ? d / dn : (d - TAU) / dn; };
export const propFor = (pm, dvKms) => (VEH.dry + VEH.prop) * (1 - Math.exp(-dvKms * 1000 / (G0 * pm.isp)));
export const burnTime = (pm, mp) => mp / (pm.thrust / (G0 * pm.isp));
export const dvMax = pm => G0 * pm.isp * Math.log((VEH.dry + VEH.prop) / VEH.dry) / 1000;   // km/s a full tank gives

// a body on the table -> its orbit. Inside the Moon zone it orbits the Moon.
export function bodyAt(maps, x, y) {
  const { E, M } = maps, dm = M ? Math.hypot(x - M.cx, y - M.cy) : Infinity, de = Math.hypot(x - E.cx, y - E.cy);
  // the Moon's only if inside its zone, nearer the Moon, and not touching the Earth figure (a close Moon's zone can reach Earth)
  const touchE = de < FIG.E + FIG.S + 2, B = dm < maps.zone && dm < de && !touchE ? M : E, prim = B === M ? 'M' : 'E', rho = Math.hypot(x - B.cx, y - B.cy), floor = B.R + FLOOR_ALT[prim];
  if (maps.true) {
    const r = Math.max(floor, B.r(rho));
    return { prim, B, rho: Math.max(B.off, rho), th: Math.atan2(-(y - B.cy), x - B.cx), r, n: Math.sqrt(B.mu / r ** 3) };
  }
  const r = Math.max(floor, B.r(rho));
  return { prim, B, rho: B.rho(r), th: Math.atan2(-(y - B.cy), x - B.cx), r, n: Math.sqrt(B.mu / r ** 3) };
}
export function moonBody(maps) { const r = D_EM; return { prim: 'E', B: maps.E, rho: maps.Dmm, th: maps.thM, r, n: Math.sqrt(MU_E / r ** 3) }; }

const pt = (B, r, th) => [B.cx + B.rho(r) * Math.cos(th), B.cy - B.rho(r) * Math.sin(th)];
// half a transfer ellipse about B from angle th0 (radius r1) to th0 + pi (radius r2)
function hohArc(B, r1, r2, th0, n = 160) {
  const up = r2 > r1, e = Math.abs(r2 - r1) / (r1 + r2), p = (r1 + r2) / 2 * (1 - e * e), out = [];
  for (let j = 0; j <= n; j++) { const f = j / n, nu = (up ? 0 : Math.PI) + Math.PI * f; out.push(pt(B, p / (1 + e * Math.cos(nu)), th0 + Math.PI * f)); }
  return out;
}
// low-thrust spiral about B from r1 to r2, sweeping dth: the angle goes as v^4 (constant tangential thrust, so most of
// the turning happens deep in the well, as on the real spiral), plus a fixed SPIRAL_TWIST (rad) spread evenly over the
// drawn radius, so the far end still curves instead of running dead straight into a corner. The total sweep stays dth.
const SPIRAL_TWIST = .5;
function spiral(B, r1, r2, th0, dth, n = 2400) {
  const v1 = vc(B.mu, r1) ** 4, v2 = vc(B.mu, r2) ** 4, tw = Math.sign(dth) * Math.min(SPIRAL_TWIST, Math.abs(dth) / 2), out = [];
  for (let j = 0; j <= n; j++) {
    const f = j / n, v4 = v1 - f * (v1 - v2), r = B.mu / Math.sqrt(v4);
    const lin = (B.rho(r) - B.rho(r1)) / (B.rho(r2) - B.rho(r1));        // progress in drawn radius
    out.push(pt(B, r, th0 + (dth - tw) * f + tw * lin));
  }
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
// approach (or departure) curve inside the Moon zone between a zone-edge point P0 and a point on a lunar orbit at
// angle thEnd. It leaves P0 in the direction dir0 (the path's own direction there, so no corner)
// and meets the orbit tangentially. Polar form about the Moon: angle linear, radius a cubic with the matching start slope.
function zoneCurve(maps, P0, dir0, rEnd, thEnd, reverse = false, n = 160) {
  const { M } = maps, rx = P0[0] - M.cx, ry = -(P0[1] - M.cy), rho0 = Math.hypot(rx, ry), phi0 = Math.atan2(ry, rx), rho1 = M.rho(rEnd);
  const dx = dir0[0], dy = -dir0[1], vr = (dx * rx + dy * ry) / rho0, vt = (-dx * ry + dy * rx) / rho0;   // radial / CCW parts of dir0 (math axes)
  // turn the way the path is already going about the Moon (no corner at P0); the curve meets the orbit tangentially
  const ccw = vt >= -1e-6;
  let d = ccw ? wrap(thEnd - phi0) : -wrap(phi0 - thEnd);
  if (Math.abs(d) < Math.PI / 2) d += ccw ? TAU : -TAU;
  // slope of rho vs f at the start so that d(rho)/(rho d phi) = vr / vt
  const want = Math.abs(vt) > 1e-6 ? vr / Math.abs(vt) * rho0 * Math.abs(d) : -3 * (rho0 - rho1);
  const s0 = Math.max(0, Math.min(3, want / (rho1 - rho0)));
  const out = [];
  for (let j = 0; j <= n; j++) {
    const f = j / n, g = s0 * (f - 2 * f * f + f ** 3) + (3 * f * f - 2 * f ** 3), rho = rho0 + (rho1 - rho0) * g, a = phi0 + d * f;
    out.push([M.cx + rho * Math.cos(a), M.cy - rho * Math.sin(a)]);
  }
  return reverse ? out.reverse() : out;
}
const dirAt = (path, end) => { const n = path.length, p = end ? path[n - 1] : path[0], q = end ? path[n - 2] : path[1], l = Math.hypot(p[0] - q[0], p[1] - q[1]) || 1; return end ? [(p[0] - q[0]) / l, (p[1] - q[1]) / l] : [(q[0] - p[0]) / l, (q[1] - p[1]) / l]; };

// round the corner where segment A ends and segment B starts: trim each by `trim` mm and bridge with a cubic Bezier
// that leaves A and joins B along their own directions (no visible corner at a patched-conic hand-over)
function fillet(A, B, trim = 28, n = 40) {
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

// Seldon-1 (a) -> Seldon-2 (b). Returns numbers for both propulsion modes and the drawn paths (arrays of [x, y] mm).
export function transfer(maps, a, b) {
  if (a.prim === b.prim && Math.abs(a.r - b.r) / Math.max(a.r, b.r) < .0015) return null;
  const legs = a.prim + b.prim, Mo = moonBody(maps), { E, M } = maps;
  let gt, et;
  if (legs === 'EE' || legs === 'MM') {
    const B = a.B, h = hoh(B.mu, a.r, b.r), tw = waitFor(a.n, a.th, b.n, b.th, h.tof);
    // drawn as if the burn is timed to arrive exactly where Seldon-2 is: Seldon-1 coasts on its orbit to b.th - pi, then fires
    gt = { dv: Math.abs(h.v1t - vc(B.mu, a.r)) + Math.abs(vc(B.mu, b.r) - h.v2t), wait: tw, tof: h.tof, path: [hohArc(B, a.r, b.r, b.th - Math.PI)] };
    const revs = burnTime(PROP_MODES[0], propFor(PROP_MODES[0], Math.abs(vc(B.mu, a.r) - vc(B.mu, b.r)))) * Math.sqrt(B.mu / ((a.r + b.r) / 2) ** 3) / TAU;
    const K = Math.max(1, Math.min(3, Math.round(revs)));
    et = { dv: Math.abs(vc(B.mu, a.r) - vc(B.mu, b.r)), path: [spiral(B, a.r, b.r, a.th, wrap(b.th - a.th) + TAU * K)] };
  } else if (legs === 'EM') {   // Earth orbit -> Hohmann out to the Moon's distance -> captured into Seldon-2's lunar orbit
    const h = hoh(MU_E, a.r, D_EM), vinf = Math.abs(vc(MU_E, D_EM) - h.v2t), tw = waitFor(a.n, a.th, Mo.n, Mo.th, h.tof);
    // drawn so it arrives at the Moon piece (it leaves when the Moon is that far behind; the wait covers that)
    const arc = clipEnd(maps, hohArc(E, a.r, D_EM, maps.thM - Math.PI));
    gt = { dv: Math.abs(h.v1t - vc(MU_E, a.r)) + hypBurn(MU_M, b.r, vinf), wait: tw, tof: h.tof, path: [arc, zoneCurve(maps, arc[arc.length - 1], dirAt(arc, true), b.r, b.th)] };
    // the spiral meets the Moon zone at its bottom edge (screen-down of the Moon), where it blends into an
    // anticlockwise capture spiral; it leaves for Earth from the top edge (see ME)
    const eg = zoneGate(maps, -1), sp = clipEnd(maps, spiral(E, a.r, eg.r, a.th, wrap(eg.th - a.th) + TAU * 3));
    et = { dv: Math.abs(vc(MU_E, a.r) - vc(MU_E, D_EM)) + (vc(MU_M, b.r) - vc(MU_M, R_SOI)), path: [sp, moonSpiralIn(maps, sp[sp.length - 1], b)] };
  } else {                      // lunar orbit -> escape -> Hohmann from the Moon's distance to Seldon-2's Earth orbit
    // timed burns (the cheapest case): Hohmann from the Moon's distance down to Seldon-2's orbit, arriving opposite the
    // Moon, then drawn following Seldon-2's orbit round to Seldon-2 (no extra delta-v: only the timing changes)
    const h = hoh(MU_E, D_EM, b.r), vinf = Math.abs(h.v1t - vc(MU_E, D_EM)), th2 = maps.thM + Math.PI, coast = [];
    for (let j = 1, d = wrap(b.th - th2), n = Math.max(2, Math.ceil(d * 40)); j <= n; j++) coast.push(pt(E, b.r, th2 + d * j / n));
    const arc = clipStart(maps, [...hohArc(E, D_EM, b.r, maps.thM), ...coast]);   // drop the part inside the Moon zone
    gt = { dv: hypBurn(MU_M, a.r, vinf) + Math.abs(vc(MU_E, b.r) - h.v2t), wait: 0, tof: h.tof, path: [zoneCurve(maps, arc[0], dirAt(arc, false).map(v => -v), a.r, a.th, true), arc] };
    // built outward from b turning backwards, then reversed: it runs Moon -> b prograde and lands exactly on b
    const eg = zoneGate(maps, 1), spE = clipStart(maps, spiral(E, b.r, eg.r, b.th, -(wrap(b.th - eg.th) + TAU * 3)).reverse());
    et = { dv: (vc(MU_M, a.r) - vc(MU_M, R_SOI)) + Math.abs(vc(MU_E, D_EM) - vc(MU_E, b.r)), path: [moonSpiralOut(maps, spE[0], a), spE] };
  }
  for (const r of [gt, et]) if (r.path.length === 2) r.path = fillet(r.path[0], r.path[1]);
  const [ET, GT] = PROP_MODES;
  gt.mp = propFor(GT, gt.dv); gt.t = gt.wait + gt.tof;
  et.mp = propFor(ET, et.dv); et.t = burnTime(ET, et.mp);
  return { legs, gt, et };
}
// the Earth-centred (r, th) of the Moon zone's top (side = 1) or bottom (side = -1) edge point
function zoneGate(maps, side) { const rho = Math.hypot(maps.Dmm, maps.zone); return { r: maps.E.r(rho), th: maps.thM + side * Math.atan2(maps.zone, maps.Dmm) }; }
// spirals inside the Moon zone (two schematic turns): in from a zone-edge point to body b (ending on it), or out
// from body a to a zone-edge point (built inward from the edge turning backwards, then reversed, so it starts on a)
const angAt = (M, P) => Math.atan2(-(P[1] - M.cy), P[0] - M.cx);
function moonSpiralIn(maps, P0, b) { const phi0 = angAt(maps.M, P0); return spiral(maps.M, R_SOI, b.r, phi0, wrap(b.th - phi0) + TAU * 2); }
function moonSpiralOut(maps, P1, a) { const phi1 = angAt(maps.M, P1); return spiral(maps.M, R_SOI, a.r, phi1, -(wrap(phi1 - a.th) + TAU * 2)).reverse(); }
