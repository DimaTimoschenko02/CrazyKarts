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

// Buildings/rockets/heavy machinery: UNCONDITIONALLY solid, always get a
// collision circle sized from their footprint AABB regardless of raw
// dimensions. Curated at the FAMILY level (not derived from measured size —
// see NATURAL_DECOR_ASSETS below for the size-driven half of this module),
// because plenty of walk-through Tech/Track and Structures pieces (platforms,
// pipes, rails, monorails, desks/stairs/supports/weapons) have a comparable
// or even larger footprint than these but read as track-level decor a kart
// drives over, not a wall — that curation is a deliberate game-designer call,
// unchanged by the P1.6 prop-collision rework (owner report, 2026-07-08) and
// out of this pass's scope. See .claude/rules/map-building.md "Props".
const STRUCTURAL_PROP_ASSETS = new Set([
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

// Natural-terrain decor family (rocks/crystals/meteors/craters/bones) —
// collision here is SIZE-DERIVED instead of a hand-maintained include/
// exclude list. Owner report 2026-07-08: adding a rock and a meteor produced
// inconsistent collision (some rocks solid, some not; a "micro" rock got a
// whole-cell-sized circle) because the old LARGE_PROP_ASSETS set was picked
// by eyeballing names, not measuring geometry — it had rock_largeA in but
// rock_crystalsLargeA/B's near-identical-size sibling rock_largeB OUT, and
// excluded the entire meteor family even though meteor/meteor_detailed are
// the same scale as rock_largeA.
//
// Actual measured footprint (max(size.x,size.z)) / height (size.y), from
// the real GLBs (tools/_tmp_glb_bbox2.ts, run once during this fix, numbers
// recorded here since the script itself was a throwaway):
//   rock                 diam=0.851 h=0.300  -> decor (below height floor)
//   rocks_smallA         diam=0.937 h=0.105  -> decor (flat pebble scatter)
//   rocks_smallB         diam=0.729 h=0.186  -> decor (flat pebble scatter)
//   rock_crystals        diam=0.851 h=0.337  -> decor (below height floor)
//   rock_largeA          diam=0.919 h=0.500  -> SOLID
//   rock_largeB          diam=0.939 h=0.500  -> SOLID (bug fix: was missing)
//   rock_crystalsLargeA  diam=0.919 h=0.541  -> SOLID
//   rock_crystalsLargeB  diam=0.939 h=0.550  -> SOLID
//   meteor               diam=0.866 h=0.735  -> SOLID (new)
//   meteor_detailed      diam=0.866 h=0.735  -> SOLID (new)
//   meteor_half          diam=0.866 h=0.367  -> SOLID (new)
//   crater               diam=0.826 h=0.118  -> decor (flat ground decal)
//   craterLarge          diam=0.886 h=0.120  -> decor (flat ground decal)
//   bones                diam=0.861 h=0.442  -> decor, EXPLICIT exception
//     (clears both thresholds on paper — a scattered bone PILE's bbox is
//     tall because one bone juts up, but the pile has almost no actual
//     blocking volume, same design call as crater/craterLarge — see
//     DECOR_HEIGHT_EXCEPTIONS below)
const NATURAL_DECOR_ASSETS = new Set([
  "rock", "rocks_smallA", "rocks_smallB", "rock_crystals",
  "rock_largeA", "rock_largeB", "rock_crystalsLargeA", "rock_crystalsLargeB",
  "meteor", "meteor_detailed", "meteor_half",
  "crater", "craterLarge", "bones",
]);

// Below this scaled footprint diameter, ANY prop (structural or natural
// decor) is too small to plausibly block a kart's body regardless of shape —
// the general "small object → collision sized or none" principle from the
// owner's bug report. Comfortably below every structural asset's real size
// (smallest is machine_barrel at 0.646m) and above every genuinely tiny
// decor item Space Kit ships (furniture/weapons/characters top out around
// 0.5m — see tools/_tmp_glb_bbox.ts sweep run during this fix).
const MIN_OBSTACLE_DIAMETER = 0.6;

// Below this scaled height, a NATURAL_DECOR_ASSETS prop stays walk-through
// even if its footprint clears MIN_OBSTACLE_DIAMETER — a wide-but-flat prop
// (crater, a loose pebble scatter) doesn't sit tall enough to actually
// obstruct a kart's undercarriage. Only applied to the natural-decor family:
// STRUCTURAL_PROP_ASSETS are always solid once past the diameter floor (a
// building or rocket hull is never "too flat to block").
const MIN_OBSTACLE_HEIGHT = 0.35;

// Explicit override — see NATURAL_DECOR_ASSETS "bones" note above.
const DECOR_HEIGHT_EXCEPTIONS = new Set(["bones"]);

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

    const isStructural = STRUCTURAL_PROP_ASSETS.has(def.asset);
    const isNaturalDecor = NATURAL_DECOR_ASSETS.has(def.asset) && !DECOR_HEIGHT_EXCEPTIONS.has(def.asset);
    if (isStructural || isNaturalDecor) {
      // Radius from the UNSCALED template's own footprint AABB (rotation
      // around Y doesn't change the circle enclosing a centered footprint,
      // so def.rot needs no compensation here — only def.scale does).
      const box = new THREE.Box3().setFromObject(template);
      const size = box.getSize(new THREE.Vector3());
      const scale = def.scale ?? 1;
      const scaledDiameter = Math.max(size.x, size.z) * scale;
      const scaledHeight = size.y * scale;
      // Size-driven gate (owner report 2026-07-08 — see NATURAL_DECOR_ASSETS
      // doc above): too-small footprint never gets an obstacle regardless of
      // family; the natural-decor family ALSO needs real height (not just a
      // wide flat footprint) to count as blocking mass.
      const passesDiameter = scaledDiameter >= MIN_OBSTACLE_DIAMETER;
      const passesHeight = isStructural || scaledHeight >= MIN_OBSTACLE_HEIGHT;
      if (passesDiameter && passesHeight) {
        const radius = (scaledDiameter / 2) * PROP_COLLISION_SHRINK;
        this.staticObstacles.push({ x: inst.position.x, z: inst.position.z, alive: true, radius });
      }
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
