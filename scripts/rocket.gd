extends Area3D

var SPEED            : float = 45.0
var DAMAGE           : int   = 40
var EXPLOSION_RADIUS : float = 3.5
var LIFETIME         : float = 6.0

var shooter_id: int = 0
var direction: Vector3 = Vector3.ZERO
var _age: float = 0.0
var _exploded: bool = false
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

func _on_body_entered(body: Node) -> void:
	if _exploded or _age < 0.02:
		return
	if body.is_in_group("rockets"):
		return
	if body is CharacterBody3D and body.player_id == shooter_id:
		return
	_explode()

func _explode() -> void:
	if _exploded:
		return
	_exploded = true
	var hit_pos := global_position

	if multiplayer.is_server():
		for kart in get_tree().get_nodes_in_group("karts"):
			var dist := hit_pos.distance_to(kart.global_position)
			if dist <= EXPLOSION_RADIUS:
				var falloff_damage := floori(DAMAGE * maxf(0.0, 1.0 - (dist / EXPLOSION_RADIUS)))
				if falloff_damage > 0:
					kart.take_damage(falloff_damage, shooter_id, DamageInfo.Type.AOE_EXPLOSION, hit_pos)

	_spawn_explosion_vfx(hit_pos)
	queue_free()

func _spawn_explosion_vfx(pos: Vector3) -> void:
	var scene := get_tree().current_scene
	var explosion := EXPLOSION_SCENE.instantiate() as Node3D
	scene.add_child(explosion)
	explosion.global_position = pos
