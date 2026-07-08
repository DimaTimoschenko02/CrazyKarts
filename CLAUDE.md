# SmashKarts Clone

Браузерная 3D мультиплеер-игра для компании друзей. Клон SmashKarts.io с расширенной статистикой.

## Стек (стабильное ядро)
- **Движок:** Godot 4.6, GDScript
- **Физика:** CharacterBody3D + move_and_slide() (arcade)
- **Мультиплеер:** WebSocketMultiplayerPeer (Godot HL Multiplayer API)
- **Master Server:** Node.js / Express (`server/`) — rooms, profiles, спавн Godot subprocess'ов
- **DB:** SQLite WAL (`server/data/smashkarts.db`)
- **Клиент:** HTML5 export → браузер
- **Web:** nginx → раздаёт HTML5 + reverse-proxy `/api/*` и `/ws/*` на master :8080
- **Локалка:** `build/serve.py` (8060)

## Инструменты разработки

- **Godot GUI:** `C:\Godot_v4.6.1-stable_win64.exe`
- **Godot Console (headless):** `C:\Godot_v4.6.1-stable_win64_console.exe`
- **Проект:** `C:\Users\dimti\do_chego_doshel_progress\smash-karts-clone\`
- **MCP:** tugcantopaloglu/godot-mcp через `.mcp.json` → скилл `/godot-mcp`
- **Hot-reload параметров:** `dev_params.json` (физика/камера, debug only)

## Точки входа (читай сначала)

| Зачем | Куда |
|-------|------|
| Архитектура (топология сервисов, sequence diagrams) | `docs/architecture.md` |
| Дизайн систем (специфика реализации) | `design/gdd/*.md` + `design/gdd/systems-index.md` |
| Dev workflow, команды запуска, порты | memory: `project_dev_workflow.md` |
| Что реализовано / отложено | memory: `project_*_done.md`, `project_*_deferred.md`, `project_known_issues.md` |
| Архитектурный overview, autoload'ы, ключевые файлы | memory: `project_architecture_overview.md` |
| UI палитра / тема | `scripts/ui/ui_palette.gd` + `resources/ui/theme_main.tres` (memory: `decision_ui_neon_stadium.md`) |
| Все memory записи | `MEMORY.md` (индекс) |

**Список keyfiles в этом CLAUDE.md не дублируется** — он быстро устаревает. Используй `MEMORY.md` индекс или `git ls-files`.

## Управление
- **W/S** — газ/тормоз
- **A/D** — поворот
- **Space или ЛКМ** — выстрел
- **ESC** — pause menu (Continue / Settings / Quit to Lobby)

## Принципы разработки

- **Feel first** — ощущения главный приоритет (физика, камера, звук, VFX, UI отзывчивость). Между "проще" и "лучше ощущается" — всегда feel.
- **Arcade feel, не симулятор.** Дрифт, ускорение, повороты — отзывчивые и приятные.
- **MVP first.** Не добавлять фичи пока база не работает стабильно.
- **GDD = апрувленная спецификация.** Не предложения — реализуй как написано, не переспрашивай уже описанное. Изменение GDD только через `/design-review` или `systems-designer`.
- **Параметры карта через `@export`**, не хардкод (типы машинок: большие/маленькие).

## Правила работы AI

### Memory актуализация (важно)

**CLAUDE.md холодный, memory тёплая.** В CLAUDE.md только стабильные правила. Текущий статус, файлы, команды, архитектурный snapshot живут в `memory/` и обновляются при каждом изменении.

Триггеры обновления memory:
- Реализован milestone → `project_*_done.md`
- Изменилась архитектура / autoload'ы → `project_architecture_overview.md`
- Изменился dev workflow → `project_dev_workflow.md`
- Принято архитектурное/дизайн решение → `decision_*.md`
- Найден нетривиальный баг → новая запись с root cause

Подробнее: memory `feedback_keep_memory_fresh.md`.

### Godot и пользователь
- **НЕ спрашивать "Godot закрыт?"** — просто запустить команду. Если упало с ошибкой блокировки (`.godot/imported/.lock`, "Project is being edited") — отчитаться, попросить закрыть.
- Перед запуском Godot — `tasklist | grep -i godot`. Свои фоновые headless'ы — kill через `taskkill //F //IM Godot_v4.6.1-stable_win64_console.exe` (двойной слэш в Git Bash). GUI Godot — попросить пользователя.

### Тестирование
- **Одно изменение = один тест.**
- **Синтаксис GDScript** проверяется автоматически хуком (`.claude/settings.json`) после каждого Edit/Write `.gd`. Ручной запуск: `"C:\Godot_v4.6.1-stable_win64_console.exe" --headless --check-only --quit --path .`
- **Самостоятельное end-to-end.** Если просят протестировать — идти до результата через MCP/Chrome без промежуточных вопросов. Спрашивать только на реальном блокере (см. memory `feedback_independent_testing.md`).
- При изменении визуала/физики — описать пользователю ЧТО изменилось и КАК проверить.

### Качество кода
- **Перед Godot фичей** (физика, анимации, сеть, UI) — Context7 для проверки API.
- **Нативные инструменты Godot предпочтительнее:** `Resource` > `Dictionary`, `@export` > хардкод, `AnimationPlayer` > ручной tween, сигналы > прямые вызовы. Перед кастомным решением — "есть встроенный способ?"
- НЕ создавать файлы без необходимости. Редактировать существующие.

## Game Studio Framework

Проект использует **Claude Code Game Studios** — трёхслойную систему: Rules (auto, `.claude/rules/`) + Skills (точка входа, `/skill-name`) + Agents (эксперты).

### Роль Claude (пересмотрено 2026-07-08, решение Димы)

**Claude принимает решения сам.** Архитектура, дизайн, trade-offs, приёмка — ответственность главной сессии, не агентов. Определения агентов (`.claude/agents/*.md`) читать как линзы/чеклисты («что бы спросил technical-director»), но вывод и выбор — свои.

**Субагенты = руки и исследователи, не решатели:**
- Исследование кода / больших данных → субагент возвращает выжимку (экономия контекста главной сессии)
- Расчёты, диагностика, прогоны на реальных данных → субагент
- Bulk-имплементация по жёсткой спеке главной сессии → субагент (sonnet норм)
- 2+ независимых задачи → параллельные субагенты в одном сообщении
- Консультация-перспектива в чужом домене (game feel, аудио, арт) → можно спросить агента, но решение своё

**Отчёт агента = claim, не факт.** Перед коммитом: читать дифф самому, гонять tsc/тесты самому. Агенты этой конфигурации склонны останавливаться на полуслове — пинать SendMessage'ем с чеклистом до полного завершения.

### Порядок работы

1. **GDD before code.** Читать `design/gdd/[system].md` ПЕРЕД реализацией.
2. Скиллы использовать когда подходят (`/design-review` для изменений GDD и т.п.).
3. Несколько независимых субагентов → параллельный вызов в одном сообщении.
4. Ревью диффов и коммит — всегда главная сессия.

Список skills и agents — в system-reminder каждой сессии.

## При старте новой сессии

1. CLAUDE.md (этот файл) — загружается автоматически
2. `MEMORY.md` индекс — загружается автоматически
3. Спросить пользователя что делаем (design / implement / fix)
4. Перед реализацией читать соответствующий GDD + relevant memory записи
5. Делегировать через скиллы / агентов

## Memory Server

MCP tools: `mcp__memory__search_memory`, `add_memory`, `update_memory`, `delete_memory`, `list_memories`
Namespaces: `patterns`, `decisions`, `bugs`, `project_state`, `conventions`, `agent_insights`, `context`
Workflow: `.claude/rules/memory-workflow.md` (искать перед задачей → передавать агентам в промпт → сохранять решения после).
