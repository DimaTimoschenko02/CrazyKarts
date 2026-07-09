// Regression tests for the terrain-edge slide (successor to
// footprintWall.ts's boolean axis-kill check) — design/notes/collision-v2.md
// §3.3/§9 Phase 1 gate: "грэйз вдоль стены сохраняет тангенциальную
// скорость", "сквозь стену не проходит".
// D3b/D4 regression coverage (design/notes/ride-collision-v2.md, 2026-07-09).
import { describe, expect, it } from "vitest";
import { footprintHalfExtents, footprintPoints, resolveTerrainSlide, tryEscape, type TerrainSampler } from "./terrainWall";
import { DEFAULT_AXLE_GEOMETRY } from "./types";
import { Heightfield } from "../shared/heightfield";

const { halfLength, halfWidth } = footprintHalfExtents(DEFAULT_AXLE_GEOMETRY);
// Same default as KartPhysicsParams.terrainWallGradientThreshold — rise over
// the short WALL_GRADIENT_BASE (0.15m, internal to terrainWall.ts) that
// counts as a wall (≈61°).
const WALL_GRADIENT_THRESHOLD = 0.27;
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
    const out = resolveTerrainSlide(sampler, { x: 0, z: 0 }, vel, dt, FWD, RIGHT, halfLength, halfWidth, WALL_GRADIENT_THRESHOLD);
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
    const out = resolveTerrainSlide(
      sampler,
      { x: 0, z: 0.5 },
      vel,
      dt,
      { x: 0, z: 1 },
      { x: 1, z: 0 },
      halfLength,
      halfWidth,
      WALL_GRADIENT_THRESHOLD
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
  it("driving into a wall_block's side is blocked: its top sits a full 0.5 level above the ground (near-vertical over the short D3b gradient base)", () => {
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
    // across it this substep — the D3b gradient over a 0.15m base straddling
    // that boundary reads ~0.5 (a full level step packed into 15cm, way past
    // WALL_GRADIENT_THRESHOLD), so the inward velocity component must be
    // killed (the block's old SAT AABB is gone; this path is now THE wall
    // mechanism for cube sides).
    const vel = { x: 12, z: 0 };
    const out = resolveTerrainSlide(sampler, { x: -0.15, z: 0 }, vel, dt, FWD, RIGHT, halfLength, halfWidth, WALL_GRADIENT_THRESHOLD);
    expect(out.vel.x).toBeLessThanOrEqual(0.01);
  });

  it("anti-tunneling: a corner crossing DEEP past the wall face in one substep (high speed) is still blocked", () => {
    // Review catch 2026-07-09: at 24 m/s a corner moves 0.2m per substep —
    // more than half the 0.15m gradient base — so BOTH gradient probes can
    // land on the wall's plateau (flat, gradient 0). The cur→next rise
    // backstop must still catch it or fast karts sail straight through
    // walls.
    const hf = Heightfield.fromMapJson({
      meta: { tile_size: 1, level_height: 0.5, origin_offset: [0, 0, 0] },
      cells: [
        { asset: "terrain", x: -1, z: 0, y_level: 0 },
        { asset: "terrain", x: 0, z: 0, y_level: 0 },
        { asset: "wall_block", x: 1, z: 0, y_level: 0 },
      ],
    });
    const sampler = samplerFromHf(hf);
    const dt = 1 / 120;
    const vel = { x: 24, z: 0 }; // 0.2m per substep — deep single-step crossing
    const out = resolveTerrainSlide(sampler, { x: -0.13, z: 0 }, vel, dt, FWD, RIGHT, halfLength, halfWidth, WALL_GRADIENT_THRESHOLD);
    expect(out.vel.x).toBeLessThanOrEqual(0.01);
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
    // strip test, leading corner crossing the rim this substep.
    const vel = { x: 12, z: 0 };
    const out = resolveTerrainSlide(sampler, { x: 1.25, z: 0 }, vel, dt, FWD, RIGHT, 0.3, 0.2, WALL_GRADIENT_THRESHOLD);
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
    const out = resolveTerrainSlide(sampler, { x: 0.5, z: 0 }, vel, dt, FWD, RIGHT, 0.3, 0.2, WALL_GRADIENT_THRESHOLD);
    expect(out.vel.x).toBeCloseTo(3, 6);
  });
});

describe("resolveTerrainSlide — D3a2/D3a3 flush-stacked wall column, sampler mirrors kart.ts's real wiring (symptom A, 2026-07-09)", () => {
  it("driving from a yard floor into a flush wall_block stack is blocked — the OLD flush-floor bug is gone", () => {
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
    // producing a real gradient the existing D3b check catches. solidBlocked
    // (D3a3) is ALSO wired here (matching kart.ts's actual sampler
    // construction) as a second, independent line of defense.
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
    const sampler: TerrainSampler = {
      sample: (x, z) => hf.sampleAt(x, z, yRef, CLIMB),
      hasColumn: (x, z) => hf.hasColumn(x, z),
      solidBlocked: (x, z) => hf.solidBlocked(x, z, yRef, kartTop, CLIMB),
    };
    const dt = 1 / 120;
    const vel = { x: 12, z: 0 };
    const out = resolveTerrainSlide(sampler, { x: -0.15, z: 0 }, vel, dt, FWD, RIGHT, halfLength, halfWidth, WALL_GRADIENT_THRESHOLD);
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
      WALL_GRADIENT_THRESHOLD
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
      WALL_GRADIENT_THRESHOLD
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
      WALL_GRADIENT_THRESHOLD
    );
    expect(Math.hypot(out.vel.x, out.vel.z)).toBeCloseTo(Math.hypot(2, 2), 6);
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
  // direction and refuses blocked ones.
  it("head-on into a pocket's wall is a clean stop: velocity fully drained, not frozen-with-residual", () => {
    // Floor pocket barely longer than the footprint, wall rising ahead.
    const sampler: TerrainSampler = {
      sample: (x, _z) => (x > 0.7 ? 5 : 0),
      hasColumn: () => true,
    };
    const dt = 1 / 120;
    const out = resolveTerrainSlide(sampler, { x: 0, z: 0 }, { x: 12, z: 0 }, dt, FWD, RIGHT, halfLength, halfWidth, WALL_GRADIENT_THRESHOLD);
    expect(Math.hypot(out.vel.x, out.vel.z)).toBeLessThanOrEqual(0.01);
    expect(out.pos.x).toBeCloseTo(0, 6); // stopped at the start, not teleported
  });

  it("tryEscape picks the first candidate direction whose whole footprint move validates (back first)", () => {
    // Wall ahead (+X) only — straight back must validate and win.
    const sampler: TerrainSampler = {
      sample: (x, _z) => (x > 0.7 ? 5 : 0),
      hasColumn: () => true,
    };
    const escaped = tryEscape(sampler, 0, 0, FWD, RIGHT, halfLength, halfWidth, 0.05, WALL_GRADIENT_THRESHOLD);
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
    const escaped = tryEscape(sampler, 0, 0, FWD, RIGHT, halfLength, halfWidth, 0.05, WALL_GRADIENT_THRESHOLD);
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
    const escaped = tryEscape(sampler, 0, 0, FWD, RIGHT, halfLength, halfWidth, 0.15, WALL_GRADIENT_THRESHOLD);
    expect(escaped).toBeNull();
  });
});
