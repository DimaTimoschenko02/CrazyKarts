extends SceneTree

# Standalone tests for DriftStateMachine.
# Run: "C:\Godot_v4.6.1-stable_win64_console.exe" --headless -s tests/test_drift_state_machine.gd --path .
#
# class_name lookups don't always resolve in `-s` standalone scripts before
# the global script class registry is built — preload by explicit path.

const DriftSM = preload("res://scripts/physics/drift_state_machine.gd")
const KartParamsRes = preload("res://scripts/kart_physics_resource.gd")

var passed: int = 0
var failed: int = 0


func _initialize() -> void:
	print("=== DriftStateMachine v3.1 tests ===")
	test_initial_state()
	test_arming_then_active()
	test_no_engage_below_speed()
	test_no_engage_low_steer()
	test_no_engage_off_floor()
	test_arming_aborts_on_release()
	test_exit_on_steer_release()
	test_visual_yaw_smoothing()
	test_rear_grip_multiplier_only_in_active()
	test_yaw_bonus_signed_by_direction()
	test_exit_boost_requires_min_active_time()
	test_disabled_returns_idle()
	test_hysteresis_no_flicker_in_band()
	print("=== %d passed, %d failed ===" % [passed, failed])
	quit(1 if failed > 0 else 0)


func _make_params():
	# Deterministic test parameters — independent of .tres tuning.
	var p = KartParamsRes.new()
	p.auto_drift_enabled = true
	p.drift_enter_steer = 0.65
	p.drift_enter_speed = 7.0
	p.drift_enter_debounce = 0.12
	p.drift_exit_steer = 0.35
	p.drift_exit_speed = 4.0
	p.drift_exit_duration = 0.3
	p.drift_visual_offset_deg = 22.0
	p.drift_visual_smooth_rate = 8.0
	p.drift_rear_grip_mult = 0.35
	p.drift_yaw_bonus = 1.4
	p.drift_forward_assist = 6.0
	p.drift_power_full_time = 1.5
	p.drift_min_active_for_boost = 0.7
	p.drift_exit_boost_force = 14.0
	p.drift_exit_boost_duration = 0.5
	return p


func _new_sm():
	return DriftSM.new(_make_params())


func _check(name: String, ok: bool, msg: String = "") -> void:
	if ok:
		passed += 1
		print("  PASS: %s" % name)
	else:
		failed += 1
		print("  FAIL: %s — %s" % [name, msg])


func test_initial_state() -> void:
	var sm = _new_sm()
	var out: Dictionary = sm.update(0.0, 0.0, true, 0.0, 0.016)
	_check("initial idle", not out["is_active"] and out["direction"] == 0)
	_check("initial grip mult = 1", absf(out["rear_grip_multiplier"] - 1.0) < 0.001)


func test_arming_then_active() -> void:
	var sm = _new_sm()
	# 7 frames at 60Hz = ~0.117s — just below debounce
	for i in range(7):
		sm.update(12.0, 0.8, true, 1.0, 1.0 / 60.0)
	var partial: Dictionary = sm.update(12.0, 0.8, true, 1.0, 1.0 / 60.0)
	_check("not active before debounce reached", not partial["is_active"])
	# A few more frames pushes past 0.12s debounce
	for i in range(5):
		sm.update(12.0, 0.8, true, 1.0, 1.0 / 60.0)
	var out: Dictionary = sm.update(12.0, 0.8, true, 1.0, 1.0 / 60.0)
	_check("active after debounce", out["is_active"])
	_check("direction = +1 for left turn (steer > 0)", out["direction"] == 1)


func test_no_engage_below_speed() -> void:
	var sm = _new_sm()
	for i in range(30):
		sm.update(5.0, 0.9, true, 1.0, 1.0 / 60.0)  # speed 5 < enter_speed 7
	var out: Dictionary = sm.update(5.0, 0.9, true, 1.0, 1.0 / 60.0)
	_check("no engage below enter_speed", not out["is_active"])


func test_no_engage_low_steer() -> void:
	var sm = _new_sm()
	for i in range(30):
		sm.update(15.0, 0.4, true, 1.0, 1.0 / 60.0)  # steer 0.4 < enter_steer 0.65
	var out: Dictionary = sm.update(15.0, 0.4, true, 1.0, 1.0 / 60.0)
	_check("no engage below enter_steer", not out["is_active"])


func test_no_engage_off_floor() -> void:
	var sm = _new_sm()
	for i in range(30):
		sm.update(15.0, 0.9, false, 1.0, 1.0 / 60.0)
	var out: Dictionary = sm.update(15.0, 0.9, false, 1.0, 1.0 / 60.0)
	_check("no engage off-floor", not out["is_active"])


func test_arming_aborts_on_release() -> void:
	var sm = _new_sm()
	for i in range(5):
		sm.update(12.0, 0.8, true, 1.0, 1.0 / 60.0)
	# Release before debounce completes
	for i in range(3):
		sm.update(12.0, 0.0, true, 1.0, 1.0 / 60.0)
	var out: Dictionary = sm.update(12.0, 0.8, true, 1.0, 1.0 / 60.0)
	# Re-armed but not yet active
	_check("aborted arming returns to idle", not out["is_active"])


func test_exit_on_steer_release() -> void:
	var sm = _new_sm()
	# Engage
	for i in range(15):
		sm.update(12.0, 0.9, true, 1.0, 1.0 / 60.0)
	var active: Dictionary = sm.update(12.0, 0.9, true, 1.0, 1.0 / 60.0)
	_check("engaged for exit test", active["is_active"])
	# Release
	var out: Dictionary = sm.update(12.0, 0.0, true, 1.0, 1.0 / 60.0)
	_check("disengage on full release", not out["is_active"])


func test_visual_yaw_smoothing() -> void:
	var sm = _new_sm()
	# Active with right-turn (steer < 0 → direction = -1)
	for i in range(30):
		sm.update(12.0, -0.9, true, 1.0, 1.0 / 60.0)
	var out: Dictionary = sm.update(12.0, -0.9, true, 1.0, 1.0 / 60.0)
	# Visual offset should be negative (right turn) and approaching -22°
	_check("visual yaw negative for right turn", out["visual_yaw_offset_rad"] < -0.1)
	_check("visual yaw approaching max",
		absf(out["visual_yaw_offset_rad"]) > deg_to_rad(15.0),
		"got %.3f rad" % out["visual_yaw_offset_rad"])


func test_rear_grip_multiplier_only_in_active() -> void:
	var sm = _new_sm()
	# Idle → mult should be 1.0
	var idle: Dictionary = sm.update(0.0, 0.0, true, 0.0, 1.0 / 60.0)
	_check("grip mult = 1 in idle", absf(idle["rear_grip_multiplier"] - 1.0) < 0.001)
	# Engage and hold long enough for engage_factor envelope to saturate.
	# With smooth_rate=4.5, ~1.5s gives engage_factor > 0.998.
	for i in range(120):
		sm.update(12.0, 0.9, true, 1.0, 1.0 / 60.0)
	var active: Dictionary = sm.update(12.0, 0.9, true, 1.0, 1.0 / 60.0)
	_check("grip mult ramps to ~0.35 in fully-engaged active",
		absf(active["rear_grip_multiplier"] - 0.35) < 0.02,
		"got %.3f" % active["rear_grip_multiplier"])
	# Sanity: mid-engage mult should sit between 1.0 and 0.35 (envelope smoothing).
	var sm2 = _new_sm()
	for i in range(20):  # ~0.33s active → engage_factor ~0.78
		sm2.update(12.0, 0.9, true, 1.0, 1.0 / 60.0)
	var mid: Dictionary = sm2.update(12.0, 0.9, true, 1.0, 1.0 / 60.0)
	_check("grip mult is between 1.0 and 0.35 mid-ramp",
		mid["rear_grip_multiplier"] > 0.4 and mid["rear_grip_multiplier"] < 0.95,
		"got %.3f" % mid["rear_grip_multiplier"])


func test_yaw_bonus_signed_by_direction() -> void:
	var sm = _new_sm()
	# Right turn: steer < 0 → direction -1 → bonus negative
	for i in range(15):
		sm.update(12.0, -0.9, true, 1.0, 1.0 / 60.0)
	var right: Dictionary = sm.update(12.0, -0.9, true, 1.0, 1.0 / 60.0)
	_check("yaw bonus negative for right turn",
		right["yaw_bonus_rad_per_sec"] < 0.0,
		"got %.3f" % right["yaw_bonus_rad_per_sec"])
	var sm2 = _new_sm()
	# Left turn: steer > 0 → direction +1 → bonus positive
	for i in range(15):
		sm2.update(12.0, 0.9, true, 1.0, 1.0 / 60.0)
	var left: Dictionary = sm2.update(12.0, 0.9, true, 1.0, 1.0 / 60.0)
	_check("yaw bonus positive for left turn", left["yaw_bonus_rad_per_sec"] > 0.0)


func test_exit_boost_requires_min_active_time() -> void:
	# Short drift (<0.7s) → no boost
	var sm = _new_sm()
	for i in range(15):  # ~0.25s active
		sm.update(12.0, 0.9, true, 1.0, 1.0 / 60.0)
	var releasing_short: Dictionary = sm.update(12.0, 0.0, true, 1.0, 1.0 / 60.0)
	_check("no boost after short drift",
		releasing_short["exit_boost_force"] < 0.5,
		"got %.3f" % releasing_short["exit_boost_force"])
	# Long drift (>0.7s) → boost
	var sm2 = _new_sm()
	for i in range(60):  # ~1s active
		sm2.update(12.0, 0.9, true, 1.0, 1.0 / 60.0)
	var releasing_long: Dictionary = sm2.update(12.0, 0.0, true, 1.0, 1.0 / 60.0)
	_check("boost granted after long drift",
		releasing_long["exit_boost_force"] > 5.0,
		"got %.3f" % releasing_long["exit_boost_force"])


func test_disabled_returns_idle() -> void:
	var p = _make_params()
	p.auto_drift_enabled = false
	var sm = DriftSM.new(p)
	for i in range(30):
		sm.update(15.0, 1.0, true, 1.0, 1.0 / 60.0)
	var out: Dictionary = sm.update(15.0, 1.0, true, 1.0, 1.0 / 60.0)
	_check("disabled never activates", not out["is_active"])
	_check("disabled grip mult stays 1.0", absf(out["rear_grip_multiplier"] - 1.0) < 0.001)


func test_hysteresis_no_flicker_in_band() -> void:
	# Engage at high steer, then drop to mid-band (0.5 — between exit 0.35 and enter 0.65).
	# Should STAY active because exit threshold is 0.35 not 0.65.
	var sm = _new_sm()
	for i in range(15):
		sm.update(12.0, 0.9, true, 1.0, 1.0 / 60.0)
	for i in range(20):
		sm.update(12.0, 0.5, true, 1.0, 1.0 / 60.0)
	var out: Dictionary = sm.update(12.0, 0.5, true, 1.0, 1.0 / 60.0)
	_check("stays active in hysteresis band (0.5)", out["is_active"])
