// modes.js — MISSION / INTERCEPT / ΔV MAP display modes for the orbital table.
// Coordinates: TV mm, origin top-left, y down; world = (x, -y).
//
//   const modes = createModes({ THREE, scene, line, setLine, label, put, toPx,
//                               getScale: () => S, get SW(){...}, get SH(){...},
//                               initialMode, missionUrl, onModeChange })
//   modes.update(pieces, dt, nowMs)   // pieces: { earth, moon, 'seldon-1', 'seldon-2', chip } each {x_mm,y_mm}
//   modes.setMode(name) ; modes.mode ; modes.onLayout()
//
// Design system ("mission-control instrument"): everything is sized in screen mm via the scale S,
// one HUD block (title / hero number / secondary metrics) at the top-left margin in every mode,
// three line styles (primary route, target, reference), greedy label placer, mode selector bottom-right.

const MU_E = 398600.4418, MU_M = 4902.8, R_E = 6378.1, R_M = 1737.4, L_KM = 384400;
const R_LEO = R_E + 400, GEO_R = 42164, MOON_SOI = 66100;
const EARTH_PIECE_R = 33, MOON_PIECE_R = 33;             // 66 mm bases
const SELDON_BASE_R = 33;                                 // a Seldon can't sit closer to Earth than the two bases touching
const K_KM_PER_MM = 170;
const MODE_NAMES = ['mission', 'intercept', 'dvmap'];
const MODE_TITLES = ['MISSION', 'INTERCEPT', 'ΔV MAP'];
const LAV = 0xb49cff, LAV2 = 0xd2c6ff, IVORY = 0xe9e6df, GREY = 0x8a909c, LGREY = 0xd6d9e0;
const BG = 0x06080c;
const MARG = 24;                                          // safe margin, mm
const TAU = Math.PI * 2;

const fmtHM = sec => { const m = Math.round(sec / 60); return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} m`; };
const fmtT = h => `${Math.floor(h / 24)} d ${String(Math.floor(h % 24)).padStart(2, '0')} h`;
const num = (v, d = 2) => v.toFixed(d);
const thou = v => Math.round(v).toLocaleString('en-US');
const U = s => `<i>${s}</i>`;                             // small lower-case unit after a number

// ---- orbital helpers ----
function hohmann(r1, r2) {
  const a = (r1 + r2) / 2;
  const dv1 = Math.abs(Math.sqrt(MU_E * (2 / r1 - 1 / a)) - Math.sqrt(MU_E / r1));
  const dv2 = Math.abs(Math.sqrt(MU_E / r2) - Math.sqrt(MU_E * (2 / r2 - 1 / a)));
  return { dv1, dv2, total: dv1 + dv2, tof: Math.PI * Math.sqrt(a ** 3 / MU_E), a };
}
const V_MOONORB = Math.sqrt(MU_E / L_KM);
// low-thrust (Edelbaum, coplanar, circular-to-circular, phasing ignored) ΔV between two orbits.
// Each point is {r: km from Earth, d: km from Moon, w: Moon-side weight 0..1}.
const moonW = d => { if (d >= MOON_SOI) return 0; if (d <= MOON_SOI - 10000) return 1; const t = (MOON_SOI - d) / 10000; return t * t * (3 - 2 * t); };
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

// ---- styles ----
const CSS = `
:root { --mm: 1.34px; }
.mt { position: fixed; pointer-events: none; white-space: nowrap; line-height: 1.25; font-family: 'JetBrains Mono', ui-monospace, monospace; color: #d6d9e0; }
.mt i { font-style: normal; font-family: 'JetBrains Mono', ui-monospace, monospace; font-weight: 400; font-size: .62em; opacity: .6; margin-left: .25em; letter-spacing: .04em; }
.mt-hud { font-size: max(7px, calc(var(--mm) * 5)); }
.mt-hud .h-t { font-size: max(8px, calc(var(--mm) * 9)); letter-spacing: .18em; color: rgba(214,217,224,.6); }
.mt-hud .h-hero { font-family: Inter, 'JetBrains Mono', sans-serif; font-weight: 600; font-size: calc(var(--mm) * 30); line-height: 1.05; margin-top: calc(var(--mm) * 3); color: #f1efe9; font-variant-numeric: tabular-nums; letter-spacing: -.01em; }
.mt-hud .h-hero i { font-size: .36em; font-weight: 400; opacity: .6; margin-left: .3em; letter-spacing: .04em; }
.mt-hud .h-row { display: flex; gap: calc(var(--mm) * 14); margin-top: calc(var(--mm) * 7); }
.mt-hud .h-m { min-width: calc(var(--mm) * 26); }
.mt-hud .h-ml { font-size: max(7px, calc(var(--mm) * 5.5)); letter-spacing: .14em; color: rgba(214,217,224,.55); margin-bottom: calc(var(--mm) * 1.2); }
.mt-hud .h-mv { font-family: Inter, 'JetBrains Mono', sans-serif; font-weight: 600; font-size: max(9px, calc(var(--mm) * 11)); color: #e6e8ec; font-variant-numeric: tabular-nums; }
.mt-hud .h-mv i { font-size: .5em; }
.mt-a { font-size: max(7px, calc(var(--mm) * 6)); letter-spacing: .06em; text-shadow: 0 0 calc(var(--mm) * 2) #06080c, 0 0 calc(var(--mm) * 2) #06080c; }
.mt-a b { font-family: Inter, 'JetBrains Mono', sans-serif; font-weight: 600; letter-spacing: 0; font-variant-numeric: tabular-nums; color: #f1efe9; }
.mt-a b i { font-size: .72em; }
.mt-c { font-size: max(7px, calc(var(--mm) * 5.5)); letter-spacing: .04em; background: #0e0c16; padding: 0 calc(var(--mm) * 1.2); color: rgba(214,217,224,.75); }
.mt-cap { font-size: max(6.5px, calc(var(--mm) * 5)); letter-spacing: .1em; color: rgba(214,217,224,.4); }
.mt-sel { font-size: max(8px, calc(var(--mm) * 9)); letter-spacing: .18em; }
.mt-mode { font-size: max(6.5px, calc(var(--mm) * 5)); letter-spacing: .18em; color: rgba(214,217,224,.4); }
`;

export function createModes(ctx) {
  const { THREE, scene, line, setLine, put } = ctx;
  const SW = () => ctx.SW, SH = () => ctx.SH, SC = () => ctx.getScale();
  const W = (x, y) => new THREE.Vector2(x, -y);
  const mkres = () => [innerWidth, innerHeight];
  const bgCol = new THREE.Color(BG);

  // fonts + css (self-contained so index.html can adopt this file as is)
  { const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    if (!document.querySelector('link[href*="family=Inter"]')) { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;600&family=JetBrains+Mono:wght@400;600&display=swap'; document.head.appendChild(l); } }

  // ---------------------------------------------------------------- registry / items
  const groups = { chrome: { fade: 1, items: [] } };
  for (const m of MODE_NAMES) groups[m] = { fade: 0, items: [] };
  const add = (g, kind, obj, base = 1) => { const it = { kind, obj, base, on: false, key: null }; groups[g].items.push(it); return it; };

  // line language: primary route / target / reference / marker (+ glyph/slot chrome)
  const STYLES = {
    primary: { c: LAV, w: 2.5, op: 1, grad: true },
    hi: { c: LAV2, w: 3, op: 1 },
    target: { c: IVORY, w: 1.75, op: .75 },
    ref: { c: GREY, w: 1, op: .45, dash: 4, gap: 4 },
    marker: { c: IVORY, w: 1.5, op: .9 },
    trail: { c: LAV, w: 2, op: 1, grad: true },
    glyph: { c: GREY, w: 1, op: .3 },
    slot: { c: GREY, w: 1, op: .22 },
    bar: { c: LAV, w: 2, op: 1 },
  };
  const kw = () => Math.max(.8, SC() / 1.344);              // line widths are authored for 1.34 px/mm (the 65" TV)
  function mkLine(g, kind) {
    const st = STYLES[kind];
    const l = line([W(0, 0), W(1, 1)], st.c, st.w * kw(), { opacity: 1, dash: st.dash, gap: st.gap });
    l.material.resolution.set(...mkres()); l.visible = false;
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
  // fr: optional array of 0..1 progress per point; opacity runs 35% -> 100% (or custom a0..a1)
  function setPts(it, pts, fr, a0 = .35, a1 = 1) {
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
  const circPts = (cx, cy, r, n = 128, a0 = 0, a1 = TAU) => {
    const out = []; for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * i / n; out.push(W(cx + r * Math.cos(a), cy - r * Math.sin(a))); } return out;
  };
  const MARK_R = 1.75;                                      // 3.5 mm open circle
  function setText(it, html) { if (it.html !== html) { it.html = html; it.obj.innerHTML = html; } }
  function place(it, x, y, anchor = 'c') {
    const el = it.obj; put(el, x, y);
    el.style.transform = { c: 'translate(-50%,0)', cm: 'translate(-50%,-50%)', l: 'translate(0,-50%)', r: 'translate(-100%,-50%)', tl: 'translate(0,0)', bl: 'translate(0,-100%)', br: 'translate(-100%,-100%)' }[anchor];
    it.on = true;
  }
  const hide = (...its) => its.forEach(i => { if (i) i.on = false; });
  function applyFonts() {
    document.documentElement.style.setProperty('--mm', SC() + 'px');
    for (const g of Object.values(groups)) for (const it of g.items) if (it.kind === 'line') it.obj.material.linewidth = it.st.w * kw();
  }

  // ---------------------------------------------------------------- HUD block (same structure in every mode)
  const hudHTML = (title, hero, unit, mets) =>
    `<div class="h-t">${title}</div><div class="h-hero">${hero}${unit ? `<i>${unit}</i>` : ''}</div>` +
    `<div class="h-row">${mets.map(([l, v]) => `<div class="h-m"><div class="h-ml">${l}</div><div class="h-mv">${v}</div></div>`).join('')}</div>`;
  const mkHud = g => mkText(g, 'mt-hud');
  const mkCaption = g => mkText(g, 'mt-cap', 1);
  function setHud(it, title, hero, unit, mets) { setText(it, hudHTML(title, hero, unit, mets)); place(it, MARG, MARG, 'tl'); }
  function setCaption(it, txt) { setText(it, txt); place(it, MARG, SH() - MARG, 'bl'); }

  // ---------------------------------------------------------------- label placer
  const mmRect = el => { const b = el.getBoundingClientRect(), s = SC(); return [(b.left - innerWidth / 2) / s + SW() / 2, (b.top - innerHeight / 2) / s + SH() / 2, (b.right - innerWidth / 2) / s + SW() / 2, (b.bottom - innerHeight / 2) / s + SH() / 2]; };
  const estW = html => html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').length * 3.9 + 1;
  const ANNO_H = 8.2;
  function obstacles(P, hudIt) {
    const circ = [], rects = [];
    for (const k of ['earth', 'moon']) if (P[k]) circ.push([P[k].x_mm, P[k].y_mm, 38]);
    for (const k of ['seldon-1', 'seldon-2']) if (P[k]) circ.push([P[k].x_mm, P[k].y_mm, 46]);
    if (P.chip) circ.push([P.chip.x_mm, P.chip.y_mm, 36]);
    const r0 = slotRect(0), r2 = slotRect(2);
    rects.push([r0.x0 - 4, r0.y0 - 14, r2.x1 + 4, SH() - 4]);
    rects.push([MARG - 2, SH() - MARG - 22, MARG + 360, SH() - MARG + 2]);
    if (hudIt && hudIt.on) { const b = mmRect(hudIt.obj); rects.push([b[0] - 3, b[1] - 3, b[2] + 3, b[3] + 3]); }
    return { circ, rects };
  }
  const rectsOverlap = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
  const rectCircle = (r, c) => { const nx = Math.max(r[0], Math.min(c[0], r[2])), ny = Math.max(r[1], Math.min(c[1], r[3])); return Math.hypot(nx - c[0], ny - c[1]) < c[2]; };
  const placerKeys = {};
  // list: [{it, x, y, html}] in priority order; greedy: right, left, above, below, then diagonals
  function placeAnnos(mode, list, obs) {
    const key = list.map(a => `${Math.round(a.x)},${Math.round(a.y)},${a.html}`).join('|') + '#' + obs.circ.map(c => Math.round(c[0]) + ',' + Math.round(c[1])).join(';') + '#' + obs.rects.map(r => Math.round(r[2]) + ',' + Math.round(r[3])).join(';') + SW();
    for (const a of list) { setText(a.it, a.html); a.it.on = true; }
    if (placerKeys[mode] === key) return;
    placerKeys[mode] = key;
    const placed = [], gap = 5, m = MARG - 8;
    for (const a of list) {
      const w = estW(a.html), h = ANNO_H, c = a.r ?? 0, g = gap + c;
      const cands = [[a.x + g, a.y - h / 2], [a.x - g - w, a.y - h / 2], [a.x - w / 2, a.y - g - h], [a.x - w / 2, a.y + g], [a.x + g, a.y - g - h], [a.x - g - w, a.y - g - h], [a.x + g, a.y + g], [a.x - g - w, a.y + g]];
      let best = null, bs = 1e9;
      for (const [x0, y0] of cands) {
        const r = [x0, y0, x0 + w, y0 + h]; let s = 0;
        if (r[0] < m || r[1] < m || r[2] > SW() - m || r[3] > SH() - m) s += 50;
        for (const p of placed) if (rectsOverlap(r, p)) s += 10;
        for (const q of obs.rects) if (rectsOverlap(r, q)) s += 10;
        for (const q of obs.circ) if (rectCircle(r, q)) s += 10;
        if (s < bs) { bs = s; best = [x0, y0, r]; if (s === 0) break; }
      }
      placed.push(best[2]); place(a.it, best[0], best[1], 'tl');
    }
  }

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
    return (p) => {
      let x = p[0], y = p[1];
      for (const B of bodies) {
        const dx = x - B.cx, dy = y - B.cy, d = Math.hypot(dx, dy);
        if (d < B.b && d > 1e-6 && B.push > 0) { const nd = d + B.push * (1 - d / B.b) ** 2; x = B.cx + dx / d * nd; y = B.cy + dy / d * nd; }
      }
      return [x, y];
    };
  }

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
    const warp = mkWarp(F, mission);
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
  // point at arc length s along the dense path
  function atS(path, s) {
    s = Math.max(0, Math.min(path.total, s));
    let lo = 0, hi = path.cum.length - 1; while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (path.cum[mid] <= s) lo = mid; else hi = mid; }
    const seg = path.cum[hi] - path.cum[lo] || 1, f = (s - path.cum[lo]) / seg;
    return { x: path.X[lo] + (path.X[hi] - path.X[lo]) * f, y: path.Y[lo] + (path.Y[hi] - path.Y[lo]) * f, u: path.U[lo] + (path.U[hi] - path.U[lo]) * f };
  }

  // ================================================================ chrome: mode selector (bottom-right)
  const SLOT = 70, SGAP = 12, SEL_LABEL = 20;
  const slotRect = i => { const x0 = SW() - MARG - 3 * SLOT - 2 * SGAP + i * (SLOT + SGAP), y0 = SH() - MARG - SEL_LABEL - SLOT; return { x0, y0, x1: x0 + SLOT, y1: y0 + SLOT, cx: x0 + SLOT / 2, cy: y0 + SLOT / 2 }; };
  const boxRect = slotRect;
  const slots = MODE_NAMES.map(() => ({ line: mkLine('chrome', 'slot'), glyph: mkLine('chrome', 'glyph'), lbl: mkText('chrome', 'mt-sel'), bar: mkLine('chrome', 'bar') }));
  const modeCap = mkText('chrome', 'mt-mode');
  function glyphPts(i, cx, cy) {
    if (i === 0) { const out = []; for (let k = 0; k <= 160; k++) { const a = k / 160 * TAU * 2.6, r = 3 + 19 * k / 160; out.push(W(cx + r * Math.cos(a), cy - r * Math.sin(a))); } return out; }
    if (i === 1) { const a = circPts(cx, cy, 10, 48), b = circPts(cx, cy, 22, 64), t = circPts(cx, cy, 16, 24, .5, 2.6); return [...a, ...t.slice().reverse().slice(0, 0), ...b]; }
    const out = []; for (const R of [7, 14, 21]) { for (let k = 0; k <= 96; k++) { const a = k / 96 * TAU, r = R + 1.3 * Math.sin(a * 3 + R); out.push(W(cx + r * Math.cos(a), cy - r * Math.sin(a))); } } return out;
  }
  const glyphExtra = mkLine('chrome', 'glyph'), glyphExtra2 = mkLine('chrome', 'glyph');
  function layoutSlots() {
    slots.forEach((s, i) => {
      const r = slotRect(i);
      setPts(s.line, [W(r.x0, r.y0), W(r.x1, r.y0), W(r.x1, r.y1), W(r.x0, r.y1), W(r.x0, r.y0)]);
      if (i === 1) { setPts(s.glyph, [...circPts(r.cx, r.cy, 22, 64)]); setPts(glyphExtra, circPts(r.cx, r.cy, 10, 40)); setPts(glyphExtra2, circPts(r.cx, r.cy, 16, 30, 0.4, 3.0)); }
      else setPts(s.glyph, glyphPts(i, r.cx, r.cy));
      setText(s.lbl, MODE_TITLES[i]); place(s.lbl, r.cx, r.y1 + 3, 'c');
    });
    const r0 = slotRect(0); setText(modeCap, 'MODE'); place(modeCap, r0.x0, r0.y0 - 3, 'bl');
  }

  // ================================================================ MISSION
  const M = { evs: [] };
  M.hud = mkHud('mission'); M.cap = mkCaption('mission'); M.hint = mkText('mission', 'mt-a');
  M.route = mkLine('mission', 'primary'); M.dro = mkLine('mission', 'target'); M.geo = mkLine('mission', 'ref'); M.geoL = mkText('mission', 'mt-a', .7);
  M.hi = mkLine('mission', 'hi'); M.ring = mkLine('mission', 'marker'); M.trail = mkLine('mission', 'trail');
  M.ghost = mkDot('mission', LAV2, 1.5, 1);
  const EV_NAME = { spiral: 'ELECTRIC SPIRAL', tli: 'TLI', opf: 'FLYBY', dri: 'DRO INSERTION' };
  const PHASE_NAME = { leo: 'LEO', spiral: 'SPIRAL', transfer: 'TRANSFER', coast: 'COAST', 'flyby-to-dro': 'FLYBY', dro: 'DRO' };
  function initMissionItems() {
    for (const ev of mission.events || []) {
      if (ev.name === 'opf') continue;
      M.evs.push({ ev, mark: mkLine('mission', 'marker'), lbl: mkText('mission', 'mt-a', .9) });
    }
    applyFonts();
  }
  const evDv = n => { const e = (mission?.events || []).find(e => e.name === n); return e && e.dv_kms != null ? e.dv_kms : null; };

  function updMission(P, dt, now) {
    const E = P.earth, Mo = P.moon, A = P['seldon-1'];
    setCaption(M.cap, (mission && mission.caption ? String(mission.caption).toUpperCase() : 'PLANAR CR3BP REFERENCE TRAJECTORY · NOT TO SCALE NEAR EARTH/MOON'));
    const TITLE = 'MISSION · LEO → DRO';
    const allHide = () => { M.builtKey = null; hide(M.route, M.dro, M.geo, M.geoL, M.hi, M.ring, M.trail, M.ghost); M.evs.forEach(e => hide(e.mark, e.lbl)); };
    if (!E || !Mo) { allHide(); setHud(M.hud, TITLE, '—', '', []); setText(M.hint, 'PLACE EARTH AND MOON'); place(M.hint, SW() / 2, SH() / 2, 'cm'); return; }
    const F = frameEM(E, Mo);
    if (!F) { allHide(); return; }
    if (!mission) { allHide(); setHud(M.hud, TITLE, '—', '', []); setText(M.hint, missionErr ? 'MISSION DATA NOT FOUND' : 'LOADING TRAJECTORY'); place(M.hint, SW() / 2, SH() / 2, 'cm'); return; }
    hide(M.hint);
    const path = getPath(F), annos = [];
    const rGeo = GEO_R * F.s;
    setPts(M.geo, circPts(F.ex, F.ey, rGeo, 160));
    annos.push({ it: M.geoL, x: F.ex, y: F.ey - rGeo, html: 'GEO' });
    if (M.builtKey !== path.key) {
      M.builtKey = path.key;
      const pts = [], fr = []; let tot = 0;
      for (let i = 0; i < path.X.length; i++) if (path.ph[i] !== 'dro') { pts.push(W(path.X[i], path.Y[i])); fr.push(path.cum[i]); tot = path.cum[i]; }
      if (pts.length > 1) setPts(M.route, pts, fr.map(c => Math.sqrt(c / (tot || 1)))); else hide(M.route);
      if (path.dro) setPts(M.dro, path.dro.X.map((x, i) => W(x, path.dro.Y[i]))); else hide(M.dro);
      M.evPos = M.evs.map(e => path.warp(F.to(e.ev.x, e.ev.y)));
      M.evs.forEach((e, i) => setPts(e.mark, circPts(M.evPos[i][0], M.evPos[i][1], MARK_R, 28)));
    }
    M.evs.forEach((e, i) => {
      const q = M.evPos[i], dv = e.ev.dv_kms;
      annos.push({ it: e.lbl, x: q[0], y: q[1], r: MARK_R, html: `${EV_NAME[e.ev.name] || (e.ev.label || e.ev.name).toUpperCase()}${dv != null ? ` <b>${num(dv)}${U('km/s')}</b>` : ''}` });
    });

    const snap = A ? nearest(path, A.x_mm, A.y_mm) : null;
    const snapped = snap && snap.d < 40;
    const spiralDv = evDv('spiral'), insDv = evDv('dri'), days = mission.transfer_days;
    if (snapped) {
      hide(M.ghost, M.trail);
      setPts(M.hi, slice(path, snap.idx));
      setPts(M.ring, circPts(snap.x, snap.y, MARK_R * 1.4, 28));
      const f = fieldsAt(snap.u), nearMoon = f.r_moon < MOON_SOI, sp = nearMoon ? f.v_moon : f.v_earth, alt = nearMoon ? f.r_moon : f.r_earth;
      setHud(M.hud, TITLE, num(mission.total_dv_kms), 'km/s', [
        ['PHASE', PHASE_NAME[f.phase] || f.phase.toUpperCase()], ['T+', `${Math.floor(f.t_h / 24)}${U('d')} ${String(Math.floor(f.t_h % 24)).padStart(2, '0')}${U('h')}`],
        ['Δv USED', `${num(f.dv)}${U('km/s')}`], ['SPEED', `${num(sp)}${U('km/s')}`], ['ALT', `${thou(alt)}${U('km')}`]]);
    } else {
      hide(M.hi, M.ring);
      const s = ((now / 1000) % 26) / 25 * path.total, g = atS(path, Math.min(s, path.total));
      M.ghost.obj.position.set(g.x, -g.y, 1); M.ghost.on = true;
      const tr = [], trc = []; const TR = 26;
      for (let k = 0; k <= 20; k++) { const q = atS(path, s - TR * (1 - k / 20)); tr.push(W(q.x, q.y)); }
      if (s > 2) setPts(M.trail, tr, null, 0, .8); else hide(M.trail);
      setHud(M.hud, TITLE, num(mission.total_dv_kms), 'km/s', [
        ['TIME', `${days >= 20 ? Math.round(days) : num(days, 1)}${U('d')}`],
        ['SPIRAL', spiralDv != null ? `${num(spiralDv)}${U('km/s')}` : '—'], ['INSERTION', insDv != null ? `${num(insDv)}${U('km/s')}` : '—']]);
    }
    placeAnnos('mission', annos, obstacles(P, M.hud));
  }

  // ================================================================ INTERCEPT
  const I = {};
  I.hud = mkHud('intercept'); I.cap = mkCaption('intercept'); I.hint = mkText('intercept', 'mt-a');
  I.geo = mkLine('intercept', 'ref'); I.geoL = mkText('intercept', 'mt-a', .7);
  I.orb = [0, 1].map(k => ({ line: mkLine('intercept', k === 0 ? 'ref' : 'target'), dot: mkDot('intercept', k === 0 ? LAV : IVORY, 1.2, .6), ang: 0, last: null }));
  I.arc = mkLine('intercept', 'primary'); I.wait = mkLine('intercept', 'ref');
  I.dep = mkLine('intercept', 'marker'); I.rdv = mkLine('intercept', 'marker');
  I.b1 = mkText('intercept', 'mt-a', .9); I.b2 = mkText('intercept', 'mt-a', .9);
  const RHO0 = EARTH_PIECE_R + SELDON_BASE_R + 3;
  const rhoOf = r => RHO0 + (r - R_E) / K_KM_PER_MM;
  const wrap = a => { a = a % TAU; return a < 0 ? a + TAU : a; };

  function updIntercept(P, dt) {
    const E = P.earth, Ps = [P['seldon-1'], P['seldon-2']];
    setCaption(I.cap, 'COPLANAR HOHMANN · ALTITUDE TO SCALE, EARTH NOT');
    const TITLE = 'INTERCEPT · SELDON-1 → SELDON-2';
    const hideAll = () => { hide(I.geo, I.geoL, I.arc, I.wait, I.dep, I.rdv, I.hint, I.b1, I.b2); I.orb.forEach(o => hide(o.line, o.dot)); };
    if (!E) { hideAll(); setHud(I.hud, TITLE, '—', '', []); setText(I.hint, 'PLACE EARTH'); place(I.hint, SW() / 2, SH() / 2, 'cm'); return; }
    hide(I.hint);
    const ex = E.x_mm, ey = E.y_mm, annos = [];
    const rhoGeo = rhoOf(GEO_R);
    setPts(I.geo, circPts(ex, ey, rhoGeo, 192));
    annos.push({ it: I.geoL, x: ex, y: ey - rhoGeo, html: 'GEO' });
    const rhoMin = rhoOf(R_E + 200);
    const info = Ps.map((p, k) => {
      const o = I.orb[k];
      if (!p) { hide(o.line, o.dot); return null; }
      const dx = p.x_mm - ex, dy = p.y_mm - ey, rho = Math.max(rhoMin, Math.hypot(dx, dy));
      const r = R_E + (rho - RHO0) * K_KM_PER_MM, theta = Math.atan2(-dy, dx);
      return { k, o, p, rho, r, theta, v: Math.sqrt(MU_E / r), T: TAU * Math.sqrt(r ** 3 / MU_E), n: Math.sqrt(MU_E / r ** 3) };
    });
    const nmax = Math.max(...info.filter(Boolean).map(i => i.n), 1e-9), warpRate = TAU / (nmax * 6);
    for (const i of info) {
      if (!i) continue;
      const { o } = i;
      setPts(o.line, circPts(ex, ey, i.rho, 160));
      if (o.last === null || Math.abs(Math.atan2(Math.sin(i.theta - o.last), Math.cos(i.theta - o.last))) > 1e-3) o.ang = i.theta;
      o.last = i.theta; o.ang += i.n * warpRate * dt;
      o.dot.obj.position.set(ex + i.rho * Math.cos(o.ang), -(ey - i.rho * Math.sin(o.ang)), 1); o.dot.on = true;
    }
    const [c, t] = info;
    const done = () => placeAnnos('intercept', annos, obstacles(P, I.hud));
    if (!c || !t) {
      hide(I.arc, I.wait, I.dep, I.rdv, I.b1, I.b2);
      setHud(I.hud, TITLE, '—', '', [['MOVE', 'place both Seldons']]);
      done(); return;
    }
    if (Math.abs(c.n - t.n) / Math.max(c.n, t.n) < 0.0015) {
      hide(I.arc, I.wait, I.dep, I.rdv, I.b1, I.b2);
      setHud(I.hud, TITLE, '—', '', [['STATUS', 'co-orbital · phasing needed']]);
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
      const nu = (up ? 0 : Math.PI) + Math.PI * j / 120, r = p / (1 + e * Math.cos(nu)), ang = thd + Math.PI * j / 120, rho = rhoOf(r);
      arc.push(W(ex + rho * Math.cos(ang), ey - rho * Math.sin(ang)));
    }
    setPts(I.arc, arc);
    if (tw > 1e-6) setPts(I.wait, circPts(ex, ey, c.rho, 80, c.theta, c.theta + c.n * tw)); else hide(I.wait);
    const dx0 = ex + c.rho * Math.cos(thd), dy0 = ey - c.rho * Math.sin(thd);
    const tha = thd + Math.PI, rx = ex + t.rho * Math.cos(tha), ry = ey - t.rho * Math.sin(tha);
    setPts(I.dep, circPts(dx0, dy0, MARK_R, 28)); setPts(I.rdv, circPts(rx, ry, MARK_R, 28));
    annos.push({ it: I.b1, x: dx0, y: dy0, r: MARK_R, html: `BURN 1 <b>${num(h.dv1)}${U('km/s')}</b>` });
    annos.push({ it: I.b2, x: rx, y: ry, r: MARK_R, html: `BURN 2 <b>${num(h.dv2)}${U('km/s')}</b>` });
    setHud(I.hud, TITLE, num(h.total), 'km/s', [
      ['BURN 1', `${num(h.dv1)}${U('km/s')}`], ['BURN 2', `${num(h.dv2)}${U('km/s')}`], ['TRANSFER', fmtHM(h.tof).replace(/ (h|m)/g, (m, u) => U(u))], ['NEXT WINDOW', fmtHM(tw).replace(/ (h|m)/g, (m, u) => U(u))]]);
    done();
  }

  // ================================================================ ΔV MAP
  const D = {};
  D.hud = mkHud('dvmap'); D.cap = mkCaption('dvmap'); D.hint = mkText('dvmap', 'mt-a');
  D.cnum = [1, 2, 3, 4, 5, 6, 7, 8].map(v => ({ v, lbl: mkText('dvmap', 'mt-c', 1) }));
  D.geo = mkLine('dvmap', 'ref'); D.geoL = mkText('dvmap', 'mt-a', .85);
  D.l1 = mkLine('dvmap', 'marker'); D.l1L = mkText('dvmap', 'mt-a', .9);
  D.l2 = mkLine('dvmap', 'marker'); D.l2L = mkText('dvmap', 'mt-a', .9);
  D.llo = mkLine('dvmap', 'ref'); D.lloL = mkText('dvmap', 'mt-a', .85);
  D.dro = mkLine('dvmap', 'target'); D.droL = mkText('dvmap', 'mt-a', .9);
  D.orb = mkLine('dvmap', 'ref'); D.orbL = mkText('dvmap', 'mt-a', .85);
  D.route = mkLine('dvmap', 'primary');
  const SHADER_VS = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }';
  const SHADER_FS = `
    precision highp float;
    varying vec2 vUv;
    uniform vec2 uE, uM, uScreen; uniform float uS, uMax, uOpacity, oVE, oVM, oW;
    const float MU_E = ${MU_E}, MU_M = ${MU_M}, R_EARTH = ${R_E}, R_MOON = ${R_M}, SOI = ${MOON_SOI}.0;
    uniform float vEL, vMSOI;
    float lineAA(float u, float fw){ fw = max(fw, 1e-5); return 1.0 - smoothstep(0.3, 1.0, abs(fract(u + 0.5) - 0.5) / fw); }
    void main(){
      vec2 p = vec2(vUv.x * uScreen.x, (1.0 - vUv.y) * uScreen.y);
      float r = length(p - uE) / uS, d = length(p - uM) / uS;
      if (r < R_EARTH || d < R_MOON) discard;
      float vEr = sqrt(MU_E / r), vMd = sqrt(MU_M / d);
      float t = clamp((SOI - d) / 10000.0, 0.0, 1.0); float wB = t * t * (3.0 - 2.0 * t);
      float cost = (1.0 - oW) * (1.0 - wB) * abs(oVE - vEr)
                 + (1.0 - oW) * wB * (abs(oVE - vEL) + max(0.0, vMd - vMSOI))
                 + oW * (1.0 - wB) * (abs(vEr - vEL) + max(0.0, oVM - vMSOI))
                 + oW * wB * abs(oVM - vMd);
      // hypsometric bands every 0.5 km/s, low-contrast violet-slate ramp
      float lvl = floor(cost / 0.5);
      float tt = clamp(lvl / 7.0, 0.0, 1.0);
      vec3 col = mix(vec3(11., 13., 20.) / 255., vec3(50., 43., 78.) / 255., tt);
      // faint hillshade (<= 12%)
      float gx = dFdx(cost) / (dFdx(p.x) + 1e-9), gy = dFdy(cost) / (dFdy(p.y) + 1e-9);
      if (abs(dFdx(p.x)) < 1e-6) gx = 0.0; if (abs(dFdy(p.y)) < 1e-6) gy = 0.0;
      const float ZS = 60.0; vec3 L = vec3(-.55, -.55, .63);
      float cmp = 1.0 / (1.0 + ZS * length(vec2(gx, gy)) * .12);
      vec3 n = vec3(-ZS * gx * cmp, -ZS * gy * cmp, 1.0);
      float lit = max(0.0, dot(n, L) / (length(n) * length(L)));
      col *= 1.0 + .12 * clamp(lit / (L.z / length(L)) - 1.0, -1.0, 1.0);
      // contours: minor every 0.5 (14%), major every 1.0 (35%)
      float u1 = cost / 0.5, f1 = fwidth(u1);
      float minor = lineAA(u1, f1) * (1.0 - smoothstep(0.25, 0.45, f1));
      float major = lineAA(cost, fwidth(cost));
      col = mix(col, vec3(214., 217., 224.) / 255., .14 * minor);
      col = mix(col, vec3(214., 217., 224.) / 255., .35 * major);
      gl_FragColor = vec4(pow(col, vec3(2.2)), uOpacity);
    }`;
  D.shadeMat = new THREE.ShaderMaterial({
    vertexShader: SHADER_VS, fragmentShader: SHADER_FS, transparent: true, depthWrite: false, toneMapped: false,
    uniforms: { uE: { value: new THREE.Vector2() }, uM: { value: new THREE.Vector2() }, uScreen: { value: new THREE.Vector2(1, 1) }, uS: { value: 1 }, uMax: { value: 8 }, uOpacity: { value: 0 },
      oVE: { value: 0 }, oVM: { value: 0 }, oW: { value: 0 }, vEL: { value: V_MOONORB }, vMSOI: { value: Math.sqrt(MU_M / MOON_SOI) } },
  });
  { const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), D.shadeMat); m.position.z = -4; m.visible = false; scene.add(m); D.shade = add('dvmap', 'mesh', m, 1); }

  let dvObs = [], dvKey = null, dvAt = -1e9, dvOrg = LEO_ORIGIN, dvMax = 8;
  const ptKm = (F, px, py) => mkPt(Math.hypot(px - F.ex, py - F.ey) / F.s, Math.hypot(px - F.mx, py - F.my) / F.s);
  const deltaV = (F, px, py) => dvField(Math.hypot(px - F.ex, py - F.ey) / F.s, Math.hypot(px - F.mx, py - F.my) / F.s, dvOrg);

  // contour-number labels + ramp top, on a coarse grid (no allocations in the inner loops)
  const NX = 120, NY = 68, GV = new Float32Array((NX + 1) * (NY + 1));
  const ETAB = [[0, 0, 1, 0], [1, 0, 1, 1], [0, 1, 1, 1], [0, 0, 0, 1]];
  const STAB = [[], [3, 0], [0, 1], [3, 1], [1, 2], [3, 0, 1, 2], [0, 2], [3, 2], [2, 3], [0, 2], [0, 1, 2, 3], [1, 2], [3, 1], [0, 1], [3, 0], []];
  function recomputeField(F) {
    const sw = SW(), sh = SH(), csx = sw / NX, csy = sh / NY;
    const oVEc = vE(dvOrg.r), oVMc = vM(dvOrg.d), oWc = dvOrg.w, vEL = V_MOONORB, vMS = vM(MOON_SOI), invS = 1 / F.s;
    let vmax = 1;
    for (let j = 0; j <= NY; j++) for (let i = 0; i <= NX; i++) {
      const px = i * csx, py = j * csy, r = Math.hypot(px - F.ex, py - F.ey) * invS, d = Math.hypot(px - F.mx, py - F.my) * invS;
      let v = NaN;
      if (r >= R_E && d >= R_M) {
        const a = vE(r), b = vM(d), t = d >= MOON_SOI ? 0 : d <= MOON_SOI - 10000 ? 1 : (MOON_SOI - d) / 10000, wB = d >= MOON_SOI ? 0 : d <= MOON_SOI - 10000 ? 1 : t * t * (3 - 2 * t);
        v = (1 - oWc) * (1 - wB) * Math.abs(oVEc - a) + (1 - oWc) * wB * (Math.abs(oVEc - vEL) + Math.max(0, b - vMS)) + oWc * (1 - wB) * (Math.abs(a - vEL) + Math.max(0, oVMc - vMS)) + oWc * wB * Math.abs(oVMc - b);
        if (v > vmax) vmax = v;
      }
      GV[j * (NX + 1) + i] = v;
    }
    dvMax = Math.min(8, vmax); D.shadeMat.uniforms.uMax.value = dvMax;
    const cand = D.cnum.map(() => null);
    for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
      const va = GV[j * (NX + 1) + i], vb = GV[j * (NX + 1) + i + 1], vc = GV[(j + 1) * (NX + 1) + i + 1], vd = GV[(j + 1) * (NX + 1) + i];
      if (va !== va || vb !== vb || vc !== vc || vd !== vd) continue;
      const mn = Math.min(va, vb, vc, vd), mx = Math.max(va, vb, vc, vd);
      for (let q = 0; q < D.cnum.length; q++) {
        const l = D.cnum[q].v; if (l <= mn || l > mx) continue;
        const idx = (va > l ? 1 : 0) | (vb > l ? 2 : 0) | (vc > l ? 4 : 0) | (vd > l ? 8 : 0), st = STAB[idx];
        for (let k = 0; k < st.length; k += 2) {
          let sx = 0, sy = 0;
          for (let h = 0; h < 2; h++) {
            const e = ETAB[st[k + h]], v0 = GV[(j + e[1]) * (NX + 1) + i + e[0]], v1 = GV[(j + e[3]) * (NX + 1) + i + e[2]], tt = (l - v0) / (v1 - v0);
            sx += (i + e[0] + (e[2] - e[0]) * tt) * csx; sy += (j + e[1] + (e[3] - e[1]) * tt) * csy;
          }
          const x = sx / 2, y = sy / 2;
          if (y < 130 || y > sh - 130 || x < 60 || x > sw - 60) continue;
          let blocked = false; for (let z = 0; z < dvObs.length; z++) { const o = dvObs[z]; if (Math.hypot(x - o[0], y - o[1]) < o[2] + 6) { blocked = true; break; } } if (blocked) continue;
          const sc = y + .35 * Math.abs(x - F.ex);
          if (!cand[q] || sc < cand[q].sc) cand[q] = { x, y, sc };
        }
      }
    }
    D.cnum.forEach((cn, q) => { if (cand[q]) { setText(cn.lbl, String(cn.v)); place(cn.lbl, cand[q].x, cand[q].y, 'cm'); } else hide(cn.lbl); });
  }
  // Earth-centred prograde low-thrust spiral between (r1,th1) and the destination, drawn in km through the frame/warp
  const altOf = pt => pt.w > .5 ? { v: pt.d - R_M, moon: true } : { v: pt.r - R_E, moon: false };
  const fmtAlt = a => `${thou(Math.max(0, a.v))}${U(a.moon ? 'km moon' : 'km')}`;

  function updDv(P, dt, now) {
    const E = P.earth, Mo = P.moon, A = P['seldon-1'], B = P['seldon-2'];
    const from = A ? 'SELDON-1' : '400 KM LEO';
    setCaption(D.cap, `ΔV FROM ${from} · LOW-THRUST (EDELBAUM) ESTIMATE · COPLANAR · PHASING IGNORED · BANDS 0.5 KM/S`);
    const TITLE = `ΔV MAP · FROM ${from}`;
    const hideAll = () => { hide(D.shade, D.geo, D.geoL, D.l1, D.l1L, D.l2, D.l2L, D.llo, D.lloL, D.dro, D.droL, D.route, D.orb, D.orbL); D.cnum.forEach(c => hide(c.lbl)); };
    if (!E || !Mo) { hideAll(); setHud(D.hud, TITLE, '—', '', []); setText(D.hint, 'PLACE EARTH AND MOON'); place(D.hint, SW() / 2, SH() / 2, 'cm'); return; }
    const F = frameEM(E, Mo);
    if (!F) { hideAll(); return; }
    hide(D.hint);
    dvOrg = A ? ptKm(F, A.x_mm, A.y_mm) : LEO_ORIGIN;
    const key = F.key + '|' + (A ? Math.round(A.x_mm * 10) + ',' + Math.round(A.y_mm * 10) : 'leo');
    dvObs = obstacles(P, null).circ;
    if (dvKey !== key && now - dvAt > 100) { recomputeField(F); dvKey = key; dvAt = now; }
    { const u = D.shadeMat.uniforms; u.uE.value.set(F.ex, F.ey); u.uM.value.set(F.mx, F.my); u.uScreen.value.set(SW(), SH()); u.uS.value = F.s;
      u.oVE.value = vE(dvOrg.r); u.oVM.value = vM(dvOrg.d); u.oW.value = dvOrg.w;
      D.shade.on = true; D.shade.obj.scale.set(SW(), SH(), 1); D.shade.obj.position.set(SW() / 2, -SH() / 2, -4); }
    const path = getPath(F), warp = path ? path.warp : (p => p);
    const costAt = (r, d) => dvCost(dvOrg, mkPt(r, d));
    const annos = [];
    // origin orbit: zero-cost valley
    if (A) {
      const cx = dvOrg.w > .5 ? F.mx : F.ex, cy = dvOrg.w > .5 ? F.my : F.ey, R = Math.hypot(A.x_mm - cx, A.y_mm - cy);
      setPts(D.orb, circPts(cx, cy, R, 180));
      const ang = Math.atan2(-(A.y_mm - cy), A.x_mm - cx) + Math.PI;
      annos.push({ it: D.orbL, x: cx + R * Math.cos(ang), y: cy - R * Math.sin(ang), html: `<b>Δv = 0</b>` });
    } else hide(D.orb, D.orbL);
    const rGeo = GEO_R * F.s;
    const vGeo = costAt(GEO_R, L_KM + GEO_R), vL1 = costAt(326400, L_KM - 326400), vL2 = costAt(448900, 448900 - L_KM), vLLO = costAt(L_KM, R_M + 100);
    setPts(D.geo, circPts(F.ex, F.ey, rGeo, 160));
    annos.push({ it: D.geoL, x: F.ex, y: F.ey - rGeo, html: `GEO <b>${num(vGeo)}</b>` });
    const l1 = F.to(326400, 0), l2 = F.to(448900, 0);
    setPts(D.l1, circPts(l1[0], l1[1], MARK_R, 28)); annos.push({ it: D.l1L, x: l1[0], y: l1[1], r: MARK_R, html: `L1 <b>${num(vL1)}</b>` });
    setPts(D.l2, circPts(l2[0], l2[1], MARK_R, 28)); annos.push({ it: D.l2L, x: l2[0], y: l2[1], r: MARK_R, html: `L2 <b>${num(vL2)}</b>` });
    const rLLO = MOON_PIECE_R + 5;
    setPts(D.llo, circPts(F.mx, F.my, rLLO, 64)); annos.push({ it: D.lloL, x: F.mx + rLLO * .7, y: F.my - rLLO * .7, html: `LLO <b>${num(vLLO)}</b>` });
    let droTop = null, vDro = 0;
    if (mission?.dro?.points?.length) { let sum = 0; for (const [x, y] of mission.dro.points) sum += costAt(Math.hypot(x, y), Math.hypot(x - L_KM, y)); vDro = sum / mission.dro.points.length; }
    if (path?.dro) {
      setPts(D.dro, path.dro.X.map((x, i) => W(x, path.dro.Y[i])));
      for (let i = 0; i < path.dro.X.length; i++) if (!droTop || path.dro.Y[i] < droTop.y) droTop = { x: path.dro.X[i], y: path.dro.Y[i] };
      annos.push({ it: D.droL, x: droTop.x, y: droTop.y, html: `DRO <b>${num(vDro)}</b>` });
    } else hide(D.dro, D.droL);
    // destination: Seldon-2
    const fromAlt = fmtAlt(altOf(dvOrg));
    if (!B) { setHud(D.hud, TITLE, '—', '', [['MOVE', 'place Seldon-2 to price it'], ['FROM ALT', fromAlt]]); hide(D.route); placeAnnos('dvmap', annos, obstacles(P, D.hud)); return; }
    const f = deltaV(F, B.x_mm, B.y_mm);
    if (!f) { hide(D.route); setHud(D.hud, TITLE, '—', '', [['MOVE', 'inside a body']]); placeAnnos('dvmap', annos, obstacles(P, D.hud)); return; }
    const bPt = ptKm(F, B.x_mm, B.y_mm), bothMoon = dvOrg.w > .5 && f.br === 'moon';
    const rt = f.br === 'moon' ? (bothMoon ? 'lunar spiral' : 'spiral + capture') : 'earth spiral';
    setHud(D.hud, TITLE, num(f.v), 'km/s', [['ROUTE', rt], ['FROM ALT', fromAlt], ['TO ALT', fmtAlt(altOf(bPt))]]);
    // route: Earth-centred prograde spiral, radius interpolated with angle, plus one extra turn
    const kb = F.from(B.x_mm, B.y_mm), kd = bPt;
    const o = A ? F.from(A.x_mm, A.y_mm) : [R_LEO, 0];
    const r1 = Math.hypot(o[0], o[1]), th1 = Math.atan2(o[1], o[0]);
    const km = [], wrap2 = a => ((a % TAU) + TAU) % TAU;
    const spiral = (rA, thA, rB, thB, n) => { let dth = wrap2(thB - thA); if (dth < 1e-6) dth = TAU;
      // phasing is ignored on this map, so leave Seldon-1's orbit wherever the prograde sweep is short (<= 120°)
      const MAXS = TAU / 3; if (dth > MAXS) { thA = thB - MAXS; dth = MAXS; }
      for (let j = 0; j <= n; j++) { const t = j / n, te = t * t * (3 - 2 * t), r = rA + (rB - rA) * te, a = thA + dth * t; km.push([r * Math.cos(a), r * Math.sin(a)]); } };
    if (f.br === 'moon') {
      spiral(r1, th1, L_KM - kd.d, 0, 220);
      const last = km[km.length - 1];
      for (let j = 1; j <= 24; j++) { const t = j / 24, u = 1 - t; km.push([u * u * last[0] + 2 * u * t * kb[0] + t * t * kb[0], u * u * last[1] + t * t * kb[1]]); }
    } else spiral(r1, th1, Math.hypot(kb[0], kb[1]), Math.atan2(kb[1], kb[0]), 240);
    setPts(D.route, km.map(p => { const q = warp(F.to(p[0], p[1])); return W(q[0], q[1]); }));
    placeAnnos('dvmap', annos, obstacles(P, D.hud));
  }

  // ================================================================ mode switching / main update
  let current = MODE_NAMES.includes(ctx.initialMode) ? ctx.initialMode : 'mission';
  groups[current].fade = 1;
  let lastBox = undefined;
  const hintFirst = !!ctx.initialMode;
  function setMode(name) {
    if (!MODE_NAMES.includes(name) || name === current) return;
    current = name; if (ctx.onModeChange) ctx.onModeChange(name);
  }
  const updFns = { mission: updMission, intercept: updIntercept, dvmap: updDv };

  function update(pieces, dt, nowMs) {
    const P = {};
    for (const k of ['earth', 'moon', 'seldon-1', 'seldon-2', 'chip']) if (pieces[k]) P[k] = pieces[k];
    let box = -1;
    if (P.chip) for (let i = 0; i < 3; i++) { const r = slotRect(i); if (Math.abs(P.chip.x_mm - r.cx) < SLOT / 2 && Math.abs(P.chip.y_mm - r.cy) < SLOT / 2) box = i; }
    if (lastBox === undefined) { lastBox = box; if (!hintFirst && box >= 0) setMode(MODE_NAMES[box]); }
    else if (box !== lastBox) { lastBox = box; if (box >= 0) setMode(MODE_NAMES[box]); }
    const cur = MODE_NAMES.indexOf(current);
    if (layoutSlots.key !== SW() + 'x' + SH()) { layoutSlots.key = SW() + 'x' + SH(); layoutSlots(); }
    slots.forEach((s, i) => {
      const act = i === cur, r = slotRect(i);
      s.line.base = act ? .45 : .22; s.glyph.base = .3; s.lbl.base = act ? 1 : .45;
      if (i === 1) { glyphExtra.base = .3; glyphExtra2.base = .3; }
      const w = MODE_TITLES[i].length * 9 * .8; s.bar.on = act;
      if (act) setPts(s.bar, [W(r.cx - w / 2, r.y1 + 17), W(r.cx + w / 2, r.y1 + 17)]);
    });
    for (const m of MODE_NAMES) {
      const g = groups[m], target = m === current ? 1 : 0;
      g.fade += (target > g.fade ? 1 : -1) * Math.min(.1, dt) / .3;
      g.fade = Math.max(0, Math.min(1, g.fade));
      if (g.fade > .003) updFns[m](P, dt, nowMs);
    }
    for (const g of Object.values(groups)) {
      const vis = g.fade > .003;
      for (const it of g.items) {
        const show = vis && it.on, o = it.base * g.fade;
        if (it.kind === 'line') { it.obj.visible = show; it.obj.material.opacity = o; }
        else if (it.kind === 'mesh') { it.obj.visible = show; it.obj.material.opacity = o; if (it.obj.material.uniforms) it.obj.material.uniforms.uOpacity.value = o; }
        else { it.obj.style.display = show ? '' : 'none'; it.obj.style.opacity = o; }
      }
    }
    glyphExtra.on = glyphExtra2.on = slots[1].glyph.on;
  }
  function onLayout() {
    applyFonts();
    for (const g of Object.values(groups)) for (const it of g.items) if (it.kind === 'line') it.obj.material.resolution.set(...mkres());
    layoutSlots.key = null; pathCache = { key: null }; M.builtKey = null; dvKey = null;
    for (const k of Object.keys(placerKeys)) placerKeys[k] = null;
  }
  applyFonts();
  return { update, setMode, onLayout, get mode() { return current; }, boxRect };
}
