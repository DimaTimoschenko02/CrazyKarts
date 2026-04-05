# State Machine System

> **Status**: In Design
> **Author**: Dima + godot-specialist + systems-designer
> **Last Updated**: 2026-04-03
> **Implements Pillar**: Infrastructure (supports all pillars)

## Overview

State Machine — единая система управления состояниями для всех игровых сущностей.
Три домена: **Kart** (движение/жизнь игрока), **Match** (фазы матча), **Weapon**
(слот оружия). Реализуется как enum + match паттерн в GDScript — zero overhead,
статическая типизация, нативная синхронизация через RPC.

Серверно-авторитетные переходы: клиент отправляет запрос, сервер валидирует и
бродкастит новое состояние всем peer'ам. Заменяет текущие разрозненные bool-флаги
(`is_dead`, `has_weapon`) на явные конечные автоматы.

Игрок не взаимодействует с системой напрямую — она определяет что игрок может
и не может делать в каждый момент. Это фундамент: 6 систем строятся поверх.

## Player Fantasy

Инфраструктурная система — "система которую ты не замечаешь". Игрок не думает
"я в состоянии driving". Но он **чувствует** результат:

- Подбили — видишь урон, продолжаешь ехать и стрелять (arcade feel, no stun)
- Умер — видишь обратный отсчёт респавна, знаешь когда вернёшься
- Респавнился — секунда неуязвимости, можно убежать от опасности
- Матч структурирован: обратный отсчёт → экшен → результат → снова

**Фантазия**: "игра всегда понимает что происходит и не глючит". Не бывает
ситуации когда ты мёртвый но двигаешься, стреляешь после смерти, или получаешь
урон во время респавна. Каждое состояние имеет чёткие правила что можно и нельзя.

## Detailed Design

### Core Rules

1. Each domain (Kart, Match, Weapon) is a separate GDScript enum
2. Transitions only through validated paths — invalid transitions silently ignored
   on client, logged as warning on server
3. Trigger priority on same frame: Server-forced > Death > Player Input
4. Timed states use server-side timers (never client timers)
5. Every transition emits `state_changed(from, to)` signal — other systems subscribe
6. Client shows optimistic state update, server corrects on mismatch

### States and Transitions

#### Kart States (6)

| State | Description | Timed | Duration |
|---|---|---|---|
| `IDLE` | Stationary, no input | No | — |
| `DRIVING` | Moving under input/inertia | No | — |
| `DRIFTING` | Drift key held, rear slide active | No | — |
| `DEAD` | HP=0, kart hidden, no collision | Yes | 3.0s |
| `RESPAWNING` | Placed at spawn, protection window | Yes | 2.0s |
| `INVULNERABLE` | Shield powerup active | Yes | 5.0s (powerup-defined) |

#### Kart Transitions

| From | To | Trigger | Authority |
|---|---|---|---|
| IDLE | DRIVING | Player input (WASD) | Client request |
| IDLE | DEAD | Damage event, HP <= 0 | Server only |
| DRIVING | IDLE | No input + velocity < 0.5 m/s | Client request |
| DRIVING | DRIFTING | Drift key + speed > drift_min_speed | Client request |
| DRIVING | DEAD | Damage event, HP <= 0 | Server only |
| DRIFTING | DRIVING | Drift key released OR speed < drift_min | Client request |
| DRIFTING | DEAD | Damage event, HP <= 0 | Server only |
| DEAD | RESPAWNING | respawn_timer expires + valid spawn point | Server only |
| RESPAWNING | DRIVING | invuln_duration expires | Server timer |
| RESPAWNING | INVULNERABLE | Shield powerup during respawn | Server only |
| IDLE | INVULNERABLE | Shield powerup collected | Server only |
| DRIVING | INVULNERABLE | Shield powerup collected | Server only |
| DRIFTING | INVULNERABLE | Shield powerup collected | Server only |
| INVULNERABLE | DRIVING | invuln_duration expires | Server timer |

#### Match States (4)

| State | Description | Timed | Duration |
|---|---|---|---|
| `WAITING` | Lobby open, accepting connections | No | — |
| `COUNTDOWN` | 3-2-1-GO sequence | Yes | 3.0s |
| `PLAYING` | Match active, timer running | Yes | 120/180/300s configurable |
| `ENDED` | Scoreboard, results display | Yes | 10.0s auto-restart |

#### Match Transitions

| From | To | Trigger | Authority |
|---|---|---|---|
| WAITING | COUNTDOWN | player_count >= min_players AND lobby-owner clicks Start (lobby-owner = first connected peer, reassigned on disconnect) | Server only |
| COUNTDOWN | PLAYING | 3s countdown expires | Server timer |
| COUNTDOWN | WAITING | Player count drops below min during countdown | Server only |
| PLAYING | ENDED | Match timer expires OR only 1 player alive | Server only |
| PLAYING | WAITING | All players disconnect | Server only |
| ENDED | WAITING | Auto-restart timer (10s) expires | Server only |

#### Weapon States (4)

| State | Description | Timed | Duration |
|---|---|---|---|
| `EMPTY` | No weapon held | No | — |
| `ARMED` | Weapon held, ready to fire | No | — |
| `FIRING` | Fire animation playing, projectile spawned | Yes | weapon.fire_anim_duration |
| `COOLDOWN` | Between shots, weapon still held | Yes | weapon.fire_rate |

#### Weapon Transitions

| From | To | Trigger | Authority |
|---|---|---|---|
| EMPTY | ARMED | Weapon pickup collected | Server only |
| ARMED | FIRING | Fire input + kart NOT in DEAD | Client → Server validate |
| ARMED | EMPTY | Different weapon pickup (replace) / Match ended | Server only |
| FIRING | COOLDOWN | Fire anim complete, ammo > 0 | Server timer |
| FIRING | EMPTY | Fire anim complete, ammo = 0 | Server timer |
| COOLDOWN | ARMED | Cooldown expires, ammo > 0 | Server timer |
| COOLDOWN | EMPTY | Cooldown expires, ammo = 0 | Server timer |

### Interactions with Other Systems

#### Cross-Domain Forced Transitions

| Event | Source SM | Target SM | Forced Transition |
|---|---|---|---|
| Match → ENDED | Match | All Karts | Force → IDLE |
| Match → ENDED | Match | All Weapons | Force → EMPTY |
| Match → COUNTDOWN | Match | All Karts | Force → IDLE (freeze) |
| Match → PLAYING | Match | All Karts | Allow DRIVING |
| Kart → DEAD | Kart | Own Weapon | → EMPTY after respawn |
| Kart → DEAD | Kart | Own Weapon | Block FIRING transitions |

#### Signals for Other Systems

```
# Kart SM
kart_state_changed(peer_id: int, from_state: KartState, to_state: KartState)
kart_died(peer_id: int, killer_peer_id: int)
kart_respawned(peer_id: int, spawn_point_index: int)

# Match SM
match_state_changed(from_state: MatchState, to_state: MatchState)
match_countdown_tick(seconds_remaining: int)
match_timer_tick(seconds_remaining: float)
match_ended(scores: Dictionary, winner_peer_id: int)

# Weapon SM
weapon_state_changed(peer_id: int, from_state: WeaponState, to_state: WeaponState)
weapon_fired(peer_id: int, weapon_resource: Resource, projectile_id: int)
weapon_picked_up(peer_id: int, weapon_resource: Resource)
weapon_emptied(peer_id: int)
```

---

## Formulas

This system has no mathematical formulas — it is logic-based (state transitions).
All numeric values (durations, thresholds) are listed in Tuning Knobs below.

The only "calculation" is trigger priority resolution:

```
Priority = server_forced(3) > damage_event(2) > player_input(1)
```

When two triggers fire on the same physics frame, higher priority wins.
Equal priority: first received by server wins (single-threaded determinism).

---

## Edge Cases

### Kart Domain

| Scenario | Resolution |
|---|---|
| Hit arrives while DEAD | Ignored — no double-death |
| Hit arrives while RESPAWNING | Ignored — same as invulnerable |
| Hit arrives while INVULNERABLE | Ignored — shield absorbs (or blocks entirely depending on powerup) |
| Match ends while DEAD | Stay DEAD, respawn timer paused, no respawn — transition to IDLE on next match |
| Player disconnects | Server forces DEAD immediately, broadcasts `_rpc_kart_disconnect`, cleans up kart node |
| Player reconnects mid-match | Treated as new join: goes through late join protocol → spawns in RESPAWNING state |
| Two damage events on same frame | Process sequentially: first may reduce HP, second may trigger DEAD |
| INVULNERABLE expires while drifting | Always exits to DRIVING (no sub-state restoration — simplicity over correctness) |
| Weapon pickup while INVULNERABLE | Allowed — INVULNERABLE blocks damage, not pickups |

### Match Domain

| Scenario | Resolution |
|---|---|
| Player joins during COUNTDOWN | Allowed, spawns at match start |
| Player joins during PLAYING | Allowed, spawns in RESPAWNING state with full invuln window |
| Player joins during ENDED | Allowed, enters next match |
| All players leave during PLAYING | Transition to WAITING, abandon scores |
| Player count exceeds max (10) during join | Reject connection before state change |
| Tie at match end (same kill count) | winner_peer_id = -1 (no winner), display as tie |

### Weapon Domain

| Scenario | Resolution |
|---|---|
| Fire input during COOLDOWN | Buffer for 1 physics tick only. If still COOLDOWN after 1 tick, discard |
| Fire input while kart is DEAD | Rejected at weapon SM level (double-gated with kart SM) |
| Weapon pickup while ARMED | Current weapon replaced, remaining ammo discarded |
| Kart dies while FIRING | Projectile already spawned completes normally, slot → EMPTY on respawn |
| Two pickups hit simultaneously | Server single-threaded: last RPC processed wins |

---

## Dependencies

### Upstream (this system depends on)

None — State Machine is Layer 1 Foundation.

### Downstream (depends on this system)

| System | What it needs from State Machine |
|---|---|
| **Health & Damage** | Kart states to determine if damage applies (INVULNERABLE blocks) |
| **Camera System** | Kart states for camera behavior (death cam, spectate on DEAD) |
| **Kart Physics** | Kart states to enable/disable movement (DEAD = no physics) |
| **Spawn System** | Kart DEAD→RESPAWNING transition triggers spawn point selection |
| **Match System** | Match states drive the entire match flow |
| **Kart Classes** | Kart states determine when class abilities are active |

### Interface Contract

Other systems connect via signals (listed in Interactions section).
State changes are the **only** way to modify what a kart can do — no direct
bool checks. Systems ask `get_kart_state(peer_id) -> KartState` or subscribe
to `kart_state_changed` signal.

---

## Tuning Knobs

| Knob | Default | Safe Range | Affects | Too Low | Too High |
|---|---|---|---|---|---|
| `respawn_delay` | 3.0s | 1.0 - 5.0s | Death penalty | No death stakes | Waiting is boring |
| `respawn_invuln_duration` | 2.0s | 0.5 - 3.0s | Respawn safety | Spawn-killed immediately | Too much free time |
| `match_countdown_duration` | 3.0s | 3.0 - 5.0s | Match start ceremony | Too rushed | Boring wait |
| `match_duration` | 180s | 60 - 300s | Match length | Too short for fun | Overstays welcome |
| `match_restart_delay` | 10.0s | 5.0 - 15.0s | Between matches | No time to see scores | Waiting |
| `min_players_to_start` | 2 | 1 - 10 | Match start requirement | Solo play (pointless) | Hard to start |
| `drift_min_speed` | TBD | — | When drift activates | Drift at standstill (weird) | Can never drift |
| `velocity_idle_threshold` | 0.5 m/s | 0.1 - 1.0 | DRIVING→IDLE transition | Jitters between states | Stuck in DRIVING while stopped |
| `fire_input_buffer_ticks` | 1 | 0 - 3 | Weapon responsiveness | Dropped inputs | Spray exploit |

---

## Visual/Audio Requirements

### State-Driven Visual Feedback

| State | Visual | Audio |
|---|---|---|
| DEAD | Explosion VFX, kart fades out | Explosion SFX |
| RESPAWNING | Kart fades in with shield glow, semi-transparent | Spawn chime |
| INVULNERABLE | Shield bubble VFX around kart | Shield hum (loop) |
| COUNTDOWN | Large 3-2-1-GO text on screen | Countdown beeps + GO horn |
| ENDED | Screen dims slightly, scoreboard overlay | Match end fanfare |

### Implementation Note

VFX/Audio are triggered by `state_changed` signals — the State Machine does not
own visual/audio code. VFX System and Audio System subscribe to signals.

---

## UI Requirements

| State | UI Change |
|---|---|
| DEAD | Show respawn timer countdown on screen center |
| RESPAWNING | Show "INVULNERABLE" indicator near HP bar |
| INVULNERABLE | Show shield icon + remaining time near HP bar |
| COUNTDOWN | Show countdown overlay (3, 2, 1, GO!) full screen |
| PLAYING | Show match timer in HUD top center |
| ENDED | Show scoreboard overlay with stats, MVP, next match timer |
| FIRING | Brief muzzle flash icon on weapon indicator |
| COOLDOWN | Weapon icon grayed out with cooldown progress |

---

## Acceptance Criteria

### Functional Tests (automated)

- [ ] Kart in DEAD state cannot move or receive input
- [ ] Kart in RESPAWNING state cannot take damage
- [ ] Kart in INVULNERABLE state cannot take damage
- [ ] DEAD automatically transitions to RESPAWNING after respawn_delay
- [ ] Match COUNTDOWN transitions to PLAYING after 3 seconds
- [ ] Match PLAYING transitions to ENDED when timer expires
- [ ] Weapon FIRING transitions to COOLDOWN (ammo > 0) or EMPTY (ammo = 0)
- [ ] Fire input rejected when kart is DEAD
- [ ] Invalid transitions (e.g., DEAD → DRIFTING) are silently ignored
- [ ] All state transitions emit correct signals with correct parameters
- [ ] Cross-domain: Match ENDED forces all karts to IDLE and weapons to EMPTY

### Network Tests (automated)

- [ ] State changes originate from server only (except client requests)
- [ ] Client request → server validates → broadcasts to all peers
- [ ] State is consistent across all connected clients after transition
- [ ] Late-joining player receives correct current state for all entities

### Playtest Criteria (human)

- [ ] Respawn delay feels fair (3s default)
- [ ] Respawn invulnerability gives enough time to reposition
- [ ] Match countdown builds anticipation
- [ ] No state where player is stuck or confused about what's happening

---

## Open Questions

1. **Spectate on death**: Should DEAD state allow camera switching to spectate
   other players? Depends on Camera System design.

2. **Match end behavior**: Should players be frozen (IDLE) or free to drive
   around during ENDED scoreboard phase? Current design: forced IDLE.

3. **Weapon on death**: Current design discards weapon on death. Alternative:
   keep weapon through respawn. SmashKarts discards — we follow reference.
