extends Control

signal goto_lobby_home
signal goto_splash

const CHECK_DEBOUNCE_S := 0.5

@onready var nick_input: LineEdit = $Center/Card/VBox/NickInput
@onready var status_label: Label = $Center/Card/VBox/StatusLabel
@onready var submit_btn: Button = $Center/Card/VBox/SubmitBtn
@onready var suggestions_box: HBoxContainer = $Center/Card/VBox/Suggestions
@onready var debounce_timer: Timer = $DebounceTimer

var _last_checked: String = ""
var _last_status: String = "" # "ok" / "conflict" / "error" / "pending"


func _ready() -> void:
	visible = false
	nick_input.text_changed.connect(_on_nick_changed)
	submit_btn.pressed.connect(_on_submit)
	debounce_timer.timeout.connect(_on_debounce_fired)
	debounce_timer.one_shot = true
	debounce_timer.wait_time = CHECK_DEBOUNCE_S
	ProfileManager.nick_available.connect(_on_nick_available)
	ProfileManager.nick_conflict.connect(_on_nick_conflict)
	ProfileManager.profile_loaded.connect(_on_profile_loaded)
	ProfileManager.register_failed.connect(_on_register_failed)
	_set_status("Введи никнейм (2-20 символов: A-Z, 0-9, _ -)", "pending")
	submit_btn.disabled = true


func reset() -> void:
	nick_input.text = ""
	_last_checked = ""
	_last_status = "pending"
	submit_btn.disabled = true
	_clear_suggestions()
	_set_status("Введи никнейм (2-20 символов: A-Z, 0-9, _ -)", "pending")


func _on_nick_changed(new_text: String) -> void:
	submit_btn.disabled = true
	_clear_suggestions()
	var trimmed := new_text.strip_edges()
	if trimmed.length() < 2:
		_set_status("Минимум 2 символа", "pending")
		debounce_timer.stop()
		return
	if trimmed.length() > 20:
		_set_status("Максимум 20 символов", "error")
		debounce_timer.stop()
		return
	if not _is_charset_ok(trimmed):
		_set_status("Только буквы, цифры, _ и -", "error")
		debounce_timer.stop()
		return
	_set_status("Проверяю…", "pending")
	debounce_timer.start()


func _on_debounce_fired() -> void:
	var nick := nick_input.text.strip_edges()
	if nick == _last_checked:
		return
	_last_checked = nick
	ProfileManager.check_nick_async(nick)


func _on_nick_available() -> void:
	if _last_checked == nick_input.text.strip_edges():
		_set_status("Свободно ✓", "ok")
		submit_btn.disabled = false


func _on_nick_conflict(suggestions: Array) -> void:
	_set_status("Этот ник занят", "error")
	_show_suggestions(suggestions)
	submit_btn.disabled = true


func _on_submit() -> void:
	var nick := nick_input.text.strip_edges()
	if nick == "":
		return
	submit_btn.disabled = true
	_set_status("Регистрирую…", "pending")
	ProfileManager.register_async(nick)


func _on_profile_loaded(_data: Dictionary) -> void:
	if not visible:
		return
	goto_lobby_home.emit()


func _on_register_failed(reason: String) -> void:
	if not visible:
		return
	_set_status("Ошибка: %s" % reason, "error")
	submit_btn.disabled = false


func _show_suggestions(suggestions: Array) -> void:
	_clear_suggestions()
	if suggestions.is_empty():
		return
	var hint := Label.new()
	hint.text = "Свободно:"
	hint.add_theme_font_size_override("font_size", 14)
	hint.add_theme_color_override("font_color", Color(0.7, 0.78, 0.92))
	hint.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	suggestions_box.add_child(hint)
	for s_any in suggestions:
		var s := str(s_any)
		var btn := Button.new()
		btn.text = s
		btn.add_theme_font_size_override("font_size", 16)
		btn.custom_minimum_size = Vector2(0, 48)
		btn.size_flags_vertical = Control.SIZE_SHRINK_CENTER
		btn.pressed.connect(func() -> void:
			nick_input.text = s
			_on_nick_changed(s)
			_on_debounce_fired()
		)
		suggestions_box.add_child(btn)


func _clear_suggestions() -> void:
	for child in suggestions_box.get_children():
		child.queue_free()


func _set_status(text: String, kind: String) -> void:
	status_label.text = text
	_last_status = kind
	match kind:
		"ok": status_label.modulate = Color(0.4, 1.0, 0.4)
		"error": status_label.modulate = Color(1.0, 0.5, 0.5)
		"pending": status_label.modulate = Color(0.85, 0.85, 0.85)
		_: status_label.modulate = Color(1, 1, 1)


func _is_charset_ok(s: String) -> bool:
	var re := RegEx.new()
	re.compile("^[A-Za-z0-9_-]+$")
	return re.search(s) != null
