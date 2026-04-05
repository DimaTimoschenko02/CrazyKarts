extends Area3D

const RESPAWN_TIME := 10.0

var active: bool = true

@onready var pickup_mesh: MeshInstance3D = $PickupMesh


func _ready() -> void:
	body_entered.connect(_on_body_entered)
	body_exited.connect(_on_body_exited)


func _process(delta: float) -> void:
	if active:
		pickup_mesh.rotate_y(delta * 2.0)


func _on_body_entered(body: Node) -> void:
	print("[Pickup:%s] body_entered: %s is_server=%s active=%s" % [name, body.name, multiplayer.is_server(), active])
	if not multiplayer.is_server():
		return
	if not active:
		return
	if not body is CharacterBody3D:
		return
	_try_give_weapon(body)


func _on_body_exited(body: Node) -> void:
	if body is CharacterBody3D:
		print("[Pickup:%s] body_exited: %s" % [name, body.name])


func _try_give_weapon(body: CharacterBody3D) -> void:
	var pid: int = body.player_id
	print("[Pickup:%s] _try_give_weapon: body=%s weapon_state=%d" % [name, body.name, StateManager.get_weapon_state(pid)])
	if StateManager.get_weapon_state(pid) != GameStates.WeaponState.EMPTY:
		return
	if not StateManager.can_move(pid):
		return

	StateManager.server_give_weapon(pid)
	_set_state(false)
	_rpc_set_state.rpc(false)
	print("[Pickup:%s] Weapon given! Respawning in %.0fs" % [name, RESPAWN_TIME])

	get_tree().create_timer(RESPAWN_TIME).timeout.connect(func():
		if not is_instance_valid(self):
			return
		print("[Pickup:%s] Respawn timer fired. Re-enabling." % name)
		_set_state(true)
		_rpc_set_state.rpc(true)
		await get_tree().physics_frame
		await get_tree().physics_frame
		_try_give_from_overlaps()
	)


func _try_give_from_overlaps() -> void:
	if not multiplayer.is_server() or not active:
		return
	var bodies := get_overlapping_bodies()
	print("[Pickup:%s] _try_give_from_overlaps: %d bodies overlapping" % [name, bodies.size()])
	for body in bodies:
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
