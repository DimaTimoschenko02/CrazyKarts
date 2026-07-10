// I3 regression coverage — see design/notes/collision-v2.md §4 for the
// concave (V-groove)/convex (ridge) worked examples this pins.
// D1 regression coverage (design/notes/ride-collision-v2.md, 2026-07-09) —
// wall-probe exclusion ("catapult" fix, symptom #1).
// D5 regression coverage (2026-07-10, follow-up to D1 — see
// tools/diagnose_edge_bugs_sim.ts scenario B4/B5): the exclusion rule is now
// body-relative (kartY/layerClimbThreshold), not center-probe-relative — see
// wallAwareGroundHeight's doc comment in groundProbe.ts for the full
// rationale (a rear-axle probe still resting on a deck was getting excluded
// as a "wall" the instant the CENTER probe alone dipped toward the canal
// ahead, and the kart fell through its own support).
import { describe, expect, it } from "vitest";
import { wallAwareGroundHeight, sampleGroundProbes, type GroundProbes } from "./groundProbe";

const FWD = { x: 0, z: -1 };
const RIGHT = { x: 1, z: 0 };

// Same default as KartPhysicsParams.layerClimbThreshold (types.ts) — the D5
// gate reuses this exact cutoff, not a separate tuner knob.
const CLIMB_THRESHOLD = 0.8;

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

describe("wallAwareGroundHeight — I3 (V-groove doesn't drop the body, ridge doesn't over-lift it)", () => {
  it("V-groove: center reads the low seam, corners read the two slopes -> body mounts the higher slope", () => {
    const probes: GroundProbes = { center: 0.0, hF: 0.15, hB: 0.1, hR: 0.25, hL: 0.05 };
    // Body (kartY) at the same 0.0 the center probe reads — every probe here
    // is well inside CLIMB_THRESHOLD of the body, so this pins the ORIGINAL
    // I3 concern (mounting the higher of two real slopes) without any
    // exclusion kicking in.
    expect(wallAwareGroundHeight(probes, 0.0, CLIMB_THRESHOLD)).toBeCloseTo(0.25, 6);
  });

  it("flat ground: all probes equal -> max is that same value (no regression on ordinary driving)", () => {
    const probes: GroundProbes = { center: 1.0, hF: 1.0, hB: 1.0, hR: 1.0, hL: 1.0 };
    expect(wallAwareGroundHeight(probes, 1.0, CLIMB_THRESHOLD)).toBeCloseTo(1.0, 6);
  });

  it("narrow gap: center probe lands on a null seam but corners still read real ground -> NOT a freefall", () => {
    const probes: GroundProbes = { center: null, hF: 0.5, hB: 0.5, hR: 0.5, hL: 0.5 };
    // kartY no longer depends on center at all (D5) — the body's own real y
    // is supplied directly regardless of whether the center probe itself
    // happened to land on an unauthored seam.
    expect(wallAwareGroundHeight(probes, 0.5, CLIMB_THRESHOLD)).toBeCloseTo(0.5, 6);
  });

  it("every probe null (fully off the map) -> null, fail-safe freefall per vertical.ts convention", () => {
    const probes: GroundProbes = { center: null, hF: null, hB: null, hR: null, hL: null };
    expect(wallAwareGroundHeight(probes, 0.0, CLIMB_THRESHOLD)).toBeNull();
  });

  it("convex ridge: front probe on the peak dominates, tail can hang", () => {
    const probes: GroundProbes = { center: 0.4, hF: 0.5, hB: 0.1, hR: 0.35, hL: 0.35 };
    expect(wallAwareGroundHeight(probes, 0.4, CLIMB_THRESHOLD)).toBeCloseTo(0.5, 6);
  });
});

describe("wallAwareGroundHeight — D1/D5 (genuinely out-of-reach roofs are still excluded)", () => {
  it("a corner probe landing on top of a neighboring obstruction far out of climb reach (>0.8 above the body) is excluded", () => {
    // Kart driving alongside a much taller obstruction: body itself (kartY)
    // sits at 0.0, one corner probe (hR) reads 1.2 above that — genuinely
    // unreachable this tick (well past CLIMB_THRESHOLD), so it must still be
    // excluded as a wall, not lifted into ground height (this is what the
    // original "catapult" bug, symptom #1, needed fixed).
    const probes: GroundProbes = { center: 0.0, hF: 0.02, hB: -0.01, hR: 1.2, hL: 0.01 };
    expect(wallAwareGroundHeight(probes, 0.0, CLIMB_THRESHOLD)).toBeCloseTo(0.02, 6);
  });

  it("all 4 edge probes excluded (kart boxed in on every side, every probe genuinely out of climb reach) -> falls back to the center probe", () => {
    const probes: GroundProbes = { center: 0.1, hF: 1.5, hB: 1.5, hR: 1.5, hL: 1.5 };
    expect(wallAwareGroundHeight(probes, 0.1, CLIMB_THRESHOLD)).toBeCloseTo(0.1, 6);
  });

  it("a probe exactly AT the climb-threshold excess is still kept (not a wall) — exclusion is strictly-greater", () => {
    const probes: GroundProbes = { center: 0.0, hF: 0.8, hB: 0.0, hR: 0.0, hL: 0.0 };
    expect(wallAwareGroundHeight(probes, 0.0, CLIMB_THRESHOLD)).toBeCloseTo(0.8, 6);
  });

  it("a probe a hair past the climb-threshold excess is excluded", () => {
    const probes: GroundProbes = { center: 0.0, hF: 0.801, hB: 0.0, hR: 0.0, hL: 0.0 };
    expect(wallAwareGroundHeight(probes, 0.0, CLIMB_THRESHOLD)).toBeCloseTo(0.0, 6);
  });

  it("the threshold is a genuine tuner knob — a lower value excludes gentler excesses too", () => {
    const probes: GroundProbes = { center: 0.0, hF: 0.4, hB: 0.0, hR: 0.0, hL: 0.0 };
    expect(wallAwareGroundHeight(probes, 0.0, 0.3)).toBeCloseTo(0.0, 6);
    expect(wallAwareGroundHeight(probes, 0.0, 0.5)).toBeCloseTo(0.4, 6);
  });
});

describe("wallAwareGroundHeight — D5 (body-relative gate, 2026-07-10, deck-edge fall-through fix)", () => {
  it("a probe 0.33 above the BODY's own height is still real ground under it (within climb reach) — the diagnosed rear-support-excluded bug", () => {
    // Reproduces the B4/B5 diagnosis shape: the CENTER probe alone (1.8) has
    // already dipped toward lower terrain ahead of the body, but the body's
    // own real y (kartY=2.0, e.g. one tick behind the vertical-follow) is
    // still close to the rear probe (2.33, a genuine support surface only
    // 0.33 above kartY — well inside CLIMB_THRESHOLD). The OLD center-
    // relative rule (D1) would have excluded hB here (2.33 - 1.8 = 0.53 >
    // its old 0.3 default) even though the body is still resting on it.
    const probes: GroundProbes = { center: 1.8, hF: 1.6, hB: 2.33, hR: 1.7, hL: 1.7 };
    expect(wallAwareGroundHeight(probes, 2.0, CLIMB_THRESHOLD)).toBeCloseTo(2.33, 6);
  });

  it("a probe 1.1 above the BODY's own height is genuinely out of climb reach — excluded", () => {
    const probes: GroundProbes = { center: 1.8, hF: 1.6, hB: 3.1, hR: 1.7, hL: 1.7 };
    expect(wallAwareGroundHeight(probes, 2.0, CLIMB_THRESHOLD)).toBeCloseTo(1.8, 6);
  });
});
