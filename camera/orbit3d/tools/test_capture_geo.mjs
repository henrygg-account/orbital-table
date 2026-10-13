// node tools/test_capture_geo.mjs — the capture plans end with the chaser on the target (capture) or well clear of it (defend)
import * as G from '../capture-geo.js';
let bad = 0; const ok = (c, m) => { if (!c) { bad++; console.log('FAIL', m); } };
const TAU = Math.PI * 2;
for (const defend of [false, true]) for (const [r1, r2, same] of [[7000, 7000, true], [42164, 42164, true], [20000, 20000, true], [7000, 42164, false], [42164, 7000, false], [10000, 12000, false]])
  for (let k = 1; k < 12; k++) for (const dir of ['auto', 'up', 'down']) {
    if (!same && dir !== 'auto') continue;
    const th2 = TAU * k / 12 + .3, P = G.plan({ r1, r2, th1: .3, th2, same, dir, defend });
    const tag = `${defend ? 'def' : 'cap'} ${r1}/${r2} ${same ? 'same' : 'xfer'} ${dir} k${k}`;
    ok(P.Ttot > 0 && isFinite(P.Ttot), tag + ' Ttot');
    if (!defend) ok(P.sepEnd < 1, `${tag} sep ${P.sepEnd}`); else ok(P.sepEnd > 500, `${tag} miss ${P.sepEnd}`);
    if (same && dir !== 'up') ok(G.apsides(P.ch.segs[1].el)[0] > G.R_E + 50 || r1 > 30000, `${tag} perigee ${G.apsides(P.ch.segs[1].el)[0]}`);
  }
const P = G.plan({ r1: 7178, r2: 7178, th1: 0, th2: 1, same: true, dir: 'auto' });
console.log('LEO 57deg ahead:', P.dir, 'N', P.N, 'dv', (P.dvCh * 1000).toFixed(1), 'm/s', 'T', (P.Ttot / 3600).toFixed(1), 'h gain', P.gain.toFixed(1));
const cfg = { dry_kg: 200, us: { isp_s: 1000, accel_mm_s2: .5 }, them: { isp_s: 320 }, dro: { us: { dv: 6.7, days: 155.1 }, them: { dv: 3.45, days: 5.458 } } };
for (const [n, r, p] of [['geo', 42164, 'geo'], ['dro', 384400, 'dro']]) { const c = G.compare(r, cfg, p); console.log(n, 'us', c.us.dv.toFixed(2), c.us.prop.toFixed(0), 'kg', (c.us.time / 86400).toFixed(0), 'd | them', c.them.dv.toFixed(2), c.them.prop.toFixed(0), 'kg', (c.them.time / 3600).toFixed(1), 'h'); }
ok(Math.abs(G.rOfRho(G.rhoOfR(30000)) - 30000) < 1, 'rho round trip');
console.log(bad ? bad + ' failures' : 'ok'); if (typeof process !== 'undefined') process.exit(bad ? 1 : 0);   // also runs in a browser page (no node on the table's laptop)
