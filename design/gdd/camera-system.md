# Camera System

> **Status**: In Design
> **Author**: Dima + game-designer + godot-specialist + ux-designer + systems-designer
> **Last Updated**: 2026-04-28
> **Implements Pillar**: Аркадный хаос (feel first — camera communicates speed, impact, chaos)

## Overview

Camera System — отдельный CameraRig node в root сцены (не child of kart),
управляет третьеличным видом за картом. 4 режима: Follow (gameplay), Death
(respawn), Countdown (match start), Scoreboard (match end). Динамические
эффекты: FOV по скорости, screen shake при уроне, drift offset, pullback.

Создаётся только для локального игрока — remote karts не имеют камеры.
Все параметры через @export — тюнинг без кода.

## Player Fantasy

"Камера — жёсткое продолжение карта. Я всегда вижу куда еду, а не куда меня
кидает. Карт всегда строго сзади — чётко, предсказуемо, без задержки. Камера
не комментирует мои действия и не добавляет своей 'инерции' — она просто
следует. Дрифт чувствуется через лёгкий боковой сдвиг взгляда, но не уводит
камеру в сторону. Удар — через тряску. Смерть — через замирание и отъезд."

## Detailed Design

### Core Rules

1. CameraRig — Node3D в root сцены, НЕ child of kart (avoid transform inheritance)
2. Создаётся только для `multiplayer.get_unique_id()` — remote karts без камеры
3. Camera mode определяет поведение в `_process()` через match на enum
4. All dynamic effects (FOV, shake, drift offset) have separate lerps — independent
5. Screen shake applies AFTER look_at() — иначе look_at() перезаписывает rotation
6. DevParams hot-reload для камерных параметров переезжает в CameraRig
7. **Camera is rigid-follow**: yaw locked to kart, position lerps fast (~30 rate).
   Никакой "инерции" камеры — momentum-feel создаёт ощущение тянучки ("резинка"),
   это намеренно исключено. Обе скорости (lerp_slow и lerp_fast) достаточно высокие
   чтобы казаться немедленными; разница между ними минорная.

### Node Structure

```
CameraRig (Node3D + camera_rig.gd)
└── ShakeNode (Node3D)        ← shake offset applied here
    └── Camera3D              ← FOV, look_at applied here
```

ShakeNode — прослойка для изоляции тряски от позиционирования.

### Camera Modes

```gdscript
enum CameraMode { FOLLOW, DEATH, COUNTDOWN, SCOREBOARD }
```

| Mode | Trigger | Behavior | Duration |
|------|---------|----------|----------|
| FOLLOW | KartState != DEAD, MatchState == PLAYING | Follow kart with dynamic effects | Continuous |
| DEATH | `kart_died` signal | Freeze at death position, slow zoom out | 3.0s (respawn_delay) |
| COUNTDOWN | MatchState == COUNTDOWN | Normal follow, karts frozen | 3.0s |
| SCOREBOARD | MatchState == ENDED | Static wide shot of arena | 10.0s |

**Mode transitions:**
| From | To | Trigger |
|------|-----|---------|
| FOLLOW | DEATH | `kart_died` signal |
| DEATH | FOLLOW | `kart_respawned` signal |
| FOLLOW | SCOREBOARD | `match_state_changed` → ENDED |
| SCOREBOARD | COUNTDOWN | `match_state_changed` → COUNTDOWN |
| COUNTDOWN | FOLLOW | `match_state_changed` → PLAYING |

**Future upgrade (documented for later):**
- DEATH mode → snap to killer camera (killer_id available from Health & Damage)
- Add SPECTATE mode: Tab to cycle through other karts during DEAD window
- Countdown → arena overview swoop down to kart

### FOLLOW Mode (Normal Gameplay)

**Position**: behind and above kart, offset by `cam_offset`
```
target_pos = kart.global_position + kart.flat_basis * cam_offset
cam_pos = cam_pos.lerp(target_pos, lerp_factor * delta)
```

**Look at**: kart position + forward look-ahead + slight vertical offset
```
look_target = kart.global_position + kart.forward_flat * look_ahead + Vector3.UP * 0.55
camera.look_at(look_target, Vector3.UP)
```

`look_ahead` намеренно мал (0.4). Большой look-ahead смещает точку прицела далеко
вперёд по yaw карта — камера смотрит "туда куда едем", а не "на карт сзади". При
повороте это создаёт ощущение что карт виден немного сбоку, а не строго сзади.
Малый look-ahead = камера смотрит почти на сам карт, всегда есть пространство
спереди для видимости трассы, карт всегда в центре кадра.

**Dynamic effects active in FOLLOW:**
- Speed-dependent FOV (wider at high speed)
- Speed-dependent distance (pullback at high speed)
- Speed-dependent lerp factor (tighter at high speed, lazier at low)
- Drift lateral offset (camera shifts in slide direction)
- Screen shake (on damage/explosion)

### DEATH Mode

**MVP implementation**: Freeze + slow zoom out
```
# On enter DEATH:
_death_pos = cam_pos                    # freeze position
_death_look = camera.global_transform   # freeze rotation
_death_zoom_start = cam_offset.z

# In _process_death:
cam_offset_z = lerp(_death_zoom_start, _death_zoom_start + 4.0, elapsed / 3.0)
cam_pos = _death_pos + Vector3.UP * (elapsed * 0.5)  # drift upward slowly
```

### COUNTDOWN Mode

Normal follow camera — karts are frozen by State Machine (IDLE state).
No special camera behavior at MVP.

### SCOREBOARD Mode

Static overhead shot:
```
cam_pos = arena_center + Vector3(0, 15, 0)
camera.look_at(arena_center, Vector3.FORWARD)
```

### Dynamic Effects

#### Speed-dependent FOV
```
t = clamp(abs(fwd_speed) / max_speed, 0.0, 1.0)
t_eased = smoothstep(0.0, 1.0, t)
target_fov = fov_min + (fov_max - fov_min) * t_eased
camera.fov = lerp(camera.fov, target_fov, 5.0 * delta)
```

#### Speed-dependent Distance (Pullback)
```
target_dist = dist_base + (dist_max - dist_base) * smoothstep(0.0, 1.0, t) * 0.7
cam_offset.z = target_dist
```

#### Speed-dependent Follow Lerp
```
lerp_factor = lerp(lerp_slow, lerp_fast, t)
```
Низкая скорость: всё равно быстрый follow (lerp_slow=22) — низкая скорость не
оправдывает визуальный lag, тянучка ощущается неприятно в любой ситуации.
Высокая скорость: чуть быстрее (lerp_fast=30) — для надёжного удержания карта в
кадре при быстрых поворотах. Разница между slow/fast намеренно минорная: оба
значения дают ощущение rigid-follow, не lazy-follow.

#### Drift Lateral Offset
```
lateral_vel = kart.velocity.dot(kart.basis.x)
t_drift = clamp(lateral_vel / max_speed, -1.0, 1.0)
target_drift_x = t_drift * drift_max_offset
_cam_drift_x = lerp(_cam_drift_x, target_drift_x, drift_lerp * delta)
target_pos += kart.flat_basis.x * _cam_drift_x
```

Смещение намеренно малое (drift_max_offset=0.6) — едва заметный hint что мы
скользим, но не уводит камеру в сторону. Быстрый возврат (drift_lerp=12.0) когда
дрифт кончается — камера не "болтается" после окончания заноса. Приоритет:
sensation дрифта без дезориентации.

#### Screen Shake (Trauma System)
```
# Add trauma:
shake_trauma = clamp(shake_trauma + amount, 0.0, 1.0)

# Decay (every frame):
shake_trauma = max(shake_trauma - shake_decay_rate * delta, 0.0)

# Apply (squared for exponential feel):
intensity = shake_trauma * shake_trauma
shake_node.position = Vector3(
    randf_range(-1, 1) * shake_max_offset * intensity,
    randf_range(-1, 1) * shake_max_offset * intensity,
    0.0
)
```

**Shake sources:**
| Source | Trauma added |
|--------|-------------|
| Direct hit (rocket) | +0.5 |
| AOE splash | +0.3 * proximity_factor |
| Kart collision | +0.15 |
| Explosion nearby | +0.2 * proximity_factor |

### Interactions with Other Systems

| System | Direction | Interface |
|--------|-----------|-----------|
| **State Machine** | ← reads | KartState → mode switching (DEAD, RESPAWNING) |
| **State Machine** | ← reads | MatchState → mode switching (COUNTDOWN, ENDED) |
| **Kart Physics** | ← reads | Speed, drift state → FOV, pullback, lerp, drift offset |
| **Health & Damage** | ← reads | `damaged` signal → screen shake |
| **Health & Damage** | ← reads | `died` signal → DEATH mode + killer_id (future: snap to killer) |
| **Network Layer** | — | Camera is client-only, no network sync needed |
| **VFX System** | ← reads | Explosion events → proximity shake |
| **Match System** | ← reads | Match state changes → COUNTDOWN/SCOREBOARD modes |

## Formulas

### Follow Lerp Factor
```
lerp_factor = lerp(lerp_slow, lerp_fast, t)
t = clamp(abs(fwd_speed) / max_speed, 0.0, 1.0)
```

| Variable | Default | Range |
|---|---|---|
| `lerp_slow` | 22.0 | 18.0-26.0 |
| `lerp_fast` | 30.0 | 25.0-35.0 |

Оба значения дают rigid-feel. Perceived lag при delta=1/60:
`lag ≈ 1 / lerp_factor * 1000ms` (approx, exponential convergence)

| Speed | lerp_factor | Perceived lag (approx) |
|---|---|---|
| 0 m/s | 22.0 | ~45ms |
| 12 m/s | 26.0 | ~38ms |
| 23 m/s | 30.0 | ~33ms |

### Dynamic FOV
```
target_fov = fov_min + (fov_max - fov_min) * smoothstep(0.0, 1.0, t)
camera.fov = lerp(camera.fov, target_fov, 5.0 * delta)
```

| Variable | Default | Range |
|---|---|---|
| `fov_min` | 65.0 | 55-70 |
| `fov_max` | 85.0 | 75-95 |

### Dynamic Distance
```
target_dist = dist_base + (dist_max - dist_base) * smoothstep(0.0, 1.0, t) * 0.7
```

| Variable | Default | Range |
|---|---|---|
| `dist_base` | 6.8 | 5.0-8.0 |
| `dist_max` | 8.6 | 7.0-10.0 |

### Drift Offset
```
target_drift_x = t_drift * drift_max_offset
_cam_drift_x = lerp(_cam_drift_x, target_drift_x, drift_lerp * delta)
```

| Variable | Default | Range |
|---|---|---|
| `drift_max_offset` | 0.6 | 0.3-1.2 |
| `drift_lerp` | 12.0 | 8.0-16.0 |

### Screen Shake
```
shake_trauma = max(shake_trauma - shake_decay_rate * delta, 0.0)
intensity = shake_trauma ^ 2
offset = randf_range(-1, 1) * shake_max_offset * intensity
```

| Variable | Default | Range |
|---|---|---|
| `shake_max_offset` | 0.15 | 0.05-0.3 |
| `shake_decay_rate` | 2.5 | 1.5-4.0 |

## Edge Cases

| Scenario | Resolution |
|---|---|
| Kart dies instantly on spawn (rare) | DEATH mode triggers, zoom out from spawn position |
| Killer disconnects during DEATH cam | Camera stays in freeze+zoom mode (no snap to show) |
| Match ends while in DEATH mode | Transition to SCOREBOARD, cancel death zoom |
| Speed changes rapidly (collision bounce) | FOV lerp (5.0*delta) smooths, no visual snap |
| Kart teleports (respawn) | Set `_cam_init = false` → instant snap to new position |
| Two shakes overlap (hit + explosion same frame) | Trauma is additive, clamped to 1.0 |
| Spectate target dies (future) | Auto-advance to next alive kart |
| Camera clips through wall | Not handled at MVP — arenas are open. Add camera collision raycast if maps get enclosed |
| HTML5 frame drop (30fps) | All formulas delta-based, scale correctly |
| Remote kart has no CameraRig | Correct — only local kart gets one |

## Dependencies

### Upstream

| System | Dependency | Type |
|---|---|---|
| **State Machine** | KartState + MatchState for mode switching | Hard |

### Downstream

None — Camera is a leaf node in the dependency graph.

### Soft Dependencies (enhanced by, works without)

| System | Enhancement |
|---|---|
| **Kart Physics** | Speed/drift → dynamic effects. Without: static camera works |
| **Health & Damage** | Damage → shake. Without: no shake, still works |
| **VFX System** | Explosion events → proximity shake. Without: no proximity shake |

### Interface Contract

- CameraRig reads kart properties (position, velocity, basis) — never modifies
- CameraRig subscribes to signals (died, respawned, match_state_changed) — never emits
- CameraRig is created by game_world.gd for local player only
- No network component — camera is purely client-side

## Tuning Knobs

| Knob | Default | Safe Range | Affects | Too Low | Too High |
|---|---|---|---|---|---|
| `cam_height` | 4.1 | 2.0-8.0 | View angle | Can't see ahead | Bird's eye, disconnected |
| `dist_base` | 6.8 | 5.0-8.0 | Camera distance | Too close, claustrophobic | Too far, detached |
| `dist_max` | 8.6 | 7.0-10.0 | Pullback at speed | No speed feel | Camera detaches |
| `fov_min` | 65.0 | 55-70 | Base field of view | Tunnel vision | Fisheye distortion |
| `fov_max` | 85.0 | 75-95 | Max FOV at speed | No speed feel | Nauseating |
| `lerp_slow` | 22.0 | 18.0-26.0 | Camera lag at low speed | Tянучка ("резинка") | Camera never settles |
| `lerp_fast` | 30.0 | 25.0-35.0 | Camera at high speed | Slightly floaty | Jittery, nervous |
| `look_ahead` | 0.4 | 0.2-1.0 | Look-ahead distance | Kart off-center, no road view | Kart appears to side, not behind |
| `drift_max_offset` | 0.6 | 0.3-1.2 | Drift camera shift | No drift sensation | Camera swings away, disorienting |
| `drift_lerp` | 12.0 | 8.0-16.0 | Drift offset return speed | Camera lingers sideways after drift | Offset snaps, jerky |
| `shake_max_offset` | 0.15 | 0.05-0.3 | Shake intensity | Unfelt hits | Nausea |
| `shake_decay_rate` | 2.5 | 1.5-4.0 | Shake duration | Shakes too long | Over too fast |
| `death_zoom_speed` | 0.5 | 0.2-1.0 | Death cam zoom rate | Too static | Too fast |

### Knob Interactions
- `fov_max` × `dist_max` = combined speed feel (both amplify speed sensation)
- `lerp_slow` × `fov_min` = low-speed feel (both make slow feel distinct)
- `shake_max_offset` × `shake_decay_rate` = impact feel weight

## Visual/Audio Requirements

| Event | Visual | Audio |
|-------|--------|-------|
| Speed increase | FOV widens, camera pulls back | — (engine audio handles this) |
| Drift | Camera shifts laterally | — (tire screech handles this) |
| Hit taken | Screen shake (trauma system) | — (impact SFX handles this) |
| Death | Camera freezes, slow zoom out | — (explosion SFX handles this) |
| Match countdown | Normal follow, karts frozen | Countdown beeps (Match System) |
| Match end | Camera rises to overview | Match end fanfare (Match System) |

Camera system has NO audio of its own — it amplifies other systems' audio through visual sync.

## UI Requirements

No UI elements owned by Camera System. HUD renders on CanvasLayer independent of camera.

Death overlay ("Killed by [name]") is owned by HUD, triggered by the same `died` signal.

## Acceptance Criteria

### Functional Tests (automated)

- [ ] CameraRig created only for local player, not remote
- [ ] Camera mode switches on State Machine signals (DEAD → DEATH, PLAYING → FOLLOW)
- [ ] FOV increases with speed (65° at rest, ~85° at max)
- [ ] Camera distance increases with speed (6.8m at rest, ~8.0m at max)
- [ ] Follow lerp is speed-dependent (tighter at high speed)
- [ ] Drift offset shifts camera laterally in drift direction
- [ ] Screen shake triggers on damage (trauma > 0)
- [ ] Screen shake decays over time (trauma → 0)
- [ ] Shake trauma additive and clamped to 1.0
- [ ] Death mode: camera freezes and zooms out
- [ ] Scoreboard mode: camera moves to overhead position
- [ ] Respawn: camera snaps to new kart position (no interpolation)

### Playtest Criteria (human) — CRITICAL

- [ ] Speed feels communicated through camera (FOV + pullback noticeable)
- [ ] Drift offset helps see where you're going during drift
- [ ] Screen shake on hit feels impactful but not nauseating
- [ ] Death camera gives clear "I died" moment
- [ ] Camera never clips through geometry on current maps
- [ ] Overall: camera feels responsive and communicative, never fights the player
- [ ] **Rigid-follow**: при резком повороте + отпуске руля карт визуально не
      перекошен на экране более 50ms; за исключением активного дрифта карт
      всегда виден строго сзади в центре кадра
- [ ] **Нет тянучки**: при смене направления на низкой скорости камера не
      "плывёт" с заметным отставанием

## Open Questions

1. **Future: Snap to killer on death** — killer_id is available from Health & Damage.
   Implementation: DEATH mode Phase 2 → lerp camera to follow killer for 3s.
   Tab to cycle = SPECTATE mode. **Dima wants this eventually.**

2. **Camera collision**: If future maps have enclosed spaces, need raycast from
   kart to camera — move camera forward if wall between them. Not needed for
   current open arena maps.

3. **Spectate mode**: Full implementation deferred. When added: CameraRig.mode = SPECTATE,
   Tab cycles `_spectate_targets` array, follow logic reused from FOLLOW mode.
   Transition between targets via position lerp (5.0 * delta).
