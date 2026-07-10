import { describe, expect, it } from "vitest";
import { snapOffsetFromSurface, worldPointToCell } from "./snapCell";
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
