# Kart Physics System — v2.1 Archive

> **ARCHIVED**: This is the v2.1 snapshot preserved before v2.2 refactor.
> Active document: `design/gdd/kart-physics.md`
> Archived on: 2026-04-21

---

# Kart Physics System

> **Status**: In Design (v2.1 drift resistance)
> **Author**: Dima + game-designer + systems-designer + godot-specialist + technical-director
> **Last Updated**: 2026-04-21 (v2.1: drift drag+rolling multipliers — speed cost for tight turns)
> **Implements Pillar**: Аркадный хаос (arcade feel, не симулятор) + Вариативность (kart classes via physics)

## Overview

Kart Physics — система движения, дрифта, коллизий и взаимодействия с рельефом.
CharacterBody3D + move_and_slide() с аркадной моделью физики. Все параметры
вынесены в KartPhysicsResource (.tres) — смена класса машины = смена ресурса.

Ключевой принцип: **feel first**. Каждое решение оптимизирует ощущение от вождения,
не физическую корректность. Асимптотическое ускорение (ощущение веса), grip recovery
curve (ощущение инерции), momentum transfer (ощущение массы).

## Player Fantasy

"Машина отзывчивая но не невесомая. Я чувствую её вес — разгон плавный, торможение
резкое. Когда дрифтую — зад выносит, я контролирую занос рулём. Выход из дрифта
не мгновенный — машина ещё скользит секунду, и я это чувствую. Когда врезаюсь в
тяжёлый карт — меня отбрасывает, а его еле сдвигает."

## Detailed Design

### Core Rules

1. Physics runs at 60 Hz (_physics_process), network sync at 30 Hz
2. Local kart: full physics simulation. Remote karts: snapshot buffer interpolation (Network Layer GDD)
3. All physics params from KartPhysicsResource (@export). No hardcoded values
4. State Machine gates physics: DEAD = no input, IDLE = frozen
5. Velocity decomposed into forward (basis.z) and lateral (basis.x) components
6. Gravity = 35.0 m/s² (3.57× Earth — arcade feel)
7. move_and_slide() handles floor/wall collision
8. Kart-to-kart collision: momentum/energy transfer
9. `max_speed` is a tunable reference value, not a physics hard clamp. Actual top speed is an emergent terminal velocity where thrust equals drag + rolling resistance. Camera and network systems use `max_speed` for normalization. User tunes empirically via `dev_params.json`, then commits final value to `.tres` once feel is correct.
10. Drift state is binary (`_is_drifting: bool`) with hysteresis thresholds to prevent jitter at the edge. The physical effect (`_grip`) remains a smooth float — only the logical state is binary.
11. Reverse drift is explicitly blocked: drift entry requires `fwd_speed > 0` (strictly positive), not `|fwd_speed| > min`.

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
@export var drift_enter_threshold: float = 0.75   # |steer_input| to enter drift (hysteresis high)
@export var drift_exit_threshold: float = 0.35    # |steer_input| to exit drift (hysteresis low)
@export var drift_min_speed_ratio: float = 0.4    # fraction of max_speed required to enter/hold drift
@export var low_grip_target: float = 0.8          # lateral damping while drifting
@export var high_grip_target: float = 18.0       # lateral damping when not drifting
@export var grip_loss_rate: float = 12.0         # /sec — grip drops toward low on entry
@export var grip_recovery_rate: float = 3.0     # /sec — grip returns toward high on exit
@export var drift_kick_force: float = 4.0         # lateral impulse applied once on drift entry
@export var drift_yaw_multiplier: float = 1.7     # yaw_rate multiplier while drifting (tighter arc)
@export var visual_drift_max_deg: float = 40.0    # max visual lean angle for body mesh decoupling
# v2.1 — Drift resistance: speed cost for tight turns (tire scrubbing physics)
@export var drift_drag_multiplier: float = 1.8    # k_drag multiplied by this while _is_drifting (lowers terminal velocity)
@export var drift_rolling_multiplier: float = 1.3 # k_rolling multiplied by this while _is_drifting (scrubbing at low speed)

@export_group("Collision")
@export var mass: float = 1.0                     # relative mass (Heavy=2.0, Light=0.6)
@export var bump_min_force: float = 3.0           # minimum push on collision
@export var bump_max_force: float = 12.0          # maximum push on collision

@export_group("Terrain")
@export var slope_speed_influence: float = 8.0    # m/s² slope acceleration bonus
@export var floor_snap_length: float = 0.3        # keep kart grounded on slopes
@export var floor_align_speed: float = 8.0        # slerp speed for floor normal alignment
```

**Removed from previous version** (superseded by force-based model and binary drift):
- `reverse_max_speed` → replaced by `accel_force * reverse_ratio` (emergent reverse terminal)
- `accel_sharpness`, `coast_decel` → replaced by `accel_force` + `k_drag` + `k_rolling`
- `min_drift_speed` → computed from `drift_min_speed_ratio * max_speed`
- `drift_steer_threshold` → split into `drift_enter_threshold` / `drift_exit_threshold` (hysteresis)
- `wheelbase`, `max_steer_angle` → removed (bicycle model abandoned for direct rotation)
- Legacy code-only params: `rwd_oversteer_factor`, `drift_steer_boost`, `drift_lateral_force`, `drift_counter_steer_mult`, `drift_same_steer_mult`, `drift_speed_penalty`, `drift_full_speed`

### Movement Model

**Force-based acceleration** (frame-rate correct, emergent terminal velocity):
```
thrust   = throttle_input * accel_force                    # throttle_input ∈ [-1.0, 1.0]
if throttle_input < 0:
    thrust = throttle_input * accel_force * reverse_ratio

# v2.1: drift resistance — multiply k_drag and k_rolling while drifting (tire scrubbing)
active_k_drag    = k_drag    * (drift_drag_multiplier    if _is_drifting else 1.0)
active_k_rolling = k_rolling * (drift_rolling_multiplier if _is_drifting else 1.0)

drag     = -sign(fwd_speed) * active_k_drag * fwd_speed * fwd_speed
rolling  = -active_k_rolling * fwd_speed
brake    = -sign(fwd_speed) * brake_force                  # only when braking opposes motion

fwd_speed += (thrust + drag + rolling + brake) * delta
```

`brake` term applies only when: braking input (S key) opposes current movement direction AND `|fwd_speed| > 0.5`.

**Terminal velocity** (emergent — no hard clamp):
```
Normal:  v_terminal        ≈ sqrt(accel_force / k_drag)
Drifting: v_terminal_drift ≈ sqrt(accel_force / (k_drag * drift_drag_multiplier))
```
With defaults (`accel_force=28, k_drag=0.03`): normal terminal ≈ 30.5 m/s, drift terminal ≈ 22.7 m/s (~74% of normal — visible slowdown in tight turns). User tunes `max_speed` reference to match observed terminal (per Core Rule #9).

**Speed-dependent steering with stationary fix**:
```
speed_ratio = clamp(abs(fwd_speed) / max_speed, 0.0, 1.0)
steer_mult  = lerp(steer_low_speed_mult, steer_high_speed_mult, speed_ratio)

if abs(fwd_speed) < stationary_steer_threshold:
    speed_scale = stationary_steer_scale                   # 0.4 — gentle rotation near stop
else:
    speed_scale = speed_ratio

effective_yaw_rate = steering_speed * steer_mult * steer_input * speed_scale * drift_mult
rotate_y(effective_yaw_rate * delta)
```

**Velocity projection after rotation** (maintain momentum through turns):
```
# After rotate_y, forward basis has changed. Re-decompose velocity:
new_fwd  = -basis.z
new_side = basis.x
fwd_speed  = velocity.dot(new_fwd)
side_speed = velocity.dot(new_side)
# Lateral component handled by _grip damping (see Drift Model)
```

Note: **no bicycle model**, no `tan(steer_angle)`, no `wheelbase`. Rotation is direct — kart pivots around its own center, velocity follows new orientation proportionally to `_grip` strength.

### Drift Model

**Key insight**: Drift state is binary (on/off) with a hysteresis gap to prevent jitter at the threshold. The physical effect — `_grip` — remains a smooth float that transitions gradually. **Binary logical state, continuous physical effect.**

**State variables**:
```
var _is_drifting: bool = false
var _grip: float = high_grip_target            # starts fully gripped
```

**Hysteresis logic** (runs each physics frame):
```
drift_min_speed = drift_min_speed_ratio * max_speed

if not _is_drifting:
    # Entry: ALL conditions required (including strictly forward — no reverse drift)
    speed_ok = fwd_speed > drift_min_speed
    steer_ok = abs(steer_input) > drift_enter_threshold
    if speed_ok and steer_ok:
        _is_drifting = true
        # Drift entry kick — rear swings out once
        velocity += basis.x * (-steer_input * drift_kick_force)
else:
    # Exit: any condition violated (hysteresis gap prevents immediate re-entry)
    if abs(steer_input) < drift_exit_threshold or fwd_speed <= drift_min_speed:
        _is_drifting = false
```

Reverse drift is **explicitly blocked** — entry condition uses `fwd_speed > drift_min_speed` (strictly positive), not `|fwd_speed|`. See Core Rule #11.

**Grip transition** (smooth — runs every frame regardless of state):
```
target_grip = low_grip_target  if _is_drifting else high_grip_target
grip_rate   = grip_loss_rate   if _is_drifting else grip_recovery_rate
_grip = move_toward(_grip, target_grip, grip_rate * delta)
```

**Lateral velocity damping via `_grip`**:
```
side_speed = velocity.dot(basis.x)
side_speed = move_toward(side_speed, 0.0, _grip * delta)
# Rebuild lateral component:
velocity = velocity - basis.x * (velocity.dot(basis.x) - side_speed)
```

**Drift yaw boost** (applied in steering calculation):
```
drift_mult = drift_yaw_multiplier if _is_drifting else 1.0
effective_yaw_rate = steering_speed * steer_mult * steer_input * speed_scale * drift_mult
```

**Grip recovery timeline** (`grip_recovery_rate = 3.0/sec`, `low_grip_target = 0.8`):

| Time after exit | `_grip` | Feel |
|---|---|---|
| 0.0s (exit) | 0.8 | Still sliding freely |
| 0.3s | ~1.7 | Starting to grip |
| 0.5s | ~2.3 | Noticeable straightening |
| 1.0s | ~3.8 | Strong grip, mostly straight |
| 2.0s | ~6.8 | Near full grip |

Player feels ~0.5–1.0 sec of tangible slide after releasing drift — heavy and committal.

**Hysteresis gap explanation** (`enter=0.75`, `exit=0.35`):
The zone `[0.35, 0.75]` on `|steer_input|` is a "safe band" — once drifting, player can relax steer to 0.5 without accidentally exiting. This mirrors how SmashKarts.io feels. Tune `drift_exit_threshold` upward if drift exits too easily, downward if too sticky. **Invariant:** `drift_enter_threshold > drift_exit_threshold`, safe minimum gap: 0.2.

### Kart-to-Kart Collision

**Energy-based momentum transfer**: push force proportional to `mass * speed`.

```
for i in get_slide_collision_count():
    var col := get_slide_collision(i)
    var other := col.get_collider()
    if other is CharacterBody3D and other.has_method("get_kart_mass"):
        var my_energy := mass * abs(fwd_speed)
        var other_energy := other.get_kart_mass() * abs(other.velocity.length())
        var energy_diff := my_energy - other_energy
        var push_dir := col.get_normal()
        
        # Positive = I have more energy = I push them
        # Negative = they push me
        var force := clamp(abs(energy_diff) * 0.5, bump_min_force, bump_max_force)
        if energy_diff > 0:
            # I push them
            other.velocity += -push_dir * force
        else:
            # They push me
            velocity += push_dir * force
```

**Same mass, same speed**: equal push on both (energy_diff ≈ 0, both get bump_min_force).
**Heavy fast vs Light slow**: Heavy pushes Light significantly.
**Light fast vs Heavy slow**: Light bounces off, Heavy barely moves.

### Terrain — Slopes & Ramps

**Slope speed influence**:
```
if is_on_floor():
    var slope_factor := -basis.z.dot(Vector3.UP)  # positive = downhill
    fwd_speed += slope_factor * slope_speed_influence * delta
```

Downhill: +8 m/s² bonus. Uphill: -8 m/s² penalty. Flat: 0.

**Floor alignment** (kart tilts with terrain):
```
if is_on_floor():
    var floor_n := get_floor_normal()
    var target_basis := Basis(basis.x, floor_n, basis.z).orthonormalized()
    basis = basis.slerp(target_basis, floor_align_speed * delta)
```

**Ramp launch** (air physics):
- No `velocity.y = 0` while on floor — let move_and_slide handle it
- In air: disable steering (0.15s lockout), apply gravity
- On landing: brief camera shake (feel)

**floor_snap_length = 0.3**: keeps kart grounded over small bumps.

### Interactions with Other Systems

| System | Direction | Interface |
|--------|-----------|-----------|
| **State Machine** | ← reads | KartState gates input: DEAD = no physics, IDLE = frozen |
| **State Machine** | → triggers | Speed/drift state feeds VFX signals |
| **Network Layer** | → sends | Position/rotation/velocity at 30 Hz via _rpc_sync |
| **Network Layer** | ← receives | Remote karts: snapshot buffer, no local physics |
| **Health & Damage** | ← reads | Collision can trigger contact damage (future: Spikes) |
| **Kart Classes** | ← reads | KartPhysicsResource swapped per class |
| **Camera System** | → feeds | Speed feeds camera FOV and follow distance |
| **VFX System** | → feeds | Drift state, speed, collision → particles, tire marks |
| **Audio System** | → feeds | Speed → engine pitch, drift → tire screech |
| **HUD** | → feeds | Speed → speedometer (if added) |

## Formulas

### Force-Based Acceleration

```
fwd_speed(t+dt) = fwd_speed(t) + (thrust + drag + rolling + brake) * dt
thrust   = throttle_input * accel_force                    (reverse: × reverse_ratio)

# v2.1: effective resistance coefficients depend on drift state
active_k_drag    = k_drag    * (drift_drag_multiplier    if _is_drifting else 1.0)
active_k_rolling = k_rolling * (drift_rolling_multiplier if _is_drifting else 1.0)

drag     = -sign(fwd_speed) * active_k_drag * fwd_speed²
rolling  = -active_k_rolling * fwd_speed
brake    = -sign(fwd_speed) * brake_force                  (only when braking opposes motion)
```

| Variable | Type | Default | Range |
|---|---|---|---|
| `accel_force` | float | 28.0 | 10-100 |
| `k_drag` | float | 0.03 | 0.01-0.2 |
| `k_rolling` | float | 1.5 | 0.5-5 |
| `brake_force` | float | 40.0 | 20-60 m/s² |
| `reverse_ratio` | float | 0.5 | 0.2-0.7 |
| `drift_drag_multiplier` | float | 1.8 | 1.2-3.0 |
| `drift_rolling_multiplier` | float | 1.3 | 1.0-2.0 |

**Terminal velocity** (solve `thrust = drag + rolling`, rolling negligible at high speed):
```
v_terminal_normal ≈ sqrt(accel_force / k_drag)
v_terminal_drift  ≈ sqrt(accel_force / (k_drag * drift_drag_multiplier))
ratio             = 1 / sqrt(drift_drag_multiplier)
```
With defaults (`accel_force=28, k_drag=0.03, drift_drag_multiplier=1.8`):
- Normal terminal: `sqrt(28/0.03) ≈ 30.5 m/s`
- Drift terminal:  `sqrt(28/0.054) ≈ 22.8 m/s` (~74.7% of normal)
- Player perceives ~25% speed reduction when holding tight drift arc.

**Acceleration timeline example** (accel_force=400, k_drag=0.4, k_rolling=12, 60fps):
- 0.5s: ~18 m/s (62% of terminal)
- 1.0s: ~24 m/s (83%)
- 2.0s: ~28 m/s (97%)
- Exponential approach: fast early, asymptote at terminal — "weight" feel without lerp hack

**Braking distance example** (from 20 m/s, brake_force=40, drag and rolling assist):
- Pure brake only: 20/40 = 0.5s, 5m
- With drag + rolling: ~0.35s, ~3.5m (shorter — intentional arcade feel)

### Speed-Dependent Steering

```
speed_ratio = clamp(abs(fwd_speed) / max_speed, 0.0, 1.0)
steer_mult  = lerp(steer_low_speed_mult, steer_high_speed_mult, speed_ratio)
speed_scale = stationary_steer_scale  if abs(fwd_speed) < stationary_steer_threshold
              else speed_ratio
yaw_rate = steering_speed * steer_mult * steer_input * speed_scale * drift_mult
```

| `fwd_speed` | `speed_ratio` | `steer_mult` | `speed_scale` | `yaw_rate` (steer=1.0, no drift) |
|---|---|---|---|---|
| 0 m/s (stationary) | 0.0 | 1.4 | 0.4 | 1.23 rad/s |
| 2.1 m/s | 0.1 | 1.33 | 0.1 | 0.29 rad/s |
| 10 m/s | 0.5 | 1.05 | 0.5 | 1.16 rad/s |
| 20 m/s | 1.0 | 0.7 | 1.0 | 1.54 rad/s |
| 20 m/s (drifting) | 1.0 | 0.7 | 1.0 | 2.62 rad/s (×1.7) |

Note: `stationary_steer_threshold` creates a narrow band at ~2 m/s where steering scale noticeably increases as speed crosses the threshold — this is intentional (smooth transition out of "parked" feel).

### Drift Hysteresis

```
ENTER drift if: abs(steer_input) > drift_enter_threshold (0.75)
                AND fwd_speed > drift_min_speed_ratio * max_speed

EXIT drift if:  abs(steer_input) < drift_exit_threshold (0.35)
                OR  fwd_speed <= drift_min_speed_ratio * max_speed
```

| Variable | Default | Range |
|---|---|---|
| `drift_enter_threshold` | 0.75 | 0.55-0.90 |
| `drift_exit_threshold` | 0.35 | 0.15-0.55 |
| `drift_min_speed_ratio` | 0.4 | 0.2-0.6 |

**Hysteresis gap**: `drift_enter_threshold - drift_exit_threshold = 0.40`
**Invariant:** `drift_exit_threshold < drift_enter_threshold`. Safe minimum gap: 0.2. Violating creates oscillation.

**Drift entry example**: player at 22 m/s pushes steer to 0.80 (> 0.75) → `_is_drifting = true`, kick fires.
**Drift hold**: player relaxes steer to 0.50 (< 0.75 but > 0.35) → drift stays active (hysteresis).
**Drift exit**: player releases to 0.20 (< 0.35) → `_is_drifting = false`, grip recovery begins.

### Grip Transition

```
target_grip = low_grip_target  if _is_drifting else high_grip_target
rate        = grip_loss_rate   if _is_drifting else grip_recovery_rate
_grip = move_toward(_grip, target_grip, rate * delta)
```

| Variable | Default | Range |
|---|---|---|
| `low_grip_target` | 0.8 | 0.1-2.0 |
| `high_grip_target` | 18.0 | 10-25 |
| `grip_loss_rate` | 12.0 | 5-20 /s |
| `grip_recovery_rate` | 3.0 | 1-8 /s |

**Drift entry** (grip_loss_rate=12): 18.0 → 0.8 takes 1.43s at full rate — but slide is noticeable immediately (even partial drop 18 → 10 reduces lateral damping significantly).
**Drift exit** (grip_recovery_rate=3): 0.8 → 18.0 takes 5.73s at full rate — player feels ~1s of real slide (see recovery timeline in Drift Model).

### Collision Energy

```
energy = mass * speed
push_force = clamp(abs(energy_diff) * 0.5, bump_min_force, bump_max_force)
```

| Scenario | My energy | Their energy | Result |
|---|---|---|---|
| Same kart, same speed (15 m/s) | 15 | 15 | Both get min push (3.0) |
| Heavy (2.0) fast vs Light (0.6) slow | 36 | 6 | Light gets 12.0 push, Heavy gets 3.0 |
| Light (0.6) fast vs Heavy (2.0) stopped | 16.2 | 0 | Heavy gets 8.1 push, Light bounces |

## Edge Cases

| Scenario | Resolution |
|---|---|
| Drift attempt at zero/low speed | Rejected: `fwd_speed > drift_min_speed_ratio * max_speed` prevents entry |
| Drifting, speed drops below drift_min | `_is_drifting = false` immediately, grip recovery begins |
| Steer oscillates near drift_enter_threshold | Hysteresis gap [exit, enter] prevents rapid re-entry — exit at 0.35, re-entry requires 0.75. Gap of 0.40 handles analog stick noise |
| `max_speed` reference value set too low | Terminal velocity exceeds max_speed reference — camera FOV hits max at lower speed, network teleport check too aggressive. Fix: user sets `max_speed` ≥ observed terminal velocity |
| Drift near stationary (speed in [0, drift_min]) | Not possible — entry condition requires speed > drift_min. If somehow drifting while slowing, exit fires cleanly |
| Two karts collide head-on at max speed | Both get max push (12.0), bounce apart |
| Kart on steep slope (>50°) | floor_max_angle rejects — kart slides off |
| Kart launched off ramp | Air physics: no steering for 0.15s, gravity applies |
| Kart lands on another kart | move_and_slide handles — push apart |
| Death during drift | `_is_drifting = false` and `_grip = high_grip_target` reset, enters DEAD state |
| DEAD state | No physics processing at all |
| Remote kart collision | Not simulated locally — server handles, clients interpolate |
| Reverse + drift attempt | Blocked by Core Rule #11: entry requires `fwd_speed > 0` (strictly positive) |
| Frame rate drop (HTML5) | Force-based formulas are `* delta` — correct at 30 or 60 fps by construction (no hidden 60fps dependency) |
| Micro-steer oscillation near enter threshold | Drift kick fires only on `false → true` transition; hysteresis gap prevents rapid re-triggering |
| Stationary steer threshold crossed mid-turn | Smooth transition: `speed_scale` uses `speed_ratio` above threshold, so the band at 2 m/s is a soft switch, not a click |
| Drift entry kick during same-frame collision | Kick is `velocity +=` (additive with collision push). If total lateral becomes extreme, move_and_slide damps it next frame |

## Dependencies

### Upstream

| System | Dependency | Type |
|---|---|---|
| **State Machine** | KartState for physics gating | Hard |
| **Network Layer** | Position sync, remote interpolation | Hard |

### Downstream

| System | What it needs |
|---|---|
| **Kart Classes** | KartPhysicsResource defines class identity |
| **Weapon System** | Kart position/velocity for projectile spawn |
| **Camera System** | Speed/drift state for dynamic camera |
| **VFX System** | Drift state for tire smoke, speed for wind effects |
| **Audio System** | Speed for engine sound, drift for tire screech |

### Interface Contract

- Physics params ONLY from KartPhysicsResource — no hardcoded values
- Speed/drift state exposed as readable properties for other systems
- Collision events emitted as signals for damage/VFX systems
- Remote karts do NOT run physics — only interpolation

## Tuning Knobs

| Knob | Default | Safe Range | Affects | Too Low | Too High |
|---|---|---|---|---|---|
| `accel_force` | 400.0 | 200-600 | Acceleration punch + terminal velocity | Sluggish, low top speed | Twitchy, overshoots terminal fast |
| `k_drag` | 0.4 | 0.1-1.0 | Top speed ceiling (emergent) + braking assist | Very high terminal, never slows | Very low terminal speed |
| `k_rolling` | 12.0 | 5-20 /s | Coast-stop behavior, low-speed decel | Rolls forever after releasing throttle | Stops immediately, feels sticky |
| `brake_force` | 40.0 | 20-60 m/s² | Brake responsiveness | Can't stop | Jarring instant stop |
| `reverse_ratio` | 0.4 | 0.2-0.7 | Reverse speed cap | Barely reverses | Full-speed reverse, unnatural |
| `steering_speed` | 2.2 | 1.5-3.5 rad/s | Turn tightness across all speeds | Can't corner | Spins out |
| `steer_high_speed_mult` | 0.7 | 0.3-1.0 | High-speed handling penalty | Nearly impossible to steer at speed | No penalty, spins at top speed |
| `stationary_steer_scale` | 0.4 | 0.2-0.8 | Rotation feel when near-stopped | Barely rotates when stopped | Spins in place instantly |
| `stationary_steer_threshold` | 2.0 | 0.5-4.0 m/s | Transition point of stationary fix | Stationary fix too narrow | Affects normal low-speed feel |
| `drift_enter_threshold` | 0.75 | 0.55-0.90 | How aggressive steer triggers drift | Drift too easy to enter | Almost never auto-drifts |
| `drift_exit_threshold` | 0.35 | 0.15-0.55 | How easily drift releases | Drift exits at full-steer input | Drift never exits (sticky) |
| `drift_min_speed_ratio` | 0.4 | 0.2-0.6 | Min speed fraction to enter/hold drift | Drift at near-standstill | Can only drift at 60%+ top speed |
| `drift_yaw_multiplier` | 1.7 | 1.2-2.5 | Extra rotation during drift | No yaw boost — drift feels identical to normal | Spin-out, uncontrollable |
| `low_grip_target` | 0.8 | 0.1-2.0 | Slide amount while drifting | Infinite slide (no lateral control) | Barely slides, not satisfying |
| `high_grip_target` | 18.0 | 10-25 | Normal grip strength | Always sliding, car floats | No slide ever |
| `grip_loss_rate` | 12.0 | 5-20 /s | Drift entry speed | Slow ramp into drift (late feel) | Instant snap on entry |
| `grip_recovery_rate` | 3.0 | 1-8 /s | Drift exit slide tail | Slides for 3+ sec after exit | Instant snap-straight |
| `drift_kick_force` | 4.0 | 3-15 | Rear swing drama on entry | Subtle, barely noticeable | Spins out, unrecoverable |
| `visual_drift_max_deg` | 40.0 | 20-50° | Body mesh visual lean during drift | Visual decoupling unnoticeable | Body faces sideways, disorienting |
| `drift_drag_multiplier` | 1.8 | 1.2-3.0 | Terminal velocity reduction in drift: `v_drift = v_normal / sqrt(mult)` — 1.8→75%, 2.0→71%, 3.0→58% | No speed cost for tight turns — drift is free | Kart slows to crawl in any turn |
| `drift_rolling_multiplier` | 1.3 | 1.0-2.0 | Extra low-speed scrubbing while drifting; felt during drift entry/exit transitions | No tactile scrubbing on drift entry | Abrupt stop feeling at low speed |
| `mass` | 1.0 | 0.4-3.0 | Collision weight | Gets pushed easily | Immovable |
| `slope_speed_influence` | 8.0 | 3-15 m/s² | Hill impact | Hills irrelevant | Hills dominate — unplayable on slopes |
| `max_speed` (reference) | 20.0 | — | Camera + network normalization only | Camera/network teleport check wrong | FOV never widens, teleport threshold too lax |

### Knob Interactions

- `accel_force` ÷ `k_drag` = terminal velocity squared — tune together, not independently
- `drift_drag_multiplier` changes drift terminal: `v_drift = sqrt(accel_force / (k_drag * mult))` — tune when drift slowdown is too subtle or too punishing
- `drift_drag_multiplier` is independent of `drift_rolling_multiplier` — former controls high-speed effect, latter controls low-speed scrubbing
- `drift_enter_threshold` − `drift_exit_threshold` must stay ≥ 0.2 (hysteresis gap invariant)
- `low_grip_target` × `drift_kick_force` = how extreme drift feels on entry
- `grip_recovery_rate` × `high_grip_target` = tail length after drift exit
- `drift_yaw_multiplier` × `steering_speed` = how tight you can cut during drift
- `k_rolling` × `k_drag` = coast feel — both tuned together for natural deceleration
- `mass` × observed terminal velocity = collision energy = how hard this kart hits others

## Visual/Audio Requirements

| Event | Visual | Audio |
|-------|--------|-------|
| Driving | — | Engine hum, pitch scales with speed |
| Drifting | Tire smoke particles (existing), tire marks on ground | Tire screech, pitch scales with lateral speed |
| Drift entry | Burst of smoke from rear tires | Screech onset SFX |
| High speed (>80%) | Speed lines on screen edges, camera FOV widens | Engine high-rev, wind noise |
| Collision with kart | Brief spark VFX at contact point | Metal clang SFX |
| Collision with wall | Dust puff at contact | Thud SFX |
| Ramp launch | — | Whoosh SFX |
| Landing | Brief camera shake, dust puff | Thump SFX |
| Slope up | — | Engine strain (lower pitch) |
| Slope down | Speed lines intensify | Engine ease (higher pitch) |

## UI Requirements

| Element | Location | Updates |
|---------|----------|---------|
| Speed indicator | Optional — HUD bottom | On speed change |
| Drift indicator | Tire smoke VFX is sufficient | On drift state |

Minimal UI — the car physics FEEL is the primary feedback channel, not numbers on screen.

## Acceptance Criteria

### Functional Tests (automated — headless)

- [ ] Kart accelerates to ~90% terminal velocity within 2.0s from rest
- [ ] Terminal velocity is emergent: at steady throttle, `fwd_speed` stabilizes without a hard clamp
- [ ] Braking from 20 m/s stops kart within 0.6s
- [ ] Coasting from 20 m/s: kart slows to 5 m/s within 2.0s (k_rolling effect)
- [ ] Steering rate at v=0 uses `stationary_steer_scale` (0.4), not zero
- [ ] Steering rate at v=`max_speed` uses `speed_ratio=1.0` and `steer_high_speed_mult`
- [ ] Drift entry: `_is_drifting` becomes true when `|steer_input| > 0.75` AND `fwd_speed > drift_min_speed_ratio * max_speed`
- [ ] Reverse drift blocked: attempting `|steer_input|=1.0` while `fwd_speed < 0` does NOT enter drift
- [ ] Drift kick: lateral impulse fires exactly once on `false → true` transition
- [ ] Drift hold: `_is_drifting` remains true when steer relaxes to 0.50 (hysteresis gap)
- [ ] Drift exit: `_is_drifting` becomes false when steer drops to 0.20 (< 0.35)
- [ ] Drift exit: `_grip` recovers toward `high_grip_target` at `grip_recovery_rate`
- [ ] No "drift" action required in InputMap
- [ ] Kart-to-kart collision: heavier/faster kart pushes lighter/slower
- [ ] Collision push force clamped between `bump_min_force` and `bump_max_force`
- [ ] Slope: kart accelerates downhill, decelerates uphill
- [ ] Floor alignment: kart tilts to match terrain normal
- [ ] KartPhysicsResource swap changes all physics behavior (no hardcoded values)
- [ ] State Machine: no physics input during DEAD
- [ ] Remote karts do not run physics (only interpolation)
- [ ] `_is_drifting = false` and `_grip` reset to `high_grip_target` on DEAD state entry
- [ ] While `_is_drifting = true`: effective drag coefficient = `k_drag * drift_drag_multiplier` (verified: terminal velocity emergent lower than normal)
- [ ] While `_is_drifting = false`: effective drag = `k_drag` (no multiplier applied — drift resistance removed cleanly on exit)

### Network Tests (automated)

- [ ] Position sync at 30 Hz includes velocity for interpolation
- [ ] Remote kart positions are smooth (snapshot buffer, no jitter)
- [ ] Server teleport check uses `max_speed` reference value from KartPhysicsResource
- [ ] Collision results consistent across clients (server-authoritative position)

### Playtest Criteria (human) — CRITICAL for this system

- [ ] Steering from standstill feels responsive (not dead zone, not a spin)
- [ ] Acceleration feels weighty — you feel the kart build speed, not instant
- [ ] Coasting has long exponential tail — no "вкопанная" stop when releasing throttle
- [ ] Drift triggers feel natural and automatic — no separate button needed
- [ ] Drift activates in first frame when conditions met (no 200-400ms lag)
- [ ] Hysteresis feels right: you can relax steer mid-drift without losing it
- [ ] Drift rear swing is dramatic — clearly visible on entry kick
- [ ] Drift exit tail: kart slides ~0.5-1.0s after releasing steer — feels committal
- [ ] Counter-steering during drift feels responsive and controllable
- [ ] Yaw boost during drift: turns tighter than normal — rewarding to use drift aggressively
- [ ] High-speed turning requires wider arcs — momentum is felt
- [ ] Kart collision feels physical — lighter kart pushed more
- [ ] Driving over hills feels natural — kart follows terrain
- [ ] Debug vectors (Phase 0) correlate visibly with felt motion
- [ ] Overall: "this feels like SmashKarts but with more weight and drama on drift"
- [ ] Drift speed cost visible: holding a full drift arc at full throttle, `fwd_speed` in debug overlay drops by ≥12% from steady-state normal terminal within 2 seconds of drift entry

## Open Questions

1. **Drift visual direction**: Should drift smoke come from rear tires only,
   or all tires? SmashKarts: rear only.

2. **Drift auto-trigger**: **Resolved**: Auto-drift on sustained steer at speed. No drift button. Binary state with hysteresis (enter 0.75, exit 0.35).

3. **Reverse drift**: **Resolved (2026-04-20)**: explicitly blocked. Entry requires `fwd_speed > 0` (strictly positive).

4. **`max_speed` reference value**: **Resolved (2026-04-20)**: tunable via `dev_params.json`, user retunes empirically to match observed terminal velocity after first playtest. Final value committed to `.tres`.

5. **Air control**: Currently no steering in air (0.15s lockout). Should there
   be slight air steering for ramp gameplay? Depends on map design.
