class_name SpawnManager extends Node

const MIN_KART_SPAWNS := 4

var _spawn_points: Array[Marker3D] = []
var _next_index: int = 0


var _discovered: bool = false


func _ready() -> void:
	pass  # Lazy discovery via _ensure_discovered() in each public method


func _discover_and_validate() -> void:
	if _discovered:
		return
	_spawn_points.clear()
	var nodes := get_tree().get_nodes_in_group("kart_spawn")
	for node in nodes:
		if node is Marker3D:
			_spawn_points.append(node)
	_discovered = true
	print("[SpawnManager] Discovered %d spawn points" % _spawn_points.size())
	validate_map()


func _ensure_discovered() -> void:
	if not _discovered:
		_discover_and_validate()


func validate_map() -> void:
	var count := _spawn_points.size()
	if count < MIN_KART_SPAWNS:
		push_error("Map needs at least %d kart_spawn points, found %d" % [MIN_KART_SPAWNS, count])


func get_initial_spawn_point() -> Vector3:
	_ensure_discovered()
	if _spawn_points.is_empty():
		push_error("SpawnManager: no spawn points discovered")
		return Vector3.ZERO
	var point := _spawn_points[_next_index % _spawn_points.size()]
	_next_index += 1
	return point.global_position


func get_respawn_point(karts_container: Node3D) -> Vector3:
	_ensure_discovered()
	if _spawn_points.is_empty():
		push_error("SpawnManager: no spawn points discovered")
		return Vector3.ZERO

	var best_point: Marker3D = _spawn_points[0]
	var best_min_dist: float = -1.0

	for point in _spawn_points:
		var min_dist := INF
		for kart in karts_container.get_children():
			if not kart is CharacterBody3D:
				continue
			var state := StateManager.get_kart_state(kart.player_id)
			if state == GameStates.KartState.DEAD or state == GameStates.KartState.RESPAWNING:
				continue
			var dist := point.global_position.distance_to(kart.global_position)
			min_dist = minf(min_dist, dist)
		if min_dist > best_min_dist:
			best_min_dist = min_dist
			best_point = point

	return best_point.global_position
