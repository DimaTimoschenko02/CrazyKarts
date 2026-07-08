// Pure 2D convex-shape collision primitives (SAT + MTV) — no THREE, no
// engine deps. Shared by the browser bundle (src/kart/kart.ts) AND the
// Colyseus match server (server/, Node — see design/notes/collision-v2.md §6)
// so both sides resolve contact against the exact same math. Everything here
// operates on the arcade's 2.5D convention: shapes live in the XZ plane,
// height is a completely separate axis handled by shared/heightfield.ts.
//
// Design doc: design/notes/collision-v2.md ("Collision v2"). This module
// implements §3.1 (satPolyPoly) and the slide law used by §3.2
// (resolveKartVsStatic, which lives in src/kart/kart.ts — this module only
// holds the pure primitives, not the substep integration loop).

export interface Vec2 {
  x: number;
  z: number;
}

// A convex polygon in world space, vertices wound CCW (looking down +Y, i.e.
// the same "top-down" sense the map/editor already uses). AABB/OBB/hulls are
// all just ConvexPoly with 4/4/<=8 vertices respectively — one algorithm
// handles every static shape family in collision-v2.md §2.
export interface ConvexPoly {
  verts: Vec2[];
}

// Only used for kart-vs-kart (src/physics/kartCollision.ts) — kept as a
// distinct primitive rather than folded into ConvexPoly because that path is
// explicitly NOT touched by this rework (see collision-v2.md §2.1: "две
// разные формы карта — сознательно").
export interface Circle {
  c: Vec2;
  r: number;
}

export interface Contact {
  n: Vec2; // unit normal, points from B toward A (separating direction for A)
  depth: number; // penetration depth along n (>0)
}

function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.z * b.z;
}

function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, z: a.z - b.z };
}

function len(a: Vec2): number {
  return Math.hypot(a.x, a.z);
}

export function normalize(a: Vec2): Vec2 {
  const l = len(a);
  if (l < 1e-9) return { x: 0, z: 0 };
  return { x: a.x / l, z: a.z / l };
}

// Perpendicular to an edge (b-a), i.e. the outward-ish axis to test for that
// edge — normalized separately by the caller (satPolyPoly always normalizes
// before projecting, so an unnormalized perp here is fine too, but we
// normalize at the source to keep every axis a true unit vector — simpler to
// reason about depth units downstream).
function edgeNormal(a: Vec2, b: Vec2): Vec2 {
  const e = sub(b, a);
  return normalize({ x: e.z, z: -e.x });
}

function projectOntoAxis(poly: ConvexPoly, axis: Vec2): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const v of poly.verts) {
    const p = dot(v, axis);
    if (p < min) min = p;
    if (p > max) max = p;
  }
  return [min, max];
}

function polyCenter(poly: ConvexPoly): Vec2 {
  let cx = 0;
  let cz = 0;
  for (const v of poly.verts) {
    cx += v.x;
    cz += v.z;
  }
  return { x: cx / poly.verts.length, z: cz / poly.verts.length };
}

// Separating Axis Theorem + Minimum Translation Vector for two convex
// polygons. Returns null if a separating axis exists (no overlap), otherwise
// the shallowest-penetration normal/depth, normal oriented to push A away
// from B (design doc §3.1). O(edges_A + edges_B) — 4 axes for AABB/OBB pairs,
// up to 8 for a hull, comfortably cheap per substep (see §3.5).
export function satPolyPoly(a: ConvexPoly, b: ConvexPoly): Contact | null {
  if (a.verts.length < 3 || b.verts.length < 3) return null;

  let bestDepth = Infinity;
  let bestAxis: Vec2 | null = null;

  const testEdges = (poly: ConvexPoly): boolean => {
    for (let i = 0; i < poly.verts.length; i++) {
      const p1 = poly.verts[i];
      const p2 = poly.verts[(i + 1) % poly.verts.length];
      const axis = edgeNormal(p1, p2);
      if (axis.x === 0 && axis.z === 0) continue; // degenerate edge, skip
      const [aMin, aMax] = projectOntoAxis(a, axis);
      const [bMin, bMax] = projectOntoAxis(b, axis);
      const overlap = Math.min(aMax, bMax) - Math.max(aMin, bMin);
      if (overlap <= 0) return false; // separating axis found — no contact
      if (overlap < bestDepth) {
        bestDepth = overlap;
        bestAxis = axis;
      }
    }
    return true;
  };

  if (!testEdges(a)) return null;
  if (!testEdges(b)) return null;
  if (!bestAxis) return null;

  // Orient the winning axis so it points from B's center toward A's center —
  // "push A away from B" per the Contact doc comment.
  const centerA = polyCenter(a);
  const centerB = polyCenter(b);
  const centerDelta = sub(centerA, centerB);
  let n = bestAxis as Vec2;
  if (dot(centerDelta, n) < 0) n = { x: -n.x, z: -n.z };

  return { n, depth: bestDepth };
}

// AABB as a ConvexPoly, CCW winding, centered at (cx, cz) with the given
// half-extents. Used for wall_block* cells (collision-v2.md §2.2).
export function makeAabb(cx: number, cz: number, halfX: number, halfZ: number): ConvexPoly {
  return {
    verts: [
      { x: cx - halfX, z: cz - halfZ },
      { x: cx + halfX, z: cz - halfZ },
      { x: cx + halfX, z: cz + halfZ },
      { x: cx - halfX, z: cz + halfZ },
    ],
  };
}

// Oriented box (kart body, structural props) — center + local half-extents
// along caller-supplied unit right/forward axes. Caller passes the axes
// (rather than a bare yaw angle) so this module stays free of any particular
// forward/right convention — see src/kart/kart.ts forwardOf()/rightOf() for
// the convention actually in use (Godot: forward = -Z at yaw 0).
export function makeObb(
  center: Vec2,
  halfRight: number,
  halfFwd: number,
  rightAxis: Vec2,
  fwdAxis: Vec2
): ConvexPoly {
  const r = { x: rightAxis.x * halfRight, z: rightAxis.z * halfRight };
  const f = { x: fwdAxis.x * halfFwd, z: fwdAxis.z * halfFwd };
  // CCW order: -right-fwd, +right-fwd, +right+fwd, -right+fwd.
  return {
    verts: [
      { x: center.x - r.x - f.x, z: center.z - r.z - f.z },
      { x: center.x + r.x - f.x, z: center.z + r.z - f.z },
      { x: center.x + r.x + f.x, z: center.z + r.z + f.z },
      { x: center.x - r.x + f.x, z: center.z - r.z + f.z },
    ],
  };
}

// Rotates + translates a set of LOCAL (already-recentered, per collision-
// v2.md §5) polygon vertices by a Y-axis rotation (radians, same sense as
// kart yaw — see rotateVecByYaw's callers) and a world-space translation.
// Used for structural OBB / natural-decor hull props (shared/staticColliders.ts).
export function transformLocalPoly(localVerts: readonly Vec2[], rotRad: number, tx: number, tz: number): ConvexPoly {
  const cos = Math.cos(rotRad);
  const sin = Math.sin(rotRad);
  return {
    verts: localVerts.map(v => ({
      x: v.x * cos + v.z * sin + tx,
      z: -v.x * sin + v.z * cos + tz,
    })),
  };
}

// I2 (design doc §0/§3.2): gate the normal (inward-only) component of
// velocity, leave the tangential component untouched — this is the ENTIRE
// "slide instead of stop" law, reused identically by static-poly contact
// resolution (kart.ts step 8) and the dynamic terrain-edge slide (physics/
// terrainWall.ts). No restitution: v·n<0 just gets clamped to 0 along n,
// matching resolveKartPush's own v·n<0 guard (kartCollision.ts) for a
// consistent no-energy-added arcade feel across every contact type.
export function slideVelocity(vel: Vec2, n: Vec2): Vec2 {
  const vn = dot(vel, n);
  if (vn >= 0) return vel; // already separating (or parallel) — untouched
  return { x: vel.x - n.x * vn, z: vel.z - n.z * vn };
}

// Point-in-convex-polygon (winding-agnostic: works for both CCW and CW since
// it only checks the SIGN of the cross product is consistent, not that it's
// positive) — listed in collision-v2.md §3.1's primitive set; not on the hot
// kart-resolve path today, but needed by future authoritative-server spawn/
// pickup placement checks and useful standalone test coverage for the shape
// tables this module underpins.
export function pointInPoly(p: Vec2, poly: ConvexPoly): boolean {
  const n = poly.verts.length;
  if (n < 3) return false;
  let sign = 0;
  for (let i = 0; i < n; i++) {
    const a = poly.verts[i];
    const b = poly.verts[(i + 1) % n];
    const cross = (b.x - a.x) * (p.z - a.z) - (b.z - a.z) * (p.x - a.x);
    if (Math.abs(cross) < 1e-9) continue; // on the edge line — inconclusive, keep scanning
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

export interface SegmentHit {
  t: number; // 0..1 along the segment where it first enters the poly
  point: Vec2;
  n: Vec2; // outward normal of the entry edge
}

// Segment-vs-convex-polygon intersection via Cyrus-Beck / half-plane
// clipping: treat each edge as a half-plane (poly interior on one side), and
// shrink the segment's valid [tEnter, tExit] parameter range by every edge in
// turn. Standard convex-clip algorithm — O(edges), exact for any convex
// polygon. Not wired into gameplay yet (P4/server rockets, out of this pass's
// scope per the collision-v2 plan) but part of the shared primitive set §3.1
// calls for, and gets its own unit coverage below so P4 has a ready-tested
// primitive to build on.
export function segmentVsPoly(a: Vec2, b: Vec2, poly: ConvexPoly): SegmentHit | null {
  const d = sub(b, a);
  let tEnter = 0;
  let tExit = 1;
  let enterNormal: Vec2 | null = null;
  const n = poly.verts.length;
  for (let i = 0; i < n; i++) {
    const p1 = poly.verts[i];
    const p2 = poly.verts[(i + 1) % n];
    // Outward normal for a CCW-wound polygon: perp(edge) rotated so it faces
    // away from the polygon's own center.
    const edgeN = edgeNormal(p1, p2);
    const center = polyCenter(poly);
    const outward = dot(sub(p1, center), edgeN) >= 0 ? edgeN : { x: -edgeN.x, z: -edgeN.z };

    const num = dot(sub(p1, a), outward);
    const den = dot(d, outward);
    if (Math.abs(den) < 1e-9) {
      // Segment parallel to this edge — reject outright if it's outside.
      if (num < 0) return null;
      continue;
    }
    const t = num / den;
    if (den < 0) {
      // Entering half-plane
      if (t > tEnter) {
        tEnter = t;
        enterNormal = outward;
      }
    } else {
      // Exiting half-plane
      if (t < tExit) tExit = t;
    }
    if (tEnter > tExit) return null;
  }
  if (!enterNormal || tEnter < 0 || tEnter > 1) return null;
  return {
    t: tEnter,
    point: { x: a.x + d.x * tEnter, z: a.z + d.z * tEnter },
    n: enterNormal,
  };
}
