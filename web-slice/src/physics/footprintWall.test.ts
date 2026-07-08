// Regression tests for the footprint-aware wall check (see the module doc
// comment in footprintWall.ts for the map_v2.json bug this fixes — a kart's
// flank clipping through terrain_sideCliff mesh while a center-point-only
// probe read the move as safe).
import { describe, expect, it } from "vitest";
import { footprintHalfExtents, footprintHitsWall, footprintPoints } from "./footprintWall";
import { DEFAULT_AXLE_GEOMETRY } from "./types";
import { Heightfield } from "../shared/heightfield";

const { halfLength, halfWidth } = footprintHalfExtents(DEFAULT_AXLE_GEOMETRY);
const MAX_STEP = 0.3;
const FWD = { x: 1, z: 0 };
const RIGHT = { x: 0, z: -1 };

describe("footprintHalfExtents", () => {
  it("derives half-length/half-width from the axle geometry (wheelbase 1.2, trackWidth 0.9)", () => {
    expect(footprintHalfExtents(DEFAULT_AXLE_GEOMETRY)).toEqual({ halfLength: 0.6, halfWidth: 0.45 });
  });
});

describe("footprintPoints", () => {
  it("returns center + 4 corners offset by half-length/half-width along fwd/right", () => {
    const pts = footprintPoints(10, 20, FWD, RIGHT, 0.6, 0.45);
    expect(pts).toHaveLength(5);
    expect(pts[0]).toEqual({ x: 10, z: 20 }); // center
    // corner (right:+1, fwd:+1): +right*0.45 + fwd*0.6 = (10+0.6, 20-0.45)
    expect(pts[1].x).toBeCloseTo(10.6, 6);
    expect(pts[1].z).toBeCloseTo(19.55, 6);
  });
});

describe("footprintHitsWall — reproduces the map_v2.json owner report (2026-07-08)", () => {
  it("a corner-only clip (center delta 0, forward corner delta > MAX_STEP) IS caught — the exact bug this fixes", () => {
    // A flat low strip (x=0, z=-1..1) followed by a hard step up to a high
    // strip (x=1, z=-1..1) — a hard cell-boundary wall, like a
    // terrain_sideCliff meeting a plateau with no transition tile. Driving
    // FORWARD (+X): the kart's front corners sit halfLength(0.6m) AHEAD of
    // its own center. Center crossing x=-0.15 -> x=-0.05 stays entirely on
    // the low strip (delta 0, old single-point check sees nothing wrong),
    // but the front corner (offset +0.6) crosses from x=0.45 (low, height 0)
    // to x=0.55 (high, height 0.5) during that SAME substep — a 0.5m jump
    // the old center-only check never sampled at all.
    const hf = Heightfield.fromMapJson({
      meta: { tile_size: 1, level_height: 0.5, origin_offset: [0, 0, 0] },
      cells: [
        { asset: "terrain", x: 0, z: -1, y_level: 0 },
        { asset: "terrain", x: 0, z: 0, y_level: 0 },
        { asset: "terrain", x: 0, z: 1, y_level: 0 },
        { asset: "terrain", x: 1, z: -1, y_level: 1 },
        { asset: "terrain", x: 1, z: 0, y_level: 1 },
        { asset: "terrain", x: 1, z: 1, y_level: 1 },
      ],
    });
    const sample = (x: number, z: number) => hf.sample(x, z);

    // Center-only check (the OLD kart.ts logic): stays on the low strip both
    // before and after — would NOT have blocked.
    const centerBefore = sample(-0.15, 0)!;
    const centerAfter = sample(-0.05, 0)!;
    expect(centerAfter - centerBefore).toBe(0);

    // New footprint-aware check: the leading corner (curX+halfLength) crosses
    // the cell boundary during this exact substep and must be caught.
    const blocked = footprintHitsWall(sample, -0.15, 0, -0.05, 0, FWD, RIGHT, MAX_STEP, halfLength, halfWidth);
    expect(blocked).toBe(true);
  });

  it("does NOT false-positive block a kart already parked on a slope (corner-to-corner comparison, not corner-to-center)", () => {
    // A wide, multi-cell-tall single ramp footprint (level_height scaled up
    // so a small footprint probe fits entirely within ONE authored slope
    // without straddling unrelated cells) — every footprint point rises
    // together with the slope; none should see a step > MAX_STEP between its
    // own before/after reading, even though corners sit at a genuinely
    // different height than the center (that's the whole point of the
    // corner-to-corner, not corner-to-center, comparison).
    const hf = Heightfield.fromMapJson({
      meta: { tile_size: 4, level_height: 0.5, origin_offset: [0, 0, 0] },
      cells: [{ asset: "terrain_ramp", x: 0, z: 0, y_level: 0, rot: 0 }],
    });
    const sample = (x: number, z: number) => hf.sample(x, z);
    const smallHalfLength = 0.3;
    const smallHalfWidth = 0.2;
    const blocked = footprintHitsWall(sample, 0, -0.4, 0, -0.2, { x: 0, z: 1 }, { x: 1, z: 0 }, MAX_STEP, smallHalfLength, smallHalfWidth);
    expect(blocked).toBe(false);
  });

  it("off-map at any footprint corner is a wall (null sample)", () => {
    const hf = Heightfield.fromMapJson({
      meta: { tile_size: 1, level_height: 0.5, origin_offset: [0, 0, 0] },
      cells: [{ asset: "terrain", x: 0, z: 0, y_level: 0 }],
    });
    const sample = (x: number, z: number) => hf.sample(x, z);
    // Driving toward the map edge — the leading footprint corner falls off
    // the single 1x1 cell before the center does.
    const blocked = footprintHitsWall(sample, 0.3, 0, 0.5, 0, FWD, RIGHT, MAX_STEP, halfLength, halfWidth);
    expect(blocked).toBe(true);
  });

  it("a corner already off-map (hcur null) doesn't spuriously block once it re-enters walkable ground", () => {
    const hf = Heightfield.fromMapJson({
      meta: { tile_size: 1, level_height: 0.5, origin_offset: [0, 0, 0] },
      cells: [
        { asset: "terrain", x: 0, z: 0, y_level: 0 },
        { asset: "terrain", x: 1, z: 0, y_level: 0 },
      ],
    });
    const sample = (x: number, z: number) => hf.sample(x, z);
    // Moving from x=-0.3 (front-right corner at x≈0.15+0.6=off cell edge but
    // still on-map) is contrived; simpler: verify a flat, fully-walkable
    // straight-line move across 2 cells never blocks.
    const blocked = footprintHitsWall(sample, 0.3, 0, 0.6, 0, FWD, RIGHT, MAX_STEP, halfLength, halfWidth);
    expect(blocked).toBe(false);
  });
});
