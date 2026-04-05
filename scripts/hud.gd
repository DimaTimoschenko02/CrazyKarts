extends CanvasLayer

@onready var score_box:    VBoxContainer = $ScorePanel/MarginContainer/VBox
@onready var hp_bar:       ProgressBar   = $HPBar
@onready var weapon_label: Label         = $WeaponLabel
@onready var kill_feed:    VBoxContainer = $KillFeed
var ping_label: Label = null


func _ready() -> void:
	GameManager.player_died.connect(_on_player_died)
	StateManager.weapon_state_changed.connect(_on_weapon_state_changed)
	GameManager.scores_updated.connect(_on_scores_updated)
	NetworkManager.ping_updated.connect(_on_ping_updated)
	_try_connect_local_health.call_deferred()

	# Create ping label in a full-rect Control container (anchors need a Control parent)
	var ping_container := Control.new()
	ping_container.set_anchors_preset(Control.PRESET_FULL_RECT)
	add_child(ping_container)
	ping_label = Label.new()
	ping_label.name = "PingLabel"
	ping_label.text = "Ping: --"
	ping_label.add_theme_font_size_override("font_size", 16)
	ping_label.add_theme_color_override("font_color", Color.GREEN)
	ping_label.anchor_left = 1.0
	ping_label.anchor_right = 1.0
	ping_label.offset_left = -130
	ping_label.offset_right = -10
	ping_label.offset_top = 10
	ping_label.offset_bottom = 40
	ping_container.add_child(ping_label)


func _exit_tree() -> void:
	if StateManager.weapon_state_changed.is_connected(_on_weapon_state_changed):
		StateManager.weapon_state_changed.disconnect(_on_weapon_state_changed)
	if GameManager.player_died.is_connected(_on_player_died):
		GameManager.player_died.disconnect(_on_player_died)
	if GameManager.scores_updated.is_connected(_on_scores_updated):
		GameManager.scores_updated.disconnect(_on_scores_updated)
	if NetworkManager.ping_updated.is_connected(_on_ping_updated):
		NetworkManager.ping_updated.disconnect(_on_ping_updated)
	var health := _get_local_health()
	if health and health.hp_changed.is_connected(_on_hp_changed):
		health.hp_changed.disconnect(_on_hp_changed)


func _on_scores_updated(_scores: Dictionary) -> void:
	update_scores(_scores)


func _on_weapon_state_changed(peer_id: int, _from: GameStates.WeaponState, to: GameStates.WeaponState) -> void:
	if peer_id != multiplayer.get_unique_id():
		return
	weapon_label.text = "[ ROCKET ]" if to == GameStates.WeaponState.ARMED else "[ no weapon ]"


func _on_ping_updated(rtt_ms: int) -> void:
	if not ping_label:
		return
	ping_label.text = "Ping: %dms" % rtt_ms
	if rtt_ms <= 100:
		ping_label.add_theme_color_override("font_color", Color.GREEN)
	elif rtt_ms <= 200:
		ping_label.add_theme_color_override("font_color", Color.YELLOW)
	else:
		ping_label.add_theme_color_override("font_color", Color.RED)


func _get_local_health() -> HealthComponent:
	var karts_node := get_tree().current_scene.get_node_or_null("Karts") if get_tree().current_scene else null
	if not karts_node:
		return null
	var kart := karts_node.get_node_or_null(str(multiplayer.get_unique_id()))
	if not kart:
		return null
	return kart.get_node_or_null("HealthComponent") as HealthComponent


func _try_connect_local_health() -> void:
	if not is_inside_tree():
		return
	var health := _get_local_health()
	if not health:
		get_tree().create_timer(0.5).timeout.connect(_try_connect_local_health, CONNECT_ONE_SHOT)
		return
	if not health.hp_changed.is_connected(_on_hp_changed):
		health.hp_changed.connect(_on_hp_changed)
	hp_bar.max_value = health.max_hp
	hp_bar.value = health.current_hp


func _on_hp_changed(current: int, maximum: int) -> void:
	hp_bar.max_value = maximum
	hp_bar.value = current


func update_scores(_scores: Dictionary) -> void:
	for child in score_box.get_children():
		child.queue_free()

	var header := Label.new()
	header.text = "%-16s  K   D" % "Player"
	header.add_theme_font_size_override("font_size", 13)
	header.add_theme_color_override("font_color", Color.YELLOW)
	score_box.add_child(header)

	for entry in GameManager.get_scores_sorted():
		var lbl := Label.new()
		lbl.text = "%-16s %2d %3d" % [
			entry["data"]["name"],
			entry["data"]["kills"],
			entry["data"]["deaths"]
		]
		lbl.add_theme_font_size_override("font_size", 13)
		score_box.add_child(lbl)


func _on_player_died(victim_id: int, killer_id: int) -> void:
	var victim_name: String = GameManager.players.get(victim_id, {}).get("name", "?")
	var killer_name: String = GameManager.players.get(killer_id, {}).get("name", "?")
	var msg := Label.new()
	if killer_id == victim_id:
		msg.text = "%s blew themselves up" % victim_name
	else:
		msg.text = "%s  killed  %s" % [killer_name, victim_name]
	msg.add_theme_font_size_override("font_size", 14)
	msg.add_theme_color_override("font_color", Color(1, 0.6, 0.2))
	kill_feed.add_child(msg)
	get_tree().create_timer(4.0).timeout.connect(msg.queue_free)
