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

@export_group("Drift (Binary v2)")
@export var drift_enter_threshold: float = 0.75   # |steer_input| above this triggers drift entry (hysteresis high)
@export var drift_exit_threshold: float = 0.35    # |steer_input| below this exits drift (hysteresis low). Must be < enter.
@export var drift_min_speed_ratio: float = 0.4    # min speed as fraction of max_speed to enter/hold drift
@export var drift_yaw_multiplier: float = 1.7     # yaw rate boost while drifting (tighter arc, SmashKarts-style)
@export var drift_kick_force: float = 4.0         # lateral impulse applied once on drift entry (rear swing)
@export var low_grip_target: float = 0.8          # grip while drifting. Lower = more slide. Half-life = ln(2)/grip
@export var high_grip_target: float = 18.0        # grip when not drifting. Higher = snappier recovery
@export var grip_loss_rate: float = 12.0          # /s — grip drops toward low_grip_target on drift entry
@export var grip_recovery_rate: float = 3.0       # /s — grip returns toward high_grip_target on drift exit
@export var vfx_smoke_speed_threshold: float = 3.0  # lateral speed (m/s) to trigger drift smoke
# v2.1 — Drift resistance: speed cost for tight turns (tire scrubbing physics)
@export_range(1.0, 3.0, 0.05) var drift_drag_multiplier: float = 1.8    # k_drag multiplied by this while _is_drifting (lowers terminal velocity)
@export_range(1.0, 2.0, 0.05) var drift_rolling_multiplier: float = 1.3 # k_rolling multiplied by this while _is_drifting (scrubbing at low speed)

@export_group("Visuals")
@export var wheel_radius: float = 0.18           # for roll animation speed
@export var visual_drift_max_deg: float = 40.0   # max visual body lean angle during drift (deg). 40 = SmashKarts-style

@export_group("Collision")
@export var mass: float = 1.0
@export var bump_min_force: float = 3.0
@export var bump_max_force: float = 12.0

@export_group("Terrain")
@export var gravity: float = 35.0               # m/s² (3.57x Earth — arcade feel)
@export var slope_speed_influence: float = 8.0
@export var floor_snap_length: float = 0.3
@export var floor_align_speed: float = 8.0
