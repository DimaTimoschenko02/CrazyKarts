extends Node

# ── Signals ──────────────────────────────────────────────────────────────────
signal kart_state_changed(peer_id: int, from_state: GameStates.KartState, to_state: GameStates.KartState)
signal kart_died(peer_id: int, killer_peer_id: int)
signal kart_respawned(peer_id: int)

signal match_state_changed(from_state: GameStates.MatchState, to_state: GameStates.MatchState)

signal weapon_state_changed(peer_id: int, from_state: GameStates.WeaponState, to_state: GameStates.WeaponState)

# ── Tuning Knobs (from GDD) ─────────────────────────────────────────────────
const RESPAWN_DELAY: float = 3.0
const RESPAWN_INVULN_DURATION: float = 2.0
const MATCH_COUNTDOWN_DURATION: float = 3.0
const MATCH_RESTART_DELAY: float = 10.0

# ── State storage ────────────────────────────────────────────────────────────
var _kart_states: Dictionary = {}    # { peer_id: GameStates.KartState }
var _weapon_states: Dictionary = {}  # { peer_id: GameStates.WeaponState }
var _match_state: GameStates.MatchState = GameStates.MatchState.WAITING

# ── Queries ──────────────────────────────────────────────────────────────────

func get_kart_state(peer_id: int) -> GameStates.KartState:
	return _kart_states.get(peer_id, GameStates.KartState.IDLE)


func get_weapon_state(peer_id: int) -> GameStates.WeaponState:
	return _weapon_states.get(peer_id, GameStates.WeaponState.EMPTY)


func get_match_state() -> GameStates.MatchState:
	return _match_state


func can_move(peer_id: int) -> bool:
	var state := get_kart_state(peer_id)
	return state != GameStates.KartState.DEAD and state != GameStates.KartState.RESPAWNING


func can_take_damage(peer_id: int) -> bool:
	return can_move(peer_id) and get_kart_state(peer_id) != GameStates.KartState.INVULNERABLE


func can_fire(peer_id: int) -> bool:
	return can_move(peer_id) and get_weapon_state(peer_id) == GameStates.WeaponState.ARMED


# ── Registration ─────────────────────────────────────────────────────────────

func register_kart(peer_id: int) -> void:
	_kart_states[peer_id] = GameStates.KartState.IDLE
	_weapon_states[peer_id] = GameStates.WeaponState.EMPTY


func unregister_kart(peer_id: int) -> void:
	_kart_states.erase(peer_id)
	_weapon_states.erase(peer_id)


# ── Server-side Kart transitions ────────────────────────────────────────────

func server_kill_kart(peer_id: int, killer_id: int) -> void:
	if not multiplayer.is_server():
		return
	var from := get_kart_state(peer_id)
	if not GameStates.is_valid_kart_transition(from, GameStates.KartState.DEAD):
		push_warning("[StateManager] Invalid transition %s → DEAD for peer %d" % [GameStates.KartState.keys()[from], peer_id])
		return
	_rpc_set_kart_state.rpc(peer_id, GameStates.KartState.DEAD, from, killer_id)
	_delayed_kart_transition(peer_id, GameStates.KartState.DEAD, GameStates.KartState.RESPAWNING, RESPAWN_DELAY)


func server_respawn_complete(peer_id: int) -> void:
	if not multiplayer.is_server():
		return
	_delayed_kart_transition(peer_id, GameStates.KartState.RESPAWNING, GameStates.KartState.DRIVING, RESPAWN_INVULN_DURATION)


func _server_transition_kart(peer_id: int, to: GameStates.KartState) -> void:
	var from := get_kart_state(peer_id)
	if not GameStates.is_valid_kart_transition(from, to):
		push_warning("[StateManager] Invalid kart transition %s → %s for peer %d" % [
			GameStates.KartState.keys()[from], GameStates.KartState.keys()[to], peer_id])
		return
	_rpc_set_kart_state.rpc(peer_id, to, from, -1)


func _delayed_kart_transition(peer_id: int, required_state: GameStates.KartState, to: GameStates.KartState, delay: float) -> void:
	get_tree().create_timer(delay).timeout.connect(func():
		if peer_id not in _kart_states:
			return
		if _kart_states[peer_id] != required_state:
			return
		_server_transition_kart(peer_id, to)
	, CONNECT_ONE_SHOT)


# ── Server-side Weapon transitions ──────────────────────────────────────────

func server_give_weapon(peer_id: int) -> void:
	if not multiplayer.is_server():
		return
	var from := get_weapon_state(peer_id)
	if from != GameStates.WeaponState.EMPTY:
		return
	_rpc_set_weapon_state.rpc(peer_id, GameStates.WeaponState.ARMED, from)


func server_consume_weapon(peer_id: int) -> void:
	if not multiplayer.is_server():
		return
	var from := get_weapon_state(peer_id)
	if from == GameStates.WeaponState.EMPTY:
		return
	_rpc_set_weapon_state.rpc(peer_id, GameStates.WeaponState.EMPTY, from)


# ── Server-side Match transitions (stub for now) ────────────────────────────

func server_start_match() -> void:
	if not multiplayer.is_server():
		return
	_rpc_set_match_state.rpc(GameStates.MatchState.PLAYING, _match_state)


func server_end_match() -> void:
	if not multiplayer.is_server():
		return
	_rpc_set_match_state.rpc(GameStates.MatchState.ENDED, _match_state)


# ── Late join sync ───────────────────────────────────────────────────────────

func sync_state_to_peer(peer_id: int) -> void:
	if not multiplayer.is_server():
		return
	for pid in _kart_states:
		# Use IDLE as "from" sentinel — the receiving side applies side effects based on "to"
		_rpc_set_kart_state.rpc_id(peer_id, pid, _kart_states[pid], GameStates.KartState.IDLE, -1)
	for pid in _weapon_states:
		if _weapon_states[pid] != GameStates.WeaponState.EMPTY:
			_rpc_set_weapon_state.rpc_id(peer_id, pid, _weapon_states[pid], GameStates.WeaponState.EMPTY)


# ── Cross-domain forced transitions ─────────────────────────────────────────

func _force_all_karts_idle() -> void:
	if not multiplayer.is_server():
		return
	for pid in _kart_states.keys():
		var current: GameStates.KartState = _kart_states[pid]
		if current != GameStates.KartState.IDLE:
			# Force transition bypasses validation — match end is a server-forced override
			_rpc_set_kart_state.rpc(pid, GameStates.KartState.IDLE, current, -1)


func _force_all_weapons_empty() -> void:
	if not multiplayer.is_server():
		return
	for pid in _weapon_states.keys():
		if _weapon_states[pid] != GameStates.WeaponState.EMPTY:
			_rpc_set_weapon_state.rpc(pid, GameStates.WeaponState.EMPTY, _weapon_states[pid])


# ── RPCs ─────────────────────────────────────────────────────────────────────

@rpc("authority", "call_local", "reliable")
func _rpc_set_kart_state(peer_id: int, to: int, from: int, param: int) -> void:
	var to_state := to as GameStates.KartState
	var from_state := from as GameStates.KartState
	_kart_states[peer_id] = to_state
	kart_state_changed.emit(peer_id, from_state, to_state)
	if to_state == GameStates.KartState.DEAD and param >= 0:
		kart_died.emit(peer_id, param)
	if to_state == GameStates.KartState.RESPAWNING:
		kart_respawned.emit(peer_id)


@rpc("authority", "call_local", "reliable")
func _rpc_set_weapon_state(peer_id: int, to: int, from: int) -> void:
	var to_state := to as GameStates.WeaponState
	var from_state := from as GameStates.WeaponState
	_weapon_states[peer_id] = to_state
	weapon_state_changed.emit(peer_id, from_state, to_state)


@rpc("authority", "call_local", "reliable")
func _rpc_set_match_state(to: int, from: int) -> void:
	var to_state := to as GameStates.MatchState
	var from_state := from as GameStates.MatchState
	_match_state = to_state
	match_state_changed.emit(from_state, to_state)
	if to_state == GameStates.MatchState.ENDED:
		_force_all_karts_idle()
		_force_all_weapons_empty()
