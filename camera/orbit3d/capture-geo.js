// capture-geo.js — maths for the CAPTURE / DEFEND and COMPETITOR modes (no DOM; checked by tools/test_capture_geo.mjs).
// Two-body (Earth) coplanar orbits, counter-clockwise, impulsive burns. Lengths km, times s, angles rad (ccw, y up).
import * as V from './vehicle.js';   // one set of vehicle numbers for every mode
export const MU =398600.4418, R_E = 6378.1, R_LEO = R_E + 400, R_GEO = 42164, L_KM = 384400, G0 = 9.80665;
const TAU = Math.PI * 2;
export const wrap = a => { a %= TAU; return a < 0 ? a + TAU : a; };

// One table scale for both modes: distance from the Earth piece (mm) <-> orbit radius (km). Logarithmic so LEO, GEO and the
// Moon's distance all fit; "not to scale". LEO ring 70 mm (clear of the 66 mm Earth base), GEO 280 mm, Moon distance 320 mm.
export const RHO = { leo: 70, geo: 265, far: 300 };
export const rhoOfR = r => r <= R_GEO
  ? RHO.leo + (RHO.geo - RHO.leo) * Math.log(Math.max(r, R_LEO) / R_LEO) / Math.log(R_GEO / R_LEO)
  : RHO.geo + (RHO.far - RHO.geo) * Math.log(Math.min(r, L_KM) / R_GEO) / Math.log(L_KM / R_GEO);
export const rOfRho = q => q <= RHO.geo
  ? R_LEO * Math.exp((Math.max(q, RHO.leo) - RHO.leo) / (RHO.geo - RHO.leo) * Math.log(R_GEO / R_LEO))
  : R_GEO * Math.exp((Math.min(q, RHO.far) - RHO.geo) / (RHO.far - RHO.geo) * Math.log(L_KM / R_GEO));

export function hohmann(r1, r2) {
  const a = (r1 + r2) / 2, v1 = Math.sqrt(MU / r1), v2 = Math.sqrt(MU / r2);
  const dv1 = Math.sqrt(MU * (2 / r1 - 1 / a)) - v1, dv2 = v2 - Math.sqrt(MU * (2 / r2 - 1 / a));   // signed: + = prograde
  return { a, dv1, dv2, total: Math.abs(dv1) + Math.abs(dv2), tof: Math.PI * Math.sqrt(a ** 3 / MU) };
}

// ---- Kepler propagation (analytic, so any time is exact and burns are just element changes)
function elems(r, v, t0) {
  const rm = Math.hypot(r[0], r[1]), v2 = v[0] * v[0] + v[1] * v[1], rv = r[0] * v[0] + r[1] * v[1];
  const a = 1 / (2 / rm - v2 / MU);
  const ex = ((v2 - MU / rm) * r[0] - rv * v[0]) / MU, ey = ((v2 - MU / rm) * r[1] - rv * v[1]) / MU, e = Math.hypot(ex, ey);
  const w = e < 1e-10 ? Math.atan2(r[1], r[0]) : Math.atan2(ey, ex), nu = Math.atan2(r[1], r[0]) - w;
  const E = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu / 2), Math.sqrt(1 + e) * Math.cos(nu / 2));
  return { a, e, w, n: Math.sqrt(MU / (a * a * a)), M0: E - e * Math.sin(E), t0 };
}
export function stateOf(el, t) {
  const e = el.e, M = el.M0 + el.n * (t - el.t0);
  let E = M + e * Math.sin(M);
  for (let i = 0; i < 40; i++) { const d = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E)); E -= d; if (Math.abs(d) < 1e-12) break; }
  const cE = Math.cos(E), sE = Math.sin(E), b = Math.sqrt(1 - e * e), k = 1 - e * cE, c = Math.cos(el.w), s = Math.sin(el.w);
  const x = el.a * (cE - e), y = el.a * b * sE, vx = -el.a * el.n * sE / k, vy = el.a * el.n * b * cE / k;
  return { r: [x * c - y * s, x * s + y * c], v: [vx * c - vy * s, vx * s + vy * c] };
}
const circular = (r0, th) => { const v = Math.sqrt(MU / r0); return elems([r0 * Math.cos(th), r0 * Math.sin(th)], [-v * Math.sin(th), v * Math.cos(th)], 0); };
export const craftAt = (c, t) => { let s = c.segs[0]; for (const q of c.segs) if (q.t0 <= t + 1e-9) s = q; return stateOf(s.el, t); };
function burn(c, t, dv) {
  const st = craftAt(c, t), sp = Math.hypot(st.v[0], st.v[1]), k = (sp + dv) / sp;
  c.segs.push({ t0: t, el: elems(st.r, [st.v[0] * k, st.v[1] * k], t) });
}
export function hohmannCraft(r1, r2, th) {              // a craft that starts on a circle at angle th and flies the Hohmann transfer
  const h = hohmann(r1, r2), c = { segs: [{ t0: 0, el: circular(r1, th) }] };
  burn(c, 0, h.dv1); burn(c, h.tof, h.dv2); return { c, h };
}
export const apsides = el => [el.a * (1 - el.e), el.a * (1 + el.e)];

// ---- CAPTURE / DEFEND plan.
// o: { r1, r2 (km), th1, th2 (rad), same (bool: one shared orbit, else a transfer), dir ('auto'|'up'|'down'), defend (bool) }
// Chaser = Seldon-1, target = Seldon-2. Same orbit: the chaser burns into a phasing orbit that is lower (shorter period, it gains on
// a target ahead of it) or higher (longer period, the target comes round to it), flies N turns, and burns back at the same point
// the moment the target arrives there. Different orbits: wait for the window, Hohmann transfer, arrive with the target.
// Defend: part-way the target makes a small prograde burn (a few m/s to a few hundred) that changes its period, so it is
// no longer at the rendezvous point when the chaser gets there.
export function plan(o) {
  const P = { same: !!o.same, defend: !!o.defend, burns: [], events: [], phases: [] };
  let ch, tg, Ttot, tBurn1 = 0;
  const th1 = o.th1;
  if (P.same) {
    const r0 = (o.r1 + o.r2) / 2, n0 = Math.sqrt(MU / r0 ** 3), T0 = TAU / n0, v0 = Math.sqrt(MU / r0);
    const phi = Math.max(.08, Math.min(TAU - .08, wrap(o.th2 - th1)));            // how far the target is ahead of the chaser
    let dir = o.dir; if (dir !== 'up' && dir !== 'down') dir = phi <= Math.PI ? 'down' : 'up';
    const frac = dir === 'down' ? phi / TAU : (TAU - phi) / TAU;
    const xmax = dir === 'down' ? Math.min(.2, 1 - Math.pow((1 + (R_E + 150) / r0) / 2, 1.5)) : .2;   // fractional period change: keep the low point above the air, and the ellipse tame
    let N = 1; while (frac / N > xmax && N < 16) N++;
    const x = frac / N, Tp = T0 * (dir === 'down' ? 1 - x : 1 + x), ap = Math.cbrt(MU * (Tp / TAU) ** 2);
    const dv1 = Math.sqrt(MU * (2 / r0 - 1 / ap)) - v0, ta = N * Tp;
    ch = { segs: [{ t0: 0, el: circular(r0, th1) }] }; tg = { segs: [{ t0: 0, el: circular(r0, th1 + phi) }] };
    burn(ch, 0, dv1); burn(ch, ta, -dv1);
    Object.assign(P, { kind: 'phasing', dir, N, Tp, T0, r0, rc: r0, phi, revs: N, ap, dv1, dv2: -dv1, tof: ta });
    P.burns.push({ who: 'ch', t: 0, dv: dv1, name: 'BURN 1' }, { who: 'ch', t: ta, dv: -dv1, name: 'BURN 2' });
    Ttot = ta; P.phases = [{ t0: 0, t1: ta }];
    P.events.push({ t: 0, label: 'BURN 1' }, { t: .03 * ta, label: 'PHASING ORBIT' }, { t: .97 * ta, label: 'BURN 2' });
  } else {
    const { r1, r2 } = o, n1 = Math.sqrt(MU / r1 ** 3), n2 = Math.sqrt(MU / r2 ** 3), h = hohmann(r1, r2);
    const rhs = wrap(o.th2 - th1 + n2 * h.tof - Math.PI), dn = n1 - n2;
    const tw = Math.abs(dn) < 1e-12 ? 0 : dn > 0 ? rhs / dn : (rhs - TAU) / dn;         // wait for the window
    ch = { segs: [{ t0: 0, el: circular(r1, th1) }] }; tg = { segs: [{ t0: 0, el: circular(r2, o.th2) }] };
    burn(ch, tw, h.dv1); burn(ch, tw + h.tof, h.dv2);
    Ttot = tw + h.tof; tBurn1 = tw;
    Object.assign(P, { kind: 'transfer', dir: r2 > r1 ? 'up' : 'down', r1, r2, rc: r2, tw, tof: h.tof, dv1: h.dv1, dv2: h.dv2, r0: r1, N: 1 });
    P.burns.push({ who: 'ch', t: tw, dv: h.dv1, name: 'BURN 1' }, { who: 'ch', t: Ttot, dv: h.dv2, name: 'BURN 2' });
    P.phases = tw > 1 ? [{ t0: 0, t1: tw }, { t0: tw, t1: Ttot }] : [{ t0: 0, t1: Ttot }];
    if (tw > 1) P.events.push({ t: 0, label: 'COAST TO WINDOW' });
    P.events.push({ t: tw, label: 'BURN 1' }, { t: tw + .04 * h.tof, label: 'TRANSFER ORBIT' }, { t: tw + .96 * h.tof, label: 'BURN 2' });
  }
  // the target's evasion
  if (P.defend) {
    const rT = P.same ? P.r0 : P.r2, nT = Math.sqrt(MU / rT ** 3), vT = Math.sqrt(MU / rT);
    const te = tBurn1 + .5 * (Ttot - tBurn1), dtr = Ttot - te;
    const d = Math.min(.1, 1.5 / (3 * nT * dtr)), dvE = vT * d;                        // d = dv/v: a quarter-turn-plus of phase by the time the chaser arrives
    burn(tg, te, dvE);
    P.te = te; P.dvE = dvE; P.burns.push({ who: 'tg', t: te, dv: dvE, name: 'EVADE' });
    P.events.push({ t: te, label: 'TARGET EVADES' });
  }
  P.events.sort((a, b) => a.t - b.t);
  P.ch = ch; P.tg = tg; P.Ttot = Ttot;
  const a = craftAt(ch, Ttot).r, b = craftAt(tg, Ttot).r;
  P.sepEnd = Math.hypot(a[0] - b[0], a[1] - b[1]);
  P.dvCh = Math.abs(P.dv1) + Math.abs(P.dv2); P.dvTg = P.dvE || 0;
  let m = 1e18; for (let i = 0; i <= 400; i++) { const t = Ttot * i / 400, p = craftAt(ch, t).r, q = craftAt(tg, t).r; m = Math.min(m, Math.hypot(p[0] - q[0], p[1] - q[1])); }
  P.closest = m;
  // screen shape of the radius: plain log scale for transfers; for one shared orbit the radial differences (a few % of the radius)
  // are exaggerated about the orbit so the phasing orbit reads (dev: mm of screen offset wanted at the extreme)
  P.rho = r => rhoOfR(r);
  if (P.same) {
    const segs = [...ch.segs, ...tg.segs]; let ext = 0;
    for (const s of segs) for (const r of apsides(s.el)) ext = Math.max(ext, Math.abs(r - P.rc));
    const rhoC = rhoOfR(P.rc), k = (rhoOfR(P.rc * 1.001) - rhoOfR(P.rc * .999)) / (P.rc * .002);   // mm per km here
    const dev = Math.max(16, .1 * rhoC), G = Math.max(1, Math.min(400, dev / (k * Math.max(ext, 1))));
    P.gain = G; P.rho = r => rhoC + G * k * (r - P.rc);
  }
  return P;
}
// animation time (0..1) -> simulation time: each phase gets a share of the animation (a long wait for the window does not eat it)
export function simTime(P, u) {
  u = Math.max(0, Math.min(1, u)); const ph = P.phases;
  if (ph.length === 1) return u * P.Ttot;
  const sh = ph.map(p => Math.max(.25, Math.min(.75, (p.t1 - p.t0) / P.Ttot))), S = sh.reduce((a, b) => a + b, 0);
  let acc = 0;
  for (let i = 0; i < ph.length; i++) { const w = sh[i] / S; if (u <= acc + w || i === ph.length - 1) return ph[i].t0 + (ph[i].t1 - ph[i].t0) * Math.min(1, (u - acc) / w); acc += w; }
  return P.Ttot;
}

// ---- COMPETITOR: the same trip, an electric spiral against an impulsive chemical transfer
// Vehicle numbers: vehicle.js (shared with LEO TO GEO / LEO TO DRO). preset 'dro' targets the table's default DRO (V.DRO_KM).
export function compare(rT, preset) {
  const r0 = R_LEO, v0 = Math.sqrt(MU / r0), v1 = Math.sqrt(MU / rT);
  let us, them;
  if (preset === 'dro') { const L = V.lunarDv(r0, V.DRO_KM); us = { dv: L.et }; them = { dv: L.gt, time: L.gtTof }; }
  else { const h = hohmann(r0, rT); us = { dv: Math.abs(v0 - v1) }; them = { dv: h.total, time: h.tof }; }
  us.prop = V.propFor(V.SELDON.isp, us.dv); them.prop = V.propFor(V.TUG.isp, them.dv);
  us.time = V.burnTime(us.prop);                                                       // s: that propellant at the engine's mass flow
  return { us, them, saved: them.prop - us.prop, ratio: them.prop / us.prop };
}
