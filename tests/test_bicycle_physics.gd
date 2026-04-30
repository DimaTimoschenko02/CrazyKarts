extends SceneTree

# Standalone test runner for BicyclePhysics module.
# Run from project root:
#   "C:\Godot_v4.6.1-stable_win64_console.exe" --headless -s tests/test_bicycle_physics.gd --path .
#
# Each test is a method named test_*. Tests print PASS/FAIL and a one-line message.
# Final summary prints total pass/fail counts. Exit code = number of failures.

const TOL := 0.0001
const TOL_LOOSE := 0.05

var _pass: int = 0
var _fail: int = 0


func _initialize() -> void:
	print("\n=== BicyclePhysics tests ===\n")
	_run_all()
	print("\n=== Summary: %d passed, %d failed ===\n" % [_pass, _fail])
	quit(_fail)


func _run_all() -> void:
	for method in get_method_list():
		if String(method["name"]).begins_with("test_"):
			call(method["name"])


# ─── Test helpers ────────────────────────────────────────────────────────────

func _assert(condition: bool, msg: String) -> void:
	if condition:
		print("  PASS  ", msg)
		_pass += 1
	else:
		print("  FAIL  ", msg)
		_fail += 1


func _assert_close(actual: float, expected: float, tolerance: float, msg: String) -> void:
	_assert(absf(actual - expected) <= tolerance, "%s (got %.4f, expected %.4f ± %.4f)" % [msg, actual, expected, tolerance])


func _make_params() -> KartPhysicsResource:
	# Variant Б defaults — heavy car with visible drift.
	var p := KartPhysicsResource.new()
	p.accel_force = 20.0
	p.k_drag = 0.07
	p.k_rolling = 1.1
	p.brake_force = 40.0
	p.reverse_ratio = 0.5
	p.max_speed = 24.5
	p.steer_low_speed_mult = 1.1
	p.steer_high_speed_mult = 0.85
	p.stationary_steer_threshold = 2.0
	p.max_steer_angle_deg = 32.0
	p.front_grip_stiffness = 12.0
	p.rear_grip_stiffness = 1.5
	p.tire_saturation_speed = 3.0
	p.inertia_scale = 0.7
	p.omega_damping = 3.0
	p.stationary_omega_kick = 2.5
	p.drift_max_slip_speed = 6.0
	p.drift_min_speed = 2.5
	p.slip_smoothing = 5.0
	p.drift_active_threshold = 0.55
	p.drift_drag_multiplier = 2.6
	p.drift_rolling_multiplier = 1.45
	p.cornering_drag_coeff = 0.7
	p.mass = 1.0
	return p


func _make_input(velocity: Vector3, throttle: float, steer: float, on_floor: bool = true) -> PhysicsInput:
	var inp := PhysicsInput.new()
	inp.velocity = velocity
	inp.basis = Basis.IDENTITY
	inp.throttle = throttle
	inp.steer_input = steer
	inp.on_floor = on_floor
	inp.brake_held = false
	return inp


# ─── Tests ───────────────────────────────────────────────────────────────────

func test_stationary_no_steer_no_motion() -> void:
	# At rest, no input, no aid trigger — kart should stay still and not drift.
	var bp := BicyclePhysics.new(_make_params())
	bp.set_axle_geometry(1.2, 0.9)
	var state := bp.step(_make_input(Vector3.ZERO, 0.0, 0.0), 1.0 / 60.0)
	_assert_close(state.omega, 0.0, TOL, "omega stays zero at rest with no input")
	_assert_close(state.drift_intensity, 0.0, TOL, "drift_intensity stays zero")
	_assert(not state.is_drifting, "is_drifting flag stays false")
	_assert_close(state.fwd_speed, 0.0, TOL, "fwd_speed stays zero with no throttle")


func test_throttle_accelerates() -> void:
	# Full throttle, no steer — should gain forward speed each tick.
	var bp := BicyclePhysics.new(_make_params())
	bp.set_axle_geometry(1.2, 0.9)
	var inp := _make_input(Vector3.ZERO, 1.0, 0.0)
	var state := bp.step(inp, 1.0 / 60.0)
	_assert(state.fwd_speed > 0.1, "fwd_speed increases with full throttle (got %.3f)" % state.fwd_speed)
	_assert_close(state.omega, 0.0, TOL, "omega stays zero when going straight")


func test_rear_lat_speed_nonzero_under_yaw() -> void:
	# When omega is non-zero in a turn, rear axle has lateral velocity in body frame.
	# Both rear wheels see the SAME body-frame X-velocity (rotation around Y doesn't
	# differ by X-position). Visual arc divergence comes from different WORLD positions
	# of the wheel nodes, not from different lat speeds.
	var bp := BicyclePhysics.new(_make_params())
	bp.set_axle_geometry(1.2, 0.9)
	var inp := _make_input(Vector3(0.0, 0.0, -15.0), 0.5, 1.0)
	var dt := 1.0 / 60.0
	var state: PhysicsState
	for _i in range(60):
		state = bp.step(inp, dt)
		inp.velocity = state.new_velocity
	_assert(absf(bp.get_omega()) > 0.1, "omega should build up under sustained steer (got %.3f)" % bp.get_omega())
	_assert(absf(state.rear_left_lat_speed) > 0.05, "rear lat speed nonzero in turn (|v|=%.4f)" % state.rear_left_lat_speed)
	# Both rear wheels see same body-frame lat velocity by physics:
	_assert_close(state.rear_left_lat_speed, state.rear_right_lat_speed, 0.001,
		"both rear wheels see same body-frame lateral velocity")


func test_reset_clears_state() -> void:
	# After reset, omega and drift_intensity must return to zero.
	var bp := BicyclePhysics.new(_make_params())
	bp.set_axle_geometry(1.2, 0.9)
	var inp := _make_input(Vector3(0.0, 0.0, -15.0), 0.5, 1.0)
	for _i in range(120):
		var st := bp.step(inp, 1.0 / 60.0)
		inp.velocity = st.new_velocity
	# Should have built up some omega and intensity
	_assert(absf(bp.get_omega()) > 0.05, "pre-reset: omega built up")
	bp.reset()
	_assert_close(bp.get_omega(), 0.0, TOL, "reset clears omega")
	_assert_close(bp.get_drift_intensity(), 0.0, TOL, "reset clears drift_intensity")
	_assert(not bp.get_is_drifting(), "reset clears is_drifting")


func test_omega_damps_to_zero() -> void:
	# Without input, an existing omega must decay over time.
	var bp := BicyclePhysics.new(_make_params())
	bp.set_axle_geometry(1.2, 0.9)
	# Build omega up
	var inp := _make_input(Vector3(0.0, 0.0, -10.0), 0.0, 1.0)
	for _i in range(30):
		var st := bp.step(inp, 1.0 / 60.0)
		inp.velocity = st.new_velocity
	var omega_peak: float = absf(bp.get_omega())
	# Now coast with no steer for a few seconds
	inp = _make_input(Vector3.ZERO, 0.0, 0.0)
	for _i in range(180):
		var st := bp.step(inp, 1.0 / 60.0)
		inp.velocity = st.new_velocity
	# After 3 seconds of coasting, omega should have lost most of its energy.
	# With omega_damping=4 (exp decay) plus tire force feedback against rotation,
	# we expect at least 50% reduction from peak (often much more).
	_assert(absf(bp.get_omega()) < omega_peak * 0.5, "omega decays to <50%% of peak after coasting (peak=%.3f, now=%.3f)" % [omega_peak, bp.get_omega()])


func test_standstill_aid_rotates_at_zero_speed() -> void:
	# At zero speed with full steer, stationary aid should rotate the kart.
	var bp := BicyclePhysics.new(_make_params())
	bp.set_axle_geometry(1.2, 0.9)
	var inp := _make_input(Vector3.ZERO, 0.0, 1.0)
	for _i in range(30):
		bp.step(inp, 1.0 / 60.0)
	_assert(absf(bp.get_omega()) > 0.05, "standstill aid produces nonzero omega at zero speed (got %.3f)" % bp.get_omega())


func test_drift_intensity_zero_below_min_speed() -> void:
	# Even with high lateral velocity, if fwd_speed < drift_min_speed → intensity 0.
	var bp := BicyclePhysics.new(_make_params())
	bp.set_axle_geometry(1.2, 0.9)
	# Pure lateral velocity, no forward
	var inp := _make_input(Vector3(5.0, 0.0, 0.0), 0.0, 0.0)
	for _i in range(30):
		bp.step(inp, 1.0 / 60.0)
	_assert_close(bp.get_drift_intensity(), 0.0, TOL_LOOSE, "drift_intensity stays ~0 below drift_min_speed")


func test_yaw_delta_matches_omega() -> void:
	# yaw_delta in PhysicsState should equal omega * delta — used by kart_controller for rotate_y.
	var bp := BicyclePhysics.new(_make_params())
	bp.set_axle_geometry(1.2, 0.9)
	# Build some omega
	var inp := _make_input(Vector3(0.0, 0.0, -10.0), 0.5, 0.5)
	var dt := 1.0 / 60.0
	for _i in range(20):
		var st := bp.step(inp, dt)
		inp.velocity = st.new_velocity
	var final_state := bp.step(inp, dt)
	_assert_close(final_state.yaw_delta, final_state.omega * dt, TOL, "yaw_delta = omega * delta")


func test_axle_geometry_clamped() -> void:
	# Negative or zero geometry should be clamped to safe minimums (no divide-by-zero).
	var bp := BicyclePhysics.new(_make_params())
	bp.set_axle_geometry(0.0, 0.0)
	var state := bp.step(_make_input(Vector3.ZERO, 1.0, 1.0), 1.0 / 60.0)
	_assert(is_finite(state.omega) and is_finite(state.fwd_speed), "no NaN/Inf with zero geometry")


func test_lateral_slip_self_corrects() -> void:
	# CRITICAL stability invariant: a small lateral perturbation must NOT amplify into runaway spin.
	# Before bug fix this test would fail — torque sign was inverted, creating positive feedback.
	var bp := BicyclePhysics.new(_make_params())
	bp.set_axle_geometry(1.2, 0.9)
	# Forward 10 m/s with tiny lateral perturbation, no input.
	var inp := _make_input(Vector3(0.1, 0.0, -10.0), 0.0, 0.0)
	# Run 2 seconds of simulation
	for _i in range(120):
		var st := bp.step(inp, 1.0 / 60.0)
		inp.velocity = st.new_velocity
	# Omega must remain bounded — runaway spin would push it to thousands.
	_assert(absf(bp.get_omega()) < 5.0, "no spin-out from small lateral perturbation (omega=%.3f)" % bp.get_omega())
	# Drift intensity must not lock at 1.0 from a single tiny perturbation
	_assert(bp.get_drift_intensity() < 0.95, "drift_intensity does not saturate from tiny perturbation (got %.3f)" % bp.get_drift_intensity())


func test_steer_left_yaws_left() -> void:
	# Sanity: pressing steer-left input must produce CCW (positive in Godot) omega.
	# Before bug fix this test would fail — sign-flipped torque turned the kart the wrong way.
	var bp := BicyclePhysics.new(_make_params())
	bp.set_axle_geometry(1.2, 0.9)
	var inp := _make_input(Vector3(0.0, 0.0, -10.0), 0.0, 1.0)  # full steer LEFT (positive in code)
	# Settle a few ticks
	for _i in range(10):
		var st := bp.step(inp, 1.0 / 60.0)
		inp.velocity = st.new_velocity
	_assert(bp.get_omega() > 0.05, "steer_input=+1 (left) produces positive omega/CCW (got %.3f)" % bp.get_omega())


# ─── Maneuver simulations: integrate over many ticks and assert smoothness ───
#
# Helper: runs N ticks of the simulation while letting the caller change input each tick
# via a callable `input_at(tick) -> {throttle, steer}`. Rotates the basis using each tick's
# yaw_delta so multi-tick simulation actually reproduces what kart_controller would see.
# Returns a list of {tick, omega, yaw_delta, side_speed, fwd_speed} samples.

func _simulate_drive(bp: BicyclePhysics, ticks: int, input_at: Callable) -> Array:
	var samples: Array = []
	var basis := Basis.IDENTITY
	var velocity := Vector3.ZERO
	var dt := 1.0 / 60.0
	for i in range(ticks):
		var ctrl: Dictionary = input_at.call(i)
		var inp := PhysicsInput.new()
		inp.basis = basis
		inp.velocity = velocity
		inp.throttle = ctrl.get("throttle", 0.0)
		inp.steer_input = ctrl.get("steer", 0.0)
		inp.on_floor = true
		inp.brake_held = false
		var st := bp.step(inp, dt)
		# Apply yaw_delta to basis (mimics rotate_y in kart_controller).
		basis = basis.rotated(Vector3.UP, st.yaw_delta)
		velocity = st.new_velocity
		samples.append({
			"tick": i,
			"omega": st.omega,
			"yaw_delta": st.yaw_delta,
			"side_speed": st.side_speed,
			"fwd_speed": st.fwd_speed,
			"drift_intensity": st.drift_intensity,
		})
	return samples


# Counts sign flips in a list of floats (treats values |v| < eps as zero / no flip).
func _count_sign_flips(values: Array, eps: float = 0.01) -> int:
	var flips := 0
	var last_sign := 0
	for v in values:
		var s: int = 0
		if v > eps: s = 1
		elif v < -eps: s = -1
		if s != 0 and last_sign != 0 and s != last_sign:
			flips += 1
		if s != 0:
			last_sign = s
	return flips


func _values(samples: Array, key: String) -> Array:
	var out: Array = []
	for s in samples:
		out.append(s[key])
	return out


func test_maneuver_straight_line_no_yaw_jitter() -> void:
	# Hold W only for 3 seconds. omega and side_speed should stay near zero
	# with at most a handful of sign flips from numerical noise.
	var bp := BicyclePhysics.new(_make_params())
	bp.set_axle_geometry(1.2, 0.9)
	var samples := _simulate_drive(bp, 180, func(_i): return {"throttle": 1.0, "steer": 0.0})
	var omegas: Array = _values(samples, "omega")
	var sides: Array = _values(samples, "side_speed")
	var max_omega: float = 0.0
	for o in omegas:
		if absf(o) > max_omega:
			max_omega = absf(o)
	_assert(max_omega < 0.5, "straight-line drive does not develop omega (max |ω|=%.4f)" % max_omega)
	# Sign flips allowed up to a small number from float noise — runaway oscillation would have many.
	var flips := _count_sign_flips(omegas, 0.02)
	_assert(flips <= 3, "no oscillating yaw on straight throttle (flips=%d)" % flips)
	_assert(_count_sign_flips(sides, 0.02) <= 3, "no side-speed oscillation on straight throttle")


func test_maneuver_smooth_turn_then_release_no_jitter() -> void:
	# Ramp speed up for 1s, hold steer-left for 1s, release steer for 2s.
	# Expect: omega rises smoothly then decays smoothly. No mid-maneuver sign flips.
	var bp := BicyclePhysics.new(_make_params())
	bp.set_axle_geometry(1.2, 0.9)
	var samples := _simulate_drive(bp, 240, func(i):
		if i < 60: return {"throttle": 1.0, "steer": 0.0}
		if i < 120: return {"throttle": 1.0, "steer": 0.5}
		return {"throttle": 1.0, "steer": 0.0})
	var omegas: Array = _values(samples, "omega")
	var omega_during_turn: Array = omegas.slice(60, 120)
	var omega_during_release: Array = omegas.slice(120, 240)
	# During steered turn, omega should be predominantly one sign (left = positive)
	var positive_count := 0
	var negative_count := 0
	for o in omega_during_turn:
		if o > 0.05:
			positive_count += 1
		elif o < -0.05:
			negative_count += 1
	_assert(positive_count > negative_count * 5, "steered turn produces consistent CCW omega (pos=%d neg=%d)" % [positive_count, negative_count])
	# After release, omega should monotonically decay (a few flips fine, but not chaos).
	var release_flips := _count_sign_flips(omega_during_release, 0.05)
	_assert(release_flips <= 4, "omega decays cleanly after release (flips=%d)" % release_flips)


func test_maneuver_full_lock_does_not_explode() -> void:
	# Worst-case: full throttle + full steer for 3 seconds. Omega must remain bounded.
	# Saturating tire model + omega_damping should keep it under reasonable cap.
	var bp := BicyclePhysics.new(_make_params())
	bp.set_axle_geometry(1.2, 0.9)
	var samples := _simulate_drive(bp, 180, func(_i): return {"throttle": 1.0, "steer": 1.0})
	var omegas: Array = _values(samples, "omega")
	var max_omega: float = 0.0
	for o in omegas:
		if absf(o) > max_omega:
			max_omega = absf(o)
	_assert(max_omega < 25.0, "full-lock turn omega stays bounded (max |ω|=%.3f, expected <25)" % max_omega)


func test_maneuver_coast_after_drive_settles() -> void:
	# Drive forward then coast for 2s with no input. Omega and side_speed should both go to ~0.
	var bp := BicyclePhysics.new(_make_params())
	bp.set_axle_geometry(1.2, 0.9)
	var samples := _simulate_drive(bp, 240, func(i):
		if i < 60: return {"throttle": 1.0, "steer": 0.3}
		return {"throttle": 0.0, "steer": 0.0})
	var last: Dictionary = samples[-1]
	_assert(absf(last["omega"]) < 0.5, "omega settles after coast (|ω|=%.3f)" % last["omega"])
	_assert(absf(last["side_speed"]) < 0.5, "side_speed settles after coast (|side|=%.3f)" % last["side_speed"])


func test_maneuver_idle_no_input_no_motion() -> void:
	# CRITICAL: the user-reported bug. With ZERO input held for 3s, kart must remain still.
	# No phantom yaw, no oscillation, no drift.
	var bp := BicyclePhysics.new(_make_params())
	bp.set_axle_geometry(1.2, 0.9)
	var samples := _simulate_drive(bp, 180, func(_i): return {"throttle": 0.0, "steer": 0.0})
	var max_omega: float = 0.0
	var max_side: float = 0.0
	for s in samples:
		if absf(s["omega"]) > max_omega:
			max_omega = absf(s["omega"])
		if absf(s["side_speed"]) > max_side:
			max_side = absf(s["side_speed"])
	_assert(max_omega < 0.001, "idle kart with zero input has zero omega (max |ω|=%.6f)" % max_omega)
	_assert(max_side < 0.001, "idle kart has zero side_speed (max |side|=%.6f)" % max_side)


func test_maneuver_aggressive_turn_produces_visible_drift() -> void:
	# Acceptance for "rear should slide": at high speed with hard steer, rear lateral
	# velocity in body frame must reach a value the player can FEEL (>= 1.5 m/s).
	# If this fails, current parameters are too grippy — the model works but the kart
	# never enters drift regime within visible-input ranges.
	var bp := BicyclePhysics.new(_make_params())
	bp.set_axle_geometry(1.2, 0.9)
	# Build up to top speed first
	var inp := _make_input(Vector3.ZERO, 1.0, 0.0)
	for _i in range(180):
		var st := bp.step(inp, 1.0 / 60.0)
		inp.velocity = st.new_velocity
	# Now hard turn at speed for 1 second, integrating basis like kart_controller would
	var basis := Basis.IDENTITY
	var velocity := inp.velocity
	var max_rear_lat: float = 0.0
	var max_omega: float = 0.0
	for i in range(60):
		var inp2 := PhysicsInput.new()
		inp2.basis = basis
		inp2.velocity = velocity
		inp2.throttle = 1.0
		inp2.steer_input = 1.0
		inp2.on_floor = true
		var st := bp.step(inp2, 1.0 / 60.0)
		basis = basis.rotated(Vector3.UP, st.yaw_delta)
		velocity = st.new_velocity
		if absf(st.rear_left_lat_speed) > max_rear_lat:
			max_rear_lat = absf(st.rear_left_lat_speed)
		if absf(st.omega) > max_omega:
			max_omega = absf(st.omega)
	# 1.5 m/s rear lat means the rear axle is genuinely sliding sideways at running pace.
	# This is the difference between "tight turning radius" and "drifting".
	_assert(max_rear_lat > 1.5, "aggressive turn produces visible rear slide (max rear |v_lat|=%.3f m/s)" % max_rear_lat)
	print("    [diag] max_omega=%.2f rad/s during aggressive turn" % max_omega)


func test_maneuver_throttle_only_drives_straight() -> void:
	# Press W only. After 3 seconds, kart should be moving in the original forward direction.
	# No spin, no lateral drift accumulation.
	var bp := BicyclePhysics.new(_make_params())
	bp.set_axle_geometry(1.2, 0.9)
	var samples := _simulate_drive(bp, 180, func(_i): return {"throttle": 1.0, "steer": 0.0})
	var last: Dictionary = samples[-1]
	_assert(last["fwd_speed"] > 5.0, "throttle-only build ups forward speed (fwd=%.3f)" % last["fwd_speed"])
	_assert(absf(last["side_speed"]) < 0.1, "throttle-only does not develop sideways drift (|side|=%.4f)" % last["side_speed"])
	_assert(absf(last["omega"]) < 0.05, "throttle-only does not yaw (|ω|=%.4f)" % last["omega"])


func test_tanh_helper_bounds() -> void:
	# Saturating tire forces depend on _tanh staying in (-1, 1) for any input.
	_assert_close(BicyclePhysics._tanh(0.0), 0.0, TOL, "_tanh(0) = 0")
	_assert(BicyclePhysics._tanh(100.0) <= 1.0 and BicyclePhysics._tanh(100.0) >= 0.999, "_tanh(big) ≈ 1")
	_assert(BicyclePhysics._tanh(-100.0) >= -1.0 and BicyclePhysics._tanh(-100.0) <= -0.999, "_tanh(-big) ≈ -1")
	_assert_close(BicyclePhysics._tanh(1.0), 0.7616, 0.001, "_tanh(1) ≈ 0.7616")
