class_name PhysicsState
extends RefCounted

# Output of BicyclePhysics.step() each tick.
# kart_controller applies new_velocity / yaw_delta to the body
# and reads telemetry fields (drift_intensity, per-wheel slip) for VFX, debug, network.

# What kart_controller applies to the body
var new_velocity: Vector3 = Vector3.ZERO
var yaw_delta: float = 0.0               # radians to rotate around Y this tick

# Bicycle-model telemetry
var omega: float = 0.0                   # angular velocity around Y (rad/s) — drives visual lean
var fwd_speed: float = 0.0               # signed velocity along -basis.z
var side_speed: float = 0.0              # signed velocity along basis.x at body center

# Per-rear-wheel lateral slip velocities (signed)
# These are the engine of "concentric arcs of different radii" — left and right rear
# wheels see different lateral speeds when omega ≠ 0, so VFX trails curve differently.
var rear_left_lat_speed: float = 0.0
var rear_right_lat_speed: float = 0.0

# Slip angles for debug display only
var slip_angle_front_deg: float = 0.0
var slip_angle_rear_deg: float = 0.0

# Derived signals consumed downstream
var drift_intensity: float = 0.0         # smoothed [0..1] master used by camera, VFX, audio
var is_drifting: bool = false            # hysteresis flag, VFX/audio on-off only
var slip_ratio: float = 0.0              # raw rear-slip ratio normalized to drift_max_slip_speed
var grip_debug: float = 0.0              # representative grip value for legacy debug overlays
