# v3.2 Drift Shape Redesign — Brief for User Review

> **Status**: PROPOSAL (не GDD, не коммитить как спецификация). Принимается решение какой из 3 вариантов реализовывать. После выбора — обновляем `kart-physics.md` v3.2 секцией через `design-system` скилл.
> **Date**: 2026-04-30
> **Authored by**: Claude (orchestrator) + 3 параллельных агентов (feature-dev:code-explorer + game-designer + systems-designer)

---

## Why a redesign

Игрок (Dima) описал текущий дрифт как **"из прямой едем-едем потом резко круг"** — нет инерции, нет плавного перехода прямая → дуга. Вместо нужного "оваль / золотое сечение" получается ~постоянный круг.

## Root cause (один абзац)

`_engage_factor` в `drift_state_machine.gd` экспоненциально насыщается до 1.0 за ~1 секунду (rate=1/s). После насыщения **все** drift outputs становятся плоскими константами:
- `rear_grip_multiplier = 0.25`
- `yaw_bonus = 1.5 rad/s × direction`
- `forward_assist = 0` (текущее значение)

Результат: `omega ≈ const`, `fwd_speed ≈ const после plateau`, радиус `r = v/omega ≈ const` → круг. Нет временной модуляции, нет эволюции формы.

`_active_timer` в SM **уже трекается** (line 136), но используется только для exit-boost gate. Никогда не подмешивается в физические outputs.

---

## Three proposals (от systems-designer)

Каждый — точечная модификация одной строки в `drift_state_machine.gd`. Engage_factor остаётся "наружным" envelope для входа/выхода. Время-зависимые формы накладываются "внутри".

### A. **Thermal Fade** (рекомендация консенсуса)

Резина задних колёс "проскальзывает" сильно на входе, постепенно "сцепляется" обратно за TAU секунд.

**Формула** (line 174):
```
base_mult = lerp(1.0, DRIFT_REAR_GRIP_MULT, engage_factor) * (1.0 + GRIP_RELEASE_PEAK * exp(-_active_timer / GRIP_RELEASE_TAU))
```

**Что игрок видит/чувствует:**
- t=0: грип почти нулевой → большое скольжение → ШИРОКАЯ дуга, инерция держится
- t=TAU (≈0.8с): грип возвращается к стационару 0.25 → радиус сжимается до круга
- t > 3×TAU: байт-в-байт идентично текущему поведению

**Геометрия трейла:** "открывающаяся часть овала" — широкий вход, плавно стягивающийся к стационарной дуге.

**Новые параметры:**
- `DRIFT_GRIP_RELEASE_PEAK` ∈ [0.3..1.5], default **0.6** — насколько "распускаем" грип на входе
- `DRIFT_GRIP_RELEASE_TAU` ∈ [0.3..2.0с], default **0.8** — за сколько грип восстанавливается

**Pros:**
- ✅ Самая простая имплементация (одна строка)
- ✅ Zero regression: при больших `t` формула reduces к текущему коду
- ✅ Hot-reload через dev_params.json
- ✅ Игрок ФИЗИЧЕСКИ чувствует разницу (реальный slip angle меняется), не только визуально
- ✅ Соответствует "ощутимая тяжёлая машина" из Player Fantasy GDD

**Cons:**
- После TAU поведение становится постоянным → нет долгосрочной "эволюции" формы. Если игрок хочет полный спираль (как в image 4 пользователя) — Thermal Fade недостаточно.

---

### B. **Yaw Surge then Settle** (для драматичного входа)

Yaw bonus стартует с burst и затухает к cruise значению. Нос машины "втыкается" в поворот резко, потом стабилизируется.

**Формула** (line 177):
```
yaw_bonus = direction * engage_factor * (DRIFT_YAW_CRUISE + DRIFT_YAW_BURST * exp(-_active_timer / DRIFT_YAW_BURST_TAU))
```

**Что игрок видит:**
- t=0: omega растёт быстро → нос машины кидается в поворот
- t=0.5с: yaw burst затух → дуга расширяется (kart inertia "обгоняет" yaw)
- Геометрия: "запятая / fishhook" — резкий тык носом, плавная тяга наружу

**Новые параметры:**
- `DRIFT_YAW_CRUISE` ∈ [0.3..2.0 rad/s], default **0.8**
- `DRIFT_YAW_BURST` ∈ [0.5..3.0 rad/s], default **2.2**
- `DRIFT_YAW_BURST_TAU` ∈ [0.2..1.0с], default **0.5**

**Pros:**
- ✅ Драматичный визуальный эффект "yaw snap" — заметно в реплеях
- ✅ Простая замена константы на формулу с временем
- ✅ Сохраняет инерцию через расширение arcа во второй фазе

**Cons:**
- ⚠️ Может ощущаться как "кнопка дрифта" — резкое движение в момент активации может конфликтовать с always-on continuous моделью (memory `feedback_drift_always_on.md`)
- ⚠️ Требует замены текущей `DRIFT_YAW_BONUS` константы → migration value tuning

---

### C. **Phase Oval / Golden Ratio** (буквальное прочтение пользовательского ТЗ)

Нормализованная фаза `φ(t) = clamp(t/PERIOD, 0, 1)`. Sin/cos модулирует И grip И yaw синусоидально.

**Формулы:**
```
phi = clamp(_active_timer / DRIFT_PHASE_PERIOD, 0, 1)
base_mult = lerp(1.0, DRIFT_REAR_GRIP_MULT, engage) + DRIFT_PHASE_GRIP_DELTA * sin(phi * PI)
yaw_bonus = direction * engage * (DRIFT_YAW_BONUS + DRIFT_PHASE_YAW_DELTA * (1 - cos(phi*PI))/2)
```

**Что игрок видит:**
- t=0..PERIOD/2: радиус расширяется (грип ослабляется в пике sin)
- t=PERIOD/2..PERIOD: радиус сжимается (yaw разгоняется через ramp)
- При длинном дрифте — циклическая вариация, "оваль повторяется"

**Геометрия:** Полная "оваль/spiral как на image 4". При `PERIOD=1.2с` и дрифте 2с — половина оваля. Длиннее — циклы.

**Новые параметры:**
- `DRIFT_PHASE_PERIOD` ∈ [0.6..3.0с], default **1.2**
- `DRIFT_PHASE_GRIP_DELTA` ∈ [0.05..0.4], default **0.15**
- `DRIFT_PHASE_YAW_DELTA` ∈ [0.3..2.0], default **0.8**

**Pros:**
- ✅ Самое близкое к "оваль/golden ratio" буквально
- ✅ C1-гладкие переходы (sin/cos basis) — соответствует обновлённому smooth-values правилу
- ✅ Interesting гимплейный pattern: разные фазы дрифта имеют разный feel

**Cons:**
- ⚠️ 3 новых параметра, тонкий баланс между ними
- ⚠️ Циклическое повторение в long-drifts может ощущаться как **искусственный ритм** в хаотичной боёвке
- ⚠️ Самая высокая complexity для отладки

---

## Рекомендация для реализации

**Thermal Fade (A)** — для первой итерации.

**Reasoning:**
1. **Risk:** одна строка, formula degrades to current behavior at large t — невозможно сломать что-то не очевидное
2. **Match:** игрок просил "wide entry с инерцией", потом "переход в закрученный круг" — это ИМЕННО Thermal Fade в чистом виде
3. **Tunable:** PEAK и TAU обе hot-reloadable, тюнер быстро настраивает feel в browser
4. **Consensus:** оба агента (game-designer + systems-designer) рекомендуют этот подход первым

Если после playtest игрок скажет "хочу больше эволюции" → добавляем Yaw Surge (B) поверх (они независимы — grip-time-curve и yaw-time-curve не конфликтуют). При желании можно дойти до C через два инкремента.

---

## Что ещё надо учесть в v3.2 (помимо drift shape)

5 жалоб игрока из breakpoint-сообщения (которые сейчас не решены):

| # | Жалоба | План |
|---|---|---|
| 1 | Камера отстаёт от визуального угла на выходе из дрифта | Тащить `_drift_visual_yaw` напрямую, **НЕ через `BaseCar.global_rotation.y`** (там +180° от GLB-импорта). Метод `get_visual_yaw()` = `global_rotation.y + _drift_visual_yaw + _visual_drift_angle`. **Камера читает это**, perp в trails использует `Basis(UP, get_visual_yaw()).x` — yaw-only basis. |
| 2 | Сила задних колёс должна толкать вперёд | **Time-coupled forward_assist**: `assist(t) = FWD_ASSIST_PEAK * exp(-t/FWD_ASSIST_TAU) + FWD_ASSIST_CRUISE`. Высокий импульс на входе (preserves inertia), затухает к стационару. Параметры: PEAK=4-6, TAU=0.5с, CRUISE=0-1. |
| 3 | Полосы дрифта пропадают постепенно — теряю их из виду | `_fade_points` срабатывает **только когда `not active`**. Во время активного дрифта alpha держится на birth value. После выхода — обычный fade. |
| 4 | Полосы рисуются "из прошлого" (engage низкий → ранние точки видны спустя время) | Вернуться к жёсткому порогу `engage > 0.45` (как в SK оригинале) ИЛИ оставить v3.1.2 smoothstep onset, но проверить что birth_alpha при низком engage = 0 (не виден). По умолчанию выбираем жёсткий порог. |
| 5 | Полосы не от визуальных колёс | Wheel positions УЖЕ visual (они дети `BaseCar`). Fix только perp_world: `Basis(UP, get_visual_yaw()).x` без 180°-багов. |

---

## Test impact

- `test_rear_grip_multiplier_only_in_active`: сейчас проверяет `mult ≈ 0.35` после 2с. С Thermal Fade при `t=2с, TAU=0.8` множитель ≈ `0.35 * (1 + 0.6 * exp(-2.5)) = 0.35 * 1.05 ≈ 0.37`. **Тест надо подправить**: либо допуск ±0.05 → ±0.1, либо ждать `t > 5×TAU = 4с` где экспонента уже мертва.
- Все остальные drift-SM тесты (signs, hysteresis, debounce, boost) — **не затрагиваются**.
- Bicycle physics tests — **не трогаются** (Thermal Fade не лезет в bicycle).

---

## Ожидаемое решение от пользователя

1. ✅ A / B / C / Hybrid — какой выбираем?
2. ✅ Дополнительно: какой из 5 неудовлетворённых жалоб (#1-#5 выше) делать в первой итерации, какой откладывать?
3. ✅ Потом: даёт permission на push'у (заблокирован hook'ом сейчас) для коммита pre-redesign state.

После ответа — `design-system` скилл для GDD update v3.2 секции, потом `gameplay-programmer` агент для имплементации, `code-review` скилл для валидации.
