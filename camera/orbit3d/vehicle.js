// vehicle.js — the ONE set of vehicle / propulsion numbers. LEO TO GEO, LEO TO DRO, COMPETITOR and CAPTURE all read this file,
// so the same trip shows the same DELTA-V, propellant and time in every mode. Edit here. No DOM; imported by orbits-geo.js,
// capture-geo.js and modes.js (and the node tests).
//
// Choice of values (a general at the table will compare the modes):
//  - Seldon Isp 1000 s: orbits-geo.js and DESIGN.md already used it; NIGHT-AGENTS.md's "~1500 s" is only a brief. PLACEHOLDER
//    until the real thruster is known. The mission files (data/mission_dro*.json, tools/spiral_mission.py) carry no Isp.
//  - Seldon thrust 50 mN: from orbits-geo.js (PROP_MODES ET). PLACEHOLDER. The trip time is propellant / mass flow
//    (mdot = F / (g0 Isp)), so time, fuel and DELTA-V stay consistent. This replaces spiral_mission.py's 0.5 mm/s2 acceleration
//    (a placeholder too, and not tied to a mass: it would be 0.18 N on a 360 kg craft, a 1.5 kW thruster) which gave 106 days.
//  - Dry mass 200 kg: orbits-geo.js VEH. PLACEHOLDER. Propellant is the rocket equation on the dry mass,
//    dry * (exp(dv / ve) - 1), for ours and for the tug (same payload to deliver); 325 kg is only the size of the full tank (owner, Oct 27; was 160)
//    (dvMax). The old geo numbers used the wet mass (135 kg); the old competitor numbers the dry mass (120 kg): dry mass wins.
//  - Typical chemical tug Isp 320 s: the brief (generic bipropellant). Burns are impulsive, trip time is the Hohmann half period.
//  - DRO radius 36,000 km: the table's default DRO (modes.js GD.droKm); data/mission_dro.json's is a 70,000 km far side.
//    The DRO DELTA-V is computed (circular LEO -> Earth-Moon distance, then the lunar capture), not read from the mission file
//    (6.70 km/s, 155 d: a stylized Edelbaum spiral), so the DRO mode and the competitor agree.
export const G0 = 9.80665;
export const SELDON = { name: 'SELDON · ELECTRIC', isp: 1000, thrust: .05, dry: 200, prop: 325 };   // thrust N; masses kg
export const TUG = { name: 'TYPICAL CHEMICAL TUG', isp: 320 };
export const DRO_KM = 36000;
// Our chemical thruster pulses (owner, Oct 26): 25 m/s a burn, at most one every 12 hours (its gas tanks refill in between). So a
// chemical trip is a run of small burns: its time is the burns x 12 h (LEO -> GEO ~78 days, not a Hohmann's 5 hours), and it is drawn
// as loops too, fewer than electric's (orbits-geo.js LOOPS). The DELTA-V and propellant are the impulsive ones, as before.
export const CHEM_PULSE = { dv: 25, every: 12 * 3600 };   // m/s a burn; s from one burn to the next
export const pulseTime = dvKms => Math.ceil(dvKms * 1000 / CHEM_PULSE.dv - 1e-9) * CHEM_PULSE.every;

const MU_E = 398600.4418, MU_M = 4902.8, D_EM = 384400, R_SOI = D_EM * (MU_M / MU_E) ** .4;
const vc = (mu, r) => Math.sqrt(mu / r);

// rocket equation for the payload (dry mass) a craft delivers
export const propFor = (isp, dvKms, dry = SELDON.dry) => dry * (Math.exp(dvKms * 1000 / (G0 * isp)) - 1);
// low-thrust trip time (s): burning that propellant at the engine's mass flow
export const burnTime = (mp, e = SELDON) => mp / (e.thrust / (G0 * e.isp));
// km/s a full tank gives
export const dvMax = (e = SELDON) => G0 * e.isp * Math.log((e.dry + e.prop) / e.dry) / 1000;

const hoh = (mu, r1, r2) => { const a = (r1 + r2) / 2; return { v1t: Math.sqrt(mu * (2 / r1 - 1 / a)), v2t: Math.sqrt(mu * (2 / r2 - 1 / a)), tof: Math.PI * Math.sqrt(a ** 3 / mu) }; };
const hypBurn = (mu, r, vinf) => Math.sqrt(vinf * vinf + 2 * mu / r) - vc(mu, r);
// Earth orbit r0 (km) -> circular lunar orbit rM (km): Hohmann out + hyperbolic capture (chemical) / spiral out + spiral in (electric)
export function lunarDv(r0, rM) {
  const h = hoh(MU_E, r0, D_EM), vinf = Math.abs(vc(MU_E, D_EM) - h.v2t);
  return { gt: Math.abs(h.v1t - vc(MU_E, r0)) + hypBurn(MU_M, rM, vinf), gtTof: h.tof,
           et: Math.abs(vc(MU_E, r0) - vc(MU_E, D_EM)) + (vc(MU_M, rM) - vc(MU_M, R_SOI)) };
}
