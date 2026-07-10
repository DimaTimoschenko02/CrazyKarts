// Vertical (Y-axis) physics — separated from bicyclePhysics.ts because it is
// axis-orthogonal to the XZ bicycle model and needed its own state machine
// (grounded ground-follow vs. ballistic airborne). Pure compute module, no
// THREE — see vertical.test.ts.
//
// Player feedback this implements (owner playtest, 2026-07): "driving off a
// ramp lip should launch the kart into the air — right now it just glides
// along the heightfield, glued to the ground no matter how steep the drop."
// FOLLOW-UP feedback (same day, second playtest): "drove up the trampoline
// ramp in the middle of the map and nothing happened — no launch at all."
// Root cause: the original launch detector only fired when the ground fell
// away FASTER than free-fall could (a cliff/dropoff). It deliberately never
// fired when a ramp simply flattens out at the top — but that IS the classic
// trampoline case: the kart was climbing at the ramp's slope rate, the ramp
// stops climbing, and the kart's own upward inertia should carry it into the
// air.
//
// Design: while grounded, y exp-follows the sampled ground height exactly
// like the pre-existing kart.ts step 8b did (same shape, parameterized as
// `groundFollowRate`) — AS LONG AS the ground is still holding the kart up.
//
// Launch detector (rate-based, NOT position-based — see below for why):
// each tick we track `state.vy`, the kart's own current vertical rate (kept
// equal to the ground-follow-implied rate while grounded — i.e. the exact
// rate the kart would need to still be glued to the surface), and compare it
// to `groundRateNow`, the RAW instantaneous rate-of-rise of the sampled
// ground height itself this tick (`(groundHeight - previousGroundHeight) /
// dt`, no smoothing). If the kart's own vy is climbing faster than the
// ground currently offers — by more than `airborneDropThreshold`, a small
// tunable margin that also acts as the anti-jitter hysteresis band for
// heightfield micro-noise — nothing is holding the kart down anymore and it
// launches, carrying its last ground-following vertical rate as `vy`. This
// single comparison covers both launch shapes with no separate cases:
//   - Cliff / ramp lip: groundRateNow crashes to a huge negative number
//     (ground height drops far in one tick) while vy is small → launch,
//     carrying roughly vy ≈ 0 (near-level "walked off the edge" launch).
//   - Ramp flattening while still climbing fast: groundRateNow drops to ~0
//     the instant the slope ends, but vy (the climb rate the kart had a
//     moment ago) is still large → launch, carrying that climb rate upward —
//     the actual trampoline effect.
// On a continuous, unbroken slope groundRateNow stays (within heightfield
// sampling noise) equal to the kart's own vy every tick — no launch, matching
// "driving smoothly up a ramp must never trigger a launch."
//
// WHY RATE-BASED, NOT A POSITION/FREEFALL COMPARISON: an earlier version of
// this detector compared a freefall-predicted `y` against the sampled ground
// height directly. That looked right on paper but never actually launched at
// cruise speed: the ground-follow exp filter has an inherent STEADY-STATE
// LAG while climbing a slope (state.y trails the true ramp height by
// `climbRate / groundFollowRate` — up to ~0.4m at cruise speed on the
// arena_slice ramp). The instant the ramp flattens, the filter still has
// that ~0.4m of banked catch-up motion left to deliver, which swamped the
// freefall/ground gap the launch check was looking for and silently ate the
// signal into a few extra ticks of ordinary-looking climb. Comparing RATES
// (vy vs. the raw ground slope) instead of absolute heights sidesteps the
// lag entirely, since it never reads state.y at all.
//
// A SLOW crawl up a ramp that then flattens implies a small vy, well under
// the threshold — no launch, or one so small it's imperceptible; a fast
// cruise implies a large vy, well past the threshold, on the very first flat
// tick — an immediate, clearly felt launch. See vertical.test.ts "launch off
// a flattening ramp top" block for the concrete speed numbers this was tuned
// against (arena_slice ramp geometry).
//
// While airborne: pure ballistic (vy -= g*dt; y += vy*dt), no ground-follow,
// no re-launch logic — horizontal input/physics are the CALLER's
// responsibility to suspend (see kart.ts step 8b wiring), this module only
// ever touches y/vy/airborne (groundHeightPrev is bookkeeping only, callers
// don't need to read it).
//
// Landing: snaps to the sampled ground height once within `landingMargin`
// of it AND already descending (vy <= 0) — the vy<=0 guard stops the kart
// from "landing" on itself in the very tick it just launched upward from a
// point that happens to be close to the (now much lower) new ground sample.
// No bounce: vy resets to 0 on landing, matching the "pure inertia, no
// physics interaction while airborne" brief (nothing partially elastic).
//
// D2 (design/notes/ride-collision-v2.md, 2026-07-09): the rate-detector above
// covers cliffs and trampolines, but has a blind spot on a SLOW crest over a
// convex ridge — groundRateNow tracks the kart's own vy closely enough
// tick-to-tick (both easing toward 0 together as the slope flattens) that
// their difference never crosses airborneDropThreshold, even though the
// kart is visibly riding over open air a moment later (symptom #3, "приклеен
// на гребне"). `groundSnapDistance` adds a second, purely POSITIONAL check
// layered in front of the follow-filter: if the sampled ground has already
// fallen more than this far below the kart's CURRENT y, go airborne carrying
// the current vy (same "carry the rate, don't snap down" contract as the
// rate-based launch above) even though the rate check alone didn't fire.
// Checked AFTER the rate detector (so it never double-fires on the same tick
// a cliff/trampoline launch already did) and BEFORE the follow-filter moves
// y at all.

export interface VerticalParams {
  gravity: number; // VERTICAL_GRAVITY — downward accel while airborne (m/s²)
  groundFollowRate: number; // VERTICAL_GROUND_FOLLOW_RATE — exp-follow rate while grounded (/s)
  airborneDropThreshold: number; // VERTICAL_AIRBORNE_DROP_THRESHOLD — how far (m/s) the kart's own vertical rate must exceed the ground's current rate-of-rise to trigger a launch — in EITHER direction (cliff drop or ramp-top launch); also the anti-jitter margin
  landingMargin: number; // VERTICAL_LANDING_MARGIN — clearance (m) below which an airborne kart snaps to the ground
  groundSnapDistance: number; // GROUND_SNAP_DISTANCE — D2 positional detachment: how far (m) the ground must sit below the kart's current y to force airborne even when the rate detector above didn't trip (catches a slow crest over a convex ridge)
}

export interface VerticalState {
  y: number;
  vy: number;
  airborne: boolean;
  // Raw ground height sampled last tick — bookkeeping for the launch
  // detector's instantaneous ground-rate estimate, see header comment. Not
  // meaningful to callers; null only before the first tick / first ground
  // sample.
  groundHeightPrev: number | null;
}

export interface VerticalInput {
  // Ground height at the kart's (already horizontally-integrated) XZ this
  // tick, or null when there's no mapped cell there (defensive — normal
  // horizontal collision in kart.ts already prevents entering unmapped
  // cells, see step 8, so this should not occur in practice). This is the
  // FOLLOW target only (the exp-filtered ride height below) — see
  // detachRefHeight for what actually drives the launch/detach checks.
  groundHeight: number | null;
  // D3 (design/notes/ride-collision-v2.md, 2026-07-09, symptom B1 "ложный
  // трамплин на склоне"): a second, CONTINUOUS ground reading — the body's
  // own CENTER ground probe (kart/groundProbe.ts sampleGroundProbes().center),
  // NOT the wall-aware MAX-of-probes `groundHeight` above. `groundHeight` can
  // jump a full probe-exclusion step in a single tick as a corner probe
  // crosses wallAwareGroundHeight's stepExcludeThreshold and gets included/
  // excluded from the MAX — a discrete jump the rate-detector below used to
  // read as a huge implied vy and fire a false launch on an ordinary slope.
  // The center probe has no such exclusion logic (it's just one continuous
  // bilinear sample), so it's what the launch/detach checks use instead. The
  // exp-follow ride-height target (below) deliberately keeps using
  // `groundHeight` — I3's "mount the highest contact point" behavior for
  // actually POSITIONING the body is untouched, only the LAUNCH DECISION
  // moved to the smoother signal. null when the caller's own center probe is
  // off the map — this module falls back to `groundHeight` in that case (see
  // stepVertical), same fallback kart.ts's own call site also applies at the
  // source (defensive: fallback applied twice is still just a fallback).
  detachRefHeight: number | null;
  // D2 follow-up (2026-07-10, "клевок носом на обрыве" fix, design/notes/
  // ride-collision-v2.md): the body's own SUPPORT (this module's
  // `groundHeight` param, the wall-aware MAX of every F/B/R/L probe) can
  // keep reading high long after the body's center AND the direction it's
  // actually driving toward have both cleared a cliff lip — a REAR probe
  // still resting on the deck behind the kart props up groundHeight
  // indefinitely, so the OLD groundHeight-AND-detachRef gate below could
  // never fire (this is D5's groundProbe.ts "own support isn't a wall" fix
  // turning into a NEW problem one level up: a real support keeps the body
  // artificially grounded, hanging its tail out over open air, while
  // attitude reads the resulting front/rear height gap as a steep downward
  // slope and pitches the nose down — the "клевок" the body-relative gate
  // fix introduced). This is the probe in the body's CURRENT direction of
  // travel (kart.ts picks probes.hF/hB by the sign of forward speed) — the
  // D2 detach check below now requires BOTH the center probe AND this
  // leading probe to have cleared the lip, replacing its old groundHeight-
  // based half. A binary hF/hB choice is fine here: detachment is a discrete
  // state flip by nature, same "OK to be binary" carve-out
  // .claude/rules/smooth-values.md lists for on/off physics events (not a
  // continuous physics VALUE). Optional and falls back to detachRefHeight
  // itself when omitted — every existing caller/test that never
  // differentiated groundHeight from detachRefHeight sees byte-identical
  // behavior (see stepVertical's D2 doc for why that fallback is safe, not a
  // silent behavior change).
  leadingProbeHeight?: number | null;
  dt: number;
}

export function createVerticalState(y: number): VerticalState {
  return { y, vy: 0, airborne: false, groundHeightPrev: null };
}

export function stepVertical(state: VerticalState, inp: VerticalInput, p: VerticalParams): VerticalState {
  const dt = inp.dt;

  if (!state.airborne) {
    if (inp.groundHeight === null) {
      // No ground info under the kart — fail safe into freefall (carrying
      // whatever vertical rate we had) rather than staying glued to a stale
      // height forever. Shouldn't happen in practice (see VerticalInput doc).
      return { y: state.y, vy: state.vy, airborne: true, groundHeightPrev: state.groundHeightPrev };
    }

    // D3: the launch/detach checks below read the CONTINUOUS center probe
    // (detachRefHeight), not the wall-aware MAX `groundHeight` — see
    // VerticalInput.detachRefHeight doc. Falls back to groundHeight when the
    // caller has no center reading (defensive; kart.ts's own call site
    // already applies the same fallback at the source).
    const detachRef = inp.detachRefHeight ?? inp.groundHeight;

    // Raw, unsmoothed rate-of-rise of the sampled ground this tick. null
    // previous sample (first tick ever) means "unknown" — treat as matching
    // the kart's own rate so the very first tick can never spuriously launch.
    const groundRateNow =
      state.groundHeightPrev === null ? state.vy : (detachRef - state.groundHeightPrev) / Math.max(dt, 1e-6);

    if (state.vy - groundRateNow > p.airborneDropThreshold) {
      // The kart's own vertical momentum is now climbing (or simply not
      // falling as fast as) the ground beneath it — nothing is holding it
      // down anymore. Position stays put this tick (don't snap to the new
      // ground sample); vy carries the last ground-following rate, which is
      // exactly the trampoline effect for a kart still climbing when the
      // ramp ends, or a near-level launch when walking off a flat cliff.
      return { y: state.y, vy: state.vy, airborne: true, groundHeightPrev: detachRef };
    }

    // D2 positional detachment — see header comment above. Only fires when
    // the rate detector above didn't already; carries the current vy exactly
    // like that branch (no snap-down, no re-derivation from the new sample).
    // D2 follow-up (2026-07-10, see VerticalInput.leadingProbeHeight doc):
    // BOTH the center probe AND the LEADING probe (the one in the body's
    // current direction of travel) must agree the ground left from under the
    // body — replaces the old groundHeight(wall-aware MAX)-AND-detachRef
    // gate, which could never fire once a REAR probe kept propping up
    // groundHeight after the body had already driven its center and nose
    // past a lip (the straddle/"клевок" case).
    //
    // `leadingProbeHeight` is OPT-IN, not merely nullable: when the field is
    // literally omitted (`undefined` — every existing test/caller that
    // predates this fix), the gate falls back to the EXACT old formula
    // (groundHeight AND detachRef) byte-for-byte, because some of those
    // callers deliberately drive groundHeight and detachRef apart (see the
    // D3 "follow-filter vy spike is capped" test) in ways that rely on
    // groundHeight staying part of this AND. Only when a caller explicitly
    // wires the new field (kart.ts always does) does the gate switch to the
    // new center-AND-leading rule; a `null` leading value (probe legitimately
    // off the map) still falls back to detachRef within that new rule.
    //  - detachRef alone sitting below y is just the body riding a corner
    //    bump (rear wheel on a kerb lifts y above the center's ground) —
    //    the highest contact point behind is still carrying the kart, and
    //    the leading probe (still on solid ground ahead) confirms it.
    //  - leadingProbeHeight alone sitting below y is the nose already over a
    //    lip while the body's own center hasn't crossed it yet — not a
    //    detach on its own (this is exactly the "front probe on a bump/pit"
    //    case: don't detach just because ONE probe found a dip).
    // A genuine crest/cliff/straddle drops both.
    const usesLeadingGate = inp.leadingProbeHeight !== undefined;
    const leadingRef = usesLeadingGate ? (inp.leadingProbeHeight ?? detachRef) : inp.groundHeight;
    if (detachRef < state.y - p.groundSnapDistance && leadingRef < state.y - p.groundSnapDistance) {
      return { y: state.y, vy: state.vy, airborne: true, groundHeightPrev: detachRef };
    }

    const followAlpha = 1 - Math.exp(-p.groundFollowRate * dt);
    const candidateY = state.y + (inp.groundHeight - state.y) * followAlpha;
    const impliedVy = (candidateY - state.y) / Math.max(dt, 1e-6);
    // D3 second half: `vy` here is pure bookkeeping (launch detector input +
    // the rate carried into flight) — position is candidateY regardless. A
    // discrete UPWARD step in the follow target (probe inclusion at
    // wallAwareGroundHeight's threshold, a sampleAt layer switch) makes
    // impliedVy spike for a few ticks; next tick that phantom vy clears
    // `vy - groundRateNow > airborneDropThreshold` and fires a false
    // trampoline even though the detector's own rate signal is smooth. While
    // grounded, a body's real vertical rate can't exceed the ground's own
    // rate-of-rise — cap the excess below the launch threshold so only a
    // genuine rate DROP (ramp lip, cliff) can trip the detector. Converged
    // steady-slope climbs have impliedVy == groundRateNow, so the trampoline
    // carry-over rate is untouched.
    const vyStored = Math.min(impliedVy, groundRateNow + p.airborneDropThreshold * 0.75);
    // D3: groundHeightPrev stores detachRef (not groundHeight) so next tick's
    // groundRateNow above stays an apples-to-apples rate over the SAME
    // continuous signal — mixing the two would reintroduce a one-tick
    // discontinuity right at a grounded/launch-check boundary.
    return { y: candidateY, vy: vyStored, airborne: false, groundHeightPrev: detachRef };
  }

  // Airborne: ballistic, no ground-follow, no re-derivation from input.
  const vy = state.vy - p.gravity * dt;
  const y = state.y + vy * dt;
  // D3: mirrors the grounded branch — bookkeeping for the NEXT grounded
  // tick's rate detector should be the continuous detachRefHeight where the
  // caller supplied one, falling back to groundHeight/stale-prev exactly as
  // before when it didn't (airborne callers don't have to populate it).
  const groundHeightPrev = inp.detachRefHeight ?? inp.groundHeight ?? state.groundHeightPrev;

  // D2 fake-land fix (2026-07-10, design/notes/ride-collision-v2.md, found
  // via tools/diag_attitude_trace.ts --synth on a wide dropoff with a lower
  // second floor underneath): a body that just detached through the grounded
  // branch's center-AND-leading gate above could swing straight into THIS
  // landing check on the very next tick and re-attach against the raw
  // wall-aware `groundHeight` param (MAX of every probe) — a REAR probe still
  // resting on the deck the body just drove off of kept propping that MAX up
  // long after the center and leading probes had both cleared the lip, so
  // the kart detached, immediately "fake-landed" on that phantom rear
  // support, detached again next tick, and repeated: an airborne/grounded
  // oscillation (15 ticks on the synthetic repro) with pitch swinging past
  // -20 degrees every cycle, instead of one clean launch arc. Fix mirrors the
  // SAME leading-probe opt-in pattern the detach gate above already uses:
  // when the caller supplies `leadingProbeHeight`, landing is judged against
  // the MAX of the center probe and the leading probe ONLY — the same two
  // probes the detach gate required to BOTH clear the lip before letting the
  // body leave the ground, so re-landing now requires those same two to
  // agree the ground is back (a trailing probe drifting back under the body
  // doesn't count — same "own support isn't what's behind you" logic as the
  // detach side). `leadingProbeHeight` omitted (every pre-existing caller/
  // test) falls back to the exact old formula byte-for-byte — same opt-in
  // contract as the detach gate, see VerticalInput.leadingProbeHeight doc for
  // why that fallback is safe, not a silent behavior change.
  const usesLeadingGate = inp.leadingProbeHeight !== undefined;
  const detachRefForLanding = inp.detachRefHeight ?? inp.groundHeight;
  const landingRef = usesLeadingGate
    ? detachRefForLanding === null
      ? null
      : Math.max(detachRefForLanding, inp.leadingProbeHeight ?? detachRefForLanding)
    : inp.groundHeight;

  if (landingRef !== null && vy <= 0 && y <= landingRef + p.landingMargin) {
    return { y: landingRef, vy: 0, airborne: false, groundHeightPrev }; // no bounce
  }
  return { y, vy, airborne: true, groundHeightPrev };
}
