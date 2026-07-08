// Builds the full set of static XZ collision polygons for a map — wall_block*
// cells (AABB) + props (OBB for structural, convex hull for natural decor) —
// from a MapJson + the baked shape table (collisionShapes.json). Pure, no
// THREE — shared by the browser bundle (src/map/mapLoader.ts wraps this for
// rendering) and the Colyseus match server (design/notes/collision-v2.md §6).
//
// This module is also the SINGLE SOURCE for "which prop asset gets a
// collider at all" (STRUCTURAL_PROP_ASSETS / NATURAL_DECOR_ASSETS / the size
// gates below) — previously duplicated ad hoc in map/mapLoader.ts's own
// circle-collision code (see git history), now centralized here so the
// client's visual placement code and this shape-collision code can never
// drift on WHICH props are solid, only on how they render.
import { ConvexPoly, makeAabb, transformLocalPoly } from "./collision2d";
import { isWallOnlyAsset, normRot, type MapJson } from "./heightfield";

// Skin margin for static-vs-kart contact resolution (design doc §2.1/§3.2,
// owner decision: "коллизии точно по контурам, ездить на грани" — skin is a
// deliberately tiny anti-jitter/anti-snag margin, NOT a soft "grace" buffer
// like the old PROP_COLLISION_SHRINK=0.8. Bump this up only if the owner
// asks for a rougher/softer feel later — see collision-v2.md §11 open
// question 2 (owner picked the literal-contour option).
export const STATIC_COLLISION_SKIN = 0.02;

// ─── Prop classification (moved from map/mapLoader.ts) ──────────────────────
// See .claude/rules/map-building.md "Props" and design/notes/collision-v2.md
// §2.3 for the two-tier model. Also duplicated (intentionally, see its own
// header comment) into tools/bake-collision-shapes.mjs so the offline baker
// knows which GLBs to process — if you add an asset here, rerun that script.
export const STRUCTURAL_PROP_ASSETS = new Set([
  "corridor", "corridor_corner", "corridor_cornerRound", "corridor_cornerRoundWindow",
  "corridor_cross", "corridor_detailed", "corridor_end", "corridor_open", "corridor_roof",
  "corridor_split", "corridor_wall", "corridor_wallCorner", "corridor_window", "corridor_windowClosed",
  "hangar_largeA", "hangar_largeB", "hangar_roundA", "hangar_roundB", "hangar_roundGlass",
  "hangar_smallA", "hangar_smallB",
  "structure", "structure_closed", "structure_detailed", "structure_diagonal",
  "gate_complex", "gate_simple",
  "craft_cargoA", "craft_cargoB", "craft_miner",
  "craft_speederA", "craft_speederB", "craft_speederC", "craft_speederD",
  "rocket_baseA", "rocket_baseB", "rocket_finsA", "rocket_finsB",
  "rocket_fuelA", "rocket_fuelB", "rocket_sidesA", "rocket_sidesB",
  "rocket_topA", "rocket_topB",
  "machine_barrel", "machine_barrelLarge", "machine_generator", "machine_generatorLarge",
  "satelliteDish_large", "turret_single", "turret_double",
  "rover",
]);

export const NATURAL_DECOR_ASSETS = new Set([
  "rock", "rocks_smallA", "rocks_smallB", "rock_crystals",
  "rock_largeA", "rock_largeB", "rock_crystalsLargeA", "rock_crystalsLargeB",
  "meteor", "meteor_detailed", "meteor_half",
  "crater", "craterLarge", "bones",
]);

export const MIN_OBSTACLE_DIAMETER = 0.6;
export const MIN_OBSTACLE_HEIGHT = 0.35;
export const DECOR_HEIGHT_EXCEPTIONS = new Set(["bones"]);

// ─── Baked shape table (collisionShapes.json) ────────────────────────────────
export interface ObbShapeEntry {
  type: "obb";
  halfX: number; // unscaled local half-extent along the template's own X
  halfZ: number; // unscaled local half-extent along the template's own Z
  // Local offset of the box's own center from the placement point (unscaled,
  // rotates WITH the piece — same convention as the halfX/halfZ axes). Almost
  // every structural asset is recentered symmetric about its placement point
  // (offset 0,0, so these fields are omitted/undefined in the baked table).
  // A few assets (see assetLoader.ts's PIVOT_RECENTER_ASSETS — currently just
  // corridor_wall) are authored flush against ONE edge of their Kenney
  // "staging cell" rather than centered on it; bake-collision-shapes.mjs
  // computes this offset the same way assetLoader.ts's recenterOnStagedPivot
  // does, so the baked collider stays aligned with the rendered mesh.
  centerX?: number;
  centerZ?: number;
}
export interface HullShapeEntry {
  type: "hull";
  verts: readonly [number, number][]; // unscaled local XZ, CCW, already recentered
  heightY: number; // unscaled local Y extent — used only for the height gate below
}
export type ShapeEntry = ObbShapeEntry | HullShapeEntry;
export type CollisionShapesTable = Readonly<Record<string, ShapeEntry>>;

// ─── Build ───────────────────────────────────────────────────────────────────

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

// Adds one wall_block* cell's 1x1 AABB — see collision-v2.md §2.2 ("никакого
// чтения меша", the fillet families round only the top edges, invisible in
// XZ). `tile` half-extent is tile_size/2 both axes (square grid cells).
function addWallCell(out: ConvexPoly[], x: number, z: number, tile: number, originX: number, originZ: number): void {
  const cx = x * tile + originX;
  const cz = z * tile + originZ;
  out.push(makeAabb(cx, cz, tile / 2, tile / 2));
}

function propDiameter(shape: ShapeEntry): number {
  if (shape.type === "obb") return Math.max(shape.halfX, shape.halfZ) * 2;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of shape.verts) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return Math.max(maxX - minX, maxZ - minZ);
}

function buildPropCollider(
  asset: string,
  x: number,
  z: number,
  rotDeg: number,
  scale: number,
  shapes: CollisionShapesTable
): ConvexPoly | null {
  const isStructural = STRUCTURAL_PROP_ASSETS.has(asset);
  const isNaturalDecor = NATURAL_DECOR_ASSETS.has(asset) && !DECOR_HEIGHT_EXCEPTIONS.has(asset);
  if (!isStructural && !isNaturalDecor) return null;

  const shape = shapes[asset];
  if (!shape) return null; // asset not in the baked table (e.g. bake not rerun yet) — degrade to "no collider" rather than throw

  const diameter = propDiameter(shape) * scale;
  if (diameter < MIN_OBSTACLE_DIAMETER) return null;
  if (isNaturalDecor) {
    const heightEntry = shape.type === "hull" ? shape.heightY : 0;
    if (heightEntry * scale < MIN_OBSTACLE_HEIGHT) return null;
  }

  const rotRad = degToRad(rotDeg);
  if (shape.type === "obb") {
    const cx = (shape.centerX ?? 0) * scale;
    const cz = (shape.centerZ ?? 0) * scale;
    const localVerts = [
      { x: cx - shape.halfX * scale, z: cz - shape.halfZ * scale },
      { x: cx + shape.halfX * scale, z: cz - shape.halfZ * scale },
      { x: cx + shape.halfX * scale, z: cz + shape.halfZ * scale },
      { x: cx - shape.halfX * scale, z: cz + shape.halfZ * scale },
    ];
    return transformLocalPoly(localVerts, rotRad, x, z);
  }
  const localVerts = shape.verts.map(([vx, vz]) => ({ x: vx * scale, z: vz * scale }));
  return transformLocalPoly(localVerts, rotRad, x, z);
}

// Builds every static collider for a map: wall_block* cells (from both
// rect_fills and cells, mirroring shared/heightfield.ts's own two loops) +
// qualifying props. Mirrors mapLoader.ts's placement math (world_pos = grid *
// tile_size + origin_offset — see .claude/rules/map-building.md) exactly so
// a collider always lines up with where the asset is actually rendered.
export function buildStaticColliders(map: MapJson, shapes: CollisionShapesTable): ConvexPoly[] {
  const tile = map.meta.tile_size;
  const [originX, , originZ] = map.meta.origin_offset;
  const out: ConvexPoly[] = [];

  for (const rect of map.rect_fills ?? []) {
    if (!isWallOnlyAsset(rect.asset)) continue;
    for (let x = rect.x_min; x <= rect.x_max; x++) {
      for (let z = rect.z_min; z <= rect.z_max; z++) addWallCell(out, x, z, tile, originX, originZ);
    }
  }
  for (const cell of map.cells ?? []) {
    if (!isWallOnlyAsset(cell.asset)) continue;
    addWallCell(out, cell.x, cell.z, tile, originX, originZ);
  }

  for (const prop of map.props ?? []) {
    const worldX = prop.x * tile + originX;
    const worldZ = prop.z * tile + originZ;
    const collider = buildPropCollider(prop.asset, worldX, worldZ, prop.rot ?? 0, prop.scale ?? 1, shapes);
    if (collider) out.push(collider);
  }

  return out;
}

// Re-export so callers building rot tables elsewhere don't need a second
// import just for normRot (kept for parity with heightfield.ts's own usage
// pattern — not currently consumed outside this module, but a natural
// extension point stays available without a signature change).
export { normRot };
