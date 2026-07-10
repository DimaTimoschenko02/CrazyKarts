// Swept collision for flying weapons — no Colyseus/schema deps, unit-
// testable in isolation. Generic across weapon types (2026-07-10 owner
// decision, playtest bug: "динамит пролетает СКВОЗЬ объекты — стены,
// потолок, вообще похуй что", then extended same day to rockets: "НИКАКОЕ
// оружие не пролетает сквозь объекты" — rockets tunnel even worse than
// dynamite, 40m/s / 30Hz = 1.33m between the old single-point-per-tick
// samples). Originally landed as dynamiteSim.sweepDynamiteSegment; pulled
// out into its own module once rocketSim needed the exact same primitive —
// see server/rooms/MatchRoom.ts tickDynamite/tickRockets for both callers.
import type { ConvexPoly } from "../../src/shared/collision2d";
import { segmentVsPoly } from "../../src/shared/collision2d";
import type { Heightfield } from "../../src/shared/heightfield";
import { isBlockedByTerrain, type Vec3 } from "./rocketSim";

export type { Vec3 };

// Root cause (both weapons): the old per-weapon tick loop tested only the
// END-of-tick closed-form/straight-line position against isBlockedByTerrain
// — a single point sample once per ~33ms tick. At dynamite's post-buff
// speedMax=28 that's up to ~0.93m of travel between samples; a rocket at
// 40m/s covers ~1.33m — both comfortably wide enough to skip clean over a
// thin wall/step's footprint (tunneling). AND isBlockedByTerrain is
// deliberately an OWN-LAYER-only test (rocketSim.ts doc: "a flying rocket
// ... should only ever compare itself against its OWN layer's floor" — that
// intentionally lets it fly under a bridge deck), so it never even looked at
// a floor stacked ABOVE the current altitude — no ceiling/deck-from-below
// detection existed at all for either weapon.
//
// Fix: walk the tick's motion segment in ≤SUBSTEP_M chunks and, at every
// substep, run TWO checks plus an optional prop check:
//   (a) isBlockedByTerrain at that point — same own-layer rule as before,
//       just re-evaluated finely enough that a thin wall's footprint can no
//       longer be skipped over in one step (this alone fixes tunneling for
//       both weapons — a rocket's bigger per-tick segment just means more
//       substeps, not a different algorithm).
//   (b) any-layer crossing: does ANY layer's floor height in this column lie
//       between the substep's start and end Y (either direction)? This is
//       what makes reaching a deck/roof FROM BELOW (an ascending approach)
//       stick — without ever falsely triggering for a projectile that's
//       simply flying steadily UNDER a deck the whole time (its Y never
//       crosses the deck's height in that case, so (b) stays silent and (a)
//       keeps reading the deck's own lower floor, same as before — this is
//       EXACTLY the "fly under a bridge stays free" behavior rocketSim.ts's
//       isBlockedByTerrain doc already relies on, preserved unchanged here).
//   (c) optional static prop colliders (buildings/rocks — see
//       src/shared/staticColliders.ts) — segment-vs-convex-polygon in the XZ
//       plane, only run when the caller passes them (server-side; see
//       MatchRoom.ts wiring, server/config/arena.ts Arena.colliders). Each
//       poly carries an OPTIONAL `worldTopY` (baked from the GLB's own AABB
//       top, see collisionShapes.json's topY / staticColliders.ts) — a
//       substep entirely above that Y (2026-07-10 owner review: "динамит,
//       перелетающий камень по высокой дуге, прилипнет в воздухе над ним")
//       skips the poly, letting a projectile clear a building/rock on a high
//       arc instead of hitting an invisible floor-to-ceiling column. A poly
//       with no `worldTopY` (stale/hand-built shapes table) falls back to
//       the old floor-to-ceiling behavior — same spirit as the heightfield
//       side not modeling road-deck thickness.
//
// Whichever check fires first along the segment wins — "sticks to/explodes
// on the FIRST thing it touches" (owner spec), not necessarily the
// geometrically most "important" one.
const SWEEP_SUBSTEP_M = 0.15;

// Tolerance for the any-layer crossing test (b) — purely a float-noise guard
// around an exact height match (e.g. a substep that lands EXACTLY on a
// deck's floor height), not a gameplay-tunable "fuzziness" knob.
const CROSSING_EPS_M = 1e-6;

// Tolerance for the prop worldTopY gate (c) — same float-noise-guard spirit
// as CROSSING_EPS_M above, just generous enough to swallow the sub-cm baked-
// AABB rounding from tools/bake-collision-shapes.mjs's round4(); not a
// gameplay-tunable "grace" margin.
const PROP_TOP_Y_EPS_M = 0.02;

function lerpVec3(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

function clamp01(t: number): number {
  return Math.max(0, Math.min(1, t));
}

export interface ProjectileSweepHit {
  hit: Vec3;
}

// Sweeps a projectile's motion for one tick (from its position at the START
// of this tick to the freshly-computed end-of-tick position) and returns the
// first point along that path where it embeds in terrain/a deck/a static
// prop, or null if the whole segment is clear. See the module header above
// for the three checks and why each exists. `colliders` is optional (a
// caller not wiring static props yet still gets the terrain/deck fix).
export function sweepProjectileSegment(
  from: Vec3,
  to: Vec3,
  heightfield: Heightfield,
  colliders?: readonly ConvexPoly[]
): ProjectileSweepHit | null {
  const dist = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
  const steps = Math.max(1, Math.ceil(dist / SWEEP_SUBSTEP_M));

  let prev = from;
  for (let i = 1; i <= steps; i++) {
    const cur = lerpVec3(from, to, i / steps);

    // (a) Own-layer floor test, re-evaluated every substep.
    if (isBlockedByTerrain(cur, heightfield)) return { hit: cur };

    // (b) Any-layer crossing (deck/ceiling reached from below, or above).
    const layers = heightfield.allLayerHeights(cur.x, cur.z) ?? [];
    const loY = Math.min(prev.y, cur.y);
    const hiY = Math.max(prev.y, cur.y);
    for (const h of layers) {
      if (h >= loY - CROSSING_EPS_M && h <= hiY + CROSSING_EPS_M) {
        const t = cur.y === prev.y ? 1 : clamp01((h - prev.y) / (cur.y - prev.y));
        return { hit: lerpVec3(prev, cur, t) };
      }
    }

    // (c) Static prop colliders, when the caller has them.
    if (colliders) {
      const subLoY = Math.min(prev.y, cur.y);
      for (const poly of colliders) {
        // worldTopY gate: this whole substep sits above the prop's own top —
        // fly over it, don't check the XZ footprint at all.
        if (poly.worldTopY !== undefined && subLoY > poly.worldTopY + PROP_TOP_Y_EPS_M) continue;
        const seg = segmentVsPoly({ x: prev.x, z: prev.z }, { x: cur.x, z: cur.z }, poly);
        if (seg) return { hit: lerpVec3(prev, cur, seg.t) };
      }
    }

    prev = cur;
  }
  return null;
}
