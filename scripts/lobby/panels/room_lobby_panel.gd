extends Control

## Pre-match waiting room: player list, invite link, "Start" (host), "Leave".

signal goto_lobby_home

@onready var title_label: Label = $Center/Card/VBox/HeaderHBox/Title
@onready var badge_label: Label = $Center/Card/VBox/HeaderHBox/Badge
@onready var invite_label: LineEdit = $Center/Card/VBox/Invite/InviteValue
@onready var copy_btn: Button = $Center/Card/VBox/Invite/CopyBtn
@onready var player_list: VBoxContainer = $Center/Card/VBox/PlayerList
@onready var start_btn: Button = $Center/Card/VBox/Footer/StartBtn
@onready var leave_btn: Button = $Center/Card/VBox/Footer/LeaveBtn
@onready var status_label: Label = $Center/Card/VBox/StatusLabel

var _room_code: String = ""


func _ready() -> void:
	visible = false
	NetworkManager.lobby_players_changed.connect(_on_roster)
	NetworkManager.match_starting.connect(_on_match_starting)
	start_btn.pressed.connect(_on_start_pressed)
	leave_btn.pressed.connect(_on_leave_pressed)
	copy_btn.pressed.connect(_on_copy_pressed)


func enter(room_code: String) -> void:
	print("[RoomLobbyPanel] enter room=", room_code, " my_nick=", ProfileManager.my_nick, " my_id=", multiplayer.get_unique_id())
	_room_code = room_code.to_upper()
	title_label.text = "Комната  %s" % _room_code
	badge_label.text = "ожидание игроков"
	invite_label.text = _build_invite_url()
	copy_btn.disabled = false
	status_label.text = ""
	# Friend-game: any client may start the match
	start_btn.disabled = false
	leave_btn.disabled = false
	# Push my nick to roster
	if ProfileManager.my_nick != "":
		NetworkManager.register_in_lobby(ProfileManager.my_nick)
	_on_roster(NetworkManager.lobby_players)


func _build_invite_url() -> String:
	var base := "http://localhost:8060"
	if OS.has_feature("web"):
		var raw: Variant = JavaScriptBridge.eval("window.location.origin")
		if raw != null:
			base = str(raw)
	return "%s/?join=%s" % [base, _room_code]


func _on_roster(players: Dictionary) -> void:
	for child in player_list.get_children():
		child.queue_free()
	if players.is_empty():
		var hint := Label.new()
		hint.text = "В комнате пока никого"
		hint.add_theme_font_size_override("font_size", 17)
		hint.add_theme_color_override("font_color", Color(0.7, 0.78, 0.92))
		hint.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
		player_list.add_child(hint)
		return
	for pid in players:
		player_list.add_child(_build_player_row(int(pid), str(players[pid])))


func _build_player_row(pid: int, nick: String) -> Control:
	var row := PanelContainer.new()
	row.theme_type_variation = "RoomCard"
	row.custom_minimum_size = Vector2(0, 64)

	var hbox := HBoxContainer.new()
	hbox.add_theme_constant_override("separation", 16)
	row.add_child(hbox)

	var dot := Label.new()
	dot.text = "●"
	dot.add_theme_font_size_override("font_size", 22)
	dot.add_theme_color_override("font_color", Color(0.40, 0.96, 0.50))
	dot.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	hbox.add_child(dot)

	var name_lbl := Label.new()
	name_lbl.text = nick
	name_lbl.add_theme_font_size_override("font_size", 22)
	name_lbl.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	name_lbl.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	hbox.add_child(name_lbl)

	if pid == 1:
		var host_tag := Label.new()
		host_tag.text = "ХОСТ"
		host_tag.add_theme_font_size_override("font_size", 14)
		host_tag.add_theme_color_override("font_color", Color(1, 0.84, 0.2))
		host_tag.size_flags_vertical = Control.SIZE_SHRINK_CENTER
		hbox.add_child(host_tag)

	return row


func _on_start_pressed() -> void:
	start_btn.disabled = true
	badge_label.text = "запускаю матч…"
	status_label.text = "Запускаю матч…"
	NetworkManager.request_match_start()


func _on_match_starting() -> void:
	badge_label.text = "матч стартует…"
	status_label.text = "Матч стартует…"
	get_tree().change_scene_to_file("res://scenes/game.tscn")


func _on_leave_pressed() -> void:
	leave_btn.disabled = true
	NetworkManager.disconnect_from_game()
	goto_lobby_home.emit()


func _on_copy_pressed() -> void:
	var url := invite_label.text
	if OS.has_feature("web"):
		var js := """
			navigator.clipboard.writeText(%s).catch(function(){});
		""" % JSON.stringify(url)
		JavaScriptBridge.eval(js, true)
	else:
		DisplayServer.clipboard_set(url)
	status_label.text = "Ссылка скопирована"
	copy_btn.text = "✓  Скопировано"
	get_tree().create_timer(2.0).timeout.connect(func() -> void:
		if is_inside_tree():
			copy_btn.text = "Скопировать"
	)
