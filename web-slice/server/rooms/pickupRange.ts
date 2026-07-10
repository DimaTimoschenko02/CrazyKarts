// Pure 3D weapon-box pickup gate — extracted from MatchRoom.ts tickBoxes()
// so it's unit-testable without spinning up a Colyseus room. Combines an XZ
// radius (unchanged behavior) with a vertical gate (new): a player driving
// UNDER a bridge that has a box sitting on its deck must NOT pick it up just
// because their XZ distance happens to be inside BOX_PICKUP_RADIUS_M — see
// MatchRoom.ts's BOX_PICKUP_VERTICAL_M doc for why 1.6m was chosen.
export interface PickupPoint {
  x: number;
  y: number;
  z: number;
}

export function isBoxPickupInRange(
  player: PickupPoint,
  box: PickupPoint,
  radiusM: number,
  verticalM: number
): boolean {
  const dist = Math.hypot(player.x - box.x, player.z - box.z);
  if (dist > radiusM) return false;
  return Math.abs(player.y - box.y) <= verticalM;
}
