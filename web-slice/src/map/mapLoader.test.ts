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

// Static collision (collision-v2 rework) — the actual shape math (SAT
// polygon placement, size gates, structural-vs-decor classification) is
// pinned exhaustively in shared/staticColliders.test.ts, which is pure and
// doesn't need a THREE scene. This section only checks GameMap's END-TO-END
// WIRING: fromJson() must actually call buildStaticColliders() with the REAL
// committed shared/collisionShapes.json table (not a THREE Box3 measured
// from the visual template — that per-prop-circle path was removed
// entirely, see design/notes/collision-v2.md §2.3/§8) and expose the result
// via getStaticColliders().
describe("GameMap static colliders — end-to-end wiring to shared/staticColliders.ts", () => {
  function libWithProps(): Map<string, THREE.Group> {
    return new Map<string, THREE.Group>([
      ["terrain", new THREE.Group()],
      ["corridor", new THREE.Group()], // structural — real shape comes from collisionShapes.json, not this template
      ["rock_largeA", new THREE.Group()], // natural decor — same
      ["desk_chair", new THREE.Group()], // neither set — never gets a collider regardless of the JSON table
    ]);
  }

  function makePropMap(props: MapJson["props"]): GameMap {
    return GameMap.fromJson(
      { meta: { tile_size: 1, level_height: 0.5, origin_offset: [0, 0, 0] }, props },
      libWithProps()
    );
  }

  it("a structural prop (corridor) gets a real SAT collider from the baked shapes table", () => {
    const map = makePropMap([{ asset: "corridor", x: 3, z: -2, y_level: 1 }]);
    const colliders = map.getStaticColliders();
    expect(colliders.length).toBeGreaterThanOrEqual(1);
    // Vertex count 4 = OBB (structural), per collisionShapes.json's baked type.
    expect(colliders[0].verts).toHaveLength(4);
  });

  it("a natural-decor prop (rock_largeA) gets a hull collider (>=3 verts, baked from the real GLB)", () => {
    const map = makePropMap([{ asset: "rock_largeA", x: 0, z: 0, y_level: 0 }]);
    const colliders = map.getStaticColliders();
    expect(colliders.length).toBeGreaterThanOrEqual(1);
    expect(colliders[0].verts.length).toBeGreaterThanOrEqual(3);
  });

  it("a prop outside both STRUCTURAL/NATURAL_DECOR sets never gets a collider", () => {
    const map = makePropMap([{ asset: "desk_chair", x: 0, z: 0, y_level: 0 }]);
    expect(map.getStaticColliders()).toHaveLength(0);
  });

  it("a map with no qualifying props/walls exposes an empty static collider list", () => {
    const map = makeMap([{ asset: "terrain", x: 0, z: 0, y_level: 0 }]);
    expect(map.getStaticColliders()).toEqual([]);
  });

  it("wall_block cells get NO static collider — drivable cubes since 2026-07-08, sides owned by the MAX_STEP path", () => {
    const map = GameMap.fromJson(
      {
        meta: { tile_size: 1, level_height: 0.5, origin_offset: [0, 0, 0] },
        cells: [{ asset: "wall_block", x: 2, z: 0, y_level: 0 }],
      },
      new Map<string, THREE.Group>([["wall_block", new THREE.Group()], ["terrain", new THREE.Group()]])
    );
    expect(map.getStaticColliders()).toHaveLength(0);
    // ...and the cube TOP is walkable ground instead.
    expect(map.sampleHeight(2, 0)).toBeCloseTo(0.5);
  });

  it("hasColumn distinguishes a wall_block cell (true, walkable top) from a genuine off-map spot (false)", () => {
    const map = GameMap.fromJson(
      {
        meta: { tile_size: 1, level_height: 0.5, origin_offset: [0, 0, 0] },
        cells: [{ asset: "wall_block", x: 2, z: 0, y_level: 0 }],
      },
      new Map<string, THREE.Group>([["wall_block", new THREE.Group()]])
    );
    expect(map.hasColumn(2, 0)).toBe(true);
    expect(map.sampleHeight(2, 0)).toBeCloseTo(0.5);
    expect(map.hasColumn(50, 50)).toBe(false);
  });
});
