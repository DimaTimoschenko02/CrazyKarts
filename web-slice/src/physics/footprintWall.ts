// Body-footprint-aware terrain wall detection. Pure math, no THREE — same
// "physics/ has no engine deps" convention as bicyclePhysics.ts/kartCollision.ts.
//
// BUG THIS FIXES (owner report, 2026-07-08, map public/maps/map_v2.json):
// kart body visibly clips through terrain_sideCliff slope geometry in a
// narrow drivable corridor around cell (19-20, 41-42) — world x≈-12, z≈10.
// Root cause: kart.ts step 8's old wall check sampled the heightfield at a
// SINGLE point (the kart's own center XZ) and compared it to the height one
// substep-distance away, ALSO at a single point. At ~0.2m/substep (maxSpeed
// 24.5 * dt 1/120) that never "jumps" a full 1m cell in one step, so the
// check never tripped — but the kart's actual body extends ~0.45m to each
// side (trackWidth/2) and ~0.6m fore/aft (wheelbase/2) of that center point.
// In this map's tight terrain_sideCorner/sideCornerInner/sideCliff maze
// (multiple stacked-height corner pieces packed into a 2-3 cell corridor —
// see tools/diagnose_heightfield_holes.ts run against map_v2.json), a
// FLANK of the kart can already be standing on/inside a steep slope's high
// face while the CENTER point is still reading a low, gently-changing
// height — the center-only check sees nothing wrong and lets the kart drive
// straight through the visual mesh at its corners.
//
// Fix: instead of comparing one height sample before/after the move, sample
// a small footprint (center + 4 corners, offset by the kart's own axle
// half-length/half-width — see DEFAULT_AXLE_GEOMETRY) BOTH before and after
// the candidate move, and compare each footprint point's height to the SAME
// corner's height a moment ago (not to a single shared scalar — a kart
// already parked on a slope has corners at genuinely different heights than
// its own center, so comparing every corner's "next" height only to "its
// own previous" height avoids false-positive wall blocks purely from
// existing on an incline).
import type { AxleGeometry } from "./types";

export interface Vec2 {
  x: number;
  z: number;
}

// One footprint sample point, expressed as a multiplier of half-width
// (right axis) and half-length (forward axis) from the body center.
interface FootprintOffset {
  right: number;
  fwd: number;
}

// Center + 4 corners. Corners are where a linear-per-cell heightfield's
// extrema actually land (heightCellFor's h(local) is linear in local x/z
// within one cell, clamped 0..1 — see shared/heightfield.ts), so this covers
// the cases a center-only probe misses without needing a denser grid.
const FOOTPRINT_OFFSETS: readonly FootprintOffset[] = [
  { right: 0, fwd: 0 },
  { right: 1, fwd: 1 },
  { right: 1, fwd: -1 },
  { right: -1, fwd: 1 },
  { right: -1, fwd: -1 },
];

// Half-extents used for the footprint probe — half the kart's own axle
// geometry (DEFAULT_AXLE_GEOMETRY: wheelbase 1.2m, trackWidth 0.9m), the
// same wheel-base-derived distances kart/attitude.ts already probes at for
// pitch/roll. Kept as a function (not a bare constant) so callers can pass a
// non-default AxleGeometry if a future kart type has a different footprint.
export function footprintHalfExtents(axle: AxleGeometry): { halfLength: number; halfWidth: number } {
  return { halfLength: axle.wheelbase * 0.5, halfWidth: axle.trackWidth * 0.5 };
}

// World-space footprint points for a body at (x, z) with the given forward/
// right unit vectors (world XZ, y=0 — same convention as kart/kart.ts
// forwardOf()/rightOf()).
export function footprintPoints(
  x: number,
  z: number,
  fwd: Vec2,
  right: Vec2,
  halfLength: number,
  halfWidth: number
): Vec2[] {
  return FOOTPRINT_OFFSETS.map(o => ({
    x: x + right.x * o.right * halfWidth + fwd.x * o.fwd * halfLength,
    z: z + right.z * o.right * halfWidth + fwd.z * o.fwd * halfLength,
  }));
}

// True if moving the kart's footprint from (curX,curZ) to (nextX,nextZ) —
// same orientation (fwd/right) at both ends, since this is called per-axis
// within a single substep, well before the kart can meaningfully turn —
// would step across a wall: any footprint point either samples off-map
// (null) at the destination, or rises more than `maxStep` above where THAT
// SAME footprint point was a moment ago. See module doc comment for why
// corner-to-corner (not corner-to-center) comparison avoids false positives
// on an existing slope.
export function footprintHitsWall(
  sample: (x: number, z: number) => number | null,
  curX: number,
  curZ: number,
  nextX: number,
  nextZ: number,
  fwd: Vec2,
  right: Vec2,
  maxStep: number,
  halfLength: number,
  halfWidth: number
): boolean {
  const curPoints = footprintPoints(curX, curZ, fwd, right, halfLength, halfWidth);
  const nextPoints = footprintPoints(nextX, nextZ, fwd, right, halfLength, halfWidth);
  for (let i = 0; i < curPoints.length; i++) {
    const hNext = sample(nextPoints[i].x, nextPoints[i].z);
    if (hNext === null) return true; // this corner would leave the map / hit a wall-only cell
    const hCur = sample(curPoints[i].x, curPoints[i].z);
    if (hCur === null) continue; // corner was already off-map a moment ago (e.g. hanging over an edge) — nothing to compare against, don't spuriously block; the center-point path still guards genuine falls
    if (hNext - hCur > maxStep) return true;
  }
  return false;
}
