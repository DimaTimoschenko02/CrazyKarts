import { describe, expect, it } from "vitest";
import { makeAabb } from "../../src/shared/collision2d";
import { Heightfield } from "../../src/shared/heightfield";
import { sweepProjectileSegment } from "./projectileSweep";

// 2026-07-10 owner playtest bug: "динамит пролетает СКВОЗЬ объекты — стены,
// потолок, вообще похуй что", extended same day to "НИКАКОЕ оружие не
// пролетает сквозь объекты" once rockets got the same treatment.
// sweepProjectileSegment replaces the old end-of-tick-only isBlockedByTerrain
// point sample with a fine (<=0.15m) substepped walk of the whole tick's
// motion — see that function's own file header in projectileSweep.ts for the
// full breakdown of its 3 checks. This suite is weapon-agnostic (the
// function has no notion of "dynamite" vs "rocket", just a from/to segment),
// so segment lengths below cover BOTH weapons' real per-tick travel
// distances: dynamite up to ~0.93m (speedMax=28 / 30Hz) and rocket ~1.33m
// (40m/s / 30Hz) — both comfortably bigger than the 0.15m substep, which is
// the whole point (the OLD single-sample-per-tick approach is exactly this
// segment tested with only its endpoint, and would miss these).
describe("sweepProjectileSegment", () => {
  it("catches a thin wall crossed mid-step (tunneling fix) — horizontal ram, dynamite-length segment (~2.8m)", () => {
    // Column x=1 is a SINGLE-layer 2.0m-tall wall (own-floor test blocks it
    // outright, since there's no lower floor in that column to fall back
    // on) sandwiched between open ground at x=0 and x=2. Flown level at
    // y=1.0 (well below the wall's 2.0m top) across the full ~2.8m gap in
    // ONE segment — bigger than a single old-style tick step — so a naive
    // single end-point sample would skip clean over the wall's ~1m-wide
    // footprint entirely.
    const hf = Heightfield.fromMapJson({
      meta: { tile_size: 1, level_height: 0.5, origin_offset: [0, 0, 0] },
      cells: [
        { asset: "terrain", x: 0, z: 0, y_level: 0 },
        { asset: "terrain", x: 1, z: 0, y_level: 4 }, // 2.0m wall
        { asset: "terrain", x: 2, z: 0, y_level: 0 },
      ],
    });
    const from = { x: -0.4, y: 1.0, z: 0 };
    const to = { x: 2.4, y: 1.0, z: 0 };
    const result = sweepProjectileSegment(from, to, hf);
    expect(result).not.toBeNull();
    // Hit lands somewhere inside the wall column's footprint (x in [0.5,1.5]).
    expect(result!.hit.x).toBeGreaterThanOrEqual(0.4);
    expect(result!.hit.x).toBeLessThanOrEqual(1.6);
    expect(result!.hit.y).toBeCloseTo(1.0, 5); // own-floor test fires at the sample point, y unchanged
  });

  it("catches a thin wall crossed mid-step at a rocket-length segment (~1.33m, 40m/s / 30Hz)", () => {
    // Same wall column as above, but the segment length matches a real
    // rocket tick's travel (40 * 1/30 ~= 1.33m) instead of dynamite's — the
    // old end-of-tick-only isBlockedByTerrain sample in tickRockets would
    // have jumped from x=0.3 straight to x=1.63, landing PAST the wall
    // column (footprint x in [0.5,1.5]) without ever sampling inside it.
    const hf = Heightfield.fromMapJson({
      meta: { tile_size: 1, level_height: 0.5, origin_offset: [0, 0, 0] },
      cells: [
        { asset: "terrain", x: 0, z: 0, y_level: 0 },
        { asset: "terrain", x: 1, z: 0, y_level: 4 }, // 2.0m wall
        { asset: "terrain", x: 2, z: 0, y_level: 0 },
      ],
    });
    const from = { x: 0.3, y: 1.0, z: 0 };
    const to = { x: 0.3 + 40 * (1 / 30), y: 1.0, z: 0 }; // ~1.633
    const result = sweepProjectileSegment(from, to, hf);
    expect(result).not.toBeNull();
    expect(result!.hit.x).toBeGreaterThanOrEqual(0.5);
    expect(result!.hit.x).toBeLessThanOrEqual(1.5);
  });

  it("catches a deck/ceiling reached from below on an ascending trajectory", () => {
    // Two stacked layers at the SAME column: a road at y=0 and a deck at
    // y=2.0 (level_height=0.5, y_level=4) directly above it — an own-layer-
    // only test would ignore the deck entirely (that's the deliberate "fly
    // under a bridge" rule) and never stop the projectile; the any-layer
    // crossing check must catch it once the ascent actually reaches the
    // deck's height.
    const hf = Heightfield.fromMapJson({
      meta: { tile_size: 1, level_height: 0.5, origin_offset: [0, 0, 0] },
      cells: [
        { asset: "terrain", x: 0, z: 0, y_level: 0 }, // road, h=0
        { asset: "terrain", x: 0, z: 0, y_level: 4 }, // deck, h=2.0, stacked in the same column
      ],
    });
    const from = { x: 0, y: 0.5, z: 0 };
    const to = { x: 0, y: 2.5, z: 0 };
    const result = sweepProjectileSegment(from, to, hf);
    expect(result).not.toBeNull();
    expect(result!.hit.y).toBeCloseTo(2.0, 1); // stuck at the deck's underside, not the tick's raw endpoint (2.5)
    expect(result!.hit.x).toBeCloseTo(0, 5);
    expect(result!.hit.z).toBeCloseTo(0, 5);
  });

  // Regression guard for rocketSim.ts's isBlockedByTerrain doc: "a flying
  // rocket ... should only ever compare itself against its OWN layer's
  // floor ... lets it fly under a bridge deck". The swept sequence must
  // preserve this exactly — flying level UNDER a deck the whole tick (never
  // ascending into it) must NOT explode/stick, at either weapon's speed.
  it("flying level UNDER a deck the whole segment does NOT hit it (rocket 'fly under a bridge' regression)", () => {
    const hf = Heightfield.fromMapJson({
      meta: { tile_size: 1, level_height: 0.5, origin_offset: [0, 0, 0] },
      rect_fills: [
        { asset: "terrain", x_min: -2, z_min: -2, x_max: 10, z_max: 2, y_level: 0, rot: 0 }, // road under the deck, h=0
      ],
      cells: [
        { asset: "terrain", x: 4, z: 0, y_level: 4 }, // one deck cell overhead at x=4, h=2.0
      ],
    });
    // Straight, level flight at y=0.5 (well below the deck's h=2.0), a
    // rocket-length segment (~1.33m) passing directly under the deck cell.
    const from = { x: 3.3, y: 0.5, z: 0 };
    const to = { x: 3.3 + 40 * (1 / 30), y: 0.5, z: 0 };
    expect(sweepProjectileSegment(from, to, hf)).toBeNull();
  });

  it("returns null for a clean flight high above open ground", () => {
    const hf = Heightfield.fromMapJson({
      meta: { tile_size: 1, level_height: 0.5, origin_offset: [0, 0, 0] },
      rect_fills: [{ asset: "terrain", x_min: -2, z_min: -2, x_max: 8, z_max: 2, y_level: 0, rot: 0 }],
    });
    const from = { x: 0, y: 3, z: 0 };
    const to = { x: 5, y: 3.5, z: 0 };
    expect(sweepProjectileSegment(from, to, hf)).toBeNull();
  });

  it("descending branch into flat ground — compatible with the old isBlockedByTerrain endpoint check", () => {
    const hf = Heightfield.fromMapJson({
      meta: { tile_size: 1, level_height: 0.5, origin_offset: [0, 0, 0] },
      rect_fills: [{ asset: "terrain", x_min: -2, z_min: -2, x_max: 2, z_max: 2, y_level: 0, rot: 0 }],
    });
    const from = { x: 0, y: 1, z: 0 };
    const to = { x: 0, y: -0.5, z: 0 };
    const result = sweepProjectileSegment(from, to, hf);
    expect(result).not.toBeNull();
    // Own-floor test fires at the first substep AT/BELOW ground (h=0), so the
    // hit lands within one substep (<=0.15m) of true ground level.
    expect(result!.hit.y).toBeGreaterThan(-0.2);
    expect(result!.hit.y).toBeLessThanOrEqual(0.01);
  });

  // (в) Static prop collider (SAT), 2026-07-10 follow-up: buildings/props
  // (src/shared/staticColliders.ts) were never checked for ANY projectile
  // server-side before this pass — server/config/arena.ts now builds
  // Arena.colliders once per map and passes it through here.
  it("catches a static prop collider (SAT, e.g. a building) at a rocket-length segment", () => {
    const hf = Heightfield.fromMapJson({
      meta: { tile_size: 1, level_height: 0.5, origin_offset: [0, 0, 0] },
      rect_fills: [{ asset: "terrain", x_min: -2, z_min: -2, x_max: 10, z_max: 2, y_level: 0, rot: 0 }],
    });
    // A 1x1m building footprint straddling x=1, well within the wide-open
    // flat terrain above (no heightfield wall/deck involved at all) — only
    // the SAT prop check can catch this.
    const building = makeAabb(1, 0, 0.5, 0.5);
    const from = { x: 0.3, y: 0.5, z: 0 };
    const to = { x: 0.3 + 40 * (1 / 30), y: 0.5, z: 0 }; // ~1.633, straight through the building
    const result = sweepProjectileSegment(from, to, hf, [building]);
    expect(result).not.toBeNull();
    expect(result!.hit.x).toBeGreaterThanOrEqual(0.5);
    expect(result!.hit.x).toBeLessThanOrEqual(1.5);
  });

  it("without colliders, the same segment sails through where a prop would have been", () => {
    const hf = Heightfield.fromMapJson({
      meta: { tile_size: 1, level_height: 0.5, origin_offset: [0, 0, 0] },
      rect_fills: [{ asset: "terrain", x_min: -2, z_min: -2, x_max: 10, z_max: 2, y_level: 0, rot: 0 }],
    });
    const from = { x: 0.3, y: 0.5, z: 0 };
    const to = { x: 0.3 + 40 * (1 / 30), y: 0.5, z: 0 };
    expect(sweepProjectileSegment(from, to, hf)).toBeNull();
  });

  // 2026-07-10 owner review: "проп-коллайдер без Y-гейта = невидимая колонна
  // до неба — динамит, перелетающий камень/низкую постройку по высокой дуге,
  // прилипнет в воздухе над ним". worldTopY gates the SAT check so a
  // projectile flying entirely ABOVE the prop's own baked top clears it.
  describe("worldTopY gate", () => {
    const hf = Heightfield.fromMapJson({
      meta: { tile_size: 1, level_height: 0.5, origin_offset: [0, 0, 0] },
      rect_fills: [{ asset: "terrain", x_min: -2, z_min: -2, x_max: 10, z_max: 2, y_level: 0, rot: 0 }],
    });
    // A 1x1m building footprint at x=1, 1.2m tall (worldTopY=1.2).
    const building = { ...makeAabb(1, 0, 0.5, 0.5), worldTopY: 1.2 };

    it("a segment flying entirely ABOVE the prop's worldTopY clears it — returns null", () => {
      const from = { x: 0.3, y: 1.5, z: 0 }; // above worldTopY=1.2
      const to = { x: 0.3 + 40 * (1 / 30), y: 1.5, z: 0 };
      expect(sweepProjectileSegment(from, to, hf, [building])).toBeNull();
    });

    it("a segment flying through the prop's footprint BELOW worldTopY still hits it", () => {
      const from = { x: 0.3, y: 0.5, z: 0 }; // below worldTopY=1.2
      const to = { x: 0.3 + 40 * (1 / 30), y: 0.5, z: 0 };
      const result = sweepProjectileSegment(from, to, hf, [building]);
      expect(result).not.toBeNull();
      expect(result!.hit.x).toBeGreaterThanOrEqual(0.5);
      expect(result!.hit.x).toBeLessThanOrEqual(1.5);
    });

    it("a poly with NO worldTopY (stale/hand-built table) still blocks even when flying high — backward compat", () => {
      const noTopBuilding = makeAabb(1, 0, 0.5, 0.5); // no worldTopY field
      const from = { x: 0.3, y: 5, z: 0 };
      const to = { x: 0.3 + 40 * (1 / 30), y: 5, z: 0 };
      expect(sweepProjectileSegment(from, to, hf, [noTopBuilding])).not.toBeNull();
    });
  });
});
