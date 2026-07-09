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
// Classification rule: a probe counts as a WALL (excluded from the max) when
// the CENTER probe is available AND this probe reads more than
// `stepExcludeThreshold` HIGHER than center. When center itself is null (the
// body's own XZ point isn't on any authored cell — the narrow-gap case I3
// already handled) there's nothing to classify against, so every probe is
// kept exactly like the old plain-MAX behavior — this preserves the "narrow
// gap: center null, corners still read real ground -> NOT a freefall" fix.
//
// Falls back to the CENTER probe alone when literally every F/B/R/L probe
// gets excluded as a wall (center present but boxed in — e.g. a kart sitting
// in a 1-cell pit/trench with a wall_block on every side): the design doc
// calls this out explicitly ("если ВСЕ угловые пробы выше порога — земля =
// центральная проба"), and it falls out for free here since `center` is
// always considered first.
//
// Returns null ONLY when every single probe is null (no ground info
// anywhere near the body at all), matching physics/vertical.ts's existing
// "no data -> fail-safe freefall" convention for a null groundHeight input.
export function wallAwareGroundHeight(probes: GroundProbes, stepExcludeThreshold: number): number | null {
  const center = probes.center;
  let best: number | null = null;
  const consider = (h: number | null): void => {
    if (h === null) return;
    if (best === null || h > best) best = h;
  };
  consider(center);
  for (const h of [probes.hF, probes.hB, probes.hR, probes.hL]) {
    if (h === null) continue;
    if (center !== null && h - center > stepExcludeThreshold) continue; // wall probe — terrainWall.ts owns this, not ground-follow
    consider(h);
  }
  return best;
}
