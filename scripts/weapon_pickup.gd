extends Area3D

const RESPAWN_TIME := 10.0

var active: bool = true

@onready var pickup_mesh: MeshInstance3D = $PickupMesh

func _ready() -> void:
	body_entered.connect(_on_body_entered)

func _process(delta: float) -> void:
	if active:
		pickup_mesh.rotate_y(delta * 2.0)

func _on_body_entered(body: Node) -> void:
	if not multiplayer.is_server():
		return
	if not active:
		return
	if not body is CharacterBody3D:
		return
	_try_give_weapon(body)

func _try_give_weapon(body: CharacterBody3D) -> void:
	if body.has_weapon:
		return

	body.give_weapon.rpc()
	_set_state(false)
	_rpc_set_state.rpc(false)

	get_tree().create_timer(RESPAWN_TIME).timeout.connect(func():
		_set_state(true)
		_rpc_set_state.rpc(true)
		call_deferred("_try_give_from_overlaps")
	)

func _try_give_from_overlaps() -> void:
	if not multiplayer.is_server() or not active:
		return
	for body in get_overlapping_bodies():
		if body is CharacterBody3D:
			_try_give_weapon(body)
			return

func _set_state(on: bool) -> void:
	active = on
	pickup_mesh.visible = on
	set_deferred("monitoring", on)

@rpc("authority", "call_remote")
func _rpc_set_state(on: bool) -> void:
	_set_state(on)
