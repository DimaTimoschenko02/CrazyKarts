extends Control

## State machine for the lobby UI. Replaces lobby.gd.
## Panels are children that toggle visibility — never freed.

@export_file("*.tscn") var game_scene: String = "res://scenes/game.tscn"

@onready var splash_panel: Control = $Panels/SplashPanel
@onready var first_time_panel: Control = $Panels/FirstTimePanel
@onready var lobby_home_panel: Control = $Panels/LobbyHomePanel
@onready var room_lobby_panel: Control = $Panels/RoomLobbyPanel


func _ready() -> void:
	print("[LobbyController] _ready: autohost=", "--autohost" in OS.get_cmdline_user_args())
	NetworkManager.server_created.connect(_on_server_created)

	splash_panel.goto_first_time.connect(_show_first_time)
	splash_panel.goto_lobby_home.connect(_show_lobby_home)
	splash_panel.goto_room_lobby.connect(_show_room_lobby)
	first_time_panel.goto_lobby_home.connect(_show_lobby_home)
	first_time_panel.goto_splash.connect(_show_splash)
	lobby_home_panel.logout_requested.connect(_on_logout)
	lobby_home_panel.entered_room.connect(_show_room_lobby)
	room_lobby_panel.goto_lobby_home.connect(_show_lobby_home)
	ProfileManager.logged_out.connect(_show_first_time)

	# Server-spawn detection: master passed --healthcheck-port or --autohost present.
	if RoomsReporter.is_room_server:
		_run_room_server_host()
		return
	if "--autohost" in OS.get_cmdline_user_args():
		_run_dev_autohost()
		return

	_show_splash()


func _run_room_server_host() -> void:
	print("[LobbyController] Master spawn detected, hosting room=", RoomsReporter.room_code)
	for p in [splash_panel, first_time_panel, lobby_home_panel, room_lobby_panel]:
		p.visible = false
	ProfileManager.my_nick = "RoomServer"
	await get_tree().process_frame
	NetworkManager.host_game()


func _run_dev_autohost() -> void:
	print("[LobbyController] --autohost detected, starting dev host")
	for p in [splash_panel, first_time_panel, lobby_home_panel]:
		p.visible = false
	# Dev autohost reuses an "AutoHost" identity. ProfileManager doesn't auth.
	ProfileManager.my_nick = "AutoHost"
	await get_tree().process_frame
	NetworkManager.host_game()


func _show_splash() -> void:
	first_time_panel.visible = false
	lobby_home_panel.visible = false
	room_lobby_panel.visible = false
	splash_panel.visible = true


func _show_first_time() -> void:
	splash_panel.visible = false
	lobby_home_panel.visible = false
	room_lobby_panel.visible = false
	first_time_panel.reset()
	first_time_panel.visible = true


func _show_lobby_home() -> void:
	splash_panel.visible = false
	first_time_panel.visible = false
	room_lobby_panel.visible = false
	lobby_home_panel.visible = true
	lobby_home_panel.refresh()


func _show_room_lobby(room_code: String) -> void:
	splash_panel.visible = false
	first_time_panel.visible = false
	lobby_home_panel.visible = false
	room_lobby_panel.visible = true
	room_lobby_panel.enter(room_code)


func _on_logout() -> void:
	ProfileManager.logout()


func _on_server_created() -> void:
	# Only fires for room-server / dev autohost paths where we host directly.
	# Browser clients never host — they go through Room Lobby first.
	get_tree().change_scene_to_file(game_scene)
