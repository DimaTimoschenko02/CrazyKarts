---
status: active
version: "2.3"
date: 2026-04-21
last-updated: 2026-04-21
---

# Kart Physics System

> **Status**: Active (v2.3 — continuous intensity_target from pow(|steer|, exponent))
> **Author**: Dima + game-designer + systems-designer + godot-specialist + technical-director
> **Last Updated**: 2026-04-21 (v2.3: continuous `intensity_target` replaces binary hysteresis targeting)
> **Previous version archives**: `design/gdd/kart-physics-v2.2-archive.md`, `design/gdd/kart-physics-v2.1-archive.md`
> **Implements Pillar**: Аркадный хаос (arcade feel, не симулятор) + Вариативность (kart classes via physics)

---

## Changes from v2.2

### What changes

- **`intensity_target` is now a continuous function of `|steer_input|`**: `target = pow(|steer_input|, DRIFT_STEER_EXPONENT) * speed_factor` instead of binary 0.0/1.0 selected by hysteresis thresholds
- **`DRIFT_STEER_EXPONENT = 3.0`** — new tuning knob (range 1.5–5.0). Controls the curvature of the target-vs-steer curve. exponent=1.0 is linear; exponent=3.0 gives slow build-up at low steer and rapid ramp near full steer
- **`speed_factor`** replaces the hard `drift_min_speed` gate: `speed_factor = clamp((fwd_speed - drift_min_speed) / drift_min_speed, 0.0, 1.0)`. Below `drift_min_speed`: target=0.0 (continuous fade, not a cliff). At 2×`drift_min_speed`: target=full steer pow value
- **`DRIFT_ENTER_THRESHOLD` and `DRIFT_EXIT_THRESHOLD` removed** — hysteresis on intensity targeting is gone. These knobs no longer exist in `KartPhysicsResource`
- **`intensity_target` drives `move_toward` to a float** (was: move_toward to 0.0 or 1.0). Rate logic preserved: `enter_rate` when target > current, `exit_rate` when target < current
- **`_is_drifting` mini-hysteresis**: `true` when `_drift_intensity > 0.72`, `false` when `_drift_intensity < 0.68`. Prevents VFX/audio flicker when intensity hovers around the threshold. (v2.2: simple threshold flip at 0.7)
- **Lateral ramp condition updated**: `if target > prev_target AND _drift_intensity < target` — ramp fires only while intensity is actively climbing toward a higher target. Prevents ramp firing during steady-state or exit
- **Steer sign preservation**: when `|steer_input| < 0.05`, preserve previous `steer_input` sign for visual lean and ramp direction. Prevents body-mesh flip from input jitter near center

### What is removed

- `drift_enter_threshold` (was 0.75) — superseded by continuous target function
- `drift_exit_threshold` (was 0.35) — superseded by continuous target function

### What stays from v2.2

- `_drift_intensity: float [0..1]` as the single physics master
- `move_toward(_drift_intensity, target, rate * delta)` update pattern
- `drift_intensity_enter_rate` and `drift_intensity_exit_rate` — unchanged semantics, same defaults
- `_grip = lerp(high_grip_target, low_grip_target, _drift_intensity)` — unchanged
- All lerp multipliers: `yaw_mult`, `active_k_drag`, `active_k_rolling` — unchanged
- `drift_lateral_ramp` continuous ramp — preserved, condition updated (see above)
- `drift_active_threshold` knob — now only used as reference, not for `_is_drifting` flip (replaced by mini-hysteresis band centered on it)
- `drift_min_speed_ratio` — retained, role changes from hard gate to speed_factor ramp origin
- Force-based inertia model (thrust + k_drag·v² + k_rolling·v)
- Direct rotation via `rotate_y()` + velocity reprojection
- All v2.2 collision, terrain, camera/VFX/audio interfaces
- deprecated `grip_loss_rate` / `grip_recovery_rate` rollback path

---

## Overview

Kart Physics — система движения, дрифта, коллизий и взаимодействия с рельефом.
CharacterBody3D + move_and_slide() с аркадной моделью физики. Все параметры
вынесены в KartPhysicsResource (.tres) — смена класса машины = смена ресурса.

Ключевой принцип: **feel first**. Каждое решение оптимизирует ощущение от вождения,
не физическую корректность. v2.3 устраняет последний бинарный элемент в дрифтовой модели:
`intensity_target` теперь непрерывная функция от `|steer_input|` через степенную кривую
(`pow(|steer|, exponent) * speed_factor`). При exponent=3.0 игрок получает мягкий отклик
при лёгком нажатии руля и мощный дрифт при полном — без порогов, без хлопков,
без ощущения "дрифт включился".

---

## Player Fantasy

"Когда я поворачиваю чуть-чуть — машина немного подскальзывает, ещё не дрифт, но уже ощущается. Жму сильнее — занос нарастает плавно, зад начинает тянуться. На полном руле — полный дрифт, тугая дуга, тяжело и приятно. Отпускаю — машина сама выбирается, без рывка. Всё читается через руль — я всегда знаю где нахожусь в диапазоне."

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
10. **`_drift_intensity: float [0..1]` is the physics master.** `_is_drifting: bool` is a derived flag for VFX/audio/network only (mini-hysteresis band: true above 0.72, false below 0.68). All drift-dependent physics values are `lerp(base, drift_value, _drift_intensity)` — no ternary switches for physics.
11. Reverse drift is explicitly blocked: drift intensity targeting requires `fwd_speed > 0`; `speed_factor = 0` when `fwd_speed <= 0`.
12. All drift-dependent physics values are `lerp(base, drift_value, _drift_intensity)` — no step functions in physics layer.
13. **`intensity_target` is a continuous function of `|steer_input|` and `speed_factor`** — no binary thresholds for targeting. Steer input maps to target via `pow(|steer|, exponent) * speed_factor`.

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
# REMOVED in v2.3: drift_enter_threshold, drift_exit_threshold
@export var drift_steer_exponent: float = 3.0     # power curve exponent for intensity_target = pow(|steer|, exp)
@export var drift_min_speed_ratio: float = 0.4    # speed_factor ramp origin: fraction of max_speed
@export var drift_intensity_enter_rate: float = 3.5  # /sec — how fast intensity climbs toward target
@export var drift_intensity_exit_rate: float = 3.0   # /sec — how fast intensity falls toward target
@export var drift_active_threshold: float = 0.7   # center of _is_drifting mini-hysteresis band (±0.02)
@export var drift_lateral_ramp: float = 30.0      # m/s² lateral ramp force while intensity climbing
@export var low_grip_target: float = 0.8          # lateral damping while fully drifting (intensity=1.0)
@export var high_grip_target: float = 18.0        # lateral damping when not drifting (intensity=0.0)

# [deprecated — kept as override for rollback]
@export var grip_loss_rate: float = 0.0           # /sec — legacy grip drop rate (0.0 = disabled)
@export var grip_recovery_rate: float = 0.0       # /sec — legacy grip recovery rate (0.0 = disabled)

@export var drift_yaw_multiplier: float = 1.7     # yaw_rate endpoint at full intensity (lerp)
@export var visual_drift_max_deg: float = 40.0    # max visual lean angle at intensity=1.0
@export var visual_lean_recovery_speed: float = 5.0  # [maybe deprecated] body mesh lag overdamping

# v2.1 — Drift resistance: speed cost for tight turns
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

**Removed in v2.3**:
- `drift_enter_threshold` — superseded by continuous `intensity_target` function
- `drift_exit_threshold` — superseded by continuous `intensity_target` function

**Added in v2.3**:
- `drift_steer_exponent` — power curve exponent for `intensity_target`

**Deprecated (kept as override for rollback)**:
- `grip_loss_rate` / `grip_recovery_rate` — when both are non-zero, override intensity-based grip derivation with legacy `move_toward` behavior. Default `0.0` = disabled.

### Movement Model

**Force-based acceleration** (frame-rate correct, emergent terminal velocity):

```
thrust   = throttle_input * accel_force                    # throttle_input ∈ [-1.0, 1.0]
if throttle_input < 0:
    thrust = throttle_input * accel_force * reverse_ratio

# v2.2+: lerp multipliers — continuous with _drift_intensity (no ternary)
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

yaw_mult = lerp(1.0, drift_yaw_multiplier, _drift_intensity)  # continuous
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

### Drift Model (v2.3 — Continuous Target)

**Core innovation**: `intensity_target` is a continuous function of `|steer_input|` via a power curve, modulated by `speed_factor`. There are no binary thresholds for intensity targeting — only smooth mappings. The `move_toward` rate logic (enter vs exit) is preserved from v2.2.

**State variables**:
```gdscript
var _drift_intensity: float = 0.0   # primary physics master [0..1]
var _drift_intensity_target: float = 0.0  # computed each frame from steer + speed
var _drift_intensity_prev_target: float = 0.0  # previous frame target (for ramp condition)
var _is_drifting: bool = false       # derived: mini-hysteresis — VFX/audio only
var _grip: float = high_grip_target  # derived each frame from intensity
var _visual_drift_angle: float = 0.0 # degrees, drives body mesh decoupling
var _steer_sign: float = 0.0         # sign of last non-jitter steer input (preserved at |steer|<0.05)
```

**Steer sign preservation** (pre-step, runs before intensity update):
```
if abs(steer_input) >= 0.05:
    _steer_sign = sign(steer_input)
# else: _steer_sign unchanged — preserves last known direction to avoid flip from jitter
```

**Speed factor** (replaces hard min-speed gate):
```
drift_min_speed = drift_min_speed_ratio * max_speed

speed_factor = clamp((fwd_speed - drift_min_speed) / drift_min_speed, 0.0, 1.0)
# Note: fwd_speed <= 0 → speed_factor = 0 → target = 0 (blocks reverse drift implicitly)
# At fwd_speed = drift_min_speed: speed_factor = 0 (target=0)
# At fwd_speed = 2 * drift_min_speed: speed_factor = 1 (target = full steer pow value)
# Between drift_min_speed and 2*drift_min_speed: linear ramp
```

**Intensity target** (continuous, per-frame):
```
intensity_target = pow(abs(steer_input), drift_steer_exponent) * speed_factor
intensity_target = clamp(intensity_target, 0.0, 1.0)
```

**Intensity update** (runs every physics frame):
```
# Rate selection: enter_rate when climbing, exit_rate when falling
if intensity_target > _drift_intensity:
    rate = drift_intensity_enter_rate
else:
    rate = drift_intensity_exit_rate

_drift_intensity_prev_target = _drift_intensity_target
_drift_intensity_target = intensity_target

_drift_intensity = move_toward(_drift_intensity, _drift_intensity_target, rate * delta)
_drift_intensity = clamp(_drift_intensity, 0.0, 1.0)
```

**Derived `_is_drifting`** (mini-hysteresis band, for VFX/audio/network only):
```
# Band centered on drift_active_threshold (default 0.7), width ±0.02
var hyst_high = drift_active_threshold + 0.02   # 0.72
var hyst_low  = drift_active_threshold - 0.02   # 0.68

if _is_drifting:
    if _drift_intensity < hyst_low:
        _is_drifting = false
else:
    if _drift_intensity > hyst_high:
        _is_drifting = true
# else: no change — hysteresis hold
```

**Derived `_grip`** (frame-derived, no separate animation):
```
# Default (intensity-based — v2.2+ path):
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

**Lateral ramp kick** (v2.3 condition — fires only while intensity is actively rising toward higher target):
```
# Ramp condition: target increased this frame AND intensity hasn't caught up yet
if _drift_intensity_target > _drift_intensity_prev_target and _drift_intensity < _drift_intensity_target:
    lateral_force = drift_lateral_ramp * (1.0 - _drift_intensity) * _steer_sign * -1.0
    side_speed += lateral_force * delta
```

This fires during entry and when player increases steer pressure mid-drift. Does NOT fire during steady-state (target stable) or on exit (target falling). The `(1.0 - _drift_intensity)` factor ensures force fades as intensity catches up.

**Visual lean** (body mesh decoupling):
```
# _steer_sign used (not raw steer_input) to prevent body flip at |steer|<0.05
target_visual_angle = _drift_intensity * visual_drift_max_deg * _steer_sign

# Default: angle follows intensity directly (no extra lag)
_visual_drift_angle = target_visual_angle

# Optional overdamping (if visual_lean_recovery_speed is tuned):
# _visual_drift_angle = move_toward(_visual_drift_angle, target_visual_angle,
#                                    visual_lean_recovery_speed * delta)
```

### Kart-to-Kart Collision

Energy-based momentum transfer: unchanged from v2.1/v2.2.

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
| **VFX System** | → feeds | `_drift_intensity: float` + `_is_drifting: bool` (mini-hyst) for graduated smoke/particles |
| **Audio System** | → feeds | `fwd_speed` → engine pitch; `_drift_intensity` → graduated screech volume |
| **HUD** | → feeds | Speed → speedometer (if added) |

---

## Formulas

### 1. Speed Factor (continuous speed gate)

```
drift_min_speed = drift_min_speed_ratio * max_speed
speed_factor    = clamp((fwd_speed - drift_min_speed) / drift_min_speed, 0.0, 1.0)
```

| Variable | Default | Range | Effect |
|---|---|---|---|
| `drift_min_speed_ratio` | 0.4 | 0.2–0.6 | Fraction of max_speed where speed_factor ramp starts |
| `drift_min_speed` (derived) | 8.0 m/s | — | `= drift_min_speed_ratio * max_speed` |

**Curve** (max_speed=20, drift_min_speed=8):

| `fwd_speed` | `speed_factor` |
|---|---|
| 0 m/s | 0.00 — reverse drift fully blocked |
| 8 m/s (= drift_min_speed) | 0.00 — just at ramp origin |
| 12 m/s | 0.50 — half-speed target scaling |
| 16 m/s (= 2× drift_min_speed) | 1.00 — full target available |
| 20+ m/s | 1.00 (clamped) |

**Example**: `fwd_speed=10, drift_min_speed=8` → `speed_factor = (10-8)/8 = 0.25`

---

### 2. Intensity Target (power curve)

```
intensity_target = pow(abs(steer_input), drift_steer_exponent) * speed_factor
intensity_target = clamp(intensity_target, 0.0, 1.0)
```

| Variable | Default | Range | Effect |
|---|---|---|---|
| `drift_steer_exponent` | 3.0 | 1.5–5.0 | Curve shape: 1.0=linear, 3.0=cubic (slow build, fast at full), 5.0=very steep near 1.0 |

**Target curve** at `speed_factor=1.0` (full speed), exponent=3.0:

| `|steer_input|` | `intensity_target` |
|---|---|
| 0.0 | 0.000 |
| 0.3 | 0.027 |
| 0.5 | 0.125 |
| 0.7 | 0.343 |
| 0.85 | 0.614 |
| 1.0 | 1.000 |

**Example**: `|steer|=0.5, speed_factor=0.8` → `target = pow(0.5, 3.0) * 0.8 = 0.125 * 0.8 = 0.100`

---

### 3. Intensity Update (move_toward to float target)

```
if intensity_target > _drift_intensity:
    rate = drift_intensity_enter_rate
else:
    rate = drift_intensity_exit_rate

_drift_intensity = move_toward(_drift_intensity, intensity_target, rate * delta)
_drift_intensity = clamp(_drift_intensity, 0.0, 1.0)
```

| Variable | Default | Range | Effect |
|---|---|---|---|
| `drift_intensity_enter_rate` | 3.5 /s | 1.0–10.0 | Speed of ramp toward target when climbing |
| `drift_intensity_exit_rate` | 3.0 /s | 1.0–10.0 | Speed of decay toward target when falling |

**Time to reach target** at `enter_rate=3.5`:
- `|steer|=1.0, speed_factor=1.0` → target=1.0, time 0→1 ≈ 0.29s
- `|steer|=0.5, speed_factor=1.0` → target=0.125, time 0→0.125 ≈ 0.036s (quick partial settle)
- `|steer|=0.7, speed_factor=1.0` → target=0.343, time 0→0.343 ≈ 0.098s

**Example** — `|steer|=0.5` entry from 0, `enter_rate=3.5`, `dt=1/60`:

| Frame | time (s) | `intensity_target` | `_drift_intensity` |
|---|---|---|---|
| 0 | 0.000 | 0.125 | 0.000 |
| 2 | 0.033 | 0.125 | 0.117 |
| 3 | 0.050 | 0.125 | 0.125 (settled) |

Compared to v2.2 full steer: intensity never reaches 1.0 at half steer — this is the continuous model in action.

---

### 4. Derived `_is_drifting` (mini-hysteresis)

```
var hyst_high = drift_active_threshold + 0.02   # default: 0.72
var hyst_low  = drift_active_threshold - 0.02   # default: 0.68

if _is_drifting:
    if _drift_intensity < hyst_low:
        _is_drifting = false
else:
    if _drift_intensity > hyst_high:
        _is_drifting = true
```

| Variable | Default | Notes |
|---|---|---|
| `drift_active_threshold` | 0.7 | Center of band |
| `hyst_high` (derived) | 0.72 | `= drift_active_threshold + 0.02` |
| `hyst_low` (derived) | 0.68 | `= drift_active_threshold - 0.02` |

**Effect**: intensity oscillating within [0.68, 0.72] does not toggle `_is_drifting`. VFX/audio won't flicker when player holds steer that produces target ≈ 0.7.

**Example**: intensity rises through 0.72 → `_is_drifting = true`. Player slightly relaxes steer, intensity dips to 0.70 → `_is_drifting` stays true. Falls to 0.67 → `_is_drifting = false`.

---

### 5. Lateral Ramp Kick (v2.3 condition)

```
# Ramp condition: target is rising AND intensity hasn't reached it yet
if _drift_intensity_target > _drift_intensity_prev_target and _drift_intensity < _drift_intensity_target:
    lateral_force = drift_lateral_ramp * (1.0 - _drift_intensity) * _steer_sign * -1.0
    side_speed += lateral_force * delta
```

| Variable | Default | Range |
|---|---|---|
| `drift_lateral_ramp` | 30.0 | 10–60 m/s² |

**Condition semantics**:
- `target > prev_target` — steer pressure is increasing (more lean requested)
- `intensity < target` — intensity hasn't caught up yet (ramp phase)
- Both must be true. If steer is held steady (target stable), ramp is silent.

**Example** — entry at `|steer|=1.0` from rest, `intensity=0`, `ramp=30`, entry over 0.29s:
`Δside_speed ≈ 30 * 0.29 * 0.5 ≈ 4.4 m/s` (factor 0.5 from `(1-intensity)` decay)

**Example** — mid-drift steer increase from `|steer|=0.7` (target=0.343) to `|steer|=1.0` (target=1.0):
Ramp fires again during the new ramp phase — player gets a secondary kick for the steer push.

---

### 6. Force-Based Acceleration

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

### 7. Derived Grip

```
# v2.2+ default path:
_grip = lerp(high_grip_target, low_grip_target, _drift_intensity)

# Applied each frame:
side_speed = move_toward(side_speed, 0.0, _grip * delta)
```

| intensity | `_grip` | side_speed decay per second |
|---|---|---|
| 0.0 | 18.0 | 18.0 m/s² — snaps lateral fast |
| 0.125 (|steer|=0.5, full speed) | 15.1 | 15.1 m/s² — slight slide |
| 0.5 | 9.4 | 9.4 m/s² — noticeable slide |
| 1.0 | 0.8 | 0.8 m/s² — nearly free sliding |

---

### 8. Speed-Dependent Steering + Yaw Multiplier

```
speed_ratio = clamp(abs(fwd_speed) / max_speed, 0.0, 1.0)
steer_mult  = lerp(steer_low_speed_mult, steer_high_speed_mult, speed_ratio)
speed_scale = stationary_steer_scale  if abs(fwd_speed) < stationary_steer_threshold
              else speed_ratio
yaw_mult    = lerp(1.0, drift_yaw_multiplier, _drift_intensity)

effective_yaw_rate = steering_speed * steer_mult * steer_input * speed_scale * yaw_mult
rotate_y(effective_yaw_rate * delta)
```

| `_drift_intensity` | `yaw_mult` | yaw_rate at v=20m/s, steer=1.0 |
|---|---|---|
| 0.0 | 1.00 | 1.54 rad/s |
| 0.5 | 1.35 | 2.08 rad/s |
| 1.0 | 1.70 | 2.62 rad/s |

---

### 9. Terminal Velocity (continuous curve)

```
v_terminal(intensity) = sqrt(accel_force / (k_drag * lerp(1.0, drift_drag_multiplier, intensity)))
```

| `_drift_intensity` | effective k_drag | `v_terminal` | vs normal |
|---|---|---|---|
| 0.0 | 0.400 | 31.6 m/s | 100% |
| 0.25 | 0.480 | 28.9 m/s | 91% |
| 0.5 | 0.560 | 26.7 m/s | 85% |
| 0.75 | 0.640 | 25.0 m/s | 79% |
| 1.0 | 0.720 | 23.6 m/s | 75% |

---

### 10. Collision Energy

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
| Drift attempt at zero/low speed | `speed_factor = 0` → `intensity_target = 0` → `_drift_intensity` decays to 0. No entry possible. Smooth: kart approaching drift_min_speed gets linearly growing target as speed rises. |
| Speed drops below `drift_min_speed` mid-drift | `speed_factor` drops smoothly (not a cliff). `intensity_target` falls proportionally. `_drift_intensity` decays toward new lower target at `exit_rate`. Slide tail felt during decay — proportional to how far speed dropped. |
| Light steer (`|steer|=0.3`) at full speed | `intensity_target = pow(0.3, 3.0) = 0.027` — near-zero, barely perceptible. `_drift_intensity` settles at 0.027. No VFX fire (below 0.68 threshold). Steering feels slightly loose but not a drift. |
| Full steer release (`steer=0`) | `intensity_target = 0`. `_drift_intensity` decays at `exit_rate = 3.0/s`. `_is_drifting` stays true until intensity falls below 0.68. Slide tail fully felt. |
| Steer flip A↔D through zero | `|steer_input|` passes through 0 briefly — `intensity_target` dips to 0, `_drift_intensity` starts decaying. If flip is fast (<3 frames), intensity barely dips before new direction builds target back up. At `|steer|<0.05`, `_steer_sign` is frozen — no body mesh flip or ramp direction flip during zero-crossing. |
| Input jitter (`|steer|` oscillates near 0.05) | `_steer_sign` frozen when `|steer|<0.05` — sign preserved. `intensity_target` stays near 0 (jitter below 0.05 → target < `pow(0.05,3.0)=0.000125`). No visible effect. |
| Speed crosses `drift_min_speed` upward | `speed_factor` ramps 0→1 linearly over next `drift_min_speed` worth of speed. `intensity_target` grows proportionally. No cliff. Player feels drift "arrive" as they accelerate past the gate. |
| Full steer at standstill (`steer=1.0, speed=0`) | `speed_factor = 0` → `intensity_target = 0`. No drift, `_drift_intensity` stays 0. Kart uses `stationary_steer_scale` for rotation. Body mesh shows no lean. |
| `_drift_intensity` clamp | Always `clamp(0.0, 1.0)` — no negative intensity, no overshoot above 1. |
| High enter/exit rates (approaching ∞) | Intensity snaps instantly to `intensity_target` each frame — still continuous (target is float), just without transition feel. Not binary. |
| Low enter/exit rates (near 0) | Intensity never reaches target in a typical corner duration. Drift "lags heavily" — tune `enter_rate >= 2.0`. |
| **Death in drift (DEAD state)** | `steer_input` becomes 0. `intensity_target = 0`. `_drift_intensity` decays at `exit_rate`. No special case — resolves naturally within 0.33s. |
| Collision during drift | Collision push is additive to `velocity`. `_drift_intensity` continues on its trajectory. Ramp may refire if steer input rises (target goes up) — collision + ramp can stack. Clamped by `move_and_slide` next frame. |
| `_is_drifting` flicker near threshold | Mini-hysteresis band [0.68, 0.72] absorbs intensity oscillation around the threshold. `_is_drifting` won't toggle unless intensity exits the band cleanly. |
| Reverse drift attempt | `fwd_speed <= 0` → `speed_factor = 0` → `intensity_target = 0`. Blocked implicitly — no special case needed. |
| Frame rate drop (HTML5, 30fps) | All formulas are `× delta` — correct at any Hz by construction. |
| Ramp/air state | **[OPEN — deferred to post-MVP]**: User intuition: no steering in air. Current: 0.15s lockout on landing. Final air control rule TBD based on map design. |
| Spawn state | `_drift_intensity = 0.0` on spawn. `_steer_sign = 0.0`. Physics starts from clean state. Full specification deferred with spawn push system (post-MVP). |

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
| **VFX System** | Graduated drift smoke, speed effects | `_drift_intensity: float`, `_is_drifting: bool` (mini-hyst), `fwd_speed: float` |
| **Audio System** | Engine pitch, graduated tire screech | `fwd_speed: float`, `_drift_intensity: float` |
| **HUD** | Speed display | `fwd_speed: float` |

### Interface Contract

Kart controller exposes these as readable properties:

```gdscript
var _drift_intensity: float       # physics master [0..1]
var _drift_intensity_target: float # current frame target (debug/telemetry)
var _is_drifting: bool             # derived flag — mini-hysteresis, VFX/audio/network
var fwd_speed: float               # forward speed
var side_speed: float              # lateral speed (after damping each frame)
var velocity: Vector3              # world-space velocity (CharacterBody3D)
```

- `_drift_intensity` is the authoritative drift float for graduated effects
- `_is_drifting` uses mini-hysteresis (±0.02 around `drift_active_threshold`) — not a raw threshold flip
- `_drift_intensity_target` exposed for debug overlay — not required by any gameplay system
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
| **`drift_steer_exponent`** ★ | 3.0 | 1.5–5.0 | Curve shape: how steeply target scales with steer; 1.0=linear, 3.0=cubic | Drift starts too easily at small steer angles | Only extreme full-steer triggers meaningful drift |
| `drift_min_speed_ratio` | 0.4 | 0.2–0.6 | speed_factor ramp origin — fraction of max_speed where drift starts becoming available | Drift available at near-zero speed | Drift only available at 60%+ top speed |
| **`drift_intensity_enter_rate`** ★ | 3.5 | 1.0–10.0 /s | Speed of intensity climb toward target; `1/rate` ≈ time to reach target=1.0 | Intensity lags heavily, drift never fully kicks in | Instant snap to target (no transition feel) |
| **`drift_intensity_exit_rate`** ★ | 3.0 | 1.0–10.0 /s | Speed of intensity fall toward lower target; slightly slower for slide tail | No slide tail — exits instantly | Long persistent slide even after releasing steer |
| **`drift_active_threshold`** ★ | 0.7 | 0.3–0.9 | Center of `_is_drifting` mini-hysteresis band (±0.02); controls when VFX/audio fire | Smoke/screech fire at barely-drifting intensity | VFX only fire when fully committed |
| **`drift_lateral_ramp`** ★ | 30.0 | 10–60 m/s² | Rear swing force while intensity is actively climbing — fires on entry and steer increases | No rear swing feel | Violent spin on entry |
| `drift_yaw_multiplier` | 1.7 | 1.2–2.5 | Extra rotation during drift (lerp endpoint at intensity=1.0) | Drift arc same as normal | Spin-out, uncontrollable |
| `low_grip_target` | 0.8 | 0.1–2.0 | Slide amount at intensity=1.0 | Infinite slide | Barely slides |
| `high_grip_target` | 18.0 | 10–25 | Normal grip (intensity=0.0) | Always sliding | No slide ever |
| `grip_loss_rate` | 0.0 | 0–20 /s | **[deprecated]** Legacy override; 0.0 = use intensity path | — | — |
| `grip_recovery_rate` | 0.0 | 0–8 /s | **[deprecated]** Legacy override; 0.0 = use intensity path | — | — |
| `visual_drift_max_deg` | 40.0 | 20–50° | Body mesh lean at intensity=1.0 | Unnoticeable tilt | Body faces sideways |
| `visual_lean_recovery_speed` | 5.0 | 2–15 /s | **[maybe deprecated]** Body mesh overdamping vs intensity | Body instant-follows intensity | Body sways long after exit |
| `drift_drag_multiplier` | 1.8 | 1.2–3.0 | Terminal velocity reduction at intensity=1.0 | No speed cost for tight turns | Kart crawls in any turn |
| `drift_rolling_multiplier` | 1.3 | 1.0–2.0 | Low-speed scrubbing at intensity=1.0 | No tactile scrubbing | Abrupt stop at low speed |
| `mass` | 1.0 | 0.4–3.0 | Collision weight | Gets pushed easily | Immovable |
| `slope_speed_influence` | 8.0 | 3–15 m/s² | Hill impact | Hills irrelevant | Hills dominate |
| `max_speed` (reference) | 20.0 | — | Camera + network normalization only | Camera/network wrong | FOV never widens |

★ = new in v2.2 or v2.3 (`drift_steer_exponent` is v2.3 addition)

**Removed vs v2.2**: `drift_enter_threshold`, `drift_exit_threshold` — superseded by continuous target function.
**Added in v2.3**: `drift_steer_exponent`.

### Knob Interactions

- `accel_force` ÷ `k_drag` = terminal velocity squared — tune together, not independently
- `drift_intensity_enter_rate` and `drift_intensity_exit_rate` — slightly different values give asymmetric feel: slower exit = longer slide tail (recommended: exit ≈ 0.85× enter rate)
- **`drift_steer_exponent` + `drift_intensity_enter_rate`**: exponent controls the target ceiling at a given steer; enter_rate controls how fast intensity chases that target. Low exponent + low rate = extremely gradual drift that never builds. High exponent + high rate = crisp commitment near full steer only.
- `drift_lateral_ramp` × `(1/drift_intensity_enter_rate)` ≈ total lateral velocity delivered during full entry; tune `drift_lateral_ramp` when entry swing feels too subtle or too violent
- `drift_active_threshold` center of `_is_drifting` band — should be ≥ 0.5 so effects don't fire at casual steering touches; for exponent=3.0, intensity_target=0.7 requires `|steer|=0.888`
- `low_grip_target` controls slide at full intensity; `drift_lateral_ramp` controls entry swing — both contribute to "drift drama"
- `drift_yaw_multiplier` × `steering_speed` = how tight you can cut during full drift
- `k_rolling` × `k_drag` = coast feel — tune together for natural deceleration
- `mass` × observed terminal velocity = collision energy = how hard this kart hits others
- **`drift_min_speed_ratio` sets ramp origin** — doubling it doubles the speed range where drift is partially suppressed. `speed_factor` reaches 1.0 at `2 × drift_min_speed_ratio × max_speed`

---

## Visual / Audio Requirements

| Event | Visual | Audio |
|-------|--------|-------|
| Driving | — | Engine hum, pitch scales with `fwd_speed` |
| Drift onset (`_drift_intensity` rising) | Graduated tire smoke scaled by `_drift_intensity` | Screech onset, volume scales with `_drift_intensity` |
| `_is_drifting = true` (intensity > 0.72) | Full tire smoke, tire marks on ground | Full tire screech |
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

Debug overlay (dev builds only): `_drift_intensity` float bar, `_drift_intensity_target` float bar, `side_speed`, `fwd_speed`, `_is_drifting` bool, `speed_factor`. Essential for tuning — target vs actual intensity gap reveals rate feel.

---

## Acceptance Criteria

### Functional Tests (automated — headless)

- [ ] Kart accelerates to ~90% terminal velocity within 2.0s from rest
- [ ] Terminal velocity is emergent — `fwd_speed` stabilizes without a hard clamp
- [ ] Braking from 20 m/s stops kart within 0.6s
- [ ] Coasting from 20 m/s: `fwd_speed` drops to <5 m/s within 2.0s (k_rolling effect)
- [ ] Steering rate at v=0 uses `stationary_steer_scale` (0.4), not zero
- [ ] **Full steer entry (`|steer|=1.0`, `v > 2×drift_min_speed`): `_drift_intensity` reaches ≥ 0.95 within 0.25–0.35s**
- [ ] **Half steer (`|steer|=0.5`, `speed_factor=1.0`): `intensity_target` ≈ 0.125 (= `pow(0.5, 3.0)`); `_drift_intensity` settles at ~0.125 within 0.05s**
- [ ] **`_drift_intensity` falls to ≤ 0.05 within 0.30–0.40s after steer drops to 0.0**
- [ ] **`_grip`, `yaw_mult`, `drag_mult`, `rolling_mult` all change as continuous functions of `_drift_intensity` — no single-frame step visible in frame-by-frame debug log**
- [ ] **`_is_drifting = true` when `_drift_intensity > 0.72`, `false` when `< 0.68`; no state change while intensity oscillates within [0.68, 0.72]**
- [ ] **VFX smoke does not flicker: `_is_drifting` stays true when intensity oscillates within ±0.02 of `drift_active_threshold`**
- [ ] Reverse drift blocked: `fwd_speed <= 0` → `speed_factor = 0` → `intensity_target = 0` → `_drift_intensity` stays 0
- [ ] **Lateral ramp: `side_speed` does not spike >5 m/s in a single frame during drift entry (60fps)**
- [ ] **Steer input flip A↔D through zero: `_drift_intensity` does not spike or jump; intensity decays then rises smoothly; `_steer_sign` holds last known direction during |steer|<0.05 crossing**
- [ ] Speed factor: `speed_factor = 0.0` at `fwd_speed = drift_min_speed`; `speed_factor = 1.0` at `fwd_speed = 2 × drift_min_speed`
- [ ] `drift_steer_exponent=3.0`: `intensity_target` at `|steer|=0.5` ≈ 0.125, at `|steer|=0.7` ≈ 0.343, at `|steer|=1.0` = 1.0 (all at speed_factor=1.0)
- [ ] Lateral ramp fires on steer increase mid-drift (target rising) but NOT during steady-state hold
- [ ] Speed reduction continuous: at intensity=0.5, effective `k_drag` ≈ `k_drag * 1.4`
- [ ] Kart-to-kart collision: heavier/faster kart pushes lighter/slower
- [ ] Collision push force clamped between `bump_min_force` and `bump_max_force`
- [ ] Slope: kart accelerates downhill, decelerates uphill
- [ ] KartPhysicsResource swap changes all physics behavior (no hardcoded values)
- [ ] **DEAD state: `steer_input` = 0, `intensity_target = 0`, `_drift_intensity` decays to 0 without special-case code**
- [ ] Remote karts do not run physics (only interpolation)
- [ ] deprecated `grip_loss_rate = 0.0`: intensity-based grip path used (verify no `move_toward` grip calls)

### Network Tests (automated)

- [ ] Position sync at 30 Hz includes `velocity` for interpolation
- [ ] Remote kart positions are smooth (snapshot buffer, no jitter)
- [ ] Server teleport check uses `max_speed` reference value from KartPhysicsResource
- [ ] `_drift_intensity` transmitted at 30 Hz for VFX sync on remote clients

### Playtest Criteria (human) — CRITICAL for this system

- [ ] **NO jerk/punch sensation on drift entry — kart "leans into" the drift over ~0.2–0.5s**
- [ ] **NO snap-forward sensation on drift exit — kart settles back over ~0.3–0.5s**
- [ ] **Light steer produces light drift feel — half steer does not produce full drift (continuous response)**
- [ ] **Full steer produces full drift with satisfying rear swing and tight arc**
- [ ] Drift onset perceptibly gradual — visible body lean builds proportionally with steer pressure
- [ ] Mid-drift kart feels heavy and committed — tighter arc, perceptible speed cost
- [ ] Drift exit tail: kart slides ~0.3–0.5s after releasing steer
- [ ] Rear swing visible on drift entry — kick arrives over first ~0.3s, not instant
- [ ] Counter-steering during drift feels responsive and controllable
- [ ] Steer flip A↔D feels smooth — no body mesh snap at zero-crossing
- [ ] `visual_drift_angle` never snaps >20° in a single frame
- [ ] After player dies in drift, kart visually settles without snap or freeze artifact
- [ ] Overall: "the drift responds to how hard I'm steering, not just whether I crossed a threshold"

---

## Open Questions

1. **[OPEN — deferred to post-MVP] Air control**: User intuition: "no steering in air". Current: 0.15s lockout on landing. Final rule depends on map design (ramp gameplay). TBD post-MVP.
