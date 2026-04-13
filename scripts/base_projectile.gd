class_name BaseProjectile extends Area3D

signal exploded(pos: Vector3)

var config: ProjectileResource
var shooter_id: int = 0
var direction: Vector3 = Vector3.FORWARD
var _age: float = 0.0
var _dead: bool = false


func setup(proj_config: ProjectileResource, shooter: int, dir: Vector3) -> void:
	config = proj_config
	shooter_id = shooter
	direction = dir.normalized()


func _ready() -> void:
	add_to_group("rockets")
	body_entered.connect(_on_body_entered_internal)
	if direction == Vector3.ZERO:
		direction = -global_transform.basis.z
	direction = direction.normalized()

	if OS.is_debug_build() and not OS.has_feature("web"):
		DevParams.params_changed.connect(_on_dev_params_changed)
		if not DevParams.get_data().is_empty():
			_on_dev_params_changed(DevParams.get_data())


func _physics_process(delta: float) -> void:
	if _dead or not config:
		return
	_age += delta
	if _age >= config.lifetime:
		_on_lifetime_expired()
		return
	_move(delta)


func _move(delta: float) -> void:
	global_position += direction * config.speed * delta
	if config.gravity_scale > 0.0:
		direction.y -= 9.8 * config.gravity_scale * delta


func _on_body_entered_internal(body: Node) -> void:
	if _dead:
		return
	if body.is_in_group("rockets"):
		return
	_on_hit(body)


func _on_hit(_body: Node3D) -> void:
	pass


func _on_lifetime_expired() -> void:
	_die()


func _die() -> void:
	if _dead:
		return
	_dead = true
	set_physics_process(false)
	set_deferred("monitoring", false)
	queue_free()


func _apply_aoe_damage(center: Vector3) -> void:
	if not multiplayer.is_server():
		return
	for kart in get_tree().get_nodes_in_group("karts"):
		if not config.self_damage and kart.player_id == shooter_id:
			continue
		var dist := center.distance_to(kart.global_position)
		if dist > config.aoe_radius:
			continue
		var falloff := maxf(0.0, 1.0 - dist / config.aoe_radius)
		var final_dmg := floori(config.base_damage * falloff)
		if final_dmg <= 0:
			continue
		var info := DamageInfo.create(
			DamageInfo.Type.AOE_EXPLOSION,
			final_dmg,
			shooter_id,
			center,
			config.weapon_name
		)
		var health: HealthComponent = kart.get_node_or_null("HealthComponent")
		if health:
			health.apply_damage(info)


func _apply_point_damage(target: Node3D) -> void:
	if not multiplayer.is_server():
		return
	var info := DamageInfo.create(
		DamageInfo.Type.PROJECTILE,
		config.base_damage,
		shooter_id,
		global_position,
		config.weapon_name
	)
	var health: HealthComponent = target.get_node_or_null("HealthComponent")
	if health:
		health.apply_damage(info)


func _on_dev_params_changed(data: Dictionary) -> void:
	if not config:
		return
	config.speed = data.get("ROCKET_SPEED", config.speed)
	config.base_damage = data.get("DAMAGE", config.base_damage)
	config.aoe_radius = data.get("EXPLOSION_RADIUS", config.aoe_radius)
	config.lifetime = data.get("ROCKET_LIFETIME", config.lifetime)
