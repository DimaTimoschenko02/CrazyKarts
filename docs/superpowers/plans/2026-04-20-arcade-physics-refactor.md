# Arcade Kart Physics v2 — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite kart control to match SmashKarts.io-style arcade feel — binary drift state with hysteresis, direct rotation (no bicycle model), drag-based inertia, objective debug visualization.

**Architecture:** Replace continuous `_drift_intent: float` with binary `_is_drifting: bool` flag + hysteresis. Drop bicycle model (pivot + `tan(steer_angle)`) for direct `rotate_y()` + velocity projection. Replace `move_toward` deceleration with quadratic drag + linear rolling resistance. Add 3D debug overlay for vector visualization before any physics changes.

**Tech Stack:** Godot 4.6, GDScript, CharacterBody3D, ImmediateMesh for debug draw.

**Branch:** `arcade-physics` (already created)

**Testing strategy:** This project has no unit test framework for GDScript physics. Testing is **manual live-play** after each phase via Godot editor. Phase 0 (debug viz) provides objective instrumentation for subjective feel feedback. Each phase commits only after user confirms "feel acceptable" or "bug fixed".

**Research sources:**
- NotebookLM deep research (conversation context from 2026-04-20)
- Existing GDD: `design/gdd/kart-physics.md`
- Memory: `decision_drift_continuous.md`, `feedback_feel_first.md`

**Reference parameters from research (NotebookLM):**
- `k_drag = 0.4` (quadratic), `k_rolling = 12.0` (linear)
- `velocity_damp = 7.0` (exp decay rate for CharacterBody3D)
- `drift_enter_threshold = 0.75`, `drift_exit_threshold = 0.35` (hysteresis)
- `drift_min_speed_ratio = 0.4` (40% of max_speed)
- `visual_drift_max_deg = 40.0` (up from 25)
- `stationary_steer_threshold = 2.0` m/s

---

## Chunk 1: GDD Update (Phase -1, before any code)

**Why first:** GDD is the approved spec. All code follows GDD. Changing physics architecture without updating GDD creates drift between doc and code — future sessions will read stale GDD and regress.

**Files:**
- Modify: `design/gdd/kart-physics.md`
- Modify: `design/gdd/systems-index.md` (status: "Implemented → Refactoring")

### Task 1.1: Validate GDD change with systems-designer

- [ ] **Step 1: Dispatch systems-designer agent**

Run `systems-designer` agent with context from this plan (architecture paragraph + reference parameters) and current `design/gdd/kart-physics.md`. Ask for:
1. Validation of new architecture (binary state, direct rotation, drag inertia)
2. Draft updated sections of GDD (Physics Model, Drift Model, Parameters)
3. Identify downstream impacts (does `camera-system.md` assume bicycle-model yaw? Does `spawn-system.md` rely on wheelbase?)

Expected output: GDD diff or updated sections ready for user review.

- [ ] **Step 2: User reviews systems-designer output**

User reads the proposed GDD changes and either approves or requests edits. No code changes yet.

- [ ] **Step 3: Apply GDD changes**

Edit `design/gdd/kart-physics.md` with systems-designer's approved sections.
Update `design/gdd/systems-index.md` row for Kart Physics: "Implemented → Refactoring (arcade-physics branch)".

- [ ] **Step 4: Commit**

```bash
git add design/gdd/kart-physics.md design/gdd/systems-index.md docs/superpowers/plans/2026-04-20-arcade-physics-refactor.md
git commit -m "Update kart physics GDD for arcade refactor (binary drift, direct rotation, drag inertia)"
```

---

## Chunk 2: Phase 0 — Debug Visualization

**Why first in code:** without objective instrumentation we're tuning blind. User cannot articulate "lateral vector hangs 2s after release" without seeing it.

**Files:**
- Create: `scripts/debug_vectors_3d.gd`
- Create: `scenes/debug_vectors.tscn` (simple `Node3D` + `MeshInstance3D`)
- Modify: `scripts/kart_controller.gd` (attach debug viz for local kart in `_ready`)
- Modify: `dev_params.json` (add `DEBUG_VECTORS: true/false` toggle)

### Task 2.1: Create DebugVectors3D node

- [ ] **Step 1: Consult godot-specialist for native method**

Dispatch `godot-specialist` with this prompt:
> "Task: draw 3D lines in-viewport following a CharacterBody3D each frame. Lines represent velocity vectors (green=velocity, blue=forward projection, red=lateral projection). Must work in editor and HTML5 export. Need native Godot 4.6 method: ImmediateMesh with ArrayMesh? Or MeshInstance3D with PRIMITIVE_LINES? Which is more performant and idiomatic for per-frame updates of 3-5 lines?"

Expected: recommendation on `ImmediateMesh` vs alternatives, short sample code.

- [ ] **Step 2: Create `scripts/debug_vectors_3d.gd`**

Node3D script that:
- Holds reference to target `CharacterBody3D`
- Updates lines each `_process(delta)`
- Lines: velocity (green, magnitude ×1), forward-projected (blue), lateral-projected (red, magnitude ×2 for visibility)
- Also renders 3 Label3D nodes with: `is_drifting`, `fwd_speed`, `grip` values
- Toggle visibility via `DevParams` "DEBUG_VECTORS" bool

Code structure:
```gdscript
extends Node3D
class_name DebugVectors3D

var target: CharacterBody3D
var _velocity_mesh: MeshInstance3D
var _forward_mesh: MeshInstance3D
var _lateral_mesh: MeshInstance3D
var _text_label: Label3D

func _ready() -> void:
    _setup_meshes()
    _setup_label()

func _process(_delta: float) -> void:
    if not target or not is_instance_valid(target):
        return
    global_position = target.global_position
    _update_vectors()
    _update_label()

# ... _setup_meshes uses ImmediateMesh with PRIMITIVE_LINES per godot-specialist rec
# ... _update_vectors re-draws each frame
# ... _update_label writes "drift=%s fwd=%.1f grip=%.1f lat=%.1f"
```

- [ ] **Step 3: Modify `kart_controller.gd::_ready()` to spawn debug viz for local kart**

Add after existing `if OS.has_feature("web")` block:
```gdscript
if OS.is_debug_build() and player_id == multiplayer.get_unique_id():
    var dbg = preload("res://scripts/debug_vectors_3d.gd").new()
    dbg.target = self
    dbg.name = "DebugVectors3D"
    get_tree().current_scene.add_child.call_deferred(dbg)
```

- [ ] **Step 4: Add `DEBUG_VECTORS` param to dev_params.json**

Insert at top of json:
```json
"DEBUG_VECTORS": true,
"_debug_vectors": "Показывать 3D-векторы velocity/forward/lateral над локальным картом (только debug builds)",
```

- [ ] **Step 5: Wire up toggle in DebugVectors3D._process**

Inside `_process`, read `DevParams.get_data().get("DEBUG_VECTORS", true)` — hide meshes if false.

- [ ] **Step 6: Godot syntax check**

The pre-commit hook auto-runs `--check-only`. If it fails, fix syntax.

- [ ] **Step 7: Manual test**

User runs game in Godot editor. Verification checklist:
- Vectors appear above local kart when moving
- Green vector (velocity) length matches visible motion
- Red (lateral) is short/zero when driving straight
- Red grows during turns
- Toggle DEBUG_VECTORS=false in dev_params.json → vectors hide in-game via hot-reload
- Remote karts do NOT show vectors (only local)

User reports: "vectors visible / not visible / jittery / positioned wrong".

- [ ] **Step 8: Commit**

```bash
git add scripts/debug_vectors_3d.gd dev_params.json scripts/kart_controller.gd
git commit -m "Add 3D debug vector overlay for kart velocity/forward/lateral visualization"
```

---

## Chunk 3: Phase 1 — Simplify (remove over-engineered mechanisms)

**Why before new logic:** the existing 3 steering mechanisms (bicycle model + lateral_force + rwd_oversteer) fight each other. Removing them first isolates each change. After this chunk the kart should still drive — just with simpler, more predictable feel (no drift, no oversteer).

**Removing:**
- Bicycle model entirely (shag 6 in `_physics_process`) → replaced by direct `rotate_y()`
- `drift_lateral_force` block (shag 8)
- `rwd_oversteer_factor` block (shag 10.5)
- `smoothstep` speed gate for drift intent
- "drift speed penalty" inside shag 4
- Continuous `_drift_intent: float` → replaced by `_is_drifting: bool` in next chunk (kept stub here)

**Keeping:**
- Input smoothing (shag 1) — steer/throttle slew rates
- Gravity (shag 2)
- Acceleration via `move_toward` (shag 4) — will be rewritten in Phase 3, not here
- Lateral damping via `exp(-grip * delta)` (shag 9)
- Visual drift angle (shag 11.5) — kept as-is
- Wheel roll animation
- Floor alignment
- Kart-to-kart collision
- VFX smoke

**Files:**
- Modify: `scripts/kart_controller.gd` (major edit in `_physics_process`)
- Modify: `scripts/kart_physics_resource.gd` (mark deprecated params)

### Task 3.1: Consult godot-specialist for direct rotation pattern

- [ ] **Step 1: Dispatch godot-specialist**

Prompt:
> "Replace bicycle-model yaw (pivot around front/rear axle + `tan(steer_angle)`) with direct rotation for a CharacterBody3D kart. Current: `rotate_y(yaw_rate * delta)` then position correction to simulate pivot. New: pure `rotate_y()` then project velocity onto new forward (preserve magnitude, redirect). Verify: (1) is `velocity = -basis.z * fwd_speed + basis.x * side_speed + Vector3(0,y,0)` correct after rotate_y? (2) any caveats with `move_and_slide` + `floor_snap_length` when rotating mid-frame? (3) should side_speed be recomputed after rotation or preserved as-is?"

Expected: confirmation of pattern + any caveats.

### Task 3.2: Refactor kart_controller._physics_process

- [ ] **Step 1: Read current `_physics_process` to confirm line ranges**

Read `scripts/kart_controller.gd:217-471`.

- [ ] **Step 2: Add stub `_is_drifting` variable**

Replace variable block at line 8-9:
```gdscript
# ── Drift (binary state + hysteresis, filled in Phase 2) ──
var _is_drifting: bool = false
var _visual_drift_angle: float = 0.0
var _cached_side_speed: float = 0.0
```

Remove `_drift_intent: float = 0.0` — no longer needed.

- [ ] **Step 3: Rewrite shag 5 (drift intent) as Phase 1 stub**

Replace shags 5 (drift intent) entirely with:
```gdscript
# ── 5. Drift state (Phase 1 stub: always false, Phase 2 will add hysteresis) ──
_is_drifting = false
```

This intentionally disables drift for Phase 1 validation — we want to confirm simplified driving works before re-adding drift complexity.

- [ ] **Step 4: Replace shag 6 (bicycle model) with direct rotation**

Remove lines 283-319 (entire bicycle model block including pivot correction).

Replace with:
```gdscript
# ── 6. Direct rotation (no bicycle model) ──
var speed_ratio: float = clamp(absf(fwd_speed) / physics.max_speed, 0.0, 1.0)
var steer_mult: float = lerp(physics.steer_low_speed_mult, physics.steer_high_speed_mult, speed_ratio)
var steer_sign: float = 1.0 if fwd_speed >= -0.5 else -1.0
var speed_scale: float = clamp(absf(fwd_speed) / maxf(physics.steer_speed_threshold, 0.01), 0.0, 1.0)

var yaw_rate: float = _steer_input * steer_sign * physics.steering_speed * steer_mult * speed_scale
rotate_y(yaw_rate * delta)

# Project velocity onto new basis (preserve magnitudes, redirect)
var fwd_dir_new: Vector3 = -global_transform.basis.z
var side_dir_new: Vector3 = global_transform.basis.x
# fwd_speed and side_speed values stay — vectors re-align to new orientation
```

- [ ] **Step 5: Remove shag 8 (drift_lateral_force)**

Delete lines 326-328:
```gdscript
# if absf(fwd_speed) > 0.5 and absf(_steer_input) > 0.05:
#     side_speed += signf(_steer_input) * absf(fwd_speed) * _drift_intent * physics.drift_lateral_force * delta
```

Also delete the comment block "── 8. Lateral force (always-on, intent-scaled) ──".

- [ ] **Step 6: Simplify shag 7 (grip) — static high grip for Phase 1**

Replace drift-intent-dependent grip calculation with fixed:
```gdscript
# ── 7. Grip — static high_grip_target in Phase 1 (Phase 2 re-adds binary switch) ──
_grip = physics.high_grip_target
```

- [ ] **Step 7: Remove shag 10.5 (RWD oversteer)**

Delete lines 340-343:
```gdscript
# if absf(fwd_speed) > 1.0 and absf(_steer_input) > 0.05 and physics.rwd_oversteer_factor > 0.0:
#     var steer_rad: float = deg_to_rad(_steer_input * physics.max_steer_angle)
#     var rwd_lateral: float = fwd_speed * sin(steer_rad) * physics.rwd_oversteer_factor
#     velocity += side_dir * rwd_lateral
```

Also remove "── 10.5. RWD oversteer nudge ──" comment block.

- [ ] **Step 8: Remove drift speed penalty from shag 4**

Delete lines 261-265 in shag 4:
```gdscript
# Drift speed penalty: explicit decel to drift max speed (not relying on slow lerp)
# if _drift_intent > 0.0 and fwd_speed > 0.0:
#     var drift_max_speed: float = physics.max_speed * lerp(1.0, physics.drift_speed_penalty, _drift_intent)
#     if fwd_speed > drift_max_speed:
#         fwd_speed = move_toward(fwd_speed, drift_max_speed, 15.0 * delta)
```

- [ ] **Step 9: Update fwd_dir/side_dir references after rotation**

After the new shag 6 (direct rotation), ensure shags 9-12 use the freshly-computed `fwd_dir_new` / `side_dir_new`. Rename to reuse existing `fwd_dir` / `side_dir` variables for minimal diff.

### Task 3.3: Deprecate old parameters

- [ ] **Step 1: Mark deprecated in `kart_physics_resource.gd`**

Add comments `# DEPRECATED v2: unused after arcade refactor` to:
- `wheelbase`
- `max_steer_angle`
- `rwd_oversteer_factor`
- `drift_lateral_force`
- `drift_counter_steer_mult`
- `drift_same_steer_mult`
- `drift_steer_boost`
- `drift_speed_penalty`
- `drift_full_speed`
- `drift_min_speed`
- `drift_steer_threshold`

Do NOT delete yet — leave values intact so existing `.tres` files don't break. Will be removed in Phase 2/3 cleanup step.

- [ ] **Step 2: Godot syntax check**

Pre-commit hook runs `--check-only`. Fix any errors.

### Task 3.4: Validate Phase 1 simplification

- [ ] **Step 1: Dispatch godot-specialist for code review**

Prompt:
> "Review refactored `_physics_process` in scripts/kart_controller.gd. Focus on: (1) velocity projection after `rotate_y` — is math correct? (2) any references to deleted mechanisms (drift_intent, bicycle pivot, etc) still remaining? (3) does this still integrate correctly with `move_and_slide`, `floor_snap`, kart-to-kart collision? Report issues only, no style nits."

- [ ] **Step 2: Apply any fixes from review**

If issues found, fix and re-run review. Limit to 3 iterations before surfacing to user.

- [ ] **Step 3: Manual test**

User runs game in editor. Verification checklist:
- Kart drives forward/backward normally (W/S)
- Kart turns while moving (A/D)
- Kart does NOT drift (flag stubbed to false)
- Kart does NOT oversteer or kick sideways
- Turning feels predictable, no "fighting" between mechanisms
- Debug vectors (from Phase 0): lateral red vector stays near zero during normal turns

Acceptable outcomes:
- "Feels bland but correct" → good, we removed drift intentionally
- "Feels broken in X specific way" → diagnose before continuing

Unacceptable outcomes:
- Kart spinning uncontrollably
- Kart won't turn at all
- Velocity exploding / going backwards unexpectedly

- [ ] **Step 4: Commit**

```bash
git add scripts/kart_controller.gd scripts/kart_physics_resource.gd
git commit -m "Simplify kart physics: remove bicycle model, lateral force, RWD oversteer, drift speed penalty"
```

---

## Chunk 4: Phase 2 — Binary Drift State with Hysteresis

**Why now:** Phase 1 established clean baseline. Now re-add drift as binary state, with snappy activation (mgnovennyy vkhod, exponentsial'nyy vykhod).

**Logic:**
- Track `_is_drifting: bool`
- Enter: `|steer| > enter_threshold` AND `|fwd_speed| > min_speed_ratio * max_speed` AND not already drifting
- Exit: `|steer| < exit_threshold` OR `|fwd_speed| < min_speed_ratio * max_speed`
- Hysteresis gap (enter > exit) prevents jitter
- `grip` switches target based on `_is_drifting` but moves smoothly via `move_toward`
- Add `drift_yaw_multiplier` for tighter turn arc during drift

**Files:**
- Modify: `scripts/kart_controller.gd` (replace stub from Phase 1)
- Modify: `scripts/kart_physics_resource.gd` (add new params, remove some deprecated)
- Modify: `resources/kart_physics.tres` (set new param values)
- Modify: `dev_params.json` (new hot-reload params)

### Task 4.1: Add parameters

- [ ] **Step 1: Add new params to `kart_physics_resource.gd`**

In `@export_group("Drift (Binary v2)")` group (replacing old "Drift (Continuous)" group):
```gdscript
@export_group("Drift (Binary v2)")
@export var drift_enter_threshold: float = 0.75      # |steer| above this enters drift
@export var drift_exit_threshold: float = 0.35       # |steer| below this exits drift
@export var drift_min_speed_ratio: float = 0.4       # min speed as fraction of max_speed
@export var drift_yaw_multiplier: float = 1.7        # yaw rate boost during drift (tighter arc)
@export var low_grip_target: float = 0.8             # KEEP — grip during drift
@export var high_grip_target: float = 16.0           # KEEP — grip when not drifting
@export var grip_loss_rate: float = 14.0             # KEEP — grip transition into drift
@export var grip_recovery_rate: float = 4.0          # KEEP — grip transition out of drift
@export var vfx_smoke_speed_threshold: float = 3.0   # KEEP
```

Remove (delete entirely, no longer deprecated-kept):
- `drift_steer_threshold`, `drift_steer_boost`, `drift_lateral_force`
- `drift_counter_steer_mult`, `drift_same_steer_mult`
- `drift_speed_penalty`, `drift_min_speed`, `drift_full_speed`
- `wheelbase`, `max_steer_angle`, `rwd_oversteer_factor` (from Phase 1)

Keep `steer_speed_threshold` (used for stationary check in Phase 4).

- [ ] **Step 2: Update `resources/kart_physics.tres` values**

Replace old drift parameters in the `.tres` file with new v2 values. Exact values from NotebookLM starting point — user will tune via dev_params.json.

- [ ] **Step 3: Update `dev_params.json`**

Replace "DRIFT (CONTINUOUS)" block with "DRIFT (BINARY V2)":
```json
"____": "=== DRIFT (BINARY V2) ===",
"HIGH_GRIP": 16,
"_high_grip": "Сцепление вне дрифта. exp(-grip*dt) формула. Выше = меньше заноса.",
"LOW_GRIP": 0.8,
"_low_grip": "Сцепление во время дрифта. Ниже = длиннее занос.",
"GRIP_LOSS_RATE": 14,
"_grip_loss": "Скорость потери сцепления при входе в дрифт (ед/сек).",
"GRIP_RECOVERY_RATE": 4,
"_grip_recovery": "Скорость восстановления при выходе из дрифта.",
"DRIFT_ENTER_THRESHOLD": 0.75,
"_drift_enter": "|steer| выше этого → вход в дрифт (бинарно, мгновенно).",
"DRIFT_EXIT_THRESHOLD": 0.35,
"_drift_exit": "|steer| ниже этого → выход из дрифта. Гистерезис: enter > exit.",
"DRIFT_MIN_SPEED_RATIO": 0.4,
"_drift_min_speed": "Мин скорость для дрифта как доля max_speed. 0.4 = 40%.",
"DRIFT_YAW_MULTIPLIER": 1.7,
"_drift_yaw": "Множитель yaw rate во время дрифта. >1.0 = тугая дуга (SmashKarts-стиль).",
"VFX_SMOKE_THRESHOLD": 2.5,
"_vfx_smoke": "Боковая скорость для включения дыма (м/с).",
```

Remove old DRIFT keys from the json.

- [ ] **Step 4: Update `kart_controller.gd::_on_dev_params_changed` mapping**

Remove mappings for deleted params. Add mappings:
```gdscript
physics.drift_enter_threshold = data.get("DRIFT_ENTER_THRESHOLD", physics.drift_enter_threshold)
physics.drift_exit_threshold  = data.get("DRIFT_EXIT_THRESHOLD",  physics.drift_exit_threshold)
physics.drift_min_speed_ratio = data.get("DRIFT_MIN_SPEED_RATIO", physics.drift_min_speed_ratio)
physics.drift_yaw_multiplier  = data.get("DRIFT_YAW_MULTIPLIER",  physics.drift_yaw_multiplier)
```

Keep existing mappings for HIGH_GRIP, LOW_GRIP, GRIP_LOSS_RATE, GRIP_RECOVERY_RATE, VFX_SMOKE_THRESHOLD.

### Task 4.2: Implement binary drift state logic

- [ ] **Step 1: Replace Phase 1 stub in `_physics_process`**

Replace:
```gdscript
# ── 5. Drift state (Phase 1 stub) ──
_is_drifting = false
```

With:
```gdscript
# ── 5. Drift state (binary + hysteresis) ──
var abs_steer: float = absf(_steer_input)
var min_drift_speed: float = physics.drift_min_speed_ratio * physics.max_speed
var speed_ok: bool = absf(fwd_speed) > min_drift_speed

if not _is_drifting:
    # Enter condition: high steer AND enough speed
    if speed_ok and abs_steer > physics.drift_enter_threshold:
        _is_drifting = true
else:
    # Exit condition: low steer OR speed drop
    if not speed_ok or abs_steer < physics.drift_exit_threshold:
        _is_drifting = false
```

- [ ] **Step 2: Update shag 6 (direct rotation) to use drift_yaw_multiplier**

Modify yaw_rate calculation:
```gdscript
var drift_boost: float = physics.drift_yaw_multiplier if _is_drifting else 1.0
var yaw_rate: float = _steer_input * steer_sign * physics.steering_speed * steer_mult * speed_scale * drift_boost
```

- [ ] **Step 3: Restore grip switching in shag 7**

Replace Phase 1 stub `_grip = physics.high_grip_target` with:
```gdscript
# ── 7. Grip switches target based on drift state, moves smoothly ──
var grip_target: float = physics.low_grip_target if _is_drifting else physics.high_grip_target
var grip_rate: float = physics.grip_loss_rate if _is_drifting else physics.grip_recovery_rate
_grip = move_toward(_grip, grip_target, grip_rate * delta)
```

- [ ] **Step 4: Godot syntax check via hook**

### Task 4.3: Validate Phase 2

- [ ] **Step 1: Manual test — drift activation**

User runs game. Checklist:
- Drive straight at full speed → debug overlay shows `is_drifting=false`, lateral red vector near zero
- Sharp turn (A/D held fully) at full speed → `is_drifting=true` in first frame (snappy!)
- Release A/D partially → stays drifting (hysteresis working)
- Release A/D fully → `is_drifting=false`, grip smoothly recovers
- Turn at low speed (< 40% max) → `is_drifting=false` regardless of steer
- Hysteresis test: wiggle steer around 0.5 → NO oscillation between states

- [ ] **Step 2: Manual test — drift feel**

User evaluates:
- "Does drift feel snappy (instant entry)?"
- "Does exit feel smooth (no jerk)?"
- "Is turn radius tighter during drift as expected?"
- "Does rear 'kick out' naturally from grip reduction?"

If any "no" → tune via dev_params.json (hot-reload):
- Too twitchy? → raise DRIFT_ENTER_THRESHOLD or lower DRIFT_EXIT_THRESHOLD for wider gap
- Not aggressive enough? → lower LOW_GRIP (e.g. 0.3)
- Rear doesn't kick out? → lower LOW_GRIP further, raise GRIP_LOSS_RATE
- Turn not tight enough? → raise DRIFT_YAW_MULTIPLIER to 2.0+

- [ ] **Step 3: Dispatch gameplay-programmer for code review**

Prompt:
> "Review binary drift state machine in scripts/kart_controller.gd shag 5 and shag 7. Focus on: (1) hysteresis logic — can both enter and exit conditions fire in same frame? (2) any race with input smoothing (_steer_input changes slower than _is_drifting flag)? (3) edge case: drift triggered then speed immediately drops below threshold — does it exit cleanly?"

- [ ] **Step 4: Apply fixes from review**

- [ ] **Step 5: Commit**

```bash
git add scripts/kart_controller.gd scripts/kart_physics_resource.gd resources/kart_physics.tres dev_params.json
git commit -m "Add binary drift state with hysteresis (enter 0.75, exit 0.35, speed gate 40%)"
```

---

## Chunk 5: Phase 3 — Drag-Based Inertia

**Why now:** drift feels good (or at least controllable). Now replace the `move_toward` constants for acceleration/deceleration with a physics-based force model that gives exponential-tail inertia (no "вкопанная" stop).

**Math:**
- `thrust = throttle * accel_force` (reverse scaled by `reverse_ratio`)
- `drag = -sign(v) * k_drag * v²` (quadratic, dominates at high speed)
- `rolling_resistance = -k_rolling * v` (linear, dominates at low speed)
- `brake = -brake_force` if braking input with forward motion
- `fwd_speed += (thrust + drag + rolling + brake) * delta`

**Terminal velocity** (equivalent to old `max_speed`): when thrust == drag + rolling:
`accel_force = k_drag * v_max² + k_rolling * v_max`
For `v_max = 20`, `k_drag = 0.4`, `k_rolling = 12.0`:
`accel_force = 0.4*400 + 12*20 = 160 + 240 = 400`

So `accel_force = 400` gives top speed 20 m/s naturally. **No hard cap needed** — drag is the limiter.

**Files:**
- Modify: `scripts/kart_controller.gd` (shag 4 entirely rewritten)
- Modify: `scripts/kart_physics_resource.gd` (add force params, remove speed params)
- Modify: `resources/kart_physics.tres` (new values)
- Modify: `dev_params.json` (new params)

### Task 5.1: Add parameters

- [ ] **Step 1: Update `kart_physics_resource.gd` Speed group**

Replace current `@export_group("Speed")` block with:
```gdscript
@export_group("Speed (v2: force-based)")
@export var accel_force: float = 400.0      # thrust force at full throttle (m/s²)
@export var reverse_ratio: float = 0.5       # reverse thrust as fraction of forward
@export var brake_force: float = 80.0        # decel when brake pressed opposite to motion
@export var k_drag: float = 0.4              # quadratic drag coefficient
@export var k_rolling: float = 12.0          # linear rolling resistance
@export var max_speed: float = 20.0          # reference only — used for drift_min_speed_ratio and UI
```

Remove: `reverse_max_speed`, `accel_sharpness`, `coast_decel`, `brake_decel`.

**Note on `max_speed`:** kept as reference value (equivalent to terminal velocity given accel_force/k_drag/k_rolling). Not used as a hard cap in physics anymore — used by `drift_min_speed_ratio` calculation and potentially HUD. Must be manually kept in sync with actual terminal velocity or made a read-only computed property.

- [ ] **Step 2: Update `resources/kart_physics.tres` values**

Set: `accel_force=400, reverse_ratio=0.5, brake_force=80, k_drag=0.4, k_rolling=12.0, max_speed=20.0`.

- [ ] **Step 3: Update `dev_params.json`**

Replace old SPEED block:
```json
"_": "=== SPEED (v2: force-based) ===",
"MAX_SPEED": 20,
"_max_speed": "Референс скорости (м/с). Реально = равновесие thrust/drag. Используется для drift_min_speed_ratio.",
"ACCEL_FORCE": 400,
"_accel_force": "Сила тяги при полном газе (м/с²). Terminal: v_max = when accel_force == k_drag*v² + k_rolling*v",
"REVERSE_RATIO": 0.5,
"_reverse_ratio": "Доля силы тяги при реверсе. 0.5 = задний ход вдвое слабее",
"BRAKE_FORCE": 80,
"_brake_force": "Сила торможения при нажатом S против движения (м/с²). Резче COAST_DECEL",
"K_DRAG": 0.4,
"_k_drag": "Коэф квадратичного сопротивления. Выше = сильнее тормозит на высокой скорости",
"K_ROLLING": 12,
"_k_rolling": "Коэф линейного сопротивления (качение). Выше = быстрее останавливается на низкой скорости",
```

Remove: `REVERSE_MAX_SPEED`, `ACCEL_SHARPNESS`, `COAST_DECEL`, `BRAKE_DECEL`.

- [ ] **Step 4: Update `kart_controller.gd::_on_dev_params_changed`**

Remove mappings for deleted keys. Add:
```gdscript
physics.accel_force   = data.get("ACCEL_FORCE",   physics.accel_force)
physics.reverse_ratio = data.get("REVERSE_RATIO", physics.reverse_ratio)
physics.brake_force   = data.get("BRAKE_FORCE",   physics.brake_force)
physics.k_drag        = data.get("K_DRAG",        physics.k_drag)
physics.k_rolling     = data.get("K_ROLLING",     physics.k_rolling)
```

Keep `MAX_SPEED` mapping (still used for drift ratio).

### Task 5.2: Rewrite shag 4 (acceleration)

- [ ] **Step 1: Replace shag 4 block**

Current lines 247-265 (approximately):
```gdscript
# ── 4. Acceleration (asymptotic) ──
var target_speed := 0.0
if _throttle > 0.0:
    target_speed = _throttle * physics.max_speed
elif _throttle < 0.0:
    target_speed = _throttle * physics.reverse_max_speed

if absf(_throttle) > 0.01:
    fwd_speed = lerp(fwd_speed, target_speed, physics.accel_sharpness * delta * 60.0)
elif Input.is_action_pressed("move_backward") and fwd_speed > 0.0:
    fwd_speed = move_toward(fwd_speed, 0.0, physics.brake_decel * delta)
else:
    fwd_speed = move_toward(fwd_speed, 0.0, physics.coast_decel * delta)
```

Replace with:
```gdscript
# ── 4. Force-based acceleration (v2) ──
var thrust: float = 0.0
if _throttle > 0.01:
    thrust = _throttle * physics.accel_force
elif _throttle < -0.01:
    thrust = _throttle * physics.accel_force * physics.reverse_ratio

# Quadratic drag: dominates at high speed
var drag: float = -signf(fwd_speed) * physics.k_drag * fwd_speed * fwd_speed

# Linear rolling resistance: dominates at low speed
var rolling: float = -physics.k_rolling * fwd_speed

# Brake: only when S pressed AND moving forward
var brake: float = 0.0
if Input.is_action_pressed("move_backward") and fwd_speed > 0.5:
    brake = -physics.brake_force

fwd_speed += (thrust + drag + rolling + brake) * delta

# Safety clamp near zero to avoid floating-point drift (optional, small window)
if absf(thrust) < 0.01 and absf(fwd_speed) < 0.1:
    fwd_speed = 0.0
```

- [ ] **Step 2: Godot syntax check via hook**

### Task 5.3: Validate Phase 3

- [ ] **Step 1: Manual test — inertia**

User runs game. Checklist:
- Hold W → accelerates smoothly, reaches terminal (~MAX_SPEED) and caps naturally via drag
- Release W at top speed → exponential decay, takes ~3-5 sec to near-stop
- Release W at low speed → stops faster (rolling resistance dominates)
- Hold S while moving forward → noticeably harder decel than coast (brake force)
- Hold S from stop → reverses slowly (reverse_ratio)

"Inertia" acceptance: car should NOT stop instantly when releasing W. Long coast phase = success.

- [ ] **Step 2: Manual test — interaction with drift**

- Drift at full speed → speed drops during drift? (should, because high lateral means energy dissipates through damping; drag is normal)
- Drift speed drop should be noticeable but NOT abrupt (no more drift_speed_penalty hack)

- [ ] **Step 3: Tune if needed via dev_params.json**

- Top speed too low/high? → adjust ACCEL_FORCE (raise for higher terminal)
- Decel too fast? → lower K_ROLLING
- Decel too slow at high speed? → raise K_DRAG
- Brake not strong enough? → raise BRAKE_FORCE

Record final values in kart_physics.tres once satisfied.

- [ ] **Step 4: Commit**

```bash
git add scripts/kart_controller.gd scripts/kart_physics_resource.gd resources/kart_physics.tres dev_params.json
git commit -m "Replace move_toward decel with force-based drag + rolling resistance (exponential inertia)"
```

---

## Chunk 6: Phase 4 — Stationary Steering

**Why now:** base physics + drift + inertia all working. Final gameplay fix — allow slow turning at near-zero speed (SmashKarts "game hack").

**Logic:** below `stationary_steer_threshold` (e.g. 2 m/s), skip the `speed_scale` attenuation — allow direct yaw regardless of speed, but at reduced rate.

**Files:**
- Modify: `scripts/kart_controller.gd` (shag 6 yaw rate calc)
- Modify: `scripts/kart_physics_resource.gd` (add params)
- Modify: `dev_params.json`

### Task 6.1: Add parameters

- [ ] **Step 1: Add to Steering group in `kart_physics_resource.gd`**

```gdscript
@export var stationary_steer_threshold: float = 2.0   # m/s — below this, use direct yaw
@export var stationary_steer_scale: float = 0.4       # yaw rate fraction at standstill
```

- [ ] **Step 2: Update `dev_params.json`**

Add to STEERING block:
```json
"STATIONARY_STEER_THRESHOLD": 2.0,
"_stationary_threshold": "Скорость (м/с) ниже которой руль работает на месте (игровой хак).",
"STATIONARY_STEER_SCALE": 0.4,
"_stationary_scale": "Доля yaw rate при полной остановке. 0.4 = 40% от нормального поворота.",
```

- [ ] **Step 3: Update `_on_dev_params_changed` mapping**

### Task 6.2: Update yaw rate calc

- [ ] **Step 1: Modify shag 6 speed_scale logic**

Replace:
```gdscript
var speed_scale: float = clamp(absf(fwd_speed) / maxf(physics.steer_speed_threshold, 0.01), 0.0, 1.0)
```

With:
```gdscript
var speed_scale: float
if absf(fwd_speed) < physics.stationary_steer_threshold:
    speed_scale = physics.stationary_steer_scale
else:
    speed_scale = clamp(absf(fwd_speed) / maxf(physics.steer_speed_threshold, 0.01), 0.0, 1.0)
```

- [ ] **Step 2: Godot syntax check**

### Task 6.3: Validate Phase 4

- [ ] **Step 1: Manual test**

- Stop kart completely → hold A or D → kart rotates in place at moderate rate
- Accelerate → poворот становится более отзывчивым (speed_scale ramps up)
- Full speed → обычный поворот (не изменилось)

- [ ] **Step 2: Commit**

```bash
git add scripts/kart_controller.gd scripts/kart_physics_resource.gd dev_params.json
git commit -m "Allow stationary steering below 2 m/s (SmashKarts-style game hack)"
```

---

## Chunk 7: Phase 5a — Visual Drift Angle Polish

**Why last:** pure visual, doesn't affect physics. Increase max visual lean angle from 25° to 40° for more exaggerated "rear kick" look.

**Files:**
- Modify: `scripts/kart_controller.gd` (shag 11.5 visual clamp)
- Modify: `scripts/kart_physics_resource.gd` (add param)
- Modify: `dev_params.json`

### Task 7.1: Parameterize visual angle

- [ ] **Step 1: Add param to `kart_physics_resource.gd` Visuals group**

```gdscript
@export var visual_drift_max_deg: float = 40.0    # max visual lean angle (deg). Arcade: 30-60
```

- [ ] **Step 2: Update shag 11.5**

Replace hardcoded `0.44` (≈25°) clamp with:
```gdscript
var max_vis_rad: float = deg_to_rad(physics.visual_drift_max_deg)
var drift_angle_target: float = clamp(
    atan2(vis_side, maxf(absf(vis_fwd), 0.1)) * -1.0,
    -max_vis_rad, max_vis_rad)
```

- [ ] **Step 3: Add to dev_params.json**

In VISUALS section (create if missing):
```json
"VISUAL_DRIFT_MAX_DEG": 40,
"_visual_drift_max": "Макс визуальный угол наклона корпуса в дрифте (градусы). 25=консервативно, 40=SmashKarts-стиль, 60=экстрим",
```

- [ ] **Step 4: Update `_on_dev_params_changed` mapping**

### Task 7.2: Validate

- [ ] **Step 1: Manual test**

- Drift at full speed → corpus наклонится заметно сильнее чем раньше
- Tune via dev_params.json if 40° too much or too little

- [ ] **Step 2: Commit**

```bash
git add scripts/kart_controller.gd scripts/kart_physics_resource.gd dev_params.json
git commit -m "Increase max visual drift angle from 25° to 40° (parameterized)"
```

---

## Chunk 8: Cleanup + Memory Update

**Why:** close out the refactor cleanly, update memory and index so future sessions don't regress.

### Task 8.1: Update project memory

- [ ] **Step 1: Update memory index**

Edit `~/.claude/projects/.../memory/MEMORY.md`:
- Mark `decision_drift_continuous.md` as superseded
- Add new memory: `decision_arcade_physics_v2.md`

- [ ] **Step 2: Write new decision memory**

File `~/.claude/projects/.../memory/decision_arcade_physics_v2.md`:
Record: binary drift state (not continuous intent), direct rotation (not bicycle model), drag-based inertia (not move_toward constants), reference values, and reasoning (SmashKarts-style research via NotebookLM).

- [ ] **Step 3: Update project_drift_remaining_issues.md**

Mark resolved issues (late activation, smoothness, speed instability, steering at standstill).
Add any new issues discovered during tuning.

### Task 8.2: Update GDD status

- [ ] **Step 1: Edit `design/gdd/systems-index.md`**

Change Kart Physics row: "Refactoring → Implemented (v2 arcade)".

### Task 8.3: PR to main (or merge decision)

- [ ] **Step 1: Decide merge strategy with user**

Options:
- Squash-merge `arcade-physics` → `main` (clean history)
- Merge commit (preserve phase history)
- Keep as experiment branch, don't merge yet

User chooses.

- [ ] **Step 2: Final commit + push (if merging)**

```bash
git add design/gdd/systems-index.md
git commit -m "Mark kart physics v2 complete"
git push -u origin arcade-physics
```

---

## Deferred (explicitly not in this plan)

- **Phase 5b: Nosedive tilt at braking/acceleration** — user wants explanation before deciding. Can be added later in this branch or post-merge as small polish phase.
- **Drift boost reward** (pressing drift long enough = speed boost on exit) — not in GDD, future feature.
- **Air control in jumps** — post-MVP (from memory `project_future_features.md`).
- **Landing impact / suspension / skid marks** — post-MVP.

---

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Network sync breaks (position via snapshot buffer) | Physics changes don't touch `_rpc_sync`. Verify after each phase that remote karts still interpolate correctly. |
| Existing `.tres` files break on param removal | Keep deprecated params stub (Phase 1) until Phase 2 cleanup. Test that scene loads without errors after each phase. |
| HTML5 build differs from editor build | Test in both editor and exported HTML5 after Phase 2 (drift logic is most likely to differ due to timing). |
| Feel regression between phases | Commit only after user confirms acceptance. Revert individual phase if needed (branch commits are isolated). |
| Godot debug draw performance hit | `DEBUG_VECTORS: false` toggle disables in one config change. Only enabled on local kart in debug builds. |

## Success Criteria

After all phases complete, user should report:
1. Drift activates **in the first frame** when conditions met (no 200-400ms lag)
2. Drift exit is smooth (no jerk)
3. Rear of kart visually "kicks out" noticeably (40° angle, low grip)
4. Coasting after release of W creates long exponential slowdown (no "вкопанная" stop)
5. Turning on the spot works smoothly
6. Debug vectors readable and correlate with felt motion

Final value ranges for all tunable params are recorded in `resources/kart_physics.tres` (committed).
