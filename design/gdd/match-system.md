# Match System

> **Status**: In Design
> **Author**: Dima + game-designer + godot-specialist + lead-programmer + systems-designer
> **Last Updated**: 2026-04-05
> **Implements Pillar**: Аркадный хаос (fast matches, constant action), Играй с друзьями (low friction loop)

## Overview

Match System — координатор всего game flow: match start, timer, scoring, end
conditions, scoreboard, restart. Реализуется через расширение существующего
GameManager autoload (уже хранит kills/deaths) — добавляем MatchState, timer,
match config, scoreboard logic.

GameManager остаётся единственным autoload для match-level данных. Не создаём
отдельный MatchManager — это был бы дублирующий класс. HP логика уже вынесена
в HealthComponent (Health & Damage GDD).

## Player Fantasy

"Матч стартует — 3-2-1-GO — и понеслось. Три минуты чистого хаоса. Таймер тикает,
я знаю сколько осталось. Время вышло — скорборд: кто MVP, сколько я набил, полная
стата. Через 10 секунд — новый раунд. Никаких пауз, никаких лобби между матчами."

## Detailed Design

### Core Rules

1. GameManager autoload расширяется match-логикой (не отдельный класс)
2. MatchState transitions server-only (from State Machine GDD)
3. Match timer: Godot Timer node на сервере, 1Hz sync на клиентов
4. Scoring: Kill=+100, Assist=+50, Death=0 (from Health & Damage GDD)
5. Win condition: highest score at timer end
6. Tiebreak: Kills > Assists > Fewer Deaths
7. MVP: multi-category (Score, Kills, Assists, Damage, Streak)
8. Post-match: 10s scoreboard → auto-restart same map (reload scene)
9. Match config from MatchConfigResource (.tres)
10. One game.tscn with UI overlays (lobby, scoreboard) — no scene switching during match

### MatchConfigResource

```gdscript
class_name MatchConfigResource extends Resource

@export_group("Timing")
@export var duration: float = 180.0          # match length (seconds)
@export var countdown_duration: float = 3.0  # 3-2-1-GO
@export var restart_delay: float = 10.0      # scoreboard display time

@export_group("Players")
@export var min_players: int = 2
@export var max_players: int = 10

@export_group("Map")
@export_file("*.tscn") var map_path: String = "res://Maps/map_1.tscn"
```

Stored as `res://config/match_default.tres`. Editable in inspector.
Future: lobby UI exposes duration/map selection → writes to config.

### GameManager Extensions

**Current** GameManager autoload:
- `players: Dictionary` (peer_id → {name, kills, deaths})
- `deal_damage()`, `_process_kill()`, `_rpc_kill()`
- signals: `scores_updated`, `player_respawned`

**Added for Match System:**
```gdscript
# Match state
var match_state: MatchState = MatchState.WAITING
var match_config: MatchConfigResource
var _match_timer: Timer
var _restart_timer: Timer

# Per-match scoring
var match_scores: Dictionary = {}  # peer_id → MatchScore

# Signals
signal match_state_changed(from: MatchState, to: MatchState)
signal match_countdown_tick(seconds_remaining: int)
signal match_timer_tick(seconds_remaining: float)
signal match_ended(results: MatchResults)
```

### MatchScore (per player per match)

```gdscript
class MatchScore:
    var kills: int = 0
    var deaths: int = 0
    var assists: int = 0
    var damage_dealt: int = 0
    var best_streak: int = 0
    var current_streak: int = 0
    var score: int = 0          # kills*100 + assists*50
```

Updated on every kill/assist/damage event. Reset on match restart.

### Match Flow

```
WAITING
  │  Lobby overlay shown. Players join.
  │  Lobby-owner sees "Start" button when player_count >= min_players.
  │
  ├─► Lobby-owner clicks Start
  │
COUNTDOWN (3s)
  │  All karts → IDLE (frozen by State Machine).
  │  HUD shows 3-2-1-GO overlay.
  │  match_countdown_tick signal every second.
  │
  ├─► Timer expires
  │
PLAYING (configurable: 120/180/300s)
  │  All karts → DRIVING allowed.
  │  All pickups active.
  │  Match timer ticking, synced 1Hz to clients.
  │  Kills/assists/damage tracked in MatchScore.
  │
  ├─► Timer expires OR all players disconnect
  │
ENDED (10s)
  │  All karts → IDLE. All weapons → EMPTY.
  │  Scoreboard overlay: full stats, MVP awards.
  │  Camera → SCOREBOARD mode.
  │
  ├─► Restart timer (10s) expires
  │
  └─► get_tree().reload_current_scene()
      (MatchConfig preserved in autoload, scores reset)
```

### Match State Transitions (from State Machine GDD)

| From | To | Trigger | Authority |
|------|-----|---------|-----------|
| WAITING | COUNTDOWN | lobby-owner Start + player_count >= min | Server only |
| COUNTDOWN | PLAYING | 3s timer expires | Server timer |
| COUNTDOWN | WAITING | Players drop below min | Server only |
| PLAYING | ENDED | Match timer expires | Server timer |
| PLAYING | ENDED | Only 1 player left in session | Server only |
| PLAYING | WAITING | All players disconnect | Server only |
| ENDED | Restart | 10s auto-restart timer | Server timer |

### Lobby-Owner

- First connected peer = lobby-owner
- If lobby-owner disconnects → reassigned to next peer (lowest peer_id)
- Only lobby-owner can click Start in lobby UI
- Server validates: `_rpc_request_start()` checks sender == lobby-owner_id

### Scoreboard & MVP

**Scoreboard columns per player:**

| Column | Source | Sort |
|--------|--------|------|
| Score | kills×100 + assists×50 | Primary sort (descending) |
| Kills | MatchScore.kills | — |
| Deaths | MatchScore.deaths | — |
| Assists | MatchScore.assists | — |
| Damage | MatchScore.damage_dealt | — |

**MVP Awards (multi-category):**

| Award | Criteria | Icon |
|-------|----------|------|
| MVP (Overall) | Highest score | Crown |
| Most Kills | Highest kills count | Skull |
| Most Assists | Highest assists count | Handshake |
| Most Damage | Highest damage_dealt | Crosshair |
| Longest Streak | Highest best_streak | Fire |

Each award shown next to winner's name on scoreboard. One player can win multiple.

**Tiebreak for Score ranking:**
```
sort_key = (score, kills, assists, -deaths)
```
Compare score first, then kills, then assists, then fewer deaths.

### Timer Implementation

**Server-side Timer nodes in GameManager:**
```gdscript
var _countdown_timer: Timer   # 3s, one-shot
var _match_timer: Timer       # configurable, one-shot
var _restart_timer: Timer     # 10s, one-shot
```

**Client sync (1Hz):**
```gdscript
# Server sends every second during PLAYING:
@rpc("authority", "call_remote", "unreliable")
func _rpc_match_timer(seconds_remaining: float) -> void:
    _client_match_time_remaining = seconds_remaining
    match_timer_tick.emit(seconds_remaining)
```

Unreliable — loss acceptable, next tick corrects. HUD updates from signal.

### Map Loading

Maps are sub-scenes under ArenaRoot in game.tscn:
```gdscript
func _load_map() -> void:
    for child in _arena_root.get_children():
        child.queue_free()
    var map := load(match_config.map_path).instantiate()
    _arena_root.add_child(map)
```

Called in `_ready()` on server, map path included in world_state for late joiners.

### Restart Flow

```gdscript
func _on_restart_timer_timeout() -> void:
    # Reload scene — all nodes recreated, autoloads persist
    # MatchConfig preserved, scores reset automatically
    get_tree().reload_current_scene()
```

Clean restart: SpawnManager, HealthComponents, WeaponComponents all recreated fresh.
Cost: ~100-200ms on HTML5 — acceptable.

### Interactions with Other Systems

| System | Direction | Interface |
|--------|-----------|-----------|
| **State Machine** | ← owns | MatchState transitions. Kart forced IDLE on COUNTDOWN/ENDED |
| **State Machine** | → triggers | PLAYING enables kart DRIVING. ENDED clears weapons. |
| **Health & Damage** | ← listens | `damage_dealt`, `player_killed`, `player_assisted` from EventBus |
| **Spawn System** | → triggers | PLAYING → initial spawn for all via SpawnManager |
| **Weapon System** | → triggers | ENDED → all weapons EMPTY |
| **Camera System** | → triggers | COUNTDOWN/SCOREBOARD camera modes |
| **Network Layer** | → uses | MatchState RPC, timer 1Hz RPC, scoreboard data in world_state |
| **Pickup System** | → triggers | PLAYING → all pickups active |
| **Lobby** | ← receives | MatchConfigResource, lobby-owner Start request |
| **HUD** | → feeds | Timer, scores, countdown overlay, scoreboard overlay |
| **Analytics** | → feeds | match_ended signal with full MatchResults |

### Network Sync

| Data | Frequency | Reliability |
|------|-----------|-------------|
| MatchState changes | On change | reliable |
| Match timer | 1Hz during PLAYING | unreliable |
| Countdown tick | Every second during COUNTDOWN | reliable |
| Scoreboard data | On ENDED | reliable |
| Kill/assist events | On event | reliable (existing) |

**Late join:** world_state includes `match_state`, `match_timer_remaining`,
all player scores, lobby-owner_id.

## Formulas

### Score Calculation

```
player_score = kills * KILL_POINTS + assists * ASSIST_POINTS
KILL_POINTS = 100
ASSIST_POINTS = 50
```

### Kill Streak

```
on_kill:
    current_streak += 1
    best_streak = max(best_streak, current_streak)
on_death:
    current_streak = 0
```

### Tiebreak Sort Key

```
sort_key(player) = (score DESC, kills DESC, assists DESC, deaths ASC)
```

### MVP Selection

```
mvp_score    = argmax(player.score)
mvp_kills    = argmax(player.kills)
mvp_assists  = argmax(player.assists)
mvp_damage   = argmax(player.damage_dealt)
mvp_streak   = argmax(player.best_streak)
```

Ties within MVP category: use tiebreak sort key. Multiple awards to same player allowed.

### Expected Score Ranges (3 min match, 6 players)

| Skill | Kills | Assists | Score |
|-------|-------|---------|-------|
| Low | 2-3 | 1 | 250-350 |
| Median | 5-6 | 2-3 | 600-750 |
| High | 10-12 | 3-5 | 1,150-1,450 |

## Edge Cases

| Scenario | Resolution |
|---|---|
| Only 1 player in WAITING | Cannot start — min_players not met |
| Players drop below min during COUNTDOWN | Abort → WAITING |
| All players leave during PLAYING | → WAITING (abandon scores) |
| 1 player left during PLAYING | → ENDED (they win by default) |
| Player joins during PLAYING | Late join protocol, spawn RESPAWNING, sees timer + scores |
| Player joins during ENDED | Enters next match on restart |
| Player joins during COUNTDOWN | Spawns, participates from GO |
| Lobby-owner disconnects in WAITING | Reassign to lowest peer_id |
| Lobby-owner disconnects in PLAYING | Match continues — lobby-owner irrelevant during play |
| Kill happens at exact match end (same frame) | Process kill first, then end. Kill counts. |
| Timer shows 0 but ENDED not yet fired | Timer RPC is unreliable — client may show 0 for up to 1s before ENDED |
| Tie in MVP category | Use tiebreak sort key for that category |
| Player has 0 kills, 0 assists, 0 damage | Still appears on scoreboard. No MVP awards. |
| Match restart while late joiner connecting | Joiner enters fresh match (scene reloaded) |

## Dependencies

### Upstream

| System | Dependency | Type |
|---|---|---|
| **State Machine** | MatchState enum + transitions | Hard |
| **Network Layer** | RPCs for state, timer, scoreboard | Hard |
| **Health & Damage** | EventBus signals for kills/assists/damage | Hard |
| **Spawn System** | Initial spawn on PLAYING | Hard |

### Downstream

| System | What it needs |
|---|---|
| **HUD** | Timer display, countdown overlay, scoreboard |
| **Camera System** | COUNTDOWN, SCOREBOARD camera modes |
| **Weapon System** | ENDED clears all weapons |
| **Lobby** | Match config delivery, Start button state |
| **Analytics** | match_ended with full MatchResults |

### Interface Contract

- GameManager.match_state is read-only for all other systems
- State changes via signals (match_state_changed) — never polled
- Scoring events come through EventBus — GameManager subscribes
- Timer sync is informational (1Hz unreliable) — clients don't make decisions from it
- Restart = full scene reload — all systems recreated clean

## Tuning Knobs

| Knob | Default | Safe Range | Affects |
|------|---------|------------|---------|
| `match_duration` | 180s | 60-300s | Match length |
| `countdown_duration` | 3.0s | 3-5s | Start ceremony |
| `restart_delay` | 10.0s | 5-15s | Scoreboard view time |
| `min_players` | 2 | 1-10 | Lobby start requirement |
| `max_players` | 10 | 2-10 | Room capacity |
| `kill_points` | 100 | 50-200 | Score pacing |
| `assist_points` | 50 | 25-100 | Support reward |
| `timer_sync_hz` | 1 | 1-5 | Timer update frequency |

### Knob Interactions
- `match_duration` × player skill = expected kills per match
- `kill_points` / `assist_points` ratio = support vs frag incentive
- `restart_delay` = scoreboard read time. Too short = can't read stats

## Visual/Audio Requirements

| Event | Visual | Audio |
|-------|--------|-------|
| COUNTDOWN 3-2-1 | Large numbers center screen | Countdown beeps |
| GO! | Flash + text | Horn/bell SFX |
| Match timer < 30s | Timer turns red, pulses | Ticking sound |
| Match timer = 0 | Flash | Match end horn |
| Kill achieved | "+100" popup + killfeed | Kill chime |
| Assist achieved | "+50 Assist" popup | Soft chime |
| Scoreboard appear | Overlay with player rows, MVP badges | Fanfare |
| Restart countdown | "Next match in Xs" text | — |
| New kill streak (3+) | "Streak: X" popup | Streak SFX escalating |

## UI Requirements

| Element | Location | Updates |
|---------|----------|---------|
| Match timer | HUD top center | Every second (match_timer_tick) |
| Countdown overlay | Screen center, large | 3, 2, 1, GO! |
| Live scoreboard (Tab) | HUD overlay | On scores_updated |
| End scoreboard | Full overlay | On match_ended |
| MVP badges | Next to winner names on scoreboard | On match_ended |
| Restart timer | Scoreboard bottom | Countdown to next match |
| Player count | Lobby | On join/leave |
| Start button | Lobby (owner only) | Enabled when min_players met |

## Acceptance Criteria

### Functional Tests (automated)

- [ ] WAITING → COUNTDOWN when lobby-owner starts + min_players met
- [ ] COUNTDOWN → PLAYING after 3s
- [ ] PLAYING → ENDED after match_duration expires
- [ ] ENDED → restart (scene reload) after restart_delay
- [ ] Kill awards +100 score, assist awards +50
- [ ] Kill streak increments and resets on death
- [ ] MVP awards assigned to correct players (multi-category)
- [ ] Tiebreak: kills > assists > fewer deaths
- [ ] Scoreboard shows all 5 columns (Score/Kills/Deaths/Assists/Damage)
- [ ] Late joiner receives match_state + timer + scores via world_state
- [ ] 1 player left → ENDED
- [ ] All players leave → WAITING
- [ ] Lobby-owner disconnect → reassigned

### Network Tests

- [ ] MatchState changes broadcast reliably to all clients
- [ ] Timer syncs at 1Hz (unreliable, drift < 1s)
- [ ] Scoreboard data delivered on ENDED (reliable)
- [ ] Late join: correct match state and timer displayed

### Playtest Criteria (human)

- [ ] Countdown builds anticipation (3-2-1-GO feels exciting)
- [ ] Match timer is always visible and readable
- [ ] Score popups are noticeable but not distracting
- [ ] Scoreboard is readable — all stats clear
- [ ] MVP awards feel earned and fun
- [ ] Auto-restart feels seamless — no dead time
- [ ] 10s scoreboard is enough time to read stats

## Open Questions

1. **Lobby UI**: Currently a separate scene (lobby.tscn). Migrate to overlay
   in game.tscn? Or keep separate scene and scene-switch? Affects MatchManager
   lifecycle. Defer to implementation.

2. **Map voting**: When 2-3 maps exist, add map vote during ENDED phase?
   Or separate map rotation? Defer to Alpha.

3. **Match history persistence**: Currently in-memory, lost on restart.
   Analytics backend (NestJS + PostgreSQL) deferred to Beta.

4. **First Blood bonus**: +25 pts for first kill of match? Adds
   excitement to match start. Nice-to-have, not MVP.

5. **Mercy rule**: If score gap > X, end match early? Prevents stomps.
   Risk: frustrates losing team who could comeback. Defer to playtest.
