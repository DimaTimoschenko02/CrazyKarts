// Road-tiles (Kenney 3D Road Tiles) branch of the heightfield — the
// data-driven physics contract between tools/bake-road-tiles.mjs's catalog
// and heightCellFor/sample. Concrete tiles pinned here:
//   roadTile_002 — flat ground (Stone), topMedian 0.63, physics exact
//   roadTile_003 — straight slope, authored ascent −X, base 0.63, rise 1.1
//   roadTile_045 — bridge (physics approx → 12×12 sub-cell heightGrid)
// If a rebake changes these numbers the assertions read them from the
// catalog itself — the tests pin BEHAVIOR (base offsets, rotation of the
// ascent, approx-as-flat / approx-as-grid), not hardcoded heights.
import { describe, expect, it } from "vitest";
import { Heightfield, heightCellFor, type MapJson } from "./heightfield";
import catalog from "./roadTilesCatalog.json";

interface Entry {
  topMedian: number;
  slope?: { ax: number; az: number; base: number; rise: number };
  heightGrid?: number[][];
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
    expect(cell.grid).toBeUndefined(); // exact tiles never carry a sub-cell grid

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

  it("unknown roadTile falls back to flat at the cell base instead of throwing", () => {
    const cell = heightCellFor("roadTile_999", 1, 0, LH);
    expect(cell.base).toBeCloseTo(LH, 5);
    expect(cell.rise).toBe(0);
  });

  // ── sub-cell height grid (physics:"approx" tiles) ─────────────────────────
  // roadTile_045 (bridge) grid has two clearly distinct corners along its
  // local-X axis at local-Z index 0 (see tools/bake-road-tiles.mjs
  // sampleHeightGrid doc — grid[i][j], i ~ local X 0..3m window, j ~ local Z
  // −3..0m window): grid[0][0] is the flat approach (1.65-ish), grid[11][0]
  // dips to ground level under the span (0.6-ish) — a real height STEP a
  // kart driving off the tile's low-X edge should actually meet, unlike the
  // old flat-at-topMedian model.
  describe("sub-cell heightGrid (physics:approx tiles, e.g. bridges)", () => {
    const grid = CAT.roadTile_045.heightGrid!;
    const n = grid.length;
    const cornerLoX = grid[0][0]; // local X low edge, local Z low edge
    const cornerHiX = grid[n - 1][0]; // local X high edge, local Z low edge
    // D3a (2026-07-09): gridSample() is bilinear now (see heightfield.ts
    // doc), so a query has to land EXACTLY on a grid cell's own center to
    // read that cell's raw value with zero blend from its neighbors — the
    // old ±0.48 near-boundary probes below deliberately sat just OFF-center
    // (to prove "inside the corner cell, not the next one" under the old
    // point-sample model) and would now pick up a small, real blend from the
    // adjacent cell instead of matching the corner value exactly. EDGE below
    // is that exact per-axis cell-0 / cell-(n-1) center offset in world
    // meters (tile_size 3) — bilinear reduces to an exact point-sample AT a
    // cell's own center by construction (see gridSample() doc), so every
    // assertion here still pins the same rotation/mirror mapping the old
    // probes did, just anchored precisely instead of approximately.
    const EDGE = (0.5 - 0.5 / n) * 3;
    // Sanity: the two corners this test leans on are genuinely different —
    // otherwise a rebake could silently make every rot/mirror assertion below
    // pass by accident (both sides reading the same flat value).
    it("catalog sanity: the two probed corners differ", () => {
      expect(Math.abs(cornerHiX - cornerLoX)).toBeGreaterThan(0.5);
    });

    it("rot=0: heightCellFor returns the grid, bilinearly sampled by sample()", () => {
      const cell = heightCellFor("roadTile_045", 0, 0, LH);
      expect(cell.rise).toBe(0);
      expect(cell.grid).toBe(grid);
      const hf = mapWith([{ asset: "roadTile_045", x: 0, z: 0, y_level: 0 }]);
      // lx=lz=-EDGE sits exactly at grid cell (0,0)'s own center; lx=+EDGE at
      // cell (n-1,0)'s center.
      expect(hf.sample(-EDGE, -EDGE)!).toBeCloseTo(cornerLoX, 5);
      expect(hf.sample(EDGE, -EDGE)!).toBeCloseTo(cornerHiX, 5);
    });

    it("rot=90: grid rotates with the mesh (same R_y convention as the slope tests)", () => {
      const hf = mapWith([{ asset: "roadTile_045", x: 0, z: 0, y_level: 0, rot: 90 }]);
      // Forward transform world=rotateVec(local,rot) — verified against
      // RAMP_ASCENT/CORNER_ASCENT in heightfield.ts — maps local (nx,nz) to
      // world (lz=nx*... ) as (world_lx, world_lz) = (nz, -nx) at rot=90 (cos=0,
      // sin=1: [x*0+z*1, -x*1+z*0] = [z, -x]). Local (−EDGE,−EDGE) → world
      // (lx=−EDGE, lz=EDGE); local (+EDGE,−EDGE) → world (lx=−EDGE, lz=−EDGE).
      expect(hf.sample(-EDGE, EDGE)!).toBeCloseTo(cornerLoX, 5);
      expect(hf.sample(-EDGE, -EDGE)!).toBeCloseTo(cornerHiX, 5);
    });

    it("rot=180: grid flips fully (local low-X edge now reads on the world +X side)", () => {
      const hf = mapWith([{ asset: "roadTile_045", x: 0, z: 0, y_level: 0, rot: 180 }]);
      // rotateVec(x,z,180) = [-x,-z]: local (−EDGE,−EDGE) → world (EDGE,EDGE).
      expect(hf.sample(EDGE, EDGE)!).toBeCloseTo(cornerLoX, 5);
      expect(hf.sample(-EDGE, EDGE)!).toBeCloseTo(cornerHiX, 5);
    });

    it("rot=270 (−90): grid rotates the other way", () => {
      const hf = mapWith([{ asset: "roadTile_045", x: 0, z: 0, y_level: 0, rot: -90 }]);
      // rotateVec(x,z,270): cos=0,sin=-1 → [x*0+z*(-1), -x*(-1)+z*0] = [-z, x].
      // Local (−EDGE,−EDGE) → world (EDGE,−EDGE).
      expect(hf.sample(EDGE, -EDGE)!).toBeCloseTo(cornerLoX, 5);
      expect(hf.sample(EDGE, EDGE)!).toBeCloseTo(cornerHiX, 5);
    });

    it("mirror: reflects across local X BEFORE the rotation (matches mapLoader's TRS order)", () => {
      // Unrotated + mirrored: local X is negated before the (identity) rotation,
      // so the grid reads mirrored on the world-X axis — same corners swap as
      // an unmirrored rot=180 would produce on X alone (Z untouched).
      const hf = mapWith([{ asset: "roadTile_045", x: 0, z: 0, y_level: 0, mirror: true }]);
      expect(hf.sample(EDGE, -EDGE)!).toBeCloseTo(cornerLoX, 5);
      expect(hf.sample(-EDGE, -EDGE)!).toBeCloseTo(cornerHiX, 5);
    });

    it("mirror + rot=90: reflect-then-rotate composes (not commutative with rotate-then-reflect)", () => {
      const hf = mapWith([{ asset: "roadTile_045", x: 0, z: 0, y_level: 0, rot: 90, mirror: true }]);
      // Forward: world = rotateVec(-nx, nz, rot) (mirroredVec convention).
      // At rot=90: rotateVec(-x,z,90) = [z, x]. Local (−EDGE,−EDGE) →
      // world (lx=−EDGE, lz=−EDGE); local (+EDGE,−EDGE) → world (−EDGE,+EDGE).
      expect(hf.sample(-EDGE, -EDGE)!).toBeCloseTo(cornerLoX, 5);
      expect(hf.sample(-EDGE, EDGE)!).toBeCloseTo(cornerHiX, 5);
    });

    it("drive OVER a bridge deck works and reflects the real deck contour (not a flat plateau)", () => {
      // Regression check on the OLD "flat at topMedian" behavior this grid
      // replaces: topMedian ≠ every corner of the deck anymore, because the
      // deck genuinely isn't flat (it's an approach ramp on one side).
      const hf = mapWith([{ asset: "roadTile_045", x: 0, z: 0, y_level: 0 }]);
      const sampled = hf.sample(EDGE, -EDGE)!;
      expect(sampled).toBeCloseTo(cornerHiX, 5);
      expect(Math.abs(sampled - CAT.roadTile_045.topMedian)).toBeGreaterThan(0.5);
      // drive-under is still deferred (single column height per query — no
      // second, lower surface reported here) — unchanged scope, not tested.
    });

    it("y_level stacks a flat offset on top of the grid, same as the old topMedian branch", () => {
      const cell0 = heightCellFor("roadTile_045", 0, 0, LH);
      const cell2 = heightCellFor("roadTile_045", 2, 0, LH);
      expect(cell2.base - cell0.base).toBeCloseTo(2 * LH, 5);
      expect(cell2.grid).toBe(cell0.grid);
    });

    // D3a regression (design/notes/ride-collision-v2.md symptom #4, "грид-
    // лесенка"): sweeping across a grid-cell boundary must read as a smooth
    // ramp, not the old raw per-cell step (~10cm on this tile). This is what
    // actually fixes the ground-height chatter — see vertical.ts's rate/
    // position detachment, which used to spuriously fire on every one of
    // these steps.
    it("sweeping across a grid-cell boundary along X removes the old raw per-cell step (bilinear vs. the old nearest-cell point-sample)", () => {
      const hf = mapWith([{ asset: "roadTile_045", x: 0, z: 0, y_level: 0 }]);
      const zProbe = -0.4 * 3; // fixed Z, deep inside grid row j=0's span
      const steps = 200;
      const worldXAt = (k: number): number => -1.49 + (2.98 * k) / steps; // sweep nearly the whole tile width

      // Old behavior, reimplemented locally (point-sample, nearest grid
      // cell — exactly what gridSample() did before D3a): jumps a FULL
      // cell-to-cell delta the instant a query crosses a cell boundary.
      function oldPointSample(worldX: number): number {
        const lx = worldX / 3; // tile_size=3, origin 0
        const lz = zProbe / 3;
        const n = grid.length;
        const i = Math.min(Math.max(Math.floor((lx + 0.5) * n), 0), n - 1);
        const j = Math.min(Math.max(Math.floor((lz + 0.5) * n), 0), n - 1);
        return grid[i][j];
      }

      const maxJump = (fn: (x: number) => number | null): number => {
        const samples: number[] = [];
        for (let k = 0; k <= steps; k++) {
          const h = fn(worldXAt(k));
          if (h !== null) samples.push(h);
        }
        expect(samples.length).toBeGreaterThan(steps / 2);
        let m = 0;
        for (let k = 1; k < samples.length; k++) m = Math.max(m, Math.abs(samples[k] - samples[k - 1]));
        return m;
      };

      const newMaxJump = maxJump(x => hf.sample(x, zProbe));
      const oldMaxJump = maxJump(oldPointSample);

      // Sanity: the OLD model actually had a real, non-trivial step to fix
      // (otherwise this comparison would be vacuous).
      expect(oldMaxJump).toBeGreaterThan(0.05);
      // Bilinear must meaningfully shrink the worst single-sub-step jump —
      // this is what actually fixes the ground-height chatter symptom (#4):
      // vertical.ts's rate/position detachment used to spuriously fire on
      // every one of these old per-cell steps.
      expect(newMaxJump).toBeLessThan(oldMaxJump * 0.5);
    });
  });
});
