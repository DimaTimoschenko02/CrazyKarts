// One-off: why did driftReleaseComposition's total-variation ratio jump from
// ~1.1 to 1.61 after driftSpeedGateLo/Hi moved 1.5/3 -> 4/7? Prints the
// visible-offset trace and speed during the release window so the
// non-monotonicity source is visible directly. Run: npx tsx tools/diag_release_variation.ts
import { BicyclePhysics } from "../src/physics/bicyclePhysics";
import { ContinuousDrift } from "../src/physics/driftContinuous";
import { DEFAULT_AXLE_GEOMETRY, DEFAULT_KART_PHYSICS_PARAMS, type PhysicsInput } from "../src/physics/types";

const DT = 1 / 60;
const params = DEFAULT_KART_PHYSICS_PARAMS;

function forwardOf(yaw: number) {
  return { x: -Math.sin(yaw), z: -Math.cos(yaw) };
}
function rightOf(yaw: number) {
  return { x: Math.cos(yaw), z: -Math.sin(yaw) };
}

const bicycle = new BicyclePhysics(params, DEFAULT_AXLE_GEOMETRY);
const drift = new ContinuousDrift(params);
let yaw = 0;
const vel = { x: 0, y: 0, z: 0 };
let throttleSm = 0;
let steerSm = 0;
let visualDriftAngle = 0;
let driftPenaltySlow = 0;

function tick(rawSteer: number, rawThrottle: number) {
  const slew = Math.abs(rawSteer) > Math.abs(steerSm) ? params.steerSlewRateIn : params.steerSlewRateOut;
  steerSm += (rawSteer - steerSm) * (1 - Math.exp(-slew * DT));
  throttleSm += (rawThrottle - throttleSm) * (1 - Math.exp(-params.throttleSlewRate * DT));
  const fwdDir = forwardOf(yaw);
  const rightDir = rightOf(yaw);
  const speed = Math.hypot(vel.x, vel.z);
  const out = drift.update(speed, steerSm, true, throttleSm, DT);
  const penaltyAlpha = 1 - Math.exp(-(1 / Math.max(params.driftPenaltyTau, 0.05)) * DT);
  driftPenaltySlow += (bicycle.getDriftIntensity() - driftPenaltySlow) * penaltyAlpha;
  const inp: PhysicsInput = {
    velocity: { ...vel },
    forward: { x: fwdDir.x, y: 0, z: fwdDir.z },
    right: { x: rightDir.x, y: 0, z: rightDir.z },
    throttle: throttleSm,
    steerInput: steerSm,
    brakeHeld: rawThrottle < 0,
    onFloor: true,
    rearGripMultiplier: out.rearGripMultiplier,
    driftPenaltyFactor: driftPenaltySlow,
    groundSlopeRad: 0,
  };
  const st = bicycle.step(inp, DT);
  yaw += st.yawDelta + out.yawBonusRadPerSec * DT;
  vel.x = st.newVelocity.x;
  vel.z = st.newVelocity.z;
  const omegaNorm = Math.min(Math.max(st.omega / Math.max(params.omegaLeanScale, 0.01), -1), 1);
  const targetLean = ((st.driftIntensity * params.visualDriftMaxDeg * -omegaNorm) * Math.PI) / 180;
  visualDriftAngle += (targetLean - visualDriftAngle) * (1 - Math.exp(-params.visualLeanRecoverySpeed * DT));
  return {
    speed,
    engage: out.engageFactor,
    visOffDeg: (out.visualYawOffsetRad * 180) / Math.PI,
    leanDeg: (visualDriftAngle * 180) / Math.PI,
    combined: ((out.visualYawOffsetRad + visualDriftAngle) * 180) / Math.PI,
  };
}

for (let i = 0; i < 90; i++) tick(0, 1);
for (let i = 0; i < 60; i++) tick(1, 1);
console.log("t_rel  speed  engage  visOff  lean  combined  d(combined)");
let prev: number | null = null;
for (let i = 0; i < 60; i++) {
  const r = tick(0, 1);
  const d = prev === null ? 0 : r.combined - prev;
  prev = r.combined;
  if (i % 2 === 0)
    console.log(
      `${(i * DT).toFixed(3)}  ${r.speed.toFixed(2)}  ${r.engage.toFixed(3)}  ${r.visOffDeg.toFixed(2)}  ${r.leanDeg.toFixed(2)}  ${r.combined.toFixed(3)}  ${d.toFixed(4)}`
    );
}
