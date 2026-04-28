extends Control

signal goto_first_time
signal goto_lobby_home
signal goto_room_lobby(room_code: String)

@onready var status_label: Label = $Center/VBox/StatusLabel

var _deep_link_code: String = ""


func _ready() -> void:
	print("[SplashPanel] _ready")
	visible = true
	status_label.text = "Загрузка…"
	_deep_link_code = _read_join_param()
	ProfileManager.profile_loaded.connect(_on_profile_loaded)
	ProfileManager.profile_load_failed.connect(_on_profile_load_failed)
	RoomsClient.room_resolved.connect(_on_room_resolved)
	RoomsClient.request_failed.connect(_on_request_failed)
	NetworkManager.joined_server.connect(_on_joined_server)
	NetworkManager.connection_failed.connect(_on_connection_failed)
	# Один кадр чтобы UI отрисовался
	await get_tree().process_frame
	ProfileManager.auth_check_async()


func _on_profile_loaded(_data: Dictionary) -> void:
	if _deep_link_code != "":
		status_label.text = "Подключаюсь к %s…" % _deep_link_code
		RoomsClient.resolve_room_async(_deep_link_code)
		return
	status_label.text = "Привет, %s" % ProfileManager.my_nick
	goto_lobby_home.emit()


func _on_profile_load_failed(reason: String) -> void:
	if reason != "no_token":
		status_label.text = "Сессия истекла, войди заново"
	goto_first_time.emit()


func _on_room_resolved(room: Dictionary) -> void:
	if _deep_link_code == "":
		return
	var ws_url: String = String(room.get("ws_url", ""))
	if ws_url == "":
		status_label.text = "Комната без ws_url"
		goto_lobby_home.emit()
		_deep_link_code = ""
		return
	NetworkManager.join_game(ws_url)


func _on_joined_server() -> void:
	if _deep_link_code == "":
		return
	var code := _deep_link_code
	_deep_link_code = ""
	goto_room_lobby.emit(code)


func _on_connection_failed() -> void:
	if _deep_link_code == "":
		return
	status_label.text = "Не удалось подключиться к %s" % _deep_link_code
	_deep_link_code = ""
	goto_lobby_home.emit()


func _on_request_failed(endpoint: String, code: int) -> void:
	if not endpoint.begins_with("resolve_room"):
		return
	status_label.text = "Комната %s не найдена (HTTP %d)" % [_deep_link_code, code]
	_deep_link_code = ""
	goto_lobby_home.emit()


func _read_join_param() -> String:
	if not OS.has_feature("web"):
		return ""
	var raw: Variant = JavaScriptBridge.eval("(new URLSearchParams(window.location.search)).get('join') || ''")
	if raw == null:
		return ""
	return str(raw).strip_edges()
