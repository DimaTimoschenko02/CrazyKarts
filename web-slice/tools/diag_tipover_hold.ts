// Diagnostic (2026-07-10): isolated validation of computeTipOverTarget's
// filtered output over TIME at a FIXED, controlled overhang fraction —
// companion to diag_attitude_trace.ts's full drive-simulation, used
// specifically for the design brief's S1/S2 "held stationary at a given
// overhang %" scenarios.
//
// WHY ISOLATED (not routed through the full heightfield + stepVertical
// pipeline like diag_attitude_trace.ts's "hold" mode): this codebase's
// heightfield is a coarse, 2-level-per-cell STEP function with no
// interpolation (.claude/rules/map-building.md) — a single ground probe can
// only ever read "on the plateau" or "on the lower floor", never a
// continuous in-between height. That makes it structurally impossible to
// position a kart at a stable, literal "50% hang, still grounded" XZ
// position on a REAL multi-meter cliff: the CENTER probe crossing the edge
// is a single discrete step from "fully supported" to "clearly not", and
// physics/vertical.ts's own (pre-existing, out of this fix's scope) D2
// detach check fires within 0-1 ticks of that same crossing — there is no
// multi-second "hovering, still grounded, tipping over" window available at
// the heightfield level to hold position b/c) tests against. This script
// instead exercises computeTipOverTarget directly against a literal,
// hand-built GroundProbes set with the CENTER probe's drop set to an exact
// FRACTION of the edge band (25%/50% of attitudeCliffDropLimit) — a direct,
// controlled analogue of "how far over the physical edge" that sidesteps the
// discrete-heightfield limitation while still exercising the REAL math
// (computeTipOverTarget, the same two-rate exp filter kart.ts step 8d runs).
//
// Run: npx tsx tools/diag_tipover_hold.ts <fractionOfEdgeBand> <ticks>
//   e.g. 0.0 (front-only, center fully grounded, S1's "~25% overhang") or
//        0.5 (center half-crossed, S2's "~40-50% overhang, held")
import { computeTipOverTarget } from "../src/kart/attitude";
import type { GroundProbes } from "../src/kart/groundProbe";
import { DEFAULT_KART_PHYSICS_PARAMS } from "../src/physics/types";

const P = DEFAULT_KART_PHYSICS_PARAMS;
const DT = 1 / 120;
const centerFrac = Number(process.argv[2] ?? 0);
const ticks = Number(process.argv[3] ?? 240);

const edgeBand = P.attitudeCliffDropLimit;
const supportHeight = 0.0;
// Front probe always fully hanging (past the edge, matching every S1/S2/S3
// scenario in the brief — the nose is always the side hanging). Center
// probe's OWN drop is `centerFrac * edgeBand` below supportHeight — 0 =
// center still exactly at support height (S1's "front only" case), 1 =
// center itself fully past the edge band (on the verge of losing support
// entirely, S2's far end).
const probes: GroundProbes = {
  center: supportHeight - centerFrac * edgeBand,
  hF: supportHeight - 10, // deep in the "fully hanging" regime, matches driving well past the lip
  hB: supportHeight, // rear axle still solidly on the plateau (design brief's scenarios never have the tail hanging)
  hR: supportHeight,
  hL: supportHeight,
};

const maxTipAngle = (P.attitudeTipOverMaxAngleDeg * Math.PI) / 180;
const target = computeTipOverTarget(probes, supportHeight, edgeBand, maxTipAngle);
const deg = (r: number) => (r * 180) / Math.PI;

console.log(`centerFrac=${centerFrac} target.pitch=${deg(target.pitch).toFixed(2)}deg target.roll=${deg(target.roll).toFixed(2)}deg`);

let pitchTipSm = 0;
let prev = 0;
let maxAbs = 0;
let maxStep = 0;
for (let t = 0; t < ticks; t++) {
  const alpha = 1 - Math.exp(-P.attitudeTipOverRate * DT);
  pitchTipSm += (target.pitch - pitchTipSm) * alpha;
  const d = deg(pitchTipSm);
  maxAbs = Math.max(maxAbs, Math.abs(d));
  if (t > 0) maxStep = Math.max(maxStep, Math.abs(d - prev));
  if (t % 12 === 0 || t === ticks - 1) console.log(`t=${t} (${(t * DT).toFixed(2)}s) pitchTipSm=${d.toFixed(3)}deg`);
  prev = d;
}
console.log(`\nSUMMARY: maxAbsPitchDeg=${maxAbs.toFixed(3)} maxTickStepDeg=${maxStep.toFixed(4)} finalPitchDeg=${prev.toFixed(3)}`);
