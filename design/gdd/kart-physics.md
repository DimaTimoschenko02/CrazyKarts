---
status: active
version: "3.0"
date: 2026-04-29
last-updated: 2026-04-29
---

# Kart Physics System

> **Status**: Active (v3.0 — two-axle bicycle model with saturating tire forces)
> **Author**: Dima + game-designer + systems-designer + godot-specialist + technical-director
> **Last Updated**: 2026-04-29 (v3.0: BicyclePhysics module, per-wheel lateral velocity, tanh tire model, omega-driven lean and VFX)
> **Previous version archives**: `design/gdd/kart-physics-v2.4-archive.md`, `design/gdd/kart-physics-v2.3-archive.md`, `design/gdd/kart-physics-v2.2-archive.md`, `design/gdd/kart-physics-v2.1-archive.md`
> **Implements Pillar**: Аркадный хаос (arcade feel, не симулятор) + Вариативность (kart classes via physics)
> **Reference feel**: SmashKarts.io — "heavy + drifty + two distinct wheel trails at different curvatures"

---

## Changes from v2.4

### Core model shift: Point-mass → Two-axle bicycle

v2.4 computed a single body-center lateral velocity and used `atan2(side_speed, fwd_speed)` as a slip proxy. The point-mass model cannot produce per-wheel velocities — left and right rear wheels always share the same lateral speed. This made it impossible to reproduce the visual observation from original SmashKarts where inner and outer rear wheels trace arcs of clearly different curvature.

v3.0 replaces the steer-rotate-then-decompose loop with a proper bicycle model. The kart has a front axle and a rear axle separated by `wheelbase`. Each rear wheel sits `half_track` offset from center. The body rotates at angular velocity `_omega` (rad/s). Per-wheel velocity = `body_velocity + _omega × wheel_position`, so left and right rear wheels see different lateral speeds whenever `_omega ≠ 0` — the outer wheel moves faster sideways than the inner wheel, producing the divergent arc effect.

**What changes**:
- Physics math extracted to `scripts/physics/bicycle_physics.gd` (pure `RefCounted`, no scene tree access)
- kart_controller becomes thin orchestrator: builds `PhysicsInput`, calls `BicyclePhysics.step()`, applies `PhysicsState`
- Yaw is now driven by torque accumulation → `_omega` (angular velocity, rad/s) → `rotate_y(_omega * delta)`, not by direct `rotate_y(steer_rate * delta)`
- Tire lateral forces computed via saturating `tanh` model: linear at small slip, saturates at ±F_max
- Per-wheel velocities: front center at `+half_wb`, rear-left at `(-half_wb, 0, -half_track)`, rear-right at `(-half_wb, 0, +half_track)`
- Drift intensity derived from the faster-sliding rear wheel's lateral speed (outer wheel during turn), normalized by `drift_max_slip_speed`
- Visual lean driven by `_omega`, not `sign(side_speed)` — leans into turns with centrifugal feel
- VFX smoke per-rear-wheel: left smoke triggers on `|rear_left_lat_speed| > threshold`, right independently

**What is removed** (v2.4 variables replaced):
- `steering_speed` as primary yaw driver — now `[deprecated v3.0]`; yaw is emergent from tire torques
- `stationary_steer_scale` — replaced by `stationary_omega_kick`
- `drift_max_slip_angle_deg` — replaced by `drift_max_slip_speed` (m/s instead of degrees)
- `drift_intent_multiplier` / `drift_intent_threshold` — smoothstep arcade yaw aid removed; standstill aid is separate
- `grip_slip_exponent`, `low_grip_target`, `high_grip_target` — grip is now emergent from tire saturation
- `drift_yaw_multiplier` — yaw boost is emergent from torque feedback

**What is added** (v3.0 variables):
- `wheelbase_override`, `track_width_override` — geometry (0 = auto-measure from wheel nodes)
- `max_steer_angle_deg` — front wheel lock angle at full steer (replaces `steering_speed`)
- `front_grip_stiffness`, `rear_grip_stiffness` — tire cornering stiffness per axle
- `tire_saturation_speed` — lateral speed (m/s) at which tire force saturates near F_max
- `inertia_scale` — moment-of-inertia multiplier (heavier feel without changing collision mass)
- `omega_damping` — angular velocity exp decay rate (1/s)
- `stationary_omega_kick` — direct `_omega` kick at near-zero speed for arcade steerability
- `drift_max_slip_speed` — rear lateral speed (m/s) that maps to `slip_ratio = 1.0`
- `omega_lean_scale` — omega (rad/s) at which visual lean reaches maximum

**What stays from v2.4** (active, unchanged semantics):
- `accel_force`, `k_drag`, `k_rolling`, `brake_force`, `reverse_ratio`, `max_speed` (longitudinal)
- `steer_slew_rate_in/out`, `throttle_slew_rate` (input smoothing)
- `drift_min_speed`, `slip_smoothing`, `drift_active_threshold` (drift signal shaping)
- `vfx_smoke_speed_threshold`, `drift_drag_multiplier`, `drift_rolling_multiplier` (still active)
- `cornering_drag_coeff` (v3.0 uses it at 0.5× internally — soft overlay, main drag is emergent)
- `visual_drift_max_deg`, `visual_lean_recovery_speed`
- `gravity`, `slope_speed_influence`, `floor_align_speed` (terrain, yaw-lock pattern preserved)
- `mass`, `bump_min`, `bump_max`, `wheel_radius`
- Kart-to-kart collision: server-only, energy model unchanged
- Network sync: position/rotation/velocity at 30 Hz, unchanged

---

## Overview

Kart Physics — система движения, дрифта, коллизий и взаимодействия с рельефом.
CharacterBody3D + move_and_slide() с аркадной физикой. Все параметры в KartPhysicsResource — смена класса машины = смена ресурса.

v3.0 вводит два ключевых прорыва:

**Two-axle bicycle model**: машина имеет переднюю и заднюю оси. Каждое заднее колесо
имеет свою lateral velocity = `body_velocity + _omega × wheel_position`. При повороте
внешнее колесо движется быстрее боком, чем внутреннее — отсюда два дымовых следа с разной кривизной (как в оригинальном SmashKarts).

**Saturating tire model**: сила поперечного сцепления растёт линейно при малом скольжении и насыщается на ±F_max при большом. Это создаёт "тяжёлую машину" ощущение: при умеренном повороте резина работает в линейной зоне (предсказуемо), при агрессивном — срывается в насыщение (дрифт).

**Reference feel** (Вариант Б — тяжёлая ощутимая машина): при повороте на скорости ощущается инерция корпуса, зад уходит в долгий slide, на полном газу с полным рулём — длинный хвост с двумя отдельными дымами.

---

## Player Fantasy

"Машина тяжёлая — у неё масса и угловая инерция, которые чувствуются. Когда я делаю резкий поворот, корпус продолжает двигаться по старой дуге ещё несколько метров — зад тянет наружу. Два дымовых следа от задних колёс идут по разным дугам: внешнее колесо скользит сильнее, внутреннее — меньше. Это не спецэффект — это реальная физика. Стоя на месте я могу подёргать рулём и почувствовать как машина реагирует. Управляемая, тяжёлая, дрифтовая."

---

## Detailed Design

### Core Rules

1. Physics runs at 60 Hz (`_physics_process`), network sync at 30 Hz
2. Local kart: full physics simulation via `BicyclePhysics.step()`. Remote karts: snapshot buffer interpolation (Network Layer GDD)
3. All physics params from KartPhysicsResource (`@export`). No hardcoded values in bicycle module
4. State Machine gates physics: `StateManager.can_move()` → if false, skip `_physics_process` body
5. `BicyclePhysics` is a pure `RefCounted` module — no scene tree, no nodes. kart_controller owns the scene body and feeds `PhysicsInput` each tick
6. Gravity = 35.0 m/s² (3.57× Earth — arcade feel). Handled by kart_controller before bicycle step (vertical only)
7. `move_and_slide()` handles floor/wall collision after bicycle step applies new velocity
8. **Slip is measured INSIDE `BicyclePhysics.step()`** before body velocity is updated — wall collision cannot feed back into drift intensity within the same tick
9. `max_speed` is a reference value, not a hard clamp. Terminal velocity is emergent
10. **`_drift_intensity: float [0..1]` is the physics master** — derived from the faster rear wheel's lateral speed, smoothed exponentially. `_is_drifting: bool` is derived (mini-hysteresis ±0.02, VFX/audio only)
11. **Yaw is emergent**: front tire lateral force at `+half_wb` and rear tire total at `-half_wb` create a net torque → `dω/dt = torque / MOI`. `_omega` integrates over time, exponentially damped. Direct `rotate_y` is gone from the steering loop
12. **Per-wheel VFX**: each rear wheel smoke fires independently based on its own lateral speed magnitude. This is the mechanism for divergent arc trails
13. **Visual lean driven by `_omega`**, not `sign(side_speed)`. Positive omega = CCW turn = lean rightward (centrifugal). Clamped by `omega_lean_scale` before multiplying by `visual_drift_max_deg`
14. **Standstill steering aid** (`stationary_omega_kick`) is active only below `stationary_steer_threshold` and blends out smoothly via `1 - smoothstep(0, threshold, |fwd_speed|)`. It never fights bicycle math at speed
15. **Floor-align yaw-lock** (preserved from v2.3): slerp to floor normal affects pitch/roll only; yaw saved before and restored after — prevents yaw feedback loop during long circular drifts
16. Kart-to-kart collision is server-only, energy-based, unchanged from v2.1+
17. **Reverse is natural**: negative `fwd_speed` → front slip angle flips sign → torque reverses → kart steers opposite way without any sign hack. `drift_min_speed` gate still prevents intensity in reverse

### Module Architecture

```
kart_controller.gd  (CharacterBody3D orchestrator)
  ├── PhysicsInput.new()     — input snapshot, rebuilt each tick
  ├── BicyclePhysics.new()   — physics module (RefCounted, pure math)
  │     └── step(PhysicsInput, delta) → PhysicsState
  └── PhysicsState           — output snapshot, applied to body
```

**PhysicsInput** (pure data, no nodes):
```gdscript
var velocity: Vector3    # current world velocity
var basis: Basis         # global_transform.basis at tick start
var throttle: float      # smoothed [-1..+1]
var steer_input: float   # smoothed [-1..+1]
var brake_held: bool     # S key held while moving forward
var on_floor: bool       # CharacterBody3D.is_on_floor()
```

**PhysicsState** (pure data output):
```gdscript
var new_velocity: Vector3          # replace XZ of body velocity
var yaw_delta: float               # radians to rotate_y this tick (= _omega * delta)
var omega: float                   # angular velocity (rad/s) — for lean + debug
var fwd_speed: float               # signed along -basis.z
var side_speed: float              # signed along basis.x (body center)
var rear_left_lat_speed: float     # left rear wheel lateral speed (signed)
var rear_right_lat_speed: float    # right rear wheel lateral speed (signed)
var slip_angle_front_deg: float    # front axle slip angle (debug)
var slip_angle_rear_deg: float     # rear axle slip angle (debug)
var drift_intensity: float         # smoothed [0..1] master
var is_drifting: bool              # hysteresis flag
var slip_ratio: float              # raw rear slip ratio before smoothing
var grip_debug: float              # representative grip for legacy overlays
```

### Persistent State in BicyclePhysics

These persist between ticks inside the `BicyclePhysics` instance:

```gdscript
var _params: KartPhysicsResource
var _wheelbase: float    # set by set_axle_geometry(), default 1.2 m
var _half_track: float   # half of track_width, default 0.45 m

var _omega: float = 0.0           # yaw angular velocity (rad/s)
var _drift_intensity: float = 0.0 # smoothed [0..1]
var _is_drifting: bool = false    # hysteresis flag
```

Reset on respawn and on entering DEAD state via `_bicycle.reset()`.

---

## Step-by-Step Physics Tick

The following describes `BicyclePhysics.step(inp, delta)` in execution order.

### A. Velocity Decomposition

```
fwd_dir  = -inp.basis.z
side_dir =  inp.basis.x
fwd_speed  = inp.velocity.dot(fwd_dir)
side_speed = inp.velocity.dot(side_dir)
```

Body velocity is decomposed into forward and lateral components in the current kart frame.

### B. Steer Angle

```
max_angle_rad = deg_to_rad(max_steer_angle_deg)
spd_ratio     = clamp(|fwd_speed| / max_speed, 0, 1)
steer_mult    = lerp(steer_low_speed_mult, steer_high_speed_mult, spd_ratio)
steer_angle   = steer_input * max_angle_rad * steer_mult
```

Front wheels turn by `steer_angle` radians. Speed-dependent reduction mirrors real vehicle behavior: full lock at standstill, narrower lock at speed.

### C. Per-Axle / Per-Wheel Lateral Velocities

```
half_wb = _wheelbase * 0.5

v_lat_front_center = side_speed + _omega * half_wb
v_lat_rear_center  = side_speed - _omega * half_wb
v_lat_rear_l       = v_lat_rear_center - _omega * _half_track
v_lat_rear_r       = v_lat_rear_center + _omega * _half_track
```

This is the core bicycle identity: velocity at any point on the body = `v_body + ω × r`. Front axle at `+half_wb`, rear at `-half_wb`. Left/right rear offset by `±half_track`.

When `_omega ≠ 0`, `v_lat_rear_l ≠ v_lat_rear_r` — the outer wheel slides faster. This is what produces divergent arc trails.

### D. Slip Angles

```
fwd_clamp   = max(|fwd_speed|, 0.5)            # prevent divide-by-zero at standstill
alpha_front = steer_angle - atan2(v_lat_front_center, fwd_clamp)
alpha_rear  = -atan2(v_lat_rear_center, fwd_clamp)
```

Slip angle = difference between wheel heading and direction of travel. Front wheel "points" at `steer_angle`; rear wheel points at 0 (fixed). Denominator clamped to 0.5 m/s.

**Physical meaning**: positive `alpha_front` means front is pointing inward relative to travel — generates a restoring force. If rear slip angle builds, it generates a turning torque that amplifies omega.

### E. Saturating Tire Lateral Forces

```
sat = max(tire_saturation_speed, 0.1)

front_signal = alpha_front * fwd_clamp
f_front  = -front_grip_stiffness * tanh(front_signal / sat) * sat
f_rear_l = -rear_grip_stiffness  * tanh(v_lat_rear_l / sat) * sat
f_rear_r = -rear_grip_stiffness  * tanh(v_lat_rear_r / sat) * sat
f_rear_total = f_rear_l + f_rear_r
```

**tanh saturation**: at small signal → `tanh(x) ≈ x` → `F ≈ -grip * v_lat` (linear, high traction). At large signal → `tanh(x) → ±1` → `F → ±grip * sat` (saturated, tire breaking away). The crossover point is `tire_saturation_speed` (m/s of lateral speed).

Lower `rear_grip_stiffness` relative to `front_grip_stiffness` → rear saturates and breaks away before front → natural oversteer (kart-style drift).

### F. Yaw Torque Integration

```
torque = f_front * half_wb - f_rear_total * half_wb
moi    = mass * (half_wb^2) * inertia_scale
omega_accel = torque / moi
_omega += omega_accel * delta

# Angular damping (framerate-independent):
_omega *= exp(-omega_damping * delta)
```

MOI is simplified (point-mass at half_wb from center). `inertia_scale` multiplies it to make the car feel heavier or lighter without changing collision mass. `omega_damping` is the exp decay rate — it prevents `_omega` from growing unbounded in sustained turns.

### G. Standstill Steering Aid

```
if inp.on_floor and |fwd_speed| < stationary_steer_threshold:
    blend = 1.0 - smoothstep(0.0, stationary_steer_threshold, |fwd_speed|)
    kick  = steer_input * stationary_omega_kick * blend
    _omega += kick * delta
```

At near-zero speed the bicycle model produces near-zero forces (no tire slip). This direct omega kick lets the player rotate while stationary, blending out smoothly as speed builds so it never interferes with bicycle math in motion.

### H. Apply Lateral Tire Forces to Body Velocity

```
f_total_lat = f_front + f_rear_total
side_speed += (f_total_lat / mass) * delta
```

Total lateral force divided by mass gives lateral acceleration. This is the channel through which tire physics changes body velocity — not a separate grip damper.

### I. Longitudinal Forces

```
thrust = throttle > 0.01 ? throttle * accel_force
       : throttle < -0.01 ? throttle * accel_force * reverse_ratio
       : 0

drag_mult    = lerp(1.0, drift_drag_multiplier,    _drift_intensity)
rolling_mult = lerp(1.0, drift_rolling_multiplier, _drift_intensity)
drag    = -sign(fwd_speed) * k_drag * drag_mult * fwd_speed^2
rolling = -k_rolling * rolling_mult * fwd_speed
cornering_drag = -sign(fwd_speed) * cornering_drag_coeff * |side_speed| * 0.5
                 [only if |fwd_speed| >= 0.1 and cornering_drag_coeff > 0]
brake   = -brake_force   [only if brake_held and fwd_speed > 0.5]

fwd_speed += (thrust + drag + rolling + cornering_drag + brake) * delta
if |thrust| < 0.01 and |fwd_speed| < 0.1: fwd_speed = 0.0   # snap to stop
```

`cornering_drag_coeff` is multiplied by 0.5 internally vs v2.4 — the main lateral drag is now emergent through tire forces (H), so the overlay is halved to avoid double-counting.

### J. Drift Intensity

```
rear_slip_mag = max(|v_lat_rear_l|, |v_lat_rear_r|)
slip_ratio    = clamp(rear_slip_mag / drift_max_slip_speed, 0, 1)

target_intensity = 0.0
if fwd_speed >= drift_min_speed:
    target_intensity = slip_ratio

alpha = 1.0 - exp(-slip_smoothing * delta)
_drift_intensity = lerp(_drift_intensity, target_intensity, alpha)
_drift_intensity = clamp(_drift_intensity, 0, 1)
```

Uses the **outer (faster-sliding) rear wheel** as the intensity signal. This means intensity reaches 1.0 when the hardest-working wheel hits `drift_max_slip_speed` m/s of lateral slip — even if the body center is barely moving sideways. More physically correct than v2.4's body-center slip angle.

### K. _is_drifting Hysteresis

```
hyst_high = drift_active_threshold + 0.02   # default: 0.57
hyst_low  = drift_active_threshold - 0.02   # default: 0.53

if _is_drifting and _drift_intensity < hyst_low:   _is_drifting = false
if not _is_drifting and _drift_intensity > hyst_high: _is_drifting = true
```

Discrete on/off for VFX/audio event triggers only. ±0.02 band prevents flicker.

### L. Pack Output State

```gdscript
out.new_velocity = fwd_dir * fwd_speed + side_dir * side_speed + Vector3(0, inp.velocity.y, 0)
out.yaw_delta    = _omega * delta
out.omega        = _omega
out.fwd_speed    = fwd_speed
out.side_speed   = side_speed
out.rear_left_lat_speed  = v_lat_rear_l
out.rear_right_lat_speed = v_lat_rear_r
out.slip_angle_front_deg = rad_to_deg(alpha_front)
out.slip_angle_rear_deg  = rad_to_deg(alpha_rear)
out.drift_intensity      = _drift_intensity
out.is_drifting          = _is_drifting
out.slip_ratio           = slip_ratio
```

### kart_controller application (after step)

```
rotate_y(state.yaw_delta)
velocity = Vector3(state.new_velocity.x, velocity.y, state.new_velocity.z)
move_and_slide()
_apply_slope_influence(delta)
_apply_floor_align(delta)         # yaw-lock preserved
_apply_kart_collisions(state.fwd_speed)
_update_visual_lean(state, delta)
_update_wheel_visuals(state, delta)
_update_vfx()
```

---

## Formulas

### 1. Per-Wheel Lateral Velocity (Bicycle Identity)

```
v_lat_at_point = v_lat_body + _omega * r_longitudinal
```

Where `r_longitudinal` is the signed distance from the body center along the forward axis.

| Point | r_longitudinal | r_lateral | v_lat |
|---|---|---|---|
| Front center | +half_wb | 0 | `side_speed + _omega * half_wb` |
| Rear center | -half_wb | 0 | `side_speed - _omega * half_wb` |
| Rear left | -half_wb | -half_track | `side_speed - _omega * half_wb - _omega * half_track` |
| Rear right | -half_wb | +half_track | `side_speed - _omega * half_wb + _omega * half_track` |

**Example** at `_omega = 1.5 rad/s` (moderate left turn), `side_speed = 2 m/s`, `half_wb = 0.6 m`, `half_track = 0.45 m`:
- Rear-left: `2 - 1.5*0.6 - 1.5*0.45 = 2 - 0.9 - 0.675 = 0.425 m/s`
- Rear-right: `2 - 1.5*0.6 + 1.5*0.45 = 2 - 0.9 + 0.675 = 1.775 m/s`

Right rear (outer during left turn) slides 4.2× harder than left rear (inner). Both fire separate smoke. Right fires first/more intensely.

---

### 2. Saturating Tire Force (tanh model)

```
F = -grip_stiffness * tanh(v_lat / sat) * sat
```

Where `sat = tire_saturation_speed` (m/s).

**Linear region** (|v_lat| << sat): `tanh(x) ≈ x`, so `F ≈ -grip_stiffness * v_lat`. Effective grip = `grip_stiffness`.

**Saturated region** (|v_lat| >> sat): `tanh(x) → ±1`, so `F → ±grip_stiffness * sat`. Maximum force = `grip_stiffness * sat`.

| `v_lat / sat` | `tanh` | F/F_max |
|---|---|---|
| 0.0 | 0.00 | 0% (no force) |
| 0.5 | 0.46 | 46% (linear zone) |
| 1.0 | 0.76 | 76% (entering saturation) |
| 1.5 | 0.91 | 91% |
| 2.0 | 0.96 | 96% |
| 3.0 | 0.99 | 99% (effectively saturated) |

**Defaults** (`rear_grip_stiffness=7`, `tire_saturation_speed=4.5`):
- F_max_rear = `7 * 4.5 = 31.5` N (normalized by mass for m/s² effect)
- Rear enters saturation around `v_lat ≈ 4.5 m/s`
- Below that: predictable linear response

**Why front > rear stiffness** (14 vs 7): front tire resists lateral slide more strongly than rear. Rear breaks away first — kart oversteers into drift. If front were softer, kart would understeer (push wide). This ratio is the fundamental tuning knob for oversteer character.

---

### 3. Yaw Torque and Angular Inertia

```
torque = f_front * half_wb - f_rear_total * half_wb
       = (f_front - f_rear_total) * half_wb

moi = mass * half_wb^2 * inertia_scale
omega_accel = torque / moi
```

**Physical intuition**: front force at `+half_wb` arm generates CW torque (nose points into turn). Rear force at `-half_wb` arm generates CCW (stabilizing). If front overcomes rear, kart turns tighter.

**Angular damping** (exp, framerate-independent):
```
_omega *= exp(-omega_damping * delta)
```

Half-life of `_omega`: `t_½ = ln(2) / omega_damping ≈ 0.173s` at default 4.0/s.

| `omega_damping` | Half-life | Feel |
|---|---|---|
| 2.0 | 0.35s | Loose, slow to stabilize |
| 4.0 | 0.17s | Default — feels heavy but responsive |
| 8.0 | 0.087s | Tight, snaps back quickly |
| 15.0 | 0.046s | Very stiff, minimal rotation persistence |

---

### 4. Drift Intensity (per-wheel normalization)

```
rear_slip_mag = max(|v_lat_rear_l|, |v_lat_rear_r|)
slip_ratio    = clamp(rear_slip_mag / drift_max_slip_speed, 0, 1)

target_intensity = slip_ratio  if fwd_speed >= drift_min_speed
                 = 0.0          otherwise

alpha = 1 - exp(-slip_smoothing * delta)
_drift_intensity = lerp(_drift_intensity, target_intensity, alpha)
```

| rear_slip_mag | slip_ratio (at drift_max_slip_speed=8) |
|---|---|
| 0 m/s | 0.00 |
| 2 m/s | 0.25 |
| 4 m/s | 0.50 |
| 6 m/s | 0.75 |
| 8+ m/s | 1.00 |

**Example**: `_omega=2.0, side_speed=1.5, half_wb=0.6, half_track=0.45`:
- Rear-right (outer): `1.5 - 2*0.6 + 2*0.45 = 1.5 - 1.2 + 0.9 = 1.2 m/s`
- Rear-left (inner): `1.5 - 2*0.6 - 2*0.45 = 1.5 - 1.2 - 0.9 = -0.6 m/s` (slight reverse slide)
- `rear_slip_mag = max(1.2, 0.6) = 1.2 m/s` → `slip_ratio = 0.15` (mild intensity)

---

### 5. Visual Lean (omega-driven)

```
omega_norm  = clamp(_omega / omega_lean_scale, -1, 1)
lean_dir    = -omega_norm                   # positive omega = CCW = lean right
target_angle = drift_intensity * visual_drift_max_deg * lean_dir [in radians]

lean_alpha = 1 - exp(-visual_lean_recovery_speed * delta)
_visual_drift_angle = lerp(_visual_drift_angle, target_angle, lean_alpha)

$BaseCar.rotation.y = _base_car_rot_y + _visual_drift_angle
```

**Why omega (not side_speed sign)**: `sign(side_speed)` flips discretely (binary), creating micro-judder on direction reversal. Omega is a continuous, smoothed signal — the body was rotating, it gradually unwinds. Lean follows the actual turning momentum, not the instantaneous lateral direction.

At `_omega = omega_lean_scale` (default 3.0 rad/s), lean reaches full `visual_drift_max_deg`. At `_omega = 0`, lean decays back at `visual_lean_recovery_speed`.

---

### 6. Per-Wheel VFX (Independent Smoke)

```
threshold = vfx_smoke_speed_threshold   # default 0.5 m/s

smoke_l = on_floor and |rear_left_lat_speed|  > threshold
smoke_r = on_floor and |rear_right_lat_speed| > threshold

l_smoke.emitting = smoke_l
r_smoke.emitting = smoke_r
```

Each side fires independently. During a hard left turn at speed:
- Right rear (outer) has high lateral slip → right smoke on
- Left rear (inner) may be below threshold → left smoke off or dimmer

This asymmetry is what produces the visible "inner arc / outer arc" divergence from the original SmashKarts trail reference. If both smokes are always on/off together, the model reduces to a single-axle point-mass (v2.4 behavior).

---

### 7. Terminal Velocity and Force Balance

Unchanged formula from v2.4:
```
v_terminal(intensity) = sqrt(accel_force / (k_drag * lerp(1.0, drift_drag_multiplier, intensity)))
```

| `_drift_intensity` | effective k_drag | `v_terminal` | vs normal |
|---|---|---|---|
| 0.0 | 0.040 | 23.5 m/s | 100% |
| 0.5 | 0.072 | 17.5 m/s | 74% |
| 1.0 | 0.104 | 14.5 m/s | 62% |

---

### 8. Kart-to-Kart Collision (server-only, unchanged)

```
my_energy    = mass * |fwd_speed|
other_energy = other.get_kart_mass() * other.velocity.length()
energy_diff  = my_energy - other_energy
push_force   = clamp(|energy_diff| * 0.5, bump_min_force, bump_max_force)

if energy_diff > 0: other.velocity += push_dir * force
else:               velocity       += -push_dir * force
```

---

### 9. Floor-Align Yaw-Lock (unchanged from v2.3)

```
saved_yaw = global_transform.basis.get_euler().y
target_basis = Basis.looking_at(project_fwd_on_floor(fwd_dir, floor_normal), floor_normal)
new_basis = global_transform.basis.slerp(target_basis, floor_align_speed * delta).orthonormalized()
euler = new_basis.get_euler()
euler.y = saved_yaw
global_transform.basis = Basis.from_euler(euler).orthonormalized()
```

Prevents the yaw feedback loop in long circular drifts: slerp toward floor normal would silently rotate yaw → change fwd_dir decomposition → change tire slip angles → change torque → different _omega. Freezing yaw breaks the coupling.

---

## Edge Cases

| Scenario | Resolution |
|---|---|
| Kart stationary, steer held | `|fwd_speed| < drift_min_speed` → `target_intensity = 0` → `_drift_intensity` decays. Standstill aid (`stationary_omega_kick`) rotates kart via direct omega addition. Tire forces are near-zero (small slip angles at low speed). |
| Speed drops below `drift_min_speed` mid-drift | `target_intensity = 0`. `_drift_intensity` decays via exp lerp at `slip_smoothing` rate. `_omega` decays via `omega_damping`. Kart gradually straightens and stops sliding. |
| Hard wall collision | `move_and_slide` modifies velocity. Next tick, velocity is decomposed into new `fwd_speed/side_speed` from updated basis. `_omega` is unaffected — rotation state persists (physically correct). Drift intensity recalculates from new per-wheel speeds. |
| Reverse driving | `fwd_speed < 0` → `target_intensity = 0` (gate prevents drift intensity). Tire forces still act on velocity and omega (reverse steering works naturally — bicycle model handles it). No sign hack needed. |
| _omega builds too fast (spin-out) | `omega_damping` prevents unbounded growth. At high `_omega`, rear tire saturation limits the destabilizing torque to ±F_max. The system self-limits. Increase `omega_damping` or `rear_grip_stiffness` if spin-out occurs at moderate steer. |
| Both rear wheels have same lateral speed | Happens only when `_omega = 0` (going straight). `v_lat_rear_l = v_lat_rear_r = side_speed`. Both smokes fire/don't fire together — degenerate to v2.4-like single-axle behavior. As soon as turning, they diverge. |
| _is_drifting flicker near threshold | Band [0.53, 0.57] absorbs oscillation. Won't toggle unless intensity exits band cleanly. |
| DEAD state / respawn | `_bicycle.reset()` → `_omega = 0`, `_drift_intensity = 0`, `_is_drifting = false`. kart_controller also resets `_rear_l_lat_speed`, `_rear_r_lat_speed`, `_omega`, `_visual_drift_angle`. |
| HTML5 at 30fps vs desktop 60fps | All formulas use `delta` with `exp(-rate*delta)` pattern. Drift tracking, angular damping, visual lean — all framerate-independent. |
| Ramp / air state | `on_floor = false` → standstill aid skipped (step G). Tire forces still compute but wheel-ground contact is lost — no physical meaning. Drift intensity holds last value (fwd_speed gate may cause decay if speed drops). Air control TBD post-MVP. |
| Circular drift steady state | `_omega` stabilizes at equilibrium where `omega_accel * delta = _omega * (1 - exp(-omega_damping * delta))`. Intensity stabilizes. Floor-align yaw-lock prevents orientation drift. Stable from first lap. |

---

## Dependencies

### Upstream

| System | Dependency | Type |
|---|---|---|
| **State Machine** | `StateManager.can_move(player_id)` gates physics tick | Hard |
| **Network Layer** | Position/rotation/velocity sync at 30 Hz | Hard |

### Downstream

| System | What it needs | Interface |
|---|---|---|
| **Kart Classes** | KartPhysicsResource defines class identity | resource swap |
| **Weapon System** | Kart position/velocity for projectile spawn | `position`, `velocity`, `basis` |
| **Camera System** | Speed + intensity for FOV, lateral offset | `state.fwd_speed`, `_drift_intensity` |
| **VFX System** | Per-wheel smoke triggers | `_rear_l_lat_speed: float`, `_rear_r_lat_speed: float`, `_is_drifting: bool` |
| **Audio System** | Engine pitch, tire screech | `state.fwd_speed`, `_drift_intensity` |
| **HUD** | Speed display | `state.fwd_speed` |
| **Debug overlays** | All telemetry | `PhysicsState` fields, `_omega` |

### Interface Contract (kart_controller public fields)

```gdscript
var _drift_intensity: float     # physics master [0..1] — camera, VFX, audio
var _is_drifting: bool          # VFX/audio on-off trigger (hysteresis)
var _omega: float               # angular velocity — visual lean, debug
var _rear_l_lat_speed: float    # per-wheel lateral speed for L smoke
var _rear_r_lat_speed: float    # per-wheel lateral speed for R smoke
var _cached_side_speed: float   # average of rear wheel speeds — legacy debug
var velocity: Vector3           # CharacterBody3D.velocity (contract preserved)
```

Network sync (30 Hz): `position`, `rotation`, `velocity` — unchanged. `_drift_intensity` and `_omega` are NOT currently synced (see Network Considerations below).

---

## Parameters (KartPhysicsResource v3.0)

### Speed Group

| Field | dev_params key | Default | Unit | Short description |
|---|---|---|---|---|
| `accel_force` | ACCEL_FORCE | 22.0 | m/s² | How aggressively the kart accelerates |
| `k_drag` | K_DRAG | 0.04 | — | Air resistance at high speed; sets top speed ceiling |
| `k_rolling` | K_ROLLING | 1.1 | 1/s | Rolling resistance; how fast the kart coasts to a stop |
| `brake_force` | BRAKE_FORCE | 40.0 | m/s² | Extra deceleration when S is held against forward motion |
| `reverse_ratio` | REVERSE_RATIO | 0.5 | x | Reverse thrust as fraction of forward power |
| `max_speed` | MAX_SPEED | 27.5 | m/s | Reference for camera FOV and network normalization only — not a hard clamp |

**`accel_force`** — How energetic the acceleration feels. At 15 the kart feels sluggish and takes 4+ seconds to reach top speed. At 22 it's 2.5 seconds of lively acceleration. At 35 it lunges forward aggressively.

**`k_drag`** — Controls top speed. Lower value = higher top speed. `accel_force / k_drag` = terminal velocity squared, so tune these two together. At k_drag=0.04 and accel=22, emergent terminal is around 23-24 m/s.

**`k_rolling`** — How quickly the kart decelerates when you release throttle at low speed. At 0.5 it rolls a long time. At 2.0 it stops more crisply. Doesn't affect top speed much.

**`brake_force`** — Hard braking deceleration. At 20 the kart needs a bit of distance. At 40 it stops assertively within ~0.7 seconds from top speed. At 60 it's snappy and jarring.

### Input Smoothing Group

| Field | dev_params key | Default | Unit | Short description |
|---|---|---|---|---|
| `steer_slew_rate_in` | STEER_SLEW_IN | 2.0 | 1/s | How fast steer ramps up when pressing a key |
| `steer_slew_rate_out` | STEER_SLEW_OUT | 1.5 | 1/s | How fast steer returns to center on key release |
| `throttle_slew_rate` | THROTTLE_SLEW | 2.0 | 1/s | How fast throttle builds from 0 to full |
| `steer_visual_rate` | STEER_VISUAL_RATE | 18.0 | 1/s | How fast the front wheel mesh turns (cosmetic only) |

**`steer_slew_rate_in`** — Smooths keyboard steer from 0 to 1. At 1.0 it takes about 0.7 seconds to reach full steer — noticeably laggy. At 2.0 it's around 0.4 seconds, feels responsive. At 5.0 it's nearly instant — twitchy.

**`steer_slew_rate_out`** — Slightly slower than slew_in gives a natural "unwinding" feel when releasing the wheel. Match both at 3.0 for responsive input; set out lower (1.0-1.5) for a lazy return.

### Steering Group

| Field | dev_params key | Default | Unit | Short description |
|---|---|---|---|---|
| `steer_low_speed_mult` | STEER_LOW_MULT | 1.0 | x | Steer angle scale factor at very low speed |
| `steer_high_speed_mult` | STEER_HIGH_MULT | 0.95 | x | Steer angle scale factor at top speed |
| `stationary_steer_threshold` | STATIONARY_STEER_THRESHOLD | 2.0 | m/s | Speed below which standstill aid is active |

**`steer_low_speed_mult` / `steer_high_speed_mult`** — These scale the physical front wheel lock angle at different speeds. At default (1.0 / 0.95) there's minimal speed-dependent reduction — nearly the same lock at any speed. Decrease `steer_high_speed_mult` to 0.6-0.7 if the kart feels too twitchy at top speed.

### Bicycle v3.0 Group

| Field | dev_params key | Default | Unit | Short description |
|---|---|---|---|---|
| `wheelbase_override` | WHEELBASE_OVERRIDE | 0.0 | m | 0 = auto-measure from wheel nodes |
| `track_width_override` | TRACK_WIDTH_OVERRIDE | 0.0 | m | 0 = auto-measure from rear wheel nodes |
| `max_steer_angle_deg` | MAX_STEER_ANGLE_DEG | 32.0 | deg | Front wheel lock angle at full steer input |
| `front_grip_stiffness` | FRONT_GRIP | 14.0 | — | How strongly front tires resist lateral slide |
| `rear_grip_stiffness` | REAR_GRIP | 7.0 | — | How strongly rear tires resist lateral slide — lower = more drift |
| `tire_saturation_speed` | TIRE_SATURATION | 4.5 | m/s | Lateral speed where tire force stops growing |
| `inertia_scale` | INERTIA_SCALE | 1.2 | x | How heavy the rotation feels |
| `omega_damping` | OMEGA_DAMPING | 4.0 | 1/s | How quickly rotation decays when not actively turning |
| `stationary_omega_kick` | STATIONARY_OMEGA_KICK | 2.5 | rad/s² | How aggressively the kart rotates while stationary |
| `drift_max_slip_speed` | DRIFT_MAX_SLIP_SPEED | 8.0 | m/s | Rear wheel lateral speed that gives intensity=1.0 |
| `omega_lean_scale` | OMEGA_LEAN_SCALE | 3.0 | rad/s | Rotation rate that gives maximum visual body lean |

**`max_steer_angle_deg`** — How tightly the front wheels can turn. At 20° the kart has wide, gradual turns. At 32° default it can make tight arcs. At 45° it turns very sharply and may feel unstable. This is the primary knob for turn radius — affects how quickly you can build omega.

**`front_grip_stiffness`** — How strongly the front pushes the nose into a turn. At 8 front feels vague and slow to respond. At 14 it's assertive. At 20 the nose bites hard and can produce sudden snap oversteer. Should always be higher than rear_grip_stiffness.

**`rear_grip_stiffness`** — The single most important drift knob. At 3 the rear breaks away very easily — lots of drift, potentially uncontrollable. At 7 default the rear slides nicely in committed turns. At 12 the rear barely slides. **Ratio of front/rear stiffness determines oversteer character** — higher ratio = more aggressive drift tendency.

**`tire_saturation_speed`** — At which lateral speed the tire stops generating more force. At 2.0 the tire saturates very quickly — feels like ice, very little progression. At 4.5 you get a generous linear region before breakaway. At 8.0+ the tire almost never saturates — very grippy.

**`inertia_scale`** — Makes the rotation feel heavier or lighter without changing how much the kart gets pushed in collisions. At 0.8 the kart rotates easily and responsively. At 1.2 it feels weighty, like a real vehicle. At 2.0 it's very sluggish to turn and oversteer is dangerous.

**`omega_damping`** — How quickly angular velocity fades when you straighten the wheel. At 2.0 the kart continues rotating for a long time after releasing steer — loose, drifty feel. At 4.0 it calms down in about 0.2 seconds. At 10.0 it stops almost immediately — very stable but less dynamic.

**`stationary_omega_kick`** — How aggressively you can rotate while stationary. At 1.0 it barely moves. At 2.5 you can make a reasonable pivot turn. At 5.0 it spins noticeably. Blends to zero as speed builds, so it never interferes with normal driving.

**`drift_max_slip_speed`** — The rear wheel lateral speed at which drift intensity reaches 1.0 (maximum). At 4.0 intensity hits max quickly — smoke appears early, reactive feel. At 8.0 you need a proper hard slide to get full intensity. At 12.0 it takes a very aggressive maneuver to see heavy smoke.

**`omega_lean_scale`** — The rotation rate (rad/s) that produces maximum visual body lean. At 2.0, even moderate turns produce a pronounced lean. At 3.0 default only committed turns lean heavily. At 5.0 the car looks almost upright even in hard turns.

### Drift Signal Shaping Group

| Field | dev_params key | Default | Unit | Active? | Short description |
|---|---|---|---|---|---|
| `drift_min_speed` | DRIFT_MIN_SPEED | 3.0 | m/s | YES | Below this speed, drift intensity cannot build up |
| `slip_smoothing` | SLIP_SMOOTHING | 8.0 | 1/s | YES | How fast drift intensity tracks the actual slip |
| `drift_active_threshold` | DRIFT_ACTIVE_THRESHOLD | 0.55 | [0..1] | YES | Intensity level where smoke/screech triggers |
| `vfx_smoke_speed_threshold` | VFX_SMOKE_THRESHOLD | 0.5 | m/s | YES | Per-wheel lateral speed to trigger smoke |
| `drift_drag_multiplier` | DRIFT_DRAG_MULTIPLIER | 2.6 | x | YES | Speed penalty at full drift intensity |
| `drift_rolling_multiplier` | DRIFT_ROLLING_MULTIPLIER | 1.45 | x | YES | Low-speed rolling resistance at full intensity |
| `cornering_drag_coeff` | CORNERING_DRAG_COEFF | 0.3 | — | YES (×0.5) | Soft fwd-drag overlay during any cornering |
| `drift_max_slip_angle_deg` | DRIFT_MAX_SLIP_ANGLE_DEG | 35.0 | deg | deprecated v3.0 | Replaced by drift_max_slip_speed |
| `drift_intent_multiplier` | DRIFT_INTENT_MULTIPLIER | 0.4 | — | deprecated v3.0 | Arcade yaw aid removed in v3.0 |
| `drift_intent_threshold` | DRIFT_INTENT_THRESHOLD | 0.7 | — | deprecated v3.0 | Arcade yaw aid removed in v3.0 |
| `grip_slip_exponent` | GRIP_SLIP_EXPONENT | 2.0 | — | deprecated v3.0 | Grip is now emergent from tanh model |
| `low_grip_target` | LOW_GRIP | 1.0 | — | deprecated v3.0 | Replaced by tire_saturation_speed |
| `high_grip_target` | HIGH_GRIP | 29.0 | — | deprecated v3.0 | Replaced by front/rear_grip_stiffness |
| `drift_yaw_multiplier` | DRIFT_YAW_MULTIPLIER | 1.8 | x | deprecated v3.0 | Yaw now emergent from torque |

**`drift_min_speed`** — Hard minimum: below this speed (m/s) drift intensity immediately decays to zero no matter how much lateral slip there is. Prevents phantom drift smoke when the kart is nearly stopped. At 1.0 drift can appear at very slow speeds. At 5.0 you need to be moving briskly before any drift activates.

**`slip_smoothing`** — How quickly the drift intensity number catches up to the actual wheel slip. At 4.0 it's slower to react — intensity builds and falls gradually, mushy feel. At 8.0 it tracks slip closely. At 15.0 it's nearly instant — intensity mirrors wheel behavior frame-by-frame, reactive and precise.

**`drift_active_threshold`** — The intensity level (0-1) at which smoke and screech audio actually trigger. At 0.3 even casual turns produce smoke. At 0.55 default you need a real committed slide. At 0.75 smoke only appears in extreme situations.

**`vfx_smoke_speed_threshold`** — Each rear wheel fires smoke independently when its lateral speed exceeds this. At 0.2 both wheels smoke at the slightest turn. At 0.5 only meaningful slides trigger smoke. Asymmetric trails (one wheel smoking, not the other) become visible only when this is tuned to let the inner wheel sometimes fall below threshold.

**`drift_drag_multiplier`** — How much extra drag the kart experiences at full drift intensity. At 1.5 there's a small speed cost. At 2.6 the kart slows noticeably in a tight drift. At 4.0 the kart nearly stops in a sustained drift. Works through k_drag scaling — affects top speed in corners, not raw deceleration.

**`cornering_drag_coeff`** — Soft forward deceleration proportional to how much the rear is sliding sideways. Produces a "digging in" feel in corners at any intensity level (not just full drift). At 0.0 no extra cornering drag. At 0.3 there's a slight but noticeable slow-down. Note: v3.0 applies this at half the v2.4 value internally — the main drag is now emergent through tire forces.

### Visuals Group

| Field | dev_params key | Default | Unit | Short description |
|---|---|---|---|---|
| `visual_drift_max_deg` | VISUAL_DRIFT_MAX_DEG | 34.0 | deg | Max body lean angle at drift_intensity=1.0 and omega=omega_lean_scale |
| `visual_lean_recovery_speed` | VISUAL_LEAN_RECOVERY_SPEED | 5.0 | 1/s | How quickly lean smooths toward its target |
| `wheel_radius` | WHEEL_RADIUS | 0.18 | m | Wheel size for rolling animation |
| `omega_lean_scale` | OMEGA_LEAN_SCALE | 3.0 | rad/s | (see Bicycle group above) |

**`visual_drift_max_deg`** — Maximum visual body tilt at full drift and full turn. At 20° the lean is subtle. At 34° it's dramatic but believable. At 50° the kart looks like it's about to tip over.

**`visual_lean_recovery_speed`** — How smoothly the lean follows the current omega*intensity signal. At 2.0 the lean lags nicely behind the actual physics — satisfying camera-like feel. At 10.0 it snaps immediately. At 0.0 lean is instant with no smoothing.

### Collision Group

| Field | Default | Notes |
|---|---|---|
| `mass` | 1.0 | Relative collision weight. Heavy kart (2.0) pushes lighter (0.6) further. |
| `bump_min_force` | 3.0 | Minimum push on any collision |
| `bump_max_force` | 12.0 | Maximum push cap |

### Terrain Group

| Field | Default | Notes |
|---|---|---|
| `gravity` | 35.0 m/s² | 3.57× Earth — arcade feel. Applied by kart_controller, not bicycle module |
| `slope_speed_influence` | 8.0 m/s² | Extra speed bonus/penalty on slopes |
| `floor_snap_length` | 0.3 m | CharacterBody3D snap-to-floor distance |
| `floor_align_speed` | 8.0 1/s | Pitch/roll alignment to floor normal; yaw frozen post-slerp |

---

## Migration Notes (v2.4 → v3.0)

### What was replaced

| v2.4 mechanism | v3.0 replacement | Reason |
|---|---|---|
| `rotate_y(steer_rate * delta)` direct yaw | `_omega` via torque accumulation | Emergent rotation from tire forces |
| Single `side_speed` for whole body | Per-wheel velocities via bicycle identity | Divergent arc trails require per-wheel |
| `atan2(side_speed, fwd_speed)` slip proxy | Rear wheel lateral speed vs `drift_max_slip_speed` | More physically meaningful normalization |
| `_grip = lerp(high, low, pow(intensity, exp))` | Saturating `tanh` tire model | Continuous saturation, no separate grip state |
| `side_speed *= exp(-_grip * delta)` damping | Tire forces directly modify `side_speed` | Physics causality: forces cause velocity change |
| `smoothstep intent aid` on yaw | `stationary_omega_kick` (standstill only) | Removed input-to-yaw shortcut; yaw is fully emergent |
| `sign(side_speed)` for lean direction | `-omega_norm = -clamp(_omega / omega_lean_scale, -1, 1)` | Continuous, no discrete sign flip |
| Single smoke on `_is_drifting` | Per-wheel smoke on `|rear_l/r_lat_speed| > threshold` | Asymmetric trail divergence |

### Deprecated but preserved (JSON roundtrip stability)

These fields exist in KartPhysicsResource and are still hot-reloaded from dev_params.json, but **the bicycle physics module does not read them**. They are kept so:
1. dev_params.json files from v2.4 don't crash with unknown key errors
2. Rollback to v2.4 code would immediately use them again

`drift_max_slip_angle_deg`, `drift_intent_multiplier`, `drift_intent_threshold`, `grip_slip_exponent`, `low_grip_target`, `high_grip_target`, `drift_yaw_multiplier`, `grip_loss_rate`, `grip_recovery_rate`, `steering_speed`, `stationary_steer_scale`

### Preserved with identical semantics

These survive v3.0 completely unchanged in behavior: `accel_force`, `k_drag`, `k_rolling`, `brake_force`, `reverse_ratio`, `max_speed`, `steer_slew_rate_in/out`, `throttle_slew_rate`, `drift_min_speed`, `slip_smoothing`, `drift_active_threshold`, `vfx_smoke_speed_threshold`, `drift_drag_multiplier`, `drift_rolling_multiplier`, `cornering_drag_coeff` (×0.5 internal adjustment), `visual_drift_max_deg`, `visual_lean_recovery_speed`, `gravity`, `slope_speed_influence`, `floor_align_speed`, `mass`, `bump_min/max_force`, `wheel_radius`.

---

## Tuning Knobs

| Knob | Default | Safe Range | Affects | Too Low | Too High |
|---|---|---|---|---|---|
| `max_steer_angle_deg` | 32.0° | 15–50° | Turn radius at speed | Wide arcs only | Very tight / unstable |
| `front_grip_stiffness` | 14.0 | 6–25 | Front tire cornering force | Understeer, nose won't bite | Snap oversteer |
| `rear_grip_stiffness` | 7.0 | 2–15 | Rear breakaway threshold | Too easy to slide | Barely drifts |
| front/rear ratio | 2.0× | 1.5–4× | Oversteer character | Understeer | Uncontrollable oversteer |
| `tire_saturation_speed` | 4.5 m/s | 1.5–10 m/s | Progression before breakaway | Ice feel (no linear zone) | Always grippy (no saturation) |
| `inertia_scale` | 1.2 | 0.5–3.0 | Rotation feel (independent of collision) | Spins easily | Sluggish yaw |
| `omega_damping` | 4.0 | 1–15 | Rotation persistence | Loose/drifty rotation | Snaps back instantly |
| `stationary_omega_kick` | 2.5 | 0.5–6.0 | Pivoting while stopped | Barely rotates | Spins in place |
| `drift_max_slip_speed` | 8.0 m/s | 3–15 m/s | When intensity hits 1.0 | Smoke at light turns | Smoke only extreme |
| `omega_lean_scale` | 3.0 rad/s | 1–6 | Visual lean sensitivity | Leans even casually | Barely leans |
| `slip_smoothing` | 8.0 /s | 3–20 | Intensity tracking speed | Mushy, lags behind | Twitchy, instant |
| `drift_min_speed` | 3.0 m/s | 1–8 | Drift activation gate | Phantom drift when slow | Drift only at speed |
| `drift_active_threshold` | 0.55 | 0.3–0.8 | Smoke/screech onset | Smoke at casual turns | VFX only at extremes |
| `accel_force` | 22.0 | 15–40 | Acceleration punch | Sluggish | Twitchy, overshoots |
| `k_drag` | 0.04 | 0.02–0.15 | Top speed ceiling | Very high terminal | Very low terminal |
| `drift_drag_multiplier` | 2.6 | 1.2–4.0 | Speed cost in drift | No speed penalty | Crawls in turns |
| `cornering_drag_coeff` | 0.3 | 0–1.5 | Tire scrubbing overlay | No decel in light turns | Aggressive dig-in |
| `visual_drift_max_deg` | 34.0° | 15–50° | Body lean drama | Unnoticeable | Body sideways |
| `floor_align_speed` | 8.0 | 3–20 | Pitch/roll slope snap | Stays flat on slopes | Jittery pitch |
| `mass` | 1.0 | 0.4–3.0 | Collision weight | Gets pushed easily | Immovable |

### Knob Interactions

- `front_grip_stiffness / rear_grip_stiffness` ratio is the primary drift character knob — tune ratio first, then individual values
- `tire_saturation_speed` changes the feel of the linear→saturation transition: lower = earlier breakaway at same stiffness
- `inertia_scale` and `omega_damping` interact: high inertia + low damping = slow to spin up, slow to stop (boat-like). Low inertia + high damping = quick response, snappy.
- `drift_max_slip_speed` and `vfx_smoke_speed_threshold` should be tuned together: if threshold > drift_max_slip_speed/2, smoke can appear before intensity reaches 0.5
- `omega_lean_scale` × `visual_drift_max_deg` = max lean. Reduce omega_lean_scale if the lean looks extreme even in light turns
- `accel_force / k_drag` = terminal velocity squared — always tune together
- `wheelbase` (auto-measured from wheel nodes) affects MOI directly. Longer car = more angular inertia at same `inertia_scale`

### Tuning Recipes

**Want more pronounced divergent trail effect** (outer/inner wheel asymmetry):
1. Lower `vfx_smoke_speed_threshold` to 0.2–0.3
2. Increase `omega_lean_scale` to 2.0–2.5 (more rotation for same turn = more asymmetry)
3. Lower `drift_max_slip_speed` to 5.0 so intensity builds with less slip

**Want heavier, harder-to-spin feel** (Variant Б → heavier):
1. Increase `inertia_scale` to 1.5–2.0
2. Decrease `omega_damping` to 3.0 (more persistent rotation, harder to correct)
3. Decrease `rear_grip_stiffness` slightly (6.0) so rear breaks away even at higher inertia

**Want more arcade, less vehicle feel** (Variant Б → С: lighter):
1. Decrease `inertia_scale` to 0.8
2. Increase `omega_damping` to 6.0–8.0
3. Increase `stationary_omega_kick` to 4.0 (more responsive stationary turn)
4. Increase `front_grip_stiffness` relative to rear (more neutral handling, less natural oversteer)

**Drift initiates too suddenly / snap oversteer**:
1. Lower `front_grip_stiffness` slightly (toward 10–12)
2. Increase `tire_saturation_speed` (5–6 m/s) — wider linear zone before breakaway
3. Increase `inertia_scale` to slow omega buildup

**Drift doesn't happen enough / feels grippy**:
1. Lower `rear_grip_stiffness` (5–6)
2. Lower `tire_saturation_speed` (3–3.5 m/s) — earlier breakaway
3. Increase `max_steer_angle_deg` (36–40°) — more wheel angle → more front torque → more omega

---

## Visual / Audio Requirements

| Event | Visual | Audio |
|-------|--------|-------|
| Driving | — | Engine hum, pitch scales with `fwd_speed` |
| `|rear_l/r_lat_speed| > threshold` | Per-wheel smoke fires independently | Screech onset, volume scales with `_drift_intensity` |
| `_is_drifting = true` (>0.57) | Full bilateral smoke, two distinct trail arcs | Full tire screech |
| Outer wheel > threshold, inner < threshold | Asymmetric smoke — only outer fires | One-sided screech |
| Drift release | Smoke fades per-wheel as lat_speed drops | Screech fades |
| Visual body lean | BaseCar.rotation.y driven by omega × intensity | — |
| High speed (>80% max_speed) | Speed lines, camera FOV widens | High-rev, wind noise |
| Collision | Spark VFX | Metal clang |
| Landing | Camera shake, dust puff | Thump |

---

## UI Requirements

Debug overlay (dev builds): `fwd_speed`, `side_speed`, `omega`, `drift_intensity`, `slip_ratio`, `rear_l_lat_speed`, `rear_r_lat_speed`, `slip_angle_front_deg`, `slip_angle_rear_deg`, `is_drifting`, `on_floor`. Key v3.0 tuning insight: `rear_l/r_lat_speed` asymmetry reveals the per-wheel divergence; if both are always equal, check that `omega ≠ 0` during turns.

---

## Network Considerations

**Current state (v3.0 release)**: only `position`, `rotation`, `velocity` are synced at 30 Hz. `_omega` and `_drift_intensity` are NOT synced.

**Consequence**: remote karts (peers) will show no visual lean (lean is driven by `_omega` which is zero on remote). Smoke will not appear on remote karts (smoke is driven by per-wheel lat speeds, which require local physics).

**This is acceptable for MVP** because:
- The game is designed for a small group of friends in a shared session
- Remote kart appearance is secondary to local kart feel
- Adding omega/drift to sync requires careful interpolation to avoid pop artifacts

**Fix is trivial when needed** (estimated 15 minutes):
1. Add `_omega` and `_drift_intensity` to `_rpc_sync` payload (2 floats)
2. On receive: apply `_omega` → drive `_update_visual_lean` on remote
3. Apply `_drift_intensity` + compute synthetic rear wheel speeds for smoke
4. See `memory/project_v3_known_followups.md` for tracking

---

## Acceptance Criteria

### Functional Tests (automated — headless)

- [ ] Kart accelerates to ~90% emergent terminal velocity within 2.5s from rest
- [ ] Terminal velocity is emergent — `fwd_speed` stabilizes without hard clamp
- [ ] Braking from 27 m/s stops kart within 1.0s
- [ ] `BicyclePhysics.reset()` → `_omega = 0`, `_drift_intensity = 0`, `_is_drifting = false`
- [ ] At `_omega = 0`: `v_lat_rear_l == v_lat_rear_r == side_speed` (no divergence when not rotating)
- [ ] At `_omega = 1.5, side_speed = 0`: `v_lat_rear_l = -1.5 * (half_wb + half_track)`, `v_lat_rear_r = -1.5 * (half_wb - half_track)` (or equivalent per formula)
- [ ] `f_rear_l ≠ f_rear_r` when `_omega ≠ 0` (per-wheel force asymmetry confirmed)
- [ ] `tanh(0) = 0`, `tanh(±20) = ±1.0` (overflow guard working)
- [ ] `drift_intensity = 0` when `fwd_speed < drift_min_speed`
- [ ] `drift_intensity = 1.0` when `max(|v_lat_rear_l|, |v_lat_rear_r|) >= drift_max_slip_speed` at speed
- [ ] `_is_drifting = true` when `drift_intensity > 0.57`, `false` when `< 0.53`
- [ ] Standstill aid: `_omega` increases when `|fwd_speed| < stationary_steer_threshold` and `steer_input ≠ 0`
- [ ] Standstill aid: zero contribution when `|fwd_speed| >= stationary_steer_threshold`
- [ ] `omega_damping` exp decay: `_omega` halves in `ln(2)/omega_damping` seconds without torque input
- [ ] Visual lean sign: positive `_omega` (CCW, left turn) → negative `lean_dir` → kart leans right
- [ ] VFX smoke: `l_smoke.emitting = (|rear_left_lat_speed| > threshold)` independently of r_smoke
- [ ] `cornering_drag` applied at 0.5× `cornering_drag_coeff` internally
- [ ] Floor-align yaw-lock: sustained circular steer — yaw stable ±0.5 rad/s over 3s
- [ ] Remote karts: `_bicycle` is null, no physics runs, snapshot buffer only
- [ ] DEAD state: `_bicycle.reset()` called, all public state mirrors zeroed
- [ ] KartPhysicsResource swap changes all behavior — no hardcoded values in bicycle module

### Network Tests (automated)

- [ ] Position sync at 30 Hz includes `velocity` for interpolation
- [ ] Remote kart positions smooth (no jitter)
- [ ] Server teleport check uses `max_speed` reference
- [ ] `_omega` and `_drift_intensity` NOT in sync payload (confirmed acceptable)

### Playtest Criteria (human) — CRITICAL

- [ ] **Two distinct rear wheel trails visible at different curvature during hard turn at speed**
- [ ] **Machine feels heavy: momentum visible when changing direction, rotation takes time to build and decay**
- [ ] **Long slide hail at sharp turn on speed: rear swings out and takes 0.4-0.8s to settle after releasing steer**
- [ ] **Drift is predictable: player can anticipate rear trajectory after 3-5 practice laps**
- [ ] Reverse steers naturally (no sign hack visible — just steer the other way)
- [ ] Standing still: wiggling steer visibly rotates kart (stationary_omega_kick working)
- [ ] Circular drift stable from first full lap: holds arc without spiraling
- [ ] Body leans smoothly into turns, recovers smoothly — no snap or jitter on direction reversal
- [ ] Speed visibly decreases in tight drift (drag multiplier effect)
- [ ] After DEAD state, kart resumes physics cleanly without jump or spin
- [ ] **HTML5 export: feel identical to desktop (exp decay formulas are framerate-independent)**
- [ ] At light steer: little or no smoke. At full steer + speed: both wheels smoking with visible asymmetry
- [ ] Outer wheel smoke starts before inner wheel smoke on hard turn entry
- [ ] **"The car has mass and feels like it" — player first-session description should confirm heaviness**

---

## Open Questions / Known Followups

See `memory/project_v3_known_followups.md` for tracked items. Current list:

1. **Network sync of `_omega` and `_drift_intensity`** — remote karts show no lean or smoke. Fix estimated 15 minutes when visual fidelity of remote karts becomes priority (see Network Considerations above)
2. **Decal-based skid marks** — per-wheel trail rendering. Requires a decal emitter at each rear wheel position, feeding on `rear_l/r_lat_speed` magnitude
3. **Debug overlay `_dbg_*` fields** — some legacy debug variable names from v2.4 may still be referenced by DebugOverlay. Needs audit after v3.0 stabilizes
4. **Audio integration** — engine pitch and drift screech volume use `fwd_speed` and `_drift_intensity`. No changes needed from v2.4. Screech could be made per-wheel (left/right channel) using `rear_l/r_lat_speed` for spatial effect
5. **Ramp/air state** — `on_floor = false` → standstill aid correctly skipped, tire forces still compute but have no ground contact. Drift intensity may decay if speed gate triggers. Air control is deferred to post-MVP
