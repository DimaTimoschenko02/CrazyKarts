extends Control

## Browse / create rooms. Polls /api/rooms every POLL_S while visible.

signal logout_requested
signal entered_room(room_code: String)

const POLL_S := 4.0
const DURATIONS := [5, 10, 20]

@onready var greeting_label: Label = $Center/Card/VBox/Header/Greeting
@onready var stats_label: Label = $Center/Card/VBox/Header/Stats
@onready var logout_btn: Button = $Center/Card/VBox/Header/LogoutBtn
@onready var room_list: VBoxContainer = $Center/Card/VBox/Scroll/RoomList
@onready var empty_label: Label = $Center/Card/VBox/EmptyLabel
@onready var status_label: Label = $Center/Card/VBox/StatusLabel
@onready var create_btn: Button = $Center/Card/VBox/Footer/CreateBtn
@onready var duration_dropdown: OptionButton = $Center/Card/VBox/Footer/DurationDropdown
@onready var poll_timer: Timer = $PollTimer

var _pending_room_code: String = ""


func _ready() -> void:
	visible = false
	logout_btn.pressed.connect(_on_logout)
	create_btn.pressed.connect(_on_create_pressed)
	duration_dropdown.clear()
	for d in DURATIONS:
		duration_dropdown.add_item("%d минут" % d, d)
	duration_dropdown.select(0)
	poll_timer.wait_time = POLL_S
	poll_timer.timeout.connect(_on_poll_tick)
	RoomsClient.rooms_updated.connect(_on_rooms_updated)
	RoomsClient.room_created.connect(_on_room_created)
	RoomsClient.request_failed.connect(_on_request_failed)
	NetworkManager.joined_server.connect(_on_joined_server)
	NetworkManager.connection_failed.connect(_on_connection_failed)


func refresh() -> void:
	print("[LobbyHome] refresh visible=", visible, " logged_in=", ProfileManager.is_logged_in)
	# Reset transient interactive state so a previous failed attempt can't leave
	# the create button stuck disabled across navigation / re-login.
	create_btn.disabled = false
	_pending_room_code = ""
	if not ProfileManager.is_logged_in:
		greeting_label.text = "Привет, гость"
		stats_label.text = ""
	else:
		greeting_label.text = "Привет, %s" % ProfileManager.my_nick
		var s: Dictionary = ProfileManager.profile.get("stats", {})
		stats_label.text = "Матчей: %d   K/D: %d/%d" % [
			int(s.get("total_matches", 0)),
			int(s.get("total_kills", 0)),
			int(s.get("total_deaths", 0)),
		]
	_clear_rooms()
	empty_label.text = "Загружаю комнаты…"
	empty_label.visible = true
	status_label.text = ""
	RoomsClient.fetch_rooms_async()
	poll_timer.start()


func _process(_delta: float) -> void:
	# Stop polling when this panel is hidden (cheap visibility check).
	if not visible and not poll_timer.is_stopped():
		poll_timer.stop()


func _on_poll_tick() -> void:
	if visible:
		RoomsClient.fetch_rooms_async()


func _on_rooms_updated(rooms: Array) -> void:
	_clear_rooms()
	if rooms.is_empty():
		empty_label.text = "Пока никто не играет — создай первую"
		empty_label.visible = true
		return
	empty_label.visible = false
	for r_any in rooms:
		var room: Dictionary = r_any
		room_list.add_child(_build_room_card(room))


func _build_room_card(room: Dictionary) -> Control:
	var card := PanelContainer.new()
	card.theme_type_variation = "RoomCard"
	card.custom_minimum_size = Vector2(0, 96)

	var hbox := HBoxContainer.new()
	hbox.add_theme_constant_override("separation", 20)
	card.add_child(hbox)

	var info := VBoxContainer.new()
	info.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	info.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	info.add_theme_constant_override("separation", 4)
	hbox.add_child(info)

	var name_text: String = String(room.get("name", "—"))
	var host_text: String = String(room.get("host_name", ""))
	var current: int = int(room.get("current_players", 0))
	var max_p: int = int(room.get("max_players", 8))
	var state: String = String(room.get("state", "WAITING"))
	var duration: int = int(room.get("duration_min", 0))
	var is_full: bool = bool(room.get("is_full", current >= max_p))

	var name_lbl := Label.new()
	name_lbl.text = name_text
	name_lbl.add_theme_font_size_override("font_size", 24)
	name_lbl.add_theme_color_override("font_color", Color(0.96, 0.98, 1.00))
	info.add_child(name_lbl)

	var meta_lbl := Label.new()
	var pieces: Array = []
	if host_text != "":
		pieces.append("хост %s" % host_text)
	if duration > 0:
		pieces.append("%d мин" % duration)
	pieces.append(_state_label(state))
	meta_lbl.text = "  ·  ".join(pieces)
	meta_lbl.add_theme_font_size_override("font_size", 15)
	meta_lbl.add_theme_color_override("font_color", Color(0.7, 0.78, 0.92))
	info.add_child(meta_lbl)

	var players_lbl := Label.new()
	players_lbl.text = "%d / %d" % [current, max_p]
	players_lbl.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	players_lbl.add_theme_font_size_override("font_size", 28)
	players_lbl.add_theme_color_override("font_color",
		Color(1, 0.5, 0.55) if is_full else Color(0.3, 0.92, 1.0))
	hbox.add_child(players_lbl)

	var join := Button.new()
	join.custom_minimum_size = Vector2(160, 64)
	join.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	join.add_theme_font_size_override("font_size", 20)
	join.text = "ЗАЙТИ ▶" if state == "WAITING" else _state_label(state)
	join.disabled = is_full or state != "WAITING"
	var ws_url: String = String(room.get("ws_url", ""))
	var code: String = String(room.get("room_code", ""))
	join.pressed.connect(func() -> void:
		_pending_room_code = code
		_join_via_ws(ws_url, name_text)
	)
	hbox.add_child(join)

	if join.disabled:
		card.modulate = Color(1, 1, 1, 0.55)

	return card


func _state_label(state: String) -> String:
	match state:
		"WAITING": return "ждут"
		"IN_MATCH": return "матч идёт"
		"POST_MATCH": return "матч окончен"
		_: return state.to_lower()


func _clear_rooms() -> void:
	for child in room_list.get_children():
		child.queue_free()


func _on_create_pressed() -> void:
	create_btn.disabled = true
	status_label.text = "Создаю комнату…"
	var duration: int = duration_dropdown.get_selected_id()
	RoomsClient.create_room_async({
		"host_name": ProfileManager.my_nick,
		"max_players": 8,
		"duration_min": duration,
	})


func _on_room_created(room: Dictionary) -> void:
	var code := String(room.get("room_code", ""))
	status_label.text = "Комната %s создана, подключаюсь…" % code
	_pending_room_code = code
	_join_via_ws(String(room.get("ws_url", "")), String(room.get("name", "")))


func _on_request_failed(endpoint: String, code: int) -> void:
	# Always re-enable the button — even if the panel got hidden by then —
	# so a later refresh() or back-nav doesn't leave Create stuck disabled.
	create_btn.disabled = false
	if visible:
		status_label.text = "Ошибка %s (HTTP %d)" % [endpoint, code]
	else:
		print("[LobbyHome] request failed while hidden: %s (HTTP %d)" % [endpoint, code])


func _join_via_ws(ws_url: String, _room_name: String) -> void:
	if ws_url == "":
		status_label.text = "Нет ws_url у комнаты"
		create_btn.disabled = false
		return
	NetworkManager.join_game(ws_url)


func _on_joined_server() -> void:
	if not visible:
		return
	if _pending_room_code == "":
		return
	entered_room.emit(_pending_room_code)
	_pending_room_code = ""


func _on_connection_failed() -> void:
	# Re-enable unconditionally so navigating away mid-attempt doesn't strand
	# the button in a disabled state.
	create_btn.disabled = false
	if visible:
		status_label.text = "Не удалось подключиться к комнате"
	else:
		print("[LobbyHome] ws connection failed while hidden")


func _on_logout() -> void:
	logout_requested.emit()
