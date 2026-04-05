# Pickup System

> **Status**: In Design
> **Author**: Dima + game-designer + godot-specialist + lead-programmer
> **Last Updated**: 2026-04-05
> **Implements Pillar**: Аркадный хаос (grab weapon, shoot immediately), Вариативность (random weapons change tactics)

## Overview

Pickup System управляет ЧТО ПРОИСХОДИТ когда игрок наезжает на бокс: обнаружение
коллизии, выбор предмета из weighted pool, выдача карту, visual feedback. Pickup
boxes — self-managed Area3D ноды с собственным respawn timer (из Spawn System GDD).

Два типа боксов: WeaponPickup (оружие) и PowerupPickup (бафы). Оба наследуют
BasePickup. Каждый бокс содержит PickupPoolResource — .tres файл с weighted list
предметов. Добавление нового оружия в пул = редактирование .tres, zero code.

## Player Fantasy

"Еду по карте — вижу светящийся бокс. Подбираю — бам, у меня ракетница! Или
дробовик. Или мина. Каждый раз сюрприз. Если у меня уже есть оружие — новое
заменяет старое. Решение за секунду: подбирать или нет?"

## Detailed Design

### Core Rules

1. BasePickup extends Area3D — shared base for weapon and powerup pickups
2. Server-authoritative: server detects collision, picks item, broadcasts result
3. One atomic RPC per collection (`_rpc_collected`) — not two separate calls
4. Player has 1 weapon slot + 1 powerup slot (from game-concept)
5. Pickup while armed: ALWAYS replace current weapon/powerup
6. Simultaneous collection: server processes sequentially, first wins
7. Random item from weighted PickupPoolResource
8. Visual states: Active (rotating, glow) → Collected (hidden) → Ghost (2s before respawn) → Active
9. Respawn timer self-managed per pickup node
10. Late join: pickup active/inactive state sent via world_state (Network Layer)

### Class Hierarchy

```
BasePickup (Area3D)
├── WeaponPickup extends BasePickup
│   - pool: PickupPoolResource (weapon_pool.tres)
│   - base_respawn_time: 10.0s
│   - Visual: yellow/orange glow
└── PowerupPickup extends BasePickup
    - pool: PickupPoolResource (powerup_pool.tres)
    - base_respawn_time: 15.0s
    - Visual: blue/green glow
```

Subclasses are thin — override `_grant_item()` only. All shared logic in BasePickup.

### Node Structure (per pickup in map)

```
WeaponPickup_N (Area3D + weapon_pickup.gd)
├── CollisionShape3D (sphere, radius ~1.2m)
├── Mesh (MeshInstance3D — rotating box)
├── PointLight3D (glow, color per type)
├── CollectParticles (GPUParticles3D, one_shot)
└── GhostMesh (MeshInstance3D — transparent, hidden by default)
```

### PickupPoolResource

```gdscript
class_name PickupPoolEntry extends Resource
@export var item: Resource       # WeaponResource or PowerupResource
@export var weight: int = 10     # relative weight

class_name PickupPoolResource extends Resource
@export var entries: Array[PickupPoolEntry] = []

func pick_random() -> Resource:
    var total := 0
    for e in entries: total += e.weight
    var roll := randi_range(0, total - 1)
    var cumulative := 0
    for e in entries:
        cumulative += e.weight
        if roll < cumulative:
            return e.item
    return entries.back().item
```

### Default Weapon Pool Weights

| Weapon | Weight | Probability |
|--------|--------|------------|
| Rocket Launcher | 30 | 30% |
| Shotgun | 25 | 25% |
| Mine | 20 | 20% |
| Dynamite | 15 | 15% |
| Laser | 10 | 10% |

Rarer = higher impact. Rocket is most common (baseline weapon).
Weights tunable via .tres file — no code changes.

### Collection Flow

```
1. Kart (CharacterBody3D) enters pickup Area3D
2. body_entered fires on ALL peers
3. Non-server peers: return (server-only logic)
4. Server: check _collected guard → if already taken, return
5. Server: set _collected = true (race condition guard)
6. Server: pick random item from pool
7. Server: call _rpc_collected.rpc(collector_peer_id, item_path)
8. All peers: hide pickup, play collect particles
9. Server: find kart by peer_id, call kart.receive_pickup(item)
10. Server: State Machine transition EMPTY → ARMED (or weapon swap)
11. Server: start respawn timer
12. Timer expires: _rpc_respawned.rpc() → show pickup on all peers
```

### Kart Interface

```gdscript
# On kart_controller.gd — single entry point for all pickups
func receive_pickup(item: Resource) -> void:
    if item is WeaponResource:
        _equip_weapon(item)
    elif item is PowerupResource:
        _apply_powerup(item)
```

Pickup does NOT know about WeaponState, HealthComponent, or slot internals.
It calls `receive_pickup()`, kart handles the rest.

### Visual States

| State | Duration | Visual | Collides |
|-------|----------|--------|----------|
| **Active** | Until collected | Rotating mesh + point light + glow | Yes |
| **Collected** | respawn_time - 2s | Hidden (mesh invisible, light off) | No |
| **Ghost** | Last 2s before respawn | Transparent mesh at 30% opacity, pulsing | No |
| **Respawning** | Instant | Flash VFX → Active | Yes |

Ghost state gives experienced players a "heads up" to route toward the pickup.

```gdscript
func _start_respawn_timer() -> void:
    # Show ghost 2 seconds before respawn
    var ghost_delay := max(0.0, effective_respawn_time - GHOST_PREVIEW_TIME)
    get_tree().create_timer(ghost_delay).timeout.connect(_show_ghost)
    get_tree().create_timer(effective_respawn_time).timeout.connect(_respawn)

func _show_ghost() -> void:
    _rpc_show_ghost.rpc()

@rpc("authority", "call_local", "reliable")
func _rpc_show_ghost() -> void:
    $GhostMesh.visible = true
    # Pulse tween
    var tw := create_tween().set_loops()
    tw.tween_property($GhostMesh, "transparency", 0.5, 0.5)
    tw.tween_property($GhostMesh, "transparency", 0.8, 0.5)
```

### Network Sync

**Collection**: one reliable RPC
```gdscript
@rpc("authority", "call_local", "reliable")
func _rpc_collected(collector_peer_id: int, item_path: String) -> void:
    active = false
    _apply_collected_visual()
    if multiplayer.is_server():
        var item := load(item_path) as Resource
        var kart := _find_kart(collector_peer_id)
        if kart:
            kart.receive_pickup(item)
        _start_respawn_timer()
```

**Respawn**: one reliable RPC
```gdscript
@rpc("authority", "call_local", "reliable")
func _rpc_respawned() -> void:
    _collected = false
    active = true
    _apply_active_visual()
```

**Late join**: pickup states included in `_rpc_world_state` Dictionary:
```
"pickups": { "WeaponPickup_N": true, "WeaponPickup_S": false, ... }
```

### Respawn Cooldown with Player Scaling

From Spawn System GDD:
```
effective_cooldown = base_respawn_time * lerp(1.0, 0.6, (player_count - 2) / 8.0)
```

| Players | Weapon (base 10s) | Powerup (base 15s) |
|---------|-------------------|-------------------|
| 2 | 10.0s | 15.0s |
| 6 | 8.0s | 12.0s |
| 10 | 6.0s | 9.0s |

### Interactions with Other Systems

| System | Direction | Interface |
|--------|-----------|-----------|
| **Spawn System** | — | No interaction. Pickups self-manage timers. |
| **Weapon System** | → feeds | `receive_pickup(WeaponResource)` equips weapon |
| **Powerup System** | → feeds | `receive_pickup(PowerupResource)` applies powerup |
| **State Machine** | → triggers | Collection triggers WeaponState EMPTY→ARMED |
| **Network Layer** | → uses | RPCs for collect/respawn/ghost. Late join via world_state. |
| **Health & Damage** | — | No direct interaction |
| **Map System** | ← placed in | Pickup nodes placed in map scenes |
| **HUD** | → feeds | Weapon icon update on collection |
| **VFX System** | → feeds | Collect particles, respawn flash |
| **Audio System** | → feeds | Collect SFX, respawn SFX |
| **Analytics** | → feeds | EventBus: pickup_collected(player_id, item_name) |

## Formulas

### Weighted Random Selection

```
total_weight = sum(entry.weight for entry in pool.entries)
roll = randi_range(0, total_weight - 1)
selected = first entry where cumulative_weight > roll
```

O(N) where N = pool size (5-8 items). Negligible cost.

### Respawn Cooldown

```
effective_cooldown = base_respawn_time * player_count_scalar
player_count_scalar = lerp(1.0, 0.6, (player_count - 2) / 8.0)
```

### Ghost Preview Timing

```
ghost_appear_time = collect_time + (effective_cooldown - GHOST_PREVIEW_TIME)
GHOST_PREVIEW_TIME = 2.0s
```

## Edge Cases

| Scenario | Resolution |
|---|---|
| Two karts hit pickup same frame | Server processes sequentially, first peer_id wins |
| Kart hits pickup while DEAD | Ignored — dead karts have collision disabled (from State Machine) |
| Kart hits pickup while INVULNERABLE | Allowed — invuln blocks damage, not pickups |
| Pickup collected during match ENDED | Allowed — match end doesn't disable pickups immediately |
| Pickup respawns with kart standing on it | Auto-collect: body_entered fires, normal collection flow |
| Late joiner: pickup in ghost state | world_state includes timer remaining, client shows appropriate state |
| All items in pool have weight 0 | Fallback: give first item. Log warning. |
| Pickup node has no pool assigned | Assert in _ready(). push_error in release. |
| Player disconnects holding picked-up weapon | Weapon disappears with player. No drop mechanic. |
| Pickup pool .tres file modified mid-match | No effect — pool loaded at _ready(). Hot-reload only between matches. |

## Dependencies

### Upstream

| System | Dependency | Type |
|---|---|---|
| **Network Layer** | RPCs for collect/respawn sync | Hard |
| **Spawn System** | Design contract: pickups self-manage timers | Soft (conceptual) |

### Downstream

| System | What it needs |
|---|---|
| **Weapon System** | WeaponResource delivered via receive_pickup() |
| **Powerup System** | PowerupResource delivered via receive_pickup() |
| **Map System** | Pickup nodes placed in map scenes |

### Interface Contract

- Pickups are self-contained Area3D nodes in map scenes
- `kart.receive_pickup(item: Resource)` — only interface to kart
- Server-only: clients never trigger collection logic
- RPCs: `_rpc_collected`, `_rpc_respawned`, `_rpc_show_ghost`
- Late join: pickup states in world_state Dictionary

## Tuning Knobs

| Knob | Default | Safe Range | Affects |
|------|---------|------------|---------|
| `weapon_respawn_time` | 10.0s | 5-20s | Weapon availability |
| `powerup_respawn_time` | 15.0s | 8-30s | Powerup frequency |
| `ghost_preview_time` | 2.0s | 1-4s | Pre-respawn warning |
| `player_count_scale_min` | 0.6 | 0.5-0.8 | Cooldown at max players |
| `collection_radius` | 1.2m | 0.8-2.0m | How close to drive |
| `rotation_speed` | 1.5 rad/s | 0.5-3.0 | Box spin speed |
| Weapon pool weights | [30,25,20,15,10] | Per weapon | Item distribution |

### Knob Interactions
- `weapon_respawn_time` × `player_count_scale_min` = effective weapon availability
- Pool weights determine meta — laser at 10% keeps it special
- `collection_radius` × kart speed = "grab window" time

## Visual/Audio Requirements

| Event | Visual | Audio |
|-------|--------|-------|
| Box active | Rotating mesh + point light (yellow=weapon, blue=powerup) | — |
| Box collected | Mesh hides + burst particles | Collect chime SFX |
| Ghost preview | Transparent pulsing mesh (30-50% opacity) | Soft hum |
| Box respawn | Flash VFX → solid mesh | Respawn pop SFX |
| Weapon received | Weapon icon appears in HUD | Equip click SFX |

## UI Requirements

| Element | Location | Updates |
|---------|----------|---------|
| Weapon icon | HUD weapon slot | On receive_pickup (WeaponResource) |
| Powerup icon + timer | HUD powerup slot | On receive_pickup (PowerupResource) |

Owned by HUD, not Pickup System. HUD listens to kart signals.

## Acceptance Criteria

### Functional Tests (automated)

- [ ] Kart driving over active WeaponPickup receives a weapon
- [ ] Kart driving over active PowerupPickup receives a powerup
- [ ] Pickup becomes inactive after collection (hidden, no collision)
- [ ] Pickup respawns after effective_cooldown expires
- [ ] Ghost preview appears 2s before respawn
- [ ] Weighted random: items appear with approximate expected distribution over 100 pickups
- [ ] Pickup while armed: current weapon replaced
- [ ] Simultaneous pickup: only one player gets item
- [ ] Dead kart cannot collect pickups
- [ ] Server-only: client cannot trigger collection
- [ ] Late join: new player sees correct pickup states

### Playtest Criteria (human)

- [ ] Pickup boxes are visible and attractive (want to drive toward them)
- [ ] Collection feels instant — no delay between driving over and receiving weapon
- [ ] Ghost preview is helpful but not distracting
- [ ] Weapon variety feels random but fair (not always the same weapon)
- [ ] Replace mechanic is intuitive — no confusion about losing current weapon

## Open Questions

1. **Drop weapon on death?** Currently weapon disappears. SmashKarts drops it.
   If dropped: becomes a temporary pickup anyone can grab. Adds complexity
   but more chaotic fun. Defer to Alpha.

2. **Pickup magnet**: Should kart have a slight pull toward nearby pickups?
   Reduces frustrating near-misses. SmashKarts doesn't do this.

3. **Map-specific pools**: Different maps could have different weapon distributions.
   Architecture supports it (different .tres per map). Design decision for later.
