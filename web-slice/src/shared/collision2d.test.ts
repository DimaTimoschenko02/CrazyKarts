// Pure-math regression coverage for the SAT/MTV primitives — see
// design/notes/collision-v2.md §3.1/§9 Phase 0 gate ("box-box overlap/MTV,
// hull-point, segment-poly").
import { describe, expect, it } from "vitest";
import {
  makeAabb,
  makeObb,
  pointInPoly,
  satPolyPoly,
  segmentVsPoly,
  slideVelocity,
  transformLocalPoly,
} from "./collision2d";

describe("satPolyPoly — AABB vs AABB", () => {
  it("returns null for two boxes that don't touch", () => {
    const a = makeAabb(0, 0, 0.5, 0.5);
    const b = makeAabb(3, 0, 0.5, 0.5);
    expect(satPolyPoly(a, b)).toBeNull();
  });

  it("returns the MTV pushing A away from B along the shallowest axis", () => {
    const a = makeAabb(0, 0, 0.5, 0.5); // spans [-0.5,0.5]
    const b = makeAabb(0.8, 0, 0.5, 0.5); // spans [0.3,1.3] — overlap on X = 0.2
    const contact = satPolyPoly(a, b)!;
    expect(contact).not.toBeNull();
    expect(contact.depth).toBeCloseTo(0.2, 6);
    // A is to the LEFT of B, so pushing A away from B means -X.
    expect(contact.n.x).toBeCloseTo(-1, 6);
    expect(contact.n.z).toBeCloseTo(0, 6);
  });

  it("touching-but-not-overlapping boxes are NOT a contact (overlap must be >0)", () => {
    const a = makeAabb(0, 0, 0.5, 0.5);
    const b = makeAabb(1, 0, 0.5, 0.5); // exactly touching at x=0.5
    expect(satPolyPoly(a, b)).toBeNull();
  });

  it("fully-overlapping (nested) boxes resolve along the shallowest containment axis", () => {
    const a = makeAabb(0, 0, 1, 1);
    const b = makeAabb(0, 0, 0.5, 2); // narrower in X, taller in Z
    const contact = satPolyPoly(a, b)!;
    expect(contact).not.toBeNull();
    // Shallowest axis is X (overlap 1.0) vs Z (overlap 2.0) — X wins.
    expect(Math.abs(contact.n.x)).toBeCloseTo(1, 6);
  });
});

describe("satPolyPoly — OBB vs AABB (kart flush against a wall_block)", () => {
  it("a kart OBB approaching a wall AABB along its facing axis resolves with depth matching the overlap", () => {
    // Wall cell centered at (2, 0), 1x1 (half 0.5,0.5) -> spans x in [1.5, 2.5].
    const wall = makeAabb(2, 0, 0.5, 0.5);
    // Kart OBB (approved shape: halfRight 0.42, halfFwd 0.83) facing +X
    // (right=(0,-1) fwd=(1,0), an arbitrary but consistent axis pair),
    // center at x=1.8 -> nose reaches 1.8+0.83=2.63, well past the wall's
    // near face at 1.5 -> penetration on X = 2.63-1.5=1.13... use a shallow
    // approach instead so the test reads as "just grazing in".
    const kartCenter = { x: 1.0, z: 0 };
    const kart = makeObb(kartCenter, 0.42, 0.83, { x: 0, z: -1 }, { x: 1, z: 0 });
    // Kart nose at x=1.0+0.83=1.83, wall near face at 1.5 -> overlap 0.33.
    const contact = satPolyPoly(kart, wall)!;
    expect(contact).not.toBeNull();
    expect(contact.depth).toBeCloseTo(0.33, 6);
    expect(contact.n.x).toBeLessThan(0); // pushed back away from the wall (-X)
  });
});

describe("slideVelocity — I2 (tangential preserved, only inward component gated)", () => {
  it("zeroes only the component of velocity going INTO the wall (v.n<0)", () => {
    const n = { x: 1, z: 0 }; // wall normal points +X (kart is pushed away in +X)
    const vel = { x: -3, z: 5 }; // moving into the wall (-X) while sliding along Z
    const out = slideVelocity(vel, n);
    expect(out.x).toBeCloseTo(0, 6); // inward component removed
    expect(out.z).toBeCloseTo(5, 6); // tangential component untouched
  });

  it("leaves velocity untouched when already separating (v.n>=0)", () => {
    const n = { x: 1, z: 0 };
    const vel = { x: 2, z: -4 };
    const out = slideVelocity(vel, n);
    expect(out).toEqual(vel);
  });

  it("grazing along a wall at an angle preserves the full tangential speed magnitude on a pure-tangent case", () => {
    const n = { x: 0, z: 1 };
    const vel = { x: 6, z: 0 }; // pure tangential, no component along n at all
    const out = slideVelocity(vel, n);
    expect(out).toEqual(vel);
  });
});

describe("transformLocalPoly", () => {
  it("rotates and translates local verts by the given yaw + world offset", () => {
    const local = [{ x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }];
    // 90 degree rotation (yaw convention matches makeObb's right/fwd usage
    // elsewhere in this module — verified numerically here, not re-derived).
    const rotated = transformLocalPoly(local, Math.PI / 2, 5, 5);
    expect(rotated.verts[0].x).toBeCloseTo(5, 5);
    expect(rotated.verts[0].z).toBeCloseTo(4, 5);
  });

  it("zero rotation is a pure translation", () => {
    const local = [{ x: 1, z: 2 }];
    const out = transformLocalPoly(local, 0, 10, -10);
    expect(out.verts[0]).toEqual({ x: 11, z: -8 });
  });
});

describe("pointInPoly — hull-point coverage", () => {
  const hull = { verts: [{ x: -1, z: -1 }, { x: 1, z: -1 }, { x: 1, z: 1 }, { x: -1, z: 1 }] };
  it("center point is inside", () => {
    expect(pointInPoly({ x: 0, z: 0 }, hull)).toBe(true);
  });
  it("a point far outside the hull is outside", () => {
    expect(pointInPoly({ x: 5, z: 5 }, hull)).toBe(false);
  });
  it("a point that WAS blocked by the old bloated circle but is outside the real hull is now correctly outside", () => {
    // Old circle model (design-doc P2 root cause): a circle around this box's
    // corners would have radius sqrt(2)~1.41, so (1.2, 1.2) used to read as
    // "inside" even though the box itself doesn't reach there.
    expect(pointInPoly({ x: 1.2, z: 1.2 }, hull)).toBe(false);
  });
});

describe("segmentVsPoly", () => {
  const box = makeAabb(0, 0, 1, 1); // spans [-1,1] both axes

  it("a segment that crosses the box returns the entry point/normal", () => {
    const hit = segmentVsPoly({ x: -3, z: 0 }, { x: 3, z: 0 }, box)!;
    expect(hit).not.toBeNull();
    expect(hit.point.x).toBeCloseTo(-1, 6);
    expect(hit.point.z).toBeCloseTo(0, 6);
    expect(hit.n.x).toBeCloseTo(-1, 6);
  });

  it("a segment that misses the box entirely returns null", () => {
    const hit = segmentVsPoly({ x: -3, z: 5 }, { x: 3, z: 5 }, box);
    expect(hit).toBeNull();
  });

  it("a segment that starts and stays fully inside the box never crosses an edge from outside", () => {
    // No boundary is ever ENTERED (every half-plane is already satisfied at
    // t=0), so this correctly reports no hit — a segment wholly inside a
    // shape isn't a "collision" for a projectile-vs-obstacle test, it just
    // never reaches an outward-facing edge to cross.
    const hit = segmentVsPoly({ x: 0, z: 0 }, { x: 0.5, z: 0 }, box);
    expect(hit).toBeNull();
  });

  it("a segment entirely past the box on both ends never hits", () => {
    const hit = segmentVsPoly({ x: 5, z: 0 }, { x: 6, z: 0 }, box);
    expect(hit).toBeNull();
  });
});
