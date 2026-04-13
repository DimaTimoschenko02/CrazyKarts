class_name RocketProjectile extends BaseProjectile

const EXPLOSION_SCENE := preload("res://scenes/explosion_rockets.tscn")


func _on_hit(body: Node) -> void:
	if _age < 0.1:
		return
	_apply_aoe_damage(global_position)
	_spawn_explosion_vfx(global_position)
	exploded.emit(global_position)
	_die()


func _on_lifetime_expired() -> void:
	_apply_aoe_damage(global_position)
	_spawn_explosion_vfx(global_position)
	exploded.emit(global_position)
	_die()


func _spawn_explosion_vfx(pos: Vector3) -> void:
	var scene := get_tree().current_scene
	if not scene:
		return
	var explosion := EXPLOSION_SCENE.instantiate() as Node3D
	scene.add_child(explosion)
	explosion.global_position = pos
