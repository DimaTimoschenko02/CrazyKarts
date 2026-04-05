extends Node


enum KartState {
	IDLE,
	DRIVING,
	DRIFTING,
	DEAD,
	RESPAWNING,
	INVULNERABLE,
}

enum MatchState {
	WAITING,
	COUNTDOWN,
	PLAYING,
	ENDED,
}

enum WeaponState {
	EMPTY,
	ARMED,
	FIRING,
	COOLDOWN,
}


# Transition tables: which transitions are valid for each state
const KART_TRANSITIONS: Dictionary = {
	KartState.IDLE:         [KartState.DRIVING, KartState.DEAD, KartState.INVULNERABLE],
	KartState.DRIVING:      [KartState.IDLE, KartState.DRIFTING, KartState.DEAD, KartState.INVULNERABLE],
	KartState.DRIFTING:     [KartState.DRIVING, KartState.DEAD, KartState.INVULNERABLE],
	KartState.DEAD:         [KartState.RESPAWNING, KartState.IDLE],
	KartState.RESPAWNING:   [KartState.DRIVING, KartState.INVULNERABLE, KartState.IDLE],
	KartState.INVULNERABLE: [KartState.DRIVING],
}

const MATCH_TRANSITIONS: Dictionary = {
	MatchState.WAITING:   [MatchState.COUNTDOWN],
	MatchState.COUNTDOWN: [MatchState.PLAYING, MatchState.WAITING],
	MatchState.PLAYING:   [MatchState.ENDED, MatchState.WAITING],
	MatchState.ENDED:     [MatchState.WAITING],
}

const WEAPON_TRANSITIONS: Dictionary = {
	WeaponState.EMPTY:    [WeaponState.ARMED],
	WeaponState.ARMED:    [WeaponState.FIRING, WeaponState.EMPTY],
	WeaponState.FIRING:   [WeaponState.COOLDOWN, WeaponState.EMPTY],
	WeaponState.COOLDOWN: [WeaponState.ARMED, WeaponState.EMPTY],
}


static func is_valid_kart_transition(from: KartState, to: KartState) -> bool:
	if from == to:
		return false
	return to in KART_TRANSITIONS.get(from, [])


static func is_valid_match_transition(from: MatchState, to: MatchState) -> bool:
	if from == to:
		return false
	return to in MATCH_TRANSITIONS.get(from, [])


static func is_valid_weapon_transition(from: WeaponState, to: WeaponState) -> bool:
	if from == to:
		return false
	return to in WEAPON_TRANSITIONS.get(from, [])
