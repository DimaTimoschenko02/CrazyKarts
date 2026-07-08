// Regression tests for the terrain-edge slide (successor to
// footprintWall.ts's boolean axis-kill check) — design/notes/collision-v2.md
// §3.3/§9 Phase 1 gate: "грэйз вдоль стены сохраняет тангенциальную
// скорость", "сквозь стену не проходит".
import { describe, expect, it } from "vitest";
import { footprintHalfExtents, footprintPoints, resolveTerrainSlide, type TerrainSampler } from "./terrainWall";
import { DEFAULT_AXLE_GEOMETRY } from "./types";
import { Heightfield } from "../shared/heightfield";

const { halfLength, halfWidth } = footprintHalfExtents(DEFAULT_AXLE_GEOMETRY);
const MAX_STEP = 0.3;
const FWD = { x: 1, z: 0 };
const RIGHT = { x: 0, z: -1 };

function samplerFromHf(hf: Heightfield): TerrainSampler {
  return {
    sample: (x, z) => hf.sample(x, z),
    hasColumn: (x, z) => hf.hasColumn(x, z),
  };
}

describe("footprintHalfExtents / footprintPoints (unchanged from footprintWall.ts)", () => {
  it("derives half-length/half-width from the axle geometry (wheelbase 1.2, trackWidth 0.9)", () => {
    expect(footprintHalfExtents(DEFAULT_AXLE_GEOMETRY)).toEqual({ halfLength: 0.6, halfWidth: 0.45 });
  });

  it("returns center + 4 corners offset by half-length/half-width along fwd/right", () => {
    const pts = footprintPoints(10, 20, FWD, RIGHT, 0.6, 0.45);
    expect(pts).toHaveLength(5);
    expect(pts[0]).toEqual({ x: 10, z: 20 });
    expect(pts[1].x).toBeCloseTo(10.6, 6);
    expect(pts[1].z).toBeCloseTo(19.55, 6);
  });
});

describe("resolveTerrainSlide — genuine off-map edges", () => {
  it("driving straight at a genuine off-map edge stops the inward component but is NOT a hard freeze (I2)", () => {
    const hf = Heightfield.fromMapJson({
      meta: { tile_size: 1, level_height: 0.5, origin_offset: [0, 0, 0] },
      cells: [{ asset: "terrain", x: 0, z: 0, y_level: 0 }],
    });
    const sampler = samplerFromHf(hf);
    // Moving toward the edge (+X) fast enough that the footprint's leading
    // corner would leave the map this substep.
    const dt = 1 / 120;
    const vel = { x: 3, z: 0 };
    const out = resolveTerrainSlide(sampler, { x: 0, z: 0 }, vel, dt, FWD, RIGHT, halfLength, halfWidth, MAX_STEP);
    // Inward (+X) component should be gated — position must not have moved
    // past where it started (or only a negligible amount).
    expect(out.pos.x).toBeLessThanOrEqual(0.01);
  });

  it("KEY I2 test: grazing ALONG an off-map edge (moving parallel, not into it) preserves tangential speed", () => {
    // A long strip along Z at x=0..2, nothing beyond x=2.5's edge (off-map
    // starts past x~2.5..). Moving purely along Z (tangent to that edge)
    // must not be slowed AT ALL — this is the exact "stena держит вдоль"
    // symptom collision-v2.md's P1 root cause describes.
    const hf = Heightfield.fromMapJson({
      meta: { tile_size: 1, level_height: 0.5, origin_offset: [0, 0, 0] },
      cells: [
        { asset: "terrain", x: 0, z: 0, y_level: 0 },
        { asset: "terrain", x: 0, z: 1, y_level: 0 },
        { asset: "terrain", x: 0, z: 2, y_level: 0 },
      ],
    });
    const sampler = samplerFromHf(hf);
    const dt = 1 / 120;
    const vel = { x: 0, z: 3 }; // pure tangential (along the strip)
    const out = resolveTerrainSlide(sampler, { x: 0, z: 0.5 }, vel, dt, { x: 0, z: 1 }, { x: 1, z: 0 }, halfLength, halfWidth, MAX_STEP);
    // With the strip only 1 cell WIDE (x spans roughly -0.5..0.5) and
    // halfWidth=0.45, the footprint corners sit right at the strip's own
    // edges (not moving in X at all), so no corner ever crosses an X
    // boundary during a pure-Z move — velocity must survive completely
    // untouched.
    expect(out.vel.z).toBeCloseTo(3, 6);
  });
});

describe("resolveTerrainSlide — wall_block cube sides ARE terrain steps now (2026-07-08 rework)", () => {
  it("driving into a wall_block's side is blocked: its top sits a full 0.5 level above the ground (> MAX_STEP)", () => {
    const hf = Heightfield.fromMapJson({
      meta: { tile_size: 1, level_height: 0.5, origin_offset: [0, 0, 0] },
      cells: [
        // terrain at x=-1 keeps the kart's REAR corners on the map — without
        // it they'd read as off-map edges too, and the leading/rear push
        // directions would cancel to a degenerate zero normal.
        { asset: "terrain", x: -1, z: 0, y_level: 0 },
        { asset: "terrain", x: 0, z: 0, y_level: 0 },
        { asset: "wall_block", x: 1, z: 0, y_level: 0 },
      ],
    });
    const sampler = samplerFromHf(hf);
    const dt = 1 / 120;
    // Driving from the flat terrain (h=0) toward the block cell (top h=0.5,
    // cell spans x∈[0.5, 1.5]): position the kart so its leading corner
    // (pos.x + halfLength = 0.45) sits just BEFORE the boundary and moves
    // across it this substep — the corner's height jump 0.5 > MAX_STEP 0.3,
    // so the inward velocity component must be killed (the block's old SAT
    // AABB is gone; this path is now THE wall mechanism for cube sides).
    const vel = { x: 12, z: 0 };
    const out = resolveTerrainSlide(sampler, { x: -0.15, z: 0 }, vel, dt, FWD, RIGHT, halfLength, halfWidth, MAX_STEP);
    expect(out.vel.x).toBeLessThanOrEqual(0.01);
  });

  it("a kart already ON TOP of a block strip drives along it freely (top is flat walkable ground)", () => {
    const hf = Heightfield.fromMapJson({
      meta: { tile_size: 1, level_height: 0.5, origin_offset: [0, 0, 0] },
      cells: [
        { asset: "wall_block", x: 0, z: 0, y_level: 0 },
        { asset: "wall_block", x: 1, z: 0, y_level: 0 },
        { asset: "wall_block", x: 2, z: 0, y_level: 0 },
      ],
    });
    const sampler = samplerFromHf(hf);
    const dt = 1 / 120;
    // Small footprint so it fits within the 1-cell-wide strip (same trick as
    // the ramp test below). Moving along the strip: every sample is the same
    // flat 0.5 top — no step, no off-map, velocity untouched.
    const vel = { x: 3, z: 0 };
    const out = resolveTerrainSlide(sampler, { x: 0.5, z: 0 }, vel, dt, FWD, RIGHT, 0.3, 0.2, MAX_STEP);
    expect(out.vel.x).toBeCloseTo(3, 6);
  });
});

describe("resolveTerrainSlide — does not false-positive block a kart already parked on a smooth ramp", () => {
  it("every footprint point rising together with the slope never trips the maxStep check", () => {
    const hf = Heightfield.fromMapJson({
      meta: { tile_size: 4, level_height: 0.5, origin_offset: [0, 0, 0] },
      cells: [{ asset: "terrain_ramp", x: 0, z: 0, y_level: 0, rot: 0 }],
    });
    const sampler = samplerFromHf(hf);
    const dt = 1 / 120;
    const smallHalfLength = 0.3;
    const smallHalfWidth = 0.2;
    const vel = { x: 0, z: 3 };
    const out = resolveTerrainSlide(sampler, { x: 0, z: -0.4 }, vel, dt, { x: 0, z: 1 }, { x: 1, z: 0 }, smallHalfLength, smallHalfWidth, MAX_STEP);
    expect(out.vel.z).toBeCloseTo(3, 6);
  });
});
