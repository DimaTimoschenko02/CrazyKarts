// I3 regression coverage — see design/notes/collision-v2.md §4 for the
// concave (V-groove)/convex (ridge) worked examples this pins.
// D1 regression coverage (design/notes/ride-collision-v2.md, 2026-07-09) —
// wall-probe exclusion ("catapult" fix, symptom #1).
import { describe, expect, it } from "vitest";
import { wallAwareGroundHeight, sampleGroundProbes, type GroundProbes } from "./groundProbe";

const FWD = { x: 0, z: -1 };
const RIGHT = { x: 1, z: 0 };

// Same default the design doc prescribes (= kart/kart.ts MAX_STEP).
const STEP_THRESHOLD = 0.3;

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
    // hR's excess over center was 0.4 in the pre-D1 version of this test —
    // that excess is now past STEP_THRESHOLD and legitimately reads as "this
    // is someone else's roof" under D1's wall exclusion (see the dedicated
    // wall-exclusion test below, which pins EXACTLY that case). Softened to
    // 0.25 here (still a genuinely different slope than hF/hB, still under
    // the step-exclude threshold) so this test keeps pinning the ORIGINAL
    // I3 concern — mounting the higher of two real slopes — without
    // colliding with the new wall classification.
    const probes: GroundProbes = { center: 0.0, hF: 0.15, hB: 0.1, hR: 0.25, hL: 0.05 };
    expect(wallAwareGroundHeight(probes, STEP_THRESHOLD)).toBeCloseTo(0.25, 6);
  });

  it("flat ground: all probes equal -> max is that same value (no regression on ordinary driving)", () => {
    const probes: GroundProbes = { center: 1.0, hF: 1.0, hB: 1.0, hR: 1.0, hL: 1.0 };
    expect(wallAwareGroundHeight(probes, STEP_THRESHOLD)).toBeCloseTo(1.0, 6);
  });

  it("narrow gap: center probe lands on a null seam but corners still read real ground -> NOT a freefall, no wall classification possible", () => {
    const probes: GroundProbes = { center: null, hF: 0.5, hB: 0.5, hR: 0.5, hL: 0.5 };
    expect(wallAwareGroundHeight(probes, STEP_THRESHOLD)).toBeCloseTo(0.5, 6);
  });

  it("every probe null (fully off the map) -> null, fail-safe freefall per vertical.ts convention", () => {
    const probes: GroundProbes = { center: null, hF: null, hB: null, hR: null, hL: null };
    expect(wallAwareGroundHeight(probes, STEP_THRESHOLD)).toBeNull();
  });

  it("convex ridge: front probe on the peak dominates, tail can hang", () => {
    const probes: GroundProbes = { center: 0.4, hF: 0.5, hB: 0.1, hR: 0.35, hL: 0.35 };
    expect(wallAwareGroundHeight(probes, STEP_THRESHOLD)).toBeCloseTo(0.5, 6);
  });
});

describe("wallAwareGroundHeight — D1 (catapult fix, symptom #1)", () => {
  it("a corner probe landing on top of a neighboring wall_block (full 0.5 step) is excluded, not lifted into ground height", () => {
    // Kart driving alongside a wall_block: center is on flat ground (0.0),
    // one corner probe (hR) strayed onto the block's flat top (0.5m above
    // center — a full level step, way past STEP_THRESHOLD). Old plain-MAX
    // would report groundHeight=0.5 here (a full block-height jump versus
    // the previous tick's ~0.0), which fed the vertical rate-detector a huge
    // implied vy and launched the kart. wallAwareGroundHeight must ignore hR
    // entirely and report the real ground height under the body (max of the
    // remaining non-wall probes).
    const probes: GroundProbes = { center: 0.0, hF: 0.02, hB: -0.01, hR: 0.5, hL: 0.01 };
    expect(wallAwareGroundHeight(probes, STEP_THRESHOLD)).toBeCloseTo(0.02, 6);
  });

  it("all 4 edge probes excluded (kart boxed in on every side, e.g. a 1-cell pit) -> falls back to the center probe", () => {
    const probes: GroundProbes = { center: 0.1, hF: 0.6, hB: 0.6, hR: 0.6, hL: 0.6 };
    expect(wallAwareGroundHeight(probes, STEP_THRESHOLD)).toBeCloseTo(0.1, 6);
  });

  it("a probe exactly AT the threshold excess is still kept (not a wall) — exclusion is strictly-greater", () => {
    const probes: GroundProbes = { center: 0.0, hF: 0.3, hB: 0.0, hR: 0.0, hL: 0.0 };
    expect(wallAwareGroundHeight(probes, STEP_THRESHOLD)).toBeCloseTo(0.3, 6);
  });

  it("a probe a hair past the threshold excess is excluded", () => {
    const probes: GroundProbes = { center: 0.0, hF: 0.301, hB: 0.0, hR: 0.0, hL: 0.0 };
    expect(wallAwareGroundHeight(probes, STEP_THRESHOLD)).toBeCloseTo(0.0, 6);
  });

  it("the threshold is a genuine tuner knob — a lower value excludes gentler excesses too", () => {
    const probes: GroundProbes = { center: 0.0, hF: 0.15, hB: 0.0, hR: 0.0, hL: 0.0 };
    expect(wallAwareGroundHeight(probes, 0.1)).toBeCloseTo(0.0, 6);
    expect(wallAwareGroundHeight(probes, 0.2)).toBeCloseTo(0.15, 6);
  });
});
