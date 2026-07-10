// Diagnostic (2026-07-10, owner playtest "reverse flick" bug) — NOT a test,
// NO fixes. Reproduces kart.ts's per-tick wiring (steer/throttle slew ->
// ContinuousDrift.update -> BicyclePhysics.step -> yaw integration) outside
// three.js on flat ground, for the exact reported input sequence:
//
//   2.5 s  throttle=+1 steer=-1   (W+D: forward cruise, turning)
//   3.0 s  throttle=-1 steer=+1   (A+S slammed: opposite steer + reverse)
//
// Symptom: "резко дергается корпус не в ту сторону, резко делается поворот".
// Hypotheses under test:
//   H1 kinematicOmega sign flip when fwdSpeed crosses 0 with steer held
//   H2 reverseGate ramps reverseSteerGain in already at fwdSpeed<+0.5
//   H3 ContinuousDrift intensity spike on the steer flip
//   H4 anything else discontinuous around the switch
// Plus a "smooth" comparison run with a 1.5 s coast inserted between phases.
//
// Run: npx tsx tools/diag_reverse_flick.ts

import { BicyclePhysics } from "../src/physics/bicyclePhysics";
import { ContinuousDrift } from "../src/physics/driftContinuous";
import { DEFAULT_KART_PHYSICS_PARAMS, DEFAULT_AXLE_GEOMETRY } from "../src/physics/types";
import type { KartPhysicsParams, PhysicsInput } from "../src/physics/types";

const DT = 1 / 120;
const RAD2DEG = 180 / Math.PI;

function forwardOf(y: number) {
  return { x: -Math.sin(y), z: -Math.cos(y) };
}
function rightOf(y: number) {
  return { x: Math.cos(y), z: -Math.sin(y) };
}
function clamp(x: number, lo: number, hi: number) {
  return Math.min(Math.max(x, lo), hi);
}
function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}
function smoothstep(lo: number, hi: number, x: number) {
  if (lo === hi) return x < lo ? 0 : 1;
  const t = clamp((x - lo) / (hi - lo), 0, 1);
  return t * t * (3 - 2 * t);
}

interface Sim {
  params: KartPhysicsParams;
  bicycle: BicyclePhysics;
  drift: ContinuousDrift;
  yaw: number;
  vel: { x: number; y: number; z: number };
  throttleSm: number;
  steerSm: number;
  driftPenaltySlow: number;
}

function makeSim(): Sim {
  const params = { ...DEFAULT_KART_PHYSICS_PARAMS };
  return {
    params,
    bicycle: new BicyclePhysics(params, DEFAULT_AXLE_GEOMETRY),
    drift: new ContinuousDrift(params),
    yaw: 0,
    vel: { x: 0, y: 0, z: 0 },
    throttleSm: 0,
    steerSm: 0,
    driftPenaltySlow: 0,
  };
}

interface Row {
  t: number;
  rawSteer: number;
  rawThrottle: number;
  steerSm: number;
  throttleSm: number;
  fwdSpeed: number; // post-step (as PhysicsState reports)
  sideSpeed: number;
  omegaDeg: number; // post-step blended omega, deg/s
  yawDeg: number; // accumulated body yaw, deg
  // Pre-step reconstruction of internal step B/F/G quantities (formulas
  // duplicated from bicyclePhysics.ts on purpose — diagnostic only):
  reverseGate: number;
  reverseSteerMult: number;
  steerAngleDeg: number; // effective, WITH reverseSteerMult
  kinematicBlend: number;
  kinematicOmegaDeg: number;
  omegaDynamicDeg: number; // torque-integrated omega BEFORE the blend
  driftIntensity: number; // bicycle's measured-slip signal (post-step)
  engageFactor: number; // ContinuousDrift |dFast|
  dFast: number;
  yawBonusDeg: number; // drift.yawBonusRadPerSec in deg/s
  rearGripMult: number;
}

// One physics substep wired exactly like kart.ts update() (flat ground,
// always grounded), identical to tools/diagnose_reverse.ts tick() but with
// the internal-quantity reconstruction added.
function tick(sim: Sim, t: number, rawSteer: number, rawThrottle: number): Row {
  const p = sim.params;

  // kart.ts step: input slew (incl. the steerSm snap-to-zero at <0.01).
  const slew = Math.abs(rawSteer) > Math.abs(sim.steerSm) ? p.steerSlewRateIn : p.steerSlewRateOut;
  sim.steerSm += (rawSteer - sim.steerSm) * (1 - Math.exp(-slew * DT));
  if (Math.abs(sim.steerSm) < 0.01 && Math.abs(rawSteer) < 0.01) sim.steerSm = 0;
  sim.throttleSm += (rawThrottle - sim.throttleSm) * (1 - Math.exp(-p.throttleSlewRate * DT));

  const fwdDir = forwardOf(sim.yaw);
  const rightDir = rightOf(sim.yaw);
  const speed = Math.hypot(sim.vel.x, sim.vel.z);
  const fwdSpeedPre = sim.vel.x * fwdDir.x + sim.vel.z * fwdDir.z;
  const sideSpeedPre = sim.vel.x * rightDir.x + sim.vel.z * rightDir.z;

  const drift = sim.drift.update(speed, sim.steerSm, true, sim.throttleSm, DT);

  const penaltyAlpha = 1 - Math.exp(-(1 / Math.max(p.driftPenaltyTau, 0.05)) * DT);
  sim.driftPenaltySlow += (sim.bicycle.getDriftIntensity() - sim.driftPenaltySlow) * penaltyAlpha;

  // ── Pre-step reconstruction of bicyclePhysics.ts internals (steps B/E/F/G)
  // using the SAME pre-step state the real step() is about to consume.
  const omegaPre = sim.bicycle.getOmega();
  const maxAngleRad = (p.maxSteerAngleDeg * Math.PI) / 180;
  const spdRatio = clamp(Math.abs(fwdSpeedPre) / Math.max(p.maxSpeed, 0.01), 0, 1);
  const steerMult = lerp(p.steerLowSpeedMult, p.steerHighSpeedMult, spdRatio);
  const reverseGate = smoothstep(-1.5, -0.3, fwdSpeedPre);
  const reverseSteerMult = lerp(p.reverseSteerGain, 1, reverseGate);
  const steerAngle = sim.steerSm * maxAngleRad * steerMult * reverseSteerMult;
  const halfWb = DEFAULT_AXLE_GEOMETRY.wheelbase * 0.5;
  const vLatFront = sideSpeedPre - omegaPre * halfWb;
  const vLatRear = sideSpeedPre + omegaPre * halfWb;
  const vWheelLatFront = vLatFront * Math.cos(steerAngle) + fwdSpeedPre * Math.sin(steerAngle);
  const sat = Math.max(p.tireSaturationSpeed, 0.1);
  const rearGripEff = p.rearGripStiffness * Math.max(drift.rearGripMultiplier, 0);
  const fFront = -p.frontGripStiffness * Math.tanh(vWheelLatFront / sat) * sat;
  const fRearTotal = 2 * -rearGripEff * Math.tanh(vLatRear / sat) * sat;
  const torque = (fRearTotal - fFront) * halfWb;
  const moi = p.mass * halfWb * halfWb * Math.max(p.inertiaScale, 0.01);
  const omegaDynamic = (omegaPre + (torque / Math.max(moi, 0.001)) * DT) * Math.exp(-p.omegaDamping * DT);
  const kinematicOmega = (fwdSpeedPre / DEFAULT_AXLE_GEOMETRY.wheelbase) * Math.tan(steerAngle);
  const kinAlpha = 1 - Math.exp(-p.kinematicOmegaRate * DT);
  const omegaKinFiltered = lerp(omegaPre, kinematicOmega, kinAlpha);
  const kinematicBlend = smoothstep(p.kinematicBlendLoSpeed, p.kinematicBlendHiSpeed, Math.abs(fwdSpeedPre));

  const inp: PhysicsInput = {
    velocity: { ...sim.vel },
    forward: { x: fwdDir.x, y: 0, z: fwdDir.z },
    right: { x: rightDir.x, y: 0, z: rightDir.z },
    throttle: sim.throttleSm,
    steerInput: sim.steerSm,
    brakeHeld: rawThrottle < 0,
    onFloor: true,
    rearGripMultiplier: drift.rearGripMultiplier,
    driftPenaltyFactor: sim.driftPenaltySlow,
    groundSlopeRad: 0,
  };
  const st = sim.bicycle.step(inp, DT);
  sim.yaw += st.yawDelta + drift.yawBonusRadPerSec * DT;
  sim.vel.x = st.newVelocity.x;
  sim.vel.z = st.newVelocity.z;

  const assist = drift.forwardAssistForce + drift.exitBoostForce;
  if (Math.abs(assist) > 0 && fwdSpeedPre >= 0) {
    const fwdAfter = forwardOf(sim.yaw);
    sim.vel.x += fwdAfter.x * assist * DT;
    sim.vel.z += fwdAfter.z * assist * DT;
  }

  return {
    t,
    rawSteer,
    rawThrottle,
    steerSm: sim.steerSm,
    throttleSm: sim.throttleSm,
    fwdSpeed: st.fwdSpeed,
    sideSpeed: st.sideSpeed,
    omegaDeg: st.omega * RAD2DEG,
    yawDeg: sim.yaw * RAD2DEG,
    reverseGate,
    reverseSteerMult,
    steerAngleDeg: steerAngle * RAD2DEG,
    kinematicBlend,
    kinematicOmegaDeg: kinematicOmega * RAD2DEG,
    omegaDynamicDeg: omegaDynamic * RAD2DEG,
    driftIntensity: st.driftIntensity,
    engageFactor: drift.engageFactor,
    dFast: sim.drift.getDFast(),
    yawBonusDeg: drift.yawBonusRadPerSec * RAD2DEG,
    rearGripMult: drift.rearGripMultiplier,
  };
}

interface Phase {
  seconds: number;
  steer: number;
  throttle: number;
}

function runScenario(phases: Phase[]): Row[] {
  const sim = makeSim();
  const rows: Row[] = [];
  let t = 0;
  for (const ph of phases) {
    const n = Math.round(ph.seconds * 120);
    for (let i = 0; i < n; i++) {
      rows.push(tick(sim, t, ph.steer, ph.throttle));
      t += DT;
    }
  }
  return rows;
}

function fmt(x: number, w = 7, d = 3) {
  return x.toFixed(d).padStart(w);
}

function printWindow(rows: Row[], tFrom: number, tTo: number, every = 2, note = "") {
  console.log(
    `\n--- trace ${tFrom.toFixed(2)}s..${tTo.toFixed(2)}s (every ${every} ticks) ${note} ---`
  );
  console.log(
    "    t     raw(st,th)  steerSm  fwdSpd  sideSpd  omega°/s  kinOm°/s  dynOm°/s  kinBlend  revGate  revMult  steerAng°  driftInt  engage  yawBon°/s   yaw°"
  );
  let i = 0;
  for (const r of rows) {
    if (r.t < tFrom - 1e-9 || r.t > tTo + 1e-9) continue;
    if (i++ % every !== 0) continue;
    console.log(
      `${r.t.toFixed(3).padStart(7)}  (${r.rawSteer >= 0 ? "+" : ""}${r.rawSteer},${r.rawThrottle >= 0 ? "+" : ""}${r.rawThrottle})  ` +
        `${fmt(r.steerSm, 7)} ${fmt(r.fwdSpeed, 7)} ${fmt(r.sideSpeed, 8)} ${fmt(r.omegaDeg, 9, 2)} ${fmt(r.kinematicOmegaDeg, 9, 2)} ${fmt(r.omegaDynamicDeg, 9, 2)} ` +
        `${fmt(r.kinematicBlend, 9)} ${fmt(r.reverseGate, 8)} ${fmt(r.reverseSteerMult, 8)} ${fmt(r.steerAngleDeg, 9, 2)} ` +
        `${fmt(r.driftIntensity, 9)} ${fmt(r.engageFactor, 7)} ${fmt(r.yawBonusDeg, 9, 2)} ${fmt(r.yawDeg, 8, 1)}`
    );
  }
}

// ── Scenario A: the reported flick ──────────────────────────────────────────
const SWITCH_T = 2.5;
const flickRows = runScenario([
  { seconds: SWITCH_T, steer: -1, throttle: 1 },
  { seconds: 3.0, steer: 1, throttle: -1 },
]);

// ── Scenario B: with 1.5s coast in between ──────────────────────────────────
const coastRows = runScenario([
  { seconds: SWITCH_T, steer: -1, throttle: 1 },
  { seconds: 1.5, steer: 0, throttle: 0 },
  { seconds: 3.0, steer: 1, throttle: -1 },
]);

// ── Analysis helpers ─────────────────────────────────────────────────────────

function analyze(label: string, rows: Row[], switchT: number) {
  console.log(`\n\n================ ${label} ================`);

  // Event times
  const zeroCross = rows.find((r) => r.t > switchT && r.fwdSpeed < 0);
  const tZero = zeroCross ? zeroCross.t : NaN;
  console.log(`switch at t=${switchT.toFixed(2)}s; fwdSpeed crosses 0 at t=${isNaN(tZero) ? "never" : tZero.toFixed(3) + "s"}`);

  printWindow(rows, switchT - 0.2, switchT + 0.5, 2, "(around input switch)");
  if (!isNaN(tZero)) printWindow(rows, tZero - 0.15, tZero + 0.4, 2, "(around fwdSpeed=0 crossing)");
  printWindow(rows, switchT + 0.5, Math.min(switchT + 3.0, rows[rows.length - 1].t), 24, "(settling, sparse)");

  // H1: omega behavior around fwdSpeed=0
  console.log(`\n[H1] omega around fwdSpeed=0 crossing:`);
  if (!isNaN(tZero)) {
    const before = rows.filter((r) => r.t >= tZero - 0.25 && r.t < tZero);
    const after = rows.filter((r) => r.t > tZero && r.t <= tZero + 0.25);
    const omBefore = before[0];
    const omAt = rows.find((r) => r.t >= tZero)!;
    const omAfter = after[after.length - 1];
    console.log(
      `  omega: t-0.25s=${omBefore.omegaDeg.toFixed(2)}°/s -> at-cross=${omAt.omegaDeg.toFixed(2)}°/s -> t+0.25s=${omAfter.omegaDeg.toFixed(2)}°/s`
    );
    console.log(
      `  kinematicOmega: t-0.25s=${omBefore.kinematicOmegaDeg.toFixed(2)}°/s -> at-cross=${omAt.kinematicOmegaDeg.toFixed(2)}°/s -> t+0.25s=${omAfter.kinematicOmegaDeg.toFixed(2)}°/s`
    );
    // max per-tick omega step in +-0.5s window
    let maxStep = 0,
      maxStepT = 0;
    const win = rows.filter((r) => r.t >= tZero - 0.5 && r.t <= tZero + 0.5);
    for (let i = 1; i < win.length; i++) {
      const d = Math.abs(win[i].omegaDeg - win[i - 1].omegaDeg);
      if (d > maxStep) {
        maxStep = d;
        maxStepT = win[i].t;
      }
    }
    console.log(`  max per-tick |Δomega| in ±0.5s of crossing: ${maxStep.toFixed(3)}°/s per tick (=${(maxStep * 120).toFixed(1)}°/s² eq) at t=${maxStepT.toFixed(3)}s`);
    // sign flips of omega in window
    const signFlips = win.filter((r, i) => i > 0 && Math.sign(r.omegaDeg) !== Math.sign(win[i - 1].omegaDeg) && Math.abs(r.omegaDeg) > 0.5);
    console.log(`  omega sign flips (|omega|>0.5°/s) in window: ${signFlips.map((r) => `t=${r.t.toFixed(3)} -> ${r.omegaDeg.toFixed(1)}°/s`).join("; ") || "none"}`);
  } else {
    console.log("  fwdSpeed never crossed 0 — H1 n/a");
  }

  // H2: effective steer angle growth in fwdSpeed window +0.5 -> -1.0
  console.log(`\n[H2] effective steerAngle vs reverseGate (fwdSpeed +0.5 -> -1.0 window):`);
  const h2rows = rows.filter((r) => r.t > switchT && r.fwdSpeed <= 0.5 && r.fwdSpeed >= -1.0);
  if (h2rows.length) {
    const first = h2rows[0];
    const last = h2rows[h2rows.length - 1];
    console.log(
      `  window t=${first.t.toFixed(3)}..${last.t.toFixed(3)}s (${h2rows.length} ticks): steerAngle ${first.steerAngleDeg.toFixed(2)}° -> ${last.steerAngleDeg.toFixed(2)}° (x${(last.steerAngleDeg / (first.steerAngleDeg || 1e-9)).toFixed(2)}), revMult ${first.reverseSteerMult.toFixed(2)} -> ${last.reverseSteerMult.toFixed(2)}`
    );
    // Also: what is steerAngle at fwdSpeed=+0.5 vs what it would be without reverseSteerMult
    for (const probe of [0.5, 0.25, 0.0, -0.5, -1.0]) {
      const r = rows.find((rr) => rr.t > switchT && rr.fwdSpeed <= probe);
      if (r)
        console.log(
          `  fwdSpeed<=${probe.toFixed(2).padStart(5)}: t=${r.t.toFixed(3)} steerSm=${r.steerSm.toFixed(3)} revGate=${r.reverseGate.toFixed(3)} revMult=${r.reverseSteerMult.toFixed(3)} steerAngle=${r.steerAngleDeg.toFixed(2)}° (без revMult было бы ${(r.steerAngleDeg / r.reverseSteerMult).toFixed(2)}°)`
        );
    }
  } else console.log("  window empty");

  // H3: drift intensity / engage spike in first 0.3s after flip
  console.log(`\n[H3] drift signals in first 0.3s after switch:`);
  const h3 = rows.filter((r) => r.t >= switchT && r.t <= switchT + 0.3);
  const preFlip = rows.filter((r) => r.t >= switchT - 0.1 && r.t < switchT);
  const peakInt = h3.reduce((m, r) => Math.max(m, r.driftIntensity), 0);
  const peakEng = h3.reduce((m, r) => Math.max(m, r.engageFactor), 0);
  const minGrip = h3.reduce((m, r) => Math.min(m, r.rearGripMult), 1);
  console.log(
    `  pre-switch: driftIntensity=${preFlip[0]?.driftIntensity.toFixed(3)} engage=${preFlip[0]?.engageFactor.toFixed(3)} dFast=${preFlip[0]?.dFast.toFixed(3)}`
  );
  console.log(`  post-switch 0.3s: peak driftIntensity=${peakInt.toFixed(3)}, peak engageFactor=${peakEng.toFixed(3)}, min rearGripMult=${minGrip.toFixed(3)}`);
  const peakYawBonus = h3.reduce((m, r) => (Math.abs(r.yawBonusDeg) > Math.abs(m) ? r.yawBonusDeg : m), 0);
  console.log(`  peak |yawBonus| in window: ${peakYawBonus.toFixed(2)}°/s`);

  // H4: discontinuities — max per-tick deltas over the whole post-switch 1.5s
  console.log(`\n[H4] max per-tick deltas in switch..+1.5s:`);
  const h4 = rows.filter((r) => r.t >= switchT && r.t <= switchT + 1.5);
  const maxD = (sel: (r: Row) => number) => {
    let m = 0,
      mt = 0;
    for (let i = 1; i < h4.length; i++) {
      const d = Math.abs(sel(h4[i]) - sel(h4[i - 1]));
      if (d > m) {
        m = d;
        mt = h4[i].t;
      }
    }
    return { m, mt };
  };
  const dOm = maxD((r) => r.omegaDeg);
  const dSide = maxD((r) => r.sideSpeed);
  const dFwd = maxD((r) => r.fwdSpeed);
  const dSteer = maxD((r) => r.steerAngleDeg);
  console.log(`  |Δomega|/tick     max ${dOm.m.toFixed(3)}°/s at t=${dOm.mt.toFixed(3)}`);
  console.log(`  |ΔsideSpeed|/tick max ${dSide.m.toFixed(4)} m/s at t=${dSide.mt.toFixed(3)}`);
  console.log(`  |ΔfwdSpeed|/tick  max ${dFwd.m.toFixed(4)} m/s at t=${dFwd.mt.toFixed(3)}`);
  console.log(`  |ΔsteerAngle|/tick max ${dSteer.m.toFixed(3)}° at t=${dSteer.mt.toFixed(3)}`);

  // Yaw overshoot summary: yaw direction before vs after
  const preYawRate = rows.filter((r) => r.t >= switchT - 0.2 && r.t < switchT).reduce((s, r) => s + r.omegaDeg, 0) / 24;
  const peakOppositeOmega = h4.reduce((m, r) => (r.omegaDeg * Math.sign(preYawRate) < m ? r.omegaDeg * Math.sign(preYawRate) : m), 0);
  console.log(
    `  mean omega pre-switch: ${preYawRate.toFixed(1)}°/s; strongest OPPOSITE-sign omega within 1.5s: ${(peakOppositeOmega * Math.sign(preYawRate)).toFixed(1)}°/s (relative to pre-switch turn direction)`
  );
}

analyze("SCENARIO A: instant flick W+D -> A+S at t=2.5s", flickRows, SWITCH_T);
analyze("SCENARIO B: W+D -> 1.5s coast -> A+S (switch to A+S at t=4.0s)", coastRows, SWITCH_T + 1.5);

// Extra: for scenario B also show the coast phase itself
printWindow(coastRows, SWITCH_T - 0.1, SWITCH_T + 1.5, 12, "(SCENARIO B coast phase, sparse)");
