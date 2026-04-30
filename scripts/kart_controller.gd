extends CharacterBody3D

# Orchestrator: input → BicyclePhysics.step() → apply to body → VFX/network/visual.
# Physics math lives in scripts/physics/bicycle_physics.gd (pure RefCounted module).
# v3.0: two-axle bicycle model with saturating tire forces. See design/gdd/kart-physics.md.

# ── Physics resource ──────────────────────────────────────────────────────────
@export var physics: KartPhysicsResource
const DEFAULT_PHYSICS_PATH := "res://resources/kart_physics_default.tres"

# ── Bicycle physics module + IO ───────────────────────────────────────────────
var _bicycle: BicyclePhysics
var _phys_input: PhysicsInput

# ── Drift state machine (auto-trigger, layered on bicycle) ───────────────────
var _drift_sm: DriftStateMachine
var _drift_visual_yaw: float = 0.0   # smoothed visual yaw applied to BaseCar
var _drift_active: bool = false      # mirror of state machine ACTIVE
var _drift_direction: int = 0        # -1 / 0 / +1
var _drift_power: float = 0.0        # 0..1 accumulated power

# ── Public state mirrors (set from PhysicsState each tick — public contract) ──
var _drift_intensity: float = 0.0    # camera, VFX, audio consume this
var _is_drifting: bool = false       # VFX/audio on-off trigger
var _cached_side_speed: float = 0.0  # legacy debug overlays read this
var _omega: float = 0.0              # for visual lean and debug

# ── Visual state ──────────────────────────────────────────────────────────────
var _visual_drift_angle: float = 0.0
var _base_car_rot_y: float = 0.0
var _wheel_roll_angle: float = 0.0
var _steer_visual_angle: float = 0.0

# ── Per-rear-wheel slip (drives independent VFX trails) ───────────────────────
var _rear_l_lat_speed: float = 0.0
var _rear_r_lat_speed: float = 0.0

# ── Network ──────────────────────────────────────────────────────────────────
const SYNC_INTERVAL := 0.033
var player_id: int = 0
var player_name: String = ""
var _snapshot_buffer: SnapshotBufferClass = null
var _sync_timer: float = 0.0
var _last_known_pos: Vector3 = Vector3.ZERO

# ── Collision (disabled on death) ────────────────────────────────────────────
var _original_collision_layer: int = 0
var _original_collision_mask: int = 0

# ── Input (smoothed) ─────────────────────────────────────────────────────────
var _throttle:    float = 0.0
var _steer_input: float = 0.0

# ── Weapon ───────────────────────────────────────────────────────────────────
var _launcher_nodes: Array[Node3D] = []
const LAUNCHER_SCENE := preload("res://scenes/launcher.tscn")
const ROCKET_SCENE := preload("res://scenes/rocket.tscn")
const ROCKET_CONFIG := preload("res://resources/rocket_config.tres")
const SnapshotBufferClass := preload("res://scripts/snapshot_buffer.gd")
const ROCKET_SPREAD_DEG := 10.0

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
	if not physics:
		physics = load(DEFAULT_PHYSICS_PATH)
	if physics:
		floor_snap_length = physics.floor_snap_length
	floor_stop_on_slope = false
	floor_max_angle = deg_to_rad(50.0)
	_original_collision_layer = collision_layer
	_original_collision_mask = collision_mask
	var is_local := (player_id == multiplayer.get_unique_id())
	name_label.text = player_name

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

	# Bicycle physics module — local kart only (remote karts use snapshot interpolation).
	if is_local and physics:
		_bicycle = BicyclePhysics.new(physics)
		_phys_input = PhysicsInput.new()
		_drift_sm = DriftStateMachine.new(physics)
		_setup_axle_geometry()

	if OS.is_debug_build() and not OS.has_feature("web"):
		DevParams.params_changed.connect(_on_dev_params_changed)
		if not DevParams.get_data().is_empty():
			_on_dev_params_changed(DevParams.get_data())

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


func _setup_axle_geometry() -> void:
	if not _bicycle:
		return
	var wb: float = physics.wheelbase_override
	if wb <= 0.0 and _wheel_fl and _wheel_rl:
		wb = absf(_wheel_fl.global_position.z - _wheel_rl.global_position.z)
		if wb < 0.1:
			wb = 1.2
	elif wb <= 0.0:
		wb = 1.2
	var tw: float = physics.track_width_override
	if tw <= 0.0 and _wheel_rl and _wheel_rr:
		tw = absf(_wheel_rl.global_position.x - _wheel_rr.global_position.x)
		if tw < 0.05:
			tw = 0.9
	elif tw <= 0.0:
		tw = 0.9
	_bicycle.set_axle_geometry(wb, tw)


func _exit_tree() -> void:
	if _health and _health.died.is_connected(_on_health_died):
		_health.died.disconnect(_on_health_died)
	if StateManager.kart_state_changed.is_connected(_on_kart_state_changed):
		StateManager.kart_state_changed.disconnect(_on_kart_state_changed)
	if StateManager.weapon_state_changed.is_connected(_on_weapon_state_changed):
		StateManager.weapon_state_changed.disconnect(_on_weapon_state_changed)


# ── Dev params hot-reload ────────────────────────────────────────────────────
# Mutates physics resource fields in-place. BicyclePhysics holds a reference,
# so changes apply on the next step() call. Deprecated v2.4 keys still read
# (no-op for physics, but keeps dev_params.json roundtrip stable).

func _on_dev_params_changed(data: Dictionary) -> void:
	if not physics:
		return
	# Speed (force-based)
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
	physics.steer_visual_rate     = data.get("STEER_VISUAL_RATE",      physics.steer_visual_rate)
	# Steering (legacy + still-used scales)
	physics.steering_speed        = data.get("STEERING_SPEED",         physics.steering_speed)
	physics.steer_low_speed_mult  = data.get("STEER_LOW_MULT",         physics.steer_low_speed_mult)
	physics.steer_high_speed_mult = data.get("STEER_HIGH_MULT",        physics.steer_high_speed_mult)
	physics.steer_speed_threshold = data.get("STEER_SPEED_THRESHOLD",  physics.steer_speed_threshold)
	physics.stationary_steer_threshold = data.get("STATIONARY_STEER_THRESHOLD", physics.stationary_steer_threshold)
	physics.stationary_steer_scale     = data.get("STATIONARY_STEER_SCALE",     physics.stationary_steer_scale)
	physics.wheel_radius          = data.get("WHEEL_RADIUS",           physics.wheel_radius)
	# v3.0 bicycle params
	physics.wheelbase_override    = data.get("WHEELBASE_OVERRIDE",     physics.wheelbase_override)
	physics.track_width_override  = data.get("TRACK_WIDTH_OVERRIDE",   physics.track_width_override)
	physics.max_steer_angle_deg   = data.get("MAX_STEER_ANGLE_DEG",    physics.max_steer_angle_deg)
	physics.front_grip_stiffness  = data.get("FRONT_GRIP",             physics.front_grip_stiffness)
	physics.rear_grip_stiffness   = data.get("REAR_GRIP",              physics.rear_grip_stiffness)
	physics.tire_saturation_speed = data.get("TIRE_SATURATION",        physics.tire_saturation_speed)
	physics.inertia_scale         = data.get("INERTIA_SCALE",          physics.inertia_scale)
	physics.omega_damping         = data.get("OMEGA_DAMPING",          physics.omega_damping)
	physics.stationary_omega_kick = data.get("STATIONARY_OMEGA_KICK",  physics.stationary_omega_kick)
	physics.drift_max_slip_speed  = data.get("DRIFT_MAX_SLIP_SPEED",   physics.drift_max_slip_speed)
	physics.omega_lean_scale      = data.get("OMEGA_LEAN_SCALE",       physics.omega_lean_scale)
	# Drift signal shaping (still-used + deprecated v2.4 — kept for JSON roundtrip)
	physics.drift_min_speed           = data.get("DRIFT_MIN_SPEED",             physics.drift_min_speed)
	physics.drift_max_slip_angle_deg  = data.get("DRIFT_MAX_SLIP_ANGLE_DEG",    physics.drift_max_slip_angle_deg)
	physics.slip_smoothing            = data.get("SLIP_SMOOTHING",              physics.slip_smoothing)
	physics.drift_intent_multiplier   = data.get("DRIFT_INTENT_MULTIPLIER",     physics.drift_intent_multiplier)
	physics.drift_intent_threshold    = data.get("DRIFT_INTENT_THRESHOLD",      physics.drift_intent_threshold)
	physics.grip_slip_exponent        = data.get("GRIP_SLIP_EXPONENT",          physics.grip_slip_exponent)
	physics.high_grip_target          = data.get("HIGH_GRIP",                   physics.high_grip_target)
	physics.low_grip_target           = data.get("LOW_GRIP",                    physics.low_grip_target)
	physics.drift_yaw_multiplier      = data.get("DRIFT_YAW_MULTIPLIER",        physics.drift_yaw_multiplier)
	physics.drift_active_threshold    = data.get("DRIFT_ACTIVE_THRESHOLD",      physics.drift_active_threshold)
	physics.vfx_smoke_speed_threshold = data.get("VFX_SMOKE_THRESHOLD",         physics.vfx_smoke_speed_threshold)
	physics.drift_drag_multiplier     = data.get("DRIFT_DRAG_MULTIPLIER",       physics.drift_drag_multiplier)
	physics.drift_rolling_multiplier  = data.get("DRIFT_ROLLING_MULTIPLIER",    physics.drift_rolling_multiplier)
	physics.cornering_drag_coeff      = data.get("CORNERING_DRAG_COEFF",        physics.cornering_drag_coeff)
	# Visuals
	physics.visual_drift_max_deg      = data.get("VISUAL_DRIFT_MAX_DEG",        physics.visual_drift_max_deg)
	physics.visual_lean_recovery_speed = data.get("VISUAL_LEAN_RECOVERY_SPEED", physics.visual_lean_recovery_speed)
	# Terrain
	physics.gravity                   = data.get("GRAVITY",                     physics.gravity)
	physics.floor_align_speed         = data.get("FLOOR_ALIGN_SPEED",           physics.floor_align_speed)
	physics.slope_speed_influence     = data.get("SLOPE_INFLUENCE",             physics.slope_speed_influence)
	# v3.1 drift state machine
	physics.auto_drift_enabled        = bool(data.get("AUTO_DRIFT_ENABLED",     1 if physics.auto_drift_enabled else 0))
	physics.drift_enter_steer         = data.get("DRIFT_ENTER_STEER",           physics.drift_enter_steer)
	physics.drift_enter_speed         = data.get("DRIFT_ENTER_SPEED",           physics.drift_enter_speed)
	physics.drift_enter_debounce      = data.get("DRIFT_ENTER_DEBOUNCE",        physics.drift_enter_debounce)
	physics.drift_exit_steer          = data.get("DRIFT_EXIT_STEER",            physics.drift_exit_steer)
	physics.drift_exit_speed          = data.get("DRIFT_EXIT_SPEED",            physics.drift_exit_speed)
	physics.drift_exit_duration       = data.get("DRIFT_EXIT_DURATION",         physics.drift_exit_duration)
	physics.drift_visual_offset_deg   = data.get("DRIFT_VISUAL_OFFSET_DEG",     physics.drift_visual_offset_deg)
	physics.drift_visual_smooth_rate  = data.get("DRIFT_VISUAL_SMOOTH_RATE",    physics.drift_visual_smooth_rate)
	physics.drift_engage_in_rate      = data.get("DRIFT_ENGAGE_IN_RATE",        physics.drift_engage_in_rate)
	physics.drift_engage_out_rate     = data.get("DRIFT_ENGAGE_OUT_RATE",       physics.drift_engage_out_rate)
	physics.drift_recovery_rate       = data.get("DRIFT_RECOVERY_RATE",         physics.drift_recovery_rate)
	physics.drift_exit_grip_mult      = data.get("DRIFT_EXIT_GRIP_MULT",        physics.drift_exit_grip_mult)
	physics.drift_rear_grip_mult      = data.get("DRIFT_REAR_GRIP_MULT",        physics.drift_rear_grip_mult)
	physics.drift_yaw_bonus           = data.get("DRIFT_YAW_BONUS",             physics.drift_yaw_bonus)
	physics.drift_forward_assist      = data.get("DRIFT_FORWARD_ASSIST",        physics.drift_forward_assist)
	physics.drift_power_full_time     = data.get("DRIFT_POWER_FULL_TIME",       physics.drift_power_full_time)
	physics.drift_min_active_for_boost = data.get("DRIFT_MIN_ACTIVE_FOR_BOOST", physics.drift_min_active_for_boost)
	physics.drift_exit_boost_force    = data.get("DRIFT_EXIT_BOOST_FORCE",      physics.drift_exit_boost_force)
	physics.drift_exit_boost_duration = data.get("DRIFT_EXIT_BOOST_DURATION",   physics.drift_exit_boost_duration)


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
	_reset_kart_state()


# Single source of truth for kart state reset. Called from _on_enter_dead and respawn().
func _reset_kart_state() -> void:
	_drift_intensity = 0.0
	_is_drifting = false
	_omega = 0.0
	_visual_drift_angle = 0.0
	_drift_visual_yaw = 0.0
	_drift_active = false
	_drift_direction = 0
	_drift_power = 0.0
	_cached_side_speed = 0.0
	_rear_l_lat_speed = 0.0
	_rear_r_lat_speed = 0.0
	_wheel_roll_angle = 0.0
	_steer_visual_angle = 0.0
	if _bicycle:
		_bicycle.reset()
	if _drift_sm:
		_drift_sm.reset()
	if $BaseCar:
		$BaseCar.rotation.y = _base_car_rot_y
	_reset_wheel_rotations()


func _on_enter_alive() -> void:
	visible = true
	collision_layer = _original_collision_layer
	collision_mask = _original_collision_mask


func _on_weapon_state_changed(peer_id: int, _from: GameStates.WeaponState, to: GameStates.WeaponState) -> void:
	if peer_id != player_id:
		return
	if to == GameStates.WeaponState.ARMED:
		_spawn_launchers()
	elif to == GameStates.WeaponState.EMPTY:
		_clear_launchers()


# ── Main loop (local kart only) ──────────────────────────────────────────────

func _physics_process(delta: float) -> void:
	# Remote karts: no physics — _process handles snapshot interpolation.
	if multiplayer.get_unique_id() != player_id:
		return
	if not StateManager.can_move(player_id):
		return
	if not _bicycle or not _phys_input or not _drift_sm:
		return

	# 1. Input smoothing (exp-lerp, framerate-independent).
	_smooth_input(delta)

	# 2. Gravity (vertical only — bicycle module sees y untouched).
	if not is_on_floor():
		velocity.y -= physics.gravity * delta

	# 3. Drift state machine: decides ACTIVE/IDLE, returns layered overrides.
	# Runs BEFORE bicycle so rear_grip_multiplier feeds tire force calc.
	var fwd_dir: Vector3 = -global_transform.basis.z
	var planar_speed: float = Vector3(velocity.x, 0.0, velocity.z).length()
	var fwd_signed: float = velocity.dot(fwd_dir)
	var drift: Dictionary = _drift_sm.update(
		planar_speed, _steer_input, is_on_floor(), _throttle, delta
	)
	_drift_active = drift["is_active"]
	_drift_direction = drift["direction"]
	_drift_visual_yaw = drift["visual_yaw_offset_rad"]
	_drift_power = drift["power"]

	# 4. Build PhysicsInput snapshot (basis after any prior rotation).
	_phys_input.velocity = velocity
	_phys_input.basis = global_transform.basis
	_phys_input.throttle = _throttle
	_phys_input.steer_input = _steer_input
	_phys_input.brake_held = Input.is_action_pressed("move_backward")
	_phys_input.on_floor = is_on_floor()
	_phys_input.rear_grip_multiplier = drift["rear_grip_multiplier"]

	# 5. Bicycle physics step.
	var state: PhysicsState = _bicycle.step(_phys_input, delta)

	# 6. Yaw application: bicycle delta + drift state bonus (extra rotation in ACTIVE).
	var total_yaw_delta: float = state.yaw_delta + drift["yaw_bonus_rad_per_sec"] * delta
	if absf(total_yaw_delta) > 0.0:
		rotate_y(total_yaw_delta)

	# 7. Velocity: keep gravity Y, take bicycle's XZ, then apply drift forward assist + exit boost.
	velocity = Vector3(state.new_velocity.x, velocity.y, state.new_velocity.z)
	var assist: float = drift["forward_assist_force"] + drift["exit_boost_force"]
	if absf(assist) > 0.0 and fwd_signed >= 0.0:
		var fwd_after: Vector3 = -global_transform.basis.z
		velocity += fwd_after * assist * delta

	# 6. Cache public mirrors for VFX, debug, network, camera.
	_drift_intensity = state.drift_intensity
	_is_drifting = state.is_drifting
	_omega = state.omega
	_rear_l_lat_speed = state.rear_left_lat_speed
	_rear_r_lat_speed = state.rear_right_lat_speed
	_cached_side_speed = (absf(state.rear_left_lat_speed) + absf(state.rear_right_lat_speed)) * 0.5

	# 7. Move.
	move_and_slide()

	# 8. Slope speed influence (post-slide).
	_apply_slope_influence(delta)

	# 9. Floor alignment — pitch/roll only, yaw locked (anti-feedback in circular drift).
	_apply_floor_align(delta)

	# 10. Kart-to-kart collision response (server-only).
	_apply_kart_collisions(state.fwd_speed)

	# 11. Visual lean (driven by omega — replaces v2.4 sign(side_speed) heuristic).
	_update_visual_lean(state, delta)

	# 12. Wheel visual animation.
	_update_wheel_visuals(state, delta)

	# 13. VFX (per-rear-wheel slip thresholds).
	_update_vfx()

	# 14. Weapon firing.
	if Input.is_action_just_pressed("fire") and StateManager.can_fire(player_id):
		_fire()

	# 15. Web metrics + debug overlay.
	_update_web_metrics(state)
	_update_debug_overlay(state)

	# 16. Network sync (30 Hz).
	_send_network_sync(delta)


# ── Per-tick helpers ─────────────────────────────────────────────────────────

func _smooth_input(delta: float) -> void:
	var raw_throttle := Input.get_axis("move_backward", "move_forward")
	var raw_steer    := Input.get_axis("steer_right",   "steer_left")
	var steer_slew: float = physics.steer_slew_rate_in if absf(raw_steer) > absf(_steer_input) else physics.steer_slew_rate_out
	var steer_alpha: float = 1.0 - exp(-steer_slew * delta)
	_steer_input = lerp(_steer_input, raw_steer, steer_alpha)
	if absf(_steer_input) < 0.01 and absf(raw_steer) < 0.01:
		_steer_input = 0.0
	var throttle_alpha: float = 1.0 - exp(-physics.throttle_slew_rate * delta)
	_throttle = lerp(_throttle, raw_throttle, throttle_alpha)


func _apply_slope_influence(delta: float) -> void:
	if not is_on_floor():
		return
	var slope_factor := -global_transform.basis.z.dot(Vector3.UP)
	var cur_fwd  := -global_transform.basis.z
	var cur_side :=  global_transform.basis.x
	var cur_fwd_speed  := velocity.dot(cur_fwd)
	var cur_side_speed := velocity.dot(cur_side)
	cur_fwd_speed += slope_factor * physics.slope_speed_influence * delta
	velocity = cur_fwd * cur_fwd_speed + cur_side * cur_side_speed + Vector3(0.0, velocity.y, 0.0)


func _apply_floor_align(delta: float) -> void:
	# Variant C: slerp affects pitch/roll only — yaw saved before, restored after.
	# Prevents yaw feedback loop that would amplify omega in long circular drifts.
	if not is_on_floor() or physics.floor_align_speed <= 0.0:
		return
	var fwd_dir := -global_transform.basis.z
	var floor_n := get_floor_normal()
	var projected_fwd := fwd_dir - floor_n * fwd_dir.dot(floor_n)
	if projected_fwd.length_squared() <= 0.0001:
		return
	var yaw_before: float = global_transform.basis.get_euler().y
	var target_basis := Basis.looking_at(projected_fwd, floor_n)
	# exp-form weight: framerate-independent (smooth-values rule)
	var align_alpha: float = 1.0 - exp(-physics.floor_align_speed * delta)
	var new_basis: Basis = global_transform.basis.slerp(target_basis, align_alpha).orthonormalized()
	var euler_after: Vector3 = new_basis.get_euler()
	euler_after.y = yaw_before
	global_transform.basis = Basis.from_euler(euler_after).orthonormalized()


func _apply_kart_collisions(fwd_speed: float) -> void:
	if not multiplayer.is_server():
		return
	for i in get_slide_collision_count():
		var col := get_slide_collision(i)
		var other := col.get_collider()
		if other is CharacterBody3D and other.has_method("get_kart_mass"):
			var other_kart := other as CharacterBody3D
			var my_energy := physics.mass * absf(fwd_speed)
			var other_energy: float = other_kart.call("get_kart_mass") * other_kart.velocity.length()
			var energy_diff := my_energy - other_energy
			var push_dir := col.get_normal()
			var force: float = clamp(absf(energy_diff) * 0.5, physics.bump_min_force, physics.bump_max_force)
			if energy_diff > 0.0:
				other.velocity += push_dir * force
			else:
				velocity += -push_dir * force


func _update_visual_lean(state: PhysicsState, delta: float) -> void:
	# Lean direction comes from omega — when body rotates left, kart leans right (centrifugal feel).
	# Negated below: positive omega = CCW = left turn, lean should be to the right side.
	var omega_norm: float = clampf(state.omega / maxf(physics.omega_lean_scale, 0.01), -1.0, 1.0)
	var lean_dir: float = -omega_norm
	var target_visual_angle: float = deg_to_rad(state.drift_intensity * physics.visual_drift_max_deg * lean_dir)
	if physics.visual_lean_recovery_speed > 0.0:
		var lean_alpha: float = 1.0 - exp(-physics.visual_lean_recovery_speed * delta)
		_visual_drift_angle = lerp(_visual_drift_angle, target_visual_angle, lean_alpha)
	else:
		_visual_drift_angle = target_visual_angle
	if $BaseCar:
		# Stack emergent lean (bicycle-driven) + drift state machine yaw offset.
		# Drift offset is signed by direction so it visually "trails" the turn.
		$BaseCar.rotation.y = _base_car_rot_y + _visual_drift_angle + _drift_visual_yaw


func _update_wheel_visuals(state: PhysicsState, delta: float) -> void:
	if _wheel_fl and _wheel_fr:
		var max_wheel_steer_rad: float = deg_to_rad(25.0)
		var target_steer: float = _steer_input * max_wheel_steer_rad
		var steer_vis_alpha: float = 1.0 - exp(-physics.steer_visual_rate * delta)
		_steer_visual_angle = lerp(_steer_visual_angle, target_steer, steer_vis_alpha)
	if _wheel_fl and _wheel_fr and _wheel_rl and _wheel_rr:
		_wheel_roll_angle += state.fwd_speed * delta / maxf(physics.wheel_radius, 0.01)
		_wheel_roll_angle = fmod(_wheel_roll_angle, TAU)
		_wheel_rl.rotation.x = _wheel_roll_angle
		_wheel_rr.rotation.x = _wheel_roll_angle
		_wheel_fl.rotation = Vector3(_wheel_roll_angle, _steer_visual_angle, 0.0)
		_wheel_fr.rotation = Vector3(_wheel_roll_angle, _steer_visual_angle, 0.0)


# v3.1: smoke driven by the engage envelope (engage_factor ≥ 0.5), not by the
# raw state flag or instantaneous slip. Reasons:
#  - Engagement matches when the body is VISUALLY drifting — smoke and the
#    yaw offset turn on together, no desync.
#  - Slip-based fallback used a 0.5 m/s threshold which fired on the slightest
#    cornering noise (false positives). Raised to 1.5 m/s so it only triggers
#    on a real rear-wheel break, not micro-scrub.
func _update_vfx() -> void:
	if not l_smoke or not r_smoke:
		return
	var on_floor := is_on_floor()
	var engaged: bool = _drift_sm and _drift_sm.is_drift_engaged()
	var smoke_l: bool
	var smoke_r: bool
	if engaged:
		smoke_l = on_floor
		smoke_r = on_floor
	else:
		# Stricter slip threshold — only real rear-wheel breakaway, not
		# every cornering noise sample.
		var slip_threshold: float = maxf(physics.vfx_smoke_speed_threshold * 3.0, 1.5)
		smoke_l = on_floor and absf(_rear_l_lat_speed) > slip_threshold
		smoke_r = on_floor and absf(_rear_r_lat_speed) > slip_threshold
	if l_smoke.emitting != smoke_l:
		l_smoke.emitting = smoke_l
	if r_smoke.emitting != smoke_r:
		r_smoke.emitting = smoke_r
	l_drift.visible = smoke_l
	r_drift.visible = smoke_r


func _update_web_metrics(state: PhysicsState) -> void:
	if not OS.has_feature("web"):
		return
	var local_vel := global_transform.basis.inverse() * velocity
	var kart_state := StateManager.get_kart_state(player_id)
	var weapon_state := StateManager.get_weapon_state(player_id)
	var js_code := "window.kartMetrics = {x:%.2f, y:%.2f, z:%.2f, speed:%.2f, fwdSpeed:%.2f, latSpeed:%.2f, rotY:%.2f, hp:%d, weapon:%s, isDead:%s, onFloor:%s, steer:%.2f, throttle:%.2f, omega:%.2f, drift:%.2f}" % [
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
		_throttle,
		state.omega,
		state.drift_intensity
	]
	JavaScriptBridge.eval(js_code)


func _update_debug_overlay(state: PhysicsState) -> void:
	if not OS.is_debug_build():
		return
	var h: float = 0.0
	var space := get_world_3d().direct_space_state
	var query := PhysicsRayQueryParameters3D.create(
		global_position, global_position + Vector3.DOWN * 10.0)
	query.exclude = [get_rid()]
	var hit := space.intersect_ray(query)
	if hit:
		h = global_position.y - (hit.position as Vector3).y
	DebugOverlay.update({
		"fwd":      state.fwd_speed,
		"lat":      state.side_speed,
		"vert":     velocity.y,
		"drift":    state.slip_angle_rear_deg,
		"height":   h,
		"angular":  state.omega,
		"on_floor": is_on_floor(),
		"hp":       GameManager.players.get(player_id, {}).get("hp", 0),
		"weapon":   StateManager.get_weapon_state(player_id) == GameStates.WeaponState.ARMED,
		"peer_id":  player_id,
		"is_server": multiplayer.is_server(),
		"pos":      global_position,
	})


func _send_network_sync(delta: float) -> void:
	if not StateManager.can_move(player_id):
		return
	_sync_timer += delta
	if _sync_timer < SYNC_INTERVAL:
		return
	_sync_timer = 0.0
	var ts := Time.get_ticks_msec()
	var game_world := get_tree().current_scene
	if multiplayer.is_server() and game_world and "synced_peers" in game_world:
		for pid in game_world.synced_peers:
			if pid != player_id:
				_rpc_sync.rpc_id(pid, global_position, global_rotation, velocity, ts)
	else:
		_rpc_sync.rpc(global_position, global_rotation, velocity, ts)


# ── Utility ──────────────────────────────────────────────────────────────────

func _reset_wheel_rotations() -> void:
	if _wheel_fl:
		_wheel_fl.rotation = Vector3.ZERO
	if _wheel_fr:
		_wheel_fr.rotation = Vector3.ZERO
	if _wheel_rl:
		_wheel_rl.rotation = Vector3.ZERO
	if _wheel_rr:
		_wheel_rr.rotation = Vector3.ZERO


# ── Public helpers (stable contract for camera, collision, debug) ────────────

func get_kart_mass() -> float:
	return physics.mass if physics else 1.0


func get_grip_debug() -> float:
	# Returns omega for v3.0 (kept under same name so legacy DebugVectors3D works).
	return _omega


func get_is_drifting_debug() -> bool:
	# v3.1: trails and VFX consume the auto-drift state machine engage envelope,
	# not the raw state flag — this syncs visuals (smoke, trails, body yaw) so
	# they all appear together when the kart is REALLY drifting visually,
	# not the instant the SM flips ACTIVE.
	if _drift_sm:
		return _drift_sm.is_drift_engaged()
	return _is_drifting


func is_auto_drifting() -> bool:
	# Engagement-based — see comment on get_is_drifting_debug. Trails and
	# smoke key off this so they appear in lockstep with the visible body yaw.
	if _drift_sm:
		return _drift_sm.is_drift_engaged()
	return _drift_active


func get_drift_engage_factor() -> float:
	if _drift_sm:
		return _drift_sm.get_engage_factor()
	return 0.0


func get_drift_direction() -> int:
	return _drift_direction


func get_drift_power() -> float:
	return _drift_power


func get_throttle_debug() -> float:
	return _throttle


func get_steer_input_debug() -> float:
	return _steer_input


# ── Remote interpolation ─────────────────────────────────────────────────────

func _process(_delta: float) -> void:
	if multiplayer.get_unique_id() == player_id:
		return
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


# ── Network sync ─────────────────────────────────────────────────────────────

@rpc("any_peer", "unreliable")
func _rpc_sync(pos: Vector3, rot: Vector3, vel: Vector3, timestamp_ms: int) -> void:
	var sender := multiplayer.get_remote_sender_id()
	if sender != player_id:
		return
	if multiplayer.is_server():
		NetworkManager.update_last_packet(sender)
		var dist := _last_known_pos.distance_to(pos)
		if dist > SnapshotBufferClass.TELEPORT_THRESHOLD:
			push_warning("[Kart] Teleport rejected for peer %d: dist=%.1f" % [sender, dist])
			return
		_last_known_pos = pos
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
	pass


# ── Respawn (visual reset, called via RPC from game_world) ───────────────────

@rpc("authority", "call_local", "reliable")
func respawn(spawn_pos: Vector3, spawn_rot: float = 0.0) -> void:
	global_position = spawn_pos
	rotation.y = spawn_rot
	velocity = Vector3.ZERO
	_throttle = 0.0
	_steer_input = 0.0
	_reset_kart_state()
	_last_known_pos = spawn_pos
	if _snapshot_buffer:
		_snapshot_buffer.force_teleport()
	_health.reset()
