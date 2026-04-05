# Spawn System

> **Status**: In Design
> **Author**: Dima + game-designer + godot-specialist + lead-programmer + systems-designer
> **Last Updated**: 2026-04-05
> **Implements Pillar**: Аркадный хаос (fast respawn, back in action), Играй с друзьями (fair spawns)

## Overview

Spawn System управляет ГДЕ и КОГДА появляются карты игроков. Spawn points —
Marker3D ноды в сцене карты, обнаруживаемые через groups. SpawnManager — нода
в game.tscn (не autoload), отвечает только за карты. Пикапы управляют своими
таймерами самостоятельно.

Серверно-авторитетный: только сервер выбирает точку и бродкастит результат.

## Player Fantasy

"Когда я умираю — через 3 секунды я уже на карте. Меня не спавнят рядом с врагом,
но и не в одном и том же месте каждый раз. 2 секунды неуязвимости — достаточно
чтобы осмотреться и рвануть к ближайшему оружию."

## Detailed Design

### Core Rules

1. Spawn points = Marker3D nodes in map scene, group `kart_spawn`
2. SpawnManager discovers points via `get_tree().get_nodes_in_group()` in `_ready()`
3. Server-only: `SpawnManager.get_spawn_point()` returns Vector3
4. Match start: sequential assignment (round-robin, index % count)
5. Respawn after death: farthest-from-enemies algorithm
6. Late join: same as respawn (farthest + 2s RESPAWNING invuln)
7. Spawn protection: soft push (3m radius, 8 m/s impulse on nearby karts)
8. Map validation: assert minimum kart_spawn count (≥4) in `_ready()`

### SpawnManager Architecture

**Node in game.tscn** (not autoload — map-specific lifecycle):

```
Game (Node3D)
├── SpawnManager (Node + spawn_manager.gd)
├── Arena (map scene with Marker3D spawn points)
├── Karts (dynamically filled)
├── Pickups (weapon/powerup — self-managed)
└── HUD
```

**Interface:**
```gdscript
class_name SpawnManager extends Node

# Called by game_world for initial spawn (match start)
func get_initial_spawn_point() -> Vector3

# Called by game_world for respawn (after death / late join)
func get_respawn_point(karts_container: Node3D) -> Vector3

# Called in _ready for map validation
func validate_map() -> void
```

game_world.gd gets reference via `@onready var spawn_manager: SpawnManager = $SpawnManager`.

### Marker3D Setup in Map

Each map scene contains Marker3D nodes in `kart_spawn` group:

```
Map1 (Node3D)
├── Geometry (MeshInstance3D, etc.)
├── SpawnPoint1 (Marker3D, group: kart_spawn)
├── SpawnPoint2 (Marker3D, group: kart_spawn)
├── ...
├── SpawnPoint8 (Marker3D, group: kart_spawn)
├── WeaponPickup_N (Area3D — self-managed, NOT via SpawnManager)
└── PowerupPickup_N (Area3D — self-managed, NOT via SpawnManager)
```

**Adding a new map**: place Marker3D nodes in editor, add to `kart_spawn` group. Zero code.
**Adding a spawn point**: add another Marker3D to the group. Zero code.

### Spawn Point Selection

#### Match Start (Initial Spawn)

Sequential round-robin:
```
func get_initial_spawn_point() -> Vector3:
    var point := _spawn_points[_next_index % _spawn_points.size()]
    _next_index += 1
    return point.global_position
```

If more players than spawn points: wraps around (overlap allowed — all have
COUNTDOWN invuln).

#### Respawn After Death / Late Join

Farthest-from-enemies:
```
func get_respawn_point(karts_container: Node3D) -> Vector3:
    var best_point: Marker3D = null
    var best_min_dist: float = -1.0
    
    for point in _spawn_points:
        var min_dist := INF
        for kart in karts_container.get_children():
            if kart is CharacterBody3D and kart.state != KartState.DEAD:
                var dist := point.global_position.distance_to(kart.global_position)
                min_dist = min(min_dist, dist)
        if min_dist > best_min_dist:
            best_min_dist = min_dist
            best_point = point
    
    return best_point.global_position if best_point else _spawn_points[0].global_position
```

### Spawn Protection (Soft Push)

When a kart respawns, server checks for nearby karts and applies impulse:
```
for kart in karts_container.get_children():
    if kart.state == KartState.DEAD:
        continue
    var dist := spawn_pos.distance_to(kart.global_position)
    if dist < spawn_push_radius and dist > 0.1:
        var push_dir := (kart.global_position - spawn_pos).normalized()
        kart.velocity += push_dir * spawn_push_force
```

Not a permanent zone — one-frame impulse at respawn moment.

### Pickup Spawn (NOT SpawnManager)

Pickups manage themselves:
- `weapon_pickup.gd` has `@export var respawn_time: float = 10.0`
- `powerup_pickup.gd` (future) has `@export var respawn_time: float = 15.0`
- Timer starts when collected, pickup reappears when timer expires
- **Match start**: all pickups active immediately on GO
- **Late join sync**: server sends pickup states via `_rpc_world_state` (Network Layer)

Pickup respawn_time with player-count scaling (future tuning knob):
```
effective_cooldown = base_cooldown * lerp(1.0, 0.6, (player_count - 2) / 8.0)
```

### Map Validation

In SpawnManager._ready():
```
func validate_map() -> void:
    var count := _spawn_points.size()
    if count < MIN_KART_SPAWNS:
        push_error("Map needs at least %d kart_spawn points, found %d" % [MIN_KART_SPAWNS, count])
    assert(count >= MIN_KART_SPAWNS, "Insufficient spawn points")
```

### States and Transitions

SpawnManager has no internal states — it's a stateless service.
State lives in the karts (KartState) and pickups (active/inactive bool).

**Kart spawn flow:**
```
Player dies → KartState.DEAD (3s timer) 
→ Server calls SpawnManager.get_respawn_point()
→ Server calls kart.respawn.rpc(spawn_pos)
→ KartState.RESPAWNING (2s invuln)
→ KartState.DRIVING
```

### Interactions with Other Systems

| System | Direction | Interface |
|--------|-----------|-----------|
| **State Machine** | ← triggers | DEAD→RESPAWNING triggers spawn point request |
| **Network Layer** | → uses | Spawn position sent via `kart.respawn.rpc(pos)` |
| **Network Layer** | → uses | Late join: pickup states in `_rpc_world_state` |
| **Health & Damage** | ← triggers | `died` signal starts respawn flow |
| **Match System** | ← triggers | Match start → initial spawn for all players |
| **Kart Physics** | → affects | Soft push impulse on nearby karts at respawn |
| **Pickup System** | — | No direct interaction — pickups self-manage |
| **Map System** | ← reads | Marker3D points from current map scene |

### Future: Random Spawn Mode

**Not implemented at MVP. Documented for later.**

Toggle at match start: "Fixed Spawn Points" vs "Random Spawn Points"

When enabled:
- Weapon/powerup pickup positions randomized each match
- Uses raycast-down from random arena AABB point to find ground
- kart_spawn still uses fixed Marker3D (player expects consistent start)
- Breaks predictable routes — players can't memorize optimal paths

Implementation approach (when needed):
```gdscript
func _find_random_ground_pos(arena_bounds: AABB) -> Vector3:
    var space := get_world_3d().direct_space_state
    for attempt in 10:
        var x := randf_range(arena_bounds.position.x, arena_bounds.end.x)
        var z := randf_range(arena_bounds.position.z, arena_bounds.end.z)
        var query := PhysicsRayQueryParameters3D.create(
            Vector3(x, arena_bounds.end.y, z),
            Vector3(x, arena_bounds.position.y, z))
        var result := space.intersect_ray(query)
        if result:
            return result.position + Vector3.UP * 0.5
    return Vector3.ZERO
```

## Formulas

### Farthest-From-Enemies Score

```
score(point) = min(distance(point, kart_i)) for all alive karts
best_point = argmax(score(point)) for all spawn points
```

O(S × K) where S = spawn points (8-10), K = alive karts (≤10). Max 100 distance checks — negligible.

### Pickup Cooldown (per pickup, self-managed)

```
effective_cooldown = base_cooldown * player_count_scalar
player_count_scalar = lerp(1.0, 0.6, (player_count - 2) / 8.0)
```

| Players | Weapon cooldown | Powerup cooldown |
|---------|----------------|-----------------|
| 2 | 10.0s | 15.0s |
| 6 | 8.0s | 12.0s |
| 10 | 6.0s | 9.0s |

### Spawn Push Impulse

```
push_dir = normalize(kart_pos - spawn_pos)
impulse = push_dir * spawn_push_force  # 8.0 m/s
```

Applied only if `distance < spawn_push_radius` (3.0m) and kart is alive.

## Edge Cases

| Scenario | Resolution |
|---|---|
| More players than spawn points (10 players, 8 points) | Match start: wrap around (overlap + invuln). Respawn: farthest still works |
| All spawn points have enemies nearby | Pick the one with greatest min distance regardless |
| Player spawns on a pickup point | Pickup triggers normal collect (auto-collect on overlap) |
| Two players respawn simultaneously | Server processes sequentially; second gets different farthest point |
| Map has 0 kart_spawn markers | assert fails in debug, push_error + fallback to Vector3.ZERO in release |
| Spawn point is inside geometry | Map design issue — validate in editor. No runtime fix |
| Late joiner during ENDED match | Spawns but enters next match on WAITING→COUNTDOWN |
| Soft push during INVULNERABLE | Applied — INVULNERABLE blocks damage, not physics push |
| Kart standing on own spawn point | Never happens — you don't respawn at same point (farthest algo) |

## Dependencies

### Upstream

| System | Dependency | Type |
|---|---|---|
| **State Machine** | KartState.DEAD triggers respawn | Hard |
| **Network Layer** | RPC for spawn position broadcast | Hard |

### Downstream

| System | What it needs |
|---|---|
| **Pickup System** | Pickup self-manages timing, SpawnManager not involved |
| **Match System** | Match start triggers initial spawn for all |
| **Map System** | Maps provide Marker3D spawn points |

### Interface Contract

- `SpawnManager.get_initial_spawn_point() → Vector3` (match start)
- `SpawnManager.get_respawn_point(karts: Node3D) → Vector3` (after death)
- Server-only: clients never call SpawnManager
- Pickups are independent — no SpawnManager coordination

## Tuning Knobs

| Knob | Default | Safe Range | Affects | Too Low | Too High |
|---|---|---|---|---|---|
| `MIN_KART_SPAWNS` | 4 | 4-12 | Map validation | Small maps fail | Over-constraining |
| `spawn_push_radius` | 3.0m | 1.0-5.0 | Protection zone | Enemies too close | Pushes too wide |
| `spawn_push_force` | 8.0 m/s | 3.0-15.0 | Push strength | Barely moves | Launches karts |
| `weapon_respawn_time` | 10.0s | 5.0-20.0 | Weapon availability | Always armed | Starved for weapons |
| `powerup_respawn_time` | 15.0s | 8.0-30.0 | Powerup frequency | Powerup spam | Powerups rare |
| `player_count_scale_min` | 0.6 | 0.5-0.8 | Cooldown at max players | Pickups everywhere | Still starved |

## Visual/Audio Requirements

| Event | Visual | Audio |
|-------|--------|-------|
| Kart respawn | Fade-in + shield glow (from State Machine RESPAWNING VFX) | Spawn chime |
| Pickup respawn | Box fades in with glow effect | Pickup appear SFX |
| Spawn push | Brief speed lines on pushed kart | Whoosh SFX |

## UI Requirements

| Element | Location | Updates |
|---------|----------|---------|
| Respawn timer | Death screen center | Countdown 3-2-1 during DEAD state |

Owned by HUD, not SpawnManager. HUD listens to `kart_died` signal.

## Acceptance Criteria

### Functional Tests (automated)

- [ ] SpawnManager discovers all Marker3D in `kart_spawn` group
- [ ] Map validation fails if < MIN_KART_SPAWNS points
- [ ] Initial spawn: sequential round-robin assignment
- [ ] Respawn: farthest-from-enemies point selected
- [ ] Late join: uses respawn logic (farthest + RESPAWNING state)
- [ ] Spawn push: nearby karts receive impulse on respawn
- [ ] Spawn push: no push on DEAD karts
- [ ] Pickup cooldown: timer starts on collect, pickup reappears after cooldown
- [ ] All pickups active at match start (no stagger)
- [ ] Player count scaling reduces cooldown at higher player counts

### Network Tests

- [ ] Spawn point selection is server-only (client cannot override)
- [ ] Respawn position broadcast via RPC to all clients
- [ ] Late joiner receives correct pickup states via world_state

### Playtest Criteria (human)

- [ ] Never spawn directly next to an enemy
- [ ] Spawn positions feel varied, not predictable
- [ ] 2s invulnerability is enough to orient and move
- [ ] Pickup respawn timing feels right — not starved, not flooded
- [ ] Soft push is noticeable but not disruptive

## Open Questions

1. **Spawn rotation**: Should kart face center of arena on spawn? Or face
   direction set by Marker3D rotation in editor? Currently only position used.

2. **Pickup visual cue before respawn**: Should pickup point show a "ghost"
   or timer indicator before the box reappears? Helps experienced players
   time their routes.

3. **Random spawn mode UX**: How to expose the toggle? Match settings in lobby?
   Host-only option? Separate queue?
