# SmashKarts Clone

Браузерная 3D мультиплеер-игра для компании друзей. Клон SmashKarts.io с расширенной статистикой.

## Стек
- **Движок:** Godot 4.6, GDScript
- **Физика:** CharacterBody3D + move_and_slide() (arcade стиль)
- **Мультиплеер:** WebSocketMultiplayerPeer (Godot High-Level Multiplayer API)
- **Сервер:** Godot headless на dedicated VPS (Linux, 8GB RAM)
- **Клиент:** HTML5 export → браузер
- **Web server:** nginx (HTTPS, раздаёт HTML5 билд) + wss://порт 4444 (game server)
- **Локальная разработка:** `build/serve.py` (порт 8060) — раздаёт HTML5 билд

## Инструменты разработки

- **Godot GUI:** `C:\Godot_v4.6.1-stable_win64.exe`
- **Godot Console (headless):** `C:\Godot_v4.6.1-stable_win64_console.exe`
- **Проект:** `C:\Users\dimti\do_chego_doshel_progress\smash-karts-clone\`
- **Справочный проект (ассеты):** `C:\Users\dimti\do_chego_doshel_progress\Smash carts\` — Quaternius Ultimate Karts Pack
- **MCP:** tugcantopaloglu/godot-mcp (149 tools) через `.mcp.json` → скилл `/godot-mcp`
- **Hot-reload параметры:** `dev_params.json` — физика/камера, только debug builds
- **На порту 8000 сидит чужой FastAPI** — не использовать, serve.py на 8060

## Запуск для разработки
1. Открыть проект в Godot 4.6
2. Запустить сцену `scenes/lobby.tscn`
3. Одно окно: Host Game → вводит имя
4. Второе окно (или другой браузер): Join с IP `127.0.0.1`
5. Для HTML5: экспорт из Godot → `python build/serve.py` → `http://localhost:8060/index.html`

## Ключевые файлы

| Файл | Роль |
|------|------|
| `scripts/network_manager.gd` | Autoload — WebSocket сервер/клиент |
| `scripts/game_manager.gd` | Autoload — HP, kills, deaths, respawn |
| `scripts/player_data.gd` | Autoload — имя локального игрока |
| `scripts/kart_controller.gd` | CharacterBody3D — физика, дрифт, стрельба, синхронизация |
| `scripts/base_projectile.gd` | BaseProjectile — движение, AOE урон, DamageInfo |
| `scripts/rocket_projectile.gd` | RocketProjectile — взрыв при попадании/lifetime |
| `scripts/projectile_resource.gd` | ProjectileResource — Resource конфиг снарядов |
| `scripts/weapon_pickup.gd` | Area3D — подбор оружия |
| `scripts/game_world.gd` | Главный скрипт игровой сцены, спавн картов |
| `scripts/hud.gd` | Очки, HP-бар, kill feed |
| `scripts/lobby.gd` | UI лобби — Host/Join |
| `scripts/game_states.gd` | Autoload — enum'ы KartState/MatchState/WeaponState + transition tables |
| `scripts/state_manager.gd` | Autoload — хранение состояний, RPC, серверные таймеры, сигналы |
| `scenes/player_kart.tscn` | Сцена карта (BaseCar + Camera + NameLabel) |
| `scenes/base_car.tscn` | Модель машинки (Car2.glb + drift VFX) |

## Архитектура мультиплеера
- Сервер **авторитарный** для урона и смертей (`GameManager` запускается на сервере)
- Позиции картов синхронизируются через RPC (клиент → все) на частоте 30 Hz
- Ракеты спавнятся по команде сервера на всех клиентах одновременно
- Карты спавнятся через **ручной RPC** (НЕ MultiplayerSpawner): клиент шлёт `_register` из `game_world._ready()`, сервер отвечает `_rpc_spawn_kart` для каждого карта
- **НЕ использовать MultiplayerSpawner** — он реплицирует ноды до загрузки сцены на клиенте (race condition)
- **Авто-джоин:** URL-параметры `?join=АДРЕС&name=ИМЯ` пропускают лобби (lobby.gd `_try_auto_join`)
- **Хостинг из браузера:** пока отключён (lobby.gd блокирует кнопку Host для web builds). Вопрос открыт — возможно стоит разрешить или сделать иначе. Требует обсуждения.

## Управление
- **W/S** — газ/тормоз
- **A/D** — поворот
- **Space или ЛКМ** — выстрел (если есть оружие)

## Принципы разработки

- **Feel first** — ощущения от управления главный приоритет (подробнее в секции внизу).
- **Arcade feel, не симулятор.** Дрифт, ускорение, повороты — отзывчивые и приятные.
- **Планируется система типов машинок:** большие (медленные, высокий урон/HP), маленькие (быстрые, ловкие, меньше HP). Физические параметры карта — через `@export`, не хардкодить.

## Правила работы AI

### Godot и пользователь
- **ВАЖНО:** Нельзя запускать Godot из консоли (экспорт, проверка и т.д.) пока пользователь держит Godot открытым. Всегда спросить: "Godot закрыт?" перед запуском любой команды Godot.
- Если нужен ре-экспорт или перезагрузка проекта — попросить пользователя сделать это из GUI, либо закрыть Godot чтобы AI мог запустить из консоли.

### Тестирование
- **Одно изменение = один тест.** НЕ делать несколько изменений визуала/физики за раз.
- **Синтаксическая проверка GDScript — автоматическая** через хук (`.claude/settings.json`). Срабатывает после каждого Edit/Write `.gd` файла. Ручной запуск если нужен: `"C:\Godot_v4.6.1-stable_win64_console.exe" --headless --check-only --quit --path "C:\Users\dimti\do_chego_doshel_progress\smash-karts-clone" 2>&1`
- При изменении визуала/физики — чётко описать пользователю ЧТО должно измениться и КАК это проверить.
- Использовать MCP Godot сервер когда доступен.

### Изменения дизайн-документов (GDD)
- **GDD = апрувленная спецификация.** Всё что написано в `design/gdd/*.md` — уже принятые решения пользователя. Не предложения, не рекомендации — конкретный план реализации. При реализации НЕ переспрашивать то, что уже описано в GDD (формулы, архитектура, поведение, RPC-паттерны, сигналы). Просто реализовывать как написано.
- **Уточнять только** то, чего в GDD нет: конкретные имена файлов/нод если не указаны, порядок реализации нескольких независимых частей, инструментальные вопросы (MCP vs ручной редактор и т.п.).
- **ОБЯЗАТЕЛЬНО:** Перед любым **изменением** файлов в `design/gdd/` — провалидировать через `/design-review` или агента `systems-designer`. GDD нельзя менять без валидации.
- Убирание/добавление состояний, переходов, формул — это дизайн-решение с downstream эффектами. Сначала анализ влияния, потом правка.

### Качество кода
- **ОБЯЗАТЕЛЬНО:** Перед реализацией любой фичи, связанной с Godot (физика, анимации, сеть, UI) — проверить документацию через Context7.
- **Предпочитать нативные инструменты Godot:**
  - `Resource` вместо `Dictionary` для структурированных данных
  - `@export` вместо хардкода параметров
  - `AnimationPlayer` вместо ручного tween-кода
  - Сигналы вместо прямых вызовов между узлами
- Перед написанием кастомного решения — спросить: "есть ли встроенный способ в Godot?"

### Структура проекта
- НЕ создавать новые файлы без необходимости. Предпочитать редактирование существующих.
- Периодически чистить неиспользуемые файлы.
- При значительных изменениях архитектуры — обновлять этот файл.

### Общий принцип
**MVP first.** Не добавлять фичи пока база не работает стабильно.

## Game Studio Framework

Проект использует **Claude Code Game Studios** — трёхслойную систему разработки.
Это НЕ набор отдельных инструментов — это СИСТЕМА, где слои работают вместе.

### Роль AI-ассистента (Claude) в Game Studio

**Claude = Project Manager / координатор между пользователем (клиент) и командой (скиллы → агенты).**

Claude НЕ принимает технические, архитектурные или дизайнерские решения самостоятельно. Все решения принимают соответствующие специалисты. Claude:
- Координирует работу: запускает нужные скиллы (приоритет) или агентов (если нет скилла), передаёт контекст
- Представляет результаты пользователю: компактно, без собственных оценок поверх
- Спрашивает пользователя когда нужно решение, но НЕ подменяет экспертизу специалистов своим мнением
- Пишет код ПОСЛЕ того как архитектура/дизайн утверждены специалистами

**Порядок делегирования:**
1. Сначала ВСЕГДА проверить — есть ли подходящий скилл. Скилл сам вызовет нужных агентов
2. Если скилла нет — вызвать агента напрямую (директора для решений, специалистов для исполнения)
3. Claude НИКОГДА не подставляет своё мнение вместо экспертизы скиллов/агентов

**Конкретно — кто что делает:**
- Архитектурные решения → `technical-director` (opus) принимает, Claude передаёт пользователю
- Дизайн-решения → `game-designer` или `systems-designer` принимает
- Выбор между подходами → директор соответствующего домена оценивает и рекомендует
- Claude НЕ пишет "моя рекомендация" по техническим вопросам — он пишет "рекомендация technical-director'а"

**Конкретно — что Claude НЕ делает сам (ОБЯЗАТЕЛЬНО делегировать):**
- **Написание кода:** Перед написанием нового кода или значительного рефакторинга (>20 строк) — консультация с `godot-specialist` или `gameplay-programmer` по паттернам. Claude пишет код только по их рекомендациям.
- **Дебаг:** При любом баге — привлечь специалиста (`godot-specialist`, `gameplay-programmer`) для анализа root cause. Даже если баг кажется очевидным — специалист видит контекст который Claude пропускает (пример: `consume_weapon` до `_launch_visual` — порядок вызовов в signal chain).
- **Изменение GDD:** см. секцию "Изменения дизайн-документов" выше.
- **Фиксы по code review:** Применение фиксов по результатам review — валидация с `godot-specialist` что фикс не создаёт новых проблем.
- **Оценки и рекомендации:** Claude не оценивает технические решения — он собирает оценки от агентов и передаёт пользователю.

**Почему это важно:**
Claude склонен подменять специалистов когда задача кажется "простой". Именно в таких случаях появляются баги — потому что Claude не видит Godot-специфичный контекст (signal ordering, RPC call_local side effects, scene tree lifecycle). Правило простое: если сомневаешься вызывать ли агента — ВЫЗЫВАЙ.

### Три слоя

**Rules** (`.claude/rules/`) — автоматические, триггерятся по паттернам файлов при записи. Не думай о них.  
**Skills** — точка входа (`/skill-name`). Сами знают каких агентов вызвать. Вызывают другие скиллы внутри.  
**Agents** — эксперты. Вызываются скиллами или напрямую. Агенты вызывают других агентов при необходимости.

### Skills — основной интерфейс

**Текущая фаза (Implementation):** `/feature-dev` — основной для реализации по GDD. `/godot-mcp` — для работы через MCP с движком.  
**Все остальные skills** перечислены в system-reminder каждой сессии.

### Agents — когда вызывать напрямую

**ПРАВИЛО: СНАЧАЛА СКИЛЛЫ.** Перед вызовом агента напрямую — проверь список скиллов. Если есть подходящий скилл — используй его. Скилл сам подберёт агентов. Это не рекомендация, а обязательное требование.

Агенты вызываются напрямую (через Agent tool) ТОЛЬКО когда:
- Проверил список скиллов и нет подходящего
- Нужна точечная консультация ("как сделать X в Godot?")
- Нужен review конкретного решения

**Агенты и их уровни:** все 34 специалиста перечислены в system-reminder. Directors (opus) — для архитектурных решений. Consultants (sonnet) — для дизайн/code architecture. Specialists (sonnet/haiku) — для конкретного кода и тестирования.

**Агенты вызывают других агентов внутри себя** — не нужно собирать полную команду вручную.

### Принципы работы системы

1. **Skills first (ОБЯЗАТЕЛЬНО)** — ВСЕГДА проверь список скиллов перед вызовом агентов. Если есть подходящий skill — используй его, он сам подберёт агентов. Агенты напрямую — крайний случай.
2. **Agents parallel** — если вызываешь напрямую, запускай параллельно (одно сообщение).
3. **Rules automatic** — не думай о них, они работают при записи файлов.
4. **GDD before code** — ВСЕГДА читай design/gdd/[system].md ПЕРЕД реализацией.
5. **Incremental writes** — файлы пишутся секция за секцией, не целиком.
6. **Feel first** — при любом выборе приоритет ощущениям (см. секцию внизу).

## При старте новой сессии — что делать

1. **Прочитать этот CLAUDE.md** (загружается автоматически)
2. **Прочитать `design/gdd/systems-index.md`** — текущий прогресс, что designed/implemented
3. **Спросить пользователя** что делаем сегодня (design / implement / fix)
4. **Использовать агентов** для любой задачи (см. правила выше)
5. **НЕ начинать писать код** без чтения соответствующего GDD файла

## Design Documents

Все design documents живут в `design/gdd/`. **Прочитать GDD ПЕРЕД реализацией системы.**

### MVP Systems (10/10 designed):
| System | GDD | Implementation |
|--------|-----|---------------|
| State Machine | `state-machine.md` | **Implemented** (game_states.gd + state_manager.gd) |
| Network Layer | `network-layer.md` | **Implemented** (snapshot buffer, ping/pong, timeout, late join, disconnect broadcast) |
| Health & Damage | `health-damage.md` | **Implemented** (HealthComponent, DamageInfo, EventBus, AOE falloff) |
| Kart Physics | `kart-physics.md` | **v2.1 implemented; v2.2 GDD active, code pending** (branch: `arcade-physics`). Continuous `_drift_intensity` model, lateral ramp kick, lerp-based multipliers. v2.1 archived at `kart-physics-v2.1-archive.md`. |
| Camera System | `camera-system.md` | Implemented (not tested) |
| Spawn System | `spawn-system.md` | Implemented (not tested, spawn push deferred) |
| Projectile System | `projectile-system.md` | Partial (rockets only) |
| Pickup System | `pickup-system.md` | Partial (weapon only) |
| Weapon System | `weapon-system.md` | Partial (rockets only) |
| Match System | `match-system.md` | Not started |

### Other docs:
- `game-concept.md` — общий концепт игры, pillars, vision
- `systems-index.md` — индекс ВСЕХ 24 систем с зависимостями и приоритетами

**Implementation Order:** см. `design/gdd/systems-index.md`.

## Текущий статус проекта

**Phase**: Implementation (steps 1-6/10 done, steps 4-6 not tested)
**Что работает сейчас**: базовый мультиплеер (lobby → game → rockets → kill/respawn), State Machine (StateManager + GameStates autoloads)
**Что сломано**: explosion VFX (stub), drift feel
**Что нужно**: рефакторинг по GDD спецификациям (шаги 3-10), затем новые фичи
**Known issues**: `docs/known-issues.md` (ping display не работает)

## Memory Server

MCP tools: `mcp__memory__search_memory`, `add_memory`, `update_memory`, `delete_memory`, `list_memories`  
Namespaces: `patterns`, `decisions`, `bugs`, `project_state`, `conventions`, `agent_insights`, `context`  
**Правило:** искать контекст перед задачей → передавать найденное агентам в промпт → сохранять решения после.  
Детальные инструкции и тип памяти каждого агента — `.claude/rules/memory-workflow.md`.

## Принцип разработки: Feel First

**Ощущения от управления — главный приоритет.** При любом выборе между "проще" и "лучше ощущается" — выбирать feel. Это касается: физики, камеры, звука, VFX, UI отзывчивости. Записано в memory как feedback.
