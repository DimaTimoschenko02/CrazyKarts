// Pure heightfield math — no THREE, no rendering. Extracted from
// map/mapLoader.ts (P3 combat vertical slice) so the SAME slope/ascent rules
// can be shared between the client renderer (GameMap wraps this) and the
// Colyseus match server (rocket-vs-terrain collision, server/config/arena.ts)
// without duplicating the ascent tables in two places.
//
// See .claude/rules/map-building.md for the grid conventions this encodes:
//   world_pos = (x * tile_size, y_level * level_height, z * tile_size) + origin_offset
//
// Rotation tables (verified by direct GLB vertex inspection, tools/glb-catalog.mjs,
// see docs/space-kit-terrain-catalog.md and .claude/rules/map-building.md):
//   terrain_ramp  (y_level = LOW):   rot 0 → ascends +Z, 90 → +X, 180 → −Z, 270 → −X
//   terrain_side* (y_level = HIGH):  rot 0 → descends −Z, 90 → −X, 180 → +Z, 270 → +X
// Ramp and side share the exact same ascent basis (+Z at rot=0) — same raw
// topology, just shifted above vs. below the pivot. Corner tiles ascend
// DIAGONALLY toward the plateau corner (see CORNER_ASCENT below).

export interface CellDef {
  asset: string;
  x: number;
  z: number;
  y_level: number;
  rot?: number;
  // Reflect the tile across its local X axis (scale.x = -1) BEFORE the Y
  // rotation — reaches the 4 orientations rotation alone can't for CHIRAL
  // pieces (roadCorner/Split, sideEnd, detailed ramps). NOT purely visual:
  // heightCellFor() below applies the same reflect-then-rotate transform to
  // the ascent gradient for asymmetric families (terrain_sideCorner,
  // terrain_sideCornerInner) so the physics gradient matches the mirrored
  // mesh instead of silently reusing the unmirrored rot's gradient (which,
  // for a diagonal corner, points at a DIFFERENT corner of the tile than the
  // one the mirrored mesh actually raises — see mirroredVec() below and the
  // "mirror-flag proof" section of tools/diagnose_heightfield_holes.ts).
  // For the straight-axis families (ramp/side/sideCliff — ascent gradient
  // (0,1) at rot=0, i.e. no X component) reflect-then-rotate is provably a
  // no-op (reflecting (0,1) across local X yields (0,1) again), so those
  // families are unaffected by this flag either way, matching their
  // genuinely X-symmetric meshes.
  mirror?: boolean;
}

export interface RectFill {
  asset: string;
  x_min: number;
  x_max: number;
  z_min: number;
  z_max: number;
  y_level: number;
  rot?: number;
}

export interface PropDef {
  asset: string;
  x: number;
  z: number;
  y_level: number;
  rot?: number;
  scale?: number;
}

export interface MapJson {
  meta: {
    tile_size: number;
    level_height: number;
    origin_offset: [number, number, number];
  };
  rect_fills?: RectFill[];
  cells?: CellDef[];
  props?: PropDef[];
}

// h(local) = base + rise * (0.5 + localX * ax + localZ * az), local ∈ [-0.5, 0.5].
// Flat cells: rise = 0, base = top surface. Slopes: base = low edge height,
// rise = level_height, (ax, az) = unit ascent direction.
//
// Optional (ax2, az2): second ascent gradient, combined with the first via
// MAX instead of a single lerp — used by terrain_sideCornerInner, whose real
// mesh is "almost the whole tile high, only a small wedge near one corner is
// low" (inversion of sideCorner). A single diagonal gradient (like
// CORNER_ASCENT) undershoots badly along the two straight high edges (dips to
// ~0.35 short of full rise there); MAX of two axis-aligned ramps (one per
// high edge) saturates to full rise exactly at both edges instead. See
// docs/space-kit-terrain-catalog.md "terrain_sideCornerInner".
export interface HeightCell {
  base: number;
  rise: number;
  ax: number;
  az: number;
  ax2?: number;
  az2?: number;
}

// Ascent direction per rotation table above (side descends → ascent is opposite).
// Ramp and side share the same ascent basis (+Z at rot=0) — the raw ramp mesh's
// low edge sits at local Z=-0.5, flat top at Z∈[0,+0.5], identical topology to
// terrain_side just shifted above the pivot instead of below it. Verified by
// direct vertex inspection (tools/glb-catalog.mjs).
const RAMP_ASCENT: Record<number, [number, number]> = {
  0: [0, 1], 90: [1, 0], 180: [0, -1], 270: [-1, 0],
};
const SIDE_ASCENT: Record<number, [number, number]> = {
  0: [0, 1], 90: [1, 0], 180: [0, -1], 270: [-1, 0],
};
// sideCliff ("крутой обрыв" — steep dropoff) is a DRIVABLE steep slope
// (game-designer decision, 2026-07: walls are now exclusively the
// wall_block* family, see isWallOnlyAsset below — sideCliff was briefly
// wall-only, reverted). Axial ascent basis identical to terrain_side (low/
// high edges are straight lines, not a diagonal corner — verified by vertex
// read, docs/space-kit-terrain-catalog.md "terrain_sideCliff"), but the
// mesh's Y-span sits ABOVE the pivot like a ramp, so y_level means the LOW
// edge here (unlike plain side, where y_level means the HIGH edge). Kept as
// its own named alias (rather than reusing SIDE_ASCENT directly) so the two
// tables can diverge later without a silent shared-object edit.
const CLIFF_ASCENT: Record<number, [number, number]> = {
  0: [0, 1], 90: [1, 0], 180: [0, -1], 270: [-1, 0],
};
// sideCorner ascends DIAGONALLY toward the plateau corner (verified by vertex
// read in the browser: at rot 90 the high edge sits at the +X+Z cell corner).
// Components are 1/√2 so the clamped height ramp reaches full rise at the corner.
const D = Math.SQRT1_2;
const CORNER_ASCENT: Record<number, [number, number]> = {
  0: [-D, D], 90: [D, D], 180: [D, -D], 270: [-D, -D],
};
// sideCornerInner: inversion of sideCorner — almost the whole tile is HIGH,
// only a small wedge near one corner is low. rot table below is the LOW
// corner's (x,z) sign per docs/space-kit-terrain-catalog.md. Each entry holds
// two axis-aligned ascent gradients, one toward each of the two straight high
// edges adjacent to the low corner (opposite axis signs of the low corner) —
// combined via MAX in heightCellFor/sample (see HeightCell ax2/az2 doc).
const CORNER_INNER_ASCENT: Record<number, [number, number, number, number]> = {
  0: [-1, 0, 0, 1], // low corner +X-Z: ascend to -X, ascend to +Z
  90: [-1, 0, 0, -1], // low corner +X+Z: ascend to -X, ascend to -Z
  180: [1, 0, 0, -1], // low corner -X+Z: ascend to +X, ascend to -Z
  270: [1, 0, 0, 1], // low corner -X-Z: ascend to +X, ascend to +Z
};

// terrain_sideEnd ("конец полуострова" — peninsula tip) has a genuinely
// asymmetric-in-X mesh — half the tile's high edge caps off at full rise,
// the other half stays low, plus a small vertical face where they meet (see
// docs/space-kit-terrain-catalog.md "terrain_sideEnd": "не полностью
// охарактеризован"). That shape can't be exactly represented by this
// module's single-gradient linear model (h is linear in local x,z; the real
// mesh is a step function of sign(localX)). We approximate it with the same
// straight axial ramp as terrain_side/sideCliff (low edge at local Z=-0.5,
// y_level=LOW edge, Y-span above the pivot like a ramp — confirmed by the
// same vertex read) — this at least removes the LATENT y_level-semantics bug
// documented below (sideEnd used to silently fall into the generic
// terrain_side branch, which assumes y_level=HIGH and geometry BELOW the
// pivot, offsetting sideEnd's height by a full level_height in the wrong
// direction). The residual "half the tile is up to level_height short of the
// visual mesh" imprecision is a known model limitation, not something this
// pass fixes — flag to systems-designer/game-designer if sideEnd placements
// start showing visible float/sink in practice.
const SIDE_END_ASCENT: Record<number, [number, number]> = {
  0: [0, 1], 90: [1, 0], 180: [0, -1], 270: [-1, 0],
};

// Exact (no floating-point noise) cos/sin for the 4 grid rotations, matching
// the rotation convention already baked into the *_ASCENT tables above
// (confirmed against CORNER_ASCENT by direct derivation: rotateVec(-D, D, 90)
// === CORNER_ASCENT[90] === (D, D), etc. for all 4 rotations).
const ROT_COS: Record<number, number> = { 0: 1, 90: 0, 180: -1, 270: 0 };
const ROT_SIN: Record<number, number> = { 0: 0, 90: 1, 180: 0, 270: -1 };

// Rotates a 2D (x,z) vector by one of the 4 grid rotations, using the SAME
// convention the hand-derived *_ASCENT tables already encode (verified: this
// reproduces CORNER_ASCENT[rot] exactly when given CORNER_ASCENT[0] as input
// for every rot in {0,90,180,270}). Used only for the mirror-aware lookups
// below — the primary tables stay as literal, independently vertex-verified
// constants so existing tests/behavior can't silently drift.
function rotateVec(x: number, z: number, rot: number): [number, number] {
  const cos = ROT_COS[rot] ?? 1;
  const sin = ROT_SIN[rot] ?? 0;
  return [x * cos + z * sin, -x * sin + z * cos];
}

// Reflect-then-rotate: mirrors a rot=0 base ascent vector across local X
// (scale.x = -1, applied BEFORE the Y rotation — matches the editor's own
// transform order, src/editor/main.ts applyCellTransform), then rotates it
// by `rot`. This is the physics-side equivalent of what the mirrored mesh
// actually does visually. For families whose rot=0 base vector has ax=0
// (ramp/side/sideCliff/sideEnd — see their tables above), reflecting negates
// nothing (reflect(0,z) = (0,z)) so this is provably identical to the
// unmirrored table — mirror is a real no-op for those, matching their
// X-symmetric meshes. For families with ax≠0 at rot=0 (corner, cornerInner)
// this yields a genuinely different vector.
function mirroredVec(base0: [number, number], rot: number): [number, number] {
  const [x0, z0] = base0;
  return rotateVec(-x0, z0, rot);
}

export function normRot(rot: number | undefined): number {
  return ((Math.round(rot ?? 0) % 360) + 360) % 360;
}

// Assets whose footprint is 2 cells long (local Z ∈ [-1, 1]) instead of 1×1.
// They can't be placed like a 1×1 tile: centred on a cell they straddle the
// two neighbours' halves. Instead they sit at +0.5 along their long axis so
// they occupy the clicked cell + the next one cleanly, and the heightfield
// expands them into two half-height ramp cells (see fromMapJson). Shared by
// the editor (placement/ghost), the loader (visual offset) and the sampler.
export const TWO_CELL_ASSETS = new Set(["terrain_rampLarge", "terrain_rampLarge_detailed"]);

// Unit long-axis (local +Z, the direction a ramp ascends) rotated by rot. For
// the 4 grid rotations this is an axis-aligned ±1 step to the "next" cell.
export function longAxis(rot: number): [number, number] {
  const r = (normRot(rot) * Math.PI) / 180;
  return [Math.round(Math.sin(r)), Math.round(Math.cos(r))];
}

// Assets that contribute NO walkable height to the heightfield — sample() on
// a lone column of one of these returns null, the same "off-map" wall
// sentinel kart.ts step 8 and rocketSim.isBlockedByTerrain already treat as
// solid. `wall_block`, `wall_block_round`, `wall_block_corner` are the
// procedural straight/filleted vertical walls (map/assetLoader.ts) — the
// ONLY wall-only family (game-designer decision, 2026-07): every Edges-family
// terrain asset (terrain_side/sideCliff/sideCorner/sideCornerInner/sideEnd)
// stays a smooth drivable slope, sideCliff included.
export function isWallOnlyAsset(asset: string): boolean {
  return asset.startsWith("wall_block");
}

export function heightCellFor(
  asset: string,
  yLevel: number,
  rot: number,
  levelHeight: number,
  mirror?: boolean
): HeightCell {
  const lh = levelHeight;
  if (asset.startsWith("terrain_ramp")) {
    const [ax, az] = RAMP_ASCENT[rot] ?? [0, 0]; // mirror: no-op, base vector has ax0=0 — see CellDef.mirror doc
    return { base: yLevel * lh, rise: lh, ax, az }; // y_level = LOW edge
  }
  if (asset.startsWith("terrain_sideCornerInner")) {
    // MUST be checked before the generic "terrain_sideCorner" branch below —
    // "terrain_sideCornerInner".startsWith("terrain_sideCorner") is true.
    // Ramp-like vertically (above pivot), same as sideCorner. Two ascent
    // gradients combined via MAX — see CORNER_INNER_ASCENT / HeightCell doc.
    const [ax0, az0, ax20, az20] = CORNER_INNER_ASCENT[0];
    const [ax, az] = mirror ? mirroredVec([ax0, az0], rot) : CORNER_INNER_ASCENT[rot] ?? [0, 0, 0, 0];
    const [ax2, az2] = mirror
      ? mirroredVec([ax20, az20], rot)
      : ([CORNER_INNER_ASCENT[rot]?.[2] ?? 0, CORNER_INNER_ASCENT[rot]?.[3] ?? 0] as [number, number]);
    return { base: yLevel * lh, rise: lh, ax, az, ax2, az2 }; // y_level = LOW corner
  }
  if (asset.startsWith("terrain_sideCorner")) {
    // Ramp-like vertically: geometry spans [0, +level_height] above pivot.
    // Diagonal ascent basis (ax0≠0 at rot=0) — mirror DOES change the
    // gradient here (see mirroredVec doc); ignoring it, as the old code did,
    // makes physics raise the WRONG corner of the tile for every mirrored
    // sideCorner cell (see tools/diagnose_heightfield_holes.ts §3).
    const [ax, az] = mirror ? mirroredVec(CORNER_ASCENT[0], rot) : CORNER_ASCENT[rot] ?? [0, 0];
    return { base: yLevel * lh, rise: lh, ax, az }; // y_level = LOW edge
  }
  if (asset.startsWith("terrain_sideCliff")) {
    // MUST be checked before the generic "terrain_side" branch below —
    // "terrain_sideCliff".startsWith("terrain_side") is true. Axial ascent
    // basis identical to plain side, but Y-span sits ABOVE the pivot like a
    // ramp, so y_level means the LOW edge (not the HIGH edge like plain side).
    const [ax, az] = CLIFF_ASCENT[rot] ?? [0, 0]; // mirror: no-op, ax0=0 — see CellDef.mirror doc
    return { base: yLevel * lh, rise: lh, ax, az }; // y_level = LOW edge
  }
  if (asset.startsWith("terrain_sideEnd")) {
    // MUST be checked before the generic "terrain_side" branch below —
    // "terrain_sideEnd".startsWith("terrain_side") is true. See SIDE_END_ASCENT
    // doc above: approximated as a straight axial ramp, Y-span above pivot
    // (y_level = LOW edge), NOT the generic side's below-pivot/HIGH-edge
    // semantics — this is the fix for the LATENT bug the old code flagged
    // but didn't act on (docs/space-kit-terrain-catalog.md "terrain_sideCliff"
        // section originally called this out for sideCliff; the same fix pattern
    // applies here).
    const [ax, az] = SIDE_END_ASCENT[rot] ?? [0, 0]; // mirror: no-op, ax0=0 — see CellDef.mirror doc
    return { base: yLevel * lh, rise: lh, ax, az }; // y_level = LOW edge
  }
  if (asset.startsWith("terrain_side")) {
    const [ax, az] = SIDE_ASCENT[rot] ?? [0, 0]; // mirror: no-op, ax0=0 — see CellDef.mirror doc
    return { base: yLevel * lh - lh, rise: lh, ax, az }; // y_level = HIGH edge
  }
  return { base: yLevel * lh, rise: 0, ax: 0, az: 0 }; // flat terrain / roads
}

// Pure grid heightfield: builds a lookup of per-cell slope descriptors from a
// MapJson and samples ground height at arbitrary world XZ. No THREE, no
// asset loading — safe to import from both the browser bundle and the
// Colyseus (Node) match server.
export class Heightfield {
  // One column can hold SEVERAL stacked layers (the editor allows multiple
  // assets in one XZ footprint at different y_levels — e.g. two walls
  // forming a 2-level vertical face, optionally capped by a flat top). sample()
  // returns the MAX height across all layers AT THE QUERIED POINT — so the
  // kart stands on the topmost solid, and a flat cap correctly wins over a
  // slope beneath it even where the slope's own peak (its far edge) ties the
  // cap's height.
  private readonly cells = new Map<string, HeightCell[]>();
  // Grid coords of wall_block* cells (isWallOnlyAsset) — tracked SEPARATELY
  // from `cells` (see design/notes/collision-v2.md §3.3): a wall_block column
  // and a genuine off-map/unauthored column both sample() as null, but only
  // the latter is a real "terrain edge" the dynamic terrain-slide path
  // (src/physics/terrainWall.ts) should react to — wall_block collision is
  // now fully owned by the SAT static-polygon path (shared/staticColliders.ts).
  // hasColumn() below is the predicate that tells the two apart.
  private readonly wallCells = new Set<string>();
  private tile = 1;
  private levelHeight = 0.5;
  private originX = 0;
  private originZ = 0;

  static fromMapJson(data: MapJson): Heightfield {
    const hf = new Heightfield();
    hf.tile = data.meta.tile_size;
    hf.levelHeight = data.meta.level_height;
    hf.originX = data.meta.origin_offset[0];
    hf.originZ = data.meta.origin_offset[2];

    for (const rect of data.rect_fills ?? []) {
      if (isWallOnlyAsset(rect.asset)) {
        for (let x = rect.x_min; x <= rect.x_max; x++) {
          for (let z = rect.z_min; z <= rect.z_max; z++) hf.wallCells.add(x + "," + z);
        }
        continue; // visual-only — see isWallOnlyAsset doc
      }
      const rot = normRot(rect.rot);
      for (let x = rect.x_min; x <= rect.x_max; x++) {
        for (let z = rect.z_min; z <= rect.z_max; z++) {
          // RectFill has no mirror field (rectangular fills are always
          // unmirrored, whole-plateau flat/uniform fills in practice).
          hf.setCell(x, z, heightCellFor(rect.asset, rect.y_level, rot, hf.levelHeight));
        }
      }
    }
    for (const cell of data.cells ?? []) {
      if (isWallOnlyAsset(cell.asset)) {
        hf.wallCells.add(cell.x + "," + cell.z);
        continue; // visual-only — see isWallOnlyAsset doc
      }
      const rot = normRot(cell.rot);
      if (TWO_CELL_ASSETS.has(cell.asset)) {
        // Expand a 2-cell ramp into two half-height ramp cells: the clicked
        // cell (low half, base = y_level) and the next cell along the long
        // axis (high half, base = y_level + half). Each rises half a level so
        // the pair spans one full level_height across two tiles — a gentle
        // slope, matching the mesh (its Y-span is one level over two cells).
        const [dx, dz] = longAxis(rot);
        const half = hf.levelHeight / 2;
        const base = cell.y_level * hf.levelHeight;
        hf.setCell(cell.x, cell.z, { base, rise: half, ax: dx, az: dz });
        hf.setCell(cell.x + dx, cell.z + dz, { base: base + half, rise: half, ax: dx, az: dz });
      } else {
        hf.setCell(cell.x, cell.z, heightCellFor(cell.asset, cell.y_level, rot, hf.levelHeight, cell.mirror));
      }
    }
    return hf;
  }

  private setCell(cx: number, cz: number, cell: HeightCell): void {
    // Append a layer to this column (see the cells map doc). Single-layer maps
    // get a 1-element array and behave exactly as before.
    const key = cx + "," + cz;
    const stack = this.cells.get(key);
    if (stack) stack.push(cell);
    else this.cells.set(key, [cell]);
  }

  // World XZ → grid cell coordinates (float, not rounded) — exposed so callers
  // (e.g. spawn/box placement) can convert grid coords to world without
  // duplicating the tile/origin formula.
  gridToWorld(gx: number, gz: number): { x: number; z: number } {
    return { x: gx * this.tile + this.originX, z: gz * this.tile + this.originZ };
  }

  // Every walkable column's (integer) grid coordinates — wall-only columns
  // (isWallOnlyAsset) never make it into `cells` (fromMapJson skips setCell
  // for them), so this is exactly the drivable footprint. Used by the
  // spawn-fallback search (main.ts / server/spawn) when the authored SPAWN
  // point lands off the map (e.g. after a redesigned layout moves the spawn
  // cell) — it needs to find *some* drivable cell without duplicating the
  // "x,z" key parsing.
  listCellCoords(): Array<{ x: number; z: number }> {
    const out: Array<{ x: number; z: number }> = [];
    for (const key of this.cells.keys()) {
      const [x, z] = key.split(",").map(Number);
      out.push({ x, z });
    }
    return out;
  }

  // True if EITHER a walkable cell OR a wall_block* cell was authored at this
  // world XZ's grid column — i.e. "this spot is part of the map's authored
  // footprint at all," regardless of whether sample() itself returns a
  // height. See the wallCells doc comment above: this is what lets the
  // terrain-slide path (src/physics/terrainWall.ts) distinguish a genuine
  // off-map edge (hasColumn===false, terrain-slide should react) from a
  // wall_block hole (hasColumn===true, sample()===null, but the SAT static-
  // polygon path already owns that collision — terrain-slide must NOT also
  // react there, or a kart would get shoved back a full footprint-radius
  // away from the wall instead of the SAT system's flush skin margin).
  hasColumn(wx: number, wz: number): boolean {
    const cx = Math.round((wx - this.originX) / this.tile);
    const cz = Math.round((wz - this.originZ) / this.tile);
    const key = cx + "," + cz;
    return this.cells.has(key) || this.wallCells.has(key);
  }

  // Ground height at a world XZ point, or null when there is no cell there
  // (off the map edge → treated as a wall / explosion trigger by callers).
  sample(wx: number, wz: number): number | null {
    const fx = (wx - this.originX) / this.tile;
    const fz = (wz - this.originZ) / this.tile;
    const cx = Math.round(fx);
    const cz = Math.round(fz);
    const stack = this.cells.get(cx + "," + cz);
    if (!stack) return null;
    const lx = fx - cx;
    const lz = fz - cz;
    let best = -Infinity;
    for (const cell of stack) {
      let t = clamp(0.5 + lx * cell.ax + lz * cell.az, 0, 1);
      if (cell.ax2 !== undefined || cell.az2 !== undefined) {
        const t2 = clamp(0.5 + lx * (cell.ax2 ?? 0) + lz * (cell.az2 ?? 0), 0, 1);
        t = Math.max(t, t2);
      }
      const h = cell.base + cell.rise * t;
      if (h > best) best = h;
    }
    return best;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}
