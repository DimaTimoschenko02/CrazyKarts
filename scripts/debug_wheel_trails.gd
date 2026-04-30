extends Node3D
class_name DebugWheelTrails

# Debug overlay: renders skid trails behind rear wheels during drift.
# Implements: visual debug aid for arcade-physics v3.1 (GDD kart-physics.md).
# Left trail = yellow (1, 0.9, 0.2), Right trail = red (0.95, 0.3, 0.2).
# Uses ImmediateMesh + PRIMITIVE_TRIANGLE_STRIP — each sampled point produces
# a perpendicular "rib" of two vertices, so the path renders as a thick ribbon
# rather than a 1-pixel polyline.
# Temporary debug tool — will be replaced by Decal/shader skid marks post-MVP.

## Maximum trail points per wheel. At 60 fps this covers ~6 seconds of history.
const MAX_POINTS := 360

## Slight Y lift to avoid z-fighting with the floor geometry.
@export var wheel_height_offset: float = 0.06

## Lateral offset from kart center to approximate rear-wheel world position.
## Used as fallback if wheel nodes are not reachable from target.
@export var wheel_offset_lateral: float = 0.6

## Rear offset from kart center (negative = behind in local Z).
@export var wheel_offset_rear: float = -0.7

## Trail width in world meters (each rib is ±half this around the wheel path).
@export var trail_width: float = 0.35

## Speed at which a trail point fades from full alpha to zero once the
## active condition clears. Lower = longer ghost trail.
@export var fade_speed: float = 0.4

@export var target: Node3D

var _enabled: bool = true

# Per-point entry: [Vector3 world_pos, float alpha, Vector3 perp_world]
# perp_world is the kart's right axis at sample time, used to build the rib.
var _left_points:  Array = []
var _right_points: Array = []

var _mesh_instance: MeshInstance3D
var _immediate_mesh: ImmediateMesh
var _material: StandardMaterial3D


func _ready() -> void:
	_immediate_mesh = ImmediateMesh.new()

	_material = StandardMaterial3D.new()
	_material.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	_material.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	_material.vertex_color_use_as_albedo = true
	_material.no_depth_test = true
	_material.depth_draw_mode = BaseMaterial3D.DEPTH_DRAW_DISABLED
	_material.cull_mode = BaseMaterial3D.CULL_DISABLED

	_mesh_instance = MeshInstance3D.new()
	_mesh_instance.mesh = _immediate_mesh
	_mesh_instance.material_override = _material
	_mesh_instance.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	add_child(_mesh_instance)

	_enabled = DevParams.get_param("DEBUG_VECTORS", true)
	visible = _enabled
	if DevParams:
		DevParams.params_changed.connect(_on_params_changed)


func _physics_process(delta: float) -> void:
	if not _enabled:
		return
	if not is_instance_valid(target):
		return

	# v3.1.1: recording driven by the smooth engage_factor, not a binary
	# is_drifting flag. Recording starts as soon as engage rises above a
	# tiny floor (0.05) and per-point alpha tracks engage — so the trail
	# fades in/out together with the visual body lean, eliminating the
	# "kink" at drift entry where points used to start mid-arc.
	# Slip-based fallback stays for sustained side-scrub outside drift.
	var engage: float = 0.0
	var side_speed: float = 0.0
	var smoke_threshold: float = 0.5

	if target.has_method("get_drift_engage_factor"):
		engage = target.get_drift_engage_factor()
	if "side_speed" in target:
		side_speed = absf(target.side_speed)
	elif "_cached_side_speed" in target:
		side_speed = absf(target._cached_side_speed)

	if target.get("physics") and target.physics.get("vfx_smoke_speed_threshold") != null:
		smoke_threshold = target.physics.vfx_smoke_speed_threshold

	var slip_active: bool = side_speed > maxf(smoke_threshold * 3.0, 1.5)
	var active: bool = engage > 0.05 or slip_active
	# Birth alpha = engage_factor when drift-driven, full alpha for raw slip.
	# Smoothstep on engage so the trail head-edge has a soft onset rather
	# than appearing at a fixed value of engage.
	var birth_alpha: float = 1.0 if slip_active and engage <= 0.05 else smoothstep(0.05, 0.6, engage)

	# Resolve rear-wheel world positions and perpendicular axis (for ribbon width).
	# perp = kart's right (basis.x). Stored per-point so old segments keep their
	# original orientation as the kart rotates.
	var perp_world: Vector3 = (target.global_transform.basis.x as Vector3).normalized()
	var pos_left:  Vector3 = _get_wheel_pos(target, true)
	var pos_right: Vector3 = _get_wheel_pos(target, false)
	pos_left.y  = target.global_position.y + wheel_height_offset
	pos_right.y = target.global_position.y + wheel_height_offset

	if active:
		_push_point(_left_points,  pos_left,  perp_world, birth_alpha)
		_push_point(_right_points, pos_right, perp_world, birth_alpha)

	_fade_points(_left_points,  delta)
	_fade_points(_right_points, delta)
	_rebuild_mesh()


func _get_wheel_pos(kart: Node3D, is_left: bool) -> Vector3:
	# Try to read directly from the wheel MeshInstance3D nodes used in kart_controller.
	# LT = rear-left (_wheel_rl), RT = rear-right (_wheel_rr).
	var node_name: String = "BaseCar/MainCar/Car2/LT" if is_left else "BaseCar/MainCar/Car2/RT"
	var wheel_node := kart.get_node_or_null(node_name) as Node3D
	if wheel_node:
		return wheel_node.global_position
	var lateral_sign: float = -1.0 if is_left else 1.0
	var local_offset := Vector3(lateral_sign * wheel_offset_lateral, 0.0, wheel_offset_rear)
	return kart.global_transform * local_offset


func _push_point(buf: Array, pos: Vector3, perp: Vector3, birth_alpha: float = 1.0) -> void:
	buf.push_back([pos, clampf(birth_alpha, 0.0, 1.0), perp])
	if buf.size() > MAX_POINTS:
		buf.pop_front()


func _fade_points(buf: Array, delta: float) -> void:
	var i := 0
	while i < buf.size():
		var tail_ratio: float = 1.0 - float(i) / maxf(float(buf.size() - 1), 1.0)
		var decay: float = fade_speed * (0.5 + tail_ratio * 1.5)
		buf[i][1] = maxf(buf[i][1] - decay * delta, 0.0)
		if buf[i][1] <= 0.0:
			buf.remove_at(i)
		else:
			i += 1


func _rebuild_mesh() -> void:
	_immediate_mesh.clear_surfaces()
	_draw_ribbon(_left_points,  Color(1.0, 0.9, 0.2))   # yellow = left
	_draw_ribbon(_right_points, Color(0.95, 0.3, 0.2))  # red   = right


# Each entry contributes two vertices offset perpendicular to motion direction,
# stitched as a TRIANGLE_STRIP — produces a continuous flat ribbon along the
# wheel path. Width is constant in world space; alpha fades head-to-tail and
# by per-point ghost decay.
func _draw_ribbon(buf: Array, base_color: Color) -> void:
	var n := buf.size()
	if n < 2:
		return
	var half_w: float = trail_width * 0.5

	_immediate_mesh.surface_begin(Mesh.PRIMITIVE_TRIANGLE_STRIP, _material)

	for i in range(n):
		var pos: Vector3 = buf[i][0]
		var alpha: float = buf[i][1]
		var perp: Vector3 = buf[i][2]
		var head_ratio: float = float(i) / float(n - 1)
		alpha *= head_ratio
		var col := Color(base_color.r, base_color.g, base_color.b, alpha)
		var v_left: Vector3 = pos - perp * half_w
		var v_right: Vector3 = pos + perp * half_w
		_immediate_mesh.surface_set_color(col)
		_immediate_mesh.surface_add_vertex(v_left)
		_immediate_mesh.surface_set_color(col)
		_immediate_mesh.surface_add_vertex(v_right)

	_immediate_mesh.surface_end()


func _on_params_changed(data: Dictionary) -> void:
	_enabled = data.get("DEBUG_VECTORS", _enabled)
	visible = _enabled
	if not _enabled:
		_left_points.clear()
		_right_points.clear()
		_immediate_mesh.clear_surfaces()


func _exit_tree() -> void:
	if DevParams and DevParams.params_changed.is_connected(_on_params_changed):
		DevParams.params_changed.disconnect(_on_params_changed)
