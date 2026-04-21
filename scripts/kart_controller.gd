extends CharacterBody3D

# ── Physics resource ──────────────────────────────────────────────────────────
@export var physics: KartPhysicsResource = KartPhysicsResource.new()

# ── Drift (v2.2 — Continuous Intensity model) ────────────────────────────────
# Implements GDD kart-physics.md v2.2: _drift_intensity [0..1] is the physics master.
# _is_drifting is a derived bool (intensity > drift_active_threshold) — VFX/audio/network only.
# All drift-dependent physics values use lerp(base, drift_value, _drift_intensity).
var _drift_intensity: float = 0.0    # primary physics master [0..1] — NEW in v2.2
var _grip: float = 18.0              # initialised in _ready from physics.high_grip_target
# _is_drifting: bool — computed property; stored as var for compatibility with _on_enter_dead
# and debug methods. Updated each frame from _drift_intensity.
var _is_drifting: bool = false
var _visual_drift_angle: float = 0.0
var _cached_side_speed: float = 0.0  # stored for VFX threshold check
var _base_car_rot_y: float = 0.0     # BaseCar initial rotation.y (0 after 180° fix)
var _wheel_roll_angle: float = 0.0   # accumulated roll for wheel spin animation
var _steer_visual_angle: float = 0.0 # smoothed visual steer angle (radians)

# ── Intensity hysteresis state (for hold-direction tracking) ──────────────────
# Needed to implement GDD §Hysteresis: when in dead zone [exit, enter], keep last target.
var _drift_target: float = 0.0    # last committed target (0.0 or 1.0)
var _drift_rate: float = 3.0      # rate corresponding to current target

# ── Network ──────────────────────────────────────────────────────────────────
const SYNC_INTERVAL := 0.033

# ── Player identity ─────────────────────────────────────────────────────────
var player_id: int = 0
var player_name: String = ""

# ── Snapshot buffer (remote karts only) ──────────────────────────────────────
var _snapshot_buffer = null  # SnapshotBufferClass instance for remote karts
var _sync_timer: float = 0.0

# ── VFX ──────────────────────────────────────────────────────────────────────
var _smoke_timer: float = 0.0
var _mark_timer:  float = 0.0

# ── Collision (disabled on death) ────────────────────────────────────────────
var _original_collision_layer: int = 0
var _original_collision_mask: int = 0

# ── Debug cache ──────────────────────────────────────────────────────────────
var _dbg_fwd_vel  : float = 0.0
var _dbg_lat_vel  : float = 0.0
var _dbg_vert_vel : float = 0.0
var _dbg_angular  : float = 0.0
var _dbg_on_floor : bool  = false

# ── Input (smoothed) ─────────────────────────────────────────────────────────
var _throttle:    float = 0.0
var _steer_input: float = 0.0
var _launcher_nodes: Array[Node3D] = []
const LAUNCHER_SCENE := preload("res://scenes/launcher.tscn")
const ROCKET_SCENE := preload("res://scenes/rocket.tscn")
const ROCKET_CONFIG := preload("res://resources/rocket_config.tres")
const SnapshotBufferClass := preload("res://scripts/snapshot_buffer.gd")
const ROCKET_SPREAD_DEG := 10.0

# ── Server-side tracking ─────────────────────────────────────────────────────
var _last_known_pos: Vector3 = Vector3.ZERO

@onready var name_label:      Label3D         = $NameLabel
@onready var _health:         HealthComponent = $HealthComponent
@onready var _launcher_left:  Marker3D   = $BaseCar/Socket_Left
@onready var _launcher_right: Marker3D   = $BaseCar/Socket_Right
@onready var _launcher_center:Marker3D   = $BaseCar/Socket_Center
@onready var l_drift:         Node3D   = $BaseCar/MainCar/Car2/LT/LeftDrift
@onready var r_drift:         Node3D   = $BaseCar/MainCar/Car2/RT/RightDrift
@onready var l_smoke: GPUParticles3D = $BaseCar/MainCar/Car2/LT/LeftDrift/GPUParticles3D
@onready var r_smoke: GPUParticles3D = $BaseCar/MainCar/Car2/RT/RightDrift/GPUParticles3D
# Blender names: T=tire(front in Blender +Z), B=back. Godot -Z=forward, so:
# LB/RB at Car2 Z=-0.991 = world forward = FRONT wheels
# LT/RT at Car2 Z=+0.991 = world backward = REAR wheels
@onready var _wheel_fl: MeshInstance3D = $BaseCar/MainCar/Car2/LB   # front-left
@onready var _wheel_fr: MeshInstance3D = $BaseCar/MainCar/Car2/RB   # front-right
@onready var _wheel_rl: MeshInstance3D = $BaseCar/MainCar/Car2/LT   # rear-left
@onready var _wheel_rr: MeshInstance3D = $BaseCar/MainCar/Car2/RT   # rear-right


func _ready() -> void:
	if player_id == 0 and name.is_valid_int():
		player_id = name.to_int()
	print("[Kart] _ready: player_id=", player_id, " name=", player_name, " my_id=", multiplayer.get_unique_id())
	_last_known_pos = global_position
	if physics:
		_grip = physics.high_grip_target
		floor_snap_length = physics.floor_snap_length
	floor_stop_on_slope = false
	floor_max_angle = deg_to_rad(50.0)
	_original_collision_layer = collision_layer
	_original_collision_mask = collision_mask
	var is_local := (player_id == multiplayer.get_unique_id())
	name_label.text = player_name

	# Remote karts: create snapshot buffer for interpolation
	if not is_local:
		_snapshot_buffer = SnapshotBufferClass.new()

	if OS.has_feature("web"):
		var dbg_label := Label.new()
		dbg_label.text = "pid=%d my_id=%d name=%s is_local=%s" % [player_id, multiplayer.get_unique_id(), name, is_local]
		dbg_label.position = Vector2(10, 40 + player_id * 25)
		dbg_label.add_theme_font_size_override("font_size", 18)
		dbg_label.add_theme_color_override("font_color", Color.YELLOW)
		get_tree().root.add_child.call_deferred(dbg_label)
	add_to_group("karts")
	if l_smoke:
		l_smoke.emitting = false
	if r_smoke:
		r_smoke.emitting = false

	if $BaseCar:
		_base_car_rot_y = $BaseCar.rotation.y

	_health.setup(player_id)
	_health.died.connect(_on_health_died)

	StateManager.kart_state_changed.connect(_on_kart_state_changed)
	StateManager.weapon_state_changed.connect(_on_weapon_state_changed)

	if OS.is_debug_build() and not OS.has_feature("web"):
		DevParams.params_changed.connect(_on_dev_params_changed)
		if not DevParams.get_data().is_empty():
			_on_dev_params_changed(DevParams.get_data())

	# Debug vector overlay (local kart only, debug builds only)
	if OS.is_debug_build() and is_local:
		var dbg := preload("res://scripts/debug_vectors_3d.gd").new()
		dbg.target = self
		dbg.name = "DebugVectors3D"
		get_tree().current_scene.add_child.call_deferred(dbg)
		var dbg_input := preload("res://scripts/debug_input_overlay.gd").new()
		dbg_input.target = self
		dbg_input.name = "DebugInputOverlay"
		get_tree().current_scene.add_child.call_deferred(dbg_input)
		var dbg_trails := preload("res://scripts/debug_wheel_trails.gd").new()
		dbg_trails.target = self
		dbg_trails.name = "DebugWheelTrails"
		get_tree().current_scene.add_child.call_deferred(dbg_trails)


func _exit_tree() -> void:
	if _health and _health.died.is_connected(_on_health_died):
		_health.died.disconnect(_on_health_died)
	if StateManager.kart_state_changed.is_connected(_on_kart_state_changed):
		StateManager.kart_state_changed.disconnect(_on_kart_state_changed)
	if StateManager.weapon_state_changed.is_connected(_on_weapon_state_changed):
		StateManager.weapon_state_changed.disconnect(_on_weapon_state_changed)


func _on_dev_params_changed(data: Dictionary) -> void:
	if not physics:
		return
	# Speed (v2: force-based)
	physics.max_speed             = data.get("MAX_SPEED",              physics.max_speed)
	physics.accel_force           = data.get("ACCEL_FORCE",            physics.accel_force)
	physics.k_drag                = data.get("K_DRAG",                 physics.k_drag)
	physics.k_rolling             = data.get("K_ROLLING",              physics.k_rolling)
	physics.brake_force           = data.get("BRAKE_FORCE",            physics.brake_force)
	physics.reverse_ratio         = data.get("REVERSE_RATIO",          physics.reverse_ratio)
	# Input smoothing
	physics.steer_slew_rate_in    = data.get("STEER_SLEW_IN",          physics.steer_slew_rate_in)
	physics.steer_slew_rate_out   = data.get("STEER_SLEW_OUT",         physics.steer_slew_rate_out)
	physics.throttle_slew_rate    = data.get("THROTTLE_SLEW",          physics.throttle_slew_rate)
	# Steering
	physics.steering_speed        = data.get("STEERING_SPEED",         physics.steering_speed)
	physics.steer_low_speed_mult  = data.get("STEER_LOW_MULT",         physics.steer_low_speed_mult)
	physics.steer_high_speed_mult = data.get("STEER_HIGH_MULT",        physics.steer_high_speed_mult)
	physics.steer_speed_threshold = data.get("STEER_SPEED_THRESHOLD",  physics.steer_speed_threshold)
	physics.stationary_steer_threshold = data.get("STATIONARY_STEER_THRESHOLD", physics.stationary_steer_threshold)
	physics.stationary_steer_scale     = data.get("STATIONARY_STEER_SCALE",     physics.stationary_steer_scale)
	physics.wheel_radius          = data.get("WHEEL_RADIUS",           physics.wheel_radius)
	# Drift (v2.2: continuous intensity)
	physics.high_grip_target           = data.get("HIGH_GRIP",                    physics.high_grip_target)
	physics.low_grip_target            = data.get("LOW_GRIP",                     physics.low_grip_target)
	physics.grip_loss_rate             = data.get("GRIP_LOSS_RATE",               physics.grip_loss_rate)
	physics.grip_recovery_rate         = data.get("GRIP_RECOVERY_RATE",           physics.grip_recovery_rate)
	physics.drift_enter_threshold      = data.get("DRIFT_ENTER_THRESHOLD",        physics.drift_enter_threshold)
	physics.drift_exit_threshold       = data.get("DRIFT_EXIT_THRESHOLD",         physics.drift_exit_threshold)
	physics.drift_min_speed_ratio      = data.get("DRIFT_MIN_SPEED_RATIO",        physics.drift_min_speed_ratio)
	physics.drift_yaw_multiplier       = data.get("DRIFT_YAW_MULTIPLIER",         physics.drift_yaw_multiplier)
	physics.drift_intensity_enter_rate = data.get("DRIFT_INTENSITY_ENTER_RATE",   physics.drift_intensity_enter_rate)
	physics.drift_intensity_exit_rate  = data.get("DRIFT_INTENSITY_EXIT_RATE",    physics.drift_intensity_exit_rate)
	physics.drift_lateral_ramp         = data.get("DRIFT_LATERAL_RAMP",           physics.drift_lateral_ramp)
	physics.drift_active_threshold     = data.get("DRIFT_ACTIVE_THRESHOLD",       physics.drift_active_threshold)
	physics.vfx_smoke_speed_threshold  = data.get("VFX_SMOKE_THRESHOLD",          physics.vfx_smoke_speed_threshold)
	# Drift resistance (v2.1 — lerp endpoints at intensity=1.0)
	physics.drift_drag_multiplier      = data.get("DRIFT_DRAG_MULTIPLIER",        physics.drift_drag_multiplier)
	physics.drift_rolling_multiplier   = data.get("DRIFT_ROLLING_MULTIPLIER",     physics.drift_rolling_multiplier)
	# Visuals
	physics.visual_drift_max_deg       = data.get("VISUAL_DRIFT_MAX_DEG",         physics.visual_drift_max_deg)
	physics.visual_lean_recovery_speed = data.get("VISUAL_LEAN_RECOVERY_SPEED",   physics.visual_lean_recovery_speed)
	# Terrain
	physics.gravity                    = data.get("GRAVITY",                      physics.gravity)
	physics.floor_align_speed          = data.get("FLOOR_ALIGN_SPEED",            physics.floor_align_speed)
	physics.slope_speed_influence      = data.get("SLOPE_INFLUENCE",              physics.slope_speed_influence)


# ── State change handlers ────────────────────────────────────────────────────

func _on_kart_state_changed(peer_id: int, _from: GameStates.KartState, to: GameStates.KartState) -> void:
	if peer_id != player_id:
		return
	match to:
		GameStates.KartState.DEAD:
			_on_enter_dead()
		GameStates.KartState.RESPAWNING, GameStates.KartState.DRIVING:
			_on_enter_alive()


func _on_enter_dead() -> void:
	visible = false
	velocity = Vector3.ZERO
	collision_layer = 0
	collision_mask = 0
	_clear_launchers()
	# v2.2: reset intensity and derived state. Exit condition will fire naturally
	# next frame (steer_input = 0 < exit_threshold), but reset here for immediate clean state.
	_drift_intensity = 0.0
	_is_drifting = false
	_drift_target = 0.0
	_visual_drift_angle = 0.0
	_cached_side_speed = 0.0
	_wheel_roll_angle = 0.0
	_steer_visual_angle = 0.0
	if physics:
		_grip = physics.high_grip_target
	if $BaseCar:
		$BaseCar.rotation.y = _base_car_rot_y
	_reset_wheel_rotations()


func _on_enter_alive() -> void:
	visible = true
	collision_layer = _original_collision_layer
	collision_mask = _original_collision_mask
	if physics:
		_grip = physics.high_grip_target


func _on_weapon_state_changed(peer_id: int, _from: GameStates.WeaponState, to: GameStates.WeaponState) -> void:
	if peer_id != player_id:
		return
	if to == GameStates.WeaponState.ARMED:
		_spawn_launchers()
	elif to == GameStates.WeaponState.EMPTY:
		_clear_launchers()


# ── Main loop (local kart only) ──────────────────────────────────────────────

func _physics_process(delta: float) -> void:
	# Remote karts: no physics, interpolation happens in _process
	if multiplayer.get_unique_id() != player_id:
		return

	if not StateManager.can_move(player_id):
		return

	# ── 1. Input smoothing ────────────────────────────────────────────────────
	var raw_throttle := Input.get_axis("move_backward", "move_forward")
	var raw_steer    := Input.get_axis("steer_right",   "steer_left")

	var steer_slew: float
	if absf(raw_steer) > absf(_steer_input):
		steer_slew = physics.steer_slew_rate_in
	else:
		steer_slew = physics.steer_slew_rate_out
	_steer_input = move_toward(_steer_input, raw_steer, steer_slew * delta)
	_throttle    = move_toward(_throttle, raw_throttle, physics.throttle_slew_rate * delta)

	# ── 2. Gravity ────────────────────────────────────────────────────────────
	if not is_on_floor():
		velocity.y -= physics.gravity * delta

	# ── 3. Decompose velocity ─────────────────────────────────────────────────
	var fwd_dir  := -global_transform.basis.z
	var side_dir :=  global_transform.basis.x
	var fwd_speed  := velocity.dot(fwd_dir)
	var side_speed := velocity.dot(side_dir)

	# ── 4. Drift intensity update (v2.2) — before rotation so fwd_speed is pre-thrust ────
	# GDD §Drift Model v2.2: hysteresis on |steer_input| drives intensity direction,
	# not a binary flip. enter_conditions → target=1.0; exit_conditions → target=0.0;
	# dead zone [exit_threshold, enter_threshold] → hold last target (hysteresis).
	# Reverse drift is explicitly blocked: requires fwd_speed > 0 (Core Rule 11).
	var abs_steer: float = absf(_steer_input)
	var drift_min_speed: float = physics.drift_min_speed_ratio * physics.max_speed

	var enter_conditions: bool = (abs_steer > physics.drift_enter_threshold) and (fwd_speed > drift_min_speed)
	var exit_conditions:  bool = (abs_steer < physics.drift_exit_threshold)  or  (fwd_speed <= drift_min_speed)

	if enter_conditions:
		_drift_target = 1.0
		_drift_rate   = physics.drift_intensity_enter_rate
	elif exit_conditions:
		_drift_target = 0.0
		_drift_rate   = physics.drift_intensity_exit_rate
	# else: hysteresis zone — keep _drift_target and _drift_rate unchanged

	_drift_intensity = move_toward(_drift_intensity, _drift_target, _drift_rate * delta)
	_drift_intensity = clamp(_drift_intensity, 0.0, 1.0)

	# Derived bool for VFX/audio/network (backward compat)
	_is_drifting = _drift_intensity > physics.drift_active_threshold

	# ── 5. Direct rotation (no bicycle model) ────────────────────────────────
	# GDD §Movement Model: rotate_y() + velocity projection. No wheelbase, no tan(steer_angle).
	# v2.2: yaw_mult = lerp(1.0, drift_yaw_multiplier, _drift_intensity) — continuous.
	var speed_ratio: float = clamp(absf(fwd_speed) / maxf(physics.max_speed, 0.01), 0.0, 1.0)
	var steer_mult: float = lerp(physics.steer_low_speed_mult, physics.steer_high_speed_mult, speed_ratio)
	var steer_sign: float = 1.0 if fwd_speed >= -0.5 else -1.0

	# Stationary steering — smoothstep blend around stationary_steer_threshold
	var base_scale: float = clamp(absf(fwd_speed) / maxf(physics.steer_speed_threshold, 0.01), 0.0, 1.0)
	var blend_low: float  = maxf(physics.stationary_steer_threshold - 0.5, 0.0)
	var blend_high: float = physics.stationary_steer_threshold + 0.5
	var blend: float = smoothstep(blend_low, blend_high, absf(fwd_speed))
	var speed_scale: float = lerp(physics.stationary_steer_scale, base_scale, blend)

	# v2.2: continuous yaw multiplier
	var yaw_mult: float = lerp(1.0, physics.drift_yaw_multiplier, _drift_intensity)
	var yaw_rate: float = _steer_input * steer_sign * physics.steering_speed * steer_mult * speed_scale * yaw_mult
	rotate_y(yaw_rate * delta)

	# Recompute dirs after rotation, then re-project BOTH fwd_speed and side_speed onto new basis.
	# This is the bicycle-model momentum transfer: after rotate_y the kart heading changed but
	# velocity still points in the old direction, so part of forward momentum becomes lateral.
	# This is intentional — it is the mechanism that creates drift sliding.
	# Thrust is applied AFTER re-projection (step 6) so it is not discarded by the dot-product.
	fwd_dir  = -global_transform.basis.z
	side_dir =  global_transform.basis.x
	fwd_speed  = velocity.dot(fwd_dir)
	side_speed = velocity.dot(side_dir)

	# ── 6. Force-based acceleration (v2.2) ────────────────────────────────────
	# Implements GDD §Movement Model: thrust + quadratic drag + linear rolling + explicit brake.
	# Applied after re-projection so thrust is not lost to the dot-product reset.
	# v2.2: drag_mult and rolling_mult are lerp(1.0, MULT, _drift_intensity) — continuous, no ternary.
	var thrust: float = 0.0
	if _throttle > 0.01:
		thrust = _throttle * physics.accel_force
	elif _throttle < -0.01:
		thrust = _throttle * physics.accel_force * physics.reverse_ratio

	# v2.2: continuous lerp multipliers — no step functions
	var drag_mult:    float = lerp(1.0, physics.drift_drag_multiplier,    _drift_intensity)
	var rolling_mult: float = lerp(1.0, physics.drift_rolling_multiplier, _drift_intensity)

	# Quadratic drag: dominates at high speed. Terminal velocity where thrust = drag + rolling.
	var drag: float = -signf(fwd_speed) * physics.k_drag * drag_mult * fwd_speed * fwd_speed

	# Linear rolling resistance: dominates at low speed, gives exponential coast-to-stop.
	var rolling: float = -physics.k_rolling * rolling_mult * fwd_speed

	# Brake: extra decel only when S is pressed and kart is moving forward.
	var brake: float = 0.0
	if Input.is_action_pressed("move_backward") and fwd_speed > 0.5:
		brake = -physics.brake_force

	fwd_speed += (thrust + drag + rolling + brake) * delta

	# Snap to zero near standstill when no throttle (avoids infinite float drift).
	if absf(thrust) < 0.01 and absf(fwd_speed) < 0.1:
		fwd_speed = 0.0

	# ── 7. Lateral ramp kick (v2.2 — replaces v2.1 one-shot impulse) ─────────
	# GDD §Lateral Ramp Kick: continuous force during entry phase only.
	# Applied to side_speed (local var), NOT velocity directly — velocity is rebuilt
	# at step 9, so mutations to velocity here would be overwritten. (v2.1 kick bug fix)
	# Force is maximal at intensity=0, falls to 0 as intensity→1: rear swing on entry,
	# not on already-drifting kart.
	if enter_conditions and _drift_intensity < 1.0:
		var lateral_force: float = physics.drift_lateral_ramp * (1.0 - _drift_intensity) * signf(-_steer_input)
		side_speed += lateral_force * delta

	# ── 8. Derived grip + lateral damping ─────────────────────────────────────
	# GDD §Derived Grip (v2.2):
	#   Default path: lerp from high_grip to low_grip via _drift_intensity (no animation, frame-derived).
	#   Legacy override: when both grip_loss_rate > 0 AND grip_recovery_rate > 0, use move_toward.
	if physics.grip_loss_rate == 0.0 and physics.grip_recovery_rate == 0.0:
		# v2.2 default: derived each frame from intensity
		_grip = lerp(physics.high_grip_target, physics.low_grip_target, _drift_intensity)
	else:
		# [deprecated] Legacy v2.1 path — move_toward with binary _is_drifting target
		var grip_target: float = physics.low_grip_target  if _is_drifting else physics.high_grip_target
		var grip_rate: float   = physics.grip_loss_rate   if _is_drifting else physics.grip_recovery_rate
		_grip = move_toward(_grip, grip_target, grip_rate * delta)

	# Lateral damping: high grip → side_speed decays fast (tight handling). Low grip → decays slow (slide).
	side_speed = move_toward(side_speed, 0.0, _grip * delta)

	# Cache for VFX
	_cached_side_speed = side_speed

	# ── 9. Rebuild velocity ───────────────────────────────────────────────────
	velocity = fwd_dir * fwd_speed + side_dir * side_speed + Vector3(0.0, velocity.y, 0.0)

	# ── 10. Move ──────────────────────────────────────────────────────────────
	move_and_slide()

	# ── 10.5. Visual drift angle (v2.2) ──────────────────────────────────────
	# GDD §Visual Lean: target = _drift_intensity * visual_drift_max_deg * sign(steer_input)
	# If visual_lean_recovery_speed > 0: overdamping (body mesh lags intensity for heavier feel).
	# If == 0: direct assignment (instant follow of intensity).
	var target_visual_angle: float = deg_to_rad(_drift_intensity * physics.visual_drift_max_deg * signf(_steer_input))
	if physics.visual_lean_recovery_speed > 0.0:
		_visual_drift_angle = move_toward(_visual_drift_angle, target_visual_angle,
				physics.visual_lean_recovery_speed * delta)
	else:
		_visual_drift_angle = target_visual_angle
	if $BaseCar:
		$BaseCar.rotation.y = _base_car_rot_y + _visual_drift_angle

	# ── 10.6. Visual front wheel steering ────────────────────────────────────
	if _wheel_fl and _wheel_fr:
		var max_wheel_steer_rad: float = deg_to_rad(25.0)  # visual only, fixed reasonable angle
		var target_steer: float = _steer_input * max_wheel_steer_rad
		_steer_visual_angle = lerp(_steer_visual_angle, target_steer, 18.0 * delta)

	# ── 10.7. Wheel roll animation ───────────────────────────────────────────
	if _wheel_fl and _wheel_fr and _wheel_rl and _wheel_rr:
		_wheel_roll_angle += fwd_speed * delta / maxf(physics.wheel_radius, 0.01)
		_wheel_roll_angle = fmod(_wheel_roll_angle, TAU)
		# No rotation flips — Car2 at identity
		_wheel_rl.rotation.x = _wheel_roll_angle
		_wheel_rr.rotation.x = _wheel_roll_angle
		# Front wheels: combine roll + steer
		_wheel_fl.rotation = Vector3(_wheel_roll_angle, _steer_visual_angle, 0.0)
		_wheel_fr.rotation = Vector3(_wheel_roll_angle, _steer_visual_angle, 0.0)

	# ── 11. Slope speed influence (post-slide, uses is_on_floor) ─────────────
	if is_on_floor():
		var slope_factor := -global_transform.basis.z.dot(Vector3.UP)
		var cur_fwd  := -global_transform.basis.z
		var cur_side :=  global_transform.basis.x
		var cur_fwd_speed  := velocity.dot(cur_fwd)
		var cur_side_speed := velocity.dot(cur_side)
		cur_fwd_speed += slope_factor * physics.slope_speed_influence * delta
		velocity = cur_fwd * cur_fwd_speed + cur_side * cur_side_speed + Vector3(0.0, velocity.y, 0.0)

	# ── 11.5. Floor alignment ─────────────────────────────────────────────────
	if is_on_floor() and physics.floor_align_speed > 0.0:
		var floor_n := get_floor_normal()
		var projected_fwd := fwd_dir - floor_n * fwd_dir.dot(floor_n)
		if projected_fwd.length_squared() > 0.0001:
			var target_basis := Basis.looking_at(projected_fwd, floor_n)
			global_transform.basis = global_transform.basis.slerp(target_basis, physics.floor_align_speed * delta).orthonormalized()

	# ── Kart-to-kart collision (server-only) ──────────────────────────────────
	if multiplayer.is_server():
		for i in get_slide_collision_count():
			var col := get_slide_collision(i)
			var other := col.get_collider()
			if other is CharacterBody3D and other.has_method("get_kart_mass"):
				var other_kart := other as CharacterBody3D
				var my_energy := physics.mass * absf(fwd_speed)
				var other_energy: float = other_kart.call("get_kart_mass") * other_kart.velocity.length()
				var energy_diff := my_energy - other_energy
				var push_dir := col.get_normal()  # points toward self (away from other)
				var force: float = clamp(absf(energy_diff) * 0.5, physics.bump_min_force, physics.bump_max_force)
				if energy_diff > 0.0:
					other.velocity += push_dir * force   # push other away from self
				else:
					velocity += -push_dir * force        # push self away from other

	_update_vfx(delta)

	if Input.is_action_just_pressed("fire") and StateManager.can_fire(player_id):
		_fire()

	if OS.has_feature("web"):
		var local_vel := global_transform.basis.inverse() * velocity
		var kart_state := StateManager.get_kart_state(player_id)
		var weapon_state := StateManager.get_weapon_state(player_id)
		var js_code := "window.kartMetrics = {x:%.2f, y:%.2f, z:%.2f, speed:%.2f, fwdSpeed:%.2f, latSpeed:%.2f, rotY:%.2f, hp:%d, weapon:%s, isDead:%s, onFloor:%s, steer:%.2f, throttle:%.2f}" % [
			global_position.x, global_position.y, global_position.z,
			velocity.length(),
			local_vel.z,
			local_vel.x,
			rad_to_deg(global_rotation.y),
			_health.current_hp if _health else 0,
			"true" if weapon_state == GameStates.WeaponState.ARMED else "false",
			"true" if kart_state == GameStates.KartState.DEAD else "false",
			"true" if is_on_floor() else "false",
			_steer_input,
			_throttle
		]
		JavaScriptBridge.eval(js_code)

	if OS.is_debug_build():
		var h : float = 0.0
		var space := get_world_3d().direct_space_state
		var query := PhysicsRayQueryParameters3D.create(
			global_position, global_position + Vector3.DOWN * 10.0)
		query.exclude = [get_rid()]
		var hit := space.intersect_ray(query)
		if hit:
			h = global_position.y - (hit.position as Vector3).y
		DebugOverlay.update({
			"fwd":      _dbg_fwd_vel,
			"lat":      _dbg_lat_vel,
			"vert":     _dbg_vert_vel,
			"drift":    rad_to_deg(atan2(absf(_dbg_lat_vel), maxf(absf(_dbg_fwd_vel), 0.1))),
			"height":   h,
			"angular":  _dbg_angular,
			"on_floor": _dbg_on_floor,
			"hp":       GameManager.players.get(player_id, {}).get("hp", 0),
			"weapon":   StateManager.get_weapon_state(player_id) == GameStates.WeaponState.ARMED,
			"peer_id":  player_id,
			"is_server": multiplayer.is_server(),
			"pos":      global_position,
		})

	# Send position sync (skip if DEAD)
	if StateManager.can_move(player_id):
		_sync_timer += delta
		if _sync_timer >= SYNC_INTERVAL:
			_sync_timer = 0.0
			var ts := Time.get_ticks_msec()
			var game_world := get_tree().current_scene
			if multiplayer.is_server() and game_world and "synced_peers" in game_world:
				for pid in game_world.synced_peers:
					if pid != player_id:
						_rpc_sync.rpc_id(pid, global_position, global_rotation, velocity, ts)
			else:
				_rpc_sync.rpc(global_position, global_rotation, velocity, ts)


# ── Public helpers ───────────────────────────────────────────────────────────

func _reset_wheel_rotations() -> void:
	if _wheel_fl:
		_wheel_fl.rotation = Vector3.ZERO
	if _wheel_fr:
		_wheel_fr.rotation = Vector3.ZERO
	if _wheel_rl:
		_wheel_rl.rotation = Vector3.ZERO
	if _wheel_rr:
		_wheel_rr.rotation = Vector3.ZERO


func get_kart_mass() -> float:
	return physics.mass if physics else 1.0


# ── Debug getters (used by DebugVectors3D overlay — stable across refactor phases) ──

func get_grip_debug() -> float:
	return _grip


func get_is_drifting_debug() -> bool:
	return _is_drifting


func get_throttle_debug() -> float:
	return _throttle


func get_steer_input_debug() -> float:
	return _steer_input


# ── Remote interpolation ─────────────────────────────────────────────────────

func _process(_delta: float) -> void:
	if multiplayer.get_unique_id() == player_id:
		return   # local kart — CameraRig handles camera
	# Remote kart: snapshot buffer interpolation
	if not _snapshot_buffer:
		return
	if StateManager.get_kart_state(player_id) == GameStates.KartState.DEAD:
		return
	var render_time := NetworkManager.get_synced_time() - SnapshotBufferClass.BUFFER_DELAY_MS
	var state: Dictionary = _snapshot_buffer.sample(render_time)
	if state["valid"]:
		global_position = state["pos"]
		global_rotation = state["rot"]


# ── Firing ───────────────────────────────────────────────────────────────────

func _fire() -> void:
	var muzzle_transforms := _launch_visual()
	_show_fire_flash()
	if multiplayer.is_server():
		StateManager.server_consume_weapon(player_id)
		for i in range(muzzle_transforms.size()):
			var tr := muzzle_transforms[i]
			var rocket_dir := _apply_rocket_spread(tr.basis.z.normalized(), i, muzzle_transforms.size())
			_rpc_spawn_projectile.rpc(player_id, tr.origin, rocket_dir)
	else:
		_rpc_request_fire.rpc_id(1)


func _launch_visual() -> Array[Transform3D]:
	var result: Array[Transform3D] = []
	for launcher in _launcher_nodes:
		var muzzle := launcher.get_node_or_null("Muzzle") as Marker3D
		if muzzle:
			result.append(muzzle.global_transform)
		if launcher.has_method("launch"):
			launcher.launch()
	return result


func _show_fire_flash() -> void:
	var flash_pos := global_position - global_transform.basis.z * 2.2 + Vector3.UP * 0.4
	var scene := get_tree().current_scene
	var m := MeshInstance3D.new()
	var sm := SphereMesh.new()
	sm.radius = 1.0
	sm.height = 2.0
	var mat := StandardMaterial3D.new()
	mat.albedo_color = Color(1.0, 1.0, 0.9, 1.0)
	mat.emission_enabled = true
	mat.emission = Color(1.0, 1.0, 0.8)
	mat.emission_energy_multiplier = 22.0
	mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	mat.cull_mode = BaseMaterial3D.CULL_DISABLED
	sm.material = mat
	m.mesh = sm
	m.scale = Vector3.ZERO
	scene.add_child(m)
	m.global_position = flash_pos
	var tw := m.create_tween()
	tw.tween_property(m, "scale", Vector3.ONE * 0.75, 0.06)
	tw.tween_property(m, "scale", Vector3.ZERO, 0.12)
	tw.tween_callback(m.queue_free)


@rpc("any_peer", "call_remote", "reliable")
func _rpc_request_fire() -> void:
	if not multiplayer.is_server():
		return
	var shooter_id := multiplayer.get_remote_sender_id()
	var kart := get_parent().get_node_or_null(str(shooter_id))
	if not kart:
		return
	if not StateManager.can_fire(shooter_id):
		return
	var muzzle_transforms: Array[Transform3D] = kart._launch_visual()
	kart._show_fire_flash()
	StateManager.server_consume_weapon(shooter_id)
	for i in range(muzzle_transforms.size()):
		var tr := muzzle_transforms[i]
		var rocket_dir: Vector3 = kart._apply_rocket_spread(tr.basis.z.normalized(), i, muzzle_transforms.size())
		_rpc_spawn_projectile.rpc(shooter_id, tr.origin, rocket_dir)


@rpc("authority", "call_local", "reliable")
func _rpc_spawn_projectile(shooter_id: int, pos: Vector3, dir: Vector3) -> void:
	var rocket := ROCKET_SCENE.instantiate()
	rocket.setup(ROCKET_CONFIG.duplicate(), shooter_id, dir)
	rocket.global_position = pos
	rocket.look_at(pos + dir.normalized(), Vector3.UP)
	var container := get_tree().current_scene.get_node_or_null("Projectiles")
	if container:
		container.add_child(rocket)
	else:
		get_tree().current_scene.add_child(rocket)


func _apply_rocket_spread(base_dir: Vector3, index: int, total: int) -> Vector3:
	if total < 3:
		return base_dir
	var yaw_deg := 0.0
	if index == 0:
		yaw_deg = -ROCKET_SPREAD_DEG
	elif index == 1:
		yaw_deg = ROCKET_SPREAD_DEG
	var spread_basis := Basis(Vector3.UP, deg_to_rad(yaw_deg))
	return (spread_basis * base_dir).normalized()


# ── Drift VFX ────────────────────────────────────────────────────────────────

func _update_vfx(_delta: float) -> void:
	if not l_smoke or not r_smoke:
		return
	var smoke_on: bool = is_on_floor() and absf(_cached_side_speed) > physics.vfx_smoke_speed_threshold
	if l_smoke.emitting != smoke_on:
		l_smoke.emitting = smoke_on
	if r_smoke.emitting != smoke_on:
		r_smoke.emitting = smoke_on
	l_drift.visible = smoke_on
	r_drift.visible = smoke_on


# ── Network sync ─────────────────────────────────────────────────────────────

@rpc("any_peer", "unreliable")
func _rpc_sync(pos: Vector3, rot: Vector3, vel: Vector3, timestamp_ms: int) -> void:
	var sender := multiplayer.get_remote_sender_id()
	if sender != player_id:
		return

	# Server-side: teleport validation + timeout tracking
	if multiplayer.is_server():
		NetworkManager.update_last_packet(sender)
		var dist := _last_known_pos.distance_to(pos)
		if dist > SnapshotBufferClass.TELEPORT_THRESHOLD:
			push_warning("[Kart] Teleport rejected for peer %d: dist=%.1f" % [sender, dist])
			return
		_last_known_pos = pos

	# Remote kart: push to snapshot buffer
	if _snapshot_buffer:
		_snapshot_buffer.push(timestamp_ms, pos, rot, vel)


# ── Weapon visuals ───────────────────────────────────────────────────────────

func _spawn_launchers() -> void:
	_clear_launchers()
	var sockets: Array[Marker3D] = [_launcher_left, _launcher_right, _launcher_center]
	for socket in sockets:
		if not socket:
			continue
		var launcher := LAUNCHER_SCENE.instantiate() as Node3D
		socket.add_child(launcher)
		launcher.transform = Transform3D.IDENTITY
		_launcher_nodes.append(launcher)


func _clear_launchers() -> void:
	for launcher in _launcher_nodes:
		if is_instance_valid(launcher):
			launcher.queue_free()
	_launcher_nodes.clear()


# ── Damage (DEPRECATED — projectiles now call HealthComponent.apply_damage directly) ──

func take_damage(damage: int, attacker_id: int, damage_type: DamageInfo.Type = DamageInfo.Type.PROJECTILE, hit_position: Vector3 = Vector3.ZERO) -> void:
	if not multiplayer.is_server():
		return
	var info := DamageInfo.create(damage_type, damage, attacker_id, hit_position)
	_health.apply_damage(info)


func _on_health_died(_killer_id: int) -> void:
	pass  # VFX hook — placeholder for step 7


# ── Respawn (visual reset, called via RPC from game_world) ───────────────────

@rpc("authority", "call_local", "reliable")
func respawn(spawn_pos: Vector3, spawn_rot: float = 0.0) -> void:
	global_position = spawn_pos
	rotation.y = spawn_rot
	velocity = Vector3.ZERO
	_throttle = 0.0
	_steer_input = 0.0
	_drift_intensity = 0.0
	_is_drifting = false
	_drift_target = 0.0
	_visual_drift_angle = 0.0
	_cached_side_speed = 0.0
	_wheel_roll_angle = 0.0
	_steer_visual_angle = 0.0
	if $BaseCar:
		$BaseCar.rotation.y = _base_car_rot_y
	_reset_wheel_rotations()
	if physics:
		_grip = physics.high_grip_target
	_last_known_pos = spawn_pos
	if _snapshot_buffer:
		_snapshot_buffer.force_teleport()
	_health.reset()
