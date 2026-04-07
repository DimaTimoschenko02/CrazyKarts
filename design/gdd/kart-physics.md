# Kart Physics System

> **Status**: In Design
> **Author**: Dima + game-designer + systems-designer + godot-specialist + technical-director
> **Last Updated**: 2026-04-04
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

### KartPhysicsResource

```gdscript
class_name KartPhysicsResource
extends Resource

@export_group("Speed")
@export var max_speed: float = 23.0          # m/s forward
@export var reverse_max_speed: float = 13.0  # m/s backward
@export var accel_sharpness: float = 0.35    # asymptotic accel (0.1=floaty, 0.5=punchy)
@export var brake_decel: float = 40.0        # m/s² braking
@export var coast_decel: float = 8.0         # m/s² no input

@export_group("Steering")
@export var steering_speed: float = 2.2      # rad/s base
@export var steer_low_speed_mult: float = 1.4  # multiplier at v=0
@export var steer_high_speed_mult: float = 0.7 # multiplier at v=max

@export_group("Drift")
@export var low_grip_target: float = 0.8     # grip during drift
@export var high_grip_target: float = 18.0   # grip when not drifting
@export var grip_loss_rate: float = 12.0     # /sec — how fast grip drops on drift entry
@export var grip_recovery_rate: float = 3.0  # /sec — how fast grip returns after release
@export var drift_kick_force: float = 4.0    # lateral impulse on drift entry
@export var min_drift_speed: float = 6.0     # m/s minimum to enter drift
@export var drift_steer_threshold: float = 0.7  # steer_input threshold (0.0-1.0)

@export_group("Collision")
@export var mass: float = 1.0                # relative mass (Heavy=2.0, Light=0.6)
@export var bump_min_force: float = 3.0      # minimum push on collision
@export var bump_max_force: float = 12.0     # maximum push on collision

@export_group("Terrain")
@export var slope_speed_influence: float = 8.0  # m/s² slope acceleration bonus
@export var floor_snap_length: float = 0.3      # keep kart grounded on slopes
@export var floor_align_speed: float = 8.0      # slerp speed for floor normal alignment
```

### Movement Model

**Asymptotic acceleration** (ощущение веса):
```
# Instead of move_toward (linear):
fwd_speed = lerp(fwd_speed, target_speed, accel_sharpness * delta * 60.0)

# target_speed = throttle_input * max_speed (forward)
# target_speed = throttle_input * reverse_max_speed (reverse)
```

**Speed-dependent steering**:
```
speed_ratio = clamp(abs(fwd_speed) / max_speed, 0.0, 1.0)
steer_mult = lerp(steer_low_speed_mult, steer_high_speed_mult, speed_ratio)
effective_steer = steering_speed * steer_mult * steer_input * delta
rotate_y(effective_steer)
```

**Braking & coasting**:
```
# Braking (opposite input to movement direction):
fwd_speed = move_toward(fwd_speed, 0.0, brake_decel * delta)

# Coasting (no input):
fwd_speed = move_toward(fwd_speed, 0.0, coast_decel * delta)
```

### Drift Model

**Key insight**: `_grip` is a float state variable that transitions smoothly
between LOW_GRIP and HIGH_GRIP. This creates the "heavy and committal" feel —
you cannot cancel drift instantly.

**State variables**: `var _grip: float = high_grip_target` and `var _was_drifting: bool = false`

**Each physics frame**:
```
var is_drifting := abs(steer_input) > drift_steer_threshold and abs(fwd_speed) > min_drift_speed

if is_drifting:
    _grip = move_toward(_grip, low_grip_target, grip_loss_rate * delta)
else:
    _grip = move_toward(_grip, high_grip_target, grip_recovery_rate * delta)

# Lateral velocity damping
var side_speed := velocity.dot(basis.x)
side_speed = move_toward(side_speed, 0.0, _grip * delta)
```

**Drift entry kick** (rear swings out):
```
if is_drifting and not _was_drifting:
    var kick := basis.x * (-steer_input * drift_kick_force)
    velocity += kick
_was_drifting = is_drifting
```

**Grip recovery timeline** (GRIP_RECOVERY_RATE = 3.0/sec):
| Time after release | `_grip` | Feel |
|---|---|---|
| 0.0s (release) | 0.8 | Still sliding freely |
| 0.3s | ~1.7 | Starting to grip |
| 0.5s | ~2.3 | Noticeable straightening |
| 1.0s | ~3.8 | Strong grip, mostly straight |
| 2.0s | ~6.8 | Near full grip |

This gives 0.5-1.0 sec of tangible slide after releasing drift — feels heavy and committal.

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

### Asymptotic Acceleration

```
fwd_speed(t+dt) = lerp(fwd_speed(t), target_speed, accel_sharpness * dt * 60.0)
```

| Variable | Type | Default | Range |
|---|---|---|---|
| `accel_sharpness` | float | 0.35 | 0.1-0.5 |
| `target_speed` | float | ±23.0 | max_speed or reverse_max_speed |

**Example**: 0 → 23 m/s acceleration timeline (accel_sharpness=0.35, 60fps):
- 0.5s: ~17 m/s (74%)
- 1.0s: ~21 m/s (91%)
- 2.0s: ~22.7 m/s (99%)
- reaches 85% quickly, last 15% is gradual — "feeling the ceiling"

### Speed-Dependent Steering

```
speed_ratio = clamp(abs(fwd_speed) / max_speed, 0.0, 1.0)
effective_steer_rate = steering_speed * lerp(steer_low_speed_mult, steer_high_speed_mult, speed_ratio)
```

| Speed | steer_rate | Turn radius at speed |
|---|---|---|
| 0 m/s | 3.08 rad/s | Tight spin |
| 12 m/s | 2.31 rad/s | Medium arc |
| 23 m/s | 1.54 rad/s | Wide sweeps |

### Grip Transition

```
_grip = move_toward(_grip, target_grip, rate * delta)
target_grip = low_grip_target if drifting else high_grip_target
rate = grip_loss_rate if drifting else grip_recovery_rate
```

**Drift entry** (grip_loss_rate=12): 18.0 → 0.8 in ~1.4 sec (but grip effect kicks in fast)
**Drift exit** (grip_recovery_rate=3): 0.8 → 18.0 in ~5.7 sec (gradual return, feel-first)

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
| Drift at zero speed | Rejected: min_drift_speed check (6 m/s) |
| Drift key held, speed drops below min | Exit drift smoothly (grip recovery begins) |
| Two karts collide head-on at max speed | Both get max push (12.0), bounce apart |
| Kart on steep slope (>50°) | floor_max_angle rejects — kart slides off |
| Kart launched off ramp | Air physics: no steering for 0.15s, gravity applies |
| Kart lands on another kart | move_and_slide handles — push apart |
| Death during drift | Kart stops immediately, enters DEAD state |
| DEAD state | No physics processing at all |
| Remote kart collision | Not simulated locally — server handles, clients interpolate |
| Reverse + drift | Drift disabled in reverse (min_drift_speed not reached in reverse) |
| Frame rate drop (HTML5) | delta-based formulas scale correctly. 30fps = same behavior |
| Micro-steer oscillation near threshold | _was_drifting prevents kick spam — kick fires only on false→true transition |

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
| `max_speed` | 23.0 | 15-35 m/s | Top speed feel | Sluggish | Hard to control |
| `accel_sharpness` | 0.35 | 0.1-0.5 | Acceleration feel | Floaty, slow | Twitchy, instant |
| `brake_decel` | 40.0 | 20-60 m/s² | Brake responsiveness | Can't stop | Jarring stop |
| `coast_decel` | 8.0 | 3-15 m/s² | Coast distance | Rolls forever | Stops instantly |
| `steering_speed` | 2.2 | 1.5-3.5 rad/s | Turn tightness | Can't corner | Spins out |
| `steer_high_speed_mult` | 0.7 | 0.3-1.0 | High-speed handling | Can't steer at speed | No speed penalty |
| `low_grip_target` | 0.8 | 0.1-2.0 | Drift slidiness | Infinite slide | Barely slides |
| `high_grip_target` | 18.0 | 10-25 | Normal grip | Always sliding | No slide ever |
| `grip_loss_rate` | 12.0 | 5-20 /s | Drift entry speed | Slow to enter drift | Instant snap |
| `grip_recovery_rate` | 3.0 | 1-8 /s | Drift exit speed | Slide forever | Snap straight |
| `drift_kick_force` | 4.0 | 3-15 | Rear swing on entry | Subtle slide | Spins out |
| `drift_steer_threshold` | 0.7 | 0.4-0.95 | How aggressive steer triggers drift | Drift triggers too easily | Almost never auto-drifts |
| `mass` | 1.0 | 0.4-3.0 | Collision weight | Gets pushed easily | Immovable |
| `slope_speed_influence` | 8.0 | 3-15 m/s² | Hill impact | Hills meaningless | Hills dominate |

### Knob Interactions

- `max_speed` × `steer_high_speed_mult` = cornering at top speed
- `low_grip_target` × `drift_kick_force` = how extreme drift feels
- `grip_recovery_rate` × `high_grip_target` = how long slide lasts after release
- `mass` × `max_speed` = collision energy = how hard this kart hits others

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

- [ ] Kart accelerates to max_speed asymptotically (reaches 90% within 1s)
- [ ] Kart stops completely when braking from max speed within 1s
- [ ] Steering rate decreases at higher speeds
- [ ] Drift entry: when fwd_speed > min_drift_speed AND abs(steer_input) > drift_steer_threshold — _grip drops, lateral kick applied once on entry
- [ ] No "drift" action required in InputMap
- [ ] Drift exit: _grip recovers gradually (not instant)
- [ ] Kart-to-kart collision: heavier/faster kart pushes lighter/slower
- [ ] Collision push force clamped between min and max
- [ ] Slope: kart accelerates downhill, decelerates uphill
- [ ] Floor alignment: kart tilts to match terrain normal
- [ ] KartPhysicsResource swap changes all physics behavior
- [ ] State Machine: no input processed during DEAD
- [ ] Remote karts do not run physics (only interpolation)

### Network Tests (automated)

- [ ] Position sync at 30 Hz includes velocity for interpolation
- [ ] Remote kart positions are smooth (snapshot buffer, no jitter)
- [ ] Collision results consistent across clients (server-authoritative position)

### Playtest Criteria (human) — CRITICAL for this system

- [ ] Acceleration feels weighty, not instant — you feel the car build speed
- [ ] Drift rear swing is dramatic — clearly visible slide
- [ ] Drift exit is gradual — car settles over ~0.5-1 sec, not instant straighten
- [ ] Counter-steering during drift feels responsive and controllable
- [ ] High-speed turning requires wider arcs — feels like real momentum
- [ ] Kart collision feels physical — lighter kart gets pushed more
- [ ] Driving over hills feels natural — kart follows terrain
- [ ] Overall: "this feels like SmashKarts but with more weight"

## Open Questions

1. **Drift visual direction**: Should drift smoke come from rear tires only,
   or all tires? SmashKarts: rear only.

2. **Drift auto-trigger**: **Resolved**: Auto-drift on sustained steer at speed. No drift button.

3. **Air control**: Currently no steering in air (0.15s lockout). Should there
   be slight air steering for ramp gameplay? Depends on map design.
