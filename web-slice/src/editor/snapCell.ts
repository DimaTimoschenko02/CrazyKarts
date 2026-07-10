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

// Highest surface Y (world meters) the snap picker is allowed to target while
// the user's active level is yLevel — the top of that level's own band, plus a
// small epsilon so a surface sitting EXACTLY on the band boundary (e.g. a
// full-height block's top) still counts.
//
// Owner regression 2026-07-10 #1: raycastSnapCell used to take the FIRST mesh
// hit along the camera ray unconditionally, i.e. always the highest surface —
// a bridge deck, a wall top — making Q/E level selection dead in snap mode
// ("can't place under a bridge anymore"). Both the mesh-ray hit filter and the
// heightfield floor sampling now reject surfaces above this cap, so aiming
// under a deck with y_level 0 skips the deck and lands on the floor below;
// raising Q/E to the deck's level makes the deck targetable again.
export function snapLevelCapY(yLevel: number, levelHeight: number, eps = 0.01): number {
  return (yLevel + 1) * levelHeight + eps;
}

// Where a snap placement actually gets WRITTEN into the cells map.
//
// Owner regression 2026-07-10 #2: cells are keyed by (x, z, y_level), and a
// snapped record used to keep the user's active y_level verbatim — so gluing a
// tree onto grass at the same active level produced the SAME key as the grass
// and silently replaced it ("дерево стоит, а блок под ним пропал"). Instead,
// bump y_level up to the first free layer at/above the requested one and fold
// the difference back into y_offset, so the final WORLD height is unchanged:
// worldBottom stays exactly floorHeight regardless of which layer the record
// lives on. Grass keeps (x,z,0); the tree lands on (x,z,1) with a negative
// y_offset that visually plants its bottom on the grass top.
//
// maxLevels is a hard iteration cap (a real column can't be taller than the
// map allows; this only guards against a pathological isLevelOccupied).
export function resolveSnapPlacement(params: {
  readonly yLevel: number;
  readonly levelHeight: number;
  readonly floorHeight: number;
  readonly bottomY: number | null; // null = asset has no baked bottom → pivot is the bottom
  readonly isLevelOccupied: (level: number) => boolean;
  readonly maxLevels?: number;
}): { yLevel: number; yOffset: number } {
  const { yLevel, levelHeight, floorHeight, bottomY, isLevelOccupied } = params;
  const maxLevels = params.maxLevels ?? 256;
  let level = yLevel;
  while (isLevelOccupied(level) && level < yLevel + maxLevels) level++;
  const yOffset = floorHeight - (level * levelHeight + (bottomY ?? 0));
  return { yLevel: level, yOffset };
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
