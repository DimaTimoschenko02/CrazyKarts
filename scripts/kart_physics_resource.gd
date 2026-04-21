class_name KartPhysicsResource
extends Resource

@export_group("Speed (v2: force-based)")
@export var accel_force: float = 400.0       # thrust at full throttle (m/s²). Terminal ≈ sqrt(accel_force/k_drag)
@export var k_drag: float = 0.4              # quadratic drag coefficient. Dominates at high speed. v_terminal ≈ sqrt(accel_force/k_drag)
@export var k_rolling: float = 12.0          # linear rolling resistance. Dominates at low speed. Tune for coast feel.
@export var brake_force: float = 40.0        # extra decel (m/s²) when S pressed against forward motion
@export var reverse_ratio: float = 0.5       # reverse thrust as fraction of forward accel_force
@export var max_speed: float = 20.0          # reference value only — camera FOV + drift_min_speed_ratio calc. NOT a hard clamp.

@export_group("Input Smoothing")
@export var steer_slew_rate_in: float = 6.0    # /s — how fast steer ramps up (keyboard 0→1)
@export var steer_slew_rate_out: float = 3.5   # /s — how fast steer returns to center
@export var throttle_slew_rate: float = 5.0    # /s — throttle ramp rate

@export_group("Steering")
@export var steering_speed: float = 2.2                  # rad/s base yaw rate
@export var steer_low_speed_mult: float = 1.4            # yaw rate multiplier at v=0
@export var steer_high_speed_mult: float = 0.7           # yaw rate multiplier at v=max_speed
@export var steer_speed_threshold: float = 3.0           # speed at which speed_scale reaches 1.0
@export var stationary_steer_threshold: float = 2.0      # m/s — below this, use stationary_steer_scale instead of speed_ratio
@export var stationary_steer_scale: float = 0.4          # fractional speed_scale at near-zero speed (0.4 = 40% of full yaw rate)

# v2.3 — Continuous Drift Intensity model. _drift_intensity: float [0..1] is the physics master.
# intensity_target = pow(|steer_input|, drift_steer_exponent) * speed_factor — no binary thresholds.
# _is_drifting: bool is derived with mini-hysteresis (±0.02 around drift_active_threshold) — VFX/audio only.
@export_group("Drift (Continuous v2.3)")
# REMOVED in v2.3: drift_enter_threshold, drift_exit_threshold — superseded by continuous pow() target
@export var drift_steer_exponent: float = 3.0     # power curve exponent: intensity_target = pow(|steer|, exp) * speed_factor. Range 1.5–5.0.
@export var drift_min_speed_ratio: float = 0.4    # speed_factor ramp origin: fraction of max_speed where drift starts becoming available
@export var drift_intensity_enter_rate: float = 3.5  # /s — how fast intensity ramps to 1.0 on entry (default: 0→1 in ~0.29s)
@export var drift_intensity_exit_rate: float = 3.0   # /s — how fast intensity falls to 0.0 on exit (default: 1→0 in ~0.33s)
@export var drift_active_threshold: float = 0.7   # intensity above which _is_drifting=true (VFX/audio trigger)
@export var drift_lateral_ramp: float = 30.0      # m/s² lateral ramp force during intensity growth (replaces v2.1 one-shot kick)
@export var drift_yaw_multiplier: float = 1.7     # yaw rate lerp endpoint at intensity=1.0 (tighter arc, SmashKarts-style)
@export var low_grip_target: float = 0.8          # lateral damping at intensity=1.0 (full drift). Lower = more slide.
@export var high_grip_target: float = 18.0        # lateral damping at intensity=0.0 (no drift). Higher = snappier recovery.

# [deprecated — kept as legacy override for rollback]
# When BOTH are non-zero: overrides intensity-based grip with move_toward behavior (v2.1 path).
# Default 0.0 = disabled. Leave at 0.0 for v2.2 intensity-based grip derivation.
@export var grip_loss_rate: float = 0.0           # /s — legacy grip drop rate (0.0 = disabled, uses intensity)
@export var grip_recovery_rate: float = 0.0       # /s — legacy grip recovery rate (0.0 = disabled, uses intensity)

# v2.1 — Drift resistance: speed cost for tight turns (tire scrubbing physics).
# Lerp endpoints at full intensity=1.0.
@export_range(1.0, 3.0, 0.05) var drift_drag_multiplier: float = 1.8    # k_drag lerp endpoint at intensity=1.0
@export_range(1.0, 2.0, 0.05) var drift_rolling_multiplier: float = 1.3 # k_rolling lerp endpoint at intensity=1.0

@export_group("Visuals")
@export var wheel_radius: float = 0.18           # for roll animation speed
@export var visual_drift_max_deg: float = 40.0   # max visual body lean angle at intensity=1.0 (deg)
@export var visual_lean_recovery_speed: float = 6.0  # [maybe deprecated] overdamping for body mesh lag vs intensity. 0 = direct follow.
@export var vfx_smoke_speed_threshold: float = 3.0  # lateral speed (m/s) to trigger drift smoke

@export_group("Collision")
@export var mass: float = 1.0
@export var bump_min_force: float = 3.0
@export var bump_max_force: float = 12.0

@export_group("Terrain")
@export var gravity: float = 35.0               # m/s² (3.57x Earth — arcade feel)
@export var slope_speed_influence: float = 8.0
@export var floor_snap_length: float = 0.3
@export var floor_align_speed: float = 8.0
