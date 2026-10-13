// modes.js — ORBITS (kiosk, default) / ENGAGEMENT / DELTA-V MAP / MISSION display modes for the orbital table (INTERCEPT archived).
// Coordinates: TV mm, origin top-left, y down; world = (x, -y).
//
//   const modes = createModes({ THREE, scene, line, put, getScale: () => S, get SW(){...}, get SH(){...},
//                               end: 'right'|'left', initialMode, missionUrl, onModeChange })
//   modes.update(pieces, dt, nowMs)   // pieces: { earth, moon, 'seldon-1', 'seldon-2', chip } each {x_mm,y_mm}
//   modes.setMode(name) ; modes.mode ; modes.onLayout() ; modes.boxRect(i)
//
// Design (see DESIGN.md): a map anchored to the pieces; two mirrored edge rails; chip boxes + lockup at the
// presenter's end; one delta-v floor under every mode (strength per mode); brand tokens from gg-table.css.

const MU_E = 398600.4418, MU_M = 4902.8, R_E = 6378.1, R_M = 1737.4, L_KM = 384400;
const R_LEO = R_E + 400, GEO_R = 42164, MOON_SOI = 66100;
const EARTH_PIECE_R = 33, MOON_PIECE_R = 33;             // 66 mm bases
const TRUE_FOOT = 33 + 3;   // true scale: Seldon base radius + margin; within Earth's disc + this a Seldon is in LEO (makeTrueMaps)
const SELDON_BASE_R = 33;                                 // a Seldon can't sit closer to Earth than the two bases touching
const MODE_NAMES = ['mission', 'intercept', 'dvmap', 'engage', 'orbits', 'geo', 'dro', 'capture', 'competitor'];
const GROUP = { geo: 'orbits', dro: 'orbits' };            // geo and dro draw with the orbits view's items
const ARCHIVED = new Set(['intercept']);                   // kept in the code, not reachable (not even by ?mode=)
const MODE_TITLES = ['MISSION', 'INTERCEPT', 'DELTA-V MAP', 'ENGAGEMENT', 'ORBITS', 'LEO TO GEO', 'LEO TO DRO', 'CAPTURE / DEFEND', 'COMPETITOR'];   // 'engage' = the sim-backed advanced CAPTURE / DEFEND (setOpts('capture', {sim: true}))
const C = { mint: 0x0ee3a6, mint300: 0x6ff5cf, mint900: 0x063f30, white: 0xf6f8f8, fog100: 0xdde3e4, fog200: 0xb8c1c3, fog300: 0x8a969a, fog400: 0x5c6b70, ink900: 0x0d1113, black: 0x0a0d0d };
const BG = C.black;
const MARG = 24;                                          // safe margin, mm
const BOX = 64, GAP = 10;                                 // chip boxes
const RAIL_H = 56;                                        // edge rail height, mm
const TAU = Math.PI * 2;

const fmtHM = sec => { const m = Math.round(sec / 60); return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} m`; };
const num = (v, d = 2) => v.toFixed(d);
const U = s => `<i>${s}</i>`;                             // small lower-case unit after a number

// ---- orbital helpers ----
function hohmann(r1, r2) {
  const a = (r1 + r2) / 2;
  const dv1 = Math.abs(Math.sqrt(MU_E * (2 / r1 - 1 / a)) - Math.sqrt(MU_E / r1));
  const dv2 = Math.abs(Math.sqrt(MU_E / r2) - Math.sqrt(MU_E * (2 / r2 - 1 / a)));
  return { dv1, dv2, total: dv1 + dv2, tof: Math.PI * Math.sqrt(a ** 3 / MU_E), a };
}
const V_MOONORB = Math.sqrt(MU_E / L_KM);
// low-thrust (Edelbaum, coplanar, circular-to-circular, phasing ignored) delta-v between two orbits.
// Each point is {r: km from Earth, d: km from Moon, w: Moon-side weight 0..1}.
const SOI_BLEND = 25000;                                  // km over which the Earth- and Moon-centred cost models blend
const moonW = d => { if (d >= MOON_SOI) return 0; if (d <= MOON_SOI - SOI_BLEND) return 1; const t = (MOON_SOI - d) / SOI_BLEND; return t * t * (3 - 2 * t); };
const vE = r => Math.sqrt(MU_E / r), vM = d => Math.sqrt(MU_M / Math.max(d, R_M));
const LEO_ORIGIN = { r: R_LEO, d: L_KM, w: 0 };
const mkPt = (r, d) => ({ r, d, w: moonW(d) });
function dvCost(A, B) {
  const ee = Math.abs(vE(A.r) - vE(B.r));
  const em = Math.abs(vE(A.r) - V_MOONORB) + Math.max(0, vM(B.d) - vM(MOON_SOI));
  const me = Math.abs(vE(B.r) - V_MOONORB) + Math.max(0, vM(A.d) - vM(MOON_SOI));
  const mm = Math.abs(vM(A.d) - vM(B.d));
  return (1 - A.w) * (1 - B.w) * ee + (1 - A.w) * B.w * em + A.w * (1 - B.w) * me + A.w * B.w * mm;
}
function dvField(r, d, o) {
  if (r < R_E || d < R_M) return null;
  const B = mkPt(r, d);
  return { v: dvCost(o, B), br: B.w > .5 ? 'moon' : 'earth' };
}
// inverse of the radial push-out in mkWarp (screen rho -> unwarped distance); same maths as the floor shader
function invWarp(rho, b, push) {
  if (rho >= b || push <= 0) return rho;
  const q = push / b, A = 1 - 2 * q;
  return Math.max(0, (-A + Math.sqrt(Math.max(0, A * A - 4 * q * (q - rho / b)))) / (2 * q)) * b;
}

const OGEO = await import('./orbits-geo.js?v=' + Date.now());   // orbits view geometry + maths (cache-bust like demo.html's import)
import * as V from './vehicle.js';                                // the one set of vehicle numbers (Isp, thrust, dry mass)
const CGEO = await import('./capture-geo.js?v=' + Date.now());  // CAPTURE / DEFEND + COMPETITOR plans (Kepler maths, tools/test_capture_geo.html)

// ---- COMPETITOR: the vehicle and tug numbers (Isp, thrust, dry mass) live in vehicle.js, one set for every mode. Edit them there.
const COMP = {
  us: { name: V.SELDON.name },
  them: { name: V.TUG.name },
  snapGeoMm: 14,                                 // a Seldon this close (mm) to the GEO ring locks the target to GEO
  colThem: 0xa592f0,                             // the competitor's colour: brand violet, lightened to read on ink (not the alarm red)
};

export function createModes(ctx) {
  const { THREE, scene, line, put } = ctx;
  const SW = () => ctx.SW, SH = () => ctx.SH, SC = () => ctx.getScale();
  const END = ctx.end === 'left' ? 'left' : 'right';
  const TEXT = ctx.text === 'all' ? 'all' : 'corners';          // 'corners': only the rail readouts; 'all': map labels, captions, box labels too
  const W = (x, y) => new THREE.Vector2(x, -y);
  const mkres = () => [innerWidth, innerHeight];
  const bgCol = new THREE.Color(BG);

  // brand css (self-contained so index.html can adopt this file as is)
  if (!document.querySelector('link[href*="gg-table.css"]')) {
    const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = new URL('gg-table.css', import.meta.url).href; document.head.appendChild(l);
  }
  let lockEl = document.getElementById('lockup');
  if (!lockEl) { lockEl = document.createElement('img'); lockEl.id = 'lockup'; lockEl.alt = 'General Galactic'; lockEl.src = new URL('assets/gg-logo-full-light.png', import.meta.url).href; document.body.appendChild(lockEl); }

  // ---------------------------------------------------------------- registry / items
  const groups = { chrome: { fade: 1, items: [] } };
  for (const m of MODE_NAMES) groups[m] = { fade: 0, items: [] };
  for (const m in GROUP) groups[m] = groups[GROUP[m]];          // shared: one set of items, one fade
  const allGroups = () => new Set(Object.values(groups));
  const add = (g, kind, obj, base = 1) => { const it = { kind, obj, base, on: false, key: null }; groups[g].items.push(it); return it; };

  // line language (widths in px at 1.344 px/mm)
  const STYLES = {
    primary: { c: C.mint, w: 2.7, op: 1, grad: true },
    under: { c: C.mint900, w: 4.7, op: .5 },
    hi: { c: C.mint300, w: 3.5, op: 1 },
    target: { c: C.white, w: 1.6, op: .7 },
    ref: { c: C.fog300, w: 1.1, op: .4, dash: 4, gap: 4 },
    orbitA: { c: C.mint, w: 2.4, op: .9 },                   // Seldon-1's orbit (mint)
    orbitB: { c: 0xe2604f, w: 2.4, op: .9 },                 // Seldon-2's orbit (red)
    link: { c: C.white, w: 1.3, op: .7, dash: 4, gap: 4 },   // straight Seldon-1 -> Seldon-2 line (white, dashed)
    marker: { c: C.white, w: 1.6, op: .9 },
    flow: { c: C.mint300, w: 2.7, op: .5, dash: 6, gap: 14 },
    box: { c: C.fog300, w: 1, op: .3 },
    glyph: { c: C.fog300, w: 1, op: .3 },
    track: { c: C.fog300, w: 1, op: .35 },
    coastA: { c: C.mint, w: 1.8, op: .6, dash: 3, gap: 3 },   // engagement: orbit if no further burns (dashed)
    coastB: { c: 0xe2604f, w: 1.8, op: .6, dash: 3, gap: 3 },
    ring: { c: C.fog300, w: 1.3, op: .8 },                  // engagement: keepout / capture ring
    thrust: { c: C.white, w: 1.8, op: .95 },                // engagement: applied thrust vector (white, per the engagement lab's palette)                  // slider rail + ticks
    fill: { c: C.mint, w: 3.0, op: .85 },                   // slider fill: zero up to the chip
    fillB: { c: 0xe2604f, w: 3.0, op: .85 },                // adversary slider / gauge fill
  };
  const kw = () => Math.max(.8, SC() / 1.344);              // line widths are authored for 1.34 px/mm (the 65" TV)
  function mkLine(g, kind) {
    const st = STYLES[kind];
    const l = line([W(0, 0), W(1, 1)], st.c, st.w * kw(), { opacity: 1, dash: st.dash, gap: st.gap });
    l.material.resolution.set(...mkres()); l.visible = false;
    if (kind === 'under') l.position.z = -.5;
    if (kind === 'flow') l.position.z = .2;
    if (st.grad) { l.material.vertexColors = true; l.material.color.set(0xffffff); l.material.needsUpdate = true; }
    const it = add(g, 'line', l, st.op); it.st = st; it.cc = new THREE.Color(st.c); return it;
  }
  function mkText(g, cls, base = 1) {
    const el = document.createElement('div'); el.className = 'mt ' + cls; el.style.display = 'none'; document.body.appendChild(el);
    return add(g, 'label', el, base);
  }
  const mkDot = (g, color, r, base = 1) => {
    const m = new THREE.Mesh(new THREE.CircleGeometry(r, 24), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false, toneMapped: false }));
    m.position.z = 1; m.visible = false; scene.add(m); return add(g, 'mesh', m, base);
  };
  // fr: optional array of 0..1 progress per point; opacity runs 40% -> 100% (or custom a0..a1)
  function setPts(it, pts, fr, a0 = .4, a1 = 1) {
    const l = it.obj, old = l.geometry, g = new old.constructor();
    g.setPositions(pts.flatMap(p => [p.x, p.y, 0]));
    if (it.st.grad) {
      const n = pts.length, cols = [], cc = it.cc;
      for (let i = 0; i < n; i++) {
        const f = fr ? fr[i] : i / Math.max(1, n - 1), a = a0 + (a1 - a0) * f;
        cols.push(bgCol.r + (cc.r - bgCol.r) * a, bgCol.g + (cc.g - bgCol.g) * a, bgCol.b + (cc.b - bgCol.b) * a);
      }
      g.setColors(cols);
    }
    l.geometry = g; old.dispose(); l.computeLineDistances(); it.pts = pts; it.on = true;
  }
  // a route is an under-stroke (mint-900, 50%) beneath the primary line
  const flows = [];                                         // ambient dash drift lines (animated in update)
  const mkRoute = g => { const r = { under: mkLine(g, 'under'), main: mkLine(g, 'primary'), flow: mkLine(g, 'flow') }; flows.push(r.flow.obj); return r; };
  function setRoute(r, pts, fr) { setPts(r.under, pts); setPts(r.main, pts, fr); setPts(r.flow, pts); }
  const circPts = (cx, cy, r, n = 128, a0 = 0, a1 = TAU) => {
    const out = []; for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * i / n; out.push(W(cx + r * Math.cos(a), cy - r * Math.sin(a))); } return out;
  };
  const MARK_R = 1.75;                                      // 3.5 mm open circle
  function setText(it, html) { if (it.html !== html) { it.html = html; it.obj.innerHTML = html; } }
  const AT = { c: 'translate(-50%,0)', cm: 'translate(-50%,-50%)', l: 'translate(0,-50%)', r: 'translate(-100%,-50%)', tl: 'translate(0,0)', bl: 'translate(0,-100%)', br: 'translate(-100%,-100%)' };
  // rotation is about the element centre (transform-origin 50% 50%), so it never changes the box the placer reasons about
  function place(it, x, y, anchor = 'c', rot = 0) {
    const el = it.obj, pk = x.toFixed(2) + ',' + y.toFixed(2) + ',' + SC();
    if (it.pk !== pk) { it.pk = pk; put(el, x, y); }
    const tr = `${AT[anchor]} rotate(${rot}deg)`;
    if (it.tr !== tr) { it.tr = tr; el.style.transform = tr; }
    it.on = true;
  }
  const hide = (...its) => its.forEach(i => { if (!i) return; if (i.under) { i.under.on = i.main.on = i.flow.on = false; } else i.on = false; });
  function applyFonts() {
    document.documentElement.style.setProperty('--mm', SC() + 'px');
    for (const g of allGroups()) for (const it of g.items) if (it.kind === 'line') it.obj.material.linewidth = it.st.w * kw();
  }

  // text faces the nearest long edge; labels on a curve run along it, flipped to read from the nearest edge
  const MID_BAND = 40;                                      // mm either side of the centre line where labels keep the near-side orientation
  const farSide = y => y < SH() / 2 - MID_BAND;
  const faceRot = y => farSide(y) ? 180 : 0;
  function tangentRot(dx, dy, y) {
    let rot = Math.atan2(dy, dx) * 180 / Math.PI;
    const c = Math.cos(rot * Math.PI / 180);
    if (farSide(y) ? c > 0 : c < 0) rot += 180;
    return rot;
  }
  const ringSpots = (cx, cy, R, degs) => degs.map(dg => {
    const a = dg * Math.PI / 180, x = cx + R * Math.cos(a), y = cy - R * Math.sin(a);
    return [x, y, tangentRot(-R * Math.sin(a), -R * Math.cos(a), y)];
  });
  const curveSpots = (X, Y, idxs) => idxs.map(i => {
    const n = X.length, a = (i - 1 + n) % n, b = (i + 1) % n;
    return [X[i], Y[i], tangentRot(X[b] - X[a], Y[b] - Y[a], Y[i])];
  });

  // ---------------------------------------------------------------- chrome: edge rails
  const rails = [0, 1].map(i => {
    const el = document.createElement('div'); el.className = 'rail'; el.style.display = 'none'; document.body.appendChild(el);
    const it = add('chrome', 'label', el, 1); it.on = true; return it;
  });
  let railOwner = null;
  function setRails(mode, o) {
    if (mode !== railOwner) return;
    if (o.raw != null) { rails.forEach(r => setText(r, o.raw)); return; }
    const { eyebrow, hero = '—', unit = '', mets = [], msg = '' } = o;
    const html = `<div class="r-left"><div class="eyebrow"><span class="sq"></span>${eyebrow}</div><div class="hero">${hero}<i>${unit}</i></div></div>` +
      `<div class="r-mid"></div><div class="r-mets">${msg ? `<div class="r-msg">${msg}</div>` : ''}${mets.map(([l, v]) => `<div class="metric"><div class="ml">${l}</div><div class="mv">${v}</div></div>`).join('')}</div>`;
    rails.forEach(r => setText(r, html));
  }

  // ---------------------------------------------------------------- chrome: chip boxes (presenter's end), lockup, caption
  const colX0 = () => END === 'right' ? SW() - MARG - BOX : MARG;
  // the chip is a slider: its position along the head-end column sets the delta-v budget from Seldon-1 (0..DV_MAX km/s).
  // The map shows what that budget reaches; chip off the track = topography off.
  const DV_MAX = 8;
  const REACH = true;                                          // the map shows reach (cost <= budget), not contour topography
  const BOXES = [{ title: 'BUDGET' }];                         // kept for boxRect(i) callers: index 0 = the track at full budget
  const track = () => {                                        // track runs the column between the far rail and the lockup
    const cx = colX0() + BOX / 2, y0 = MARG + RAIL_H + 40, y1 = SH() - MARG - 134;
    return { cx, y0, y1 };
  };
  const yForBudget = b => { const t = track(), f = Math.max(0, Math.min(1, b / DV_MAX)); return END === 'right' ? t.y1 - f * (t.y1 - t.y0) : t.y0 + f * (t.y1 - t.y0); };
  const budgetForY = y => { const t = track(), f = END === 'right' ? (t.y1 - y) / (t.y1 - t.y0) : (y - t.y0) / (t.y1 - t.y0); return DV_MAX * Math.max(0, Math.min(1, f)); };
  const boxRect = i => {
    const t = track(), cx = t.cx, cy = yForBudget(i === 0 ? DV_MAX : DV_MAX / 2);
    return { x0: cx - BOX / 2, y0: cy - BOX / 2, x1: cx + BOX / 2, y1: cy + BOX / 2, cx, cy };
  };
  const onTrack = c => { const t = track(); return Math.abs(c.x_mm - t.cx) < BOX / 2 + 6 && c.y_mm > t.y0 - BOX / 2 && c.y_mm < t.y1 + BOX / 2; };
  const boxRot = END === 'right' ? -90 : 90;
  const boxes = BOXES.map(() => ({ line: mkLine('chrome', 'track'), ticks: Array.from({ length: DV_MAX + 1 }, () => mkLine('chrome', 'track')), tickL: Array.from({ length: DV_MAX / 2 + 1 }, () => mkText('chrome', 'mt-chip')), fill: mkLine('chrome', 'fill'), lbl: mkText('chrome', 'mt-chip'), read: mkText('chrome', 'mt-readout') }));
  const modeCap = mkText('chrome', 'mt-eyebrow');
  const CH = { rails: [], col: [0, 0, 0, 0], lock: [0, 0, 0, 0] };
  let chromeKey = null;
  function layoutChrome() {
    const s = SC(), sw = SW(), sh = SH();
    const t = track(), outer = END === 'right' ? 1 : -1;     // +1: screen edge is at larger x
    boxes.forEach((b, i) => {
      setPts(b.line, [W(t.cx, t.y0), W(t.cx, t.y1)]);
      for (let k = 0; k <= DV_MAX; k++) { const y = yForBudget(k), hw = k % 2 ? 4 : 7; setPts(b.ticks[k], [W(t.cx - hw, y), W(t.cx + hw, y)]); }
      b.tickL.forEach((it, k) => { setText(it, String(2 * k)); place(it, t.cx + outer * 24, yForBudget(2 * k), 'cm', boxRot); });
      setText(b.lbl, 'DELTA-V BUDGET'); place(b.lbl, t.cx, END === 'right' ? t.y0 - 48 : t.y1 + 48, 'cm', boxRot);   // past the full-budget end, clear of the chip
    });
    setText(modeCap, 'MODE'); modeCap.on = false;
    CH.col = [t.cx - BOX / 2 - 30, t.y0 - 30, t.cx + BOX / 2 + 30, t.y1 + 30];
    // rails
    const rx = END === 'right' ? MARG : MARG + BOX + 24, rw = sw - 2 * MARG - (BOX + 24);
    const ys = [sh - MARG - RAIL_H, MARG];
    rails.forEach((r, i) => {
      put(r.obj, rx, ys[i]); r.obj.style.width = rw * s + 'px'; r.obj.style.height = RAIL_H * s + 'px';
      r.obj.style.transform = i === 1 ? 'rotate(180deg)' : '';
    });
    CH.rails = ys.map(y => [rx, y, rx + rw, y + RAIL_H]);
    // lockup: centred on the box column, below the stack, reads from the presenter's end
    const lw = 120, lh = lw * (lockEl.naturalWidth ? lockEl.naturalHeight / lockEl.naturalWidth : .25), lcx = t.cx, lcy = sh - MARG - 94;
    put(lockEl, lcx, lcy); lockEl.style.width = lw * s + 'px'; lockEl.style.height = 'auto';
    lockEl.style.transform = `translate(-50%,-50%) rotate(${boxRot}deg)`; lockEl.style.visibility = 'visible';
    CH.lock = [lcx - lh / 2, lcy - lw / 2, lcx + lh / 2, lcy + lw / 2];
    applyFonts();
  }
  lockEl.addEventListener('load', () => { chromeKey = null; });
  // foot caption at the opposite short end, centred vertically
  const FOOT_ROT = END === 'right' ? 90 : -90;
  function setCaption(it, txt) {
    if (TEXT === 'corners') { it.on = false; return; }
    setText(it, txt);
    place(it, END === 'right' ? MARG + 4 : SW() - MARG - 4, SH() / 2, 'cm', FOOT_ROT);
  }
  const footRect = cap => {
    const L = (cap && cap.html ? cap.html.replace(/<[^>]*>/g, '').length : 0) * 4.8 + 8, y0 = SH() / 2 - L / 2, y1 = SH() / 2 + L / 2;
    return END === 'right' ? [MARG - 4, y0, MARG + 34, y1] : [SW() - MARG - 34, y0, SW() - MARG + 4, y1];
  };

  // ---------------------------------------------------------------- label placer
  const msgFor = (E, Mo, needMoon) => !E ? (needMoon && !Mo ? 'Place Earth and the Moon.' : 'Place Earth.') : needMoon && !Mo ? 'Place the Moon.' : '';
  function obstacles(P, capIt) {
    const circ = [], rects = [];
    for (const k of ['earth', 'moon']) if (P[k]) circ.push([P[k].x_mm, P[k].y_mm, 39]);
    for (const k of ['seldon-1', 'seldon-2']) if (P[k]) rects.push([P[k].x_mm - 75, P[k].y_mm - 30, P[k].x_mm + 75, P[k].y_mm + 30]);
    if (P.chip) rects.push([P.chip.x_mm - 30, P.chip.y_mm - 30, P.chip.x_mm + 30, P.chip.y_mm + 30]);
    rects.push(...CH.rails, CH.col, CH.lock, footRect(capIt));
    return { circ, rects };
  }
  const rectsOverlap = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
  const rectCircle = (r, c) => { const nx = Math.max(r[0], Math.min(c[0], r[2])), ny = Math.max(r[1], Math.min(c[1], r[3])); return Math.hypot(nx - c[0], ny - c[1]) < c[2]; };
  // label size in mm: measured from the DOM when possible (offset sizes ignore rotation), else estimated
  function measure(a) {
    const el = a.it.obj, prev = el.style.display; el.style.display = '';
    let w = el.offsetWidth / SC(), h = el.offsetHeight / SC(); el.style.display = prev;
    if (!(w > 0)) {
      const plain = a.html.replace(/<i>.*?<\/i>/g, 'xxx').replace(/<[^>]*>/g, '');
      w = plain.length * 5.6 + 2; h = 10;
    }
    return [w + 2, h];
  }
  const placerKeys = {}, placedStore = {};
  // list: [{it, x, y, html, r?, rot?, spots?}] in priority order. Default: right, left, above, below, diagonals of the
  // anchor, text facing the nearest long edge. spots: [[cx, cy, rot]] label centres on a curve, tried in order.
  function placeAnnos(mode, list, obs) {
    if (TEXT === 'corners') { for (const a of list) a.it.on = false; return; }
    const key = list.map(a => `${Math.round(a.x)},${Math.round(a.y)},${a.html}`).join('|') + '#' + obs.circ.map(c => Math.round(c[0]) + ',' + Math.round(c[1])).join(';') + '#' + obs.rects.map(r => r.map(Math.round).join(',')).join(';') + SW() + 'x' + SC();
    for (const a of list) { setText(a.it, a.html); a.it.on = true; }
    if (placerKeys[mode] === key) return;
    placerKeys[mode] = key;
    const placed = [], gap = 5, m = MARG - 8;
    for (const a of list) {
      const [w, h] = measure(a), g = gap + (a.r ?? 0), cands = [];
      if (a.spots) for (const s of a.spots) cands.push({ cx: s[0], cy: s[1], rot: s[2] });
      else {
        const rot = a.rot ?? faceRot(a.y);
        for (const [x0, y0] of [[a.x + g, a.y - h / 2], [a.x - g - w, a.y - h / 2], [a.x - w / 2, a.y - g - h], [a.x - w / 2, a.y + g], [a.x + g, a.y - g - h], [a.x - g - w, a.y - g - h], [a.x + g, a.y + g], [a.x - g - w, a.y + g]])
          cands.push({ cx: x0 + w / 2, cy: y0 + h / 2, rot });
      }
      let best = null, bs = 1e9;
      for (const c of cands) {
        const cs = Math.abs(Math.cos(c.rot * Math.PI / 180)), sn = Math.abs(Math.sin(c.rot * Math.PI / 180)), bw = w * cs + h * sn, bh = w * sn + h * cs;
        const r = [c.cx - bw / 2, c.cy - bh / 2, c.cx + bw / 2, c.cy + bh / 2]; let s = 0;
        if (r[0] < m || r[1] < m || r[2] > SW() - m || r[3] > SH() - m) s += 50;
        for (const p of placed) if (rectsOverlap(r, p)) s += 10;
        for (const q of obs.rects) if (rectsOverlap(r, q)) s += 10;
        for (const q of obs.circ) if (rectCircle(r, q)) s += 10;
        if (s < bs) { bs = s; best = { c, r }; if (s === 0) break; }
      }
      placed.push(best.r); place(a.it, best.c.cx, best.c.cy, 'cm', best.c.rot);
    }
    placedStore[mode] = placed;
  }
  if (document.fonts) { const rp = () => { for (const k of Object.keys(placerKeys)) placerKeys[k] = null; }; document.fonts.ready.then(rp); document.fonts.addEventListener?.('loadingdone', rp); }

  // ---------------------------------------------------------------- frame mapping (Earth–Moon rotating frame)
  function frameEM(E, M) {
    const dx = M.x_mm - E.x_mm, dy = M.y_mm - E.y_mm, d = Math.hypot(dx, dy);
    if (d < 20) return null;
    const ux = dx / d, uy = dy / d;
    const F = { ex: E.x_mm, ey: E.y_mm, mx: M.x_mm, my: M.y_mm, ux, uy, nx: uy, ny: -ux, s: d / L_KM, d };
    F.key = [E.x_mm, E.y_mm, M.x_mm, M.y_mm].map(v => Math.round(v * 40)).join(',');
    F.to = (xk, yk) => [F.ex + F.s * (xk * ux + yk * F.nx), F.ey + F.s * (xk * uy + yk * F.ny)];
    F.from = (px, py) => [((px - F.ex) * ux + (py - F.ey) * uy) / F.s, ((px - F.ex) * F.nx + (py - F.ey) * F.ny) / F.s];
    return F;
  }
  // smooth radial push-out around each body so LEO / flyby ring sit just outside the pieces
  function mkWarp(F, mission) {
    const leoAlt = mission?.leo_alt_km ?? 400, flyAlt = mission?.flyby_alt_km ?? 130;
    const body = (cx, cy, minR, d0) => {
      const b = minR * 4, w0 = (1 - d0 / b) ** 2;
      let push = minR > d0 && d0 < b ? (minR - d0) / w0 : 0;
      push = Math.min(push, b * .45);
      return { cx, cy, b, push };
    };
    const bodies = [
      body(F.ex, F.ey, EARTH_PIECE_R + 6, (R_E + leoAlt) * F.s),
      body(F.mx, F.my, MOON_PIECE_R + 6, (R_M + flyAlt) * F.s),
    ];
    const fn = (p) => {
      let x = p[0], y = p[1];
      for (const B of bodies) {
        const dx = x - B.cx, dy = y - B.cy, d = Math.hypot(dx, dy);
        if (d < B.b && d > 1e-6 && B.push > 0) { const nd = d + B.push * (1 - d / B.b) ** 2; x = B.cx + dx / d * nd; y = B.cy + dy / d * nd; }
      }
      return [x, y];
    };
    fn.bodies = bodies;
    const rho = (B, r) => { const d = r * F.s; return d < B.b ? d + B.push * (1 - d / B.b) ** 2 : d; };   // km -> warped screen radius
    fn.rhoE = r => rho(bodies[0], r); fn.rhoM = r => rho(bodies[1], r);
    fn.rInvE = q => invWarp(q, bodies[0].b, bodies[0].push) / F.s; fn.rInvM = q => invWarp(q, bodies[1].b, bodies[1].push) / F.s;
    fn.inv = (p) => {                                       // undo the push-out (screen position -> unwarped screen position)
      let x = p[0], y = p[1];
      for (let k = bodies.length - 1; k >= 0; k--) {
        const B = bodies[k], dx = x - B.cx, dy = y - B.cy, rho = Math.hypot(dx, dy);
        if (rho < B.b && rho > 1e-6 && B.push > 0) { const d = invWarp(rho, B.b, B.push); x = B.cx + dx / rho * d; y = B.cy + dy / rho * d; }
      }
      return [x, y];
    };
    return fn;
  }
  // DELTA-V MAP warp: around Earth the screen radius is linear in delta-v (circular-orbit speed) out to DV_R1, then the plain
  // km scale takes over unchanged, so every 0.5 km/s ring is the same width and the Moon region keeps its shape.
  const DV_R1 = 200000, DV_RE0 = R_E + 200, DV_RM0 = R_M + 100, MAX_RINGS = 4;
  const ringStep = span => [0.5, 1, 2, 4].find(st => span / st <= MAX_RINGS) || 4;   // km/s between rings for a body whose zone spans `span` km/s
  function mkWarpDv(F) {
    const rho0 = EARTH_PIECE_R + 6, vRef = vE(DV_RE0), rho1 = F.s * DV_R1;
    if (rho1 - rho0 < 60 || F.s * MOON_SOI - (MOON_PIECE_R + 6) < 30) return null;                      // Moon piece too close to Earth: fall back to the push-out warp
    const K = (rho1 - rho0) / (vRef - vE(DV_R1));
    const rhoE = r => r <= DV_RE0 ? rho0 * r / DV_RE0 : r <= DV_R1 ? rho0 + K * (vRef - vE(r)) : F.s * r;
    const rInvE = q => q <= rho0 ? DV_RE0 * q / rho0 : q <= rho1 ? MU_E / (vRef - (q - rho0) / K) ** 2 : q / F.s;
    // same idea around the Moon, out to its sphere of influence
    const mRho0 = MOON_PIECE_R + 6, mVref = vM(DV_RM0), mRho1 = F.s * MOON_SOI, KM = (mRho1 - mRho0) / (mVref - vM(MOON_SOI));
    const rhoM = d => d <= DV_RM0 ? mRho0 * d / DV_RM0 : d <= MOON_SOI ? mRho0 + KM * (mVref - vM(d)) : F.s * d;
    const rInvM = q => q <= mRho0 ? DV_RM0 * q / mRho0 : q <= mRho1 ? MU_M / (mVref - (q - mRho0) / KM) ** 2 : q / F.s;
    const radial = (p, cx, cy, lim, f) => { const dx = p[0] - cx, dy = p[1] - cy, d = Math.hypot(dx, dy); if (d < 1e-6 || d >= lim) return p; const q = f(d); return [cx + dx / d * q, cy + dy / d * q]; };
    const fn = p => radial(radial(p, F.ex, F.ey, rho1, d => rhoE(d / F.s)), F.mx, F.my, mRho1, d => rhoM(d / F.s));
    fn.inv = p => radial(radial(p, F.mx, F.my, mRho1, q => rInvM(q) * F.s), F.ex, F.ey, rho1, q => rInvE(q) * F.s);
    fn.rhoE = rhoE; fn.rInvE = rInvE; fn.rhoM = rhoM; fn.rInvM = rInvM;
    fn.bodies = [{ cx: F.ex, cy: F.ey, b: 1, push: 0 }, { cx: F.mx, cy: F.my, b: 1, push: 0 }];
    fn.dv = { rho0, rho1, K, vRef, mRho0, mRho1, KM, mVref, stepE: ringStep(vRef - vE(DV_R1)), stepM: ringStep(mVref - vM(MOON_SOI)) };
    return fn;
  }
  let warpDvCache = { key: null, fn: null };
  const warpDvFor = F => {
    if (warpDvCache.key !== F.key) warpDvCache = { key: F.key, fn: mkWarpDv(F) || warpFor(F) };
    return warpDvCache.fn;
  };
  let warpCache = { key: null, fn: null };
  const warpFor = F => {
    const key = F.key + (mission ? 'm' : '-');
    if (warpCache.key !== key) warpCache = { key, fn: mkWarp(F, mission) };
    return warpCache.fn;
  };

  // ---------------------------------------------------------------- mission data
  let mission = null, missionErr = null;
  fetch(ctx.missionUrl || 'data/mission_dro.json').then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(j => { mission = j; initMissionItems(); }).catch(e => { missionErr = String(e); });

  function densify(list, F, warp) {
    const sc = list.map(p => F.to(p[0], p[1])), n = list.length;
    const X = [], Y = [], Uu = [];
    const push = (p, u) => { const w = warp(p); X.push(w[0]); Y.push(w[1]); Uu.push(u); };
    for (let i = 0; i < n - 1; i++) {
      const a = sc[i], b = sc[i + 1], wa = warp(a), wb = warp(b);
      const len = Math.hypot(wb[0] - wa[0], wb[1] - wa[1]);
      const cnt = Math.max(1, Math.min(60, Math.ceil(len / 1.0)));
      const p0 = sc[Math.max(0, i - 1)], p3 = sc[Math.min(n - 1, i + 2)];
      const l0 = Math.hypot(a[0] - p0[0], a[1] - p0[1]), l1 = Math.hypot(b[0] - a[0], b[1] - a[1]), l2 = Math.hypot(p3[0] - b[0], p3[1] - b[1]);
      const smooth = i > 0 && i < n - 2 && l1 > 1e-9 && l0 / l1 < 2 && l0 / l1 > .5 && l2 / l1 < 2 && l2 / l1 > .5;
      for (let k = 0; k < cnt; k++) {
        const t = k / cnt; let q;
        if (smooth) {
          const t2 = t * t, t3 = t2 * t;
          q = [0, 1].map(c => .5 * (2 * a[c] + (-p0[c] + b[c]) * t + (2 * p0[c] - 5 * a[c] + 4 * b[c] - p3[c]) * t2 + (-p0[c] + 3 * a[c] - 3 * b[c] + p3[c]) * t3));
        } else q = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        push(q, i + t);
      }
    }
    if (n) push(sc[n - 1], n - 1);
    return { X, Y, U: Uu };
  }

  let pathCache = { key: null };
  function getPath(F) {
    if (!mission) return null;
    if (pathCache.key === F.key) return pathCache;
    const warp = warpFor(F);
    const P = mission.points, d = densify(P.map(p => [p.x, p.y]), F, warp);
    const cum = [0]; for (let i = 1; i < d.X.length; i++) cum.push(cum[i - 1] + Math.hypot(d.X[i] - d.X[i - 1], d.Y[i] - d.Y[i - 1]));
    const ph = d.U.map(u => P[Math.min(P.length - 1, Math.ceil(u - 1e-9))].phase);
    const dro = mission.dro?.points?.length ? densify(mission.dro.points, F, warp) : null;
    pathCache = { key: F.key, warp, ...d, cum, total: cum[cum.length - 1], ph, dro };
    return pathCache;
  }
  const fieldsAt = u => {
    const P = mission.points, i = Math.max(0, Math.min(P.length - 1, Math.floor(u))), j = Math.min(P.length - 1, i + 1), f = u - i;
    const a = P[i], b = P[j], L = k => a[k] + (b[k] - a[k]) * f;
    return { t_h: L('t_h'), dv: L('dv'), v_earth: L('v_earth'), v_moon: L('v_moon'), r_earth: L('r_earth'), r_moon: L('r_moon'), phase: f < .5 ? a.phase : b.phase };
  };
  function nearest(path, px, py) {
    let best = { d: 1e9 };
    const { X, Y, U: Uu } = path;
    for (let j = 0; j < X.length - 1; j++) {
      const ax = X[j], ay = Y[j], bx = X[j + 1] - ax, by = Y[j + 1] - ay, l2 = bx * bx + by * by;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * bx + (py - ay) * by) / l2)) : 0;
      const qx = ax + bx * t, qy = ay + by * t, d = Math.hypot(px - qx, py - qy);
      if (d < best.d) best = { d, x: qx, y: qy, idx: j + t, u: Uu[j] + (Uu[j + 1] - Uu[j]) * t };
    }
    return best;
  }
  const slice = (path, idx, n = 240) => {
    const out = []; for (let k = 0; k <= n; k++) {
      const q = idx * k / n, i = Math.min(path.X.length - 2, Math.floor(q)), f = q - i;
      out.push(W(path.X[i] + (path.X[i + 1] - path.X[i]) * f, path.Y[i] + (path.Y[i + 1] - path.Y[i]) * f));
    } return out;
  };

  // ================================================================ FLOOR (chrome, always on): the delta-v field
  const SHADER_VS = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }';
  const SHADER_FS = `
    precision highp float;
    varying vec2 vUv;
    uniform vec2 uE, uM, uScreen; uniform float uS, uOpacity, uBudget, oVE, oVM, oW, uStrength, uEb, uEpush, uMb, uMpush, uDvMap, uRho0, uRho1, uK, uVref, uMRho0, uMRho1, uMK, uMVref, uStepE, uStepM;
    const float MU_E = ${MU_E}, MU_M = ${MU_M}, R_EARTH = ${R_E}, R_MOON = ${R_M}, SOI = ${MOON_SOI}.0;
    uniform float vEL, vMSOI;
    float invWarp(float rho, float b, float push){ if (rho >= b || push <= 0.0) return rho; float q = push / b; float A = 1.0 - 2.0 * q; float x = (-A + sqrt(max(0.0, A*A - 4.0*q*(q - rho/b)))) / (2.0*q); return x * b; }
    float lineAA(float u, float fw){ fw = max(fw, 1e-5); return 1.0 - smoothstep(0.3, 1.0, abs(fract(u + 0.5) - 0.5) / fw); }
    void main(){
      vec2 p = vec2(vUv.x * uScreen.x, (1.0 - vUv.y) * uScreen.y);
      vec3 ink = vec3(13., 17., 19.) / 255.;
      float rho = length(p - uE), r;
      if (uDvMap > 0.5) r = rho <= uRho0 ? ${DV_RE0.toFixed(1)} * rho / uRho0 : rho <= uRho1 ? MU_E / pow(uVref - (rho - uRho0) / uK, 2.0) : rho / uS;
      else r = invWarp(rho, uEb, uEpush) / uS;
      float rm = length(p - uM), d;
      if (uDvMap > 0.5) d = rm <= uMRho0 ? ${DV_RM0.toFixed(1)} * rm / uMRho0 : rm <= uMRho1 ? MU_M / pow(uMVref - (rm - uMRho0) / uMK, 2.0) : rm / uS;
      else d = invWarp(rm, uMb, uMpush) / uS;
      bool inside = (r < R_EARTH || d < R_MOON);
      r = max(r, R_EARTH); d = max(d, R_MOON);
      float vEr = sqrt(MU_E / r), vMd = sqrt(MU_M / d);
      float t = clamp((SOI - d) / ${SOI_BLEND}.0, 0.0, 1.0); float wB = t * t * (3.0 - 2.0 * t);
      float cost = (1.0 - oW) * (1.0 - wB) * abs(oVE - vEr)
                 + (1.0 - oW) * wB * (abs(oVE - vEL) + max(0.0, vMd - vMSOI))
                 + oW * (1.0 - wB) * (abs(vEr - vEL) + max(0.0, oVM - vMSOI))
                 + oW * wB * abs(oVM - vMd);
      // REACH: one semi-transparent violet region = every point Seldon-1 can get to within the slider's budget. No lines.
      float over = cost - uBudget;
      float aaw = max(fwidth(cost), 1e-5) * 1.5;
      float reach = 1.0 - smoothstep(-aaw, aaw, over);
      vec3 mint = vec3(106., 86., 184.) / 255.;                // violet-400
      float alpha = 0.22 * reach;
      if (inside) alpha = 0.0;
      // clean ground under both rails
      alpha *= uStrength;                                      // no rail mask: the region runs under the rails
      gl_FragColor = vec4(pow(mint, vec3(2.2)), uOpacity * alpha);
    }`;
  const shadeMat = new THREE.ShaderMaterial({
    vertexShader: SHADER_VS, fragmentShader: SHADER_FS, transparent: true, depthWrite: false, toneMapped: false,
    uniforms: { uE: { value: new THREE.Vector2() }, uM: { value: new THREE.Vector2() }, uScreen: { value: new THREE.Vector2(1, 1) }, uS: { value: 1 }, uOpacity: { value: 0 }, uBudget: { value: 8 },
      oVE: { value: 0 }, oVM: { value: 0 }, oW: { value: 0 }, vEL: { value: V_MOONORB }, vMSOI: { value: Math.sqrt(MU_M / MOON_SOI) },
      uStrength: { value: .55 }, uEb: { value: 1 }, uEpush: { value: 0 }, uMb: { value: 1 }, uMpush: { value: 0 }, uDvMap: { value: 0 }, uRho0: { value: 1 }, uRho1: { value: 1 }, uK: { value: 1 }, uVref: { value: 1 }, uMRho0: { value: 1 }, uMRho1: { value: 1 }, uMK: { value: 1 }, uMVref: { value: 1 }, uStepE: { value: 1 }, uStepM: { value: .5 } },
  });
  const shade = (() => { const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), shadeMat); m.position.z = -4; m.visible = false; scene.add(m); return add('chrome', 'mesh', m, 1); })();
  const FLOOR_STR = { mission: 0, intercept: 0, dvmap: 1 };   // the floor exists only in the map
  const usable = m => MODE_NAMES.includes(m) && !ARCHIVED.has(m);
  let current = usable(ctx.initialMode) ? ctx.initialMode : 'geo';   // LEO TO GEO by default (the four main modes: geo, capture, dro, competitor); ?mode=orbits|engage|dvmap|mission reopens the old ones
  let topo = ctx.topo !== false;                              // delta-v topography (floor, rings, labels) on/off; the chip drives it
  let budget = DV_MAX, budgetS = DV_MAX;                      // slider value (km/s from Seldon-1) and its smoothed copy
  const grp = () => GROUP[current] || current;                  // the group the current mode draws with
  groups[current].fade = 1;
  let floorStr = FLOOR_STR[current], floorOrg = LEO_ORIGIN;
  // distance helpers through the inverse warp so the field agrees with the drawn orbits
  const kmFrom = (F, px, py) => { const wp = warpDvFor(F); return [wp.rInvE(Math.hypot(px - F.ex, py - F.ey)), wp.rInvM(Math.hypot(px - F.mx, py - F.my))]; };
  const ptKm = (F, px, py) => { const [r, d] = kmFrom(F, px, py); return mkPt(r, d); };
  const deltaV = (F, px, py) => { const [r, d] = kmFrom(F, px, py); return dvField(r, d, dvOrg); };
  let dvOrg = LEO_ORIGIN;
  let lastFloorF = null;
  // frame from the real pieces; a virtual Earth / Moon (750 mm along +x) keeps the floor and the shared mapping alive
  const frameFor = P => {
    const Ee = P.earth || { x_mm: SW() * .23, y_mm: SH() / 2 };
    return frameEM(Ee, P.moon || { x_mm: Ee.x_mm + 750, y_mm: Ee.y_mm });
  };
  function updFloor(P, dt, now) {
    const F = frameFor(P) || lastFloorF; if (!F) return;
    lastFloorF = F;
    const A = P['seldon-1'];
    floorOrg = A ? ptKm(F, A.x_mm, A.y_mm) : LEO_ORIGIN;       // always relative to Seldon-1
    floorStr += ((topo && current === 'dvmap' ? 1 : 0) - floorStr) * (1 - Math.exp(-dt / .13));
    const u = shadeMat.uniforms, wpd = warpDvFor(F), [Eb, Mb] = wpd.bodies;
    u.uDvMap.value = wpd.dv ? 1 : 0; if (wpd.dv) { u.uRho0.value = wpd.dv.rho0; u.uRho1.value = wpd.dv.rho1; u.uK.value = wpd.dv.K; u.uVref.value = wpd.dv.vRef; u.uMRho0.value = wpd.dv.mRho0; u.uMRho1.value = wpd.dv.mRho1; u.uMK.value = wpd.dv.KM; u.uMVref.value = wpd.dv.mVref; u.uStepE.value = wpd.dv.stepE; u.uStepM.value = wpd.dv.stepM; }
    u.uE.value.set(F.ex, F.ey); u.uM.value.set(F.mx, F.my); u.uScreen.value.set(SW(), SH()); u.uS.value = F.s;
    u.oVE.value = vE(floorOrg.r); u.oVM.value = vM(floorOrg.d); u.oW.value = floorOrg.w;
    budgetS += (budget - budgetS) * (1 - Math.exp(-dt / .12)); u.uBudget.value = budgetS;
    u.uStrength.value = .95 + .05 * Math.sin(TAU * now / 44000); u.uEb.value = Eb.b; u.uEpush.value = Eb.push; u.uMb.value = Mb.b; u.uMpush.value = Mb.push;
    shade.on = floorStr > .005; shade.base = floorStr; shade.obj.scale.set(SW(), SH(), 1); shade.obj.position.set(SW() / 2, -SH() / 2, -4);
  }

  // ================================================================ MISSION
  const M = { evs: [] };
  M.cap = mkText('mission', 'mt-foot', 1);
  M.route = mkRoute('mission'); M.dro = mkLine('mission', 'target'); M.geo = mkLine('mission', 'ref'); M.geoL = mkText('mission', 'mt-label', .8); M.droL = mkText('mission', 'mt-label', .9);
  M.hi = mkLine('mission', 'hi'); M.ring = mkLine('mission', 'marker');
  M.geoDot = mkDot('mission', C.fog100, 1.25, .9); M.droDot = mkDot('mission', C.white, 1.25, .9);   // ambient only
  const EV_NAME = { spiral: 'ELECTRIC SPIRAL', dri: 'DRO INSERTION' };
  const PHASE_NAME = { leo: 'LEO', spiral: 'SPIRAL', transfer: 'TRANSFER', dro: 'DRO' };
  function initMissionItems() {
    for (const ev of mission.events || []) {
      if (ev.name === 'opf') continue;
      M.evs.push({ ev, mark: mkLine('mission', 'marker'), lbl: mkText('mission', 'mt-label', .9) });
    }
    applyFonts();
  }
  const evDv = n => { const e = (mission?.events || []).find(e => e.name === n); return e && e.dv_kms != null ? e.dv_kms : null; };

  function updMission(P, dt, now) {
    const E = P.earth, Mo = P.moon, A = P['seldon-1'];
    setCaption(M.cap, (mission && mission.caption ? String(mission.caption).toUpperCase() : 'PLANAR CR3BP REFERENCE TRAJECTORY · NOT TO SCALE NEAR EARTH/MOON'));
    const EYE = 'MISSION · LEO TO DRO';
    const allHide = () => { M.builtKey = null; hide(M.route, M.dro, M.geo, M.geoL, M.droL, M.hi, M.ring, M.geoDot, M.droDot); M.evs.forEach(e => hide(e.mark, e.lbl)); };
    if (!E || !Mo) { allHide(); setRails('mission', { eyebrow: EYE, msg: msgFor(E, Mo, true) }); return; }
    const F = frameEM(E, Mo);
    if (!F) { allHide(); return; }
    if (!mission) { allHide(); setRails('mission', { eyebrow: EYE, msg: missionErr ? 'Mission data not found.' : 'Loading trajectory.' }); return; }
    const path = getPath(F), annos = [];
    const wp = warpFor(F), rGeo = wp.rhoE(GEO_R);
    setPts(M.geo, circPts(F.ex, F.ey, rGeo, 160));
    annos.push({ it: M.geoL, x: F.ex, y: F.ey - rGeo, html: 'GEO', spots: ringSpots(F.ex, F.ey, rGeo, [270, 90]) });
    { const a = (now / 24000 % 1) * TAU; M.geoDot.obj.position.set(F.ex + rGeo * Math.cos(a), -(F.ey - rGeo * Math.sin(a)), 1); M.geoDot.on = true; }
    if (M.builtKey !== path.key) {
      M.builtKey = path.key;
      const pts = [], fr = []; let tot = 0;
      for (let i = 0; i < path.X.length; i++) if (path.ph[i] !== 'dro') { pts.push(W(path.X[i], path.Y[i])); fr.push(path.cum[i]); tot = path.cum[i]; }
      if (pts.length > 1) setRoute(M.route, pts, fr.map(c => Math.sqrt(c / (tot || 1)))); else hide(M.route);
      if (path.dro) setPts(M.dro, path.dro.X.map((x, i) => W(x, path.dro.Y[i]))); else hide(M.dro);
      M.evPos = M.evs.map(e => path.warp(F.to(e.ev.x, e.ev.y)));
      M.evs.forEach((e, i) => setPts(e.mark, circPts(M.evPos[i][0], M.evPos[i][1], MARK_R, 28)));
    }
    if (path.dro) {
      const X = path.dro.X, Y = path.dro.Y; let it = 0, ib = 0, il = 0, ir = 0;
      for (let i = 1; i < X.length; i++) { if (Y[i] < Y[it]) it = i; if (Y[i] > Y[ib]) ib = i; if (X[i] < X[il]) il = i; if (X[i] > X[ir]) ir = i; }
      annos.push({ it: M.droL, x: X[it], y: Y[it], html: 'DRO', spots: curveSpots(X, Y, [ib, it, ir, il]) });
      const k = Math.min(X.length - 1, Math.floor((now / 40000 % 1) * X.length)); M.droDot.obj.position.set(X[k], -Y[k], 1); M.droDot.on = true;
    } else hide(M.droL, M.droDot);
    M.evs.forEach((e, i) => {
      const q = M.evPos[i], dv = e.ev.dv_kms;
      annos.push({ it: e.lbl, x: q[0], y: q[1], r: MARK_R, html: `${EV_NAME[e.ev.name] || (e.ev.label || e.ev.name).toUpperCase()}${dv != null ? ` <b>${num(dv)}${U('km/s')}</b>` : ''}` });
    });

    const snap = A ? nearest(path, A.x_mm, A.y_mm) : null;
    const snapped = snap && snap.d < 40;
    const spiralDv = evDv('spiral'), insDv = evDv('dri'), days = mission.transfer_days;
    if (snapped) {
      setPts(M.hi, slice(path, snap.idx));
      setPts(M.ring, circPts(snap.x, snap.y, MARK_R * 1.4, 28));
      const f = fieldsAt(snap.u), sp = f.r_moon < MOON_SOI ? f.v_moon : f.v_earth;
      setRails('mission', { eyebrow: EYE, hero: num(f.dv), unit: 'km/s', mets: [
        ['PHASE', PHASE_NAME[f.phase] || f.phase.toUpperCase()], ['T+', `${Math.floor(f.t_h / 24)}${U('d')} ${String(Math.floor(f.t_h % 24)).padStart(2, '0')}${U('h')}`],
        ['SPEED', `${num(sp)}${U('km/s')}`]] });
    } else {
      hide(M.hi, M.ring);
      setRails('mission', { eyebrow: EYE, hero: num(mission.total_dv_kms), unit: 'km/s', mets: [
        ['TIME', `${days >= 20 ? Math.round(days) : num(days, 1)}${U('d')}`],
        ['SPIRAL', spiralDv != null ? `${num(spiralDv)}${U('km/s')}` : '—'], ['INSERTION', insDv != null ? `${num(insDv)}${U('km/s')}` : '—']] });
    }
    placeAnnos('mission', annos, obstacles(P, M.cap));
  }

  // ================================================================ INTERCEPT
  const I = {};
  I.cap = mkText('intercept', 'mt-foot', 1);
  I.geo = mkLine('intercept', 'ref'); I.geoL = mkText('intercept', 'mt-label', .8);
  I.orb = [0, 1].map(k => ({ line: mkLine('intercept', k === 0 ? 'orbitA' : 'orbitB'), dot: mkDot('intercept', k === 0 ? C.fog100 : C.white, 1.25, .9), ang: 0, last: null }));
  I.arc = mkRoute('intercept'); I.wait = mkLine('intercept', 'ref');
  I.dep = mkLine('intercept', 'marker'); I.rdv = mkLine('intercept', 'marker'); I.link = mkLine('intercept', 'link');
  I.b1 = mkText('intercept', 'mt-label', .9); I.b2 = mkText('intercept', 'mt-label', .9);
  const wrap = a => { a = a % TAU; return a < 0 ? a + TAU : a; };

  function updIntercept(P, dt) {
    const E = P.earth, Ps = [P['seldon-1'], P['seldon-2']];
    setCaption(I.cap, 'COPLANAR HOHMANN · ALTITUDE TO SCALE, EARTH NOT');
    const EYE = 'INTERCEPT · SELDON-1 TO SELDON-2';
    const hideAll = () => { hide(I.geo, I.geoL, I.arc, I.wait, I.dep, I.rdv, I.b1, I.b2, I.link); I.orb.forEach(o => hide(o.line, o.dot)); };
    if (!E) { hideAll(); setRails('intercept', { eyebrow: EYE, msg: 'Place Earth.' }); return; }
    const F = frameFor(P); if (!F) { hideAll(); return; }
    const wp = warpFor(F), ex = E.x_mm, ey = E.y_mm, annos = [];
    const rhoGeo = wp.rhoE(GEO_R);
    annos.push({ it: I.geoL, x: ex, y: ey - rhoGeo, html: 'GEO', spots: ringSpots(ex, ey, rhoGeo, [270, 90]) });
    const rhoMin = EARTH_PIECE_R + SELDON_BASE_R;
    const info = Ps.map((p, k) => {
      const o = I.orb[k];
      if (!p) { hide(o.line, o.dot); return null; }
      const dx = p.x_mm - ex, dy = p.y_mm - ey, rho = Math.max(rhoMin, Math.hypot(dx, dy));
      const r = Math.max(R_E + 200, wp.rInvE(rho)), theta = Math.atan2(-dy, dx);
      return { k, o, p, rho, r, theta, v: Math.sqrt(MU_E / r), T: TAU * Math.sqrt(r ** 3 / MU_E), n: Math.sqrt(MU_E / r ** 3) };
    });
    const nmax = Math.max(...info.filter(Boolean).map(i => i.n), 1e-9), warpRate = TAU / (nmax * 6);
    const z = 1;                                            // no zoom: the physical pieces sit on their orbits, so the orbits cannot shrink
    setPts(I.geo, circPts(ex, ey, rhoGeo * z, 192));
    for (const i of info) {
      if (!i) continue;
      const { o } = i;
      i.rz = i.rho * z;
      setPts(o.line, circPts(ex, ey, i.rz, 160));
      if (o.last === null || Math.abs(Math.atan2(Math.sin(i.theta - o.last), Math.cos(i.theta - o.last))) > 1e-3) o.ang = i.theta;
      o.last = i.theta; o.ang += i.n * warpRate * dt;
      o.dot.obj.position.set(ex + i.rz * Math.cos(o.ang), -(ey - i.rz * Math.sin(o.ang)), 1); o.dot.on = true;
    }
    const [c, t] = info;
    const done = () => placeAnnos('intercept', annos, obstacles(P, I.cap));
    if (c && t) setPts(I.link, [W(c.p.x_mm, c.p.y_mm), W(t.p.x_mm, t.p.y_mm)]); else hide(I.link);   // straight line between the two Seldons
    if (!c || !t) {
      hide(I.arc, I.wait, I.dep, I.rdv, I.b1, I.b2);
      setRails('intercept', { eyebrow: EYE, msg: !c && !t ? 'Place both Seldons.' : !c ? 'Place Seldon-1.' : 'Place Seldon-2.' });
      done(); return;
    }
    if (Math.abs(c.n - t.n) / Math.max(c.n, t.n) < 0.0015) {
      hide(I.arc, I.wait, I.dep, I.rdv, I.b1, I.b2);
      setRails('intercept', { eyebrow: EYE, msg: 'Co-orbital. Phasing needed.' });
      done(); return;
    }
    const h = hohmann(c.r, t.r);
    const alpha = Math.PI - t.n * h.tof, phi = t.theta - c.theta, dn = t.n - c.n;
    const delta = wrap(alpha - phi);
    const tw = delta < 1e-9 ? 0 : dn > 0 ? delta / dn : (delta - TAU) / dn;
    const thd = c.theta + c.n * tw;
    const a = h.a, e = Math.abs(t.r - c.r) / (c.r + t.r), p = a * (1 - e * e), up = t.r > c.r;
    const arc = [];
    for (let j = 0; j <= 120; j++) {
      const nu = (up ? 0 : Math.PI) + Math.PI * j / 120, r = p / (1 + e * Math.cos(nu)), ang = thd + Math.PI * j / 120, rho = wp.rhoE(r) * z;
      arc.push(W(ex + rho * Math.cos(ang), ey - rho * Math.sin(ang)));
    }
    setRoute(I.arc, arc);
    if (tw > 1e-6) setPts(I.wait, circPts(ex, ey, c.rz, 80, c.theta, c.theta + c.n * tw)); else hide(I.wait);
    const dx0 = ex + c.rz * Math.cos(thd), dy0 = ey - c.rz * Math.sin(thd);
    const tha = thd + Math.PI, rx = ex + t.rz * Math.cos(tha), ry = ey - t.rz * Math.sin(tha);
    setPts(I.dep, circPts(dx0, dy0, MARK_R, 28)); setPts(I.rdv, circPts(rx, ry, MARK_R, 28));
    annos.push({ it: I.b1, x: dx0, y: dy0, r: MARK_R, html: `BURN 1 <b>${num(h.dv1)}${U('km/s')}</b>` });
    annos.push({ it: I.b2, x: rx, y: ry, r: MARK_R, html: `BURN 2 <b>${num(h.dv2)}${U('km/s')}</b>` });
    setRails('intercept', { eyebrow: EYE, hero: num(h.total), unit: 'km/s', mets: [
      ['TRANSFER', fmtHM(h.tof).replace(/ (h|m)/g, (m, u) => U(u))], ['NEXT WINDOW', fmtHM(tw).replace(/ (h|m)/g, (m, u) => U(u))]] });
    done();
  }

  // ================================================================ DELTA-V MAP
  const D = {};
  D.cap = mkText('dvmap', 'mt-foot', 1);
  D.cnum = Array.from({ length: 16 }, (_, i) => (i + 1) / 2).map(v => ({ v, lbls: [0, 1, 2, 3].map(() => mkText('dvmap', 'mt-contour', 1)) }));   // Earth near/far, Moon near/far
  D.geo = mkLine('dvmap', 'ref'); D.geoL = mkText('dvmap', 'mt-label', .85);
  D.l1 = mkLine('dvmap', 'marker'); D.l1L = mkText('dvmap', 'mt-label', .9);
  D.l2 = mkLine('dvmap', 'marker'); D.l2L = mkText('dvmap', 'mt-label', .9);
  D.llo = mkLine('dvmap', 'ref'); D.lloL = mkText('dvmap', 'mt-label', .85);
  D.dro = mkLine('dvmap', 'target'); D.droL = mkText('dvmap', 'mt-label', .9);
  D.orb = mkLine('dvmap', 'orbitA'); D.orb2 = mkLine('dvmap', 'orbitB'); D.path = mkLine('dvmap', 'link');   // the route itself, dashed white D.orbL = mkText('dvmap', 'mt-label', .85);   // the two Seldons' actual orbits, solid (violet / white)
  D.route = mkRoute('dvmap');

  let dvKey = null, dvAt = -1e9;
  // contour-number labels, on a coarse grid (no allocations in the inner loops); field uses the same inverse warp as the floor
  const NX = 120, NY = 68, GV = new Float32Array((NX + 1) * (NY + 1));
  const ETAB = [[0, 0, 1, 0], [1, 0, 1, 1], [0, 1, 1, 1], [0, 0, 0, 1]];
  const STAB = [[], [3, 0], [0, 1], [3, 1], [1, 2], [3, 0, 1, 2], [0, 2], [3, 2], [2, 3], [0, 2], [0, 1, 2, 3], [1, 2], [3, 1], [0, 1], [3, 0], []];
  function recomputeField(F, obs) {
    const sw = SW(), sh = SH(), csx = sw / NX, csy = sh / NY, wpf = warpDvFor(F), geoClear = 0;   // rings are evenly spaced now, so labels may sit inside GEO
    const oVEc = vE(dvOrg.r), oVMc = vM(dvOrg.d), oWc = dvOrg.w, vEL = V_MOONORB, vMS = vM(MOON_SOI), invS = 1 / F.s;
    for (let j = 0; j <= NY; j++) for (let i = 0; i <= NX; i++) {
      const px = i * csx, py = j * csy, r = wpf.rInvE(Math.hypot(px - F.ex, py - F.ey)), d = wpf.rInvM(Math.hypot(px - F.mx, py - F.my));
      let v = NaN;
      if (r >= R_E && d >= R_M) {
        const a = vE(r), b = vM(d), t = d >= MOON_SOI ? 0 : d <= MOON_SOI - SOI_BLEND ? 1 : (MOON_SOI - d) / SOI_BLEND, wB = d >= MOON_SOI ? 0 : d <= MOON_SOI - SOI_BLEND ? 1 : t * t * (3 - 2 * t);
        v = (1 - oWc) * (1 - wB) * Math.abs(oVEc - a) + (1 - oWc) * wB * (Math.abs(oVEc - vEL) + Math.max(0, b - vMS)) + oWc * (1 - wB) * (Math.abs(a - vEL) + Math.max(0, oVMc - vMS)) + oWc * wB * Math.abs(oVMc - b);
      }
      GV[j * (NX + 1) + i] = v;
    }
    const cand = [0, 1, 2, 3].map(() => D.cnum.map(() => null)), mZone = wpf.dv ? wpf.dv.mRho1 : 0, stepE = wpf.dv ? wpf.dv.stepE : 1, stepM = wpf.dv ? wpf.dv.stepM : 1;   // [Earth near, Earth far, Moon near, Moon far]
    for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
      const va = GV[j * (NX + 1) + i], vb = GV[j * (NX + 1) + i + 1], vc = GV[(j + 1) * (NX + 1) + i + 1], vd = GV[(j + 1) * (NX + 1) + i];
      if (va !== va || vb !== vb || vc !== vc || vd !== vd) continue;
      const mn = Math.min(va, vb, vc, vd), mx = Math.max(va, vb, vc, vd);
      for (let q = 0; q < D.cnum.length; q++) {
        const l = D.cnum[q].v; if (l <= mn || l > mx) continue;
        const idx = (va > l ? 1 : 0) | (vb > l ? 2 : 0) | (vc > l ? 4 : 0) | (vd > l ? 8 : 0), st = STAB[idx];
        for (let k = 0; k < st.length; k += 2) {
          let sx = 0, sy = 0, ex0 = 0, ey0 = 0, ex1 = 0, ey1 = 0;
          for (let h = 0; h < 2; h++) {
            const e = ETAB[st[k + h]], v0 = GV[(j + e[1]) * (NX + 1) + i + e[0]], v1 = GV[(j + e[3]) * (NX + 1) + i + e[2]], tt = (l - v0) / (v1 - v0);
            const qx = (i + e[0] + (e[2] - e[0]) * tt) * csx, qy = (j + e[1] + (e[3] - e[1]) * tt) * csy;
            sx += qx; sy += qy; if (h === 0) { ex0 = qx; ey0 = qy; } else { ex1 = qx; ey1 = qy; }
          }
          const x = sx / 2, y = sy / 2;
          if (y < MARG + RAIL_H + 12 || y > sh - MARG - RAIL_H - 12 || x < 60 || x > sw - 60) continue;
          let blocked = false;
          for (let z = 0; z < obs.circ.length; z++) { const o = obs.circ[z]; if (Math.hypot(x - o[0], y - o[1]) < o[2] + 6) { blocked = true; break; } }
          if (!blocked) for (let z = 0; z < obs.rects.length; z++) { const o = obs.rects[z]; if (x > o[0] - 8 && x < o[2] + 8 && y > o[1] - 8 && y < o[3] + 8) { blocked = true; break; } }
          if (!blocked && Math.hypot(x - F.ex, y - F.ey) < geoClear) blocked = true;
          if (blocked) continue;
          const far = farSide(y), moon = Math.hypot(x - F.mx, y - F.my) < mZone, bx = moon ? F.mx : F.ex, lv = D.cnum[q].v, stp = moon ? stepM : stepE;
          if (Math.abs(lv / stp - Math.round(lv / stp)) > 1e-6) continue;
          const _unused = 0, sc = (far ? y : -y) + .35 * Math.abs(x - bx), slot = cand[(moon ? 2 : 0) + (far ? 1 : 0)];   // far half: top of the ring; near half: bottom (text ends up horizontal)
          if (!slot[q] || sc < slot[q].sc) slot[q] = { x, y, sc, dx: ex1 - ex0, dy: ey1 - ey0 };
        }
      }
    }
    const lab = (it, c, v) => { if (c && topo) { setText(it, `${v}<i>km/s</i>`); place(it, c.x, c.y, 'cm', tangentRot(c.dx, c.dy, c.y)); } else hide(it); };
    D.cnum.forEach((cn, q) => cn.lbls.forEach((it, z) => lab(it, cand[z][q], cn.v)));   // the map's labels stay on in corners-only text mode
  }

  function updDv(P, dt, now) {
    const E = P.earth, Mo = P.moon, A = P['seldon-1'], B = P['seldon-2'];
    const from = A ? 'SELDON-1' : 'LEO';
    setCaption(D.cap, `DELTA-V FROM ${A ? from : '400 KM LEO'} · LOW-THRUST ESTIMATE · COPLANAR · PHASING IGNORED · BANDS 0.5 KM/S`);
    const EYE = `DELTA-V MAP · FROM ${from}`;
    const hideAll = () => { hide(D.geo, D.geoL, D.l1, D.l1L, D.l2, D.l2L, D.llo, D.lloL, D.dro, D.droL, D.route, D.orb, D.orb2, D.orbL, D.path); D.cnum.forEach(c => hide(...c.lbls)); };
    if (!E || !Mo) { hideAll(); setRails('dvmap', { eyebrow: EYE, msg: msgFor(E, Mo, true) }); return; }
    const F = frameEM(E, Mo);
    if (!F) { hideAll(); return; }
    dvOrg = A ? ptKm(F, A.x_mm, A.y_mm) : LEO_ORIGIN;
    const key = F.key + '|' + (A ? Math.round(A.x_mm * 10) + ',' + Math.round(A.y_mm * 10) : 'leo');
    const obs = obstacles(P, D.cap);
    // contour numbers follow the floor: fade with it, vanish when the topography is off, and get re-placed when it comes back
    if (topo && !D.labelsOn) dvKey = null; D.labelsOn = topo;
    D.cnum.forEach(cn => cn.lbls.forEach(it => { it.base = floorStr; if (!topo || REACH || cn.v > budgetS + .04) it.on = false; }));
    const wantField = topo && !REACH && dvKey !== key && now - dvAt > 100;
    const finish = () => {                                    // place labels first, then number the contours around them
      placeAnnos('dvmap', annos, obs);
      if (wantField) { recomputeField(F, { circ: obs.circ, rects: obs.rects.concat(placedStore.dvmap || []) }); dvKey = key; dvAt = now; }
    };
    const wp = warpDvFor(F), path = getPath(F);
    const costAt = (r, d) => dvCost(dvOrg, mkPt(r, d));
    const annos = [];
    // each Seldon's actual orbit: a solid circle about whichever body it is bound to (Moon inside its zone, else Earth)
    const mZoneR = wp.dv ? wp.dv.mRho1 : 0;
    const orbitOf = (pc, it) => { if (!pc) { hide(it); return; } const moon = Math.hypot(pc.x_mm - F.mx, pc.y_mm - F.my) < mZoneR;
      const cx = moon ? F.mx : F.ex, cy = moon ? F.my : F.ey; setPts(it, circPts(cx, cy, Math.hypot(pc.x_mm - cx, pc.y_mm - cy), 180)); };
    orbitOf(A, D.orb); orbitOf(B, D.orb2); hide(D.orbL);
    const rGeo = wp.rhoE(GEO_R);
    const vGeo = costAt(GEO_R, L_KM + GEO_R), vL1 = costAt(326400, L_KM - 326400), vL2 = costAt(448900, 448900 - L_KM), vLLO = costAt(L_KM, R_M + 100);
    // reference orbits and libration points are off in the map (user: the gradient and its labels are the point); POI = true brings them back
    const POI = false;
    if (POI) {
    setPts(D.geo, circPts(F.ex, F.ey, rGeo, 160));
    annos.push({ it: D.geoL, x: F.ex, y: F.ey - rGeo, html: `GEO <b>${num(vGeo)}${U('km/s')}</b>`, spots: ringSpots(F.ex, F.ey, rGeo, [270, 90]) });
    const l1 = F.to(326400, 0), l2 = F.to(448900, 0);
    setPts(D.l1, circPts(l1[0], l1[1], MARK_R, 28)); annos.push({ it: D.l1L, x: l1[0], y: l1[1], r: MARK_R, html: `L1 <b>${num(vL1)}${U('km/s')}</b>` });
    setPts(D.l2, circPts(l2[0], l2[1], MARK_R, 28)); annos.push({ it: D.l2L, x: l2[0], y: l2[1], r: MARK_R, html: `L2 <b>${num(vL2)}${U('km/s')}</b>` });
    const rLLO = Math.max(wp.rhoM(R_M + 100), MOON_PIECE_R + 6);   // mission data's 70,000 km flyby alt switches the Moon push-out off, so keep the ring clear of the base
    setPts(D.llo, circPts(F.mx, F.my, rLLO, 64)); annos.push({ it: D.lloL, x: F.mx, y: F.my - rLLO, html: `LLO <b>${num(vLLO)}${U('km/s')}</b>`, spots: ringSpots(F.mx, F.my, rLLO, [270, 90]) });
    } else hide(D.geo, D.geoL, D.l1, D.l1L, D.l2, D.l2L, D.llo, D.lloL);
    let vDro = 0;
    if (mission?.dro?.points?.length) { let sum = 0; for (const [x, y] of mission.dro.points) sum += costAt(Math.hypot(x, y), Math.hypot(x - L_KM, y)); vDro = sum / mission.dro.points.length; }
    if (POI && path?.dro) {
      const X = path.dro.X, Y = path.dro.Y; let it = 0, ib = 0, il = 0, ir = 0;
      for (let i = 1; i < X.length; i++) { if (Y[i] < Y[it]) it = i; if (Y[i] > Y[ib]) ib = i; if (X[i] < X[il]) il = i; if (X[i] > X[ir]) ir = i; }
      setPts(D.dro, X.map((x, i) => W(x, Y[i])));
      annos.push({ it: D.droL, x: X[it], y: Y[it], html: `DRO <b>${num(vDro)}${U('km/s')}</b>`, spots: curveSpots(X, Y, [ib, it, ir, il]) });
    } else hide(D.dro, D.droL);
    // destination: Seldon-2
    if (!B) { setRails('dvmap', { eyebrow: EYE, msg: 'Place Seldon-2 to price it.' }); hide(D.route, D.path); finish(); return; }
    const f = deltaV(F, B.x_mm, B.y_mm);
    if (!f) { hide(D.route, D.path); setRails('dvmap', { eyebrow: EYE, msg: 'Move Seldon-2 off the body.' }); finish(); return; }
    const bPt = ptKm(F, B.x_mm, B.y_mm), bothMoon = dvOrg.w > .5 && f.br === 'moon';
    const rt = f.br === 'moon' ? (bothMoon ? 'LUNAR SPIRAL' : 'SPIRAL + CAPTURE') : 'EARTH SPIRAL';
    const days = f.v * 1000 / 0.0005 / 86400;            // Edelbaum at 0.5 mm/s2
    setRails('dvmap', { eyebrow: EYE, hero: num(f.v), unit: 'km/s', mets: [['TIME', `${days >= 20 ? Math.round(days) : num(days, 1)}${U('d')}`], ['ROUTE', rt]] });
    // route: Earth-centred prograde spiral, radius interpolated with angle, plus one extra turn (positions un-warped to km)
    // route: one smooth spiral in screen polar coordinates (about the Moon when both ends are in its sphere, else about Earth);
    // drawn in screen space so the map's radial warps can't put a kink in it. Phasing is ignored, so the sweep takes the shorter way.
    const aScr = A ? [A.x_mm, A.y_mm] : wp(F.to(R_LEO, 0)), bScr = [B.x_mm, B.y_mm];
    const [cx, cy] = bothMoon ? [F.mx, F.my] : [F.ex, F.ey];
    const rA = Math.hypot(aScr[0] - cx, aScr[1] - cy), thA = Math.atan2(aScr[1] - cy, aScr[0] - cx);
    const rB = Math.hypot(bScr[0] - cx, bScr[1] - cy), thB = Math.atan2(bScr[1] - cy, bScr[0] - cx);
    let dth = ((thB - thA) % TAU + TAU) % TAU; if (dth > Math.PI) dth -= TAU;
    const avoid = (p, bx, by, minR) => { const b = 3 * minR, dx = p[0] - bx, dy = p[1] - by, d = Math.hypot(dx, dy); if (d >= b || d < 1e-6) return p; const nd = d + (minR - d) * (1 - d / b) ** 2; return [bx + dx / d * nd, by + dy / d * nd]; };
    const pts = []; for (let j = 0; j <= 240; j++) { const t = j / 240, te = t * t * (3 - 2 * t), r = rA + (rB - rA) * te, a = thA + dth * t;
      let q = [cx + r * Math.cos(a), cy + r * Math.sin(a)]; q = avoid(q, F.mx, F.my, MOON_PIECE_R + 14); q = avoid(q, F.ex, F.ey, EARTH_PIECE_R + 14); pts.push(W(q[0], q[1])); }
    setPts(D.path, pts); hide(D.route);
    finish();
  }

  // ================================================================ ENGAGE: the real wargame engagement (OEL physics)
  // tools/engage_server.py runs the Engagement Lab's own run (GG-1 base vs a mirrored GG-1, scenario doctrine, seed 0;
  // cross-track manoeuvres banned, both craft start on circular coplanar orbits). Earth sits fixed at the table centre;
  // the Moon is not part of this mode. Each Seldon's distance from Earth sets its orbit, drawn as a ring before the run.
  // The picture is an Earth-centred polar view with the relative motion magnified: radial and in-track offsets from the
  // reference (target-role) orbit are drawn at ENG_KM_PER_MM, while the shared orbital motion turns at the true rate.
  // Seldon-1 is ours (mint), Seldon-2 the adversary (red). Solid = what the sim flew; dashed = each craft's orbit from
  // that moment if it never burned again (Hill / Clohessy-Wiltshire coast about the circular reference orbit).
  const ENG_URL = ctx.engageUrl || `http://${location.hostname || 'localhost'}:8791`;
  // the laptop's control page (control.html) chooses the scenario and every parameter and presses Start; the table only
  // has the pieces and the hand-driven ZOOM slider. Shared state lives on the sim server (/control, /status).
  const engScen = () => ENG.ctrl?.scenario || ctx.engageScenario || 'defend_keepout';
  const RING_DEF = { defend_keepout: .25, pursue_evader: .15 };
  const engK = () => 1 / ENG.vals.s.zoom;                    // km per mm of separation before the run (SETUP: ZOOM)
  const ENG_SPEED = 60, ENG_HOLD = 4;                         // sim seconds per real second; seconds held on the result
  const ENG_NAME = { defend_keepout: 'DEFEND', pursue_evader: 'PURSUE' };
  const ENG_N0 = Math.sqrt(398600.4418 / 7000 ** 3);          // both featured scenarios: circular 7000 km reference
  const engEarth = () => ({ x: SW() / 2, y: SH() / 2 });
  // View: the pair rides its orbit at TRUE scale; only the separation between the two craft is magnified, in a lens
  // that travels with them. Distance from Earth on the table is the orbit radius: real altitude changes here are a few
  // km out of ~7000 km (under 0.1%), so at true scale the pair stays on its circle (the tiny true-scale drift is still
  // applied). Each craft's offset from the pair's midpoint is drawn linearly at s mm per km: 1/ENG_KM_PER_MM (200) at
  // the start, zooming out smoothly (never in) whenever the fight would otherwise reach toward Earth or off the table.
  // No compression and no floor; a scale bar shows the current zoom.
  const ENG_EARTH_CLEAR = 78, ENG_COAST_MIN_S = 240, ENG_ARC_ROOM = 1.1;   // mm from Earth's centre; s; rad of arc each side
  const engRoomIn = rho0 => Math.max(15, rho0 - ENG_EARTH_CLEAR), engRoomOut = rho0 => Math.max(25, SH() / 2 - MARG - 6 - rho0);
  // g: { ex, ey, rho0, phi0 }; (cR, cI) the pair's midpoint at ts; A the reference orbit radius (km); s mm per km
  function engMap(g, R, I, cR, cI, ts, n, A, s) {
    const rho = g.rho0 * (1 + cR / A) + (R - cR) * s, phi = g.phi0 + n * ts + cI / A + (I - cI) * s / g.rho0;
    return [g.ex + rho * Math.cos(phi), g.ey - rho * Math.sin(phi)];
  }
  // zoom track for a run: the largest s <= 1/K that keeps both craft inside the room up to each moment (a prefix
  // minimum, eased in over the preceding minute so it never jumps)
  function engZoom(R, rho0) {
    const N = R.t.length, s0 = 1 / ENG.geo.K, inR = engRoomIn(rho0), outR = engRoomOut(rho0), arc = rho0 * ENG_ARC_ROOM, fit = new Float32Array(N);
    for (let k = 0; k < N; k++) {
      const cR = (R.cha[k][0] + R.tgt[k][0]) / 2, cI = (R.cha[k][1] + R.tgt[k][1]) / 2;
      let f = s0;
      for (const p of [R.cha[k], R.tgt[k]]) {
        const dR = p[0] - cR, dI = p[1] - cI;
        if (dR < 0) f = Math.min(f, inR / -dR); else if (dR > 0) f = Math.min(f, outR / dR);
        if (dI) f = Math.min(f, arc / Math.abs(dI));
      }
      fit[k] = f;
    }
    const LA = Math.max(1, Math.round(60 / ((R.t[N - 1] - R.t[0]) / (N - 1)))), z = new Float32Array(N);
    let run = s0;
    for (let k = 0; k < N; k++) {                             // prefix minimum of the look-ahead window: zoom out a minute early
      let w = s0; for (let j = k; j < Math.min(N, k + LA); j++) w = Math.min(w, fit[j]);
      run = Math.min(run, w); z[k] = run;
    }
    // ease: zoom out at most e-fold per tau (sim s; about half a second of playback), started early enough to arrive in time
    const dts = (R.t[N - 1] - R.t[0]) / (N - 1), tau = Math.max(20, (R.t[N - 1] - R.t[0]) / 60), gk = Math.exp(dts / tau);
    for (let k = N - 2; k >= 0; k--) z[k] = Math.min(z[k], z[k + 1] * gk);
    return z;
  }
  const G = {
    ringO: mkLine('engage', 'orbitA'), ringA: mkLine('engage', 'orbitB'),             // starting orbits (before the run)
    coastO: mkLine('engage', 'coastA'), coastA: mkLine('engage', 'coastB'),           // no-more-burns orbits at the playhead
    trailO: mkLine('engage', 'orbitA'), trailA: mkLine('engage', 'orbitB'),           // what the sim flew
    thrO: mkLine('engage', 'thrust'), thrA: mkLine('engage', 'thrust'),
    scaleL: mkLine('engage', 'thrust'), scaleT: mkText('engage', 'mt-chip on'),         // lens scale bar
    keep: mkLine('engage', 'ring'), dotO: mkDot('engage', C.mint, 3.8, 1), dotA: mkDot('engage', 0xe2604f, 3.8, 1),
  };
  const ENG = { res: null, key: null, busy: false, err: null, still: 0, last: null, play: 0, geo: null, now: null, gauge: null };

  // ---------------------------------------------------------------- engagement panels
  // Three panels: ours (presenter's short end), the adversary's (other short end), and a neutral SETUP panel centred on
  // the presenter's long edge. Every panel shows all of its numbers at once, but has ONE slider. Two printed codes per
  // panel: a SELECTOR code, placed in a field's box to choose what the slider changes, and a VALUE code on the slider.
  // Pickup (like a mixing desk fader): after a new field is selected the slider does nothing until the value code
  // reaches that field's mark, so values never jump. Codes: sl:<o|a|s>:sel and sl:<o|a|s>:val.
  const ENG_SL = [
    { id: 'thrust', label: 'THRUST', unit: 'N', min: .05, max: 50, log: true, def: 1 },
    { id: 'fuel', label: 'FUEL', unit: 'kg', min: .5, max: 200, log: true, def: 5 },
    { id: 'dry', label: 'DRY MASS', unit: 'kg', min: 50, max: 2000, log: true, def: 180 },
    { id: 'isp', label: 'ISP', unit: 's', min: 100, max: 400, log: false, def: 220, step: 5 },
  ];
  const ZOOM_DEF = ctx.engageScale ? 1 / ctx.engageScale : 200;   // mm of table per km of separation
  const ENG_SETUP = [
    { id: 'time', label: 'TIME', unit: 's', min: 300, max: 12000, log: true, def: 1800 },
    { id: 'ring', label: engScen().startsWith('pursue') ? 'CAPTURE ZONE' : 'KEEPOUT ZONE', unit: 'km', min: .02, max: 2, log: true,
      def: .25 },
    { id: 'speed', label: 'PLAYBACK', unit: '×', min: .25, max: 4, log: true, def: 1 },
    { id: 'zoom', label: 'ZOOM', unit: 'mm/km', min: 50, max: 800, log: true, def: ZOOM_DEF },
  ];
  const slT = (sl, v) => sl.log ? Math.log(v / sl.min) / Math.log(sl.max / sl.min) : (v - sl.min) / (sl.max - sl.min);
  const slV = (sl, t) => sl.log ? sl.min * Math.pow(sl.max / sl.min, t) : sl.min + t * (sl.max - sl.min);
  const clean = (sl, v) => sl.step ? Math.round(v / sl.step) * sl.step : +v.toPrecision(2);
  const fmtV = v => v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(1) : v >= .1 ? v.toFixed(2) : v.toFixed(3);
  const fmtField = (sl, v) => sl.id === 'time' ? (v >= 3600 ? `${(v / 3600).toFixed(1)}<i>h</i>` : `${Math.round(v / 60)}<i>min</i>`)
    : sl.id === 'speed' ? `${fmtV(v)}<i>×</i>` : `${fmtV(v)}<i>${sl.unit}</i>`;
  ENG.vals = { o: Object.fromEntries(ENG_SL.map(sl => [sl.id, sl.def])), a: Object.fromEntries(ENG_SL.map(sl => [sl.id, sl.def])),
    s: Object.fromEntries(ENG_SETUP.map(sl => [sl.id, sl.def])) };
  const engFields = side => side === 's' ? ENG_SETUP : ENG_SL;
  // geometry. Player panels run along a short end (text rotated to read from that end); setup runs along the long edge.
  const ENG_Y0 = 150, engY1 = () => SH() - 150, BOXMM = 30;
  const engEnd = side => (side === 'o') === (END === 'right') ? 'right' : 'left';
  const engColX = (side, off) => engEnd(side) === 'left' ? MARG + off : SW() - MARG - off;
  const engRot = side => side === 's' ? 0 : engEnd(side) === 'left' ? 90 : -90;
  const COL = { head: 24, gauge: 74, box: 128, text: 172, track: 236 };
  // field k's box centre, the slider track ends, and the position along it for a 0..1 value
  function engGeom(side) {
    const F = engFields(side), n = F.length;
    if (side === 's') {
      const cx = SW() / 2, pitch = 120, y = SH() - MARG - 78;
      return { boxes: F.map((_, k) => ({ x: cx + (k - (n - 1) / 2) * pitch, y })), text: F.map((_, k) => ({ x: cx + (k - (n - 1) / 2) * pitch, y: y + 30 })),
        t0: { x: cx - 230, y: SH() - MARG - 14 }, t1: { x: cx + 230, y: SH() - MARG - 14 } };
    }
    const y0 = ENG_Y0, y1 = engY1(), left = engEnd(side) === 'left', seg = (y1 - y0) / n;
    const yk = k => left ? y0 + seg * (k + .5) : y1 - seg * (k + .5);
    return { boxes: F.map((_, k) => ({ x: engColX(side, COL.box), y: yk(k) })), text: F.map((_, k) => ({ x: engColX(side, COL.text), y: yk(k) })),
      t0: { x: engColX(side, COL.track), y: left ? y0 : y1 }, t1: { x: engColX(side, COL.track), y: left ? y1 : y0 } };
  }
  const along = (g, t) => ({ x: g.t0.x + (g.t1.x - g.t0.x) * t, y: g.t0.y + (g.t1.y - g.t0.y) * t });
  function onTrackT(g, c) {                                     // 0..1 along the track, or null if the code is not on it
    const dx = g.t1.x - g.t0.x, dy = g.t1.y - g.t0.y, L2 = dx * dx + dy * dy, t = ((c.x_mm - g.t0.x) * dx + (c.y_mm - g.t0.y) * dy) / L2;
    const px = g.t0.x + dx * t, py = g.t0.y + dy * t;
    if (Math.hypot(c.x_mm - px, c.y_mm - py) > 26 || t < -.08 || t > 1.08) return null;
    return Math.max(0, Math.min(1, t));
  }
  const PAN = {};
  for (const side of ['o', 'a', 's']) {
    const fk = side === 'a' ? 'fillB' : side === 'o' ? 'fill' : 'track';
    PAN[side] = { sel: 0, grabbed: true, prevT: null,
      boxes: engFields(side).map(() => mkLine('engage', 'track')), texts: engFields(side).map(() => mkText('engage', 'mt-chip')),
      track: mkLine('engage', 'track'), fill: mkLine('engage', fk), mark: mkLine('engage', 'thrust'), cap: mkText('engage', 'mt-chip on') };
  }
  const ENGC = {};
  for (const side of ['o', 'a']) ENGC[side] = { head: mkText('engage', 'mt-chip on'), gT: mkLine('engage', 'track'), gF: mkLine('engage', side === 'o' ? 'fill' : 'fillB'),
    gL: mkText('engage', 'mt-chip'), gV: mkText('engage', 'mt-slv') };
  // default code positions (the demo seeds its stand-in chips here): selector on the first field, value code on its mark
  function engChips() {
    const out = [];
    for (const side of ['o', 'a', 's']) {
      const g = engGeom(side), F = engFields(side), k = PAN[side].sel, p = along(g, slT(F[k], ENG.vals[side][F[k].id]));
      out.push({ key: `sl:${side}:sel`, x: g.boxes[k].x, y: g.boxes[k].y }, { key: `sl:${side}:val`, x: p.x, y: p.y });
    }
    return out;
  }
  function panel(side, P) {
    const g = engGeom(side), F = engFields(side), S = PAN[side], V = ENG.vals[side], rot = engRot(side);
    const selC = P[`sl:${side}:sel`], valC = P[`sl:${side}:val`];
    if (selC) g.boxes.forEach((b, k) => { if (Math.hypot(selC.x_mm - b.x, selC.y_mm - b.y) < BOXMM * .75 && S.sel !== k) { S.sel = k; S.grabbed = false; S.prevT = null; } });
    const f = F[S.sel], tv = slT(f, V[f.id]), tc = valC ? onTrackT(g, valC) : null;
    if (tc == null) S.prevT = null;
    else {
      if (!S.grabbed && (Math.abs(tc - tv) < .025 || (S.prevT != null && (S.prevT - tv) * (tc - tv) <= 0))) S.grabbed = true;   // pickup
      if (S.grabbed) V[f.id] = Math.min(f.max, Math.max(f.min, clean(f, slV(f, tc))));
      S.prevT = tc;
    }
    const col = side === 'a' ? 0xe2604f : side === 'o' ? C.mint : C.white;
    g.boxes.forEach((b, k) => {
      const h = BOXMM / 2, on = k === S.sel, it = S.boxes[k];
      setPts(it, [W(b.x - h, b.y - h), W(b.x + h, b.y - h), W(b.x + h, b.y + h), W(b.x - h, b.y + h), W(b.x - h, b.y - h)]);
      it.obj.material.color.set(on ? col : C.fog300); it.base = on ? 1 : .5;
      const tx = S.texts[k]; setText(tx, `${F[k].label}&nbsp; <b style="font-size:1.6em">${fmtField(F[k], V[F[k].id]).replace(/<i>/, '</b><i>')}`);
      if (!tx.html.includes('</b>')) setText(tx, tx.html + '</b>');
      tx.obj.classList.toggle('on', on); place(tx, g.text[k].x, g.text[k].y, 'cm', rot);
    });
    const tNow = slT(f, V[f.id]), pv = along(g, tNow), nx = -(g.t1.y - g.t0.y), ny = g.t1.x - g.t0.x, nl = Math.hypot(nx, ny), ux = nx / nl * 9, uy = ny / nl * 9;
    setPts(S.track, [W(g.t0.x, g.t0.y), W(g.t1.x, g.t1.y)]); setPts(S.fill, [W(g.t0.x, g.t0.y), W(pv.x, pv.y)]);
    setPts(S.mark, [W(pv.x - ux, pv.y - uy), W(pv.x + ux, pv.y + uy)]);                        // the mark the value code picks up at
    const capAt = along(g, side === 's' ? -.12 : 1.1);
    setText(S.cap, S.grabbed || !valC ? `SET ${f.label}` : `SET ${f.label} · SLIDE TO THE MARK`);
    place(S.cap, capAt.x, capAt.y, side === 's' ? 'r' : 'cm', rot);
  }
  const G0 = 9.80665;
  const dvCap = v => v.isp * G0 * Math.log((v.dry + v.fuel) / v.dry);          // m/s, full tank
  // ---- laptop link: poll the control state, post status back
  ENG.startSeen = null; ENG.resetSeen = null; ENG.startReq = false; ENG.lastPoll = 0; ENG.lastStatus = 0; ENG.status = {};
  function engPoll(now) {
    if (now - ENG.lastPoll < 250 || ENG.polling) return;
    ENG.lastPoll = now; ENG.polling = true;
    fetch(ENG_URL + '/control').then(r => r.json()).then(c => {
      ENG.ctrl = c; ENG.ctrlErr = false;
      for (const side of ['o', 'a']) Object.assign(ENG.vals[side], c[side === 'o' ? 'ours' : 'adv']);
      ENG.vals.s.time = +c.time_s || 1800; ENG.vals.s.speed = +c.speed || 1;
      ENG.vals.s.ring = c.ring_km != null ? +c.ring_km : (RING_DEF[c.scenario] ?? .25);
      if (ENG.startSeen == null) { ENG.startSeen = c.start_seq; ENG.resetSeen = c.reset_seq; }   // never auto-run on page load
      if (c.start_seq !== ENG.startSeen) { ENG.startSeen = c.start_seq; ENG.startReq = true; }
      if (c.reset_seq !== ENG.resetSeen) { ENG.resetSeen = c.reset_seq; ENG.res = null; ENG.key = null; ENG.startReq = false; }
    }).catch(() => { ENG.ctrlErr = true; }).finally(() => { ENG.polling = false; });
    if (now - ENG.lastStatus > 500) {
      ENG.lastStatus = now;
      fetch(ENG_URL + '/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ENG.status) }).catch(() => {});
    }
  }
  // ---- the one table control: ZOOM, set by hand (camera key 'hand'; demo: a draggable stand-in). Locked while a run plays.
  const ZF = ENG_SETUP.find(f => f.id === 'zoom');
  const zoomTrack = () => ({ t0: { x: SW() / 2 - 230, y: SH() - MARG - 22 }, t1: { x: SW() / 2 + 230, y: SH() - MARG - 22 } });
  const Z = { track: mkLine('engage', 'track'), fill: mkLine('engage', 'track'), mark: mkLine('engage', 'thrust'), lbl: mkText('engage', 'mt-chip on'), val: mkText('engage', 'mt-slv'), ring: mkLine('engage', 'track') };
  // a hand moves a zoom slider only by a deliberate drag: it must first rest on the knob (within GRAB_MM along the track)
  // for GRAB_S; then the knob follows it. A jump of more than JUMP_MM between updates, or leaving the track for LET_GO_S,
  // lets go. Touching the track anywhere else, or a fingertip flickering onto it, does nothing (user, Oct 9).
  const GRAB_MM = 45, GRAB_S = .25, JUMP_MM = 70, LET_GO_S = .3;
  function dragT(st, g, h, tKnob, dt) {                       // -> the dragged position (0..1) or null
    const L = Math.hypot(g.t1.x - g.t0.x, g.t1.y - g.t0.y), t = h ? onTrackT(g, h) : null;
    if (t == null) { st.off = (st.off || 0) + dt; if (st.off > LET_GO_S) { st.held = false; st.rest = 0; } st.last = null; return null; }
    st.off = 0;
    if (st.last != null && Math.abs(t - st.last) * L > JUMP_MM) { st.held = false; st.rest = 0; }
    st.last = t;
    if (!st.held) {
      if (Math.abs(t - tKnob) * L <= GRAB_MM) { st.rest = (st.rest || 0) + dt; st.held = st.rest >= GRAB_S; } else st.rest = 0;
      return null;
    }
    return t;
  }
  const engDrag = {};
  function zoomSlider(P, locked, dt = 1 / 60) {
    const g = zoomTrack(), h = P.hand, V = ENG.vals.s;
    let active = false;
    const td = locked ? null : dragT(engDrag, g, h, slT(ZF, V.zoom), dt);
    if (td != null) { active = true; const v = clean(ZF, slV(ZF, td)); V.zoom += (v - V.zoom) * .35; if (Math.abs(V.zoom - v) < .5) V.zoom = v; }
    const pv = along(g, slT(ZF, V.zoom));
    setPts(Z.track, [W(g.t0.x, g.t0.y), W(g.t1.x, g.t1.y)]); setPts(Z.fill, [W(g.t0.x, g.t0.y), W(pv.x, pv.y)]);
    setPts(Z.mark, [W(pv.x, pv.y - 9), W(pv.x, pv.y + 9)]);
    hide(Z.ring);                                              // no hand cursor (Oct 9: unnecessary)
    setText(Z.lbl, locked ? 'ZOOM · LOCKED DURING THE RUN' : 'ZOOM'); place(Z.lbl, g.t0.x - 14, g.t0.y, 'r', 0);
    setText(Z.val, `${Math.round(V.zoom)}<i>mm per km</i>`); place(Z.val, g.t1.x + 14, g.t1.y, 'l', 0);
  }
  function engControls(P) {
    for (const side of ['o', 'a']) {
      const U = ENGC[side], rot = engRot(side), y0 = ENG_Y0, y1 = engY1(), left = engEnd(side) === 'left';
      const lo = left ? y0 : y1, hi = left ? y1 : y0, sgn = left ? 1 : -1;
      // gauge: fuel left in the tank, and delta-v used of what a full tank gives (both from the sim's own mass history)
      const v = ENG.vals[side], g = ENG.gauge?.[side], cap = dvCap(v), used = g ? g.used : 0, frac = g ? g.frac : 1, xg = engColX(side, COL.gauge);
      setPts(U.gT, [W(xg, y0), W(xg, y1)]);
      if (frac > .005) setPts(U.gF, [W(xg, lo), W(xg, lo + (hi - lo) * frac)]); else hide(U.gF);
      setText(U.gL, 'FUEL LEFT'); place(U.gL, xg, lo - sgn * 40, 'cm', rot);
      setText(U.gV, `${Math.round(frac * 100)}<i>%</i>`); place(U.gV, xg, hi + sgn * 38, 'cm', rot);
      setText(U.head, `${side === 'o' ? 'GG-1 · OURS' : 'ADVERSARY'} &nbsp;·&nbsp; ${fmtV(v.thrust)} N · ${fmtV(v.fuel)}+${fmtV(v.dry)} KG · ISP ${Math.round(v.isp)} S &nbsp;·&nbsp; DELTA-V USED <b>${used.toFixed(1)}</b> / ${cap.toFixed(0)}<i>m/s</i>`);
      place(U.head, engColX(side, COL.head), (y0 + y1) / 2, 'cm', rot);
    }
  }
  const wrapPi = a => Math.atan2(Math.sin(a), Math.cos(a));
  const polar = (Ee, p) => ({ rho: Math.hypot(p.x_mm - Ee.x, p.y_mm - Ee.y), phi: Math.atan2(-(p.y_mm - Ee.y), p.x_mm - Ee.x) });   // phi CCW as seen from above
  // Hill coast: relative state (x radial, y in-track, km and km/s) after tau seconds with no thrust
  function cw(n, x, y, vx, vy, tau) {
    const c = Math.cos(n * tau), s = Math.sin(n * tau);
    return [(4 - 3 * c) * x + s / n * vx + 2 * (1 - c) / n * vy, 6 * (s - n * tau) * x + y - 2 * (1 - c) / n * vx + (4 * s - 3 * n * tau) / n * vy];
  }
  async function engRun(req) {
    ENG.busy = true; ENG.err = null;
    try {
      const r = await fetch(ENG_URL + '/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req) });
      const j = await r.json(); if (!r.ok || j.error) throw new Error(j.error || r.status);
      ENG.res = j; ENG.key = req.key; ENG.play = +ctx.engageStart || 0; ENG.geo = req.geo;   // engageStart: test hook (sim s)
    } catch (e) { ENG.err = String(e.message || e); ENG.key = req.key; }
    ENG.busy = false;
  }
  function engScaleBar(sMmPerKm) {
    const km = [10, 5, 2, 1, .5, .25, .1, .05].find(k => k * sMmPerKm <= 150) ?? .05, L = km * sMmPerKm, y = SH() - MARG - 122, x0 = SW() / 2 - L / 2;
    setPts(G.scaleL, [W(x0, y - 3), W(x0, y), W(x0 + L, y), W(x0 + L, y - 3)]);
    setText(G.scaleT, `${km >= 1 ? km : km * 1000}<i>${km >= 1 ? 'km' : 'm'}</i>&nbsp; SEPARATION`); place(G.scaleT, SW() / 2, y - 12, 'c', 0);
  }
  function updEngage(P, _dt, now) {
    const dt = ENG.now == null ? 0 : Math.min(1, (now - ENG.now) / 1000); ENG.now = now;   // real clock: frame-rate independent
    engPoll(now);
    engControls(P);
    const A = P['seldon-1'], B = P['seldon-2'], EYE = `ENGAGEMENT · ${ENG_NAME[engScen()] || engScen().toUpperCase()}`;
    ENG.zoomNow = ENG.zoomNow ?? 1;
    const hideAll = () => hide(G.ringO, G.ringA, G.coastO, G.coastA, G.trailO, G.trailA, G.keep, G.dotO, G.dotA, G.thrO, G.thrA, G.scaleL, G.scaleT);
    if (!A || !B) { hideAll(); setRails('engage', { eyebrow: EYE, msg: 'Place Seldon-1 and Seldon-2.' }); return; }
    const Ee = engEarth(), K = engK(), pA = polar(Ee, A), pB = polar(Ee, B);
    // the sim takes the CHASER's offset from the TARGET (the reference orbit); Defend: we are the target, Pursue: the chaser
    const weChase = engScen().startsWith('pursue');
    const T = weChase ? pB : pA, Cc = weChase ? pA : pB;
    const dPhi = wrapPi(Cc.phi - T.phi), rho0 = (T.rho + Cc.rho) / 2, phi0 = T.phi + dPhi / 2;
    // chaser's offset from the midpoint, in mm (radial, along-track) -> km through the local scale; the opening is twice that
    const open = [(Cc.rho - T.rho) * K, dPhi * rho0 * K];        // linear: the lens starts at 200 mm per km
    const vk = o => ENG_SL.map(sl => (+o[sl.id]).toPrecision(3)).join(',');
    const key = engScen() + '|' + Math.round(open[0] / .02) + ',' + Math.round(open[1] / .02) + '|' + vk(ENG.vals.o) + '|' + vk(ENG.vals.a) + '|' + ENG.vals.s.ring.toPrecision(3) + '|' + Math.round(ENG.vals.s.time) + '|' + ENG.vals.s.zoom.toPrecision(3);
    if (ENG.startReq && !ENG.busy) {                           // the laptop pressed Start: fly exactly what is on the table now
      ENG.startReq = false;
      engRun({ scenario: engScen(), r_km: open[0], i_km: open[1], key, geo: { ex: Ee.x, ey: Ee.y, rho0, phi0, K },
        ours: { ...ENG.vals.o }, adv: { ...ENG.vals.a }, ring_km: ENG.vals.s.ring, time_s: ENG.vals.s.time });
    }
    const R = ENG.res, stale = key !== ENG.key;
    const ring = (it, rho) => setPts(it, circPts(Ee.x, Ee.y, rho, 180));   // the true starting orbit: always through the piece
    const playing = !!R && !stale && !ENG.busy;
    zoomSlider(P, playing, dt);
    if (ENG.ctrlErr || (ENG.err && !stale)) { hideAll(); setRails('engage', { eyebrow: EYE, msg: 'Sim server offline. Start tools/engage.sh.' }); ENG.status = { phase: 'offline' }; return; }
    if (!R || stale) {                                       // before the run: each piece's current orbit is the ring through it
      ENG.gauge = null;
      hide(G.coastO, G.coastA, G.trailO, G.trailA, G.keep, G.dotO, G.dotA, G.thrO, G.thrA);
      ring(G.ringO, pA.rho); ring(G.ringA, pB.rho); engScaleBar(ENG.vals.s.zoom); ENG.zoomNow = ENG.vals.s.zoom / 200;   // sky follows the zoom
      setRails('engage', { eyebrow: EYE, hero: `${Math.hypot(open[0], open[1]).toFixed(2)}`, unit: 'km', msg: ENG.busy ? 'Simulating…' : 'Ready. Start the run on the laptop.' });
      ENG.status = { phase: ENG.busy ? 'simulating' : 'ready', scenario: engScen(), opening_km: +Math.hypot(open[0], open[1]).toFixed(3), zoom: Math.round(ENG.vals.s.zoom) };
      return;
    }
    hide(G.ringO, G.ringA);
    // playback
    const g = ENG.geo, n = R.n || ENG_N0, t = R.t, N = t.length, tEnd = t[N - 1];
    const spd = Math.max(ENG_SPEED, tEnd / 30) * ENG.vals.s.speed;   // any length plays back in about 30 s, times PLAYBACK
    ENG.play += dt * spd; if (ENG.play > tEnd + ENG_HOLD * spd) ENG.play = 0;
    const tp = Math.min(ENG.play, tEnd), step = (tEnd - t[0]) / (N - 1), q = Math.min(N - 1, (tp - t[0]) / step), i0 = Math.floor(q), fr = q - i0, i1 = Math.min(N - 1, i0 + 1);
    const mid = ts => {                                        // the pair's midpoint (R, I) at sim time ts (held after the end)
      const qq = Math.max(0, Math.min(N - 1, (Math.min(ts, tEnd) - t[0]) / step)), a = Math.floor(qq), b = Math.min(N - 1, a + 1), f = qq - a;
      const m = (arr, k) => arr[a][k] + (arr[b][k] - arr[a][k]) * f;
      return [(m(R.cha, 0) + m(R.tgt, 0)) / 2, (m(R.cha, 1) + m(R.tgt, 1)) / 2];
    };
    if (ENG.zoomFor !== R) { ENG.zoom = engZoom(R, g.rho0); ENG.zoomFor = R; }
    const sNow = ENG.zoom[i0] + (ENG.zoom[i1] - ENG.zoom[i0]) * fr, Akm = R.a_km || 7000;   // current lens: mm per km
    ENG.zoomNow = sNow / 200;                                   // table zoom vs the default 200 mm/km (the sky follows)
    const toTab = (rk, ik, ts) => { const c = mid(ts); return engMap(g, rk, ik, c[0], c[1], ts, n, Akm, sNow); };
    engScaleBar(sNow);   // (R, I) km at sim time ts -> table mm
    const ours = weChase ? R.cha : R.tgt, adv = weChase ? R.tgt : R.cha;
    const lerp = (arr, k) => [arr[i0][k] + (arr[i1][k] - arr[i0][k]) * fr];
    const trail = arr => { const out = []; for (let k = 0; k <= i0; k++) { const p = arr[k]; if (p[0] == null) continue; const [x, y] = toTab(p[0], p[1], t[k]); out.push(W(x, y)); }
      const [x, y] = toTab(lerp(arr, 0)[0], lerp(arr, 1)[0], tp); out.push(W(x, y)); return out; };
    const vel = (arr, k) => { const a = Math.max(0, k - 1), b = Math.min(N - 1, k + 1); return [(arr[b][0] - arr[a][0]) / (t[b] - t[a]), (arr[b][1] - arr[a][1]) / (t[b] - t[a])]; };
    const coast = arr => {                                    // the orbit this craft is on right now, if it never burns again
      const x = lerp(arr, 0)[0], y = lerp(arr, 1)[0], [vx, vy] = vel(arr, Math.round(q)), Tp = Math.max(ENG_COAST_MIN_S, tEnd - tp), out = [];   // to the end of the engagement
      for (let k = 0; k <= 200; k++) {
        const tau = Tp * k / 200, [cx, cy] = cw(n, x, y, vx, vy, tau), c = mid(tp + tau);
        // stop where the coast leaves the lens (toward Earth, off the table, or too far along the orbit)
        const dr = (cx - c[0]) * sNow, di = (cy - c[1]) * sNow;
        if (k > 0 && (dr < -engRoomIn(g.rho0) || dr > engRoomOut(g.rho0) || Math.abs(di) > g.rho0 * ENG_ARC_ROOM)) break;
        const [px, py] = toTab(cx, cy, tp + tau); out.push(W(px, py));
      }
      if (out.length < 2) out.push(out[0]);
      return out;
    };
    setPts(G.coastO, coast(ours)); setPts(G.coastA, coast(adv));
    const tO = trail(ours), tA = trail(adv);
    if (tO.length > 1) setPts(G.trailO, tO); else hide(G.trailO);
    if (tA.length > 1) setPts(G.trailA, tA); else hide(G.trailA);
    const dO = tO[tO.length - 1], dA = tA[tA.length - 1];
    G.dotO.obj.position.set(dO.x, dO.y, 1.2); G.dotO.on = true; G.dotA.obj.position.set(dA.x, dA.y, 1.2); G.dotA.on = true;
    // applied thrust (the sim's own record): an arrow from each craft along the push, length by fraction of full thrust
    const thrArrow = (it, arr, d, spec, mass) => {
      if (!arr) { hide(it); return; }
      const v = arr[i0], amax = spec && mass?.[i0] ? spec.max_thrust_n / mass[i0] * 1e-3 : 5.4e-6;   // this craft's full thrust, km/s^2
      const mag = Math.hypot(v[0], v[1]), f = Math.min(1, mag / amax);
      if (f < .04) { hide(it); return; }
      const px = d.x, py = -d.y, phi = Math.atan2(-(py - g.ey), px - g.ex);
      const ux = v[0] / mag * Math.cos(phi) - v[1] / mag * Math.sin(phi), uy = -v[0] / mag * Math.sin(phi) - v[1] / mag * Math.cos(phi);   // R, I -> table
      const L = 10 + 26 * f, tx = px + ux * L, ty = py + uy * L, hx = -ux * 5, hy = -uy * 5;
      setPts(it, [W(px + ux * 5, py + uy * 5), W(tx, ty), W(tx + hx - uy * 3, ty + hy + ux * 3), W(tx, ty), W(tx + hx + uy * 3, ty + hy - ux * 3)]);
    };
    thrArrow(G.thrO, weChase ? R.thrust_cha : R.thrust_tgt, dO, R.product_spec, R.product_mass);
    thrArrow(G.thrA, weChase ? R.thrust_tgt : R.thrust_cha, dA, R.adversary_spec, R.adversary_mass);
    // keepout (Defend) / capture (Pursue) ring rides the target-role craft; it floods red on a breach, mint on a capture
    const crit = R.record?.metrics || {}, thr = crit.keepout_radius_km ?? crit.capture_range_km ?? R.criteria?.keepout_radius_km ?? R.criteria?.capture_range_km;
    const rng = R.range[i0] + (R.range[i1] - R.range[i0]) * fr;
    if (thr) {
      const tr = weChase ? adv : ours, cr = lerp(tr, 0)[0], ci = lerp(tr, 1)[0], kp = [];   // ring drawn through the same fisheye
      for (let k = 0; k <= 96; k++) { const a = k / 96 * TAU, [x, y] = toTab(cr + thr * Math.cos(a), ci + thr * Math.sin(a), tp); kp.push(W(x, y)); }
      setPts(G.keep, kp);
      G.keep.obj.material.color.set(rng < thr ? (weChase ? C.mint : 0xe2604f) : C.fog300);
    } else hide(G.keep);
    // gauges: each craft's fuel left and delta-v used so far, from its own mass history (rocket equation, the runner's measure)
    const gaugeOf = (mass, spec) => {
      const m0 = mass?.[0], m = mass?.[i0]; if (!m0 || !m || !spec) return null;
      return { used: spec.isp_s * G0 * Math.log(m0 / m), frac: spec.fuel_mass_kg > 0 ? Math.max(0, Math.min(1, (m - spec.dry_mass_kg) / spec.fuel_mass_kg)) : 0 };
    };
    ENG.gauge = { o: gaugeOf(R.product_mass, R.product_spec), a: gaugeOf(R.adversary_mass, R.adversary_spec) };
    setRails('engage', {
      eyebrow: EYE, hero: rng < 1 ? `${Math.round(rng * 1000)}` : rng.toFixed(2), unit: rng < 1 ? 'm' : 'km',
      mets: [['TIME', `${Math.round(tp)}<i>s</i>`], ['RESULT', ENG.play >= tEnd ? R.verdict : '—']],
    });
    ENG.status = { phase: ENG.play >= tEnd ? 'result' : 'playing', scenario: engScen(), t: Math.round(tp), t_end: Math.round(tEnd), range_km: +rng.toFixed(4),
      verdict: R.verdict, reasons: R.reasons, final: ENG.play >= tEnd, ours: ENG.gauge?.o, adv: ENG.gauge?.a, zoom: Math.round(ENG.vals.s.zoom) };
  }

  // ================================================================ ORBITS (the kiosk view)
  // Earth, the Moon and the two Seldons with their orbits; LEO and GEO reference rings. Earth and the Moon go where
  // their pieces are. Scale (orbits-geo.js, node-tested by tools/test_orbits_geo.mjs): true proportions out to GEO
  // with LEO just clear of the Earth piece, compressed from GEO to the Moon so the Moon lands on its piece; inside the
  // Moon zone a Seldon orbits the Moon (patched conics). Seldon-1 -> Seldon-2 transfer drawn for both engines (GT Hohmann,
  // ET low-thrust spiral) with delta-v and fuel only.
  const ORB_LAP = 8, LEO_GAP = 14, ORB_FOOT = 66;   // ORB_FOOT: bottom band (mm) kept for the zoom slider and the disclaimer                             // LEO ring hidden when it would be closer than this (mm) to GEO
  // one colour per thing, told apart on the dark sky (colour-blind-safe set); all text sits on dark plates
  const OC = { s1: 0x56b4e9, s2: 0xe69f00, moon: 0xb8c1c3, gt: 0xff5a4f, et: 0xb67dff };   // GT red, ET purple (brighter than the brand violet so it reads on the sky)
  const hex = c => '#' + c.toString(16).padStart(6, '0');
  Object.assign(STYLES, {
    oS1: { c: OC.s1, w: 2.6, op: .95 }, oS2: { c: OC.s2, w: 2.6, op: .95 }, oMoon: { c: OC.moon, w: 1.4, op: .5, dash: 5, gap: 4 },
    oRef: { c: C.fog200, w: 1.3, op: .6, dash: 3, gap: 4 }, oSoi: { c: C.fog300, w: 1.2, op: .55, dash: 2, gap: 4 },
    // transfer: a solid line in the engine colour, light dashes running along it toward Seldon-2, an arrowhead at the end
    oGT: { c: OC.gt, w: 2.2, op: .25, dash: 6, gap: 5 }, oET: { c: OC.et, w: 1.8, op: .25, dash: 6, gap: 5 },   // 25%, dashed (Oct 9: they dominated the scene)
    oGTf: { c: 0xffc2bd, w: 2.2, op: .55, dash: 5, gap: 9 }, oETf: { c: 0xe6d4ff, w: 1.8, op: .55, dash: 5, gap: 9 },
    oGTa: { c: OC.gt, w: 2.4, op: .25 }, oETa: { c: OC.et, w: 2.4, op: .25 },
    // Seldon-1 coasting along its orbit to the first burn (dotted), and a tick across the path where that burn is (Oct 12)
    oGTc: { c: OC.gt, w: 1.8, op: .45, dash: 1.2, gap: 3.5 }, oETc: { c: OC.et, w: 1.8, op: .45, dash: 1.2, gap: 3.5 },
  });
  const OR = { ang: [null, null, null], last: [null, null, null] };
  OR.ring = [mkLine('orbits', 'oS1'), mkLine('orbits', 'oS2'), mkLine('orbits', 'oMoon')];   // Seldon-1, Seldon-2, Moon
  OR.dot = [mkDot('orbits', OC.s1, 2, 1), mkDot('orbits', OC.s2, 2, 1), mkDot('orbits', OC.moon, 1.6, .8)];
  OR.tag = [mkText('orbits', 'mt-tag'), mkText('orbits', 'mt-tag'), mkText('orbits', 'mt-tag')]; OR.slot = [{}, {}, {}];
  OR.soi = mkLine('orbits', 'oSoi');
  OR.leo = mkLine('orbits', 'oRef'); OR.leoL = mkText('orbits', 'mt-tag dim');
  OR.geo = mkLine('orbits', 'oRef'); OR.geoL = mkText('orbits', 'mt-tag dim'); OR.foot = mkText('orbits', 'mt-tag dim');
  OR.tr = { gt: mkLine('orbits', 'oGT'), et: mkLine('orbits', 'oET'), gtF: mkLine('orbits', 'oGTf'), etF: mkLine('orbits', 'oETf'),
    gtA: mkLine('orbits', 'oGTa'), etA: mkLine('orbits', 'oETa'), gtC: mkLine('orbits', 'oGTc'), etC: mkLine('orbits', 'oETc'),
    read: mkText('orbits', 'mt-xfer'), key: null };   // read: GT / ET delta-v and fuel table, top centre
  // ZOOM: only while Earth or the Moon is off the table (both on: their distance sets the scale). Starts at the scale last
  // in use, so lifting a piece does not jump the map. Set by hand (camera key 'hand'; demo: the draggable stand-in).
  const OZF = { min: 20, max: 1500, log: true };              // km per mm
  OR.kmmm = 400; OR.zoomOn = false; OR.eDir = [-1, 0]; OR.view = null; OR.ease = null;   // view: 'both' | 'earth' | 'moon'; ease: zoom heading to a view's default         // eDir: Moon -> Earth direction last seen (Moon alone: Earth stays that way, off the table)
  OR.z = { track: mkLine('orbits', 'track'), fill: mkLine('orbits', 'track'), mark: mkLine('orbits', 'thrust'), ring: mkLine('orbits', 'track'),
    lbl: mkText('orbits', 'mt-chip on'), val: mkText('orbits', 'mt-slv mono') };
  const orbZoomTrack = () => ({ t0: { x: SW() / 2 - 200, y: SH() - MARG - 40 }, t1: { x: SW() / 2 + 200, y: SH() - MARG - 40 } });
  const orbDrag = {};
  function orbZoomSlider(P, dt = 1 / 60) {
    const g = orbZoomTrack(), h = P.hand, Z = OR.z;
    let active = false;
    const td = dragT(orbDrag, g, h, slT(OZF, OR.kmmm), dt);   // only a deliberate drag of the knob (see dragT)
    if (td != null) { active = true; OR.ease = null; const v = clean(OZF, slV(OZF, td)); OR.kmmm += (v - OR.kmmm) * .35; if (Math.abs(OR.kmmm - v) < .5) OR.kmmm = v; }
    const pv = along(g, slT(OZF, OR.kmmm));
    setPts(Z.track, [W(g.t0.x, g.t0.y), W(g.t1.x, g.t1.y)]); setPts(Z.fill, [W(g.t0.x, g.t0.y), W(pv.x, pv.y)]);
    setPts(Z.mark, [W(pv.x, pv.y - 9), W(pv.x, pv.y + 9)]);
    hide(Z.ring);                                              // no hand cursor (Oct 9: unnecessary)
    setText(Z.lbl, 'ZOOM'); place(Z.lbl, g.t0.x - 14, g.t0.y, 'r', 0);
    setText(Z.val, `${Math.round(OR.kmmm).toLocaleString('en-US')}<i>km per mm</i>`); place(Z.val, g.t1.x + 14, g.t1.y, 'l', 0);
  }
  const kmTxt = km => `${Math.round(km).toLocaleString('en-US')}<i>km</i>`;
  const fmtTp = s => s >= 730 * 86400 ? [(s / 31557600).toFixed(1), 'years'] : s >= 2 * 86400 ? [(s / 86400).toFixed(1), 'days'] : s >= 3600 ? [(s / 3600).toFixed(1), 'h'] : [String(Math.max(1, Math.round(s / 60))), 'min'];
  const fmtT = s => { const [v, u] = fmtTp(s); return `${v}<i>${u}</i>`; };
  // tags: kept on screen and nudged apart so they never overprint each other
  let tagRects = [], TAG_TOP = MARG, TAG_BOT = MARG + ORB_FOOT, TAG_FLIP = false;   // the band tags stay in (mm from each edge); FLIP: face the nearest long edge (geo, dro)
  const TAG_CH = .62;                                          // Space Mono advance (.6 em) + a little tracking, per character
  const plainLen = html => html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').length;
  function tagAt(it, html, x, y, em = 9.5) {
    setText(it, html);
    const w = plainLen(html) * em * TAG_CH + 10, h = em * 1.6;
    x = Math.max(MARG + w / 2, Math.min(SW() - MARG - w / 2, x));
    y = Math.max(TAG_TOP + h / 2, Math.min(SH() - TAG_BOT, y));
    for (let k = 0; k < 12; k++) {
      const hit = tagRects.find(r => Math.abs(r.x - x) < (r.w + w) / 2 && Math.abs(r.y - y) < (r.h + h) / 2 + 2);
      if (!hit) break;
      y = hit.y + (y >= hit.y ? 1 : -1) * ((hit.h + h) / 2 + 3);
    }
    tagRects.push({ x, y, w, h });
    place(it, x, y, 'cm', TAG_FLIP ? faceRot(y) : 0);
  }
  // the physical pieces (tracked centre + footprint radius, mm, incl. the Seldons' panels): labels never sit on one.
  // Seldon span ~100 mm measured in the camera image (Oct 7); Earth ~70 mm.
  const PIECE_R = { earth: 38, moon: 28, 'seldon-1': 56, 'seldon-2': 56 }, TAG_GAP = 6;
  let pieceObs = [];
  const rectClear = (x, y, w, h, o) => Math.hypot(Math.max(Math.abs(o.x - x) - w / 2, 0), Math.max(Math.abs(o.y - y) - h / 2, 0)) >= o.r;
  const offPieces = (x, y, w, h) => pieceObs.every(o => rectClear(x, y, w, h, o));
  // a piece's label beside it: the first direction (preferred u first, then fanning out; last frame's choice before all)
  // where the whole label clears every piece, stays on screen and misses the labels already placed
  const TAG_FAN = [0, 25, -25, 50, -50, 75, -75, 100, -100, 130, -130, 180];
  function tagBeside(it, html, px, py, ux, uy, slot, em = 9.5) {
    setText(it, html);
    const w = plainLen(html) * em * TAG_CH + 10, h = em * 1.6, a0 = Math.atan2(uy, ux);
    const own = pieceObs.find(o => o.x === px && o.y === py) || { x: px, y: py, r: 30 };
    const ok = (x, y) => x - w / 2 >= MARG && x + w / 2 <= SW() - MARG && y - h / 2 >= TAG_TOP && y + h / 2 <= SH() - TAG_BOT && offPieces(x, y, w, h)
      && !tagRects.some(r => Math.abs(r.x - x) < (r.w + w) / 2 + 2 && Math.abs(r.y - y) < (r.h + h) / 2 + 2);
    const at = deg => {                                        // nearest spot along this direction that clears the piece itself
      const a = a0 + deg * Math.PI / 180, cx = Math.cos(a), cy = Math.sin(a);
      for (let d = 0; d < 320; d += 3) if (rectClear(px + cx * d, py + cy * d, w, h, own)) return [px + cx * d, py + cy * d];
      return [px + cx * 320, py + cy * 320];
    };
    const order = slot.deg != null ? [slot.deg, ...TAG_FAN.filter(d => d !== slot.deg)] : TAG_FAN;
    for (const deg of order) {
      const [x, y] = at(deg);
      if (ok(x, y)) { slot.deg = deg; tagRects.push({ x, y, w, h }); place(it, x, y, 'cm', TAG_FLIP ? faceRot(y) : 0); return; }
    }
    slot.deg = null; const [x, y] = at(0); tagAt(it, html, x, y, em);   // nowhere clean: the old rule (clamped, nudged off other labels)
  }
  // a reference ring around Earth with its label on the ring, at the first angle (from a few) that is on screen
  function refRing(line, lbl, maps, r, name) {
    const E = maps.E, rho = E.rho(r);
    setPts(line, circPts(E.cx, E.cy, rho, 192));
    for (const deg of [118, 62, 242, 298, 180, 0]) {
      const a = deg * Math.PI / 180, x = E.cx + rho * Math.cos(a), y = E.cy - rho * Math.sin(a);
      if (x > MARG + 30 && x < SW() - MARG - 30 && y > TAG_TOP + 12 && y < SH() - TAG_BOT - 6 && offPieces(x, y, plainLen(name) * 8 * TAG_CH + 10, 8 * 1.6)) { tagAt(lbl, name, x, y, 8); return; }
    }
    hide(lbl);
  }
  // demo stand-ins: Seldon-1 in LEO up-left of Earth, Seldon-2 in a 100 km lunar orbit above the Moon (wherever they are)
  function orbitsDemo(pc, noMoon) {
    if (noMoon) {   // ?nomoon (the live set has no Moon piece): Earth centred, Seldon-1 in LEO, Seldon-2 in GEO
      const E = OGEO.makeMaps([SW() / 2, SH() / 2], null, { ...OGEO.SCALE, noMoonMm: OGEO.FIG.E + (OGEO.D_EM - OGEO.R_E) / OGEO.ZOOM.leoGeo }).E, on = (r, deg) => { const t = deg * Math.PI / 180, rho = E.rho(r); return { x_mm: E.cx + rho * Math.cos(t), y_mm: E.cy - rho * Math.sin(t), seen_ago: 0 }; };
      return { earth: { x_mm: E.cx, y_mm: E.cy, seen_ago: 0 }, 'seldon-1': on(OGEO.R_LEO, 60), 'seldon-2': on(OGEO.R_GEO, 200) };
    }
    const e = pc.earth || { x_mm: OGEO.LAYOUT.earth[0], y_mm: OGEO.LAYOUT.earth[1] }, m = pc.moon || { x_mm: OGEO.LAYOUT.moon[0], y_mm: OGEO.LAYOUT.moon[1] };
    const maps = OGEO.makeMaps([e.x_mm, e.y_mm], [m.x_mm, m.y_mm]);
    const at = (B, r, deg) => { const t = deg * Math.PI / 180, rho = B.rho(r); return { x_mm: B.cx + rho * Math.cos(t), y_mm: B.cy - rho * Math.sin(t), seen_ago: 0 }; };
    if (maps.true) {   // true scale: Seldon-1 just outside the Earth figure (reads as LEO), Seldon-2 in a DRO (about 50,000 km); Earth and Moon 970 mm apart
      const L = OGEO.LAYOUT, m2 = OGEO.makeMaps(L.earth, L.moon), at2 = (B, rho, deg) => { const q = B.xy(rho, deg * Math.PI / 180); return { x_mm: q[0], y_mm: q[1], seen_ago: 0 }; };
      return { earth: { x_mm: L.earth[0], y_mm: L.earth[1], seen_ago: 0 }, moon: { x_mm: L.moon[0], y_mm: L.moon[1], seen_ago: 0 },
        'seldon-1': at2(m2.E, m2.E.rho(OGEO.R_LEO), 60), 'seldon-2': at2(m2.M, m2.zone * .72, 90) };   // LEO / DRO
    }
    return { 'seldon-1': at(maps.E, Math.max(OGEO.R_LEO, maps.E.r(EARTH_PIECE_R + SELDON_BASE_R + 2)), 135), 'seldon-2': at(maps.M, OGEO.R_M + 100, 90) };
  }
  // Seldon-1 -> Seldon-2: GT (red, Hohmann) and ET (purple, spiral) paths with moving dashes and an arrowhead, plus delta-v and fuel per engine,
  // two rows at the top centre. Recomputed only when a piece moves.
  // the paths are hidden while any piece is being moved; once all is still they are drawn out from Seldon-1 to Seldon-2
  // over TR_DRAW_S, starting TR_WAIT_S after the last piece settles (arrowheads once they arrive; no running dashes, Oct 9)
  // presenter pause / scrub (show state play, t): paused stops the dots and holds every film frame; seek(f) jumps the film / the drawn transfer to
  // fraction f (0..1) once (each consumer keeps the last n it saw), then plays on from there unless paused
  const PL = { paused: false, f: null, n: 0 };
  const TR_DONE = new URLSearchParams(location.search).has('trdone');
  const TR_DRAW_S = 10, TR_WAIT_S = 1, trEase = x => 1 - (1 - x) ** 3;
  const prefix = (pts, cum, f) => {                            // the first f (0..1) of a path by length
    const L = cum[cum.length - 1] * f, out = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      if (cum[i] <= L) { out.push(pts[i]); continue; }
      const u = (L - cum[i - 1]) / Math.max(1e-9, cum[i] - cum[i - 1]);
      out.push([pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * u, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * u]); break;
    }
    return out.length > 1 ? out : [pts[0], pts[0]];
  };
  function updTransfer(maps, a, b, dt, moving, fromTo, G) {   // G: the geo / dro look (our electric path only, mint, numbers on the rails)
    const T = G ? OR.trG : OR.tr, ks = G ? ['et'] : ['gt', 'et'], xk = a && b ? [maps.E.cx, maps.E.cy, maps.M?.cx, maps.M?.cy, a.rho, a.th, b.rho, b.th, maps.k * 1e4].map(v => (v ?? 0).toFixed(3)).join() : null;
    if (T.xk !== xk) { T.xk = xk; OGEO.LOOPS.etMax = G === 'dro' ? 1 : G ? 2 : 6; T.X = xk && OGEO.transfer(maps, a, b); }   // geo / dro: fewer loops, one clean path
    const X = T.X;
    const its = ks.flatMap(k => [T[k], T[k + 'F'], T[k + 'A'], T[k + 'C']]);
    if (!X) { hide(...its, T.read); T.key = null; T.draw = 0; return; }
    if (moving) { hide(...its); T.draw = 0; T.key = null; T.still = 0; }
    else { T.still = (T.still ?? 0) + dt; if (T.still >= TR_WAIT_S && !PL.paused) T.draw = Math.min(1, (T.draw ?? 0) + dt / TR_DRAW_S); }
    if (T.seekN !== PL.n) { T.seekN = PL.n; if (PL.f != null && !moving) { T.still = TR_WAIT_S; T.draw = PL.f; } }
    if (TR_DONE && !moving) { T.still = TR_WAIT_S; T.draw = 1; }   // test hook ?trdone: the paths fully drawn (headless runs see few frames)
    const waiting = !moving && T.still < TR_WAIT_S;
    const key = [maps.E.cx, maps.E.cy, maps.M?.cx, maps.M?.cy, a.rho, a.th, b.rho, b.th].map(v => (v ?? 0).toFixed(2)).join();
    if (T.key !== key) {
      T.key = key;
      for (const [k, r] of [['gt', X.gt], ['et', X.et]].filter(([k]) => ks.includes(k))) {
        const nl = r.lead.length, pts = [...r.lead, ...r.path.flat()], n = pts.length, tip = pts[n - 1];   // coast to the first burn, then the transfer
        let j = n - 2; while (j > 0 && Math.hypot(pts[j][0] - tip[0], pts[j][1] - tip[1]) < 6) j--;   // direction over the last 6 mm
        const ux = tip[0] - pts[j][0], uy = tip[1] - pts[j][1], ul = Math.hypot(ux, uy) || 1, dx = ux / ul, dy = uy / ul, L = 7, Wd = 4;
        setPts(T[k + 'A'], [W(tip[0] - dx * L - dy * Wd, tip[1] - dy * L + dx * Wd), W(tip[0], tip[1]), W(tip[0] - dx * L + dy * Wd, tip[1] - dy * L - dx * Wd)]);
        const cum = [0]; for (let i = 1; i < n; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
        T[k + 'P'] = { pts, cum, nl }; T[k + 'Drawn'] = -1;
      }
    }
    if (moving || waiting) hide(...its);                        // nothing while a piece moves or until the pause is over (setPts above turns arrowheads on)
    else if (!moving) {
      const f = trEase(T.draw), done = T.draw >= 1;
      for (const k of ks) {
        const P = T[k + 'P'];
        if (T[k + 'Drawn'] !== f) {
          const pre = done ? P.pts : prefix(P.pts, P.cum, f), nl = P.nl;   // drawn out along the coast first, then the transfer
          if (nl > 1) setPts(T[k + 'C'], pre.slice(0, Math.min(nl, pre.length)).map(p => W(p[0], p[1]))); else hide(T[k + 'C']);
          const past = pre.length > nl || (nl === 0 && pre.length > 1);
          if (past) setPts(T[k], pre.slice(Math.max(0, nl - 1)).map(p => W(p[0], p[1]))); else hide(T[k]);
          T[k + 'Drawn'] = f;
        }
        T[k + 'A'].on = done;
      }
    }
    if (G) return;                                              // geo / dro read the numbers off the rails
    // one table: engine | delta-v | fuel, then the route it is for underneath (names in their orbit colours)
    const row = (id, r) => { const pm = OGEO.PROP_MODES.find(m => m.id === id);
      return `<span class="xk" style="color:${hex(OC[id.toLowerCase()])}">${id}</span><span class="xn">${pm.name}</span>`
        + `<span class="xv">${r.dv.toFixed(2)}</span><span class="xu">km/s</span><span class="xv">${Math.round(r.mp)}</span><span class="xu">kg</span>`
        + `<span class="xv">${fmtTp(r.t)[0]}</span><span class="xu">${fmtTp(r.t)[1]}</span>`; };
    const html = `<div class="xg"><span></span><span></span><span class="xh">DELTA-V</span><span></span><span class="xh">FUEL</span><span></span><span class="xh">TIME</span><span></span>${row('GT', X.gt)}${row('ET', X.et)}</div>`
      + `<div class="xf">FROM <span style="color:${hex(OC.s1)}">${fromTo?.[0] ?? 'SELDON-1'}</span> TO <span style="color:${hex(OC.s2)}">${fromTo?.[1] ?? 'SELDON-2'}</span></div>`;
    if (T.read.html !== html) T.readBox = null;
    setText(T.read, html); place(T.read, SW() / 2, MARG, 'c', 0);
    const el = T.read.obj;                                       // measured once shown (mm), so the Seldon tags keep clear of it
    if (!T.readBox && el.offsetWidth) T.readBox = { w: el.offsetWidth / SC() + 6, h: el.offsetHeight / SC() + 4 };
    const bx = T.readBox || { w: 300, h: 60 };
    tagRects.push({ x: SW() / 2, y: MARG + bx.h / 2, w: bx.w, h: bx.h });
  }
  function updOrbits(P, dt) {
    if (grp() === 'orbits') OR.v = current;                       // the variant on screen (kept while this group fades out)
    if (OR.v && OR.v !== 'orbits') return updGD(P, dt, OR.v);
    hide(...gdOnly(), OR.trG.et, OR.trG.etA, OR.trG.etC); OR.trG.key = null; OR.ring[1].dim = 1;
    tagRects = []; TAG_TOP = MARG; TAG_BOT = MARG + ORB_FOOT; TAG_FLIP = false;
    pieceObs = Object.entries(P).filter(([k]) => PIECE_R[k]).map(([k, p]) => ({ x: p.x_mm, y: p.y_mm, r: PIECE_R[k] + TAG_GAP }));
    const zs = Object.values(OR.z), all = [...OR.ring, ...OR.dot, ...OR.tag, OR.soi, OR.leo, OR.leoL, OR.geo, OR.geoL, OR.foot, OR.tr.gt, OR.tr.et, OR.tr.gtF, OR.tr.etF, OR.tr.gtA, OR.tr.etA, OR.tr.gtC, OR.tr.etC, OR.tr.read, ...zs];
    const onTable = p => p && p.x_mm >= 0 && p.x_mm <= SW() && p.y_mm >= 0 && p.y_mm <= SH();
    const eOn = onTable(P.earth), mOn = onTable(P.moon);
    OR.zoomOn = eOn !== mOn;
    // two views (user, Oct 12): Earth and Moon on the table = the transit to DRO, scaled by their distance; Moon off = LEO /
    // GEO manoeuvres, which open at their own zoom (GEO filling the table) and ease there. The slider takes over from it.
    const view = eOn && mOn ? 'both' : eOn ? 'earth' : mOn ? 'moon' : null;
    if (view !== OR.view) { if (view === 'earth') OR.ease = OGEO.ZOOM.leoGeo; OR.view = view; }
    if (OR.ease != null && view === 'earth') { OR.kmmm += (OR.ease - OR.kmmm) * (1 - Math.exp(-dt / .25)); if (Math.abs(OR.kmmm - OR.ease) < .5) { OR.kmmm = OR.ease; OR.ease = null; } }
    if (!eOn && !mOn) { hide(...all); return; }
    let maps;
    if (eOn && mOn) {                                             // both on: the Earth-Moon distance sets the scale
      maps = OGEO.makeMaps([P.earth.x_mm, P.earth.y_mm], [P.moon.x_mm, P.moon.y_mm]);
      OR.kmmm = Math.max(OZF.min, Math.min(OZF.max, 1 / maps.k));
      const dl = Math.hypot(P.earth.x_mm - P.moon.x_mm, P.earth.y_mm - P.moon.y_mm) || 1;
      OR.eDir = [(P.earth.x_mm - P.moon.x_mm) / dl, (P.earth.y_mm - P.moon.y_mm) / dl];
      hide(...zs);
    } else {                                                      // one of them: the zoom slider sets the scale
      orbZoomSlider(P, dt);
      const Dmm = OGEO.FIG.E + (OGEO.D_EM - OGEO.R_E) / OR.kmmm;   // where the Moon's centre stands from Earth's at this scale
      if (eOn) maps = OGEO.makeMaps([P.earth.x_mm, P.earth.y_mm], null, { ...OGEO.SCALE, noMoonMm: Dmm });
      else maps = OGEO.makeMaps([P.moon.x_mm + OR.eDir[0] * Dmm, P.moon.y_mm + OR.eDir[1] * Dmm], [P.moon.x_mm, P.moon.y_mm]);   // Earth off the table
    }
    const { E, M } = maps;
    const pc = [P['seldon-1'], P['seldon-2']];
    const bodies = [pc[0] && OGEO.bodyAt(maps, pc[0].x_mm, pc[0].y_mm), pc[1] && OGEO.bodyAt(maps, pc[1].x_mm, pc[1].y_mm), M && OGEO.moonBody(maps)];
    const nmax = Math.max(...bodies.filter(Boolean).map(i => i.n)), rate = TAU / (nmax * ORB_LAP);
    // the message, zone and reference rings first, so the body tags placed later avoid their labels
    if (M) setPts(OR.soi, circPts(M.cx, M.cy, maps.zone, 128)); else hide(OR.soi);   // the Moon zone (unlabelled)
    if (eOn) refRing(OR.geo, OR.geoL, maps, OGEO.R_GEO, 'GEO'); else hide(OR.geo, OR.geoL);   // no GEO around an Earth that is off the table (user, Oct 9)
    if (!mOn && E.rho(OGEO.R_GEO) - E.rho(OGEO.R_LEO) >= LEO_GAP) refRing(OR.leo, OR.leoL, maps, OGEO.R_LEO, 'LEO'); else hide(OR.leo, OR.leoL);   // no LEO while the Moon is on the table (user, Oct 9); nor when it would crowd GEO
    setText(OR.foot, 'Not to scale.'); place(OR.foot, SW() / 2, SH() - MARG - 4, 'cm', 0);
    updTransfer(maps, bodies[0], bodies[1], dt, !!(pc[0]?.moving || pc[1]?.moving || P.earth?.moving || P.moon?.moving));
    bodies.forEach((b, k) => {
      if (!b) { hide(OR.ring[k], OR.dot[k], OR.tag[k]); OR.last[k] = null; return; }
      setPts(OR.ring[k], OGEO.orbitPts(b, 256).map(p => W(p[0], p[1])));   // its own shape: a circle, or a DRO about the Moon
      if (OR.last[k] === null || Math.abs(wrapPi(b.th - OR.last[k])) > 1e-3) OR.ang[k] = b.th;   // the piece moved: the dot restarts from it
      OR.last[k] = b.th; OR.ang[k] += b.dir * b.n * rate * (PL.paused ? 0 : dt);   // DROs run clockwise
      { const q = OGEO.orbitXY(b, OR.ang[k]); OR.dot[k].obj.position.set(q[0], -q[1], 1); } OR.dot[k].on = true;
      const T = TAU / b.n, col = hex([OC.s1, OC.s2, OC.moon][k]);
      if (k === 2) return;                                          // the Moon: orbit ring only, no label
      const px = pc[k].x_mm, py = pc[k].y_mm;   // label beside the piece, preferably outward from the body it orbits
      tagBeside(OR.tag[k], `<span style="color:${col}">SELDON-${k + 1}</span> &nbsp;${b.prim === 'M' ? 'DRO · ' : ''}${kmTxt(b.r - b.B.R)} · ${fmtT(T)} period`, px, py, px - b.B.cx || 1, py - b.B.cy, OR.slot[k]);   // user, Oct 12: no 'up'; 'period'
    });
  }

  // ================================================================ LEO TO GEO / LEO TO DRO (modes 'geo' and 'dro')
  // The orbits view's drawing and maths, one job each. geo: Earth alone; a Seldon within a generous band of the GEO ring locks
  // onto it. dro: Earth, the Moon and one Seldon; anywhere near the Moon (inside its zone, which is not drawn) is the DRO.
  // The transfer is drawn from where the Seldon is to GEO / the DRO. Scale 'true' (setScale): Earth and the Moon at true relative
  // size at fixed spots, their pieces ignored; only the Seldons move.
  Object.assign(STYLES, { oBody: { c: C.fog200, w: 1.2, op: .9 } });
  const GD = { geoBand: 40, leoBand: 25, peerBand: 25, droKm: V.DRO_KM, was: [false, false], wasLeo: [false, false], peer: -1 };   // bands: mm of ring distance (LEO, GEO, the other Seldon's orbit)   // geoBand: mm of ring distance; droKm: size of the DRO drawn
  let scaleMode = 'show';
  const fixedEM = () => ({ earth: { x_mm: 150, y_mm: SH() / 2 }, moon: { x_mm: SW() - 190, y_mm: SH() / 2 } });   // room for GEO left of Earth, the DRO right of the Moon, and the "True scale" label at the end
  // geo / dro share the rails language with capture and competitor: mint = our path, white = the target, fog dashed = references
  Object.assign(STYLES, { gOur: { c: C.mint, w: 1.8, op: .6 }, gRoute: { c: C.mint, w: 2.7, op: 1, grad: true }, gRouteA: { c: C.mint, w: 2.7, op: 1 }, gRouteC: { c: C.mint, w: 1.8, op: .55, dash: 1.2, gap: 3.5 } });
  OR.trG = { et: mkLine('orbits', 'gRoute'), etA: mkLine('orbits', 'gRouteA'), etC: mkLine('orbits', 'gRouteC'), key: null };   // the same transfer state as OR.tr, drawn our way
  const GX = { ring: [mkLine('orbits', 'gOur'), mkLine('orbits', 'target')], dot: [mkDot('orbits', C.mint, 2.2, 1), mkDot('orbits', C.white, 2.2, 1)],
    tag: [mkText('orbits', 'mt-label'), mkText('orbits', 'mt-label')], foot: [mkText('orbits', 'mt-foot', 1), mkText('orbits', 'mt-foot', 1)] };
  OR.msg = mkText('orbits', 'mt-tag'); OR.ts = mkText('orbits', 'mt-tag dim');
  OR.disc = [mkDot('orbits', 0x244b63, 1, 1), mkDot('orbits', C.fog300, 1, .9)];
  OR.discL = [mkLine('orbits', 'oBody'), mkLine('orbits', 'oBody')]; OR.discT = [mkText('orbits', 'mt-tag dim'), mkText('orbits', 'mt-tag dim')];
  const gdOnly = () => [OR.msg, OR.ts, ...OR.disc, ...OR.discL, ...OR.discT, ...GX.ring, ...GX.dot, ...GX.tag, ...GX.foot];   // (updTransfer keeps OR.trG itself)
  const trItems = () => ['gt', 'et', 'gtF', 'etF', 'gtA', 'etA', 'gtC', 'etC', 'read'].map(k => OR.tr[k]);   // (updTransfer keeps these itself)
  const orAll = () => [...OR.ring, ...OR.dot, ...OR.tag, OR.soi, OR.leo, OR.leoL, OR.geo, OR.geoL, OR.foot, ...Object.values(OR.z), ...gdOnly()];
  function updGD(P, dt, mode) {
    const geo = mode === 'geo', TS = scaleMode === 'true', FX = fixedEM(), EYE = MODE_TITLES[MODE_NAMES.indexOf(mode)];
    hide(...orAll(), ...trItems()); OR.tr.key = null; tagRects = [];   // (the old orbits view redraws its paths when it comes back)
    TAG_TOP = TAG_BOT = MARG + RAIL_H + 16; TAG_FLIP = true;       // labels stay between the rails (and their "Not to scale." lines) and face the nearest long edge
    const E = TS ? FX.earth : P.earth, Mo = TS ? FX.moon : geo ? null : P.moon;
    const ids = ['seldon-1', 'seldon-2'].filter(id => P[id]).slice(0, geo ? 2 : 1);   // dro: one Seldon (Seldon-1 if both are seen)
    const msg = !E || (!geo && !Mo) ? msgFor(E, Mo, !geo) : !ids.length ? 'Place Seldon-1.' : '';
    if (!E || (!geo && !Mo)) { setRails(mode, { eyebrow: EYE, msg }); hide(OR.trG.et, OR.trG.etA, OR.trG.etC); OR.tr.xk = OR.tr.key = OR.trG.xk = OR.trG.key = null; return; }
    const e = [E.x_mm, E.y_mm], maps = TS ? OGEO.makeTrueMaps(e, [Mo.x_mm, Mo.y_mm], { noZone: geo, foot: TRUE_FOOT }) : geo ? OGEO.makeGeoMaps(e) : OGEO.makeMaps(e, [Mo.x_mm, Mo.y_mm]);
    pieceObs = ids.map(id => ({ x: P[id].x_mm, y: P[id].y_mm, r: PIECE_R[id] + TAG_GAP }));
    if (TS) {   // Earth and the Moon drawn at true relative size (the 3D stand-ins are hidden by the page)
      [[E, R_E, 0, 'EARTH'], [Mo, R_M, 1, 'MOON']].forEach(([c, R, i, name]) => {
        const r = R * maps.k; (OR.trueB ||= [null, null])[i] = { x: c.x_mm, y: c.y_mm, r };
        OR.disc[i].obj.scale.set(r, r, 1); OR.disc[i].obj.position.set(c.x_mm, -c.y_mm, -.3); OR.disc[i].on = true;
        setPts(OR.discL[i], circPts(c.x_mm, c.y_mm, r, 96)); pieceObs.push({ x: c.x_mm, y: c.y_mm, r: r + TAG_GAP });
        tagAt(OR.discT[i], name, c.x_mm, c.y_mm + r + 10, 8);
      });
    } else { pieceObs.push({ x: E.x_mm, y: E.y_mm, r: PIECE_R.earth + TAG_GAP }); if (Mo) pieceObs.push({ x: Mo.x_mm, y: Mo.y_mm, r: PIECE_R.moon + TAG_GAP }); }
    // bodies: the Seldons' orbits, snapped to GEO / the DRO inside the lock band (hysteresis kept per Seldon)
    const kOf = id => id === 'seldon-2' ? 1 : 0;
    const bodies = ids.map(id => {
      const p = P[id], k = kOf(id), raw = OGEO.bodyAt(maps, p.x_mm, p.y_mm);
      const b = geo ? OGEO.lockGeo(maps, raw, GD.was[k], GD.geoBand) : OGEO.lockDro(maps, p.x_mm, p.y_mm, raw, GD.was[k], GD.droKm);
      GD.was[k] = !!b.locked;
      if (geo && !b.locked) { const l = OGEO.lockLeo(maps, b, GD.wasLeo[k], GD.leoBand); GD.wasLeo[k] = !!l.leo; return l; }
      GD.wasLeo[k] = false; return b;
    });
    for (const k of [0, 1]) if (!ids.some(id => kOf(id) === k)) GD.was[k] = GD.wasLeo[k] = false;
    // the other Seldon's orbit locks too (geo): one placed near it joins that orbit exactly (the one being moved joins the
    // other; Seldon-2 joins Seldon-1 when neither moves), with the same hysteresis as GEO. Two on one orbit = a phasing story.
    if (geo && bodies.length === 2 && bodies.every(x => x.prim === 'E')) {
      const mv = ids.map(id => !!P[id].moving), j = mv[0] && !mv[1] ? 0 : mv[1] && !mv[0] ? 1 : GD.peer >= 0 ? GD.peer : 1;
      const A = bodies[1 - j], J = bodies[j], band = GD.peerBand * (GD.peer === j ? 1.15 : 1);   // (a short release: two orbits 30 mm apart are two orbits)
      if (!J.locked && !J.leo && Math.abs(J.rho - A.rho) < band) { bodies[j] = { ...J, r: A.r, rho: A.rho, n: A.n, peer: true }; GD.peer = j; }
      else GD.peer = -1;
    } else GD.peer = -1;
    // reference rings (fog, dashed)
    if (geo || TS) refRing(OR.geo, OR.geoL, maps, OGEO.R_GEO, 'GEO');
    if (geo && maps.E.rho(OGEO.R_GEO) - maps.E.rho(OGEO.R_LEO) >= LEO_GAP) refRing(OR.leo, OR.leoL, maps, OGEO.R_LEO, 'LEO');
    // the way on: from the first Seldon to the second (geo) or to GEO / the DRO (nothing if it is there already)
    const a = bodies[0]; let b = bodies[1], to = null;
    if (a && !b && !a.locked) { b = OGEO.targetBody(maps, a, geo ? 'E' : 'M', geo ? OGEO.R_GEO : GD.droKm); to = geo ? 'GEO' : 'DRO'; }
    const toName = to || (b && b.locked ? (geo ? 'GEO' : 'DRO') : ids[1] && ids[1].toUpperCase());
    footNote(GX.foot, TS ? 'True scale.' : 'Not to scale.');
    updTransfer(maps, a, b, dt, ids.some(id => P[id].moving) || (!TS && !!(P.earth?.moving || (!geo && P.moon?.moving))), null, mode);
    // orbit rings and the dots riding them (one lap of the fastest Seldon in ORB_LAP seconds): ours mint, the target white
    const moonB = !geo && maps.M && OGEO.moonBody(maps), nmax = Math.max(...bodies.map(x => x.n), moonB ? moonB.n : 0), rate = TAU / (nmax * ORB_LAP);
    const ride = (k, x, ring, dot) => {
      setPts(ring, OGEO.orbitPts(x, 256).map(p => W(p[0], p[1])));
      if (OR.last[k] === null || Math.abs(wrapPi(x.th - OR.last[k])) > 1e-3) OR.ang[k] = x.th;   // the piece moved (or was reset): the dot restarts from it
      OR.last[k] = x.th; OR.ang[k] += x.dir * x.n * rate * (PL.paused ? 0 : dt);
      if ((OR.seekN ||= [])[k] !== PL.n) { OR.seekN[k] = PL.n; if (PL.f != null) OR.ang[k] = x.th + x.dir * x.n * rate * PL.f * TR_DRAW_S; }   // the dot where the drawn transfer has got to
      const q = OGEO.orbitXY(x, OR.ang[k]); dot.obj.position.set(q[0], -q[1], 1); dot.on = true;
    };
    if (moonB) ride(2, moonB, OR.ring[2], OR.dot[2]); else OR.last[2] = null;
    bodies.forEach((x, k) => {
      ride(k, x, GX.ring[k], GX.dot[k]);
      const T = TAU / x.n, p = P[ids[k]], col = k ? '#f6f8f8' : '#0ee3a6', where = x.locked ? (geo ? 'GEO' : 'DRO') + (geo ? '' : ' · ' + kmTxt(x.r - x.B.R)) : x.leo ? 'LEO' : kmTxt(x.r - x.B.R) + (x.peer ? ' · SAME ORBIT' : '');
      tagBeside(GX.tag[k], `<span style="color:${col}">${ids[k].toUpperCase()}</span> &nbsp;${where} · ${fmtT(T)} period`, p.x_mm, p.y_mm, p.x_mm - x.B.cx || 1, p.y_mm - x.B.cy, OR.slot[k], 8.6);
    });
    for (let k = bodies.length; k < 2; k++) OR.last[k] = null;
    if (a && b && to) {   // the orbit it is heading for (white); the DRO is labelled where it is farthest from Earth
      setPts(GX.ring[1], OGEO.orbitPts(b, 256).map(p => W(p[0], p[1])));
      if (to === 'DRO') { const q = maps.M.xy(b.rho, maps.thM); tagAt(GX.tag[1], `<span style="color:#f6f8f8">DRO</span>`, q[0], q[1], 8); }
    }
    // rails: hero = DELTA-V of our electric transfer, then FUEL, TIME and where it ends
    const X = OR.trG.X, et = X && X.et;
    if (msg) setRails(mode, { eyebrow: EYE, msg });
    else if (a && b && et) {
      const dv = et.dv, alt = b.prim === 'M' ? ['DRO RADIUS', kmTxt(b.r)] : ['ALTITUDE', kmTxt(b.r - b.B.R)];
      setRails(mode, { eyebrow: `${EYE} · ${ids[0].toUpperCase()} TO ${toName}`, hero: dv < 1 ? String(Math.round(dv * 1000)) : num(dv), unit: dv < 1 ? 'm/s delta-v' : 'km/s delta-v',
        mets: [['FUEL', `${Math.round(et.mp)}<i>kg</i>`], ['TIME', fmtT(et.t)], alt] });
    } else setRails(mode, { eyebrow: `${EYE} · ${ids[0].toUpperCase()}`, hero: '0', unit: 'km/s delta-v', mets: [['STATUS', geo ? 'IN GEO' : 'IN THE DRO']] });
  }
  function setScale(s) { scaleMode = s === 'true' ? 'true' : 'show'; OR.tr.xk = OR.trG.xk = null; }
  function setOptsOrbits(m, o = {}) {
    const num = (v, lo, hi) => Math.max(lo, Math.min(hi, +v));
    if (m === 'geo' && o.band_mm != null) GD.geoBand = num(o.band_mm, 10, 120);
    if (m === 'geo' && o.peer_mm != null) GD.peerBand = num(o.peer_mm, 0, 80);
    if (m === 'geo' && o.leo_mm != null) GD.leoBand = num(o.leo_mm, 0, 80);
    if (m === 'dro' && o.dro_km != null) GD.droKm = num(o.dro_km, 5000, 60000);
    OR.tr.xk = OR.trG.xk = null;
  }
  function reset() { OR.last = [null, null, null]; for (const T of [OR.tr, OR.trG]) Object.assign(T, { draw: 0, still: 0, key: null }); }   // dots restart from their pieces, the transfer is drawn out again
  // demo stand-ins for geo / dro (what the camera would see); `given` names the pieces the URL already placed
  // standAt: where a piece stands (mm from Earth's centre) for an orbit of r km; in true scale that is the footprint rule, not the drawn ring
  const standAt = (maps, r) => maps.E.rho0 != null ? maps.E.rho0 + Math.max(0, r - OGEO.R_LEO) * maps.k : maps.E.rho(r);
  function gdDemo(mode, pc, given = []) {
    const TS = scaleMode === 'true', out = {}, use = k => !given.includes(k), at = (B, rho, deg) => { const t = deg * Math.PI / 180; return { x_mm: B.cx + rho * Math.cos(t), y_mm: B.cy - rho * Math.sin(t), seen_ago: 0 }; };
    if (mode === 'capture' || mode === 'competitor') {            // Earth at the centre, no Moon; the Seldons sit where the film makes sense
      const e = given.includes('earth') && pc.earth ? pc.earth : { x_mm: SW() / 2, y_mm: SH() / 2 }, A = (rho, deg) => at({ cx: e.x_mm, cy: e.y_mm }, rho, deg);
      if (use('earth')) out.earth = { x_mm: e.x_mm, y_mm: e.y_mm, seen_ago: 0 };
      if (use('moon')) out.moon = null;
      if (mode === 'capture') { if (use('s1')) out['seldon-1'] = A(150, 30); if (use('s2')) out['seldon-2'] = A(150, 90); }   // two Seldons on one orbit, 60 degrees apart
      else { if (use('s1')) out['seldon-1'] = A(CGEO.RHO.geo - 8, 40); if (use('s2')) out['seldon-2'] = null; }   // one Seldon just inside GEO: the target locks to it
      return out;
    }
    if (mode === 'geo') {
      const e = TS ? fixedEM().earth : pc.earth && given.includes('earth') ? pc.earth : { x_mm: SW() / 2, y_mm: SH() / 2 }, maps = TS ? OGEO.makeTrueMaps([e.x_mm, e.y_mm], [fixedEM().moon.x_mm, e.y_mm], { noZone: true, foot: TRUE_FOOT }) : OGEO.makeGeoMaps([e.x_mm, e.y_mm]);
      if (use('earth')) out.earth = { x_mm: e.x_mm, y_mm: e.y_mm, seen_ago: 0 };
      if (use('moon')) out.moon = null;                          // the Moon is not part of this mode
      if (use('s1')) out['seldon-1'] = at(maps.E, standAt(maps, OGEO.R_LEO) + (TS ? 4 : 0), 60);
      if (use('s2')) out['seldon-2'] = at(maps.E, standAt(maps, OGEO.R_GEO) - 22, 200);   // a little inside the GEO ring: locks onto it
    } else {
      const L = OGEO.LAYOUT, e = given.includes('earth') ? pc.earth : { x_mm: TS ? fixedEM().earth.x_mm : L.earth[0], y_mm: TS ? fixedEM().earth.y_mm : L.earth[1] };
      const m = given.includes('moon') ? pc.moon : { x_mm: TS ? fixedEM().moon.x_mm : L.moon[0], y_mm: TS ? fixedEM().moon.y_mm : L.moon[1] };
      const maps = TS ? OGEO.makeTrueMaps([e.x_mm, e.y_mm], [m.x_mm, m.y_mm], { foot: TRUE_FOOT }) : OGEO.makeMaps([e.x_mm, e.y_mm], [m.x_mm, m.y_mm]);
      if (use('earth')) out.earth = { x_mm: e.x_mm, y_mm: e.y_mm, seen_ago: 0 };
      if (use('moon')) out.moon = { x_mm: m.x_mm, y_mm: m.y_mm, seen_ago: 0 };
      if (use('s1')) out['seldon-1'] = at(maps.E, TS ? standAt(maps, OGEO.R_LEO) + 4 : maps.E.rho(Math.max(OGEO.R_LEO, maps.E.r(EARTH_PIECE_R + SELDON_BASE_R + 2))), 135);
      out['seldon-2'] = null;                                    // one Seldon only
    }
    return out;
  }

  // ================================================================ CAPTURE / DEFEND and COMPETITOR (maths: capture-geo.js)
  // Both draw about the Earth piece with one log scale (CGEO.rhoOfR: LEO 70 mm, GEO 265 mm, Moon distance 300 mm), "not to scale".
  // Both play a short film on a loop: clk runs while the pieces are still, restarts when one moves (or on reset()).
  const OPT = { capture: { scenario: 'capture', path: 'auto', dir: 'auto', speed: 30 }, competitor: { target: null, speed: 26 } };
  const fmtDur = (s, html = true) => {
    const u = x => html ? U(x) : ' ' + x;
    return s < 5400 ? `${Math.round(s / 60)}${u("min")}` : s < 172800 ? `${(s / 3600).toFixed(s < 36000 ? 1 : 0)}${u('h')}` : `${s < 20 * 86400 ? (s / 86400).toFixed(1) : Math.round(s / 86400)}${u('d')}`;
  };
  const fmtDvh = dv => dv < 1 ? `${Math.round(dv * 1000)}${U('m/s')}` : `${num(dv)}${U('km/s')}`;
  const fmtKm = x => `${Math.round(x).toLocaleString('en-US')}${U('km')}`;
  const cmmAt = (ex, ey, rho) => r => { const q = rho(Math.hypot(r[0], r[1])), a = Math.atan2(r[1], r[0]); return [ex + q * Math.cos(a), ey - q * Math.sin(a)]; };   // km (Earth frame) -> table mm
  // points along a craft's flight from t0 to t1; denser at both ends (the fast, tight part of a long ellipse is at its ends)
  const sampleC = (c, t0, t1, n, mm) => { const out = []; for (let i = 0; i <= n; i++) { const p = mm(CGEO.craftAt(c, t0 + (t1 - t0) * (1 - Math.cos(Math.PI * i / n)) / 2).r); out.push(W(p[0], p[1])); } return out; };
  const outward = (x, y, ex, ey, d) => { const l = Math.hypot(x - ex, y - ey) || 1; return [x + (x - ex) / l * d, y + (y - ey) / l * d]; };
  function footNote(its, txt) {                                  // "Not to scale." on both long sides, just inside the rails
    its.forEach((it, i) => { setText(it, txt); place(it, SW() / 2, i === 0 ? SH() - MARG - RAIL_H - 14 : MARG + RAIL_H + 3, 'c', i === 0 ? 0 : 180); });
  }
  // film clock: returns animation progress u (0..1) and whether the pieces are settled
  function filmClock(F, key, moving, dt, lead, dur, hold) {
    if (key !== F.key) { F.key = key; F.hold = .8; F.clk = 0; F.fresh = true; }
    if (moving) { F.hold = .8; F.clk = 0; } else if (F.hold > 0) { F.hold -= dt; F.clk = 0; } else if (!PL.paused) F.clk += dt;
    if (F.clk > lead + dur + hold) F.clk = 0;                     // loop
    if (F.reset) { F.reset = false; F.clk = 0; F.hold = 0; }
    if (F.seekN !== PL.n) { F.seekN = PL.n; if (PL.f != null && !moving) { F.hold = 0; F.clk = lead + PL.f * dur; } }
    if (ctx.engageStart != null && ctx.engageStart !== '' && !isNaN(+ctx.engageStart)) F.clk = +ctx.engageStart;   // test hook ?engt=<s>: freeze the film there
    return Math.max(0, Math.min(1, (F.clk - lead) / dur));
  }

  // ---------------------------------------------------------------- CAPTURE / DEFEND
  // Seldon-1 chases Seldon-2. Same orbit: phasing orbit (lower or higher) and back. Different orbits: wait, Hohmann, arrive together.
  // DEFEND: the target makes a small burn part-way so it is not at the rendezvous point when the chaser gets there.
  const CP = { clk: 0, hold: 0, key: null, S: null };
  const CD = {};
  CD.ringC = mkLine('capture', 'ref'); CD.ringT = mkLine('capture', 'target');
  CD.plan = mkLine('capture', 'coastA'); CD.fly = mkRoute('capture'); CD.evP = mkLine('capture', 'link');
  CD.tailC = mkLine('capture', 'hi'); CD.tailT = mkLine('capture', 'target');
  CD.link = mkLine('capture', 'link'); CD.keep = mkLine('capture', 'ring'); CD.rdv = mkLine('capture', 'marker');
  CD.bm = [0, 1, 2].map(() => ({ mark: mkLine('capture', 'marker'), lbl: mkText('capture', 'mt-label', .9) }));
  CD.dotC = mkDot('capture', C.mint, 3.6, 1); CD.dotT = mkDot('capture', C.white, 3.6, 1);
  CD.tagC = mkText('capture', 'mt-label', .9); CD.tagT = mkText('capture', 'mt-label', .9);
  CD.foot = [mkText('capture', 'mt-foot', 1), mkText('capture', 'mt-foot', 1)];
  const CD_ALL = [CD.ringC, CD.ringT, CD.plan, CD.fly, CD.evP, CD.tailC, CD.tailT, CD.link, CD.keep, CD.rdv, CD.dotC, CD.dotT, CD.tagC, CD.tagT, ...CD.foot, ...CD.bm.flatMap(b => [b.mark, b.lbl])];
  const CAP_LEAD = 2.5, CAP_HOLD = 8;                              // s: pause on the start, and on the result before it loops

  function capBuild(ex, ey, A, B, same, defend, O) {
    const ang = p => Math.atan2(-(p.y_mm - ey), p.x_mm - ex), rr = p => CGEO.rOfRho(Math.hypot(p.x_mm - ex, p.y_mm - ey));
    const pl = CGEO.plan({ r1: rr(A), r2: rr(B), th1: ang(A), th2: ang(B), same, dir: O.dir, defend });
    const mm = cmmAt(ex, ey, pl.rho), S = { pl, mm, ex, ey };
    const c0 = pl.ch.segs[0].el, t0 = pl.tg.segs[0].el, per = el => TAU / el.n;
    setPts(CD.ringT, sampleC(pl.tg, 0, per(t0), 160, mm));
    if (same) hide(CD.ringC); else setPts(CD.ringC, sampleC(pl.ch, 0, per(c0), 160, mm));
    const mseg = pl.ch.segs[1], tM = mseg.t0, tM1 = pl.same ? tM + TAU / mseg.el.n : tM + pl.tof;   // the manoeuvre orbit: one lap (phasing) / the half ellipse (transfer)
    S.man = [tM, tM1]; setPts(CD.plan, sampleC(pl.ch, tM, tM1, 200, mm));
    if (pl.defend) { const es = pl.tg.segs[1]; S.ev = [es.t0, es.t0 + TAU / es.el.n]; setPts(CD.evP, sampleC(pl.tg, S.ev[0], S.ev[1], 160, mm)); } else hide(CD.evP);
    S.bpos = pl.burns.map(b => mm(CGEO.craftAt(b.who === 'ch' ? pl.ch : pl.tg, b.t).r));
    return S;
  }
  function updCapture(P, dt) {
    const O = OPT.capture, E = P.earth, A = P['seldon-1'], B = P['seldon-2'];
    const defend = /defend/i.test(O.scenario);
    const EYE = `${defend ? 'DEFEND' : 'CAPTURE'} · SELDON-1 TO SELDON-2`;
    if (!E || !A || !B) { hide(...CD_ALL); CP.key = null; setRails('capture', { eyebrow: EYE, msg: !E ? 'Place Earth.' : !A && !B ? 'Place both Seldons.' : !A ? 'Place Seldon-1.' : 'Place Seldon-2.' }); return; }
    const ex = E.x_mm, ey = E.y_mm, rho = p => Math.max(CGEO.RHO.leo, Math.hypot(p.x_mm - ex, p.y_mm - ey));
    const d12 = Math.abs(rho(A) - rho(B));
    const same = O.path === 'phasing' || d12 < 3 || (O.path !== 'transfer' && d12 < 25);
    const key = [ex, ey, A.x_mm, A.y_mm, B.x_mm, B.y_mm].map(v => Math.round(v / 2)).join(',') + [defend, same, O.dir, O.speed].join();
    if (key !== CP.key) CP.S = null;
    const moving = !!(A.moving || B.moving || E.moving);
    const u = filmClock(CP, key, moving, dt, CAP_LEAD, O.speed, CAP_HOLD);
    if (!CP.S) CP.S = capBuild(ex, ey, A, B, same, defend, O);
    const { pl, mm } = CP.S, t = CGEO.simTime(pl, u), started = u > 0, done = u >= 1;
    const pc = CGEO.craftAt(pl.ch, t), pt = CGEO.craftAt(pl.tg, t), qc = mm(pc.r), qt = mm(pt.r);
    // the flown part of the manoeuvre orbit, brighter than the planned (dashed) one
    const [m0, m1] = CP.S.man, tf = Math.min(t, m1);
    if (started && tf > m0 + 1) setRoute(CD.fly, sampleC(pl.ch, m0, tf, Math.max(4, Math.ceil(180 * (tf - m0) / (m1 - m0))), mm)); else hide(CD.fly);
    // short tails behind both craft
    const tail = (c, q) => { const seg = c.segs.filter(s => s.t0 <= t + 1e-9).pop(), dT = .1 * TAU / seg.el.n, pts = []; for (let k = 8; k >= 0; k--) { const p = mm(CGEO.craftAt(c, Math.max(0, t - dT * k / 8)).r); pts.push(W(p[0], p[1])); } return pts; };
    if (started) { setPts(CD.tailC, tail(pl.ch)); setPts(CD.tailT, tail(pl.tg)); } else hide(CD.tailC, CD.tailT);
    CD.dotC.obj.position.set(qc[0], -qc[1], 1); CD.dotC.on = true; CD.dotT.obj.position.set(qt[0], -qt[1], 1); CD.dotT.on = true;
    setPts(CD.link, [W(qc[0], qc[1]), W(qt[0], qt[1])]);
    if (defend) { setPts(CD.keep, circPts(qt[0], qt[1], 15, 48)); } else hide(CD.keep);
    // evasion orbit appears when the target burns
    if (pl.defend) { if (t >= pl.te && started) CD.evP.on = true; else hide(CD.evP); }
    // burn markers: dim until they happen; BURN 1 and BURN 2 share a spot in a phasing capture, so one label carries both
    const bmk = CD.bm; let used = 0;
    const shared = pl.same;
    pl.burns.forEach((b, i) => {
      const [x, y] = CP.S.bpos[i], hit = started && t >= b.t - 1e-6, B_ = bmk[i];
      if (shared && i === 1) { hide(B_.mark, B_.lbl); return; }
      setPts(B_.mark, circPts(x, y, MARK_R * 1.4, 28)); B_.mark.dim = hit ? 1 : .45; B_.lbl.dim = hit ? 1 : .75;
      const [lx, ly] = outward(x, y, ex, ey, 52);                 // clear of the CHASER / TARGET tags that sit on the dots at the start
      const nm = b.name === 'EVADE' ? 'EVADE' : b.name;
      const html = shared && i === 0 ? `BURN 1 <b>${fmtDvh(Math.abs(b.dv))}</b><br>BURN 2 <b>${fmtDvh(Math.abs(pl.burns[1].dv))}</b>` : `${nm} <b>${fmtDvh(Math.abs(b.dv))}</b>`;
      setText(B_.lbl, html); place(B_.lbl, lx, ly, 'cm', faceRot(ly));
      if (b.who === 'tg' && !(started && t >= b.t - 1e-6)) hide(B_.mark, B_.lbl);   // the evasion is not shown before it happens
    });
    // the rendezvous ring on the chaser's second burn
    { const q = CP.S.bpos[1], hit = done; setPts(CD.rdv, circPts(q[0], q[1], 9, 40)); CD.rdv.dim = hit ? 1 : .0; CD.rdv.on = hit && !defend; }
    // tags ride the dots: CHASER on the outside, TARGET on the inside, facing the nearest long edge
    { const [x, y] = outward(qc[0], qc[1], ex, ey, 19); setText(CD.tagC, 'CHASER'); place(CD.tagC, x, y, 'cm', faceRot(y)); }
    { const [x, y] = outward(qt[0], qt[1], ex, ey, -19); setText(CD.tagT, defend ? 'TARGET' : 'TARGET'); place(CD.tagT, x, y, 'cm', faceRot(y)); }
    footNote(CD.foot, 'Not to scale.');
    // rails
    let lab = 'READY'; if (done) lab = defend ? 'KEEP-OUT HELD' : 'CAPTURED'; else if (started) for (const ev of pl.events) if (ev.t <= t + 1e-6) lab = ev.label;
    const tt = pl.Ttot * (started ? (done ? 1 : t / pl.Ttot) : 0);
    const tm = ['T+', `${fmtDur(tt)} <i>of</i> ${fmtDur(pl.Ttot)}`];
    const path = pl.same ? [['PHASING ORBIT', `${pl.dir === 'down' ? 'LOWER' : 'HIGHER'} <i>${pl.N} ${pl.N > 1 ? 'turns' : 'turn'}</i>`]] : [['TRANSFER', fmtDur(pl.tof)], ['WAIT FOR WINDOW', fmtDur(pl.tw)]];
    if (defend) setRails('capture', { eyebrow: EYE, hero: String(Math.round(pl.dvTg * 1000)), unit: 'm/s evade', mets: [['PHASE', lab], tm, ['CHASER DELTA-V', fmtDvh(pl.dvCh)], ['MISS DISTANCE', done ? fmtKm(pl.sepEnd) : '—']] });
    else setRails('capture', { eyebrow: EYE, hero: pl.dvCh < 1 ? String(Math.round(pl.dvCh * 1000)) : num(pl.dvCh), unit: pl.dvCh < 1 ? 'm/s chaser delta-v' : 'km/s chaser delta-v', mets: [['PHASE', lab], tm, ...path] });
  }

  // ---------------------------------------------------------------- COMPETITOR
  // Us (electric spiral) and a typical chemical tug both leave LEO for the target orbit set by a Seldon piece's distance from Earth.
  const KP = { clk: 0, hold: 0, key: null, S: null };
  const KD = {};
  KD.leo = mkLine('competitor', 'ref'); KD.tgt = mkLine('competitor', 'target');
  KD.usP = mkLine('competitor', 'coastA'); KD.usF = mkRoute('competitor');
  KD.thP = mkLine('competitor', 'ref'); KD.thF = mkLine('competitor', 'hi'); KD.thF.cc = new THREE.Color(COMP.colThem); KD.thF.obj.material.color.set(COMP.colThem);
  KD.thP.obj.material.color.set(COMP.colThem);
  KD.dotU = mkDot('competitor', C.mint, 3.8, 1); KD.dotT = mkDot('competitor', COMP.colThem, 3.8, 1);
  KD.b = [0, 1].map(() => mkLine('competitor', 'marker'));
  KD.lblTgt = mkText('competitor', 'mt-label', .9); KD.tagU = mkText('competitor', 'mt-label', .95); KD.tagT = mkText('competitor', 'mt-label', .95);
  KD.lblU = mkText('competitor', 'mt-label', .8); KD.lblT = mkText('competitor', 'mt-label', .8);
  KD.foot = [mkText('competitor', 'mt-foot', 1), mkText('competitor', 'mt-foot', 1)];
  const KD_ALL = [KD.leo, KD.tgt, KD.usP, KD.usF, KD.thP, KD.thF, KD.dotU, KD.dotT, ...KD.b, KD.lblTgt, KD.tagU, KD.tagT, KD.lblU, KD.lblT, ...KD.foot];
  const hexCss = n => '#' + n.toString(16).padStart(6, '0');
  const CMP_LEAD = 2, CMP_HOLD = 9;

  function updCompetitor(P, dt) {
    const O = OPT.competitor, E = P.earth, EYE = 'COMPETITOR · LEO TO ';
    if (!E) { hide(...KD_ALL); KP.key = null; setRails('competitor', { eyebrow: EYE + 'TARGET', msg: 'Place Earth.' }); return; }
    const ex = E.x_mm, ey = E.y_mm;
    // target orbit: a preset from the tablet, else the farther Seldon piece (distance from Earth), locking to GEO when near its ring
    const seld = ['seldon-1', 'seldon-2'].map(k => P[k]).filter(Boolean).sort((a, b) => Math.hypot(b.x_mm - ex, b.y_mm - ey) - Math.hypot(a.x_mm - ex, a.y_mm - ey));
    const pc = seld[0], tg = O.target;
    let rT, preset, th0 = -Math.PI / 2;                                  // preset with no piece: leave LEO at the bottom, arrive at the top
    if (pc) th0 = Math.atan2(-(pc.y_mm - ey), pc.x_mm - ex) + Math.PI;
    if (tg === 'geo') { rT = CGEO.R_GEO; preset = 'geo'; }
    else if (tg === 'dro') { rT = CGEO.L_KM; preset = 'dro'; }
    else if (tg != null && tg !== '' && tg !== 'auto' && isFinite(+tg) && +tg > 0) { rT = CGEO.R_E + +tg; preset = null; }
    else if (pc) {
      const q = Math.hypot(pc.x_mm - ex, pc.y_mm - ey); rT = CGEO.rOfRho(q);
      if (Math.abs(q - CGEO.RHO.geo) < COMP.snapGeoMm) { rT = CGEO.R_GEO; preset = 'geo'; } else if (q >= CGEO.RHO.far - 4) { rT = CGEO.L_KM; preset = 'dro'; }
    } else { hide(...KD_ALL); KP.key = null; setRails('competitor', { eyebrow: EYE + 'TARGET', msg: 'Place a Seldon to set the target orbit.' }); return; }
    rT = Math.max(rT, CGEO.R_LEO * 1.06);
    const moving = !!(E.moving || (pc && pc.moving));
    const key = [ex, ey, th0, rT].map(v => Math.round(v * (v > 1000 ? .01 : 1) / 2)).join(',') + [preset, O.speed].join();
    if (key !== KP.key) KP.S = null;
    const f = filmClock(KP, key, moving, dt, CMP_LEAD, O.speed, CMP_HOLD);
    if (!KP.S) {                                                       // build the paths once per placement
      const rho = CGEO.rhoOfR, rho0 = rho(CGEO.R_LEO), rhoT = rho(rT), cmp = CGEO.compare(rT, preset);
      const mm = cmmAt(ex, ey, rho), S = { cmp, rhoT, rho0, th0 };
      // ours: schematic spiral, evenly spaced in the table's radius; ends a touch before the competitor's arrival point so the dots do not overlap
      const turns = Math.max(1, Math.min(5, Math.floor((rhoT - rho0) / 10))) + .5, v0 = Math.sqrt(CGEO.MU / CGEO.R_LEO), v1 = Math.sqrt(CGEO.MU / rT);
      S.spiral = fr => { const r = CGEO.MU / (v0 + (v1 - v0) * fr) ** 2, q = rho(r), a = th0 + TAU * turns * (q - rho0) / Math.max(1, rhoT - rho0) - .22 * (q - rho0) / Math.max(1, rhoT - rho0); return [ex + q * Math.cos(a), ey - q * Math.sin(a)]; };
      S.usPts = Array.from({ length: 401 }, (_, i) => { const p = S.spiral(i / 400); return W(p[0], p[1]); });
      const { c, h } = CGEO.hohmannCraft(CGEO.R_LEO, rT, th0); S.hc = c; S.h = h;
      S.thPts = sampleC(c, 0, h.tof, 240, mm);
      S.thAt = fr => mm(CGEO.craftAt(c, h.tof * fr).r);
      S.ratio = Math.max(.15, Math.min(1, Math.pow(cmp.them.time / cmp.us.time, .3)));   // the film runs the tug faster, but not at the true ratio (it would arrive in a blink)
      S.mm = mm; setPts(KD.usP, S.usPts); setPts(KD.thP, S.thPts); setPts(KD.leo, circPts(ex, ey, rho0, 128)); setPts(KD.tgt, circPts(ex, ey, rhoT, 192));
      KP.S = S;
    }
    const S = KP.S, { cmp } = S, fU = f, fT = Math.min(1, f / S.ratio);
    const pu = S.spiral(fU), pt = S.thAt(fT);
    const n = Math.max(2, Math.ceil(400 * fU)); if (fU > .002) setRoute(KD.usF, S.usPts.slice(0, n + 1)); else hide(KD.usF);
    if (fT > .002) setPts(KD.thF, sampleC(S.hc, 0, S.h.tof * fT, Math.max(8, Math.ceil(200 * fT)), S.mm)); else hide(KD.thF);
    KD.dotU.obj.position.set(pu[0], -pu[1], 1); KD.dotU.on = true; KD.dotT.obj.position.set(pt[0], -pt[1], 1); KD.dotT.on = true;
    // the two tug burns (start and arrival), and the labels
    const bp = [S.thAt(0), S.thAt(1)];
    KD.b.forEach((b, i) => { setPts(b, circPts(bp[i][0], bp[i][1], MARK_R * 1.4, 28)); b.dim = (i === 0 ? fT > 0 : fT >= 1) ? 1 : .45; b.obj.material.color.set(COMP.colThem); });
    const tagAt = (it, p, d, html, col) => { const [x, y] = outward(p[0], p[1], ex, ey, d); setText(it, `<span style="color:${col}">${html}</span>`); place(it, x, y, 'cm', faceRot(y)); };
    tagAt(KD.tagU, pu, 15, `US · T+ ${fmtDur(fU * cmp.us.time, false)}`, hexCss(C.mint));
    tagAt(KD.tagT, pt, -15, `TUG · T+ ${fmtDur(fT * cmp.them.time, false)}`, hexCss(COMP.colThem));
    { const pa = [ex + S.rhoT * Math.cos(th0 + Math.PI + .5), ey - S.rhoT * Math.sin(th0 + Math.PI + .5)]; const tl = preset === 'geo' ? 'GEO' : preset === 'dro' ? 'DRO' : Math.round(rT - CGEO.R_E).toLocaleString('en-US') + ' km up'; tagAt(KD.lblTgt, pa, 13, `TARGET · ${tl}${preset === 'geo' ? ' · 35,786 km' : ''}`, '#f6f8f8'); }
    { const mid = S.usPts[260]; tagAt(KD.lblU, [mid.x, -mid.y], 12, 'ELECTRIC SPIRAL', hexCss(C.mint)); const m2 = S.thAt(.5); tagAt(KD.lblT, m2, -4, 'HOHMANN TRANSFER', hexCss(COMP.colThem)); }
    footNote(KD.foot, 'Not to scale. Spiral is a schematic.');
    // rails: hero = propellant saved, then each side's delta-v, propellant and trip time
    const saved = Math.round(cmp.saved), side = (nm, col, r) => `<div class="xf"><div class="eyebrow" style="color:${col}">${nm}</div><div class="xf-mets">`
      + `<div class="metric"><div class="ml">DELTA-V</div><div class="mv">${num(r.dv)}<i>km/s</i></div></div>`
      + `<div class="metric"><div class="ml">PROPELLANT</div><div class="mv" style="font-size:calc(var(--mm) * 24)">${Math.round(r.prop)}<i>kg</i></div></div>`
      + `<div class="metric"><div class="ml">TRIP TIME</div><div class="mv">${fmtDur(r.time)}</div></div></div></div>`;
    const dest = preset === 'geo' ? 'GEO' : preset === 'dro' ? 'DRO' : `${Math.round(rT - CGEO.R_E).toLocaleString('en-US')} KM`;
    setRails('competitor', { raw: `<div class="r-left"><div class="eyebrow"><span class="sq"></span>${EYE}${dest}</div><div class="hero">${saved}<i>kg less propellant</i></div></div><div class="r-mid"></div>`
      + `<div class="r-mets">${side(COMP.us.name, hexCss(C.mint), cmp.us)}${side(COMP.them.name, hexCss(COMP.colThem), cmp.them)}</div>` });
  }

  // ================================================================ mode switching / main update
  let lastBox = undefined;
  const hintFirst = !!ctx.initialMode;
  function setMode(name) {
    if (!usable(name) || name === current) return;
    current = name; chromeKey = null; if (ctx.onModeChange) ctx.onModeChange(name);   // re-lay the chrome (labels hidden by a mode come back)
  }
  const updFns = { mission: updMission, intercept: updIntercept, dvmap: updDv, engage: updEngage, orbits: updOrbits, capture: updCapture, competitor: updCompetitor };
  // presenter hooks (the tablet calls these through demo.html / the show state)
  function setOpts(mode, o) { return mode === 'capture' || mode === 'competitor' ? setOptsFilm(mode, o) : setOptsOrbits(mode, o || {}); }
  function setOptsFilm(mode, o) {
    if (!o || !OPT[mode]) return;
    const cur = OPT[mode], prev = JSON.stringify(cur);
    if (mode === 'capture') {
      if (typeof o.scenario === 'string') {                      // 'capture' | 'defend' | 'phasing-up' | 'phasing-down' | 'transfer' (a combination: 'defend-phasing-up')
        const s = o.scenario.toLowerCase();
        cur.scenario = s.includes('defend') ? 'defend' : 'capture';
        if (s.includes('transfer')) cur.path = 'transfer'; else if (s.includes('phasing')) cur.path = 'phasing';
        if (s.includes('up')) cur.dir = 'up'; else if (s.includes('down')) cur.dir = 'down';
      }
      if (['auto', 'phasing', 'transfer'].includes(o.path)) cur.path = o.path;
      if (['auto', 'up', 'down'].includes(o.dir)) cur.dir = o.dir;
      if (o.speed > 5) cur.speed = Math.min(120, +o.speed);
      if (o.sim != null) setMode(o.sim ? 'engage' : 'capture');  // advanced: the real engagement sim (tools/engage.sh, port 8791)
    } else if (mode === 'competitor') {
      if ('target' in o) cur.target = o.target === 'altitude' ? (+o.alt_km > 0 ? +o.alt_km : 20000) : o.target;   // 'geo' | 'dro' | <altitude km> | 'auto' / null (= by the Seldon piece); the tablet sends 'altitude' + alt_km
      else if (+o.alt_km > 0 && typeof cur.target === 'number') cur.target = +o.alt_km;
      if (o.speed > 5) cur.speed = Math.min(120, +o.speed);
    }
    if (JSON.stringify(cur) !== prev) { CP.reset = KP.reset = true; }
  }
  const resetFilm = () => { CP.reset = KP.reset = true; };
  { const Q = new URLSearchParams(location.search);              // test hooks: ?scenario=defend|phasing-up|transfer  ?dir=up|down  ?target=geo|dro|<km>
    const sc = Q.get('scenario'); if (sc) setOpts('capture', { scenario: sc });
    if (Q.get('dir')) setOpts('capture', { dir: Q.get('dir') });
    if (Q.get('target')) setOpts('competitor', { target: Q.get('target') }); }

  function update(pieces, dt, nowMs) {
    const P = {};
    for (const k of ['earth', 'moon', 'seldon-1', 'seldon-2', 'chip']) if (pieces[k]) P[k] = pieces[k];
    for (const k in pieces) if (k.startsWith('sl:')) P[k] = pieces[k];
    if (pieces.hand) P.hand = pieces.hand;
    if (P.chip) { topo = onTrack(P.chip); if (topo) budget = budgetForY(P.chip.y_mm); }   // chip present: it decides; absent: keyboard / ctx
    const ck = SW() + 'x' + SH() + 'x' + SC();
    if (chromeKey !== ck) { chromeKey = ck; layoutChrome(); }
    boxes.forEach(b => {
      const act = topo, t = track(), yb = yForBudget(budgetS);
      b.line.base = act ? 1 : .5; b.ticks.forEach(g => g.base = act ? 1 : .5); b.tickL.forEach(g => g.base = act ? 1 : .5); b.lbl.base = 1;
      setPts(b.fill, [W(t.cx, yForBudget(0)), W(t.cx, yb)]); b.fill.on = act && budgetS > .02;
      setText(b.read, `${budgetS.toFixed(1)}<i>km/s</i>`); place(b.read, t.cx + (END === 'right' ? -1 : 1) * (BOX / 2 + 20), yb, 'cm', boxRot); b.read.on = act;
      if (b.lbl.act !== act) { b.lbl.act = act; b.lbl.obj.classList.toggle('on', act); }
      if (current === 'engage' || grp() === 'orbits' || current === 'capture' || current === 'competitor') hide(b.line, ...b.ticks, ...b.tickL, b.fill, b.lbl, b.read);   // the map's budget slider is not part of this mode
    });
    updFloor(P, dt, nowMs);
    for (const l of flows) l.material.dashOffset = -3 * nowMs / 1000;   // dashes travel toward increasing point index at 3 mm/s
    railOwner = current;
    rails.forEach(r => { r.on = current !== 'orbits'; });   // only the old orbits view has no edge rails
    { const d = current === 'orbits' ? 'none' : ''; if (lockEl.style.display !== d) lockEl.style.display = d; }   // nor the company lockup
    for (const m of MODE_NAMES) {
      if (GROUP[m]) continue;
      const g = groups[m], target = m === grp() ? 1 : 0;
      g.fade += (target > g.fade ? 1 : -1) * Math.min(.1, dt) / .4;
      g.fade = Math.max(0, Math.min(1, g.fade));
      if (g.fade > .003) updFns[m](P, dt, nowMs);
    }
    for (const g of allGroups()) {
      const vis = g.fade > .003;
      for (const it of g.items) {
        const show = vis && it.on, o = it.base * (it.dim ?? 1) * g.fade * g.fade * (3 - 2 * g.fade);   // ease-standard-ish, no overshoot; dim: optional per-item strength
        if (it.kind === 'line') { it.obj.visible = show; it.obj.material.opacity = o; }
        else if (it.kind === 'mesh') { it.obj.visible = show; it.obj.material.opacity = o; if (it.obj.material.uniforms) it.obj.material.uniforms.uOpacity.value = o; }
        else {
          const d = show ? '' : 'none';
          if (it.disp !== d) { it.disp = d; it.obj.style.display = d; }
          if (it.op !== o) { it.op = o; it.obj.style.opacity = o; }
        }
      }
    }
  }
  function onLayout() {
    applyFonts();
    for (const g of allGroups()) for (const it of g.items) { if (it.kind === 'line') it.obj.material.resolution.set(...mkres()); it.pk = null; }
    chromeKey = null; pathCache = { key: null }; M.builtKey = null; dvKey = null;
    for (const k of Object.keys(placerKeys)) placerKeys[k] = null;
  }
  applyFonts();
  return { update, setMode, onLayout, setOpts, reset: () => { reset(); resetFilm(); }, setPlay: on => { PL.paused = !on; }, seek: f => { PL.f = Math.max(0, Math.min(1, +f || 0)); PL.n++; }, get paused() { return PL.paused; },
    get testState() { return { capture: CP.clk, competitor: KP.clk, geoDraw: OR.trG.draw, geoAng: OR.ang[0], lead: { capture: CAP_LEAD, competitor: CMP_LEAD }, speed: { capture: OPT.capture.speed, competitor: OPT.competitor.speed } }; }, /* test hook (tools/test_control.py): film clocks (s), the drawn-out transfer (0..1), the dot angle */ get mode() { return current; }, boxRect, setTopo: v => { topo = !!v; }, get topo() { return topo; },
    setBudget: v => { budget = Math.max(0, Math.min(DV_MAX, +v)); }, get budget() { return budget; }, trackY: yForBudget, DV_MAX, engChips, get viewZoom() { return current === 'engage' ? (ENG.zoomNow ?? 1) : 1; }, get scale() { return scaleMode; }, get trueScale() { return scaleMode === 'true' && (current === 'geo' || current === 'dro'); },   /* true scale exists in LEO TO GEO / LEO TO DRO only; elsewhere the pieces stay live */ setScale, gdDemo, get orbitsLike() { return grp() === 'orbits' || current === 'capture' || current === 'competitor'; }, get drawsBodies() { return scaleMode === 'true' && (current === 'geo' || current === 'dro'); },
    titles: Object.fromEntries(MODE_NAMES.map((m, i) => [m, MODE_TITLES[i]])), get handMode() { return current === 'engage' || (current === 'orbits' && OR.zoomOn); }, orbitsDemo: (pc, noMoon) => orbitsDemo(pc, noMoon),
    get trueBodies() { return OR.trueB || []; },   // true scale: the drawn Earth and Moon {x, y, r} in mm (the page keeps its Seldon stand-ins clear of them)
    orbitsFigures: () => ({ earth: OGEO.FIG.E, moon: OGEO.FIG.M, seldon: OGEO.FIG.S }),
    zoomHandPos: () => current === 'orbits' ? along(orbZoomTrack(), slT(OZF, OR.kmmm)) : along(zoomTrack(), slT(ZF, ENG.vals.s.zoom)),
    handTrack: () => current === 'orbits' ? orbZoomTrack() : zoomTrack(),   // the zoom track the camera's fingertips are matched to
    engSet: (side, id, v) => { if (ENG.vals[side] && id in ENG.vals[side]) { ENG.vals[side][id] = +v; PAN[side].grabbed = false; } } };
}
