// renders the GT / ET transfer paths for several table layouts into one SVG and prints kink stats per path:
// worst bend (degrees of turn over any 3 mm of path) and curvature sign flips (S-bends) outside the joins. Earth -> Moon cases
// also draw the LEO TO DRO profile (hy: chemical passes red, electric purple, dashed) and print its stats (HY).
//   node tools/render_transfers.mjs ../orbits-geo.js out.svg     (module path is relative to tools/)
const G = await import(process.argv[2]);
const fs = await import('fs');
const W = 1428.5, H = 803.5, sc = .5, SW0 = W, SH0 = H;
const on = (B, rho, deg) => { const t = deg * Math.PI / 180; return [B.cx + rho * Math.cos(t), B.cy - rho * Math.sin(t)]; };
const layouts = [['default', G.LAYOUT.earth, G.LAYOUT.moon], ['Earth centre, Moon up-right', [600, 450], [1150, 200]]];
const cases = [];
for (const [ln, e, m] of layouts) {
  const maps = G.makeMaps(e, m), d = maps.zone * .72;
  cases.push([`${ln}: LEO -> DRO`, maps, on(maps.E, maps.E.rho(G.R_LEO), 60), maps.M.xy(d, Math.PI / 2)]);
  cases.push([`${ln}: DRO -> GEO`, maps, maps.M.xy(d, Math.PI / 2), on(maps.E, maps.E.rho(G.R_GEO), 300)]);
}
{ // LEO TO DRO's own view (DRO_VIEW): from LEO, and on a pass (onPass, as the page reads a piece there) partway out and beyond GEO
  const maps = G.makeMaps(G.LAYOUT.earth, G.LAYOUT.moon, { ...G.SCALE, view: G.DRO_VIEW }), q = maps.M.xy(maps.M.rho(36000), Math.PI / 2);
  for (const [n, d, a] of [['LEO', maps.E.rho(G.R_LEO), 135], ['partway', 172, 30], ['beyond GEO', 420, 20]]) cases.push([`LEO TO DRO view: ${n} -> DRO`, maps, on(maps.E, d, a), q]);
}
{ // Earth only, at the LEO / GEO view's zoom
  const maps = G.makeMaps([SW0 / 2, SH0 / 2], null, { ...G.SCALE, noMoonMm: G.FIG.E + (G.D_EM - G.R_E) / G.ZOOM.leoGeo });
  cases.push(['Earth only: LEO -> GEO', maps, on(maps.E, maps.E.rho(G.R_LEO), 60), on(maps.E, maps.E.rho(G.R_GEO), 200)]);
  cases.push(['Earth only: GEO -> LEO', maps, on(maps.E, maps.E.rho(G.R_GEO), 200), on(maps.E, maps.E.rho(G.R_LEO), 60)]);
}
function stats(pts) {
  const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const at = s => { let i = cum.findIndex(c => c >= s); if (i <= 0) i = 1; const u = (s - cum[i - 1]) / Math.max(1e-9, cum[i] - cum[i - 1]); return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * u, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * u]; };
  const step = 3, hd = []; for (let s = 0; s + step <= cum.at(-1); s += step) { const a = at(s), b = at(s + step); hd.push(Math.atan2(b[1] - a[1], b[0] - a[0])); }
  let worst = 0, flips = 0, prev = 0;
  for (let i = 1; i < hd.length; i++) { let d = hd[i] - hd[i - 1]; d = Math.atan2(Math.sin(d), Math.cos(d)); worst = Math.max(worst, Math.abs(d)); const sgn = Math.abs(d) < .002 ? 0 : Math.sign(d); if (sgn && prev && sgn !== prev) flips++; if (sgn) prev = sgn; }
  return { worst: worst * 180 / Math.PI, flips, len: cum.at(-1) };
}
let svg = '';
cases.forEach(([name, maps, p1, p2], ci) => {
  const a0 = G.bodyAt(maps, ...p1), a = name.startsWith('LEO TO DRO view') && !name.includes(': LEO') ? G.onPass(maps, a0, 36000) : a0, b = G.bodyAt(maps, ...p2), X = G.transfer(maps, a, b);
  const tx = (ci % 2) * (W * sc + 10), ty = Math.floor(ci / 2) * (H * sc + 34) + 26;
  const path = pts => 'M' + pts.map(p => `${(tx + p[0] * sc).toFixed(1)},${(ty + p[1] * sc).toFixed(1)}`).join('L');
  const sE = stats(X.et.path.flat()), sG = stats(X.gt.path.flat()), sH = X.hy && stats(X.hy.path.flat());
  console.log(`${name.padEnd(48)} ET worst ${sE.worst.toFixed(1)}°/3mm, ${sE.flips} S-bends | GT worst ${sG.worst.toFixed(1)}°/3mm, ${sG.flips} S-bends${sH ? ` | HY worst ${sH.worst.toFixed(1)}°/3mm, ${sH.flips} S-bends, ${X.hy.chem.n} + ${X.hy.elec.n} passes` : ''}`);
  svg += `<text x="${tx + 6}" y="${ty - 8}" fill="#ccc" font-size="12" font-family="monospace">${name}</text>`;
  svg += `<rect x="${tx}" y="${ty}" width="${W * sc}" height="${H * sc}" fill="none" stroke="#333"/>`;
  svg += `<circle cx="${tx + maps.E.cx * sc}" cy="${ty + maps.E.cy * sc}" r="${G.FIG.E * sc}" fill="#3a6"/>`;
  if (maps.M) svg += `<circle cx="${tx + maps.M.cx * sc}" cy="${ty + maps.M.cy * sc}" r="${G.FIG.M * sc}" fill="#999"/><circle cx="${tx + maps.M.cx * sc}" cy="${ty + maps.M.cy * sc}" r="${maps.zone * sc}" fill="none" stroke="#555" stroke-dasharray="2 3"/>`;
  for (const [pp, col] of [[p1, '#56b4e9'], [p2, '#e69f00']]) svg += `<circle cx="${tx + pp[0] * sc}" cy="${ty + pp[1] * sc}" r="4" fill="${col}"/>`;
  for (const [bb, col] of [[a, '#56b4e9'], [b, '#e69f00']]) svg += `<path d="${path(G.orbitPts(bb, 180))}" fill="none" stroke="${col}" stroke-width=".8" opacity=".6"/>`;   // each Seldon's own orbit
  const arrows = (pts, col) => { let acc = 0, o = ''; for (let i = 1; i < pts.length; i++) { acc += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); if (acc > 45) { acc = 0; const x = tx + pts[i][0] * sc, y = ty + pts[i][1] * sc, ang = Math.atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0]) * 57.3; o += `<path d="M-4,-2.6L0,0L-4,2.6" transform="translate(${x},${y}) rotate(${ang})" stroke="${col}" fill="none" stroke-width="1"/>`; } } return o; };
  const lead = (r, col) => r.lead.length > 1 ? `<path d="${path(r.lead)}" fill="none" stroke="${col}" stroke-width="1.6" stroke-dasharray="1 3"/>` : '';   // coasting to it
  svg += `<clipPath id="c${ci}"><rect x="${tx}" y="${ty}" width="${W * sc}" height="${H * sc}"/></clipPath><g clip-path="url(#c${ci})">${lead(X.gt, '#ff5a4f')}${lead(X.et, '#b67dff')}<path d="${path(X.gt.path.flat())}" fill="none" stroke="#ff5a4f" stroke-width="1"/><path d="${path(X.et.path.flat())}" fill="none" stroke="#b67dff" stroke-width="1.3"/>${arrows(X.gt.path.flat(), '#ff5a4f')}${arrows(X.et.path.flat(), '#b67dff')}${X.hy ? X.hy.path.map((seg, i) => `<path d="${path(seg)}" fill="none" stroke="${X.hy.kinds[i] === 'gt' ? '#ff5a4f' : '#b67dff'}" stroke-width="1.6" stroke-dasharray="4 2.5" opacity=".9"/>`).join('') : ''}</g>`;   // cropped to the table, as on the TV
});
fs.writeFileSync(process.argv[3], `<svg xmlns="http://www.w3.org/2000/svg" width="${2 * W * sc + 10}" height="${Math.ceil(cases.length / 2) * (H * sc + 34) + 20}" style="background:#0a0d0d">${svg}</svg>`);
