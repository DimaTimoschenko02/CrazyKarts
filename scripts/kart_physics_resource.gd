class_name KartPhysicsResource
extends Resource

@export_group("Speed")
@export var max_speed: float = 23.0
@export var reverse_max_speed: float = 13.0
@export var accel_sharpness: float = 0.35      # asymptotic: lerp(speed, target, sharpness * dt * 60)
@export var brake_decel: float = 40.0
@export var coast_decel: float = 8.0

@export_group("Input Smoothing")
@export var steer_slew_rate_in: float = 6.0    # /s — how fast steer ramps up (keyboard 0→1)
@export var steer_slew_rate_out: float = 3.5   # /s — how fast steer returns to center
@export var throttle_slew_rate: float = 5.0    # /s — throttle ramp rate

@export_group("Steering")
@export var steering_speed: float = 2.2
@export var steer_low_speed_mult: float = 1.4
@export var steer_high_speed_mult: float = 0.7
@export var steer_speed_threshold: float = 3.0  # min speed for full steering (0 = off)
@export var wheelbase: float = 1.19              # meters between front/rear axles (bicycle model)
@export var max_steer_angle: float = 40.0        # degrees, front wheel turn limit
@export var rwd_oversteer_factor: float = 0.04   # rear-wheel drive lateral nudge strength

@export_group("Visuals")
@export var wheel_radius: float = 0.18           # for roll animation speed

@export_group("Drift (Continuous)")
@export var low_grip_target: float = 0.8            # grip at full drift intent (max slide)
@export var high_grip_target: float = 16.0           # grip at zero intent (full traction)
@export var grip_loss_rate: float = 14.0             # how fast grip drops when intent rises
@export var grip_recovery_rate: float = 4.0          # how fast grip recovers when intent drops
@export var drift_steer_threshold: float = 0.45      # steer dead zone — below this, intent = 0
@export var drift_lateral_force: float = 0.30        # continuous lateral push (× intent × fwd_speed)
@export var drift_counter_steer_mult: float = 1.4    # steering boost when counter-steering in slide
@export var drift_same_steer_mult: float = 0.7       # steering reduction when steering into slide
@export var vfx_smoke_speed_threshold: float = 3.0   # lateral speed (m/s) to trigger drift smoke

@export_group("Collision")
@export var mass: float = 1.0
@export var bump_min_force: float = 3.0
@export var bump_max_force: float = 12.0

@export_group("Terrain")
@export var gravity: float = 35.0               # m/s² (3.57x Earth — arcade feel)
@export var slope_speed_influence: float = 8.0
@export var floor_snap_length: float = 0.3
@export var floor_align_speed: float = 8.0
