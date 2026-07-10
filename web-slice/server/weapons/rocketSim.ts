// Pure rocket simulation/hit-detection math — no Colyseus/schema deps, unit-
// testable in isolation. Authoritative side of the flow documented in
// docs/p2-port-notes.md §1: a single "explode" trigger (proximity hit /
// terrain block / map bounds / lifetime expiry) always resolves through the
// SAME AOE-with-falloff formula, matching the reference (there's no separate
// "direct hit" damage — Area3D.body_entered just calls _apply_aoe_damage at
// the collision point, same as the lifetime-expiry path).
import type { Heightfield } from "../../src/shared/heightfield";
import { anisotropicDist3D, withinProximity3D } from "../../src/shared/spatial3d";
import type { AoeStats, ProjectileStats } from "../../src/weapons/stats";

export interface Vec2 {
  x: number;
  z: number;
}

// Full 3D position/direction — added for pitched flight (rockets now sample
// ground slope at launch and fly a straight but tilted line, see
// computeLaunchPitchRad below). Vec2 stays in use for the purely-horizontal
// math (proximity hit, AOE falloff) that never needed a vertical axis.
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface MuzzleDirection {
  dx: number;
  dz: number;
  yawOffsetRad: number;
}

// Fan of `volleyCount` directions spread evenly across `spreadDeg` either
// side of the shooter's yaw (kart_controller.gd:60 ROCKET_SPREAD_DEG). With
// volleyCount=3 this reproduces the reference's left/right/center 3-launcher
// case exactly (-10°, 0°, +10°); volleyCount=1 fires straight ahead.
export function computeMuzzleDirections(yaw: number, stats: ProjectileStats): MuzzleDirection[] {
  const { volleyCount, spreadDeg } = stats;
  if (volleyCount <= 1) {
    return [directionAt(yaw, 0)];
  }
  const spreadRad = (spreadDeg * Math.PI) / 180;
  const out: MuzzleDirection[] = [];
  for (let i = 0; i < volleyCount; i++) {
    // Evenly spaced from -spreadRad to +spreadRad (volleyCount=3 → -1,0,+1 * spreadRad).
    const t = volleyCount === 1 ? 0 : (i / (volleyCount - 1)) * 2 - 1;
    out.push(directionAt(yaw, t * spreadRad));
  }
  return out;
}

function directionAt(yaw: number, offset: number): MuzzleDirection {
  const y = yaw + offset;
  // forwardOf(yaw) convention from kart/kart.ts: (-sin(yaw), 0, -cos(yaw)).
  return { dx: -Math.sin(y), dz: -Math.cos(y), yawOffsetRad: offset };
}

// One straight-line, constant-velocity step in full 3D (still gravityScale=0
// per rocket_config.tres — no arc, `dir` just isn't horizontal-only anymore:
// its Y component is baked in once at launch from the ground slope under the
// shooter, see computeLaunchPitchRad/tiltDirection3D).
export function stepRocket(pos: Vec3, dir: Vec3, speed: number, dt: number): Vec3 {
  return { x: pos.x + dir.x * speed * dt, y: pos.y + dir.y * speed * dt, z: pos.z + dir.z * speed * dt };
}

// Layer-aware (shared/heightfield.ts Heightfield.sampleAt), climbThreshold=0:
// a flying rocket has nowhere to "climb" onto a higher deck the way a
// driving kart's layerClimbThreshold intentionally allows — it should only
// ever compare itself against its OWN layer's floor (any floor at/below its
// current y). This also fixes multi-layer columns (e.g. a bridge deck over a
// road): the old plain sample() (MAX-of-layers) would explode a rocket
// flying UNDER the deck against the deck's own height even though the
// rocket is nowhere near it; sampleAt(climb=0) instead compares against the
// road floor beneath it, matching the ground the rocket is actually over.
const ROCKET_LAYER_CLIMB_THRESHOLD = 0;

// True if the rocket should explode against terrain/map-edge at `pos`: the
// ground is higher than the rocket's CURRENT altitude (pos.y, re-checked every
// tick as the rocket climbs/descends a pitched line), or `pos` is off the
// heightfield entirely (both read as "hit a wall").
export function isBlockedByTerrain(pos: Vec3, heightfield: Heightfield): boolean {
  const groundY = heightfield.sampleAt(pos.x, pos.z, pos.y, ROCKET_LAYER_CLIMB_THRESHOLD);
  if (groundY === null) return true; // off the map = wall
  return groundY > pos.y;
}

// Safety clamp on the launch pitch so a muzzle sitting right at a cliff edge
// (huge Δheight over a short lookahead) can't fire a near-vertical rocket —
// not part of the design spec, just guards against a pathological slope
// sample; 45° comfortably covers every ramp/plateau angle in the current kit.
const MAX_LAUNCH_PITCH_RAD = Math.PI / 4;

// Layer-aware launch-pitch probing (shared/heightfield.ts Heightfield.
// sampleAt) uses the SHOOTER's own y as yRef, so a kart standing under a low
// bridge probes the road floor it's actually driving on, not the bridge deck
// above it — matching the ordinary "which floor is this body near" rule
// kart.ts uses while driving. 0.8 = KartPhysicsParams.layerClimbThreshold's
// design default (see types.ts field doc); kept as a local constant rather
// than threading the full params object through the weapons module, which
// otherwise has no dependency on kart tuning at all.
const LAUNCH_PITCH_LAYER_CLIMB_THRESHOLD = 0.8;

// Ground-slope-aware launch pitch: samples height a short distance behind
// and ahead of the KART's position (not the muzzle!) along the horizontal
// fire direction, and returns the angle of the line between them. Positive =
// uphill (rocket noses up). Off-map samples (null) fall back to a flat
// (0 rad) launch rather than guessing.
//
// The probe MUST straddle the kart position, not the muzzle: ramps in the
// current kit are single 1m tiles, and the muzzle sits 1.2m ahead of the
// kart (MUZZLE_FORWARD_OFFSET_M) — a kart standing ON a ramp has its muzzle
// already hanging over the flat tile beyond the ramp, so probing under the
// muzzle reads slope 0 and every rocket flies dead level (live-playtest
// regression, 2026-07-07). A symmetric ±lookahead/2 probe around the kart
// stays inside the ramp tile the kart is actually tilted by.
export function computeLaunchPitchRad(
  kartX: number,
  kartZ: number,
  dirX: number,
  dirZ: number,
  heightfield: Heightfield,
  kartY: number,
  lookaheadM = 0.7
): number {
  const half = lookaheadM / 2;
  const h0 = heightfield.sampleAt(kartX - dirX * half, kartZ - dirZ * half, kartY, LAUNCH_PITCH_LAYER_CLIMB_THRESHOLD);
  const h1 = heightfield.sampleAt(kartX + dirX * half, kartZ + dirZ * half, kartY, LAUNCH_PITCH_LAYER_CLIMB_THRESHOLD);
  if (h0 === null || h1 === null) return 0;
  const pitch = Math.atan2(h1 - h0, lookaheadM);
  return Math.max(-MAX_LAUNCH_PITCH_RAD, Math.min(MAX_LAUNCH_PITCH_RAD, pitch));
}

// Tilts a horizontal unit direction (dx,dz) by `pitchRad` into a 3D unit
// vector. Horizontal components shrink by cos(pitch) so the whole vector
// stays unit length — speed*dir still gives the correct 3D velocity.
export function tiltDirection3D(dirX: number, dirZ: number, pitchRad: number): Vec3 {
  const cp = Math.cos(pitchRad);
  return { x: dirX * cp, y: Math.sin(pitchRad), z: dirZ * cp };
}

export interface PlayerPoint extends Vec3 {
  id: string;
}

// Vertical gate for proximity TRIGGER events (direct rocket hit, mine arm,
// dynamite stick) — these are genuine on/off events (something either
// touches a body or it doesn't), which is exactly the smooth-values rule's
// carve-out for a hard threshold (see shared/spatial3d.ts withinProximity3D
// doc). Must be STRICTLY below a single road-tile floor gap (1.1m,
// .claude/rules/map-building.md) — a mine on a bridge deck must NOT arm/
// trigger (and waste itself) on a kart passing underneath, which is the
// exact playtest bug this gate exists for. 1.0m still comfortably covers
// every genuine same-floor case: player.y and a mine's y are both
// floor-referenced (usually |dy|≈0, up to ~0.5 on slopes), and a rocket/
// dynamite in flight sits MUZZLE_HEIGHT_OFFSET_M=0.5 (MatchRoom.ts) above
// its target's floor-Y.
const PROXIMITY_VERTICAL_M = 1.0;

// Vertical weight for AOE falloff distance — unlike the proximity gate
// above, this is a continuous quantity (damage falloff), so per
// smooth-values.md it must never hard-cut to 0/full at a boundary. Instead
// we make Y "count more" than XZ: one road-tile floor (1.1m) of vertical
// separation reads as if it were 1.1 * 2.5 = 2.75m of horizontal
// separation, which pushes a rocket's 3.5m-radius falloff down to
// floor(40*(1-2.75/3.5)) = 8 damage (was 40 at point-blank) — "almost
// obliterated by falloff" per the task brief, not a literal hard zero,
// while a blast at the very edge of a deck (no floor between the two
// points, small actual dy) still degrades smoothly rather than snapping.
// Explosions do NOT raycast against terrain — a rocket exploding right next
// to a thin wall still damages through it — this weighting is a cheap proxy
// for "probably a different floor", not real occlusion.
const AOE_VERTICAL_WEIGHT = 2.5;

// Nearest alive, non-shooter (when selfDamage is false) kart within
// hitRadius (XZ) AND PROXIMITY_VERTICAL_M (Y) — proximity trigger for
// exploding on a body, mirrors Area3D.body_entered in the reference (see
// file header: this only decides WHERE to explode, not a separate damage
// amount). "Nearest" ranks candidates by XZ distance only, matching the old
// pre-3D behavior — the vertical axis is purely a gate here, not part of
// the ranking.
export function findProximityHit(
  pos: Vec3,
  players: readonly PlayerPoint[],
  hitRadius: number,
  shooterId: string,
  selfDamage: boolean
): string | null {
  let best: string | null = null;
  let bestDist = Infinity;
  for (const p of players) {
    if (!selfDamage && p.id === shooterId) continue;
    if (!withinProximity3D(pos, p, hitRadius, PROXIMITY_VERTICAL_M)) continue;
    const d = Math.hypot(p.x - pos.x, p.z - pos.z);
    if (d < bestDist) {
      bestDist = d;
      best = p.id;
    }
  }
  return best;
}

// AOE damage at an explosion center: linear falloff to 0 at aoeRadius,
// floor()'d, shooter excluded unless selfDamage is true. Mirrors
// `_apply_aoe_damage` in the reference exactly (docs/p2-port-notes.md §1
// step 6), with one deliberate addition vs. the reference: distance is now
// anisotropicDist3D (see AOE_VERTICAL_WEIGHT above) instead of flat XZ, so
// an explosion on a bridge deck doesn't full-damage a kart driving on the
// road directly underneath it.
export function computeAoeDamage(
  center: Vec3,
  players: readonly PlayerPoint[],
  stats: AoeStats,
  shooterId: string
): Map<string, number> {
  const result = new Map<string, number>();
  for (const p of players) {
    if (!stats.selfDamage && p.id === shooterId) continue;
    const dist = anisotropicDist3D(p.x - center.x, p.y - center.y, p.z - center.z, AOE_VERTICAL_WEIGHT);
    if (dist > stats.aoeRadius) continue;
    const falloff = Math.max(0, 1 - dist / stats.aoeRadius);
    const dmg = Math.floor(stats.baseDamage * falloff);
    if (dmg > 0) result.set(p.id, dmg);
  }
  return result;
}
