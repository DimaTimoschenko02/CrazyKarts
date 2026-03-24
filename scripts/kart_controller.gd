extends CharacterBody3D

# ── Физика ───────────────────────────────────────────────────────────────────
var MAX_SPEED      : float = 23.0    # м/с
var REVERSE_MAX_SPEED: float = 13.0
var ACCELERATION   : float = 12.0   # м/с² — разгон
var REVERSE_ACCELERATION: float = 10.0
var BRAKE_DECEL    : float = 40.0   # м/с² — торможение/реверс
var COAST_DECEL    : float = 8.0    # м/с² — накат (газ отпущен)
var STEERING_SPEED : float = 2.2    # рад/с при максимальной скорости
var HIGH_GRIP      : float = 18.0   # боковое сцепление на малой скорости (цепкий)
var LOW_GRIP       : float = 0.3    # боковое сцепление при заносе (скользкий)

# ── Сеть ─────────────────────────────────────────────────────────────────────
const SYNC_INTERVAL  := 0.05

# ── Состояние игрока ─────────────────────────────────────────────────────────
var player_id: int = 0
var player_name: String = ""

var current_hp: int = 100
var has_weapon: bool = false
var is_dead: bool = false

# ── Сеть: интерполяция ───────────────────────────────────────────────────────
var _net_pos: Vector3
var _net_rot: Vector3
var _sync_timer: float = 0.0

# ── Камера ────────────────────────────────────────────────────────────────────
var _cam_offset := Vector3(0, 4.1, 6.8)
var _cam_look_forward := 1.15
var _cam_pos    := Vector3.ZERO
var _cam_init   := false

# ── Визуал ────────────────────────────────────────────────────────────────────
var _smoke_timer: float = 0.0
var _mark_timer:  float = 0.0

# ── Debug кэш (заполняется в _integrate_forces, читается в _physics_process) ──
var _dbg_fwd_vel  : float = 0.0
var _dbg_lat_vel  : float = 0.0
var _dbg_vert_vel : float = 0.0
var _dbg_angular  : float = 0.0
var _dbg_on_floor : bool  = false

# ── Ввод ─────────────────────────────────────────────────────────────────────
var _throttle:    float = 0.0
var _steer_input: float = 0.0
var _launcher_nodes: Array[Node3D] = []
const LAUNCHER_SCENE := preload("res://scenes/launcher.tscn")
const ROCKET_SPREAD_DEG := 10.0

@onready var camera:          Camera3D = $Camera3D
@onready var name_label:      Label3D  = $NameLabel
@onready var _launcher_left:  Marker3D   = $BaseCar/Socket_Left
@onready var _launcher_right: Marker3D   = $BaseCar/Socket_Right
@onready var _launcher_center:Marker3D   = $BaseCar/Socket_Center
@onready var l_drift:         Node3D   = $BaseCar/MainCar/Car2/LT/LeftDrift
@onready var r_drift:         Node3D   = $BaseCar/MainCar/Car2/RT/RightDrift
@onready var l_smoke: GPUParticles3D = $BaseCar/MainCar/Car2/LT/LeftDrift/GPUParticles3D
@onready var r_smoke: GPUParticles3D = $BaseCar/MainCar/Car2/RT/RightDrift/GPUParticles3D

func _ready() -> void:
	_net_pos = global_position
	_net_rot = global_rotation
	camera.current = (player_id == multiplayer.get_unique_id())
	name_label.text = player_name
	add_to_group("karts")
	if l_smoke:
		l_smoke.emitting = false
	if r_smoke:
		r_smoke.emitting = false
	# Удалённые карты двигаем вручную — без симуляции физики
	
	if OS.is_debug_build() and not OS.has_feature("web"):
		DevParams.params_changed.connect(_on_dev_params_changed)

func _on_dev_params_changed(data: Dictionary) -> void:
	MAX_SPEED      = data.get("MAX_SPEED",      MAX_SPEED)
	REVERSE_MAX_SPEED = data.get("REVERSE_MAX_SPEED", REVERSE_MAX_SPEED)
	ACCELERATION   = data.get("ACCELERATION",   ACCELERATION)
	REVERSE_ACCELERATION = data.get("REVERSE_ACCELERATION", REVERSE_ACCELERATION)
	COAST_DECEL    = data.get("COAST_DECEL",    COAST_DECEL)
	BRAKE_DECEL    = data.get("BRAKE_DECEL",    BRAKE_DECEL)
	HIGH_GRIP      = data.get("HIGH_GRIP",      HIGH_GRIP)
	LOW_GRIP       = data.get("LOW_GRIP",       LOW_GRIP)
	STEERING_SPEED = data.get("STEERING_SPEED", STEERING_SPEED)
	_cam_offset = Vector3(0.0,
		data.get("CAMERA_HEIGHT",    _cam_offset.y),
		absf(data.get("CAMERA_DISTANCE", absf(_cam_offset.z))))
	_cam_look_forward = data.get("CAMERA_LOOK_AHEAD", _cam_look_forward)
	if camera:
		camera.fov = data.get("FOV", camera.fov)

# ── Основной цикл ─────────────────────────────────────────────────────────────

func _physics_process(delta: float) -> void:
	if is_dead:
		return

	if multiplayer.get_unique_id() == player_id:
		# 1. Ввод
		_throttle    = Input.get_axis("move_backward", "move_forward")
		_steer_input = Input.get_axis("steer_right",   "steer_left")
		
		# 2. Гравитация
		if not is_on_floor():
			velocity.y -= 35.0 * delta
		else:
			velocity.y = 0
		
		# 3. Направление и расчет скорости
		var forward_dir = -global_transform.basis.z
		var side_dir = global_transform.basis.x
		
		var effective_throttle := _throttle
		if _throttle == 0.0 and _steer_input != 0.0:
			effective_throttle = 0.55
		var target_speed := 0.0
		if effective_throttle > 0.0:
			target_speed = effective_throttle * MAX_SPEED
		elif effective_throttle < 0.0:
			target_speed = effective_throttle * REVERSE_MAX_SPEED
		var current_fwd_speed = velocity.dot(forward_dir)
		
		if effective_throttle > 0.0:
			current_fwd_speed = move_toward(current_fwd_speed, target_speed, ACCELERATION * delta)
		elif effective_throttle < 0.0:
			current_fwd_speed = move_toward(current_fwd_speed, target_speed, REVERSE_ACCELERATION * delta)
		else:
			current_fwd_speed = lerp(current_fwd_speed, 0.0, 1.2 * delta)

		# 4. Повороты
		var rotation_speed = STEERING_SPEED
		if _throttle == 0:
			rotation_speed *= 1.25
		var steer_sign := 1.0
		if current_fwd_speed < -0.5:
			steer_sign = -1.0
		rotate_y(_steer_input * steer_sign * rotation_speed * delta)
		
		# 5. СБОРКА ВЕКТОРА (Убираем резкое выравнивание)
		var current_side_speed = velocity.dot(side_dir)
		
		var drift_resistance := 3.8 if _steer_input != 0.0 else 4.8
		current_side_speed = lerp(current_side_speed, 0.0, drift_resistance * delta)
		
		velocity = (forward_dir * current_fwd_speed) + (side_dir * current_side_speed) + Vector3(0, velocity.y, 0)
		
		move_and_slide()
		_update_vfx(delta)
		# --- КОНЕЦ БЛОКА ФИЗИКИ ---
		
		if Input.is_action_just_pressed("fire") and has_weapon:
			_fire()
		
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
				"hp":       current_hp,
				"weapon":   has_weapon,
				"peer_id":  player_id,
				"is_server": multiplayer.is_server(),
				"pos":      global_position,
			})
		_sync_timer += delta
		if _sync_timer >= SYNC_INTERVAL:
			_sync_timer = 0.0
			_rpc_sync.rpc(global_position, global_rotation, velocity)
	else:
		# Плавная интерполяция позиции удалённого карта
		global_position = global_position.lerp(_net_pos, 12.0 * delta)
		global_rotation = Vector3(
			lerp_angle(global_rotation.x, _net_rot.x, 12.0 * delta),
			lerp_angle(global_rotation.y, _net_rot.y, 12.0 * delta),
			lerp_angle(global_rotation.z, _net_rot.z, 12.0 * delta)
		)

# ── Arcade физика (_integrate_forces — правильный способ по документации Godot) ──
#
# _integrate_forces вызывается движком ВНУТРИ физического шага, после применения
# гравитации, но до разрешения контактов. Это единственное место, где безопасно
# переопределять linear_velocity/angular_velocity (docs.godotengine.org → RigidBody3D).



# ── Камера ────────────────────────────────────────────────────────────────────

func _process(delta: float) -> void:
	if multiplayer.get_unique_id() != player_id or not camera:
		return
	var flat_basis := Basis(Vector3.UP, global_rotation.y)
	var target_pos := global_position + flat_basis * _cam_offset
	if not _cam_init:
		_cam_pos  = target_pos
		_cam_init = true
	_cam_pos = _cam_pos.lerp(target_pos, 6.0 * delta)
	camera.global_position = _cam_pos
	var forward_flat := -flat_basis.z
	var look_at_pt := global_position + forward_flat * _cam_look_forward + Vector3.UP * 0.55
	camera.look_at(look_at_pt, Vector3.UP)

# ── Стрельба ──────────────────────────────────────────────────────────────────

func _fire() -> void:
	has_weapon = false
	var muzzle_transforms := _launch_visual()
	_show_fire_flash()
	if multiplayer.is_server():
		for i in range(muzzle_transforms.size()):
			var tr := muzzle_transforms[i]
			var rocket_dir := _apply_rocket_spread(tr.basis.z.normalized(), i, muzzle_transforms.size())
			_rpc_spawn_rocket.rpc(player_id, tr.origin, rocket_dir)
	else:
		_rpc_request_fire.rpc_id(1)
	_clear_launchers()

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
	var muzzle_transforms: Array[Transform3D] = kart._launch_visual()
	kart._show_fire_flash()
	for i in range(muzzle_transforms.size()):
		var tr := muzzle_transforms[i]
		var rocket_dir: Vector3 = kart._apply_rocket_spread(tr.basis.z.normalized(), i, muzzle_transforms.size())
		_rpc_spawn_rocket.rpc(shooter_id, tr.origin, rocket_dir)
	kart._clear_launchers()

@rpc("authority", "call_local", "reliable")
func _rpc_spawn_rocket(shooter_id: int, pos: Vector3, dir: Vector3) -> void:
	var rocket_scene := load("res://scenes/rocket.tscn") as PackedScene
	var rocket := rocket_scene.instantiate()
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

# ── Дымок при скольжении ──────────────────────────────────────────────────────
func _update_vfx(delta: float) -> void:
	if not l_smoke or not r_smoke: return
	
	var local_velocity = global_transform.basis.inverse() * velocity
	var forward_speed = abs(local_velocity.z)
	var side_speed = abs(local_velocity.x)
	var hard_steer: bool = abs(_steer_input) > 0.55
	var moving_drift: bool = forward_speed > 4.0 and side_speed > 2.2
	var spin_turn: bool = abs(_throttle) < 0.15 and abs(_steer_input) > 0.8 and forward_speed > 1.2
	var is_drifting := is_on_floor() and hard_steer and (moving_drift or spin_turn)

	if l_smoke.emitting != is_drifting:
		l_smoke.emitting = is_drifting
	if r_smoke.emitting != is_drifting:
		r_smoke.emitting = is_drifting

	l_drift.visible = true
	r_drift.visible = true

# ── Сетевая синхронизация ─────────────────────────────────────────────────────

@rpc("any_peer", "unreliable")
func _rpc_sync(pos: Vector3, rot: Vector3, _lvel: Vector3) -> void:
	if multiplayer.get_remote_sender_id() != player_id:
		return
	_net_pos = pos
	_net_rot = rot

# ── Оружие / урон ─────────────────────────────────────────────────────────────

@rpc("authority", "call_local", "reliable")
func give_weapon() -> void:
	if not has_weapon:
		has_weapon = true
		_spawn_launchers()

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

func take_damage(damage: int, attacker_id: int) -> void:
	if not multiplayer.is_server():
		return
	GameManager.deal_damage(player_id, attacker_id, damage)
	_rpc_update_hp.rpc(GameManager.players.get(player_id, {}).get("hp", 0))

@rpc("authority", "call_local", "reliable")
func _rpc_update_hp(new_hp: int) -> void:
	current_hp = new_hp
	if current_hp <= 0 and not is_dead:
		_die()

func _die() -> void:
	is_dead = true
	visible = false
	velocity  = Vector3.ZERO

@rpc("authority", "call_local", "reliable")
func respawn(spawn_pos: Vector3) -> void:
	is_dead = false
	visible = true
	current_hp    = GameManager.MAX_HP
	global_position  = spawn_pos
	velocity  = Vector3.ZERO
	_throttle    = 0.0
	_steer_input = 0.0
