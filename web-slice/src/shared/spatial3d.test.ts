import { describe, expect, it } from "vitest";
import { anisotropicDist3D, withinProximity3D } from "./spatial3d";

describe("anisotropicDist3D", () => {
  it("collapses to plain XZ (2D) distance when dy=0", () => {
    expect(anisotropicDist3D(3, 0, 4, 2.5)).toBeCloseTo(5, 10); // 3-4-5 triangle
  });

  it("collapses to isotropic 3D distance at verticalWeight=1", () => {
    expect(anisotropicDist3D(3, 4, 0, 1)).toBeCloseTo(5, 10);
  });

  it("scales the Y contribution by verticalWeight, not X/Z", () => {
    // dy=1 weighted 2.5x reads as if it were 2.5m of horizontal separation.
    expect(anisotropicDist3D(0, 1, 0, 2.5)).toBeCloseTo(2.5, 10);
    // dx/dz are never touched by the weight.
    expect(anisotropicDist3D(2.5, 0, 0, 2.5)).toBeCloseTo(2.5, 10);
  });

  it("is symmetric in sign of each delta (distance, not displacement)", () => {
    expect(anisotropicDist3D(-3, -1, -4, 2.5)).toBeCloseTo(anisotropicDist3D(3, 1, 4, 2.5), 10);
  });

  it("degenerates to 0 at the same point", () => {
    expect(anisotropicDist3D(0, 0, 0, 2.5)).toBe(0);
  });
});

describe("withinProximity3D", () => {
  const a = { x: 0, y: 0, z: 0 };

  it("true when both XZ radius and Y gate are satisfied", () => {
    expect(withinProximity3D(a, { x: 0.5, y: 0.2, z: 0 }, 1.0, 1.0)).toBe(true);
  });

  it("false when XZ distance exceeds radiusXZ, even with dy=0", () => {
    expect(withinProximity3D(a, { x: 2, y: 0, z: 0 }, 1.0, 1.0)).toBe(false);
  });

  it("false when |dy| exceeds maxDy, even at the exact same XZ point (bridge-deck gate)", () => {
    expect(withinProximity3D(a, { x: 0, y: 1.1, z: 0 }, 1.0, 1.0)).toBe(false);
  });

  it("true right at the maxDy boundary (inclusive)", () => {
    expect(withinProximity3D(a, { x: 0, y: 1.0, z: 0 }, 1.0, 1.0)).toBe(true);
  });

  it("true right at the radiusXZ boundary (inclusive)", () => {
    expect(withinProximity3D(a, { x: 1.0, y: 0, z: 0 }, 1.0, 1.0)).toBe(true);
  });

  it("is order-independent (a vs b symmetric)", () => {
    const b = { x: 0.6, y: 0.4, z: 0.2 };
    expect(withinProximity3D(a, b, 1.0, 1.0)).toBe(withinProximity3D(b, a, 1.0, 1.0));
  });
});
