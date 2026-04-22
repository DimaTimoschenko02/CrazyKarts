class_name KartPhysicsResource
extends Resource

@export_group("Speed")
@export var accel_force: float = 22.0        # thrust at full throttle (m/s²). Terminal ≈ sqrt(accel_force/k_drag)
@export var k_drag: float = 0.04             # quadratic drag coefficient. Dominates at high speed.
@export var k_rolling: float = 1.1           # linear rolling resistance. Dominates at low speed.
@export var brake_force: float = 40.0        # extra decel (m/s²) when S pressed against forward motion
@export var reverse_ratio: float = 0.5       # reverse thrust as fraction of forward accel_force
@export var max_speed: float = 27.5          # reference value only — camera FOV + network normalization. NOT a hard clamp.

@export_group("Input Smoothing")
@export var steer_slew_rate_in: float = 2.0    # /s — how fast steer ramps up (keyboard 0→1)
@export var steer_slew_rate_out: float = 1.5   # /s — how fast steer returns to center
@export var throttle_slew_rate: float = 2.0    # /s — throttle ramp rate

@export_group("Steering")
@export var steering_speed: float = 2.6                  # rad/s base yaw rate
@export var steer_low_speed_mult: float = 1.0            # yaw rate multiplier at v=0
@export var steer_high_speed_mult: float = 0.95          # yaw rate multiplier at v=max_speed
@export var steer_speed_threshold: float = 3.0           # speed at which speed_scale reaches 1.0
@export var stationary_steer_threshold: float = 2.0      # m/s — below this, use stationary_steer_scale
@export var stationary_steer_scale: float = 0.2          # fractional speed_scale at near-zero speed

# v2.4 — Emergent Drift model. _drift_intensity [0..1] is the physics master.
# Derived from measured slip_angle = atan2(|side_speed|, max(|fwd_speed|, 0.5)).
# Framerate-independent: exp(-grip*delta) damping, 1-exp(-rate*delta) lerp.
# _is_drifting: bool is derived with mini-hysteresis (±0.02 around drift_active_threshold) — VFX/audio only.
@export_group("Drift (Emergent v2.4)")
@export var drift_min_speed: float = 3.0          # m/s hard gate — below this intensity decays to 0
@export var drift_max_slip_angle_deg: float = 35.0  # slip_ratio = 1.0 at this angle
@export var slip_smoothing: float = 8.0           # exp lerp rate: intensity tracks slip_ratio (1/s)
@export var drift_intent_multiplier: float = 0.4  # extra yaw fraction at full steer (smoothstep intent aid endpoint)
@export var drift_intent_threshold: float = 0.7   # |steer| at which smoothstep begins ramping intent aid
@export var grip_slip_exponent: float = 2.0       # exponent on grip curve: 1.0=linear, 2.0=grip holds then drops sharply
@export var low_grip_target: float = 1.0          # exp decay rate at intensity=1.0 (SmashKarts-range compromise)
@export var high_grip_target: float = 29.0        # exp decay rate at intensity=0.0
@export var drift_active_threshold: float = 0.55  # center of _is_drifting mini-hysteresis (±0.02)
@export var drift_yaw_multiplier: float = 1.8     # yaw rate lerp endpoint at intensity=1.0
@export var visual_drift_max_deg: float = 34.0    # max visual body lean angle at intensity=1.0 (deg)
@export var visual_lean_recovery_speed: float = 5.0

@export var drift_drag_multiplier: float = 2.6    # k_drag lerp endpoint at intensity=1.0
@export var drift_rolling_multiplier: float = 1.45

# [deprecated — kept for rollback]
# When BOTH are non-zero: overrides intensity-based grip with move_toward behavior (v2.1 path).
@export var grip_loss_rate: float = 0.0
@export var grip_recovery_rate: float = 0.0

@export_group("Visuals")
@export var wheel_radius: float = 0.18
@export var vfx_smoke_speed_threshold: float = 0.5  # lateral speed (m/s) to trigger drift smoke

@export_group("Collision")
@export var mass: float = 1.0
@export var bump_min_force: float = 3.0
@export var bump_max_force: float = 12.0

@export_group("Terrain")
@export var gravity: float = 35.0               # m/s² (3.57x Earth — arcade feel)
@export var slope_speed_influence: float = 8.0
@export var floor_snap_length: float = 0.3
@export var floor_align_speed: float = 8.0      # pitch/roll only — yaw frozen post-slerp
