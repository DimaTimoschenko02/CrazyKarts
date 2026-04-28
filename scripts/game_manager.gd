extends Node

# ── Signals ───────────────────────────────────────────────────────────────────
signal scores_updated(scores: Dictionary)
signal player_died(victim_id: int, killer_id: int)
signal match_ended
signal match_timer_tick(seconds_remaining: int, duration_total: int)
signal match_finished(results: Dictionary)

# ── State ─────────────────────────────────────────────────────────────────────
# { player_id: stat_dict } — stat_dict tracked server-side, broadcast on kill.
var players: Dictionary = {}

var _match_started_at: int = 0
var _match_id: String = ""
var _match_timer: Timer = null      # one-shot, fires _end_match after duration
var _match_tick_timer: Timer = null # repeating 1Hz, broadcasts remaining time
var _match_in_progress: bool = false
var _match_duration_s: int = 0
var _match_finished_results: Dictionary = {}


func _ready() -> void:
	# ALWAYS so RPCs and timers keep flowing while game is paused.
	process_mode = Node.PROCESS_MODE_ALWAYS
	if Engine.has_singleton("EventBus") or get_node_or_null("/root/EventBus") != null:
		EventBus.damage_dealt.connect(_on_damage_dealt)


# ── Player Registration ───────────────────────────────────────────────────────
func register_player(player_id: int, player_name: String) -> void:
	players[player_id] = _empty_stat_block(player_name)
	StateManager.register_kart(player_id)
	print("[GameManager] Registered: ", player_name, " (id=", player_id, ")")
	if multiplayer.is_server() and not _match_in_progress:
		_begin_match_if_first_player()


func _empty_stat_block(player_name: String) -> Dictionary:
	return {
		"name": player_name,
		"kills": 0,
		"deaths": 0,
		"assists": 0,
		"damage_dealt": 0,
		"damage_taken": 0,
		"shots_fired": 0,
		"shots_hit": 0,
	}


func unregister_player(player_id: int) -> void:
	StateManager.unregister_kart(player_id)
	players.erase(player_id)


# ── Kill / Assist Recording ───────────────────────────────────────────────────
func record_kill(victim_id: int, killer_id: int, info: DamageInfo) -> void:
	if not multiplayer.is_server():
		return
	if victim_id in players:
		players[victim_id]["deaths"] += 1
	if killer_id in players and killer_id != victim_id:
		players[killer_id]["kills"] += 1
	_rpc_kill.rpc(victim_id, killer_id, players)
	StateManager.server_kill_kart(victim_id, killer_id)
	EventBus.player_killed.emit(victim_id, killer_id, info)


func record_assist(assister_id: int, victim_id: int) -> void:
	if not multiplayer.is_server():
		return
	if assister_id in players:
		players[assister_id]["assists"] += 1
	EventBus.player_assisted.emit(assister_id, victim_id)


func record_shot_fired(pid: int) -> void:
	if not multiplayer.is_server():
		return
	if pid in players:
		players[pid]["shots_fired"] += 1


func record_shot_hit(pid: int) -> void:
	if not multiplayer.is_server():
		return
	if pid in players:
		players[pid]["shots_hit"] += 1


func _on_damage_dealt(attacker_id: int, victim_id: int, _info: DamageInfo, final_amount: int) -> void:
	if not multiplayer.is_server():
		return
	if attacker_id in players and attacker_id != victim_id:
		players[attacker_id]["damage_dealt"] += final_amount
	if victim_id in players:
		players[victim_id]["damage_taken"] += final_amount


# ── Network Sync ──────────────────────────────────────────────────────────────
@rpc("authority", "call_local", "reliable")
func _rpc_kill(victim_id: int, killer_id: int, new_scores: Dictionary) -> void:
	players = new_scores
	player_died.emit(victim_id, killer_id)
	scores_updated.emit(players)


# ── Utilities ─────────────────────────────────────────────────────────────────
func get_scores_sorted() -> Array:
	var arr := []
	for pid in players:
		arr.append({"id": pid, "data": players[pid]})
	arr.sort_custom(func(a, b): return a["data"]["kills"] > b["data"]["kills"])
	return arr


func get_match_duration_s() -> int:
	return _match_duration_s


func is_match_finished() -> bool:
	return not _match_finished_results.is_empty()


func get_match_results() -> Dictionary:
	return _match_finished_results


# ── Match lifecycle (server-side) ─────────────────────────────────────────────

func _begin_match_if_first_player() -> void:
	if not multiplayer.is_server():
		return
	if _match_in_progress:
		return
	var duration_min: int = 5
	if RoomsReporter and RoomsReporter.duration_min > 0:
		duration_min = RoomsReporter.duration_min
	_match_in_progress = true
	_match_started_at = int(Time.get_unix_time_from_system())
	_match_id = _generate_uuid_v4()
	_match_duration_s = duration_min * 60
	_match_finished_results = {}

	if _match_timer:
		_match_timer.queue_free()
	_match_timer = Timer.new()
	_match_timer.one_shot = true
	_match_timer.wait_time = float(_match_duration_s)
	add_child(_match_timer)
	_match_timer.timeout.connect(_end_match)
	_match_timer.start()

	if _match_tick_timer:
		_match_tick_timer.queue_free()
	_match_tick_timer = Timer.new()
	_match_tick_timer.one_shot = false
	_match_tick_timer.wait_time = 1.0
	add_child(_match_tick_timer)
	_match_tick_timer.timeout.connect(_on_tick)
	_match_tick_timer.start()

	# Broadcast initial state so clients see full timer immediately.
	_rpc_match_timer.rpc(_match_duration_s, _match_duration_s)
	match_timer_tick.emit(_match_duration_s, _match_duration_s)
	print("[GameManager] Match begun: id=", _match_id, " duration_s=", _match_duration_s)


func _on_tick() -> void:
	if not multiplayer.is_server() or not _match_in_progress:
		return
	if _match_timer == null:
		return
	var remaining: int = int(ceil(_match_timer.time_left))
	_rpc_match_timer.rpc(remaining, _match_duration_s)
	match_timer_tick.emit(remaining, _match_duration_s)


@rpc("authority", "call_remote", "unreliable_ordered")
func _rpc_match_timer(seconds_remaining: int, duration_total: int) -> void:
	_match_duration_s = duration_total
	match_timer_tick.emit(seconds_remaining, duration_total)


func _end_match() -> void:
	if not multiplayer.is_server() or not _match_in_progress:
		return
	_match_in_progress = false
	if _match_tick_timer:
		_match_tick_timer.stop()
	var ended_at := int(Time.get_unix_time_from_system())
	var payload := _build_match_payload(ended_at)
	print("[GameManager] Match ended, submitting: ", payload.get("match_id", ""))
	if MasterClient and MasterClient.is_active():
		MasterClient.submit_match_async(payload)
	# Build client-facing scoreboard (ordered, lightweight) and broadcast.
	var results := _build_match_results()
	_rpc_match_finished.rpc(results)
	_apply_match_finished_locally(results)


@rpc("authority", "call_local", "reliable")
func _rpc_match_finished(results: Dictionary) -> void:
	_apply_match_finished_locally(results)


func _apply_match_finished_locally(results: Dictionary) -> void:
	_match_finished_results = results
	# Force karts to stop / strip weapons (mirrors GDD: ENDED).
	if multiplayer.is_server():
		StateManager.server_end_match()
	match_finished.emit(results)
	match_ended.emit()


func _build_match_results() -> Dictionary:
	var rows: Array = []
	for entry in get_scores_sorted():
		var pid: int = int(entry["id"])
		var s: Dictionary = entry["data"]
		var shots: int = int(s.get("shots_fired", 0))
		var hits: int = int(s.get("shots_hit", 0))
		var accuracy: float = (float(hits) / float(shots) * 100.0) if shots > 0 else 0.0
		rows.append({
			"player_id": pid,
			"name": String(s.get("name", "")),
			"kills": int(s.get("kills", 0)),
			"deaths": int(s.get("deaths", 0)),
			"assists": int(s.get("assists", 0)),
			"damage_dealt": int(s.get("damage_dealt", 0)),
			"damage_taken": int(s.get("damage_taken", 0)),
			"shots_fired": shots,
			"shots_hit": hits,
			"accuracy_pct": accuracy,
		})
	return {
		"match_id": _match_id,
		"duration_s": _match_duration_s,
		"rows": rows,
	}


func _build_match_payload(ended_at: int) -> Dictionary:
	var participants := []
	for pid in players:
		var s: Dictionary = players[pid]
		var score: int = int(s.get("kills", 0)) * 100 + int(s.get("assists", 0)) * 50
		participants.append({
			"nickname": String(s.get("name", "")),
			"kills":         int(s.get("kills", 0)),
			"deaths":        int(s.get("deaths", 0)),
			"assists":       int(s.get("assists", 0)),
			"damage_dealt":  int(s.get("damage_dealt", 0)),
			"damage_taken":  int(s.get("damage_taken", 0)),
			"shots_fired":   int(s.get("shots_fired", 0)),
			"shots_hit":     int(s.get("shots_hit", 0)),
			"score":         score,
		})
	return {
		"match_id":   _match_id,
		"started_at": _match_started_at,
		"ended_at":   ended_at,
		"map_id":     RoomsReporter.map_name if RoomsReporter else "map_1",
		"room_code":  RoomsReporter.room_code if RoomsReporter else "",
		"participants": participants,
	}


# ── Restart hook ──────────────────────────────────────────────────────────────

func reset_for_restart() -> void:
	# Called server-side just before reload_current_scene. Wipes match state
	# so the next match starts cleanly when first client re-registers.
	if _match_timer:
		_match_timer.queue_free()
		_match_timer = null
	if _match_tick_timer:
		_match_tick_timer.queue_free()
		_match_tick_timer = null
	_match_in_progress = false
	_match_id = ""
	_match_started_at = 0
	_match_duration_s = 0
	_match_finished_results = {}
	# Wipe per-player stats — names will be re-supplied on _register.
	players.clear()


func _generate_uuid_v4() -> String:
	# RFC4122 §4.4: random version 4 UUID
	var bytes := PackedByteArray()
	for _i in range(16):
		bytes.append(randi() & 0xFF)
	bytes[6] = (bytes[6] & 0x0F) | 0x40
	bytes[8] = (bytes[8] & 0x3F) | 0x80
	var hex := ""
	for b in bytes:
		hex += "%02x" % b
	return "%s-%s-%s-%s-%s" % [
		hex.substr(0, 8),
		hex.substr(8, 4),
		hex.substr(12, 4),
		hex.substr(16, 4),
		hex.substr(20, 12),
	]
