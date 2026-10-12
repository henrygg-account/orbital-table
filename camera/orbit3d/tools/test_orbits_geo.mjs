// node tools/test_orbits_geo.mjs [out.json] — numbers + on-screen check for the orbits view's standard cases
import * as G from '../orbits-geo.js';
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
console.log(fails ? `\n${fails} checks FAILED` : '\nall checks passed');
if (fails) process.exit(1);
