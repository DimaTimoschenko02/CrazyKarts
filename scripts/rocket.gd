extends Area3D

var SPEED            : float = 45.0
var DAMAGE           : int   = 50
var EXPLOSION_RADIUS : float = 3.5
var LIFETIME         : float = 6.0

var shooter_id: int = 0
var direction: Vector3 = Vector3.ZERO
var _age: float = 0.0
var _exploded: bool = false
var _trail_timer: float = 0.015
const EXPLOSION_SCENE := preload("res://scenes/explosion_rockets.tscn")

func _ready() -> void:
	add_to_group("rockets")
	body_entered.connect(_on_body_entered)
	if direction == Vector3.ZERO:
		direction = -global_transform.basis.z
	direction = direction.normalized()
	if OS.is_debug_build() and not OS.has_feature("web"):
		DevParams.params_changed.connect(_on_dev_params_changed)

func _on_dev_params_changed(data: Dictionary) -> void:
	SPEED            = data.get("ROCKET_SPEED",      SPEED)
	DAMAGE           = data.get("DAMAGE",             DAMAGE)
	EXPLOSION_RADIUS = data.get("EXPLOSION_RADIUS",   EXPLOSION_RADIUS)
	LIFETIME         = data.get("ROCKET_LIFETIME",    LIFETIME)

func _physics_process(delta: float) -> void:
	if _exploded:
		return
	_age += delta
	if _age >= LIFETIME:
		_explode()
		return
	global_position += direction * SPEED * delta
	_trail_timer += delta
	if _trail_timer >= 0.015:
		_trail_timer = 0.0
		_spawn_trail()

func _spawn_trail() -> void:
	var p := MeshInstance3D.new()
	var sm := SphereMesh.new()
	sm.radius = 0.14
	sm.height = 0.28
	var mat := StandardMaterial3D.new()
	mat.albedo_color = Color(1.0, 0.45, 0.05, 0.85)
	mat.emission_enabled = true
	mat.emission = Color(1.0, 0.25, 0.0)
	mat.emission_energy_multiplier = 5.0
	mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	sm.material = mat
	p.mesh = sm
	get_tree().current_scene.add_child(p)
	p.global_position = global_position - direction * 0.35
	var tw := p.create_tween()
	tw.set_parallel(true)
	tw.tween_property(p, "scale", Vector3.ZERO, 0.22)
	tw.tween_callback(p.queue_free).set_delay(0.22)

func _on_body_entered(body: Node) -> void:
	if _exploded or _age < 0.1:
		return
	if body.is_in_group("rockets"):
		return
	if body is RigidBody3D and body.player_id == shooter_id:
		return
	_explode()

func _explode() -> void:
	if _exploded:
		return
	_exploded = true
	var hit_pos := global_position

	if multiplayer.is_server():
		for kart in get_tree().get_nodes_in_group("karts"):
			if hit_pos.distance_to(kart.global_position) <= EXPLOSION_RADIUS:
				kart.take_damage(DAMAGE, shooter_id)

	_spawn_explosion_vfx(hit_pos)
	queue_free()

func _spawn_explosion_vfx(pos: Vector3) -> void:
	var scene := get_tree().current_scene
	var explosion := EXPLOSION_SCENE.instantiate() as Node3D
	scene.add_child(explosion)
	explosion.global_position = pos
