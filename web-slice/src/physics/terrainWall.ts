// Dynamic terrain-edge slide — successor to the old footprintWall.ts
// axis-kill check (see design/notes/collision-v2.md §3.3). Handles the two
// cases the SAT static-polygon path (shared/staticColliders.ts) does NOT
// cover, because they aren't discrete authored shapes:
//   1. Genuine off-map edges (heightfield.hasColumn===false — nothing
//      authored there at all, not even a wall_block).
//   2. A rise between two REAL terrain cells steeper than a kart can climb
//      (rare after collision-v2: every Edges-family asset is now a smooth
//      drivable ramp, but kept as a safety net for stacked/malformed columns).
//
// wall_block* cells are DELIBERATELY EXCLUDED here (see the hasColumn guard
// below) — those are fully owned by the SAT poly system now. Reacting to
// them here too would reproduce the exact P1 bug this rework fixes: a
// footprint-radius-wide "you can't get within half a meter of the wall"
// block instead of the SAT system's flush skin margin.
//
// Design: reuses shared/collision2d.ts's slideVelocity (I2 — same v·n<0 gate
// as the static-poly resolver) so every contact type in this rework — walls,
// props, and now terrain edges — shares one velocity-slide law. The contact
// NORMAL here is approximated from which footprint corner(s) tripped the
// check (average of their body-relative offset directions, negated) rather
// than a true SAT MTV, because a heightfield edge isn't a polygon with real
// depth — this is "good enough" for the rare cases that still reach this
// path (map boundary, malformed stacked columns), and crucially is now
// BODY-RELATIVE (not "which global x/z axis moved"), which is what actually
// fixes the diagonal-wall corner-clip case footprintWall.ts's doc comment
// described (P1 root cause).
import { slideVelocity, type Vec2 } from "../shared/collision2d";

interface FootprintOffset {
  right: number;
  fwd: number;
}

// Center + 4 corners — same set footprintWall.ts used, still the right probe
// set for a rectangular body's height/off-map extrema (corners are where a
// linear-per-cell heightfield's extrema land).
const FOOTPRINT_OFFSETS: readonly FootprintOffset[] = [
  { right: 0, fwd: 0 },
  { right: 1, fwd: 1 },
  { right: 1, fwd: -1 },
  { right: -1, fwd: 1 },
  { right: -1, fwd: -1 },
];

export function footprintHalfExtents(axle: { wheelbase: number; trackWidth: number }): { halfLength: number; halfWidth: number } {
  return { halfLength: axle.wheelbase * 0.5, halfWidth: axle.trackWidth * 0.5 };
}

export function footprintPoints(x: number, z: number, fwd: Vec2, right: Vec2, halfLength: number, halfWidth: number): Vec2[] {
  return FOOTPRINT_OFFSETS.map(o => ({
    x: x + right.x * o.right * halfWidth + fwd.x * o.fwd * halfLength,
    z: z + right.z * o.right * halfWidth + fwd.z * o.fwd * halfLength,
  }));
}

export interface TerrainSampler {
  sample(x: number, z: number): number | null;
  // See heightfield.ts Heightfield.hasColumn doc — true for BOTH walkable
  // and wall_block columns, false only for a genuinely unauthored spot.
  hasColumn(x: number, z: number): boolean;
}

// One footprint corner's before/after check — returns true if this corner's
// move should be treated as hitting a genuine terrain edge (NOT a wall_block
// hole, see the module doc comment).
function cornerBlocked(sampler: TerrainSampler, cur: Vec2, next: Vec2, maxStep: number): boolean {
  const hNext = sampler.sample(next.x, next.z);
  if (hNext === null) {
    // Off-map at the destination — a wall_block hole is NOT a terrain edge
    // (SAT owns it); anything else genuinely has no ground there.
    return !sampler.hasColumn(next.x, next.z);
  }
  const hCur = sampler.sample(cur.x, cur.z);
  if (hCur === null) return false; // corner was already off-map a moment ago — nothing to compare, don't spuriously block
  return hNext - hCur > maxStep;
}

// Iteratively resolves a candidate XZ move against genuine terrain edges
// (see module doc). Mirrors resolveKartVsStatic's shape (kart/kart.ts) —
// same MAX_ITERS-bounded slide loop, same v·n<0 gate — but the "contact" is
// derived from footprint-corner sampling instead of a real SAT MTV.
export function resolveTerrainSlide(
  sampler: TerrainSampler,
  pos: Vec2,
  vel: Vec2,
  dt: number,
  fwd: Vec2,
  right: Vec2,
  halfLength: number,
  halfWidth: number,
  maxStep: number,
  maxIters = 4
): { pos: Vec2; vel: Vec2 } {
  let px = pos.x;
  let pz = pos.z;
  let vx = vel.x;
  let vz = vel.z;

  for (let iter = 0; iter < maxIters; iter++) {
    if (vx === 0 && vz === 0) break;
    const nx = px + vx * dt;
    const nz = pz + vz * dt;
    const curPts = footprintPoints(px, pz, fwd, right, halfLength, halfWidth);
    const nextPts = footprintPoints(nx, nz, fwd, right, halfLength, halfWidth);

    let sumX = 0;
    let sumZ = 0;
    let blockedCount = 0;
    for (let i = 0; i < curPts.length; i++) {
      if (!cornerBlocked(sampler, curPts[i], nextPts[i], maxStep)) continue;
      blockedCount++;
      // Body-relative offset direction of this corner (not world axis) —
      // the actual P1 fix: a diagonal wall clips a ROTATED corner, and the
      // push-back direction must be relative to the body, not a global x/z
      // guess. Center (offset 0,0) blocked means the whole footprint is off
      // the map — fall back to pushing straight back along -fwd (can't
      // derive a meaningful corner direction from the zero offset).
      const o = FOOTPRINT_OFFSETS[i];
      if (o.right === 0 && o.fwd === 0) {
        sumX += -fwd.x;
        sumZ += -fwd.z;
      } else {
        sumX += right.x * o.right + fwd.x * o.fwd;
        sumZ += right.z * o.right + fwd.z * o.fwd;
      }
    }

    if (blockedCount === 0) {
      // Clear — commit the full move and stop (common case: no terrain edge
      // nearby this substep).
      px = nx;
      pz = nz;
      break;
    }

    const len = Math.hypot(sumX, sumZ);
    if (len < 1e-9) break; // degenerate (opposing corners cancelled) — bail, keep current pos/vel
    const n: Vec2 = { x: -sumX / len, z: -sumZ / len }; // negate: push AWAY from the blocked direction
    const slid = slideVelocity({ x: vx, z: vz }, n);
    vx = slid.x;
    vz = slid.z;
    // Loop again with the corrected velocity — if the slid move now clears,
    // it commits on the next iteration's blockedCount===0 branch.
  }

  return { pos: { x: px, z: pz }, vel: { x: vx, z: vz } };
}
