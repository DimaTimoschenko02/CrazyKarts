---
status: archived
version: "2.2"
date: 2026-04-21
archived-date: 2026-04-21
archived-reason: "Superseded by v2.3 — continuous intensity_target (pow(|steer|, exponent)) replaces binary hysteresis for intensity targeting"
---

# Kart Physics System (v2.2 Archive)

> **Status**: Archived — see `design/gdd/kart-physics.md` for current (v2.3)
> **Author**: Dima + game-designer + systems-designer + godot-specialist + technical-director
> **Last Updated**: 2026-04-21 (v2.2: `_drift_intensity` replaces `_is_drifting` as physics master)
> **Previous version archive**: `design/gdd/kart-physics-v2.1-archive.md`
> **Implements Pillar**: Аркадный хаос (arcade feel, не симулятор) + Вариативность (kart classes via physics)

---

## Changes from v2.1

### What changes

- `_is_drifting: bool` no longer drives physics directly — replaced by `_drift_intensity: float [0..1]` as the single physics master
- All drift-dependent params (`yaw_mult`, `drag_mult`, `rolling_mult`, `_grip`) become `lerp(normal, drift_value, _drift_intensity)` — no more instant step functions
- Two new rate params: `drift_intensity_enter_rate` and `drift_intensity_exit_rate` replace the feel of `grip_loss_rate` / `grip_recovery_rate` as the transition speed knobs
- `_grip` becomes a derived value from `_drift_intensity`, not independently animated
- `_visual_drift_angle` driven by `intensity * VISUAL_DRIFT_MAX_DEG * sign(steer_input)` — unified
- `DRIFT_KICK_FORCE` one-shot impulse replaced by `DRIFT_LATERAL_RAMP` continuous ramp lateral force
- `_is_drifting: bool` retained as derived flag (`intensity > drift_active_threshold`) for VFX / audio / network

### What is removed

- `DRIFT_KICK_FORCE` — superseded by `DRIFT_LATERAL_RAMP` continuous ramp

### What stays from v2.1

- Force-based inertia model (thrust + k_drag·v² + k_rolling·v)
- Direct rotation via `rotate_y()` + velocity reprojection
- Hysteresis thresholds `ENTER=0.75` / `EXIT=0.35` — now control direction of intensity growth, not a bool flip
- `drift_min_speed_ratio`
- Physical multiplier values (`DRIFT_YAW_MULTIPLIER`, `DRIFT_DRAG_MULTIPLIER`, `DRIFT_ROLLING_MULTIPLIER`, `HIGH_GRIP`, `LOW_GRIP`) — now used as lerp endpoints, not switched values
- Reverse drift block: entry requires `fwd_speed > 0`
- `visual_lean_recovery_speed` — retained as optional overdamping knob `[maybe deprecated]`

---

## Overview

Kart Physics — система движения, дрифта, коллизий и взаимодействия с рельефом.
CharacterBody3D + move_and_slide() с аркадной моделью физики. Все параметры
вынесены в KartPhysicsResource (.tres) — смена класса машины = смена ресурса.

Ключевой принцип: **feel first**. Каждое решение оптимизирует ощущение от вождения,
не физическую корректность. v2.2 вводит `_drift_intensity: float [0..1]` как единственный
физический мастер-параметр — все drift-зависимые значения (`_grip`, `yaw_mult`, `drag_mult`,
`rolling_mult`, визуальный наклон) непрерывно интерполируются через этот float. Это устраняет
главный регресс v2.1: рывок на входе/выходе из дрифта.

---

## Player Fantasy

"Дрифт начинается как постепенный занос — я чувствую как зад начинает скользить, а не удар кулаком. В середине дрифта машина тяжёлая и обязательная — дуга тугая, скорость чуть падает, я это ощущаю через руль. Когда отпускаю поворот — машина не снапается обратно, а плавно цепляется за асфальт за 0.3–0.5 секунды. Я чувствую вес, инерцию, и могу это предсказать."

Каждый переход оптимизирован под ощущение, не под физическую корректность.

---

## Detailed Design

### Core Rules

1. Physics runs at 60 Hz (`_physics_process`), network sync at 30 Hz
2. Local kart: full physics simulation. Remote karts: snapshot buffer interpolation (Network Layer GDD)
3. All physics params from KartPhysicsResource (`@export`). No hardcoded values
4. State Machine gates physics: DEAD = no input, IDLE = frozen
5. Velocity decomposed into forward (`basis.z`) and lateral (`basis.x`) components
6. Gravity = 35.0 m/s² (3.57× Earth — arcade feel)
7. `move_and_slide()` handles floor/wall collision
8. Kart-to-kart collision: momentum/energy transfer
9. `max_speed` is a tunable reference value, not a physics hard clamp. Actual top speed is an emergent terminal velocity where thrust equals drag + rolling resistance. Camera and network systems use `max_speed` for normalization. User tunes empirically via `dev_params.json`, then commits final value to `.tres` once feel is correct.
10. **`_drift_intensity: float [0..1]` is the physics master.** `_is_drifting: bool` is a derived flag for VFX/audio/network only (`intensity > drift_active_threshold`). All drift-dependent physics values are `lerp(base, drift_value, _drift_intensity)` — no ternary switches for physics.
11. Reverse drift is explicitly blocked: drift entry requires `fwd_speed > 0` (strictly positive), not `|fwd_speed| > min`.
12. All drift-dependent physics values are `lerp(base, drift_value, _drift_intensity)` — no step functions in physics layer.

### KartPhysicsResource

```gdscript
class_name KartPhysicsResource
extends Resource

@export_group("Speed")
@export var accel_force: float = 400.0            # thrust applied to fwd_speed (m/s² equivalent)
@export var k_drag: float = 0.4                   # quadratic drag (dominates at high speed)
@export var k_rolling: float = 12.0               # linear rolling resistance (dominates at low speed)
@export var brake_force: float = 40.0             # m/s² deceleration when braking against movement
@export var reverse_ratio: float = 0.4            # reverse thrust as fraction of forward
@export var max_speed: float = 20.0               # reference value (tunable) — camera/network normalization

@export_group("Steering")
@export var steering_speed: float = 2.2           # rad/s base yaw rate
@export var steer_low_speed_mult: float = 1.4     # multiplier at v=0
@export var steer_high_speed_mult: float = 0.7    # multiplier at v=max_speed
@export var stationary_steer_threshold: float = 2.0  # m/s — below this, use stationary_steer_scale
@export var stationary_steer_scale: float = 0.4      # fractional speed_scale at near-zero speed

@export_group("Drift")
@export var drift_enter_threshold: float = 0.75   # |steer_input| hysteresis high — intensity grows toward 1.0
@export var drift_exit_threshold: float = 0.35    # |steer_input| hysteresis low — intensity grows toward 0.0
@export var drift_min_speed_ratio: float = 0.4    # fraction of max_speed required to enter/hold drift
@export var drift_intensity_enter_rate: float = 3.5  # /sec — how fast intensity ramps to 1.0 on entry
@export var drift_intensity_exit_rate: float = 3.0   # /sec — how fast intensity falls to 0.0 on exit
@export var drift_active_threshold: float = 0.7   # intensity level above which _is_drifting = true (VFX/audio)
@export var drift_lateral_ramp: float = 30.0      # m/s² lateral ramp force during intensity growth phase
@export var low_grip_target: float = 0.8          # lateral damping while fully drifting (intensity=1.0)
@export var high_grip_target: float = 18.0        # lateral damping when not drifting (intensity=0.0)

# [deprecated — kept as override for rollback]
# If non-zero, overrides intensity-based grip derivation and uses move_toward legacy behavior
@export var grip_loss_rate: float = 0.0           # /sec — legacy grip drop rate (0.0 = disabled, uses intensity)
@export var grip_recovery_rate: float = 0.0       # /sec — legacy grip recovery rate (0.0 = disabled, uses intensity)

@export var drift_yaw_multiplier: float = 1.7     # yaw_rate endpoint at full intensity (lerp)
@export var visual_drift_max_deg: float = 40.0    # max visual lean angle at intensity=1.0
@export var visual_lean_recovery_speed: float = 5.0  # [maybe deprecated] overdamping for body mesh lag vs intensity

# v2.1 — Drift resistance: speed cost for tight turns (tire scrubbing physics)
@export var drift_drag_multiplier: float = 1.8    # k_drag lerp endpoint at full intensity
@export var drift_rolling_multiplier: float = 1.3 # k_rolling lerp endpoint at full intensity

@export_group("Collision")
@export var mass: float = 1.0                     # relative mass (Heavy=2.0, Light=0.6)
@export var bump_min_force: float = 3.0           # minimum push on collision
@export var bump_max_force: float = 12.0          # maximum push on collision

@export_group("Terrain")
@export var slope_speed_influence: float = 8.0    # m/s² slope acceleration bonus
@export var floor_snap_length: float = 0.3        # keep kart grounded on slopes
@export var floor_align_speed: float = 8.0        # slerp speed for floor normal alignment
```

**Removed from v2.1** (superseded):
- `drift_kick_force` — replaced by `drift_lateral_ramp` continuous ramp

**Deprecated (kept as override for rollback)**:
- `grip_loss_rate` / `grip_recovery_rate` — when both are non-zero, override intensity-based grip derivation with legacy `move_toward` behavior. Default `0.0` = disabled.

### Movement Model

**Force-based acceleration** (frame-rate correct, emergent terminal velocity):

```
thrust   = throttle_input * accel_force                    # throttle_input ∈ [-1.0, 1.0]
if throttle_input < 0:
    thrust = throttle_input * accel_force * reverse_ratio

# v2.2: lerp multipliers — continuous with _drift_intensity (no ternary)
active_k_drag    = k_drag    * lerp(1.0, drift_drag_multiplier,    _drift_intensity)
active_k_rolling = k_rolling * lerp(1.0, drift_rolling_multiplier, _drift_intensity)

drag     = -sign(fwd_speed) * active_k_drag * fwd_speed * fwd_speed
rolling  = -active_k_rolling * fwd_speed
brake    = -sign(fwd_speed) * brake_force                  # only when braking opposes motion

fwd_speed += (thrust + drag + rolling + brake) * delta
```

`brake` applies only when: braking input (S key) opposes current movement direction AND `|fwd_speed| > 0.5`.

**Terminal velocity** (emergent — no hard clamp, continuous with intensity):
```
v_terminal(intensity) = sqrt(accel_force / (k_drag * lerp(1.0, drift_drag_multiplier, intensity)))
```
- intensity=0.0: `sqrt(400/0.4)` ≈ 31.6 m/s (normal)
- intensity=0.5: `sqrt(400/(0.4*1.4))` ≈ 26.7 m/s (-15%)
- intensity=1.0: `sqrt(400/(0.4*1.8))` ≈ 23.6 m/s (-25%)

Terminal velocity decreases continuously as drift intensity grows — no discrete speed jump.

**Speed-dependent steering with stationary fix**:
```
speed_ratio = clamp(abs(fwd_speed) / max_speed, 0.0, 1.0)
steer_mult  = lerp(steer_low_speed_mult, steer_high_speed_mult, speed_ratio)

if abs(fwd_speed) < stationary_steer_threshold:
    speed_scale = stationary_steer_scale
else:
    speed_scale = speed_ratio

yaw_mult = lerp(1.0, drift_yaw_multiplier, _drift_intensity)  # v2.2: continuous
effective_yaw_rate = steering_speed * steer_mult * steer_input * speed_scale * yaw_mult
rotate_y(effective_yaw_rate * delta)
```

**Velocity projection after rotation**:
```
new_fwd  = -basis.z
new_side = basis.x
fwd_speed  = velocity.dot(new_fwd)
side_speed = velocity.dot(new_side)
```

### Drift Model (v2.2 — Continuous Intensity)

**Core innovation**: a single float `_drift_intensity ∈ [0.0, 1.0]` replaces the binary `_is_drifting` as the physics driver. All drift effects interpolate through this float.

**State variables**:
```gdscript
var _drift_intensity: float = 0.0   # primary physics master [0..1]
var _is_drifting: bool = false       # derived: intensity > drift_active_threshold — VFX/audio only
var _grip: float = high_grip_target  # derived each frame from intensity (or legacy move_toward)
var _visual_drift_angle: float = 0.0 # degrees, drives body mesh decoupling
```

**Intensity update** (runs every physics frame):
```
drift_min_speed = drift_min_speed_ratio * max_speed

enter_conditions = (abs(steer_input) > drift_enter_threshold) AND (fwd_speed > drift_min_speed)
exit_conditions  = (abs(steer_input) < drift_exit_threshold)  OR  (fwd_speed <= drift_min_speed)

# Hysteresis semantics (v2.2):
# - Both thresholds in dead zone [exit, enter]? Keep current direction (no flip)
# - Above enter_threshold: target = 1.0
# - Below exit_threshold OR speed too low: target = 0.0
# - Between thresholds: target stays as last set (hysteresis gap)

if enter_conditions:
    target = 1.0
    rate   = drift_intensity_enter_rate
elif exit_conditions:
    target = 0.0
    rate   = drift_intensity_exit_rate
# else: target and rate unchanged (hysteresis — stay in current direction)

_drift_intensity = move_toward(_drift_intensity, target, rate * delta)
_drift_intensity = clamp(_drift_intensity, 0.0, 1.0)
```

**Derived `_grip`** (frame-derived, no separate animation):
```
# Default (intensity-based — v2.2 path):
if grip_loss_rate == 0.0 and grip_recovery_rate == 0.0:
    _grip = lerp(high_grip_target, low_grip_target, _drift_intensity)

# Legacy override (deprecated rollback path — only when both rates are non-zero):
else:
    target_grip = low_grip_target  if _is_drifting else high_grip_target
    grip_rate   = grip_loss_rate   if _is_drifting else grip_recovery_rate
    _grip = move_toward(_grip, target_grip, grip_rate * delta)
```

**Lateral velocity damping via `_grip`**:
```
side_speed = velocity.dot(basis.x)
side_speed = move_toward(side_speed, 0.0, _grip * delta)
velocity   = velocity - basis.x * (velocity.dot(basis.x) - side_speed)
```

**Lateral ramp kick** (continuous — replaces v2.1 one-shot impulse):
```
# Applied only while intensity is growing (enter_conditions active)
# Force falls off as intensity approaches 1.0 (no kick when already fully drifting)
if enter_conditions and _drift_intensity < 1.0:
    lateral_force = drift_lateral_ramp * (1.0 - _drift_intensity) * sign(-steer_input)
    side_speed += lateral_force * delta
```

This gives a total lateral velocity contribution of approximately:
`Δside_speed ≈ drift_lateral_ramp * entry_duration * 0.5 ≈ 30 * 0.29 * 0.5 ≈ 4.4 m/s`
...spread over ~0.3s, not a single-frame spike.

**Derived `_is_drifting`** (for VFX/audio/network only):
```
_is_drifting = _drift_intensity > drift_active_threshold
```

**Visual lean** (body mesh decoupling):
```
target_visual_angle = _drift_intensity * visual_drift_max_deg * sign(steer_input)

# Default: angle follows intensity directly (no extra lag)
_visual_drift_angle = target_visual_angle

# Optional overdamping (if visual_lean_recovery_speed is tuned):
# _visual_drift_angle = move_toward(_visual_drift_angle, target_visual_angle,
#                                    visual_lean_recovery_speed * delta)
```

`visual_lean_recovery_speed` acts as overdamping — makes the body mesh lag behind intensity for a heavier feel. Default value keeps it aligned with intensity; tune upward for extra body sway.

**Hysteresis gap behavior**:
The zone `[drift_exit_threshold, drift_enter_threshold]` = `[0.35, 0.75]` on `|steer_input|` is a "safe band". Once drifting at intensity > 0.35, player can relax steer into this band without triggering decay. The intensity holds its last direction. This mirrors SmashKarts.io's sticky feel.

**Invariant**: `drift_exit_threshold < drift_enter_threshold`. Safe minimum gap: 0.2. Violating this creates oscillation.

### Kart-to-Kart Collision

Energy-based momentum transfer: unchanged from v2.1.

```gdscript
for i in get_slide_collision_count():
    var col := get_slide_collision(i)
    var other := col.get_collider()
    if other is CharacterBody3D and other.has_method("get_kart_mass"):
        var my_energy := mass * abs(fwd_speed)
        var other_energy := other.get_kart_mass() * abs(other.velocity.length())
        var energy_diff := my_energy - other_energy
        var push_dir := col.get_normal()
        var force := clamp(abs(energy_diff) * 0.5, bump_min_force, bump_max_force)
        if energy_diff > 0:
            other.velocity += -push_dir * force
        else:
            velocity += push_dir * force
```

See v2.1 archive for full scenario table.

### Terrain — Slopes & Ramps

Slope speed influence, floor alignment, ramp launch: unchanged from v2.1. See archive for pseudocode.

Key values: gravity = 35.0 m/s², `slope_speed_influence` = 8.0 m/s², `floor_snap_length` = 0.3 m.

### Interactions with Other Systems

| System | Direction | Interface |
|--------|-----------|-----------|
| **State Machine** | ← reads | KartState gates input: DEAD = no physics, IDLE = frozen |
| **State Machine** | → triggers | Speed/drift state feeds VFX signals |
| **Network Layer** | → sends | Position/rotation/velocity at 30 Hz via `_rpc_sync` |
| **Network Layer** | ← receives | Remote karts: snapshot buffer, no local physics |
| **Health & Damage** | ← reads | Collision can trigger contact damage (future: Spikes) |
| **Kart Classes** | ← reads | KartPhysicsResource swapped per class |
| **Camera System** | → feeds | `fwd_speed`, `side_speed`, `_drift_intensity` for FOV + lateral offset |
| **VFX System** | → feeds | `_drift_intensity: float` + `_is_drifting: bool` for graduated smoke/particles |
| **Audio System** | → feeds | `fwd_speed` → engine pitch; `_drift_intensity` → graduated screech volume |
| **HUD** | → feeds | Speed → speedometer (if added) |

---

## Formulas

### 1. Drift Intensity Update

```
# Per-frame, 60 Hz
enter_conditions = (abs(steer_input) > ENTER_THRESHOLD) AND (fwd_speed > drift_min_speed)
exit_conditions  = (abs(steer_input) < EXIT_THRESHOLD)  OR  (fwd_speed <= drift_min_speed)

if enter_conditions:    target = 1.0;  rate = drift_intensity_enter_rate
elif exit_conditions:   target = 0.0;  rate = drift_intensity_exit_rate
# else: hysteresis zone — no change to target/rate

_drift_intensity = move_toward(_drift_intensity, target, rate * delta)
_drift_intensity = clamp(_drift_intensity, 0.0, 1.0)
```

| Variable | Default | Range | Effect |
|---|---|---|---|
| `drift_intensity_enter_rate` | 3.5 /s | 1.0–10.0 | Full entry 0→1 in `1/rate` sec (default ≈ 0.29s) |
| `drift_intensity_exit_rate` | 3.0 /s | 1.0–10.0 | Full exit 1→0 in `1/rate` sec (default ≈ 0.33s) |
| `drift_enter_threshold` | 0.75 | 0.55–0.90 | Steer threshold to start growing toward 1.0 |
| `drift_exit_threshold` | 0.35 | 0.15–0.55 | Steer threshold below which decay begins |

**Example** — full steer entry at drift speed, `enter_rate = 3.5`, `dt = 1/60`:

| Frame | time (s) | `_drift_intensity` |
|---|---|---|
| 0 | 0.000 | 0.000 |
| 6 | 0.100 | 0.350 |
| 12 | 0.200 | 0.700 |
| 17 | 0.283 | 0.950 |
| ~20 | 0.333 | 1.000 |

Perceptible lean begins at frame 2–3; VFX fires at frame ~12 (intensity > 0.7).

---

### 2. Force-Based Acceleration

```
thrust = throttle_input * accel_force   (or × reverse_ratio when throttle < 0)

active_k_drag    = k_drag    * lerp(1.0, drift_drag_multiplier,    _drift_intensity)
active_k_rolling = k_rolling * lerp(1.0, drift_rolling_multiplier, _drift_intensity)

drag    = -sign(fwd_speed) * active_k_drag * fwd_speed²
rolling = -active_k_rolling * fwd_speed
brake   = -sign(fwd_speed) * brake_force   (only when braking opposes motion and |fwd_speed| > 0.5)

fwd_speed(t+dt) = fwd_speed(t) + (thrust + drag + rolling + brake) * dt
```

| Variable | Default | Range |
|---|---|---|
| `accel_force` | 400.0 | 200–600 m/s² |
| `k_drag` | 0.4 | 0.1–1.0 |
| `k_rolling` | 12.0 | 5–20 /s |
| `brake_force` | 40.0 | 20–60 m/s² |
| `reverse_ratio` | 0.4 | 0.2–0.7 |
| `drift_drag_multiplier` | 1.8 | 1.2–3.0 |
| `drift_rolling_multiplier` | 1.3 | 1.0–2.0 |

**Example** — acceleration from rest, defaults, intensity=0: reaches ~62% terminal at 0.5s, ~83% at 1.0s.

---

### 3. Derived Grip

```
# v2.2 default path (grip_loss_rate == 0 AND grip_recovery_rate == 0):
_grip = lerp(high_grip_target, low_grip_target, _drift_intensity)

# [deprecated override: grip_loss_rate > 0 AND grip_recovery_rate > 0]
# target_grip = lerp(high_grip_target, low_grip_target, float(_is_drifting))
# _grip = move_toward(_grip, target_grip, rate * delta)

# Applied each frame:
side_speed = move_toward(side_speed, 0.0, _grip * delta)
```

| Variable | Default | Range |
|---|---|---|
| `high_grip_target` | 18.0 | 10–25 (m/s² lateral damping) |
| `low_grip_target` | 0.8 | 0.1–2.0 |
| `grip_loss_rate` | 0.0 | 0–20 /s — **deprecated, 0.0 = disabled** |
| `grip_recovery_rate` | 0.0 | 0–8 /s — **deprecated, 0.0 = disabled** |

**Example** at typical intensity values:

| intensity | `_grip` | side_speed decay per second |
|---|---|---|
| 0.0 | 18.0 | 18.0 m/s² — snaps lateral fast |
| 0.5 | 9.4 | 9.4 m/s² — noticeable slide |
| 1.0 | 0.8 | 0.8 m/s² — nearly free sliding |

---

### 4. Speed-Dependent Steering + Yaw Multiplier

```
speed_ratio = clamp(abs(fwd_speed) / max_speed, 0.0, 1.0)
steer_mult  = lerp(steer_low_speed_mult, steer_high_speed_mult, speed_ratio)
speed_scale = stationary_steer_scale  if abs(fwd_speed) < stationary_steer_threshold
              else speed_ratio
yaw_mult    = lerp(1.0, drift_yaw_multiplier, _drift_intensity)  # continuous v2.2

effective_yaw_rate = steering_speed * steer_mult * steer_input * speed_scale * yaw_mult
rotate_y(effective_yaw_rate * delta)
```

| `_drift_intensity` | `yaw_mult` | yaw_rate at v=20m/s, steer=1.0 |
|---|---|---|
| 0.0 | 1.00 | 1.54 rad/s |
| 0.5 | 1.35 | 2.08 rad/s |
| 1.0 | 1.70 | 2.62 rad/s |

---

### 5. Drift Hysteresis (v2.2 semantics)

```
ENTER direction (target=1.0) if:
    abs(steer_input) > drift_enter_threshold (0.75)
    AND fwd_speed > drift_min_speed_ratio * max_speed

EXIT direction (target=0.0) if:
    abs(steer_input) < drift_exit_threshold (0.35)
    OR  fwd_speed <= drift_min_speed_ratio * max_speed

HOLD current direction if: steer_input in (0.35, 0.75) — hysteresis zone
```

| Variable | Default | Range |
|---|---|---|
| `drift_enter_threshold` | 0.75 | 0.55–0.90 |
| `drift_exit_threshold` | 0.35 | 0.15–0.55 |
| `drift_min_speed_ratio` | 0.4 | 0.2–0.6 |

**Invariant**: `drift_exit_threshold < drift_enter_threshold`. Minimum safe gap: 0.2.

**Hysteresis gap**: 0.75 − 0.35 = 0.40. Steer input in `[0.35, 0.75]` holds current intensity direction.

**Example** — drift hold: player drifts at intensity=0.85, relaxes steer to 0.50 (in hysteresis zone) → intensity holds, no decay. Player releases to 0.20 (< 0.35) → decay begins at `exit_rate = 3.0/s`.

---

### 6. Terminal Velocity (continuous curve)

```
v_terminal(intensity) = sqrt(accel_force / (k_drag * lerp(1.0, drift_drag_multiplier, intensity)))
```

With defaults (`accel_force=400, k_drag=0.4, drift_drag_multiplier=1.8`):

| `_drift_intensity` | effective k_drag | `v_terminal` | vs normal |
|---|---|---|---|
| 0.0 | 0.400 | 31.6 m/s | 100% |
| 0.25 | 0.480 | 28.9 m/s | 91% |
| 0.5 | 0.560 | 26.7 m/s | 85% |
| 0.75 | 0.640 | 25.0 m/s | 79% |
| 1.0 | 0.720 | 23.6 m/s | 75% |

Speed reduction is gradual — no discrete jump. Player feels drift "costing speed" continuously as lean increases.

---

### 7. Lateral Ramp Kick

```
# Only active while intensity is growing (enter_conditions AND intensity < 1.0)
if enter_conditions and _drift_intensity < 1.0:
    lateral_force = drift_lateral_ramp * (1.0 - _drift_intensity) * sign(-steer_input)
    side_speed += lateral_force * delta
```

| Variable | Default | Range |
|---|---|---|
| `drift_lateral_ramp` | 30.0 | 10–60 m/s² |

**Example** — entry at intensity=0.0, `drift_lateral_ramp=30`, full entry over 0.29s:
`Δside_speed ≈ 30 * 0.29 * 0.5 ≈ 4.4 m/s` (average factor 0.5 because force decays as intensity rises)

Compare: v2.1 impulse was 10 m/s in one frame. v2.2 ramp gives ~4.4 m/s spread over 0.3s — same "rear swing" feel without the spike.

---

### 8. Collision Energy

```
energy = mass * speed
push_force = clamp(abs(energy_diff) * 0.5, bump_min_force, bump_max_force)
```

| Scenario | My energy | Their energy | Result |
|---|---|---|---|
| Same kart, same speed (15 m/s) | 15 | 15 | Both get min push (3.0) |
| Heavy (2.0) fast vs Light (0.6) slow | 36 | 6 | Light gets 12.0, Heavy gets 3.0 |
| Light (0.6) fast vs Heavy (2.0) stopped | 16.2 | 0 | Heavy gets 8.1, Light bounces |

---

## Edge Cases

| Scenario | Resolution |
|---|---|
| Drift attempt at zero/low speed | Rejected: `fwd_speed > drift_min_speed_ratio * max_speed` prevents entry. `_drift_intensity` stays 0. |
| Speed drops below `drift_min_speed` during active drift | Exit condition triggers immediately. `_drift_intensity` decays at `drift_intensity_exit_rate`. Slide tail still felt during decay. |
| Steer released (`< 0.35`) during active drift | Exit condition triggers. Decay begins at `exit_rate = 3.0/s`. Side_speed dissipates over ~0.3s felt as slide tail. |
| Hysteresis hold (steer in `[0.35, 0.75]`) | Neither enter nor exit condition fires. Intensity holds current direction — no change. |
| `_drift_intensity` clamp | Always `clamp(0.0, 1.0)` — no negative intensity, no overshoot above 1. |
| High enter/exit rates (approaching ∞) | Degenerates to v2.1 binary behavior (instant flip). Acceptable for testing — this is a known continuity trade-off. |
| Low enter/exit rates (near 0) | Intensity never reaches 1.0 in a typical corner duration. Drift "never fully kicks in" — tune `enter_rate ≥ 2.0`. |
| **Death in drift (DEAD state)** | `steer_input` becomes 0. Exit condition fires immediately (steer < 0.35). `_drift_intensity` decays at standard `exit_rate`. No special case logic needed — resolves naturally within 0.33s. |
| Steer flip A→D during active drift | Sign of `steer_input` flips. Exit condition fires if new steer magnitude < 0.35. If new magnitude > 0.75, intensity re-enters toward 1.0. During brief zero-crossing, intensity may dip slightly — typically imperceptible. Lateral ramp kick reapplies in new direction. |
| Collision during drift | Collision push is additive to `velocity`. `_drift_intensity` continues on its trajectory uninterrupted. Ramp kick + collision push may stack — clamped by `move_and_slide` next frame. |
| `_is_drifting` flicker near `drift_active_threshold` | Hysteresis gap at input level prevents intensity oscillation. Float intensity absorbs micro-jitter. `_is_drifting` flips only when intensity crosses 0.7 from below or above — continuous float prevents rapid oscillation. |
| Reverse drift attempt | Blocked by Core Rule 11: `fwd_speed > 0` required for entry. `_drift_intensity` stays 0 while reversing. |
| Frame rate drop (HTML5, 30fps) | All formulas are `× delta` — correct at any Hz by construction. |
| Ramp/air state | **[OPEN — deferred to post-MVP]**: User intuition: no steering in air. Current: 0.15s lockout on landing. Final air control rule TBD based on map design. |
| Spawn state | `_drift_intensity = 0.0` on spawn. Physics starts from clean state. Full specification deferred with spawn push system (post-MVP). |

---

## Dependencies

### Upstream

| System | Dependency | Type |
|---|---|---|
| **State Machine** | KartState gates physics (DEAD = no input, IDLE = frozen) | Hard |
| **Network Layer** | Position/rotation/velocity sync at 30 Hz, remote interpolation | Hard |

### Downstream

| System | What it needs | Interface |
|---|---|---|
| **Kart Classes** | KartPhysicsResource defines class identity | `KartPhysicsResource` resource swap |
| **Weapon System** | Kart position/velocity for projectile spawn | `position`, `velocity`, `basis` |
| **Camera System** | Speed + intensity for FOV, lateral offset during drift | `fwd_speed: float`, `side_speed: float`, `_drift_intensity: float` |
| **VFX System** | Graduated drift smoke, speed effects | `_drift_intensity: float`, `_is_drifting: bool`, `fwd_speed: float` |
| **Audio System** | Engine pitch, graduated tire screech | `fwd_speed: float`, `_drift_intensity: float` |
| **HUD** | Speed display | `fwd_speed: float` |

### Interface Contract

Kart controller exposes these as readable properties:

```gdscript
var _drift_intensity: float   # physics master [0..1] — NEW in v2.2
var _is_drifting: bool         # derived flag — VFX/audio/network (backward compat)
var fwd_speed: float           # forward speed
var side_speed: float          # lateral speed (after damping each frame)
var velocity: Vector3          # world-space velocity (CharacterBody3D)
```

- `_drift_intensity` is the authoritative drift float for graduated effects
- `_is_drifting` is retained for systems that need a bool trigger (VFX onset, network flag)
- Remote karts do NOT run physics — only interpolation
- Physics params ONLY from KartPhysicsResource — no hardcoded values

---

## Tuning Knobs

| Knob | Default | Safe Range | Affects | Too Low | Too High |
|---|---|---|---|---|---|
| `accel_force` | 400.0 | 200–600 | Acceleration punch + terminal velocity | Sluggish, low top speed | Twitchy, overshoots terminal fast |
| `k_drag` | 0.4 | 0.1–1.0 | Top speed ceiling (emergent) + braking assist | Very high terminal | Very low terminal speed |
| `k_rolling` | 12.0 | 5–20 /s | Coast-stop behavior, low-speed decel | Rolls forever | Stops instantly, sticky |
| `brake_force` | 40.0 | 20–60 m/s² | Brake responsiveness | Can't stop | Jarring instant stop |
| `reverse_ratio` | 0.4 | 0.2–0.7 | Reverse speed cap | Barely reverses | Full-speed reverse |
| `steering_speed` | 2.2 | 1.5–3.5 rad/s | Turn tightness across all speeds | Can't corner | Spins out |
| `steer_high_speed_mult` | 0.7 | 0.3–1.0 | High-speed handling penalty | Nearly impossible to steer at speed | No penalty, spins at top speed |
| `stationary_steer_scale` | 0.4 | 0.2–0.8 | Rotation feel when near-stopped | Barely rotates | Spins in place instantly |
| `stationary_steer_threshold` | 2.0 | 0.5–4.0 m/s | Transition point of stationary fix | Fix too narrow | Affects normal low-speed feel |
| `drift_enter_threshold` | 0.75 | 0.55–0.90 | How aggressive steer triggers intensity growth | Intensity grows too easily | Almost never drifts |
| `drift_exit_threshold` | 0.35 | 0.15–0.55 | How easily intensity decays | Decays at full-steer | Never decays (very sticky) |
| `drift_min_speed_ratio` | 0.4 | 0.2–0.6 | Min speed fraction to enter/hold drift | Drift at near-standstill | Can only drift at 60%+ top speed |
| **`drift_intensity_enter_rate`** ★ | 3.5 | 1.0–10.0 /s | Speed of ramp from 0→1 on entry; ~`1/rate` sec to full drift | Drift never fully reaches intensity=1 in a corner | Instant snap (→v2.1 binary feel) |
| **`drift_intensity_exit_rate`** ★ | 3.0 | 1.0–10.0 /s | Speed of decay from 1→0 on exit; slightly slower than enter for "tail" | No slide tail after exit | Instant snap-straight |
| **`drift_active_threshold`** ★ | 0.7 | 0.3–0.9 | Intensity level above which `_is_drifting=true`; controls when VFX/audio fire | Smoke/screech at barely-drifting intensity | VFX only fire when fully committed |
| **`drift_lateral_ramp`** ★ | 30.0 | 10–60 m/s² | Rear swing during entry — continuous force replacing v2.1 impulse | No noticeable rear swing | Violent slide on entry |
| `drift_yaw_multiplier` | 1.7 | 1.2–2.5 | Extra rotation during drift (lerp endpoint at intensity=1.0) | Drift arc same as normal | Spin-out, uncontrollable |
| `low_grip_target` | 0.8 | 0.1–2.0 | Slide amount at intensity=1.0 | Infinite slide | Barely slides |
| `high_grip_target` | 18.0 | 10–25 | Normal grip (intensity=0.0) | Always sliding | No slide ever |
| `grip_loss_rate` | 0.0 | 0–20 /s | **[deprecated]** Legacy override; 0.0 = use intensity path | — | — |
| `grip_recovery_rate` | 0.0 | 0–8 /s | **[deprecated]** Legacy override; 0.0 = use intensity path | — | — |
| `visual_drift_max_deg` | 40.0 | 20–50° | Body mesh lean at intensity=1.0 | Unnoticeable tilt | Body faces sideways |
| `visual_lean_recovery_speed` | 5.0 | 2–15 /s | **[maybe deprecated]** Body mesh overdamping vs intensity; higher = less body lag | Body instant-follows intensity | Body sways long after exit |
| `drift_drag_multiplier` | 1.8 | 1.2–3.0 | Terminal velocity reduction at intensity=1.0: `v = v_normal/sqrt(mult)` | No speed cost for tight turns | Kart crawls in any turn |
| `drift_rolling_multiplier` | 1.3 | 1.0–2.0 | Low-speed scrubbing at intensity=1.0; felt during entry/exit | No tactile scrubbing | Abrupt stop at low speed |
| `mass` | 1.0 | 0.4–3.0 | Collision weight | Gets pushed easily | Immovable |
| `slope_speed_influence` | 8.0 | 3–15 m/s² | Hill impact | Hills irrelevant | Hills dominate |
| `max_speed` (reference) | 20.0 | — | Camera + network normalization only | Camera/network wrong | FOV never widens |

★ = new in v2.2

**Removed vs v2.1**: `drift_kick_force` — replaced by `drift_lateral_ramp`.

### Knob Interactions

- `accel_force` ÷ `k_drag` = terminal velocity squared — tune together, not independently
- `drift_intensity_enter_rate` and `drift_intensity_exit_rate` — slightly different values give asymmetric feel: slower exit = longer slide tail (recommended: exit ≈ 0.85× enter rate)
- `drift_intensity_enter_rate` × `drift_enter_threshold` = how quickly committed drift begins; fast rate + low threshold = instant slam-into-drift
- `drift_lateral_ramp` × `(1/drift_intensity_enter_rate)` ≈ total lateral velocity delivered over entry; tune `drift_lateral_ramp` when entry swing is too subtle or too violent
- `drift_active_threshold` determines when VFX/audio fire — should be ≥ 0.5 so effects don't fire prematurely during brief steer touches
- `drift_enter_threshold` − `drift_exit_threshold` must stay ≥ 0.2 (hysteresis gap invariant)
- `low_grip_target` controls slide at full intensity; `drift_lateral_ramp` controls the entry swing — both contribute to "drift drama"
- `drift_yaw_multiplier` × `steering_speed` = how tight you can cut during full drift
- `k_rolling` × `k_drag` = coast feel — tune together for natural deceleration
- `mass` × observed terminal velocity = collision energy = how hard this kart hits others

---

## Visual / Audio Requirements

| Event | Visual | Audio |
|-------|--------|-------|
| Driving | — | Engine hum, pitch scales with `fwd_speed` |
| Drift onset (`_drift_intensity` rising) | Graduated tire smoke scaled by `_drift_intensity` | Screech onset, volume scales with `_drift_intensity` |
| Full drift (`_is_drifting = true`) | Full tire smoke, tire marks on ground | Full tire screech |
| Drift release | Smoke fades with `_drift_intensity` decay | Screech fades with `_drift_intensity` |
| High speed (>80% max_speed) | Speed lines on screen edges, camera FOV widens | Engine high-rev, wind noise |
| Collision with kart | Brief spark VFX at contact point | Metal clang SFX |
| Collision with wall | Dust puff at contact | Thud SFX |
| Ramp launch | — | Whoosh SFX |
| Landing | Brief camera shake, dust puff | Thump SFX |
| Slope up | — | Engine strain (lower pitch) |
| Slope down | Speed lines intensify | Engine ease (higher pitch) |

---

## UI Requirements

| Element | Location | Updates |
|---------|----------|---------|
| Speed indicator | Optional — HUD bottom | On speed change |
| Drift indicator | Tire smoke VFX is sufficient | On `_drift_intensity` change |

Debug overlay (dev builds only): `_drift_intensity` float bar, `side_speed`, `fwd_speed`, `_is_drifting` bool. Essential for tuning.

---

## Acceptance Criteria

### Functional Tests (automated — headless)

- [ ] Kart accelerates to ~90% terminal velocity within 2.0s from rest
- [ ] Terminal velocity is emergent — `fwd_speed` stabilizes without a hard clamp
- [ ] Braking from 20 m/s stops kart within 0.6s
- [ ] Coasting from 20 m/s: `fwd_speed` drops to <5 m/s within 2.0s (k_rolling effect)
- [ ] Steering rate at v=0 uses `stationary_steer_scale` (0.4), not zero
- [ ] **`_drift_intensity` reaches ≥ 0.95 within 0.25–0.35s from conditions met at full steer (|steer|=1.0, v > drift_min)**
- [ ] **`_drift_intensity` falls to ≤ 0.05 within 0.30–0.40s after steer drops to 0.0**
- [ ] **`_grip`, `yaw_mult`, `drag_mult`, `rolling_mult` all change as continuous functions of `_drift_intensity` — no single-frame step visible in frame-by-frame debug log**
- [ ] **`_is_drifting = true` exactly when `_drift_intensity > drift_active_threshold` (0.7), false otherwise**
- [ ] Hysteresis hold: `_drift_intensity` does not decay when steer held at 0.50 (in `[exit, enter]` zone)
- [ ] Reverse drift blocked: `|steer_input|=1.0` while `fwd_speed < 0` → `_drift_intensity` stays 0
- [ ] **Lateral ramp: `side_speed` does not spike >5 m/s in a single frame at any point during drift entry (verify at 60fps)**
- [ ] Speed reduction continuous: at intensity=0.5, effective `k_drag` ≈ `k_drag * lerp(1.0, 1.8, 0.5)` = `k_drag * 1.4`
- [ ] `drift_active_threshold = 0.7`: VFX flag `_is_drifting` fires at intensity 0.70, not at 0.0 or 1.0
- [ ] Kart-to-kart collision: heavier/faster kart pushes lighter/slower
- [ ] Collision push force clamped between `bump_min_force` and `bump_max_force`
- [ ] Slope: kart accelerates downhill, decelerates uphill
- [ ] KartPhysicsResource swap changes all physics behavior (no hardcoded values)
- [ ] **DEAD state: `steer_input` = 0, exit condition fires, `_drift_intensity` decays to 0 without special-case code**
- [ ] Remote karts do not run physics (only interpolation)
- [ ] deprecated `grip_loss_rate = 0.0`: intensity-based grip path used (verify no `move_toward` grip calls)

### Network Tests (automated)

- [ ] Position sync at 30 Hz includes `velocity` for interpolation
- [ ] Remote kart positions are smooth (snapshot buffer, no jitter)
- [ ] Server teleport check uses `max_speed` reference value from KartPhysicsResource
- [ ] `_drift_intensity` transmitted at 30 Hz for VFX sync on remote clients

### Playtest Criteria (human) — CRITICAL for this system

- [ ] **NO jerk/punch sensation on drift entry — kart "leans into" the drift over ~0.2–0.5s (the v2.1 regression being fixed)**
- [ ] **NO snap-forward sensation on drift exit — kart settles back over ~0.3–0.5s**
- [ ] Drift onset perceptibly gradual — visible body lean builds over time, not instant
- [ ] Mid-drift kart feels heavy and committed — tighter arc, perceptible speed cost
- [ ] Drift exit tail: kart slides ~0.3–0.5s after releasing steer — feels sticky and weighty
- [ ] Hysteresis feels right: relaxing steer mid-drift does not accidentally exit
- [ ] Rear swing visible on drift entry — satisfying "kick" that arrives over first ~0.3s, not instant
- [ ] Counter-steering during drift feels responsive and controllable
- [ ] `visual_drift_angle` never snaps >20° in a single frame (was a visible bug in v2.1)
- [ ] After player dies in drift, kart visually settles without any snap or freeze artifact
- [ ] Overall: "this feels like SmashKarts but with more weight and zero entry jank"

---

## Open Questions

1. **[OPEN — deferred to post-MVP] Air control**: User intuition: "no steering in air". Current: 0.15s lockout on landing. Final rule depends on map design (ramp gameplay). TBD post-MVP.
