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
const check = (name, ok, detail) => { out.push({ name, ok: !!ok, detail }); };
async function section(name, fn) { try { await fn(); } catch (e) { check(name + ' (aborted)', false, String(e && e.message || e)); } }

await until(() => window.__t && T().modes && T().smooth['seldon-1'], 'the page to show the stub feed');

await section('freeze', async () => {
  await post({ mode: 'geo', freeze: false, play: true, t: null }); await stub({ move: true });
  await until(() => T().SHOW.mode === 'geo' && !T().SHOW.freeze, 'geo, unfrozen'); await sleep(1500);
  const w0 = drawn('seldon-1'); await sleep(1500); const w1 = drawn('seldon-1');
  check('moving piece is followed before freeze', d2(w0, w1) > 8, `moved ${d2(w0, w1).toFixed(1)} mm in 1.5 s`);
  await post({ freeze: true }); await until(() => T().SHOW.freeze, 'freeze to reach the page'); await sleep(800);
  const f0 = drawn('seldon-1'), s0 = (await stub()).s1; await sleep(3000); const f1 = drawn('seldon-1'), s1 = (await stub()).s1;
  check('stub piece kept moving during the freeze', d2(s0, s1) > 15, `stub moved ${d2(s0, s1).toFixed(1)} mm`);
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
  await post({ mode: 'geo', zoom: 0.5 }); await until(() => T().SHOW.zoom === 0.5, 'zoom 0.5'); await sleep(800);
  const ts = T().modes.testState; check('zoom 0.5: LEO stays clear of the Earth piece', ts.rho.leo >= 60 && ts.geoView.leoMm >= 60 && Math.abs(ts.geoView.geoMm - 125) < .01, `capture LEO ${ts.rho.leo} mm, geo LEO ${ts.geoView.leoMm} / GEO ${ts.geoView.geoMm} mm`);
  await post({ zoom: 1 }); await until(() => T().SHOW.zoom === 1, 'zoom back to 1');
});
await section('LEO TO DRO scale', async () => {
  const G = await import('/orbits-geo.js'), maps = G.makeMaps([230, 400], [1200, 400], { ...G.SCALE, view: G.DRO_VIEW }), E = maps.E;
  check('LEO TO DRO: LEO and GEO enlarged (66 / 180 mm)', Math.abs(E.rho(G.R_LEO) - 66) < .01 && Math.abs(E.rho(G.R_GEO) - 180) < .01, `LEO ${E.rho(G.R_LEO).toFixed(1)} mm, GEO ${E.rho(G.R_GEO).toFixed(1)} mm`);
  check('LEO TO DRO: a piece reads back the orbit it is drawn on', [100, 150, 300, 600].every(q => Math.abs(E.rho(E.r(q)) - q) < .01), 'rho -> r -> rho');
  check('LEO TO DRO: the Moon is still at the Moon', Math.abs(E.rho(G.D_EM) - 970) < .5, `${E.rho(G.D_EM).toFixed(1)} mm`);
});
check('no errors on the page in any mode', !pageErrors.length, pageErrors.slice(0, 3).join(' | ') || 'none');
await J('/result', out);
