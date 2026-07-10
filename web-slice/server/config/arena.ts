// Server-side arena data: builds a Heightfield (shared math with the client,
// see src/shared/heightfield.ts) plus derived spawn/weapon-box points from a
// map JSON in public/maps/, so rocket-vs-terrain collision uses the exact
// same slope rules the player sees.
//
// Which map a given match ROOM plays is picked per-room, not fixed at module
// load: loadArena(name) is called once from server/rooms/MatchRoom.ts
// onCreate() with that room's `options.map` (itself forwarded from the
// creator's joinOrCreate() call — see src/net/netClient.ts and the lobby's
// map picker, src/lobby/main.ts). An invalid/missing/unknown name falls back
// to src/shared/activeMap.ts's ACTIVE_MAP, which is also what this file used
// to load unconditionally before per-room maps existed.
//
// Spawn points and weapon-box points are DERIVED from the map JSON (flat
// cells clear of the island's edges, spread out via farthest-point sampling
// — see server/spawn/autoSpawn.ts) rather than hand-picked per map. This is
// what closes out the `// TODO: read spawn points from the map JSON once the
// match room knows which map is active` note that used to live in
// rooms/MatchRoom.ts: hardcoded grid coords only made sense while exactly
// one map (arena_slice) ever loaded; ACTIVE_MAP switching to mars_base
// exposed that they don't generalize (wrong plateau height → spawns
// underground / mid-air).
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { ConvexPoly } from "../../src/shared/collision2d";
import { Heightfield, type MapJson } from "../../src/shared/heightfield";
import { ACTIVE_MAP } from "../../src/shared/activeMap";
import { buildStaticColliders, type CollisionShapesTable } from "../../src/shared/staticColliders";
import collisionShapesTable from "../../src/shared/collisionShapes.json";
import { deriveBoxGrid, deriveSpawnGrid, type GridPoint } from "../spawn/autoSpawn";

// Same baked table src/map/mapLoader.ts already imports client-side
// (produced by tools/bake-collision-shapes.mjs) — the server needs its own
// copy so thrown weapons can stick to buildings/props, not just heightfield
// terrain (2026-07-10 owner bug: dynamite flying through walls/structures —
// see server/weapons/dynamiteSim.ts sweepDynamiteSegment). Kart-vs-prop
// collision stays client-only (unrelated to this pass); this is purely a
// projectile concern.
const SHAPES_TABLE = collisionShapesTable as unknown as CollisionShapesTable;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAPS_DIR = path.join(__dirname, "../../public/maps");

// Same charset the client-side pickers validate against (src/main.ts ?map=
// parsing, vite.config.ts editorMapsFilePlugin's save endpoint) — kept as an
// independent literal rather than a shared import because this is server
// code and those are client/dev-tooling modules; drift here is low-risk
// since it's intentionally the same permissive "safe filename" shape, not a
// business rule that needs one canonical source.
const MAP_NAME_RE = /^[a-z0-9_-]+$/i;

export interface WorldPoint {
  x: number;
  z: number;
}

// Weapon-box world point, WITH an explicit Y (unlike WorldPoint, which is
// XZ-only — spawns always sit on the ground so their Y is looked up
// separately via groundHeightAt). Hand-authored box_points (map editor) are
// legitimately allowed to float in the air (bridge/second-floor placements
// are an intentional owner choice, not a mistake to correct), so a box's Y
// has to travel WITH the point instead of being re-derived from the terrain
// at spawn time — see loadArena's boxPoints construction below and
// MatchRoom.ts onCreate, which now just adds BOX_HOVER_HEIGHT_M to this Y
// instead of calling groundHeightAt(p) itself.
export interface BoxPoint {
  x: number;
  y: number;
  z: number;
}

export interface Arena {
  heightfield: Heightfield;
  spawnPoints: readonly WorldPoint[];
  boxPoints: readonly BoxPoint[];
  // Static XZ prop colliders (buildings/structures + tall natural decor —
  // src/shared/staticColliders.ts) for this arena's map. Currently only
  // consumed by server-side projectile sweeps (dynamiteSim.
  // sweepDynamiteSegment via MatchRoom.ts) — kart-vs-prop collision is
  // client-only and unrelated.
  colliders: readonly ConvexPoly[];
  // Ground height at any XZ point. spawnPoints/boxPoints are DERIVED from
  // findFlatSpawnCandidates (autoSpawn.ts), which only ever returns cells
  // clear of the island's edges, so this should always hit a real sample —
  // this fallback is defense-in-depth for the scenario that actually bit a
  // player: an old server process still holding a STALE Arena built from a
  // map that got redesigned/replaced underneath it (per-room arenas are
  // cached forever, see the `cache` map below — a redeploy that swaps the
  // map file without restarting the process would leave a running room on
  // spawn coordinates that used to be flat ground and now aren't). Falling
  // back to a flat 0 in that case teleports the respawning player's Y
  // straight through the actual (changed) terrain; instead this walks
  // outward from the queried point to the NEAREST walkable column and uses
  // its real height — same idea as the client's GameMap.findFallbackSpawn()
  // (src/map/mapLoader.ts), just anchored to the point being sampled
  // instead of the map's bounding-box center, since here we're recovering a
  // single Y value, not relocating the player's XZ.
  groundHeightAt: (p: WorldPoint) => number;
}

// Nearest-walkable-column height fallback for groundHeightAt — see the Arena
// doc above for why this exists (stale-arena / off-heightfield defense, not
// expected to trigger for spawn/box points on a live, correctly-loaded map).
// O(cells) linear scan: only runs on the rare null-sample path, and arenas
// top out at a few thousand cells, so this is not a hot-path concern.
function nearestWalkableHeight(heightfield: Heightfield, p: WorldPoint): number {
  const coords = heightfield.listCellCoords();
  if (coords.length === 0) return 0; // no walkable cell exists at all — nothing better to fall back to
  let best = coords[0];
  let bestDistSq = Infinity;
  for (const c of coords) {
    const world = heightfield.gridToWorld(c.x, c.z);
    const distSq = (world.x - p.x) ** 2 + (world.z - p.z) ** 2;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      best = c;
    }
  }
  const world = heightfield.gridToWorld(best.x, best.z);
  return heightfield.sample(world.x, world.z) ?? 0;
}

function mapPathFor(name: string): string {
  return path.join(MAPS_DIR, `${name}.json`);
}

function resolveMapName(name: string | undefined): string {
  if (name && MAP_NAME_RE.test(name) && existsSync(mapPathFor(name))) return name;
  if (name) console.warn(`[arena] unknown/invalid map "${name}" — falling back to "${ACTIVE_MAP}"`);
  return ACTIVE_MAP;
}

// One Arena per distinct (resolved) map name, reused for every room that
// plays it AS LONG AS the map file on disk hasn't changed since — the
// heightfield + derived spawn/box grids are pure functions of the map JSON,
// no reason to recompute per room for an unchanged file. Keyed by the file's
// own mtimeMs (not just the name) so a map that gets overwritten in place —
// e.g. the editor's "Drive" button POSTs a fresh editor_drive.json every time
// the owner tweaks a layout, see vite.config.ts editorMapsFilePlugin — is
// detected and reloaded instead of silently serving the stale Arena an
// earlier room already built for that name. This was the actual root cause
// of "placed boxes in the editor, hit Drive, no boxes in game": the SAME
// server process had loaded that map name once already (e.g. a previous
// Drive session, or another room), cached it forever, and kept returning
// that first snapshot's box_points/heightfield no matter how many times the
// file changed underneath it — only a full server restart ever picked up
// the edit. statSync is a single cheap syscall per loadArena() call (room
// creation, not per-tick), so checking it unconditionally costs nothing
// worth avoiding.
const cache = new Map<string, { arena: Arena; mtimeMs: number }>();

export function loadArena(name?: string): Arena {
  const safeName = resolveMapName(name);
  const mapPath = mapPathFor(safeName);
  const mtimeMs = statSync(mapPath).mtimeMs;
  const cached = cache.get(safeName);
  if (cached && cached.mtimeMs === mtimeMs) return cached.arena;

  const mapJson = JSON.parse(readFileSync(mapPath, "utf-8")) as MapJson;
  const heightfield = Heightfield.fromMapJson(mapJson);

  // MIN_KART_SPAWNS in the reference (spawn_manager.gd) is 4; we ask for 6 —
  // deriveSpawnGrid returns fewer only if the map genuinely doesn't have
  // that many flat, edge-clear cells (see autoSpawn.ts doc).
  const spawnGrid: readonly GridPoint[] = deriveSpawnGrid(mapJson, 6);

  const toWorldPoints = (grid: readonly GridPoint[]): WorldPoint[] =>
    grid.map(([gx, gz]) => heightfield.gridToWorld(gx, gz));

  // spawn uses top-layer sample() intentionally; multi-layer spawn selection is out of scope
  const groundHeightAt = (p: WorldPoint): number =>
    heightfield.sample(p.x, p.z) ?? nearestWalkableHeight(heightfield, p);

  // Hand-authored box_points (map editor, "Маркеры" category) win outright
  // over the auto-derive when present — the owner placing boxes by hand is
  // explicitly opting that map OUT of the farthest-point-sampling heuristic.
  // y_LEVEL IS carried through here (BoxPoint.y, above) unlike the old
  // WorldPoint-only shape: the owner may legitimately place a box in the air
  // (a bridge deck, a second-floor platform) and that placement must be
  // trusted as-authored, NOT snapped down to whatever the terrain happens to
  // read at that XZ (a box on a bridge over a canyon would otherwise fall to
  // the canyon floor — see MatchRoom.ts onCreate, which used to re-derive Y
  // via groundHeightAt and silently discarded this). Absent/empty falls back
  // to the old auto-derive so every pre-existing map keeps loading
  // unchanged; the auto path has no authored Y to trust, so it keeps using
  // groundHeightAt exactly like before.
  const boxPoints: BoxPoint[] =
    mapJson.box_points && mapJson.box_points.length > 0
      ? mapJson.box_points.map(p => {
          const world = heightfield.gridToWorld(p.x, p.z);
          return { x: world.x, y: p.y_level * mapJson.meta.level_height, z: world.z };
        })
      : deriveBoxGrid(mapJson, 6, spawnGrid).map(([gx, gz]) => {
          // excludes spawn cells so a box never stacks on a spawn point
          const world = heightfield.gridToWorld(gx, gz);
          return { x: world.x, y: groundHeightAt(world), z: world.z };
        });

  const arena: Arena = {
    heightfield,
    spawnPoints: toWorldPoints(spawnGrid),
    boxPoints,
    groundHeightAt,
    colliders: buildStaticColliders(mapJson, SHAPES_TABLE),
  };
  cache.set(safeName, { arena, mtimeMs });
  return arena;
}
