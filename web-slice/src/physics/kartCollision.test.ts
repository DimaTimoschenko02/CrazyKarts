import { describe, expect, it } from "vitest";
import { KART_COLLISION_RADIUS, KART_PUSH_VERTICAL_M, resolveKartPush } from "./kartCollision";

describe("resolveKartPush", () => {
  it("does nothing when karts are far apart", () => {
    const res = resolveKartPush(
      { x: 0, z: 0 },
      { x: 5, z: 0 },
      [{ x: 10, y: 0, z: 0, alive: true }]
    );
    expect(res.pos).toEqual({ x: 0, z: 0 });
    expect(res.vel).toEqual({ x: 5, z: 0 });
  });

  it("ignores dead obstacles", () => {
    const res = resolveKartPush(
      { x: 0, z: 0 },
      { x: 0, z: 0 },
      [{ x: 0.5, y: 0, z: 0, alive: false }]
    );
    expect(res.pos).toEqual({ x: 0, z: 0 });
  });

  it("pushes the local kart fully outside the combined radius on overlap", () => {
    // Obstacle sits 1m away along +X, combined radius is 2*KART_COLLISION_RADIUS
    // (deep overlap either way) — read the constant, not a hardcoded number,
    // so this test stays correct across KART_VISUAL_SCALE changes.
    const res = resolveKartPush({ x: 0, z: 0 }, { x: 0, z: 0 }, [{ x: 1, y: 0, z: 0, alive: true }]);
    const dist = Math.hypot(res.pos.x - 1, res.pos.z - 0);
    expect(dist).toBeCloseTo(KART_COLLISION_RADIUS * 2, 6);
    // Pushed AWAY from the obstacle (negative X side).
    expect(res.pos.x).toBeLessThan(0);
  });

  it("zeroes + partially bounces velocity along the closing normal, keeps tangential speed", () => {
    // Obstacle directly ahead on +X; local kart closing straight at it (vx=10)
    // while also sliding sideways (vz=3, tangential to the X-axis normal).
    const res = resolveKartPush(
      { x: 0, z: 0 },
      { x: 10, z: 3 },
      [{ x: 1, y: 0, z: 0, alive: true }]
    );
    // Normal here is exactly -X (pointing from obstacle back to local kart).
    // Closing speed component (+X, i.e. -normal direction) must be reduced,
    // not merely zeroed — RESTITUTION>0 means it actually reverses a bit.
    expect(res.vel.x).toBeLessThan(10);
    expect(res.vel.x).toBeLessThan(0); // bounced backward off the normal
    // Tangential (Z) component is untouched by a purely-X normal.
    expect(res.vel.z).toBeCloseTo(3, 6);
  });

  it("does not add energy when the kart is already separating", () => {
    // Overlapping, but velocity already points away from the obstacle.
    const res = resolveKartPush(
      { x: 0, z: 0 },
      { x: -5, z: 0 },
      [{ x: 1, y: 0, z: 0, alive: true }]
    );
    expect(res.vel.x).toBe(-5); // unchanged — already moving apart
  });

  it("resolves overlap against multiple obstacles sequentially", () => {
    const res = resolveKartPush(
      { x: 0, z: 0 },
      { x: 0, z: 0 },
      [
        { x: 1, y: 0, z: 0, alive: true },
        { x: 0, y: 0, z: 1, alive: true },
      ]
    );
    // Pushed away from both — net position should have moved to negative X
    // and negative Z from the sequential resolution.
    expect(res.pos.x).toBeLessThan(0);
    expect(res.pos.z).toBeLessThan(0);
  });
});

// REAL BUG #3 (collision audit, 2026-07-10): kart-vs-kart push used to be
// pure XZ, so a kart on a bridge deck got shoved by one driving underneath
// it. These pin the vertical gate (KART_PUSH_VERTICAL_M) at the three shapes
// called out in the audit brief: same floor, across a full deck, and on a
// sloped ramp where two karts' Y can legitimately differ by a smaller amount.
describe("resolveKartPush — vertical (floor) gate", () => {
  it("same floor (dy=0): pushes exactly like the Y-blind path used to", () => {
    const res = resolveKartPush({ x: 0, z: 0 }, { x: 0, z: 0 }, [{ x: 1, y: 0, z: 0, alive: true }], KART_COLLISION_RADIUS, 0);
    const dist = Math.hypot(res.pos.x - 1, res.pos.z - 0);
    expect(dist).toBeCloseTo(KART_COLLISION_RADIUS * 2, 6);
    expect(res.pos.x).toBeLessThan(0);
  });

  it("through a floor (dy=1.1, one full deck spacing): no push at all", () => {
    const res = resolveKartPush({ x: 0, z: 0 }, { x: 0, z: 0 }, [{ x: 1, y: 1.1, z: 0, alive: true }], KART_COLLISION_RADIUS, 0);
    expect(res.pos).toEqual({ x: 0, z: 0 });
    expect(res.vel).toEqual({ x: 0, z: 0 });
  });

  it("just past the gate threshold (dy=KART_PUSH_VERTICAL_M+0.01): gate excludes it", () => {
    const res = resolveKartPush(
      { x: 0, z: 0 },
      { x: 0, z: 0 },
      [{ x: 1, y: KART_PUSH_VERTICAL_M + 0.01, z: 0, alive: true }],
      KART_COLLISION_RADIUS,
      0
    );
    expect(res.pos).toEqual({ x: 0, z: 0 });
  });

  it("on a slope (dy=0.4, within a single ramp's plausible divergence): still pushes", () => {
    const res = resolveKartPush({ x: 0, z: 0 }, { x: 0, z: 0 }, [{ x: 1, y: 0.4, z: 0, alive: true }], KART_COLLISION_RADIUS, 0);
    const dist = Math.hypot(res.pos.x - 1, res.pos.z - 0);
    expect(dist).toBeCloseTo(KART_COLLISION_RADIUS * 2, 6);
    expect(res.pos.x).toBeLessThan(0);
  });

  it("selfY defaults to 0 — omitting it behaves like every obstacle is on the local kart's own floor", () => {
    // No selfY argument passed — obstacle at y=0 must still push (default-0 contract).
    const res = resolveKartPush({ x: 0, z: 0 }, { x: 0, z: 0 }, [{ x: 1, y: 0, z: 0, alive: true }]);
    expect(res.pos.x).toBeLessThan(0);
  });
});
