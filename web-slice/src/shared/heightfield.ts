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

// Weapon-box spawn point, authored by hand in the map editor (grid-cell
// coordinates, same space as CellDef — NOT world meters). This is a pure
// gameplay-spawn annotation, not a terrain layer: Heightfield.fromMapJson
// below never reads box_points, so hand-placed boxes have zero effect on
// collision/slope — only server/config/arena.ts (Colyseus match server)
// consumes this field, converting grid -> world via the same
// Heightfield.gridToWorld formula the old auto-derived box grid used. See
// server/spawn/autoSpawn.ts deriveBoxGrid for the fallback used when this is
// absent/empty (keeps every pre-existing map loading unchanged).
export interface BoxPointDef {
  x: number;
  z: number;
  y_level: number;
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
  box_points?: BoxPointDef[];
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
//
// Optional `grid`: a baked 12×12 sub-cell height sample (road tiles with
// physics:"approx" — RoadTileCatalogEntry.heightGrid). When present, sample()
// ignores rise/ax/az/ax2/az2 for this layer entirely and instead point-
// samples the grid via gridSample() below, which undoes this cell's
// rot/mirror to find which grid cell sits under the query point. See
// gridSample() doc for the transform.
export interface HeightCell {
  base: number;
  rise: number;
  ax: number;
  az: number;
  ax2?: number;
  az2?: number;
  grid?: number[][];
  gridRot?: number;
  gridMirror?: boolean;
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
// (game-designer decision, 2026-07 — sideCliff was briefly wall-only,
// reverted; the wall_block* family later stopped being walls too, see the
// note above heightCellFor). Axial ascent basis identical to terrain_side (low/
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

// Point-samples a baked sub-cell height grid (RoadTileCatalogEntry.heightGrid,
// tools/bake-road-tiles.mjs sampleHeightGrid()) at normalized cell-local
// offset (lx,lz) ∈ [-0.5,0.5] (0,0 = cell center — the SAME space sample()
// already uses for lx/lz and the *_ASCENT tables use for ax/az).
//
// The grid was baked over the tile's UNROTATED, UNMIRRORED mesh-local
// footprint (tools/bake-road-tiles.mjs FOOTPRINT_X/Z, normalized here the
// same way the ascent tables normalize a raw local vector to [-0.5,0.5]).
// map/mapLoader.ts places each instance with rotation.y = rot and, if
// mirrored, scale.x = -1 applied BEFORE rotation in three.js's TRS order
// (mirror = reflect across local X, then rotate — see CellDef.mirror doc) —
// exactly the transform mirroredVec()/rotateVec() already encode for ascent
// vectors above. So a world-space query offset (lx,lz) maps back to the grid
// by applying the INVERSE of that same transform: rotate by -rot, then (if
// mirrored) negate the X component — i.e. rotate-then-un-mirror, the reverse
// order of the forward un-mirror-then-rotate placement.
//
// Derivation: forward is world = R(rot)·S(mirror)·local (S = diag(±1,1), an
// involution). rotateVec(x,z,rot) is exactly R(rot) in this codebase's
// convention (verified against CORNER_ASCENT — see rotateVec doc). R is
// orthogonal with det 1, so its inverse is R(-rot); S is its own inverse. So
// local = S(mirror)·R(-rot)·world — rotate the query offset by -rot first,
// THEN negate X if mirrored (S does not commute past R in general, so this
// order, not "un-mirror then un-rotate", is the one that actually inverts
// the forward transform).
//
// D3a (design/notes/ride-collision-v2.md, 2026-07-09): this was originally
// point-sampled (nearest grid cell, no bilinear) on the theory that blending
// across sharp height steps (curb lips, canal bank edges) would smear back
// the false-wall/false-hole bug this grid replaces. That theory was wrong in
// practice: the 12×12 baked grid's own cell-to-cell steps (~10cm on a
// road-tile-sized cell) were themselves being read as terrain by the
// vertical-follow path, and a driving kart crossing grid-cell boundaries hit
// a real, felt micro-stairstep ("chatter" symptom #4) — not a rendering
// artifact, an actual discontinuous ground-height signal every ~10-25cm of
// travel. Bilinear interpolation between the 4 surrounding grid cells turns
// that into an honest, continuous slope (matching what the baked data is
// actually approximating: a smoothly-varying deck surface, not a real
// staircase). Genuine walls/edges are NOT lost by this — see
// physics/terrainWall.ts's D3b gradient check, which now recognizes "wall"
// by measured slope over a fixed short probe base rather than relying on
// gridSample()'s old raw single-cell steps to manufacture one.
//
// Clamps the CONTINUOUS fractional index to [0, n-1] (not the integer cell
// index) before flooring, so a query at/past the very edge cell's own center
// holds that edge cell's value flat with zero blend, rather than either
// wrapping or extrapolating past the grid's own data — "clamp indices, don't
// read a neighboring cell" per the design doc, and this module never reads
// outside its own single `grid` array regardless (neighboring MAP tiles are
// a wholly separate HeightCell / column lookup in sample() below).
function gridSample(lx: number, lz: number, grid: number[][], rot: number, mirror: boolean): number {
  const [rx, rz] = rotateVec(lx, lz, normRot(-rot));
  const nx = mirror ? -rx : rx;
  const nz = rz;
  const n = grid.length;
  const fx = clamp((nx + 0.5) * n - 0.5, 0, n - 1);
  const fz = clamp((nz + 0.5) * n - 0.5, 0, n - 1);
  const i0 = Math.floor(fx);
  const i1 = Math.min(i0 + 1, n - 1);
  const j0 = Math.floor(fz);
  const j1 = Math.min(j0 + 1, n - 1);
  const tx = fx - i0;
  const tz = fz - j0;
  const h00 = grid[i0][j0];
  const h10 = grid[i1][j0];
  const h01 = grid[i0][j1];
  const h11 = grid[i1][j1];
  const hLoZ = h00 + (h10 - h00) * tx;
  const hHiZ = h01 + (h11 - h01) * tx;
  return hLoZ + (hHiZ - hLoZ) * tz;
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

// NOTE (owner decision 2026-07-08): the "wall-only asset" concept is GONE.
// wall_block* used to be infinite walls (no walkable height, SAT-owned
// collision) — but a 1x0.5 cube you can never stand on contradicted the
// owner's mental model ("через него нельзя проехать, но сверху можно").
// wall_block* now shares ground_block's physics exactly: the cube TOP is a
// walkable surface, the sides block naturally because a full-level 0.5 step
// exceeds the kart's MAX_STEP. Rockets fly over a block when above its top
// (rocketSim.isBlockedByTerrain compares heights) — also physically right.

// ── Kenney 3D Road Tiles (roadTile_NNN) — data-driven physics ─────────────
// Per-tile geometry facts baked offline by tools/bake-road-tiles.mjs (column
// sampling over the raw triangles — the "read the vertices, don't trust a
// screenshot" doctrine). Heights in the catalog are in the tile's own local
// meters ABOVE ITS PIVOT (the road deck sits ~0.55m above y=0 — these tiles
// are thick slabs), independent of the map's level_height:
//   physics "exact"  — flat (one height: topMedian) or a straight axis slope
//                      (base + rise + unit ascent, rotated/mirrored below).
//   physics "approx" — bridges / curved slopes / water / misc render fully
//                      but the heightfield treats them as FLAT at topMedian.
//                      Bridges can't be driven UNDER yet: this column model
//                      stores one surface per layer and callers take the MAX,
//                      so a drive-under needs a real multi-layer query — see
//                      docs/roads-catalog.md; deferred until bridge tiles
//                      actually land in a map.
import roadTilesCatalog from "./roadTilesCatalog.json";

interface RoadTileCatalogEntry {
  kind: string;
  physics: "exact" | "approx";
  topMedian: number;
  slope?: { ax: number; az: number; base: number; rise: number };
  // 12×12 sub-cell height sample, physics:"approx" tiles only — see
  // tools/bake-road-tiles.mjs sampleHeightGrid() and gridSample() above.
  // Absolute tile-local heights (same units/origin as topMedian), indexed
  // [i][j] over the tile's own unrotated footprint (i ~ local X, j ~ local Z).
  heightGrid?: number[][];
}

const ROAD_TILES = roadTilesCatalog as unknown as Record<string, RoadTileCatalogEntry>;

export function isRoadTileAsset(asset: string): boolean {
  return asset.startsWith("roadTile_");
}

export function heightCellFor(
  asset: string,
  yLevel: number,
  rot: number,
  levelHeight: number,
  mirror?: boolean
): HeightCell {
  const lh = levelHeight;
  if (isRoadTileAsset(asset)) {
    const entry = ROAD_TILES[asset];
    // Unknown tile (catalog out of date): flat at the cell base — visible
    // sink is a louder bug signal than a silent throw during map load.
    if (!entry) return { base: yLevel * lh, rise: 0, ax: 0, az: 0 };
    if (entry.heightGrid) {
      // physics:"approx" — sub-cell grid instead of the linear base+rise
      // model (see HeightCell.grid / gridSample doc). yLevel offsets the
      // whole baked grid up by a level, same as the flat topMedian branch
      // below did before this grid existed.
      return { base: yLevel * lh, rise: 0, ax: 0, az: 0, grid: entry.heightGrid, gridRot: rot, gridMirror: !!mirror };
    }
    if (entry.slope) {
      const base0: [number, number] = [entry.slope.ax, entry.slope.az];
      const [ax, az] = mirror ? mirroredVec(base0, rot) : rotateVec(base0[0], base0[1], rot);
      return { base: yLevel * lh + entry.slope.base, rise: entry.slope.rise, ax, az };
    }
    return { base: yLevel * lh + entry.topMedian, rise: 0, ax: 0, az: 0 };
  }
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
  if (asset === "ground_block" || asset.startsWith("wall_block")) {
    // Drivable cube (map/assetLoader.ts): the walkable surface is the cube's
    // TOP face, one level above the pivot (the cube spans
    // [y_level, y_level+1] * level_height). Stacked cubes each add a flat
    // layer; sample()'s per-point MAX picks the top of the stack. Sides block
    // naturally: a full-level 0.5 step exceeds MAX_STEP, so terrainWall
    // treats the cube face as a wall — drive onto it via a ramp/slope,
    // exactly like a plateau edge. wall_block* shares this branch since the
    // 2026-07-08 owner decision (see the note above heightCellFor) — the two
    // families differ only in top-edge fillets, which are purely visual.
    return { base: (yLevel + 1) * lh, rise: 0, ax: 0, az: 0 };
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

  // Every authored column's (integer) grid coordinates. Since the 2026-07-08
  // wall_block rework EVERY authored cell is walkable (wall/ground cubes
  // included — their walkable surface is the cube top), so this is exactly
  // the drivable footprint. Used by the spawn-fallback search (main.ts /
  // server/spawn) when the authored SPAWN point lands off the map (e.g.
  // after a redesigned layout moves the spawn cell) — it needs to find
  // *some* drivable cell without duplicating the "x,z" key parsing.
  listCellCoords(): Array<{ x: number; z: number }> {
    const out: Array<{ x: number; z: number }> = [];
    for (const key of this.cells.keys()) {
      const [x, z] = key.split(",").map(Number);
      out.push({ x, z });
    }
    return out;
  }

  // True if any cell was authored at this world XZ's grid column — i.e.
  // "this spot is part of the map's authored footprint." Since the 2026-07-08
  // wall_block rework every authored column also has a walkable height, so
  // this is equivalent to sample() !== null; kept as its own predicate
  // because callers (src/physics/terrainWall.ts, kart.ts step 8c) ask the
  // "is this off the map?" question, not the "how high is the ground?" one.
  hasColumn(wx: number, wz: number): boolean {
    const cx = Math.round((wx - this.originX) / this.tile);
    const cz = Math.round((wz - this.originZ) / this.tile);
    return this.cells.has(cx + "," + cz);
  }

  // Per-layer heights of the column under a world XZ point, or null when
  // nothing was authored there. Factored out of sample()/sampleAt() so both
  // share the exact same per-cell math (grid lookup or linear base+rise+MAX
  // ax2/az2 model) — neither of those was touched, only lifted out of the
  // old sample() loop body.
  private columnHeights(wx: number, wz: number): number[] | null {
    const fx = (wx - this.originX) / this.tile;
    const fz = (wz - this.originZ) / this.tile;
    const cx = Math.round(fx);
    const cz = Math.round(fz);
    const stack = this.cells.get(cx + "," + cz);
    if (!stack) return null;
    const lx = fx - cx;
    const lz = fz - cz;
    const heights: number[] = [];
    for (const cell of stack) {
      let h: number;
      if (cell.grid) {
        // Sub-cell grid layer (road tiles, physics:"approx") — bypasses the
        // linear base+rise model entirely. See HeightCell.grid / gridSample doc.
        h = cell.base + gridSample(lx, lz, cell.grid, cell.gridRot ?? 0, cell.gridMirror ?? false);
      } else {
        let t = clamp(0.5 + lx * cell.ax + lz * cell.az, 0, 1);
        if (cell.ax2 !== undefined || cell.az2 !== undefined) {
          const t2 = clamp(0.5 + lx * (cell.ax2 ?? 0) + lz * (cell.az2 ?? 0), 0, 1);
          t = Math.max(t, t2);
        }
        h = cell.base + cell.rise * t;
      }
      heights.push(h);
    }
    return heights;
  }

  // Ground height at a world XZ point, or null when there is no cell there
  // (off the map edge → treated as a wall / explosion trigger by callers).
  // Always the MAX across every stacked layer — this is the "topmost solid
  // wins" convention every existing caller (spawn, diagnostics, rocket
  // terrain-block) still relies on. See sampleAt() below for the
  // layer-aware query multi-level ground-follow needs (driving UNDER a
  // bridge/second floor instead of snapping onto its roof).
  sample(wx: number, wz: number): number | null {
    const heights = this.columnHeights(wx, wz);
    if (heights === null) return null;
    return Math.max(...heights);
  }

  // Layer-aware ground height for a mover currently sitting near `yRef`
  // (typically its own y from the START of this tick, before any vertical
  // step). Picks the highest floor the mover could actually be standing ON
  // (any layer at/below yRef + climbThreshold), falling back to the LOWEST
  // floor in the column when the mover is below every layer (e.g. it just
  // fell through/spawned under a stack). This is what lets a kart drive
  // UNDER a bridge/roof instead of the plain MAX-of-layers sample() always
  // snapping it onto the highest surface in the column.
  //
  // v1 limitation: layers are floors only, no ceilings/thickness — driving
  // within `climbThreshold` of the underside of an overhead deck will still
  // let the mover "climb" onto it (there's no separate headroom check). Not
  // a regression versus the old MAX-only behavior (which had no under-bridge
  // driving at all), just the model's current scope — see the map-building
  // rules doc if a real ceiling/headroom check becomes necessary later.
  sampleAt(wx: number, wz: number, yRef: number, climbThreshold: number): number | null {
    const heights = this.columnHeights(wx, wz);
    if (heights === null) return null;
    let bestCandidate = -Infinity;
    let hasCandidate = false;
    let lowest = Infinity;
    for (const h of heights) {
      if (h < lowest) lowest = h;
      if (h <= yRef + climbThreshold) {
        hasCandidate = true;
        if (h > bestCandidate) bestCandidate = h;
      }
    }
    return hasCandidate ? bestCandidate : lowest;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}
