extends Node3D

var _muzzle: Marker3D
var _missile_visual: Node3D
var _missile_trail: GPUParticles3D

func _ready() -> void:
	_muzzle = $Muzzle
	_missile_visual = _resolve_missile_visual()
	_missile_trail = _resolve_missile_trail()
	if _missile_trail:
		_missile_trail.emitting = false
	if _missile_visual:
		_missile_visual.show()

func _resolve_missile_visual() -> Node3D:
	var named := get_node_or_null("Muzzle/MissileVisual") as Node3D
	if named:
		return named
	for child in _muzzle.get_children():
		if child is Node3D:
			return child
	return null

func _resolve_missile_trail() -> GPUParticles3D:
	if not _missile_visual:
		return null
	var direct := _missile_visual.get_node_or_null("GPUParticles3D") as GPUParticles3D
	if direct:
		return direct
	return _missile_visual.get_node_or_null("blockbench_export/GPUParticles3D") as GPUParticles3D

func launch() -> void:
	if not _missile_visual:
		return
	_missile_visual.show()
	_missile_visual.scale = Vector3.ONE
	_missile_visual.position = Vector3.ZERO

	var tween := create_tween()
	tween.set_parallel(true)
	tween.tween_property(_missile_visual, "position:z", 0.8, 0.18)
	tween.tween_property(_missile_visual, "scale", Vector3(0.3, 0.3, 0.3), 0.18)
	if _missile_trail:
		_missile_trail.emitting = true
	tween.chain().tween_callback(_missile_visual.hide)
	tween.chain().tween_callback(func() -> void:
		if _missile_trail:
			_missile_trail.emitting = false
	)
