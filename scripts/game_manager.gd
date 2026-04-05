extends Node

# ── Signals ───────────────────────────────────────────────────────────────────
signal scores_updated(scores: Dictionary)
signal player_died(victim_id: int, killer_id: int)

# ── State ─────────────────────────────────────────────────────────────────────
# { player_id: { name, kills, deaths } }
var players: Dictionary = {}


# ── Player Registration ───────────────────────────────────────────────────────
func register_player(player_id: int, player_name: String) -> void:
	players[player_id] = {
		"name": player_name,
		"kills": 0,
		"deaths": 0,
	}
	StateManager.register_kart(player_id)
	print("[GameManager] Registered: ", player_name, " (id=", player_id, ")")


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
	EventBus.player_assisted.emit(assister_id, victim_id)


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
