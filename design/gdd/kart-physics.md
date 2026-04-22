---
status: active
version: "2.4"
date: 2026-04-22
last-updated: 2026-04-22
---

# Kart Physics System

> **Status**: Active (v2.4 — emergent slip-angle intensity replacing input-driven pow curve)
> **Author**: Dima + game-designer + systems-designer + godot-specialist + technical-director
> **Last Updated**: 2026-04-22 (v2.4: slip_angle measurement via atan2; framerate-independent exp decay; smoothstep intent aid)
> **Previous version archives**: `design/gdd/kart-physics-v2.3-archive.md`, `design/gdd/kart-physics-v2.2-archive.md`, `design/gdd/kart-physics-v2.1-archive.md`
> **Implements Pillar**: Аркадный хаос (arcade feel, не симулятор) + Вариативность (kart classes via physics)
> **Reference feel**: SmashKarts.io — "heavy + very drifty + very predictable"

---

## Changes from v2.3

### Core model shift: Input-driven → Emergent slip-angle

v2.3 derived `intensity_target` from `steer_input` via a power curve. The kart drifted because you *told* it to. v2.4 measures actual physics: the angle between the kart's heading and its velocity vector. Drift intensity is now a *consequence* of real lateral movement, not a function of button pressure.

**What changes**:
- `intensity_target` computed from measured `slip_angle` via `atan2(|side_speed|, max(|fwd_speed|, 0.5))`, not from `pow(|steer|, exponent)`
- `_drift_intensity` smoothed toward `slip_ratio` with `SLIP_SMOOTHING` (exponential lerp), replacing `move_toward` enter/exit rate pair
- Side speed damping changes from `move_toward(side_speed, 0, _grip * delta)` to **framerate-independent exponential decay**: `side_speed *= exp(-_grip * delta)` — preserves lateral inertia shape, stable at any fps
- **Slip angle measurement happens BEFORE `move_and_slide()`** — wall collision slide must not feed back into intensity (avoids false drift spikes on wall contact)
- **Smoothstep intent aid**: `intent_scale = smoothstep(intent_threshold, 1.0, |steer|)` — continuous curve, no binary threshold behavior
- New `DRIFT_MIN_SPEED` hard gate (m/s, absolute, not ratio) replaces `drift_min_speed_ratio`-based `speed_factor` ramp

**What is removed** (v2.3 variables no longer exist):
- `DRIFT_STEER_EXPONENT` — power curve exponent for input-driven target
- `DRIFT_INTENSITY_ENTER_RATE` — move_toward rate while climbing
- `DRIFT_INTENSITY_EXIT_RATE` — move_toward rate while falling
- `DRIFT_LATERAL_RAMP` — lateral ramp kick tied to target rise
- `_drift_intensity_target` — per-frame computed input target
- `_drift_intensity_prev_target` — previous frame target for ramp condition
- `_steer_sign` — steer sign preservation for ramp/lean direction
- `drift_min_speed_ratio` — speed_factor ramp fraction
- `speed_factor` computed variable

**What is added** (v2.4 variables):
- `DRIFT_MAX_SLIP_ANGLE_DEG` — slip angle (°) at which `slip_ratio` = 1.0
- `DRIFT_MIN_SPEED` — hard gate in m/s; below this `_drift_intensity` decays to 0
- `DRIFT_INTENT_MULTIPLIER` — fractional extra yaw when player steers at speed (arcade aid)
- `DRIFT_INTENT_THRESHOLD` — `|steer_input|` at which smoothstep begins ramping intent aid
- `SLIP_SMOOTHING` — rate for `_drift_intensity` exponential tracking toward `slip_ratio`
- `GRIP_SLIP_EXPONENT` — optional exponent on grip lerp curve (default 2.0)

**What stays from v2.3** (unchanged):
- Force-based inertia (thrust + k_drag·v² + k_rolling·v + brake)
- Velocity decomposition: `rotate_y` → re-project fwd/side → apply thrust → apply grip
- Floor-align yaw-lock (pitch/roll only, yaw frozen post-slerp)
- Visual lean (`_visual_drift_angle` scaled by `_drift_intensity`)
- Stationary steering hack (stationary_steer_scale below threshold speed)
- Split low/high speed steer multipliers
- KartState gating (DEAD/IDLE = no input)
- Network sync pattern (30 Hz)
- Kart-to-kart collision energy model
- `_is_drifting` mini-hysteresis (±0.02 band around `drift_active_threshold`)
- Derived `_grip = lerp(high_grip_target, low_grip_target, pow(_drift_intensity, GRIP_SLIP_EXPONENT))`
- `drift_yaw_multiplier` lerp on yaw rate
- `drift_drag_multiplier` and `drift_rolling_multiplier` lerp on active k_drag/k_rolling
- deprecated `grip_loss_rate` / `grip_recovery_rate` rollback path (still 0.0 = disabled)

---

## Overview

Kart Physics — система движения, дрифта, коллизий и взаимодействия с рельефом.
CharacterBody3D + move_and_slide() с аркадной моделью физики. Все параметры
вынесены в KartPhysicsResource (.tres) — смена класса машины = смена ресурса.

**Reference feel**: SmashKarts.io — машина ощущается тяжёлой (momentum visible),
зад живёт своей жизнью (активный дрифт), но игрок полностью контролирует после практики.
Это НЕ "сдержанная" машина — это "яркая, но предсказуемая".

v2.4 переходит на emergent модель: дрифт — это физическое следствие реального бокового скольжения
(измеренный `slip_angle`), а не функция кнопки руля. Аркадный отклик сохраняется через
smoothstep intent aid и framerate-independent экспоненциальный side damping — игрок
чувствует контроль, но не диктует физике когда дрифтить.

---

## Player Fantasy

"Машина тяжёлая — у неё есть масса и инерция. Когда я ухожу в поворот, зад начинает тянуть — не потому что я нажал кнопку дрифта, а потому что машина *скользит*. Чем сильнее ухожу, тем больше занос. Опытный игрок знает как войти, держать дугу, и выйти. Новичок — учится. Но при этом машина предсказуема: она не делает ничего неожиданного. Тяжёлая. Дрифтовая. Предсказуемая."

---

## Detailed Design

### Core Rules

1. Physics runs at 60 Hz (`_physics_process`), network sync at 30 Hz
2. Local kart: full physics simulation. Remote karts: snapshot buffer interpolation (Network Layer GDD)
3. All physics params from KartPhysicsResource (`@export`). No hardcoded values
4. State Machine gates physics: DEAD = no input, IDLE = frozen
5. Velocity decomposed into forward (`-basis.z`) and lateral (`basis.x`) components each frame after `rotate_y()`
6. Gravity = 35.0 m/s² (3.57× Earth — arcade feel)
7. `move_and_slide()` handles floor/wall collision. **Slip angle is measured BEFORE `move_and_slide()`** — post-slide velocity contains wall-slide components that would falsely spike intensity on wall contact
8. Kart-to-kart collision: momentum/energy transfer
9. `max_speed` is a tunable reference value, not a physics hard clamp. Terminal velocity is emergent. Camera and network use `max_speed` for normalization
10. **`_drift_intensity: float [0..1]` is the physics master.** Derived from measured `slip_angle`, smoothed exponentially by `SLIP_SMOOTHING`. `_is_drifting: bool` is derived (mini-hysteresis, VFX/audio only)
11. **Drift is emergent**: `_drift_intensity` reflects how much the kart is actually sliding, not how hard the player is steering. Steer input produces yaw → velocity vector lags behind heading → slip_angle grows → intensity grows
12. **Smoothstep intent aid** preserves arcade agency: at `|steer| > DRIFT_INTENT_THRESHOLD`, a continuous extra yaw fraction (`DRIFT_INTENT_MULTIPLIER`) is added, scaled by `smoothstep(intent_threshold, 1.0, |steer|)`. No binary threshold — smooth ramp-on
13. **Framerate-independent side damping**: `side_speed *= exp(-_grip * delta)` — exponential decay. At `_grip=29, delta=1/60`: retain ~62% per frame. At `_grip=1, delta=1/60`: retain ~98.3% per frame. Behavior is identical at 30fps and 60fps within floating-point tolerance
14. **`DRIFT_MIN_SPEED` hard gate**: below this speed (m/s), `_drift_intensity` decays toward 0 regardless of slip_angle. Prevents phantom drift from velocity decompose noise at near-zero speed
15. Reverse drift explicitly blocked: `fwd_speed <= 0` → intensity decays toward 0
16. All drift-dependent physics values are `lerp(base, drift_value, intensity)` — no step functions in physics layer
17. `GRIP_SLIP_EXPONENT` allows non-linear grip curve: exponent > 1.0 keeps grip high at low intensity and drops sharply at high intensity ("car grips normally, then suddenly lets go" — SmashKarts-like)
18. **Floor-align yaw-lock** (from v2.3): `basis.slerp(floor_normal_basis, ...)` only affects pitch/roll; yaw is saved and restored after slerp to prevent yaw feedback loop in circular drift

### KartPhysicsResource

```gdscript
class_name KartPhysicsResource
extends Resource

@export_group("Speed")
@export var accel_force: float = 22.0             # thrust (м/с²) — tuned to emergent ~27.5 m/s terminal
@export var k_drag: float = 0.04                  # quadratic drag
@export var k_rolling: float = 1.1                # linear rolling resistance
@export var brake_force: float = 40.0             # м/с² deceleration
@export var reverse_ratio: float = 0.5            # reverse thrust fraction
@export var max_speed: float = 27.5               # reference (camera/network normalization)

@export_group("Input Smoothing")
@export var steer_slew_rate_in: float = 2.0       # steer ramp-up rate (1/s)
@export var steer_slew_rate_out: float = 1.5      # steer return rate (1/s)
@export var throttle_slew_rate: float = 2.0       # throttle ramp rate (1/s)

@export_group("Steering")
@export var steering_speed: float = 2.6           # rad/s base yaw rate
@export var steer_low_speed_mult: float = 1.0     # multiplier at v=0
@export var steer_high_speed_mult: float = 0.95   # multiplier at v=max_speed
@export var steer_speed_threshold: float = 3.0
@export var stationary_steer_threshold: float = 2.0
@export var stationary_steer_scale: float = 0.2

@export_group("Drift (Emergent v2.4)")
@export var drift_min_speed: float = 3.0          # m/s hard gate — below this, intensity decays to 0
@export var drift_max_slip_angle_deg: float = 35.0  # slip_ratio = 1.0 at this angle
@export var slip_smoothing: float = 8.0           # exponential lerp rate: intensity toward slip_ratio (1/s)
@export var drift_intent_multiplier: float = 0.4  # extra yaw fraction at full steer (intent aid endpoint)
@export var drift_intent_threshold: float = 0.7   # |steer| at which smoothstep begins ramping intent aid
@export var grip_slip_exponent: float = 2.0       # exponent on grip lerp curve (1.0=linear, 2.0=grip holds then drops)
@export var low_grip_target: float = 1.0          # side exp decay rate at intensity=1.0 (SmashKarts-range compromise)
@export var high_grip_target: float = 29.0        # side exp decay rate at intensity=0.0
@export var drift_active_threshold: float = 0.55  # center of _is_drifting mini-hysteresis (±0.02)
@export var drift_yaw_multiplier: float = 1.8     # yaw_rate lerp endpoint at intensity=1.0
@export var visual_drift_max_deg: float = 34.0
@export var visual_lean_recovery_speed: float = 5.0

@export var drift_drag_multiplier: float = 2.6    # k_drag lerp endpoint at intensity=1.0
@export var drift_rolling_multiplier: float = 1.45

# [deprecated — kept for rollback]
@export var grip_loss_rate: float = 0.0
@export var grip_recovery_rate: float = 0.0

@export_group("Collision")
@export var mass: float = 1.0
@export var bump_min_force: float = 3.0
@export var bump_max_force: float = 12.0

@export_group("Terrain")
@export var gravity: float = 35.0
@export var slope_speed_influence: float = 8.0
@export var floor_snap_length: float = 0.3
@export var floor_align_speed: float = 8.0        # pitch/roll only — yaw frozen post-slerp

@export_group("Visuals")
@export var wheel_radius: float = 0.18
@export var vfx_smoke_speed_threshold: float = 0.5
```

### Movement Model

**Force-based acceleration** (identical to v2.3):

```
thrust   = throttle_input * accel_force
if throttle_input < 0: thrust *= reverse_ratio

active_k_drag    = k_drag    * lerp(1.0, drift_drag_multiplier,    _drift_intensity)
active_k_rolling = k_rolling * lerp(1.0, drift_rolling_multiplier, _drift_intensity)

drag    = -sign(fwd_speed) * active_k_drag * fwd_speed^2
rolling = -active_k_rolling * fwd_speed
brake   = -sign(fwd_speed) * brake_force   [only when braking opposes motion and |fwd_speed|>0.5]

fwd_speed += (thrust + drag + rolling + brake) * delta
```

**Terminal velocity** (emergent):
```
v_terminal(intensity) = sqrt(accel_force / (k_drag * lerp(1.0, drift_drag_multiplier, intensity)))
```

**Speed-dependent steering + smoothstep intent aid**:
```
speed_ratio = clamp(abs(fwd_speed) / max_speed, 0.0, 1.0)
steer_mult  = lerp(steer_low_speed_mult, steer_high_speed_mult, speed_ratio)

speed_scale = stationary_steer_scale  if abs(fwd_speed) < stationary_steer_threshold
              else speed_ratio

# Drift yaw boost (from measured intensity — emergent feedback)
yaw_mult = lerp(1.0, drift_yaw_multiplier, _drift_intensity)

# Smoothstep intent aid: continuous ramp from threshold to full steer
intent_aid = 0.0
if fwd_speed > drift_min_speed:
    intent_scale = smoothstep(drift_intent_threshold, 1.0, abs(steer_input))
    intent_aid   = drift_intent_multiplier * intent_scale * sign(steer_input)

effective_yaw_rate = steering_speed * steer_mult * (steer_input + intent_aid) * speed_scale * yaw_mult
rotate_y(effective_yaw_rate * delta)
```

**Velocity projection after rotation** (unchanged):
```
new_fwd  = -basis.z
new_side = basis.x
fwd_speed  = velocity.dot(new_fwd)
side_speed = velocity.dot(new_side)
```

### Drift Model (v2.4 — Emergent Slip-Angle)

**State variables**:
```gdscript
var _drift_intensity: float = 0.0    # physics master [0..1]
var _is_drifting: bool = false       # derived — mini-hysteresis, VFX/audio only
var _slip_angle_deg: float = 0.0     # debug/telemetry — measured slip angle
var _slip_ratio: float = 0.0         # debug/telemetry — normalized slip [0..1]
var _grip: float = high_grip_target  # derived each frame
var _visual_drift_angle: float = 0.0
```

**Step 1 — Slip angle measurement** (after velocity decompose from rotated basis, BEFORE `move_and_slide()`):
```
slip_angle_rad = atan2(abs(side_speed), max(abs(fwd_speed), 0.5))
_slip_angle_deg = rad_to_deg(slip_angle_rad)
_slip_ratio = clamp(_slip_angle_deg / drift_max_slip_angle_deg, 0.0, 1.0)
```

**Step 2 — Intensity update** (framerate-independent exponential tracking):
```
# Hard gate: below drift_min_speed or reverse, decay toward 0
var target_intensity: float
if fwd_speed < drift_min_speed or fwd_speed <= 0:
    target_intensity = 0.0
else:
    target_intensity = _slip_ratio

# Framerate-independent exponential smoothing:
var alpha = 1.0 - exp(-slip_smoothing * delta)
_drift_intensity = lerp(_drift_intensity, target_intensity, alpha)
_drift_intensity = clamp(_drift_intensity, 0.0, 1.0)
```

**Step 3 — Derived `_is_drifting`** (mini-hysteresis):
```
var hyst_high = drift_active_threshold + 0.02   # default: 0.57
var hyst_low  = drift_active_threshold - 0.02   # default: 0.53

if _is_drifting and _drift_intensity < hyst_low:
    _is_drifting = false
elif not _is_drifting and _drift_intensity > hyst_high:
    _is_drifting = true
```

**Step 4 — Derived `_grip`** (non-linear curve):
```
# Default (intensity-based):
if grip_loss_rate == 0.0 and grip_recovery_rate == 0.0:
    var curved_intensity = pow(_drift_intensity, grip_slip_exponent)
    _grip = lerp(high_grip_target, low_grip_target, curved_intensity)
else:
    # [deprecated rollback path]
    target_grip = low_grip_target if _is_drifting else high_grip_target
    grip_rate   = grip_loss_rate  if _is_drifting else grip_recovery_rate
    _grip = move_toward(_grip, target_grip, grip_rate * delta)
```

**Step 5 — Framerate-independent side speed damping**:
```
# Exponential decay — identical behavior at any fps
side_speed *= exp(-_grip * delta)

# Rebuild velocity from decomposed components:
velocity = new_fwd * fwd_speed + new_side * side_speed + Vector3.UP * vertical_speed
```

**Step 6** — `move_and_slide()` happens here. Wall collision may modify velocity but will not feed back into `_drift_intensity` until next frame's Step 1 (which operates on NEW fwd/side decompose after rotate_y applied for that frame).

**Step 7 — Visual lean** (direction from `side_speed` sign, emergent):
```
var lean_dir = sign(side_speed) if abs(side_speed) > 0.1 else 0.0
target_visual_angle = _drift_intensity * visual_drift_max_deg * lean_dir * -1.0
_visual_drift_angle = target_visual_angle
```

### Kart-to-Kart Collision

Unchanged from v2.1/v2.2/v2.3.

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

### Terrain — Slopes & Ramps

Unchanged from v2.1–v2.3. Key values: gravity=35.0 m/s², `slope_speed_influence`=8.0 m/s², `floor_snap_length`=0.3 m.

**Floor-align yaw-lock** (unchanged from v2.3):
```
saved_yaw = global_transform.basis.get_euler().y
new_basis = global_transform.basis.slerp(floor_normal_basis, floor_align_speed * delta)
euler = new_basis.get_euler()
euler.y = saved_yaw
global_transform.basis = Basis.from_euler(euler)
```

### Interactions with Other Systems

| System | Direction | Interface |
|--------|-----------|-----------|
| **State Machine** | ← reads | KartState gates input: DEAD = no physics, IDLE = frozen |
| **State Machine** | → triggers | `_drift_intensity`, `_is_drifting` feed VFX signals |
| **Network Layer** | → sends | Position/rotation/velocity at 30 Hz via `_rpc_sync` |
| **Network Layer** | ← receives | Remote karts: snapshot buffer, no local physics |
| **Health & Damage** | ← reads | Collision → contact damage (future: Spikes) |
| **Kart Classes** | ← reads | KartPhysicsResource swapped per class |
| **Camera System** | → feeds | `fwd_speed`, `side_speed`, `_drift_intensity` |
| **VFX System** | → feeds | `_drift_intensity: float` + `_is_drifting: bool` |
| **Audio System** | → feeds | `fwd_speed` → engine pitch; `_drift_intensity` → screech volume |
| **HUD** | → feeds | `fwd_speed` → speedometer |

---

## Formulas

### 1. Slip Angle Measurement

```
slip_angle_rad = atan2(abs(side_speed), max(abs(fwd_speed), 0.5))
slip_angle_deg = rad_to_deg(slip_angle_rad)
slip_ratio     = clamp(slip_angle_deg / drift_max_slip_angle_deg, 0.0, 1.0)
```

| Variable | Default | Range | Effect |
|---|---|---|---|
| `drift_max_slip_angle_deg` | 35.0° | 20–60° | Angle at which slip_ratio=1.0 (full drift) |

**Curve** (fwd_speed=20 m/s, varying side_speed):

| `side_speed` | `slip_angle_deg` | `slip_ratio` (at 35° max) |
|---|---|---|
| 0 m/s | 0.0° | 0.000 |
| 3 m/s | 8.5° | 0.243 |
| 7 m/s | 19.3° | 0.551 |
| 12 m/s | 31.0° | 0.886 |
| 15+ m/s | ≥35.0° | 1.000 |

**`atan2` minimum denominator** (`max(|fwd_speed|, 0.5)`): prevents division-by-near-zero when kart is nearly stationary. At `fwd_speed=0, side_speed=0` → `slip_angle=0` → no phantom drift.

**Critical positioning**: this measurement happens on `side_speed` computed from velocity decomposition AFTER `rotate_y()` but BEFORE `move_and_slide()`. Post-slide velocity includes wall-slide lateral components from collision response and must not be used.

---

### 2. Intensity Update (framerate-independent exponential lerp)

```
target_intensity = 0.0  if (fwd_speed < drift_min_speed or fwd_speed <= 0)
                       else slip_ratio

alpha = 1.0 - exp(-slip_smoothing * delta)
_drift_intensity = lerp(_drift_intensity, target_intensity, alpha)
_drift_intensity = clamp(_drift_intensity, 0.0, 1.0)
```

| Variable | Default | Range | Effect |
|---|---|---|---|
| `slip_smoothing` | 8.0 /s | 3–20 /s | How fast intensity tracks measured slip; higher = more instant response |
| `drift_min_speed` | 3.0 m/s | 1–8 m/s | Hard gate below which drift cannot activate |

**Half-life** (time for intensity to halve toward target): `t_½ = ln(2) / slip_smoothing ≈ 0.087s` at default 8.0. At `target=1.0` from 0: reaches ~0.5 in 87ms, ~0.86 in 240ms.

**Framerate independence**: `alpha = 1 - exp(-rate*delta)` is the correct framerate-independent lerp. At 60fps: `alpha = 1-exp(-8/60) ≈ 0.125`. At 30fps: `alpha = 1-exp(-8/30) ≈ 0.234`. Both sum to same cumulative progression over same elapsed time.

---

### 3. Derived `_is_drifting` (mini-hysteresis)

```
hyst_high = drift_active_threshold + 0.02   # default: 0.57
hyst_low  = drift_active_threshold - 0.02   # default: 0.53

if _is_drifting and _drift_intensity < hyst_low:   _is_drifting = false
if not _is_drifting and _drift_intensity > hyst_high: _is_drifting = true
```

| Variable | Default | Notes |
|---|---|---|
| `drift_active_threshold` | 0.55 | Center of band; `slip_ratio=0.55` corresponds to ~19° slip at 35° max |

---

### 4. Derived `_grip` (non-linear curve)

```
curved_intensity = pow(_drift_intensity, grip_slip_exponent)
_grip = lerp(high_grip_target, low_grip_target, curved_intensity)
```

| Variable | Default | Range | Effect |
|---|---|---|---|
| `grip_slip_exponent` | 2.0 | 1.0–4.0 | Curve shape: 1.0=linear, 2.0=grip stays high at low intensity, drops at high |
| `low_grip_target` | 1.0 | 0.5–3.0 | Exp decay rate at full drift (SmashKarts-range compromise: not "ice" 0.5, not "sticky" 2.5) |
| `high_grip_target` | 29.0 | 15–40 | Exp decay rate at no drift |

With `grip_slip_exponent=2.0` and defaults:

| `_drift_intensity` | `curved_intensity` | `_grip` |
|---|---|---|
| 0.0 | 0.00 | 29.0 |
| 0.3 | 0.09 | 26.5 |
| 0.5 | 0.25 | 22.0 |
| 0.7 | 0.49 | 15.3 |
| 0.85 | 0.72 | 9.1 |
| 1.0 | 1.00 | 1.0 |

**Why LOW_GRIP=1.0 (compromise)**: at 0.5 rear slides nearly unchecked (ice feel from v2.3). At 2.5 drift barely visible (sticky). 1.0 is starting point — tune empirically toward 0.7-0.8 (looser) or 1.4 (tighter) based on feel.

---

### 5. Framerate-Independent Side Speed Damping

```
side_speed *= exp(-_grip * delta)
```

**Why exp decay (not `*= 1 - grip*delta`)**: linear approximation diverges from true exponential at high delta. At delta=1/30 the linear form overshoots by ~2× the error of delta=1/60 — noticeable in slip tail between desktop 60fps and HTML5 30fps. Exponential form is framerate-independent: `exp(-grip*t)` gives same result for any time-slicing of `t`.

**Per-frame retention at various `_grip` (at 60fps, dt=1/60)**:

| `_grip` | `exp(-grip*dt)` | Half-life | Feel |
|---|---|---|---|
| 29.0 (intensity=0.0) | 0.617 | ~0.024s | Near-snap to grip |
| 22.0 (intensity=0.5, exp=2) | 0.694 | ~0.032s | Quick but not instant |
| 15.3 (intensity=0.7, exp=2) | 0.775 | ~0.045s | Controlled slide |
| 9.1 (intensity=0.85) | 0.860 | ~0.076s | Pronounced slide |
| 1.0 (intensity=1.0) | 0.983 | ~0.693s | Long drift tail |

**Example** — side_speed builds to 8 m/s at full drift (_grip=1.0): after 0.5s → `8 * exp(-1.0 * 0.5) ≈ 8 * 0.607 ≈ 4.85 m/s` still sliding.

---

### 6. Smoothstep Intent Aid

```
intent_aid = 0.0
if fwd_speed > drift_min_speed:
    intent_scale = smoothstep(drift_intent_threshold, 1.0, abs(steer_input))
    intent_aid   = drift_intent_multiplier * intent_scale * sign(steer_input)

effective_yaw_rate = steering_speed * steer_mult * (steer_input + intent_aid) * speed_scale * yaw_mult
```

| Variable | Default | Range | Effect |
|---|---|---|---|
| `drift_intent_multiplier` | 0.4 | 0.0–1.0 | Extra yaw as fraction of steer_input; 0.0 = pure emergent |
| `drift_intent_threshold` | 0.7 | 0.5–0.9 | Steer at which smoothstep begins; below = 0, at 1.0 = full |

**Smoothstep curve values** (`intent_scale` vs `|steer_input|`, threshold=0.7):

| `|steer|` | `smoothstep(0.7, 1.0, x)` | `intent_aid` (mult=0.4) |
|---|---|---|
| 0.7 | 0.00 | 0.00 |
| 0.75 | 0.07 | 0.03 |
| 0.8 | 0.26 | 0.10 |
| 0.85 | 0.50 | 0.20 |
| 0.9 | 0.74 | 0.30 |
| 0.95 | 0.93 | 0.37 |
| 1.0 | 1.00 | 0.40 |

**Why smoothstep (not binary threshold)**: binary `if |steer|>0.7` reintroduces threshold feel that v2.4 aims to remove. Smoothstep gives C1-continuous transition — aid gradually ramps over last 30% of steer range, no perceptible "snap".

---

### 7. Force-Based Acceleration

Identical to v2.3. See formula #6 in v2.3 archive.

```
thrust   = throttle_input * accel_force  (× reverse_ratio when negative)
active_k_drag    = k_drag    * lerp(1.0, drift_drag_multiplier,    _drift_intensity)
active_k_rolling = k_rolling * lerp(1.0, drift_rolling_multiplier, _drift_intensity)
drag    = -sign(fwd_speed) * active_k_drag * fwd_speed^2
rolling = -active_k_rolling * fwd_speed
fwd_speed += (thrust + drag + rolling + brake) * delta
```

---

### 8. Speed-Dependent Steering + Yaw Multiplier

```
yaw_mult = lerp(1.0, drift_yaw_multiplier, _drift_intensity)
effective_yaw_rate = steering_speed * steer_mult * (steer_input + intent_aid) * speed_scale * yaw_mult
```

| `_drift_intensity` | `yaw_mult` | effective yaw at v=27.5m/s, steer=1.0 (with full intent aid) |
|---|---|---|
| 0.0 | 1.00 | 2.6 * 0.95 * 1.4 * ~1.0 * 1.00 ≈ 3.46 rad/s |
| 0.5 | 1.40 | ≈ 4.84 rad/s |
| 1.0 | 1.80 | ≈ 6.22 rad/s |

---

### 9. Terminal Velocity

```
v_terminal(intensity) = sqrt(accel_force / (k_drag * lerp(1.0, drift_drag_multiplier, intensity)))
```

| `_drift_intensity` | effective k_drag | `v_terminal` (drag-only) | vs normal |
|---|---|---|---|
| 0.0 | 0.040 | 23.5 m/s | 100% |
| 0.5 | 0.072 | 17.5 m/s | 74% |
| 1.0 | 0.104 | 14.5 m/s | 62% |

Note: `k_rolling=1.1` has small effect compared to v2.3's 12.0. Terminal dominated by k_drag. Empirical tuning: run straight, measure peak, adjust k_drag or accel_force, update `max_speed` reference.

---

### 10. Collision Energy

Identical to v2.3.

```
energy = mass * speed
push_force = clamp(abs(energy_diff) * 0.5, bump_min_force, bump_max_force)
```

---

### 11. Floor-Align Yaw-Lock

Identical to v2.3.

```
saved_yaw = global_transform.basis.get_euler().y
new_basis = global_transform.basis.slerp(floor_normal_basis, floor_align_speed * delta)
euler = new_basis.get_euler()
euler.y = saved_yaw
global_transform.basis = Basis.from_euler(euler)
```

---

## Edge Cases

| Scenario | Resolution |
|---|---|
| Kart stationary, steer held | `fwd_speed < drift_min_speed` → `target_intensity = 0` → `_drift_intensity` decays to 0. `atan2` denominator clamped to 0.5 — no phantom slip_angle from near-zero velocity noise. |
| Speed drops below `drift_min_speed` mid-drift | `target_intensity = 0`. `_drift_intensity` decays via exp lerp at `slip_smoothing` rate. At smoothing=8: reaches ~0.0 in ~300ms. Slide tail felt as side_speed decays via exp damping (not forced to zero). |
| Kart enters drift naturally at moderate speed | Yaw builds side_speed → slip_angle grows → intensity grows → `_grip` drops → side_speed decays less → more slip_angle. Self-reinforcing loop. `drift_max_slip_angle_deg` caps slip_ratio at 1.0, preventing runaway. |
| Player steers opposite direction mid-drift (counter-steer) | Yaw toward center → `side_speed` starts decaying faster (heading realigns with velocity) → `slip_angle` drops → `slip_ratio` drops → `_drift_intensity` follows. Recovery feels physical and proportional. |
| Full steer + intent aid at speed | Smoothstep intent_aid → effective steer = 1.4 at `|steer|=1.0` → more yaw → side_speed builds faster → slip_angle grows to 35°+ → intensity reaches 1.0 within ~250ms. Drift initiated "on command" despite emergent model. |
| Reverse driving (`fwd_speed < 0`) | `target_intensity = 0`. Intent aid blocked (`fwd_speed <= drift_min_speed`). No drift in reverse. |
| Hard wall collision during drift | `move_and_slide` redirects velocity. On NEXT frame, velocity decomposes afresh from new `-basis.z / basis.x` → `side_speed` reflects new state → `slip_angle` recomputed. No false intensity spike because slip measured BEFORE wall slide in current frame. May spike briefly if player rotates along wall, but resolves within 1-2 frames. |
| Input jitter (steer oscillating near threshold) | Smoothstep `intent_aid` at `|steer|=0.7` evaluates to 0.0 with zero derivative — no binary flipping. Jitter around threshold produces zero jitter in yaw rate. Below threshold: pure emergent physics unaffected by steer magnitude. |
| DEAD state | `steer_input = 0`, `throttle_input = 0`. No yaw → no side_speed buildup. Existing `side_speed` decays via exp damping. `_drift_intensity` follows `slip_ratio` down naturally. No special-case code needed. |
| Circular drift (sustained steer, steady state) | At equilibrium: `side_speed` stable → `slip_angle` stable → `_drift_intensity` stable → `_grip` stable → exp damping = lateral speed produced by yaw. Floor-align yaw-lock prevents orientation oscillation (v2.3 fix retained). Stable from FIRST lap (no feedback loop unlike v2.3). |
| `_is_drifting` flicker near threshold | Band [0.53, 0.57] absorbs intensity oscillation. `_is_drifting` won't toggle unless intensity exits band cleanly. |
| `grip_slip_exponent` = 1.0 | Linear grip-vs-intensity (legacy behavior). Use for comparison testing. |
| HTML5 at 30fps vs desktop 60fps | `alpha = 1 - exp(-rate*delta)` and `exp(-_grip*delta)` are both framerate-independent. Drift tracking and side damping give identical behavior at any fps. Visual smoothness may differ (fewer frames), but feel does not. |
| Ramp/air state | **[OPEN — deferred to post-MVP]**: no drift intensity update while airborne. `_drift_intensity` holds last value. On landing, resumes tracking slip_ratio. Air control TBD. |

---

## Dependencies

### Upstream

| System | Dependency | Type |
|---|---|---|
| **State Machine** | KartState gates physics (DEAD = no input, IDLE = frozen) | Hard |
| **Network Layer** | Position/rotation/velocity sync at 30 Hz | Hard |

### Downstream

| System | What it needs | Interface |
|---|---|---|
| **Kart Classes** | KartPhysicsResource defines class identity | resource swap |
| **Weapon System** | Kart position/velocity for projectile spawn | `position`, `velocity`, `basis` |
| **Camera System** | Speed + intensity for FOV, lateral offset | `fwd_speed`, `side_speed`, `_drift_intensity` |
| **VFX System** | Graduated drift smoke | `_drift_intensity: float`, `_is_drifting: bool` |
| **Audio System** | Engine pitch, tire screech | `fwd_speed`, `_drift_intensity` |
| **HUD** | Speed display | `fwd_speed` |

### Interface Contract

```gdscript
var _drift_intensity: float       # physics master [0..1]
var _is_drifting: bool            # derived — mini-hysteresis, VFX/audio/network
var _slip_angle_deg: float        # debug/telemetry
var fwd_speed: float
var side_speed: float
var velocity: Vector3
```

---

## Tuning Knobs

| Knob | Default | Safe Range | Affects | Too Low | Too High |
|---|---|---|---|---|---|
| `accel_force` | 22.0 | 15–40 | Acceleration punch + terminal velocity | Sluggish | Twitchy, overshoots |
| `k_drag` | 0.04 | 0.02–0.15 | Top speed ceiling | Very high terminal | Very low terminal |
| `k_rolling` | 1.1 | 0.5–5.0 | Coast-stop feel | Rolls forever | Stops sticky |
| `brake_force` | 40.0 | 20–60 | Brake responsiveness | Can't stop | Jarring stop |
| `reverse_ratio` | 0.5 | 0.2–0.7 | Reverse speed cap | Barely reverses | Full-speed reverse |
| `steering_speed` | 2.6 | 1.5–3.5 rad/s | Turn tightness | Can't corner | Spins out |
| `steer_high_speed_mult` | 0.95 | 0.5–1.0 | High-speed handling | Impossible | No penalty |
| `stationary_steer_scale` | 0.2 | 0.1–0.6 | Rotation when stopped | Barely rotates | Instant spin |
| **`drift_max_slip_angle_deg`** ★ | 35.0° | 20–55° | At what slip angle intensity reaches 1.0 | Intense drift from tiny slide | Need massive slide |
| **`slip_smoothing`** ★ | 8.0 /s | 3–20 /s | How fast intensity tracks slip_ratio | Intensity lags — mushy | Twitchy |
| **`drift_min_speed`** ★ | 3.0 m/s | 1–8 m/s | Hard gate for drift activation | Phantom drift at stop | Drift only high speed |
| **`drift_intent_multiplier`** ★ | 0.4 | 0.0–1.0 | Extra yaw at committed steer; 0.0 = pure emergent | Drift hard to initiate | Steer dominates (v2.3 feel) |
| **`drift_intent_threshold`** ★ | 0.7 | 0.5–0.9 | Steer where smoothstep begins | Aid at casual turn | Only extreme gets aid |
| **`grip_slip_exponent`** ★ | 2.0 | 1.0–4.0 | Grip curve shape | Drops too early | Stays near max until extreme |
| **`low_grip_target`** ★ | 1.0 | 0.5–3.0 | Slide at full intensity (compromise) | Unchecked slide (ice) | Barely drifts |
| `high_grip_target` | 29.0 | 15–40 | Snap-back at intensity=0 | Always sliding | No slide ever |
| `drift_active_threshold` | 0.55 | 0.3–0.8 | `_is_drifting` band center | Smoke at casual turns | VFX only at extreme |
| `drift_yaw_multiplier` | 1.8 | 1.2–2.5 | Extra rotation during drift | Drift arc same as normal | Spin-out |
| `drift_drag_multiplier` | 2.6 | 1.2–3.5 | Terminal velocity penalty in drift | No speed cost | Crawls in any turn |
| `drift_rolling_multiplier` | 1.45 | 1.0–2.0 | Low-speed scrubbing | No tactile scrubbing | Abrupt stop |
| `visual_drift_max_deg` | 34.0 | 20–50° | Body lean at intensity=1.0 | Unnoticeable | Body sideways |
| `mass` | 1.0 | 0.4–3.0 | Collision weight | Pushed easily | Immovable |
| `floor_align_speed` | 8.0 | 3–20 /s | Pitch/roll slope snap (yaw frozen) | Stays flat | Jittery pitch |
| `max_speed` (reference) | 27.5 | — | Camera + network normalization | — | — |

★ = new in v2.4

### Knob Interactions

- `accel_force` ÷ `k_drag` = terminal velocity squared — tune together
- `drift_max_slip_angle_deg` + `slip_smoothing`: angle sets sensitivity, smoothing sets responsiveness
- `drift_intent_multiplier` + `drift_max_slip_angle_deg`: higher intent aid compensates for high angle requirement
- `low_grip_target` + `drift_max_slip_angle_deg`: equilibrium between slip produced by yaw and slip damped by `_grip`. Lower `low_grip_target` → deeper drift naturally
- `grip_slip_exponent` changes inflection: at exp=2 grip stays near `high_grip_target` until ~70% intensity then drops sharply — "tipping point" SmashKarts-style
- `drift_yaw_multiplier` × `steering_speed` = effective yaw at full drift — drift circle tightness

---

## Visual / Audio Requirements

| Event | Visual | Audio |
|-------|--------|-------|
| Driving | — | Engine hum, pitch scales with `fwd_speed` |
| `_drift_intensity` rising | Graduated tire smoke scaled by intensity | Screech onset, volume scales |
| `_is_drifting = true` (>0.57) | Full tire smoke, tire marks | Full tire screech |
| Drift release | Smoke fades with intensity decay | Screech fades |
| High speed (>80% max_speed) | Speed lines, camera FOV widens | High-rev, wind noise |
| Collision | Spark VFX | Metal clang |
| Wall collision | Dust puff | Thud |
| Landing | Camera shake, dust puff | Thump |

---

## UI Requirements

Debug overlay (dev builds only): `_drift_intensity` float bar, `_slip_angle_deg` float, `_slip_ratio` float, `side_speed`, `fwd_speed`, `_is_drifting` bool, `intent_aid` value. Essential for v2.4 tuning: `slip_angle` reveals whether drift is coming from physics or driven by intent aid.

---

## Acceptance Criteria

### Functional Tests (automated — headless)

- [ ] Kart accelerates to ~90% emergent terminal velocity within 2.5s from rest
- [ ] Terminal velocity is emergent — `fwd_speed` stabilizes without hard clamp
- [ ] Braking from 27 m/s stops kart within 1.0s
- [ ] Coasting from 27 m/s: `fwd_speed` drops to <10 m/s within 2.5s
- [ ] `slip_angle_deg = 0` when `side_speed = 0` regardless of `fwd_speed`
- [ ] `atan2` minimum denominator: `slip_angle` stays 0 when stationary
- [ ] `slip_ratio = 0` when `fwd_speed < drift_min_speed`; `_drift_intensity` decays toward 0
- [ ] At `fwd_speed=20, side_speed=12`: `slip_angle_deg ≈ 31°`, `slip_ratio ≈ 0.886`
- [ ] `_drift_intensity` uses framerate-independent `1-exp(-rate*delta)` alpha
- [ ] Side damping uses `side_speed *= exp(-_grip*delta)` — not linear approximation
- [ ] **Slip measured from `side_speed` BEFORE `move_and_slide()`** — no false spike on wall collision
- [ ] `_is_drifting = true` when `_drift_intensity > 0.57`, `false` when `< 0.53`
- [ ] `grip_slip_exponent=2.0`: `_grip ≈ 22.0` at `_drift_intensity=0.5`
- [ ] Smoothstep intent aid: at `|steer|=0.7` → aid=0.0; at `|steer|=1.0` → aid=0.4; at `|steer|=0.85` → aid≈0.2
- [ ] Intent aid = 0 when `fwd_speed <= drift_min_speed`
- [ ] Reverse drift blocked: `fwd_speed <= 0` → `target_intensity = 0`
- [ ] DEAD state: `steer_input = 0` → no side_speed growth → intensity decays without special case
- [ ] `_drift_intensity` clamped [0, 1] at all times
- [ ] `drift_yaw_multiplier` lerp: yaw_rate continuous function of intensity
- [ ] `active_k_drag`, `active_k_rolling` continuous functions of intensity
- [ ] Kart-to-kart: heavier/faster pushes lighter/slower; force clamped to [bump_min, bump_max]
- [ ] KartPhysicsResource swap changes all behavior — no hardcoded values
- [ ] Floor-align yaw-lock: sustained circular steer — yaw stable ±0.5 rad/s over 3s
- [ ] Remote karts: no local physics, only interpolation
- [ ] Network sync includes `_drift_intensity` at 30 Hz

### Network Tests (automated)

- [ ] Position sync at 30 Hz includes `velocity` for interpolation
- [ ] Remote kart positions smooth (no jitter)
- [ ] `_drift_intensity` transmitted for remote VFX
- [ ] Server teleport check uses `max_speed` reference

### Playtest Criteria (human) — CRITICAL

- [ ] **Machine feels heavy: momentum visible when changing direction, no instant-snap**
- [ ] **Rear actively slides: at committed steer, rear clearly swings outward — not just tighter arc**
- [ ] **Drift is predictable: player can anticipate rear trajectory after 3–5 practice laps**
- [ ] Drift initiates within ~0.3s of committed full steer at speed
- [ ] **Circular drift stable from first full lap: holds arc without spiraling inward/outward**
- [ ] **Entry feels earned: casual turns don't drift, committed turns do — clear threshold in feel**
- [ ] Drift exit: side_speed decays over ~0.4–0.7s (visible tail)
- [ ] Counter-steering visibly corrects rear — controllable
- [ ] At low steer (casual): no drift, no VFX, slight body lean only
- [ ] At mid steer (~0.6): mild intensity build, slight smoke, controllable arc
- [ ] At full steer + speed: full drift, heavy smoke, tight arc, satisfying
- [ ] **"Heavy + drifty + predictable" — matches player first-session description**
- [ ] No jarring body-mesh snap during steer reversal (A→D or D→A)
- [ ] Drift VFX do not flicker when player holds steer near threshold
- [ ] Speed visibly decreases in tight drift (drag multiplier effect)
- [ ] After DEAD state, kart resumes physics cleanly without jump
- [ ] **Compare to v2.3: rear swing is more "physical" — builds from slide, not button press timing**
- [ ] **HTML5 export: feel identical to desktop (framerate-independent decay working)**
- [ ] **Raceline spiral at corner entry: first arc wider than subsequent, natural tightening as speed bleeds off**

---

## Open Questions

1. **[OPEN — deferred to post-MVP] Air control**: No drift intensity update while airborne. `_drift_intensity` holds last value on ramp launch, resumes on landing.
2. **[OPEN] LOW_GRIP tuning target**: Start at 1.0 (compromise). If rear doesn't swing enough → 0.7-0.8. If can't recover → 1.4-1.8.
3. **[OPEN] Intent aid necessity**: if pure emergent feel achieves goals without aid, set `drift_intent_multiplier=0.0`. Testing will determine.
