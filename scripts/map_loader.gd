@tool
extends Node3D
class_name MapLoader

@export_file("*.json") var map_path: String = "res://resources/maps/test_plateau.json"
@export var auto_load: bool = true
@export var generate_collision: bool = false
@export_tool_button("Reload Map") var _reload_btn: Callable = _reload_in_editor

const ASSET_ROOT := "res://assets/map_materials/space-kit/"


func _ready() -> void:
	if auto_load:
		load_map(map_path)


func _reload_in_editor() -> void:
	if not Engine.is_editor_hint():
		return
	_clear_children()
	load_map(map_path)


func _clear_children() -> void:
	for child in get_children(true):
		child.free()


func load_map(path: String) -> void:
	var file := FileAccess.open(path, FileAccess.READ)
	if file == null:
		push_error("MapLoader: cannot open %s" % path)
		return
	var parsed: Variant = JSON.parse_string(file.get_as_text())
	if not (parsed is Dictionary):
		push_error("MapLoader: invalid JSON in %s" % path)
		return

	var data: Dictionary = parsed
	var meta: Dictionary = data.get("meta", {})
	var tile_size := float(meta.get("tile_size", 1.0))
	var level_height := float(meta.get("level_height", 0.5))
	var origin_offset := _read_vec3(meta.get("origin_offset", [0, 0, 0]))

	var count := 0
	for fill in data.get("rect_fills", []):
		count += _apply_rect_fill(fill, tile_size, level_height, origin_offset)
	for cell in data.get("cells", []):
		if _spawn_cell(cell, tile_size, level_height, origin_offset):
			count += 1
	for prop in data.get("props", []):
		_spawn_prop(prop, tile_size, level_height, origin_offset)

	print("MapLoader: placed %d cells from %s" % [count, path])


func _apply_rect_fill(
	fill: Dictionary,
	tile_size: float,
	level_height: float,
	origin_offset: Vector3
) -> int:
	var asset: String = fill.get("asset", "")
	if asset == "":
		return 0
	var x0: int = int(fill.get("x_min", 0))
	var z0: int = int(fill.get("z_min", 0))
	var x1: int = int(fill.get("x_max", 0))
	var z1: int = int(fill.get("z_max", 0))
	var y_level: float = float(fill.get("y_level", 0))
	var rot: float = float(fill.get("rot", 0.0))
	var placed := 0
	for x in range(x0, x1 + 1):
		for z in range(z0, z1 + 1):
			_spawn_at(asset, x, z, y_level, rot, tile_size, level_height, origin_offset)
			placed += 1
	return placed


func _spawn_cell(
	cell: Dictionary,
	tile_size: float,
	level_height: float,
	origin_offset: Vector3
) -> bool:
	var asset: String = cell.get("asset", "")
	if asset == "":
		return false
	var x: int = int(cell.get("x", 0))
	var z: int = int(cell.get("z", 0))
	var y_level: float = float(cell.get("y_level", 0))
	var rot: float = float(cell.get("rot", 0.0))
	_spawn_at(asset, x, z, y_level, rot, tile_size, level_height, origin_offset)
	return true


func _spawn_at(
	asset: String,
	x: float,
	z: float,
	y_level: float,
	rot: float,
	tile_size: float,
	level_height: float,
	origin_offset: Vector3
) -> void:
	var inst := _instantiate_asset(asset)
	if inst == null:
		return
	inst.position = Vector3(
		x * tile_size,
		y_level * level_height,
		z * tile_size
	) + origin_offset
	inst.rotation_degrees.y = rot
	add_child(inst, true)
	if generate_collision and not Engine.is_editor_hint():
		_attach_collision(inst, asset, tile_size)


func _spawn_prop(
	prop: Dictionary,
	tile_size: float,
	level_height: float,
	origin_offset: Vector3
) -> void:
	var asset: String = prop.get("asset", "")
	if asset == "":
		return
	var x: float = float(prop.get("x", 0))
	var z: float = float(prop.get("z", 0))
	var y_level: float = float(prop.get("y_level", 0))
	var rot: float = float(prop.get("rot", 0.0))
	var extra_scale: float = float(prop.get("scale", 1.0))
	var inst := _instantiate_asset(asset)
	if inst == null:
		return
	inst.position = Vector3(
		x * tile_size,
		y_level * level_height,
		z * tile_size
	) + origin_offset
	inst.rotation_degrees.y = rot
	if not is_equal_approx(extra_scale, 1.0):
		inst.scale = Vector3.ONE * extra_scale
	add_child(inst, true)
	if generate_collision and not Engine.is_editor_hint():
		_attach_convex(inst)


func _instantiate_asset(asset_name: String) -> Node3D:
	if asset_name == "":
		return null
	var full_path := ASSET_ROOT + asset_name + ".glb"
	var scene: PackedScene = load(full_path)
	if scene == null:
		push_warning("MapLoader: missing asset %s" % full_path)
		return null
	return scene.instantiate() as Node3D


func _attach_collision(inst: Node3D, asset_name: String, tile_size: float) -> void:
	if asset_name == "terrain" or asset_name.begins_with("terrain_road"):
		var body := StaticBody3D.new()
		var shape := CollisionShape3D.new()
		var box := BoxShape3D.new()
		box.size = Vector3(tile_size, 0.1, tile_size)
		shape.shape = box
		shape.position = Vector3(0, -0.05, 0)
		body.add_child(shape)
		inst.add_child(body)
	else:
		_attach_convex(inst)


func _attach_convex(node: Node) -> void:
	var stack: Array[Node] = [node]
	while stack.size() > 0:
		var n: Node = stack.pop_back()
		if n is MeshInstance3D:
			var mi := n as MeshInstance3D
			if mi.mesh != null:
				mi.create_convex_collision()
		for c in n.get_children():
			stack.append(c)


func _read_vec3(value: Variant) -> Vector3:
	if value is Array and value.size() >= 3:
		return Vector3(float(value[0]), float(value[1]), float(value[2]))
	return Vector3.ZERO
