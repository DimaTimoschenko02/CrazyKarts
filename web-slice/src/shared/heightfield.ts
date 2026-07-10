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
  // "Snap to surface" (editor F / 🧲 toggle, 2026-07-10): a fractional
  // vertical shift in METERS applied on top of y_level*level_height, for
  // tiles whose baked base isn't a multiple of any floor height or
  // level_height step — decorative road tiles (roadTile_019/020, trees on a
  // grass clump) are the motivating case, see tileBottomY() below.
  // Default 0 (omitted entirely when 0 — see editor/main.ts computeSnapOffset
  // callers, which only ever set this key to a nonzero value), so every
  // pre-existing map with no y_offset field loads bit-for-bit unchanged.
  // Applied uniformly to BOTH this HeightCell's `base` and `solidBase` in
  // fromMapJson below — shifting `base` alone would move the visible/
  // sampled surface but leave a stale solidBase, silently reopening the
  // D3a2 burial-filter bug this field predates.
  y_offset?: number;
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
// D3a2 (design/notes/ride-collision-v2.md, 2026-07-09): "floors without
// thickness" model — every layer used to be a bare surface height with no
// notion of how far DOWN its own solid actually extends. That's what let a
// stack of flush-stacked plates read as passable (the bottom plate's top
// happened to sit flush with an unrelated floor on the far side, so the
// column's per-point MAX/candidate logic saw "the floor just continues"
// instead of "there's a wall's worth of solid material here"). `solidBase` is
// the Y of this layer's LOWER face — the bottom of the physical volume this
// HeightCell represents, NOT necessarily equal to `base` (which for a THICK
// solid like a cube is the flat TOP, not the bottom). See heightCellFor()
// below for the per-family derivation and Heightfield's burial filter
// (columnLayers/liveFloors) and solidBlocked() for what actually consumes it.
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
  solidBase: number;
  // "Genuine wall" tag (2026-07-10 follow-up to D5, design/notes/
  // ride-collision-v2.md — see Heightfield.wallBlocked() below): set ONLY on
  // wall_block* cells (heightCellFor's ground_block/wall_block branch below).
  // D5 gated physics/terrainWall.ts's GRAD/STEP checks on layerClimbThreshold
  // — correct for an ordinary heightfield step (a real, climbable rise), but
  // it also silently let a wall_block's half-level (0.5m) side stop counting
  // as a wall whenever climbThreshold (default 0.8) exceeds that height,
  // since Heightfield.solidBlocked() already carried the exact same gate.
  // wall_block* cells are an EXPLICIT authoring choice ("solid from the
  // side, walkable on top", commit ef6c224) — not a plain terrain rise that
  // should ever be climb-gated — so they get their own always-on check
  // (wallBlocked()) instead of relying on the climb-relative one.
  // ground_block does NOT get this flag: it shares wall_block's geometry
  // branch (same cube shape) but was never the "genuinely impassable from
  // the side" family — only its top-edge fillet differs visually from
  // wall_block, per heightCellFor's own doc comment.
  isWall?: boolean;
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
  // D3a2 (design/notes/ride-collision-v2.md, 2026-07-09): the tile's own
  // lowest mesh point (tools/bake-road-tiles.mjs), same local-meters-above-
  // pivot space as topMedian/slope.base — used as this layer's solidBase
  // offset (see heightCellFor's road-tile branch). Baked for every catalog
  // entry (302/302 as of this pass); optional here defensively for a stale/
  // hand-edited catalog missing the field.
  minY?: number;
  slope?: { ax: number; az: number; base: number; rise: number };
  // 12×12 sub-cell height sample, physics:"approx" tiles only — see
  // tools/bake-road-tiles.mjs sampleHeightGrid() and gridSample() above.
  // Absolute tile-local heights (same units/origin as topMedian), indexed
  // [i][j] over the tile's own unrotated footprint (i ~ local X, j ~ local Z).
  heightGrid?: number[][];
}

const ROAD_TILES = roadTilesCatalog as unknown as Record<string, RoadTileCatalogEntry>;

// "Snap to surface" support (CellDef.y_offset doc above): the tile's own
// lowest MESH point (baked `minY`, local meters above the pivot — 0 for all
// 302 tiles as of this pass, the slab bottom IS the pivot plane). This is the
// tile's true floor contact point for snapping: shift the tile so this point
// lands on the sampled surface and its underside sits flush.
//
// History (owner bug 2026-07-10, roads_v1): the first cut of snap used the
// minimum of the physics heightGrid instead. That grid samples the TOP
// (walkable) surface — for roadTile_019 (trees on a grass clump) its minimum
// is 1.577, the lowest point of the clump's top, NOT the mesh bottom.
// Subtracting it drove the offset to floor − 1.577, sinking the tree ~1m
// under the grass ("прикрепилось к нулю, торчит из-под травы"). Snapping must
// use the mesh bottom; the walkable-surface grid belongs to physics sampling
// (heightCellFor) only.
//
// Returns null for assets not in the road-tile catalog (space-kit assets):
// their pivot already sits on their base plane, so editor/main.ts
// computeSnapOffset falls back to the plain yLevel*level_height base.
export function tileBottomY(asset: string): number | null {
  const entry = ROAD_TILES[asset];
  if (!entry) return null;
  return entry.minY ?? 0;
}

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
    // solidBase (D3a2): road-tile thickness is baked per-tile in the catalog
    // as `minY` — the tile's own lowest mesh point, in the SAME local-meters-
    // above-pivot space topMedian/slope.base use (tools/bake-road-tiles.mjs).
    // Offset by yLevel*lh exactly like every other height field on this
    // layer. Missing/unknown catalog entry -> 0 (zero thickness), matching
    // the existing "flat at cell base" fallback for a stale catalog.
    const solidBase = yLevel * lh + (entry?.minY ?? 0);
    // Unknown tile (catalog out of date): flat at the cell base — visible
    // sink is a louder bug signal than a silent throw during map load.
    if (!entry) return { base: yLevel * lh, rise: 0, ax: 0, az: 0, solidBase };
    if (entry.heightGrid) {
      // physics:"approx" — sub-cell grid instead of the linear base+rise
      // model (see HeightCell.grid / gridSample doc). yLevel offsets the
      // whole baked grid up by a level, same as the flat topMedian branch
      // below did before this grid existed.
      return { base: yLevel * lh, rise: 0, ax: 0, az: 0, grid: entry.heightGrid, gridRot: rot, gridMirror: !!mirror, solidBase };
    }
    if (entry.slope) {
      const base0: [number, number] = [entry.slope.ax, entry.slope.az];
      const [ax, az] = mirror ? mirroredVec(base0, rot) : rotateVec(base0[0], base0[1], rot);
      return { base: yLevel * lh + entry.slope.base, rise: entry.slope.rise, ax, az, solidBase };
    }
    return { base: yLevel * lh + entry.topMedian, rise: 0, ax: 0, az: 0, solidBase };
  }
  if (asset.startsWith("terrain_ramp")) {
    const [ax, az] = RAMP_ASCENT[rot] ?? [0, 0]; // mirror: no-op, base vector has ax0=0 — see CellDef.mirror doc
    // solidBase (D3a2): geometry spans [0, +level_height] ABOVE the pivot —
    // the pivot itself (yLevel*lh) is the solid's lower face.
    return { base: yLevel * lh, rise: lh, ax, az, solidBase: yLevel * lh }; // y_level = LOW edge
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
    // solidBase (D3a2): above-pivot family, same as ramp/sideCorner.
    return { base: yLevel * lh, rise: lh, ax, az, ax2, az2, solidBase: yLevel * lh }; // y_level = LOW corner
  }
  if (asset.startsWith("terrain_sideCorner")) {
    // Ramp-like vertically: geometry spans [0, +level_height] above pivot.
    // Diagonal ascent basis (ax0≠0 at rot=0) — mirror DOES change the
    // gradient here (see mirroredVec doc); ignoring it, as the old code did,
    // makes physics raise the WRONG corner of the tile for every mirrored
    // sideCorner cell (see tools/diagnose_heightfield_holes.ts §3).
    const [ax, az] = mirror ? mirroredVec(CORNER_ASCENT[0], rot) : CORNER_ASCENT[rot] ?? [0, 0];
    // solidBase (D3a2): above-pivot family — pivot (yLevel*lh) is the floor.
    return { base: yLevel * lh, rise: lh, ax, az, solidBase: yLevel * lh }; // y_level = LOW edge
  }
  if (asset.startsWith("terrain_sideCliff")) {
    // MUST be checked before the generic "terrain_side" branch below —
    // "terrain_sideCliff".startsWith("terrain_side") is true. Axial ascent
    // basis identical to plain side, but Y-span sits ABOVE the pivot like a
    // ramp, so y_level means the LOW edge (not the HIGH edge like plain side).
    const [ax, az] = CLIFF_ASCENT[rot] ?? [0, 0]; // mirror: no-op, ax0=0 — see CellDef.mirror doc
    // solidBase (D3a2): above-pivot family, same as ramp.
    return { base: yLevel * lh, rise: lh, ax, az, solidBase: yLevel * lh }; // y_level = LOW edge
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
    // solidBase (D3a2): above-pivot family, same as ramp.
    return { base: yLevel * lh, rise: lh, ax, az, solidBase: yLevel * lh }; // y_level = LOW edge
  }
  if (asset.startsWith("terrain_side")) {
    const [ax, az] = SIDE_ASCENT[rot] ?? [0, 0]; // mirror: no-op, ax0=0 — see CellDef.mirror doc
    // solidBase (D3a2): BELOW-pivot family — geometry spans [-level_height, 0]
    // below the pivot (y_level = HIGH edge), so the LOW edge (base itself,
    // yLevel*lh - lh) is already the solid's own lower face.
    return { base: yLevel * lh - lh, rise: lh, ax, az, solidBase: yLevel * lh - lh }; // y_level = HIGH edge
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
    // solidBase (D3a2): the ONE family here where base (the flat TOP) and
    // solidBase (the flat BOTTOM, one full level_height below it) genuinely
    // differ — the cube has real thickness, unlike every thin-quad terrain
    // family above.
    // isWall (2026-07-10, see HeightCell.isWall doc): only the wall_block*
    // half of this shared branch is tagged — ground_block was never meant to
    // be an always-solid side, see that doc comment for the full rationale.
    return { base: (yLevel + 1) * lh, rise: 0, ax: 0, az: 0, solidBase: yLevel * lh, isWall: asset.startsWith("wall_block") };
  }
  // Flat terrain / roads: a thin quad with zero thickness — solidBase equals
  // the surface height itself (base, since rise=0 here means the surface
  // never varies across the cell).
  return { base: yLevel * lh, rise: 0, ax: 0, az: 0, solidBase: yLevel * lh }; // flat terrain / roads
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
      // y_offset (CellDef doc above): shifts this cell's whole layer — both
      // the sampled surface (`base`) and its solid's lower face
      // (`solidBase`) — by a fractional number of meters. Applied uniformly
      // to whichever branch below produced the HeightCell(s), so burial
      // filtering/solidBlocked (which read solidBase, not base) stay correct
      // for an offset tile exactly like for an unoffset one.
      const offset = cell.y_offset ?? 0;
      if (TWO_CELL_ASSETS.has(cell.asset)) {
        // Expand a 2-cell ramp into two half-height ramp cells: the clicked
        // cell (low half, base = y_level) and the next cell along the long
        // axis (high half, base = y_level + half). Each rises half a level so
        // the pair spans one full level_height across two tiles — a gentle
        // slope, matching the mesh (its Y-span is one level over two cells).
        const [dx, dz] = longAxis(rot);
        const half = hf.levelHeight / 2;
        const base = cell.y_level * hf.levelHeight + offset;
        // solidBase (D3a2): same above-pivot family as terrain_ramp — each
        // half's own base IS its solid's lower face (no separate thickness
        // below it, matching the single-cell ramp branch above).
        hf.setCell(cell.x, cell.z, { base, rise: half, ax: dx, az: dz, solidBase: base });
        hf.setCell(cell.x + dx, cell.z + dz, { base: base + half, rise: half, ax: dx, az: dz, solidBase: base + half });
      } else {
        const hc = heightCellFor(cell.asset, cell.y_level, rot, hf.levelHeight, cell.mirror);
        if (offset !== 0) {
          hc.base += offset;
          hc.solidBase += offset;
        }
        hf.setCell(cell.x, cell.z, hc);
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

  // One stacked layer's (height, solidBase) pair AT a specific query point —
  // solidBase is per-cell constant (see heightCellFor), h varies with lx/lz
  // for sloped/grid layers exactly like the old columnHeights() did.
  private static readonly EPS = 0.02; // D3a2 burial-filter tolerance (meters) — see liveFloors doc

  // Per-layer (height, solidBase) pairs of the column under a world XZ point,
  // or null when nothing was authored there. Factored out of sample()/
  // sampleAt()/solidBlocked() so all three share the exact same per-cell math
  // (grid lookup or linear base+rise+MAX ax2/az2 model).
  private columnLayers(wx: number, wz: number): Array<{ h: number; solidBase: number; isWall?: boolean }> | null {
    const fx = (wx - this.originX) / this.tile;
    const fz = (wz - this.originZ) / this.tile;
    const cx = Math.round(fx);
    const cz = Math.round(fz);
    const stack = this.cells.get(cx + "," + cz);
    if (!stack) return null;
    const lx = fx - cx;
    const lz = fz - cz;
    const layers: Array<{ h: number; solidBase: number; isWall?: boolean }> = [];
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
      layers.push({ h, solidBase: cell.solidBase, isWall: cell.isWall });
    }
    return layers;
  }

  // D3a2 burial filter: a floor is BURIED (not a real standing/candidate
  // surface at this point) when some OTHER layer's solid actually occupies
  // the space right at/below this floor's own height and sticks up higher —
  // i.e. this floor is the underside of a taller solid sitting flush on top
  // of it, not open ground. Concretely: layer i is buried iff there exists
  // layer j (j != i) with solidBase_j <= h_i + EPS (j's solid starts at/below
  // i's floor — no gap) AND h_j > h_i + EPS (j's solid actually rises above
  // i's floor, not just touching it). This is what fixes the "stopped wall
  // stack proezzhaetsya naskvoz'" bug (symptom A, design/notes/
  // ride-collision-v2.md): a stack of flush-stacked plates only ever exposes
  // its OWN topmost floor as a live candidate — every plate below it is
  // buried inside the stack's own solid material, so a probe standing at the
  // stack's mid-height correctly reads "wall", not "floor continues here".
  private liveFloors(layers: Array<{ h: number; solidBase: number }>): Array<{ h: number; solidBase: number }> {
    const EPS = Heightfield.EPS;
    return layers.filter((li, i) => !layers.some((lj, j) => j !== i && lj.solidBase <= li.h + EPS && lj.h > li.h + EPS));
  }

  // Per-layer heights of the column under a world XZ point, or null when
  // nothing was authored there. Thin wrapper over columnLayers() kept for
  // sample() below, which deliberately stays on the RAW (unfiltered) height
  // list — the topmost layer in a column is never buried by construction (no
  // other layer can both start at/below its own height AND rise higher than
  // it), so applying the burial filter here would be a no-op for the MAX this
  // method returns; skipping it keeps sample()'s existing callers (spawn,
  // diagnostics, rocket terrain-block) bit-for-bit unchanged.
  private columnHeights(wx: number, wz: number): number[] | null {
    const layers = this.columnLayers(wx, wz);
    return layers === null ? null : layers.map(l => l.h);
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
  // (any LIVE layer — see liveFloors doc — at/below yRef + climbThreshold),
  // falling back to the LOWEST live floor in the column when the mover is
  // below every layer (e.g. it just fell through/spawned under a stack).
  // This is what lets a kart drive UNDER a bridge/roof instead of the plain
  // MAX-of-layers sample() always snapping it onto the highest surface in
  // the column.
  //
  // D3a2: candidates (and the below-everything fallback) are now filtered
  // through liveFloors() first, so a BURIED floor (e.g. the underside of a
  // flush-stacked wall plate — see liveFloors doc) can never be picked as a
  // standing surface here either, consistent with sample()'s own MAX (which
  // never needed the filter — see columnHeights doc) and solidBlocked()
  // below (which deliberately does NOT filter — a buried floor is still real
  // solid material for collision purposes, just not a place to stand).
  sampleAt(wx: number, wz: number, yRef: number, climbThreshold: number): number | null {
    const layers = this.columnLayers(wx, wz);
    if (layers === null) return null;
    const live = this.liveFloors(layers);
    let bestCandidate = -Infinity;
    let hasCandidate = false;
    let lowest = Infinity;
    for (const l of live) {
      if (l.h < lowest) lowest = l.h;
      if (l.h <= yRef + climbThreshold) {
        hasCandidate = true;
        if (l.h > bestCandidate) bestCandidate = l.h;
      }
    }
    return hasCandidate ? bestCandidate : lowest;
  }

  // D3a3 (design/notes/ride-collision-v2.md, 2026-07-09): honest solid-vs-
  // moving-body intersection test, for callers that need a real "is there a
  // WALL here" answer rather than a floor-follow height — the launch-off-a-
  // ramp-into-a-wall-plate case (symptom B2) needs this because a flying kart
  // isn't standing on anything, so sampleAt's "which floor is under me" model
  // doesn't apply; it needs "does any solid's volume overlap the space my
  // body currently occupies".
  //
  // A layer blocks iff ALL of:
  //   1. h > yRef + climbThreshold — its surface is too tall to just climb
  //      onto (an ordinary curb/step stays climbable, not a wall).
  //   2. solidBase < kartTop — the solid's own lower face starts below the
  //      TOP of the body's vertical extent (otherwise the solid is entirely
  //      ABOVE the body — e.g. a bridge deck over a kart driving underneath,
  //      see the design doc's explicit "drive-under stays free" example).
  //   3. h > yRef — the solid's own top is above the body's BOTTOM (yRef;
  //      otherwise the solid is entirely below the body — standing/driving
  //      on top of something is not "blocked").
  // (2) and (3) together are exactly interval-overlap: [solidBase, h] ∩
  // [yRef, kartTop] is non-empty.
  //
  // Deliberately uses the RAW (unfiltered) layer list, not liveFloors() — a
  // buried floor (e.g. one plate inside a flush-stacked wall) is still real
  // solid material a body can run into; burial only changes which floor a
  // body STANDS on, not what blocks it.
  solidBlocked(wx: number, wz: number, yRef: number, kartTop: number, climbThreshold: number): boolean {
    const layers = this.columnLayers(wx, wz);
    if (layers === null) return false;
    for (const l of layers) {
      if (l.h > yRef + climbThreshold && l.solidBase < kartTop && l.h > yRef) return true;
    }
    return false;
  }

  // D5 follow-up (2026-07-10, design/notes/ride-collision-v2.md — wall_block
  // regression fix): an explicit, NEVER climb-gated check for the wall_block*
  // family (HeightCell.isWall doc above). Unlike solidBlocked()/sampleAt()'s
  // `climbThreshold`, this deliberately does NOT scale with
  // KartPhysicsParams.layerClimbThreshold — a wall_block's side is an
  // authored "always a wall" decision (commit ef6c224: "solid from the side,
  // walkable on top"), not an ordinary terrain rise that should ever become
  // climbable just because a designer tunes climb reach up for curbs/decks
  // elsewhere on the map.
  //
  // WALL_TOP_TOLERANCE (0.25m): a body standing/driving ON TOP of a
  // wall_block has yRef essentially equal to that same cell's own top (h) —
  // without slack this cell's OWN layer would immediately re-trigger itself
  // as "a wall right under me" the instant sub-meter float noise or a
  // shallow probe offset put yRef a hair below h, freezing a kart that's
  // already standing on the block. 0.25 is comfortably larger than any such
  // noise (position quantization, probe half-extents) while staying well
  // under a half-level step (0.5m default), so a genuinely DIFFERENT,
  // taller wall_block one level up is still caught.
  private static readonly WALL_TOP_TOLERANCE = 0.25;

  wallBlocked(wx: number, wz: number, yRef: number): boolean {
    const layers = this.columnLayers(wx, wz);
    if (layers === null) return false;
    for (const l of layers) {
      if (l.isWall && l.h > yRef + Heightfield.WALL_TOP_TOLERANCE) return true;
    }
    return false;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}
