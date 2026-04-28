extends Node

## Server-side autoload (only active when master spawns this Godot process).
## Parses room metadata from cmdline + opens a tiny HTTP healthcheck endpoint
## that the master polls every few seconds.

const IDLE_EXIT_GRACE_S: float = 60.0  # local hint; master is the source of truth

var room_code: String = ""
var map_name: String = "map_1"
var max_players: int = 8
var duration_min: int = 5
var healthcheck_port: int = 0
var internal_token: String = ""
var is_room_server: bool = false  # true only when master spawned us

var _tcp_server: TCPServer
var _idle_since_ms: int = -1


func _ready() -> void:
	_parse_cmdline()
	print("[RoomsReporter] cmdline parsed: healthcheck_port=", healthcheck_port, " room=", room_code)
	if healthcheck_port <= 0:
		# Not spawned by master — autoload is a no-op (dev autohost / desktop join).
		return
	is_room_server = true
	_tcp_server = TCPServer.new()
	var err := _tcp_server.listen(healthcheck_port, "127.0.0.1")
	if err != OK:
		push_error("[RoomsReporter] Failed to bind healthcheck on port %d: %s" % [healthcheck_port, err])
		return
	print("[RoomsReporter] room=", room_code,
		" port=", NetworkManager.port if Engine.has_singleton("NetworkManager") else "?",
		" healthcheck=", healthcheck_port,
		" max_players=", max_players,
		" duration_min=", duration_min)


func _parse_cmdline() -> void:
	var args := OS.get_cmdline_user_args()
	var i := 0
	while i < args.size():
		var a: String = args[i]
		var has_next: bool = i + 1 < args.size()
		match a:
			"--room":
				if has_next:
					room_code = args[i + 1]; i += 2; continue
			"--map":
				if has_next:
					map_name = args[i + 1]; i += 2; continue
			"--max-players":
				if has_next:
					max_players = int(args[i + 1]); i += 2; continue
			"--duration-min":
				if has_next:
					duration_min = int(args[i + 1]); i += 2; continue
			"--healthcheck-port":
				if has_next:
					healthcheck_port = int(args[i + 1]); i += 2; continue
			"--internal-token":
				if has_next:
					internal_token = args[i + 1]; i += 2; continue
		# Equal-form: --key=value
		if a.begins_with("--room="):
			room_code = a.substr(7)
		elif a.begins_with("--map="):
			map_name = a.substr(6)
		elif a.begins_with("--max-players="):
			max_players = int(a.substr(14))
		elif a.begins_with("--duration-min="):
			duration_min = int(a.substr(15))
		elif a.begins_with("--healthcheck-port="):
			healthcheck_port = int(a.substr(19))
		elif a.begins_with("--internal-token="):
			internal_token = a.substr(17)
		i += 1


func _process(_delta: float) -> void:
	if not is_room_server:
		return
	_serve_one_request()
	_check_idle_exit()


func _serve_one_request() -> void:
	if _tcp_server == null or not _tcp_server.is_listening():
		return
	if not _tcp_server.is_connection_available():
		return
	var stream := _tcp_server.take_connection()
	if stream == null:
		return
	# Wait briefly for request bytes
	var buf := PackedByteArray()
	var deadline_ms := Time.get_ticks_msec() + 200
	while Time.get_ticks_msec() < deadline_ms:
		stream.poll()
		var avail := stream.get_available_bytes()
		if avail > 0:
			buf.append_array(stream.get_data(avail)[1])
			var as_text := buf.get_string_from_utf8()
			if as_text.contains("\r\n\r\n"):
				break
		else:
			OS.delay_msec(5)
	var body := _build_status_json()
	var response := "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s" % [body.length(), body]
	stream.put_data(response.to_utf8_buffer())
	stream.disconnect_from_host()


func _build_status_json() -> String:
	var match_state: String = "WAITING"
	if Engine.has_singleton("StateManager") or get_node_or_null("/root/StateManager") != null:
		match_state = _state_to_label(StateManager.get_match_state()) if StateManager else "WAITING"
	var current_players := _count_players()
	var data := {
		"state": match_state,
		"players": current_players,
		"room_code": room_code,
		"max_players": max_players,
		"duration_min": duration_min,
		"map": map_name,
	}
	return JSON.stringify(data)


func _state_to_label(state: int) -> String:
	if not Engine.has_singleton("GameStates") and get_node_or_null("/root/GameStates") == null:
		return "WAITING"
	match state:
		GameStates.MatchState.WAITING:    return "WAITING"
		GameStates.MatchState.COUNTDOWN:  return "WAITING"
		GameStates.MatchState.PLAYING:    return "IN_MATCH"
		GameStates.MatchState.ENDED:      return "POST_MATCH"
	return "WAITING"


func _count_players() -> int:
	if get_node_or_null("/root/GameManager") == null:
		return 0
	# GameManager.players is { pid: { ... } } populated by register_player()
	if "players" in GameManager:
		return GameManager.players.size()
	return 0


func _check_idle_exit() -> void:
	if not multiplayer or multiplayer.multiplayer_peer == null:
		return
	var connected_count := 0
	if multiplayer.multiplayer_peer is WebSocketMultiplayerPeer:
		connected_count = multiplayer.get_peers().size()
	var now := Time.get_ticks_msec()
	if connected_count == 0:
		if _idle_since_ms < 0:
			_idle_since_ms = now
		elif (now - _idle_since_ms) > int(IDLE_EXIT_GRACE_S * 1000):
			print("EXIT_REQUESTED: idle for %.1fs" % ((now - _idle_since_ms) / 1000.0))
			_idle_since_ms = now  # avoid spam
	else:
		_idle_since_ms = -1
