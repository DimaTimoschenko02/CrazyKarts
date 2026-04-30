class_name BicyclePhysics
extends RefCounted

# Two-axle bicycle physics model with saturating tire forces.
#
# Why bicycle model: each rear wheel sees its own lateral velocity
# (body_velocity + omega × wheel_offset), so left and right rear wheels
# trace arcs of different curvature during a turn — exactly what produces
# the SmashKarts-style concentric drift trails.
#
# Pure compute module: no Godot scene tree access, no nodes.
# kart_controller owns the body, builds PhysicsInput each tick,
# calls step(), then applies PhysicsState back to the body.
#
# Persistent state between ticks: _omega, _drift_intensity, _is_drifting.

var _params: KartPhysicsResource
var _wheelbase: float = 1.2              # set by set_axle_geometry()
var _half_track: float = 0.45            # set by set_axle_geometry()

var _omega: float = 0.0                  # yaw angular velocity (rad/s)
var _drift_intensity: float = 0.0        # smoothed [0..1]
var _is_drifting: bool = false           # hysteresis flag


func _init(params: KartPhysicsResource) -> void:
	_params = params


func set_axle_geometry(wheelbase: float, track_width: float) -> void:
	_wheelbase = maxf(wheelbase, 0.1)
	_half_track = maxf(track_width * 0.5, 0.05)


func reset() -> void:
	_omega = 0.0
	_drift_intensity = 0.0
	_is_drifting = false


# ─── Public read-only accessors (legacy debug bridge) ────────────────────────

func get_omega() -> float:
	return _omega


func get_drift_intensity() -> float:
	return _drift_intensity


func get_is_drifting() -> bool:
	return _is_drifting


# ─── Main step ───────────────────────────────────────────────────────────────

func step(inp: PhysicsInput, delta: float) -> PhysicsState:
	var out := PhysicsState.new()

	# A. Decompose velocity in current basis.
	var fwd_dir: Vector3 = -inp.basis.z
	var side_dir: Vector3 = inp.basis.x
	var fwd_speed: float = inp.velocity.dot(fwd_dir)
	var side_speed: float = inp.velocity.dot(side_dir)

	# B. Steer angle from input. Speed-dependent reduction acts like real
	# vehicle: full lock at standstill, narrower lock at top speed.
	var max_angle_rad: float = deg_to_rad(_params.max_steer_angle_deg)
	var spd_ratio: float = clampf(absf(fwd_speed) / maxf(_params.max_speed, 0.01), 0.0, 1.0)
	var steer_mult: float = lerpf(_params.steer_low_speed_mult, _params.steer_high_speed_mult, spd_ratio)
	var steer_angle: float = inp.steer_input * max_angle_rad * steer_mult

	# C. Per-axle lateral velocities. Bicycle model: v_at_point = v_body + ω × r_point.
	#
	# Godot conventions: forward = -Z, right = +X, up = +Y. Yaw ω is rotation around +Y;
	# positive ω = CCW from above = LEFT turn.
	#
	# Front axle position in body frame: r_front = (0, 0, -half_wb) (because forward = -Z).
	# Rear axle position: r_rear = (0, 0, +half_wb).
	#
	# (ω × r) gives the velocity contribution from rotation. For ω = (0, ω, 0):
	#   (ω × r_front).x = ω × (-half_wb) = -ω · half_wb
	#   (ω × r_rear).x  = ω × (+half_wb) = +ω · half_wb
	#
	# Physical sanity check: when ω > 0 (CCW = left turn), front of body moves LEFT (-X)
	# and rear moves RIGHT (+X). Signs above confirm this.
	#
	# Both rear wheels see the SAME body-frame lateral velocity (rotation around Y doesn't
	# differentiate by X-position for the X-component of velocity). Visual arc divergence
	# comes from each wheel being at a different world POSITION — not from different lat speeds.
	var half_wb: float = _wheelbase * 0.5
	var v_lat_front: float = side_speed - _omega * half_wb
	var v_lat_rear: float = side_speed + _omega * half_wb

	# D. Front tire lateral velocity in WHEEL frame (rotated from body by steer_angle).
	# wheel_right_in_body = (cos α, 0, -sin α). Velocity at front in body frame is
	# (v_lat_front, 0, -fwd_speed). Project onto wheel_right:
	#   v_wheel_lat = v_lat_front * cos(α) - (-fwd_speed) * sin(α)
	#               = v_lat_front * cos(α) + fwd_speed * sin(α)
	# Signed fwd_speed makes reverse driving naturally invert the steer effect (no hack needed).
	var v_wheel_lat_front: float = v_lat_front * cos(steer_angle) + fwd_speed * sin(steer_angle)

	# E. Saturating tire lateral forces. f = -grip * tanh(v_lat / sat) * sat (opposes slip).
	# Front: force in wheel-right direction. Project back to body X via cos(α);
	# for arcade purposes we approximate F_body_x ≈ F_wheel (cos(α) ~ 1 at typical steer).
	var sat: float = maxf(_params.tire_saturation_speed, 0.1)
	var rear_grip_eff: float = _params.rear_grip_stiffness * maxf(inp.rear_grip_multiplier, 0.0)
	var f_front: float = -_params.front_grip_stiffness * _tanh(v_wheel_lat_front / sat) * sat
	var f_rear_per_wheel: float = -rear_grip_eff * _tanh(v_lat_rear / sat) * sat
	var f_rear_total: float = 2.0 * f_rear_per_wheel  # both rear wheels see same body-frame lat vel

	# Slip angles (debug output only).
	var fwd_clamp: float = maxf(absf(fwd_speed), 0.5)
	var alpha_front: float = atan2(v_lat_front, fwd_clamp) - steer_angle
	var alpha_rear: float = atan2(v_lat_rear, fwd_clamp)
	# Per-rear-wheel slip exposed for VFX. Both wheels see the same body-frame lat vel,
	# so we expose the same value for both — visual divergence will come from the
	# per-wheel positional offset combined with body rotation.
	var v_lat_rear_l: float = v_lat_rear
	var v_lat_rear_r: float = v_lat_rear

	# F. Yaw torque integration.
	# Godot convention: forward = -Z, so front axle position is r_front = (0, 0, -half_wb)
	# and rear axle is r_rear = (0, 0, +half_wb). For lateral force F_x at axle position r,
	# Y-axis torque = (r × F).y = r_z × F_x.
	# Therefore: τ_y = -half_wb × F_front_x + half_wb × F_rear_x = half_wb × (F_rear - F_front).
	# Sign matters: with the wrong sign, lateral slip torque amplifies slip → spin-out feedback loop.
	var torque: float = (f_rear_total - f_front) * half_wb
	var moi: float = _params.mass * (half_wb * half_wb) * maxf(_params.inertia_scale, 0.01)
	var omega_accel: float = torque / maxf(moi, 0.001)
	_omega += omega_accel * delta

	# Angular damping — framerate-independent exponential decay.
	_omega *= exp(-_params.omega_damping * delta)

	# G. Standstill steering aid. Direct yaw kick at near-zero speed,
	# blended out smoothly above stationary_steer_threshold so it never fights
	# the bicycle math in motion.
	if inp.on_floor and absf(fwd_speed) < _params.stationary_steer_threshold:
		var blend: float = 1.0 - smoothstep(0.0, _params.stationary_steer_threshold, absf(fwd_speed))
		var kick: float = inp.steer_input * _params.stationary_omega_kick * blend
		_omega += kick * delta

	# H. Apply lateral tire forces to body velocity.
	# Net lateral acceleration = sum of all tire lat forces / mass.
	var f_total_lat: float = f_front + f_rear_total
	side_speed += (f_total_lat / maxf(_params.mass, 0.001)) * delta

	# I. Longitudinal forces — preserved from v2.4. Cornering drag kept as
	# a soft overlay so light-corner deceleration stays visible (heavy lateral
	# slowdown is now emergent through tire forces).
	var thrust: float = 0.0
	if inp.throttle > 0.01:
		thrust = inp.throttle * _params.accel_force
	elif inp.throttle < -0.01:
		thrust = inp.throttle * _params.accel_force * _params.reverse_ratio

	var drag_mult: float = lerpf(1.0, _params.drift_drag_multiplier, _drift_intensity)
	var rolling_mult: float = lerpf(1.0, _params.drift_rolling_multiplier, _drift_intensity)
	var drag: float = -signf(fwd_speed) * _params.k_drag * drag_mult * fwd_speed * fwd_speed
	var rolling: float = -_params.k_rolling * rolling_mult * fwd_speed
	# Continuous force blends (smooth-values rule): no discrete jumps on continuous physics terms.
	# cornering_drag fades in across [0..0.2] m/s so the term doesn't snap on at standstill noise.
	var cornering_drag: float = 0.0
	if _params.cornering_drag_coeff > 0.0:
		var cd_blend: float = smoothstep(0.0, 0.2, absf(fwd_speed))
		cornering_drag = -signf(fwd_speed) * _params.cornering_drag_coeff * absf(side_speed) * 0.5 * cd_blend
	# brake force blends in across [0..0.6] m/s so it doesn't yank the car at near-zero forward speed.
	var brake: float = 0.0
	if inp.brake_held:
		var brake_blend: float = smoothstep(0.0, 0.6, fwd_speed)
		brake = -_params.brake_force * brake_blend

	fwd_speed += (thrust + drag + rolling + cornering_drag + brake) * delta
	if absf(thrust) < 0.01 and absf(fwd_speed) < 0.1:
		fwd_speed = 0.0

	# J. Drift intensity — derived from the faster-sliding rear wheel.
	# This is the "outer wheel during a turn" — captures the moment a wheel
	# breaks traction even when the body center is barely sliding.
	var rear_slip_mag: float = maxf(absf(v_lat_rear_l), absf(v_lat_rear_r))
	var slip_ratio: float = clampf(rear_slip_mag / maxf(_params.drift_max_slip_speed, 0.01), 0.0, 1.0)

	var target_intensity: float = 0.0
	if fwd_speed >= _params.drift_min_speed:
		target_intensity = slip_ratio
	var alpha: float = 1.0 - exp(-_params.slip_smoothing * delta)
	_drift_intensity = lerpf(_drift_intensity, target_intensity, alpha)
	_drift_intensity = clampf(_drift_intensity, 0.0, 1.0)

	# K. _is_drifting hysteresis (±0.02 around drift_active_threshold).
	# Discrete on-off flip is fine here — VFX/audio trigger only, not physics.
	var hyst_high: float = _params.drift_active_threshold + 0.02
	var hyst_low: float = _params.drift_active_threshold - 0.02
	if _is_drifting:
		if _drift_intensity < hyst_low:
			_is_drifting = false
	else:
		if _drift_intensity > hyst_high:
			_is_drifting = true

	# L. Pack output state.
	out.new_velocity = fwd_dir * fwd_speed + side_dir * side_speed + Vector3(0.0, inp.velocity.y, 0.0)
	out.yaw_delta = _omega * delta
	out.omega = _omega
	out.fwd_speed = fwd_speed
	out.side_speed = side_speed
	out.rear_left_lat_speed = v_lat_rear_l
	out.rear_right_lat_speed = v_lat_rear_r
	out.slip_angle_front_deg = rad_to_deg(alpha_front)
	out.slip_angle_rear_deg = rad_to_deg(alpha_rear)
	out.drift_intensity = _drift_intensity
	out.is_drifting = _is_drifting
	out.slip_ratio = slip_ratio
	out.grip_debug = _params.rear_grip_stiffness * (1.0 - _drift_intensity * 0.7)
	return out


# Hyperbolic tangent. GDScript has no built-in tanh — implement via exp with
# overflow guard. Used by saturating tire force model.
static func _tanh(x: float) -> float:
	if x > 20.0:
		return 1.0
	if x < -20.0:
		return -1.0
	var e2x: float = exp(2.0 * x)
	return (e2x - 1.0) / (e2x + 1.0)
