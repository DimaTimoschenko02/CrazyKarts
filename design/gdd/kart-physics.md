---
status: draft
version: "2.2"
date: 2026-04-21
---

# Kart Physics System

> **Status**: Draft (v2.2 — continuous drift intensity)
> **Author**: Dima + game-designer + systems-designer + godot-specialist + technical-director
> **Last Updated**: 2026-04-21 (v2.2 skeleton: _drift_intensity replaces _is_drifting as physics master)
> **Previous version archive**: `design/gdd/kart-physics-v2.1-archive.md`
> **Implements Pillar**: Аркадный хаос (arcade feel, не симулятор) + Вариативность (kart classes via physics)

---

## Changes from v2.1

### What changes

- `_is_drifting: bool` no longer drives physics directly — replaced by `_drift_intensity: float [0..1]` as the single physics master
- All drift-dependent params (`yaw_mult`, `drag_mult`, `rolling_mult`, `_grip`) become `lerp(normal, drift_value, _drift_intensity)` — no more instant step functions
- Two new rate params: `drift_intensity_enter_rate` and `drift_intensity_exit_rate` (replace `grip_loss_rate` / `grip_recovery_rate` as the transition speed knobs)
- `_grip` becomes a derived value from `_drift_intensity`, not independently animated
- `_visual_drift_angle` driven by `intensity * VISUAL_DRIFT_MAX_DEG * sign(steer_input)` — unified

### What is removed

- `grip_loss_rate` and `grip_recovery_rate` as independent params — superseded by intensity rates [OPEN: keep as legacy aliases or delete entirely?]
- `DRIFT_KICK_FORCE` one-shot impulse [OPEN: replace with continuous ramp force, or remove entirely and rely on velocity reprojection?]

### What stays from v2.1

- Force-based inertia model (thrust + k_drag·v² + k_rolling·v)
- Direct rotation via `rotate_y()` + velocity reprojection
- Hysteresis thresholds `ENTER=0.75` / `EXIT=0.35` — now control direction of intensity growth, not a bool flip
- `drift_min_speed_ratio`
- Physical multiplier values (`DRIFT_YAW_MULTIPLIER`, `DRIFT_DRAG_MULTIPLIER`, `DRIFT_ROLLING_MULTIPLIER`, `HIGH_GRIP`, `LOW_GRIP`) — now used as lerp endpoints, not switched values
- Reverse drift block: entry requires `fwd_speed > 0`
- `_is_drifting: bool` retained as derived flag (`intensity > threshold`) for VFX / audio / network

---

## Overview

<!-- DRAFT THIS SECTION — ~3-4 sentences. Cover: CharacterBody3D model, feel-first principle,
     what v2.2 adds over v2.1 (unified smoothness via _drift_intensity). -->

- CharacterBody3D + move_and_slide() arcade model — same as v2.1
- All params in KartPhysicsResource (@export) — same as v2.1
- Core innovation: `_drift_intensity` as single smooth master for all drift physics
- Feel First: eliminates the jerk-on-entry/jerk-on-exit problem diagnosed in control-system-analysis.md

---

## Player Fantasy

<!-- DRAFT THIS SECTION — 2-3 sentences in first person, "I feel..." format.
     Must explicitly mention: smooth drift entry (no jerk), weight during drift arc,
     satisfying exit tail. Feel First principle must be visible here. -->

- "Drift begins as a gradual lean — I feel the rear start to slide, not a punch"
- "Mid-drift the kart feels heavy and committed — tighter arc, perceptible speed cost"
- "Releasing the steer, the kart settles back over ~0.5-1s — I feel it grip, not snap"
- Feel First: every transition optimized for feel, not physical correctness

---

## Detailed Design

<!-- SECTION: Core Rules -->

### Core Rules

- Rules 1-9 from v2.1 unchanged (60 Hz physics, force-based model, no hard speed clamp, etc.)
- **Rule 10 (updated)**: `_drift_intensity: float [0..1]` is the physics master. `_is_drifting: bool` is a derived flag for VFX/audio/network only (`intensity > DRIFT_ACTIVE_THRESHOLD`)
- **Rule 11 unchanged**: reverse drift blocked (`fwd_speed > 0` required)
- New Rule 12: all drift-dependent physics values are `lerp(base, drift_value, _drift_intensity)` — no ternary switches for physics

### KartPhysicsResource

<!-- DRAFT THIS SECTION — show new @export vars only.
     Changes: add drift_intensity_enter_rate, drift_intensity_exit_rate, drift_active_threshold.
     [OPEN]: fate of grip_loss_rate / grip_recovery_rate — keep as aliases or remove?
     [OPEN]: fate of drift_kick_force — new continuous param or just 0? -->

- New params: `drift_intensity_enter_rate`, `drift_intensity_exit_rate`, `drift_active_threshold`
- Removed/changed: `grip_loss_rate`, `grip_recovery_rate` → [OPEN]
- `drift_kick_force` → [OPEN]
- All other params from v2.1 preserved

### Movement Model

<!-- DRAFT THIS SECTION — identical to v2.1 for thrust/drag/rolling/brake.
     Only change: active_k_drag and active_k_rolling now use lerp(1.0, MULT, intensity)
     instead of ternary. Show the updated pseudocode snippet. -->

- Force integration: unchanged from v2.1
- `active_k_drag = k_drag * lerp(1.0, drift_drag_multiplier, _drift_intensity)`
- `active_k_rolling = k_rolling * lerp(1.0, drift_rolling_multiplier, _drift_intensity)`
- Terminal velocity formula: show how it changes continuously with intensity

### Drift Model (v2.2 — Continuous Intensity)

<!-- DRAFT THIS SECTION — the core of v2.2. Cover:
     - _drift_intensity float state variable
     - Hysteresis thresholds now control growth DIRECTION (not bool flip)
     - intensity += enter_rate * delta when conditions met
     - intensity -= exit_rate * delta when conditions not met
     - _grip = lerp(high_grip, low_grip, _drift_intensity)  [derived, not separately animated]
     - yaw_mult = lerp(1.0, DRIFT_YAW_MULTIPLIER, _drift_intensity)
     - drag/rolling multipliers via lerp
     - _visual_drift_angle = intensity * VISUAL_DRIFT_MAX_DEG * sign(steer)
     - _is_drifting derived: intensity > drift_active_threshold
     - [OPEN]: kick — continuous ramp or remove entirely? -->

- `_drift_intensity: float = 0.0` — new primary state variable
- Intensity grows toward 1.0 at `drift_intensity_enter_rate` when hysteresis enter conditions met
- Intensity falls toward 0.0 at `drift_intensity_exit_rate` when exit conditions trigger
- `_grip` is now `lerp(high_grip_target, low_grip_target, _drift_intensity)` — no separate animation
- All drift multipliers via `lerp(1.0, MULTIPLIER, _drift_intensity)` — synchronized with intensity
- `_is_drifting` derived as `_drift_intensity > drift_active_threshold` — for VFX/audio/network
- [OPEN: kick behavior — see Open Questions]

### Kart-to-Kart Collision

<!-- Unchanged from v2.1 — brief note to that effect, reference archive for full spec -->

- Energy-based momentum transfer: unchanged from v2.1
- See v2.1 archive for full pseudocode

### Terrain — Slopes & Ramps

<!-- Unchanged from v2.1 — brief note -->

- Slope speed influence, floor alignment, ramp launch: unchanged from v2.1

### Interactions with Other Systems

<!-- Same table as v2.1 with one update: VFX/Audio now read _is_drifting (derived bool)
     and optionally _drift_intensity for graduated effects -->

- VFX/Audio: now receive `_drift_intensity` float in addition to `_is_drifting` bool — enables graduated tire smoke intensity etc.
- All other interfaces unchanged

---

## Formulas

<!-- DRAFT THIS SECTION — for each formula: variable definitions, expected ranges, example calc.
     Sections needed:
     1. Drift Intensity Update (the new core formula — grow/decay with hysteresis-gated rates)
     2. Force-Based Acceleration (updated: lerp multipliers instead of ternary)
     3. Derived Grip (new: grip = lerp(high, low, intensity))
     4. Speed-Dependent Steering (updated: yaw_mult via lerp)
     5. Drift Hysteresis (same thresholds, new semantics — controls intensity direction)
     6. Terminal velocity (show continuous curve as function of intensity)
     7. Collision Energy (unchanged from v2.1)
     [OPEN]: kick formula if kept -->

- **Intensity update formula**: `_drift_intensity += rate * delta` toward target (0 or 1) based on conditions
- **Grip derived**: `_grip = lerp(high_grip_target, low_grip_target, _drift_intensity)` [no move_toward]
- **Yaw**: `drift_mult = lerp(1.0, drift_yaw_multiplier, _drift_intensity)`
- **Drag/rolling**: both via `lerp(1.0, MULTIPLIER, _drift_intensity)`
- **Terminal velocity (continuous)**: `v_t = sqrt(accel_force / (k_drag * lerp(1.0, drift_drag_multiplier, intensity)))`
- All formulas need: variable table with defaults + ranges, numeric example at intensity=0, 0.5, 1.0

---

## Edge Cases

<!-- DRAFT THIS SECTION — same format as v2.1 table.
     New cases to cover:
     - intensity stuck near 0.0 or 1.0 (clamping)
     - partial intensity at DEAD state reset
     - intensity behavior when speed drops below drift_min mid-drift (forced decay?)
     - very fast enter/exit rates (approaching v2.1 binary behavior — acceptable?)
     - very slow enter/exit rates (intensity never reaches 1.0 in a typical corner)
     - _is_drifting (derived) flickers around drift_active_threshold
     Existing v2.1 edge cases: review which still apply, which change -->

- [OPEN]: what happens at DEAD state — snap `_drift_intensity = 0.0` or decay?
- Intensity clamp: `clamp(_drift_intensity, 0.0, 1.0)` — never goes negative or above 1
- Speed drops below drift_min during drift: exit condition triggers, intensity decays at exit_rate
- `_is_drifting` flicker near `drift_active_threshold`: hysteresis gap (enter/exit thresholds) prevents rapid oscillation at input level; intensity float absorbs micro-oscillation at physics level
- Entry/exit rates approaching infinity: degenerates to v2.1 binary behavior (known, acceptable for testing)

---

## Dependencies

<!-- Same as v2.1 with one addition: note that _drift_intensity (float) is now part of the
     interface contract for VFX/Audio downstream consumers -->

### Upstream (unchanged)

- State Machine: KartState gates physics (Hard)
- Network Layer: position sync, remote interpolation (Hard)

### Downstream (updated interface)

- VFX System: now receives `_drift_intensity: float` for graduated smoke/effects
- Audio System: can use `_drift_intensity` for graduated screech volume
- Camera System, Weapon System, Kart Classes: unchanged

### Interface Contract

<!-- Updated: _drift_intensity is now a public readable property alongside _is_drifting -->

- `_drift_intensity: float` exposed as readable property (in addition to existing `_is_drifting`)
- `_is_drifting` remains in interface for backward compat (now derived)
- All other contracts unchanged from v2.1

---

## Tuning Knobs

<!-- DRAFT THIS SECTION — same table format as v2.1.
     New knobs to document:
     - drift_intensity_enter_rate: how fast intensity ramps to 1.0 (replaces grip_loss_rate feel)
     - drift_intensity_exit_rate: how fast intensity falls to 0.0 (replaces grip_recovery_rate feel)
     - drift_active_threshold: float above which _is_drifting = true (for VFX/audio/network)
     [OPEN]: document grip_loss_rate / grip_recovery_rate as removed or legacy aliases
     [OPEN]: document drift_kick_force as removed or new continuous form
     Knob interactions section must be updated (intensity rates interact with hysteresis thresholds) -->

- `drift_intensity_enter_rate`: /sec — speed of ramp-up from 0 to 1 on drift entry
- `drift_intensity_exit_rate`: /sec — speed of decay from 1 to 0 on drift release
- `drift_active_threshold`: 0.0-1.0 — intensity level at which _is_drifting flips true for VFX/audio
- All v2.1 multiplier knobs preserved (now as lerp endpoints, not switched values)
- [OPEN: fate of grip_loss_rate, grip_recovery_rate, drift_kick_force]

---

## Acceptance Criteria

<!-- DRAFT THIS SECTION — same 3-tier structure as v2.1:
     1. Functional Tests (automated/headless) — updated for intensity model:
        - intensity reaches 1.0 within expected time from full-steer entry
        - intensity decays to 0.0 within expected time after release
        - all drift-dependent values verified as continuous (no step functions)
        - _is_drifting derived correctly from intensity
        - DEAD state: intensity reset to 0.0
        - reverse drift still blocked
     2. Network Tests — unchanged from v2.1
     3. Playtest Criteria (human) — same as v2.1 plus:
        - NO jerk/punch on drift entry (the v2.1 regression being fixed)
        - NO snap-forward on drift exit
        - Drift onset gradual (~0.2-0.5s ramp visible in debug overlay)
        - Overall "this feels like SmashKarts but smoother on entry" -->

- Functional: `_drift_intensity` reaches ≥0.95 within expected time from full-steer entry at drift speed
- Functional: `_drift_intensity` reaches ≤0.05 within expected time after steer release
- Functional: `grip`, `yaw_mult`, `drag_mult`, `rolling_mult` all change continuously — no single-frame step visible in debug
- Functional: `_is_drifting` is true when `_drift_intensity > drift_active_threshold`, false otherwise
- Functional: DEAD state resets `_drift_intensity = 0.0`
- Functional: reverse drift still blocked
- Playtest: NO jerk/punch sensation on drift entry
- Playtest: NO snap-forward sensation on drift exit
- Playtest: drift onset perceptibly gradual — kart "leans in" over ~0.2-0.5s
- Playtest: "this feels like SmashKarts but with more weight and zero entry jank"

---

## Open Questions

<!-- Explicit [OPEN] items for user resolution before section fill -->

1. **[OPEN] Kick — keep, ramp, or remove?**
   Three options from control-system-analysis.md:
   - (a) Remove entirely (`drift_kick_force = 0`) — rely on velocity reprojection to generate side_speed organically
   - (b) Replace with continuous ramp lateral force applied while intensity is growing (fades as intensity approaches 1.0)
   - (c) Keep one-shot impulse but scale by `min(intensity_target - intensity_current, delta)` — soft kick spread over first few frames
   *This is the highest-impact open question for entry feel.*

2. **[OPEN] grip_loss_rate / grip_recovery_rate — keep or remove?**
   These params are superseded by `drift_intensity_enter_rate` / `drift_intensity_exit_rate`.
   - (a) Remove from KartPhysicsResource — clean break, update `.tres` files
   - (b) Keep as deprecated aliases that map to intensity rates — easier rollback if needed

3. **[OPEN] DEAD state intensity reset — snap or decay?**
   When entering DEAD state mid-drift:
   - (a) Snap `_drift_intensity = 0.0` immediately (v2.1 behavior, cleaner)
   - (b) Let intensity decay at `drift_intensity_exit_rate` (smoother visual, but kart may still "drift" while dead for a frame or two)

4. **[OPEN] drift_active_threshold value**
   At what intensity level does `_is_drifting` flip for VFX/audio?
   - Low (e.g. 0.2): smoke appears early in ramp, gradual onset
   - High (e.g. 0.7): smoke appears only when drift is well established, sharper trigger

5. **Air control** (carried from v2.1): no steering in air (0.15s lockout) — should there be slight air steering for ramp gameplay? Depends on map design. Deferred.
