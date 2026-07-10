// Pure mine simulation math — no Colyseus/schema deps, unit-testable in
// isolation. Same style as rocketSim.ts. New gameplay-programmer work
// (2026-07-10 task brief): mines have no reference implementation, only the
// task spec's stated drop-timing formula.
import { KART_TYPES } from "../../src/kart/stats";
import { DEFAULT_KART_PHYSICS_PARAMS } from "../../src/physics/types";

// Time between consecutive mine drops (task spec formula): dropping 3 mines
// at even T-second intervals while driving at max speed spans 2*T*maxSpeed
// meters from the 1st mine to the 3rd — solving that for T so the span is
// ~1.15x the kart's own body length:
//   T = (1.15 * modelLength / 2) / maxSpeed
export function computeMineDropIntervalS(modelLength: number, maxSpeed: number): number {
  return (1.15 * modelLength) / 2 / maxSpeed;
}

// Owner feedback 2026-07-10: mines were dropping too close together — "not
// even a full kart body's length between them" — widen every drop interval
// by this factor (spacing scales linearly with T, so this scales the gap
// between mines by the same 1.25x too).
const MINE_DROP_INTERVAL_SPACING_MULT = 1.25;

// Single source of truth for the interval actually used in play. "racer" is
// the only kart type that exists today (src/kart/stats.ts) — same
// assumption server/rooms/MatchRoom.ts already makes for other kart-derived
// constants (e.g. MUZZLE_FORWARD_OFFSET_M).
export const MINE_DROP_INTERVAL_S =
  computeMineDropIntervalS(KART_TYPES.racer.modelLength, DEFAULT_KART_PHYSICS_PARAMS.maxSpeed) *
  MINE_DROP_INTERVAL_SPACING_MULT;

// Half the kart's body length — how far behind the kart's reported x/z each
// mine drops (task spec: "смещение назад на ~полкорпуса"), so mines land
// roughly at the rear bumper instead of inside the cockpit.
export const MINE_DROP_BACK_OFFSET_M = KART_TYPES.racer.modelLength / 2;

// A dropped mine can't trigger on anyone (including its own owner) until
// this much time has passed — task spec value (WEAPON_TYPES.mines.armDelayS).
export function isMineArmed(ageS: number, armDelayS: number): boolean {
  return ageS >= armDelayS;
}

// An unarmed-or-armed mine that nobody has triggered silently despawns once
// its lifetime elapses (task spec: "lifetime 30с → тихий деспавн", no AOE).
export function isMineExpired(ageS: number, lifetimeS: number): boolean {
  return ageS >= lifetimeS;
}
