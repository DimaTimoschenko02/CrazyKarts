# Profile / Account System

> **Status**: In Design
> **Author**: Dima + systems-designer
> **Last Updated**: 2026-04-26
> **Milestone**: Beta (B2)
> **Implements Pillar**: Играй с друзьями (persistence, bragging rights, long-term engagement)

---

## Overview

Profile System — лёгкая система персистентных профилей без паролей и OAuth.
Каждый игрок идентифицируется уникальным nickname. При первом заходе генерируется
auth-token (UUID v4), сохраняется в localStorage браузера и в базе данных профиля.
При следующих заходах токен автоматически подтягивает профиль — игрок не вводит
имя повторно.

Вся stat-логика работает на стороне отдельного middleware-сервиса (Node.js Express),
который читает/пишет SQLite. Godot game server общается с ним по HTTP после окончания
матча. Никаких прямых SQL-коннектов из Godot — это GDScript без нормального
async SQL driver.

Система ориентирована на ~10 постоянных игроков. Масштабирование не является целью
на текущем этапе.

---

## Player Fantasy

"Я ввёл своё имя один раз. Теперь браузер меня помнит. После каждого матча я вижу
точную стату: сколько нанёс урона, из чего, кого больше всего мочил, кто мой главный
враг. Через месяц заходим играть снова — мои K/D и статистика на месте. Могу сказать
другу: 'Я твой главный киллер — проверь дашборд'."

Pillar alignment: **Играй с друзьями** — общая история матчей создаёт социальный
контекст. Статистика — это материал для разговора после игры.

---

## Identity Model

### Nickname Rules

| Rule | Value | Rationale |
|------|-------|-----------|
| Min length | 2 символа | Слишком короткий — не читается в килфиде |
| Max length | 20 символов | Влезает в scoreboard без truncation |
| Allowed charset | `[A-Za-z0-9_-]` | Без пробелов — URL-safe, безопасен в SQL |
| Case sensitivity | **Case-insensitive для uniqueness check** | `"Dima"` и `"dima"` — один профиль |
| Display case | Сохраняется как введён (canonical form) | Первый зарегистрировавший задаёт форму |
| Uniqueness scope | Global (вся БД) | Nickname = первичный ключ (lowercase) |

**Validation regex (server-side):**
```
^[A-Za-z0-9_-]{2,20}$
```

### Reserved Nicknames

Список заблокированных имён — не может быть зарегистрировано:
```
server, admin, bot, ai, system, moderator, host, god, null, undefined
```

Проверка case-insensitive. Список расширяем без кода (конфиг или таблица `reserved_nicknames`).

### Nickname Conflict Flow (UI — реализует ux-designer в фазе C)

1. Игрок вводит nickname в Lobby
2. Client шлёт `POST /api/profile/register` с `{nickname, token: null}`
3. Если nickname занят → server отвечает `{conflict: true, suggestions: ["Dima_2", "Dima99", "DimaX"]}`
4. UI показывает: "Это имя уже занято. Попробуй: [кнопки с вариантами]"
5. Игрок выбирает вариант или вводит другое имя

**Suggestions algorithm (server-side):**
```
base = nickname_lower
candidates = [base + "_2", base + "_" + random(10,99), base[0:18] + "X"]
return first 3 that are available
```

---

## Auth-Token Mechanism

### Token Format

UUID v4 в строковом представлении: `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`

Пример: `f47ac10b-58cc-4372-a567-0e02b2c3d479`

32 байта случайности (122 бита entropy). Коллизия невозможна в рамках 10 пользователей.

### Storage

| Хранилище | Значение | Как использовать |
|-----------|----------|-----------------|
| Браузер localStorage | `smash_karts_token` | Читается при старте Lobby |
| База данных (profiles.auth_token) | UUID v4 hash | Сервер верифицирует при каждом запросе |

**Хранение в DB: хеш, не plaintext.**
```
stored = SHA-256(token_uuid)
```
При верификации: `SHA-256(incoming_token) == stored_hash`

Это предотвращает компрометацию токенов при утечке БД.

### Token Lifecycle

| Событие | Действие |
|---------|----------|
| Первый заход (нет токена в localStorage) | Генерируется новый UUID, создаётся профиль |
| Повторный заход (токен есть) | `POST /api/profile/auth` → возвращает профиль |
| Токен валиден | Профиль подтягивается, игрок сразу в лобби с именем |
| Токен не найден в БД | Профиль не найден → flow как при первом заходе |
| Ручной сброс (кнопка "Сменить аккаунт") | localStorage очищается, новый flow регистрации |

**Токен никогда не ротируется автоматически** — обновление только по явному запросу
пользователя. Для аудитории из 10 друзей угроза угона аккаунта минимальна.

### Edge Cases

| Сценарий | Поведение |
|----------|-----------|
| Два устройства с одним токеном | Оба входят под одним профилем — это нормально (один игрок, два браузера) |
| Токен потерян (очистка браузера) | Создаётся новый профиль. Старый остаётся в БД (возможно осиротевший) |
| Потеря старого ника | Игрок может ввести тот же nickname → если незанят (orphaned), регистрируется заново. Если занят (кто-то взял) → conflict flow |
| Nickname "угнан" пока токен существует | Невозможно: nickname unique и токен привязан к нику |
| localStorage недоступен (приватный режим) | Токен не сохраняется → каждый сеанс нужно вводить имя. Допустимо для MVP |

---

## Database — SQLite vs PostgreSQL Decision

### Сравнение

| Критерий | SQLite | PostgreSQL |
|----------|--------|------------|
| Деплой | Один файл рядом с сервером | Отдельный процесс, конфиг, порт |
| Concurrent writes | Serialized (WAL mode: OK для ~10 юзеров) | MVCC, параллельные транзакции |
| Аналитические запросы | Базовые GROUP BY, нет window functions до SQLite 3.25 | Полный SQL: OVER(), PARTITION BY, JSON ops |
| Backup | `cp smashkarts.db smashkarts.db.bak` | `pg_dump`, настройка cron |
| Memory footprint | ~2MB процесс | ~50-100MB PostgreSQL daemon |
| JSON columns | `TEXT` + парсинг в app | `JSONB` с индексами и операторами |
| Целевая нагрузка | 10 игроков, 1-5 матчей/день | — |

### Решение: **SQLite**

**Обоснование:**
1. **Нагрузка**: 10 игроков, ~1-5 записей `match_participants` в день. WAL-mode SQLite
   спокойно держит 100+ concurrent reads и 10+ writes/sec. Нашей нагрузки нет в принципе.
2. **Деплой**: Весь стек Godot server + middleware + БД — на одном VPS. Одна команда
   `npm start` запускает всё. PostgreSQL потребует отдельного сервиса, pg_hba.conf,
   пользователя, порта.
3. **Аналитика**: Все нужные нам запросы (duels, fav_weapon, K/D) выражаются
   стандартным SQL. Window functions есть в SQLite начиная с 3.25 (2018) — на любом
   современном Ubuntu/Debian это покрыто.
4. **Backup**: `cp` или `VACUUM INTO 'backup.db'` — ничего настраивать.
5. **Миграция**: Если проект вырастет до 100+ игроков, данные можно перелить в
   PostgreSQL за вечер через стандартный SQL dump/restore.

**WAL mode обязателен:**
```sql
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
```
Это позволяет параллельные reads во время write — middleware читает стату пока
записывает окончание матча.

---

## Database Schema (DDL)

### Таблицы

```sql
-- Хранить nickname в lowercase (canonical). Display form — отдельное поле.
CREATE TABLE profiles (
    nickname_lower   TEXT PRIMARY KEY,           -- 'dima' — canonical key
    nickname_display TEXT NOT NULL,              -- 'Dima' — как показывать
    auth_token_hash  TEXT NOT NULL UNIQUE,       -- SHA-256(uuid_v4)
    created_at       INTEGER NOT NULL,           -- Unix timestamp (seconds)
    last_seen_at     INTEGER NOT NULL,

    -- Aggregate stats (denormalized for fast profile page)
    total_kills      INTEGER NOT NULL DEFAULT 0,
    total_deaths     INTEGER NOT NULL DEFAULT 0,
    total_assists    INTEGER NOT NULL DEFAULT 0,
    total_damage_dealt INTEGER NOT NULL DEFAULT 0,
    total_damage_taken INTEGER NOT NULL DEFAULT 0,
    total_shots_fired INTEGER NOT NULL DEFAULT 0,
    total_shots_hit   INTEGER NOT NULL DEFAULT 0,
    total_matches    INTEGER NOT NULL DEFAULT 0,
    total_wins       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE matches (
    match_id     TEXT PRIMARY KEY,               -- UUID v4
    started_at   INTEGER NOT NULL,               -- Unix timestamp
    ended_at     INTEGER,                        -- NULL если матч ещё идёт
    map_id       TEXT NOT NULL DEFAULT 'map_1',
    room_id      TEXT,                           -- для будущей Rooms System (B1)
    player_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE match_participants (
    match_id          TEXT NOT NULL REFERENCES matches(match_id),
    nickname_lower    TEXT NOT NULL REFERENCES profiles(nickname_lower),
    placement         INTEGER,                   -- 1 = winner (highest score)

    kills             INTEGER NOT NULL DEFAULT 0,
    deaths            INTEGER NOT NULL DEFAULT 0,
    assists           INTEGER NOT NULL DEFAULT 0,
    damage_dealt      INTEGER NOT NULL DEFAULT 0,
    damage_taken      INTEGER NOT NULL DEFAULT 0,
    shots_fired       INTEGER NOT NULL DEFAULT 0,
    shots_hit         INTEGER NOT NULL DEFAULT 0,
    best_killstreak   INTEGER NOT NULL DEFAULT 0,
    time_alive_sec    INTEGER NOT NULL DEFAULT 0,  -- сек в живых (суммарно)
    score             INTEGER NOT NULL DEFAULT 0,  -- kills*100 + assists*50

    -- Per-weapon breakdown (JSON array of {weapon, shots, hits, kills, damage})
    weapon_stats      TEXT NOT NULL DEFAULT '[]', -- JSON

    PRIMARY KEY (match_id, nickname_lower)
);

```

### Индексы

```sql
-- Поиск участников матча
CREATE INDEX idx_mp_match ON match_participants(match_id);

-- Поиск всех матчей игрока (для истории)
CREATE INDEX idx_mp_profile ON match_participants(nickname_lower);
```

### Deferred to v2: per-hit damage log

`damage_events` и VIEW `duels` **НЕ входят в MVP schema** — добавятся в v2 (Alpha A) для deep analytics (heat maps, точная accuracy, nemesis/prey). Хранятся здесь как референс будущей миграции.

**Trade-off (если включить):** при 10 игроках, матч ~180с, ~5 попаданий/минуту на игрока →
~900 событий/матч. За 100 матчей = 90,000 строк (~4MB). Приемлемо. Retention policy: удалять старше 90 дней.

```sql
-- v2: per-hit log для deep analytics
CREATE TABLE damage_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id      TEXT NOT NULL REFERENCES matches(match_id),
    timestamp_ms  INTEGER NOT NULL,             -- Time.get_ticks_msec() или wall clock
    attacker_nick TEXT NOT NULL,                -- nickname_lower (может быть '' для env)
    victim_nick   TEXT NOT NULL,                -- nickname_lower
    weapon_name   TEXT NOT NULL DEFAULT '',     -- 'rocket_launcher', 'mine', etc.
    damage_type   TEXT NOT NULL DEFAULT '',     -- 'PROJECTILE', 'AOE_EXPLOSION', 'CONTACT', 'ENVIRONMENTAL'
    amount        INTEGER NOT NULL,             -- final damage applied (after modifiers)
    is_kill       INTEGER NOT NULL DEFAULT 0    -- 1 if this event caused death
);

-- v2: Duel aggregates — derived VIEW (требует damage_events)
CREATE VIEW duels AS
    SELECT
        mp_a.nickname_lower AS attacker,
        mp_b.nickname_lower AS victim,
        COUNT(*)            AS matches_together,
        SUM(CASE WHEN de.is_kill = 1 AND de.attacker_nick = mp_a.nickname_lower
                 THEN 1 ELSE 0 END) AS kills_by_a,
        SUM(CASE WHEN de.is_kill = 1 AND de.attacker_nick = mp_b.nickname_lower
                 THEN 1 ELSE 0 END) AS kills_by_b
    FROM damage_events de
    JOIN match_participants mp_a
         ON de.match_id = mp_a.match_id AND de.attacker_nick = mp_a.nickname_lower
    JOIN match_participants mp_b
         ON de.match_id = mp_b.match_id AND de.victim_nick = mp_b.nickname_lower
    WHERE mp_a.nickname_lower != mp_b.nickname_lower
    GROUP BY mp_a.nickname_lower, mp_b.nickname_lower;

-- v2: индексы для damage_events
CREATE INDEX idx_de_match ON damage_events(match_id);
CREATE INDEX idx_de_attacker ON damage_events(attacker_nick);
CREATE INDEX idx_de_victim ON damage_events(victim_nick);
```

---

## Stats Vocabulary

### Per-Match (в match_participants)

| Метрика | Тип | Описание |
|---------|-----|----------|
| `kills` | int | Финальный удар по противнику |
| `deaths` | int | Количество смертей |
| `assists` | int | Урон за 5с до чужого килла |
| `damage_dealt` | int | Суммарный нанесённый урон |
| `damage_taken` | int | Суммарный полученный урон |
| `shots_fired` | int | Выпущенных снарядов |
| `shots_hit` | int | Попаданий (снаряд задел цель) |
| `best_killstreak` | int | Максимальная серия без смерти |
| `time_alive_sec` | int | Суммарное время в живых (секунд) |
| `score` | int | kills×100 + assists×50 |
| `placement` | int | Место по score (1 = победитель) |
| `weapon_stats` | JSON | Разбивка по оружию (см. ниже) |

**weapon_stats JSON schema:**
```json
[
  {
    "weapon": "rocket_launcher",
    "shots_fired": 12,
    "shots_hit": 7,
    "kills": 3,
    "damage": 215
  }
]
```

### Per-Profile Aggregate (в profiles)

| Метрика | Описание |
|---------|----------|
| `total_kills` | Все убийства за все матчи |
| `total_deaths` | Все смерти |
| `total_assists` | Все ассисты |
| `total_damage_dealt` | Суммарный урон |
| `total_damage_taken` | Суммарно полученный урон |
| `total_shots_fired` | Всего выстрелов |
| `total_shots_hit` | Всего попаданий |
| `total_matches` | Количество матчей |
| `total_wins` | Количество первых мест |

### Derived / Computed Stats (вычисляются middleware при запросе)

| Метрика | Формула | Описание |
|---------|---------|----------|
| `kd_ratio` | `total_kills / max(1, total_deaths)` | K/D всех времён |
| `accuracy_pct` | `total_shots_hit * 100.0 / max(1, total_shots_fired)` | Точность всех времён |
| `win_rate_pct` | `total_wins * 100.0 / max(1, total_matches)` | % матчей с 1-м местом |
| `avg_damage_per_match` | `total_damage_dealt / max(1, total_matches)` | Средний урон |
| `favourite_weapon` | `argmax(weapon_stats.damage по всем match_participants)` | Оружие с максимальным суммарным уроном |
| `nemesis` | `argmax(kills WHERE attacker = X AND victim = self) FROM duels` | Кто убивал тебя чаще всего |
| `prey` | `argmax(kills WHERE attacker = self AND victim = Y) FROM duels` | Кого ты убивал чаще всего |

### Дополнительные интересные метрики (для дашборда v2)

| Метрика | Описание | Зачем |
|---------|----------|-------|
| `most_damage_single_match` | Рекорд урона за один матч | Bragging rights |
| `longest_killstreak_ever` | Рекордная серия убийств | Bragging rights |
| `damage_efficiency` | `damage_dealt / max(1, damage_taken)` | Насколько эффективно атакуешь vs получаешь |
| `assist_rate` | `assists / max(1, kills)` | Насколько игрок командный |
| `survival_ratio` | `avg(time_alive_sec) / match_duration` | Как долго живёт в среднем |

---

## Server-Side Architecture

### Выбор: Middleware vs Прямой DB Connect из Godot

**Прямой DB connect из Godot: не рекомендуется.**

GDScript не имеет зрелых async SQL-драйверов. SQLite в Godot доступен только через
GDExtension (`godot-sqlite` от Khenzio) — третья сторона, лишняя зависимость для HTML5
export, возможные проблемы с headless. HTTP из Godot (`HTTPRequest`) — стандартный
встроенный инструмент.

**Middleware: Node.js Express.**

| Критерий | Node.js Express | Python FastAPI |
|----------|----------------|----------------|
| Знание стека | Основной стек Dima (NestJS) | Вторичный |
| Async I/O | Нативный | Нативный (asyncio) |
| SQLite клиент | `better-sqlite3` (synchronous, простой) | `aiosqlite` |
| JSON API | Express Router | FastAPI |
| Деплой | `npm install && node server.js` | `pip install && uvicorn` |
| Код объёма | ~200 строк для MVP | ~200 строк для MVP |

**Решение: Node.js Express + better-sqlite3.**

Знакомый стек, быстрый старт, минимум конфигурации.

### Структура компонентов

```
VPS
├── Godot Headless Server (порт 4444, WebSocket)
│   └── После match end: HTTP POST → localhost:3000/api/match/submit
│
├── Node.js Profile API (порт 3000, только localhost + nginx proxy)
│   ├── GET  /api/profile/auth           — верифицировать токен → вернуть профиль
│   ├── POST /api/profile/register       — создать профиль, вернуть токен
│   ├── GET  /api/profile/:nick          — публичный профиль (stats)
│   ├── POST /api/match/submit           — game server шлёт итоги матча
│   └── GET  /api/leaderboard            — топ-10 по K/D (v2)
│
├── smashkarts.db (SQLite файл)
│
└── nginx
    ├── / → HTML5 build
    ├── /wss → proxy WebSocket 4444
    └── /api → proxy localhost:3000
```

### Godot → Middleware: Протокол

Godot headless server (не клиент!) шлёт HTTP POST в конце матча:

```json
POST localhost:3000/api/match/submit
Authorization: Bearer <SERVER_SECRET>

{
  "match_id": "uuid-v4",
  "started_at": 1714000000,
  "ended_at": 1714000180,
  "map_id": "map_1",
  "participants": [
    {
      "nickname": "Dima",
      "kills": 8,
      "deaths": 3,
      "assists": 2,
      "damage_dealt": 520,
      "damage_taken": 210,
      "shots_fired": 22,
      "shots_hit": 14,
      "best_killstreak": 4,
      "time_alive_sec": 145,
      "score": 900,
      "placement": 1,
      "weapon_stats": [
        {"weapon": "rocket_launcher", "shots_fired": 22, "shots_hit": 14, "kills": 8, "damage": 520}
      ]
    }
  ],
  "damage_events": [
    {
      "timestamp_ms": 12500,
      "attacker": "Dima",
      "victim": "Kolya",
      "weapon": "rocket_launcher",
      "damage_type": "AOE_EXPLOSION",
      "amount": 35,
      "is_kill": false
    }
  ]
}
```

`SERVER_SECRET` — env variable на VPS, не хранится в клиентском коде.
Клиент никогда не шлёт стату напрямую — только через Godot server.

### ProfileManager в Godot (сервер)

Autoload `ProfileManager` на Godot headless server:

```gdscript
class_name ProfileManager
extends Node

const API_BASE := "http://localhost:3000/api"
const SERVER_SECRET := "" # читать из env через OS.get_environment()

# Кеш: nickname → {nickname, token_hash, ...} для текущего матча
var _session_cache: Dictionary = {}

func submit_match(match_data: Dictionary) -> void:
    var http := HTTPRequest.new()
    add_child(http)
    http.request_completed.connect(_on_submit_done.bind(http))
    http.request(
        API_BASE + "/match/submit",
        ["Authorization: Bearer " + SERVER_SECRET, "Content-Type: application/json"],
        HTTPClient.METHOD_POST,
        JSON.stringify(match_data)
    )

func _on_submit_done(result, code, headers, body, http: HTTPRequest) -> void:
    http.queue_free()
    if code != 200:
        push_error("[ProfileManager] submit failed: " + str(code))
```

### Данные для `match/submit` из GameManager

GameManager уже хранит `match_scores: Dictionary` (per MatchScore) и слушает
`EventBus.damage_dealt`. При переходе в `ENDED`:

```
GameManager._on_match_ended()
  → собирает MatchResults (kills, deaths, assists, damage, weapon_stats)
  → собирает damage_events из in-memory buffer
  → вызывает ProfileManager.submit_match(match_data)
```

---

## Event Flow: Damage → Database

```
1. Player A стреляет → RocketProjectile.hit(B)
   └── DamageInfo(type=AOE_EXPLOSION, amount=35, attacker=A, weapon="rocket_launcher")

2. HealthComponent.apply_damage(info) [SERVER ONLY]
   ├── Обновляет current_hp
   ├── EventBus.damage_dealt.emit(A_id, B_id, info, final_amount)
   └── Если HP=0: GameManager.record_kill(B, A, info)

3. GameManager [listens to EventBus.damage_dealt]
   ├── match_scores[A].damage_dealt += final_amount
   ├── match_scores[B].damage_taken += final_amount
   ├── weapon_stats[A]["rocket_launcher"].damage += final_amount
   ├── weapon_stats[A]["rocket_launcher"].shots_hit += 1
   └── _damage_event_buffer.append({timestamp_ms, A, B, weapon, type, amount, is_kill})

4. WeaponComponent [on fire]
   └── match_scores[A]["rocket_launcher"].shots_fired += 1

5. Match ends → MatchState.ENDED
   ├── GameManager._build_match_payload() → собирает всё в Dictionary
   └── ProfileManager.submit_match(payload) → HTTP POST → Node.js API

6. Node.js API (match/submit handler)
   ├── INSERT INTO matches (...)
   ├── INSERT INTO match_participants (...) × N
   ├── INSERT INTO damage_events (...) × M  [batch]
   └── UPDATE profiles SET total_kills += ..., total_deaths += ... WHERE nickname_lower = ?
       (для каждого участника)

7. HTTP 200 → GameManager продолжает restart_timer
   (match restart не ждёт подтверждения — fire-and-forget,
    если API недоступен — матч всё равно перезапускается)

8. При следующем входе игрока:
   └── Lobby → GET /api/profile/auth?token=UUID → JSON профиль с агрегатами
```

**Важно:** Godot game server не ждёт ответа от API перед рестартом. Stats submission
— fire-and-forget. Потеря статистики при падении API приемлема для аудитории из 10 друзей.

---

## Formulas

### K/D Ratio

```
kd_ratio = total_kills / max(1, total_deaths)
```

| Variable | Type | Range | Notes |
|----------|------|-------|-------|
| `total_kills` | int | 0..∞ | Aggregate across all matches |
| `total_deaths` | int | 0..∞ | max(1,...) prevents division by zero |
| `kd_ratio` | float | 0.0..∞ | Displayed as "X.XX" |

### Accuracy

```
accuracy_pct = shots_hit * 100.0 / max(1, shots_fired)
```

| Variable | Type | Range |
|----------|------|-------|
| `shots_hit` | int | 0..shots_fired |
| `shots_fired` | int | 0..∞ |
| `accuracy_pct` | float | 0.0..100.0 |

Трекается per-match и aggregate. Отображается как "XX.X%".

### Win Rate

```
win_rate_pct = total_wins * 100.0 / max(1, total_matches)
```

Победа = `placement = 1` в `match_participants`.

### Damage Efficiency

```
damage_efficiency = total_damage_dealt / max(1, total_damage_taken)
```

Значение > 1.0 = игрок наносит больше чем получает. Отображается как "X.XX".

### Nickname Suggestion

```
suggestions = [
    base + "_2",                              -- простой суффикс
    base + "_" + randint(10, 99),             -- рандомный суффикс
    base[:min(18, len(base))] + "X"           -- с заменой последних символов
]
-- Отфильтровать занятые, вернуть первые 3
```

---

## Edge Cases

| Сценарий | Поведение |
|----------|-----------|
| Игрок не зарегистрирован, но уже в лобби | Блокируется в Lobby UI — nickname required перед join/host |
| Токен есть, но профиль удалён из БД | 404 от API → Lobby показывает "Создать новый профиль" |
| API недоступен при регистрации | Lobby показывает ошибку "Сервер статистики недоступен. Сыграть без аккаунта?" (guest mode) |
| API недоступен при submit после матча | Ошибка логируется, матч перезапускается без сохранения статы |
| Два клиента с одним токеном одновременно в матче | Невозможно: один peer_id per connection. Если один и тот же ник зайдёт дважды — второй вытеснит первого (Lobby должен проверять дубли) |
| Матч прерван (все вышли) | match_participants сохраняются с тем что есть. ended_at проставляется текущим временем |
| Игрок вышел в середине матча | Его match_participants сохраняется с данными до момента выхода |
| Пустой weapon_stats | Сохраняется `'[]'`, отображается как "Оружие не использовалось" |
| Nickname 20 символов + суффикс не влезает | suggestions генерируют только из первых 18 символов |
| ENVIRONMENTAL kill (attacker_id = -1) | `attacker_nick = ''`, `damage_events.attacker_nick = ''`. В дашборде — "Среда" |
| Попытка записи через клиент напрямую | `POST /api/match/submit` требует `SERVER_SECRET`. Клиент его не знает. |

---

## Privacy

### Что видят другие игроки

По умолчанию все stats публичные в рамках закрытого сообщества (~10 друзей).
Нет настроек приватности в MVP. Все видят профиль любого игрока по nickname.

### Удаление профиля

MVP: нет UI для удаления. Ручное удаление через API endpoint:

```
DELETE /api/profile/:nick
Authorization: Bearer <SERVER_SECRET>
```

Cascade: удаляет `match_participants` и `damage_events` связанного игрока.
Матчи без участника остаются.

### GDPR

Для аудитории из 10 друзей в России — GDPR не применяется формально.
Никаких PII: только nickname + game stats. Нет email, нет IP, нет location.
Единственная личная привязка — токен в localStorage (на устройстве пользователя).

### v2: Opt-out из публичной статы

Флаг `profiles.is_private` — если true, профиль не отображается в leaderboard
и недоступен по публичному GET. Только сам владелец видит свои stats (по токену).

---

## Dependencies

### Upstream (Profile System depends on)

| System | Dependency | Type |
|--------|-----------|------|
| **Network Layer** | Lobby использует WebSocket для получения nickname; game server шлёт HTTP | Hard |
| **Match System** | match_ended event запускает submit; MatchScore структура определяет payload | Hard |
| **Health & Damage** | EventBus.damage_dealt — источник damage_events и stats | Hard |
| **Weapon System** | weapon_name в DamageInfo — источник weapon_stats | Soft |

### Downstream (depends on Profile System)

| System | What it needs |
|--------|--------------|
| **Lobby UI** | Profile auth flow: токен → nickname → join |
| **Scoreboard UI** | post-match stats, MVP данные |
| **Rooms System (B1)** | room.participants[] ссылаются на nickname_lower |
| **Analytics External** | Весь профиль и match_participants как data source |

### Bidirectional Interfaces

- **Match System → Profile**: `match_ended` signal → `ProfileManager.submit_match()`
- **Profile → Lobby**: REST GET возвращает profil; Lobby отображает nickname
- **Health & Damage → Profile**: EventBus в GameManager → in-memory buffer → submit payload

---

## Tuning Knobs

| Knob | Default | Safe Range | Affects | Notes |
|------|---------|------------|---------|-------|
| `min_nickname_length` | 2 | 1-5 | UX vs spam | < 2 = trash nicknames |
| `max_nickname_length` | 20 | 10-32 | scoreboard layout | > 20 = не влезает в UI |
| `assist_window_sec` | 5 | 3-10 | assist frequency | Уже определён в Health & Damage |
| `damage_events_retention_days` | 90 | 30-365 | DB size | 90 дней ≈ 4MB при 10 игроках |
| `api_port` | 3000 | 1024-65535 | infrastructure | Только localhost, за nginx |
| `server_secret_length` | 32 bytes | 16-64 | security | env var, не в коде |
| `nickname_suggestion_count` | 3 | 1-5 | UX | Больше 5 — перегруженный UI |

---

## Phasing

### MVP (Beta B2)

**Цель:** Никакой ник не теряется между сессиями. После матча можно увидеть свою стату.

- Уникальный nickname (case-insensitive uniqueness)
- Auth-token в localStorage
- Middleware API: register, auth, submit
- SQLite schema: profiles, matches, match_participants
- Без damage_events (добавим в v2 — меньше объём payload для MVP)
- Post-match scoreboard показывает данные из match_participants текущего матча
- Агрегаты в profiles обновляются (total_kills, total_deaths, total_damage_dealt)

### v2 (Alpha A)

**Цель:** Полноценная статистика и история матчей.

- damage_events таблица и retention policy (90 дней)
- Derived stats: kd_ratio, accuracy, win_rate, damage_efficiency
- Nemesis / Prey из duel view
- Favourite weapon computation
- Публичный профиль `/api/profile/:nick` (JSON)
- История матчей (последние 20)
- Per-weapon stats в post-match scoreboard

### v3 (Beta B)

**Цель:** Социальные метрики и соревновательный контекст.

- Leaderboard API (top-10 по K/D, damage, wins)
- Frontend dashboard (отдельная страница)
- ELO-подобный рейтинг (простая формула на основе placement)
- Achievements (first blood, killstreak, damage record)
- Opt-out privacy flag
- Replay system (если реализован в game server)

---

## Acceptance Criteria

### Functional Tests (automated)

- [ ] `POST /api/profile/register` с уникальным nick возвращает token и 201
- [ ] `POST /api/profile/register` с занятым nick возвращает `{conflict: true, suggestions: [...]}`
- [ ] `POST /api/profile/auth` с валидным токеном возвращает профиль и 200
- [ ] `POST /api/profile/auth` с невалидным токеном возвращает 404
- [ ] `POST /api/match/submit` без SERVER_SECRET возвращает 401
- [ ] `POST /api/match/submit` с валидным payload обновляет profiles.total_kills
- [ ] Два вызова register с одинаковым nick (разный регистр) → conflict
- [ ] Профиль с nickname "admin" → 400 (reserved)
- [ ] Nickname длиннее 20 символов → 400 (validation)
- [ ] Nickname с пробелами → 400 (invalid charset)
- [ ] damage_events не хранятся в MVP (payload без них принимается нормально)
- [ ] total_matches инкрементится после submit

### Network / Integration Tests

- [ ] Godot server успешно шлёт submit после match_ended (HTTPRequest не виснет)
- [ ] API недоступен → Godot логирует ошибку и продолжает restart_timer
- [ ] Lobby GET /api/profile/auth с localStorage токеном → nickname подставляется автоматически
- [ ] submit payload содержит все поля (нет null для required полей)

### Playtest Criteria (human)

- [ ] Первый вход: ввёл имя, токен сохранился, при повторном заходе имя уже вписано
- [ ] После матча: scoreboard показывает K/D, damage, assists корректно
- [ ] Если API упал: lobby не падает, можно играть (graceful degradation)
- [ ] Nickname conflict: предложения понятны и кликабельны
- [ ] Очистка localStorage → flow нового аккаунта работает (не падает)

---

## Open Questions

1. **Guest mode**: Если API недоступен при регистрации — разрешить ли играть без аккаунта?
   Stats не сохранятся. UX: "Играть как гость [имя]" vs "Только с аккаунтом".
   Для ~10 друзей скорее всего API всегда доступен — отложить до первого сбоя.

2. **Nickname change**: Позволить ли менять отображаемое имя без смены canonical key?
   Например, `dima` display → `DIMA`. Requires `ALTER TABLE` или второе поле. Отложено v2.

3. **Orphaned profiles**: Если игрок потерял токен и создал новый профиль с тем же ником
   (занят) — старый профиль висит мёртвым грузом. Cleanup job нужен? Retention: удалять
   профили без матчей старше 180 дней.

4. **Damage tracking for accuracy**: shots_fired — откуда берётся? WeaponComponent при
   каждом выстреле должен шлать событие в GameManager. Нужен `EventBus.weapon_fired`
   сигнал (сейчас его нет в event_bus.gd).

5. **Rooms System (B1) integration**: room_id в matches — placeholder. Когда B1 будет
   реализован, матчи должны быть привязаны к комнатам. API match/submit должен принимать
   room_id опционально.
