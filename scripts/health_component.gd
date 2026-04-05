class_name HealthComponent
extends Node

# ── Signals ───────────────────────────────────────────────────────────────────
signal damaged(info: DamageInfo, final_amount: int)
signal died(killer_id: int)
signal hp_changed(current: int, maximum: int)

# ── Exports ───────────────────────────────────────────────────────────────────
@export var max_hp: int = 100
@export var class_resist_modifier: float = 1.0

# ── State ─────────────────────────────────────────────────────────────────────
var current_hp: int = 0
var _owner_id: int = -1
# { attacker_id: int -> timestamp_msec: int }
var _assist_tracker: Dictionary = {}

const ASSIST_WINDOW_MS: int = 5000


# ── Setup ─────────────────────────────────────────────────────────────────────
func setup(owner_id: int) -> void:
	_owner_id = owner_id
	current_hp = max_hp


# ── Damage API ────────────────────────────────────────────────────────────────
func apply_damage(info: DamageInfo) -> void:
	if not multiplayer.is_server():
		return
	if not StateManager.can_take_damage(_owner_id):
		return
	if current_hp <= 0:
		return

	var final_damage: int = floori(info.amount * class_resist_modifier)
	if final_damage <= 0:
		return

	_assist_tracker[info.attacker_id] = Time.get_ticks_msec()

	current_hp = maxi(current_hp - final_damage, 0)

	if current_hp <= 0:
		var assisters := _collect_assisters(info.attacker_id)
		_assist_tracker.clear()
		_rpc_sync_hp.rpc(current_hp)
		EventBus.damage_dealt.emit(info.attacker_id, _owner_id, info, final_damage)
		GameManager.record_kill(_owner_id, info.attacker_id, info)
		for aid in assisters:
			GameManager.record_assist(aid, _owner_id)
		died.emit(info.attacker_id)
	else:
		_rpc_sync_hp.rpc(current_hp)
		damaged.emit(info, final_damage)
		EventBus.damage_dealt.emit(info.attacker_id, _owner_id, info, final_damage)


func reset() -> void:
	current_hp = max_hp
	_assist_tracker.clear()
	if multiplayer.is_server():
		_rpc_sync_hp.rpc(current_hp)


func get_hp_ratio() -> float:
	if max_hp <= 0:
		return 0.0
	return float(current_hp) / float(max_hp)


# ── Network ───────────────────────────────────────────────────────────────────
@rpc("authority", "call_local", "reliable")
func _rpc_sync_hp(hp: int) -> void:
	current_hp = hp
	hp_changed.emit(current_hp, max_hp)


# ── Internals ─────────────────────────────────────────────────────────────────
func _collect_assisters(killer_id: int) -> Array:
	var now := Time.get_ticks_msec()
	var assisters: Array = []
	for aid in _assist_tracker:
		if aid != killer_id and (now - _assist_tracker[aid]) <= ASSIST_WINDOW_MS:
			assisters.append(aid)
	return assisters
