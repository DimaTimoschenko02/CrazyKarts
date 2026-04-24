extends Control

@export_file("*.tscn") var game_scene: String = "res://scenes/game.tscn"

@onready var name_input:   LineEdit = $VBox/NameRow/NameInput
@onready var ip_input:     LineEdit = $VBox/JoinRow/IPInput
@onready var status_label: Label    = $VBox/StatusLabel
@onready var host_btn:     Button   = $VBox/HostRow/HostBtn
@onready var join_btn:     Button   = $VBox/JoinRow/JoinBtn

func _ready() -> void:
	print("[Lobby] _ready: web=", OS.has_feature("web"), " my_name=", PlayerData.my_name)
	NetworkManager.server_created.connect(_on_server_created)
	NetworkManager.joined_server.connect(_on_joined_server)
	NetworkManager.connection_failed.connect(_on_connection_failed)
	if OS.has_feature("web"):
		ip_input.text = ""
		host_btn.disabled = true
		status_label.text = "Host in desktop build. Join via ws://host:port or wss://..."
		# Авто-джоин по URL параметрам: ?join=АДРЕС&name=ИМЯ
		_try_auto_join()
	else:
		ip_input.text = "127.0.0.1"

	# Auto-host for automated testing (launch with -- --autohost)
	if "--autohost" in OS.get_cmdline_user_args():
		print("[Lobby] --autohost detected, starting server automatically")
		name_input.text = "AutoHost"
		PlayerData.my_name = "AutoHost"
		await get_tree().process_frame
		var err := NetworkManager.host_game()
		if err != OK:
			status_label.text = "Autohost failed (port %d in use?)" % NetworkManager.PORT

func _try_auto_join() -> void:
	var join_addr := _get_url_param("join")
	if join_addr.is_empty():
		return
	var pname := _get_url_param("name")
	if pname.is_empty():
		pname = "Player_%d" % randi_range(100, 999)
	print("[Lobby] Auto-join: addr=%s name=%s" % [join_addr, pname])
	name_input.text = pname
	ip_input.text = join_addr
	# Даём один кадр на инициализацию UI, потом подключаемся
	await get_tree().process_frame
	_on_join_pressed()

func _get_url_param(key: String) -> String:
	if not OS.has_feature("web"):
		return ""
	var js_code := """
		(function() {
			var params = new URLSearchParams(window.location.search);
			return params.get('%s') || '';
		})()
	""" % key
	var result = JavaScriptBridge.eval(js_code)
	if result == null:
		return ""
	return str(result)

func _on_host_pressed() -> void:
	if OS.has_feature("web"):
		status_label.text = "Web build cannot host server. Run host from desktop build."
		return
	var pname := name_input.text.strip_edges()
	if pname.is_empty():
		status_label.text = "Enter your name!"
		return
	PlayerData.my_name = pname
	_set_buttons(false)
	status_label.text = "Starting server…"
	var err := NetworkManager.host_game()
	if err != OK:
		status_label.text = "Could not start server (port %d in use?)" % NetworkManager.PORT
		_set_buttons(true)

func _on_join_pressed() -> void:
	var pname := name_input.text.strip_edges()
	if pname.is_empty():
		status_label.text = "Enter your name!"
		return
	var ip := ip_input.text.strip_edges()
	if ip.is_empty():
		status_label.text = "Enter server address!"
		return
	PlayerData.my_name = pname
	_set_buttons(false)
	status_label.text = "Connecting to %s…" % ip
	var err := NetworkManager.join_game(ip)
	if err != OK:
		status_label.text = "Failed to connect. Use host, host:port, ws:// or wss://."
		_set_buttons(true)

func _on_server_created() -> void:
	status_label.text = "Server ready – loading game…"
	get_tree().change_scene_to_file(game_scene)

func _on_joined_server() -> void:
	status_label.text = "Connected! Loading game…"
	get_tree().change_scene_to_file(game_scene)

func _on_connection_failed() -> void:
	status_label.text = "Connection failed. Check IP and try again."
	_set_buttons(true)

func _set_buttons(enabled: bool) -> void:
	host_btn.disabled = (not enabled) or OS.has_feature("web")
	join_btn.disabled = not enabled
