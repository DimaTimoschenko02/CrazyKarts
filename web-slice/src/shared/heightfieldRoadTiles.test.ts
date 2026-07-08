// Road-tiles (Kenney 3D Road Tiles) branch of the heightfield — the
// data-driven physics contract between tools/bake-road-tiles.mjs's catalog
// and heightCellFor/sample. Concrete tiles pinned here:
//   roadTile_002 — flat ground (Stone), topMedian 0.63, physics exact
//   roadTile_003 — straight slope, authored ascent −X, base 0.63, rise 1.1
//   roadTile_045 — bridge (physics approx → flat at topMedian 1.69)
// If a rebake changes these numbers the assertions read them from the
// catalog itself — the tests pin BEHAVIOR (base offsets, rotation of the
// ascent, approx-as-flat), not hardcoded heights.
import { describe, expect, it } from "vitest";
import { Heightfield, heightCellFor, type MapJson } from "./heightfield";
import catalog from "./roadTilesCatalog.json";

interface Entry {
  topMedian: number;
  slope?: { ax: number; az: number; base: number; rise: number };
}
const CAT = catalog as unknown as Record<string, Entry>;

const LH = 1.1; // roads-preset level height

function mapWith(cells: MapJson["cells"]): Heightfield {
  return Heightfield.fromMapJson({
    meta: { tile_size: 3, level_height: LH, origin_offset: [0, 0, 0] },
    cells,
  });
}

describe("road tiles heightfield", () => {
  it("flat tile: surface = y_level * level_height + topMedian", () => {
    const cell = heightCellFor("roadTile_002", 0, 0, LH);
    expect(cell.base).toBeCloseTo(CAT.roadTile_002.topMedian, 5);
    expect(cell.rise).toBe(0);

    const stacked = heightCellFor("roadTile_002", 2, 0, LH);
    expect(stacked.base).toBeCloseTo(2 * LH + CAT.roadTile_002.topMedian, 5);
  });

  it("slope tile rot=0: ascends along the authored −X direction", () => {
    const slope = CAT.roadTile_003.slope!;
    expect(slope.ax).toBe(-1); // authored ascent (uniform across the pack's straight slopes)
    const hf = mapWith([{ asset: "roadTile_003", x: 0, z: 0, y_level: 0 }]);
    // Cell 0 at tile_size 3, origin 0 → world center (0,0); edges at ±1.5.
    const low = hf.sample(1.4, 0)!; // +X side = LOW edge for a −X ascent
    const high = hf.sample(-1.4, 0)!;
    expect(high).toBeGreaterThan(low);
    // Clamped ramp reaches base/base+rise exactly AT the edges.
    expect(hf.sample(1.499, 0)!).toBeCloseTo(slope.base, 2);
    expect(hf.sample(-1.499, 0)!).toBeCloseTo(slope.base + slope.rise, 2);
  });

  it("slope tile rot=90: ascent rotates with the mesh (−X → +Z, same convention as the legacy ramp tables)", () => {
    const slope = CAT.roadTile_003.slope!;
    const hf = mapWith([{ asset: "roadTile_003", x: 0, z: 0, y_level: 0, rot: 90 }]);
    // three.js rotation.y=+90° maps local (−1,0) to world (0,+1) — the same
    // R_y convention the verified legacy tables encode (rotateVec(0,1,90) =
    // (1,0) reproduces RAMP_ASCENT[90]). So ascent lands on +Z here.
    expect(hf.sample(0, 1.499)!).toBeCloseTo(slope.base + slope.rise, 2);
    expect(hf.sample(0, -1.499)!).toBeCloseTo(slope.base, 2);
  });

  it("slope high edge meets the next level's flat tile with no physics lip", () => {
    const flatTop = CAT.roadTile_002.topMedian;
    const slope = CAT.roadTile_003.slope!;
    // Slope at y_level 0 ascending −X; flat tile one level up on the −X side.
    const hf = mapWith([
      { asset: "roadTile_003", x: 0, z: 0, y_level: 0 },
      { asset: "roadTile_002", x: -1, z: 0, y_level: 1 },
    ]);
    const slopeEdge = hf.sample(-1.499, 0)!;
    const flatEdge = hf.sample(-1.501, 0)!;
    // base(0.63) + rise(1.1) vs LH(1.1) + topMedian(0.63) — same by construction.
    expect(Math.abs(slopeEdge - flatEdge)).toBeLessThan(0.02);
    expect(flatEdge).toBeCloseTo(LH + flatTop, 5);
    void slope;
  });

  it("approx tiles (bridge) are flat at topMedian — drive OVER works, drive UNDER deferred", () => {
    const cell = heightCellFor("roadTile_045", 0, 0, LH);
    expect(cell.rise).toBe(0);
    expect(cell.base).toBeCloseTo(CAT.roadTile_045.topMedian, 5);
  });

  it("unknown roadTile falls back to flat at the cell base instead of throwing", () => {
    const cell = heightCellFor("roadTile_999", 1, 0, LH);
    expect(cell.base).toBeCloseTo(LH, 5);
    expect(cell.rise).toBe(0);
  });
});
