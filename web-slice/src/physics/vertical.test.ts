import { describe, expect, it } from "vitest";
import { createVerticalState, stepVertical, type VerticalParams, type VerticalState } from "./vertical";

const P: VerticalParams = {
  gravity: 20,
  groundFollowRate: 20,
  airborneDropThreshold: 4.0,
  landingMargin: 0.04,
  groundSnapDistance: 0.07, // matches DEFAULT_KART_PHYSICS_PARAMS.groundSnapDistance
};

const DT = 1 / 120;

describe("stepVertical — grounded follow", () => {
  it("follows a flat ground height exactly (no drift)", () => {
    let s = createVerticalState(0);
    for (let i = 0; i < 60; i++) s = stepVertical(s, { groundHeight: 0, detachRefHeight: 0, dt: DT }, P);
    expect(s.airborne).toBe(false);
    expect(s.y).toBeCloseTo(0, 6);
  });

  it("smoothly climbs a gentle continuous slope without ever going airborne", () => {
    // Height rises 0.005 per substep — much gentler than gravity could ever
    // account for as a "drop", so this must never trigger a launch.
    let s = createVerticalState(0);
    let h = 0;
    for (let i = 0; i < 200; i++) {
      h += 0.005;
      s = stepVertical(s, { groundHeight: h, detachRefHeight: h, dt: DT }, P);
      expect(s.airborne).toBe(false);
    }
    expect(s.y).toBeGreaterThan(0.9);
  });

  it("does not chatter airborne on/off from heightfield micro-noise", () => {
    let s = createVerticalState(0);
    const noise = [0, 0.002, -0.001, 0.0015, -0.0008, 0.001, 0, -0.0012];
    let flips = 0;
    let wasAirborne = false;
    for (let i = 0; i < 200; i++) {
      const h = noise[i % noise.length];
      s = stepVertical(s, { groundHeight: h, detachRefHeight: h, dt: DT }, P);
      if (s.airborne !== wasAirborne) flips++;
      wasAirborne = s.airborne;
    }
    expect(flips).toBe(0);
  });
});

describe("stepVertical — launch off a ramp lip", () => {
  it("launches upward (positive vy) when a climbing ramp ends in a sudden drop", () => {
    let s = createVerticalState(0);
    // Climb steadily (steep ramp: rises fast enough to build a large positive
    // implied vy), then the ground suddenly drops far below — simulating
    // driving off the top of a ramp into open air / a lower level.
    let h = 0;
    for (let i = 0; i < 30; i++) {
      h += 0.05; // steep, deliberate climb
      s = stepVertical(s, { groundHeight: h, detachRefHeight: h, dt: DT }, P);
      expect(s.airborne).toBe(false);
    }
    const vyBeforeDrop = s.vy;
    expect(vyBeforeDrop).toBeGreaterThan(1); // was genuinely climbing
    s = stepVertical(s, { groundHeight: h - 5, detachRefHeight: h - 5, dt: DT }, P); // cliff after the ramp
    expect(s.airborne).toBe(true);
    expect(s.vy).toBeCloseTo(vyBeforeDrop, 6); // launched carrying the climb rate
    expect(s.vy).toBeGreaterThan(1);
  });

  it("also launches (falls, vy~=0) walking slowly off a flat cliff edge", () => {
    let s = createVerticalState(0);
    for (let i = 0; i < 30; i++) s = stepVertical(s, { groundHeight: 0, detachRefHeight: 0, dt: DT }, P);
    expect(s.vy).toBeCloseTo(0, 3);
    s = stepVertical(s, { groundHeight: -5, detachRefHeight: -5, dt: DT }, P);
    expect(s.airborne).toBe(true);
    expect(Math.abs(s.vy)).toBeLessThan(0.5); // launched near-level, not glued down
  });

  it("traces a parabola while airborne (pure ballistic, no ground-follow)", () => {
    let s: VerticalState = { y: 0, vy: 5, airborne: true, groundHeightPrev: null };
    const g = P.gravity;
    let tExpected = 0;
    for (let i = 0; i < 30; i++) {
      s = stepVertical(s, { groundHeight: -100, detachRefHeight: -100, dt: DT }, P); // ground far below, never lands
      tExpected += DT;
      const expectedVy = 5 - g * tExpected;
      expect(s.vy).toBeCloseTo(expectedVy, 5);
    }
  });

  it("lands without a bounce and preserves the (caller-owned) horizontal velocity concept", () => {
    // vy starts positive (apex not yet reached), ground close below —
    // must NOT land while still ascending even if within landingMargin.
    let s: VerticalState = { y: 0.01, vy: 3, airborne: true, groundHeightPrev: null };
    s = stepVertical(s, { groundHeight: 0, detachRefHeight: 0, dt: DT }, P);
    expect(s.airborne).toBe(true); // still rising, must not snap down

    // Now simulate falling back down onto flat ground.
    s = { y: 0.5, vy: -1, airborne: true, groundHeightPrev: null };
    for (let i = 0; i < 200 && s.airborne; i++) {
      s = stepVertical(s, { groundHeight: 0, detachRefHeight: 0, dt: DT }, P);
    }
    expect(s.airborne).toBe(false);
    expect(s.vy).toBe(0); // no bounce
    expect(s.y).toBeCloseTo(0, 6);
  });
});

// Real arena_slice ramp geometry: rise=0.5m over a 1m tile (see
// shared/heightfield.ts + .claude/rules/map-building.md) → slope angle
// atan(0.5/1) ≈ 26.565deg. A kart's vertical climb rate while riding that
// ramp is horizontalSpeed * sin(26.565deg) ≈ horizontalSpeed * 0.4472.
const RAMP_SLOPE_VSIN = Math.sin(Math.atan(0.5 / 1));

describe("stepVertical — launch off a flattening ramp top (trampoline)", () => {
  it("does not launch (or launches imperceptibly) when creeping up a ramp that flattens", () => {
    // Slow crawl: ~4 m/s kart speed (owner playtest "crawl" range 3-5 m/s) ->
    // ~1.79 m/s climb rate, well under the airborneDropThreshold margin.
    const climbRate = 4 * RAMP_SLOPE_VSIN;
    let s = createVerticalState(0);
    let h = 0;
    for (let i = 0; i < 60; i++) {
      h += climbRate * DT;
      s = stepVertical(s, { groundHeight: h, detachRefHeight: h, dt: DT }, P);
      expect(s.airborne).toBe(false);
    }
    for (let i = 0; i < 30; i++) {
      s = stepVertical(s, { groundHeight: h, detachRefHeight: h, dt: DT }, P); // ramp flattens
    }
    expect(s.airborne).toBe(false); // stays glued to the now-flat ramp top
    // Ground-follow exp filter still has a little catch-up lag to clear after
    // 30 flat ticks (see vertical.ts header on follow-filter lag) — 2 decimal
    // places (1cm) is plenty tight to prove it settled onto the ramp top.
    expect(s.y).toBeCloseTo(h, 2);
  });

  it("launches a real trampoline arc when cruising up a ramp that flattens", () => {
    // Cruise: ~18 m/s kart speed (owner playtest "cruise" range 15-22 m/s)
    // -> ~8.05 m/s climb rate, well past the airborneDropThreshold margin.
    const climbRate = 18 * RAMP_SLOPE_VSIN;
    let s = createVerticalState(0);
    let h = 0;
    for (let i = 0; i < 60; i++) {
      h += climbRate * DT;
      s = stepVertical(s, { groundHeight: h, detachRefHeight: h, dt: DT }, P);
      expect(s.airborne).toBe(false);
    }
    const vyBeforeFlatten = s.vy;
    expect(vyBeforeFlatten).toBeCloseTo(climbRate, 1);

    s = stepVertical(s, { groundHeight: h, detachRefHeight: h, dt: DT }, P); // ramp flattens, ground stops rising
    expect(s.airborne).toBe(true); // launches on the very first flat tick
    expect(s.vy).toBeCloseTo(vyBeforeFlatten, 6); // carries the climb rate upward
  });

  it("traces the expected trampoline arc (apex height + flight time) at production gravity", () => {
    // Same cruise scenario as above, but at the tuned production gravity
    // (22 m/s^2, DEFAULT_KART_PHYSICS_PARAMS.verticalGravity) so the apex
    // numbers below are what the game actually ships.
    const g = 22;
    const params: VerticalParams = { ...P, gravity: g };
    const climbRate = 18 * RAMP_SLOPE_VSIN;

    let s = createVerticalState(0);
    let h = 0;
    for (let i = 0; i < 60; i++) {
      h += climbRate * DT;
      s = stepVertical(s, { groundHeight: h, detachRefHeight: h, dt: DT }, params);
    }
    s = stepVertical(s, { groundHeight: h, detachRefHeight: h, dt: DT }, params); // launch tick
    expect(s.airborne).toBe(true);
    const launchY = s.y;
    const launchVy = s.vy;

    // Analytical apex height / flight time from the launch vy.
    const expectedApex = launchY + (launchVy * launchVy) / (2 * g);
    const expectedFlightTime = (2 * launchVy) / g;

    let maxY = launchY;
    let t = 0;
    let landed = false;
    let flightTime = 0;
    for (let i = 0; i < 400 && !landed; i++) {
      s = stepVertical(s, { groundHeight: h, detachRefHeight: h, dt: DT }, params); // ground stays at the flattened height
      t += DT;
      maxY = Math.max(maxY, s.y);
      if (!s.airborne) {
        landed = true;
        flightTime = t;
      }
    }

    expect(landed).toBe(true);
    expect(maxY).toBeCloseTo(expectedApex, 1);
    // flightTime is quantized to whole DT ticks and the landing snap also
    // eats up to one landingMargin's worth of extra fall time, so this is
    // necessarily a looser tolerance than the (continuous) apex height above.
    expect(flightTime).toBeCloseTo(expectedFlightTime, 0);
    // Order-of-magnitude sanity check against the design brief (~1-1.5m arc,
    // sub-second hang time) — a bit over 1.5m is fine, this is a real
    // trampoline, not a token hop.
    expect(maxY - launchY).toBeGreaterThan(0.8);
    expect(maxY - launchY).toBeLessThan(2.0);
  });
});

describe("stepVertical — D2 positional detachment (convex ridge crest, symptom #3)", () => {
  // A moderate grade reversal (climb rate C, then IMMEDIATELY declining at
  // the mirrored rate -C — the convex-ridge crest case) chosen so the RATE
  // detector's own margin (vy - groundRateNow, up to ~2C right at the kink)
  // stays UNDER airborneDropThreshold(4.0) — isolating D2's positional check
  // as the only thing that can detach the kart here. See RAMP_SLOPE_VSIN
  // above for where a rate like this comes from physically (a mid-range
  // kart speed on the arena_slice grade).
  function rideOverRidge(climbRate: number, snapDistance: number): { everAirborne: boolean; firstAirborneAt: number } {
    const params: VerticalParams = { ...P, groundSnapDistance: snapDistance };
    let s = createVerticalState(0);
    let h = 0;
    // Climb to a steady-state follow-lag first.
    for (let i = 0; i < 90; i++) {
      h += climbRate * DT;
      s = stepVertical(s, { groundHeight: h, detachRefHeight: h, dt: DT }, params);
    }
    // Crest: ground immediately reverses to declining at the same rate.
    for (let i = 0; i < 90; i++) {
      h -= climbRate * DT;
      s = stepVertical(s, { groundHeight: h, detachRefHeight: h, dt: DT }, params);
      if (s.airborne) return { everAirborne: true, firstAirborneAt: i };
    }
    return { everAirborne: s.airborne, firstAirborneAt: -1 };
  }

  it("a moderate crest eventually detaches the kart even though the rate detector alone never trips", () => {
    const result = rideOverRidge(1.7, 0.07);
    expect(result.everAirborne).toBe(true);
  });

  it("a gentler crest (small follow-lag, under groundSnapDistance) stays glued — not every tiny dip launches", () => {
    const result = rideOverRidge(0.8, 0.07);
    expect(result.everAirborne).toBe(false);
  });

  it("groundSnapDistance is a genuine tuner knob: tightening it catches the same crest sooner", () => {
    const loose = rideOverRidge(1.7, 0.2);
    const tight = rideOverRidge(1.7, 0.03);
    expect(tight.everAirborne).toBe(true);
    // Looser threshold either never detaches on this same crest, or detaches
    // meaningfully later than the tight one.
    if (loose.everAirborne) {
      expect(loose.firstAirborneAt).toBeGreaterThan(tight.firstAirborneAt);
    }
  });
});

describe("stepVertical — params drive the thresholds", () => {
  it("a higher airborneDropThreshold requires a steeper drop to launch", () => {
    const loose: VerticalParams = { ...P, airborneDropThreshold: 0.1 };
    const strict: VerticalParams = { ...P, airborneDropThreshold: 50 };

    let sLoose = createVerticalState(0);
    let sStrict = createVerticalState(0);
    // Prime a previous ground sample at flat 0 first (the launch detector is
    // rate-based — it needs one prior sample to measure a rate from), then
    // apply a moderate one-tick drop: not a ramp launch, just a modest
    // downhill tick, which is exactly what the threshold margin is for.
    sLoose = stepVertical(sLoose, { groundHeight: 0, detachRefHeight: 0, dt: DT }, loose);
    sStrict = stepVertical(sStrict, { groundHeight: 0, detachRefHeight: 0, dt: DT }, strict);
    sLoose = stepVertical(sLoose, { groundHeight: -0.05, detachRefHeight: -0.05, dt: DT }, loose);
    sStrict = stepVertical(sStrict, { groundHeight: -0.05, detachRefHeight: -0.05, dt: DT }, strict);
    expect(sLoose.airborne).toBe(true);
    expect(sStrict.airborne).toBe(false);
  });

  it("gravity param changes the fall acceleration", () => {
    let s1: VerticalState = { y: 10, vy: 0, airborne: true, groundHeightPrev: null };
    let s2: VerticalState = { y: 10, vy: 0, airborne: true, groundHeightPrev: null };
    const lowG: VerticalParams = { ...P, gravity: 5 };
    const highG: VerticalParams = { ...P, gravity: 40 };
    for (let i = 0; i < 30; i++) {
      s1 = stepVertical(s1, { groundHeight: -100, detachRefHeight: -100, dt: DT }, lowG);
      s2 = stepVertical(s2, { groundHeight: -100, detachRefHeight: -100, dt: DT }, highG);
    }
    expect(Math.abs(s2.vy)).toBeGreaterThan(Math.abs(s1.vy));
  });
});

describe("stepVertical — D3 (design/notes/ride-collision-v2.md, 2026-07-09, symptom B1) — detachRefHeight, not groundHeight, drives launch/detach", () => {
  it("a one-tick groundHeight drop (simulating a wallAwareGroundHeight probe include/exclude flip) does NOT launch when detachRefHeight stays smooth", () => {
    let s = createVerticalState(0);
    for (let i = 0; i < 30; i++) s = stepVertical(s, { groundHeight: 0, detachRefHeight: 0, dt: DT }, P);
    expect(s.airborne).toBe(false);
    // groundHeight DROPS a full probe-exclusion step in one tick (this is
    // exactly what wallAwareGroundHeight's stepExcludeThreshold produces on
    // an ordinary slope when a corner probe that was propping up the MAX
    // crosses it and gets excluded — see groundProbe.ts) — the rate detector
    // reads a discrete drop in groundHeight as "the ground fell away", the
    // false-trampoline mechanism symptom B1 describes. The CONTINUOUS center
    // probe (detachRefHeight) barely moved this same tick.
    s = stepVertical(s, { groundHeight: -0.35, detachRefHeight: -0.001, dt: DT }, P);
    expect(s.airborne).toBe(false);
  });

  it("a one-tick UPWARD groundHeight step (probe INCLUSION at the deck arrival) does not launch on the following ticks either — the follow-filter vy spike is capped", () => {
    // The exact trace from the roads_v1 diagnosis (symptom B1): climbing a
    // 20.1° slope at 6 m/s (real climb rate 2.2 m/s), the front probe rides
    // just past stepExcludeThreshold; the moment it reaches the flat deck it
    // re-enters wallAwareGroundHeight's MAX and the follow TARGET jumps
    // +0.335 in one tick while the center probe stays smooth. The rate
    // detector's own signal (detachRefHeight) is clean — the danger is the
    // follow filter converting the target step into a phantom vy≈6-7 that
    // clears `vy - groundRateNow > threshold` on the NEXT tick. The stored
    // vy is capped against the ground's own rate to kill exactly this.
    const CLIMB = 2.2; // m/s, ground rise rate on the slope
    let s = createVerticalState(0);
    let h = 0;
    for (let i = 0; i < 60; i++) {
      h += CLIMB * DT;
      s = stepVertical(s, { groundHeight: h, detachRefHeight: h, dt: DT }, P);
    }
    expect(s.airborne).toBe(false);
    // probe inclusion: follow target jumps ahead by a full exclusion step,
    // center probe keeps its smooth slope rate — and keeps climbing after.
    for (let i = 0; i < 30; i++) {
      h += CLIMB * DT;
      s = stepVertical(s, { groundHeight: h + 0.335, detachRefHeight: h, dt: DT }, P);
      expect(s.airborne).toBe(false);
    }
  });

  it("the SAME discrete groundHeight drop WOULD have launched under the old (groundHeight-only) rate check — proves detachRefHeight is load-bearing here, not a no-op", () => {
    // Same scenario as above, but detachRefHeight is wired to drop WITH
    // groundHeight (i.e. behaving like the pre-D3 code, which had no
    // separate signal) — this must launch, confirming the smooth-signal
    // case above isn't passing "by accident" (e.g. a threshold that never
    // fires regardless of input).
    let s = createVerticalState(0);
    for (let i = 0; i < 30; i++) s = stepVertical(s, { groundHeight: 0, detachRefHeight: 0, dt: DT }, P);
    s = stepVertical(s, { groundHeight: -0.35, detachRefHeight: -0.35, dt: DT }, P);
    expect(s.airborne).toBe(true);
  });

  it("a real cliff/trampoline launch still fires when BOTH signals genuinely rise together (real geometry, not a probe artifact)", () => {
    // Cruise-speed climb up a ramp that flattens — detachRefHeight tracks
    // groundHeight exactly (a real, continuous slope has no probe-exclusion
    // discontinuity to diverge from), so the launch must still fire on the
    // very first flat tick, same contract as the pre-D3 "trampoline" test
    // above.
    const climbRate = 18 * RAMP_SLOPE_VSIN;
    let s = createVerticalState(0);
    let h = 0;
    for (let i = 0; i < 60; i++) {
      h += climbRate * DT;
      s = stepVertical(s, { groundHeight: h, detachRefHeight: h, dt: DT }, P);
      expect(s.airborne).toBe(false);
    }
    const vyBeforeFlatten = s.vy;
    s = stepVertical(s, { groundHeight: h, detachRefHeight: h, dt: DT }, P); // ramp flattens
    expect(s.airborne).toBe(true);
    expect(s.vy).toBeCloseTo(vyBeforeFlatten, 6);
  });

  it("falls back to groundHeight when detachRefHeight is null (caller's center probe off the map)", () => {
    let s = createVerticalState(0);
    for (let i = 0; i < 30; i++) s = stepVertical(s, { groundHeight: 0, detachRefHeight: null, dt: DT }, P);
    expect(s.airborne).toBe(false);
    s = stepVertical(s, { groundHeight: -5, detachRefHeight: null, dt: DT }, P);
    expect(s.airborne).toBe(true); // falls back to the groundHeight-based rate, same as the pre-D3 cliff-edge test
  });
});

describe("stepVertical — D2 landing-gate fix (2026-07-10, wide dropoff fake-land oscillation)", () => {
  // Regression for the bug found via tools/diag_attitude_trace.ts --synth: on
  // a wide cliff (a REAR probe still resting on the upper deck long after the
  // center+leading probes cross the lip), the OLD landing check re-attached
  // against the raw wall-aware groundHeight (still propped up by that rear
  // probe) on the very tick after the D2 detach gate fired, producing an
  // airborne/grounded oscillation instead of one clean launch. Sequence
  // below mirrors that shape directly at the stepVertical level (no map/
  // heightfield needed): center+leading (the body's own footprint) both
  // clear the lip while a trailing groundHeight value (what a rear probe
  // would still read) stays high.
  const UPPER = 1.0; // upper deck height (what a rear probe would still read)
  const LOWER = 0.0; // lower floor height, far below

  it("does not fake-land while a trailing probe still props up raw groundHeight, only when center+leading agree", () => {
    let s = createVerticalState(UPPER);
    // Settle grounded on the upper deck first (leading gate wired every tick,
    // matching kart.ts's real call site).
    for (let i = 0; i < 10; i++) {
      s = stepVertical(
        s,
        { groundHeight: UPPER, detachRefHeight: UPPER, leadingProbeHeight: UPPER, dt: DT },
        P
      );
    }
    expect(s.airborne).toBe(false);

    let firstAirborneTick = -1;
    let sawRelandBeforeRealFloor = false;
    for (let i = 0; i < 40; i++) {
      // Center + leading (own footprint) crossed the lip immediately; raw
      // groundHeight stays propped at UPPER by a trailing (rear) probe for a
      // while, exactly like a wide dropoff's rear-probe straggler.
      const trailingStillPropped = i < 20;
      s = stepVertical(
        s,
        {
          groundHeight: trailingStillPropped ? UPPER : LOWER,
          detachRefHeight: LOWER,
          leadingProbeHeight: LOWER,
          dt: DT,
        },
        P
      );
      if (s.airborne && firstAirborneTick === -1) firstAirborneTick = i;
      // Once genuinely airborne, must stay airborne for as long as the
      // trailing prop is still artificially propping up raw groundHeight —
      // any grounded tick in that window is exactly the fake-land bug.
      if (firstAirborneTick !== -1 && trailingStillPropped && !s.airborne) sawRelandBeforeRealFloor = true;
    }

    expect(firstAirborneTick).toBeGreaterThanOrEqual(0); // did detach
    expect(sawRelandBeforeRealFloor).toBe(false); // never fake-landed on the phantom rear support
  });

  it("still lands normally once center+leading themselves reach the real floor (no regression to the launch/landing contract)", () => {
    let s: VerticalState = { y: LOWER + 0.5, vy: -3, airborne: true, groundHeightPrev: null };
    for (let i = 0; i < 100 && s.airborne; i++) {
      s = stepVertical(
        s,
        { groundHeight: LOWER, detachRefHeight: LOWER, leadingProbeHeight: LOWER, dt: DT },
        P
      );
    }
    expect(s.airborne).toBe(false);
    expect(s.vy).toBe(0);
    expect(s.y).toBeCloseTo(LOWER, 6);
  });

  it("byte-identical old landing behavior when leadingProbeHeight is omitted (pre-existing callers/tests)", () => {
    let s: VerticalState = { y: 0.5, vy: -1, airborne: true, groundHeightPrev: null };
    for (let i = 0; i < 200 && s.airborne; i++) {
      s = stepVertical(s, { groundHeight: 0, detachRefHeight: 0, dt: DT }, P);
    }
    expect(s.airborne).toBe(false);
    expect(s.vy).toBe(0);
    expect(s.y).toBeCloseTo(0, 6);
  });
});
