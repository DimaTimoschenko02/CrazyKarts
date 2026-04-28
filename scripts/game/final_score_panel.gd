extends CanvasLayer

## Match-end scoreboard overlay. Shown after GameManager.match_finished.
## Two CTAs: "Back to lobby" (any peer) and "Play again" (host only).

@onready var dimmer: ColorRect            = $Dimmer
@onready var card: PanelContainer         = $Center/Card
@onready var title_label: Label           = $Center/Card/VBox/Title
@onready var subtitle_label: Label        = $Center/Card/VBox/Subtitle
@onready var rows_box: VBoxContainer      = $Center/Card/VBox/Scroll/Rows
@onready var status_label: Label          = $Center/Card/VBox/Status
@onready var leave_btn: Button            = $Center/Card/VBox/Buttons/LeaveBtn
@onready var replay_btn: Button           = $Center/Card/VBox/Buttons/ReplayBtn


func _ready() -> void:
	layer = 8 # above HUD (1) and below PauseMenu (10)
	visible = false
	GameManager.match_finished.connect(_on_match_finished)
	leave_btn.pressed.connect(_on_leave_pressed)
	replay_btn.pressed.connect(_on_replay_pressed)


func _exit_tree() -> void:
	if GameManager.match_finished.is_connected(_on_match_finished):
		GameManager.match_finished.disconnect(_on_match_finished)


func _on_match_finished(results: Dictionary) -> void:
	_render(results)
	visible = true


func _render(results: Dictionary) -> void:
	for child in rows_box.get_children():
		child.queue_free()

	var rows: Array = results.get("rows", [])
	subtitle_label.text = "Длительность: %d мин · игроков: %d" % [
		int(results.get("duration_s", 0)) / 60,
		rows.size(),
	]

	rows_box.add_child(_build_header())
	for i in range(rows.size()):
		var row_data: Dictionary = rows[i]
		rows_box.add_child(_build_row(i + 1, row_data))

	# Replay rules: only the host (peer_id 1 OR is_server) can fire restart.
	# Browser clients see disabled button with hint.
	var i_am_host: bool = multiplayer.is_server() or _has_host_peer()
	if i_am_host:
		replay_btn.disabled = false
		replay_btn.text = "Играть ещё раз"
		status_label.text = ""
	else:
		replay_btn.disabled = true
		replay_btn.text = "Ждём хоста"
		status_label.text = "Только хост может запустить новый матч"


func _has_host_peer() -> bool:
	# Friend-game model: any client may also request restart via RPC and
	# server will accept. So we just always allow the button.
	return true


func _build_header() -> Control:
	var row := PanelContainer.new()
	row.theme_type_variation = "RoomCard"
	row.modulate = Color(1, 1, 1, 0.7)
	var hbox := HBoxContainer.new()
	hbox.add_theme_constant_override("separation", 12)
	row.add_child(hbox)
	var cols := [
		{"text": "#",        "size": 56,  "align": HORIZONTAL_ALIGNMENT_CENTER},
		{"text": "ИГРОК",    "size": 0,   "align": HORIZONTAL_ALIGNMENT_LEFT, "expand": true},
		{"text": "K",        "size": 90,  "align": HORIZONTAL_ALIGNMENT_RIGHT},
		{"text": "D",        "size": 90,  "align": HORIZONTAL_ALIGNMENT_RIGHT},
		{"text": "УРОН",     "size": 110, "align": HORIZONTAL_ALIGNMENT_RIGHT},
		{"text": "ТОЧН.",    "size": 90,  "align": HORIZONTAL_ALIGNMENT_RIGHT},
	]
	for c in cols:
		var lbl := Label.new()
		lbl.text = String(c["text"])
		lbl.horizontal_alignment = int(c["align"])
		lbl.add_theme_font_size_override("font_size", 16)
		lbl.add_theme_color_override("font_color", Color(0.3, 0.92, 1, 1))
		var sz: int = int(c["size"])
		if sz > 0:
			lbl.custom_minimum_size = Vector2(sz, 0)
		if bool(c.get("expand", false)):
			lbl.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		hbox.add_child(lbl)
	return row


func _build_row(rank: int, data: Dictionary) -> Control:
	var row := PanelContainer.new()
	row.theme_type_variation = "RoomCard"
	row.custom_minimum_size = Vector2(0, 72)

	var hbox := HBoxContainer.new()
	hbox.add_theme_constant_override("separation", 12)
	row.add_child(hbox)

	var rank_lbl := Label.new()
	rank_lbl.text = str(rank)
	rank_lbl.custom_minimum_size = Vector2(56, 0)
	rank_lbl.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	rank_lbl.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	rank_lbl.add_theme_font_size_override("font_size", 28)
	rank_lbl.add_theme_color_override("font_color",
		Color(1, 0.84, 0.2) if rank == 1 else Color(0.7, 0.78, 0.92))
	hbox.add_child(rank_lbl)

	var name_lbl := Label.new()
	name_lbl.text = String(data.get("name", "?"))
	name_lbl.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	name_lbl.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	name_lbl.add_theme_font_size_override("font_size", 22)
	if rank == 1:
		name_lbl.add_theme_color_override("font_color", Color(1, 0.84, 0.2))
	hbox.add_child(name_lbl)

	hbox.add_child(_make_num_label(int(data.get("kills", 0)),         90))
	hbox.add_child(_make_num_label(int(data.get("deaths", 0)),        90))
	hbox.add_child(_make_num_label(int(data.get("damage_dealt", 0)),  110))
	hbox.add_child(_make_pct_label(float(data.get("accuracy_pct", 0)), 90))
	return row


func _make_num_label(value: int, min_w: int) -> Label:
	var lbl := Label.new()
	lbl.text = str(value)
	lbl.custom_minimum_size = Vector2(min_w, 0)
	lbl.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
	lbl.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	lbl.add_theme_font_size_override("font_size", 22)
	return lbl


func _make_pct_label(value: float, min_w: int) -> Label:
	var lbl := Label.new()
	lbl.text = "%.0f%%" % value
	lbl.custom_minimum_size = Vector2(min_w, 0)
	lbl.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
	lbl.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	lbl.add_theme_font_size_override("font_size", 22)
	return lbl


func _on_leave_pressed() -> void:
	leave_btn.disabled = true
	replay_btn.disabled = true
	status_label.text = "Возвращаюсь в лобби…"
	NetworkManager.disconnect_from_game()
	get_tree().change_scene_to_file("res://scenes/lobby.tscn")


func _on_replay_pressed() -> void:
	replay_btn.disabled = true
	leave_btn.disabled = true
	status_label.text = "Запускаю новый матч…"
	NetworkManager.request_match_restart()
