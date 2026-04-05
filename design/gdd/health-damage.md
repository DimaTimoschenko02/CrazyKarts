# Health & Damage System

> **Status**: In Design
> **Author**: Dima + game-designer + systems-designer + godot-specialist + lead-programmer + technical-director
> **Last Updated**: 2026-04-04
> **Implements Pillar**: Аркадный хаос (fast damage, quick kills, constant action)

## Overview

Health & Damage — серверно-авторитетная система управления HP, получения урона
и отслеживания убийств/ассистов. Реализуется как `HealthComponent` нода,
прикреплённая к каждому карту. Единый source of truth для HP — сам компонент.

GameManager перестаёт хранить HP — становится match-level orchestrator
(kills, deaths, scores). Все источники урона (ракеты, AOE, контакт, окружение)
общаются через единый `DamageInfo` интерфейс.

Игрок видит HP-бар и килфид. Система невидима — но определяет "жив ты или мёртв".

## Player Fantasy

"Я чувствую каждый удар. Попал ракетой — враг реагирует (hit stun). Два точных
попадания — он мёртв. Я знаю сколько HP у меня осталось, знаю когда пора убегать.
Если меня добили — это было честно и быстро, через 3 секунды я снова в игре."

Pillar alignment: **Аркадный хаос** — TTK 2-4 секунды, быстрая смерть =
быстрый respawn = быстро обратно в экшен.

## Detailed Design

### Core Rules

1. Each kart has a `HealthComponent` node with `max_hp` and `current_hp`
2. All damage calculated on server only (`multiplayer.is_server()`)
3. Damage sources deliver `DamageInfo` to `HealthComponent.apply_damage()`
4. HealthComponent checks KartState before applying: INVULNERABLE/RESPAWNING → reject
5. `final_damage = base_damage * class_resist_modifier` (receive-time scaling)
6. HP clamped to `[0, max_hp]` — no negative, no overheal
7. HP = 0 → emit `died` signal → State Machine transitions to DEAD
8. HP > 0 after damage → emit `damaged` signal (no state transition — kart continues driving)
9. Kill credit: last hit gets Kill (+100 pts). Anyone who dealt damage within
   5 sec assist window gets Assist (+50 pts)
10. Overkill: HP clamped to 0 for gameplay, raw damage tracked for analytics
11. No per-hit invulnerability frames (respawn i-frames only, from State Machine)
12. No HP regen at MVP. Future: kart classes may have regen as @export on HealthComponent

### DamageInfo Structure

```gdscript
class_name DamageInfo extends RefCounted

enum Type { PROJECTILE, AOE_EXPLOSION, CONTACT, ENVIRONMENTAL }

var type: Type
var amount: int              # base damage before modifiers
var attacker_id: int = -1    # -1 = environment / self-damage
var weapon_name: String = "" # for analytics ("rocket_launcher", "mine", etc.)
var position: Vector3        # impact point (for VFX, directional indicators)
```

### HealthComponent

```
KartController (CharacterBody3D)
├── HealthComponent (Node)    ← owns HP, signals, apply_damage()
├── BaseCar (model)
├── Camera3D
└── NameLabel (Label3D)
```

**Signals:**
```gdscript
signal damaged(info: DamageInfo)
signal died(killer_id: int)
signal hp_changed(current: int, maximum: int)
```

**Server-side flow:**
1. Damage source creates `DamageInfo`
2. Calls `target_kart.health_component.apply_damage(info)`
3. HealthComponent checks State Machine → reject if invulnerable
4. Applies `final_damage = info.amount * class_resist_modifier`
5. Updates `current_hp`, syncs via `_rpc_sync_hp.rpc(current_hp)`
6. Emits `damaged` or `died` signal
7. Records to EventBus for analytics

**Client-side:**
- Receives `_rpc_sync_hp` → updates local HP → emits `hp_changed` for HUD
- Receives death/hit via State Machine RPC (from State Machine GDD)

### AOE Damage

Linear falloff from explosion center:

```
aoe_damage = base_damage * max(0.0, 1.0 - (distance / explosion_radius))
```

- Direct center hit (dist=0): 100% damage
- Half radius: 50% damage
- Edge of radius: 0% damage
- Self-damage applies (same formula)

### Damage Types

`DamageInfo.Type` enum exists but has no gameplay effect at MVP.
All types deal damage identically. Future use: ENVIRONMENTAL may bypass Shield powerup.

### Interactions with Other Systems

| System | Direction | Interface |
|--------|-----------|-----------|
| **State Machine** | ← reads | HealthComponent reads KartState to gate damage (INVULNERABLE/RESPAWNING blocks) |
| **State Machine** | → triggers | `died` signal → KartState.DEAD |
| **Network Layer** | → uses | `_rpc_sync_hp` (reliable, S→all), kill/assist RPCs |
| **Weapon System** | ← receives | Weapons create DamageInfo and call apply_damage() |
| **Powerup System** | ← receives | Shield powerup sets INVULNERABLE state (blocks damage via SM) |
| **Powerup System** | ← receives | Spikes powerup creates DamageInfo(CONTACT) on collision |
| **Kart Classes** | ← reads | max_hp and class_resist_modifier from KartStats Resource |
| **Match System** | → feeds | Kill/assist events feed match scoring |
| **HUD** | → feeds | hp_changed signal updates HP bar |
| **Analytics** | → feeds | EventBus signals: damage_dealt, player_killed |
| **VFX System** | → feeds | damaged signal triggers hit flash, died triggers explosion |

### EventBus (Analytics Decoupling)

New autoload `EventBus` with signals:
```gdscript
signal damage_dealt(attacker_id: int, victim_id: int, info: DamageInfo, final_amount: int)
signal player_killed(victim_id: int, killer_id: int, info: DamageInfo)
signal player_assisted(assister_id: int, victim_id: int)
```

GameManager emits these. Analytics subscribes. Zero coupling.

## Formulas

### Base Damage

```
final_damage = floor(base_damage * class_resist_modifier)
```

| Variable | Type | Range | Source |
|---|---|---|---|
| `base_damage` | int | 5-60 | Weapon Resource |
| `class_resist_modifier` | float | 0.85-1.2 | Kart Class Resource |
| `final_damage` | int | 4-72 | Applied to HP |

### Class Modifiers (future, MVP = all 1.0)

| Kart Class | max_hp | resist_modifier | Notes |
|---|---|---|---|
| Standard | 100 | 1.0 | Baseline |
| Heavy | 150 | 0.85 | Tank |
| Light | 70 | 1.2 | Glass cannon |
| Healer | 100 | 1.0 | Future: has regen |

### AOE Falloff

```
aoe_damage = floor(base_damage * max(0.0, 1.0 - (distance / explosion_radius)))
```

| Variable | Type | Range |
|---|---|---|
| `distance` | float | 0 — explosion_radius |
| `explosion_radius` | float | 3.5m (rocket default) |
| `base_damage` | int | 40 (rocket) |
| Output | int | 0-40 |

**Example calculations (Rocket, radius 3.5m):**
- dist 0.0m → 40 dmg (direct hit)
- dist 1.0m → 29 dmg
- dist 1.75m → 20 dmg (half radius)
- dist 3.0m → 6 dmg
- dist 3.5m → 0 dmg (edge)

### Assist Window

```
is_assist = (time_since_damage <= ASSIST_WINDOW) AND (attacker_id != killer_id)
```

| Variable | Value |
|---|---|
| ASSIST_WINDOW | 5.0 sec |
| Assist threshold | Any damage (no minimum) |

### TTK (Time to Kill) — Rocket vs Standard (100 HP)

```
rockets_to_kill = ceil(100 / 40) = 3 direct hits
time_to_kill = (rockets_to_kill - 1) * fire_rate = 2 * 1.25s = 2.5 sec
```

### Weapon TTK Summary

| Weapon | base_dmg | Fire rate | vs Standard (100 HP) | vs Heavy (128 effective) | vs Light (58 effective) |
|---|---|---|---|---|---|
| Rocket (direct) | 40 | 1.25s/shot | 2.5s (3 hits) | 3.75s (4 hits) | 1.25s (2 hits) |
| Shotgun (all pellets) | 55 | 1.5s/shot | 1.5s (2 hits) | 3.0s (3 hits) | 1.5s (2 hits) |
| Mine | 60 | proximity | instant | 2 mines | instant |
| Laser | 8/tick @6Hz | continuous | ~2.1s | ~3.5s | ~1.2s |

Note: "effective HP" = max_hp / resist_modifier (Heavy: 150/0.85≈176, but displayed as 150 HP)

### Kill Scoring

| Event | Points |
|---|---|
| Kill | +100 |
| Assist | +50 |
| Death | 0 (no penalty) |

## Edge Cases

| Scenario | Resolution |
|---|---|
| Damage while INVULNERABLE/RESPAWNING | Rejected by HealthComponent (checks State Machine) |
| Damage while DEAD | Rejected (HP already 0) |
| Self-damage (own rocket AOE) | Allowed — same formula, attacker_id = self |
| Negative damage (healing attempt) | Clamped to 0 — no healing at MVP |
| HP goes below 0 | Clamped to 0, excess not applied |
| Two damage events same frame | Processed sequentially by server. First reduces HP, second may trigger DEAD |
| Assist by self | Impossible — attacker_id == killer_id filtered out |
| Multiple assisters | All qualify — each gets +50 pts. No cap |
| Fire at dead kart | No HealthComponent response (HP=0 check), rocket passes through |
| Damage from disconnected player | attacker_id invalid → credit as environment kill, no assist |
| Match ends during damage | Damage still applies (match end processes after physics frame) |
| Healer regen (future) | Delay after damage (3s), capped, stops at max_hp. Details TBD with kart classes |

## Dependencies

### Upstream (this system depends on)

| System | Dependency | Type |
|---|---|---|
| **State Machine** | KartState for damage gating | Hard — cannot function without |
| **Network Layer** | RPC for HP sync, kill broadcast | Hard — cannot function without |

### Downstream (depends on this system)

| System | What it needs |
|---|---|
| **Kart Classes** | max_hp, resist_modifier from Resource → HealthComponent |
| **Weapon System** | DamageInfo interface for all weapons |
| **Powerup System** | DamageInfo(CONTACT) for Spikes, INVULNERABLE state for Shield |
| **Match System** | Kill/assist events for scoring |
| **HUD** | hp_changed signal for HP bar |
| **Analytics (in-game)** | EventBus signals for stats |
| **VFX System** | damaged/died signals for effects |
| **Spawn System** | died signal triggers respawn flow |

### Interface Contract

- All damage goes through `HealthComponent.apply_damage(DamageInfo)` — no exceptions
- HealthComponent emits signals — consumers subscribe, never poll
- GameManager delegates to EventBus for analytics — no direct coupling
- HP sync via reliable RPC from server — clients never modify HP locally

## Tuning Knobs

| Knob | Default | Safe Range | Affects | Too Low | Too High |
|---|---|---|---|---|---|
| `base_hp` | 100 | 50-200 | Survivability | Instant deaths | Spongy, boring |
| `rocket_damage` | 40 | 20-60 | Rocket TTK | Rockets feel weak | One-shot kills |
| `explosion_radius` | 3.5m | 2.0-5.0m | AOE area | Hard to hit | Unavoidable splash |
| `class_resist_modifier` | 1.0 | 0.5-1.5 | Class balance | Class too squishy | Class unkillable |
| `assist_window` | 5.0s | 3.0-10.0s | Assist frequency | Too few assists | Everyone gets assist |
| `kill_points` | 100 | 50-200 | Score pacing | Low engagement | Score inflation |
| `assist_points` | 50 | 25-100 | Support reward | Support unrewarded | Assists > kills |

### Knob Interactions

- `base_hp` × `rocket_damage` = TTK. Change one, check TTK table.
- `explosion_radius` × `rocket_damage` = splash pressure. Large radius + high damage = unavoidable.
- `class_resist_modifier` × `base_hp` = effective HP. Heavy with high resist + high HP = unkillable.

## Visual/Audio Requirements

| Event | Visual | Audio |
|-------|--------|-------|
| Take damage | Kart flashes red (0.1s), damage number popup | Impact thud SFX |
| Low HP (<30%) | HP bar pulses red, screen edge vignette | Heartbeat/warning loop |
| Death | Explosion VFX, kart fades out | Explosion SFX |
| Kill confirmed | "+100" popup on killer's screen, killfeed entry | Kill confirm chime |
| Assist | "+50 Assist" popup, killfeed entry | Soft assist chime |
| Shield blocks damage | Shield flash VFX, no HP change | Shield clang SFX |

## UI Requirements

| Element | Location | Updates |
|---------|----------|---------|
| HP bar | HUD bottom-center | On hp_changed signal |
| Damage numbers | World-space above hit kart | On damaged signal |
| Kill feed | HUD top-right, last 5 entries | On kill/assist events |
| Kill popup | HUD center-bottom, brief flash | On kill confirmed |
| Death screen | Overlay with "Killed by [name]" | On died signal |

## Acceptance Criteria

### Functional Tests (automated)

- [ ] HealthComponent.apply_damage() reduces HP by final_damage
- [ ] Damage rejected when KartState is INVULNERABLE or RESPAWNING
- [ ] Damage rejected when current_hp <= 0 (already dead)
- [ ] HP never goes below 0 or above max_hp
- [ ] `died` signal emitted when HP reaches 0
- [ ] `damaged` signal emitted when HP reduced but > 0
- [ ] AOE damage decreases linearly with distance, 0 at edge
- [ ] Self-damage from own AOE works correctly
- [ ] Assist awarded to all who damaged victim within 5 sec window
- [ ] Assist not awarded to killer (no self-assist)
- [ ] DamageInfo.type field populates correctly per source
- [ ] Kill/assist points added to match scores correctly

### Network Tests (automated)

- [ ] HP sync: all clients show same HP after damage
- [ ] Kill broadcast: all clients see killfeed entry
- [ ] Server-only: client cannot call apply_damage() and have it take effect
- [ ] Late join: new player sees correct HP for all karts

### Playtest Criteria (human)

- [ ] Rocket direct hit feels impactful (visual + audio feedback)
- [ ] TTK feels right — 2-3 rockets to kill, not too fast or slow
- [ ] Low HP warning is noticeable but not annoying
- [ ] Kill confirmation feedback is satisfying
- [ ] Death screen shows useful info (who killed you, with what)

## Open Questions

1. **Damage numbers**: World-space floating numbers or HUD-only? SmashKarts
   doesn't show damage numbers. Could add visual noise in chaotic matches.

2. **Kill cam**: Show killer's position briefly on death? Helps learning
   but reveals enemy position.

3. **Minimum damage**: Should there be a minimum of 1 damage per hit?
   Or can AOE at edge deal 0? Current: 0 at edge (no damage outside radius).

4. **Regen details**: When kart classes ship, nail down regen rate, delay,
   cap. Current: deferred, marked as @export on HealthComponent for future.
