// Diagnostic (2026-07-10, updated for the "клюёт носом на скорости" tip-over
// fix): per-tick trace of the body-attitude pipeline (sampleGroundProbes ->
// excludeGroundProbesForAttitude + computeAttitudeTarget (fast, grounded
// slope-follow) ADDED to computeTipOverTarget (slow, "see-saw over the
// edge") -> two independent exp filters, summed) while driving off a cliff
// edge or hanging over one at low/zero speed, using the REAL modules —
// mirrors kart/kart.ts step 8b-vertical/8d exactly (including the
// leadingProbeHeight D2 gate) so this reproduces on-screen behavior 1:1.
//
// Run: npx tsx tools/diag_attitude_trace.ts [x z yawDeg speed ticks]
// Run: npx tsx tools/diag_attitude_trace.ts scanline <x> <zFrom> <zTo>
// Run: npx tsx tools/diag_attitude_trace.ts hold <x> <z> <yawDeg> <holdTicks> [creepSpeed]
//   ("hold" mode: creep forward at `creepSpeed` (default 0.6 m/s) from
//   50 cells behind (x,z) along yaw, THEN hold XZ fixed once (x,z) is
//   reached for `holdTicks` extra ticks — used to reproduce a kart parked
//   with part of its footprint hanging over an edge, per the design brief's
//   S1/S2 scenarios which are about dwell TIME at a fixed overhang, not a
//   moving crossing.)
//
// --synth flag (any position in argv): swap the loaded map for an in-memory
// synthetic one instead of public/maps/roads_v1.json — a clean 5m-tall
// plateau (z<0, h=5.0) dropping straight to a canyon floor (z>=0, h=0.0)
// along a long, dead-straight edge at z=0. roads_v1.json's real cliffs
// turned out to all be either single-cell bumps or full map-edge voids (no
// clean multi-cell "plateau then a real lower floor" edge to drive off of)
// — this gives full control over approach speed/overhang fraction for the
// S1/S2/S3 acceptance scenarios in the design brief, matching the same
// map-authoring conventions (.claude/rules/map-building.md: tile_size=1,
// level_height=0.5) as the real maps.
import { readFileSync } from "fs";
import { Heightfield, type MapJson } from "../src/shared/heightfield";
import { sampleGroundProbes, wallAwareGroundHeight, excludeGroundProbesForAttitude } from "../src/kart/groundProbe";
import { computeAttitudeTarget, computeTipOverTarget, LEVEL } from "../src/kart/attitude";
import { createVerticalState, stepVertical, type VerticalState } from "../src/physics/vertical";
import { DEFAULT_KART_PHYSICS_PARAMS, COLLISION_AXLE_GEOMETRY } from "../src/physics/types";

const P = DEFAULT_KART_PHYSICS_PARAMS;
const AXLE = COLLISION_AXLE_GEOMETRY;
const DT = 1 / 120;

const synthIdx = process.argv.indexOf("--synth");
const useSynth = synthIdx !== -1;
if (useSynth) process.argv.splice(synthIdx, 1);

// Drop magnitude picked to match the scale of the REAL cliffs this map
// system actually authors (roads_v1.json's own biggest sudden single-row
// step, found via tools/scan_grid.ts, is ~1.05m) rather than an arbitrary
// large canyon — a multi-meter sheer drop is unrepresentative of how this
// game's terrain is built (map-building.md: flat "terrain" tiles at
// different y_level, always in modest per-cell steps) and disproportionately
// exercises an unrelated, PRE-EXISTING landing-reattach gap in
// physics/vertical.ts's OWN landing check (out of this fix's scope — see
// the trace's own SUMMARY output / this tool's run log for the discovery:
// stepVertical's landing branch checks the RAW wall-aware groundHeight, not
// the leading-probe-aware height the D2 detach gate already uses, so a kart
// that's detached via the front+center leading-probe gate can immediately
// "fake-land" back onto a still-elevated REAR probe's reading for the ~0.9m/
// speed seconds it takes the rear probe to also clear the lip — flagged to
// lead-programmer/vertical.ts owner, NOT fixed here per this task's scope).
const map: MapJson = useSynth
  ? {
      meta: { tile_size: 1, level_height: 0.5, origin_offset: [0, 0, 0] },
      rect_fills: [
        { asset: "terrain", x_min: -25, x_max: 25, z_min: -25, z_max: -1, y_level: 2 }, // plateau, h=1.0
        { asset: "terrain", x_min: -25, x_max: 25, z_min: 0, z_max: 25, y_level: 0 }, // canyon floor, h=0.0
      ],
    }
  : (JSON.parse(readFileSync("public/maps/roads_v1.json", "utf8")) as MapJson);
const hf = Heightfield.fromMapJson(map);

// ── Find a cliff edge along a line (helper mode) ─────────────────────────
if (process.argv[2] === "scanline") {
  const x = Number(process.argv[3]);
  for (let z = Number(process.argv[4]); z >= Number(process.argv[5]); z -= 1) {
    console.log(`z=${z.toFixed(1)} h=${hf.sample(x, z)}`);
  }
  process.exit(0);
}

const holdMode = process.argv[2] === "hold";
const argBase = holdMode ? 3 : 2;

const targetX = Number(process.argv[argBase] ?? 34.5);
const targetZ = Number(process.argv[argBase + 1] ?? 16.5);
const yaw = (Number(process.argv[argBase + 2] ?? 0) * Math.PI) / 180; // 0 = heading -Z
const holdTicks = holdMode ? Number(process.argv[argBase + 3] ?? 240) : 0;
const creepSpeed = holdMode ? Number(process.argv[argBase + 4] ?? 0.6) : 0;
const speed = holdMode ? creepSpeed : Number(process.argv[argBase + 3] ?? 7);
const driveTicks = holdMode ? 999999 : Number(process.argv[argBase + 4] ?? 300); // hold mode: drive until target reached, capped below

const fwd = { x: -Math.sin(yaw), z: -Math.cos(yaw) };
const right = { x: Math.cos(yaw), z: -Math.sin(yaw) };

// hold mode starts 3m behind the target point along -fwd, then creeps in.
const startX = holdMode ? targetX - fwd.x * 3 : targetX;
const startZ = holdMode ? targetZ - fwd.z * 3 : targetZ;

const y0 = hf.sample(startX, startZ) ?? hf.sample(targetX, targetZ);
if (y0 === null) { console.log("start off-map"); process.exit(1); }

let x = startX, z = startZ;
let vertical: VerticalState = createVerticalState(y0);
let pitchGroundSm = 0, rollGroundSm = 0;
let pitchTipSm = 0, rollTipSm = 0;
let prevPitchSm = 0;
let maxAbsPitchDeg = 0;
let maxTickStepDeg = 0;
let reachedTarget = false;
let holdCounter = 0;

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

const distToTarget = () => Math.hypot(targetX - x, targetZ - z);
const maxTicks = holdMode ? 2000 : driveTicks;

for (let t = 0; t < maxTicks; t++) {
  const yRef = vertical.y;

  if (holdMode) {
    if (!reachedTarget && distToTarget() > 0.02) {
      x += fwd.x * speed * DT;
      z += fwd.z * speed * DT;
      if (distToTarget() <= 0.02) { x = targetX; z = targetZ; reachedTarget = true; }
    } else {
      reachedTarget = true;
      holdCounter++;
      if (holdCounter > holdTicks) break;
    }
  } else {
    x += fwd.x * speed * DT;
    z += fwd.z * speed * DT;
  }

  const probes = sampleGroundProbes(
    (px, pz) => hf.sampleAt(px, pz, yRef, P.layerClimbThreshold),
    x, z, fwd, right, AXLE.wheelbase * 0.5, AXLE.trackWidth * 0.5
  );
  const gMax = wallAwareGroundHeight(probes, yRef, P.layerClimbThreshold);
  const detachRef = probes.center ?? gMax;
  const effSpeed = holdMode && reachedTarget ? 0 : speed;
  const leadingProbe = effSpeed >= 0 ? probes.hF : probes.hB;
  vertical = stepVertical(
    vertical,
    { groundHeight: gMax, detachRefHeight: detachRef, leadingProbeHeight: leadingProbe, dt: DT },
    {
      gravity: P.verticalGravity,
      groundFollowRate: P.verticalGroundFollowRate,
      airborneDropThreshold: P.verticalAirborneDropThreshold,
      landingMargin: P.verticalLandingMargin,
      groundSnapDistance: P.groundSnapDistance,
    }
  );

  // Mirror kart.ts step 8d exactly: two additive, independently-filtered targets.
  const groundedTarget = vertical.airborne
    ? LEVEL
    : computeAttitudeTarget(excludeGroundProbesForAttitude(probes, P.attitudeCliffDropLimit), AXLE.wheelbase * 0.5, AXLE.trackWidth * 0.5);
  const tipOverTarget = vertical.airborne
    ? LEVEL
    : computeTipOverTarget(probes, gMax, P.attitudeCliffDropLimit, rad(P.attitudeTipOverMaxAngleDeg));

  const groundRate = vertical.airborne ? P.attitudeAirborneRelaxRate : P.attitudeFollowRate;
  const tipRate = vertical.airborne ? P.attitudeAirborneRelaxRate : P.attitudeTipOverRate;
  const groundAlpha = 1 - Math.exp(-groundRate * DT);
  const tipAlpha = 1 - Math.exp(-tipRate * DT);
  pitchGroundSm += (groundedTarget.pitch - pitchGroundSm) * groundAlpha;
  rollGroundSm += (groundedTarget.roll - rollGroundSm) * groundAlpha;
  pitchTipSm += (tipOverTarget.pitch - pitchTipSm) * tipAlpha;
  rollTipSm += (tipOverTarget.roll - rollTipSm) * tipAlpha;
  const pitchSm = pitchGroundSm + pitchTipSm;

  maxAbsPitchDeg = Math.max(maxAbsPitchDeg, Math.abs(deg(pitchSm)));
  const tickStepDeg = Math.abs(deg(pitchSm) - deg(prevPitchSm));
  if (t > 0) maxTickStepDeg = Math.max(maxTickStepDeg, tickStepDeg);

  const jump = tickStepDeg > 1.5 && t > 0;
  if (t % 6 === 0 || jump || vertical.airborne) {
    const pr = (h: number | null) => (h === null ? "null" : h.toFixed(2));
    console.log(
      `t=${t} z=${z.toFixed(2)} y=${vertical.y.toFixed(2)} air=${vertical.airborne ? 1 : 0} hold=${reachedTarget ? 1 : 0} ` +
      `probes[C=${pr(probes.center)} F=${pr(probes.hF)} B=${pr(probes.hB)}] ` +
      `pitchGround=${deg(pitchGroundSm).toFixed(1)}° pitchTip=${deg(pitchTipSm).toFixed(1)}° pitchSm=${deg(pitchSm).toFixed(1)}°${jump ? "  <<< TICK STEP >1.5deg" : ""}`
    );
  }
  prevPitchSm = pitchSm;
}

console.log(`\nSUMMARY: maxAbsPitchDeg=${maxAbsPitchDeg.toFixed(2)} maxTickStepDeg=${maxTickStepDeg.toFixed(3)} finalPitchSm=${deg(pitchGroundSm + pitchTipSm).toFixed(2)}`);
