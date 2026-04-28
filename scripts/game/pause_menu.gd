extends CanvasLayer

## In-game pause overlay: ESC toggles. Two views — Main (Continue / Settings /
## Quit) and Settings (placeholder + Back). Pause uses get_tree().paused so
## physics + kart input freeze. NetworkManager / GameManager / StateManager
## are ALWAYS so the connection stays alive.

@onready var main_view: VBoxContainer    = $Center/Card/Views/MainView
@onready var settings_view: VBoxContainer = $Center/Card/Views/SettingsView
@onready var continue_btn: Button         = $Center/Card/Views/MainView/ContinueBtn
@onready var settings_btn: Button         = $Center/Card/Views/MainView/SettingsBtn
@onready var leave_btn: Button            = $Center/Card/Views/MainView/LeaveBtn
@onready var back_btn: Button             = $Center/Card/Views/SettingsView/BackBtn


func _ready() -> void:
	# Layer above HUD (1) and FinalScorePanel (8) so it never gets covered.
	layer = 12
	# ALWAYS — _unhandled_input must fire both before and during pause.
	process_mode = Node.PROCESS_MODE_ALWAYS
	visible = false
	main_view.visible = true
	settings_view.visible = false
	continue_btn.pressed.connect(_close)
	settings_btn.pressed.connect(_show_settings)
	leave_btn.pressed.connect(_on_leave_pressed)
	back_btn.pressed.connect(_show_main)


func _unhandled_input(event: InputEvent) -> void:
	if not (event is InputEventKey):
		return
	if not event.pressed or event.echo:
		return
	if event.keycode != KEY_ESCAPE:
		return
	get_viewport().set_input_as_handled()
	if visible:
		_close()
	else:
		_open()


func _open() -> void:
	main_view.visible = true
	settings_view.visible = false
	visible = true
	get_tree().paused = true


func _close() -> void:
	visible = false
	get_tree().paused = false


func _show_settings() -> void:
	main_view.visible = false
	settings_view.visible = true


func _show_main() -> void:
	settings_view.visible = false
	main_view.visible = true


func _on_leave_pressed() -> void:
	leave_btn.disabled = true
	# Resume tree so scene change isn't blocked, then disconnect + go to lobby.
	get_tree().paused = false
	NetworkManager.disconnect_from_game()
	get_tree().change_scene_to_file("res://scenes/lobby.tscn")
