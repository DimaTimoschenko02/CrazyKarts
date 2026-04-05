# Weapon System

> **Status**: In Design
> **Author**: Dima + game-designer + godot-specialist + lead-programmer + systems-designer
> **Last Updated**: 2026-04-05
> **Implements Pillar**: Аркадный хаос (grab and shoot), Вариативность (different weapons = different tactics)

## Overview

Weapon System управляет КАК игрок использует оружие: fire modes, ammo, cooldown,
charge mechanic, weapon slot state. Реализуется как WeaponComponent — отдельная нода
(child of kart), аналогично HealthComponent. Все параметры в WeaponResource (.tres).

Три fire mode: INSTANT (нажал → выстрел), CHARGE (зажал → отпустил → бросок
с силой), CONTINUOUS (зажал → луч, отпустил → пауза → можно продолжить).

НЕ управляет: поведением снаряда (Projectile System), подбором оружия (Pickup System).

## Player Fantasy

"Подобрал бокс — у меня ракетница. Нажал пробел — ракета летит. Три выстрела —
оружие кончилось, еду за новым. Подобрал динамит — зажал пробел, чувствую как
нарастает сила броска. Отпустил — динамит летит по дуге, далеко. Подобрал лазер —
зажал — луч прожигает врага, отпустил, подождал, дострелял."

## Detailed Design

### Core Rules

1. WeaponComponent — Node, child of kart (scene-placed in editor)
2. One weapon slot at MVP (future: 2 slots)
3. All params from WeaponResource (@export) — no hardcoded values
4. Server-authoritative: client sends fire request, server validates + executes
5. Ammo is finite per pickup — weapon goes EMPTY when ammo depleted
6. New pickup always replaces current weapon (from Pickup System GDD)
7. Death clears weapon (EMPTY state, from State Machine GDD)
8. Charge accumulation on client, validated by server on release
9. Laser hitscan lives entirely in WeaponComponent (no projectile node)

### WeaponResource

```gdscript
class_name WeaponResource extends Resource

enum FireMode { INSTANT, CHARGE, CONTINUOUS }

@export_group("Identity")
@export var weapon_name: String = ""
@export var icon: Texture2D
@export var visual_scene: PackedScene    # weapon model on kart

@export_group("Firing")
@export var fire_mode: FireMode = FireMode.INSTANT
@export var ammo: int = 3               # shots (INSTANT/CHARGE) or bursts (CONTINUOUS)
@export var fire_rate: float = 1.2      # COOLDOWN duration between shots
@export var fire_anim_duration: float = 0.2  # FIRING state duration

@export_group("Projectile")
@export var projectile_resource: ProjectileResource  # null = hitscan (laser)
@export var projectile_count: int = 1   # shotgun = 7
@export var spread_angle: float = 0.0   # half-angle degrees (shotgun = 9)

@export_group("Charge (CHARGE mode only)")
@export var charge_time_max: float = 1.5   # max hold time
@export var charge_min_power: float = 0.2  # min hold to fire (ratio)
@export var charge_min_speed: float = 10.0 # projectile speed at min charge
@export var charge_max_speed: float = 35.0 # projectile speed at max charge

@export_group("Continuous (CONTINUOUS mode only)")
@export var beam_tick_rate: float = 6.0    # Hz
@export var beam_max_range: float = 20.0   # meters
@export var beam_damage_per_tick: int = 8
@export var beam_burst_duration: float = 3.0  # seconds per burst
@export var beam_release_cooldown: float = 0.3  # pause after releasing trigger
```

### Weapon Definitions

| Weapon | FireMode | Ammo | Fire Rate | Special |
|--------|----------|------|-----------|---------|
| Rocket Launcher | INSTANT | 3 shots | 1.2s | 1 projectile |
| Shotgun | INSTANT | 4 bursts | 0.9s | 7 pellets, 9° spread |
| Mine | INSTANT | 2 mines | 1.5s | Drop behind kart |
| Dynamite | CHARGE | 1 throw | 1.8s | Hold = farther throw, arc |
| Laser | CONTINUOUS | 2 bursts | 0.3s release cd | 3s beam, 6Hz tick, hitscan |

### WeaponComponent Architecture

```
KartController (CharacterBody3D)
├── HealthComponent (Node)
├── WeaponComponent (Node + weapon_component.gd)
│   └── WeaponSocket (Node3D — weapon visual attachment point)
│       └── [dynamic] weapon model instance
└── ...
```

**Public API:**
```gdscript
class_name WeaponComponent extends Node

signal weapon_state_changed(from: int, to: int)
signal weapon_fired(weapon: WeaponResource)
signal weapon_emptied()

func equip_weapon(weapon_res: WeaponResource) -> void
func request_fire() -> void        # called on fire press
func release_fire() -> void        # called on fire release
func get_state() -> WeaponState
func has_weapon() -> bool
func get_current_weapon() -> WeaponResource
```

**Internal state:**
```gdscript
var _weapon: WeaponResource = null
var _state: WeaponState = WeaponState.EMPTY
var _current_ammo: int = 0
var _charge_timer: float = 0.0        # CHARGE mode: time held
var _beam_remaining: float = 0.0      # CONTINUOUS mode: seconds left in burst
var _cooldown_timer: float = 0.0      # time remaining in COOLDOWN
```

### Fire Mode Dispatch

```gdscript
func _execute_fire(charge_ratio: float = 0.0) -> void:
    if not multiplayer.is_server(): return
    match _weapon.fire_mode:
        WeaponResource.FireMode.INSTANT:
            _fire_instant()
        WeaponResource.FireMode.CHARGE:
            _fire_charge(charge_ratio)
        WeaponResource.FireMode.CONTINUOUS:
            _fire_continuous_start()
```

### INSTANT Fire Flow

```
Client: press fire → request_fire() → _rpc_request_fire.rpc_id(1)
Server: validate (ARMED? ammo>0? kart not DEAD?) → execute
Server: spawn projectile(s) via _rpc_spawn_projectile.rpc()
Server: _current_ammo -= 1
Server: state → FIRING (fire_anim_duration) → COOLDOWN (fire_rate) → ARMED or EMPTY
```

### CHARGE Fire Flow

```
Client: press fire → _charge_timer = 0, start accumulating
Client: hold fire → _charge_timer += delta (in _process)
Client: _charge_timer >= charge_time_max → auto-fire at max power
Client: release fire → charge_ratio = clamp(_charge_timer / charge_time_max, 0, 1)
Client: if charge_ratio >= charge_min_power → _rpc_request_charge_fire.rpc_id(1, charge_ratio)
Server: validate + clamp charge_ratio to [0, 1]
Server: launch_speed = lerp(charge_min_speed, charge_max_speed, charge_ratio)
Server: spawn projectile with calculated speed + gravity
Server: _current_ammo -= 1 → FIRING → COOLDOWN → ARMED or EMPTY
```

**Charge affects speed only** (user decision). Damage and AOE radius are fixed per weapon.

### CONTINUOUS Fire Flow (Laser)

```
Client: press fire → _rpc_request_beam_start.rpc_id(1)
Server: validate → state = FIRING, start beam
Server: every 1/tick_rate seconds → raycast, apply damage tick
Server: _rpc_beam_update.rpc(origin, hit_point) → clients draw beam visual
Server: beam_remaining -= delta

Client: release fire → _rpc_request_beam_stop.rpc_id(1)
Server: state = COOLDOWN (beam_release_cooldown = 0.3s) → ARMED (if ammo left)

Server: beam_remaining <= 0 → burst depleted
Server: _current_ammo -= 1 → COOLDOWN → ARMED (if ammo) or EMPTY
```

**Releasing trigger pauses ammo drain.** Player can fire in bursts to conserve.
Short cooldown (0.3s) prevents instant re-fire (no tap-spam exploit).

### Laser Hitscan Implementation

No projectile node. WeaponComponent owns the raycast:

```gdscript
func _fire_beam_tick() -> void:
    if not multiplayer.is_server(): return
    var space := get_world_3d().direct_space_state
    var from := _get_muzzle_position()
    var to := from + _get_aim_direction() * _weapon.beam_max_range
    var query := PhysicsRayQueryParameters3D.create(from, to)
    query.collision_mask = 0b011  # world + karts
    query.exclude = [_kart_rid]
    var result := space.intersect_ray(query)
    if result and result.collider.is_in_group("karts"):
        var info := DamageInfo.new()
        info.type = DamageInfo.Type.PROJECTILE
        info.amount = _weapon.beam_damage_per_tick
        info.attacker_id = _kart.player_id
        info.weapon_name = _weapon.weapon_name
        info.position = result.position
        result.collider.health_component.apply_damage(info)
    _rpc_beam_update.rpc(from, result.position if result else to)
```

Visual beam on clients: MeshInstance3D stretched between origin and hit_point.
Tween fade on beam stop.

### Weapon Visual on Kart

WeaponSocket (Node3D) on kart — fixed attachment point. On equip:
```gdscript
func _update_visual() -> void:
    for child in _weapon_socket.get_children():
        child.queue_free()
    if _weapon and _weapon.visual_scene:
        var model := _weapon.visual_scene.instantiate()
        _weapon_socket.add_child(model)
```

Replaces current launcher_visual.gd (specific to missiles).

### State Machine Integration

WeaponComponent uses WeaponState enum from State Machine GDD:

| State | Enter condition | Exit condition |
|-------|----------------|----------------|
| EMPTY | No weapon / ammo depleted / death | Pickup collected |
| ARMED | Weapon equipped, ammo > 0 | Fire input |
| FIRING | Fire validated by server | fire_anim_duration expires |
| COOLDOWN | FIRING duration complete | fire_rate expires |

Cross-domain (from State Machine GDD):
- Kart DEAD → WeaponComponent clears weapon (EMPTY)
- Kart DEAD → block fire input (WeaponComponent checks kart state)
- Match ENDED → all weapons EMPTY

### Network RPCs

| RPC | Direction | Reliability | Data |
|-----|-----------|-------------|------|
| `_rpc_request_fire` | C→S | reliable | — (INSTANT) |
| `_rpc_request_charge_fire` | C→S | reliable | charge_ratio: float |
| `_rpc_request_beam_start` | C→S | reliable | — |
| `_rpc_request_beam_stop` | C→S | reliable | — |
| `_rpc_spawn_projectile` | S→all | reliable | type, shooter_id, pos, dir, speed |
| `_rpc_beam_update` | S→all | unreliable | origin: Vec3, hit_point: Vec3 |
| `_rpc_equip_weapon` | S→all | reliable | weapon_path: String |
| `_rpc_weapon_emptied` | S→all | reliable | — |

### Interactions with Other Systems

| System | Direction | Interface |
|--------|-----------|-----------|
| **State Machine** | ← reads | KartState gates fire input; WeaponState tracks slot |
| **State Machine** | → triggers | Fire changes WeaponState (ARMED→FIRING→COOLDOWN) |
| **Pickup System** | ← receives | `equip_weapon(WeaponResource)` on collection |
| **Projectile System** | → spawns | `_rpc_spawn_projectile` for INSTANT/CHARGE modes |
| **Health & Damage** | → delivers | Laser beam tick → DamageInfo → apply_damage() |
| **Network Layer** | → uses | RPCs for fire request, projectile spawn, beam sync |
| **Kart Physics** | ← reads | Kart position/direction for muzzle point and aim |
| **HUD** | → feeds | Weapon icon, ammo count, charge bar |
| **VFX System** | → feeds | Muzzle flash, beam visual, charge glow |
| **Audio System** | → feeds | Fire SFX, charge buildup, beam hum |
| **Camera System** | → feeds | Screen shake on fire (from Camera GDD) |

## Formulas

### Ammo Depletion

```
# INSTANT / CHARGE: discrete
_current_ammo -= 1  # per shot

# CONTINUOUS: time-based
_beam_remaining -= delta  # while beam active
# burst depleted when _beam_remaining <= 0 → _current_ammo -= 1
```

### Charge Power

```
charge_ratio = clamp(hold_time / charge_time_max, 0.0, 1.0)
launch_speed = lerp(charge_min_speed, charge_max_speed, charge_ratio)
# Damage: fixed (not scaled by charge)
# AOE radius: fixed (not scaled by charge)
```

| Charge | hold_time | launch_speed | Range (approx) |
|--------|-----------|-------------|-----------------|
| Tap | 0.3s | 13.3 m/s | ~5m arc |
| Half | 0.75s | 22.5 m/s | ~15m arc |
| Full | 1.5s | 35.0 m/s | ~28m arc |

### Laser DPS

```
DPS = beam_damage_per_tick * beam_tick_rate = 8 * 6 = 48
TTK vs Standard (100 HP) = 100 / 48 = 2.08s
Total damage per burst = DPS * burst_duration = 48 * 3 = 144
Total damage per pickup = 144 * ammo_bursts = 144 * 2 = 288
```

### Server Fire Rate Validation

```
time_since_last_fire = now - _last_fire_time
valid = time_since_last_fire >= weapon.fire_rate * 0.8  # 20% tolerance
```

### Weapon Power Budget (expected kills per pickup)

| Weapon | Ammo | Dmg/shot (avg) | Hit rate | Expected kills |
|--------|------|---------------|----------|----------------|
| Rocket | 3 | 28 (AOE avg) | 55% | 0.46 |
| Shotgun | 4 | 35 (burst avg) | 45% | 0.63 |
| Mine | 2 | 42 (AOE avg) | 40% | 0.34 |
| Dynamite | 1 | 50 (fixed) | 50% | 0.25 |
| Laser | 2 bursts | 144/burst | 65% | 1.87 |

Laser highest value — compensated by 10% pool weight (rarest drop).

## Edge Cases

| Scenario | Resolution |
|---|---|
| Fire while DEAD | Rejected by WeaponComponent (checks kart state) |
| Fire while COOLDOWN | Rejected (1 tick buffer from State Machine GDD) |
| Fire while EMPTY | Rejected (no weapon) |
| Charge release below min_power | No fire, reset charge timer |
| Charge held past max time | Auto-fire at max power |
| Beam tick with no target in range | Beam visual shows full range, no damage |
| Beam target enters INVULNERABLE | DamageInfo rejected by HealthComponent |
| Pickup during FIRING | FIRING completes normally, then weapon swapped |
| Pickup during CHARGE | Cancel charge, equip new weapon |
| Pickup during beam | Stop beam, equip new weapon |
| Death during FIRING | Projectile already spawned (completes). Weapon → EMPTY |
| Death during CHARGE | Cancel charge, no fire. Weapon → EMPTY |
| Death during beam | Beam stops immediately. Weapon → EMPTY |
| Client sends charge_ratio > 1.0 | Server clamps to [0, 1] |
| Client sends fire request while server thinks COOLDOWN | Rejected, log warning |
| Two fire requests same frame | First processed, second rejected |
| Ammo = 0 after shot | COOLDOWN → EMPTY (skip ARMED) |
| Late join: player has weapon | World state includes equipped weapon per kart |

## Dependencies

### Upstream

| System | Dependency | Type |
|---|---|---|
| **Pickup System** | Delivers WeaponResource via receive_pickup() | Hard |
| **Projectile System** | Spawns projectiles for INSTANT/CHARGE | Hard |
| **Kart Physics** | Position/direction for aim | Hard |
| **State Machine** | KartState + WeaponState | Hard |
| **Network Layer** | RPCs | Hard |
| **Health & Damage** | DamageInfo for laser beam | Hard |

### Downstream

| System | What it needs |
|---|---|
| **HUD** | Weapon icon, ammo, charge bar |
| **VFX System** | Muzzle flash, beam, charge glow |
| **Audio System** | Fire SFX, charge, beam hum |
| **Camera System** | Shake trigger on fire |
| **Analytics** | weapon_fired events |

### Interface Contract

- `WeaponComponent.equip_weapon(res)` — only entry point from Pickup System
- `request_fire()` / `release_fire()` — only input interface
- Server validates everything — client cannot force fire
- Projectile spawn delegated to Projectile System via RPC

## Tuning Knobs

| Knob | Default | Safe Range | Affects |
|------|---------|------------|---------|
| `rocket_ammo` | 3 | 2-5 | Pickup value |
| `rocket_fire_rate` | 1.2s | 0.8-2.0 | DPS |
| `shotgun_ammo` | 4 | 2-6 | Burst economy |
| `shotgun_fire_rate` | 0.9s | 0.5-1.5 | Burst speed |
| `shotgun_pellet_count` | 7 | 5-12 | Spread density |
| `mine_ammo` | 2 | 1-3 | Area denial |
| `mine_fire_rate` | 1.5s | 0.8-2.5 | Drop speed |
| `dynamite_ammo` | 1 | 1-3 | Uses per pickup |
| `dynamite_charge_max` | 1.5s | 0.8-2.5 | Skill ceiling |
| `dynamite_min_speed` | 10 m/s | 6-16 | Min range |
| `dynamite_max_speed` | 35 m/s | 20-50 | Max range |
| `laser_ammo_bursts` | 2 | 1-3 | Total beam time |
| `laser_burst_duration` | 3.0s | 1.5-4.0 | Per-burst time |
| `laser_release_cooldown` | 0.3s | 0.1-0.5 | Tap prevention |
| `laser_tick_rate` | 6 Hz | 4-10 | DPS granularity |
| `laser_damage_per_tick` | 8 | 4-12 | DPS |

### Knob Interactions
- `laser_tick_rate` × `laser_damage_per_tick` = DPS
- `laser_burst_duration` × `laser_ammo_bursts` = total beam time
- `dynamite_charge_max` × `dynamite_max_speed` = max throw distance
- `ammo` × `fire_rate` = weapon hold duration

## Visual/Audio Requirements

| Event | Visual | Audio |
|-------|--------|-------|
| Weapon equipped | Model appears on kart, HUD icon updates | Equip click SFX |
| INSTANT fire | Muzzle flash | Weapon-specific fire SFX |
| CHARGE start | Charge glow builds on weapon model | Charge buildup rising tone |
| CHARGE release | Bright flash + throw animation | Throw whoosh SFX |
| CHARGE auto-fire (max) | Extra flash | Max charge ding + throw |
| Beam start | Laser beam appears (MeshInstance3D) | Beam hum starts |
| Beam active | Beam tracks aim direction | Continuous hum, hit sparks |
| Beam stop | Beam fades (Tween) | Hum stops |
| Ammo depleted | Weapon model disappears | Empty click SFX |

## UI Requirements

| Element | Location | Updates |
|---------|----------|---------|
| Weapon icon | HUD weapon slot | On equip/empty |
| Ammo counter | Next to weapon icon | On each shot |
| Charge bar | Below weapon icon | During CHARGE hold (fill animation) |
| Beam ammo bar | Below weapon icon | During CONTINUOUS fire (drain animation) |

Owned by HUD, fed by WeaponComponent signals.

## Acceptance Criteria

### Functional Tests (automated)

- [ ] INSTANT fire: press → projectile spawned, ammo decremented
- [ ] INSTANT fire: ammo 0 → weapon EMPTY
- [ ] CHARGE fire: hold < min_power → no fire
- [ ] CHARGE fire: hold full → auto-fire at max speed
- [ ] CHARGE fire: release mid-charge → fire at proportional speed
- [ ] CONTINUOUS fire: hold → beam ticks damage at tick_rate
- [ ] CONTINUOUS fire: release → 0.3s cooldown → ARMED
- [ ] CONTINUOUS fire: burst depleted → ammo -1 → ARMED or EMPTY
- [ ] Equip weapon: old weapon replaced, ammo reset
- [ ] Death: weapon cleared (EMPTY)
- [ ] DEAD: fire rejected
- [ ] Server validates all fire requests
- [ ] Charge value clamped server-side
- [ ] Laser raycast hits karts within range
- [ ] Laser raycast stops at walls

### Network Tests

- [ ] Fire request RPC reaches server
- [ ] Projectile spawn RPC reaches all clients
- [ ] Beam update RPC updates visual on all clients
- [ ] Late join: new player sees other players' equipped weapons

### Playtest Criteria (human)

- [ ] Rocket feels satisfying to fire (instant, responsive)
- [ ] Shotgun feels punchy at close range
- [ ] Mine drop feels tactical (behind kart)
- [ ] Dynamite charge feels responsive — power builds visibly
- [ ] Laser beam tracking feels smooth and connected
- [ ] Weapon swap on pickup is instant, no delay
- [ ] Running out of ammo is clear (empty click, icon gone)

## Open Questions

1. **HUD charge bar**: Linear fill or easing? Should it pulse at max charge
   to signal "fire now"?

2. **Weapon drop on death**: Currently weapon vanishes. Future: drop as temporary
   pickup (like SmashKarts). Adds chaos. Defer to Alpha.

3. **Two weapon slots**: WeaponComponent designed as single node. For 2 slots:
   add second WeaponComponent + slot switching input. Defer to Alpha.

4. **Dynamite self-damage**: Uses AOE from Projectile System. Self-damage = yes
   (same as rocket). Arc means skilled players can avoid, careless ones get hurt.
