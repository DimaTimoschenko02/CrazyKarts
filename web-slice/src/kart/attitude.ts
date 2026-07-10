// Body attitude (pitch/roll) from the heightfield — shared by the local kart
// (kart.ts, physics-driven) and remote karts (net/remoteKarts.ts, computed
// purely from the network-synced XZ/yaw + the SAME local map, no extra wire
// data needed). Pure math, no THREE Object3D — callers own their own
// exp-filter state and apply .pitch/.roll to rotation.x/.z themselves.
//
// Sign convention verified against THREE's Euler "YXZ" composition (rotation
// order: Z, then X, then Y — see kart.ts syncVisual): a positive rotation.x
// tips the -Z-pointing nose UP in world space regardless of yaw, and a
// positive rotation.z tips the +X ("right") side UP regardless of yaw. Both
// targets below are built so "the ground is higher on side X" maps directly
// to "that side of the body sits higher" — i.e. the body follows the
// terrain, exactly like it already does vertically (kart.ts groundY).
//
// P3 (design/notes/collision-v2.md §4): this now takes an ALREADY-SAMPLED
// GroundProbes set (kart/groundProbe.ts) instead of re-sampling the
// heightfield itself — the same center+F/B/R/L probe set also feeds the
// I3 max-height ground-follow (kart.ts step 8b), so a substep never samples
// the heightfield twice for what is conceptually one "where's the ground
// under this body" question.
import type { GroundProbes } from "./groundProbe";

export interface AttitudeTarget {
  pitch: number; // radians, +up at the nose when climbing
  roll: number; // radians, +up on the +X ("right") side
}

export const LEVEL: AttitudeTarget = { pitch: 0, roll: 0 };

// Standard C1-continuous 0..1 ease between edges lo/hi — used below (and by
// net/remoteKarts.ts) anywhere a continuous value needs to gate another
// continuous value instead of a hard threshold, per .claude/rules/
// smooth-values.md. Duplicated (not imported) from net/snapshotBuffer.ts's
// private copy — this module is the shared local/remote attitude primitive
// and deliberately has zero net/ deps.
export function smoothstep(lo: number, hi: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
}

// `halfWheelbase`/`halfTrack` must be the SAME half-distances the caller
// used to build `probes` (kart/groundProbe.ts sampleGroundProbes) — they're
// only needed here for the atan2 denominator (probe separation), not for
// re-sampling.
//
// NOTE on map-edge behavior: this returns LEVEL outright the instant the
// KART'S OWN xz falls outside every defined heightfield cell
// (probes.center===null). That's a genuine discrete jump versus the real
// slope one step earlier (see attitude.test.ts's reproduction of the exact
// size of that jump) — left as-is here rather than papered over, because on
// its own this function has no notion of "how far off the map" to grade the
// falloff by. Callers whose input position can legitimately sit at/past the
// map edge (net/remoteKarts.ts, where remote karts spawn and get pushed
// right up against map boundaries) MUST NOT call this raw and apply its
// result directly — they need to blend it continuously against LEVEL
// themselves, keyed off a SEPARATE smoothed signal (computeAirborneFactor
// below), exactly the way .claude/rules/smooth-values.md's rule #5
// prescribes: smooth the blend FACTOR once, then use it as a plain
// multiplier, rather than lerping toward this function's own (still
// binary-at-the-edge) output.
export function computeAttitudeTarget(probes: GroundProbes, halfWheelbase: number, halfTrack: number): AttitudeTarget {
  if (probes.center === null) return LEVEL;
  const hHere = probes.center;
  const hF = probes.hF ?? hHere;
  const hB = probes.hB ?? hHere;
  const hR = probes.hR ?? hHere;
  const hL = probes.hL ?? hHere;

  return {
    pitch: Math.atan2(hF - hB, halfWheelbase * 2),
    roll: Math.atan2(hR - hL, halfTrack * 2),
  };
}

// Continuous replacement for a hard "airborne = y - ground > threshold"
// boolean gate (see net/remoteKarts.ts REMOTE_AIRBORNE_HEIGHT). Returns 0
// when fully grounded, 1 when fully airborne (or off the map entirely — no
// ground reading available), and eases smoothly through the band around
// `threshold` in between rather than flipping at an exact height. Callers
// still need to exp-filter this frame-to-frame (see RemoteKart.airborneSm in
// remoteKarts.ts) — this alone only removes the height-threshold step, not
// arrival-to-arrival snapshot noise.
//
// `groundHeight === null` (off the map) is treated as fully airborne rather
// than, say, extrapolating a ground height that doesn't exist: a kart
// standing at the very edge of the world with no cell under its own XZ
// really does have nothing physical to bank its body against, and forcing
// SOME slope value there would be inventing data. What this function fixes
// is the OTHER discontinuity — a kart hovering near (not past) the edge no
// longer has its attitude flip between two extremes across a single
// centimeter of position noise.
export function computeAirborneFactor(
  groundHeight: number | null,
  y: number,
  threshold: number,
  band: number
): number {
  if (groundHeight === null) return 1;
  return smoothstep(threshold - band, threshold + band, y - groundHeight);
}

// Tip-over ("качели через кромку") — owner playtest report 2026-07-10,
// "клюёт носом на скорости при съезде с обрыва". Root cause was that the
// ordinary grounded slope-follow target (computeAttitudeTarget fed
// clampGroundProbesForAttitude's output) still let a probe that had just
// cleared a cliff lip pull the body toward a real (if capped) nose-down
// slope, and the FAST filter (attitudeFollowRate) had time to act on it
// before physics/vertical.ts's own launch detector caught up — see
// groundProbe.ts excludeGroundProbesForAttitude's doc comment for that half
// of the fix (the grounded target now reads exactly 0 contribution from any
// probe past the edge, full stop).
//
// This function is the OTHER half: a kart that's genuinely resting with
// part of its own footprint hanging past a support edge for real TIME (not
// just a fast crossing) should still visibly see-saw over, like a plank
// balanced on a ledge — that's what a much slower, separately-filtered
// target computed here (attitudeTipOverRate, ~1/s — an order of magnitude
// slower than attitudeFollowRate's 20/s) reproduces.
//
// Physical model: whether the body is past ITS OWN tipping point is judged
// by the CENTER probe specifically, not by the front/back probes alone. A
// plank still resting on solid ground at its own middle can't tip no matter
// how far its overhanging end sticks out — gravity has nothing to rotate
// around yet (design brief S1: "nose ~25% over the edge, standing still ->
// nothing happens", stays that way forever, not just briefly). Only once
// the CENTER probe itself starts reading past the support surface (S2:
// "~40-50% hang") does `mag` below leave its dead zone and the slow filter
// start carrying pitch/roll toward `maxTipAngle`.
//
// `hang(h)` is a plain 0..1 measure of how far a probe's raw reading has
// fallen below `supportHeight` (the wall-aware MAX-of-probes surface that's
// actually holding the body up — kart/kart.ts's groundHeightNow, the SAME
// value physics/vertical.ts's ground-follow step already computed this
// tick, no extra sampling), smoothstepped over `edgeBand` — callers pass
// KartPhysicsParams.attitudeCliffDropLimit here (the exact same "how far
// below counts as fully off the ledge" definition excludeGroundProbesForAttitude
// uses one layer up, so the two halves of this fix agree on where the edge
// is) rather than introducing a third tunable for the same concept.
//
// Direction is a plain signed difference between the two probes on each
// axis (hangF-hangB for pitch, hangR-hangL for roll) — continuous, no
// discrete branch (.claude/rules/smooth-values.md rules #1/#4): right at the
// symmetric point (hangF==hangB) the raw direction value is 0, which only
// matters once `mag` is non-zero, and even then just yields target 0
// (level) rather than a sign-flip artifact.
export function computeTipOverTarget(
  probes: GroundProbes,
  supportHeight: number | null,
  edgeBand: number,
  maxTipAngle: number
): AttitudeTarget {
  if (probes.center === null || supportHeight === null) return LEVEL;
  const hang = (h: number | null): number => (h === null ? 1 : smoothstep(0, edgeBand, supportHeight - h));
  const hangC = hang(probes.center);
  const hangF = hang(probes.hF);
  const hangB = hang(probes.hB);
  const hangR = hang(probes.hR);
  const hangL = hang(probes.hL);

  // Dead zone: near-zero effect until the CENTER probe itself is
  // meaningfully past the support edge (S1's "~25% overhang -> nothing"
  // requirement is satisfied by hangC staying ~0 well before the center
  // probe crosses), then a pow-shaped ramp toward full tip as it does.
  const mag = Math.pow(smoothstep(0.15, 0.9, hangC), 1.5);

  const pitchDir = hangF - hangB; // >0: nose is the side hanging -> tip nose down
  const rollDir = hangR - hangL; // >0: right side is hanging -> tip right side down

  return {
    pitch: -pitchDir * mag * maxTipAngle,
    roll: -rollDir * mag * maxTipAngle,
  };
}
