// Heightfield math is physics-critical (kart height follow + wall blocking),
// so the cell→height rules are pinned here. Slope tables come from
// .claude/rules/map-building.md; the sideCorner quirk (ramp-like Y span) was
// verified by a vertex read of the raw GLB in the browser (2026-07-06).
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { GameMap, type MapJson } from "./mapLoader";

// Placement templates are irrelevant for height math — use empty groups.
function stubLib(names: string[]): Map<string, THREE.Group> {
  return new Map(names.map(n => [n, new THREE.Group()]));
}

const LIB = stubLib([
  "terrain", "terrain_ramp", "terrain_side", "terrain_sideCorner", "terrain_roadStraight", "terrain_sideCliff",
]);

function makeMap(cells: MapJson["cells"], rects: MapJson["rect_fills"] = []): GameMap {
  return GameMap.fromJson(
    {
      meta: { tile_size: 1, level_height: 0.5, origin_offset: [0, 0, 0] },
      rect_fills: rects,
      cells,
    },
    LIB
  );
}

describe("GameMap heightfield", () => {
  it("flat terrain: top surface at y_level * level_height, roads identical", () => {
    const map = makeMap([
      { asset: "terrain", x: 0, z: 0, y_level: 0 },
      { asset: "terrain", x: 1, z: 0, y_level: 2 },
      { asset: "terrain_roadStraight", x: 2, z: 0, y_level: 1, rot: 90 },
    ]);
    expect(map.sampleHeight(0, 0)).toBe(0);
    expect(map.sampleHeight(1, 0)).toBe(1.0);
    expect(map.sampleHeight(2, 0)).toBe(0.5);
  });

  it("off-map and between maps returns null (wall for the mover)", () => {
    const map = makeMap([{ asset: "terrain", x: 0, z: 0, y_level: 0 }]);
    expect(map.sampleHeight(5, 5)).toBeNull();
    expect(map.sampleHeight(-1.2, 0)).toBeNull();
  });

  // NB: cells are pivot-centered — cell (0,0) spans world [-0.5, 0.5); probes
  // sit at ±0.4 because exactly ±0.5 rounds into the (empty) neighbor cell.
  //
  // Ramp shares its ascent basis with terrain_side (+Z at rot=0) — verified by
  // direct GLB vertex inspection (tools/glb-catalog.mjs). An earlier version of
  // this test pinned a table that was rotated 90° off from the real mesh (ramp
  // ascended +X here while the rendered mesh actually rose along +Z) — see
  // docs/space-kit-terrain-catalog.md for the full discrepancy writeup.
  it("ramp rot=0 ascends +Z from its LOW y_level", () => {
    const map = makeMap([{ asset: "terrain_ramp", x: 0, z: 0, y_level: 0, rot: 0 }]);
    expect(map.sampleHeight(0, -0.4)).toBeCloseTo(0.05, 5); // near low edge
    expect(map.sampleHeight(0, 0)).toBeCloseTo(0.25, 5); // mid
    expect(map.sampleHeight(0, 0.4)).toBeCloseTo(0.45, 5); // near high edge
  });

  it("ramp rot=90 ascends +X from its LOW y_level", () => {
    const map = makeMap([{ asset: "terrain_ramp", x: 0, z: 0, y_level: 0, rot: 90 }]);
    expect(map.sampleHeight(-0.4, 0)).toBeCloseTo(0.05, 5); // near low edge
    expect(map.sampleHeight(0, 0)).toBeCloseTo(0.25, 5); // mid
    expect(map.sampleHeight(0.4, 0)).toBeCloseTo(0.45, 5); // near high edge
  });

  it("side rot=0 descends -Z from its HIGH y_level", () => {
    const map = makeMap([{ asset: "terrain_side", x: 0, z: 0, y_level: 1, rot: 0 }]);
    expect(map.sampleHeight(0, 0.4)).toBeCloseTo(0.45, 5); // near high edge (+Z)
    expect(map.sampleHeight(0, 0)).toBeCloseTo(0.25, 5);
    expect(map.sampleHeight(0, -0.4)).toBeCloseTo(0.05, 5); // near low edge (-Z)
  });

  it("sideCorner rot=90 rises diagonally toward +X+Z from its LOW y_level", () => {
    const map = makeMap([{ asset: "terrain_sideCorner", x: 0, z: 0, y_level: 0, rot: 90 }]);
    const high = map.sampleHeight(0.4, 0.4)!; // toward plateau-side corner
    const mid = map.sampleHeight(0, 0)!;
    const low = map.sampleHeight(-0.4, -0.4)!;
    expect(high).toBeCloseTo(0.5, 5); // diagonal ramp saturates at the corner
    expect(mid).toBeCloseTo(0.25, 5);
    expect(low).toBeLessThan(0.05);
  });

  it("rect_fills expand to every covered cell; later entries override earlier", () => {
    const map = makeMap(
      [{ asset: "terrain", x: 1, z: 1, y_level: 2 }],
      [{ asset: "terrain", x_min: 0, z_min: 0, x_max: 2, z_max: 2, y_level: 0, rot: 0 }]
    );
    expect(map.sampleHeight(0, 2)).toBe(0); // rect ground
    expect(map.sampleHeight(1, 1)).toBe(1.0); // overridden by the cell
  });

  // terrain_sideCliff ("крутой обрыв") is a DRIVABLE steep slope — see
  // shared/heightfield.ts isWallOnlyAsset doc. It was briefly made wall-only,
  // then reverted (game-designer decision, 2026-07): walls are now
  // exclusively the wall_block* procedural family. Same axial ascent basis
  // as terrain_side (straight low/high edges, not diagonal), but y_level
  // means the LOW edge (geometry sits above the pivot, ramp-like) instead of
  // plain side's HIGH-edge/below-pivot semantics.
  it("terrain_sideCliff rot=90 ascends +X from its LOW y_level, next to a flat plateau", () => {
    const map = makeMap([
      { asset: "terrain", x: 1, z: 0, y_level: 1 },
      { asset: "terrain_sideCliff", x: 0, z: 0, y_level: 0, rot: 90 },
    ]);
    expect(map.sampleHeight(-0.4, 0)).toBeCloseTo(0.05, 1); // near low edge (-X)
    expect(map.sampleHeight(0.4, 0)).toBeCloseTo(0.45, 1); // near high edge (+X)
    expect(map.sampleHeight(1, 0)).toBeCloseTo(0.5, 6); // the plateau top itself is unaffected
  });

  it("terrain_sideCliff + a flat cap in the SAME column is still walkable, at the cap's height", () => {
    // Stacking a flat "terrain" layer on top of a cliff still works —
    // sample()'s per-column MAX means the cap wins wherever it's higher than
    // the (now genuinely drivable) cliff slope beneath it.
    const map = makeMap([
      { asset: "terrain_sideCliff", x: 0, z: 0, y_level: 0, rot: 0 },
      { asset: "terrain", x: 0, z: 0, y_level: 1 },
    ]);
    expect(map.sampleHeight(0, 0)).toBeCloseTo(0.5, 6);
  });
});

// Static prop collision — see .claude/rules/map-building.md "Props" and the
// STRUCTURAL_PROP_ASSETS / NATURAL_DECOR_ASSETS doc comments in mapLoader.ts
// for the two-tier model this pins: buildings/rockets/heavy machinery are
// unconditionally solid (family-curated), natural-terrain decor (rocks/
// crystals/meteors/craters/bones) is SIZE-DERIVED from measured footprint
// diameter + height (owner report 2026-07-08 — replaced an inconsistent
// hand-maintained include/exclude list, see git history for the prior
// LARGE_PROP_ASSETS set this superseded).
describe("GameMap static prop obstacles", () => {
  // A template's footprint/height is whatever geometry it carries — real
  // asset templates are recentered on XZ by assetLoader.ts before they ever
  // reach GameMap, so a Box3 built here (already centered at the mesh's
  // local origin) is representative of what placeProp() actually sees at
  // runtime. sizeY defaults to 1 (irrelevant for STRUCTURAL_PROP_ASSETS,
  // which don't gate on height) but is set explicitly for every
  // NATURAL_DECOR_ASSETS template below to mirror the real measured AABBs
  // documented in mapLoader.ts.
  function boxTemplate(sizeX: number, sizeZ: number, sizeY = 1): THREE.Group {
    const group = new THREE.Group();
    group.add(new THREE.Mesh(new THREE.BoxGeometry(sizeX, sizeY, sizeZ)));
    return group;
  }

  function libWithProps(): Map<string, THREE.Group> {
    return new Map<string, THREE.Group>([
      ["terrain", new THREE.Group()],
      // STRUCTURAL_PROP_ASSETS — unconditionally solid, no height gate.
      ["corridor", boxTemplate(1.0, 1.0)],
      // NATURAL_DECOR_ASSETS — real measured (diam, height) pairs, see the
      // doc comment in mapLoader.ts for the source measurements.
      ["rock_largeA", boxTemplate(2.0, 1.2, 0.5)], // non-square footprint, max dim = x, real height class
      ["rock_largeB", boxTemplate(0.939, 0.928, 0.5)], // bug fix: missing from the old LARGE_PROP_ASSETS set
      ["rock_crystalsLargeA", boxTemplate(1.0, 1.6, 0.541)], // max dim = z
      ["rock", boxTemplate(0.851, 0.801, 0.3)], // real footprint is NOT tiny (~0.85m) — stays decor via the HEIGHT gate (0.3 < 0.35), not diameter
      ["rocks_smallA", boxTemplate(0.937, 0.87, 0.105)], // flat pebble scatter — wide footprint, decor via height gate
      ["meteor", boxTemplate(0.866, 0.75, 0.735)], // new: solid chunk, same scale as rock_largeA
      ["crater", boxTemplate(0.826, 0.715, 0.118)], // flat ground decal — decor via height gate
      ["bones", boxTemplate(0.861, 0.582, 0.442)], // clears BOTH thresholds but explicitly excepted (scattered pile, not real mass)
      ["desk_chair", boxTemplate(0.15, 0.15, 0.294)], // not in either set at all — never gets an obstacle
    ]);
  }

  function makePropMap(props: MapJson["props"], originOffset: [number, number, number] = [0, 0, 0]): GameMap {
    return GameMap.fromJson(
      {
        meta: { tile_size: 1, level_height: 0.5, origin_offset: originOffset },
        props,
      },
      libWithProps()
    );
  }

  it("structural prop (corridor) gets a collision circle at its world position, scaled and shrunk", () => {
    const map = makePropMap([{ asset: "corridor", x: 3, z: -2, y_level: 1, scale: 0.8 }], [-1, 0, 0.5]);
    const obstacles = map.getStaticObstacles();
    expect(obstacles).toHaveLength(1);
    // world x = 3*1 + (-1) = 2, world z = -2*1 + 0.5 = -1.5.
    expect(obstacles[0].x).toBeCloseTo(2, 6);
    expect(obstacles[0].z).toBeCloseTo(-1.5, 6);
    expect(obstacles[0].alive).toBe(true);
    // footprint max(1.0, 1.0) = 1.0 → radius = (1.0/2) * 0.8(scale) * 0.8(shrink) = 0.32.
    expect(obstacles[0].radius).toBeCloseTo(0.32, 6);
  });

  it("large natural-decor prop (rock_largeA) gets a collision circle, scaled and shrunk", () => {
    const map = makePropMap([{ asset: "rock_largeA", x: 0, z: 0, y_level: 0, scale: 0.8 }]);
    const obstacles = map.getStaticObstacles();
    expect(obstacles).toHaveLength(1);
    // footprint max(2.0, 1.2) = 2.0 → radius = (2.0/2) * 0.8(scale) * 0.8(shrink) = 0.64.
    expect(obstacles[0].radius).toBeCloseTo(0.64, 6);
  });

  it("uses max(size.x, size.z) regardless of which axis is longer", () => {
    const map = makePropMap([{ asset: "rock_crystalsLargeA", x: 0, z: 0, y_level: 0, scale: 1 }]);
    // footprint max(1.0, 1.6) = 1.6 → radius = (1.6/2) * 1 * 0.8 = 0.64.
    expect(map.getStaticObstacles()[0].radius).toBeCloseTo(0.64, 6);
  });

  it("bug fix: rock_largeB (same scale as rock_largeA) now gets a collision circle", () => {
    // Was silently missing from the old hand-maintained LARGE_PROP_ASSETS
    // set despite being near-identical in size to rock_largeA/B's siblings.
    const map = makePropMap([{ asset: "rock_largeB", x: 0, z: 0, y_level: 0 }]);
    expect(map.getStaticObstacles()).toHaveLength(1);
    expect(map.getStaticObstacles()[0].radius).toBeCloseTo((0.939 / 2) * 0.8, 6);
  });

  it("meteor family gets a collision circle now (was entirely excluded before)", () => {
    const map = makePropMap([{ asset: "meteor", x: 0, z: 0, y_level: 0 }]);
    expect(map.getStaticObstacles()).toHaveLength(1);
  });

  it("wide-but-flat natural decor (rock, rocks_smallA, crater) stays walk-through despite footprint above the diameter floor", () => {
    const map = makePropMap([
      { asset: "rock", x: 1, z: 1, y_level: 0 }, // diam 0.851 clears MIN_OBSTACLE_DIAMETER, height 0.3 fails MIN_OBSTACLE_HEIGHT
      { asset: "rocks_smallA", x: 2, z: 2, y_level: 0 }, // diam 0.937 clears, height 0.105 fails
      { asset: "crater", x: 3, z: 3, y_level: 0 }, // diam 0.826 clears, height 0.118 fails
    ]);
    expect(map.getStaticObstacles()).toHaveLength(0);
  });

  it("bones stays walk-through via the explicit exception even though it clears both thresholds", () => {
    // bones: diam 0.861 >= 0.6, height 0.442 >= 0.35 — would pass the
    // generic size gate, but is explicitly excepted (see DECOR_HEIGHT_EXCEPTIONS).
    const map = makePropMap([{ asset: "bones", x: 0, z: 0, y_level: 0 }]);
    expect(map.getStaticObstacles()).toHaveLength(0);
  });

  it("a prop outside both STRUCTURAL_PROP_ASSETS and NATURAL_DECOR_ASSETS never gets an obstacle regardless of size", () => {
    const map = makePropMap([{ asset: "desk_chair", x: 0, z: 0, y_level: 0 }]);
    expect(map.getStaticObstacles()).toHaveLength(0);
  });

  it("scaling a natural-decor prop below MIN_OBSTACLE_DIAMETER drops its obstacle (small object -> no collision)", () => {
    // rock_largeA scaled down to 0.2: diam = 2.0*0.2 = 0.4 < 0.6 -> decor.
    const map = makePropMap([{ asset: "rock_largeA", x: 0, z: 0, y_level: 0, scale: 0.2 }]);
    expect(map.getStaticObstacles()).toHaveLength(0);
  });

  it("scaling a structural prop below MIN_OBSTACLE_DIAMETER also drops its obstacle", () => {
    // corridor scaled to 0.3: diam = 1.0*0.3 = 0.3 < 0.6 -> no obstacle even though it's STRUCTURAL.
    const map = makePropMap([{ asset: "corridor", x: 0, z: 0, y_level: 0, scale: 0.3 }]);
    expect(map.getStaticObstacles()).toHaveLength(0);
  });

  it("defaults to scale 1 when a natural-decor prop omits it", () => {
    const map = makePropMap([{ asset: "rock_largeA", x: 0, z: 0, y_level: 0 }]);
    // radius = (2.0/2) * 1(default scale) * 0.8 = 0.8.
    expect(map.getStaticObstacles()[0].radius).toBeCloseTo(0.8, 6);
  });

  it("a map with no qualifying props exposes an empty static obstacle list", () => {
    const map = makeMap([{ asset: "terrain", x: 0, z: 0, y_level: 0 }]);
    expect(map.getStaticObstacles()).toEqual([]);
  });
});
