// Snap-to-surface cell picking — pure grid math, split out of main.ts so it
// can be unit tested without a THREE.Scene/Raycaster/camera (same pattern as
// paintLine.ts's cellsAlongLine).
//
// Owner bug report 2026-07-10: with 🧲 "snap to surface" on, the cell under
// the cursor was picked by intersecting the mouse ray against the abstract
// y = y_level*LEVEL_HEIGHT plane. On a raised plateau (surface well above
// that plane) the ray grazes the plane far from where it visually looks like
// it's pointing, landing the cell on/behind terrain the user never aimed at
// — often empty space, which then made the snap offset silently fall back to
// 0 ("attached to the void floor" instead of the visible grass).
//
// The fix (see raycastSnapCell in main.ts) raycasts against the ACTUAL
// placed meshes instead — the same approach precise-delete (X hotkey) already
// uses to find "what is the camera looking at" — and this function converts
// that hit point into the grid cell it falls into, using the editor's
// world <-> cell convention: world = (cell - half) * tileSize.
export function worldPointToCell(
  worldX: number,
  worldZ: number,
  tileSize: number,
  half: number,
  gridSize: number
): { x: number; z: number } {
  const cellSpaceX = worldX / tileSize + half;
  const cellSpaceZ = worldZ / tileSize + half;
  return {
    x: clamp(Math.round(cellSpaceX), 0, gridSize - 1),
    z: clamp(Math.round(cellSpaceZ), 0, gridSize - 1),
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

// The fractional y_offset (meters) that puts a tile's own lowest mesh point
// (bottomY, local meters above its pivot — see tileBottomY in
// shared/heightfield.ts) flush on an already-placed surface at floorHeight.
// Pure math, split out of main.ts's computeSnapOffset so it can be unit
// tested against real map metas (roads preset: tile_size 3, level_height 1.1).
//
// Returns null when floorHeight is null (the sampled spot has no authored
// surface). Callers MUST treat null as "snap found nothing": place at the
// plain y_level height and surface it in the UI (status bar "snap: n/a").
// Owner bug 2026-07-10: an earlier version silently returned 0 here, which
// reads exactly like a successful snap to the void floor — banned.
export function snapOffsetFromSurface(params: {
  readonly floorHeight: number | null;
  readonly yLevel: number;
  readonly levelHeight: number;
  readonly bottomY: number | null; // null = asset has no baked bottom (space-kit) → pivot is the bottom
}): number | null {
  const { floorHeight, yLevel, levelHeight, bottomY } = params;
  if (floorHeight === null) return null;
  const base = yLevel * levelHeight + (bottomY ?? 0);
  return floorHeight - base;
}
