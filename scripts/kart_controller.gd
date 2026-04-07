extends CharacterBody3D

# ── Physics resource ──────────────────────────────────────────────────────────
@export var physics: KartPhysicsResource = KartPhysicsResource.new()

# ── Drift (continuous model) ──────────────────────────────────────────────────
var _grip: float = 16.0              # initialised in _ready from physics.high_grip_target
var _drift_intent: float = 0.0       # 0.0 = no drift, 1.0 = full drift (continuous)
var _visual_drift_angle: float = 0.0
var _cached_side_speed: float = 0.0  # stored for VFX threshold check
var _base_car_rot_y: float = 0.0     # BaseCar has 180° rotation in scene — preserve it
var _wheel_roll_angle: float = 0.0   # accumulated roll for wheel spin animation
var _steer_visual_angle: float = 0.0 # smoothed visual steer angle (radians)

# ── Network ──────────────────────────────────────────────────────────────────
const SYNC_INTERVAL := 0.033

# ── Player identity ─────────────────────────────────────────────────────────
var player_id: int = 0
var player_name: String = ""

# ── Snapshot buffer (remote karts only) ──────────────────────────────────────
var _snapshot_buffer = null  # SnapshotBufferClass instance for remote karts
var _sync_timer: float = 0.0

# ── Camera ───────────────────────────────────────────────────────────────────
var _cam_offset := Vector3(0, 4.1, 6.8)
var _cam_look_forward := 1.15
var _cam_pos    := Vector3.ZERO
var _cam_init   := false
var _cam_lateral: float = 0.0        # current lateral offset (lerped)
var _cam_lateral_max: float = 1.5    # max lateral shift in turns (m)
var _cam_lateral_speed: float = 4.0  # lerp speed for lateral offset
var _cam_fov_base: float = 80.0      # base FOV (from dev_params)
var _cam_fov_boost: float = 12.0     # extra FOV at max speed

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
const SnapshotBufferClass := preload("res://scripts/snapshot_buffer.gd")
const ROCKET_SPREAD_DEG := 10.0

# ── Server-side tracking ─────────────────────────────────────────────────────
var _last_known_pos: Vector3 = Vector3.ZERO

@onready var camera:          Camera3D        = $Camera3D
@onready var name_label:      Label3D         = $NameLabel
@onready var _health:         HealthComponent = $HealthComponent
@onready var _launcher_left:  Marker3D   = $BaseCar/Socket_Left
@onready var _launcher_right: Marker3D   = $BaseCar/Socket_Right
@onready var _launcher_center:Marker3D   = $BaseCar/Socket_Center
@onready var l_drift:         Node3D   = $BaseCar/MainCar/Car2/LT/LeftDrift
@onready var r_drift:         Node3D   = $BaseCar/MainCar/Car2/RT/RightDrift
@onready var l_smoke: GPUParticles3D = $BaseCar/MainCar/Car2/LT/LeftDrift/GPUParticles3D
@onready var r_smoke: GPUParticles3D = $BaseCar/MainCar/Car2/RT/RightDrift/GPUParticles3D
# NOTE: In Blender/GLB, T=front B=back. But double 180° rotation means
# LT/RT are at world +Z = REAR, LB/RB are at world -Z = FRONT in Godot.
@onready var _wheel_fl: MeshInstance3D = $BaseCar/MainCar/Car2/LB   # front-left (Godot -Z)
@onready var _wheel_fr: MeshInstance3D = $BaseCar/MainCar/Car2/RB   # front-right (Godot -Z)
@onready var _wheel_rl: MeshInstance3D = $BaseCar/MainCar/Car2/LT   # rear-left (Godot +Z)
@onready var _wheel_rr: MeshInstance3D = $BaseCar/MainCar/Car2/RT   # rear-right (Godot +Z)


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
	camera.current = is_local
	name_label.text = player_name

	# Remote karts: create snapshot buffer for interpolation
	if not is_local:
		_snapshot_buffer = SnapshotBufferClass.new()

	if OS.has_feature("web"):
		var dbg_label := Label.new()
		dbg_label.text = "pid=%d my_id=%d name=%s is_local=%s cam=%s" % [player_id, multiplayer.get_unique_id(), name, is_local, camera.current]
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
	# Speed
	physics.max_speed             = data.get("MAX_SPEED",              physics.max_speed)
	physics.reverse_max_speed     = data.get("REVERSE_MAX_SPEED",      physics.reverse_max_speed)
	physics.accel_sharpness       = data.get("ACCEL_SHARPNESS",        physics.accel_sharpness)
	physics.coast_decel           = data.get("COAST_DECEL",            physics.coast_decel)
	physics.brake_decel           = data.get("BRAKE_DECEL",            physics.brake_decel)
	# Input smoothing
	physics.steer_slew_rate_in    = data.get("STEER_SLEW_IN",          physics.steer_slew_rate_in)
	physics.steer_slew_rate_out   = data.get("STEER_SLEW_OUT",         physics.steer_slew_rate_out)
	physics.throttle_slew_rate    = data.get("THROTTLE_SLEW",          physics.throttle_slew_rate)
	# Steering
	physics.steering_speed        = data.get("STEERING_SPEED",         physics.steering_speed)
	physics.steer_low_speed_mult  = data.get("STEER_LOW_MULT",         physics.steer_low_speed_mult)
	physics.steer_high_speed_mult = data.get("STEER_HIGH_MULT",        physics.steer_high_speed_mult)
	physics.steer_speed_threshold = data.get("STEER_SPEED_THRESHOLD",  physics.steer_speed_threshold)
	physics.wheelbase             = data.get("WHEELBASE",              physics.wheelbase)
	physics.max_steer_angle       = data.get("MAX_STEER_ANGLE",       physics.max_steer_angle)
	physics.rwd_oversteer_factor  = data.get("RWD_OVERSTEER",         physics.rwd_oversteer_factor)
	physics.wheel_radius          = data.get("WHEEL_RADIUS",          physics.wheel_radius)
	# Drift (continuous)
	physics.high_grip_target      = data.get("HIGH_GRIP",              physics.high_grip_target)
	physics.low_grip_target       = data.get("LOW_GRIP",               physics.low_grip_target)
	physics.drift_steer_threshold = data.get("DRIFT_STEER_THRESHOLD",  physics.drift_steer_threshold)
	physics.grip_loss_rate        = data.get("GRIP_LOSS_RATE",         physics.grip_loss_rate)
	physics.grip_recovery_rate    = data.get("GRIP_RECOVERY_RATE",     physics.grip_recovery_rate)
	physics.drift_lateral_force       = data.get("DRIFT_LATERAL_FORCE",  physics.drift_lateral_force)
	physics.drift_counter_steer_mult = data.get("DRIFT_COUNTER_STEER", physics.drift_counter_steer_mult)
	physics.drift_same_steer_mult    = data.get("DRIFT_SAME_STEER",    physics.drift_same_steer_mult)
	physics.vfx_smoke_speed_threshold = data.get("VFX_SMOKE_THRESHOLD", physics.vfx_smoke_speed_threshold)
	# Terrain
	physics.gravity               = data.get("GRAVITY",               physics.gravity)
	physics.floor_align_speed     = data.get("FLOOR_ALIGN_SPEED",     physics.floor_align_speed)
	physics.slope_speed_influence = data.get("SLOPE_INFLUENCE",        physics.slope_speed_influence)
	_cam_offset = Vector3(0.0,
		data.get("CAMERA_HEIGHT",    _cam_offset.y),
		absf(data.get("CAMERA_DISTANCE", absf(_cam_offset.z))))
	_cam_look_forward = data.get("CAMERA_LOOK_AHEAD", _cam_look_forward)
	_cam_lateral_max  = data.get("CAMERA_LATERAL_MAX", _cam_lateral_max)
	_cam_lateral_speed = data.get("CAMERA_LATERAL_SPEED", _cam_lateral_speed)
	_cam_fov_base     = data.get("FOV", _cam_fov_base)
	_cam_fov_boost    = data.get("FOV_SPEED_BOOST", _cam_fov_boost)
	if camera:
		camera.fov = _cam_fov_base


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
	_drift_intent = 0.0
	_visual_drift_angle = 0.0
	_cached_side_speed = 0.0
	_wheel_roll_angle = 0.0
	_steer_visual_angle = 0.0
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

	# ── 4. Acceleration (asymptotic) ──────────────────────────────────────────
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

	# ── 5. Drift intent (continuous 0.0–1.0, based on steer only) ────────────
	var raw_intent := absf(_steer_input)
	var intent_target := 0.0
	if raw_intent > physics.drift_steer_threshold:
		intent_target = (raw_intent - physics.drift_steer_threshold) / maxf(1.0 - physics.drift_steer_threshold, 0.01)
	_drift_intent = intent_target  # instant — smoothing comes from grip rate

	# ── 6. Bicycle model steering (front-axle pivot) ─────────────────────────
	var speed_ratio: float = clamp(absf(fwd_speed) / physics.max_speed, 0.0, 1.0)
	var steer_mult: float = lerp(physics.steer_low_speed_mult, physics.steer_high_speed_mult, speed_ratio)
	var steer_sign: float = 1.0 if fwd_speed >= -0.5 else -1.0
	var speed_scale: float = clamp(absf(fwd_speed) / maxf(physics.steer_speed_threshold, 0.01), 0.0, 1.0)

	# Counter-steer detection: compare steer direction vs actual slide direction
	var steer_modifier := 1.0
	if _drift_intent > 0.1 and absf(side_speed) > 0.5:
		var is_counter := signf(_steer_input) != 0.0 and signf(_steer_input) != signf(side_speed)
		var blend: float = clamp(_drift_intent, 0.0, 1.0)
		if is_counter:
			steer_modifier = lerp(1.0, physics.drift_counter_steer_mult, blend)
		else:
			steer_modifier = lerp(1.0, physics.drift_same_steer_mult, blend)

	# Bicycle model: yaw_rate = (speed / wheelbase) × tan(steer_angle)
	var effective_steer_deg: float = _steer_input * steer_sign * physics.max_steer_angle * steer_mult * steer_modifier
	var steer_angle_rad: float = clamp(deg_to_rad(effective_steer_deg), deg_to_rad(-75.0), deg_to_rad(75.0))
	var safe_speed: float = maxf(absf(fwd_speed), 0.1) * speed_scale
	var yaw_rate: float = (safe_speed / maxf(physics.wheelbase, 0.1)) * tan(steer_angle_rad)

	# Front-axle pivot: record position BEFORE rotation, correct AFTER
	var half_wb := physics.wheelbase * 0.5
	var front_axle_pre := global_position - global_transform.basis.z * half_wb

	rotate_y(yaw_rate * delta)

	# Shift so front axle stays put — rear swings out
	var front_axle_post := global_position - global_transform.basis.z * half_wb
	global_position += front_axle_pre - front_axle_post

	# Recompute dirs after rotation + translation
	fwd_dir  = -global_transform.basis.z
	side_dir =  global_transform.basis.x

	# ── 7. Grip — continuous function of drift_intent ─────────────────────────
	var grip_target: float = lerp(physics.high_grip_target, physics.low_grip_target, _drift_intent)
	var grip_rate: float = physics.grip_loss_rate if grip_target < _grip else physics.grip_recovery_rate
	_grip = move_toward(_grip, grip_target, grip_rate * delta)

	# ── 8. Lateral force (always-on, intent-scaled) ───────────────────────────
	if absf(fwd_speed) > 0.5 and absf(_steer_input) > 0.05:
		side_speed += signf(_steer_input) * absf(fwd_speed) * _drift_intent * physics.drift_lateral_force * delta

	# ── 9. Lateral damping (exponential grip) ─────────────────────────────────
	side_speed *= exp(-_grip * delta)

	# Cache for VFX
	_cached_side_speed = side_speed

	# ── 10. Rebuild velocity ──────────────────────────────────────────────────
	velocity = fwd_dir * fwd_speed + side_dir * side_speed + Vector3(0.0, velocity.y, 0.0)

	# ── 10.5. RWD oversteer nudge ─────────────────────────────────────────────
	if absf(fwd_speed) > 1.0 and absf(_steer_input) > 0.05 and physics.rwd_oversteer_factor > 0.0:
		var steer_rad: float = deg_to_rad(_steer_input * physics.max_steer_angle)
		var rwd_lateral: float = fwd_speed * sin(steer_rad) * physics.rwd_oversteer_factor
		velocity += side_dir * rwd_lateral

	# ── 11. Move ─────────────────────────────────────────────────────────────
	move_and_slide()

	# ── 11.5. Visual drift angle (always active) ─────────────────────────────
	var vis_fwd  := velocity.dot(-global_transform.basis.z)
	var vis_side := velocity.dot(global_transform.basis.x)
	var drift_angle_target: float = clamp(
		atan2(vis_side, maxf(absf(vis_fwd), 0.1)) * -1.0,
		-0.44, 0.44)  # max ~25 degrees
	var drift_vis_rate: float = lerp(4.0, 12.0, _drift_intent)
	_visual_drift_angle = lerp(_visual_drift_angle, drift_angle_target, drift_vis_rate * delta)
	if $BaseCar:
		$BaseCar.rotation.y = _base_car_rot_y + _visual_drift_angle

	# ── 11.6. Visual front wheel steering ────────────────────────────────────
	if _wheel_fl and _wheel_fr:
		var target_steer: float = _steer_input * deg_to_rad(physics.max_steer_angle)
		_steer_visual_angle = lerp(_steer_visual_angle, target_steer, 18.0 * delta)

	# ── 11.7. Wheel roll animation ───────────────────────────────────────────
	if _wheel_fl and _wheel_fr and _wheel_rl and _wheel_rr:
		_wheel_roll_angle += fwd_speed * delta / maxf(physics.wheel_radius, 0.01)
		_wheel_roll_angle = fmod(_wheel_roll_angle, TAU)
		# Double 180° rotation = identity → no sign flip needed
		_wheel_rl.rotation.x = _wheel_roll_angle
		_wheel_rr.rotation.x = _wheel_roll_angle
		# Front wheels: combine roll + steer
		_wheel_fl.rotation = Vector3(_wheel_roll_angle, _steer_visual_angle, 0.0)
		_wheel_fr.rotation = Vector3(_wheel_roll_angle, _steer_visual_angle, 0.0)

	# ── 12. Slope speed influence (post-slide, uses is_on_floor) ──────────────
	if is_on_floor():
		var slope_factor := -global_transform.basis.z.dot(Vector3.UP)
		var cur_fwd  := -global_transform.basis.z
		var cur_side :=  global_transform.basis.x
		var cur_fwd_speed  := velocity.dot(cur_fwd)
		var cur_side_speed := velocity.dot(cur_side)
		cur_fwd_speed += slope_factor * physics.slope_speed_influence * delta
		velocity = cur_fwd * cur_fwd_speed + cur_side * cur_side_speed + Vector3(0.0, velocity.y, 0.0)

	# ── 12. Floor alignment ───────────────────────────────────────────────────
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


# ── Camera + Remote interpolation ────────────────────────────────────────────

func _process(delta: float) -> void:
	if multiplayer.get_unique_id() == player_id:
		# Local kart: camera only
		if not camera:
			return
		var flat_basis := Basis(Vector3.UP, global_rotation.y)

		# Camera lateral offset in turns — shifts outward so you see around corners
		var lateral_target: float = -_steer_input * _cam_lateral_max
		_cam_lateral = lerp(_cam_lateral, lateral_target, _cam_lateral_speed * delta)
		var side_flat := flat_basis.x

		var target_pos := global_position + flat_basis * _cam_offset + side_flat * _cam_lateral
		if not _cam_init:
			_cam_pos  = target_pos
			_cam_init = true
		_cam_pos = _cam_pos.lerp(target_pos, 6.0 * delta)
		camera.global_position = _cam_pos
		var forward_flat := -flat_basis.z
		var look_at_pt := global_position + forward_flat * _cam_look_forward + Vector3.UP * 0.55
		camera.look_at(look_at_pt, Vector3.UP)

		# Speed-dependent FOV
		var speed_t: float = clamp(velocity.length() / physics.max_speed, 0.0, 1.0)
		var target_fov: float = lerp(_cam_fov_base, _cam_fov_base + _cam_fov_boost, speed_t)
		camera.fov = lerp(camera.fov, target_fov, 4.0 * delta)
	else:
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
			_rpc_spawn_rocket.rpc(player_id, tr.origin, rocket_dir)
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
		_rpc_spawn_rocket.rpc(shooter_id, tr.origin, rocket_dir)


@rpc("authority", "call_local", "reliable")
func _rpc_spawn_rocket(shooter_id: int, pos: Vector3, dir: Vector3) -> void:
	var rocket := ROCKET_SCENE.instantiate()
	get_tree().current_scene.add_child(rocket)
	rocket.shooter_id = shooter_id
	rocket.global_position = pos
	rocket.direction = dir.normalized()
	rocket.look_at(pos + dir.normalized(), Vector3.UP)


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


# ── Damage (server-side entry point) ─────────────────────────────────────────

func take_damage(damage: int, attacker_id: int, damage_type: DamageInfo.Type = DamageInfo.Type.PROJECTILE, hit_position: Vector3 = Vector3.ZERO) -> void:
	if not multiplayer.is_server():
		return
	var info := DamageInfo.create(damage_type, damage, attacker_id, hit_position)
	_health.apply_damage(info)


func _on_health_died(_killer_id: int) -> void:
	pass  # VFX hook — placeholder for step 7


# ── Respawn (visual reset, called via RPC from game_world) ───────────────────

@rpc("authority", "call_local", "reliable")
func respawn(spawn_pos: Vector3) -> void:
	global_position = spawn_pos
	velocity = Vector3.ZERO
	_throttle = 0.0
	_steer_input = 0.0
	_drift_intent = 0.0
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
