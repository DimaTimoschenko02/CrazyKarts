// JSON grid-map loader — three.js port of scripts/map_loader.gd, following
// .claude/rules/map-building.md.
//
// The loader "dumbly places" assets — no auto-sides / auto-corner magic (that
// was deliberately removed in the Godot version after it caused more bugs
// than it solved). On top of placement it delegates the HEIGHTFIELD math to
// ../shared/heightfield.ts (extracted in the P3 combat slice so the Colyseus
// match server can sample the exact same terrain for rocket collision without
// duplicating the ascent tables — see server/config/arena.ts).
//
// Collision v2 (design/notes/collision-v2.md): static collision (wall_block*
// cells + structural/natural-decor props) is now SAT convex polygons built by
// shared/staticColliders.ts from the committed shared/collisionShapes.json
// table, NOT the old per-prop collision circle. See kart/kart.ts step 8 for
// the SAT resolution loop that consumes getStaticColliders() below.
import * as THREE from "three";
import type { AssetLibrary } from "./assetLoader";
import { Heightfield, TWO_CELL_ASSETS, longAxis, type CellDef, type MapJson, type PropDef } from "../shared/heightfield";
import { buildStaticColliders, type CollisionShapesTable } from "../shared/staticColliders";
import type { ConvexPoly } from "../shared/collision2d";
import collisionShapesTable from "../shared/collisionShapes.json";

export type { MapJson };

const SHAPES_TABLE = collisionShapesTable as unknown as CollisionShapesTable;

export class GameMap {
  readonly root = new THREE.Group();
  private heightfield = new Heightfield();
  private tile = 1;
  private levelHeight = 0.5;
  private origin = new THREE.Vector3();
  private staticColliders: ConvexPoly[] = [];

  // Static SAT collision polygons — wall_block* cells (AABB) + qualifying
  // props (structural OBB / natural-decor hull), see shared/staticColliders.ts.
  // Consumed by kart/kart.ts step 8 (resolveKartVsStatic), NOT by the old
  // circle-push path — resolveKartPush (physics/kartCollision.ts) is now
  // kart-vs-kart ONLY.
  getStaticColliders(): readonly ConvexPoly[] {
    return this.staticColliders;
  }

  // Ground height at a world XZ point, or null when there is no cell there
  // (off the map edge → the mover treats it as a wall).
  sampleHeight(wx: number, wz: number): number | null {
    return this.heightfield.sample(wx, wz);
  }

  // True if EITHER a walkable cell OR a wall_block* cell was authored here —
  // see shared/heightfield.ts Heightfield.hasColumn doc. Used by
  // physics/terrainWall.ts to tell a genuine off-map edge apart from a
  // wall_block hole (which the SAT static-poly path above already owns).
  hasColumn(wx: number, wz: number): boolean {
    return this.heightfield.hasColumn(wx, wz);
  }

  // Fallback spawn point for when the authored SPAWN constant (main.ts) lands
  // off this particular map (e.g. a hand-built or server-loaded map that
  // never got a cell at the default coordinates) — the kart would otherwise
  // free-fall through the "off map = wall" null sample. Picks the walkable
  // cell nearest the map's own bounding-box center (not nearest to the
  // missed spawn point — a small/offset map may have no cells anywhere near
  // (0, *, 6.5) at all), so the kart always lands somewhere inside the
  // authored layout. Returns null only if the map has no walkable cells at
  // all (e.g. a pure decoration/no-terrain map, which shouldn't happen but
  // isn't this method's job to validate).
  findFallbackSpawn(): { x: number; y: number; z: number } | null {
    const coords = this.heightfield.listCellCoords();
    if (coords.length === 0) return null;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const c of coords) {
      minX = Math.min(minX, c.x); maxX = Math.max(maxX, c.x);
      minZ = Math.min(minZ, c.z); maxZ = Math.max(maxZ, c.z);
    }
    const centerX = (minX + maxX) / 2;
    const centerZ = (minZ + maxZ) / 2;
    let best = coords[0];
    let bestDistSq = Infinity;
    for (const c of coords) {
      const distSq = (c.x - centerX) ** 2 + (c.z - centerZ) ** 2;
      if (distSq < bestDistSq) { bestDistSq = distSq; best = c; }
    }
    const world = this.heightfield.gridToWorld(best.x, best.z);
    const y = this.heightfield.sample(world.x, world.z) ?? 0;
    return { x: world.x, y, z: world.z };
  }

  private place(lib: AssetLibrary, def: CellDef): void {
    const template = lib.get(def.asset);
    if (!template) {
      console.warn("[map] unknown asset:", def.asset);
      return;
    }
    const rot = ((Math.round(def.rot ?? 0) % 360) + 360) % 360;
    const inst = template.clone();
    inst.position.set(
      def.x * this.tile + this.origin.x,
      def.y_level * this.levelHeight + this.origin.y,
      def.z * this.tile + this.origin.z
    );
    inst.rotation.y = THREE.MathUtils.degToRad(rot);
    // 2-cell ramps sit at +0.5 along their long axis so their 2-tile footprint
    // lands on the clicked cell + the next one, instead of straddling the two
    // neighbours' halves (see TWO_CELL_ASSETS). Matches the editor's placement.
    if (TWO_CELL_ASSETS.has(def.asset)) {
      const [dx, dz] = longAxis(rot);
      inst.position.x += dx * 0.5 * this.tile;
      inst.position.z += dz * 0.5 * this.tile;
    }
    // Mirror = reflect across local X before the rotation (three.js applies
    // scale before rotation in its TRS matrix, so setting scale.x here gives
    // reflect-then-rotate). See CellDef.mirror — visual only. three.js flips
    // the render winding for the resulting negative-determinant matrix, so
    // normals/lighting stay correct without a DoubleSide hack.
    if (def.mirror) inst.scale.x = -1;
    this.root.add(inst);
  }

  private placeProp(lib: AssetLibrary, def: PropDef): void {
    const template = lib.get(def.asset);
    if (!template) {
      console.warn("[map] unknown prop asset:", def.asset);
      return;
    }
    const inst = template.clone();
    inst.position.set(
      def.x * this.tile + this.origin.x,
      def.y_level * this.levelHeight + this.origin.y,
      def.z * this.tile + this.origin.z
    );
    inst.rotation.y = THREE.MathUtils.degToRad(def.rot ?? 0);
    inst.scale.setScalar(def.scale ?? 1);
    this.root.add(inst);
    // Collision shape (if any) is built once for the WHOLE map from the raw
    // MapJson in fromJson() below (shared/staticColliders.ts) — not per-prop
    // here, since that module needs the world_pos/rot/scale math anyway and
    // this is purely the visual placement path.
  }

  static async load(url: string, lib: AssetLibrary): Promise<GameMap> {
    const data = (await (await fetch(url)).json()) as MapJson;
    return GameMap.fromJson(data, lib);
  }

  static fromJson(data: MapJson, lib: AssetLibrary): GameMap {
    const map = new GameMap();
    map.tile = data.meta.tile_size;
    map.levelHeight = data.meta.level_height;
    map.origin.fromArray(data.meta.origin_offset);
    map.heightfield = Heightfield.fromMapJson(data);
    map.staticColliders = buildStaticColliders(data, SHAPES_TABLE);

    for (const rect of data.rect_fills ?? []) {
      for (let x = rect.x_min; x <= rect.x_max; x++) {
        for (let z = rect.z_min; z <= rect.z_max; z++) {
          map.place(lib, { asset: rect.asset, x, z, y_level: rect.y_level, rot: rect.rot });
        }
      }
    }
    for (const cell of data.cells ?? []) map.place(lib, cell);
    for (const prop of data.props ?? []) map.placeProp(lib, prop);
    return map;
  }
}
