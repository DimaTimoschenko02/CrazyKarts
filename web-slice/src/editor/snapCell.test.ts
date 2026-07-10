import { describe, expect, it } from "vitest";
import { snapOffsetFromSurface, worldPointToCell, snapLevelCapY, resolveSnapPlacement } from "./snapCell";
import { Heightfield, tileBottomY, type MapJson } from "../shared/heightfield";

describe("worldPointToCell", () => {
  it("world origin maps to the grid's center cell", () => {
    // gridSize=32 -> half=15.5, tileSize=3 -> (0,0) is cell space (15.5,15.5) -> rounds to (16,16)
    expect(worldPointToCell(0, 0, 3, 15.5, 32)).toEqual({ x: 16, z: 16 });
  });

  it("round-trips a cell's own center back to itself", () => {
    const tileSize = 3;
    const half = 15.5;
    const gridSize = 32;
    for (const cell of [0, 5, 16, 31]) {
      const worldX = (cell - half) * tileSize;
      expect(worldPointToCell(worldX, 0, tileSize, half, gridSize).x).toBe(cell);
    }
  });

  it("rounds a point that lands between two cell centers to the nearest one", () => {
    const tileSize = 3;
    const half = 15.5;
    // Halfway between cell 16 and 17's centers, nudged slightly toward 17.
    const worldX = (16.6 - half) * tileSize;
    expect(worldPointToCell(worldX, 0, tileSize, half, 32).x).toBe(17);
  });

  it("clamps points outside the grid to the nearest edge cell", () => {
    const tileSize = 1;
    const half = 15.5;
    const gridSize = 32;
    expect(worldPointToCell(-1000, -1000, tileSize, half, gridSize)).toEqual({ x: 0, z: 0 });
    expect(worldPointToCell(1000, 1000, tileSize, half, gridSize)).toEqual({ x: 31, z: 31 });
  });

  it("works with the road-tiles preset metrics (tileSize=3, levelHeight irrelevant here)", () => {
    // A point clearly inside cell (10, 20) on a 3m grid.
    const half = 15.5;
    const worldX = (10 - half) * 3 + 0.9; // 0.9m off-center, still inside the 3m cell
    const worldZ = (20 - half) * 3 - 1.1;
    expect(worldPointToCell(worldX, worldZ, 3, half, 32)).toEqual({ x: 10, z: 20 });
  });
});

describe("snapOffsetFromSurface — snap-to-surface fractional y_offset", () => {
  // Roads-preset regression for the owner bug (2026-07-10, roads_v1.json):
  // a roadTile_019 tree snapped onto a grass tile must land its bottom on the
  // grass TOP (0.55m), not sink under it. Reproduces the exact editor math:
  // per-map meta tile_size=3 / level_height=1.1, heightfield built from the
  // map, bottomY from the catalog.
  const TILE_SIZE = 3;
  const LEVEL_HEIGHT = 1.1;
  const HALF = 31.5; // GRID_SIZE 64, origin_offset = -HALF*TILE_SIZE = -94.5 (roads_v1's actual meta)
  const roadsMap: MapJson = {
    meta: { tile_size: TILE_SIZE, level_height: LEVEL_HEIGHT, origin_offset: [-HALF * TILE_SIZE, 0, -HALF * TILE_SIZE] },
    cells: [
      // roadTile_163: flat "exact" grass, walkable top 0.55m above the pivot.
      { asset: "roadTile_163", x: 37, z: 41, y_level: 0, rot: 0 },
    ],
  };

  it("puts a roadTile_019 tree's bottom on a grass tile's 0.55m top (offset = +0.55)", () => {
    const hf = Heightfield.fromMapJson(roadsMap);
    const worldX = (37 - HALF) * TILE_SIZE;
    const worldZ = (41 - HALF) * TILE_SIZE;
    const floorHeight = hf.sample(worldX, worldZ);
    expect(floorHeight).toBeCloseTo(0.55, 6); // grass top, sanity check the fixture
    // Regression guard: roadTile_019's mesh bottom is its pivot plane (0),
    // NOT the 1.577 minimum of its walkable-top heightGrid the buggy version
    // subtracted (which produced offset ≈ -1.03 — tree sunk under the grass).
    expect(tileBottomY("roadTile_019")).toBe(0);
    const offset = snapOffsetFromSurface({
      floorHeight,
      yLevel: 0,
      levelHeight: LEVEL_HEIGHT,
      bottomY: tileBottomY("roadTile_019"),
    });
    expect(offset).toBeCloseTo(0.55, 6);
  });

  it("accounts for the target y_level (placing at y_level 1 on the same 0.55m grass)", () => {
    const offset = snapOffsetFromSurface({ floorHeight: 0.55, yLevel: 1, levelHeight: LEVEL_HEIGHT, bottomY: 0 });
    // base = 1*1.1 + 0 = 1.1 → shift down onto the grass top.
    expect(offset).toBeCloseTo(0.55 - 1.1, 6);
  });

  it("returns null (NOT a silent 0) when there is no surface to snap to", () => {
    const hf = Heightfield.fromMapJson(roadsMap);
    const emptyX = (5 - HALF) * TILE_SIZE; // cell (5, 5) has nothing authored
    expect(hf.sample(emptyX, emptyX)).toBeNull();
    const offset = snapOffsetFromSurface({
      floorHeight: hf.sample(emptyX, emptyX),
      yLevel: 0,
      levelHeight: LEVEL_HEIGHT,
      bottomY: tileBottomY("roadTile_019"),
    });
    expect(offset).toBeNull();
  });

  it("falls back to the pivot as the bottom for non-catalog (space-kit) assets", () => {
    expect(tileBottomY("terrain")).toBeNull();
    const offset = snapOffsetFromSurface({ floorHeight: 0.5, yLevel: 0, levelHeight: 0.5, bottomY: null });
    expect(offset).toBeCloseTo(0.5, 6);
  });
});

describe("snapLevelCapY — highest surface the snap picker may target (regression #1, Q/E dead in snap mode)", () => {
  const LEVEL_HEIGHT = 1.1; // roads preset

  it("caps at the top of the active level's band (plus epsilon)", () => {
    expect(snapLevelCapY(0, LEVEL_HEIGHT)).toBeCloseTo(1.11, 6);
    expect(snapLevelCapY(2, LEVEL_HEIGHT)).toBeCloseTo(3.3 + 0.01, 6);
  });

  it("rejects a bridge deck above the active level but accepts the floor beneath it", () => {
    // Deck top at 2.2 (level 2 boundary), floor top at 0.55, user on y_level 0.
    const cap = snapLevelCapY(0, LEVEL_HEIGHT);
    expect(2.2 <= cap).toBe(false); // deck hit filtered out
    expect(0.55 <= cap).toBe(true); // floor hit accepted
  });

  it("accepts a surface sitting exactly on the level boundary (epsilon)", () => {
    // A full-height block top lands exactly at (yLevel+1)*levelHeight —
    // float-exact boundary must still be targetable at that level.
    expect(1.1 <= snapLevelCapY(0, LEVEL_HEIGHT)).toBe(true);
  });
});

describe("resolveSnapPlacement — layer bump so snap never overwrites its support (regression #2)", () => {
  const LEVEL_HEIGHT = 1.1; // roads preset (tile_size 3 irrelevant here)

  it("tree glued onto grass: support at y_level 0 stays, tree lands on y_level 1 with y_offset -0.55", () => {
    // Grass at (x,z,0), walkable top 0.55m; tree's mesh bottom is its pivot (0).
    const occupied = new Set([0]);
    const placed = resolveSnapPlacement({
      yLevel: 0,
      levelHeight: LEVEL_HEIGHT,
      floorHeight: 0.55,
      bottomY: 0,
      isLevelOccupied: lvl => occupied.has(lvl),
    });
    expect(placed.yLevel).toBe(1);
    expect(placed.yOffset).toBeCloseTo(-0.55, 6);
    // World bottom is unchanged by the bump: still exactly the grass top.
    expect(placed.yLevel * LEVEL_HEIGHT + 0 + placed.yOffset).toBeCloseTo(0.55, 6);
  });

  it("keeps the requested level when it is free (no support cell in the way)", () => {
    const placed = resolveSnapPlacement({
      yLevel: 0,
      levelHeight: LEVEL_HEIGHT,
      floorHeight: 0.55,
      bottomY: 0,
      isLevelOccupied: () => false,
    });
    expect(placed.yLevel).toBe(0);
    expect(placed.yOffset).toBeCloseTo(0.55, 6);
  });

  it("skips PAST several occupied layers to the first free one, world height still unchanged", () => {
    const occupied = new Set([0, 1, 2]);
    const placed = resolveSnapPlacement({
      yLevel: 0,
      levelHeight: LEVEL_HEIGHT,
      floorHeight: 2.75, // top of a 2.5-level stack
      bottomY: 0,
      isLevelOccupied: lvl => occupied.has(lvl),
    });
    expect(placed.yLevel).toBe(3);
    expect(placed.yOffset).toBeCloseTo(2.75 - 3 * LEVEL_HEIGHT, 6);
    expect(placed.yLevel * LEVEL_HEIGHT + placed.yOffset).toBeCloseTo(2.75, 6);
  });

  it("accounts for a non-zero baked bottom (bottomY) in the recomputed offset", () => {
    const placed = resolveSnapPlacement({
      yLevel: 0,
      levelHeight: LEVEL_HEIGHT,
      floorHeight: 0.55,
      bottomY: 0.2,
      isLevelOccupied: lvl => lvl === 0,
    });
    // worldBottom = yLevel*LH + bottomY + yOffset must equal floorHeight.
    expect(placed.yLevel).toBe(1);
    expect(placed.yLevel * LEVEL_HEIGHT + 0.2 + placed.yOffset).toBeCloseTo(0.55, 6);
  });

  it("null bottomY (space-kit pivot-bottom asset) behaves as bottomY 0", () => {
    const placed = resolveSnapPlacement({
      yLevel: 0,
      levelHeight: 0.5,
      floorHeight: 0.5,
      bottomY: null,
      isLevelOccupied: lvl => lvl === 0,
    });
    expect(placed.yLevel).toBe(1);
    expect(placed.yOffset).toBeCloseTo(0, 6);
  });

  it("terminates via maxLevels against a pathological always-occupied column", () => {
    const placed = resolveSnapPlacement({
      yLevel: 0,
      levelHeight: 1.1,
      floorHeight: 0.55,
      bottomY: 0,
      isLevelOccupied: () => true,
      maxLevels: 8,
    });
    expect(placed.yLevel).toBe(8);
  });
});
