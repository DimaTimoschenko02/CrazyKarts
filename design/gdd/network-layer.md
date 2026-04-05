# Network Layer

> **Status**: In Design
> **Author**: Dima + godot-specialist + network-programmer
> **Last Updated**: 2026-04-03
> **Implements Pillar**: Играй с друзьями (low barrier, instant join)

## Overview

Network Layer — серверно-авторитетная мультиплеер система на WebSocket для
браузерной арена-игры. Обеспечивает подключение, синхронизацию состояния мира,
интерполяцию remote-игроков и management сессии.

Текущая реализация (`network_manager.gd` + RPC в `kart_controller.gd` и
`game_world.gd`) работает для базового случая, но требует рефакторинга:
добавить интерполяцию, late join sync, ping display, timeout detection.

**Hosting model**: Dedicated Godot headless server на VPS (8GB RAM).
Без ngrok — прямое WebSocket подключение. Nginx раздаёт HTML5 билд.

## Player Fantasy

"Я открыл ссылку в браузере и через 3 секунды уже в игре. Никаких лагов,
никаких тормозов. Другие машины двигаются плавно. Если кто-то отвалился —
игра не зависает. Если я подключился посреди матча — вижу всех и все очки."

## Detailed Design

### Core Rules

1. **WebSocketMultiplayerPeer** — единственный транспорт (совместим с HTML5)
2. **Server-authoritative** для всех мутаций: HP, kills, spawns, pickups, match state
3. **Client-authoritative** для движения (no input lag, arcade feel)
4. Server validates: teleport check (`delta_pos > MAX_SPEED * SYNC_INTERVAL * 3` → reject)
5. All reliable RPCs are ordered (WebSocket TCP guarantees this)
6. Unreliable RPCs: position sync only (loss acceptable, next packet corrects)
7. State changes synced via State Machine signals → `_rpc_set_state.rpc()` (reliable)
8. No MultiplayerSpawner — manual RPC handshake (documented race condition)

### RPC Inventory

| RPC | Direction | Reliability | Data | Bytes |
|-----|-----------|-------------|------|-------|
| `_register(name)` | C→S | reliable | String | ~32 |
| `_rpc_spawn_kart(pid, name, pos)` | S→C | reliable | int, String, Vec3 | ~48 |
| `_rpc_sync(pos, rot, vel, timestamp)` | C→S→all | unreliable | 3xVec3 + int | ~52 |
| `_rpc_set_state(state_enum)` | S→all | reliable | int | ~20 |
| `_rpc_request_fire()` | C→S | reliable | — | ~16 |
| `_rpc_spawn_rocket(shooter, pos, dir)` | S→all | reliable | int, Vec3, Vec3 | ~44 |
| `_rpc_update_hp(hp)` | S→target | reliable | int | ~20 |
| `_rpc_kill(victim, killer)` | S→all | reliable | int, int | ~24 |
| `_rpc_respawn(pid, pos)` | S→all | reliable | int, Vec3 | ~32 |
| `_rpc_world_state(state)` | S→C | reliable | Dictionary | ~200-500 |
| `_rpc_ping(timestamp)` | C→S | unreliable | int | ~20 |
| `_rpc_pong(timestamp)` | S→C | unreliable | int | ~20 |
| `_rpc_pickup_state(id, active)` | S→all | reliable | int, bool | ~20 |
| `_rpc_match_timer(seconds)` | S→all | unreliable | float | ~20 |
| `_rpc_kart_disconnect(pid)` | S→all | reliable | int | ~20 |

**Critical implementation notes:**
- `_rpc_kart_disconnect` MUST be called in `_on_player_disconnected` BEFORE `queue_free`. Clients on receipt: remove kart node, clear from local tracking, play disconnect VFX/SFX. Currently missing in code.
- `_rpc_sync` MUST include `timestamp_ms: int` for snapshot buffer to work. This is a breaking change from current signature `(pos, rot, vel)` → `(pos, rot, vel, timestamp_ms)`.
- `_rpc_world_state` MUST be implemented BEFORE pickup system or match system — they depend on late join sync.

### Sync Model

| Data | Frequency | Reliability | Owner | Notes |
|------|-----------|-------------|-------|-------|
| Position/rotation/velocity | 30 Hz | unreliable | each kart | Skip if DEAD |
| Kart state (SM enum) | on change | reliable | server | Via State Machine |
| HP | on change | reliable | server | |
| Weapon state | on change | reliable | server | Via State Machine |
| Match state | on change | reliable | server | Via State Machine |
| Match timer | 1 Hz | unreliable | server | Drift correction |
| Rocket spawn | on event | reliable | server | |
| Pickup active/inactive | on event | reliable | server | Currently missing |
| Scores | on change | reliable | server | |
| Ping | every 2s | unreliable | client→server→client | RTT measurement |

### Interpolation: Snapshot Buffer

Remote karts use a **snapshot buffer** with render delay for smooth movement.

**Buffer design:**
- Store last N=8 snapshots: `{ timestamp_ms: int, pos: Vector3, rot: Vector3, vel: Vector3 }`
- `render_time = current_time_ms - BUFFER_DELAY_MS` (default 100ms)
- Each frame: find two snapshots bracketing `render_time`, lerp between them
- `t = (render_time - snap_a.timestamp) / (snap_b.timestamp - snap_a.timestamp)`
- If no future snapshot exists: extrapolate using last `vel` for max 150ms, then freeze
- On respawn/teleport: set `_force_teleport = true`, skip interpolation for 1 frame

**Why 100ms buffer**: At 30 Hz, packets arrive every ~33ms. 100ms buffer covers
3 packet intervals — absorbs jitter and 1-2 dropped packets gracefully.

**Parameters:**
- `BUFFER_DELAY_MS: int = 100` — visual delay for smoothness
- `MAX_SNAPSHOTS: int = 8` — ring buffer size
- `EXTRAPOLATE_MAX_MS: int = 150` — max extrapolation before freeze
- `TELEPORT_THRESHOLD: float = 10.0` — distance to skip interpolation

### Late Join Protocol

```
Client                              Server
  |                                   |
  |--- _register(name) ------------->|
  |                                   | 1. Build world_state Dictionary
  |<-- _rpc_world_state(state) ------|    (scores, pickups, match_timer,
  |                                   |     kart_positions, match_state)
  |<-- _rpc_spawn_kart(pid1...) -----|  2. Spawn existing karts (reliable, ordered)
  |<-- _rpc_spawn_kart(new_pid) -----|  3. Spawn self last
  |                                   |  4. Append to synced_peers
  |--- _rpc_sync (starts flowing) -->|
```

**world_state payload:**
```gdscript
{
  "scores": { pid: { "name": String, "kills": int, "deaths": int, "hp": int } },
  "pickups": { pickup_path: bool },  # active/inactive per pickup node
  "match_state": int,                # MatchState enum
  "match_timer_remaining": float,
  "kart_states": { pid: int }        # KartState enum per player
}
```

Order matters: `_rpc_world_state` arrives BEFORE `_rpc_spawn_kart` because
spawning triggers `_ready()` which reads from GameManager.

### Connection Flow

```
1. Player opens browser → loads HTML5 build from nginx
2. Lobby UI appears → enters name → clicks Join
3. Client: NetworkManager.join_game("wss://server-domain:4444")
4. WebSocket handshake → multiplayer.connected_to_server fires
5. Client: scene changes to game.tscn
6. Client: _register.rpc_id(1, name)
7. Server: sends world_state + spawns all karts
8. Client: starts sending _rpc_sync at 30 Hz
9. Server: routes _rpc_sync to all synced_peers
```

### Ping Measurement

```gdscript
# Client sends every 2 seconds:
@rpc("any_peer", "call_remote", "unreliable")
func _rpc_ping(client_timestamp: int) -> void:
    _rpc_pong.rpc_id(multiplayer.get_remote_sender_id(), client_timestamp)

@rpc("authority", "call_remote", "unreliable")
func _rpc_pong(original_timestamp: int) -> void:
    var rtt_ms := Time.get_ticks_msec() - original_timestamp
    current_ping = rtt_ms
```

Display in HUD: `Ping: {rtt_ms}ms` — update every 2s, not every pong.

### Timeout Detection

Server tracks last received packet per peer:
- `_last_packet_time: Dictionary = {}` — `{ pid: msec }`
- Updated on every `_rpc_sync` received
- Checked in `_process`: if `now - _last_packet_time[pid] > TIMEOUT_MS` → disconnect
- `TIMEOUT_MS = 5000` (5 seconds)
- On timeout: emit `player_disconnected`, clean up kart, broadcast `_rpc_kart_disconnect`

### Server Validation

Minimal anti-glitch (not anti-cheat — friends game):
- **Teleport check**: `distance(last_known_pos, new_pos) > MAX_SPEED * SYNC_INTERVAL * 3`
  → ignore packet, log warning
- **Fire rate check**: `time_since_last_fire < weapon.fire_rate * 0.8` → reject
- **State check**: fire request while kart DEAD → reject (double-gated with State Machine)

### Interactions with Other Systems

| System | Interface |
|--------|-----------|
| **State Machine** | All state transitions synced via reliable RPC. Network Layer transports, SM validates. |
| **Health & Damage** | `_rpc_update_hp`, `_rpc_kill` — server sends to affected clients |
| **Kart Physics** | `_rpc_sync` carries position/rotation/velocity at 30 Hz |
| **Spawn System** | `_rpc_spawn_kart`, `_rpc_respawn` — server authoritative |
| **Pickup System** | `_rpc_pickup_state` — server broadcasts active/inactive |
| **Weapon System** | `_rpc_request_fire` (C→S), `_rpc_spawn_rocket` (S→all) |
| **Match System** | `_rpc_match_timer` (1Hz), match state via SM signals |
| **Lobby** | `NetworkManager.join_game()`, `_register` handshake |
| **Account System** | Future: auth token in `_register` payload |
| **HUD** | Ping display, connection status |

## Formulas

### Bandwidth per player (outgoing)

```
sync_bytes_per_packet = 52  # 3xVec3 + timestamp + RPC overhead
packets_per_second = sync_hz  # default 30
outgoing_per_player = sync_bytes_per_packet * packets_per_second
                    = 52 * 30 = 1,560 B/s ≈ 1.5 KB/s
```

### Server total bandwidth (fan-out)

```
total_server_bandwidth = num_players * outgoing_per_player * (num_players - 1)
For 6 players:  6 * 1560 * 5 = 46,800 B/s ≈ 46 KB/s
For 10 players: 10 * 1560 * 9 = 140,400 B/s ≈ 137 KB/s
```

### Interpolation lerp factor

```
t = (render_time - snap_a.timestamp) / (snap_b.timestamp - snap_a.timestamp)
t = clamp(t, 0.0, 1.0)
interpolated_pos = snap_a.pos.lerp(snap_b.pos, t)
interpolated_rot = snap_a.rot.lerp(snap_b.rot, t)  # or slerp for quaternion
```

### Ping RTT

```
rtt_ms = Time.get_ticks_msec() - original_timestamp
displayed_ping = moving_average(last_5_rtt_values)  # smooth display
```

## Edge Cases

| Scenario | Resolution |
|----------|-----------|
| Client joins during PLAYING | Late join protocol: full world_state → spawn in RESPAWNING |
| Client joins during ENDED | Receives world_state with ENDED match_state, enters next match |
| Client joins during COUNTDOWN | Spawns, participates from start |
| Server receives _rpc_sync from unknown pid | Ignore, log warning |
| Client sends _rpc_sync while DEAD | Kart should skip sync in DEAD state; server ignores if received |
| Client teleports (pos jump > threshold) | Server rejects packet, keeps last valid position |
| Client fires faster than cooldown | Server rejects, uses own cooldown tracking |
| WebSocket disconnects silently (no close frame) | Timeout detection: 5s no packets → force disconnect |
| Packet arrives out of order (unreliable) | Snapshot buffer: only insert if timestamp > latest, else discard |
| Client tab goes to background (browser throttle) | Chrome throttles bg tabs to ~1/min after 5 min. Timeout kicks at 5s. Acceptable — rejoin. Note: 10s alt-tab is fine, extended bg = kick. |
| nginx restart while game running | WebSocket drops, clients get server_disconnected → return to lobby |
| Two clients with same name | Allowed — peer_id is the unique identifier, not name |
| world_state packet too large (many players) | Max ~500 bytes for 10 players — well under WebSocket 64KB limit |
| Rotation interpolation on ramps | Current: Euler lerp per axis. Works on flat arena. If ramps added, switch to Quaternion slerp to avoid gimbal lock. |

## Dependencies

### Upstream

None — Network Layer is Layer 1 Foundation.

### Downstream (depends on this system)

| System | What it needs |
|--------|---------------|
| Health & Damage | Reliable RPC for HP/kill events |
| Kart Physics | Unreliable RPC for position sync, snapshot buffer |
| Spawn System | Reliable RPC for kart spawn/despawn |
| Pickup System | Reliable RPC for pickup state changes |
| Projectile System | Reliable RPC for rocket spawn |
| Weapon System | Reliable RPC for fire request/validation |
| Powerup System | Reliable RPC for powerup state |
| Match System | Reliable RPC for match state, unreliable for timer |
| Lobby | WebSocket connection setup, _register handshake |
| Account System | Future: auth token transport |

### Interface Contract

- All game state mutations go through server RPCs — no direct peer-to-peer
- `NetworkManager` singleton handles connection lifecycle
- Game systems use `multiplayer.is_server()` to branch authority
- Sync data flows through specific RPCs listed in RPC Inventory
- Snapshot buffer is internal to kart rendering — other systems don't interact with it

## Tuning Knobs

| Knob | Default | Safe Range | Affects | Too Low | Too High |
|------|---------|------------|---------|---------|----------|
| `sync_hz` | 30 | 10-60 | Position update rate | Jerky movement | Bandwidth waste |
| `buffer_delay_ms` | 100 | 50-200 | Interpolation smoothness | Jitter visible | Visible input lag |
| `max_snapshots` | 8 | 4-16 | Snapshot ring buffer size | Can't absorb loss | Memory waste |
| `extrapolate_max_ms` | 150 | 50-300 | Max prediction time | Freeze too fast | Ghost movement |
| `teleport_threshold` | 10.0 | 5.0-20.0 | Anti-glitch distance | False positives | Allows cheating |
| `timeout_ms` | 5000 | 3000-10000 | Disconnect detection | False kicks on lag spike | Ghost players linger |
| `ping_interval_s` | 2.0 | 1.0-5.0 | Ping measurement rate | Wasted bandwidth | Stale ping display |
| `fire_rate_tolerance` | 0.8 | 0.5-1.0 | Server fire rate check multiplier | Rejects valid fires | Allows spam |
| `websocket_port` | 4444 | 1024-65535 | Server listen port | — | — |

## Visual/Audio Requirements

| Event | Visual | Audio |
|-------|--------|-------|
| Connection established | "Connected!" toast in lobby | — |
| Connection failed | "Connection failed" error message | Error beep |
| Player joined | "[Name] joined" in chat/feed | Join chime |
| Player disconnected | "[Name] left" + kart fades out | Disconnect sound |
| High ping (>200ms) | Ping indicator turns yellow/red | — |
| Server disconnected | "Host disconnected" overlay → lobby | Warning sound |

## UI Requirements

| Element | Location | Updates |
|---------|----------|---------|
| Ping display | HUD top-right corner | Every 2s |
| Connection status | Lobby + HUD | On change |
| Player count | Lobby "Players: N/10" | On join/leave |
| Server address | Lobby input field | User input |
| "Connecting..." spinner | Lobby overlay | During connection |
| "Reconnecting..." | Not implemented — return to lobby instead | — |

## Acceptance Criteria

### Functional Tests (automated — headless + Chrome MCP)

- [ ] Client connects to server via WebSocket successfully
- [ ] _register handshake completes: client receives all existing karts
- [ ] Late join: new player receives world_state with correct scores, pickup states, match timer
- [ ] Position sync: remote kart position updates at ~30 Hz
- [ ] Snapshot buffer: remote karts move smoothly (no visible teleporting)
- [ ] Ping measurement: RTT value updates in HUD every 2s
- [ ] Timeout: server detects disconnected client within 5s
- [ ] Teleport rejection: server ignores invalid position jumps
- [ ] Fire rate validation: server rejects rapid-fire beyond weapon cooldown
- [ ] Player disconnect: kart removed from all clients

### Network Tests (automated)

- [ ] Bandwidth stays under 150 KB/s server total with 10 players
- [ ] No memory leak in snapshot buffer (ring buffer bounded to MAX_SNAPSHOTS)
- [ ] Reliable RPCs arrive in order (WebSocket TCP guarantee)
- [ ] World state packet size < 1KB for 10 players

### Playtest Criteria (human)

- [ ] Remote karts look smooth, no visible jerking during normal play
- [ ] No noticeable delay between pressing fire and seeing rocket on other screens
- [ ] Late join: joining mid-match shows correct game state immediately
- [ ] Player disconnect doesn't freeze or crash the game for others
- [ ] Ping display is accurate (compare with system ping)

## Open Questions

1. **WSS certificate**: VPS needs SSL cert for `wss://`. Use Let's Encrypt via
   nginx reverse proxy? Or self-signed for dev?

2. **Multiple rooms**: Currently one room per server process. Future: multiple
   rooms in one process, or separate process per room?

3. **Spectator mode**: Should disconnected players be able to watch? Requires
   keeping WebSocket open without a kart.

4. **Bandwidth adaptive**: Should server reduce sync_hz for high-ping players?
   Or keep uniform 30 Hz for simplicity?

5. **Server browser**: Currently join by URL/IP. Future: server list API?
