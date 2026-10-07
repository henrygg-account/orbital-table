"""engage_server.py — runs the REAL General Galactic engagement sim (Orbital Engagement Lab physics + the wargame
runner, unmodified) for the orbital table, with the opening geometry taken from where the Seldon pieces sit.

Everything about a run is what the Engagement Lab web app (wargame/webapp/app.py) builds when you press Run with
its defaults: the GG-1 `base` product card for our craft, an adversary that mirrors the same base card (airframe +
sensor), the scenario's own doctrine, criteria and window, seed 0. The ONLY differences:

  * the adversary's opening offset (R and I, km) comes from the table instead of the "Start distance" box, and
  * the per-seed ±0.4 km in-track jitter is off, because the placement IS the opening.

The runner derives two things from the opening — the evader's react range and the attacker's guidance plan times
(both "sized to the commanded opening") — but reads only the in-track component (`start_range_path`). A table
placement can be mostly radial, so this server applies those same two rules with the true opening distance
hypot(R, I), passes them as ordinary config-path overrides, and blanks `start_range_path` so the runner does not
re-apply them from the in-track number alone. Upstream code is never modified.

Run with the OEL venv:
  ../../gengalactic-demos/apps/orbital-sim/orbital-engagement-lab-main/.venv/bin/python tools/engage_server.py
API (CORS open, localhost only):
  GET  /health
  GET  /scenarios                      -> featured + all scenario ids with titles and roles
  POST /run {scenario, r_km, i_km}     -> {verdict, reasons, margins, roles, threshold_km, t[], range[], cha[[r,i]], tgt[[r,i]], ...}
"""
from __future__ import annotations

import copy
import csv
import json
import math
import os
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")   # same cap the runner sets for its workers
os.environ.setdefault("OMP_NUM_THREADS", "1")

import yaml  # noqa: E402

from wargame.campaign import expand_matrix, load_campaign  # noqa: E402
from wargame.inject import get_path_value  # noqa: E402
from wargame.products import load_product_card  # noqa: E402
from wargame.runner import _payload_from_spec, execute_run  # noqa: E402
from wargame import scenarios as _wg_scenarios  # noqa: E402
from wargame.behaviors import CommonSenseEvader  # noqa: E402
from wargame.scenarios import load_scenario, scenario_library  # noqa: E402

MU_E = 398600.4418


class PlanarEvader(CommonSenseEvader):
    """The upstream CommonSenseEvader with cross-track manoeuvring banned (the table is top-down and coplanar).

    Identical doctrine (react rule, hysteresis band, full authority, hard delta-v stop, DONE at the window); only the
    dodge direction changes: upstream blends the in-plane perpendicular-to-line-of-sight with a 0.65 cross-track push;
    here the dodge is the in-plane perpendicular alone.
    """

    def _dodge_direction_eci(self, own_pos, own_vel, rel_pos_eci):
        from wargame.behaviors import _cross, _dot, _ric_axes, _unit
        axes = _ric_axes(own_pos, own_vel)
        if axes is None:
            return None
        r_hat, i_hat, c_hat = axes
        los_ric = _unit((_dot(rel_pos_eci, r_hat), _dot(rel_pos_eci, i_hat), 0.0))
        if los_ric is None:
            return None
        perp = _unit(_cross((0.0, 0.0, 1.0), los_ric)) or (1.0, 0.0, 0.0)
        return tuple(r_hat[k] * perp[0] + i_hat[k] * perp[1] for k in range(3))


# Keep the last OEL result so the applied thrust history can be returned (read-only; the run itself is unchanged).
import sim.api as _oel_api  # noqa: E402
_LAST: dict = {}
_orig_run = _oel_api.SimulationSession.run


def _run_and_keep(self, *a, **k):
    res = _orig_run(self, *a, **k)
    _LAST["result"] = res
    return res


_oel_api.SimulationSession.run = _run_and_keep


def _thrust_ric(res, times):
    """Applied thrust acceleration (km/s^2) of each craft, rotated into the reference orbit's R/I axes, at `times`."""
    import numpy as np
    out = {}
    try:
        ts = np.asarray(res.time_s, dtype=float)
        ref = np.asarray(res.target_reference_orbit, dtype=float)
        for oid, acc in res.applied_thrust.items():
            a = np.asarray(acc, dtype=float)
            rows = []
            for t in times:
                k = int(min(len(ts) - 1, max(0, np.searchsorted(ts, t))))
                pos, vel = ref[k, :3], ref[k, 3:6]
                r_hat = pos / np.linalg.norm(pos)
                c_hat = np.cross(pos, vel); c_hat /= np.linalg.norm(c_hat)
                i_hat = np.cross(c_hat, r_hat)
                v = a[k] if k < len(a) else np.zeros(3)
                v = np.nan_to_num(v)
                rows.append([float(v @ r_hat), float(v @ i_hat)])
            out[str(oid)] = rows
    except Exception as exc:  # noqa: BLE001 - thrust is display-only, never fails a run
        out["error"] = str(exc)
    return out


# Swap the whitelisted class the scenarios name, in this process only (upstream files untouched).
_wg_scenarios.INTENT_PROVIDERS["CommonSenseEvader"] = (__name__, "PlanarEvader")

PORT = int(os.environ.get("ENGAGE_PORT", "8791"))
PKG_DATA = Path(sys.modules["wargame"].__file__).resolve().parent / "data"
CARD = PKG_DATA / "products" / "gg1.yaml"
FEATURED = {"defend_keepout": "Defend", "pursue_evader": "Pursue"}      # the web app's two featured engagements
OPEN_MIN_KM, OPEN_MAX_KM = 0.5, 20.0
SENSOR_UNLIMITED_KM = 1.0e6                                      # the web app's Start distance bounds
WORK = Path(tempfile.mkdtemp(prefix="table_engage_"))
LOCK = threading.Lock()
# shared control state: the laptop's control page writes it, the table page polls it (and posts its status back)
CONTROL = {"scenario": "defend_keepout",
           "ours": {"thrust": 1.0, "fuel": 5.0, "dry": 180.0, "isp": 220.0},
           "adv": {"thrust": 1.0, "fuel": 5.0, "dry": 180.0, "isp": 220.0},
           "time_s": 1800.0, "ring_km": None, "speed": 1.0, "start_seq": 0, "reset_seq": 0}
STATUS: dict = {}
CLOCK = threading.Lock()
CACHE: dict[tuple, dict] = {}


def _spec(variant) -> dict:
    """The web app's _spec_inputs at its defaults: four airframe fields + the sensor block."""
    return {
        "dry_mass_kg": float(variant.dry_mass_kg), "fuel_mass_kg": float(variant.fuel_mass_kg),
        "max_thrust_n": float(variant.max_thrust_n), "isp_s": float(variant.isp_s),
        # Table rule: no sensor restriction, both craft see each other at all times (range far past any placement).
        "sensor": {"max_range_km": SENSOR_UNLIMITED_KM, "require_line_of_sight": False},
    }


AIRFRAME = {"dry": ("dry_mass_kg", 50.0, 2000.0), "fuel": ("fuel_mass_kg", 0.0, 200.0),
            "thrust": ("max_thrust_n", 0.05, 50.0), "isp": ("isp_s", 100.0, 400.0)}   # the web app's _SPEC_BOUNDS


def _airframe(spec: dict, vals: dict | None) -> dict:
    """Table slider values (dry, fuel, thrust, isp) onto a web-app spec dict, clamped to the Lab's own bounds."""
    out = dict(spec)
    for k, (field, lo, hi) in AIRFRAME.items():
        if vals and vals.get(k) is not None:
            out[field] = min(hi, max(lo, float(vals[k])))
    return out


def _payload(scenario_id: str, r_km: float, i_km: float, run_dir: Path, ours: dict | None = None,
             adv: dict | None = None, ring_km: float | None = None, time_s: float | None = None) -> tuple[dict, dict]:
    library = scenario_library()
    descriptor, raw = load_scenario(library[scenario_id])
    card = load_product_card(CARD)
    base = card.variant("base")
    product = _airframe(_spec(base), ours)
    adversary = _airframe(_spec(base), adv)                   # the web app prefills the adversary as a mirror of base

    # opening: chaser relative to target, curvilinear RIC (km). Both craft start on CIRCULAR coplanar orbits, so the
    # chaser gets the circular-orbit drift rate for its radial offset (Hill: di/dt = -1.5 n R) instead of zero.
    state_path = "objects.chaser.initial_state.relative_to_target_ric.state"
    a_km = float(get_path_value(raw, "objects.target.initial_state.coes.a_km"))
    n = math.sqrt(MU_E / a_km ** 3)
    overrides = {f"{state_path}[0]": float(r_km), f"{state_path}[1]": float(i_km),
                 f"{state_path}[4]": -1.5 * n * float(r_km)}

    # the runner's two opening-sized rules, with the true distance
    opening = math.hypot(r_km, i_km)
    start_path = descriptor.start_range_path
    if start_path and descriptor.guidance_time_paths:
        authored = abs(float(get_path_value(raw, start_path)))
        if authored > 0:
            scale = (opening / authored) ** 0.5
            for p in descriptor.guidance_time_paths:
                overrides[p] = round(float(get_path_value(raw, p)) * scale, 3)
    meta = (raw.get("metadata") or {}).get("wargame") or {}
    # ring size: the Lab's keepout / capture tunable (criteria), with each craft's own doctrine distance scaled by the
    # same factor so the authored ratios hold (upstream moves only the criteria, which can hand out free wins)
    crit = meta.get("criteria") or {}
    ring_field = "keepout_radius_km" if "keepout_radius_km" in crit else "capture_range_km" if "capture_range_km" in crit else None
    if ring_km is not None and ring_field:
        ring = min(2.0, max(0.02, float(ring_km)))
        f = ring / float(crit[ring_field])
        overrides[f"metadata.wargame.criteria.{ring_field}"] = ring
        for key in ("product_intent_provider", "adversary_intent_provider"):
            params = ((meta.get(key) or {}).get("params") or {})
            for p in ("keepout_km", "capture_range_km"):
                if p in params:
                    overrides[f"metadata.wargame.{key}.params.{p}"] = float(params[p]) * f
    # engagement time: the Lab's survive / time-limit tunable. The runner already ties both craft's clocks to it and
    # extends the propagated window; per the tunable's own help ("the propagated window ... follow this number") the
    # window is also shortened here when the time is below the authored one.
    time_field = "survive_time_s" if "survive_time_s" in crit else "max_time_s" if "max_time_s" in crit else None
    if time_s is not None and time_field:
        tsec = float(min(23316.0, max(300.0, round(float(time_s)))))
        overrides[f"metadata.wargame.criteria.{time_field}"] = tsec
        dt = float((raw.get("simulator") or {}).get("dt_s", 1.0))
        overrides["simulator.duration_s"] = math.ceil(tsec / dt) * dt
    # each provider measures its own spend with its own Isp
    for key, spec in (("product_intent_provider", product), ("adversary_intent_provider", adversary)):
        if "isp_s" in ((meta.get(key) or {}).get("params") or {}):
            overrides[f"metadata.wargame.{key}.params.isp_s"] = float(spec["isp_s"])
    if start_path:
        for key in ("product_intent_provider", "adversary_intent_provider"):
            prov = meta.get(key)
            if isinstance(prov, dict) and str(prov.get("class")) == "CommonSenseEvader" and "react_range_km" in (prov.get("params") or {}):
                overrides[f"metadata.wargame.{key}.params.react_range_km"] = opening

    # same campaign the web app writes (_write_campaign), one run
    product_file = WORK / "product.yaml"
    product_file.write_text(yaml.safe_dump({"product": "GG-custom", "variants": {"custom": product}}))
    camp = {
        "campaign": "table", "product_file": str(product_file), "variants": ["custom"], "scenarios": [scenario_id],
        "seeds": [0], "sweeps": [], "seed_variation": [], "execution": {"workers": 1}, "output_dir": str(run_dir.parent),
        "adversary_spec": adversary, "overrides": overrides,
    }
    camp_file = WORK / "campaign.yaml"
    camp_file.write_text(yaml.safe_dump(camp))
    spec = expand_matrix(load_campaign(camp_file))[0]
    payload = _payload_from_spec(spec, "table", run_dir, plots=False)
    payload["descriptor"] = copy.deepcopy(payload["descriptor"])
    payload["descriptor"]["start_range_path"] = ""            # rules applied above with hypot(R, I)
    info = {"product_object_id": descriptor.product_object_id, "adversary_object_id": descriptor.adversary_object_id,
            "product_role": descriptor.product_role, "title": descriptor.title, "opening_km": opening, "overrides": overrides,
            "product_spec": product, "adversary_spec": adversary, "a_km": a_km, "n": n}
    return payload, info


def _num(x):
    try:
        v = float(x)
        return v if math.isfinite(v) else None
    except (TypeError, ValueError):
        return None


def run(scenario_id: str, r_km: float, i_km: float, ours: dict | None = None, adv: dict | None = None,
        ring_km: float | None = None, time_s: float | None = None) -> dict:
    opening = math.hypot(r_km, i_km)
    if opening < OPEN_MIN_KM or opening > OPEN_MAX_KM:
        f = min(max(opening, OPEN_MIN_KM), OPEN_MAX_KM) / max(opening, 1e-9)
        r_km, i_km = r_km * f, i_km * f                          # clamp to the web app's Start distance range
    key = (scenario_id, round(r_km, 3), round(i_km, 3), json.dumps(ours, sort_keys=True), json.dumps(adv, sort_keys=True),
           None if ring_km is None else round(float(ring_km), 4), None if time_s is None else round(float(time_s)))
    if key in CACHE:
        return CACHE[key]
    run_dir = WORK / "runs" / f"{scenario_id}_{int(time.time() * 1000)}"
    payload, info = _payload(scenario_id, r_km, i_km, run_dir, ours, adv, ring_km, time_s)
    t0 = time.time()
    record = execute_run(payload)
    wall = time.time() - t0
    ts = run_dir / "wargame_timeseries.csv"
    t, rng, cha, tgt, cs, tsx, pm, am = [], [], [], [], [], [], [], []
    if ts.exists():
        with ts.open() as h:
            for row in csv.DictReader(h):
                t.append(_num(row["time_s"])); rng.append(_num(row["range_km"]))
                cha.append([_num(row["cha_r_km"]), _num(row["cha_i_km"])]); tgt.append([_num(row["tgt_r_km"]), _num(row["tgt_i_km"])])
                cs.append(_num(row.get("cha_state_idx"))); tsx.append(_num(row.get("tgt_state_idx")))
                pm.append(_num(row.get("product_mass_kg"))); am.append(_num(row.get("adversary_mass_kg")))
    thr = _thrust_ric(_LAST.pop("result"), [x for x in t if x is not None]) if "result" in _LAST else {}
    crit = record.get("rules", {}).get("criteria") or record.get("criteria") or {}
    out = {
        "scenario": scenario_id, "title": info["title"], "verdict": record.get("verdict"), "reasons": record.get("reasons"),
        "record": {k: v for k, v in record.items() if k not in ("paths",)},
        "roles": {"product": info["product_object_id"], "adversary": info["adversary_object_id"], "product_role": info["product_role"]},
        "opening_km": [r_km, i_km], "overrides": info["overrides"],
        "t": t, "range": rng, "cha": cha, "tgt": tgt, "cha_state": cs, "tgt_state": tsx, "product_mass": pm, "adversary_mass": am,
        "criteria": crit, "wall_s": round(wall, 2), "a_km": info["a_km"], "n": info["n"], "planar": True,
        "thrust_cha": thr.get("chaser"), "thrust_tgt": thr.get("target"),
        "product_spec": info["product_spec"], "adversary_spec": info["adversary_spec"],
    }
    CACHE[key] = out
    return out


class H(BaseHTTPRequestHandler):
    def _send(self, code: int, obj) -> None:
        body = json.dumps(obj, default=str).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):  # noqa: N802
        if self.path.startswith("/health"):
            return self._send(200, {"ok": True})
        if self.path.startswith("/control"):
            with CLOCK:
                return self._send(200, {**CONTROL, "status": STATUS})
        if self.path.startswith("/scenarios"):
            lib = scenario_library()
            items = []
            for sid in sorted(lib):
                d, _ = load_scenario(lib[sid])
                items.append({"id": sid, "title": d.title, "product_role": d.product_role, "featured": FEATURED.get(sid)})
            return self._send(200, {"featured": FEATURED, "scenarios": items})
        self._send(404, {"error": "not found"})

    def do_POST(self):  # noqa: N802
        if self.path.startswith("/control") or self.path.startswith("/status"):
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                with CLOCK:
                    if self.path.startswith("/status"):
                        STATUS.clear(); STATUS.update(body); STATUS["at"] = time.time()
                    else:
                        for k in ("scenario", "time_s", "ring_km", "speed"):
                            if k in body:
                                CONTROL[k] = body[k]
                        for side in ("ours", "adv"):
                            if isinstance(body.get(side), dict):
                                CONTROL[side].update({k: float(v) for k, v in body[side].items() if k in CONTROL[side]})
                        if body.get("start"):
                            CONTROL["start_seq"] += 1
                        if body.get("reset"):
                            CONTROL["reset_seq"] += 1
                    out = {**CONTROL, "status": STATUS}
                return self._send(200, out)
            except Exception as exc:  # noqa: BLE001
                return self._send(400, {"error": str(exc)})
        if not self.path.startswith("/run"):
            return self._send(404, {"error": "not found"})
        try:
            req = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
            sid = str(req.get("scenario") or "defend_keepout")
            with LOCK:                                    # one engagement at a time (laptop heat; the sim is ~2-5 s)
                out = run(sid, float(req["r_km"]), float(req["i_km"]), req.get("ours"), req.get("adv"), req.get("ring_km"),
                          req.get("time_s"))
            self._send(200, out)
        except Exception as exc:  # noqa: BLE001
            self._send(500, {"error": f"{type(exc).__name__}: {exc}"})

    def log_message(self, fmt, *args):  # quiet
        sys.stderr.write("[engage] " + (fmt % args) + "\n")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        for sid, (r, i) in (("defend_keepout", (0.0, -1.2)), ("pursue_evader", (0.0, -1.2))):
            o = run(sid, r, i)
            print(sid, o["verdict"], o["reasons"], "rows", len(o["t"]), "wall", o["wall_s"], "s")
        sys.exit(0)
    print(f"engage server on http://localhost:{PORT}  (work dir {WORK})", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
