# SmashKarts Clone — System Architecture

Single source of truth for service topology. Originally a single-process Godot game where players entered an IP. Now: three services on the VPS plus a static client.

---

## Services and Ports

### Production

| Service | Port | Process | Owns |
|---------|------|---------|------|
| **nginx** | 443 (TLS) | systemd | TLS termination, static HTML5 serving, reverse-proxy `/api/*` and `/ws/*` to master |
| **Master Server (Node.js Express)** | 8080 (internal) | systemd `smash-master.service` | Rooms CRUD, profile API, match-stats ingest, WS proxy `/ws/{room}` → local Godot port, healthcheck poller, subprocess lifecycle |
| **Per-room Godot game server** | 4445–4545 (internal) | spawned by master via `child_process.spawn` | One match = one Godot `--headless` process. Game state, RPC, physics, damage. Lifecycle owned by master. |
| **SQLite (WAL)** | n/a (file) | embedded in master | Profiles, matches, match_participants. WAL enables concurrent reads. |
| **HTML5 client** | served from `/var/www/smash-karts/` | static | Godot 4 web export with COOP/COEP headers |

Per-room Godot ports are **never exposed** on the firewall — only nginx `:443` (and SSH).

### Dev workflow (Windows)

| Service | Port | How to start |
|---------|------|--------------|
| Master Server | 8080 | `cd server && npm start` |
| Static client | 8060 | `py build/serve.py` |
| Per-room Godot | 4445+ | spawned by master on demand |

Browser → `http://localhost:8060/index.html` → talks to master at `:8080`. **No manual Godot launch.** Old `--autohost` desktop flow is preserved for ad-hoc testing without going through master.

---

## Service Dependency Graph

```
Browser ─HTTPS─→ nginx ─HTTP─→ Master (Express)
   │                                ├─→ SQLite (sync, WAL)
   │                                ├─→ child_process.spawn(Godot)
   │                                └─→ ws proxy /ws/{room} ↔ Godot ws
   │                                                            ↑
   └─WSS────────→ nginx /ws/* ─ws─→ Master ──ws (internal)──────┘

Per-room Godot ─HTTP→ Master /api/internal/match/submit  (after match ends)
Master ─HTTP→ Per-room Godot /healthcheck                (every 5 s)
```

---

## Sequence: full join flow

```
Player                Browser              nginx           Master            Godot (room)
  │  open URL            │                   │                │                   │
  │ ───────────────────→ │                   │                │                   │
  │                      │ GET /index.html   │                │                   │
  │                      │ ────────────────→ │ static         │                   │
  │                      │ ←──────────────── │                │                   │
  │                      │ GET /api/health   │                │                   │
  │                      │ ────────────────────────────────→ │                   │
  │                      │ ←──────────────────────────────── │                   │
  │                      │ POST /api/profile/auth (token)    │                   │
  │                      │ ────────────────────────────────→ │ SELECT profile    │
  │                      │ ←──────────────────────────────── │                   │
  │                      │ GET /api/rooms (poll 4 s)         │                   │
  │                      │ ────────────────────────────────→ │ list active rooms │
  │                      │ ←──────────────────────────────── │                   │
  │  click room          │                                                       │
  │                      │ GET /api/rooms/{code}             │                   │
  │                      │ ────────────────────────────────→ │ resolve ws_url    │
  │                      │ ←──────────────────────────────── │                   │
  │                      │ WSS /ws/{code} (upgrade)          │                   │
  │                      │ ────────────────────────────────→ │ proxy ───→        │ ws  ←──── connects
  │                      │ ←──────────────────────────────── │ ←─── proxy ←───── │
  │                      │ scene_change("game.tscn")                             │
  │                      │ ←─── Godot Multiplayer RPCs over WSS ─────────────→  │
```

---

## Sequence: match-end flow

```
Godot (room)                        Master                   SQLite
  │  match timer = 0                  │                         │
  │  build _match_payload             │                         │
  │  POST /api/internal/match/submit  │                         │
  │  + Authorization: Bearer X        │                         │
  │ ────────────────────────────────→ │ verify INTERNAL_TOKEN   │
  │                                   │ BEGIN TRANSACTION       │
  │                                   │ INSERT match            │
  │                                   │ ───────────────────────→│
  │                                   │ INSERT match_participants × N
  │                                   │ ───────────────────────→│
  │                                   │ UPDATE profiles × N (aggregates)
  │                                   │ ───────────────────────→│
  │                                   │ COMMIT                  │
  │ ←─────────── 202 Accepted ─────── │                         │
  │  state = POST_MATCH               │                         │
  │  player count → 0 within 60 s     │                         │
  │  EXIT_REQUESTED → master cleanup  │                         │
```

---

## Who does what

### Master Server (Node.js Express)
- **Never holds game state.** Only knows: room exists at port X, has N players, state (`WAITING` / `IN_MATCH` / `POST_MATCH` / `CLEANUP`), is host alive.
- Spawns and reaps per-room Godot subprocesses (`child_process.spawn`, `child.kill('SIGTERM')`).
- Allocates ports synchronously from pool 4445–4545.
- Polls each room healthcheck every 5 s.
- Proxies WSS `/ws/{room_code}` to local Godot port.
- Receives match-end batch POST, writes to SQLite in a single transaction.
- NestJS-style modular structure: `controller / service / repository / dto` per domain.

### Per-room Godot (`--headless`)
- Existing `kart_controller`, `game_manager`, `state_manager` code.
- Reads `--port=N --room=CODE --healthcheck-port=M --internal-token=X --duration-min=K --max-players=8` from cmdline (after `--`).
- `network_manager.gd` binds to cmdline port instead of hardcoded 4444.
- `rooms_reporter.gd` autoload opens TCPServer on healthcheck port and answers HTTP/1.1 with `{state, players, room_code, max_players}`.
- After match end: `master_client.gd` POSTs match payload to master `/api/internal/match/submit`.

### Browser client (Godot HTML5)
- Three new autoloads:
  - `ProfileManager` — token + nickname + auth flow with master
  - `RoomsClient` — HTTP to master for room list / create / resolve
  - `MasterClient` — server-only POST helper (only loaded when spawned by master)
- `lobby.gd` god-object replaced by `lobby_controller.gd` + 5 panel scripts (Splash, FirstTime, LobbyHome, RoomLobby, Profile).
- URL deep-link `?join=ROOMID` resolved after auth → straight into game.

### nginx
- Terminates TLS.
- Serves static HTML5 from `/var/www/smash-karts/` with COOP/COEP headers.
- Blanket-routes `/api/*` and `/ws/*` to master `:8080`.
- Per-room Godot ports never exposed.

### SQLite (WAL)
- Embedded in master process via `better-sqlite3` (synchronous API).
- WAL mode allows concurrent reads while writing match results.
- Sequential migrations gated by `PRAGMA user_version`.
- Schema: `profiles`, `matches`, `match_participants`. (`damage_events` deferred to v2.)

---

## Documentation Responsibility

This file is the **service topology overview**. Detailed contracts live in:

- `design/gdd/rooms-system.md` — room lifecycle, master API, healthcheck protocol, port pool
- `design/gdd/profile-system.md` — SQLite schema, auth-token flow, stats vocabulary
- `design/gdd/lobby-ui.md` — 5-screen UX, deep-link, polling cadence, panel state machine
- `design/gdd/network-layer.md` — WS RPC contracts (preserved from single-process days)

When implementation diverges from a GDD: **update the GDD before continuing** (memory rule `feedback_keep_docs_in_sync.md`).
