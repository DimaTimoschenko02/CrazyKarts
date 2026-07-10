// Shared ground-height probe set (I3, design/notes/collision-v2.md §4) —
// ONE sample of center + F/B/R/L feeds BOTH the body's height-follow
// (physics/vertical.ts, via wallAwareGroundHeight below) and its pitch/roll
// (kart/attitude.ts), so a substep never samples the heightfield twice for
// what is conceptually the same "where does the ground sit under this body"
// question. Pure math, no THREE — same "physics/kart modules have no engine
// deps beyond a plain sampler function" convention as physics/vertical.ts.
//
// WHY MAX, NOT CENTER (I3): a rigid body sitting in a wedge-shaped V-groove
// (two slopes meeting at a low seam) or straddling a convex ridge has its
// own center reading either the seam's low point or one slope's mid-height —
// neither matches where the body's actual underside rests, which is
// determined by whichever contact point pushes UP the most. Taking the max
// of every non-null probe means the body "mounts" the highest thing under
// its own footprint, exactly like a real rigid chassis resting on whichever
// wheel/corner touches ground first. See design doc §4 for the concave/
// convex worked examples this fixes.
//
// D1 (design/notes/ride-collision-v2.md, 2026-07-09): plain MAX-of-all-probes
// turned out to have a second failure mode on top of the V-groove/ridge cases
// above — a corner probe can land on top of a NEIGHBORING obstacle (e.g. the
// flat top of an adjacent wall_block cube) rather than reading the ground
// under THIS body at all. That's not "the body mounts the highest contact
// point under it" (I3's intent) — it's "ground height briefly reads a whole
// block-height taller than reality because a probe strayed onto someone
// else's roof", which fed a one-tick jump straight into the vertical
// rate-detector and launched the kart ("catapult", symptom #1).
// wallAwareGroundHeight() below fixes this: any probe reading meaningfully
// HIGHER than the CENTER probe (more than `stepExcludeThreshold`) is treated
// as a wall — owned by physics/terrainWall.ts's slide/block logic, not by
// this "where does the body rest" question — and excluded from the max.

export interface Vec2 {
  x: number;
  z: number;
}

export interface GroundProbes {
  center: number | null;
  hF: number | null; // ahead, along +fwd
  hB: number | null; // behind, along -fwd
  hR: number | null; // right, along +right
  hL: number | null; // left, along -right
}

// `fwd`/`right` are unit vectors in world XZ (y=0) — same convention as
// kart/kart.ts forwardOf()/rightOf(). `halfWheelbase`/`halfTrack` are the
// fore-aft / left-right probe half-distances (see DEFAULT_AXLE_GEOMETRY).
export function sampleGroundProbes(
  sample: (x: number, z: number) => number | null,
  x: number,
  z: number,
  fwd: Vec2,
  right: Vec2,
  halfWheelbase: number,
  halfTrack: number
): GroundProbes {
  return {
    center: sample(x, z),
    hF: sample(x + fwd.x * halfWheelbase, z + fwd.z * halfWheelbase),
    hB: sample(x - fwd.x * halfWheelbase, z - fwd.z * halfWheelbase),
    hR: sample(x + right.x * halfTrack, z + right.z * halfTrack),
    hL: sample(x - right.x * halfTrack, z - right.z * halfTrack),
  };
}

// Wall-aware max of the non-null, non-wall probes — the height-follow target
// per I3 (see D1 in the module doc above for the wall-exclusion addition).
//
// D5 (body-relative wall gate, 2026-07-10, follow-up to D1 — see
// tools/diagnose_edge_bugs_sim.ts scenario B): D1's original classification
// compared each probe to the CENTER probe — but the center probe drifts with
// the body's own XZ position mid-crossing, and right at a deck's edge that
// drift is exactly what let a probe reading the deck the kart is STILL
// PHYSICALLY RESTING ON (e.g. the rear axle probe, still squarely on a 2.75m
// deck) get excluded as a "wall" the instant the center probe itself dipped
// toward the lower terrain ahead — the body fell through its own support.
// Classification rule is now: a probe counts as a WALL (excluded from the
// max) when it reads more than `climbThreshold` ABOVE the body's own current
// reference height `kartY` (yRef, the same per-tick reference height passed
// to physics/terrainWall.ts and shared/heightfield.ts's own layer-selection
// climb cutoff — KartPhysicsParams.layerClimbThreshold) — i.e. "is this
// probe reporting a floor meaningfully out of this body's own reach", not
// "is this probe higher than some OTHER probe on the same body". A real
// support surface the body is resting on is by definition within reach of
// yRef, so it can never be excluded by this rule regardless of what the
// center probe happens to read that tick.
//
// Falls back to the CENTER probe alone when literally every F/B/R/L probe
// gets excluded as a wall (kart genuinely boxed in — e.g. a 1-cell pit with
// a wall_block on every side, all four edge probes reading a neighbor's
// roof out of climb reach): the design doc calls this out explicitly ("если
// ВСЕ угловые пробы выше порога — земля = центральная проба"), and it falls
// out for free here since `center` is always considered first.
//
// Returns null ONLY when every single probe is null (no ground info
// anywhere near the body at all), matching physics/vertical.ts's existing
// "no data -> fail-safe freefall" convention for a null groundHeight input.
export function wallAwareGroundHeight(probes: GroundProbes, kartY: number, climbThreshold: number): number | null {
  const center = probes.center;
  let best: number | null = null;
  const consider = (h: number | null): void => {
    if (h === null) return;
    if (best === null || h > best) best = h;
  };
  consider(center);
  for (const h of [probes.hF, probes.hB, probes.hR, probes.hL]) {
    if (h === null) continue;
    if (h - kartY > climbThreshold) continue; // wall probe — terrainWall.ts owns this, not ground-follow
    consider(h);
  }
  return best;
}

// Standard C1-continuous 0..1 ease between edges lo/hi — private copy, same
// duplication pattern kart/attitude.ts's own smoothstep header comment
// documents (this module is a leaf shared by both attitude.ts and
// physics/vertical.ts's ground-follow input and deliberately has no deps
// beyond plain math).
function smoothstep(lo: number, hi: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
}

// Cliff-edge attitude fix (owner playtest report, 2026-07-09): the downward
// mirror of wallAwareGroundHeight's wall exclusion above. A probe reading
// meaningfully LOWER than the center probe is air hanging off a cliff edge —
// not ground under that wheel — and letting the RAW depth of "whatever's
// down there" (which can be many meters, an entire floor below on a
// multi-layer map) feed straight into body TILT (kart/attitude.ts) or the
// forward slope probe (kart/kart.ts's slopeRaw) is what produced the reported
// "nose dives the instant the front wheel crosses the lip" pop: a single
// substep's slope target swinging to something like atan2(-6, dist) ≈ -80°.
//
// Unlike wallAwareGroundHeight (which fully DROPS an excluded probe from the
// vertical/height-follow max — physics/vertical.ts still needs the real,
// unclamped depth so it can correctly detect launch-off-a-ledge, per the
// design brief's explicit "do not touch detach logic" instruction), this
// CAPS a probe's value instead of dropping it: attitude still wants some
// directional information right at the lip (a little nose-down IS correct as
// the wheel visually crosses the edge), just not the raw unclamped depth of a
// floor meters below. `dropLimit` is how far below center a probe is allowed
// to pull attitude before being capped; the cap eases in smoothly over a
// `dropLimit * 0.5` band starting exactly at `drop === dropLimit`, so probes
// reading at/under the limit are returned completely untouched (C0/C1 match
// at that boundary — see attitude.test.ts's cliff-edge coverage) and probes
// reading far below plateau at exactly `center - dropLimit`.
export function clampHeightForAttitude(h: number | null, center: number, dropLimit: number): number | null {
  if (h === null) return null;
  const drop = center - h;
  const band = dropLimit * 0.5;
  const t = 1 - smoothstep(dropLimit, dropLimit + band, drop);
  const cap = center - dropLimit;
  return h * t + cap * (1 - t);
}

// Probe-set version of clampHeightForAttitude above — clamps every non-center
// probe against the SAME center reading used elsewhere in this tick (I3's
// "one probe set, one 'where's the ground' question" convention). When the
// body's own center is off the map (probes.center === null — the narrow-gap
// case I3 already handles), there is nothing to clamp against, so the probe
// set is returned unchanged, same as wallAwareGroundHeight's own
// center-null fallback above.
export function clampGroundProbesForAttitude(probes: GroundProbes, dropLimit: number): GroundProbes {
  if (probes.center === null) return probes;
  const center = probes.center;
  return {
    center,
    hF: clampHeightForAttitude(probes.hF, center, dropLimit),
    hB: clampHeightForAttitude(probes.hB, center, dropLimit),
    hR: clampHeightForAttitude(probes.hR, center, dropLimit),
    hL: clampHeightForAttitude(probes.hL, center, dropLimit),
  };
}

// Cliff-edge NOSE-DIVE fix, take 2 (owner playtest report, 2026-07-10 —
// "клюёт носом на скорости", see design/notes/ride-collision-v2.md follow-up
// and kart/attitude.ts's computeTipOverTarget doc for the full picture).
// clampHeightForAttitude/clampGroundProbesForAttitude above still CAP a
// hanging probe at `center - dropLimit`, which keeps feeding a small but
// real downward slope target into the FAST slope-follow filter
// (attitudeFollowRate=20) the instant a probe crosses the lip — at cruise
// speed the body has time to visibly dip before the vertical step (physics/
// vertical.ts) even detects a launch, because the fast filter reacts within
// a couple ticks. This sibling function is the harder version: any probe
// reading past `dropLimit` below center is EXCLUDED entirely from the
// slope-follow target (folded back to `center` itself, i.e. zero
// contribution) rather than capped to a small residual slope — the body's
// grounded attitude is then driven only by whatever probes are still
// genuinely resting on the support surface, exactly like a rigid chassis
// that's lost contact on one corner: the OTHER wheels decide the tilt, not
// the missing one. A probe within the limit is untouched (same C0/C1 match
// at the boundary as the clamp version — reuses the identical smoothstep
// band shape, just blends toward `center` instead of the capped value).
//
// The slow, SEPARATE "tip-over" signal (computeTipOverTarget) is what
// re-introduces a nose-down lean for a kart that's genuinely hanging its
// support past the edge — on its own much slower rate, so a fast crossing
// never has time to accumulate it before going airborne (see that
// function's doc comment for the full model). This function's job is only
// to make sure the FAST filter stops seeing hanging probes as ordinary
// slope at all.
export function excludeHeightForAttitude(h: number | null, center: number, dropLimit: number): number | null {
  if (h === null) return null;
  const drop = center - h;
  const band = dropLimit * 0.5;
  const t = 1 - smoothstep(dropLimit, dropLimit + band, drop);
  return h * t + center * (1 - t); // fully excluded -> collapses to `center` (zero slope contribution)
}

// Probe-set version of excludeHeightForAttitude — same "one probe set, one
// clamp-against-center tick" convention as clampGroundProbesForAttitude.
export function excludeGroundProbesForAttitude(probes: GroundProbes, dropLimit: number): GroundProbes {
  if (probes.center === null) return probes;
  const center = probes.center;
  return {
    center,
    hF: excludeHeightForAttitude(probes.hF, center, dropLimit),
    hB: excludeHeightForAttitude(probes.hB, center, dropLimit),
    hR: excludeHeightForAttitude(probes.hR, center, dropLimit),
    hL: excludeHeightForAttitude(probes.hL, center, dropLimit),
  };
}
