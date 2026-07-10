import { describe, expect, it } from "vitest";
import {
  chargeFraction,
  clampHoldMs,
  computeLaunchDir3D,
  computeLaunchSpeed,
  dynamitePositionAtT,
} from "./dynamiteSim";

describe("clampHoldMs", () => {
  it("clamps to [0, maxChargeMs]", () => {
    expect(clampHoldMs(-50, 1100)).toBe(0);
    expect(clampHoldMs(500, 1100)).toBe(500);
    expect(clampHoldMs(5000, 1100)).toBe(1100);
  });

  it("treats non-finite/garbage input as 0 (never trust the client)", () => {
    expect(clampHoldMs(NaN, 1100)).toBe(0);
    expect(clampHoldMs(Infinity, 1100)).toBe(0);
  });
});

describe("chargeFraction", () => {
  it("0 at no hold, 1 at max hold, linear between", () => {
    expect(chargeFraction(0, 1100)).toBe(0);
    expect(chargeFraction(1100, 1100)).toBe(1);
    expect(chargeFraction(550, 1100)).toBeCloseTo(0.5, 10);
  });

  it("clamps a hold beyond maxChargeMs to 1", () => {
    expect(chargeFraction(9999, 1100)).toBe(1);
  });
});

describe("computeLaunchSpeed", () => {
  it("interpolates linearly between speedMin and speedMax", () => {
    expect(computeLaunchSpeed(0, 8, 16)).toBe(8);
    expect(computeLaunchSpeed(1, 8, 16)).toBe(16);
    expect(computeLaunchSpeed(0.5, 8, 16)).toBeCloseTo(12, 10);
  });
});

describe("computeLaunchDir3D", () => {
  it("stays a unit vector at any angle", () => {
    const dir = computeLaunchDir3D(0, 40);
    expect(Math.hypot(dir.x, dir.y, dir.z)).toBeCloseTo(1, 10);
  });

  it("points straight up-forward (+Y, -Z) at yaw=0", () => {
    const dir = computeLaunchDir3D(0, 40);
    expect(dir.x).toBeCloseTo(0, 10);
    expect(dir.z).toBeLessThan(0);
    expect(dir.y).toBeCloseTo(Math.sin((40 * Math.PI) / 180), 10);
  });

  it("angle 0 is fully horizontal", () => {
    const dir = computeLaunchDir3D(0, 0);
    expect(dir.y).toBeCloseTo(0, 10);
    expect(dir.z).toBeCloseTo(-1, 10);
  });
});

describe("dynamitePositionAtT", () => {
  it("at t=0 returns the origin", () => {
    const pos = dynamitePositionAtT({ x: 1, y: 2, z: 3 }, { x: 5, y: 5, z: -5 }, 20, 0);
    expect(pos).toEqual({ x: 1, y: 2, z: 3 });
  });

  it("pure horizontal (no gravity, no vertical velocity) advances linearly", () => {
    const pos = dynamitePositionAtT({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -10 }, 0, 2);
    expect(pos).toEqual({ x: 0, y: 0, z: -20 });
  });

  it("gravity pulls the arc down over time (classic projectile parabola)", () => {
    // vy0=10, g=20 -> apex at t=0.5 (y = 10*0.5 - 0.5*20*0.25 = 2.5), lands back
    // near y=0 at t=1 (y = 10 - 0.5*20*1 = 0).
    const apex = dynamitePositionAtT({ x: 0, y: 0, z: 0 }, { x: 0, y: 10, z: 0 }, 20, 0.5);
    expect(apex.y).toBeCloseTo(2.5, 10);
    const landing = dynamitePositionAtT({ x: 0, y: 0, z: 0 }, { x: 0, y: 10, z: 0 }, 20, 1);
    expect(landing.y).toBeCloseTo(0, 10);
  });
});
