// Regression tests for the terrain-edge slide (successor to
// footprintWall.ts's boolean axis-kill check) — design/notes/collision-v2.md
// §3.3/§9 Phase 1 gate: "грэйз вдоль стены сохраняет тангенциальную
// скорость", "сквозь стену не проходит".
// D3b/D4 regression coverage (design/notes/ride-collision-v2.md, 2026-07-09).
// D5 regression coverage (2026-07-10, body-relative wall gate — see
// resolveTerrainSlide/tryEscape's new yRef/climbThreshold params and
// terrainWall.ts's D5 doc comment): GRAD/STEP now only count as a wall when
// the "wall" sample itself sits more than climbThreshold above yRef.
import { describe, expect, it } from "vitest";
import { footprintHalfExtents, footprintPoints, resolveTerrainSlide, tryEscape, type TerrainSampler } from "./terrainWall";
import { DEFAULT_AXLE_GEOMETRY } from "./types";
import { Heightfield } from "../shared/heightfield";

const { halfLength, halfWidth } = footprintHalfExtents(DEFAULT_AXLE_GEOMETRY);
// Same default as KartPhysicsParams.terrainWallGradientThreshold — rise over
// the short WALL_GRADIENT_BASE (0.15m, internal to terrainWall.ts) that
// counts as a wall (≈61°).
const WALL_GRADIENT_THRESHOLD = 0.27;
// Same default as KartPhysicsParams.layerClimbThreshold — the D5 body-
// relative gate's cutoff for "still within this body's own reach".
const CLIMB_THRESHOLD = 0.8;
const FWD = { x: 1, z: 0 };
const RIGHT = { x: 0, z: -1 };

function samplerFromHf(hf: Heightfield): TerrainSampler {
  return {
    sample: (x, z) => hf.sample(x, z),
    hasColumn: (x, z) => hf.hasColumn(x, z),
  };
}

// Mirrors kart.ts's real terrainSampler wiring (sample/hasColumn/solidBlocked/
// wallBlocked all bound to the SAME yRef this call also gates GRAD/STEP
// with) — used by the wall_block tests below. wallBlocked (2026-07-10 follow-
// up) is what actually keeps a wall_block* side genuinely solid regardless of
// climbThreshold — see heightfield.ts Heightfield.wallBlocked doc.
function samplerFromHfWithSolid(hf: Heightfield, yRef: number, climbThreshold: number, kartBodyHeight = 1.0): TerrainSampler {
  return {
    sample: (x, z) => hf.sampleAt(x, z, yRef, climbThreshold),
    hasColumn: (x, z) => hf.hasColumn(x, z),
    solidBlocked: (x, z) => hf.solidBlocked(x, z, yRef, yRef + kartBodyHeight, climbThreshold),
    wallBlocked: (x, z) => hf.wallBlocked(x, z, yRef),
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
    const out = resolveTerrainSlide(sampler, { x: 0, z: 0 }, vel, dt, FWD, RIGHT, halfLength, halfWidth, WALL_GRADIENT_THRESHOLD, 0, CLIMB_THRESHOLD);
    // Inward (+X) component should be gated — position must not have moved
    // past where it started (or only a negligible amount). Off-map blocking
    // (hNext===null branch) is independent of the D5 yRef gate.
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
    const out = resolveTerrainSlide(
      sampler,
      { x: 0, z: 0.5 },
      vel,
      dt,
      { x: 0, z: 1 },
      { x: 1, z: 0 },
      halfLength,
      halfWidth,
      WALL_GRADIENT_THRESHOLD,
      0,
      CLIMB_THRESHOLD
    );
    // With the strip only 1 cell WIDE (x spans roughly -0.5..0.5) and
    // halfWidth=0.45, the footprint corners sit right at the strip's own
    // edges (not moving in X at all), so no corner ever crosses an X
    // boundary during a pure-Z move — velocity must survive completely
    // untouched.
    expect(out.vel.z).toBeCloseTo(3, 6);
  });
});

describe("resolveTerrainSlide — wall_block cube sides ARE terrain steps now (2026-07-08 rework)", () => {
  // FOLLOW-UP FIX (2026-07-10, resolved the earlier D5 regression): D5's
  // body-relative climb gate correctly stopped GRAD/STEP from false-blocking
  // ordinary drivable terrain, but it ALSO relaxed a wall_block's half-level
  // (0.5m) side whenever climbThreshold (default 0.8) exceeded that height —
  // conflicting with the 2026-07-08 design decision ("wall_block* are
  // drivable cubes: solid from the side, walkable on top", commit ef6c066).
  // Fix: wall_block* cells now carry HeightCell.isWall, and
  // Heightfield.wallBlocked()/TerrainSampler.wallBlocked (never climb-gated)
  // is OR-ed into cornerBlocked alongside the D5-gated GRAD/STEP/solidBlocked
  // checks — see heightfield.ts and terrainWall.ts doc comments.
  it("driving into a wall_block's side is blocked at the production default (climb=0.8 > block height 0.5) via the new always-on wallBlocked check", () => {
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
    const yRef = 0;
    const sampler = samplerFromHfWithSolid(hf, yRef, CLIMB_THRESHOLD);
    const dt = 1 / 120;
    const vel = { x: 12, z: 0 };
    const out = resolveTerrainSlide(sampler, { x: -0.15, z: 0 }, vel, dt, FWD, RIGHT, halfLength, halfWidth, WALL_GRADIENT_THRESHOLD, yRef, CLIMB_THRESHOLD);
    expect(out.vel.x).toBeLessThanOrEqual(0.01);
  });

  it("a kart already parked ON TOP of a wall_block (yRef == the block's own top) is NOT self-blocked by its own layer (WALL_TOP_TOLERANCE)", () => {
    const hf = Heightfield.fromMapJson({
      meta: { tile_size: 1, level_height: 0.5, origin_offset: [0, 0, 0] },
      cells: [
        { asset: "wall_block", x: 0, z: 0, y_level: 0 },
        { asset: "wall_block", x: 1, z: 0, y_level: 0 },
        { asset: "wall_block", x: 2, z: 0, y_level: 0 },
      ],
    });
    const yRef = 0.5; // the block strip's own top
    const sampler = samplerFromHfWithSolid(hf, yRef, CLIMB_THRESHOLD);
    const dt = 1 / 120;
    const vel = { x: 3, z: 0 };
    const out = resolveTerrainSlide(sampler, { x: 0.5, z: 0 }, vel, dt, FWD, RIGHT, 0.3, 0.2, WALL_GRADIENT_THRESHOLD, yRef, CLIMB_THRESHOLD);
    expect(out.vel.x).toBeCloseTo(3, 6);
  });

  it("driving up onto a wall_block's top from a foot-height yRef is still blocked (a step this close underneath still isn't within WALL_TOP_TOLERANCE)", () => {
    const hf = Heightfield.fromMapJson({
      meta: { tile_size: 1, level_height: 0.5, origin_offset: [0, 0, 0] },
      cells: [
        { asset: "terrain", x: -1, z: 0, y_level: 0 },
        { asset: "terrain", x: 0, z: 0, y_level: 0 },
        { asset: "wall_block", x: 1, z: 0, y_level: 0 },
      ],
    });
    // yRef=0 (standing at the block's own FOOT, not its top) — top(0.5) is
    // 0.5 above yRef, past WALL_TOP_TOLERANCE(0.25), so it still reads as a
    // wall from below, exactly as intended.
    const yRef = 0;
    const sampler = samplerFromHfWithSolid(hf, yRef, CLIMB_THRESHOLD);
    const dt = 1 / 120;
    const vel = { x: 6, z: 0 };
    const out = resolveTerrainSlide(sampler, { x: 0.3, z: 0 }, vel, dt, FWD, RIGHT, halfLength, halfWidth, WALL_GRADIENT_THRESHOLD, yRef, CLIMB_THRESHOLD);
    expect(out.vel.x).toBeLessThanOrEqual(0.01);
  });

  it("anti-tunneling: a fast approach into a wall_block's side is still blocked (high speed, production default climb)", () => {
    const hf = Heightfield.fromMapJson({
      meta: { tile_size: 1, level_height: 0.5, origin_offset: [0, 0, 0] },
      cells: [
        { asset: "terrain", x: -1, z: 0, y_level: 0 },
        { asset: "terrain", x: 0, z: 0, y_level: 0 },
        { asset: "wall_block", x: 1, z: 0, y_level: 0 },
      ],
    });
    const yRef = 0;
    const sampler = samplerFromHfWithSolid(hf, yRef, CLIMB_THRESHOLD);
    const dt = 1 / 120;
    const vel = { x: 24, z: 0 }; // 0.2m per substep — deep single-step crossing
    const out = resolveTerrainSlide(sampler, { x: -0.13, z: 0 }, vel, dt, FWD, RIGHT, halfLength, halfWidth, WALL_GRADIENT_THRESHOLD, yRef, CLIMB_THRESHOLD);
    expect(out.vel.x).toBeLessThanOrEqual(0.01);
  });

  it("ground_block (NOT wall_block) is unaffected by the new wallBlocked check — no isWall tag, same D5-gated behavior as before", () => {
    const hf = Heightfield.fromMapJson({
      meta: { tile_size: 1, level_height: 0.5, origin_offset: [0, 0, 0] },
      cells: [
        { asset: "terrain", x: -1, z: 0, y_level: 0 },
        { asset: "terrain", x: 0, z: 0, y_level: 0 },
        { asset: "ground_block", x: 1, z: 0, y_level: 0 },
      ],
    });
    const yRef = 0;
    const sampler = samplerFromHfWithSolid(hf, yRef, CLIMB_THRESHOLD);
    const dt = 1 / 120;
    const vel = { x: 12, z: 0 };
    // Same shape as the wall_block test above, but ground_block's 0.5m step
    // is within CLIMB_THRESHOLD(0.8) and it carries no isWall tag — D5's own
    // gate (not wallBlocked) governs it, exactly as it did for plain terrain.
    const out = resolveTerrainSlide(sampler, { x: -0.15, z: 0 }, vel, dt, FWD, RIGHT, halfLength, halfWidth, WALL_GRADIENT_THRESHOLD, yRef, CLIMB_THRESHOLD);
    expect(out.vel.x).toBeCloseTo(12, 6);
  });

  it("driving OFF a block's edge (steep drop AHEAD) is never blocked — cliffs are jumps, not walls", () => {
    // Review catch 2026-07-09: the first D3b draft used |hB - hA| for the
    // gradient, which read a 0.5m DROP ahead as a wall too — an invisible
    // wall on every plateau rim / trampoline lip, killing drive-off jumps.
    // The criterion must be SIGNED: only climbing up blocks.
    const hf = Heightfield.fromMapJson({
      meta: { tile_size: 1, level_height: 0.5, origin_offset: [0, 0, 0] },
      cells: [
        { asset: "wall_block", x: 0, z: 0, y_level: 0 },
        { asset: "wall_block", x: 1, z: 0, y_level: 0 },
        { asset: "terrain", x: 2, z: 0, y_level: 0 },
        { asset: "terrain", x: 3, z: 0, y_level: 0 },
      ],
    });
    const sampler = samplerFromHf(hf);
    const dt = 1 / 120;
    // On top of the block strip (h=0.5), driving +X toward the rim at
    // x=1.5 where the ground drops to h=0. Same small footprint as the
    // strip test, leading corner crossing the rim this substep. yRef=0.5 —
    // the body's own height while parked on the block top.
    const vel = { x: 12, z: 0 };
    const out = resolveTerrainSlide(sampler, { x: 1.25, z: 0 }, vel, dt, FWD, RIGHT, 0.3, 0.2, WALL_GRADIENT_THRESHOLD, 0.5, CLIMB_THRESHOLD);
    expect(out.vel.x).toBeCloseTo(12, 6);
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
    const out = resolveTerrainSlide(sampler, { x: 0.5, z: 0 }, vel, dt, FWD, RIGHT, 0.3, 0.2, WALL_GRADIENT_THRESHOLD, 0.5, CLIMB_THRESHOLD);
    expect(out.vel.x).toBeCloseTo(3, 6);
  });
});

describe("resolveTerrainSlide — D3a2/D3a3 flush-stacked wall column, sampler mirrors kart.ts's real wiring (symptom A, 2026-07-09)", () => {
  it("driving from a yard floor into a flush wall_block stack is blocked — the OLD flush-floor bug is gone (regression: a genuinely tall/out-of-reach wall still blocks under D5)", () => {
    // Reproduces the real bug's shape: kart.ts's terrainSampler.sample is
    // bound to Heightfield.sampleAt (layer-aware), not the plain MAX
    // sample() — see kart.ts step 8a. A 4-cube flush wall_block stack at
    // x=1 has a mid-height floor (1.5) exactly flush with the yard floor
    // (also 1.5) at x=-1/x=0; with climbThreshold small enough that the
    // stack's true top (2.0) is unreachable, the OLD unfiltered sampleAt
    // would have picked that flush 1.5 as the "floor" of the wall column too
    // — zero gradient, drive straight through. The burial filter (D3a2)
    // removes that buried floor from the candidate set entirely, so
    // sampleAt now reports the column's one live floor (2.0) instead —
    // producing a real gradient the existing D3b check catches. D5's new
    // yRef gate does NOT relax this case: the stack's real top (2.0) is a
    // full 0.5m past yRef(1.5)+CLIMB(0.3) — genuinely out of climb reach —
    // so GRAD/STEP still correctly block it, and solidBlocked (D3a3) is
    // wired here too (matching kart.ts's actual sampler) as a second,
    // independent line of defense.
    const hf = Heightfield.fromMapJson({
      meta: { tile_size: 1, level_height: 0.5, origin_offset: [0, 0, 0] },
      cells: [
        { asset: "terrain", x: -1, z: 0, y_level: 3 }, // yard floor, h=1.5 — keeps rear corners on the map
        { asset: "terrain", x: 0, z: 0, y_level: 3 }, // yard floor, h=1.5
        { asset: "wall_block", x: 1, z: 0, y_level: 0 }, // top 0.5
        { asset: "wall_block", x: 1, z: 0, y_level: 1 }, // top 1.0
        { asset: "wall_block", x: 1, z: 0, y_level: 2 }, // top 1.5 — flush with the yard floor (the bug's flush point)
        { asset: "wall_block", x: 1, z: 0, y_level: 3 }, // top 2.0 — the stack's real, only LIVE top
      ],
    });
    const CLIMB = 0.3; // small enough that 2.0 is unreachable from yRef=1.5
    const yRef = 1.5;
    const kartTop = yRef + 1.0; // matches kart.ts's KART_BODY_HEIGHT
    const sampler = samplerFromHfWithSolid(hf, yRef, CLIMB, kartTop - yRef);
    const dt = 1 / 120;
    const vel = { x: 12, z: 0 };
    const out = resolveTerrainSlide(sampler, { x: -0.15, z: 0 }, vel, dt, FWD, RIGHT, halfLength, halfWidth, WALL_GRADIENT_THRESHOLD, yRef, CLIMB);
    expect(out.vel.x).toBeLessThanOrEqual(0.01);
  });
});

describe("resolveTerrainSlide — does not false-positive block a kart already parked on a smooth ramp", () => {
  it("every footprint point rising together with the slope never trips the D3b gradient check", () => {
    const hf = Heightfield.fromMapJson({
      meta: { tile_size: 4, level_height: 0.5, origin_offset: [0, 0, 0] },
      cells: [{ asset: "terrain_ramp", x: 0, z: 0, y_level: 0, rot: 0 }],
    });
    const sampler = samplerFromHf(hf);
    const dt = 1 / 120;
    const smallHalfLength = 0.3;
    const smallHalfWidth = 0.2;
    const vel = { x: 0, z: 3 };
    const out = resolveTerrainSlide(
      sampler,
      { x: 0, z: -0.4 },
      vel,
      dt,
      { x: 0, z: 1 },
      { x: 1, z: 0 },
      smallHalfLength,
      smallHalfWidth,
      WALL_GRADIENT_THRESHOLD,
      0,
      CLIMB_THRESHOLD
    );
    expect(out.vel.z).toBeCloseTo(3, 6);
  });
});

describe("resolveTerrainSlide — D3b: angled slope junction never false-blocks a real-sized footprint (симптом #5, клин)", () => {
  it("a real body-sized footprint (0.6/0.45) crossing a kinked-but-mild slope junction is never blocked", () => {
    // Synthetic two-plane wedge, continuous in HEIGHT but with a genuine
    // slope-angle KINK at x=0 (two differently-angled, both perfectly
    // climbable slopes meeting along a line) — this is the general shape of
    // "два наклонных блока под углом" without depending on any particular
    // Heightfield ramp-pair authoring. The OLD cur/next-diff criterion
    // sampled at whatever distance the corner happened to move, which could
    // straddle unrelated far parts of either plane; D3b's short, FIXED local
    // base only ever sees the true local slope on each side of the kink.
    const sampler: TerrainSampler = {
      sample: (x, _z) => (x <= 0 ? 0.15 * x : 0.4 * x),
      hasColumn: () => true,
    };
    const dt = 1 / 120;
    const vel = { x: 3, z: 0 }; // straight across the kink
    const out = resolveTerrainSlide(
      sampler,
      { x: -0.3, z: 0 },
      vel,
      dt,
      FWD,
      RIGHT,
      halfLength,
      halfWidth,
      WALL_GRADIENT_THRESHOLD,
      0,
      CLIMB_THRESHOLD
    );
    expect(out.vel.x).toBeCloseTo(3, 6);
  });

  it("driving diagonally (both fwd and lateral) across the same kink is also never blocked", () => {
    const sampler: TerrainSampler = {
      sample: (x, _z) => (x <= 0 ? 0.15 * x : 0.4 * x),
      hasColumn: () => true,
    };
    const dt = 1 / 120;
    const vel = { x: 2, z: 2 };
    const out = resolveTerrainSlide(
      sampler,
      { x: -0.3, z: 0 },
      vel,
      dt,
      FWD,
      RIGHT,
      halfLength,
      halfWidth,
      WALL_GRADIENT_THRESHOLD,
      0,
      CLIMB_THRESHOLD
    );
    expect(Math.hypot(out.vel.x, out.vel.z)).toBeCloseTo(Math.hypot(2, 2), 6);
  });
});

describe("resolveTerrainSlide — D5 (body-relative wall gate, 2026-07-10) — symptom A, slope-foot GRAD false block", () => {
  // Mirrors the exact magnitude tools/diagnose_edge_bugs_sim.ts's scenario A
  // hit on roads_v1.json's roadTile_289 side seam: a short local rise of
  // Δ0.423 over the 0.15m gradient base (well past WALL_GRADIENT_THRESHOLD
  // 0.27) right at a cell boundary — a real, but perfectly climbable, slope
  // FOOT. hA/hB straddle a hard step at x=0.5, same construction the
  // existing wall_block tests above use.
  const sampler: TerrainSampler = {
    sample: (x, _z) => (x < 0.5 ? 0.55 : 0.973),
    hasColumn: () => true,
  };
  const dt = 1 / 120;
  const vel = { x: 12, z: 0 };

  it("is NOT a wall when the body is right there (yRef within climb reach of the rise) — the diagnosed false block", () => {
    // yRef=0.6 mirrors the real playtest trace (kart's own y sitting right
    // at the low/grass side, ~0.55-0.6) — the "wall" sample (0.973) is only
    // 0.373 above that, inside CLIMB_THRESHOLD(0.8).
    const out = resolveTerrainSlide(sampler, { x: -0.15, z: 0 }, vel, dt, FWD, RIGHT, halfLength, halfWidth, WALL_GRADIENT_THRESHOLD, 0.6, CLIMB_THRESHOLD);
    expect(out.vel.x).toBeCloseTo(12, 6);
  });

  it("the SAME local rise IS still a wall when the body is far below (out of climb reach)", () => {
    // yRef=-1.0: the "wall" sample (0.973) is 1.973 above that — genuinely
    // out of reach, so the gate must still let GRAD/STEP block it (this is
    // what keeps D5 from silently disabling wall detection everywhere).
    const out = resolveTerrainSlide(sampler, { x: -0.15, z: 0 }, vel, dt, FWD, RIGHT, halfLength, halfWidth, WALL_GRADIENT_THRESHOLD, -1.0, CLIMB_THRESHOLD);
    expect(out.vel.x).toBeLessThanOrEqual(0.01);
  });
});

describe("resolveTerrainSlide — D5 regression: a genuinely tall wall (Δ2.0, far past any climb reach) still blocks", () => {
  it("a 2.0m near-vertical rise blocks regardless of how close yRef is set", () => {
    const sampler: TerrainSampler = {
      sample: (x, _z) => (x < 0.5 ? 0.0 : 2.0),
      hasColumn: () => true,
    };
    const dt = 1 / 120;
    const vel = { x: 12, z: 0 };
    // yRef=0 — right at the low side, the most generous possible reference —
    // still 2.0 - 0 - CLIMB_THRESHOLD(0.8) = 1.2 clear of climb reach.
    const out = resolveTerrainSlide(sampler, { x: -0.15, z: 0 }, vel, dt, FWD, RIGHT, halfLength, halfWidth, WALL_GRADIENT_THRESHOLD, 0, CLIMB_THRESHOLD);
    expect(out.vel.x).toBeLessThanOrEqual(0.01);
  });
});

describe("resolveTerrainSlide / tryEscape — D4 anti-deadlock (симптом #2, застревание намертво)", () => {
  // The in-game deadlocks the owner hit were manufactured by D3b's
  // predecessor (false walls at slope seams) — with the signed local
  // gradient those walls no longer exist, and simple authored geometry can
  // no longer steer resolveTerrainSlide into the degenerate branch. What
  // remains testable and load-bearing: (a) a genuine dead-end must end as a
  // CLEAN stop — zero residual velocity, no phantom energy re-fed into the
  // next tick, and (b) the escape valve itself picks a validated free
  // direction and refuses blocked ones. All walls here are tall (5.0, far
  // past CLIMB_THRESHOLD from yRef=0) so D5's gate doesn't change any of
  // these outcomes.
  it("head-on into a pocket's wall is a clean stop: velocity fully drained, not frozen-with-residual", () => {
    // Floor pocket barely longer than the footprint, wall rising ahead.
    const sampler: TerrainSampler = {
      sample: (x, _z) => (x > 0.7 ? 5 : 0),
      hasColumn: () => true,
    };
    const dt = 1 / 120;
    const out = resolveTerrainSlide(sampler, { x: 0, z: 0 }, { x: 12, z: 0 }, dt, FWD, RIGHT, halfLength, halfWidth, WALL_GRADIENT_THRESHOLD, 0, CLIMB_THRESHOLD);
    expect(Math.hypot(out.vel.x, out.vel.z)).toBeLessThanOrEqual(0.01);
    expect(out.pos.x).toBeCloseTo(0, 6); // stopped at the start, not teleported
  });

  it("tryEscape picks the first candidate direction whose whole footprint move validates (back first)", () => {
    // Wall ahead (+X) only — straight back must validate and win.
    const sampler: TerrainSampler = {
      sample: (x, _z) => (x > 0.7 ? 5 : 0),
      hasColumn: () => true,
    };
    const escaped = tryEscape(sampler, 0, 0, FWD, RIGHT, halfLength, halfWidth, 0.05, WALL_GRADIENT_THRESHOLD, 0, CLIMB_THRESHOLD);
    expect(escaped).not.toBeNull();
    expect(escaped!.dir.x).toBeCloseTo(-1, 6); // -fwd
    expect(escaped!.x).toBeCloseTo(-0.05, 6);
  });

  it("tryEscape skips a blocked candidate and falls through to a free one", () => {
    // Walls ahead AND behind (corridor), flat in Z — lateral must win.
    const sampler: TerrainSampler = {
      sample: (x, _z) => (x > 0.7 || x < -0.7 ? 5 : 0),
      hasColumn: () => true,
    };
    const escaped = tryEscape(sampler, 0, 0, FWD, RIGHT, halfLength, halfWidth, 0.05, WALL_GRADIENT_THRESHOLD, 0, CLIMB_THRESHOLD);
    expect(escaped).not.toBeNull();
    expect(Math.abs(escaped!.dir.z)).toBeCloseTo(1, 6); // one of the laterals
  });

  it("tryEscape returns null only when genuinely boxed in on all four sides", () => {
    // Walls must start OUTSIDE the resting corners (±0.6/±0.45) so every
    // candidate move crosses INTO a rise — corners already overlapping a
    // wall are free to leave it under the signed gradient (deliberately:
    // that's how a kart that somehow clipped in un-clips itself).
    const sampler: TerrainSampler = {
      sample: (x, z) => (Math.abs(x) > 0.62 || Math.abs(z) > 0.47 ? 5 : 0),
      hasColumn: () => true,
    };
    const escaped = tryEscape(sampler, 0, 0, FWD, RIGHT, halfLength, halfWidth, 0.15, WALL_GRADIENT_THRESHOLD, 0, CLIMB_THRESHOLD);
    expect(escaped).toBeNull();
  });
});

describe("resolveTerrainSlide — road-tile curb fix (owner playtest, 2026-07-10): sameCell gate", () => {
  // Synthetic curb: a sharp step at x=0 (low side 0.6, high/curb side 1.0 —
  // Δ0.4, matches the measured real Kenney road-tile curb magnitude, see
  // gameplay-programmer's tools/diag_wall_slide.ts probe of roadTile_182/015/
  // 233/228/241 for the real baked numbers this mirrors). yRef=0.6 (the
  // low/road side, exactly how a kart cruising the road sits) puts the curb
  // top (1.0) only Δ0.4 above yRef — INSIDE climbThreshold (0.8), i.e. the
  // exact D5 "within climb reach" condition that used to let this rise
  // through unblocked (the "carabканье" bug). `sameCell` always true here
  // simulates the real case: both GRAD probe endpoints and the STEP cur/next
  // pair all land inside the SAME road tile's own baked heightGrid.
  // Boundary at x=0.5 (not the body center's own start x) — mirrors the
  // exact D5 slope-foot test's geometry above (start pos x=-0.15, footprint
  // halfLength=0.6, so the LEADING corner already sits at x=0.45, just
  // short of the boundary — matching a real "about to touch" contact, not a
  // corner that's already spawned on the far side).
  const curbSampler: TerrainSampler = {
    sample: (x, _z) => (x < 0.5 ? 0.6 : 1.0),
    hasColumn: () => true,
    sameCell: () => true,
  };
  const dt = 1 / 120;
  const yRef = 0.6;

  it("a steep same-cell rise blocks even when it's within D5 climb reach (the bug this fix targets)", () => {
    // Head-on approach (pure +X) — must be blocked (old behavior: sailed
    // through since Δ0.4 < CLIMB_THRESHOLD 0.8, see the D5 slope-foot test
    // above using this exact same start pos/boundary/speed magnitude).
    const out = resolveTerrainSlide(curbSampler, { x: -0.15, z: 0 }, { x: 12, z: 0 }, dt, FWD, RIGHT, halfLength, halfWidth, WALL_GRADIENT_THRESHOLD, yRef, CLIMB_THRESHOLD);
    expect(Math.hypot(out.vel.x, out.vel.z)).toBeLessThanOrEqual(0.01);
  });

  it("without sameCell wired up (old sampler shape), the SAME rise stays climbable — proves this is opt-in, zero behavior change for old callers", () => {
    const noSameCellSampler: TerrainSampler = { sample: curbSampler.sample, hasColumn: () => true };
    const out = resolveTerrainSlide(noSameCellSampler, { x: -0.15, z: 0 }, { x: 12, z: 0 }, dt, FWD, RIGHT, halfLength, halfWidth, WALL_GRADIENT_THRESHOLD, yRef, CLIMB_THRESHOLD);
    expect(out.vel.x).toBeCloseTo(12, 6);
  });

  it("a GENTLE same-cell rise (below gradientThreshold) is NOT walled by sameCell alone — only steep+same-cell walls", () => {
    // Same yRef/climb-reach setup, but a shallow rise (Δ0.1 over the full
    // step, well under a 61° gradient) — sameCell must not turn every
    // within-tile elevation change into a wall, only genuinely steep ones.
    const gentleSampler: TerrainSampler = {
      sample: (x, _z) => (x < 0.5 ? 0.6 : 0.7),
      hasColumn: () => true,
      sameCell: () => true,
    };
    const out = resolveTerrainSlide(gentleSampler, { x: -0.15, z: 0 }, { x: 12, z: 0 }, dt, FWD, RIGHT, halfLength, halfWidth, WALL_GRADIENT_THRESHOLD, yRef, CLIMB_THRESHOLD);
    expect(out.vel.x).toBeCloseTo(12, 6);
  });

  // Angle-of-attack (owner acceptance criteria #1): approach the curb at a
  // shallow angle relative to its own run (the wall face runs along Z, so
  // "angle to the wall" is measured from the Z axis) — the tangential (vz)
  // component must survive the slide untouched (I2's v·n<0-only law), only
  // the inward (vx) component gets killed. phi is angle FROM the wall
  // surface (0 = pure graze, 90 = head-on). speed=20 (well above the 6+m/s
  // owner playtest range) guarantees the leading corner's vx component alone
  // still crosses the 0.05m gap to the boundary within one 1/120s substep
  // even at the shallowest tested angle (30°) — this is purely a test-setup
  // margin, not a claim about real playtest speeds.
  function approachAtAngle(phiDeg: number, speed = 20) {
    const phi = (phiDeg * Math.PI) / 180;
    const vx = speed * Math.sin(phi);
    const vz = speed * Math.cos(phi);
    return resolveTerrainSlide(curbSampler, { x: -0.15, z: 0 }, { x: vx, z: vz }, dt, FWD, RIGHT, halfLength, halfWidth, WALL_GRADIENT_THRESHOLD, yRef, CLIMB_THRESHOLD);
  }

  it("30 deg to the wall: slides — tangential (vz) speed survives close to its full input value", () => {
    const speed = 20;
    const vzIn = speed * Math.cos((30 * Math.PI) / 180);
    const out = approachAtAngle(30, speed);
    expect(out.vel.z).toBeGreaterThan(vzIn * 0.9);
    // Inward component killed — resultant speed must be well below the input.
    expect(Math.hypot(out.vel.x, out.vel.z)).toBeLessThan(speed);
  });

  it("50 deg to the wall (owner's acceptance boundary): still slides, tangential speed clearly preserved", () => {
    const speed = 20;
    const vzIn = speed * Math.cos((50 * Math.PI) / 180);
    const out = approachAtAngle(50, speed);
    expect(out.vel.z).toBeGreaterThan(vzIn * 0.9);
  });

  it("90 deg (dead head-on, no tangential component at all): clean stop, no residual energy, no penetration", () => {
    const out = approachAtAngle(90, 20);
    expect(Math.hypot(out.vel.x, out.vel.z)).toBeLessThanOrEqual(0.01);
    expect(out.pos.x).toBeLessThanOrEqual(0.5); // never crossed into the curb
  });

  it("sustained multi-tick contact stays stable: repeatedly stepping into the same curb never penetrates or accumulates residual velocity", () => {
    // Regression for "машинка не должна оказываться в текстурах" — simulate
    // ~30 consecutive substeps of a kart continuously steering into the curb
    // at a shallow angle (as if grazing along it for a full second), and
    // assert position never sinks past the boundary and velocity never
    // blows up (no chatter/energy injection tick over tick).
    let pos = { x: -0.3, z: 0 };
    let maxXReached = -Infinity;
    let maxSpeed = 0;
    for (let i = 0; i < 30; i++) {
      const phi = (35 * Math.PI) / 180;
      const speed = 20;
      const vel = { x: speed * Math.sin(phi), z: speed * Math.cos(phi) };
      const out = resolveTerrainSlide(curbSampler, pos, vel, dt, FWD, RIGHT, halfLength, halfWidth, WALL_GRADIENT_THRESHOLD, yRef, CLIMB_THRESHOLD);
      pos = out.pos;
      maxXReached = Math.max(maxXReached, pos.x);
      maxSpeed = Math.max(maxSpeed, Math.hypot(out.vel.x, out.vel.z));
    }
    expect(maxXReached).toBeLessThan(0.5 - halfLength + 0.01); // leading corner never crosses the curb boundary
    expect(maxSpeed).toBeLessThanOrEqual(20 + 1e-6); // never gains energy tick over tick
  });
});
