import { describe, expect, it } from "vitest";
import { KART_TYPES } from "../../src/kart/stats";
import { DEFAULT_KART_PHYSICS_PARAMS } from "../../src/physics/types";
import {
  computeMineDropIntervalS,
  isMineArmed,
  isMineExpired,
  MINE_DROP_BACK_OFFSET_M,
  MINE_DROP_INTERVAL_S,
} from "./mineSim";

describe("computeMineDropIntervalS", () => {
  it("matches the task spec formula: (1.15 * modelLength / 2) / maxSpeed", () => {
    // modelLength = 1.7 * KART_VISUAL_SCALE(1.5) = 2.55m, maxSpeed = 24.5 m/s
    // (src/kart/stats.ts KART_TYPES.racer, src/physics/types.ts
    // DEFAULT_KART_PHYSICS_PARAMS.maxSpeed) -> T = (1.15*2.55/2)/24.5
    expect(computeMineDropIntervalS(2.55, 24.5)).toBeCloseTo(0.05985, 5);
  });

  it("scales linearly with modelLength and inversely with maxSpeed", () => {
    expect(computeMineDropIntervalS(4, 10)).toBeCloseTo((1.15 * 4) / 2 / 10, 10);
    expect(computeMineDropIntervalS(2, 20)).toBeCloseTo((1.15 * 2) / 2 / 20, 10);
  });

  it("MINE_DROP_INTERVAL_S is the raw formula value widened by the 1.25x spacing multiplier", () => {
    // Owner feedback 2026-07-10: mines dropped too close together — spacing
    // widened by 1.25x on top of the task-spec formula (see mineSim.ts
    // MINE_DROP_INTERVAL_SPACING_MULT).
    const rawFormula = computeMineDropIntervalS(KART_TYPES.racer.modelLength, DEFAULT_KART_PHYSICS_PARAMS.maxSpeed);
    expect(MINE_DROP_INTERVAL_S).toBeCloseTo(rawFormula * 1.25, 10);
    // Sanity-pin the actual live value so a change to modelLength/maxSpeed/the
    // spacing multiplier is a visible, deliberate test update rather than a
    // silent drift. Raw formula was ~0.05985 -> widened to ~0.074813.
    expect(MINE_DROP_INTERVAL_S).toBeCloseTo(0.074813, 5);
  });

  it("MINE_DROP_BACK_OFFSET_M is half the racer's body length", () => {
    expect(MINE_DROP_BACK_OFFSET_M).toBeCloseTo(KART_TYPES.racer.modelLength / 2, 10);
  });
});

describe("isMineArmed", () => {
  it("false before the arm delay elapses", () => {
    expect(isMineArmed(0, 0.8)).toBe(false);
    expect(isMineArmed(0.79, 0.8)).toBe(false);
  });

  it("true once the arm delay elapses", () => {
    expect(isMineArmed(0.8, 0.8)).toBe(true);
    expect(isMineArmed(5, 0.8)).toBe(true);
  });
});

describe("isMineExpired", () => {
  it("false before lifetime elapses", () => {
    expect(isMineExpired(29.9, 30)).toBe(false);
  });

  it("true once lifetime elapses", () => {
    expect(isMineExpired(30, 30)).toBe(true);
    expect(isMineExpired(31, 30)).toBe(true);
  });
});
