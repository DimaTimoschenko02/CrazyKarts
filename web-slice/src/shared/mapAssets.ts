// Single source of truth for "which Space Kit assets does the map editor
// palette offer, and which of those does the game need to preload". Both
// src/editor/main.ts (palette buttons) and src/main.ts (MAP_ASSETS preload
// list) import from here — before this module existed the two kept their
// own copies of the same list and could silently drift (see the "Keep in
// sync with the editor palette" comment this module replaces).
//
// Categories with isProp=true place as PropRecord (float xz, no grid snap);
// isProp=false categories place as CellRecord (grid-snapped, y_level stack).
// Every asset added here that isn't in PROCEDURAL_ASSETS (assetLoader.ts)
// must exist as public/assets/space-kit/<asset>.glb — see .claude/rules/
// map-building.md for the pivot-fix story (assetLoader.ts recenterXZ
// handles ALL of these generically, verified against the raw glTF node
// translations for the full 153-asset Kenney catalog — see git history for
// the verification script, no per-asset preprocessing needed).
export interface PaletteItem { asset: string; label: string }
export interface PaletteCategory { category: string; isProp: boolean; items: PaletteItem[] }

// ── Kenney "3D Road Tiles" — the current map-building pack ────────────────
// (owner decision 2026-07-08: space-kit's hand-stitched side/corner edges
// kept breaking collision; road tiles bake slopes/curves INTO each 3×3m
// tile). All 302 tiles are offered — the owner wants to browse everything —
// grouped by the AUTO-classification from tools/bake-road-tiles.mjs (see
// docs/roads-catalog.md). Labels are generated from geometry (slope
// direction/rise, road edge connectivity), not hand-written; refine per-tile
// as real usage reveals what matters. Tiles are 3m per cell with a ~1.1m
// level height — maps built from them use meta tile_size=3/level_height=1.1
// (the editor has a grid preset for this), NOT space-kit's 1/0.5.
import roadTilesCatalog from "./roadTilesCatalog.json";

interface RoadTileEntry { category: string; label: string }

const ROAD_CATEGORY_ORDER = [
  "Roads: Straight", "Roads: Corner", "Roads: Cross & T", "Roads: End & Detail",
  "Slopes", "Slopes: Curved & Corner", "Bridges", "Water", "Ground", "Misc",
];

const ROAD_CATEGORIES: PaletteCategory[] = ROAD_CATEGORY_ORDER.map(category => ({
  category,
  isProp: false,
  items: Object.entries(roadTilesCatalog as Record<string, RoadTileEntry>)
    .filter(([, e]) => e.category === category)
    .map(([asset, e]) => ({ asset, label: e.label })),
})).filter(cat => cat.items.length > 0);

// ── Legacy: Kenney Space Kit ───────────────────────────────────────────────
// Superseded for terrain/roads by the road-tiles pack above but NOT removed:
// every shipped map (arena_slice, mars_base, map_v1/v2…) is built from these,
// and the space-kit PROPS (rocks, buildings, rockets…) remain the only decor
// set — they place at float coords in any grid, road-tile maps included.
const LEGACY_PALETTE: PaletteCategory[] = [
  { category: "Terrain", isProp: false, items: [
    { asset: "terrain", label: "Terrain" },
    { asset: "terrain_ramp", label: "Ramp" },
    { asset: "terrain_rampLarge", label: "Ramp Large (2x)" },
    { asset: "terrain_rampLarge_detailed", label: "Ramp Large Detailed (2x)" },
  ] },
  { category: "Roads", isProp: false, items: [
    { asset: "terrain_roadStraight", label: "Road Straight" },
    { asset: "terrain_roadCorner", label: "Road Corner" },
    { asset: "terrain_roadCross", label: "Road Cross" },
    { asset: "terrain_roadEnd", label: "Road End" },
    { asset: "terrain_roadSplit", label: "Road Split" },
  ] },
  { category: "Edges", isProp: false, items: [
    { asset: "terrain_side", label: "Side" },
    { asset: "terrain_sideCorner", label: "Side Corner" },
    { asset: "terrain_sideCornerInner", label: "Side Corner Inner" },
    { asset: "terrain_sideEnd", label: "Side End" },
    { asset: "terrain_sideCliff", label: "Side Cliff" },
  ] },
  { category: "Walls", isProp: false, items: [
    { asset: "wall_block", label: "Wall Block" },
    { asset: "wall_block_round", label: "Wall Round" },
    { asset: "wall_block_corner", label: "Wall Corner" },
    // Same cube visual as wall_block but DRIVABLE on top (mountains/plateaus
    // out of stacked cubes) — see assetLoader PROCEDURAL_ASSETS doc.
    { asset: "ground_block", label: "Ground Block (проезжаемый)" },
  ] },
  { category: "Props", isProp: true, items: [
    { asset: "rock", label: "Rock" },
    { asset: "rock_largeA", label: "Rock Large A" },
    { asset: "rock_largeB", label: "Rock Large B" },
    { asset: "rock_crystals", label: "Rock Crystals" },
    { asset: "rock_crystalsLargeA", label: "Rock Crystals Large A" },
    { asset: "rock_crystalsLargeB", label: "Rock Crystals Large B" },
    { asset: "rocks_smallA", label: "Rocks Small A" },
    { asset: "rocks_smallB", label: "Rocks Small B" },
  ] },
  // ── Full Kenney Space Kit — added to give the map editor building blocks
  // beyond the P1 terrain/rock set. All placed as free-float props (no
  // grid-tile connector logic — corridor/pipe/platform/monorail pieces DO
  // look tile-sized, but wiring up their rotation-aware auto-connections is
  // out of scope here; a map author can still hand-place+rotate them like
  // any other prop). Large solid ones get collision via LARGE_PROP_ASSETS
  // in map/mapLoader.ts — see the comment there for which of these qualify.
  { category: "Buildings", isProp: true, items: [
    { asset: "corridor", label: "Corridor" },
    { asset: "corridor_corner", label: "Corridor Corner" },
    { asset: "corridor_cornerRound", label: "Corridor Corner Round" },
    { asset: "corridor_cornerRoundWindow", label: "Corridor Corner Round Window" },
    { asset: "corridor_cross", label: "Corridor Cross" },
    { asset: "corridor_detailed", label: "Corridor Detailed" },
    { asset: "corridor_end", label: "Corridor End" },
    { asset: "corridor_open", label: "Corridor Open" },
    { asset: "corridor_roof", label: "Corridor Roof" },
    { asset: "corridor_split", label: "Corridor Split" },
    { asset: "corridor_wall", label: "Corridor Wall" },
    { asset: "corridor_wallCorner", label: "Corridor Wall Corner" },
    { asset: "corridor_window", label: "Corridor Window" },
    { asset: "corridor_windowClosed", label: "Corridor Window Closed" },
    { asset: "hangar_largeA", label: "Hangar Large A" },
    { asset: "hangar_largeB", label: "Hangar Large B" },
    { asset: "hangar_roundA", label: "Hangar Round A" },
    { asset: "hangar_roundB", label: "Hangar Round B" },
    { asset: "hangar_roundGlass", label: "Hangar Round Glass" },
    { asset: "hangar_smallA", label: "Hangar Small A" },
    { asset: "hangar_smallB", label: "Hangar Small B" },
    { asset: "structure", label: "Structure" },
    { asset: "structure_closed", label: "Structure Closed" },
    { asset: "structure_detailed", label: "Structure Detailed" },
    { asset: "structure_diagonal", label: "Structure Diagonal" },
    { asset: "gate_complex", label: "Gate Complex" },
    { asset: "gate_simple", label: "Gate Simple" },
  ] },
  { category: "Rockets", isProp: true, items: [
    { asset: "craft_cargoA", label: "Craft Cargo A" },
    { asset: "craft_cargoB", label: "Craft Cargo B" },
    { asset: "craft_miner", label: "Craft Miner" },
    { asset: "craft_speederA", label: "Craft Speeder A" },
    { asset: "craft_speederB", label: "Craft Speeder B" },
    { asset: "craft_speederC", label: "Craft Speeder C" },
    { asset: "craft_speederD", label: "Craft Speeder D" },
    { asset: "rocket_baseA", label: "Rocket Base A" },
    { asset: "rocket_baseB", label: "Rocket Base B" },
    { asset: "rocket_finsA", label: "Rocket Fins A" },
    { asset: "rocket_finsB", label: "Rocket Fins B" },
    { asset: "rocket_fuelA", label: "Rocket Fuel A" },
    { asset: "rocket_fuelB", label: "Rocket Fuel B" },
    { asset: "rocket_sidesA", label: "Rocket Sides A" },
    { asset: "rocket_sidesB", label: "Rocket Sides B" },
    { asset: "rocket_topA", label: "Rocket Top A" },
    { asset: "rocket_topB", label: "Rocket Top B" },
  ] },
  { category: "Structures", isProp: true, items: [
    { asset: "machine_barrel", label: "Machine Barrel" },
    { asset: "machine_barrelLarge", label: "Machine Barrel Large" },
    { asset: "machine_generator", label: "Machine Generator" },
    { asset: "machine_generatorLarge", label: "Machine Generator Large" },
    { asset: "machine_wireless", label: "Machine Wireless" },
    { asset: "machine_wirelessCable", label: "Machine Wireless Cable" },
    { asset: "turret_single", label: "Turret Single" },
    { asset: "turret_double", label: "Turret Double" },
    { asset: "satelliteDish", label: "Satellite Dish" },
    { asset: "satelliteDish_detailed", label: "Satellite Dish Detailed" },
    { asset: "satelliteDish_large", label: "Satellite Dish Large" },
    { asset: "stairs", label: "Stairs" },
    { asset: "stairs_corner", label: "Stairs Corner" },
    { asset: "stairs_short", label: "Stairs Short" },
    { asset: "supports_high", label: "Supports High" },
    { asset: "supports_low", label: "Supports Low" },
    { asset: "desk_chair", label: "Desk Chair" },
    { asset: "desk_chairArms", label: "Desk Chair Arms" },
    { asset: "desk_chairStool", label: "Desk Chair Stool" },
    { asset: "desk_computer", label: "Desk Computer" },
    { asset: "desk_computerCorner", label: "Desk Computer Corner" },
    { asset: "desk_computerScreen", label: "Desk Computer Screen" },
    { asset: "weapon_gun", label: "Weapon Gun" },
    { asset: "weapon_rifle", label: "Weapon Rifle" },
  ] },
  { category: "Tech / Track", isProp: true, items: [
    { asset: "pipe_corner", label: "Pipe Corner" },
    { asset: "pipe_cornerDiagonal", label: "Pipe Corner Diagonal" },
    { asset: "pipe_cornerRound", label: "Pipe Corner Round" },
    { asset: "pipe_cornerRoundLarge", label: "Pipe Corner Round Large" },
    { asset: "pipe_cross", label: "Pipe Cross" },
    { asset: "pipe_end", label: "Pipe End" },
    { asset: "pipe_entrance", label: "Pipe Entrance" },
    { asset: "pipe_open", label: "Pipe Open" },
    { asset: "pipe_rampLarge", label: "Pipe Ramp Large" },
    { asset: "pipe_rampSmall", label: "Pipe Ramp Small" },
    { asset: "pipe_ring", label: "Pipe Ring" },
    { asset: "pipe_ringHigh", label: "Pipe Ring High" },
    { asset: "pipe_ringHighEnd", label: "Pipe Ring High End" },
    { asset: "pipe_ringSupport", label: "Pipe Ring Support" },
    { asset: "pipe_split", label: "Pipe Split" },
    { asset: "pipe_straight", label: "Pipe Straight" },
    { asset: "pipe_supportHigh", label: "Pipe Support High" },
    { asset: "pipe_supportLow", label: "Pipe Support Low" },
    { asset: "platform_center", label: "Platform Center" },
    { asset: "platform_corner", label: "Platform Corner" },
    { asset: "platform_cornerOpen", label: "Platform Corner Open" },
    { asset: "platform_cornerRound", label: "Platform Corner Round" },
    { asset: "platform_end", label: "Platform End" },
    { asset: "platform_high", label: "Platform High" },
    { asset: "platform_large", label: "Platform Large" },
    { asset: "platform_long", label: "Platform Long" },
    { asset: "platform_low", label: "Platform Low" },
    { asset: "platform_side", label: "Platform Side" },
    { asset: "platform_small", label: "Platform Small" },
    { asset: "platform_smallDiagonal", label: "Platform Small Diagonal" },
    { asset: "platform_straight", label: "Platform Straight" },
    { asset: "monorail_trackCornerLarge", label: "Monorail Track Corner Large" },
    { asset: "monorail_trackCornerSmall", label: "Monorail Track Corner Small" },
    { asset: "monorail_trackSlope", label: "Monorail Track Slope" },
    { asset: "monorail_trackStraight", label: "Monorail Track Straight" },
    { asset: "monorail_trackSupport", label: "Monorail Track Support" },
    { asset: "monorail_trackSupportCorner", label: "Monorail Track Support Corner" },
    { asset: "monorail_trainBox", label: "Monorail Train Box" },
    { asset: "monorail_trainCargo", label: "Monorail Train Cargo" },
    { asset: "monorail_trainEnd", label: "Monorail Train End" },
    { asset: "monorail_trainFlat", label: "Monorail Train Flat" },
    { asset: "monorail_trainFront", label: "Monorail Train Front" },
    { asset: "monorail_trainPassenger", label: "Monorail Train Passenger" },
    { asset: "rail", label: "Rail" },
    { asset: "rail_corner", label: "Rail Corner" },
    { asset: "rail_end", label: "Rail End" },
    { asset: "rail_middle", label: "Rail Middle" },
  ] },
  { category: "Decor", isProp: true, items: [
    { asset: "barrel", label: "Barrel" },
    { asset: "barrels", label: "Barrels" },
    { asset: "barrels_rail", label: "Barrels Rail" },
    { asset: "bones", label: "Bones" },
    { asset: "chimney", label: "Chimney" },
    { asset: "chimney_detailed", label: "Chimney Detailed" },
    { asset: "crater", label: "Crater" },
    { asset: "craterLarge", label: "Crater Large" },
    { asset: "meteor", label: "Meteor" },
    { asset: "meteor_detailed", label: "Meteor Detailed" },
    { asset: "meteor_half", label: "Meteor Half" },
    { asset: "rover", label: "Rover" },
  ] },
  { category: "Characters", isProp: true, items: [
    { asset: "alien", label: "Alien" },
    { asset: "astronautA", label: "Astronaut A" },
    { asset: "astronautB", label: "Astronaut B" },
  ] },
];

// Road-tile categories first (current pack), then the legacy space-kit set
// under "Legacy: …" labels. Category names are pure UI grouping — maps store
// asset names only, so renaming categories can't break saved maps.
export const PALETTE: PaletteCategory[] = [
  ...ROAD_CATEGORIES,
  ...LEGACY_PALETTE.map(cat => ({ ...cat, category: `Legacy: ${cat.category}` })),
];

export const ASSET_NAMES = PALETTE.flatMap(cat => cat.items.map(i => i.asset));
export const PROP_ASSETS = new Set(
  PALETTE.filter(cat => cat.isProp).flatMap(cat => cat.items.map(i => i.asset))
);
export function isPropAsset(asset: string): boolean {
  return PROP_ASSETS.has(asset);
}

// Categories collapsed by default in the editor sidebar. With 302 road tiles
// + the full legacy set the sidebar would be an endless scroll, so default
// to: road categories OPEN only for the core flat-road groups the owner
// reaches for first, everything else (big road groups + ALL legacy) closed.
// The Recent section (MRU) is the primary navigation tool at this scale.
export const DEFAULT_COLLAPSED_CATEGORIES = new Set([
  "Roads: Cross & T", "Roads: End & Detail", "Slopes: Curved & Corner",
  "Bridges", "Water", "Ground", "Misc",
  ...LEGACY_PALETTE.map(cat => `Legacy: ${cat.category}`),
]);
