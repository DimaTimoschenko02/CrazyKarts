// Kart-vs-static-shape contact resolution — design/notes/collision-v2.md
// §3.2 (resolveKartVsStatic). Pure math, no THREE — same "physics/ has no
// engine deps" convention as bicyclePhysics.ts/kartCollision.ts. Resolves
// the kart's OBB against every static ConvexPoly (wall_block AABBs +
// structural/natural-decor props, see shared/staticColliders.ts) via
// SAT + MTV push-out and an I2 velocity slide — the SAME slideVelocity law
// physics/terrainWall.ts uses for the (separate) dynamic terrain-edge case.
import { makeObb, satPolyPoly, slideVelocity, type ConvexPoly, type Vec2 } from "../shared/collision2d";

// Owner-approved kart shape vs. static geometry (collision-v2.md §2.1):
// halfWidth ≈ 0.42, halfLength ≈ 0.83 — body racer 0.86m wide x 1.7m long,
// minus the same STATIC_COLLISION_SKIN margin (a capsule fallback was
// considered and rejected — see §7/§11 open question 1 — OBB gives the
// flush-parking-to-a-flat-wall feel the owner explicitly asked for).
export const KART_STATIC_HALF_WIDTH = 0.42;
export const KART_STATIC_HALF_LENGTH = 0.83;

export interface StaticSlideResult {
  pos: Vec2;
  vel: Vec2;
}

// `rightAxis`/`fwdAxis`: unit vectors in world XZ at the kart's current yaw
// (see kart/kart.ts forwardOf()/rightOf()). MAX_ITERS=4 per design doc §3.5
// (multi-contact clink/corner stability, bounded so a degenerate 3-way
// squeeze can't spin forever).
export function resolveKartVsStatic(
  colliders: readonly ConvexPoly[],
  pos: Vec2,
  vel: Vec2,
  rightAxis: Vec2,
  fwdAxis: Vec2,
  skin: number,
  maxIters = 4
): StaticSlideResult {
  let px = pos.x;
  let pz = pos.z;
  let vx = vel.x;
  let vz = vel.z;

  for (let iter = 0; iter < maxIters; iter++) {
    let moved = false;
    for (const col of colliders) {
      const kartObb = makeObb({ x: px, z: pz }, KART_STATIC_HALF_WIDTH, KART_STATIC_HALF_LENGTH, rightAxis, fwdAxis);
      const contact = satPolyPoly(kartObb, col);
      if (!contact) continue;
      px += contact.n.x * (contact.depth + skin);
      pz += contact.n.z * (contact.depth + skin);
      const slid = slideVelocity({ x: vx, z: vz }, contact.n);
      vx = slid.x;
      vz = slid.z;
      moved = true;
    }
    if (!moved) break;
  }

  return { pos: { x: px, z: pz }, vel: { x: vx, z: vz } };
}
