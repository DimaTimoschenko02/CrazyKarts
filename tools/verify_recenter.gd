@tool
extends SceneTree

# Verify that ALL space-kit assets have their visual AABB centered at (0, y, 0) in XZ
# after the recenter_on_import.gd import script.


func _init() -> void:
	var dir := DirAccess.open("res://assets/map_materials/space-kit")
	if dir == null:
		push_error("Cannot open dir")
		quit(1)
		return
	var files: Array[String] = []
	dir.list_dir_begin()
	var f := dir.get_next()
	while f != "":
		if f.ends_with(".glb"):
			files.append(f)
		f = dir.get_next()
	dir.list_dir_end()
	files.sort()

	var bad: Array[String] = []
	for name in files:
		var packed: PackedScene = load("res://assets/map_materials/space-kit/" + name)
		if packed == null:
			continue
		var inst: Node = packed.instantiate()
		var aabb := _compute_aabb_world(inst)
		if aabb.size == Vector3.ZERO:
			continue
		var cx := aabb.position.x + aabb.size.x * 0.5
		var cz := aabb.position.z + aabb.size.z * 0.5
		if absf(cx) > 0.01 or absf(cz) > 0.01:
			bad.append("%s: center_xz=(%.3f, %.3f)  aabb.pos=%v size=%v" % [name, cx, cz, aabb.position, aabb.size])
		inst.queue_free()

	print("\n=== RESULT ===")
	print("Total files: %d" % files.size())
	print("Bad (center XZ not at 0): %d" % bad.size())
	for b in bad:
		print("  %s" % b)
	quit(0)


func _compute_aabb_world(root: Node) -> AABB:
	var result: Array = [AABB(), false]
	_accum(root, Transform3D.IDENTITY, result)
	return result[0]


func _accum(node: Node, parent_xform: Transform3D, result: Array) -> void:
	var xform := parent_xform
	if node is Node3D:
		xform = parent_xform * (node as Node3D).transform
	if node is MeshInstance3D:
		var mi := node as MeshInstance3D
		if mi.mesh != null:
			var local_aabb: AABB = mi.mesh.get_aabb()
			var transformed: AABB = xform * local_aabb
			if result[1]:
				result[0] = (result[0] as AABB).merge(transformed)
			else:
				result[0] = transformed
				result[1] = true
	for c in node.get_children():
		_accum(c, xform, result)
