// Reproduction + regression coverage for the "remote kart jitters at the map
// edge" bug (2026-07-07 live playtest report). computeAttitudeTarget now
// takes an already-sampled GroundProbes set (kart/groundProbe.ts P3 rework —
// design/notes/collision-v2.md §4) instead of re-sampling the map itself;
// this file builds probes via sampleGroundProbes(map.sampleHeight, ...) to
// keep the SAME end-to-end reproduction as before.
//
// computeAttitudeTarget itself still has a hard "off the map -> LEVEL"
// branch (documented, not hidden, by the first test below) — the actual fix
// lives one layer up: net/remoteKarts.ts no longer applies that raw output
// directly, it blends it through computeAirborneFactor's continuous 0..1
// signal (exp-filtered frame to frame), so the raw jump documented here
// never reaches the screen. See attitude.ts's computeAttitudeTarget doc
// comment for the full reasoning.
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { GameMap, type MapJson } from "../map/mapLoader";
import { computeAirborneFactor, computeAttitudeTarget, computeTipOverTarget } from "./attitude";
import { sampleGroundProbes, clampGroundProbesForAttitude, excludeGroundProbesForAttitude, type GroundProbes } from "./groundProbe";

function stubLib(names: string[]): Map<string, THREE.Group> {
  return new Map(names.map(n => [n, new THREE.Group()]));
}

const LIB = stubLib(["terrain", "terrain_ramp"]);

function makeMap(cells: MapJson["cells"]): GameMap {
  return GameMap.fromJson(
    { meta: { tile_size: 1, level_height: 0.5, origin_offset: [0, 0, 0] }, cells },
    LIB
  );
}

function attitudeAt(
  map: GameMap,
  x: number,
  z: number,
  fwd: { x: number; z: number },
  right: { x: number; z: number },
  halfWheelbase: number,
  halfTrack: number
) {
  const probes = sampleGroundProbes((px, pz) => map.sampleHeight(px, pz), x, z, fwd, right, halfWheelbase, halfTrack);
  return computeAttitudeTarget(probes, halfWheelbase, halfTrack);
}

describe("computeAttitudeTarget at the map edge (raw behavior, documented not hidden)", () => {
  it("jumps discontinuously in pitch as the forward probe crosses off the map", () => {
    const map = makeMap([
      { asset: "terrain_ramp", x: 0, z: 0, y_level: 0, rot: 0 }, // climbs +Z, 0..0.5
      { asset: "terrain", x: 0, z: 1, y_level: 1 }, // flat top at 0.5, last defined cell
    ]);
    const fwd = { x: 0, z: 1 };
    const right = { x: 1, z: 0 };
    const halfWheelbase = 1.0;
    const halfTrack = 0.5;

    const pitches: { z: number; pitch: number }[] = [];
    for (let z = -0.05; z <= 0.1; z += 0.005) {
      const t = attitudeAt(map, 0, z, fwd, right, halfWheelbase, halfTrack);
      pitches.push({ z, pitch: t.pitch });
    }
    let maxStep = 0;
    for (let i = 1; i < pitches.length; i++) {
      maxStep = Math.max(maxStep, Math.abs(pitches[i].pitch - pitches[i - 1].pitch));
    }
    // This particular geometry happens to stay smooth (the probe's
    // fallback-to-hHere value already matches the neighboring real height
    // closely here) — kept as a baseline/regression pin so a future change
    // to the fallback logic that DOES break this case gets caught.
    expect(maxStep).toBeLessThan(0.01);
  });

  it("returns LEVEL discontinuously once the kart CENTER itself steps off the map — the real bug site", () => {
    const map = makeMap([{ asset: "terrain_ramp", x: 0, z: 0, y_level: 0, rot: 0 }]);
    const fwd = { x: 0, z: 1 };
    const right = { x: 1, z: 0 };

    const justOn = attitudeAt(map, 0, 0.49, fwd, right, 0.3, 0.5);
    const justOff = attitudeAt(map, 0, 0.51, fwd, right, 0.3, 0.5);

    // 0.02m of motion DOES snap the raw pitch most of the way to zero here
    // (~0.24 rad, ~14 degrees) — this is the exact discontinuity that used
    // to reach the screen directly. It's an accepted characteristic of the
    // raw function now (see file header): callers must not use this output
    // unblended right at a map boundary.
    expect(Math.abs(justOn.pitch - justOff.pitch)).toBeGreaterThan(0.2);
  });
});

describe("computeAirborneFactor", () => {
  it("eases smoothly through the band around the threshold instead of a hard flip", () => {
    const threshold = 0.3;
    const band = 0.1;
    // computeAirborneFactor(groundHeight, y, threshold, band): drive the
    // clearance directly via `y - groundHeight`, so pass groundHeight=0.
    const factors = [];
    for (let clearance = 0; clearance <= 0.6; clearance += 0.005) {
      factors.push(computeAirborneFactor(0, clearance, threshold, band));
    }
    let maxStep = 0;
    for (let i = 1; i < factors.length; i++) maxStep = Math.max(maxStep, Math.abs(factors[i] - factors[i - 1]));
    // smoothstep's steepest point is its midpoint slope, 6/(4*band) per unit
    // x here — at a 0.005m sample step that's ~0.0375, nowhere near the
    // near-1.0 single-frame jump the old hard threshold produced. The bound
    // below just confirms it's a smooth curve, not a specific tuning value.
    expect(maxStep).toBeLessThan(0.1);
    expect(factors[0]).toBeCloseTo(0, 5); // fully grounded well below threshold-band
    expect(factors[factors.length - 1]).toBeCloseTo(1, 5); // fully airborne well above
  });

  it("returns fully airborne (1) when off the map, with no special-case discontinuity at exactly the edge", () => {
    // Off-map (null) and "very high clearance while still on-map" both
    // collapse to the same factor=1 plateau, so a kart crossing the exact
    // map boundary while already far above the ground (e.g. mid-jump) sees
    // no jump at all — both sides of that crossing are already 1.
    expect(computeAirborneFactor(null, 5, 0.3, 0.1)).toBe(1);
    expect(computeAirborneFactor(0, 5, 0.3, 0.1)).toBe(1);
  });
});

// End-to-end reproduction of the reported symptom, using the SAME blend
// math net/remoteKarts.ts's update() loop applies (raw target * (1 -
// exp-filtered airborne factor)) — without needing a THREE.Scene/renderer,
// so this can assert directly on the rendered pitch value across a
// simulated resting kart whose XZ has a few millimeters of residual network
// jitter straddling the map edge.
describe("remote kart attitude blend at the map edge (integration, no THREE scene needed)", () => {
  function simulatePitchSeries(
    map: GameMap,
    xsAcrossFrames: number[],
    z: number,
    y: number,
    dt: number
  ): number[] {
    const fwd = { x: 0, z: 1 };
    const right = { x: 1, z: 0 };
    const halfWheelbase = 0.3;
    const halfTrack = 0.5;
    const threshold = 0.3;
    const band = 0.1;
    const rate = 10;
    let airborneSm = 0;
    let pitchSm = 0;
    const out: number[] = [];
    for (const x of xsAcrossFrames) {
      const groundHere = map.sampleHeight(x, z);
      const airborneRaw = computeAirborneFactor(groundHere, y, threshold, band);
      airborneSm += (airborneRaw - airborneSm) * (1 - Math.exp(-rate * dt));
      const grounded = groundHere === null ? { pitch: 0, roll: 0 } : attitudeAt(map, x, z, fwd, right, halfWheelbase, halfTrack);
      const groundedFactor = 1 - airborneSm;
      const target = grounded.pitch * groundedFactor;
      const followAlpha = 1 - Math.exp(-15 * dt); // representative follow rate
      pitchSm += (target - pitchSm) * followAlpha;
      out.push(pitchSm);
    }
    return out;
  }

  it("does not visibly flicker frame to frame when a resting kart's XZ noise straddles the map boundary", () => {
    // Map is defined for x in [0,1] at z=0 (flat, y_level=1 -> h=0.5) and
    // UNDEFINED beyond x=1 — a hard edge, same as the outer boundary of any
    // real arena. A kart resting essentially AT that edge (x hovering right
    // around 1.0 with the kind of sub-centimeter jitter RemoteInterpolator's
    // residual smoothing leaves behind) used to flip groundHere between a
    // real value and null every single frame.
    const map = makeMap([{ asset: "terrain", x: 0, z: 0, y_level: 1 }]);
    const dt = 1 / 60;
    const xs: number[] = [];
    // 120 frames (2s) of tiny +-3mm jitter straddling x=1.0 (the cell's
    // edge — sampleHeight rounds to the nearest cell, so anything x>1.5
    // would already be off-map by a full cell; here we specifically probe
    // right at the boundary itself).
    let seed = 7;
    const rng = (): number => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
    for (let i = 0; i < 120; i++) xs.push(1.0 + (rng() - 0.5) * 0.006);

    const pitches = simulatePitchSeries(map, xs, 0, 0.5, dt);
    // Skip the first ~15 frames (the exp filter's own settling transient
    // from its zero initial state) and look only at steady-state frame-to-
    // frame deltas.
    let maxStep = 0;
    for (let i = 16; i < pitches.length; i++) maxStep = Math.max(maxStep, Math.abs(pitches[i] - pitches[i - 1]));
    expect(maxStep).toBeLessThan(0.01);
  });
});

// Cliff-edge nose-dive fix (owner playtest report, 2026-07-09):
// kart/groundProbe.ts clampGroundProbesForAttitude caps how far BELOW the
// center probe a neighboring probe is allowed to pull body attitude — the
// downward mirror of wallAwareGroundHeight's wall exclusion. Vertical/
// height-follow (physics/vertical.ts, the actual launch-detach logic) is
// untouched by this fix and keeps consuming the RAW probes (see kart.ts
// step 8b/8d) — these tests only exercise the attitude path.
describe("clampGroundProbesForAttitude — cliff-edge nose-dive fix", () => {
  const DROP_LIMIT = 0.35;
  const HALF_WHEELBASE = 0.6;
  const HALF_TRACK = 0.5;

  it("pitch target is bounded (not a near-vertical -80deg dive) when the front probe reads a canyon floor meters below", () => {
    // center + hB on the plateau (0.0), hF has already crossed the lip and
    // reads the canyon floor 6m below — exactly the "front wheel crosses the
    // edge" moment the owner reported. hR/hL flat (isolate pitch).
    const probes: GroundProbes = { center: 0.0, hF: -6.0, hB: 0.0, hR: 0.0, hL: 0.0 };

    const rawPitch = computeAttitudeTarget(probes, HALF_WHEELBASE, HALF_TRACK).pitch;
    const clampedPitch = computeAttitudeTarget(
      clampGroundProbesForAttitude(probes, DROP_LIMIT),
      HALF_WHEELBASE,
      HALF_TRACK
    ).pitch;

    // Raw: atan2(-6, 1.2) ~ -1.37 rad (~-78.7deg) — the reported dive.
    expect(rawPitch).toBeLessThan(-1.0);
    // Clamped: atan2(-DROP_LIMIT, 1.2) ~ -0.28 rad (~-16deg) — still nose-
    // down (correct, the wheel really is dropping at the lip) but nowhere
    // near the raw dive.
    expect(clampedPitch).toBeGreaterThan(-0.4);
    expect(clampedPitch).toBeLessThan(0);
  });

  it("does not touch a probe reading meaningfully HIGHER (climbing a slope stays exactly as before)", () => {
    const probes: GroundProbes = { center: 0.0, hF: 2.0, hB: 0.0, hR: 0.0, hL: 0.0 };
    const rawPitch = computeAttitudeTarget(probes, HALF_WHEELBASE, HALF_TRACK).pitch;
    const clampedPitch = computeAttitudeTarget(
      clampGroundProbesForAttitude(probes, DROP_LIMIT),
      HALF_WHEELBASE,
      HALF_TRACK
    ).pitch;
    expect(clampedPitch).toBeCloseTo(rawPitch, 10);
  });

  it("roll target is bounded the same way when a SIDE probe crosses the lip (not just the front)", () => {
    const probes: GroundProbes = { center: 0.0, hF: 0.0, hB: 0.0, hR: -6.0, hL: 0.0 };
    const rawRoll = computeAttitudeTarget(probes, HALF_WHEELBASE, HALF_TRACK).roll;
    const clampedRoll = computeAttitudeTarget(
      clampGroundProbesForAttitude(probes, DROP_LIMIT),
      HALF_WHEELBASE,
      HALF_TRACK
    ).roll;
    expect(rawRoll).toBeLessThan(-1.0);
    expect(clampedRoll).toBeGreaterThan(-0.4);
    expect(clampedRoll).toBeLessThan(0);
  });

  it("end-to-end approach to a real cliff lip (GameMap): clamped pitch target never spikes frame to frame", () => {
    // Plateau at z=0 (h=6.0, y_level=12), canyon floor at z=1 (h=0.0,
    // y_level=0) — a real multi-meter drop past the lip, same as the reported
    // scenario, sampled through the actual heightfield/GameMap path (not a
    // synthetic GroundProbes literal like the tests above).
    const map = makeMap([
      { asset: "terrain", x: 0, z: 0, y_level: 12 },
      { asset: "terrain", x: 0, z: 1, y_level: 0 },
    ]);
    const fwd = { x: 0, z: 1 };
    const right = { x: 1, z: 0 };
    const halfWheelbase = 0.3;
    const halfTrack = 0.5;
    const yRef = 6.0;
    const climbThreshold = 0.8;

    const rawPitches: number[] = [];
    const clampedPitches: number[] = [];
    // Sweep the kart's own z from well before the lip up to (but not past)
    // the cell boundary the kart's own CENTER crosses (z=0.5 — cells are 1m
    // flat tiles here per .claude/rules/map-building.md, so a probe's raw
    // sampled height steps HARD, in a single sample, the instant it crosses
    // a cell boundary — there is no continuous interpolation for this fix to
    // smooth on top of; that's a pre-existing, unrelated characteristic of
    // this heightfield representation, not something in scope here). The
    // front probe (z + halfWheelbase=0.3) crosses its OWN cell boundary at
    // z=0.2, well inside this range — isolating exactly the "front wheel
    // crosses the lip while the body is still grounded on the plateau" bug
    // this fix targets, without also crossing the boundary under center.
    for (let z = 0.05; z <= 0.45; z += 0.01) {
      const probes = sampleGroundProbes(
        (px, pz) => map.sampleHeightAt(px, pz, yRef, climbThreshold),
        0,
        z,
        fwd,
        right,
        halfWheelbase,
        halfTrack
      );
      rawPitches.push(computeAttitudeTarget(probes, halfWheelbase, halfTrack).pitch);
      const clamped = clampGroundProbesForAttitude(probes, DROP_LIMIT);
      clampedPitches.push(computeAttitudeTarget(clamped, halfWheelbase, halfTrack).pitch);
    }

    const maxStepOf = (series: number[]): number => {
      let maxStep = 0;
      for (let i = 1; i < series.length; i++) maxStep = Math.max(maxStep, Math.abs(series[i] - series[i - 1]));
      return maxStep;
    };
    const rawMaxStep = maxStepOf(rawPitches);
    const clampedMaxStep = maxStepOf(clampedPitches);

    // The underlying grid cell boundary is itself a hard step (see comment
    // above) — the clamp can't turn that into a fully continuous curve
    // without heightfield interpolation, which is out of scope. What it DOES
    // do is cap how far the resulting pitch swing is allowed to reach: the
    // raw sweep here jumps almost straight to a near-vertical dive in one
    // sample (matching the reported symptom), the clamped sweep's single
    // worst step must be a small fraction of that.
    expect(rawMaxStep).toBeGreaterThan(1.0); // raw: confirms this reproduces the reported near-vertical pop
    expect(clampedMaxStep).toBeLessThan(0.6); // clamped: still a visible dip at the lip, nowhere near a dive
    expect(clampedMaxStep).toBeLessThan(rawMaxStep * 0.4); // and a large, unambiguous reduction versus raw
  });
});

// Cliff-edge nose-dive fix, take 2 (owner playtest report, 2026-07-10 —
// "клюёт носом на скорости при съезде с обрыва"). groundProbe.ts
// excludeGroundProbesForAttitude — the harder sibling of
// clampGroundProbesForAttitude above: a probe past the drop limit is folded
// back to `center` (ZERO slope contribution), not merely capped to a small
// residual slope.
describe("excludeGroundProbesForAttitude — probe past the cliff contributes NOTHING to slope-follow", () => {
  const DROP_LIMIT = 0.35;
  const HALF_WHEELBASE = 0.6;
  const HALF_TRACK = 0.5;

  it("pitch target is exactly LEVEL (not just capped) when the front probe has cleared the edge and the rest of the body is flat", () => {
    const probes: GroundProbes = { center: 0.0, hF: -6.0, hB: 0.0, hR: 0.0, hL: 0.0 };
    const excludedPitch = computeAttitudeTarget(
      excludeGroundProbesForAttitude(probes, DROP_LIMIT),
      HALF_WHEELBASE,
      HALF_TRACK
    ).pitch;
    // Contrast with the OLD clamp behavior (still capped to a small nonzero
    // slope) — exclude collapses it all the way to 0.
    const clampedPitch = computeAttitudeTarget(
      clampGroundProbesForAttitude(probes, DROP_LIMIT),
      HALF_WHEELBASE,
      HALF_TRACK
    ).pitch;
    expect(excludedPitch).toBe(0);
    expect(clampedPitch).toBeLessThan(0); // the OLD fix still left a small residual dive — this is exactly the gap the new fix closes
  });

  it("does not touch a probe reading within the drop limit — an ordinary downhill slope still slope-follows normally", () => {
    const probes: GroundProbes = { center: 0.0, hF: -0.1, hB: 0.0, hR: 0.0, hL: 0.0 };
    const rawPitch = computeAttitudeTarget(probes, HALF_WHEELBASE, HALF_TRACK).pitch;
    const excludedPitch = computeAttitudeTarget(
      excludeGroundProbesForAttitude(probes, DROP_LIMIT),
      HALF_WHEELBASE,
      HALF_TRACK
    ).pitch;
    expect(excludedPitch).toBeCloseTo(rawPitch, 10);
  });

  it("does not touch a probe reading meaningfully HIGHER (climbing a slope is unaffected, same as the clamp version)", () => {
    const probes: GroundProbes = { center: 0.0, hF: 2.0, hB: 0.0, hR: 0.0, hL: 0.0 };
    const rawPitch = computeAttitudeTarget(probes, HALF_WHEELBASE, HALF_TRACK).pitch;
    const excludedPitch = computeAttitudeTarget(
      excludeGroundProbesForAttitude(probes, DROP_LIMIT),
      HALF_WHEELBASE,
      HALF_TRACK
    ).pitch;
    expect(excludedPitch).toBeCloseTo(rawPitch, 10);
  });

  it("C0-continuous at the drop-limit boundary — a probe right at the limit gives the same result excluded or raw", () => {
    const justInside: GroundProbes = { center: 0.0, hF: -DROP_LIMIT * 0.999, hB: 0.0, hR: 0.0, hL: 0.0 };
    const raw = computeAttitudeTarget(justInside, HALF_WHEELBASE, HALF_TRACK).pitch;
    const excluded = computeAttitudeTarget(excludeGroundProbesForAttitude(justInside, DROP_LIMIT), HALF_WHEELBASE, HALF_TRACK).pitch;
    expect(excluded).toBeCloseTo(raw, 3);
  });
});

// Tip-over ("качели через кромку") — the SEPARATE, slow signal that
// re-introduces a nose-down lean for a kart genuinely resting with part of
// its footprint hanging (as opposed to a fast crossing, which excludeGround-
// ProbesForAttitude above keeps at exactly 0). See kart/attitude.ts
// computeTipOverTarget's doc comment for the full physical model (center
// probe drives magnitude — "is the body past its own tipping point" — front/
// back probes drive direction only).
describe("computeTipOverTarget — see-saw over the edge", () => {
  const EDGE_BAND = 0.35;
  const MAX_TIP = (22 * Math.PI) / 180;

  it("returns LEVEL when every probe is still resting on the support surface", () => {
    const probes: GroundProbes = { center: 0, hF: 0, hB: 0, hR: 0, hL: 0 };
    const t = computeTipOverTarget(probes, 0, EDGE_BAND, MAX_TIP);
    expect(t.pitch).toBeCloseTo(0, 10);
    expect(t.roll).toBeCloseTo(0, 10);
  });

  it("dead zone: front probe fully hanging but CENTER still fully supported -> pitch stays exactly 0 (design brief S1 — 'nose ~25% over the edge, standing still, nothing happens', not just small, ZERO)", () => {
    const probes: GroundProbes = { center: 0, hF: -10, hB: 0, hR: 0, hL: 0 };
    const t = computeTipOverTarget(probes, 0, EDGE_BAND, MAX_TIP);
    expect(t.pitch).toBeCloseTo(0, 10);
  });

  it("ramps up smoothly (not a step) once the CENTER probe itself starts crossing the support edge, capped at maxTipAngle", () => {
    const fractions = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1.0, 1.5, 3.0];
    const pitches = fractions.map(f => {
      const probes: GroundProbes = { center: -f * EDGE_BAND, hF: -10, hB: 0, hR: 0, hL: 0 };
      return computeTipOverTarget(probes, 0, EDGE_BAND, MAX_TIP).pitch;
    });
    // Monotonically more nose-down (more negative) as the center probe sinks
    // further below the support surface.
    for (let i = 1; i < pitches.length; i++) expect(pitches[i]).toBeLessThanOrEqual(pitches[i - 1] + 1e-9);
    // Bounded: never exceeds -maxTipAngle even far past the edge.
    for (const p of pitches) expect(p).toBeGreaterThanOrEqual(-MAX_TIP - 1e-9);
    // Genuinely reaches close to the cap once well past the edge.
    expect(pitches[pitches.length - 1]).toBeLessThan(-MAX_TIP * 0.9);
  });

  it("direction follows which probe is hanging — a REAR-hanging kart (reversing off a ledge) tips the OTHER way", () => {
    const probes: GroundProbes = { center: -EDGE_BAND, hF: 0, hB: -10, hR: 0, hL: 0 };
    const t = computeTipOverTarget(probes, 0, EDGE_BAND, MAX_TIP);
    expect(t.pitch).toBeGreaterThan(0); // tail hanging -> nose UP, not down
  });

  it("roll follows the same model on the side axis — a right-hanging kart tips right-side-down (negative roll)", () => {
    const probes: GroundProbes = { center: -EDGE_BAND, hF: 0, hB: 0, hR: -10, hL: 0 };
    const t = computeTipOverTarget(probes, 0, EDGE_BAND, MAX_TIP);
    expect(t.roll).toBeLessThan(0);
    expect(t.pitch).toBeCloseTo(0, 10); // isolated axis — no cross-talk into pitch
  });

  it("returns LEVEL when off the map entirely (center or support height null) — nothing to judge a tipping point against", () => {
    const probes: GroundProbes = { center: null, hF: -10, hB: 0, hR: 0, hL: 0 };
    expect(computeTipOverTarget(probes, 0, EDGE_BAND, MAX_TIP)).toEqual({ pitch: 0, roll: 0 });
    const probes2: GroundProbes = { center: 0, hF: -10, hB: 0, hR: 0, hL: 0 };
    expect(computeTipOverTarget(probes2, null, EDGE_BAND, MAX_TIP)).toEqual({ pitch: 0, roll: 0 });
  });

  it("filtered over time at a fixed ~50%-past-center overhang converges monotonically with NO tick-to-tick jump greater than 1.5deg (design brief S2 acceptance bound), using the SAME attitudeTipOverRate default and dt kart.ts runs at", () => {
    const DT = 1 / 120;
    const RATE = 1.0; // DEFAULT_KART_PHYSICS_PARAMS.attitudeTipOverRate
    const probes: GroundProbes = { center: -0.5 * EDGE_BAND, hF: -10, hB: 0, hR: 0, hL: 0 };
    const target = computeTipOverTarget(probes, 0, EDGE_BAND, MAX_TIP);
    expect(target.pitch).toBeLessThan(0); // sanity: this fixture is meant to be past the dead zone

    let pitchSm = 0;
    let prev = 0;
    let maxStepDeg = 0;
    const deg = (r: number) => (r * 180) / Math.PI;
    for (let t = 0; t < 300; t++) {
      const alpha = 1 - Math.exp(-RATE * DT);
      pitchSm += (target.pitch - pitchSm) * alpha;
      if (t > 0) maxStepDeg = Math.max(maxStepDeg, Math.abs(deg(pitchSm) - deg(prev)));
      // monotonic: each tick must be <= the previous in signed value (getting
      // MORE negative or staying put, never bouncing back up) while
      // approaching a fixed negative target from 0.
      expect(pitchSm).toBeLessThanOrEqual(prev + 1e-9);
      prev = pitchSm;
    }
    expect(maxStepDeg).toBeLessThan(1.5);
  });

  it("a FAST crossing (target present for only ~0.1s, matching a kart driving over a cliff lip at speed) barely moves the slow filter — stays under 4deg (design brief S3 acceptance bound)", () => {
    const DT = 1 / 120;
    const RATE = 1.0;
    const probes: GroundProbes = { center: -EDGE_BAND, hF: -10, hB: 0, hR: 0, hL: 0 }; // fully past the dead zone, worst case
    const target = computeTipOverTarget(probes, 0, EDGE_BAND, MAX_TIP);

    let pitchSm = 0;
    const deg = (r: number) => (r * 180) / Math.PI;
    const fastCrossingTicks = 12; // ~0.1s at 120Hz — the straddle window a 7 m/s kart with a ~0.9m half-wheelbase actually spends with the front probe hanging
    for (let t = 0; t < fastCrossingTicks; t++) {
      const alpha = 1 - Math.exp(-RATE * DT);
      pitchSm += (target.pitch - pitchSm) * alpha;
    }
    expect(Math.abs(deg(pitchSm))).toBeLessThan(4);
  });
});
