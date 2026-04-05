extends Node

# ── Signals ───────────────────────────────────────────────────────────────────
signal damage_dealt(attacker_id: int, victim_id: int, info: DamageInfo, final_amount: int)
signal player_killed(victim_id: int, killer_id: int, info: DamageInfo)
signal player_assisted(assister_id: int, victim_id: int)
