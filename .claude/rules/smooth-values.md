---
description: Все значения физики/визуала, которые могут меняться плавно — ДОЛЖНЫ меняться плавно. Никаких discrete jumps.
globs: ["scripts/**/*.gd"]
---

# Smooth Values Rule

**Принцип:** любое значение которое в реальности меняется непрерывно (скорость, угол наклона, grip, intensity, visual lean, rotation, FOV, шум VFX, громкость звука) — в коде тоже должно меняться непрерывно. Discrete jumps (skачки через `if/else`, `signf`, бинарные пороги) видны игроку как дёрганье, даже если скачок "маленький".

## Что считается нарушением

### 1. Discrete thresholds в числовых значениях
```gdscript
# ❌ ПЛОХО — скачок при переходе через 0.1
var lean_dir: float = signf(side_speed) if absf(side_speed) > 0.1 else 0.0

# ✅ ХОРОШО — smoothstep даёт C1-непрерывный переход
var lean_dir: float = smoothstep(0.05, 0.2, absf(side_speed)) * signf(side_speed)
```

### 2. Framerate-dependent lerp
```gdscript
# ❌ ПЛОХО — alpha зависит от fps, на 30fps вдвое быстрее
_value = lerp(_value, target, rate * delta)

# ✅ ХОРОШО — одинаковый feel на 30/60/120 fps
_value = lerp(_value, target, 1.0 - exp(-rate * delta))
```

### 3. Линейный `move_toward` где нужна экспоненциальная релаксация
```gdscript
# ❌ ПЛОХО — постоянная скорость возврата, нет "затухания у цели"
_angle = move_toward(_angle, target, rate * delta)

# ✅ ХОРОШО — естественное затухание, быстро в начале, плавно у цели
_angle = lerp(_angle, target, 1.0 - exp(-rate * delta))
```

**Исключение:** `move_toward` допустим для input slew если он создаёт ощутимую "тяжёлую педаль" (линейный ramp желаемый), но НЕ для visual smoothing.

### 4. Бинарные state flips влияющие на физику
```gdscript
# ❌ ПЛОХО — при пересечении 0.5 yaw_rate мгновенно меняет знак
var steer_sign: float = 1.0 if fwd_speed >= -0.5 else -1.0

# ✅ ХОРОШО — smoothstep по зоне
var steer_sign: float = lerp(-1.0, 1.0, smoothstep(-0.5, 0.5, fwd_speed))
```

**Исключение:** state machine flips для логики (`_is_drifting` для VFX триггера) — они должны быть дискретными, но с гистерезисом (±0.02 band). Эти flips влияют только на ON/OFF события (VFX/audio start), не на continuous physics values.

### 5. Snap-to-zero без деградации
```gdscript
# ❌ ПОДОЗРИТЕЛЬНО — snap на пороге 0.1 создаёт micro-jitter
if absf(fwd_speed) < 0.1:
    fwd_speed = 0.0

# ✅ ЛУЧШЕ — узкий порог + убедиться что decay уже привёл к ≈0
if absf(thrust) < 0.01 and absf(fwd_speed) < 0.02:
    fwd_speed = 0.0
```

## Паттерны которые ДОЛЖНЫ использоваться

| Ситуация | Правильный паттерн |
|---|---|
| Плавный возврат к цели | `lerp(current, target, 1.0 - exp(-rate * delta))` |
| Threshold gate на continuous значении | `smoothstep(lo, hi, x)` |
| Sign с мёртвой зоной | `smoothstep(-zone, zone, x) * 2.0 - 1.0` или `lerp(-1, 1, smoothstep(-zone, zone, x))` |
| Exponential decay (velocity, grip, scale) | `value *= exp(-rate * delta)` |
| Mix двух значений по intensity | `lerp(a, b, intensity)` — ОК если intensity сама плавная |
| Нелинейная форма | `pow(x, exp)` или `Curve.sample(x)` |

## Когда использовать `Curve` (Godot resource)

Заменяй `@export var X: float` на `@export var X_curve: Curve` когда:

- Тюнер хочет **форму** кривой, а не одно число (S-образная, bell, двухступенчатая)
- Линейный `lerp(low, high, t)` даёт "монотонный" feel — нет "зоны комфорта"
- Значение должно **по-разному** реагировать в разных диапазонах (slow at 0-30%, fast at 30-70%, slow again at 70-100%)

**Плюсы Curve:**
- Тюнер редактирует мышкой в Inspector, не трогая код
- Можно хранить разные Curve resources как "профили" (arcade / simulation / kids mode)
- Bezier касательные дают C1/C2 гладкость автоматически

**Минусы Curve:**
- Нельзя hot-reload через `dev_params.json` (только .tres — значит открытие Godot или ре-экспорт)
- Оверхед `curve.sample(x)` незначителен, но не нулевой

**Как использовать:**
```gdscript
@export var visual_lean_curve: Curve
# в физике:
var lean_shape: float = physics.visual_lean_curve.sample(_drift_intensity)
var target_angle: float = lean_shape * MAX_ANGLE * lean_dir
```

## Проверочный вопрос перед коммитом

Для любого изменения physics/visual значения спроси:
1. **Может ли эта переменная перепрыгнуть?** → если да, это micro-judder, чини
2. **Одинаковый feel на 30 и 60 fps?** → если нет, `1-exp(-rate*delta)` вместо `rate*delta`
3. **Имеет ли смысл линейная форма?** → если нет, `Curve` или `pow()`

## Известные исключения (дискретные — и это ОК)

- State machine flips (`_is_drifting` bool для VFX триггера) — нужны как on/off события
- Collision responses (instant push force on contact) — по природе дискретны
- Input button events (`is_action_just_pressed`) — по природе дискретны
- Snap-to-zero velocity в узкой окрестности (≤0.02 м/с) с подтверждённым отсутствием thrust
