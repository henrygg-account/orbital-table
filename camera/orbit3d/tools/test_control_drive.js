// Runs inside demo.html (injected by test_control.py, page opened with ?testhook): drives the show state through the stub live.py and
// checks what the page draws. Reports to POST /result. Time-based waits only (headless software WebGL runs few frames per second).
const sleep = ms => new Promise(r => setTimeout(r, ms));
const J = (url, body) => fetch(url, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }).then(r => r.json());
const post = patch => J('/show', patch), stub = patch => J('/stub', patch);
const T = () => window.__t();
const clk = k => T().modes.testState[k];
const drawn = k => { const s = T().smooth[k]; return s ? [s.x, s.y] : null; };
const d2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
async function until(cond, what, ms = 60000) { const t0 = performance.now(); while (performance.now() - t0 < ms) { try { if (cond()) return true; } catch {} await sleep(50); } throw new Error('timed out waiting for ' + what); }
const out = [];
const pageErrors = []; addEventListener('error', e => pageErrors.push(String(e.message)));   // anything a mode throws while drawing
const say = o => fetch('/progress', { method: 'POST', body: JSON.stringify(o) }).catch(() => {});   // live progress: test_control.py prints it as it comes
const check = (name, ok, detail) => { const r = { name, ok: !!ok, detail }; out.push(r); say({ check: r }); };
async function section(name, fn) { say({ section: name }); try { await fn(); } catch (e) { check(name + ' (aborted)', false, String(e && e.message || e)); } }

say({ section: 'page loaded' });
await until(() => window.__t && T().modes && T().smooth['seldon-1'], 'the page to show the stub feed');

await section('freeze', async () => {
  await post({ mode: 'geo', freeze: false, play: true, t: null }); await stub({ move: true });
  await until(() => T().SHOW.mode === 'geo' && !T().SHOW.freeze, 'geo, unfrozen'); await sleep(1500);
  let w = drawn('seldon-1'), moved = 0; for (let i = 0; i < 10; i++) { await sleep(150); const q = drawn('seldon-1'); moved += d2(w, q); w = q; }   // (the path travelled: two samples a quarter sweep apart can land close either side of a turn)
  check('moving piece is followed before freeze', moved > 8, `moved ${moved.toFixed(1)} mm in 1.5 s`);
  await post({ freeze: true }); await until(() => T().SHOW.freeze, 'freeze to reach the page'); await sleep(800);
  // the stub's path length over the 3 s (two samples half a 6 s sweep apart can land in the same place either side of a turn)
  const f0 = drawn('seldon-1'); let path = 0, sp = (await stub()).s1;
  for (let i = 0; i < 10; i++) { await sleep(300); const q = (await stub()).s1; path += d2(sp, q); sp = q; }
  const f1 = drawn('seldon-1');
  check('stub piece kept moving during the freeze', path > 15, `stub travelled ${path.toFixed(1)} mm`);
  check('frozen: drawn piece stays put', d2(f0, f1) < 0.5, `drawn moved ${d2(f0, f1).toFixed(2)} mm in 3 s`);
  await post({ freeze: false }); await until(() => !T().SHOW.freeze, 'unfreeze'); await sleep(1500);
  const u0 = drawn('seldon-1'); await sleep(1200); const u1 = drawn('seldon-1'), st = (await stub()).s1;
  check('unfrozen: drawn piece moves again', d2(u0, u1) > 5, `moved ${d2(u0, u1).toFixed(1)} mm in 1.2 s`);
  check('unfrozen: drawn piece follows the stub piece', d2(u1, st) < 40, `${d2(u1, st).toFixed(1)} mm from the stub`);
});

await section('reset (capture film)', async () => {
  await stub({ move: false }); await post({ mode: 'capture', play: true, t: null, freeze: false });
  await until(() => T().SHOW.mode === 'capture', 'capture mode');
  await until(() => clk('capture') > 1.5, 'the film to be 1.5 s in'); const c1 = clk('capture');
  const n0 = (await J('/show')).reset; await post({ reset: true });
  await until(() => T().SHOW.reset === n0 + 1, 'the reset to reach the page');
  await until(() => clk('capture') < c1 - 1, 'film clock to drop', 3000);
  const c2 = clk('capture'); check('reset: film time goes back near 0', c2 < 1, `${c1.toFixed(2)} s -> ${c2.toFixed(2)} s`);
  await until(() => clk('capture') > c2 + 0.5, 'the film to run again'); check('reset: film plays again', true, `${clk('capture').toFixed(2)} s`);
});

// pause holds the clock; seek puts it at lead + f * speed (once); play carries on from there
async function filmPause(mode) {
  const lead = T().modes.testState.lead[mode], speed = T().modes.testState.speed[mode];
  await post({ mode, play: true, t: null }); await until(() => T().SHOW.mode === mode && clk(mode) > 0.5, mode + ' film running');
  await post({ play: false }); await until(() => !T().SHOW.play, 'pause'); await sleep(500);
  const a = clk(mode); await sleep(2500); const b = clk(mode);
  check(mode + ': paused film holds its frame', Math.abs(b - a) < 0.01, `${a.toFixed(3)} -> ${b.toFixed(3)}`);
  await post({ play: false, t: 0.5 }); await until(() => Math.abs(clk(mode) - (lead + 0.5 * speed)) < 0.05, 'seek 0.5');
  await sleep(1500); check(mode + ': seek 0.5 lands mid-film and holds', Math.abs(clk(mode) - (lead + 0.5 * speed)) < 0.05, `${clk(mode).toFixed(2)} s (want ${(lead + 0.5 * speed).toFixed(2)})`);
  await post({ t: 0.9 }); await until(() => Math.abs(clk(mode) - (lead + 0.9 * speed)) < 0.05, 'seek 0.9');
  const s = clk(mode); await post({ play: true, t: null }); await until(() => T().SHOW.play, 'play'); await until(() => clk(mode) > s + 0.3, 'film to play on', 15000);
  check(mode + ': play continues from the scrubbed frame', true, `${s.toFixed(2)} -> ${clk(mode).toFixed(2)} s`);
}
await section('pause/seek capture', () => filmPause('capture'));
await section('pause/seek competitor', () => filmPause('competitor'));

// geo / dro: the transfer draws out (0..1) and the dots ride; pause holds both, seek sets the drawn fraction
async function gdPause(mode) {
  await post({ mode, play: true, t: null }); await until(() => T().SHOW.mode === mode && T().modes.testState.geoDraw > 0.02, mode + ' transfer being drawn', 60000);
  await post({ play: false }); await until(() => !T().SHOW.play, 'pause'); await sleep(500);
  const a = T().modes.testState; await sleep(2500); const b = T().modes.testState;
  check(mode + ': paused transfer and dot hold', Math.abs(b.geoDraw - a.geoDraw) < 1e-6 && Math.abs(b.geoAng - a.geoAng) < 1e-6, `draw ${a.geoDraw.toFixed(3)} -> ${b.geoDraw.toFixed(3)}, dot ${a.geoAng.toFixed(3)} -> ${b.geoAng.toFixed(3)}`);
  await post({ play: false, t: 0.6 }); await until(() => Math.abs(T().modes.testState.geoDraw - 0.6) < 1e-6, 'seek 0.6'); await sleep(1500);
  check(mode + ': seek 0.6 draws 60% and holds', Math.abs(T().modes.testState.geoDraw - 0.6) < 1e-6, `draw ${T().modes.testState.geoDraw.toFixed(3)}`);
  await post({ play: true, t: null }); await until(() => T().modes.testState.geoDraw > 0.62, 'the transfer to draw on', 30000);
  check(mode + ': play continues from the scrubbed frame', true, `draw ${T().modes.testState.geoDraw.toFixed(3)}`);
}
await section('pause/seek geo', () => gdPause('geo'));
await section('pause/seek dro', () => gdPause('dro'));

await section('space key', async () => {
  await post({ play: true, t: null }); await until(() => T().SHOW.play, 'play');
  dispatchEvent(new KeyboardEvent('keydown', { key: ' ' })); await until(() => !T().SHOW.play, 'Space to pause');
  dispatchEvent(new KeyboardEvent('keydown', { key: ' ' })); await until(() => T().SHOW.play, 'Space to play');
  check('Space toggles pause / play', true, '');
});

// true scale: a Seldon touching the Earth disc (disc radius + 33 mm base + margin) is in LEO; beyond that the altitude grows from 400 km
await section('true-scale LEO', async () => {
  const G = await import('/orbits-geo.js'), k = 1088 / G.D_EM, foot = 36, maps = G.makeTrueMaps([150, 400], [1238, 400], { noZone: true, foot });
  const alt = d => { const b = G.bodyAt(maps, 150 + d, 400); return b.r - G.R_E; };
  const touch = G.R_E * k + 33 + 2;
  check('true scale: Seldon touching Earth is in LEO', Math.abs(alt(touch) - 400) < 1, `${alt(touch).toFixed(0)} km at ${touch.toFixed(1)} mm`);
  check('true scale: inside the footprint is still LEO', Math.abs(alt(G.R_E * k + 5) - 400) < 1, `${alt(G.R_E * k + 5).toFixed(0)} km`);
  const far = alt(G.R_E * k + foot + 100); check('true scale: altitude grows from the footprint at true scale', Math.abs(far - (400 + 100 / k)) < 5, `${far.toFixed(0)} km for 100 mm beyond (want ${(400 + 100 / k).toFixed(0)})`);
  check('true scale: the GEO ring is drawn at true scale', Math.abs(maps.E.rho(G.R_GEO) - G.R_GEO * k) < 0.01, `${maps.E.rho(G.R_GEO).toFixed(1)} mm`);
  check('true scale: the LEO ring is drawn at true scale (just above the disc)', Math.abs(maps.E.rho(G.R_LEO) - G.R_LEO * k) < 0.01, `${maps.E.rho(G.R_LEO).toFixed(2)} mm, disc ${(G.R_E * k).toFixed(2)} mm`);
  { const b = G.bodyAt(maps, 150 + touch, 400); check('true scale: a Seldon touching Earth is drawn on the true LEO ring', Math.abs(b.rho - G.R_LEO * k) < 0.01, `${b.rho.toFixed(2)} mm`); }
});

await section('zoom', async () => {
  await post({ mode: 'capture', zoom: 1.5 }); await until(() => T().SHOW.zoom === 1.5, 'zoom to reach the page'); await sleep(800);
  const M = T().modes;
  check('zoom 1.5: CAPTURE / COMPETITOR radii scale', M.zoom === 1.5 && Math.abs(M.testState.rho.geo - 265 * 1.5) < .01, `zoom ${M.zoom}, GEO at ${M.testState.rho.geo} mm`);
  await post({ mode: 'geo', zoom: 0.6 }); await until(() => T().SHOW.zoom === 0.6, 'zoom 0.6'); await sleep(800);   // (Oct 26: LEO TO GEO has one scale; a zoom saved in show.json must not stick)
  const ts = T().modes.testState; check('zoom 0.6: LEO TO GEO keeps its one scale (LEO 100, GEO 500 mm)', ts.geoView.leoMm === 100 && ts.geoView.geoMm === 500, `geo LEO ${ts.geoView.leoMm} / GEO ${ts.geoView.geoMm} mm`);
  await post({ zoom: 1 }); await until(() => T().SHOW.zoom === 1, 'zoom back to 1');
});
await section('LEO TO DRO scale', async () => {
  const G = await import('/orbits-geo.js'), maps = G.makeMaps([230, 400], [1200, 400], { ...G.SCALE, view: G.DRO_VIEW }), E = maps.E;
  check('LEO TO DRO: LEO and GEO enlarged (66 / 180 mm)', Math.abs(E.rho(G.R_LEO) - 66) < .01 && Math.abs(E.rho(G.R_GEO) - 180) < .01, `LEO ${E.rho(G.R_LEO).toFixed(1)} mm, GEO ${E.rho(G.R_GEO).toFixed(1)} mm`);
  check('LEO TO DRO: a piece reads back the orbit it is drawn on', [100, 150, 300, 600].every(q => Math.abs(E.rho(E.r(q)) - q) < .01), 'rho -> r -> rho');
  check('LEO TO DRO: the Moon is still at the Moon', Math.abs(E.rho(G.D_EM) - 970) < .5, `${E.rho(G.D_EM).toFixed(1)} mm`);
});
await section('recalibrate from the phone', async () => {
  const n0 = (await stub()).calibrations; await post({ calib: true });
  const t0 = performance.now(); let n = n0; while (performance.now() - t0 < 8000 && n === n0) { await sleep(300); n = (await stub()).calibrations; }
  check('show.calib bump: the TV page runs its marker calibration', n === n0 + 1, `/calibrate called ${n - n0} time(s)`);
});
// the phone's Path (off / GEO / Seldon-2 / DRO) and Engine (ET / GT): show.path, show.engine. Stub: Earth (230, 400), Seldon-1 parked
// 120 mm out, Seldon-2 200 mm out (LEO TO GEO: GEO at 250 mm, so Seldon-2 is not on it), the Moon at (1200, 400)
await section('transfer path from the phone', async () => {
  const gd = () => T().modes.testState.gd, shown = () => T().modes.testState.pathShown, rail = () => document.querySelector('.rail').textContent.replace(/[^ -~]/g, '?');   // (ASCII: the test prints it to a cp1252 console)
  const hero = dv => Math.round(dv * 1000).toLocaleString('en-US'), R_GEO = 42164;   // (the table reads delta-v in m/s)
  const tfmt = s => s >= 730 * 86400 ? (s / 31557600).toFixed(1) : s >= 2 * 86400 ? (s / 86400).toFixed(1) : s >= 3600 ? (s / 3600).toFixed(1) : String(Math.max(1, Math.round(s / 60)));   // (the rails' time, modes.js fmtTp)
  const heroTxt = () => (document.querySelector('.rail .hero')?.textContent || '').replace(/[^ -~]/g, '?');
  const railBoxes = () => { const S = Math.min(innerWidth / 1428.5, innerHeight / 803.5), ox = (innerWidth - 1428.5 * S) / 2, oy = (innerHeight - 803.5 * S) / 2;   // the rails' hero and mets, table mm
    return [...document.querySelectorAll('.rail .hero, .rail .metric')].map(e => e.getBoundingClientRect()).filter(r => r.width).map(r => [(r.left - ox) / S, (r.top - oy) / S, (r.right - ox) / S, (r.bottom - oy) / S]); };
  // the path for target `tg` is drawn out, ends on that target's ring (prim: the body it orbits), and the rails carry its numbers
  const drawsTo = async (tg, prim, eng, what) => {   // (a pick resets the drawn fraction at once, so geoDraw > 0 with the engine on the page is the new path)
    await until(() => gd().target === tg && gd().engine === eng && gd().show && shown() && T().modes.testState.geoDraw > .02 && gd().n > 1, `the path to ${tg} (${eng}) to be drawn`, 45000);
    const g = gd(); check(`${what}: the path ends on its ring`, g.prim === prim && Math.abs(g.dRho) < 1, `${g.prim}, tip ${g.dRho.toFixed(2)} mm off the ring (r ${Math.round(g.toR)} km)`);
    const hit = g.pts.filter(p => p[1] < 24 || p[1] > 803.5 - 24 || railBoxes().some(([x0, y0, x1, y1]) => p[0] > x0 && p[0] < x1 && p[1] > y0 && p[1] < y1));
    const big = T().modes.mode === 'geo' && tg === 'geo' && T().modes.testState.geoView.geoMm > 803.5 / 2 - 24;   // (GEO 500 mm since Oct 26, owner: wider than the table is tall, a route to it leaves the table)
    check(`${what}: the path stays on the table, off the rails' numbers`, (big || !hit.length) && railBoxes().length >= 4, hit.length ? `${hit.length} points, e.g. ${hit[0].map(v => v.toFixed(0))} mm` : `${g.n} points, ${railBoxes().length} rail boxes`);
    // (owner, Oct 27) LEO TO GEO leads with the TIME, then its engine's ISP, the cumulative DELTA-V and FUEL; LEO TO DRO with the
    // cumulative DELTA-V so far, then the TIME TO DRO
    const ok = g.engine === 'hy' ? heroTxt().startsWith(hero(Math.max(0, g.full.dv - g.dv))) && rail().includes('cumulative') && rail().includes('TIME TO DRO' + tfmt(g.t))
      : heroTxt().startsWith(tfmt(g.t)) && rail().includes(`CUMULATIVE ?v${hero(g.dv)}`) && rail().includes(g.engine === 'gt' ? 'CHEMICAL ISP' : 'ELECTRIC ISP');
    check(`${what}: the rails give its numbers`, ok, `${hero(g.dv)} m/s, ${tfmt(g.t)} ${g.engine}: hero "${heroTxt()}", "${rail().slice(0, 90)}"`);
    await post({ t: 1 }); await until(() => T().modes.testState.geoDraw >= 1 && T().modes.testState.colors.length > 1, 'the path drawn out (seek 1)', 10000); await post({ t: null }); await sleep(300);
    const ts = T().modes.testState, want = (g.engine === 'hy' ? g.runs : [g.engine]).map(k => k === 'gt' ? 0xff5a4f : 0xb67dff);
    check(`${what}: drawn dashed in its engine colours (GT red, ET purple)`, want.every(c => ts.colors.includes(c)) && ts.colors.length === want.length + 1 && ts.dash.every(([d, gp, sc]) => !d || (d === 8 && gp === 5 && sc > .9 && sc < 1.1)),
      `colours ${ts.colors.map(c => c.toString(16)).join(', ')} (want ${want.map(c => c.toString(16)).join(', ')} + arrowhead), dashes ${JSON.stringify(ts.dash)}`);
    check(`${what}: over every orbit line, under the dots`, ts.layer.path > ts.layer.orbit && ts.layer.dot > ts.layer.path, JSON.stringify(ts.layer));
    return g;
  };
  await stub({ move: false, drop: [] }); await post({ mode: 'geo', path: 'off', engine: 'et', play: true, t: null, zoom: 1 }); await sleep(2500);
  check('LEO TO GEO: no transfer path unless the presenter picks one', !shown() && T().modes.path === 'off', `path ${shown() ? 'shown' : 'hidden'}`);
  // (owner, Oct 27: "it says days to target with path and reach off"; "only show ISP when either path or reach is on")
  { const s1 = (await stub()).s1, d = drawn('seldon-1');   // (owner, Oct 27: "altitude still moves slightly after lockin": the ease's tail never arrived)
    check('a still piece is drawn exactly where the feed has it (not creeping toward it)', d2(d, s1) === 0, `${d2(d, s1).toFixed(4)} mm off`); }
  check('path off (and reach off): the rails are empty, no title, no trip, no ISP (owner, Oct 27: "remove the leo to geo text")', !rail().trim(), `"${rail().slice(0, 60)}"`);
  await post({ path: 'geo' }); const et = await drawsTo('geo', 'E', 'et', 'path GEO, ET');
  check('path GEO: to GEO itself, not Seldon-2', Math.abs(et.toR - R_GEO) < 1, `r ${Math.round(et.toR)} km`);
  await post({ engine: 'gt' }); await until(() => T().modes.engine === 'gt', 'GT to reach the page');
  check('engine change: the path draws out again from the start', T().modes.testState.geoDraw < .1, `draw ${T().modes.testState.geoDraw.toFixed(3)}`);
  const gt = await drawsTo('geo', 'E', 'gt', 'path GEO, GT');
  check('GT and ET: different paths', Math.abs(gt.len - et.len) > 50, `GT ${gt.len.toFixed(0)} mm (${gt.n} pts), ET ${et.len.toFixed(0)} mm (${et.n} pts)`);
  check('GT and ET: different numbers', Math.abs(gt.dv - et.dv) > .02 && Math.abs(gt.mp - et.mp) > 5 && Math.abs(gt.t - et.t) > 3600, `GT ${gt.dv.toFixed(2)} km/s ${gt.mp.toFixed(0)} kg, ET ${et.dv.toFixed(2)} km/s ${et.mp.toFixed(0)} kg`);
  await post({ path: 'seldon-2' });
  const s2 = await drawsTo('seldon-2', 'E', 'gt', 'path Seldon-2, GT');
  check('path Seldon-2: to its orbit, below GEO', s2.toR < R_GEO - 1000, `r ${Math.round(s2.toR)} km`);
  // the phone's Isp (show.isp, Oct 26) prices the path: the same route, the FUEL it needs from the rocket equation on the dry mass
  { const mp = isp => 200 * (Math.exp(s2.dv * 1000 / (9.80665 * isp)) - 1);
    await post({ isp: { gt: 250 } }); await until(() => gd().mp && Math.abs(gd().mp - mp(250)) < .5, 'the path priced at GT Isp 250 s', 15000);
    check('path Isp: GT 250 s, the same route needs more fuel, the rails say so', Math.abs(gd().dv - s2.dv) < 1e-6 && gd().mp > s2.mp + 5 && rail().includes('250') && rail().includes(`${Math.round(mp(250))}kg`), `${gd().mp.toFixed(0)} kg (was ${s2.mp.toFixed(0)}): "${rail().slice(0, 70)}"`);
    await post({ isp: { gt: 320 } }); await until(() => Math.abs(gd().mp - s2.mp) < .5, 'GT Isp back to 320 s', 15000); }
  await stub({ drop: ['seldon-2'] }); await until(() => !T().pieces['seldon-2'], 'Seldon-2 off the table'); await sleep(1500);
  check('Seldon-2 picked but off the table: no path, the rails price GEO', !shown() && gd().target === 'geo' && T().modes.path === 'seldon-2', `path ${shown() ? 'shown' : 'hidden'}, rails for ${gd().target}`);
  await stub({ drop: [] }); await until(() => T().pieces['seldon-2'], 'Seldon-2 back');
  let s = await post({ path: 'dro', engine: 'et' }); check('picking DRO switches to LEO TO DRO', s.mode === 'dro' && s.path === 'dro', `${s.mode} / ${s.path}`);
  await until(() => T().modes.mode === 'dro', 'LEO TO DRO on the page');
  const de = await drawsTo('dro', 'M', 'hy', 'path DRO (engine ET)');
  check('DRO: the mission profile, chemical passes then electric', de.runs.join() === 'gt,et' && de.chem.n >= 1 && de.chem.n + de.elec.n <= 10 && Math.abs(de.chem.dv + de.elec.dv - de.dv) < 1e-9, `runs ${de.runs}, ${de.chem.n} + ${de.elec.n} passes, ${de.chem.dv.toFixed(2)} + ${de.elec.dv.toFixed(2)} = ${de.dv.toFixed(2)} km/s`);
  const d0 = T().modes.testState.geoDraw; await post({ engine: 'gt' }); await until(() => T().modes.engine === 'gt', 'GT to reach the page'); await sleep(800);
  const dg = gd(); check('DRO: the engine pick changes nothing (same route, not drawn again)', dg.engine === 'hy' && Math.abs(dg.len - de.len) < 1e-6 && dg.dv === de.dv && T().modes.testState.geoDraw >= Math.min(1, d0), `${dg.engine}, ${dg.len.toFixed(0)} vs ${de.len.toFixed(0)} mm, draw ${d0.toFixed(2)} -> ${T().modes.testState.geoDraw.toFixed(2)}`);
  // LEO TO DRO is the mission (owner, Oct 26: "we put seldon 1 and it completes the mission from there"): always the DRO, priced
  // with our figures (the phone's Isp is LEO TO GEO's); GEO picked goes to LEO TO GEO
  s = await post({ path: 'off' }); check('LEO TO DRO: the mission cannot be turned off', s.mode === 'dro' && s.path === 'dro', `${s.mode} / ${s.path}`);
  { const mp0 = gd().mp; await post({ isp: { gt: 200, et: 400 } }); await sleep(1500);
    check('LEO TO DRO: the phone\'s Isp changes nothing (our figures)', Math.abs(gd().mp - mp0) < 1e-6 && Math.abs(gd().mp - de.mp) < 1e-6, `${gd().mp.toFixed(1)} kg (was ${mp0.toFixed(1)})`);
    await post({ isp: { gt: 320, et: 1000 } }); }
  s = await post({ path: 'geo' }); check('GEO picked in LEO TO DRO: LEO TO GEO', s.mode === 'geo' && s.path === 'geo', `${s.mode} / ${s.path}`);
  s = await post({ mode: 'dro' }); check('back to LEO TO DRO: the mission again', s.path === 'dro', s.path); await until(() => T().modes.mode === 'dro', 'LEO TO DRO again');
  // LEO TO DRO: off LEO Seldon-1 is on one of the passes (owner, Oct 26: "just presume our orbit is already elliptical"), by the GEO
  // ring too ("in DRO mode do not lock to GEO or draw the green orbit"); right behind Earth it is circular
  const tag1 = () => T().modes.testState.s1Tag.replace(/[^ -~]/g, '?');   // (Seldon-1's label: no name on it since Oct 27, owner: "No need for labbels to say seldon 1")
  check('LEO TO DRO: the labels do not name the Seldons', ![...document.querySelectorAll('.mt-label')].some(e => e.style.display !== 'none' && /seldon/i.test(e.textContent)), `"${tag1()}"`);
  await stub({ s1_at: [412, 400] });
  // (Oct 26, owner: "in DRO mode do not lock to GEO or draw the green orbit") by the GEO ring it is on a pass like anywhere else, no ring of its own
  { const ok = await until(() => T().modes.path === 'dro' && gd().fromLock == null && gd().fromApo > 0 && gd().show, 'Seldon-1 by the GEO ring, on a pass', 8000).catch(() => false);
    check('LEO TO DRO: Seldon-1 by the GEO ring does not snap to GEO (it is on a pass)', ok, `${gd().fromLock}, apoapsis ${Math.round(gd().fromApo)} km, tag "${tag1()}"`);
    check('LEO TO DRO: no green orbit for Seldon-1 (the route is drawn from it)', T().modes.testState.s1Ring === false, `ring ${T().modes.testState.s1Ring}`); }
  check('DRO from a pass: the tag gives its apogee', /apogee/i.test(tag1()) && !/period/i.test(tag1()), `"${tag1()}"`);
  // the mission is drawn from LEO and undrawn behind Seldon-1 as it is moved out (owner, Oct 27: "designed for moving the satellite from
  // LEO to DRO basically left to right ... undrawing the path as it crosses"); the rails give what is left from where it is
  const settle = () => until(() => Math.abs(gd().cut - gd().cutTo) < .01, 'the cut to be wiped in (the headless page runs at a few frames a second)', 20000);
  await stub({ s1_at: [300, 400] }); await until(() => gd().fromLock === 'LEO' && gd().show && gd().n > 1, 'Seldon-1 in LEO', 15000); await sleep(1500); await settle();
  const g0 = gd();
  check('LEO TO DRO: from LEO, the whole route, priced whole', g0.cut < 1 && Math.abs(g0.dv - g0.full.dv) < 1e-9 && g0.full.chem.n >= 1 && shown(), `cut ${g0.cut.toFixed(1)} mm of ${g0.rlen.toFixed(0)}, ${hero(g0.dv)} m/s`);
  // (owner, Oct 27: "DRO mode sould say time to DRO ... and maybe current altitude"; "cumulative delta v")
  check('LEO TO DRO in LEO: cumulative delta-v 0, the whole TIME TO DRO, altitude 400 km', heroTxt().startsWith('0m/s cumulative') && rail().includes('TIME TO DRO' + tfmt(g0.t)) && rail().includes('ALTITUDE400km') && !rail().includes('DRO RADIUS'), `hero "${heroTxt()}", "${rail().slice(0, 90)}"`);
  const out = async (q, what) => { await stub({ s1_at: q }); await until(() => gd().fromLock !== 'LEO' && gd().cut > 1, what, 15000); await sleep(1500); await settle(); return gd(); };
  const g1 = await out([520, 330], 'Seldon-1 out on the passes');
  check('LEO TO DRO: moved out, the route stays the one from LEO', Math.abs(g1.len - g0.len) < 1e-6 && d2(g1.pts[0], g0.pts[0]) < 1e-6 && shown(), `${g1.len.toFixed(0)} vs ${g0.len.toFixed(0)} mm`);
  // (owner, Oct 27: "vertical movement shouldnt affect it and you should only undraw or redraw a circle if the seldon is clearly past it
  // from an X perspective"): whole loops, by the piece's distance along the Earth-Moon line (x, mm from Earth), 20 mm past an apoapsis
  const passed = x => g1.loops.filter(A => x > A + 20).length;
  check('LEO TO DRO: ...the loops it is clearly past undrawn, whole ones', g1.loopN >= 1 && g1.loopN === passed(290) && g1.cut > 200, `${g1.loopN} of ${g1.loops.length} loops (apoapses ${g1.loops.map(Math.round).join(', ')} mm out), cut ${g1.cut.toFixed(0)} mm`);
  const alt1 = Math.round(g1.fromR - 6378.1).toLocaleString('en-US');
  check('LEO TO DRO: ...the rails: the cumulative delta-v so far, the TIME TO DRO and the altitude from there', g1.dv < g0.dv - .5 && g1.mp < g0.mp && heroTxt().startsWith(hero(g1.full.dv - g1.dv) + 'm/s cumulative') && rail().includes('TIME TO DRO' + tfmt(g1.t)) && rail().includes(`ALTITUDE${alt1}km`),
    `${hero(g0.dv - g1.dv)} of ${hero(g0.dv)} m/s used, ${hero(g1.dv)} to go, altitude ${alt1} km: hero "${heroTxt()}", "${rail().slice(0, 90)}"`);
  { const at = async (q, n, what) => { await stub({ s1_at: q }); return until(() => gd().loopN === n && Math.abs(drawn('seldon-1')[0] - q[0]) < 1 && Math.abs(drawn('seldon-1')[1] - q[1]) < 1, what, 8000).then(() => true, () => false); };
    const ok1 = await at([520, 470], g1.loopN, 'the piece across the line');
    check('LEO TO DRO: moving the piece across the line changes nothing', ok1 && Math.abs(gd().cutTo - g1.cutTo) < 1e-9, `${gd().loopN} loops (was ${g1.loopN}), cut to ${gd().cutTo.toFixed(1)} (was ${g1.cutTo.toFixed(1)})`);
    const k = g1.loops.findIndex(A => A > 500), A = g1.loops[k], X = x => [230 + x, 400];   // (an electric loop: the next ones well apart)
    const s = [await at(X(A + 10), k, '10 mm past an apoapsis'), await at(X(A + 25), k + 1, '25 mm past it'), await at(X(A + 10), k + 1, 'back to 10 mm past'), await at(X(A - 25), k, '25 mm short of it')];
    check('LEO TO DRO: a loop goes only 20 mm past its apoapsis, and comes back only 20 mm short of it', s.every(Boolean), `loop ${k} (apoapsis ${A.toFixed(0)} mm): +10 kept ${s[0]}, +25 gone ${s[1]}, back to +10 still gone ${s[2]}, -25 back ${s[3]}; now ${gd().loopN}`); }
  const g2 = await out([1000, 400], 'Seldon-1 by the Moon');
  check('LEO TO DRO: farther out, more undrawn, more used and less left', g2.cut > g1.cut + 200 && g2.dv < g1.dv && Math.abs(g2.len - g0.len) < 1e-6 && shown() && heroTxt().startsWith(hero(g2.full.dv - g2.dv)), `cut ${g2.cut.toFixed(0)} mm, ${hero(g2.dv)} m/s to go, hero "${heroTxt()}"`);
  await stub({ s1_at: [1150, 400] }); await until(() => gd().fromLock === 'DRO' && !shown(), 'Seldon-1 in the DRO, the route all undrawn', 15000).catch(() => false);
  { const ts = T().modes.testState;   // (owner, Oct 27: "DRO orbit shouldnt go away when we reach it it should lock")
    check('LEO TO DRO: in the DRO, the route is gone, the DRO stays with Seldon-1 locked on it, the rails say so', gd().fromLock === 'DRO' && !shown() && ts.droRing && ts.s1Dot && !ts.s1Ring && rail().includes('IN THE DRO') && heroTxt().startsWith(hero(g0.full.dv) + 'm/s cumulative'),
      `${gd().fromLock}, path ${shown() ? 'shown' : 'gone'}, DRO ring ${ts.droRing}, dot ${ts.s1Dot}, hero "${heroTxt()}", "${rail().slice(0, 60)}"`); }
  await stub({ s1_at: [100, 400] }); await until(() => gd().fromLock == null && gd().fromApo == null && shown(), 'Seldon-1 behind Earth', 15000); await sleep(1500); await settle();
  const g5 = gd();
  check('LEO TO DRO: behind Earth (past the LEO band), the whole route to go, chemical then electric, no apogee', g5.cut < 1 && g5.chem.n >= 1 && rail().includes('TIME TO DRO' + tfmt(g5.t)) && !/apogee/i.test(tag1()), `cut ${g5.cut.toFixed(1)} mm, ${g5.chem.n} + ${g5.elec.n} passes, tag "${tag1()}"`);
  await stub({ s1_at: [300, 400] }); await until(() => gd().fromLock === 'LEO' && gd().cut < 1 && shown(), 'back in LEO, the whole route', 15000).catch(() => false);
  check('LEO TO DRO: back in LEO, the whole route again', gd().fromLock === 'LEO' && gd().cut < 1 && shown(), `cut ${gd().cut.toFixed(1)} mm`);
  await post({ path: 'dro' });
  await stub({ s1_at: null }); await until(() => gd().show && shown(), 'the path back', 15000);
  s = await post({ path: 'seldon-2' }); check('picking Seldon-2 switches to LEO TO GEO', s.mode === 'geo' && s.path === 'seldon-2', `${s.mode} / ${s.path}`);
  await post({ path: 'dro' }); s = await post({ mode: 'geo' }); check('a mode switch clears a target it cannot show (DRO in LEO TO GEO)', s.path === 'off', s.path);
  await until(() => T().modes.mode === 'geo' && T().modes.path === 'off', 'path off on the page'); await sleep(800);
  check('...and the table shows no path', !shown(), '');
  s = await post({ mode: 'dro', transfer: true }); check('the old transfer: true still works (the DRO in LEO TO DRO)', s.path === 'dro', s.path);
  await drawsTo('dro', 'M', 'hy', 'old transfer: true');
  s = await post({ transfer: false }); check('...and transfer: false leaves the mission on in LEO TO DRO', s.path === 'dro', s.path);
  await post({ mode: 'geo', path: 'off' }); await until(() => T().SHOW.mode === 'geo' && T().SHOW.path === 'off', 'LEO TO GEO, path off');
  dispatchEvent(new KeyboardEvent('keydown', { key: 'p' })); await until(() => T().SHOW.path === 'geo', 'P: the first target');
  dispatchEvent(new KeyboardEvent('keydown', { key: 'p' })); await until(() => T().SHOW.path === 'seldon-2', 'P: the next target');
  dispatchEvent(new KeyboardEvent('keydown', { key: 'p' })); await until(() => T().SHOW.path === 'off', 'P: back to off');
  const e0 = T().SHOW.engine; dispatchEvent(new KeyboardEvent('keydown', { key: 'g' })); await until(() => T().SHOW.engine !== e0, 'G: the other engine');
  check('keys: P cycles the targets the mode draws, G the engine', true, `engine ${e0} -> ${T().SHOW.engine}`);
  await post({ mode: 'geo', path: 'off', engine: 'et' });
});
// Oct 25: Earth on the table, no Seldon, then a zoom change: the transfer code reused an old path with no Seldon and threw,
// which stopped the TV's frame loop (it kept showing its last frame)
// the phone's Reach (show.reach, Oct 26): the table shades what one tank reaches, electric vs chemical on the same tank, and the rails
// give both tanks' DELTA-V; off again, it all goes
await section('reach from the phone', async () => {
  const rx = () => T().modes.testState.reach, rail = () => document.querySelector('.rail').textContent.replace(/[^ -~]/g, '?');
  await stub({ s1_at: [350, 400] }); await post({ mode: 'geo', path: 'off', reach: true });
  await until(() => rx().shown && rail().includes('TANK'), 'the reach bands', 30000);
  const gv = T().modes.testState.geoView, geoRho = km => gv.leoMm + (km - 6778.1) * (gv.geoMm - gv.leoMm) / (42164 - 6778.1);   // (its edge labelled where it is on the table)
  const r = rx(); check('reach on: both bands, electric reaching farther than chemical', r.et && r.gt && (!isFinite(r.et.hi) || r.et.hi > r.gt.hi) && r.on === 'et' && (r.lbl || !isFinite(r.et.hi) || geoRho(r.et.hi) > 803.5 / 2), `electric to ${!isFinite(r.et.hi) ? 'escape' : Math.round(r.et.hi) + ' km'}, chemical to ${!isFinite(r.gt.hi) ? 'escape' : Math.round(r.gt.hi) + ' km'}`);
  // (owner, Oct 27: "remove the reaches and same tank numbers"): its engine's tank DELTA-V, its ISP and the tank only
  const m = dv => Math.round(dv * 1000).toLocaleString('en-US');
  check('reach on: the rails give its engine\'s tank, ISP and tank only', rail().startsWith(m(rx().et.dv)) && rail().includes('ELECTRIC ISP') && rail().includes('TANK') && !/SAME TANK|REACHES|CHEMICAL/.test(rail()) && !rail().includes(m(rx().gt.dv)), `"${rail().slice(0, 80)}"`);
  await post({ reach: 'gt' }); await until(() => rx().on === 'gt' && rail().includes('chemical'), 'the chemical reach map', 15000);
  check('reach GT: its own map, the rails give the chemical tank', rx().shown && rx().edge.join() === 'gt' && rail().startsWith(m(rx().gt.dv)) && rail().includes('CHEMICAL ISP') && !rail().includes('ELECTRIC'), `edges ${rx().edge}: "${rail().slice(0, 60)}"`);
  // (owner, Oct 27: "reach is kind of glitchy when seldon 1 is far from earth on ET"): far out its rings run in toward LEO (the outward
  // ones are off the table there), and they stay while Seldon-1 moves (they had blinked off with it)
  await post({ reach: 'et' }); await stub({ s1_at: [680, 400] }); await until(() => rx().on === 'et' && rx().shown, 'electric reach far out', 15000); await sleep(1500);
  { const far = rx().iso; await stub({ move: true }); const mv = []; for (let i = 0; i < 8; i++) { await sleep(250); mv.push(rx().iso); } await stub({ move: false, s1_at: [350, 400] });
    check('reach far out on electric: its 1,000 m/s rings in toward LEO, and they stay while Seldon-1 moves', far >= 2 && mv.every(n => n > 0), `${far} rings with Seldon-1 450 mm out; while it moves ${mv.join(' ')}`); }
  // (owner, Oct 27: "reach and path cant be on same time no reach in DRO mode on phone")
  { const s1 = await post({ mode: 'dro', reach: 'et' }); await until(() => T().modes.mode === 'dro', 'LEO TO DRO', 30000); await sleep(1000);
    check('no reach in LEO TO DRO', s1.reach === 'off' && !rx().shown, `show.reach ${s1.reach}, shaded ${rx().shown}`); }
  { await post({ mode: 'geo', path: 'off', reach: 'et' }); const s2 = await post({ path: 'geo' }), s3 = await post({ reach: 'gt' });
    check('reach and a path are never on together (the one turned on wins)', s2.path === 'geo' && s2.reach === 'off' && s3.reach === 'gt' && s3.path === 'off', `path on: ${s2.path} / reach ${s2.reach}; reach on: ${s3.path} / reach ${s3.reach}`); }
  // the phone's Isp / tank sliders (show.isp, show.tank): the map's tank DELTA-V follows (g0 Isp ln((200 + tank) / 200))
  await post({ mode: 'geo', reach: 'et', isp: { et: 800 }, tank: 300 }); const dv3 = 9.80665 * 800 * Math.log(500 / 200) / 1000;
  await until(() => rx().et && Math.abs(rx().et.dv - dv3) < .01 && rail().includes('800s'), 'the sliders to reach the map', 15000);
  check('reach sliders: Isp 800 s and a 300 kg tank set the map and the rails', Math.abs(rx().et.dv - dv3) < .01 && rail().includes(Math.round(dv3 * 1000).toLocaleString('en-US')) && rail().includes('300kg'), `${rx().et.dv.toFixed(2)} km/s: "${rail().slice(0, 70)}"`);
  await post({ isp: { et: 1000 }, tank: 325 }); await until(() => rx().et && Math.abs(rx().et.dv - 9.80665 * Math.log(525 / 200)) < .01, 'the sliders back (the 325 kg tank, owner Oct 27)', 15000);
  await post({ reach: false, mode: 'geo' }); await until(() => !rx().shown, 'the bands to go', 15000); check('reach off: the bands go', !rx().shown && !rail().includes('TANK'), `"${rail().slice(0, 60)}"`);
});
// LEO TO DRO keeps its route drawn while Seldon-1 moves (owner, Oct 26: "keep the transit drawn at all times and update it as seldon 1
// moves around"): drawn out once; then, out of LEO, the route stays put and is undrawn up to the piece as it goes (Oct 27)
await section('LEO TO DRO live route', async () => {
  const gd = () => T().modes.testState.gd;
  await post({ mode: 'geo', path: 'off' }); await until(() => T().modes.mode === 'geo', 'LEO TO GEO first');
  await stub({ move: true }); await post({ mode: 'dro', reach: 'off' }); const seq = [];   // (as a refresh: the route new, Seldon-1 seen moving at first)
  // (owner, Oct 27: "it disappears completely when moving now": it hid while a piece moved until its first draw-out was done, and
  // started that again with every move) it draws out while the piece moves, gradually, and stays once it is there
  for (let i = 0; i < 40; i++) { await sleep(150); seq.push({ on: T().modes.testState.pathShown, d: T().modes.testState.geoDraw }); }
  const first = seq.findIndex(q => q.on), stays = first >= 0 && seq.slice(first).every(q => q.on), mid = seq.some(q => q.on && q.d > .02 && q.d < .9);
  await stub({ move: false, s1_at: [600, 550] });
  check('LEO TO DRO: a new route (a refresh) draws out while Seldon-1 moves, gradually, and does not go away', T().modes.mode === 'dro' && stays && mid,
    `shown from sample ${first} of 40, stays ${stays}, seen part-drawn ${mid}, draw ${seq.map(q => q.d.toFixed(2)).filter((_, i) => i % 5 === 0).join(' ')}`);
  await post({ mode: 'geo', path: 'off' }); await until(() => T().modes.mode === 'geo', 'LEO TO GEO'); await post({ mode: 'dro' });
  const ok0 = await until(() => T().modes.mode === 'dro' && gd().show && T().modes.testState.geoDraw >= 1, 'the route drawn out', 40000).catch(() => false);
  check('LEO TO DRO: the route draws out once', ok0, `mode ${T().modes.mode}, show ${gd().show}, target ${gd().target}, path ${T().modes.path}, draw ${T().modes.testState.geoDraw}, from ${gd().fromLock} r ${Math.round(gd().fromR)}`);
  await stub({ move: true }); const seen = [];
  for (let i = 0; i < 12; i++) { await sleep(250); const g = gd(); seen.push({ on: T().modes.testState.pathShown, draw: T().modes.testState.geoDraw, cut: g.cut, len: g.len, p0: g.pts?.[0] }); }
  const cuts = seen.map(q => q.cut), moved = Math.max(...cuts) - Math.min(...cuts), same = seen.every(q => q.p0 && Math.abs(q.len - seen[0].len) < 1e-6 && d2(q.p0, seen[0].p0) < 1e-6);
  check('LEO TO DRO: a moving Seldon-1 keeps the route drawn; it stays put and is undrawn up to the piece as it goes', seen.every(q => q.on && q.draw >= 1) && same && moved > 30, `shown ${seen.filter(q => q.on).length}/12, drawn ${seen.map(q => q.draw.toFixed(1)).join(' ')}, route the same ${same}, the cut moved over ${moved.toFixed(0)} mm`);
  await stub({ move: false }); await post({ mode: 'geo', path: 'off' });
});
await section('Earth only, zoom changed', async () => {
  await post({ mode: 'geo', zoom: 1, freeze: false, play: true, t: null }); await sleep(1500);   // a transfer drawn (both Seldons)
  const e0 = pageErrors.length;   // the Seldons go and the zoom changes in one feed message (as when the TV page loads)
  await Promise.all([stub({ earth_only: true }), post({ zoom: 0.6 })]); await until(() => T().SHOW.zoom === 0.6, 'zoom 0.6'); await sleep(1500);
  const f0 = T().frames; await sleep(1000);
  check('Earth only + zoom: no error, and the page keeps drawing', pageErrors.length === e0 && T().frames > f0, `${pageErrors.length - e0} error(s): ${pageErrors.slice(e0).join(' | ').slice(0, 160)}`);
  await stub({ earth_only: false }); await post({ zoom: 1 });
});
check('no errors on the page in any mode', !pageErrors.length, pageErrors.slice(0, 3).join(' | ') || 'none');
await J('/result', out);
