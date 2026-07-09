// Dynamic terrain-edge slide — successor to the old footprintWall.ts
// axis-kill check (see design/notes/collision-v2.md §3.3). Handles the two
// cases the SAT static-polygon path (shared/staticColliders.ts) does NOT
// cover, because they aren't discrete authored shapes:
//   1. Genuine off-map edges (heightfield.hasColumn===false — nothing
//      authored there at all).
//   2. A rise between two terrain cells steeper than a kart can climb.
//      Since the 2026-07-08 wall_block rework this is the PRIMARY wall
//      mechanism, not a rare safety net: wall_block*/ground_block cube sides
//      present exactly this full-level 0.5 step, so this path owns
//      block-side collision (the blocks' old SAT AABBs are gone — a 2D poly
//      would shove a kart standing ON a block off it). The blocked corner
//      stops at the cell boundary = the cube's visible face, so this is
//      contour-exact per the owner's collision rule.
//
// Design: reuses shared/collision2d.ts's slideVelocity (I2 — same v·n<0 gate
// as the static-poly resolver) so every contact type in this rework — walls,
// props, and now terrain edges — shares one velocity-slide law. The contact
// NORMAL here is approximated from which footprint corner(s) tripped the
// check (average of their body-relative offset directions, negated) rather
// than a true SAT MTV, because a heightfield edge isn't a polygon with real
// depth — this is "good enough" for the rare cases that still reach this
// path (map boundary, malformed stacked columns), and crucially is now
// BODY-RELATIVE (not "which global x/z axis moved"), which is what actually
// fixes the diagonal-wall corner-clip case footprintWall.ts's doc comment
// described (P1 root cause).
//
// D3b (design/notes/ride-collision-v2.md, 2026-07-09): the wall/slope
// criterion used to be "hNext - hCur > maxStep", sampled at the footprint
// corner's own before/after positions — a distance that's really "however
// far this corner moved this substep", NOT a fixed physical span. At a
// heightfield cell boundary that distance can straddle two differently-
// shaped cells (e.g. two ramps meeting at an angle) and read a height jump
// that has nothing to do with the actual local slope, falsely blocking a
// perfectly climbable ~26° ramp (symptom #5, "клин на стыке наклонных
// блоков"). Replaced with a genuine LOCAL GRADIENT: a short, fixed-length
// probe base (WALL_GRADIENT_BASE, 0.15m — a geometric implementation detail,
// not itself a tuner knob) straddling the corner's DESTINATION position
// along the direction of travel. Wall = rise over that short base exceeds
// `wallGradientThreshold` (a tuner param, KartPhysicsParams.
// terrainWallGradientThreshold — see types.ts doc for the default/rationale).
// This keeps catching genuine walls (a wall_block's near-vertical side rises
// far more than that over 0.15m) while no longer false-positiving on any
// ordinary drivable slope this game authors, regardless of which two cells
// the probe base happens to straddle.
//
// D4 (design/notes/ride-collision-v2.md, 2026-07-09): the slide loop used to
// have a hard freeze on two failure paths — "opposing corners cancel"
// (len<1e-9, e.g. a kart wedged between two obstacles on opposite sides) and
// "still blocked after maxIters" (e.g. a tight V-notch where each slide
// attempt immediately re-blocks against a second wall) — both left the kart
// at its EXACT starting position with a residual nonzero velocity, which
// repeats identically next tick if the caller's heading/velocity input
// hasn't changed (the "вечная петля" in symptom #2). See resolveTerrainSlide
// below for the anti-deadlock escape this adds.
import { slideVelocity, type Vec2 } from "../shared/collision2d";

interface FootprintOffset {
  right: number;
  fwd: number;
}

// Center + 4 corners — same set footprintWall.ts used, still the right probe
// set for a rectangular body's height/off-map extrema (corners are where a
// linear-per-cell heightfield's extrema land).
const FOOTPRINT_OFFSETS: readonly FootprintOffset[] = [
  { right: 0, fwd: 0 },
  { right: 1, fwd: 1 },
  { right: 1, fwd: -1 },
  { right: -1, fwd: 1 },
  { right: -1, fwd: -1 },
];

// D3b — short fixed-length probe base (meters) for the wall/slope gradient
// check, see module doc. Deliberately NOT a KartPhysicsParams tuner field:
// it's the geometric "how local is local" knob, not the "how steep counts as
// a wall" knob (that's wallGradientThreshold, passed in by the caller).
const WALL_GRADIENT_BASE = 0.15;

export function footprintHalfExtents(axle: { wheelbase: number; trackWidth: number }): { halfLength: number; halfWidth: number } {
  return { halfLength: axle.wheelbase * 0.5, halfWidth: axle.trackWidth * 0.5 };
}

export function footprintPoints(x: number, z: number, fwd: Vec2, right: Vec2, halfLength: number, halfWidth: number): Vec2[] {
  return FOOTPRINT_OFFSETS.map(o => ({
    x: x + right.x * o.right * halfWidth + fwd.x * o.fwd * halfLength,
    z: z + right.z * o.right * halfWidth + fwd.z * o.fwd * halfLength,
  }));
}

export interface TerrainSampler {
  sample(x: number, z: number): number | null;
  // See heightfield.ts Heightfield.hasColumn doc — false only for a
  // genuinely unauthored spot (every authored column is walkable now).
  hasColumn(x: number, z: number): boolean;
}

// One footprint corner's before/after check — returns true if this corner's
// move should be treated as hitting a terrain edge (off-map, or a genuine
// wall by the D3b local-gradient criterion — cube sides included, see module
// doc). `dir` is the BODY's movement direction this iteration (same for
// every corner, not a per-corner offset direction) — see module doc D3b.
function cornerBlocked(sampler: TerrainSampler, cur: Vec2, next: Vec2, dir: Vec2, gradientThreshold: number): boolean {
  const hNext = sampler.sample(next.x, next.z);
  if (hNext === null) {
    // Off-map at the destination. hasColumn is redundant with sample===null
    // since the wall_block rework, kept as a cheap belt-and-braces guard in
    // case a null-sampling-but-authored column kind ever returns.
    return !sampler.hasColumn(next.x, next.z);
  }
  const hCur = sampler.sample(cur.x, cur.z);
  if (hCur === null) return false; // corner was already off-map a moment ago — nothing to compare, don't spuriously block

  // D3b: short base straddling the DESTINATION corner along the direction of
  // travel — see module doc for why this replaces the old cur/next diff.
  // Falls back to the already-sampled hCur/hNext when a probe endpoint falls
  // off the map (e.g. right at the world edge) rather than adding a third
  // null-handling branch — a reasonable, conservative clamp to the nearest
  // known sample.
  const half = WALL_GRADIENT_BASE / 2;
  const hA = sampler.sample(next.x - dir.x * half, next.z - dir.z * half) ?? hCur;
  const hB = sampler.sample(next.x + dir.x * half, next.z + dir.z * half) ?? hNext;
  // SIGNED rise along the travel direction, not |...|: only climbing UP a
  // steep face is a wall. A steep drop ahead (plateau edge, block rim,
  // trampoline lip) must stay driveable — the kart sails off and the
  // vertical model handles the fall. An abs() here reads every cliff edge
  // as a wall and re-creates the exact invisible-wall bug this rework
  // exists to kill.
  //
  // The cur→next rise is OR-ed in as the anti-tunneling backstop: a fast
  // corner can cross the face by more than half the gradient base in one
  // substep (0.17m at 20 m/s vs 0.075m half-base), landing BOTH probes on
  // the plateau — gradient reads flat and the kart would sail through the
  // wall. This is the old criterion, but it's no longer the false-positive
  // source it used to be: bilinear grid sampling (D3a) made in-tile heights
  // continuous, and the known cell-seam artifacts top out around 0.2 —
  // under the 0.27 threshold.
  return hB - hA > gradientThreshold || hNext - hCur > gradientThreshold;
}

// D4 anti-deadlock escape — tried only when the main slide loop below never
// once committed a move despite the body still having real velocity (see
// call site). Tries a small, fixed set of candidate directions in order of
// "most likely to actually be free": straight back along -fwd first (the
// direction the design doc calls out explicitly — "назад по heading"), then
// sideways (both lateral directions), then forward as a last resort. Each
// candidate is validated with the SAME corner/gradient check the main loop
// uses (not just assumed clear) so this never shoves the kart through a
// second, different wall. Returns null if every candidate is blocked too
// (genuinely boxed in on every side — rare, and per the design doc's
// invariant this is the one case where staying put is still correct).
// Exported for direct unit testing: with the signed D3b gradient the false
// walls that used to manufacture in-game deadlocks are gone, so the main
// resolveTerrainSlide path can no longer be steered into this branch by any
// simple authored geometry — but it stays as the safety net for exotic
// multi-wall states, and the test suite exercises it directly.
export function tryEscape(
  sampler: TerrainSampler,
  px: number,
  pz: number,
  fwd: Vec2,
  right: Vec2,
  halfLength: number,
  halfWidth: number,
  escapeDist: number,
  gradientThreshold: number
): { x: number; z: number; dir: Vec2 } | null {
  const candidates: Vec2[] = [
    { x: -fwd.x, z: -fwd.z },
    { x: right.x, z: right.z },
    { x: -right.x, z: -right.z },
    { x: fwd.x, z: fwd.z },
  ];
  const curPts = footprintPoints(px, pz, fwd, right, halfLength, halfWidth);
  for (const dir of candidates) {
    const ex = px + dir.x * escapeDist;
    const ez = pz + dir.z * escapeDist;
    const nextPts = footprintPoints(ex, ez, fwd, right, halfLength, halfWidth);
    let blocked = false;
    for (let i = 0; i < curPts.length; i++) {
      if (cornerBlocked(sampler, curPts[i], nextPts[i], dir, gradientThreshold)) {
        blocked = true;
        break;
      }
    }
    if (!blocked) return { x: ex, z: ez, dir };
  }
  return null;
}

// Iteratively resolves a candidate XZ move against genuine terrain edges
// (see module doc). Mirrors resolveKartVsStatic's shape (kart/kart.ts) —
// same MAX_ITERS-bounded slide loop, same v·n<0 gate — but the "contact" is
// derived from footprint-corner sampling instead of a real SAT MTV.
export function resolveTerrainSlide(
  sampler: TerrainSampler,
  pos: Vec2,
  vel: Vec2,
  dt: number,
  fwd: Vec2,
  right: Vec2,
  halfLength: number,
  halfWidth: number,
  wallGradientThreshold: number,
  maxIters = 4
): { pos: Vec2; vel: Vec2 } {
  let px = pos.x;
  let pz = pos.z;
  let vx = vel.x;
  let vz = vel.z;
  const inputSpeed = Math.hypot(vel.x, vel.z);
  let moved = false; // D4: did the blockedCount===0 commit branch ever run this call?

  for (let iter = 0; iter < maxIters; iter++) {
    if (vx === 0 && vz === 0) break;
    const speed = Math.hypot(vx, vz);
    const dir: Vec2 = { x: vx / speed, z: vz / speed };
    const nx = px + vx * dt;
    const nz = pz + vz * dt;
    const curPts = footprintPoints(px, pz, fwd, right, halfLength, halfWidth);
    const nextPts = footprintPoints(nx, nz, fwd, right, halfLength, halfWidth);

    let sumX = 0;
    let sumZ = 0;
    let blockedCount = 0;
    for (let i = 0; i < curPts.length; i++) {
      if (!cornerBlocked(sampler, curPts[i], nextPts[i], dir, wallGradientThreshold)) continue;
      blockedCount++;
      // Body-relative offset direction of this corner (not world axis) —
      // the actual P1 fix: a diagonal wall clips a ROTATED corner, and the
      // push-back direction must be relative to the body, not a global x/z
      // guess. Center (offset 0,0) blocked means the whole footprint is off
      // the map — fall back to pushing straight back along -fwd (can't
      // derive a meaningful corner direction from the zero offset).
      const o = FOOTPRINT_OFFSETS[i];
      if (o.right === 0 && o.fwd === 0) {
        sumX += -fwd.x;
        sumZ += -fwd.z;
      } else {
        sumX += right.x * o.right + fwd.x * o.fwd;
        sumZ += right.z * o.right + fwd.z * o.fwd;
      }
    }

    if (blockedCount === 0) {
      // Clear — commit the full move and stop (common case: no terrain edge
      // nearby this substep).
      px = nx;
      pz = nz;
      moved = true;
      break;
    }

    const len = Math.hypot(sumX, sumZ);
    if (len < 1e-9) break; // degenerate (opposing corners cancelled) — D4 escape below handles this, not a plain freeze anymore
    const n: Vec2 = { x: -sumX / len, z: -sumZ / len }; // negate: push AWAY from the blocked direction
    const slid = slideVelocity({ x: vx, z: vz }, n);
    vx = slid.x;
    vz = slid.z;
    // Loop again with the corrected velocity — if the slid move now clears,
    // it commits on the next iteration's blockedCount===0 branch.
  }

  // D4 anti-deadlock: only fires when the loop above NEVER committed a move
  // (moved===false) AND there's still real velocity magnitude left over
  // (an ordinary head-on wall stop legitimately slides its velocity down to
  // ~0 within one iteration and correctly returns zero displacement — that's
  // not a deadlock, that's a kart stopped against a wall). Genuinely stuck
  // cases (opposing-corner cancellation, or a V-notch that re-blocks every
  // iteration without ever reducing to zero velocity) leave real velocity on
  // the table with zero position change — see module doc.
  if (!moved && inputSpeed > 1e-6 && Math.hypot(vx, vz) > 1e-3) {
    const escapeDist = inputSpeed * dt;
    const escaped = tryEscape(sampler, px, pz, fwd, right, halfLength, halfWidth, escapeDist, wallGradientThreshold);
    if (escaped) {
      px = escaped.x;
      pz = escaped.z;
      vx = escaped.dir.x * inputSpeed;
      vz = escaped.dir.z * inputSpeed;
    } else {
      // Every candidate direction is also blocked — genuinely boxed in.
      // Zero the stale velocity instead of leaving unresolved energy that
      // would otherwise silently persist into next tick's bicycle step.
      vx = 0;
      vz = 0;
    }
  }

  return { pos: { x: px, z: pz }, vel: { x: vx, z: vz } };
}
