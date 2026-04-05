class_name DamageInfo
extends RefCounted

# ── Signals ──────────────────────────────────────────────────────────────────
# (none — data class only)

# ── Types ─────────────────────────────────────────────────────────────────────
enum Type { PROJECTILE, AOE_EXPLOSION, CONTACT, ENVIRONMENTAL }

# ── Properties ────────────────────────────────────────────────────────────────
var type: Type = Type.PROJECTILE
var amount: int = 0
var attacker_id: int = -1
var weapon_name: String = ""
var position: Vector3 = Vector3.ZERO


# ── Factory ───────────────────────────────────────────────────────────────────
static func create(
		p_type: Type,
		p_amount: int,
		p_attacker_id: int = -1,
		p_position: Vector3 = Vector3.ZERO,
		p_weapon_name: String = ""
) -> DamageInfo:
	var info := DamageInfo.new()
	info.type = p_type
	info.amount = p_amount
	info.attacker_id = p_attacker_id
	info.position = p_position
	info.weapon_name = p_weapon_name
	return info
