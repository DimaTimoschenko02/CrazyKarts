extends Node3D

const KART_SCENE := preload("res://scenes/player_kart.tscn")

const SPAWN_POINTS: Array[Vector3] = [
	Vector3( 7, 3.5,  0),
	Vector3(-7, 3.5,  0),
	Vector3( 0, 3.5,  7),
	Vector3( 0, 3.5, -7),
	Vector3( 5, 3.5,  5),
	Vector3(-5, 3.5, -5),
	Vector3( 5, 3.5, -5),
	Vector3(-5, 3.5,  5),
]

var _spawn_index: int = 0
var _players: Dictionary = {}  # { pid: { name: String, pos: Vector3 } }
var synced_peers: Array[int] = []

@onready var karts: Node3D = $Karts
@onready var hud: CanvasLayer = $HUD


func _ready() -> void:
	print("[GameWorld] _ready: is_server=", multiplayer.is_server(), " my_id=", multiplayer.get_unique_id())

	if multiplayer.is_server():
		print("[GameWorld] Server mode - spawning host kart")
		synced_peers.append(1)
		_spawn_for_player(1, PlayerData.my_name)
		NetworkManager.player_disconnected.connect(_on_player_disconnected)
	else:
		print("[GameWorld] Client mode - telling server we're ready")
		_register.rpc_id(1, PlayerData.my_name)

	GameManager.scores_updated.connect(hud.update_scores)
	StateManager.kart_state_changed.connect(_on_kart_state_changed)


# ── Client → Server: "я загрузился, вот моё имя" ────────────────────────────

@rpc("any_peer", "call_remote", "reliable")
func _register(player_name: String) -> void:
	if not multiplayer.is_server():
		return
	var pid := multiplayer.get_remote_sender_id()
	print("[GameWorld] _register from pid=", pid, " name=", player_name)

	for existing_pid in _players:
		var info = _players[existing_pid]
		var kart_node = karts.get_node_or_null(str(existing_pid))
		var pos = kart_node.global_position if kart_node else info["pos"]
		_rpc_spawn_kart.rpc_id(pid, existing_pid, info["name"], pos)

	_spawn_for_player(pid, player_name)
	synced_peers.append(pid)
	# Send current states of all karts to new peer
	StateManager.sync_state_to_peer(pid)


# ── Spawning ──────────────────────────────────────────────────────────────────

func _spawn_for_player(pid: int, player_name: String) -> void:
	print("[GameWorld] Spawning kart for pid=", pid, " name=", player_name)
	GameManager.register_player(pid, player_name)
	var idx := _spawn_index
	_spawn_index += 1
	var spawn_pos := SPAWN_POINTS[idx % SPAWN_POINTS.size()]

	_players[pid] = { "name": player_name, "pos": spawn_pos }

	_rpc_spawn_kart.rpc(pid, player_name, spawn_pos)


@rpc("authority", "call_local", "reliable")
func _rpc_spawn_kart(pid: int, player_name: String, spawn_pos: Vector3) -> void:
	if karts.has_node(str(pid)):
		return
	print("[GameWorld] _rpc_spawn_kart: pid=", pid, " name=", player_name)
	var kart := KART_SCENE.instantiate()
	kart.player_id   = pid
	kart.player_name = player_name
	kart.name        = str(pid)
	kart.position    = spawn_pos
	karts.add_child(kart, true)


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
	var spawn_pos := SPAWN_POINTS[randi() % SPAWN_POINTS.size()]
	kart.respawn.rpc(spawn_pos)
	# Start invuln timer (RESPAWNING → DRIVING)
	StateManager.server_respawn_complete(pid)


# ── Player disconnect ─────────────────────────────────────────────────────────

func _on_player_disconnected(pid: int) -> void:
	if not multiplayer.is_server():
		return
	GameManager.unregister_player(pid)
	_players.erase(pid)
	synced_peers.erase(pid)
	var kart := karts.get_node_or_null(str(pid))
	if kart:
		kart.queue_free()
