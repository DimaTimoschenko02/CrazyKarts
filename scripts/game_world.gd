extends Node3D

const KART_SCENE := preload("res://scenes/player_kart.tscn")
const CameraRigScript := preload("res://scripts/camera_rig.gd")

var _players: Dictionary = {}  # { pid: { name: String, pos: Vector3 } }
var synced_peers: Array[int] = []

@onready var karts: Node3D = $Karts
@onready var hud: CanvasLayer = $HUD
@onready var spawn_manager: SpawnManager = $SpawnManager
@onready var projectiles: Node3D = $Projectiles


func _ready() -> void:
	print("[GameWorld] _ready: is_server=", multiplayer.is_server(), " my_id=", multiplayer.get_unique_id())

	if multiplayer.is_server():
		# Headless room-server hosts the world but is NOT a player.
		# Dev autohost (no master) keeps the legacy host-kart behavior so a
		# single Godot window remains playable.
		var is_dedicated_server: bool = RoomsReporter and RoomsReporter.is_room_server
		if is_dedicated_server:
			print("[GameWorld] Dedicated room-server — no host kart")
		else:
			print("[GameWorld] Dev host mode — spawning host kart")
			synced_peers.append(1)
			_spawn_for_player(1, ProfileManager.my_nick)
		NetworkManager.player_disconnected.connect(_on_player_disconnected)
	else:
		print("[GameWorld] Client mode - telling server we're ready")
		_register.rpc_id(1, ProfileManager.my_nick)

	StateManager.kart_state_changed.connect(_on_kart_state_changed)


func _exit_tree() -> void:
	if StateManager.kart_state_changed.is_connected(_on_kart_state_changed):
		StateManager.kart_state_changed.disconnect(_on_kart_state_changed)
	if multiplayer.is_server() and NetworkManager.player_disconnected.is_connected(_on_player_disconnected):
		NetworkManager.player_disconnected.disconnect(_on_player_disconnected)


# ── Client → Server: "я загрузился, вот моё имя" ────────────────────────────

@rpc("any_peer", "call_remote", "reliable")
func _register(player_name: String) -> void:
	if not multiplayer.is_server():
		return
	var pid := multiplayer.get_remote_sender_id()
	print("[GameWorld] _register from pid=", pid, " name=", player_name)

	# 1. Send full world state FIRST (before spawning karts)
	_rpc_world_state.rpc_id(pid, _build_world_state())

	# 2. Spawn existing karts for new client
	for existing_pid in _players:
		var info = _players[existing_pid]
		var kart_node = karts.get_node_or_null(str(existing_pid))
		var pos = kart_node.global_position if kart_node else info["pos"]
		var rot: float = kart_node.rotation.y if kart_node else 0.0
		_rpc_spawn_kart.rpc_id(pid, existing_pid, info["name"], pos, rot)

	# 3. Spawn new player's kart (on all clients)
	_spawn_for_player(pid, player_name)

	# 4. Peer ready for sync RPCs (all spawns sent reliable → arrive in order)
	synced_peers.append(pid)

	# 5. Send current states
	StateManager.sync_state_to_peer(pid)


# ── World State (late join sync) ─────────────────────────────────────────────

func _build_world_state() -> Dictionary:
	var pickup_states := {}
	for pickup in get_tree().get_nodes_in_group("pickups"):
		if pickup.has_method("_set_state"):
			pickup_states[pickup.get_path()] = pickup.active

	var hp_states := {}
	for pid in GameManager.players:
		var kart := karts.get_node_or_null(str(pid))
		if kart:
			var health: HealthComponent = kart.get_node_or_null("HealthComponent")
			if health:
				hp_states[pid] = health.current_hp

	return {
		"scores": GameManager.players.duplicate(true),
		"pickups": pickup_states,
		"match_state": StateManager.get_match_state(),
		"hp_states": hp_states,
	}


var _pending_hp_states: Dictionary = {}

@rpc("authority", "call_remote", "reliable")
func _rpc_world_state(state: Dictionary) -> void:
	print("[GameWorld] Received world_state")
	if "scores" in state:
		GameManager.players = state["scores"]
		GameManager.scores_updated.emit(GameManager.players)

	if "pickups" in state:
		for path in state["pickups"]:
			var pickup := get_node_or_null(path)
			if pickup and pickup.has_method("_set_state"):
				pickup._set_state(state["pickups"][path])

	if "hp_states" in state:
		_pending_hp_states = state["hp_states"]


func _apply_pending_hp(pid: int) -> void:
	if pid not in _pending_hp_states:
		return
	var kart := karts.get_node_or_null(str(pid))
	if not kart:
		return
	var health: HealthComponent = kart.get_node_or_null("HealthComponent")
	if health:
		health.current_hp = clampi(_pending_hp_states[pid], 0, health.max_hp)
		health.hp_changed.emit(health.current_hp, health.max_hp)
	_pending_hp_states.erase(pid)


# ── Spawning ──────────────────────────────────────────────────────────────────

func _spawn_for_player(pid: int, player_name: String) -> void:
	print("[GameWorld] Spawning kart for pid=", pid, " name=", player_name)
	GameManager.register_player(pid, player_name)
	var spawn_pos: Vector3 = spawn_manager.get_initial_spawn_point()
	var spawn_rot: float = _face_center_rotation(spawn_pos)

	_players[pid] = { "name": player_name, "pos": spawn_pos }

	_rpc_spawn_kart.rpc(pid, player_name, spawn_pos, spawn_rot)


@rpc("authority", "call_local", "reliable")
func _rpc_spawn_kart(pid: int, player_name: String, spawn_pos: Vector3, spawn_rot: float = 0.0) -> void:
	if karts.has_node(str(pid)):
		return
	print("[GameWorld] _rpc_spawn_kart: pid=", pid, " name=", player_name)
	var kart := KART_SCENE.instantiate()
	kart.player_id   = pid
	kart.player_name = player_name
	kart.name        = str(pid)
	kart.position    = spawn_pos
	kart.rotation.y  = spawn_rot
	karts.add_child(kart, true)
	call_deferred("_apply_pending_hp", pid)

	# CameraRig for local player only
	if pid == multiplayer.get_unique_id():
		_spawn_camera_rig(kart)


# ── State changes ────────────────────────────────────────────────────────────

func _on_kart_state_changed(peer_id: int, _from: GameStates.KartState, to: GameStates.KartState) -> void:
	if to == GameStates.KartState.RESPAWNING:
		_on_kart_respawning(peer_id)


func _on_kart_respawning(pid: int) -> void:
	if not multiplayer.is_server():
		return
	var kart := karts.get_node_or_null(str(pid)) as CharacterBody3D
	if not kart:
		return
	var spawn_pos: Vector3 = spawn_manager.get_respawn_point(karts)
	var spawn_rot: float = _face_center_rotation(spawn_pos)
	kart.respawn.rpc(spawn_pos, spawn_rot)
	StateManager.server_respawn_complete(pid)


func _face_center_rotation(spawn_pos: Vector3) -> float:
	var dir := Vector3.ZERO - spawn_pos
	dir.y = 0.0
	if dir.is_zero_approx():
		return 0.0
	return atan2(dir.x, dir.z)


# ── Player disconnect ─────────────────────────────────────────────────────────

func _on_player_disconnected(pid: int) -> void:
	if not multiplayer.is_server():
		return
	# Broadcast disconnect to all clients BEFORE cleanup
	_rpc_kart_disconnect.rpc(pid)
	GameManager.unregister_player(pid)
	_players.erase(pid)
	synced_peers.erase(pid)
	var kart := karts.get_node_or_null(str(pid))
	if kart:
		kart.queue_free()


func _spawn_camera_rig(kart: CharacterBody3D) -> void:
	if get_node_or_null("CameraRig"):
		return
	var rig := Node3D.new()
	rig.name = "CameraRig"
	rig.set_script(CameraRigScript)

	var shake_node := Node3D.new()
	shake_node.name = "ShakeNode"

	var camera := Camera3D.new()
	camera.name = "Camera3D"

	shake_node.add_child(camera)
	rig.add_child(shake_node)
	add_child(rig)

	rig.call_deferred("set_target", kart)


@rpc("authority", "call_remote", "reliable")
func _rpc_kart_disconnect(pid: int) -> void:
	print("[GameWorld] Kart disconnect: pid=", pid)
	GameManager.players.erase(pid)
	var kart := karts.get_node_or_null(str(pid))
	if kart:
		kart.queue_free()
