extends Node3D
class_name DebugVectors3D

const VECTOR_RADIUS := 0.06
const LABEL_Y_OFFSET := 3.8        # start well above NameLabel
const LABEL_SPACING := 0.45        # more vertical gap
const LABEL_X_OFFSET := 1.2        # shifted to the right side of kart
const LABEL_PIXEL_SIZE := 0.009    # bigger render scale

var target: CharacterBody3D

var _vec_velocity: MeshInstance3D
var _vec_forward:  MeshInstance3D
var _vec_lateral:  MeshInstance3D

var _lbl_drift: Label3D
var _lbl_fwd:   Label3D
var _lbl_lat:   Label3D
var _lbl_grip:  Label3D

var _enabled: bool = true

var _prev_drift: String = ""
var _prev_fwd:   String = ""
var _prev_lat:   String = ""
var _prev_grip:  String = ""


func _ready() -> void:
	_vec_velocity = _create_vector_mesh(Color.GREEN)
	_vec_forward  = _create_vector_mesh(Color(0.3, 0.6, 1.0))
	_vec_lateral  = _create_vector_mesh(Color(1.0, 0.3, 0.3))

	_lbl_drift = _create_label(Color.YELLOW, 0)
	_lbl_fwd   = _create_label(Color(0.6, 0.8, 1.0), 1)
	_lbl_lat   = _create_label(Color(1.0, 0.5, 0.5), 2)
	_lbl_grip  = _create_label(Color.WHITE, 3)

	_enabled = DevParams.get_param("DEBUG_VECTORS", true)
	visible = _enabled
	if DevParams:
		DevParams.params_changed.connect(_on_params_changed)


func _process(_delta: float) -> void:
	if not _enabled:
		return
	if not is_instance_valid(target):
		return

	global_position = target.global_position

	var vel: Vector3 = target.velocity
	var basis: Basis = target.global_transform.basis
	var fwd_dir:  Vector3 = -basis.z
	var side_dir: Vector3 =  basis.x

	var fwd_speed: float = vel.dot(fwd_dir)
	var lat_speed: float = vel.dot(side_dir)

	_update_vector(_vec_velocity, vel)
	_update_vector(_vec_forward,  fwd_dir  * fwd_speed)
	_update_vector(_vec_lateral,  side_dir * lat_speed * 2.0)

	var is_drifting: bool = false
	if target.has_method("get_is_drifting_debug"):
		is_drifting = target.get_is_drifting_debug()

	var grip: float = 0.0
	if target.has_method("get_grip_debug"):
		grip = target.get_grip_debug()

	_set_text(_lbl_drift, "drift: %s" % ("YES" if is_drifting else "no"),  "_prev_drift")
	_set_text(_lbl_fwd,   "fwd:  %5.1f m/s" % fwd_speed, "_prev_fwd")
	_set_text(_lbl_lat,   "lat:  %5.1f m/s" % lat_speed, "_prev_lat")
	_set_text(_lbl_grip,  "grip: %5.2f"     % grip,       "_prev_grip")


func _create_vector_mesh(color: Color) -> MeshInstance3D:
	var mi := MeshInstance3D.new()
	var mesh := CylinderMesh.new()
	mesh.top_radius = VECTOR_RADIUS
	mesh.bottom_radius = VECTOR_RADIUS
	mesh.height = 1.0
	mi.mesh = mesh

	var mat := StandardMaterial3D.new()
	mat.albedo_color = color
	mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	mat.no_depth_test = true
	mi.material_override = mat

	add_child(mi)
	return mi


func _create_label(color: Color, row: int) -> Label3D:
	var lbl := Label3D.new()
	lbl.billboard = BaseMaterial3D.BILLBOARD_ENABLED
	lbl.modulate = color
	lbl.font_size = 48
	lbl.outline_size = 12
	lbl.outline_modulate = Color(0, 0, 0, 0.9)
	lbl.no_depth_test = true
	lbl.pixel_size = LABEL_PIXEL_SIZE
	lbl.horizontal_alignment = HORIZONTAL_ALIGNMENT_LEFT
	lbl.position = Vector3(LABEL_X_OFFSET, LABEL_Y_OFFSET - float(row) * LABEL_SPACING, 0.0)
	add_child(lbl)
	return lbl


func _update_vector(mi: MeshInstance3D, vector: Vector3) -> void:
	var length: float = vector.length()
	if length < 0.05:
		mi.visible = false
		return
	mi.visible = true

	var dir: Vector3 = vector / length
	var up_ref: Vector3 = Vector3.UP if absf(dir.dot(Vector3.UP)) < 0.99 else Vector3.FORWARD
	var x_axis: Vector3 = dir.cross(up_ref).normalized()
	var z_axis: Vector3 = x_axis.cross(dir).normalized()
	var b := Basis(x_axis, dir, z_axis)
	b = b.scaled(Vector3(1.0, length, 1.0))

	mi.transform = Transform3D(b, vector * 0.5)


func _set_text(lbl: Label3D, new_text: String, prev_var: String) -> void:
	if get(prev_var) != new_text:
		lbl.text = new_text
		set(prev_var, new_text)


func _on_params_changed(data: Dictionary) -> void:
	_enabled = data.get("DEBUG_VECTORS", _enabled)
	visible = _enabled


func _exit_tree() -> void:
	if DevParams and DevParams.params_changed.is_connected(_on_params_changed):
		DevParams.params_changed.disconnect(_on_params_changed)
