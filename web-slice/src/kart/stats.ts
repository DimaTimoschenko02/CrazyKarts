// Data-driven kart catalogue. A new kart type (small+fast / large+tanky) is
// a new KART_TYPES entry with physics overrides — zero changes to Kart or
// the physics modules. See design/gdd (kart types) once that spec lands.
import { DEFAULT_KART_PHYSICS_PARAMS, KART_VISUAL_SCALE, type KartPhysicsParams } from "../physics/types";

export interface KartStats {
  readonly id: string;
  readonly displayName: string;
  readonly model: string; // glb asset name under /assets/cars/ (see map/assetLoader.ts loadKartModel)
  readonly modelLength: number; // target Z-length in meters, see loadKartModel
  readonly maxHp: number; // reserved for weapons (P2) — not consumed yet
  readonly physics: Partial<KartPhysicsParams>; // overrides layered on DEFAULT_KART_PHYSICS_PARAMS
  // axle geometry (wheelbase/trackWidth): add a per-kart override here (e.g.
  // `axle: Partial<AxleGeometry>`) when a second kart type needs one — every
  // kart currently shares DEFAULT_AXLE_GEOMETRY, see kart/kart.ts.
}

export const KART_TYPES: Readonly<Record<string, KartStats>> = {
  racer: {
    id: "racer",
    displayName: "Race Kart",
    // Kenney "Blocky Cars" pack (web-slice/public/assets/cars/), not
    // space-kit — swapped 2026-07 because the old craft_racer.glb scaled to
    // a 1x1m map tile read visibly too wide for a single lane (2.2m target
    // length -> 1.3m body width, wider than the tile itself).
    model: "race",
    // race.glb's raw AABB is 1.3m wide x 2.56m long x 0.73m tall (measured
    // from the glTF accessor bounds, see project memory). loadKartModel
    // scales uniformly by this target / raw Z length, so every dimension
    // scales together: base 1.7 -> ~0.86m wide, ~0.49m tall — fits inside a
    // 1m tile with clearance on both sides (SmashKarts-style proportions).
    // Scaled by KART_VISUAL_SCALE (physics/types.ts, 1.5x — owner request
    // 2026-07-09: "too small for the 3m-tile road map") to 2.55m body length
    // / ~1.29m wide / ~0.74m tall. Collision footprint/probes (kart/kart.ts
    // COLLISION_AXLE_GEOMETRY) and kart-vs-kart radius (physics/kartCollision.ts
    // KART_COLLISION_RADIUS) scale by the same constant so the body stays in
    // the same visual proportion to its own collision shape as before —
    // dynamics (wheelbase/trackWidth fed into BicyclePhysics) are
    // deliberately NOT scaled, see KART_VISUAL_SCALE's doc comment.
    modelLength: 1.7 * KART_VISUAL_SCALE,
    maxHp: 100,
    physics: {},
  },
};

// Merges a kart's physics overrides on top of the tuned defaults. Pulled out
// as a pure function so the merge order (defaults first, overrides win) is
// unit-tested independently of Kart/THREE.
export function buildKartPhysicsParams(stats: KartStats): KartPhysicsParams {
  return { ...DEFAULT_KART_PHYSICS_PARAMS, ...stats.physics };
}
