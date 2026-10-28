// node tools/test_orbits_geo.mjs [out.json] — numbers + on-screen check for the orbits view's standard cases
import * as G from '../orbits-geo.js';
import * as V from '../vehicle.js';
import { writeFileSync } from 'node:fs';
const SW = 1428.5, SH = 803.5, MARG = 24, PANEL_TOP = SH - MARG - 95;   // panels occupy the bottom ~95 mm at the corners
const maps = G.makeMaps(G.LAYOUT.earth, G.LAYOUT.moon);
const at = (B, r, deg) => { const t = deg * Math.PI / 180, rho = B.rho(r); return [B.cx + rho * Math.cos(t), B.cy - rho * Math.sin(t)]; };
const cases = {
  'LEO -> LLO': [at(maps.E, G.R_E + 400, 135), at(maps.M, G.R_M + 100, 90)],
  'LLO -> LEO': [at(maps.M, G.R_M + 100, 90), at(maps.E, G.R_E + 400, 135)],
  'LEO -> GEO': [at(maps.E, G.R_E + 400, 135), at(maps.E, 42164, 60)],
};
const fmtT = s => s > 2 * 86400 ? (s / 86400).toFixed(1) + ' d' : (s / 3600).toFixed(1) + ' h';
const out = { maps: { E: [maps.E.cx, maps.E.cy], M: [maps.M.cx, maps.M.cy], zone: maps.zone, Dmm: maps.Dmm }, cases: {} };
for (const D of [740, 600, 450, 300]) { const m = G.makeMaps([360, 370], [360 + D, 370]); console.log(`Moon ${D} mm away: LEO ${m.E.rho(G.R_LEO).toFixed(1)} mm, GEO ${m.E.rho(G.R_GEO).toFixed(1)} mm (ratio ${(m.E.rho(G.R_GEO) / m.E.rho(G.R_LEO)).toFixed(2)}, true ${(G.R_GEO / G.R_LEO).toFixed(2)}), zone ${m.zone.toFixed(0)} mm, Moon lands at ${m.E.rho(G.D_EM).toFixed(1)} mm, inverse check ${(m.E.r(m.E.rho(200000)) - 200000).toFixed(3)} km`); }
console.log(`LEO ring ${maps.E.rho(G.R_E + 400).toFixed(0)} mm, GEO ${maps.E.rho(42164).toFixed(0)} mm, Moon ${maps.Dmm.toFixed(0)} mm, LLO ${maps.M.rho(G.R_M + 100).toFixed(0)} mm, zone ${maps.zone} mm; tank gives ET ${G.dvMax(G.PROP_MODES[0]).toFixed(2)} km/s, GT ${G.dvMax(G.PROP_MODES[1]).toFixed(2)} km/s`);
for (const [name, [p1, p2]] of Object.entries(cases)) {
  const a = G.bodyAt(maps, ...p1), b = G.bodyAt(maps, ...p2), X = G.transfer(maps, a, b);
  console.log(`\n${name}: Seldon-1 ${a.prim} r=${a.r.toFixed(0)} km (alt ${(a.r - (a.prim === 'M' ? G.R_M : G.R_E)).toFixed(0)}), Seldon-2 ${b.prim} r=${b.r.toFixed(0)} km (alt ${(b.r - (b.prim === 'M' ? G.R_M : G.R_E)).toFixed(0)})`);
  for (const k of ['gt', 'et']) {
    const r = X[k], pts = [...r.lead, ...r.path.flat()], xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    const off = pts.filter(p => p[0] < MARG || p[0] > SW - MARG || p[1] < MARG || p[1] > SH - MARG).length;
    const underPanels = pts.filter(p => p[1] > PANEL_TOP && (p[0] < MARG + 300 || p[0] > SW - MARG - 88 - 300)).length;
    const gaps = r.path.slice(1).map((seg, i) => Math.hypot(seg[0][0] - r.path[i].at(-1)[0], seg[0][1] - r.path[i].at(-1)[1]).toFixed(2));
    console.log(`  ${k.toUpperCase()} dv ${r.dv.toFixed(3)} km/s  time ${fmtT(r.t)}${r.wait ? ` (wait ${fmtT(r.wait)} + transfer ${fmtT(r.tof)})` : ''}  propellant ${r.mp.toFixed(1)} kg${r.mp > G.VEH.prop ? ' OVER TANK' : ''}`);
    console.log(`     path bbox x ${box[0].toFixed(0)}..${box[2].toFixed(0)} y ${box[1].toFixed(0)}..${box[3].toFixed(0)}; off-screen pts ${off}; under panels ${underPanels}; joins ${gaps.join(', ') || '-'} mm`);
  }
  out.cases[name] = { p1, p2, a: { rho: a.rho, prim: a.prim }, b: { rho: b.rho, prim: b.prim }, gt: X.gt.path, et: X.et.path };
}
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(out));

// ---- pass/fail checks for the edge-measured true scale (exit code 1 on failure) ----
let fails = 0;
const check = (ok, msg) => { if (!ok) { fails++; console.log('FAIL', msg); } };
for (let D = 53; D <= 1300; D += 7) for (const ang of [0, 1, 2.5, 4]) {
  const e = [600, 400], mo = [e[0] + D * Math.cos(ang), e[1] - D * Math.sin(ang)], m = G.makeMaps(e, mo);
  const leo = m.E.rho(G.R_LEO), geo = m.E.rho(G.R_GEO);
  check(geo > leo && leo > G.FIG.E, `D ${D}: GEO ${geo} > LEO ${leo} > Earth figure ${G.FIG.E}`);
  check(Math.abs(m.E.r(m.E.rho(123456)) - 123456) < 1e-6, `D ${D}: Earth map inverse`);
  check(Math.abs(leo - G.FIG.E - 400 * m.k) < 1e-9, `D ${D}: LEO hugs the Earth figure's edge`);
  for (const a of [0, 1.3, 3.1, 4.4]) {   // a Seldon touching Earth, every direction: orbits Earth at FIG.S / k above the edge (floor 400 km)
    const b = G.bodyAt(m, e[0] + (G.FIG.E + G.FIG.S) * Math.cos(a), e[1] - (G.FIG.E + G.FIG.S) * Math.sin(a));
    check(b.prim === 'E' && Math.abs(b.r - G.R_E - Math.max(400, G.FIG.S / m.k)) < 1, `D ${D} ang ${ang}: Seldon touching Earth at ${a} reads ${b.prim} alt ${Math.round(b.r - G.R_E)}`);
    for (const k of ['r', 'n', 'rho']) check(Number.isFinite(b[k]) && b[k] > 0, `D ${D}: finite ${k}`);
  }
  if (D >= 120) {   // a Seldon touching the Moon on its far side orbits the Moon at FIG.S / k above the edge (floor 100 km)
    const ux = (mo[0] - e[0]) / D, uy = (mo[1] - e[1]) / D, d = G.FIG.M + G.FIG.S, b = G.bodyAt(m, mo[0] + ux * d, mo[1] + uy * d);
    check(b.prim === 'M' && Math.abs(b.r - G.R_M - Math.max(100, G.FIG.S / m.k)) < 1, `D ${D}: Seldon touching the Moon reads ${b.prim} alt ${Math.round(b.r - (b.prim === 'M' ? G.R_M : G.R_E))}`);
  }
}
// no gap: altitude rises continuously from the figure edge
{ const m = G.makeMaps(); let prev = 0; for (let d = G.FIG.E; d < 200; d += .5) { const b = G.bodyAt(m, m.E.cx + d, m.E.cy), alt = b.r - G.R_E; check(alt >= prev && alt - prev < 600, `continuous altitude at ${d} mm (${prev} -> ${alt})`); prev = alt; } }
// every GT and ET path starts exactly on Seldon-1 (coast, then first burn) and ends on Seldon-2's orbit, for every pair of bodies and many angles
{ const m = G.makeMaps(), atp = (B, r, d) => { const t = d * Math.PI / 180, rho = B.rho(r); return [B.cx + rho * Math.cos(t), B.cy - rho * Math.sin(t)]; };
  for (const [n, B1, r1, B2, r2] of [['EE', m.E, G.R_LEO, m.E, G.R_GEO], ['MM', m.M, G.R_M + 100, m.M, G.R_M + 20000], ['EM', m.E, G.R_LEO, m.M, G.R_M + 100], ['ME', m.M, G.R_M + 100, m.E, G.R_GEO]])
    for (let d1 = 0; d1 < 360; d1 += 45) for (let d2 = 0; d2 < 360; d2 += 15) {
      const q = atp(B2, r2, d2), a = G.bodyAt(m, ...atp(B1, r1, d1)), b = G.bodyAt(m, ...q);
      if (a.prim !== n[0] || b.prim !== n[1]) continue;
      const X = G.transfer(m, a, b);
      const p1 = atp(B1, r1, d1);
      for (const k of ['gt', 'et']) {
        const all = [...X[k].lead, ...X[k].path.flat()], s0 = all[0], e = all.at(-1), qe = b.B.inv(e[0], e[1]);
        check(Math.hypot(s0[0] - p1[0], s0[1] - p1[1]) < .5, `${n} ${k} ${d1}->${d2}: starts ${Math.hypot(s0[0] - p1[0], s0[1] - p1[1]).toFixed(1)} mm from Seldon-1`);
        check(Math.abs(qe.rho - b.rho) < .5, `${n} ${k} ${d1}->${d2}: ends ${Math.abs(qe.rho - b.rho).toFixed(1)} mm off Seldon-2's orbit`);
        if (X[k].lead.length) { const l = X[k].lead.at(-1), f = X[k].path[0][0]; check(Math.hypot(l[0] - f[0], l[1] - f[1]) < .5, `${n} ${k}: the coast meets the first burn`); }
      }
    } }
// LEO TO DRO with Earth and the Moon close: GEO stays gapMm outside LEO, the map rises all the way; closer still is `near` (Oct 25)
for (const D of [120, 150, 165, 189, 230, 300, 970]) {
  const m = G.makeMaps([200, 400], [200 + D, 400], { ...G.SCALE, view: G.DRO_VIEW }), l = m.E.rho(G.R_LEO), g = m.E.rho(G.R_GEO);
  let prev = 0, mono = true; for (let r = G.R_E; r < G.D_EM; r += 100) { const p = m.E.rho(r); mono &&= p >= prev - 1e-9; prev = p; }
  check(g - l >= G.DRO_VIEW.gapMm - 1e-9 && mono, `DRO view D ${D}: GEO ${g.toFixed(1)} vs LEO ${l.toFixed(1)} mm, monotonic ${mono}`);
  check(!!m.near === D < 160, `DRO view D ${D}: near ${m.near} (zone edge ${(D - m.zone).toFixed(0)} mm)`);
}
// locks: a locked ring stays under the piece (cap) whatever the band, and an unlocked one passes through its centre (a GEO view
// of any size: LEO TO GEO's own, 500 mm, since Oct 26, and the maths for smaller and larger ones). A piece inside LEO (100 mm since
// Oct 26, out from the Earth piece) is in LEO: the LEO ring
for (const geoMm of [200, 290, 500]) {
  const m = G.makeGeoMaps([700, 400], { leoMm: G.GEO_VIEW.leoMm, geoMm });
  for (let d = 66; d < geoMm + 100; d += 1) for (const was of [false, true]) for (const band of [10, 40, 120]) {   // (66: a Seldon touching Earth)
    const gl = G.lockGeo(m, G.bodyAt(m, 700 + d, 400), was, band, 30), b = gl.locked ? gl : G.lockLeo(m, gl, was, band * .6, 30);
    check(d < G.GEO_VIEW.leoMm ? b.leo && Math.abs(b.rho - G.GEO_VIEW.leoMm) < 1e-6 : Math.abs(d - b.rho) <= (b.locked || b.leo ? 30 : 1e-6), `GEO view ${geoMm}: piece ${d} mm band ${band}${was ? ' held' : ''}: ring at ${b.rho.toFixed(1)} mm`);
  }
}
// true scale: GEO locks from the piece a band inside the ring out to its drawn orbit a band outside it, and the reading
// only ever rises with the piece's distance; a DRO's period is the three-body one (Kepler's close in)
{ const m = G.makeTrueMaps([150, 400], [1238, 400], { noZone: true, foot: 36 }), rg = m.E.rho(G.R_GEO), at = d => G.bodyAt(m, 150 + d, 400), lk = (d, was = false) => G.lockGeo(m, at(d), was, 14, 30);
  const foot = rg + (rg - at(rg).rho);   // where a piece's own orbit is drawn on the GEO ring
  check(lk(rg - 13).locked && lk(foot).locked && lk(foot + 13).locked && !lk(rg - 15).locked && !lk(foot + 15).locked, `true scale: GEO lock from ${(rg - 14).toFixed(1)} (piece) to ${(foot + 14).toFixed(1)} mm (ring ${rg.toFixed(1)})`);
  for (const was of [false, true]) { let prev = 0, mono = true; for (let d = 60; d < 260; d += .5) { const r = lk(d, was).r; mono &&= r >= prev - 1e-6; prev = r; } check(mono, `true scale: the GEO reading rises with the piece's distance${was ? ' (held)' : ''}`); }
  check(Math.abs(G.droPeriod(36000) / 86400 - 5.88) < .01 && G.droPeriod(30000) < G.droPeriod(40000), `DRO period 36,000 km: ${(G.droPeriod(36000) / 86400).toFixed(2)} d`);
  const kep = r => 2 * Math.PI * Math.sqrt(r ** 3 / G.MU_M); check(Math.abs(G.droPeriod(1837) / kep(1837) - 1) < .05, `DRO period 1,837 km: ${(G.droPeriod(1837) / 3600).toFixed(2)} h (Kepler ${(kep(1837) / 3600).toFixed(2)} h)`); }
// LEO TO DRO, the trip back to a Seldon just beyond GEO (direct): a short curve on the table, its arrowhead clear of the piece
{ const m = G.makeMaps(G.LAYOUT.earth, G.LAYOUT.moon, { ...G.SCALE, view: G.DRO_VIEW }), q = [m.M.cx, m.M.cy - 60], a = G.lockDro(m, ...q, G.bodyAt(m, ...q), false, 36000);
  for (const p of [[280, 660], [320, 700], [230, 600], [650, 250]]) {
    const pts = G.transfer(m, a, G.bodyAt(m, ...p)).et.path.flat(), xs = pts.map(v => v[0]), ys = pts.map(v => v[1]), tip = pts.at(-1), gap = Math.hypot(tip[0] - p[0], tip[1] - p[1]);
    check(pts.length < 3000 && Math.min(...xs) > -70 && Math.max(...xs) < 1500 && Math.min(...ys) > -70 && Math.max(...ys) < 875 && gap > 40, `DRO -> Seldon at ${p}: ${pts.length} pts, bbox x ${Math.min(...xs).toFixed(0)}..${Math.max(...xs).toFixed(0)} y ${Math.min(...ys).toFixed(0)}..${Math.max(...ys).toFixed(0)}, arrowhead ${gap.toFixed(0)} mm from it`);
  } }
// LEO TO DRO's profile (hybrid, Oct 26): passes 1-3 chemical, 4-10 electric. Numbers: chem + elec = total, fuel stage by stage
// (the electric on the dry mass, the chemical on dry + that), a higher start skips passes, past pass 3 and near the Moon electric
// only (the lunar ET estimate); it beats ET on time and GT on fuel. Shape: starts on Seldon-1, joins with no gap and no kink, red
// then purple, ends on the DRO, stays between the rails, for starts from LEO out to GEO, wherever Earth and the Moon stand
{ const m = G.makeMaps(G.LAYOUT.earth, G.LAYOUT.moon, { ...G.SCALE, view: G.DRO_VIEW }), rDro = 36000, [ET, GT] = G.PROP_MODES;
  const from = (d, deg = 135) => { const t = deg * Math.PI / 180, q = [m.E.cx + d * Math.cos(t), m.E.cy - d * Math.sin(t)], raw = G.bodyAt(m, ...q); return d <= m.E.rho(G.R_LEO) + 1 ? G.lockLeo(m, raw, false, 25, 30) : raw; };
  const hyOf = a => G.transfer(m, a, G.targetBody(m, a, 'M', rDro)), near = (x, y, e = 1e-9) => Math.abs(x - y) <= e * Math.max(1, Math.abs(y));
  let prevC = 9;
  for (const d of [66, 100, 130, 150, 165, 175, 179, 250, 500, 800]) {
    const a = from(d, 180), X = hyOf(a), h = X.hy, c = h.chem, e = h.elec;
    check(near(h.dv, c.dv + e.dv) && near(h.mp, c.mp + e.mp) && near(h.t, c.t + e.t), `hybrid from ${d} mm: total = chemical + electric (${h.dv.toFixed(3)} km/s, ${h.mp.toFixed(1)} kg, ${(h.t / 86400).toFixed(1)} d)`);
    check(near(e.mp, G.propFor(ET, e.dv)) && near(c.mp, V.propFor(GT.isp, c.dv, V.SELDON.dry + e.mp)), `hybrid from ${d} mm: fuel stage by stage (electric ${e.mp.toFixed(1)} kg on the dry mass, chemical ${c.mp.toFixed(1)} kg on dry + that)`);
    check(c.n <= prevC && c.n + e.n <= G.HYB.passes && (c.n === 0) === (c.dv === 0), `hybrid from ${d} mm (r ${Math.round(a.r)} km): ${c.n} chemical + ${e.n} electric passes (no more than from lower down)`); prevC = c.n;
    if (!c.n) check(near(e.dv, V.lunarDv(a.r, rDro).et) && near(e.dv, X.et.dv), `hybrid from ${d} mm: electric only = the lunar ET estimate (${e.dv.toFixed(3)} vs ${X.et.dv.toFixed(3)} km/s)`);
  }
  { const a = from(66), X = hyOf(a), h = X.hy;
    check(h.chem.n === 3 && h.elec.n === 7, `hybrid from LEO: 3 + 7 passes (${h.chem.n} + ${h.elec.n})`);
    const vp = Math.sqrt(G.MU_E * (2 / G.R_LEO - 2 / (G.R_LEO + G.HYB.chemKm))) - Math.sqrt(G.MU_E / G.R_LEO);
    check(near(h.chem.dv, vp), `hybrid from LEO: chemical = vis-viva LEO -> ${G.HYB.chemKm} km apoapsis (${h.chem.dv.toFixed(3)} vs ${vp.toFixed(3)} km/s)`);
    check(h.t < X.et.t && h.mp < X.gt.mp && h.dv < X.et.dv, `hybrid from LEO beats ET on time (${(h.t / 86400).toFixed(0)} vs ${(X.et.t / 86400).toFixed(0)} d) and GT on fuel (${h.mp.toFixed(0)} vs ${X.gt.mp.toFixed(0)} kg)`); }
  check(hyOf(from(115, 180)).hy.chem.n === 2 && hyOf(from(175, 180)).hy.chem.n === 0 && hyOf(from(175, 180)).hy.elec.n === 7, 'hybrid: a Seldon between passes 1 and 2 skips pass 1; one past pass 3 (inside GEO) does passes 4-10, electric');
  check(hyOf(from(760, 10)).hy.path.length === 2 && hyOf(from(760, 10)).hy.kinds.every(k => k === 'et'), 'hybrid: past HYB.direct of the way to the Moon, one electric curve (direct)');
  { const H = r => G.hybridNumbers(r, rDro), lo = H(33000), hi = H(33100);   // pass 3 (36,000 km) skipped within 30% of its step: no lap of dashes over the Seldon's own orbit
    check(H(35500).chem.n === 0 && H(23500).chem.n === 1 && H(16000).chem.n === 2 && lo.chem.n === 1 && hi.chem.n === 0, 'hybrid: a pass just beyond the start (within HYB.skip of its step) is skipped');
    check(Math.abs(lo.dv - hi.dv) < .02 && Math.abs(lo.mp - hi.mp) < 6, `hybrid: skipping it barely moves the numbers (${lo.dv.toFixed(3)} / ${hi.dv.toFixed(3)} km/s, ${lo.mp.toFixed(1)} / ${hi.mp.toFixed(1)} kg)`); }
  for (const d of [66, 110, 150, 178]) for (const deg of [0, 90, 180, 270]) {   // (the loops start at the periapsis opposite the Moon wherever the Seldon is: a few starting angles)
    const a = from(d, deg), b = G.targetBody(m, a, 'M', rDro), h = G.hybrid(m, a, b), all = [...h.lead, ...h.path.flat()], s0 = all[0], end = all.at(-1), p1 = m.E.xy(a.rho, a.th);
    const gaps = h.path.slice(1).map((seg, i) => Math.hypot(seg[0][0] - h.path[i].at(-1)[0], seg[0][1] - h.path[i].at(-1)[1]));
    const turn = h.path.slice(1).map((seg, i) => { const p = h.path[i], u = [p.at(-1)[0] - p.at(-2)[0], p.at(-1)[1] - p.at(-2)[1]], v = [seg[1][0] - seg[0][0], seg[1][1] - seg[0][1]]; return Math.abs(Math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1])) * 180 / Math.PI; });
    const ys = h.path.flat().map(p => p[1]), rail = 24 + 76;   // (the Orbitron rails' band)
    check(Math.hypot(s0[0] - p1[0], s0[1] - p1[1]) < .5 && Math.abs(b.B.inv(end[0], end[1]).rho - b.rho) < .5, `hybrid from ${d} mm at ${deg}: starts on Seldon-1, ends on the DRO`);
    check(gaps.every(g => g < 1e-6) && turn.every(t => t < 3), `hybrid from ${d} mm at ${deg}: joins ${gaps.map(g => g.toFixed(3)).join(', ')} mm, turning ${turn.map(t => t.toFixed(1)).join(', ')} deg`);
    check(h.kinds[0] === (h.chem.n ? 'gt' : 'et') && h.kinds.slice(1).every(k => k === 'et'), `hybrid from ${d} mm at ${deg}: chemical first, then electric (${h.kinds})`);
    check(Math.min(...ys) > m.E.cy - (803.5 / 2 - rail) && Math.max(...ys) < m.E.cy + (803.5 / 2 - rail), `hybrid from ${d} mm at ${deg}: within the rails (y ${Math.min(...ys).toFixed(0)}..${Math.max(...ys).toFixed(0)})`);
  }
  // the loops keep to the room between the rails wherever Earth and the Moon stand (Oct 26: off-centre pairs ran them through a
  // rail): 600-1100 mm apart, the Earth-Moon line up to 100 mm off the table's centre at up to 10 deg, or 50 mm at 20 deg (beyond
  // that Earth's own periapsis side is in the rail, or off the table's end)
  const R = G.HYB.room;
  for (const D of [600, 800, 970, 1100]) for (const off of [-100, -50, 0, 50, 100]) for (const ang of [-20, -10, 0, 10, 20]) {
    if (Math.abs(ang) > 10 && (Math.abs(off) > 50 || D > 970)) continue;
    const t = ang * Math.PI / 180, mid = [714.25, 401.75 + off], e = [mid[0] - D / 2 * Math.cos(t), mid[1] - D / 2 * Math.sin(t)], mo = [mid[0] + D / 2 * Math.cos(t), mid[1] + D / 2 * Math.sin(t)];
    const mm = G.makeMaps(e, mo, { ...G.SCALE, view: G.DRO_VIEW }); let worst = -Infinity, n = 0;
    for (const d of [66, 100, 130, 150, 178]) {
      const q = mm.E.xy(d, mm.thM + 2.4), raw = G.bodyAt(mm, ...q), a = d <= mm.E.rho(G.R_LEO) + 1 ? G.lockLeo(mm, raw, false, 25, 30) : raw, h = G.hybrid(mm, a, G.targetBody(mm, a, 'M', rDro));
      if (h.path.length < 3) continue; n++;
      const ex = ([x, y]) => Math.max(-x, x - 1428.5, R.y0 - y, y - R.y1), cs = !h.chem.n;   // (the table's ends have no rail: on the glass is enough)
      for (const p of h.path.slice(cs ? 1 : 0, -1).flat()) worst = Math.max(worst, ex(p));   // the passes; a coast (electric only) no farther out than the piece (one in a rail starts there)
      if (cs) for (const p of h.path[0]) worst = Math.max(worst, ex(p) - Math.max(0, ex(q)));
    }
    check(n > 0 && worst < .5, `hybrid, Earth-Moon ${D} mm, ${off} mm off centre, ${ang} deg: ${n} starts, the loops ${worst < 0 ? (-worst).toFixed(0) + ' mm inside' : worst.toFixed(1) + ' mm outside'} the room between the rails, on the table`);
  } }
// LEO TO DRO's starts (owner, Oct 26: "in DRO mode just presume our orbit is already elliptical"): GEO snaps as in LEO TO GEO and a
// GEO start coasts along GEO to the periapsis opposite the Moon; right behind Earth a start is circular (and does the whole trip, as from
// LEO); anywhere else off LEO it is on one of the passes (onPass): its ring is the passes' own ellipse through the piece, or off the
// passes the nearest ellipse through it (always through it), it rides that to the next periapsis (in the next pass's colour) and does
// the passes left, tangent all the way, onto the DRO, in the room; short of its apoapsis with the last pass left it goes straight on,
// or by the Moon one curve (direct()); numbers run on from LEO's; the riding dot is fastest at periapsis, but not by Kepler's 13 : 1
{ const m = G.makeMaps(G.LAYOUT.earth, G.LAYOUT.moon, { ...G.SCALE, view: G.DRO_VIEW }), mg = G.makeGeoMaps([700, 400]), rDro = 36000, R = G.HYB.room, rg = m.E.rho(G.R_GEO);
  for (const was of [false, true]) {   // the same GEO band as LEO TO GEO's (snap 85% of the cap, hold the cap: the cap rules a 40 mm band)
    const w = d => G.lockGeo(m, G.bodyAt(m, m.E.cx + rg + d, m.E.cy), was, 40, 30).locked, wg = d => G.lockGeo(mg, G.bodyAt(mg, 700 + mg.E.rho(G.R_GEO) + d, 400), was, 40, 30).locked;
    const edge = f => { let d = 0; while (f(d + .25) && d < 100) d += .25; return d; };
    check(Math.abs(edge(w) - edge(wg)) < .3 && Math.abs(edge(d => w(-d)) - edge(d => wg(-d))) < .3, `LEO TO DRO: GEO snaps within ${edge(w)} / ${edge(d => w(-d))} mm${was ? ' (held)' : ''}, as LEO TO GEO (${edge(wg)} / ${edge(d => wg(-d))})`);
  }
  const TAU = 2 * Math.PI, seg = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]), ang = (u, v) => Math.abs(Math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1])) * 180 / Math.PI;
  const out = p => Math.max(R.x0 - p[0], p[0] - R.x1, R.y0 - p[1], p[1] - R.y1), near = (x, y, e = 1e-9) => Math.abs(x - y) <= e * Math.max(1, Math.abs(y));
  const rail = p => p[0] < 0 || p[0] > 1428.5 ? -Infinity : Math.max(R.y0 - p[1], p[1] - R.y1);   // into a rail, on the glass (the ends have none)
  // the page's order (modes.js updGD): the DRO, GEO, LEO, else a pass (W: the hysteresis, as the page keeps it)
  const pipe = (mp, q, W = {}) => { let b = G.lockDro(mp, ...q, G.bodyAt(mp, ...q), W.was, rDro); W.was = !!b.locked; if (!b.locked) { b = G.lockGeo(mp, b, W.wasG, mp.E.rho0 != null ? 14 : 40, 30); W.wasG = !!b.locked; } else W.wasG = false;
    if (!b.locked) { const l = G.lockLeo(mp, b, W.wasLeo, 25, 30); W.wasLeo = !!l.leo; if (l.leo) return l; const o = G.onPass(mp, l, rDro, W.near); W.near = !!o.ell?.near; return o; } return b; };
  // how far a point is off member L (radially, mm, in the family's frame, un-squeezed by L's own squeeze)
  const offM = (L, p) => { const F = L.F, dx = p[0] - F.o[0], dy = p[1] - F.o[1], x = dx * F.u[0] + dy * F.u[1], y0 = dx * F.v[0] + dy * F.v[1], y = y0 / (y0 > 0 ? L.s[0] : L.s[1]), r = Math.hypot(x, y), sl = 2 * L.rp * L.A / (L.rp + L.A); return Math.abs(r - sl / (1 + L.ec * x / (r || 1))); };
  const stepTurn = (segs, pc) => { let w = 0; for (const s of segs) for (let i = 1; i < s.length - 1; i++) if (seg(s[i], s[i - 1]) > .05 && seg(s[i + 1], s[i]) > .05 && seg(s[i], pc) > 33) w = Math.max(w, ang([s[i][0] - s[i - 1][0], s[i][1] - s[i - 1][1]], [s[i + 1][0] - s[i][0], s[i + 1][1] - s[i][1]])); return w; };
  const dir = (p, q) => [q[0] - p[0], q[1] - p[1]];
  // a sweep of the table (between the rails): every start checked; returns the counts and the worst of each
  const sweep = (mp, name, step = 30, turn = 5, centred = false) => {
    const st = { pass: 0, off: 0, circ: 0, on: 0, direct: 0, lap: 0, ring: 0, start: 0, ride: 0, tan: 0, join: 0, jd: 0, step: 0, room: -Infinity, roomAt: '', ringRail: -Infinity, ringAt: '', bad: [] };
    const thP = mp.thM + Math.PI, up = [Math.cos(thP), -Math.sin(thP)];
    for (let x = R.x0 + 10; x <= R.x1 - 10; x += step) for (let y = R.y0 + 10; y <= R.y1 - 10; y += step) {
      const q = [x, y], a = pipe(mp, q); if (a.prim !== 'E' || a.locked || a.leo) continue;
      const b = G.targetBody(mp, a, 'M', rDro), h = G.hybrid(mp, a, b), end = h.path.flat().at(-1), pc = mp.E.xy(a.seen ?? a.rho, a.th);
      if (!(Math.abs(b.B.inv(end[0], end[1]).rho - b.rho) < .5)) st.bad.push(`${q}: ends off the DRO`);
      h.path.slice(1).forEach((s, i) => { const p = h.path[i]; if (seg(s[0], p.at(-1)) > 1e-6) st.bad.push(`${q}: a gap at a join`);
        const t = ang(dir(p.at(-2), p.at(-1)), dir(s[0], s[1])), nb = Math.max(p.length > 2 ? ang(dir(p.at(-3), p.at(-2)), dir(p.at(-2), p.at(-1))) : 0, s.length > 2 ? ang(dir(s[0], s[1]), dir(s[1], s[2])) : 0);
        if (h.how === 'direct') st.jd = Math.max(st.jd, t); else if (t - nb > st.join) { st.join = t - nb; st.joinAt = `${q} ${h.how} join ${i}`; } });   // (a join turns no more than the steps either side: tangent, sampling aside)
      const pr = Math.max(0, rail(pc)), ringR = a.ell ? Math.max(0, ...G.orbitPts(a, 256).map(rail)) : 0;
      for (const p of h.path.slice(0, -1).flat()) { const o = rail(p) - Math.max(pr, ringR); if (o > st.room) { st.room = o; st.roomAt = `${x},${y} (${h.how || 'circular'})`; } }   // the route no farther into a rail than the piece or its own ring
      if (!a.ell) {   // circular: only right behind Earth
        st.circ++; const P = mp.E.xy(a.rho, a.th), c = ((P[0] - mp.E.cx) * up[0] + (P[1] - mp.E.cy) * up[1]) / a.rho;
        if (!(c >= Math.cos(G.HYB.behind[1]) - 1e-9)) st.bad.push(`${q}: circular, ${(Math.acos(c) * 180 / Math.PI).toFixed(0)} deg off the line behind Earth`);
        continue;
      }
      const L = a.ell, F = L.F, s0 = h.path[0][0];
      st.ring = Math.max(st.ring, L.off, offM(L, mp.E.xy(a.rho, a.th))); if (L.rp > F.rp + 1e-9 || L.ec > F.ecMax + 1e-9) st.off++; else st.pass++;
      if (seg(G.orbitXY(a, L.m0), L.pt) > .5) st.bad.push(`${q}: the dot does not start on the piece`);
      st.start = Math.max(st.start, seg(s0, L.pt));
      const proj = ((x - mp.E.cx) * (mp.M.cx - mp.E.cx) + (y - mp.E.cy) * (mp.M.cy - mp.E.cy)) / mp.Dmm;   // (along the line from Earth)
      if (proj > 0 && !L.near && ringR - pr > st.ringRail) { st.ringRail = ringR - pr; st.ringAt = `${x},${y}`; }   // between Earth and the Moon's neighbourhood its ring keeps off the rails as the piece does
      if (h.how === 'direct') { st.direct++; if (!((L.near || L.A > mp.Dmm - b.rho + 1 || (L.nu > 0 && L.nu <= Math.PI && !h.apo.length)) && h.path.length === 2)) st.bad.push(`${q}: direct() neither by the Moon nor short of its apoapsis on the last pass`); continue; }
      { const w = stepTurn(h.path.slice(0, -1), pc); if (w > st.step) { st.step = w; st.stepAt = `${q} ${h.how}`; } }
      const first = h.path[0];
      const dro = h.path.at(-1), j0 = dro[0], jm = Math.atan2(-(j0[1] - mp.M.cy), j0[0] - mp.M.cx);
      if (h.how === 'ride' || h.how === 'direct') {   // its apoapsis reaches the DRO (or by the Moon): the DRO joined where it is nearest, either way round (Oct 26), not swung round to its Earth side
        const dp = h.path.at(-2)[0], dm = Math.atan2(-(dp[1] - mp.M.cy), dp[0] - mp.M.cx), off = Math.abs(Math.atan2(Math.sin(jm - dm), Math.cos(jm - dm))) * 180 / Math.PI;
        if (off > 110) st.bad.push(`${q}: joins the DRO ${off.toFixed(0)} deg round from where its curve onto it starts`);
      }
      if (h.how === 'ride') { st.rideN = (st.rideN || 0) + 1; st.ride = Math.max(st.ride, ...first.filter((_, i) => i % 5 === 0).map(p => offM(L, p))); if (!(L.A > mp.Dmm - b.rho + 1)) st.bad.push(`${q}: rides to the DRO with its apoapsis short of it`); }
      else if (h.how === 'on') { st.on++; st.tan = Math.max(st.tan, ang(L.tan, dir(first[0], first[1]))); if (!(L.nu > 0 && L.nu <= Math.PI + 1e-9)) st.bad.push(`${q}: straight on past its apoapsis`); }
      else if (L.nu > 1e-3) {   // its ride: on its ring all the way, to its periapsis
        st.ride = Math.max(st.ride, ...first.filter((_, i) => i % 5 === 0).map(p => offM(L, p)));
        if (seg(first.at(-1), [F.o[0] + L.rp * F.u[0], F.o[1] + L.rp * F.u[1]]) > .5) st.bad.push(`${q}: the ride ends off its periapsis`);
        if (L.nu > Math.PI && !h.apo.length) st.lap++;
      }
      if (h.kinds[0] !== (h.chem.n && h.how !== 'on' ? 'gt' : 'et') || h.kinds.slice(h.chem.n ? 2 : 1).some(k => k !== 'et')) st.bad.push(`${q}: kinds ${h.kinds} for ${h.chem.n} chemical passes`);
    }
    console.log(`  ${name}: ${st.pass} starts on a pass, ${st.off} off the passes (the nearest ellipse through the piece), ${st.circ} circular behind Earth; ${st.on} straight on, ${st.rideN || 0} riding to the DRO, ${st.direct} direct(), ${st.lap} a lap first on the last pass; ring into a rail beyond the piece (between Earth and the Moon's neighbourhood) ${st.ringRail.toFixed(1)} mm at ${st.ringAt}`);
    check(!st.bad.length, `${name}: ${st.bad.length} bad starts${st.bad.length ? ': ' + st.bad.slice(0, 4).join('; ') : ''}`);
    check(st.pass + st.off > 100 && st.ring < 1e-6 && st.start < .5, `${name}: the ring passes through the piece (${st.ring.toExponential(1)} mm), the route starts on it (${st.start.toFixed(2)} mm)`);
    check(st.ride < 1e-6 && st.tan < 2 && st.join < .5 && st.jd < 4 && st.step < turn, `${name}: the route rides the ring to the periapsis (${st.ride.toExponential(1)} mm off) or leaves along it (${st.tan.toFixed(2)} deg), joins turn ${st.join.toFixed(2)} deg more than the steps either side (direct()'s ${st.jd.toFixed(1)} deg), ${st.step.toFixed(1)} deg per ~3 mm step (worst ${st.stepAt}; join worst ${st.joinAt})`);
    check(st.room < 2, `${name}: the route ${st.room.toFixed(1)} mm farther into a rail than the piece or its ring (worst at ${st.roomAt})`);
    if (centred) check(st.ringRail < 5, `${name}: between Earth and the Moon's neighbourhood the ring keeps off the rails as the piece does (${st.ringRail.toFixed(1)} mm at ${st.ringAt})`);
    return st;
  };
  const s0 = sweep(m, 'Earth-Moon 970 mm, centred', 20, 5, true);
  check(s0.on > 0 && s0.direct > 0 && s0.off > 0 && s0.circ > 0 && s0.lap > 0, `970 mm: some starts go straight on (${s0.on}), some direct() (${s0.direct}), some off the passes (${s0.off}), some circular (${s0.circ}), some a lap first (${s0.lap})`);
  sweep(G.makeMaps([364.25, 401.75], [1064.25, 401.75], { ...G.SCALE, view: G.DRO_VIEW }), 'Earth-Moon 700 mm, centred', 30, 5, true);
  for (const [e, mo] of [[[450, 400], [1150, 400]], [[300, 500], [1150, 300]], [[180, 300], [1100, 480]], [[250, 480], [1200, 300]], [[140, 400], [1290, 400]]]) sweep(G.makeMaps(e, mo, { ...G.SCALE, view: G.DRO_VIEW }), `pair ${e} / ${mo}`);
  sweep(G.makeTrueMaps([150, 401.75], [1238.5, 401.75], { foot: 36 }), 'true scale', 30, 8);   // (true scale: LEO is 19 mm out, the periapsis turns ~38 mm round)
  // continuity: along lines across the table the ring moves smoothly (no jumps but at a lock; the passes' own edge by Earth is steep:
  // e near the last pass's, a mm there moves the apoapsis tens of mm), the riding point too, and from the circle behind Earth onto the ellipses
  { let we = 0, wo = 0, wp = 0, wc = 0, at = '', ato = '';
    const H = a => G.hybrid(m, a, G.targetBody(m, a, 'M', rDro)).dv;
    for (const y of [180, 260, 330, 400, 470, 540, 620]) { let prev = null; const W = {};
      for (let x = 60; x <= 1368; x += .5) { const a = pipe(m, [x, y], W), L = a.ell, cur = a.prim === 'E' && !a.locked && !a.leo ? { L, rp: L ? L.rp : a.rho, A: L ? L.A : a.rho, p: L ? G.orbitXY(a, L.m0) : null, a } : null;
        if (cur && prev) {
          if (L && prev.L) { const off = L.rp > L.F.rp + 1e-9 || L.ec > L.F.ecMax + 1e-9 || prev.L.rp > L.F.rp + 1e-9 || prev.L.ec > L.F.ecMax + 1e-9, d = Math.max(Math.abs(cur.A - prev.A), Math.abs(cur.rp - prev.rp));
            if (!off) { const de = Math.abs(L.ec - prev.L.ec); if (de > we) { we = de; at = `${x},${y}`; } } else if (d > wo) { wo = d; ato = `${x},${y}`; } wp = Math.max(wp, seg(cur.p, prev.p)); }
          else if (!!L !== !!prev.L) wc = Math.max(wc, Math.abs(cur.A - prev.A), Math.abs(cur.rp - prev.rp), Math.abs(H(cur.a) - H(prev.a)) * 1000);   // (circle <-> ellipse: mm, and m/s)
        }
        prev = cur; } }
    check(we < .02 && wo < 15 && wp < 15 && wc < 50, `continuous: on the passes e moves at most ${we.toFixed(4)} per 0.5 mm of the piece (at ${at}), off them its apsides ${wo.toFixed(1)} mm (at ${ato}), the dot's start ${wp.toFixed(1)} mm; circle to ellipse behind Earth ${wc.toFixed(2)} (mm / m/s)`); }
  // numbers: from a pass's apoapsis Q, LEO's when Q is LEO, then smoothly out (a skipped pass barely moves them), falling all the way
  { const H = Q => G.hybridNumbers(G.R_LEO, rDro, false, Q), l = G.hybridNumbers(G.R_LEO, rDro), l1 = H(G.R_LEO + 1e-6);
    check(near(l1.dv, l.dv, 1e-6) && near(l1.mp, l.mp, 1e-6) && l1.chem.n === 3, `numbers: a pass with its apoapsis at LEO is LEO (${l1.dv.toFixed(4)} / ${l.dv.toFixed(4)} km/s)`);
    let prev = l1, w = [0, 0, 0], sk = [0, 0], n = 0;   // (sk: where a pass is skipped; the electric then does what a short chemical burn did, a little dearer)
    for (let Q = G.R_LEO + 100; Q < G.D_EM - rDro; Q += 100) { const h = H(Q), dv = h.dv - prev.dv, dm = Math.abs(h.mp - prev.mp);
      if (h.chem.n === prev.chem.n && h.elec.n === prev.elec.n) w = [Math.max(w[0], Math.abs(dv)), Math.max(w[1], dm), Math.max(w[2], Math.abs(h.t - prev.t) / 86400)], w[3] = Math.max(w[3] ?? -1, dv);
      else { n++; sk = [Math.max(sk[0], Math.abs(dv)), Math.max(sk[1], dm)]; } prev = h; }
    check(w[0] < .03 && w[1] < 8 && w[3] < 0, `numbers from LEO's out to the last pass: per 100 km of apoapsis at most ${w[0].toFixed(4)} km/s, ${w[1].toFixed(2)} kg, ${w[2].toFixed(2)} d, always falling`);
    check(n === 9 && sk[0] < .1 && sk[1] < 6, `numbers: ${n} passes skipped on the way out, each moving them at most ${sk[0].toFixed(3)} km/s, ${sk[1].toFixed(1)} kg`);
    const vp = (ra, rb) => Math.sqrt(G.MU_E * (2 / G.R_LEO - 2 / (G.R_LEO + ra))) - Math.sqrt(G.MU_E * (2 / G.R_LEO - 2 / (G.R_LEO + rb))), h = H(20000);
    check(near(h.chem.dv, vp(G.HYB.chemKm, 20000)) && h.chem.n === 2, `numbers from a LEO x 20,000 km pass: chemical = vis-viva at the periapsis to the pass-3 apoapsis (${h.chem.dv.toFixed(3)} km/s, ${h.chem.n} passes)`);
    const c = G.hybridNumbers(60000, rDro), cp = G.hybridNumbers(60000, rDro, false, 60000, 60000), hi = G.hybridNumbers(G.R_LEO, rDro, false, 200000, 30000), lo = H(200000);   // (a periapsis raised: the circle at the end, less to do higher up)
    check(near(cp.dv, c.dv, 1e-9) && near(cp.mp, c.mp, 1e-9) && hi.dv < lo.dv, `numbers off the passes: periapsis = apoapsis is the circle (${cp.dv.toFixed(4)} / ${c.dv.toFixed(4)} km/s); a raised periapsis needs less (${hi.dv.toFixed(3)} < ${lo.dv.toFixed(3)})`);
    // and on the table, a piece moving out along the Earth-Moon line (past the LEO band: there its ellipse's apoapsis is the piece)
    let pv = null, wt = 0; for (let x = m.E.cx + 95; x < m.E.cx + 700; x += 1) { const a = pipe(m, [x, m.E.cy]); if (!a.ell) { pv = null; continue; } const h = G.hybrid(m, a, G.targetBody(m, a, 'M', rDro)); if (pv && pv.n === h.chem.n + h.elec.n) wt = Math.max(wt, Math.abs(h.dv - pv.dv)); pv = { dv: h.dv, n: h.chem.n + h.elec.n }; }
    check(wt < .03, `numbers along the line: at most ${wt.toFixed(3)} km/s per mm of the piece (but where a pass is skipped)`); }
  // the riding dot: a Kepler-like pace (fastest at periapsis, at most 1 + HYB.pace : 1 - HYB.pace), from the piece; on the page (modes.js
  // ride: a lap in ORB_LAP 8 s, no quicker than 150 mm/s round the ring) never more than 300 mm/s (10 mm a frame at 30 fps)
  for (const q of [[330, 300], [600, 400], [700, 180], [1000, 470], [230, 150]]) {
    const a = pipe(m, q), L = a.ell, sp = M0 => seg(G.orbitXY(a, M0 + 1e-3), G.orbitXY(a, M0)) / 1e-3, vp = sp(0), va = sp(Math.PI), want = (1 + L.ep) / (1 - L.ep);
    const pts = G.orbitPts(a, 256), len = pts.reduce((s, p, i) => i ? s + seg(p, pts[i - 1]) : 0, 0), moon = G.moonBody(m), rate = TAU / (Math.max(a.n, moon.n) * 8);
    let w = a.n * rate; w *= Math.min(1, TAU / w * 150 / len); let vmax = 0; for (let i = 0; i < 720; i++) vmax = Math.max(vmax, sp(i / 720 * TAU) * w);
    check(vp > va * 1.3 && vp / va < 4.5 && seg(G.orbitXY(a, L.m0), L.pt) < .5 && vmax < 300, `dot from ${q}: ${vp.toFixed(0)} mm per radian at periapsis, ${va.toFixed(0)} at apoapsis (x${(vp / va).toFixed(1)}; Kepler's x${((1 + L.ec) / (1 - L.ec)).toFixed(1)}, softened x${want.toFixed(1)}), from the piece; on the page at most ${vmax.toFixed(0)} mm/s`);
  }
  // (review, Oct 26) the spots that read badly: just past the LEO band behind Earth (circular now, the whole trip, as from LEO); 150 mm
  // above Earth (its own ellipse through it); 80% of the way out, and by the Moon either side of its apoapsis (one short route, no lap
  // back round Earth; no flip half a millimetre over, the numbers the same)
  { const hy = q => { const a = pipe(m, q); return { a, h: G.hybrid(m, a, G.targetBody(m, a, 'M', rDro)) }; }, len = h => h.path.slice(0, -1).flat().reduce((s, p, i, A) => i ? s + seg(p, A[i - 1]) : 0, 0);
    { const { a, h } = hy([100, 400]), l = hy([m.E.cx - 70, m.E.cy]).h; check(!a.ell && h.chem.n === 1 && h.dv < l.dv && h.dv > 2.5, `behind Earth at 100,400: circular (${Math.round(a.r)} km), the whole trip: ${h.chem.n} + ${h.elec.n} passes, ${h.dv.toFixed(2)} km/s (LEO ${l.dv.toFixed(2)})`); }
    { const { a, h } = hy([230, 250]); check(a.ell && a.ell.off < 1e-6 && h.path[0][0] && seg(h.path[0][0], a.ell.pt) < .5, `150 mm above Earth: on its own ellipse through the piece (apogee ${Math.round(a.ell.Q)} km), the route from it`); }
    for (const q of [[1000, 470], [988, 250], [992, 250]]) { const { a, h } = hy(q); check(h.how !== 'passes' && len(h) < 450, `by the Moon at ${q}: ${h.how}, ${len(h).toFixed(0)} mm (no lap back round Earth), ${(h.dv * 1000).toFixed(0)} m/s, apogee ${Math.round(a.ell.Q)} km`); }
    { const A = hy([989.5, 250]).h, B = hy([990, 250]).h; check(A.how === B.how && Math.abs(A.dv - B.dv) < .005, `half a millimetre by the Moon: ${A.how} / ${B.how}, ${(A.dv * 1000).toFixed(0)} / ${(B.dv * 1000).toFixed(0)} m/s`); }
  }
  // GEO picked from a pass (numbers only, modes.js): chemical and electric run on from LEO's Hohmann and LEO -> GEO estimate, and through Q = GEO
  { const leo = G.lockLeo(m, G.bodyAt(m, m.E.cx + 70, m.E.cy), false, 25, 30), gb = G.targetBody(m, leo, 'E', G.R_GEO), X0 = G.transfer(m, leo, gb);
    const asPass = (Q, P) => ({ ...leo, leo: false, ell: { Q, rpK: P } }), X = (Q, P) => G.transfer(m, asPass(Q, P), gb), lo = X(G.R_LEO + 1e-6), a = X(G.R_GEO - 1), b = X(G.R_GEO + 1);
    check(near(lo.gt.dv, X0.gt.dv, 1e-6) && near(lo.et.dv, X0.et.dv, 1e-6), `GEO from a pass at LEO: LEO's numbers (GT ${lo.gt.dv.toFixed(3)} / ${X0.gt.dv.toFixed(3)}, ET ${lo.et.dv.toFixed(3)} / ${X0.et.dv.toFixed(3)} km/s)`);
    check(Math.abs(a.gt.dv - b.gt.dv) < 1e-3 && Math.abs(a.et.dv - b.et.dv) < 1e-3 && a.gt.dv < lo.gt.dv, `GEO from a pass through GEO: ${a.gt.dv.toFixed(4)} / ${b.gt.dv.toFixed(4)} km/s (GT), ${a.et.dv.toFixed(4)} / ${b.et.dv.toFixed(4)} (ET)`);
    const r = X(G.R_GEO + 1e-6, G.R_GEO - 1e-6), up = X(200000, 60000);
    check(r.gt.dv < 1e-3 && r.et.dv < 1e-3 && up.gt.dv > 0 && up.et.dv > 0, `GEO from a pass off the passes: on GEO nothing (${r.gt.dv.toFixed(4)} km/s), from above it a burn down (${up.gt.dv.toFixed(3)} GT, ${up.et.dv.toFixed(3)} ET)`); }
  { const tm = G.makeTrueMaps([150, 401.75], [1238.5, 401.75], { foot: 36 });   // true scale: from GEO, along GEO first
    const ringOk = (mp, a, c) => { const E = mp.E, sw = ((mp.thM + Math.PI - a.th) % TAU + TAU) % TAU; let Ax = sw; for (let t = 0; t <= sw; t += .002) if (out(E.xy(a.rho, a.th + t)) > .25) { Ax = t; break; }
      let w = 0, k = 0; for (const p of c) { const t = ((Math.atan2(E.cy - p[1], p[0] - E.cx) - a.th) % TAU + TAU) % TAU; if (t < Ax - 1.25 && t < sw) { k++; w = Math.max(w, Math.abs(Math.hypot(p[0] - E.cx, p[1] - E.cy) - a.rho)); } } return { ok: w < .5, w, k, Ax }; };
    for (const dg of [60, 120, 250, 300]) { const a = G.lockGeo(tm, G.bodyAt(tm, ...tm.E.xy(tm.E.rho(G.R_GEO) + 30, dg * Math.PI / 180)), false, 14, 30), h = G.hybrid(tm, a, G.targetBody(tm, a, 'M', rDro));
      check(a.locked && h.path.length === 3 && (o => o.ok && (o.Ax < 1.5 || o.k > 20))(ringOk(tm, a, h.path[0])) && h.kinds.every(k => k === 'et'), `true scale, GEO at ${dg}: coast on GEO till near the table end (the ring runs 9 mm into its margin), then the passes (${h.elec.n})`); }
    for (const dg of [0, 60, 120, 200, 300]) { const a = G.lockGeo(m, G.bodyAt(m, ...m.E.xy(rg + 5, dg * Math.PI / 180)), false, 40, 30), h = G.hybrid(m, a, G.targetBody(m, a, 'M', rDro)), c = h.path[0];   // 970 mm: on GEO all the way
      check(a.locked && h.chem.n === 0 && h.elec.n === 7 && (c.every(p => Math.abs(seg(p, [m.E.cx, m.E.cy]) - rg) < .5)), `GEO at ${dg}: coasts on GEO to the burn point, then all 7 electric passes`); } }
  // (review, Oct 26) Earth by the table's end: no route inside LEO (the periapsis on LEO, its loops spilling into the end margin as
  // before); a short coast along GEO by the burn point joins smoothly, starting under the base; near the Moon, direct() keeps inside
  // the room for pieces well inside it
  for (const ex of [60, 90, 120, 150]) {
    const mm = G.makeMaps([ex, 400], [ex + 1000, 400], { ...G.SCALE, view: G.DRO_VIEW }), rl = mm.E.rho(G.R_LEO); let mn = Infinity, first = Infinity;
    for (const d of [rl, 100, 130, 160]) for (const deg of [40, 90, 135, 270, 320]) {
      const a = pipe(mm, mm.E.xy(d, deg * Math.PI / 180)); if (a.prim !== 'E') continue;
      const h = G.hybrid(mm, a, G.targetBody(mm, a, 'M', rDro)); for (const p of h.path.slice(0, -1).flat()) mn = Math.min(mn, seg(p, [ex, 400]));
      if (d === rl) first = Math.min(first, Math.abs(seg(h.path[0][0], [ex, 400]) - rl));
    }
    check(mn > rl - .5 && first < .5, `Earth ${ex} mm from the end: every route keeps outside LEO (closest ${mn.toFixed(1)} mm, LEO ${rl.toFixed(1)}), a LEO start's first burn on LEO (${first.toFixed(2)} mm)`);
  }
  for (const [nm, mp, q] of [['true scale', G.makeTrueMaps([150, 401.75], [1238.5, 401.75], { foot: 36 }), [40, 400]], ['true scale', G.makeTrueMaps([150, 401.75], [1238.5, 401.75], { foot: 36 }), [40, 380]], ['true scale', G.makeTrueMaps([150, 401.75], [1238.5, 401.75], { foot: 36 }), [40, 360]], ['970 mm', m, [40, 320]]]) {
    let a = G.bodyAt(mp, ...q); a = G.lockGeo(mp, a, false, mp.E.rho0 != null ? 14 : 40, 30); const h = G.hybrid(mp, a, G.targetBody(mp, a, 'M', rDro));
    const tn = h.path.slice(1).map((s, i) => { const p = h.path[i]; return ang([p.at(-1)[0] - p.at(-2)[0], p.at(-1)[1] - p.at(-2)[1]], [s[1][0] - s[0][0], s[1][1] - s[0][1]]); }), pc = mp.E.xy(a.seen ?? a.rho, a.th);
    check(h.path.length === 3 && tn.every(t => t < 3) && stepTurn(h.path.slice(0, -1), pc) < 5 && seg(h.path[0][0], pc) < 16.5, `${nm}, Seldon-1 at ${q} by the burn point: short coast joins at ${tn.map(t => t.toFixed(1))} deg, worst step ${stepTurn(h.path.slice(0, -1), pc).toFixed(1)}, starts ${seg(h.path[0][0], pc).toFixed(1)} mm from the piece`);
  }
  { let n = 0, w = -Infinity, at = '';
    for (let x = 700; x <= 1348; x += 20) for (let y = R.y0 + 40; y <= R.y1 - 40; y += 20) {
      const a = pipe(m, [x, y]); if (!a.ell) continue; const h = G.hybrid(m, a, G.targetBody(m, a, 'M', rDro)); if (h.how !== 'direct') continue;
      n++; const o = Math.max(...h.path[0].map(out)); if (o > w) { w = o; at = `${x},${y}`; }
    }
    check(n > 20 && w < .5, `near the Moon: ${n} direct() curves from pieces 40 mm or more inside the room keep inside it (worst ${w.toFixed(1)} mm, at ${at})`); }
}
// the reach view (Oct 26): one full tank's DELTA-V (the 325 kg tank, owner Oct 27: electric 9.46 km/s, chemical 3.03 on the same tank), and the circular orbits it reaches
{ const L = G.reach(G.R_LEO), Gg = G.reach(G.R_GEO), alt = r => r - G.R_E;
  check(Math.abs(L.et.dv - G.dvMax(G.PROP_MODES[0])) < 1e-9 && Math.abs(L.gt.dv - 3.03) < .01 && Math.abs(L.et.dv - 9.46) < .01, `reach: one tank is ${L.et.dv.toFixed(2)} km/s electric, ${L.gt.dv.toFixed(2)} chemical`);
  check(L.et.lo === G.R_LEO && L.et.hi === Infinity && L.gt.hi < G.R_GEO && alt(L.gt.hi) > 13500 && alt(L.gt.hi) < 14500 && L.et.dro && !L.gt.dro, `reach from LEO: electric escapes (every orbit out, the DRO too), chemical to ${Math.round(alt(L.gt.hi)).toLocaleString()} km, not the DRO (pure engines)`);
  check(Gg.et.hi === Infinity && Gg.gt.hi === Infinity && Gg.et.lo === G.R_LEO && Gg.gt.lo > G.R_LEO && Gg.et.dro && Gg.gt.dro, `reach from GEO: both escape and reach the DRO; electric down to LEO, chemical only to ${Math.round(alt(Gg.gt.lo)).toLocaleString()} km`);
  const f = (r, k) => G.reach(r)[k], ok = [6800, 8000, 12000, 20000, 30000, 42164, 60000].every((r, i, A) => i === 0 || (f(r, 'et').lo >= f(A[i - 1], 'et').lo - 1e-6 && f(r, 'gt').lo >= f(A[i - 1], 'gt').lo - 1e-6));
  check(ok, 'reach: the lowest orbit each reaches rises as the start rises');
  // the owner's slider glitch (Oct 26): chemical at 435 s on a 235 kg tank is 3.31 km/s, past LEO's escape burn (3.18) but short of GEO (3.85):
  // the band ends short of GEO, and nothing past its edge (out to 12 LEO radii) is in reach
  const Q = G.reach(G.R_LEO, 36000, { isp: { et: 1000, gt: 435 }, tank: 235 }).gt, past = Array.from({ length: 60 }, (_, i) => Q.hi * (1.001 + i * (11.9 * G.R_LEO / Q.hi - 1.001) / 59));
  check(Math.abs(Q.dv - 3.31) < .01 && Q.hi < G.R_GEO && past.every(r => G.reachCost(G.R_LEO, r, 'gt') > Q.dv), `reach: chemical 435 s / 235 kg from LEO (${Q.dv.toFixed(2)} km/s) stops at ${Math.round(alt(Q.hi)).toLocaleString()} km, short of GEO, nothing past it in reach`); }
console.log(fails ? `\n${fails} checks FAILED` : '\nall checks passed');
if (fails) process.exit(1);
