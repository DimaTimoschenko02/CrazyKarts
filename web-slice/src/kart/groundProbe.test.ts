// I3 regression coverage — see design/notes/collision-v2.md §4 for the
// concave (V-groove)/convex (ridge) worked examples this pins.
import { describe, expect, it } from "vitest";
import { maxGroundHeight, sampleGroundProbes, type GroundProbes } from "./groundProbe";

const FWD = { x: 0, z: -1 };
const RIGHT = { x: 1, z: 0 };

describe("sampleGroundProbes", () => {
  it("samples center + F/B/R/L at the given half-distances along fwd/right", () => {
    const calls: Array<[number, number]> = [];
    const sample = (x: number, z: number): number | null => {
      calls.push([x, z]);
      return x + z; // arbitrary deterministic function to check offsets
    };
    const probes = sampleGroundProbes(sample, 10, 20, FWD, RIGHT, 0.6, 0.45);
    // center
    expect(probes.center).toBe(30);
    // F: +fwd*0.6 = (10, 20-0.6) = (10, 19.4)
    expect(probes.hF).toBeCloseTo(29.4, 6);
    // B: -fwd*0.6 = (10, 20.6)
    expect(probes.hB).toBeCloseTo(30.6, 6);
    // R: +right*0.45 = (10.45, 20)
    expect(probes.hR).toBeCloseTo(30.45, 6);
    // L: -right*0.45 = (9.55, 20)
    expect(probes.hL).toBeCloseTo(29.55, 6);
    expect(calls).toHaveLength(5);
  });
});

describe("maxGroundHeight — I3 (V-groove doesn't drop the body, ridge doesn't over-lift it)", () => {
  it("V-groove: center reads the low seam, corners read the two slopes -> body mounts the higher slope", () => {
    const probes: GroundProbes = { center: 0.0, hF: 0.3, hB: 0.1, hR: 0.4, hL: 0.05 };
    expect(maxGroundHeight(probes)).toBeCloseTo(0.4, 6);
  });

  it("flat ground: all probes equal -> max is that same value (no regression on ordinary driving)", () => {
    const probes: GroundProbes = { center: 1.0, hF: 1.0, hB: 1.0, hR: 1.0, hL: 1.0 };
    expect(maxGroundHeight(probes)).toBeCloseTo(1.0, 6);
  });

  it("narrow gap: center probe lands on a null seam but corners still read real ground -> NOT a freefall", () => {
    const probes: GroundProbes = { center: null, hF: 0.5, hB: 0.5, hR: 0.5, hL: 0.5 };
    expect(maxGroundHeight(probes)).toBeCloseTo(0.5, 6);
  });

  it("every probe null (fully off the map) -> null, fail-safe freefall per vertical.ts convention", () => {
    const probes: GroundProbes = { center: null, hF: null, hB: null, hR: null, hL: null };
    expect(maxGroundHeight(probes)).toBeNull();
  });

  it("convex ridge: front probe on the peak dominates, tail can hang", () => {
    const probes: GroundProbes = { center: 0.4, hF: 0.5, hB: 0.1, hR: 0.35, hL: 0.35 };
    expect(maxGroundHeight(probes)).toBeCloseTo(0.5, 6);
  });
});
