class_name PhysicsInput
extends RefCounted

# Input snapshot passed to BicyclePhysics.step() each tick.
# Pure data. No node references. Can be reused (kart_controller pre-allocates one).

var velocity: Vector3 = Vector3.ZERO     # current world velocity (CharacterBody3D.velocity)
var basis: Basis = Basis.IDENTITY        # global_transform.basis at tick start
var throttle: float = 0.0                # smoothed throttle [-1..+1]
var steer_input: float = 0.0             # smoothed steer [-1..+1]
var brake_held: bool = false             # explicit brake key held while moving forward
var on_floor: bool = true                # CharacterBody3D.is_on_floor() result
var rear_grip_multiplier: float = 1.0    # set by DriftStateMachine (<1 during active drift)


func reset() -> void:
	velocity = Vector3.ZERO
	basis = Basis.IDENTITY
	throttle = 0.0
	steer_input = 0.0
	brake_held = false
	on_floor = true
	rear_grip_multiplier = 1.0
