---
description: Memory server usage workflow — when to search, save, and pass context to agents
globs: ["scripts/**", "design/gdd/**", "scenes/**"]
---

# Memory Workflow

## Основная сессия (Claude) — MCP tools

### Перед началом задачи — ИСКАТЬ
```
mcp__memory__search_memory(query="...", top_k=5)
```

Примеры запросов по типу задачи:
| Задача | Запрос |
|--------|--------|
| Физика / движение | `"kart physics drift patterns Godot"` |
| Сеть / RPC | `"multiplayer RPC sync architecture decisions"` |
| Баги | `"known bugs <система>"` |
| Новая фича | `"<система> patterns conventions decisions"` |
| Дебаг | `"<симптом> error root cause"` |

### После задачи — СОХРАНЯТЬ
```
mcp__memory__add_memory(text="...", namespace="...", metadata={project: "smash-karts-clone", source: "user"})
```

**Сохранять:**
- Архитектурные решения с обоснованием ("выбрали X вместо Y потому что...")
- Нетривиальные баги и root cause
- Паттерны специфичные для этого проекта
- Предупреждения для будущих сессий

**НЕ сохранять:** то что уже в GDD, очевидное из кода, временный статус

### Даты записей
Каждая запись содержит `metadata.created_at` (ISO timestamp). При обновлении через `update_memory` добавляется `metadata.updated_at`.

**При конфликтующих результатах** (несколько похожих записей по одной теме) — брать запись с более свежей датой: сначала `updated_at`, если нет — `created_at`.

### Write guard поведение
- `"added"` → запись добавлена ✓
- `"duplicate"` → идентичная запись уже есть, skip ✓
- `"similar_exists"` → похожая запись (score + текст показаны) → решить: `update_memory` если устарела, `force=true` если реально новая информация

---

## Агенты — НЕ видят MCP

Агенты (субагенты) не имеют доступа к MCP. Контекст передаётся **вручную через промпт**:

```
results = mcp__memory__search_memory(query="Godot RPC patterns")
Agent(prompt=f"Контекст из памяти:\n{results}\n\nЗадача: ...")
```

### Память агентов по тирам

**Tier 1 — Directors** (`technical-director`, `creative-director`, `producer`)
- Модель: `opus`
- Личный файл памяти: `~/.claude/agent-memory/smash-karts/{name}.md` (до 2000 слов)
- REST API: `curl "${MEMORY_URL}/api/search"` и `POST /api/memories`
- Namespaces: `decisions`, `project_state`
- Сохраняют: архитектурные решения, cross-system риски, стратегические trade-offs
- Ищут: широко по всей базе (top_k=10)

**Tier 2 — Consultants** (`game-designer`, `systems-designer`, `lead-programmer`, `godot-specialist`, `ux-designer`, `art-director`, `audio-director`, `economy-designer`, `narrative-director`, `qa-lead`)
- Модель: `sonnet`
- Личного файла нет — только REST API
- Namespaces: `patterns`, `conventions`
- Сохраняют: доменные паттерны, дизайн-решения, cross-system взаимодействия
- Бюджет: 1-2 поиска в начале, 1-3 записи в конце

**Tier 3 — Specialists** (все остальные: `gameplay-programmer`, `network-programmer`, `godot-gdscript-specialist`, `godot-shader-specialist`, `godot-gdextension-specialist`, `engine-programmer`, `ui-programmer`, `technical-artist`, `performance-analyst`, `sound-designer`, `qa-tester`, `level-designer`, `world-builder`, `writer`, `community-manager`, `live-ops-designer`, `analytics-engineer`, `localization-lead`, `prototyper`, `release-manager`, `ai-programmer`)
- Модель: `sonnet` / `haiku`
- Личного файла нет — только REST API
- Namespace: `bugs`
- Сохраняют: **только** новые баги и нетривиальные gotchas
- Бюджет: 1 поиск в начале, 0-1 запись в конце (большинство сессий = 0 записей)

### Конфиг URL для агентов
Агенты читают URL из: `.claude/agent-memory/config.json` → поле `memory_url`  
При деплое на VPS — обновить этот файл, всё остальное не меняется.

---

## Namespaces — что куда

| Namespace | Что хранить |
|-----------|-------------|
| `patterns` | Технические паттерны специфичные для этого проекта |
| `decisions` | Архитектурные/дизайнерские решения с обоснованием |
| `bugs` | Баги, root cause, workarounds |
| `project_state` | Текущий статус, прогресс, что в работе |
| `conventions` | Project-specific правила сверх CLAUDE.md |
| `agent_insights` | Ключевые выводы из прошлых сессий агентов |
| `context` | Временный контекст задачи / спринта |
