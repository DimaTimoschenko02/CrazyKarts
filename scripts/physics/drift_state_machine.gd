class_name DriftStateMachine
extends RefCounted

# Auto-triggered drift state machine layered on top of BicyclePhysics.
#
# Why a state machine: pure emergent drift from bicycle physics either
# produces stable driving with no rear slide, or wild rotation with no
# control — there is no sweet-spot tuning that gives both.
# SmashKarts-style games (no drift button) solve this by AUTO-detecting
# turn intent (high steer + speed + throttle held for a debounce window)
# and then explicitly applying: visual yaw offset, rear-grip multiplier,
# yaw rate bonus, forward assist. On exit: visual snap-back + optional
# boost based on accumulated drift power.
#
# Pure compute module. No node access. kart_controller builds DriftInput
# each tick, calls update(), reads DriftOutput.

enum State { IDLE, ARMING, ACTIVE, EXITING }

var _state: int = State.IDLE
var _prev_state: int = State.IDLE       # used to detect ACTIVE → EXITING transition
var _direction: int = 0                 # -1, 0, +1
var _arm_timer: float = 0.0             # accumulated time conditions held
var _active_timer: float = 0.0          # time spent in ACTIVE
var _exit_timer: float = 0.0            # time spent in EXITING (boost window)
var _visual_yaw_offset: float = 0.0     # smoothed visual offset (rad)
var _engage_factor: float = 0.0         # 0..1 smooth envelope: scales ALL drift effects
var _recovery_factor: float = 0.0       # 0..1 snap-grip overlay, fires on ACTIVE→EXITING
var _power: float = 0.0                 # 0..1, ramps over active time
var _exit_boost_remaining: float = 0.0  # post-exit boost time left (sec)

var _params: KartPhysicsResource


func _init(params: KartPhysicsResource) -> void:
	_params = params


func reset() -> void:
	_state = State.IDLE
	_prev_state = State.IDLE
	_direction = 0
	_arm_timer = 0.0
	_active_timer = 0.0
	_exit_timer = 0.0
	_visual_yaw_offset = 0.0
	_engage_factor = 0.0
	_recovery_factor = 0.0
	_power = 0.0
	_exit_boost_remaining = 0.0


func is_active() -> bool:
	return _state == State.ACTIVE


func get_direction() -> int:
	return _direction


func get_engage_factor() -> float:
	return _engage_factor


# True only when the visual/physical drift effect is meaningfully engaged.
# Used by VFX (smoke, trails) so they appear in sync with the visible body
# yaw — not before the visual catches up to the state flip.
func is_drift_engaged(threshold: float = 0.5) -> bool:
	return _engage_factor >= threshold


# Returns Dictionary with the layered outputs:
#   is_active: bool
#   direction: int (-1, 0, +1)
#   visual_yaw_offset_rad: float    — apply to visual mesh, smoothed
#   rear_grip_multiplier: float      — fed into PhysicsInput for bicycle
#   yaw_bonus_rad_per_sec: float    — added to body rotation outside bicycle
#   forward_assist_force: float     — extra thrust along physics forward
#   exit_boost_force: float         — extra thrust during post-drift boost
#   power: float                    — 0..1 accumulated power
#
# Caller reads these and applies them. State transitions are debounced
# (steer thresholds with hysteresis, debounce timer for entry, fixed
# duration for exit visual decay).
func update(speed: float, steer_input: float, on_floor: bool, throttle: float, delta: float) -> Dictionary:
	if not _params.auto_drift_enabled:
		_state = State.IDLE
		var idle_alpha: float = 1.0 - exp(-_params.drift_visual_smooth_rate * delta)
		_visual_yaw_offset = lerp(_visual_yaw_offset, 0.0, idle_alpha)
		_engage_factor = lerp(_engage_factor, 0.0, idle_alpha)
		return _idle_output()

	var abs_steer: float = absf(steer_input)
	var enter_ok: bool = (
		on_floor
		and speed >= _params.drift_enter_speed
		and abs_steer >= _params.drift_enter_steer
		and throttle > 0.05
	)
	var exit_ok: bool = (
		not on_floor
		or speed < _params.drift_exit_speed
		or abs_steer < _params.drift_exit_steer
	)

	_prev_state = _state
	match _state:
		State.IDLE:
			if enter_ok:
				_state = State.ARMING
				_direction = 1 if steer_input > 0.0 else -1
				_arm_timer = 0.0
		State.ARMING:
			if not enter_ok or signf(steer_input) != float(_direction):
				_state = State.IDLE
				_arm_timer = 0.0
				_direction = 0
			else:
				_arm_timer += delta
				if _arm_timer >= _params.drift_enter_debounce:
					_state = State.ACTIVE
					_active_timer = 0.0
					_power = 0.0
		State.ACTIVE:
			if exit_ok:
				_state = State.EXITING
				_exit_timer = 0.0
				if _active_timer >= _params.drift_min_active_for_boost:
					_exit_boost_remaining = _params.drift_exit_boost_duration
				# Snap-grip overlay activates the moment we leave ACTIVE so the
				# bicycle's rear tire pulls HARDER than normal during recovery,
				# killing residual lateral velocity instead of letting it
				# linger as "ghost slide".
				_recovery_factor = 1.0
			else:
				_active_timer += delta
				_power = clampf(_active_timer / maxf(_params.drift_power_full_time, 0.01), 0.0, 1.0)
		State.EXITING:
			_exit_timer += delta
			if _exit_timer >= _params.drift_exit_duration:
				_state = State.IDLE
				_direction = 0
				_active_timer = 0.0
				_power = 0.0

	# Engage envelope — smoothly ramps to 1 in ACTIVE, decays to 0 elsewhere.
	# Separate enter/exit rates so onset can be soft and recovery can be just
	# slow enough to feel natural without lingering.
	var engage_target: float = 1.0 if _state == State.ACTIVE else 0.0
	var rate: float = _params.drift_engage_in_rate if engage_target > _engage_factor else _params.drift_engage_out_rate
	var smooth_alpha: float = 1.0 - exp(-rate * delta)
	_engage_factor = lerp(_engage_factor, engage_target, smooth_alpha)
	if _engage_factor < 0.001 and engage_target == 0.0:
		_engage_factor = 0.0

	# Recovery overlay decays once we leave ACTIVE.
	var recovery_alpha: float = 1.0 - exp(-_params.drift_recovery_rate * delta)
	_recovery_factor = lerp(_recovery_factor, 0.0, recovery_alpha)
	if _recovery_factor < 0.001:
		_recovery_factor = 0.0

	# Visual yaw is driven directly by the smoothed _engage_factor (not by
	# the binary engage_target lerped a second time). Single-stage smoothing
	# gives a clean C1 curve without the slope discontinuity that double
	# filtering produced — visible as a "kink" at drift entry/exit in trails.
	var max_off: float = deg_to_rad(_params.drift_visual_offset_deg)
	_visual_yaw_offset = max_off * float(_direction) * _engage_factor

	# Rear grip multiplier:
	#   base   = lerp(1, drift_rear_grip_mult, engage)   → loose grip in ACTIVE
	#   overlay = (drift_exit_grip_mult - 1) * recovery   → extra-tight on exit
	# Snap-grip overlay clamps residual side velocity quickly without breaking
	# the "drifty" feel during ACTIVE.
	var base_mult: float = lerp(1.0, _params.drift_rear_grip_mult, _engage_factor)
	var overlay: float = (_params.drift_exit_grip_mult - 1.0) * _recovery_factor
	var rear_grip_mult: float = base_mult + overlay
	var yaw_bonus: float = _params.drift_yaw_bonus * float(_direction) * _engage_factor
	var fwd_assist: float = _params.drift_forward_assist * _engage_factor

	# Post-exit boost — pure forward burst, decays linearly.
	var exit_boost: float = 0.0
	if _exit_boost_remaining > 0.0:
		var t: float = clampf(_exit_boost_remaining / maxf(_params.drift_exit_boost_duration, 0.01), 0.0, 1.0)
		exit_boost = _params.drift_exit_boost_force * t
		_exit_boost_remaining = maxf(_exit_boost_remaining - delta, 0.0)

	return {
		"is_active": _state == State.ACTIVE,
		"direction": _direction,
		"visual_yaw_offset_rad": _visual_yaw_offset,
		"rear_grip_multiplier": rear_grip_mult,
		"yaw_bonus_rad_per_sec": yaw_bonus,
		"forward_assist_force": fwd_assist,
		"exit_boost_force": exit_boost,
		"power": _power,
		"engage_factor": _engage_factor,
	}


func _idle_output() -> Dictionary:
	return {
		"is_active": false,
		"direction": 0,
		"visual_yaw_offset_rad": _visual_yaw_offset,
		"rear_grip_multiplier": 1.0,
		"yaw_bonus_rad_per_sec": 0.0,
		"forward_assist_force": 0.0,
		"exit_boost_force": 0.0,
		"power": 0.0,
		"engage_factor": _engage_factor,
	}
