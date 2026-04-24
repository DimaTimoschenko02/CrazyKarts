@tool
extends EditorScenePostImport

# EditorScenePostImport hook for Kenney Space Kit (.glb) assets.
# Kenney assets were exported from one big Blender scene, so their
# vertices sit far from the local origin AND at inconsistent Y heights
# (some have max_y=0, others max_y=+0.5, breaking y_level consistency).
#
# We normalize each asset so that:
#   - Visual XZ center is at (0, y, 0) in local space
#   - Top surface is at Y=0 (max_y=0), low parts at negative Y
# This gives a uniform semantic: y_level = the level of the TOP surface.


func _post_import(scene: Node) -> Object:
	if not (scene is Node3D):
		return scene
	var root := scene as Node3D
	var aabb := _compute_local_aabb(root)
	if aabb.size == Vector3.ZERO:
		return scene
	var offset := Vector3(
		aabb.position.x + aabb.size.x * 0.5,
		aabb.position.y + aabb.size.y,
		aabb.position.z + aabb.size.z * 0.5
	)
	for child in root.get_children():
		if child is Node3D:
			var n := child as Node3D
			n.position -= offset
	return scene


func _compute_local_aabb(root: Node3D) -> AABB:
	var result: Array = [AABB(), false]
	for child in root.get_children():
		_accum(child, Transform3D.IDENTITY, result)
	return result[0]


func _accum(node: Node, parent_xform: Transform3D, result: Array) -> void:
	var xform := parent_xform
	if node is Node3D:
		xform = parent_xform * (node as Node3D).transform
	if node is MeshInstance3D:
		var mi := node as MeshInstance3D
		if mi.mesh != null:
			var local_aabb: AABB = mi.get_aabb()
			var transformed: AABB = xform * local_aabb
			if result[1]:
				result[0] = (result[0] as AABB).merge(transformed)
			else:
				result[0] = transformed
				result[1] = true
	for c in node.get_children():
		_accum(c, xform, result)
