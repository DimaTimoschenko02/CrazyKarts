// Shared ground-height probe set (I3, design/notes/collision-v2.md §4) —
// ONE sample of center + F/B/R/L feeds BOTH the body's height-follow
// (physics/vertical.ts, via maxGroundHeight below) and its pitch/roll
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

// Max of every non-null probe — the height-follow target per I3. Returns
// null ONLY when every single probe is null (no ground info anywhere near
// the body at all), matching physics/vertical.ts's existing "no data ->
// fail-safe freefall" convention for a null groundHeight input — this
// ALSO transparently fixes the narrow-gap edge case design doc §4 calls out:
// a center sample landing on a null seam between two diagonal walls no
// longer drops the kart if any of the 4 corner probes still reads real
// ground.
export function maxGroundHeight(probes: GroundProbes): number | null {
  let best: number | null = null;
  for (const h of [probes.center, probes.hF, probes.hB, probes.hR, probes.hL]) {
    if (h === null) continue;
    if (best === null || h > best) best = h;
  }
  return best;
}
