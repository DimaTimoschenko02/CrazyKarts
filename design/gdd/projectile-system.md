# Projectile System

> **Status**: In Design
> **Author**: Dima + game-designer + godot-specialist + lead-programmer + systems-designer
> **Last Updated**: 2026-04-05
> **Implements Pillar**: Аркадный хаос (shoot, explode, chaos), Вариативность (different projectile behaviors)

## Overview

Projectile System управляет поведением снарядов после выстрела: движение, коллизия,
урон при попадании, lifetime, AOE взрыв. BaseProjectile extends Area3D — общий
базовый класс для rocket, mine, shotgun pellet. Лазер — NOT a projectile (hitscan
raycast, живёт в Weapon System).

Каждый тип снаряда = ProjectileResource (.tres) + сцена + скрипт-наследник.
Добавление нового снаряда = новый .tres + .tscn + скрипт, без изменения базового кода.

## Player Fantasy

"Я выстрелил ракетой — она летит и взрывается красиво. Бросил мину — она ждёт
жертву. Выстрелил из дробовика — облако пуль разлетается веером. Каждое оружие
ощущается по-разному, но все понятны с первого раза."

## Detailed Design

### Core Rules

1. BaseProjectile extends Area3D — shared base for all physical projectiles
2. Laser is NOT a projectile — it's a hitscan query (Weapon System scope)
3. Server spawns all projectiles via RPC, clients create visual mirror copies
4. Damage calculated ONLY on server (`multiplayer.is_server()`)
5. Projectile creates DamageInfo and calls `target.health_component.apply_damage()` directly
6. Projectiles do NOT collide with each other (collision mask excludes Layer 3)
7. Self-damage: rockets yes (skill expression), mines no (ignore placer_id)
8. All params from ProjectileResource (@export) — no hardcoded values
9. No object pooling at MVP (max ~40 active, HTML5 handles it)
10. Deterministic movement — all clients run same physics, no position sync needed for moving projectiles

### ProjectileResource

```gdscript
class_name ProjectileResource extends Resource

@export_group("Movement")
@export var speed: float = 28.0          # m/s (0 = stationary, e.g. mine)
@export var lifetime: float = 3.5        # seconds
@export var gravity_scale: float = 0.0   # 0 = straight line, >0 = arc/drop

@export_group("Damage")
@export var base_damage: int = 40
@export var aoe_radius: float = 3.5      # 0 = point damage (pellet), >0 = AOE
@export var self_damage: bool = true     # can hurt shooter?

@export_group("Behavior")
@export var weapon_name: String = ""     # for DamageInfo analytics
@export var projectile_scene: PackedScene # scene to instantiate
```

### BaseProjectile Class

```gdscript
class_name BaseProjectile extends Area3D

var config: ProjectileResource
var shooter_id: int = 0
var direction: Vector3 = Vector3.FORWARD
var _age: float = 0.0
var _dead: bool = false

func setup(proj_config: ProjectileResource, shooter: int, dir: Vector3) -> void:
    config = proj_config
    shooter_id = shooter
    direction = dir.normalized()

func _physics_process(delta: float) -> void:
    if _dead: return
    _age += delta
    if _age >= config.lifetime:
        _on_lifetime_expired()
        return
    _move(delta)

# Virtual methods for subclasses
func _move(delta: float) -> void:
    global_position += direction * config.speed * delta

func _on_hit(body: Node3D) -> void:
    pass  # override in subclass

func _on_lifetime_expired() -> void:
    _die()

func _die() -> void:
    if _dead: return
    _dead = true
    set_physics_process(false)
    set_deferred("monitoring", false)
    queue_free()

func _apply_aoe_damage(center: Vector3) -> void:
    if not multiplayer.is_server(): return
    for kart in get_tree().get_nodes_in_group("karts"):
        if not config.self_damage and kart.player_id == shooter_id:
            continue
        var dist := center.distance_to(kart.global_position)
        if dist > config.aoe_radius: continue
        var falloff := max(0.0, 1.0 - dist / config.aoe_radius)
        var final_dmg := int(config.base_damage * falloff)
        if final_dmg <= 0: continue
        var info := DamageInfo.new()
        info.type = DamageInfo.Type.AOE_EXPLOSION
        info.amount = final_dmg
        info.attacker_id = shooter_id
        info.weapon_name = config.weapon_name
        info.position = center
        kart.health_component.apply_damage(info)

func _apply_point_damage(target: Node3D) -> void:
    if not multiplayer.is_server(): return
    var info := DamageInfo.new()
    info.type = DamageInfo.Type.PROJECTILE
    info.amount = config.base_damage
    info.attacker_id = shooter_id
    info.weapon_name = config.weapon_name
    info.position = global_position
    target.health_component.apply_damage(info)
```

### Projectile Types

#### Rocket (RocketProjectile extends BaseProjectile)

| Property | Value |
|---|---|
| Speed | 28 m/s |
| Lifetime | 3.5s |
| base_damage | 40 |
| AOE radius | 3.5m (linear falloff) |
| Self-damage | Yes |
| Gravity | 0 (straight line) |

**Behavior**: Flies forward. On `body_entered` (wall or kart) → AOE explosion.
On lifetime expire → AOE explosion at current position.

```gdscript
# rocket_projectile.gd
func _on_hit(body: Node3D) -> void:
    if body.is_in_group("karts") and body.player_id == shooter_id and _age < 0.1:
        return  # skip self-collision on launch
    _apply_aoe_damage(global_position)
    exploded.emit(global_position)
    _die()

func _on_lifetime_expired() -> void:
    _apply_aoe_damage(global_position)
    exploded.emit(global_position)
    _die()
```

#### Shotgun Pellet (ShotgunPellet extends BaseProjectile)

| Property | Value |
|---|---|
| Speed | 22 m/s |
| Lifetime | 0.55s (max range ~12m) |
| Pellet count | 7 (1 center + 6 ring) |
| Spread half-angle | 9° |
| base_damage per pellet | 8 (total burst: 56 if all hit) |
| AOE radius | 0 (point damage) |
| Self-damage | No |
| Range falloff | Linear: `damage * (1 - dist/max_range)` |

**Behavior**: Multiple pellets spawned simultaneously with spread pattern.
Each pellet is a separate Area3D. On `body_entered` (kart) → point damage.
On wall hit or lifetime → disappear.

**Spread pattern** (server calculates, spawns all):
```
pellet_dirs[0] = forward (center)
for i in 6:
    pellet_dirs[i+1] = forward.rotated(up, (i * TAU/6) + randf()*0.1)
                        .slerp(forward, 1.0 - tan(deg_to_rad(9)))
```

#### Mine (MineProjectile extends BaseProjectile)

| Property | Value |
|---|---|
| Speed | 0 (stationary after placement) |
| Lifetime | 45s |
| base_damage | 60 |
| AOE radius | 3.5m (linear falloff) |
| Self-damage | No (ignore placer_id) |
| Detection radius | 2.5m |
| Arm delay | 1.5s (prevents instant self-detonation) |
| Detonation delay | 0.15s (visual telegraph) |

**Behavior**: Drops behind kart, raycasts down to ground. Sits stationary.
After arm_delay, `monitoring = true`. When kart enters detection radius →
0.15s detonation delay → AOE explosion.

```gdscript
# mine_projectile.gd
var _armed: bool = false

func _move(delta: float) -> void:
    pass  # stationary

func _physics_process(delta: float) -> void:
    super(delta)
    if not _armed and _age >= ARM_DELAY:
        _armed = true
        monitoring = true

func _on_hit(body: Node3D) -> void:
    if not _armed: return
    if body.is_in_group("karts"):
        # detonation delay
        await get_tree().create_timer(DETONATION_DELAY).timeout
        _apply_aoe_damage(global_position)
        exploded.emit(global_position)
        _die()
```

#### Laser (NOT a projectile — documented here for reference)

Lives in Weapon System. Hitscan via `PhysicsDirectSpaceState3D.intersect_ray()`.

| Property | Value |
|---|---|
| Speed | Instant (hitscan) |
| Damage per tick | 8 |
| Tick rate | 6 Hz |
| DPS | 48 |
| Max range | 20m |
| Beam duration | While trigger held, max 3s burst |
| Self-damage | No |

Visual: MeshInstance3D beam stretched to hit point. Tween fade on release.

### Collision Layers

| Layer | Contents | Projectile Mask |
|-------|----------|-----------------|
| 1 | World geometry | Yes — rockets/pellets hit walls |
| 2 | Karts | Yes — all projectiles detect karts |
| 3 | Projectiles | No — projectiles ignore each other |
| 4 | Pickups | No |

Mines: mask only Layer 2 (karts). They sit on ground, don't collide with walls.

### Network Authority

**Server spawns, all simulate, server damages:**

```
1. Client presses fire → _rpc_request_fire.rpc_id(1)
2. Server validates (cooldown, state, ammo)
3. Server: _rpc_spawn_projectile.rpc(type, shooter_id, pos, dir)
4. All peers: instantiate scene, run _physics_process locally
5. On collision (server only): apply_damage via DamageInfo
6. On explosion: _rpc_explode.rpc(pos) for VFX on all clients
```

Moving projectiles (rockets, pellets): deterministic movement, no position sync.
Static projectiles (mines): one RPC with position on spawn, no further sync.

### Interactions with Other Systems

| System | Direction | Interface |
|--------|-----------|-----------|
| **Health & Damage** | → delivers | DamageInfo via apply_damage() on hit |
| **Network Layer** | → uses | RPC for spawn, explode |
| **Kart Physics** | ← reads | Kart position/velocity at fire time (spawn point, direction) |
| **Weapon System** | ← created by | Weapon triggers projectile spawn |
| **VFX System** | → feeds | `exploded` signal for explosion effects |
| **Audio System** | → feeds | `exploded` signal for explosion SFX, launch SFX on spawn |
| **State Machine** | — | No direct interaction (Health & Damage checks state) |

## Formulas

### AOE Falloff (shared, from Health & Damage GDD)

```
aoe_damage = floor(base_damage * max(0.0, 1.0 - distance / aoe_radius))
```

### Shotgun Spread

```
pellet_dir[0] = forward                          # center pellet
pellet_dir[i] = forward.rotated(up, i * TAU/6)   # 6 ring pellets
                .slerp(forward, cos(spread_half_angle))

max_range = speed * lifetime = 22 * 0.55 = 12.1m
damage_at_dist = base_damage * max(0.0, 1.0 - dist / max_range)
```

### Mine Detection

```
is_triggered = distance(mine, kart) <= detection_radius AND _armed
detonation_time = trigger_time + detonation_delay
```

### TTK Verification

| Weapon | Projectile | vs Standard (100 HP) | Target 2-4s? |
|--------|-----------|---------------------|-------------|
| Rocket | RocketProjectile | 2.5s (3 direct hits) | Yes |
| Shotgun | 7× ShotgunPellet | 1.5s (2 bursts, close range) | Yes* |
| Mine | MineProjectile | Instant (1 mine = 60 dmg) | Situational |
| Laser | Hitscan (no projectile) | 2.1s continuous | Yes |

*Shotgun 1.5s is below 2s floor but requires point-blank range (0-6m).

## Edge Cases

| Scenario | Resolution |
|---|---|
| Rocket hits shooter on launch | Ignored for first 0.1s (_age < 0.1 check) |
| Mine placed, placer drives over it | Ignored (self_damage = false, ignore placer_id) |
| Mine placed, placer disconnects | Mine persists, can hurt others. placer_id invalid = environment kill |
| Two rockets hit same kart same frame | Both process — Health & Damage handles sequential damage |
| Shotgun pellets hit multiple karts | Each pellet damages independently |
| Projectile hits DEAD kart | Health & Damage rejects (HP already 0) |
| Projectile flies off map | Lifetime expires → queue_free |
| Mine arm_delay interrupted by lifetime | Should not happen (arm_delay 1.5s << lifetime 45s) |
| Explosion during match ENDED | Damage still applies (match end processes after physics) |
| Client desynced projectile position | Visual only — damage is server-side, position irrelevant |
| Max projectiles on screen | ~40 at peak. No pooling needed, queue_free sufficient |

## Dependencies

### Upstream

| System | Dependency | Type |
|---|---|---|
| **Network Layer** | RPC for spawn/explode | Hard |
| **Health & Damage** | DamageInfo + apply_damage | Hard |
| **Kart Physics** | Position/direction at fire time | Hard |

### Downstream

| System | What it needs |
|---|---|
| **Weapon System** | Calls projectile spawn, provides config |
| **VFX System** | `exploded` signal for effects |
| **Audio System** | Launch and explosion sounds |

### Interface Contract

- Weapon System creates projectile via `_rpc_spawn_projectile.rpc(type, shooter_id, pos, dir)`
- Projectile self-manages: movement, collision, damage, cleanup
- `exploded` signal is the only output for VFX/Audio
- No external system calls methods on a projectile after spawn

## Tuning Knobs

| Knob | Default | Safe Range | Affects |
|------|---------|------------|---------|
| `rocket_speed` | 28 m/s | 15-45 | Dodge difficulty |
| `rocket_lifetime` | 3.5s | 2.0-6.0 | Max range |
| `rocket_damage` | 40 | 20-60 | TTK |
| `rocket_aoe_radius` | 3.5m | 2.0-5.0 | Splash area |
| `pellet_count` | 7 | 5-12 | Spread density |
| `pellet_spread_angle` | 9° | 5-15° | Cone width |
| `pellet_damage` | 8 | 5-12 | Per-pellet TTK |
| `pellet_speed` | 22 m/s | 15-30 | Effective range |
| `pellet_lifetime` | 0.55s | 0.3-1.0 | Max range |
| `mine_damage` | 60 | 30-80 | Lethality |
| `mine_lifetime` | 45s | 20-90 | Map control duration |
| `mine_detection_radius` | 2.5m | 1.5-4.0 | Trigger sensitivity |
| `mine_arm_delay` | 1.5s | 0.5-3.0 | Drop-and-trigger prevention |
| `mine_detonation_delay` | 0.15s | 0.1-0.5 | Reaction window |

### Knob Interactions

- `rocket_speed` × `rocket_lifetime` = max range (28 × 3.5 = 98m, covers arena)
- `pellet_speed` × `pellet_lifetime` = effective range (22 × 0.55 = 12m)
- `mine_detection_radius` must be < `mine_aoe_radius` (trigger inside blast zone)
- `rocket_damage` × `rocket_aoe_radius` = splash pressure (both amplify AOE threat)

## Visual/Audio Requirements

| Event | Visual | Audio |
|-------|--------|-------|
| Rocket launch | Muzzle flash, smoke trail | Rocket whoosh SFX |
| Rocket flight | Smoke trail particle | — |
| Rocket explosion | Explosion VFX (radius-matched) | Explosion SFX |
| Shotgun fire | Muzzle flash, spread lines | Shotgun blast SFX |
| Pellet hit | Spark VFX at impact | Metal ping SFX |
| Mine drop | Mine model appears on ground | Drop thud SFX |
| Mine arm | Blinking red light activates | Arm beep SFX |
| Mine detonation | 0.15s warning flash → explosion VFX | Warning beep → explosion SFX |

## UI Requirements

No UI owned by Projectile System. Damage numbers owned by HUD (via Health & Damage signals).

## Acceptance Criteria

### Functional Tests (automated)

- [ ] Rocket moves at configured speed in configured direction
- [ ] Rocket explodes on kart collision with AOE damage (linear falloff)
- [ ] Rocket explodes on wall collision
- [ ] Rocket explodes on lifetime expire
- [ ] Rocket self-damage applies to shooter in AOE
- [ ] Shotgun spawns correct pellet count with spread pattern
- [ ] Pellet deals point damage on kart hit, no AOE
- [ ] Pellet disappears on wall hit or lifetime
- [ ] Mine drops at ground level behind kart
- [ ] Mine arms after arm_delay (monitoring activates)
- [ ] Mine detonates with delay when kart enters detection radius
- [ ] Mine ignores placer (no self-damage)
- [ ] Mine persists for full lifetime if not triggered
- [ ] All damage goes through DamageInfo → HealthComponent.apply_damage()
- [ ] Projectiles do not collide with each other
- [ ] Server-only damage (client projectiles are visual only)

### Playtest Criteria (human)

- [ ] Rocket feels satisfying — speed, trail, explosion all read clearly
- [ ] Shotgun feels punchy at close range, useless at distance
- [ ] Mine is visible enough to avoid if paying attention
- [ ] Mine detonation telegraph (0.15s) is noticeable but brief
- [ ] No projectile-related lag with 10 players firing simultaneously

## Open Questions

1. **Rocket speed**: Current code has SPEED=45, design says 28. The 45 might
   feel better in practice — needs playtest. 28 is calculated for dodge window.

2. **Shotgun pellet implementation**: 7 separate Area3D nodes per shot = 7 × 10
   players = 70 nodes in worst case. Performance ok? Alternative: single raycast
   cone check (cheaper, same result).

3. **Mine limit per player**: Should there be a max mines per player? (e.g., 3)
   Otherwise a player could mine-carpet the arena.

4. **Projectile visual on remote clients**: Deterministic movement means
   clients show correct position. But on high latency, explosions may appear
   at slightly wrong time. Acceptable for friends game?

5. **Future: bouncing projectiles**: BaseProjectile has no bounce_count
   implementation yet. Add when a bouncing weapon is designed.
