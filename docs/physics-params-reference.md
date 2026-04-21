# Kart Physics Parameters — Reference Snapshot

**Версия физики:** v2 arcade (binary drift + direct rotation + force-based inertia)
**Снимок значений:** 2026-04-21
**Источники** (upload в NotebookLM вместе с этим файлом для полного контекста):
- `design/gdd/kart-physics.md` — полная спека архитектуры и обоснование
- `dev_params.json` — текущие runtime-значения (hot-reload 0.5с)
- `scripts/kart_controller.gd` — имплементация
- `tools/param_tuner.html` — tuning UI с examples и deps

> **Важно**: все значения — snapshot на момент написания. В repo может быть свежее. Смотри `dev_params.json` для live-значений.

---

## Базовые формулы v2

```text
# Движение (per physics frame, dt)
thrust_accel     = throttle * ACCEL_FORCE          # forward direction
brake_accel      = -brake * BRAKE_FORCE * sign(fwd_speed)
reverse_accel    = -reverse * ACCEL_FORCE * REVERSE_RATIO
drag             = -K_DRAG * |v| * v               # quadratic, against velocity
rolling          = -K_ROLLING * v                  # linear, against velocity
velocity        += (thrust + brake + reverse + drag + rolling) * dt

# Эмерджентный top speed
terminal_speed   ≈ sqrt(ACCEL_FORCE / K_DRAG)

# Поворот (direct rotation, без bicycle model)
speed_scale      = clamp(|v| / STEER_SPEED_THRESHOLD, 0..1)
                   # при |v| < STATIONARY_STEER_THRESHOLD:
                   # speed_scale = STATIONARY_STEER_SCALE
steer_mult       = lerp(STEER_LOW_MULT, STEER_HIGH_MULT, |v| / MAX_SPEED)
drift_mult       = is_drifting ? DRIFT_YAW_MULTIPLIER : 1.0
yaw_rate         = STEERING_SPEED * speed_scale * steer_mult * drift_mult * steer_input
rotate_y(yaw_rate * dt)

# Проекция velocity на новый forward после поворота
v_forward        = v.dot(new_forward) * new_forward
v_lateral        = v - v_forward
# Gasим lateral через grip:
v_lateral       *= exp(-current_grip * dt)
velocity         = v_forward + v_lateral

# Binary drift state (с hysteresis)
if not drifting and |steer_input| > DRIFT_ENTER_THRESHOLD
   and fwd_speed > MAX_SPEED * DRIFT_MIN_SPEED_RATIO:
    drifting = true
    apply one-shot lateral kick: v += basis.x * sign(steer) * DRIFT_KICK_FORCE
if drifting and (|steer_input| < DRIFT_EXIT_THRESHOLD
                 or fwd_speed < MAX_SPEED * DRIFT_MIN_SPEED_RATIO * 0.8):
    drifting = false

# Grip интерполяция (smooth)
target_grip = drifting ? LOW_GRIP : HIGH_GRIP
current_grip = move_toward(current_grip, target_grip,
                           (drifting ? GRIP_LOSS_RATE : GRIP_RECOVERY_RATE) * dt)
```

---

## Скорость (v2 force-based)

| Параметр | Значение | Диапазон | Смысл |
|---|---|---|---|
| `MAX_SPEED` | 25 | 5–50 m/s | Референс макс скорости. **НЕ hard clamp** — реальная эмерджентная. Используется для `DRIFT_MIN_SPEED_RATIO` и эффектов камеры. |
| `ACCEL_FORCE` | 400 | 10–100 m/s² (**типичный аркад ~25**) | Сила тяги при полном газе. Terminal ≈ `sqrt(ACCEL_FORCE/K_DRAG)`. |
| `K_DRAG` | 1 | 0.01–0.2 (**типичный ~0.03**) | Квадратичное сопротивление. Основной ограничитель top speed. |
| `K_ROLLING` | 12 | 0.1–5 (**типичный 1–3**) | Линейное сопротивление. Гасит катящуюся машину без газа. |
| `BRAKE_FORCE` | 40 | 5–60 m/s² | Дополнительный stop при S. |
| `REVERSE_RATIO` | 0.5 | 0.2–0.8 | Доля ACCEL_FORCE при реверсе. |

**⚠️ Замечание по текущему снимку:** `ACCEL_FORCE=400` и `K_DRAG=1` — сильно выше типичных аркадных значений. Дают terminal ≈ 20 m/s но разгон моментальный (400 m/s² ≈ 40g). Для плавного разгона: `ACCEL_FORCE=20–30` + `K_DRAG=0.03–0.05`.

**Формулы для интуиции** (ACCEL=A, K_DRAG=D):
- terminal speed = √(A / D)
- время разгона до 80% terminal ≈ arctanh(0.8) / √(A · D) секунд
- при A=25, D=0.03: terminal ≈ 29 m/s, 0→23 m/s за ~1.3с

---

## Сглаживание ввода

| Параметр | Значение | Диапазон | Смысл |
|---|---|---|---|
| `STEER_SLEW_IN` | 3 | 1–20 /s | Скорость нарастания руля. Время до порога дрифта: `ENTER_THRESHOLD / SLEW_IN`. |
| `STEER_SLEW_OUT` | 2.5 | 1–15 /s | Скорость возврата руля в центр. Время выхода из дрифта: `(ENTER - EXIT) / SLEW_OUT`. |
| `THROTTLE_SLEW` | 1 | 1–20 /s | Скорость нарастания газа. 1/1=1с до полного — очень мягко. |

**Формула:** `input = move_toward(input, raw_key, SLEW * dt)`.

---

## Рулёжка (direct rotation)

| Параметр | Значение | Диапазон | Смысл |
|---|---|---|---|
| `STEERING_SPEED` | 2.8 | 0.5–5 rad/s | База. Итог = `STEERING_SPEED × steer_mult × speed_scale × drift_mult × steer_input`. |
| `STEER_LOW_MULT` | 1.4 | 0.5–3 | Множитель руля на v=0. Обычно >HIGH чтобы маневрировать медленно. |
| `STEER_HIGH_MULT` | 0.8 | 0.1–1.5 | Множитель на v=MAX_SPEED. <1.0 для широких дуг на скорости. |
| `STEER_SPEED_THRESHOLD` | 3 m/s | 0.5–10 | Скорость при которой speed_scale=1.0. |
| `STATIONARY_STEER_THRESHOLD` | 2 m/s | 0.5–5 | Ниже — используется STATIONARY_STEER_SCALE вместо speed_scale. |
| `STATIONARY_STEER_SCALE` | 0.4 | 0.1–1.0 | Доля yaw при стоянке. Аркадный хак для отзывчивости. |
| `WHEEL_RADIUS` | 0.18 | 0.05–0.5 m | Только визуал — скорость вращения колёс. |

---

## Дрифт (binary v2 + hysteresis)

| Параметр | Значение | Диапазон | Смысл |
|---|---|---|---|
| `HIGH_GRIP` | 11.5 | 5–30 | Grip вне дрифта. `side_speed *= exp(-grip × dt)`. |
| `LOW_GRIP` | 0.5 | 0.1–3 | Grip во время дрифта. Разница HIGH-LOW = глубина дрифта. |
| `GRIP_LOSS_RATE` | 4 /s | 1–30 | Скорость HIGH→LOW (при входе). Time = (HIGH-LOW)/rate. |
| `GRIP_RECOVERY_RATE` | 5 /s | 0.5–20 | Скорость LOW→HIGH (при выходе). **Для SmashKarts feel — 15–25** (быстрая стабилизация). |
| `DRIFT_ENTER_THRESHOLD` | 0.5 | 0.5–0.95 | `\|steer_input\|` для входа. **Инвариант: ENTER > EXIT**. |
| `DRIFT_EXIT_THRESHOLD` | 0.45 | 0.1–0.7 | `\|steer_input\|` для выхода. **Гистерезис: ENTER − EXIT = 0.05** ⚠️ очень маленький разрыв — дрифт будет моргать на микродвижениях руля. Рекомендовано ≥ 0.3. |
| `DRIFT_MIN_SPEED_RATIO` | 0.15 | 0.1–0.8 | Мин `fwd_speed` для дрифта = MAX_SPEED × ratio. При 25 × 0.15 = 3.75 m/s. |
| `DRIFT_YAW_MULTIPLIER` | 2.5 | 1.0–3.0 | Множитель yaw_rate в дрифте. **Основа feel'a**. SmashKarts ~1.5–1.7. |
| `DRIFT_KICK_FORCE` | 4 m/s | 0–15 | One-shot боковой импульс при ENTER. Щелчок зада. |
| `VFX_SMOKE_THRESHOLD` | 0.5 m/s | 0.5–10 | Порог `\|lateral_speed\|` для smoke VFX. |

---

## Визуал

| Параметр | Значение | Диапазон | Смысл |
|---|---|---|---|
| `VISUAL_DRIFT_MAX_DEG` | 40° | 10–60 | Макс наклон корпуса в дрифте. При выходе сбрасывается **мгновенно** (без интерполяции). |
| `DEBUG_VECTORS` | true | 0/1 | Оверлей с 3D-векторами velocity/forward/lateral + метрики. Desktop debug only. |

---

## Рельеф

| Параметр | Значение | Диапазон | Смысл |
|---|---|---|---|
| `GRAVITY` | 35 m/s² | 10–60 | 3.57× земной (аркадное приземление). |
| `FLOOR_ALIGN_SPEED` | 8 /s | 0–20 | Скорость slerp наклона карта по поверхности. |
| `SLOPE_INFLUENCE` | 8 m/s² | 0–20 | Бонус/штраф скорости на склонах. |

---

## Камера

| Параметр | Значение | Диапазон | Смысл |
|---|---|---|---|
| `CAMERA_DISTANCE` | 5 m | 3–20 | Дистанция от карта. |
| `CAMERA_HEIGHT` | 3.5 m | 1–10 | Высота над картом. |
| `CAMERA_LOOK_AHEAD` | 1.25 m | 0–5 | Смещение точки взгляда вперёд по курсу. |
| `FOV` | 70° | 50–110 | Базовый угол обзора. |
| `FOV_SPEED_BOOST` | 4° | 0–30 | Доп FOV на макс скорости. |
| `CAMERA_LATERAL_MAX` | 0.8 m | 0–4 | Макс боковое смещение в поворотах. |
| `CAMERA_LATERAL_SPEED` | 2 /s | 1–10 | Скорость lerp бокового смещения. |

---

## Бой

| Параметр | Значение | Диапазон | Смысл |
|---|---|---|---|
| `ROCKET_SPEED` | 40 m/s | 10–60 | ≈ 144 km/h. Быстрее MAX_SPEED → нельзя убежать. |
| `ROCKET_LIFETIME` | 6 s | 1–15 | Макс дальность = SPEED × LIFETIME = 240 m. |
| `EXPLOSION_RADIUS` | 3.5 m | 1–10 | AOE falloff от центра. |
| `DAMAGE` | 50 | 10–200 | HP=100 → 2 попадания = смерть. |

---

## Что менять для типичных feel-проблем

| Симптом | Что крутить |
|---|---|
| Разгон моментальный | ↓ `ACCEL_FORCE` (до 20–30), ↑ `K_ROLLING` (1–3), ↓ `THROTTLE_SLEW` (1–2) |
| Тормозит слишком резко | ↓ `BRAKE_FORCE` (15–25) |
| Не хочет катиться по инерции | ↓ `K_ROLLING` (0.5–1.5) |
| Дрифт моргает / не стабильный | ↑ разрыв ENTER/EXIT до 0.3+ (ENTER 0.75, EXIT 0.35) |
| После дрифта "плывёт" | ↑ `GRIP_RECOVERY_RATE` (15–25) |
| Дрифт слабый | ↑ `DRIFT_YAW_MULTIPLIER` (1.7+), ↑ `HIGH_GRIP` (18+), ↓ `LOW_GRIP` (0.3–0.8) |
| Не дрифтит на малой скорости | ↓ `DRIFT_MIN_SPEED_RATIO` (0.2) или ↑ `MAX_SPEED` |
| Руль не чувствуется на скорости | ↑ `STEER_HIGH_MULT` (0.9–1.0) |
| Спамит вход в дрифт | ↑ `DRIFT_ENTER_THRESHOLD` (0.8) |

---

## Как обновлять этот файл

Файл — snapshot. Обновлять вручную после значимых изменений значений. Автогенератор не сделан (можно добавить `tools/generate_params_doc.py` позже).

**Single-source для формул:** `design/gdd/kart-physics.md`
**Single-source для значений:** `dev_params.json`
**Single-source для UI-описаний:** `tools/param_tuner.html` (`PARAMS` + `FORMULAS`)
