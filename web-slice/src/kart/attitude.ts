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
