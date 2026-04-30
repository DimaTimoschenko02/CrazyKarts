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
@export var steer_visual_rate: float = 18.0    # /s — front-wheel visual angle exp-lerp rate

@export_group("Steering")
@export var steering_speed: float = 2.6                  # [deprecated v3.0] kept for legacy paths only
@export var steer_low_speed_mult: float = 1.0            # steer-angle scale at v=0 (still used by v3.0)
@export var steer_high_speed_mult: float = 0.95          # steer-angle scale at v=max_speed (still used by v3.0)
@export var steer_speed_threshold: float = 3.0           # [deprecated v3.0] kept for backward compat
@export var stationary_steer_threshold: float = 2.0      # m/s — speed below which standstill aid blends in
@export var stationary_steer_scale: float = 0.2          # [deprecated v3.0] replaced by stationary_omega_kick

@export_group("Bicycle v3.0 (Two-Axle)")
# Geometry. Override = 0.0 means "auto-measure from wheel nodes at _ready()".
@export var wheelbase_override: float = 0.0              # m, 0 = auto from front/rear wheel nodes
@export var track_width_override: float = 0.0            # m, 0 = auto from rear wheel L/R nodes

# Steering shape
@export var max_steer_angle_deg: float = 32.0            # full-lock front wheel angle

# Tire model (saturating: linear region then capped force)
@export var front_grip_stiffness: float = 14.0           # linear-zone slope of front tire force
@export var rear_grip_stiffness: float = 7.0             # linear-zone slope of rear tire force (lower = drift)
@export var tire_saturation_speed: float = 4.5           # m/s where tire force saturates near max

# Yaw inertia
@export var inertia_scale: float = 1.2                   # multiplier on point-mass MOI baseline
@export var omega_damping: float = 4.0                   # 1/s exp damping on angular velocity

# Standstill arcade aid (separate from bicycle math, blends out above threshold)
@export var stationary_omega_kick: float = 2.5           # rad/s² yaw kick at zero speed

# Drift intensity normalization
@export var drift_max_slip_speed: float = 8.0            # m/s rear lat-speed at which slip_ratio = 1.0

# Visual lean (consumed by kart_controller, not by bicycle math)
@export var omega_lean_scale: float = 3.0                # rad/s of omega that gives full visual lean

# Drift signals (intensity / is_drifting / lean) — driven by v3.0 bicycle model in kart_controller.
# slip_smoothing, drift_min_speed, drift_active_threshold, drift_*_multiplier are still active.
# drift_max_slip_angle_deg, drift_intent_*, grip_slip_exponent, low/high_grip_target are [deprecated v3.0].
@export_group("Drift Signal Shaping")
@export var drift_min_speed: float = 3.0          # m/s hard gate — below this intensity decays to 0
@export var drift_max_slip_angle_deg: float = 35.0  # [deprecated v3.0] replaced by drift_max_slip_speed
@export var slip_smoothing: float = 8.0           # exp lerp rate: intensity tracks slip_ratio (1/s)
@export var drift_intent_multiplier: float = 0.4  # [deprecated v3.0] arcade yaw aid removed
@export var drift_intent_threshold: float = 0.7   # [deprecated v3.0] arcade yaw aid removed
@export var grip_slip_exponent: float = 2.0       # [deprecated v3.0] grip is now saturating tanh, not pow curve
@export var low_grip_target: float = 1.0          # [deprecated v3.0] replaced by tire_saturation_speed
@export var high_grip_target: float = 29.0        # [deprecated v3.0] replaced by front/rear_grip_stiffness
@export var drift_active_threshold: float = 0.55  # center of _is_drifting mini-hysteresis (±0.02)
@export var drift_yaw_multiplier: float = 1.8     # [deprecated v3.0] yaw is now emergent from omega
@export var visual_drift_max_deg: float = 34.0    # max visual body lean angle at intensity=1.0 (deg)
@export var visual_lean_recovery_speed: float = 5.0

@export var drift_drag_multiplier: float = 2.6    # k_drag lerp endpoint at intensity=1.0
@export var drift_rolling_multiplier: float = 1.45
@export var cornering_drag_coeff: float = 0.3     # soft fwd-drag overlay during corners (v3.0 halves it internally)

# [deprecated — kept for rollback]
# When BOTH are non-zero: overrides intensity-based grip with move_toward behavior (v2.1 path).
@export var grip_loss_rate: float = 0.0
@export var grip_recovery_rate: float = 0.0

@export_group("Drift State Machine v3.1 (auto-trigger)")
# Layered on top of bicycle physics. Auto-triggered by speed+steer threshold.
# Provides explicit drift state with visual yaw offset, rear-grip multiplier,
# yaw rate bonus, forward assist, and post-exit boost.
@export var auto_drift_enabled: bool = true
@export var drift_enter_steer: float = 0.65        # |steer| threshold to begin arming
@export var drift_enter_speed: float = 7.0         # m/s minimum to engage
@export var drift_enter_debounce: float = 0.12     # sec hold before ACTIVE
@export var drift_exit_steer: float = 0.35         # hysteresis: exit when |steer| drops below
@export var drift_exit_speed: float = 4.0          # m/s minimum to stay active
@export var drift_exit_duration: float = 0.3       # sec for visual snap-back
@export var drift_visual_offset_deg: float = 22.0  # body yaw offset when ACTIVE
@export var drift_visual_smooth_rate: float = 4.5  # 1/s [legacy alias; use drift_engage_*_rate below]
@export var drift_engage_in_rate: float = 3.5      # 1/s exp ramp speed entering ACTIVE
@export var drift_engage_out_rate: float = 2.5     # 1/s exp ramp speed leaving ACTIVE (slower = smoother)
@export var drift_recovery_rate: float = 4.0       # 1/s decay of snap-grip overlay after exit
@export var drift_exit_grip_mult: float = 1.8      # rear grip multiplier during recovery (>1 kills residual slide)
@export var drift_rear_grip_mult: float = 0.35     # multiplier on rear_grip_stiffness during ACTIVE
@export var drift_yaw_bonus: float = 1.4           # rad/s extra body rotation during ACTIVE
@export var drift_forward_assist: float = 3.0      # m/s² extra forward thrust during ACTIVE
@export var drift_power_full_time: float = 1.5     # sec of ACTIVE for power=1.0
@export var drift_min_active_for_boost: float = 0.7  # sec ACTIVE required to grant exit boost
@export var drift_exit_boost_force: float = 14.0   # m/s² forward burst during exit window
@export var drift_exit_boost_duration: float = 0.5 # sec, decays linearly

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
