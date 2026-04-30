extends Node3D

# ── Mode ─────────────────────────────────────────────────────────────────────
enum CameraMode { FOLLOW, DEATH, COUNTDOWN, SCOREBOARD }

var _mode: CameraMode = CameraMode.FOLLOW

# ── Target ────────────────────────────────────────────────────────────────────
var _target: CharacterBody3D = null

# ── Node refs ─────────────────────────────────────────────────────────────────
@onready var _shake_node: Node3D = $ShakeNode
@onready var _camera: Camera3D   = $ShakeNode/Camera3D

# ── Follow state ──────────────────────────────────────────────────────────────
var _cam_pos: Vector3 = Vector3.ZERO
var _cam_init: bool   = false
var _cam_drift_x: float = 0.0

# ── Death state ───────────────────────────────────────────────────────────────
var _death_pos: Vector3   = Vector3.ZERO
var _death_elapsed: float = 0.0

# ── Shake state ───────────────────────────────────────────────────────────────
var _shake_trauma: float = 0.0

# ── Tuning knobs ──────────────────────────────────────────────────────────────
@export_group("Follow")
@export var cam_height: float   = 4.1
@export var dist_base: float    = 6.8
@export var dist_max: float     = 8.6
@export var look_ahead: float   = 0.4
@export var lerp_slow: float    = 22.0
@export var lerp_fast: float    = 30.0

@export_group("FOV")
@export var fov_min: float = 65.0
@export var fov_max: float = 85.0

@export_group("Drift Offset")
@export var drift_max_offset: float = 0.0
@export var drift_lerp: float       = 12.0

@export_group("Shake")
@export var shake_max_offset: float = 0.15
@export var shake_decay_rate: float = 2.5

@export_group("Death")
@export var death_zoom_amount: float = 4.0
@export var death_drift_speed: float = 0.5

@export_group("Scoreboard")
@export var scoreboard_height: float = 15.0
@export var arena_center: Vector3    = Vector3.ZERO


func _ready() -> void:
	StateManager.kart_state_changed.connect(_on_kart_state_changed)
	StateManager.kart_died.connect(_on_kart_died)
	StateManager.match_state_changed.connect(_on_match_state_changed)

	if OS.is_debug_build() and not OS.has_feature("web"):
		DevParams.params_changed.connect(_on_dev_params_changed)
		if not DevParams.get_data().is_empty():
			_on_dev_params_changed(DevParams.get_data())


func _exit_tree() -> void:
	if StateManager.kart_state_changed.is_connected(_on_kart_state_changed):
		StateManager.kart_state_changed.disconnect(_on_kart_state_changed)
	if StateManager.kart_died.is_connected(_on_kart_died):
		StateManager.kart_died.disconnect(_on_kart_died)
	if StateManager.match_state_changed.is_connected(_on_match_state_changed):
		StateManager.match_state_changed.disconnect(_on_match_state_changed)


# ── Public API ────────────────────────────────────────────────────────────────

func set_target(kart: CharacterBody3D) -> void:
	_target = kart
	_cam_init = false
	_camera.current = true
	var health: HealthComponent = kart.get_node_or_null("HealthComponent")
	if health and not health.damaged.is_connected(_on_damaged):
		health.damaged.connect(_on_damaged)


func add_trauma(amount: float) -> void:
	_shake_trauma = clampf(_shake_trauma + amount, 0.0, 1.0)


# ── Process dispatch ──────────────────────────────────────────────────────────

func _process(delta: float) -> void:
	if not _target:
		return
	match _mode:
		CameraMode.FOLLOW:
			_process_follow(delta)
		CameraMode.DEATH:
			_process_death(delta)
		CameraMode.COUNTDOWN:
			_process_countdown(delta)
		CameraMode.SCOREBOARD:
			_process_scoreboard(delta)
	_apply_shake(delta)


# ── FOLLOW ────────────────────────────────────────────────────────────────────

func _process_follow(delta: float) -> void:
	var flat_basis := Basis(Vector3.UP, _target.global_rotation.y)
	var speed: float = _target.velocity.length()
	var max_speed: float = _target.physics.max_speed if _target.get("physics") else 14.0
	var t: float = clampf(speed / max_speed, 0.0, 1.0)
	var t_eased: float = smoothstep(0.0, 1.0, t)

	# Speed-dependent distance (pullback)
	var target_dist: float = dist_base + (dist_max - dist_base) * t_eased * 0.7
	var cam_offset := Vector3(0.0, cam_height, target_dist)

	# Drift lateral offset (based on actual lateral velocity)
	var lateral_vel: float = _target.velocity.dot(_target.global_transform.basis.x)
	var t_drift: float = clampf(lateral_vel / maxf(max_speed, 1.0), -1.0, 1.0)
	var target_drift_x: float = t_drift * drift_max_offset
	_cam_drift_x = lerp(_cam_drift_x, target_drift_x, 1.0 - exp(-drift_lerp * delta))

	# Target position
	var target_pos: Vector3 = _target.global_position + flat_basis * cam_offset
	target_pos += flat_basis.x * _cam_drift_x

	if not _cam_init:
		_cam_pos  = target_pos
		_cam_init = true

	# Speed-dependent follow lerp. Use t_eased (smoothstep'd) so the rate
	# itself transitions smoothly across the speed range — using raw t
	# produced a slight slope discontinuity at t=0 and t=1.
	var lerp_factor: float = lerp(lerp_slow, lerp_fast, t_eased)
	_cam_pos = _cam_pos.lerp(target_pos, 1.0 - exp(-lerp_factor * delta))
	global_position = _cam_pos

	# Look-at
	var forward_flat: Vector3 = -flat_basis.z
	var look_target: Vector3  = _target.global_position + forward_flat * look_ahead + Vector3.UP * 0.55
	_camera.look_at(look_target, Vector3.UP)

	# Speed-dependent FOV
	var target_fov: float = fov_min + (fov_max - fov_min) * t_eased
	_camera.fov = lerp(_camera.fov, target_fov, 1.0 - exp(-5.0 * delta))


# ── DEATH ─────────────────────────────────────────────────────────────────────

func _process_death(delta: float) -> void:
	_death_elapsed += delta
	global_position = _death_pos + Vector3.UP * (_death_elapsed * death_drift_speed)
	# Offset look target slightly forward to avoid look_at crash when directly above
	var look_target: Vector3 = _death_pos + Vector3(0.0, 0.0, 0.1)
	_camera.look_at(look_target, Vector3.UP)
	# Widen FOV for cinematic feel
	var t: float = clampf(_death_elapsed / 3.0, 0.0, 1.0)
	var target_fov: float = lerp(fov_min, fov_max, t)
	_camera.fov = lerp(_camera.fov, target_fov, 1.0 - exp(-3.0 * delta))


# ── COUNTDOWN ─────────────────────────────────────────────────────────────────

func _process_countdown(delta: float) -> void:
	_process_follow(delta)


# ── SCOREBOARD ────────────────────────────────────────────────────────────────

func _process_scoreboard(delta: float) -> void:
	var overhead_pos: Vector3 = arena_center + Vector3(0.0, scoreboard_height, 0.0)
	global_position = global_position.lerp(overhead_pos, 1.0 - exp(-2.0 * delta))
	_camera.look_at(arena_center, Vector3.FORWARD)


# ── SHAKE ─────────────────────────────────────────────────────────────────────

func _apply_shake(delta: float) -> void:
	_shake_trauma = maxf(_shake_trauma - shake_decay_rate * delta, 0.0)
	if _shake_trauma < 0.001:
		_shake_node.position = Vector3.ZERO
		return
	var intensity: float = _shake_trauma * _shake_trauma
	_shake_node.position = Vector3(
		randf_range(-1.0, 1.0) * shake_max_offset * intensity,
		randf_range(-1.0, 1.0) * shake_max_offset * intensity,
		0.0
	)


# ── Signal handlers ───────────────────────────────────────────────────────────

func _on_kart_state_changed(peer_id: int, _from: GameStates.KartState, to: GameStates.KartState) -> void:
	if not _target or peer_id != _target.player_id:
		return
	match to:
		GameStates.KartState.DRIVING, GameStates.KartState.INVULNERABLE:
			if _mode == CameraMode.DEATH:
				_cam_init = false
				_mode = CameraMode.FOLLOW


func _on_kart_died(peer_id: int, _killer_id: int) -> void:
	if not _target or peer_id != _target.player_id:
		return
	_death_pos     = global_position
	_death_elapsed = 0.0
	_mode          = CameraMode.DEATH


func _on_match_state_changed(_from: GameStates.MatchState, to: GameStates.MatchState) -> void:
	match to:
		GameStates.MatchState.COUNTDOWN:
			_mode = CameraMode.COUNTDOWN
		GameStates.MatchState.PLAYING:
			_mode = CameraMode.FOLLOW
		GameStates.MatchState.ENDED:
			_mode = CameraMode.SCOREBOARD
		GameStates.MatchState.WAITING:
			_mode = CameraMode.FOLLOW


func _on_damaged(info: DamageInfo, _final_amount: int) -> void:
	var trauma: float = 0.5
	if info.type == DamageInfo.Type.AOE_EXPLOSION:
		trauma = 0.3
	add_trauma(trauma)


# ── DevParams hot-reload ──────────────────────────────────────────────────────

func _on_dev_params_changed(data: Dictionary) -> void:
	cam_height       = data.get("CAMERA_HEIGHT",       cam_height)
	dist_base        = data.get("CAMERA_DISTANCE",     dist_base)
	look_ahead       = data.get("CAMERA_LOOK_AHEAD",   look_ahead)
	drift_max_offset = data.get("CAMERA_LATERAL_MAX",  drift_max_offset)
	drift_lerp       = data.get("CAMERA_LATERAL_SPEED", drift_lerp)
	fov_min          = data.get("FOV",                 fov_min)
	var fov_boost: float = data.get("FOV_SPEED_BOOST", fov_max - fov_min)
	fov_max = fov_min + fov_boost
	if _camera:
		_camera.fov = fov_min
