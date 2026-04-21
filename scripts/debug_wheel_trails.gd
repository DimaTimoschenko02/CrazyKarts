extends Node3D
class_name DebugWheelTrails

# Debug overlay: renders skid trails behind rear wheels during drift/slide.
# Implements: visual debug aid for arcade-physics v2.1 (GDD kart-physics.md).
# Left trail = yellow (1, 0.9, 0.2), Right trail = red (0.95, 0.3, 0.2).
# Uses ImmediateMesh + PRIMITIVE_LINE_STRIP with vertex-color alpha fade.
# Temporary debug tool — will be replaced by Decal/shader skid marks post-MVP.

## Maximum trail points per wheel. At 60 fps this covers ~2 seconds of history.
const MAX_POINTS := 120

## Slight Y lift to avoid z-fighting with the floor geometry.
@export var wheel_height_offset: float = 0.06

## Lateral offset from kart center to approximate rear-wheel world position.
## Used as fallback if wheel nodes are not reachable from target.
@export var wheel_offset_lateral: float = 0.6

## Rear offset from kart center (negative = behind in local Z).
@export var wheel_offset_rear: float = -0.7

## Speed at which a trail point fades from full alpha to zero once the
## active condition clears. Lower = longer ghost trail.
@export var fade_speed: float = 1.5

@export var target: Node3D

var _enabled: bool = true

# Ring-buffer style arrays: each entry is [Vector3 pos, float alpha].
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

	# --- Determine whether to record new points this frame ---
	var is_drifting: bool = false
	var side_speed:  float = 0.0
	var smoke_threshold: float = 0.5  # fallback if no physics resource

	if target.has_method("get_is_drifting_debug"):
		is_drifting = target.get_is_drifting_debug()
	if "side_speed" in target:
		side_speed = absf(target.side_speed)
	elif "_cached_side_speed" in target:
		side_speed = absf(target._cached_side_speed)

	if target.get("physics") and target.physics.get("vfx_smoke_speed_threshold") != null:
		smoke_threshold = target.physics.vfx_smoke_speed_threshold

	var active: bool = is_drifting or side_speed > smoke_threshold

	# --- Resolve rear-wheel world positions ---
	var pos_left:  Vector3 = _get_wheel_pos(target, true)
	var pos_right: Vector3 = _get_wheel_pos(target, false)

	# Snap Y to the kart floor level + small lift
	pos_left.y  = target.global_position.y + wheel_height_offset
	pos_right.y = target.global_position.y + wheel_height_offset

	# --- Append new points when active ---
	if active:
		_push_point(_left_points,  pos_left)
		_push_point(_right_points, pos_right)

	# --- Fade all stored alphas ---
	_fade_points(_left_points,  delta)
	_fade_points(_right_points, delta)

	# --- Rebuild mesh ---
	_rebuild_mesh()


func _get_wheel_pos(kart: Node3D, is_left: bool) -> Vector3:
	# Try to read directly from the wheel MeshInstance3D nodes used in kart_controller.
	# LT = rear-left (_wheel_rl), RT = rear-right (_wheel_rr).
	var node_name: String = "BaseCar/MainCar/Car2/LT" if is_left else "BaseCar/MainCar/Car2/RT"
	var wheel_node := kart.get_node_or_null(node_name) as Node3D
	if wheel_node:
		return wheel_node.global_position

	# Fallback: approximate from kart transform + configurable offsets.
	var lateral_sign: float = -1.0 if is_left else 1.0
	var local_offset := Vector3(
		lateral_sign * wheel_offset_lateral,
		0.0,
		wheel_offset_rear
	)
	return kart.global_transform * local_offset


func _push_point(buf: Array, pos: Vector3) -> void:
	buf.push_back([pos, 1.0])
	if buf.size() > MAX_POINTS:
		buf.pop_front()


func _fade_points(buf: Array, delta: float) -> void:
	# Fade from tail (oldest = index 0) toward head, and remove fully faded entries.
	var i := 0
	while i < buf.size():
		# Points near the tail are oldest; decay them faster using a tail bias.
		var tail_ratio: float = 1.0 - float(i) / maxf(float(buf.size() - 1), 1.0)
		var decay: float = fade_speed * (0.5 + tail_ratio * 1.5)
		buf[i][1] = maxf(buf[i][1] - decay * delta, 0.0)
		if buf[i][1] <= 0.0:
			buf.remove_at(i)
		else:
			i += 1


func _rebuild_mesh() -> void:
	_immediate_mesh.clear_surfaces()

	_draw_trail(_left_points,  Color(1.0, 0.9, 0.2))   # yellow = left
	_draw_trail(_right_points, Color(0.95, 0.3, 0.2))  # red   = right


func _draw_trail(buf: Array, base_color: Color) -> void:
	var n := buf.size()
	if n < 2:
		return

	_immediate_mesh.surface_begin(Mesh.PRIMITIVE_LINE_STRIP, _material)

	for i in range(n):
		var alpha: float = buf[i][1]
		# Additional per-index fade: head (newest = last index) is brightest.
		var head_ratio: float = float(i) / float(n - 1)
		alpha *= head_ratio  # 0 at oldest end, 1 at newest
		var col := Color(base_color.r, base_color.g, base_color.b, alpha)
		_immediate_mesh.surface_set_color(col)
		_immediate_mesh.surface_add_vertex(buf[i][0])

	_immediate_mesh.surface_end()


func _on_params_changed(data: Dictionary) -> void:
	_enabled = data.get("DEBUG_VECTORS", _enabled)
	visible = _enabled
	if not _enabled:
		# Clear trails so stale points don't reappear on re-enable.
		_left_points.clear()
		_right_points.clear()
		_immediate_mesh.clear_surfaces()


func _exit_tree() -> void:
	if DevParams and DevParams.params_changed.is_connected(_on_params_changed):
		DevParams.params_changed.disconnect(_on_params_changed)
