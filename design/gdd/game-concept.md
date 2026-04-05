---
status: reverse-documented
source: smash-karts-clone/
date: 2026-04-03
verified-by: Dima
---

# SmashKarts Clone — Game Concept Document

> **Note**: This document was reverse-engineered from the existing implementation
> and supplemented with the creator's vision. It captures current behavior,
> clarified design intent, and planned features.

---

## 1. Elevator Pitch

3D мультиплеер аркадная арена с картами и оружием для игры с друзьями в браузере.
Вдохновлено SmashKarts.io — но без рекламы, пассов и скинов. Фокус на чистом
геймплее: дрифт, стрельба, хаос, смех.

---

## 2. Core Pillars

| Pillar | Description |
|--------|-------------|
| **Аркадный хаос** | Быстрые матчи, постоянный экшен, никаких пауз. Подобрал оружие — стреляй. |
| **Вариативность** | Классы машин с разными характеристиками. Оружия и бафы меняют тактику. |
| **Играй с друзьями** | Минимальный барьер входа: ссылка → браузер → играешь. Никакой регистрации. |
| **Честная игра** | Никаких pay-to-win механик. Все машины и оружия доступны всем. |

---

## 3. Target Platform

- **Primary**: HTML5 (браузер) — Chrome, Firefox, Edge
- **Secondary** (future): Desktop (Windows) — standalone билд
- **Engine**: Godot 4.6, GL Compatibility renderer
- **Networking**: WebSocket (совместим с браузером и desktop)

---

## 4. Players & Sessions

- **Room size**: 2-10 игроков (оптимум 4-6)
- **Hosting**: Dedicated Godot headless on VPS (Linux, 8GB RAM). Nginx serves HTML5 build. No ngrok.
- **Session flow**: Lobby → Match → Scoreboard → Next Match / Lobby
- **Join method**: URL с параметрами (`?join=server&name=Player`)

---

## 5. Core Loop

```
Enter Lobby
    → Choose Kart Class
    → Join Match
        → Drive & Drift
        → Pick Up Weapons / Powerups
        → Shoot / Use Abilities
        → Get Kills / Take Damage
        → Die → Respawn (3 sec)
    → Match Timer Ends
    → Scoreboard (stats, MVP)
    → Next Match / Return to Lobby
```

---

## 6. Systems Overview

### 6.1 Kart System

**Current state**: One kart, identical for all players. CharacterBody3D with
arcade physics, drift on Shift.

**Design intent**: Multiple kart classes with distinct playstyles.

| Class | HP | Speed | Special | Fantasy |
|-------|----|-------|---------|---------|
| Standard | 100 | Medium | None | Balanced allrounder |
| Heavy | 150 | Slow | Knockback resistance | Tank, hard to kill |
| Light | 70 | Fast | Quick acceleration | Glass cannon, hit & run |
| Healer | 100 | Medium | Passive HP regen | Support, outlast enemies |

**Architecture requirement**: Kart stats must be defined as Resource files,
not hardcoded. Adding a new class = new `.tres` file, no code changes.

**Drift mechanics**:
- Drift is a core feel mechanic, not just visual
- Rear of the kart should slide out significantly (like SmashKarts reference)
- Current issue: kart straightens too quickly, rear doesn't swing enough
- Drift should feel heavy and committal — you choose when to drift
- No drift boost (unlike Mario Kart) — drift is for cornering and style

### 6.2 Weapon System

**Current state**: Rockets only. Pickup → fire with spread. Server-authoritative
rocket spawning.

**Design intent**: Expandable weapon system with multiple weapon types.

**Architecture requirement**: Each weapon defined as a Resource with:
- `weapon_name: String`
- `damage: float`
- `fire_rate: float`
- `projectile_scene: PackedScene`
- `ammo: int`
- `special_properties: Dictionary`

**Planned weapons** (expand over time):
1. **Rocket Launcher** (implemented) — AOE damage, medium speed
2. **Shotgun** — close range, spread, high burst
3. **Mines** — drop behind, proximity detonation
4. **Laser** — instant hit, long range, low damage
5. **Spikes** — melee contact kill (buff-like behavior, see 6.3)

**Pickup flow**:
1. Weapon pickup spawns on map at fixed points
2. Player drives over pickup → receives random weapon (or from pool)
3. Player has 1 weapon slot (use it or lose it on next pickup)
4. Pickup respawns after cooldown (configurable per pickup point)

### 6.3 Powerup System (Separate from Weapons)

**Current state**: Not implemented.

**Design intent**: Temporary buffs that modify kart behavior. Separate system
from weapons — different pickup points, different visuals, different slot.

| Powerup | Duration | Effect |
|---------|----------|--------|
| Speed Boost | 3 sec | +50% speed |
| Shield | 5 sec | Absorb one hit |
| Spikes | 8 sec | Contact damage/kill on collision |
| Invisibility | 4 sec | Transparent, no name label |

**Architecture**: Powerup = Resource with `effect_type`, `duration`, `modifier_value`.
Applied as a temporary modifier on the kart. Stack rules: new powerup replaces old.

### 6.4 Match System

**Current state**: Not implemented. Players join and play indefinitely.

**Design intent**: Timed matches with scoring.

**Match flow**:
1. Countdown (3-2-1-GO)
2. Match timer (configurable: 2/3/5 min)
3. Scoring: kills, deaths, damage dealt
4. Match end → scoreboard with MVP
5. Auto-restart or vote for next map

**Scoring**:
- Kill = +100 points
- Assist = +50 points (damage dealt within last 5 sec before kill)
- Death = -0 points (no penalty, keep it fun)

### 6.5 Map System

**Current state**: One flat arena (`map_1.tscn`) with scattered obstacles.

**Design intent**: 2-3 small arenas with vertical variety.

**Map design principles**:
- Single arena plane (no separate rooms/corridors)
- Terrain variation: hills, ramps, pits/holes
- Obstacles for cover and drift opportunities
- 4-8 weapon pickup points per map
- 2-4 powerup pickup points per map
- 6-10 spawn points, spread evenly

**Planned maps**:
1. **Warehouse** — flat industrial arena, boxes as cover (current map, refined)
2. **Volcano** — hills and lava pits (fall in = instant death + respawn)
3. **Rooftops** — multi-level platforms, gaps to jump/fall

### 6.6 HUD & UI

**Current state**: Basic HUD with HP bar, weapon label, kill feed, score panel.

**Design intent**: Clean, minimal HUD. No clutter.

**HUD elements**:
- HP bar (top or bottom)
- Current weapon icon + ammo count
- Active powerup icon + timer
- Kill feed (last 3-5 kills, fade out)
- Match timer (top center)
- Mini scoreboard (Tab to show)
- Minimap (future consideration)

### 6.7 Analytics System

**Current state**: Not implemented. JavaScriptBridge calls exist for basic web metrics.

**Design intent**: Two-layer analytics.

**Layer 1 — In-game mini stats**:
- End-of-match scoreboard: kills, deaths, K/D, damage dealt, damage taken
- Per-player weapon accuracy (shots fired / shots hit)
- MVP highlight

**Layer 2 — External dashboard**:
- Persistent stats across sessions (account system + backend/DB)
- Detailed per-player metrics: damage per weapon, favorite weapon, avg survival time
- Match history, heatmaps (future)
- Stack: TBD (likely NestJS backend + PostgreSQL — Dima's core stack)

**Account system** (for analytics, not monetization):
- Lightweight auth (login/register, no OAuth complexity at start)
- Purpose: track persistent stats, match history, personal records
- No gameplay gating — accounts are optional for playing, required for stats tracking

### 6.8 Network Architecture

**Current state**: WebSocket multiplayer, server-authoritative for damage/kills,
client-side prediction for movement.

**Design decisions** (already made, documented here):
- WebSocket over ENet (browser compatibility requirement)
- Server authority for all game state mutations (HP, kills, pickups, spawns)
- Client sends input, receives authoritative state
- RPC-based spawn handshake (not MultiplayerSpawner — race condition with scene changes)
- Sync rate: 30 Hz (configurable in future)

**Known issues to fix**:
- No interpolation for remote karts (jerky movement)
- No input lockout during respawn
- No world state sync on late join (pickups, powerups not synced)
- No ping/latency display

---

## 7. What Exists vs What's Needed

| System | Status | Priority |
|--------|--------|----------|
| Kart movement & drift | Partial (drift feel needs tuning) | HIGH |
| HTML5 export | Broken (gray screen) | CRITICAL |
| Weapon system (rockets) | Working but hardcoded | HIGH |
| Weapon system (expandable) | Not implemented | HIGH |
| Powerup system | Not implemented | MEDIUM |
| Kart classes | Not implemented | MEDIUM |
| Match system (timer, scoring) | Not implemented | HIGH |
| Maps (2-3) | 1 basic map exists | MEDIUM |
| HUD improvements | Basic exists | LOW |
| In-game analytics | Not implemented | LOW |
| External analytics dashboard | Not implemented | FUTURE |
| Network interpolation | Not implemented | HIGH |
| Dead code cleanup | Needed | HIGH |
| Resource-based architecture | Not implemented | HIGH |

---

## 8. Technical Constraints

- **Godot 4.6** with GL Compatibility — no Vulkan features
- **HTML5 primary** — no threads, no GDExtension in web builds
- **WebSocket only** — ENet not available in browser
- **Single server process** — no horizontal scaling needed for 6-10 players
- **Lightweight accounts** — for persistent stats tracking across sessions

---

## 9. Out of Scope (Explicitly)

- Skins, cosmetics, battle passes — no monetization
- Matchmaking — friends share a link
- Mobile support — browser on desktop only
- AI bots — all players are human
- Chat system — players communicate externally (Discord, etc.)

---

## 10. Reference

- **Primary reference**: [SmashKarts.io](https://smashkarts.io)
- **What to take**: Core gameplay feel, weapon variety, arena design, drift mechanics
- **What to avoid**: Ad spam, battle passes, skin economy, overly complex progression
- **What to improve**: Kart class variety, cleaner UI, detailed stats/analytics
