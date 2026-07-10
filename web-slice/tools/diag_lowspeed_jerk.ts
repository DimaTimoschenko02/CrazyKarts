// Diagnostic (2026-07-10, owner playtest "дёрганье на малых скоростях") —
// NOT a test, NO fixes. Reproduces kart.ts's per-tick wiring (steer/throttle
// slew -> ContinuousDrift.update -> BicyclePhysics.step -> yaw integration)
// outside three.js on flat ground for a "дёрганый пятачок" scenario: rapid
// 0.4-0.7s WASD combos at 2-6 m/s, matching the owner's video telemetry
// (speed 2.0-5.9, drift engage 0.46-0.97 at driftIntensity 0.02-0.05, omega
// jumping -0.45 -> -0.78 -> +1.13 rad/s).
//
// Questions under diagnosis:
//   Q1 dominant source of per-tick omega jumps at low speed:
//        drift yawBonus/exit boost? front tire force on steer flip?
//        kinematicOmegaRate=10 filter? something else?
//      -> per-tick Δomega is DECOMPOSED exactly (kinematic pull vs dynamic
//         torque vs damping vs drift-grip-loss counterfactual), residual
//         asserted ~0.
//   Q2 why engageFactor reaches 0.5-0.97 at 2-5 m/s — what speed gate?
//   Q3 top-10 |Δomega|/tick with full input/contribution context.
//   Q4 same scenario re-run with kinematicOmegaRate = 10 / 5 / 2.5.
//
// Run: npx tsx tools/diag_lowspeed_jerk.ts

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
  // visual chain (kart.ts step 11 + driftVisualYaw) — pure functions of
  // logged state, replicated so the OBSERVED body wobble is measurable too.
  visualDriftAngle: number;
}

function makeSim(overrides: Partial<KartPhysicsParams> = {}): Sim {
  const params = { ...DEFAULT_KART_PHYSICS_PARAMS, ...overrides };
  return {
    params,
    bicycle: new BicyclePhysics(params, DEFAULT_AXLE_GEOMETRY),
    drift: new ContinuousDrift(params),
    yaw: 0,
    vel: { x: 0, y: 0, z: 0 },
    throttleSm: 0,
    steerSm: 0,
    driftPenaltySlow: 0,
    visualDriftAngle: 0,
  };
}

interface Row {
  t: number;
  label: string; // which key combo is held
  rawSteer: number;
  rawThrottle: number;
  steerSm: number;
  throttleSm: number;
  speed: number; // hypot — what ContinuousDrift's speedGate actually reads
  fwdSpeed: number; // post-step
  sideSpeed: number;
  omegaDeg: number; // post-step bicycle omega, deg/s
  dOmegaDeg: number; // omegaPost - omegaPre this tick, deg/s
  // exact decomposition of dOmega (deg/s per tick), sums to dOmegaDeg:
  cKinDeg: number; //   (1-blend) * kinAlpha * (kinematicOmega - omegaPre)
  cTorqueDeg: number; //   blend * torque/moi * dt * exp(-damp*dt)  (front+rear tire torque)
  cDampDeg: number; //   blend * omegaPre * (exp(-damp*dt) - 1)
  cDriftGripDeg: number; //   part of cTorque caused by rearGripMult<1 (counterfactual mult=1)
  residual: number; // reconstruction error (should be ~0)
  kinematicBlend: number;
  kinematicOmegaDeg: number; // raw kinematic target
  steerAngleDeg: number;
  // drift outputs
  engageFactor: number;
  dFast: number;
  speedGate: number;
  steerGate: number;
  throttleGate: number;
  yawBonusDeg: number; // added to yaw DIRECTLY (not via omega), deg/s
  exitBoost: number; // longitudinal force
  fwdAssist: number;
  rearGripMult: number;
  driftIntensity: number;
  // what the player actually sees turning: physical omega + yawBonus,
  // plus the purely visual body-yaw offset on top
  bodyYawRateDeg: number; // omega + yawBonus, deg/s
  visualOffsetDeg: number; // visualDriftAngle + driftVisualYaw, deg
}

function tick(sim: Sim, t: number, label: string, rawSteer: number, rawThrottle: number): Row {
  const p = sim.params;

  // kart.ts input slew (incl. steerSm snap-to-zero at <0.01).
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

  // ── Pre-step reconstruction of bicyclePhysics.ts steps B..G with the SAME
  // pre-step state step() is about to consume, for the exact decomposition.
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
  const fFront = -p.frontGripStiffness * Math.tanh(vWheelLatFront / sat) * sat;
  const rearGripEff = p.rearGripStiffness * Math.max(drift.rearGripMultiplier, 0);
  const fRearTotal = 2 * -rearGripEff * Math.tanh(vLatRear / sat) * sat;
  // Counterfactual: same tick, rearGripMultiplier forced to 1 (no drift grip loss).
  const fRearNoDrift = 2 * -p.rearGripStiffness * Math.tanh(vLatRear / sat) * sat;
  const torque = (fRearTotal - fFront) * halfWb;
  const torqueNoDrift = (fRearNoDrift - fFront) * halfWb;
  const moi = p.mass * halfWb * halfWb * Math.max(p.inertiaScale, 0.01);
  const dampMul = Math.exp(-p.omegaDamping * DT);
  const kinematicOmega = (fwdSpeedPre / DEFAULT_AXLE_GEOMETRY.wheelbase) * Math.tan(steerAngle);
  const kinAlpha = 1 - Math.exp(-p.kinematicOmegaRate * DT);
  const kinematicBlend = smoothstep(p.kinematicBlendLoSpeed, p.kinematicBlendHiSpeed, Math.abs(fwdSpeedPre));

  // Decomposition of (omegaPost - omegaPre):
  //   omegaPost = (1-b)*lerp(omegaPre, kinOmega, kinAlpha) + b*(omegaPre + torque/moi*dt)*dampMul
  const cKin = (1 - kinematicBlend) * kinAlpha * (kinematicOmega - omegaPre);
  const cTorque = kinematicBlend * (torque / Math.max(moi, 0.001)) * DT * dampMul;
  const cDamp = kinematicBlend * omegaPre * (dampMul - 1);
  const cDriftGrip = kinematicBlend * ((torque - torqueNoDrift) / Math.max(moi, 0.001)) * DT * dampMul;

  // ── The real step, wired exactly like kart.ts update().
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

  // Visual chain (kart.ts updateSkidAndTelemetry step 11 + syncVisual).
  const omegaNorm = clamp(st.omega / Math.max(p.omegaLeanScale, 0.01), -1, 1);
  const targetLean = ((st.driftIntensity * p.visualDriftMaxDeg * -omegaNorm) * Math.PI) / 180;
  const leanAlpha = 1 - Math.exp(-p.visualLeanRecoverySpeed * DT);
  sim.visualDriftAngle += (targetLean - sim.visualDriftAngle) * leanAlpha;
  const visualOffset = sim.visualDriftAngle + drift.visualYawOffsetRad;

  const dOmega = st.omega - omegaPre;
  // gates as ContinuousDrift computed them this tick (same formulas/params):
  const steerGate = smoothstep(p.driftSteerGateLo, p.driftSteerGateHi, Math.abs(sim.steerSm));
  const speedGate = smoothstep(p.driftSpeedGateLo, p.driftSpeedGateHi, Math.abs(speed));
  const throttleGate = smoothstep(0, Math.max(p.driftThrottleGate, 1e-4), sim.throttleSm);

  return {
    t,
    label,
    rawSteer,
    rawThrottle,
    steerSm: sim.steerSm,
    throttleSm: sim.throttleSm,
    speed,
    fwdSpeed: st.fwdSpeed,
    sideSpeed: st.sideSpeed,
    omegaDeg: st.omega * RAD2DEG,
    dOmegaDeg: dOmega * RAD2DEG,
    cKinDeg: cKin * RAD2DEG,
    cTorqueDeg: cTorque * RAD2DEG,
    cDampDeg: cDamp * RAD2DEG,
    cDriftGripDeg: cDriftGrip * RAD2DEG,
    residual: (dOmega - (cKin + cTorque + cDamp)) * RAD2DEG,
    kinematicBlend,
    kinematicOmegaDeg: kinematicOmega * RAD2DEG,
    steerAngleDeg: steerAngle * RAD2DEG,
    engageFactor: drift.engageFactor,
    dFast: sim.drift.getDFast(),
    speedGate,
    steerGate,
    throttleGate,
    yawBonusDeg: drift.yawBonusRadPerSec * RAD2DEG,
    exitBoost: drift.exitBoostForce,
    fwdAssist: drift.forwardAssistForce,
    rearGripMult: drift.rearGripMultiplier,
    driftIntensity: st.driftIntensity,
    bodyYawRateDeg: (st.omega + drift.yawBonusRadPerSec) * RAD2DEG,
    visualOffsetDeg: visualOffset * RAD2DEG,
  };
}

interface Phase {
  label: string;
  seconds: number;
  steer: number;
  throttle: number;
}

// "Дёрганый пятачок" — rapid combos as in the owner's video. Convention as
// in diag_reverse_flick.ts: D = steer -1, A = steer +1, W = thr +1, S = thr -1.
// Short W lead-in gets speed into the 2-6 m/s corridor first.
// Durations tuned so hypot speed lives in the 2-6 m/s corridor (throttle
// slew 2/s + accelForce 17 climb fast; brake+reverse dump speed fast, so W
// phases are short and S phases shorter still).
const JERK_PHASES: Phase[] = [
  { label: "W    ", seconds: 0.55, steer: 0, throttle: 1 }, // lead-in to ~3 m/s
  { label: "W+D  ", seconds: 0.5, steer: -1, throttle: 1 },
  { label: "A    ", seconds: 0.5, steer: 1, throttle: 0 },
  { label: "S+A  ", seconds: 0.4, steer: 1, throttle: -1 },
  { label: "W    ", seconds: 0.4, steer: 0, throttle: 1 },
  { label: "W+A  ", seconds: 0.5, steer: 1, throttle: 1 },
  { label: "D+S  ", seconds: 0.4, steer: -1, throttle: -1 },
  { label: "W+D  ", seconds: 0.5, steer: -1, throttle: 1 },
  // second lap of the same fidgeting for more samples
  { label: "A    ", seconds: 0.4, steer: 1, throttle: 0 },
  { label: "W+A  ", seconds: 0.5, steer: 1, throttle: 1 },
  { label: "S+D  ", seconds: 0.4, steer: -1, throttle: -1 },
  { label: "W+D  ", seconds: 0.6, steer: -1, throttle: 1 },
  { label: "W+A  ", seconds: 0.5, steer: 1, throttle: 1 },
];

function runScenario(phases: Phase[], overrides: Partial<KartPhysicsParams> = {}): Row[] {
  const sim = makeSim(overrides);
  const rows: Row[] = [];
  let t = 0;
  for (const ph of phases) {
    const n = Math.round(ph.seconds * 120);
    for (let i = 0; i < n; i++) {
      rows.push(tick(sim, t, ph.label, ph.steer, ph.throttle));
      t += DT;
    }
  }
  return rows;
}

function fmt(x: number, w = 7, d = 3) {
  return x.toFixed(d).padStart(w);
}

// ── Run main scenario ────────────────────────────────────────────────────────
const rows = runScenario(JERK_PHASES);

// sanity: decomposition must reconstruct dOmega exactly
const maxResidual = rows.reduce((m, r) => Math.max(m, Math.abs(r.residual)), 0);

console.log("================ diag_lowspeed_jerk — дёрганый пятачок, flat ground, 120 Hz ================");
console.log(`decomposition residual check: max |dOmega - (kin+torque+damp)| = ${maxResidual.toExponential(2)} deg/s (must be ~0)\n`);

// Speed corridor check
const afterLeadIn = rows.filter((r) => r.t > 0.9);
const spMin = afterLeadIn.reduce((m, r) => Math.min(m, r.speed), 1e9);
const spMax = afterLeadIn.reduce((m, r) => Math.max(m, r.speed), 0);
const spMean = afterLeadIn.reduce((s, r) => s + r.speed, 0) / afterLeadIn.length;
console.log(`[corridor] speed after lead-in: min=${spMin.toFixed(2)} mean=${spMean.toFixed(2)} max=${spMax.toFixed(2)} m/s (target 2-6)\n`);

// ── Q2: speed gate / engage at low speed ────────────────────────────────────
const p = DEFAULT_KART_PHYSICS_PARAMS;
console.log("[Q2] ContinuousDrift gates (driftContinuous.ts step 1):");
console.log(`  speedGate = smoothstep(driftSpeedGateLo=${p.driftSpeedGateLo}, driftSpeedGateHi=${p.driftSpeedGateHi}, |speed|)  <- HYPOT speed (fwd+side), not fwdSpeed`);
console.log(`  steerGate = smoothstep(${p.driftSteerGateLo}, ${p.driftSteerGateHi}, |steerSm|), throttleGate = smoothstep(0, ${p.driftThrottleGate}, throttleSm)`);
console.log(`  driftMinSpeed=${p.driftMinSpeed} gates ONLY bicycle's driftIntensity (measured slip), NOT ContinuousDrift.`);
console.log("  engage vs speed bands (this run):");
for (const [lo, hi] of [[1.5, 2.5], [2.5, 3.5], [3.5, 4.5], [4.5, 6.0]] as const) {
  const band = rows.filter((r) => r.speed >= lo && r.speed < hi);
  if (!band.length) continue;
  const eMax = band.reduce((m, r) => Math.max(m, r.engageFactor), 0);
  const eMean = band.reduce((s, r) => s + r.engageFactor, 0) / band.length;
  const gMean = band.reduce((s, r) => s + r.speedGate, 0) / band.length;
  const iMax = band.reduce((m, r) => Math.max(m, r.driftIntensity), 0);
  console.log(
    `    speed ${lo}-${hi} m/s (${String(band.length).padStart(4)} ticks): engage mean=${eMean.toFixed(2)} max=${eMax.toFixed(2)}, speedGate mean=${gMean.toFixed(2)}, driftIntensity max=${iMax.toFixed(3)}`
  );
}

// ── Q3: top-10 |Δomega| ticks with context ──────────────────────────────────
const ranked = [...rows].sort((a, b) => Math.abs(b.dOmegaDeg) - Math.abs(a.dOmegaDeg));
// de-dupe: keep at most one entry per 0.15s cluster so the table shows 10
// distinct EVENTS, not 10 neighbouring ticks of the same spike
const top: Row[] = [];
for (const r of ranked) {
  if (top.every((x) => Math.abs(x.t - r.t) > 0.15)) top.push(r);
  if (top.length >= 10) break;
}
top.sort((a, b) => Math.abs(b.dOmegaDeg) - Math.abs(a.dOmegaDeg));
console.log("\n[Q3] top-10 |Δomega|/tick events (deg/s per 1/120s tick), decomposed:");
console.log(
  "     t    keys   raw(st,th) steerSm  speed  fwdSpd | dOm°/t | kin部 torq部 damp部 (driftGrip部) | blend kinOm°/s om°/s | engage yawBon°/s grip"
);
for (const r of top) {
  console.log(
    `${r.t.toFixed(3).padStart(7)}  ${r.label} (${r.rawSteer >= 0 ? "+" : ""}${r.rawSteer},${r.rawThrottle >= 0 ? "+" : ""}${r.rawThrottle}) ${fmt(r.steerSm, 7, 2)} ${fmt(r.speed, 6, 2)} ${fmt(r.fwdSpeed, 6, 2)} |` +
      ` ${fmt(r.dOmegaDeg, 6, 2)} | ${fmt(r.cKinDeg, 6, 2)} ${fmt(r.cTorqueDeg, 6, 2)} ${fmt(r.cDampDeg, 6, 2)} (${fmt(r.cDriftGripDeg, 6, 2)}) |` +
      ` ${fmt(r.kinematicBlend, 5, 2)} ${fmt(r.kinematicOmegaDeg, 7, 1)} ${fmt(r.omegaDeg, 7, 1)} | ${fmt(r.engageFactor, 5, 2)} ${fmt(r.yawBonusDeg, 7, 2)} ${fmt(r.rearGripMult, 5, 2)}`
  );
}

// aggregate attribution over ALL high-jerk ticks (|dOmega| >= half of peak)
const peak = Math.abs(ranked[0].dOmegaDeg);
const hi = rows.filter((r) => Math.abs(r.dOmegaDeg) >= peak * 0.5);
const sumAbs = (sel: (r: Row) => number) => hi.reduce((s, r) => s + Math.abs(sel(r)), 0);
const sKin = sumAbs((r) => r.cKinDeg);
const sTor = sumAbs((r) => r.cTorqueDeg);
const sDmp = sumAbs((r) => r.cDampDeg);
const sDft = sumAbs((r) => r.cDriftGripDeg);
const sTot = sKin + sTor + sDmp;
console.log(`\n  attribution over the ${hi.length} worst ticks (|Δω| >= 50% of peak ${peak.toFixed(2)}°/s-per-tick):`);
console.log(
  `    kinematic pull ${(100 * sKin / sTot).toFixed(0)}%  |  tire torque ${(100 * sTor / sTot).toFixed(0)}% (of which drift-grip-loss share ${(100 * sDft / sTot).toFixed(0)}%)  |  damping ${(100 * sDmp / sTot).toFixed(0)}%`
);

// yawBonus / exit boost magnitudes for Q1
const maxYawBonus = rows.reduce((m, r) => Math.max(m, Math.abs(r.yawBonusDeg)), 0);
const maxDYawBonus = rows.reduce((m, r, i) => (i > 0 ? Math.max(m, Math.abs(r.yawBonusDeg - rows[i - 1].yawBonusDeg)) : m), 0);
const maxBoost = rows.reduce((m, r) => Math.max(m, r.exitBoost), 0);
const maxAssist = rows.reduce((m, r) => Math.max(m, r.fwdAssist), 0);
console.log(`\n[Q1-aux] drift DIRECT outputs over whole run:`);
console.log(`  |yawBonus| max = ${maxYawBonus.toFixed(2)} deg/s (added straight to yaw), max per-tick change ${maxDYawBonus.toFixed(3)} deg/s`);
console.log(`  exitBoost max = ${maxBoost.toFixed(2)} N-equiv (longitudinal), forwardAssist max = ${maxAssist.toFixed(2)} (param=${p.driftForwardAssist})`);
const minGrip = rows.reduce((m, r) => Math.min(m, r.rearGripMult), 1);
console.log(`  rearGripMult min = ${minGrip.toFixed(3)} (param floor driftRearGripMult=${p.driftRearGripMult}, gripFloor=${p.driftGripFloor})`);

// visible body wobble (what the video shows): omega + yawBonus + visual offset
let maxDBody = 0, maxDBodyT = 0;
let maxDVis = 0, maxDVisT = 0;
for (let i = 1; i < rows.length; i++) {
  const db = Math.abs(rows[i].bodyYawRateDeg - rows[i - 1].bodyYawRateDeg);
  if (db > maxDBody) { maxDBody = db; maxDBodyT = rows[i].t; }
  const dv = Math.abs(rows[i].visualOffsetDeg - rows[i - 1].visualOffsetDeg);
  if (dv > maxDVis) { maxDVis = dv; maxDVisT = rows[i].t; }
}
console.log(`  body yaw RATE (omega+yawBonus) max per-tick change: ${maxDBody.toFixed(2)} deg/s at t=${maxDBodyT.toFixed(3)}`);
console.log(`  visual body-yaw OFFSET (lean + driftVisualYaw, max ±${p.driftVisualOffsetDeg}° from dFast) max per-tick change: ${maxDVis.toFixed(3)} deg at t=${maxDVisT.toFixed(3)}`);
const visMin = rows.reduce((m, r) => Math.min(m, r.visualOffsetDeg), 0);
const visMax = rows.reduce((m, r) => Math.max(m, r.visualOffsetDeg), 0);
console.log(`  visual offset range over run: ${visMin.toFixed(1)}..${visMax.toFixed(1)} deg`);

// ── Trace around the single worst event ─────────────────────────────────────
const worstT = ranked[0].t;
console.log(`\n[trace] ±0.35s around worst Δomega event (t=${worstT.toFixed(3)}s), every 3rd tick:`);
console.log(
  "     t    keys  steerSm  thrSm  speed  fwdSpd sideSpd |  om°/s  dOm°/t kinOm°/s blend | engage dFast spdGate yawBon°/s grip | visOff°"
);
let k = 0;
for (const r of rows) {
  if (r.t < worstT - 0.35 || r.t > worstT + 0.35) continue;
  if (k++ % 3 !== 0) continue;
  console.log(
    `${r.t.toFixed(3).padStart(7)}  ${r.label} ${fmt(r.steerSm, 6, 2)} ${fmt(r.throttleSm, 6, 2)} ${fmt(r.speed, 6, 2)} ${fmt(r.fwdSpeed, 6, 2)} ${fmt(r.sideSpeed, 7, 2)} |` +
      ` ${fmt(r.omegaDeg, 7, 1)} ${fmt(r.dOmegaDeg, 6, 2)} ${fmt(r.kinematicOmegaDeg, 7, 1)} ${fmt(r.kinematicBlend, 5, 2)} |` +
      ` ${fmt(r.engageFactor, 5, 2)} ${fmt(r.dFast, 5, 2)} ${fmt(r.speedGate, 5, 2)} ${fmt(r.yawBonusDeg, 7, 2)} ${fmt(r.rearGripMult, 5, 2)} | ${fmt(r.visualOffsetDeg, 6, 1)}`
  );
}

// ── Q4: kinematicOmegaRate sweep 10 / 5 / 2.5 ───────────────────────────────
console.log("\n[Q4] kinematicOmegaRate sweep (same scenario):");
console.log("  rate | max|Δω|/tick | p99|Δω|/tick | max|ω| °/s | max|Δ bodyYawRate|/tick | sum|Δω| (total 'зубцы')");
for (const rate of [10, 5, 2.5]) {
  const rr = runScenario(JERK_PHASES, { kinematicOmegaRate: rate });
  const dabs = rr.map((r) => Math.abs(r.dOmegaDeg)).sort((a, b) => a - b);
  const mx = dabs[dabs.length - 1];
  const p99 = dabs[Math.floor(dabs.length * 0.99)];
  const mo = rr.reduce((m, r) => Math.max(m, Math.abs(r.omegaDeg)), 0);
  let mdb = 0;
  for (let i = 1; i < rr.length; i++) mdb = Math.max(mdb, Math.abs(rr[i].bodyYawRateDeg - rr[i - 1].bodyYawRateDeg));
  const sum = rr.reduce((s, r) => s + Math.abs(r.dOmegaDeg), 0);
  console.log(
    `  ${String(rate).padStart(4)} | ${fmt(mx, 12, 3)} | ${fmt(p99, 12, 3)} | ${fmt(mo, 10, 1)} | ${fmt(mdb, 23, 3)} | ${fmt(sum, 10, 1)}`
  );
}
