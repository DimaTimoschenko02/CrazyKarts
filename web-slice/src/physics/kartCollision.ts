// Client-side kart-vs-kart circle collision, gated by height (see
// KART_PUSH_VERTICAL_M below) so it never fires across floors on a
// multi-layer map. Pure math, no THREE — same "physics/ has no engine deps"
// convention as bicyclePhysics.ts.
//
// Design: there is no server authority for kart-kart contact yet (see
// network-programmer brief). Instead, EACH client independently pushes its
// OWN kart away from every OTHER (already network-interpolated) kart it
// overlaps AND is roughly on the same floor as (Y within
// KART_PUSH_VERTICAL_M). Because both clients run the same resolution
// locally against each other's rendered position, the effect reads as
// symmetric even though neither side is authoritative — same trick
// client-side rigidbody demos use for "good enough" local-only collision in
// an owner-authoritative game.
//
// The caller (Kart.update, kart/kart.ts) is responsible for re-validating the
// result against the map heightfield afterwards — this module knows nothing
// about walls/terrain, it only resolves circle-circle overlap (now height-
// gated — see KART_PUSH_VERTICAL_M).

export interface Vec2 {
  x: number;
  z: number;
}

export interface KartObstacle {
  x: number;
  y: number; // rendered/synced kart height — drives the vertical push gate, see KART_PUSH_VERTICAL_M
  z: number;
  alive: boolean;
}

import { KART_VISUAL_SCALE } from "./types";
import { withinProximity3D } from "../shared/spatial3d";

// Tune by feel — not derived from the visual mesh bounds (kart body is
// roughly 0.86m wide x 1.7m long BEFORE scaling, see kart/stats.ts
// KART_TYPES.racer). A circle this size gives a bit of grace for grazing
// side-by-side driving before it starts shoving. Scaled by KART_VISUAL_SCALE
// (physics/types.ts) so the collision circle keeps the same visual grace
// margin relative to the bigger kart body — see that constant's doc comment.
export const KART_COLLISION_RADIUS = 0.9 * KART_VISUAL_SCALE;

// Fraction of closing speed reflected back as bounce (0 = fully inelastic
// stop along the normal, 1 = perfectly elastic). Low value reads as "karts
// bumping", not "karts pinballing".
const RESTITUTION = 0.3;

// REAL BUG #3 (collision audit, 2026-07-10): this module used to be pure XZ
// circle-circle push with no Y awareness at all — on a multi-layer map (a
// bridge deck over a lower road, ~1.1m floor-to-floor, see
// shared/spatial3d.ts's own header + .claude/rules/map-building.md
// level_height) a kart driving on the bridge got shoved by a kart passing
// underneath it. `KART_PUSH_VERTICAL_M` gates the push out once the two
// karts' Y values diverge by this much before the circle test even runs.
// Chosen strictly LESS than the ~1.1m floor spacing (the Kenney 3D Road
// Tiles pack's own per-level height, see project memory
// project_roads_pack_migration_plan.md) so two karts separated by a full
// deck never push, while same-floor divergence from ordinary slope/ramp
// riding (own playtest ceiling ~0.5m on any single ramp face) still pushes
// normally — this is a discrete gate, not a continuous physics value: per
// .claude/rules/smooth-values.md's own carve-out, contact/collision
// responses are allowed to be binary by nature (same category as "mine
// arming" / "direct-hit detection" in shared/spatial3d.ts's own doc comment
// for withinProximity3D below), so a hard per-frame on/off here (rather than
// a smoothed falloff) is intentional, not an oversight.
export const KART_PUSH_VERTICAL_M = 1.0;

// Resolves overlap between the LOCAL kart (pos/vel) and every alive obstacle
// in `obstacles`. Dead karts are ignored entirely (no collision with a
// corpse). Multiple overlaps are resolved sequentially against the running
// pos/vel — fine for the handful of karts an arcade match has, and avoids
// needing a real physics solver for what's a cosmetic-feel bump, not a
// hard-authoritative rule.
export function resolveKartPush(
  pos: Vec2,
  vel: Vec2,
  obstacles: readonly KartObstacle[],
  radius: number = KART_COLLISION_RADIUS,
  // Local kart's own current height (Kart.state.pos.y, one-tick lag same as
  // every other step 8c reading — see kart.ts step 8c call site comment).
  // Defaults to 0 so pre-existing single-floor callers/tests (no bridges,
  // every kart effectively on the same plane) see byte-identical behavior:
  // every obstacle.y also defaults conceptually to "same floor" in that case.
  selfY: number = 0
): { pos: Vec2; vel: Vec2 } {
  let px = pos.x;
  let pz = pos.z;
  let vx = vel.x;
  let vz = vel.z;
  const minDist = radius * 2;

  for (const o of obstacles) {
    if (!o.alive) continue;
    // Vertical gate BEFORE the circle test — see KART_PUSH_VERTICAL_M doc
    // above. withinProximity3D's own radiusXZ check is the exact same
    // "dist < minDist" overlap test this loop needs anyway (see
    // shared/spatial3d.ts), so this single call replaces both the old
    // Y-blind overlap check and adds the new floor gate in one shot — no
    // duplicated circle math.
    if (!withinProximity3D({ x: px, y: selfY, z: pz }, { x: o.x, y: o.y, z: o.z }, minDist, KART_PUSH_VERTICAL_M)) continue;
    const dx = px - o.x;
    const dz = pz - o.z;
    const dist = Math.hypot(dx, dz);
    // Exactly coincident (degenerate normal — bail rather than divide by
    // zero; vanishingly unlikely for two moving karts anyway).
    if (dist < 1e-6) continue;

    const nx = dx / dist;
    const nz = dz / dist;
    const penetration = minDist - dist;

    // Positional correction: push the local kart fully out of the overlap.
    px += nx * penetration;
    pz += nz * penetration;

    // Velocity: kill (+ partially bounce) only the component ALONG the
    // normal (closing speed), leave the tangential component — sliding past
    // each other — untouched. Skip entirely if already separating (avoid
    // adding energy to a pair that's moving apart).
    const vDotN = vx * nx + vz * nz;
    if (vDotN < 0) {
      const scale = (1 + RESTITUTION) * vDotN;
      vx -= scale * nx;
      vz -= scale * nz;
    }
  }

  return { pos: { x: px, z: pz }, vel: { x: vx, z: vz } };
}
