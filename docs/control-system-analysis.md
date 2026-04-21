# Технический анализ системы управления картом v2.1

> **Цель документа**: детальный технический разбор для аудита в NotebookLM.
> Описывает реализацию на ветке `arcade-physics`, файл `scripts/kart_controller.gd`.
> Код и имена переменных — оригинальные (GDScript). Объяснения — на русском.
>
> **Версия реализации**: v2.1 (force-based inertia + binary drift + hysteresis + drift resistance)
> **Дата**: 2026-04-21

---

## Модель управления (v2.1)

Физика карта построена на модели **force-based inertia** с **direct rotation** и **бинарным дрифтом с гистерезисом**. Это сознательно упрощённая аркадная модель — без bicycle model, без wheelbase, без реалистичной шинной механики.

Движение по продольной оси (вперёд/назад) описывается ньютоновой динамикой: тяга `thrust` противостоит квадратичному аэродинамическому сопротивлению `drag` и линейному сопротивлению качения `rolling`. Равновесие этих сил даёт **emergent terminal velocity** — карт не упирается в жёсткий клэмп скорости, а органично выходит на плато. Поворот реализован через прямой `rotate_y()` — карт разворачивается вокруг своей оси, а вектор velocity перепроецируется на новую ориентацию.

Дрифт — это **логически бинарный state** (`_is_drifting: bool`) плюс **физически непрерывный float** `_grip`. Логика входа/выхода гистерезисная (порог входа выше порога выхода), что предотвращает дёрганье на границе. Физический эффект — степень гашения бокового скольжения — меняется плавно через `move_toward`. Версия v2.1 добавила `drift_drag_multiplier` и `drift_rolling_multiplier`: при активном дрифте сопротивление движению возрастает, имитируя scrubbing шин и снижая terminal velocity примерно до 74% от нормального.

---

## Как работает поступательное движение

### Тяга (thrust)

**Строки 265–268** `kart_controller.gd`:

```gdscript
var thrust: float = 0.0
if _throttle > 0.01:
    thrust = _throttle * physics.accel_force
elif _throttle < -0.01:
    thrust = _throttle * physics.accel_force * physics.reverse_ratio
```

`_throttle` — сглаженный входной сигнал (0..1 или -1..0), `accel_force` — скалярная сила в м/с². Реверс ослаблен через `reverse_ratio = 0.5`.

### Сопротивление (drag и rolling)

**Строки 272–279**:

```gdscript
var drag_mult:    float = physics.drift_drag_multiplier    if _is_drifting else 1.0
var rolling_mult: float = physics.drift_rolling_multiplier if _is_drifting else 1.0

var drag:    float = -signf(fwd_speed) * physics.k_drag * drag_mult * fwd_speed * fwd_speed
var rolling: float = -physics.k_rolling * rolling_mult * fwd_speed
```

- **Квадратичное `drag`**: пропорционально `v²`, доминирует на высоких скоростях. Аналог аэродинамического сопротивления.
- **Линейное `rolling`**: пропорционально `v`, доминирует на малых скоростях. Имитирует трение качения. Отвечает за то, что карт не "скользит вечно" после отпускания газа.
- В момент дрифта оба коэффициента умножаются — `drag_mult = 2.3`, `rolling_mult = 1.3` (текущие значения `dev_params.json`).

### Terminal velocity (формула)

Равновесие `thrust = drag + rolling` (при `rolling << drag` на высокой скорости):

```
v_terminal_normal ≈ sqrt(accel_force / k_drag)
                  = sqrt(28 / 0.03) ≈ 30.5 м/с

v_terminal_drift  ≈ sqrt(accel_force / (k_drag * drift_drag_multiplier))
                  = sqrt(28 / (0.03 * 2.3)) ≈ 20.1 м/с (~66% от нормального)
```

> Значения `dev_params.json` (`ACCEL_FORCE=28`, `K_DRAG=0.03`, `DRIFT_DRAG_MULTIPLIER=2.3`) дают terminal ~30.5 м/с в норме. Это выше `MAX_SPEED=27.5`, что означает: карт теоретически способен превысить референсную скорость при долгом разгоне. Referense `max_speed` используется только для расчётов FOV, drift_min_speed и нормализации сети — не как hard clamp.

### Интеграция сил

**Строка 286**:

```gdscript
fwd_speed += (thrust + drag + rolling + brake) * delta
```

Euler integration, frame-rate independent (везде умножается на `delta`).

### Brake и reverse

**Строки 282–285**:

```gdscript
var brake: float = 0.0
if Input.is_action_pressed("move_backward") and fwd_speed > 0.5:
    brake = -physics.brake_force
```

`brake_force = 40` м/с² применяется только когда кнопка S нажата и карт движется вперёд. При реверсе (fwd_speed <= 0.5) тормоз не добавляется — `thrust` сам отрицательный.

### Snap to zero

**Строки 289–291**:

```gdscript
if absf(thrust) < 0.01 and absf(fwd_speed) < 0.1:
    fwd_speed = 0.0
```

Предотвращает бесконечное затухание около нуля — вместо экспоненциальной асимптоты просто обнуляется.

---

## Как работает поворот

### Прямое вращение (direct rotation)

**Строки 312–328**:

```gdscript
var speed_ratio: float = clamp(absf(fwd_speed) / maxf(physics.max_speed, 0.01), 0.0, 1.0)
var steer_mult: float = lerp(physics.steer_low_speed_mult, physics.steer_high_speed_mult, speed_ratio)
var steer_sign: float = 1.0 if fwd_speed >= -0.5 else -1.0
...
var drift_mult: float = physics.drift_yaw_multiplier if _is_drifting else 1.0
var yaw_rate: float = _steer_input * steer_sign * physics.steering_speed * steer_mult * speed_scale * drift_mult
rotate_y(yaw_rate * delta)
```

Нет bicycle model, нет `tan(steer_angle)`, нет wheelbase. Карт просто поворачивается вокруг своей вертикальной оси.

### Speed-dependent steering

`steer_mult` линейно интерполируется между `STEER_LOW_MULT=1.4` (на v=0) и `STEER_HIGH_MULT=0.8` (на v=max_speed). Формула:

```
steer_mult = lerp(1.4, 0.8, speed_ratio)
```

Это значит, что **на малых скоростях карт поворачивает острее** (1.4x), на высоких — мягче (0.8x). Параметр `STEER_SPEED_THRESHOLD=3` задаёт скорость, при которой `speed_scale` достигает 1.0 в обычном режиме.

### Stationary steer hack (аркадный)

**Строки 321–324**:

```gdscript
var speed_scale: float
if absf(fwd_speed) < physics.stationary_steer_threshold:
    speed_scale = physics.stationary_steer_scale
else:
    speed_scale = clamp(absf(fwd_speed) / maxf(physics.steer_speed_threshold, 0.01), 0.0, 1.0)
```

При скорости ниже `STATIONARY_STEER_THRESHOLD=2` м/с используется фиксированный `speed_scale=0.4`, что даёт 40% от полного yaw rate. Это аркадный хак: карт визуально реагирует на A/D даже стоя, хотя реально не едет.

Важное следствие: при переходе порога ~2 м/с `speed_scale` скачкообразно переходит из `0.4` в `speed_ratio ≈ 0.07–0.1`, то есть **снижается** — карт в этот момент временно рулит хуже, чем стоя. Это небольшой артефакт архитектуры.

### Перепроекция velocity после поворота

**Строки 330–333**:

```gdscript
rotate_y(yaw_rate * delta)

# Recompute dirs after rotation (velocity projection onto new orientation).
fwd_dir  = -global_transform.basis.z
side_dir =  global_transform.basis.x
```

После `rotate_y` карт повернулся, но velocity ещё смотрит в старом направлении. На следующем шаге (шаг 8) `fwd_speed` и `side_speed` пересчитываются через `velocity.dot(fwd_dir)` / `velocity.dot(side_dir)` относительно **нового** направления basis. Это и есть механизм, через который поворот создаёт боковое скольжение: после резкого поворота часть `fwd_speed` "выплёскивается" в `side_speed`, и `_grip` начинает её гасить.

### Grip и гашение бокового скольжения

**Строки 336–342**:

```gdscript
var grip_target: float = physics.low_grip_target if _is_drifting else physics.high_grip_target
var grip_rate: float   = physics.grip_loss_rate  if _is_drifting else physics.grip_recovery_rate
_grip = move_toward(_grip, grip_target, grip_rate * delta)

# ── 8. Lateral damping (exponential via grip strength)
side_speed *= exp(-_grip * delta)
```

`side_speed *= exp(-_grip * delta)` — это экспоненциальное затухание. При `_grip = 18` за один тик 60 fps (dt=0.01667):

```
exp(-18 * 0.01667) = exp(-0.3) ≈ 0.741 → за один кадр гасится 26% бокового скольжения
```

При `_grip = 0.2` (дрифт):

```
exp(-0.2 * 0.01667) = exp(-0.003) ≈ 0.997 → за один кадр гасится лишь 0.3%
```

Это и есть разница между "цепкая резина" и "скользит как на льду".

---

## Как работает дрифт

### Порог входа/выхода с гистерезисом

**Строки 296–310**:

```gdscript
var abs_steer: float = absf(_steer_input)
var drift_min_speed: float = physics.drift_min_speed_ratio * physics.max_speed

if not _is_drifting:
    if fwd_speed > drift_min_speed and abs_steer > physics.drift_enter_threshold:
        _is_drifting = true
        side_speed += -_steer_input * physics.drift_kick_force
else:
    if abs_steer < physics.drift_exit_threshold or fwd_speed <= drift_min_speed:
        _is_drifting = false
```

- **DRIFT_ENTER_THRESHOLD = 0.75**: порог входа. Нужно зажать руль на 75%+ от максимума.
- **DRIFT_EXIT_THRESHOLD = 0.35**: порог выхода. Можно расслабить до 35% — дрифт продолжится.
- **Гистерезисный зазор = 0.40**: зона `[0.35, 0.75]` — "мёртвая зона" для переключений. Если уже дрифтишь и держишь руль на 0.5 — дрифт не выключится. Предотвращает осцилляцию при вибрации стика.

### DRIFT_MIN_SPEED_RATIO = 0.15

```
drift_min_speed = 0.15 * 27.5 = 4.125 м/с
```

Это довольно низкий порог (~15 км/ч). Дрифт доступен при почти любой значимой скорости.

> **Примечание**: В `kart_physics_resource.gd` default value = `0.4` (40%), в `dev_params.json` текущее значение = `0.15` (15%). Реальное поведение определяется `dev_params.json` через hot-reload.

### Что происходит в момент ENTRY (false → true)

#### 1. DRIFT_KICK_FORCE — мгновенный боковой импульс

**Строка 307**:

```gdscript
side_speed += -_steer_input * physics.drift_kick_force
```

`side_speed` — это локальная переменная, рассчитанная в начале шага через `velocity.dot(side_dir)` (**строка 261**). Она представляет проекцию вектора velocity на ось X карта (боковое направление). Изменение `side_speed` здесь — это прибавление к поперечной компоненте velocity в системе координат карта.

При `DRIFT_KICK_FORCE=10` и `_steer_input=0.75` (минимальный порог входа):
```
Δside_speed = -0.75 * 10 = -7.5 м/с
```

При `_steer_input=-1.0` (полный руль влево):
```
Δside_speed = -(-1.0) * 10 = +10 м/с
```

**Важно**: знак `-_steer_input` намеренный. При повороте влево (`_steer_input > 0` в Godot при `steer_left` axis) добавляется отрицательная боковая скорость (в локальных координатах карта — вправо, то есть зад выбрасывает вправо, нос уходит влево). Это и есть эффект "зад выносит".

Импульс применяется **ОДНОКРАТНО** в кадр перехода `false → true`. Это не постоянная сила, а мгновенный Dirac delta в дискретной физике. При 60 fps это 10/0.01667 ≈ 600 м/с² эквивалентного ускорения за один тик.

#### 2. Grip начинает падать (но не мгновенно)

**Строки 336–338**:

```gdscript
var grip_target: float = physics.low_grip_target if _is_drifting else physics.high_grip_target
var grip_rate: float   = physics.grip_loss_rate  if _is_drifting else physics.grip_recovery_rate
_grip = move_toward(_grip, grip_target, grip_rate * delta)
```

`grip_loss_rate = 25` (текущее в dev_params), цель `low_grip_target = 0.2`:

```
Время полного перехода: (18 - 0.2) / 25 = 0.712 сек
```

Grip падает **линейно** (через `move_toward`, не `lerp`). Каждый кадр отнимается `25 * 0.01667 ≈ 0.417` единиц. Заметное снижение уже за первые 3-4 кадра.

#### 3. drift_yaw_multiplier включается МГНОВЕННО

**Строки 326–327**:

```gdscript
var drift_mult: float = physics.drift_yaw_multiplier if _is_drifting else 1.0
var yaw_rate: float = _steer_input * steer_sign * physics.steering_speed * steer_mult * speed_scale * drift_mult
```

`DRIFT_YAW_MULTIPLIER=1.3` — в момент входа yaw rate умножается на 1.3 скачком. Нет рампы, нет lerp. В тот же самый кадр, когда `_is_drifting` стал `true`.

#### 4. drag_mult и rolling_mult включаются МГНОВЕННО

**Строки 272–273**:

```gdscript
var drag_mult:    float = physics.drift_drag_multiplier    if _is_drifting else 1.0
var rolling_mult: float = physics.drift_rolling_multiplier if _is_drifting else 1.0
```

Аналогично — ступенька в ту же секунду. Эффективное сопротивление движению увеличивается с `k_drag=0.03` до `k_drag*2.3=0.069` и `k_rolling=1.5` до `k_rolling*1.3=1.95` одним кадром.

### Что происходит в момент EXIT (true → false)

#### 1. Grip начинает восстанавливаться (плавно)

```
Время полного восстановления: (18 - 0.2) / 18.5 ≈ 0.962 сек
```

Но заметное воздействие начинается сразу: за первую секунду grip вырастает с 0.2 до ~18.2 (почти полностью). При `GRIP_RECOVERY_RATE=18.5` восстановление быстрое — около 1 секунды для полного возврата.

Ощущаемое скольжение после выхода: при `_grip ≈ 0.2` гашение `side_speed` за 1 кадр всего 0.3%, поэтому первые несколько кадров карт продолжает скользить ощутимо. Через ~200 мс при rate=18.5 grip уже ≈3.9 → за кадр гасится exp(-3.9*0.01667)=exp(-0.065)≈0.937 → 6.3% в кадр — уже заметно.

#### 2. drift_yaw_multiplier, drag_mult, rolling_mult возвращаются к 1.0 МГНОВЕННО

Та же тернарная логика — в кадр выхода `_is_drifting = false`, и все три множителя немедленно возвращаются к 1.0. Резкое снятие ограничений на скорость + снятие yaw boost происходит в одном кадре.

#### 3. Visual lean сбрасывается мгновенно

**Строки 363–365**:

```gdscript
else:
    # Instant snap to zero on drift exit — no lerp, intentional SmashKarts feel
    _visual_drift_angle = 0.0
```

Комментарий в коде называет это "intentional SmashKarts feel". Корпус резко выравнивается в кадр выхода из дрифта — это намеренное дизайн-решение, но визуально создаёт рывок.

---

## Почему вход/выход ощущаются резкими — главная секция

Разберём каждый источник рывка отдельно.

### 1. DRIFT_KICK_FORCE — мгновенный импульс

**Строка 307**: `side_speed += -_steer_input * physics.drift_kick_force`

Это **одноразовый импульс** в момент перехода. При текущем `DRIFT_KICK_FORCE=10` и минимальном триггере (`_steer_input=0.75`) добавляется 7.5 м/с бокового скольжения за **один кадр физики** (1/60 сек). Это не сила, применяемая со временем — это мгновенное изменение velocity.

**Физическая аналогия**: представь удар сзади в бок — машину резко бросило в сторону. Не постепенное скольжение шины под нагрузкой, а физический удар.

**Что делает этот импульс "ударом"**:
- Он применяется в единственный кадр, а не размазывается по нескольким
- Величина зависит от `_steer_input` в момент входа — при полном руле и высоком threshold kick ещё сильнее
- Нет ramp-up: при `KICK=10` и `steer=1.0` это 10 м/с бокового за один кадр

**Альтернативы (для NotebookLM)**: применять kick как непрерывную lateral force пока `|steer| > threshold`, убывающую со временем (ramp-out over 0.3–0.5s). Или вообще убрать kick (KICK=0) и полагаться только на velocity reprojection after rotate_y как источник бокового скольжения.

### 2. Рассогласование плавной и ступенчатой частей системы

**Это главная причина воспринимаемого рывка.**

В момент входа в дрифт одновременно происходит:

| Параметр | Поведение | Скорость |
|---|---|---|
| `_grip` | падает 18 → 0.2 | плавно, ~0.7 сек |
| `drift_yaw_multiplier` | 1.0 → 1.3 | **мгновенно** |
| `drag_mult` | 1.0 → 2.3 | **мгновенно** |
| `rolling_mult` | 1.0 → 1.3 | **мгновенно** |
| `DRIFT_KICK_FORCE` | +10 м/с бокового | **мгновенно** |

Только grip — плавный. Всё остальное — ступенчатое. Пользователь воспринимает систему как набор мгновенных изменений плюс один плавный хвост (постепенное нарастание скольжения пока grip не упал до LOW_GRIP).

Аналогично на выходе:

| Параметр | Поведение | Скорость |
|---|---|---|
| `_grip` | растёт 0.2 → 18 | плавно, ~1 сек |
| `drift_yaw_multiplier` | 1.3 → 1.0 | **мгновенно** |
| `drag_mult` | 2.3 → 1.0 | **мгновенно** |
| `rolling_mult` | 1.3 → 1.0 | **мгновенно** |
| `_visual_drift_angle` | снимается | **мгновенно** (intentional) |

Разница между "drag уже нормальный" и "grip ещё не восстановился" создаёт ощущение что карт выстрелил вперёд при выходе из дрифта (resistance пропала мгновенно, но slip ещё есть).

### 3. Бинарность state — нет continuous drift intensity

`_is_drifting` — это `bool`. В коде нет переменной вида `_drift_intensity: float` от 0 до 1. Все условия, зависящие от `_is_drifting` (строки 272–273, 326, 357, 364), переключаются между двумя дискретными значениями. Нет промежуточного состояния "кот почти дрифтует".

Практическое следствие: на пороге threshold система нестабильна. Если `_steer_input` колеблется около 0.75 (keyboard jitter при отпускании кнопки через slew), гистерезис предотвращает быстрое переключение, но каждый переход — это полный прыжок от одного набора параметров к другому.

### 4. Input slew — быстрый выход из дрифта при отпускании руля

**Строки 245–249**:

```gdscript
var steer_slew: float
if absf(raw_steer) > absf(_steer_input):
    steer_slew = physics.steer_slew_rate_in
else:
    steer_slew = physics.steer_slew_rate_out
_steer_input = move_toward(_steer_input, raw_steer, steer_slew * delta)
```

- `STEER_SLEW_IN=3` → время до порога входа 0.75 от нуля = `0.75 / 3 = 0.25 сек`
- `STEER_SLEW_OUT=2.5` → при отпускании (raw=0): `_steer_input` проходит путь 0.75→0.35 за `0.4 / 2.5 = 0.16 сек` — и выходит из дрифта

То есть дрифт может автоматически прекратиться через 0.16 сек после того как игрок отпустил руль. Это быстро — пользователь не успевает "выйти плавно", рука убрана → через мгновение система уже переключилась.

### 5. Отсутствие рампы при включении drift_yaw_multiplier

При входе в дрифт yaw rate мгновенно умножается на 1.3. При текущих параметрах на скорости 20 м/с и полном руле:

```
yaw_normal  = 1.0 * 2.0 * 0.7 * 1.0 * 1.0 = 1.4 рад/с → 80°/сек
yaw_drifting = 1.0 * 2.0 * 0.7 * 1.0 * 1.3 = 1.82 рад/с → 104°/сек
```

Скачок +24°/сек в момент переключения — карт мгновенно начинает резче поворачивать. Это добавляет к kick impulse ещё и кинематический рывок в angular velocity.

---

## Текущие значения тюнинга (dev_params.json)

### SPEED (v2: force-based)

| Параметр | Значение | Что делает |
|---|---|---|
| `MAX_SPEED` | 27.5 м/с | Референс, не hard clamp. Реальный terminal ≈ 30.5 м/с (выше референса) |
| `ACCEL_FORCE` | 28 м/с² | Тяга при полном газе. Низкое значение = тяжёлое ускорение |
| `K_DRAG` | 0.03 | Квадратичное сопротивление. Terminal = sqrt(28/0.03) ≈ 30.5 м/с |
| `K_ROLLING` | 1.5 | Линейное сопротивление. Очень низкое — карт долго катится после газа |
| `BRAKE_FORCE` | 40 м/с² | Экстренное торможение кнопкой S |
| `REVERSE_RATIO` | 0.5 | Задний ход вдвое слабее тяги |

### INPUT SMOOTHING

| Параметр | Значение | Что делает |
|---|---|---|
| `STEER_SLEW_IN` | 3 /сек | До полного руля (1.0) — 0.33 сек. До порога дрифта (0.75) — 0.25 сек |
| `STEER_SLEW_OUT` | 2.5 /сек | До нуля от полного — 0.4 сек. Сквозь гистерезисный зазор (0.75→0.35) — 0.16 сек |
| `THROTTLE_SLEW` | 2.5 /сек | До полного газа — 0.4 сек |

### STEERING

| Параметр | Значение | Что делает |
|---|---|---|
| `STEERING_SPEED` | 2 рад/с | Базовая скорость разворота |
| `STEER_LOW_MULT` | 1.4 | Множитель на малой скорости (острее) |
| `STEER_HIGH_MULT` | 0.8 | Множитель на высокой скорости (мягче) |
| `STEER_SPEED_THRESHOLD` | 3 м/с | Скорость для нормализации speed_scale |
| `STATIONARY_STEER_THRESHOLD` | 2 м/с | Ниже этого — используется stationary_steer_scale |
| `STATIONARY_STEER_SCALE` | 0.4 | 40% от full yaw rate на месте |

### DRIFT (BINARY V2 + v2.1 resistance)

| Параметр | Значение | Что делает |
|---|---|---|
| `HIGH_GRIP` | 18 | Сцепление вне дрифта. exp(-18*dt) ≈ 83% бокового гасится за 0.1 сек |
| `LOW_GRIP` | 0.2 | Сцепление во время дрифта. exp(-0.2*dt) ≈ 0.3% гасится за кадр |
| `GRIP_LOSS_RATE` | 25 /сек | 18→0.2 занимает 0.71 сек |
| `GRIP_RECOVERY_RATE` | 18.5 /сек | 0.2→18 занимает 0.96 сек |
| `DRIFT_ENTER_THRESHOLD` | 0.75 | Порог входа — нужно 75% руля |
| `DRIFT_EXIT_THRESHOLD` | 0.35 | Порог выхода — можно расслабить до 35% |
| `DRIFT_MIN_SPEED_RATIO` | 0.15 | Мин. скорость для дрифта = 0.15 * 27.5 = 4.1 м/с (очень низко) |
| `DRIFT_YAW_MULTIPLIER` | 1.3 | +30% к yaw rate в дрифте (ступенька при входе/выходе) |
| `DRIFT_KICK_FORCE` | 10 | Мгновенный боковой импульс при входе. При steer=1.0 → +10 м/с бокового |
| `VFX_SMOKE_THRESHOLD` | 0.5 м/с | Дым включается при любом заметном боковом скольжении |
| `DRIFT_DRAG_MULTIPLIER` | 2.3 | k_drag × 2.3 в дрифте. Terminal дрифта ≈ 20.1 м/с (66% нормального) |
| `DRIFT_ROLLING_MULTIPLIER` | 1.3 | k_rolling × 1.3 в дрифте. Дополнительный scrubbing |

### VISUALS

| Параметр | Значение | Что делает |
|---|---|---|
| `VISUAL_DRIFT_MAX_DEG` | 46° | Максимальный визуальный наклон корпуса в дрифте |

### TERRAIN

| Параметр | Значение | Что делает |
|---|---|---|
| `GRAVITY` | 35 м/с² | 3.57x земной — быстрое приземление, аркадный feel |
| `FLOOR_ALIGN_SPEED` | 8 | Скорость выравнивания по нормали пола (slerp) |
| `SLOPE_INFLUENCE` | 8 м/с² | ±8 м/с² уклона в горку/с горки |

---

## Вопросы для NotebookLM

### 1. Как сделать вход в дрифт плавным?

Текущая проблема: `DRIFT_KICK_FORCE` — мгновенный impulse, `drift_yaw_multiplier` / `drag_mult` / `rolling_mult` включаются скачком. Как перейти к плавному входу? Варианты:

- **Ramp kick**: вместо одноразового impulse применять `kick_force * delta` как непрерывную силу в течение 0.2–0.5 сек после входа, убывая
- **Ramp multipliers**: вводить `_drift_intensity: float` (0→1) и умножать все drift-dependent параметры на неё. `_drift_intensity` нарастает со скоростью ~3/сек при входе, падает при выходе
- **Убрать kick совсем**: полагаться только на velocity reprojection. При повороте и low grip side_speed накапливается органично без искусственного толчка

Какой из этих подходов ближе к поведению SmashKarts.io?

### 2. Как SmashKarts.io реализует плавный вход?

Наблюдение: в SmashKarts.io дрифт начинается мягко — занос нарастает постепенно в течение ~0.5–1 сек, а не как удар. Как именно это реализовано? Это:
- Continuous drift intensity float?
- Drift entry force применяется непрерывно пока steer > threshold?
- Или просто очень высокое `grip_loss_rate` без kick, и side_speed накапливается органично?

### 3. Стоит ли делать `drift_intensity: float` [0..1] вместо `bool`?

Если `_is_drifting` заменить на `_drift_intensity: float`:

```
При входе:  _drift_intensity += gain_rate * delta → цель 1.0
При выходе: _drift_intensity -= loss_rate * delta → цель 0.0
```

Тогда все drift-dependent параметры: `yaw_mult = lerp(1.0, DRIFT_YAW_MULTIPLIER, _drift_intensity)`, аналогично для `drag_mult`, `rolling_mult`. Kick можно выразить как force = `KICK_FORCE * rate * delta` пока `_drift_intensity` растёт.

Плюсы: все переходы плавные, нет ступенек. Минусы: сложнее, нет чёткого "в дрифте / не в дрифте" для логики VFX/audio/сети. Как решить?

### 4. Как синхронизировать плавность всех drift-зависимых величин?

Сейчас `_grip` — плавный float, а `yaw_mult`, `drag_mult`, `rolling_mult` — ступенчатые. Было бы идеально, чтобы все они менялись с одинаковой скоростью. Предложение: использовать `_grip` как единственный "мастер" и выражать всё через него:

```
drift_ratio = 1.0 - clamp((_grip - low_grip_target) / (high_grip_target - low_grip_target), 0.0, 1.0)
yaw_mult = lerp(1.0, DRIFT_YAW_MULTIPLIER, drift_ratio)
drag_mult = lerp(1.0, DRIFT_DRAG_MULTIPLIER, drift_ratio)
```

Тогда все параметры меняются синхронно — с одинаковой скоростью что и grip. Но: `drag_mult` влияет на фактическую скорость и начнёт меняться с задержкой относительно момента входа. Это хорошо или плохо для feel?

### 5. DRIFT_KICK_FORCE → 0 плюс continuous lateral force

Убрать kick (`DRIFT_KICK_FORCE=0`) и заменить на непрерывную lateral force, применяемую пока `_is_drifting AND |_steer_input| > threshold`:

```
var lateral_force = _steer_input * DRIFT_LATERAL_FORCE  # новый параметр
side_speed += -lateral_force * delta  # не * delta нет — это уже скорость изменения
```

Это создаст нарастающий занос вместо удара. Минус: пока карт дрифтует и держит стик — side_speed будет непрерывно расти, и нужен будет cap или decay. Как это правильно балансировать? Какое значение `DRIFT_LATERAL_FORCE` и как соотносится с grip damping?

---

*Документ создан для аудита в NotebookLM. Все строки кода ссылаются на `scripts/kart_controller.gd` на ветке `arcade-physics`.*
