extends CanvasLayer
class_name DebugInputOverlay

const KEY_SIZE     := 40
const KEY_ACTIVE   := Color(1.0, 0.85, 0.0, 1.0)
const KEY_INACTIVE := Color(0.18, 0.18, 0.18, 0.85)
const FONT_SIZE    := 22
const LABEL_COLOR  := Color(1.0, 1.0, 1.0, 1.0)

var target: CharacterBody3D

var _enabled: bool = true

var _key_w: ColorRect
var _key_a: ColorRect
var _key_s: ColorRect
var _key_d: ColorRect

var _lbl_throttle: Label
var _lbl_steer:    Label
var _lbl_speed:    Label

var _prev_throttle: String = ""
var _prev_steer:    String = ""
var _prev_speed:    String = ""


func _ready() -> void:
	layer = 11

	var root := Control.new()
	root.set_anchors_and_offsets_preset(Control.PRESET_TOP_LEFT)
	root.position = Vector2(12.0, 12.0)
	root.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(root)

	_key_w = _make_key_rect("W")
	_key_a = _make_key_rect("A")
	_key_s = _make_key_rect("S")
	_key_d = _make_key_rect("D")

	var col := VBoxContainer.new()
	col.add_theme_constant_override("separation", 3)
	col.mouse_filter = Control.MOUSE_FILTER_IGNORE
	root.add_child(col)

	var top_row := HBoxContainer.new()
	top_row.add_theme_constant_override("separation", 4)
	top_row.mouse_filter = Control.MOUSE_FILTER_IGNORE
	var spacer := Control.new()
	spacer.custom_minimum_size = Vector2(float(KEY_SIZE + 4), float(KEY_SIZE))
	spacer.mouse_filter = Control.MOUSE_FILTER_IGNORE
	top_row.add_child(spacer)
	top_row.add_child(_key_w)
	col.add_child(top_row)

	var bot_row := HBoxContainer.new()
	bot_row.add_theme_constant_override("separation", 4)
	bot_row.mouse_filter = Control.MOUSE_FILTER_IGNORE
	bot_row.add_child(_key_a)
	bot_row.add_child(_key_s)
	bot_row.add_child(_key_d)
	col.add_child(bot_row)

	var metrics := VBoxContainer.new()
	metrics.position = Vector2(0.0, float(KEY_SIZE * 2 + 12))
	metrics.add_theme_constant_override("separation", 2)
	metrics.mouse_filter = Control.MOUSE_FILTER_IGNORE
	root.add_child(metrics)

	_lbl_throttle = _make_label()
	_lbl_steer    = _make_label()
	_lbl_speed    = _make_label()
	metrics.add_child(_lbl_throttle)
	metrics.add_child(_lbl_steer)
	metrics.add_child(_lbl_speed)

	_enabled = bool(DevParams.get_param("DEBUG_VECTORS", true))
	visible = _enabled
	DevParams.params_changed.connect(_on_params_changed)


func _process(_delta: float) -> void:
	if not _enabled:
		return
	if not is_instance_valid(target):
		return

	_key_w.color = KEY_ACTIVE if Input.is_action_pressed("move_forward")  else KEY_INACTIVE
	_key_s.color = KEY_ACTIVE if Input.is_action_pressed("move_backward") else KEY_INACTIVE
	_key_a.color = KEY_ACTIVE if Input.is_action_pressed("steer_left")    else KEY_INACTIVE
	_key_d.color = KEY_ACTIVE if Input.is_action_pressed("steer_right")   else KEY_INACTIVE

	var throttle: float = 0.0
	var steer: float    = 0.0
	if target.has_method("get_throttle_debug"):
		throttle = target.get_throttle_debug()
	if target.has_method("get_steer_input_debug"):
		steer = target.get_steer_input_debug()

	var fwd_speed: float = target.velocity.dot(-target.global_transform.basis.z)

	var t_str := "throttle: %+.2f" % throttle
	var s_str := "steer:    %+.2f" % steer
	var v_str := "speed:    %5.1f m/s" % fwd_speed

	if _prev_throttle != t_str:
		_lbl_throttle.text = t_str
		_prev_throttle = t_str
	if _prev_steer != s_str:
		_lbl_steer.text = s_str
		_prev_steer = s_str
	if _prev_speed != v_str:
		_lbl_speed.text = v_str
		_prev_speed = v_str


func _make_key_rect(label_text: String) -> ColorRect:
	var rect := ColorRect.new()
	rect.custom_minimum_size = Vector2(float(KEY_SIZE), float(KEY_SIZE))
	rect.color = KEY_INACTIVE
	rect.mouse_filter = Control.MOUSE_FILTER_IGNORE

	var lbl := Label.new()
	lbl.text = label_text
	lbl.add_theme_font_size_override("font_size", FONT_SIZE)
	lbl.add_theme_color_override("font_color", Color.WHITE)
	lbl.add_theme_color_override("font_outline_color", Color.BLACK)
	lbl.add_theme_constant_override("outline_size", 3)
	lbl.set_anchors_and_offsets_preset(Control.PRESET_CENTER)
	lbl.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	lbl.vertical_alignment   = VERTICAL_ALIGNMENT_CENTER
	lbl.mouse_filter = Control.MOUSE_FILTER_IGNORE
	rect.add_child(lbl)
	return rect


func _make_label() -> Label:
	var lbl := Label.new()
	lbl.add_theme_font_size_override("font_size", FONT_SIZE)
	lbl.add_theme_color_override("font_color", LABEL_COLOR)
	lbl.add_theme_color_override("font_outline_color", Color.BLACK)
	lbl.add_theme_constant_override("outline_size", 4)
	lbl.mouse_filter = Control.MOUSE_FILTER_IGNORE
	return lbl


func _on_params_changed(data: Dictionary) -> void:
	_enabled = bool(data.get("DEBUG_VECTORS", _enabled))
	visible = _enabled


func _exit_tree() -> void:
	if DevParams and DevParams.params_changed.is_connected(_on_params_changed):
		DevParams.params_changed.disconnect(_on_params_changed)
