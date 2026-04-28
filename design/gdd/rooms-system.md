# Rooms System

> **Status**: In Design
> **Author**: systems-designer
> **Last Updated**: 2026-04-26
> **Implements Pillar**: Играй с друзьями (low barrier — public room browser, no manual IP, no invite code needed)

---

## Overview

Rooms System переводит игру от однокомнатной архитектуры (один Godot процесс = один матч, игроки вводят IP вручную) к модели с именованными комнатами и человекочитаемыми invite-кодами.

**Целевой опыт**: игрок открывает сайт, видит список публичных комнат, кликает на комнату друга → через 5 секунд в лобби. Без IP-адресов. Без invite-кодов. Без desktop-клиента. Deep-link по `?join=CODE` тоже работает (для Discord-шаринга), но не обязателен.

**Целевая нагрузка**: ~10 друзей одновременно, 1-3 матча параллельно. VPS 8GB RAM. Никакого public matchmaking — это игра для компании.

---

## Player Fantasy

"Открыл сайт. Вижу список комнат — 'Вася's room 3/8 WAITING'. Кликнул. Написал ник. Уже в лобби. Пять человек ждут, один ещё заходит. Старт. Три минуты хаоса. Финал. Вася хочет ещё — создал новую комнату, она появилась в списке. Все кликнули. Всё."

---

## Detailed Design

### Architectural Decision: Option B — Master-server + per-room Godot processes

**Выбранная архитектура: B — отдельный headless Godot процесс на комнату.**

Одна главная программа (Master Server, написанная на Node.js Express) управляет жизненным циклом комнат: создаёт, удаляет, выдаёт список. При создании комнаты Master Server запускает отдельный `godot --headless` на свободном порту. Клиент подключается к WebSocket этого конкретного Godot-процесса через WSS-прокси master server.

**Почему не вариант A (N логических комнат в одном процессе):**

| Критерий | A: Один процесс | B: Процесс на комнату |
|---|---|---|
| Изоляция краша | Одна ошибка убивает все комнаты | Краш одного не задевает другие |
| Изменение кода комнаты | Нужна полная перестройка RPC с room_id фильтрацией | Нет изменений в kart/game логике |
| Масштаб (1-3 комнаты) | Избыточная сложность | Прямолинейно, каждый процесс = независимый мир |
| Godot Multiplayer API | MultiplayerAPI не поддерживает несколько независимых сетевых пространств в одном процессе без значительного хака | Нативная модель: один MultiplayerPeer на процесс |
| RAM VPS 8GB | Один процесс ~150MB idle | 3 процесса ~450MB — комфортно в 8GB |
| Разработческий риск | Высокий: нужно перепроектировать весь RPC слой | Низкий: текущий game_manager.gd/network_manager.gd без изменений |

**Вывод**: Вариант B сохраняет весь текущий игровой код (kart_controller, game_manager, network_manager) нетронутым. Rooms Server — отдельный легковесный процесс который только знает: "запусти Godot на порту X, следи что живой, скажи клиентам куда подключаться."

---

### System Architecture Overview

```
Browser Client
     │
     ├─► HTTPS GET /api/rooms          → список публичных комнат
     ├─► HTTPS POST /api/rooms         → создать комнату (получить invite-код)
     ├─► HTTPS GET /api/rooms/{code}   → инфо о комнате по коду
     │
     └─► WSS wss://play.domain.com/ws/{room_code}  → через master WSS-прокси
                                                      → master форвардит в localhost:{godot_port}

VPS
     ├── nginx                              → HTTPS, раздаёт HTML5 билд
     │                                        /api/* → proxy master:8080
     │                                        /ws/*  → proxy master:8080 (blanket route)
     ├── master.js (Node.js Express)        → управляет комнатами, spawns Godot процессы
     │       port: 8080 (internal)            WSS-прокси: ws /ws/{code} → localhost:{godot_port}
     │       systemd: smash-master.service    один npm install, один процесс
     │
     ├── godot --headless (комната 1)  → WSS port 4445 (internal, не открыт в firewall)
     ├── godot --headless (комната 2)  → WSS port 4446 (internal)
     └── godot --headless (комната N)  → WSS port 4444 + N - 1
```

**WSS Proxy**: клиент подключается к `wss://play.domain.com/ws/{room_code}`.
nginx blanket-routes `/ws/*` → `master:8080`. Master форвардит байты через Node.js `ws` (библиотека)
или `http-proxy` в `localhost:{godot_port}`. Godot-порты не открываются во внешний firewall.

**Port pool**: 4445–4545 (100 портов → хватит навсегда при нагрузке 1-3 комнаты).
Порт 4444 зарезервирован — не ломаем dev-окружение где сервер запускается вручную на 4444.

---

### Room Lifecycle

```
CREATE
  │  POST /api/rooms {name, max_players, duration_min, host_name}
  │  All rooms are PUBLIC. No type field. duration_min: 5 | 10 | 20
  │  Master Server: allocate free port, spawn godot --headless -- --port N --room CODE --map map_1 --max-players N --healthcheck-port N+1000
  │  Returns: { room_code: "XKCD42", ws_url: "wss://play.domain.com/ws/XKCD42", room_id: uuid, invite_link: "...?join=XKCD42" }
  │
WAITING
  │  Godot процесс запущен, ждёт игроков.
  │  Rooms Server периодически опрашивает /healthcheck на порт процесса.
  │  Lobby UI показывает "Waiting for players (1/6 joined, min 1 to start)"
  │
  ├─► Игроки подключаются через ws://server:4447
  │   Handshake: первый JOIN-пакет несёт room_code для верификации.
  │
COUNTDOWN (3-5s)
  │  Lobby-owner нажимает Start (или авто-старт если все ready).
  │  Используется существующий Match System COUNTDOWN.
  │
IN_MATCH (5 / 10 / 20 min — выбирается при создании комнаты)
  │  Нативный Godot матч. Без участия Rooms Server во время игры.
  │  Rooms Server только знает что комната "IN_MATCH" (статус от процесса).
  │
POST_MATCH (10s scoreboard)
  │  После scoreboard: выбор "Play Again" (та же комната) или "Leave".
  │  При "Play Again": комната переходит в WAITING → следующий матч.
  │  Master Server получает batch POST /api/internal/match/submit с полным payload.
  │
CLEANUP
  │  Triggered by: все игроки ушли OR idle timeout OR crash detected.
  │  Rooms Server: SIGTERM Godot процессу, освобождает порт.
  │  Запись match_results в БД (если persistence включена).
```

#### Room States

| State | Description | Transition In | Transition Out |
|---|---|---|---|
| WAITING | Лобби, игроки собираются, есть свободные слоты | Создание комнаты / конец матча (Play Again) / игрок ушёл из FULL | Lobby-owner Start / current_players == max_players |
| FULL | Комната заполнена, join недоступен | current_players == max_players (healthcheck) | Игрок отключается (current_players < max_players) |
| COUNTDOWN | 3-2-1-GO | Lobby-owner Start | Countdown timer expires |
| IN_MATCH | Матч идёт | Countdown end | Match timer / last player leaves |
| POST_MATCH | Scoreboard 10s | Match end | Restart / all leave |
| CLEANUP | Удаление | Empty room / idle timeout / crash | (terminal — процесс убит) |

Note: FULL — это вычисляемый статус на стороне Rooms Server (is_full: current_players >= max_players). В healthcheck от Godot отдельного состояния FULL нет — Rooms Server вычисляет сам.

---

### Room Object Model

```js
// Master Server (Node.js) — in-memory room object
{
  room_id: String,          // uuid4 (internal)
  room_code: String,        // 6-char alphanumeric, uppercase. URL identifier: ?join=XKCD42
                            // NOT a privacy mechanism — all rooms are public. Just a short stable ID.
  name: String,             // display name (max 32 chars). Default: "{host_name}'s room"
  // type: removed — all rooms are PUBLIC in MVP
  state: String,            // "WAITING" | "COUNTDOWN" | "IN_MATCH" | "POST_MATCH" | "CLEANUP" | "FULL"
  ws_port: Number,          // Godot process internal WebSocket port
  healthcheck_port: Number, // ws_port + 1000
  process_pid: Number,      // OS process ID for monitoring/kill
  max_players: Number,      // 1-10 (min 1 — solo start OK)
  current_players: Number,  // from Godot healthcheck
  map_name: String,         // "map_1" (single map in MVP)
  duration_min: Number,     // 5 | 10 | 20
  created_at: Number,       // Unix timestamp ms
  last_activity: Number,    // updated on player join/leave
  host_name: String,        // display only, не для auth
}
```

---

### Connection Flow (Full)

```
1. Игрок A создаёт комнату
   POST /api/rooms { name: "Ваши мамы", max_players: 8, duration_min: 10, host_name: "Вася" }
   ← { room_code: "XKCD42", ws_url: "wss://play.domain.com/ws/XKCD42",
       room_id: "uuid", invite_link: "https://play.domain.com/?join=XKCD42" }
   Master Server: spawn godot --headless -- --port 4447 --room XKCD42 --map map_1 --max-players 8 --healthcheck-port 5447
   Godot процесс стартует, слушает WS на :4447 (internal). Готовность — HTTP polling localhost:5447/healthcheck.
   Комната СРАЗУ появляется в GET /api/rooms (публичная, WAITING).

2. Игрок Б видит комнату в списке на главной
   GET /api/rooms → [..., { room_code: "XKCD42", name: "Ваши мамы", state: "WAITING",
                             current_players: 1, max_players: 8, host_name: "Вася" }]
   Клик на комнату → JS: GET /api/rooms/XKCD42 → { ws_url }
   NetworkManager.join_game("wss://play.domain.com:4447")

3. Альтернативно: Вася скинул ?join=XKCD42 в Discord
   Игрок кликает → https://play.domain.com/?join=XKCD42
   Та же схема через GET /api/rooms/XKCD42 → подключается к тому же :4447

4. Godot процесс принимает _register(name, session_token) от каждого клиента
   Первый зарегистрированный = lobby-owner (как сейчас в Match System)
   Godot валидирует session_token через POST http://localhost:8080/api/internal/validate-token
   (HTTPRequest → await → если токен невалиден, peer кикается)

5. Match flow
   Далее без изменений — существующий Match System GDD

6. После POST_MATCH: "Play Again"
   Godot внутри продолжает существовать, переходит в WAITING
   Rooms Server обновляет state → WAITING
   Игроки остаются подключёнными, новый матч начинается без реконнекта

7. Cleanup
   Если все ушли: Godot получает пустой peer list → сигнал rooms-server
   Rooms Server: SIGTERM процессу, освобождает порт
```

#### URL Schemes

| URL | Action |
|---|---|
| `https://play.domain.com/` | Главная → список публичных комнат + Create/Join |
| `https://play.domain.com/?join=XKCD42` | Авто-джоин в комнату по коду |
| `https://play.domain.com/?join=XKCD42&name=Вася` | Авто-джоин с именем (пропускает ввод ника) |
| `POST /api/rooms` | Создать комнату |
| `GET /api/rooms` | Список публичных комнат |
| `GET /api/rooms/{code}` | Инфо о комнате по коду (для deep-link / клика по строке в browser) |
| `GET /api/rooms/{code}/ws_url` | Только WebSocket URL (для JS клиента) |

---

### Master Server API (Node.js Express)

Минимальный REST API. Не требует auth — это игра для друзей.

```
POST   /api/rooms                          → создать комнату
GET    /api/rooms                          → список PUBLIC комнат (state != CLEANUP)
GET    /api/rooms/{code}                   → инфо о комнате по invite-коду
DELETE /api/rooms/{code}                   → force cleanup (admin only, header X-Admin-Key)
GET    /api/health                         → liveness check master server

POST   /api/internal/validate-token        → Godot → master: валидация session_token
POST   /api/internal/match/submit          → Godot → master: итоги матча (batch, один раз per match)
```

Эндпоинты `/api/internal/*` доступны только с `Authorization: Bearer <INTERNAL_TOKEN>`.

**POST /api/rooms request:**
```json
{
  "name": "Ваши мамы",
  "max_players": 8,
  "duration_min": 10,
  "host_name": "Вася"
}
```
Note: no `type` field — all rooms are PUBLIC. No `map` field — single map in MVP (map_1 hardcoded).
Name defaults to `"{host_name}'s room"` if omitted.

**POST /api/rooms response:**
```json
{
  "room_code": "XKCD42",
  "room_id": "uuid",
  "ws_url": "wss://play.domain.com/ws/XKCD42",
  "invite_link": "https://play.domain.com/?join=XKCD42"
}
```

**GET /api/rooms response:**

Returns all rooms where `state != CLEANUP`. No PUBLIC/PRIVATE filter needed — all rooms are public.

```json
[
  {
    "room_code": "ABCD12",
    "name": "Friendly fire",
    "state": "WAITING",
    "current_players": 3,
    "max_players": 8,
    "map": "map_1",
    "host_name": "Dima",
    "is_full": false
  },
  {
    "room_code": "XKCD42",
    "name": "Ваши мамы",
    "state": "IN_MATCH",
    "current_players": 8,
    "max_players": 8,
    "map": "map_1",
    "host_name": "Вася",
    "is_full": true
  }
]
```

**Public room browser display (what lobby UI shows per row):**

| Field | Display |
|---|---|
| `name` | Имя комнаты (host nickname или custom) |
| `current_players / max_players` | "3/8" |
| `state` | Бейдж: "Ждём" (WAITING) / "Матч" (IN_MATCH) / "Финиш" (POST_MATCH) |
| `map` | Имя карты (если выбор карт реализован, иначе скрыть) |
| `is_full` | Кнопка Join заблокирована, строка dimmed, бейдж "FULL" |
| Ping (v2) | Не в MVP — отложено |

---

### Invite Code Generation

```
room_code = random 6-char alphanumeric, uppercase
charset = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # убраны 0/O/I/1 (ambiguous)
entropy = 33^6 ≈ 1.07 billion combinations
collision_chance = 1/1_073_741_824 per creation attempt
on_collision: regenerate (max 3 attempts, then error)
```

**Кейс: два игрока одновременно создали комнату с одинаковым кодом:**
Master Server хранит rooms в памяти (JS Map). При создании: синхронная проверка → insert (Node.js однопоточный event loop). Если код уже существует → regenerate. Риск коллизии при 1-3 активных комнатах практически нулевой.

---

### Healthcheck Protocol (Rooms Server ↔ Godot Process)

Godot процесс должен уведомлять Rooms Server о состоянии. Два механизма:

**Выбранный механизм: Godot HTTP healthcheck endpoint (TCPServer в GDScript).**
Godot запускает `TCPServer` на `healthcheck_port = ws_port + 1000` (e.g., Godot на :4447 → healthcheck на :5447).

```gdscript
# Новый autoload: rooms_reporter.gd (только на сервере)
# Реализует минимальный HTTP/1.1 ответ на GET /healthcheck:
{
  "state": "WAITING",        # текущий MatchState
  "players": 3,
  "room_code": "XKCD42"
}
```

Master Server polling каждые 5 секунд. Если healthcheck не отвечает 15 секунд:
→ SIGTERM Godot процессу → 5 секунд grace → SIGKILL → cleanup.

**Отклонено: stdout parsing** — Godot пишет JSON-строки в stdout, Node.js читает pipe. Fragile (mixing log output + data). Отклонено.

**Готовность при spawn:** Master Server polls `localhost:{healthcheck_port}/healthcheck` каждые 500ms после spawn, до 10 секунд. Если healthcheck ответил → комната помечается READY, ws_url возвращается клиенту. Если timeout → spawn считается неудачным → 503.

---

### Godot Process Launch Parameters

```js
// Node.js spawn (master.js)
const proc = spawn(GODOT_BIN, [
  "--headless", "--",
  "--port", "4445",
  "--room", "ABC123",
  "--map", "map_1",
  "--max-players", "8",
  "--healthcheck-port", "5445"
]);
// GODOT_BIN на Linux: /opt/smash-karts/smash-karts-server.x86_64 (embed_pck=true, не требует --path)
// GODOT_BIN в dev: C:\Godot_v4.6.1-stable_win64_console.exe
```

```gdscript
# Godot: rooms_reporter.gd читает параметры через OS.get_cmdline_user_args()
```

**Environment variables (master.js):**
```
GODOT_BIN          — путь к server binary
INTERNAL_TOKEN     — Bearer-токен для Godot → master /api/internal/* запросов
SERVER_SECRET      — Bearer-токен для match/submit auth (= INTERNAL_TOKEN или отдельный)
DB_PATH            — путь к SQLite файлу (default: ./smashkarts.db)
MASTER_PORT        — порт Express сервера (default: 8080)
PORT_POOL_START    — первый порт для Godot процессов (default: 4445)
PORT_POOL_SIZE     — размер пула (default: 100)
```

**Как Godot сообщает об окончании сессии:**
Когда последний игрок отключается, Godot healthcheck начинает возвращать `players: 0`.
Master обнаружит это при следующем polling интервале (5 сек) → cleanup.
Резервный механизм: healthcheck timeout (15 сек молчания) → SIGTERM.

---

### Changes to Existing Code

#### `scripts/network_manager.gd` — минимальные изменения

- Добавить чтение `--port` из cmdline args (сейчас `PORT := 4444` хардкодом)
- Остальное без изменений

```gdscript
# Заменить константу:
var PORT: int = _read_port_arg()  # default 4444

func _read_port_arg() -> int:
    var args := OS.get_cmdline_user_args()
    var idx := args.find("--port")
    if idx >= 0 and idx + 1 < args.size():
        return int(args[idx + 1])
    return 4444
```

#### `scripts/game_manager.gd` — без изменений

GameManager не знает про комнаты. Он работает с peer_id как и сейчас.

#### `scripts/lobby.gd` — значительный рефакторинг UI

Старая логика (ввод IP вручную) заменяется на:
1. Загрузка списка комнат через `GET /api/rooms` (публичные)
2. Форма "Создать комнату" → `POST /api/rooms` → получить ws_url → join_game(ws_url)
3. Поле "Код комнаты" → `GET /api/rooms/{code}` → получить ws_url → join_game(ws_url)
4. URL param `?join=CODE` → тот же GET → join_game(ws_url)

Детальная структура UI — в отдельном GDD (UX designer, задача C).

#### Новые файлы

| Файл | Роль |
|---|---|
| `scripts/rooms_reporter.gd` | Autoload (server-only). Читает --port/--room/--healthcheck-port из args. Запускает TCPServer-based HTTP healthcheck. Сигнализирует о пустой комнате. |
| `server/master.js` | Node.js Express сервер. Управление комнатами, spawn Godot процессов, WSS-прокси, match/submit handler, SQLite (better-sqlite3). |
| `server/package.json` | dependencies: express, better-sqlite3, ws, uuid |
| `server/events.js` | Stub для async event queue [deferred to v2] |

---

### Persistence

**MVP**: rooms в памяти (JS Map в master.js). После краша master все комнаты потеряны — Godot процессы продолжают работать (осиротевшие), но недостижимы через API.

**Решение для осиротевших процессов**: при старте master.js — сканировать занятые порты из pool и SIGTERM всё что не зарегистрировано.

**v2 (отложено)**: SQLite для сохранения room records при рестарте master. При рестарте: проверить что Godot процессы с сохранёнными PID живы (kill -0), пересинхронизировать.

**Match history**: Master Server сам обрабатывает итоги матча. Godot при MatchState → ENDED шлёт один `POST /api/internal/match/submit` с полным payload. Master.js `matchSubmitHandler` пишет в одной SQLite transaction: INSERT matches + INSERT match_participants × N + UPDATE profiles aggregates × N.

**Async event queue [deferred to v2]**: per-event лог (damage_events) откладывается. В MVP — только batch POST на match end. `server/events.js` содержит пустой stub структуру, готовую к v2.

---

### RPC Changes

Никаких новых игровых RPC. Rooms System работает на уровне HTTP и process management — выше уровня Godot Multiplayer API.

Единственное новое: `rooms_reporter.gd` должен знать текущий MatchState и player count. Читает из GameManager (autoload) — нет новых сигналов.

---

### Authority Model

Не меняется. GameManager остаётся авторитарным сервером. Rooms Server — только координатор запуска, он не участвует в игровой логике.

```
Rooms Server        Godot Process (room)          Client
     │                      │                        │
     │  spawn(port, code)   │                        │
     ├─────────────────────►│                        │
     │                      │                        │
     │  GET /healthcheck ──►│                        │
     │  ◄── { state, n } ──│                        │
     │                      │                        │
     │                      │◄── WS connect ─────────│
     │                      │◄── _register(name) ────│
     │                      │─── _rpc_spawn_kart ────►│
     │                      │       ... game ...      │
     │                      │                        │
     │  GET /healthcheck ──►│                        │
     │  ◄── { players: 0 } ─│                        │
     │                      │                        │
     │  SIGTERM ────────────►│                        │
```

---

### Edge Cases

| Scenario | Resolution |
|---|---|
| Два запроса на создание комнаты получают одинаковый код | Dict lock → check → insert в asyncio. Коллизия → regenerate (до 3 попыток). При 3 провалах → HTTP 503. |
| Игрок в двух вкладках с одним nick | Allowed — peer_id разный. В GameManager два разных игрока. Визуально: "Вася" и "Вася" на скорборде. Не баг — не меняем. |
| Godot процесс крашнул во время матча | Healthcheck timeout (15s) → Rooms Server помечает комнату CLEANUP. GET /api/rooms/{code} возвращает 404. Клиент получает server_disconnected → показывает "Комната недоступна". |
| Master упал (не Godot) | Godot процессы живут. ws_url недоступен через API, но если клиент уже знает ws_url (из local storage) — может подключиться напрямую. После рестарта master: scan + orphan cleanup. |
| Игрок знает ws_url и подключается мимо API | Разрешено. Это private game — не нужна защита. Godot принимает как обычный peer. |
| Комната в IN_MATCH — новый игрок хочет войти | GET /api/rooms/{code} возвращает state=IN_MATCH. Lobby UI показывает "Матч идёт, можно войти как наблюдатель или подождать". Подключение разрешено — late join через существующий Network Layer protocol. |
| Комната заполнена (current_players == max_players) | GET /api/rooms возвращает is_full=true. Lobby UI: строка dimmed, кнопка Join недоступна (disabled), бейдж "FULL". POST /api/rooms/{code}/join → 409 Conflict "Room is full". Клиент НЕ получает ws_url. Godot процесс не вызывается. |
| Игрок пытается зайти в FULL комнату через ?join=CODE | GET /api/rooms/CODE возвращает state + is_full=true. Lobby UI показывает "Комната заполнена" вместо ника-поля. Кнопка Join не появляется. |
| Все отключились во время POST_MATCH | Godot → players: 0 → rooms_reporter уведомляет → Rooms Server → CLEANUP. |
| idle timeout (комната создана, никто не присоединился) | Master: если `last_activity > IDLE_TIMEOUT_S` (300s, 5 мин) и `current_players == 0` → CLEANUP. |
| VPS перезагрузка | Все процессы убиты. При рестарте master: комнаты пустые. systemd автоматически перезапускает `smash-master.service`. Игроки видят пустой список — создают новые комнаты. |
| Reconnect после потери WebSocket | Allowed, не blocked. Клиент повторно вызывает join_game(ws_url) — Godot принимает как нового peer с новым peer_id. Скор и прогресс матча потеряны. Причина: нет persistent identity без Profile System (B2). |
| Порт уже занят при spawn | Master пробует следующий порт из pool. Попытки: 5 максимум, потом 503. |

---

### Integration with Profile System (B2)

Profile System работает с player identity (nickname → persistent record). Rooms System работает с сессионными данными матча.

**Связь**:
- Room хранит `players: List[str]` — display nicknames (не profile_id). Только для отображения.
- После матча Rooms Server отправляет результаты во внутреннее API: `POST /internal/match_results { room_code, duration, players_results: [{nickname, kills, deaths, damage}] }`. Profile System резолвит nicknames → profile_id и сохраняет.
- Rooms System НЕ зависит от Profile System — работает без неё. Profile System опционально обогащает данные.

---

### Phasing

#### MVP (первый деплой)

- [x] Master Server (Node.js Express) с in-memory storage комнат
- [x] POST /api/rooms → spawn Godot process → return room_code + ws_url + invite_link
- [x] GET /api/rooms → публичный список всех активных комнат (WAITING / IN_MATCH / POST_MATCH)
- [x] GET /api/rooms/{code} → resolve ws_url (для deep-link и клика по строке в browser)
- [x] `?join=CODE` авто-джоин (уже есть `?join=ADDR`, адаптируем)
- [x] network_manager.gd: читать --port из cmdline
- [x] rooms_reporter.gd: healthcheck endpoint (HTTPServer в GDScript или UDP ping)
- [x] Idle timeout (5 мин без игроков → cleanup)
- [x] nginx: проксировать /api/* и /ws/* на master :8080
- [x] systemd service `smash-master.service` (Node.js master)
- [x] FULL state: комнаты с current_players == max_players помечаются is_full=true, join недоступен

**MVP scope**: все комнаты публичные. Public room browser — core MVP, не v2.

#### v2 (после MVP)

- [ ] SQLite persistence для rooms (survives master restart)
- [ ] Lobby UI: выбор карты при создании комнаты
- [ ] Play Again кнопка (без реконнекта, WAITING → следующий матч)
- [ ] Persistent reconnect (session token → recover peer identity)
- [ ] Ping display в room browser

#### v3 / Отложено

- [ ] Региональные сервера (второй VPS)
- [ ] Rate limiting: max N комнат на IP за час
- [ ] Tournament bracket (спонсорский матч)
- [ ] Spectator mode (отдельный peer_id без kart)

---

## Formulas

### Port Allocation

```
port_pool = range(4445, 4545)  # 100 портов
healthcheck_port = ws_port + 1000  # e.g., 4447 → 5447
free_port = first port in pool not in active_rooms.values()
```

### Invite Code

```
charset_len = 33  # "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
code_len = 6
total_combinations = 33^6 = 1,073,741,824
collision_probability_at_3_rooms = 3 / 1,073,741,824 ≈ 0.0000003%
```

### Memory per room

```
godot_headless_idle = ~150 MB RSS
godot_headless_in_match_6players = ~200 MB RSS (estimate)
node_master = ~80 MB RSS (Node.js base + Express + better-sqlite3 + ws)
nginx = ~20 MB RSS

3 rooms (in_match) + infra = 3 * 200 + 80 + 20 = 700 MB
VPS 8GB → headroom: ~7.3 GB → can theoretically handle ~35 concurrent rooms
Realistic limit for 8GB with OS overhead: 20-25 rooms (never needed for 10 friends)
```

### Idle Timeout

```
IDLE_TIMEOUT_S = 300   # 5 minutes
CHECK_INTERVAL_S = 5   # master polls each room healthcheck every 5s
max_orphan_time = IDLE_TIMEOUT_S + CHECK_INTERVAL_S = 305s ≈ 5 min
```

---

## Edge Cases

(See also Edge Cases in Detailed Design section above.)

| Scenario | Resolution |
|---|---|
| Godot prints to stdout, pipe buffer fills | Master reads stdout via `child.stdout.on('data', ...)` (non-blocking). If process becomes unresponsive, healthcheck timeout handles it. |
| SIGTERM ignored by Godot | After 5s grace: SIGKILL via `child.kill('SIGKILL')` (Node.js child_process API). |
| Master port 8080 in use | systemd service fails to start → alert. Override via `MASTER_PORT` env var. |
| Max rooms reached (port pool exhausted) | POST /api/rooms → 503 "Server at capacity". Log error. |
| Code injection via room name | Master validates via DTO: name max 32 chars, alphanum + spaces + punctuation whitelist. No HTML/JS. |
| Race: два игрока одновременно кликают Join на WAITING комнате, последний слот | Godot принимает обоих — он не знает max_players из API. Master узнаёт о превышении только из healthcheck (current_players > max_players). Поведение: оба в матче, is_full=true после следующего healthcheck. Не критично для 10 друзей. |
| Игрок отключается из FULL комнаты | healthcheck → current_players уменьшается → is_full=false → комната снова отображается в списке как доступная. Автоматически, без дополнительной логики. |

---

## Dependencies

### Upstream (Rooms System depends on)

| System | Dependency | Type |
|---|---|---|
| **Network Layer** | WebSocket transport, port config | Hard |
| **Match System** | MatchState (Rooms Server reads from healthcheck) | Soft (observes) |
| **OS/VPS** | Process spawning, port availability | Infrastructure |

### Downstream (depends on Rooms System)

| System | What it needs |
|---|---|
| **Lobby UI** | REST API для списка комнат и создания |
| **Profile System (B2)** | POST /internal/match_results после CLEANUP |

### Bidirectional note

- **Network Layer GDD** (Open Question #2) был "multiple rooms — future". Rooms System закрывает этот вопрос через вариант B: отдельные процессы.
- **Match System GDD** не меняется. MatchState живёт внутри каждого Godot-процесса независимо.

---

## Tuning Knobs

| Knob | Default | Safe Range | Affects | Too Low | Too High |
|---|---|---|---|---|---|
| `IDLE_TIMEOUT_S` | 300 | 60-600 | Cleanup пустых комнат | Удаляет комнаты пока игрок в туалете | Осиротевшие процессы висят долго |
| `HEALTHCHECK_INTERVAL_S` | 5 | 2-30 | Частота проверки живости | Много HTTP запросов | Долго обнаруживаем краш |
| `HEALTHCHECK_TIMEOUT_S` | 15 | 10-60 | Время до CLEANUP после молчания | False positives на лаге | Ghost комнаты видны в списке |
| `PORT_POOL_START` | 4445 | 1025-60000 | Первый порт для комнат | — | — |
| `PORT_POOL_SIZE` | 100 | 10-1000 | Макс одновременных комнат | Мало комнат | Много занятых портов |
| `MAX_ROOM_NAME_LEN` | 32 | 8-64 | UI readability | Короткие имена | Длинные имена ломают layout |
| `MASTER_PORT` | 8080 | 1025-65535 | Внутренний API/WS порт | — | — |

---

## Acceptance Criteria

### Functional Tests (автоматизированные)

- [ ] POST /api/rooms (без поля type) → возвращает room_code (6 chars, valid charset), ws_url, invite_link
- [ ] GET /api/rooms → возвращает созданную комнату с полями name, state, current_players, max_players, is_full
- [ ] GET /api/rooms не содержит поля type в ответе
- [ ] Godot процесс запускается на указанном порту и отвечает на WebSocket handshake
- [ ] GET /api/rooms/{code} → возвращает корректный ws_url
- [ ] `?join=CODE` в URL → lobby.gd резолвит ws_url и вызывает join_game(ws_url)
- [ ] Клик по строке в room browser → lobby.gd резолвит ws_url через GET /api/rooms/{code} и вызывает join_game(ws_url)
- [ ] Два клиента подключаются к одному ws_url → оба появляются в матче
- [ ] POST /api/rooms два раза быстро → разные room_code, разные ws_port
- [ ] Все игроки отключились → healthcheck показывает players:0 → master cleanup
- [ ] IDLE_TIMEOUT: комната без игроков 5+ мин → автоматически удаляется
- [ ] При краше Godot процесса: healthcheck timeout → room удалена из GET /api/rooms
- [ ] current_players == max_players → is_full=true в GET /api/rooms и GET /api/rooms/{code}
- [ ] POST /api/rooms/{code}/join при is_full=true → 409 Conflict

### Network Tests

- [ ] 3 параллельных комнаты: все независимы (kill одной не трогает других)
- [ ] Master restart: orphan Godot процессы найдены и убиты при старте
- [ ] Bandwidth master ↔ Godot: healthcheck ~100 байт * 0.2/s = 20 B/s → negligible

### Playtest Criteria (human)

- [ ] Открыть сайт → видно список комнат (или пустой экран "нет комнат")
- [ ] Создать комнату → она сразу появляется в списке у другого игрока (без reload)
- [ ] Кликнуть на комнату в списке → join без ввода кода → оба в одном лобби
- [ ] ?join=CODE из Discord работает в Chrome без установки чего-либо
- [ ] Заполненная комната в списке: строка dimmed, кнопка Join недоступна, бейдж "FULL"
- [ ] Если комната умерла (Godot крашнул) → клиент видит ошибку, а не бесконечный лоадер
- [ ] После ухода всех игроков из FULL комнаты → она снова появляется как доступная

---

## Open Questions

1. **rooms_reporter.gd HTTP server**: В GDScript нет встроенного HTTP-сервера. Варианты: (a) TCP socket с ручным HTTP/1.1 parsing — несложно для одного endpoint; (b) UDP ping/pong вместо HTTP — master шлёт UDP ping на healthcheck_port, Godot отвечает pong с JSON payload. Реализация: (a) — master уже умеет HTTP (`fetch`/`got`), Godot открывает TCPServer на healthcheck_port и парсит однострочный HTTP/1.1 запрос. Тривиально для одного endpoint.

2. **Nginx WSS proxy для game ports**: Нужно ли проксировать game WebSocket через nginx (один 443 порт) или оставить прямые порты (4445-4545)? Прямые порты проще, но требуют открытия ~100 портов в firewall. Через nginx: один порт, но нужен путь `/room/{code}` → upstream `localhost:PORT`. Реализуемо, но чуть сложнее конфигурация. Решить при деплое.

3. **Play Again без реконнекта**: Когда матч заканчивается и все хотят сыграть снова — нужно ли сохранять WebSocket соединения или переподключаться? Текущий Match System делает `reload_current_scene()` → autoloads живут. WebSocket соединение через NetworkManager autoload тоже живёт. Значит Play Again = просто новый матч без реконнекта. Проверить что NetworkManager.peer не сбрасывается при reload_current_scene.

4. **Авторизация создания комнаты**: Сейчас нет. Любой может создать N комнат (DoS). Для компании друзей — не проблема. Если игра станет публичной — добавить rate limiting по IP или simple shared password.
