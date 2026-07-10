// Data-driven weapon catalogue — same pattern as kart/stats.ts's KART_TYPES.
// "rocket" was ported from the Godot reference (docs/p2-port-notes.md §1).
// "mines" and "dynamite" are NEW gameplay-programmer work (2026-07-10 task
// brief) — there is no reference implementation for them, only a task spec;
// numbers below are picked to feel roughly on par with rocket (mines/
// dynamite comments flag the ones that are pure "tune by feel" guesses vs.
// the ones derived from a stated formula).
//
// Both the client (VFX prediction/rendering) and the server (server/weapons/
// {rocket,mine,dynamite}Sim.ts, authoritative sim) read from this same table
// so tuning a number here changes both sides at once.

// Shared shape for anything that resolves an AOE blast at a point: linear
// falloff to 0 at aoeRadius, floor()'d damage, shooter excluded unless
// selfDamage is true. See server/weapons/rocketSim.ts computeAoeDamage,
// which every weapon type below (rocket direct hit, mine trigger, dynamite
// fuse) resolves its explosion through — one formula, three callers.
export interface AoeStats {
  readonly baseDamage: number;
  readonly aoeRadius: number; // m, linear falloff to 0 at this radius
  readonly selfDamage: boolean; // false: shooter/owner excluded from its own blast
}

export interface ProjectileStats extends AoeStats {
  readonly id: string; // "rocket"
  readonly speed: number; // m/s, straight-line, gravityScale=0 (rocket_config.tres:7)
  readonly lifetime: number; // s, AOE-explodes on expiry if nothing else stops it first (rocket_config.tres:8)
  readonly spreadDeg: number; // kart_controller.gd:60 ROCKET_SPREAD_DEG — fan angle for the side rockets
  readonly volleyCount: number; // how many rockets fire per shot (reference: 1-3 depending on launcher
  // sockets present on the kart model; our race.glb (kart/stats.ts
  // KART_TYPES.racer, formerly craft_racer) has no socket meshes either, so
  // we always fire the full 3-rocket fan from a single muzzle point to
  // preserve the reference's "feel" — see decision in the combat-slice plan)
  // UNCONFIRMED vs the Godot .tscn Area3D shape (not read this session) —
  // tune by feel, not a spec value:
  readonly hitRadius: number; // m, proximity trigger radius for exploding on a kart
}

// Three mines dropped one at a time from the kart's rear, see server/weapons/
// mineSim.ts computeMineDropIntervalS for the drop-timing formula (task
// spec: 3 mines dropped while driving at max speed end up ~1.15x the kart's
// own body length apart from 1st to 3rd).
export interface MineStats extends AoeStats {
  readonly id: "mines";
  readonly count: number; // how many mines one fire() drops
  readonly armDelayS: number; // s after drop before the mine can trigger on ANYONE, including its own owner — task spec value
  readonly triggerRadius: number; // m, proximity that triggers an armed mine — task spec value
  readonly lifetimeS: number; // s before an untriggered mine silently despawns — task spec value
}

// Charge-and-throw arc weapon, see server/weapons/dynamiteSim.ts for the
// launch-speed/parabola math.
export interface DynamiteStats extends AoeStats {
  readonly id: "dynamite";
  readonly speedMin: number; // m/s launch speed at charge=0 — tune by feel, task spec default
  readonly speedMax: number; // m/s launch speed at charge=1 (full hold) — tune by feel, task spec default
  readonly maxChargeMs: number; // ms — holding past this auto-throws at full charge, task spec value
  readonly launchAngleDeg: number; // degrees above horizontal, task spec value
  readonly gravity: number; // m/s^2 downward accel during flight — tune by feel, task spec default
  readonly stickRadius: number; // m, proximity to a kart that makes the dynamite stick to it instead of the ground
  readonly fuseS: number; // s between sticking (ground or kart) and exploding — task spec value
}

export type WeaponStats = ProjectileStats | MineStats | DynamiteStats;

export const WEAPON_TYPES: Readonly<Record<string, WeaponStats>> = {
  rocket: {
    id: "rocket",
    speed: 40,
    lifetime: 6.0,
    baseDamage: 40,
    aoeRadius: 3.5,
    // Owner decision 2026-07-10 (final): NO weapon ever damages its own
    // shooter — resolves the GDD "open question" in favor of zero
    // self-damage across the whole kit (rocket/mines/dynamite alike).
    selfDamage: false,
    spreadDeg: 10,
    volleyCount: 3,
    hitRadius: 1.0,
  },
  mines: {
    id: "mines",
    count: 3,
    armDelayS: 0.8,
    triggerRadius: 1.1,
    lifetimeS: 30,
    // Slightly less damage/radius than a rocket's direct AOE (a mine is a
    // placed trap, not an aimed shot). Owner decision 2026-07-10: no weapon
    // self-damages — your own mine neither triggers on you nor hurts you
    // (see MatchRoom.tickMines, which passes MINES.selfDamage as the
    // trigger's owner-eligibility flag).
    baseDamage: 45,
    aoeRadius: 3.0,
    selfDamage: false,
  },
  dynamite: {
    id: "dynamite",
    speedMin: 8, // m/s at a bare tap — kept short, makes the full charge feel dramatic by contrast
    // m/s at full charge (owner feedback 2026-07-10: "throw distance at full
    // hold must be at least 3x what it was"). Ballistic range scales with
    // speed^2 (range = v^2*sin(2*angle)/gravity), so tripling range needs
    // speedMax * sqrt(3) ~= 27.7 -> rounded up to 28 (was 16, ~3.06x range).
    // speedMin/launchAngleDeg/gravity intentionally untouched.
    speedMax: 28,
    maxChargeMs: 1100,
    launchAngleDeg: 40,
    gravity: 20,
    stickRadius: 1.0,
    fuseS: 0.9,
    // Biggest single-hit AOE in the kit (task spec: "radius/urон больше
    // ракеты"). Owner decision 2026-07-10: no weapon self-damages — your own
    // dynamite neither sticks to you nor hurts you (see MatchRoom.
    // tickDynamite, which passes DYNAMITE.selfDamage as the stick check's
    // owner-eligibility flag).
    baseDamage: 65,
    // aoeRadius x1.5 (owner feedback 2026-07-10: dynamite's blast should feel
    // noticeably bigger than a rocket's, was too close to it at 4.5m — now
    // 6.75m vs. the rocket's 3.5m).
    aoeRadius: 6.75,
    selfDamage: false,
  },
};
