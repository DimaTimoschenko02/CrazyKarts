class_name ProjectileResource extends Resource

@export_group("Movement")
@export var speed: float = 28.0
@export var lifetime: float = 3.5
@export var gravity_scale: float = 0.0

@export_group("Damage")
@export var base_damage: int = 40
@export var aoe_radius: float = 3.5
@export var self_damage: bool = false

@export_group("Behavior")
@export var weapon_name: String = ""
@export var projectile_scene: PackedScene
