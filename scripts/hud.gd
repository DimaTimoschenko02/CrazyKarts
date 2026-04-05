extends CanvasLayer

@onready var score_box:    VBoxContainer = $ScorePanel/MarginContainer/VBox
@onready var hp_bar:       ProgressBar   = $HPBar
@onready var weapon_label: Label         = $WeaponLabel
@onready var kill_feed:    VBoxContainer = $KillFeed


func _ready() -> void:
	GameManager.player_died.connect(_on_player_died)
	StateManager.weapon_state_changed.connect(_on_weapon_state_changed)
	GameManager.scores_updated.connect(_on_scores_updated)


func _exit_tree() -> void:
	if StateManager.weapon_state_changed.is_connected(_on_weapon_state_changed):
		StateManager.weapon_state_changed.disconnect(_on_weapon_state_changed)
	if GameManager.player_died.is_connected(_on_player_died):
		GameManager.player_died.disconnect(_on_player_died)
	if GameManager.scores_updated.is_connected(_on_scores_updated):
		GameManager.scores_updated.disconnect(_on_scores_updated)


func _on_scores_updated(_scores: Dictionary) -> void:
	_update_hp_bar()
	update_scores(_scores)


func _on_weapon_state_changed(peer_id: int, _from: GameStates.WeaponState, to: GameStates.WeaponState) -> void:
	if peer_id != multiplayer.get_unique_id():
		return
	weapon_label.text = "[ ROCKET ]" if to == GameStates.WeaponState.ARMED else "[ no weapon ]"


func _update_hp_bar() -> void:
	var my_id := multiplayer.get_unique_id()
	var data: Dictionary = GameManager.players.get(my_id, {})
	hp_bar.value = data.get("hp", 100)


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
