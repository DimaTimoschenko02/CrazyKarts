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
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Heightfield, type MapJson } from "../../src/shared/heightfield";
import { ACTIVE_MAP } from "../../src/shared/activeMap";
import { deriveBoxGrid, deriveSpawnGrid, type GridPoint } from "../spawn/autoSpawn";

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

export interface Arena {
  heightfield: Heightfield;
  spawnPoints: readonly WorldPoint[];
  boxPoints: readonly WorldPoint[];
  // Ground height at any XZ point (falls back to 0 if somehow off the
  // heightfield — shouldn't happen for the hand-picked spawn/box points
  // above). Used both for box hover placement and for setting a respawned
  // player's y before their client resumes reporting its own heightfield-
  // sampled pose.
  groundHeightAt: (p: WorldPoint) => number;
}

function mapPathFor(name: string): string {
  return path.join(MAPS_DIR, `${name}.json`);
}

function resolveMapName(name: string | undefined): string {
  if (name && MAP_NAME_RE.test(name) && existsSync(mapPathFor(name))) return name;
  if (name) console.warn(`[arena] unknown/invalid map "${name}" — falling back to "${ACTIVE_MAP}"`);
  return ACTIVE_MAP;
}

// One Arena per distinct (resolved) map name, built once and reused for
// every room that plays it — the heightfield + derived spawn/box grids are
// pure functions of the map JSON, no reason to recompute per room.
const cache = new Map<string, Arena>();

export function loadArena(name?: string): Arena {
  const safeName = resolveMapName(name);
  const cached = cache.get(safeName);
  if (cached) return cached;

  const mapJson = JSON.parse(readFileSync(mapPathFor(safeName), "utf-8")) as MapJson;
  const heightfield = Heightfield.fromMapJson(mapJson);

  // MIN_KART_SPAWNS in the reference (spawn_manager.gd) is 4; we ask for 6 —
  // deriveSpawnGrid returns fewer only if the map genuinely doesn't have
  // that many flat, edge-clear cells (see autoSpawn.ts doc).
  const spawnGrid: readonly GridPoint[] = deriveSpawnGrid(mapJson, 6);
  // Excludes the spawn cells so a box never stacks exactly on a spawn point.
  const boxGrid: readonly GridPoint[] = deriveBoxGrid(mapJson, 6, spawnGrid);

  const toWorldPoints = (grid: readonly GridPoint[]): WorldPoint[] =>
    grid.map(([gx, gz]) => heightfield.gridToWorld(gx, gz));

  const arena: Arena = {
    heightfield,
    spawnPoints: toWorldPoints(spawnGrid),
    boxPoints: toWorldPoints(boxGrid),
    groundHeightAt: p => heightfield.sample(p.x, p.z) ?? 0,
  };
  cache.set(safeName, arena);
  return arena;
}
