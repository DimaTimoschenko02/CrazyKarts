// JSON grid-map loader — three.js port of scripts/map_loader.gd, following
// .claude/rules/map-building.md.
//
// The loader "dumbly places" assets — no auto-sides / auto-corner magic (that
// was deliberately removed in the Godot version after it caused more bugs
// than it solved). On top of placement it delegates the HEIGHTFIELD math to
// ../shared/heightfield.ts (extracted in the P3 combat slice so the Colyseus
// match server can sample the exact same terrain for rocket collision without
// duplicating the ascent tables — see server/config/arena.ts).
import * as THREE from "three";
import type { AssetLibrary } from "./assetLoader";
import { Heightfield, TWO_CELL_ASSETS, longAxis, type CellDef, type MapJson, type PropDef } from "../shared/heightfield";
import type { KartObstacle } from "../physics/kartCollision";

export type { MapJson };

// A static (never-moving, always-alive) collision circle contributed by a
// map prop — see LARGE_PROP_ASSETS below. Superset of KartObstacle so it can
// be concatenated straight into the `obstacles` array Kart.update() already
// accepts from net/remoteKarts.ts getObstacles() (see main.ts wiring).
export interface StaticObstacle extends KartObstacle {
  radius: number;
}

// Which prop asset names get a physical collision circle — everything else
// (rock, rocks_smallA/B, rock_crystals, and all "small decor" from the full
// Space Kit added in shared/mapAssets.ts — barrels, chimneys, craters,
// meteors, astronauts...) is pure decoration the kart drives straight
// through. See .claude/rules/map-building.md "Props" section for the asset
// catalog this mirrors. Keep this in sync if new big rock/crystal/building
// props are added to the Space Kit prop set.
//
// Full-kit additions included here: buildings (corridor/hangar/structure/
// gate — solid rooms/walls) and rockets/craft (large solid hulls) get
// collision unconditionally; from Structures only the visibly large solid
// pieces (generators, big satellite dish, turrets) do — desks/stairs/
// supports/weapons stay walk-through, matching a small/thin-decor call.
// Tech/Track (pipe/platform/monorail/rail) is left walk-through everywhere:
// it reads as track/ground-level decor a kart drives over, not a wall.
const LARGE_PROP_ASSETS = new Set([
  "rock_largeA", "rock_crystalsLargeA", "rock_crystalsLargeB",
  // Buildings
  "corridor", "corridor_corner", "corridor_cornerRound", "corridor_cornerRoundWindow",
  "corridor_cross", "corridor_detailed", "corridor_end", "corridor_open", "corridor_roof",
  "corridor_split", "corridor_wall", "corridor_wallCorner", "corridor_window", "corridor_windowClosed",
  "hangar_largeA", "hangar_largeB", "hangar_roundA", "hangar_roundB", "hangar_roundGlass",
  "hangar_smallA", "hangar_smallB",
  "structure", "structure_closed", "structure_detailed", "structure_diagonal",
  "gate_complex", "gate_simple",
  // Rockets / craft
  "craft_cargoA", "craft_cargoB", "craft_miner",
  "craft_speederA", "craft_speederB", "craft_speederC", "craft_speederD",
  "rocket_baseA", "rocket_baseB", "rocket_finsA", "rocket_finsB",
  "rocket_fuelA", "rocket_fuelB", "rocket_sidesA", "rocket_sidesB",
  "rocket_topA", "rocket_topB",
  // Structures — only the visibly large solid pieces
  "machine_barrel", "machine_barrelLarge", "machine_generator", "machine_generatorLarge",
  "satelliteDish_large", "turret_single", "turret_double",
  // Decor — vehicle-sized only
  "rover",
]);

// Large props get a collision circle shrunk from their raw footprint AABB by
// this factor — arcade standard so grazing the rock's rough/uneven visual
// edge doesn't get treated as a hard hit (mirrors why KART_COLLISION_RADIUS
// itself is smaller than the kart mesh's own footprint).
const PROP_COLLISION_SHRINK = 0.8;

export class GameMap {
  readonly root = new THREE.Group();
  private heightfield = new Heightfield();
  private tile = 1;
  private levelHeight = 0.5;
  private origin = new THREE.Vector3();
  private staticObstacles: StaticObstacle[] = [];

  // Static collision circles contributed by large decorative props (see
  // LARGE_PROP_ASSETS) — concatenate with net.getObstacles() before passing
  // to Kart.update() (see main.ts).
  getStaticObstacles(): readonly StaticObstacle[] {
    return this.staticObstacles;
  }

  // Ground height at a world XZ point, or null when there is no cell there
  // (off the map edge → the mover treats it as a wall).
  sampleHeight(wx: number, wz: number): number | null {
    return this.heightfield.sample(wx, wz);
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

    if (LARGE_PROP_ASSETS.has(def.asset)) {
      // Radius from the UNSCALED template's own footprint AABB (rotation
      // around Y doesn't change the circle enclosing a centered footprint,
      // so def.rot needs no compensation here — only def.scale does).
      const box = new THREE.Box3().setFromObject(template);
      const size = box.getSize(new THREE.Vector3());
      const scale = def.scale ?? 1;
      const radius = (Math.max(size.x, size.z) / 2) * scale * PROP_COLLISION_SHRINK;
      this.staticObstacles.push({ x: inst.position.x, z: inst.position.z, alive: true, radius });
    }
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
