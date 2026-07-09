// Pure filtering logic for the asset-browser modal (main.ts owns the DOM;
// this module only decides which assets match the current chip/search
// state, so it can be unit-tested without a browser/WebGL context).

export interface BrowserAssetInfo {
  asset: string;
  label: string;
  category: string;
  // Road-tile material composition (fraction of surface area per material,
  // e.g. { Grass: 0.4, Asphalt: 0.6 }). Undefined for legacy space-kit
  // assets, which have no such data baked.
  materials?: Record<string, number>;
  // Connection-height family labels this tile's edges touch (e.g. a slope
  // touching "0.60" at its low edge and "1.71" at its high edge). Undefined
  // for legacy space-kit assets — no measured geometry, same convention as
  // `materials`. See src/shared/mapAssets.ts's HEIGHT_FAMILIES clustering.
  heightFamilies?: ReadonlySet<string>;
}

// Category/material/height chips are multiselect within their own row
// (owner request 2026-07-09: clicking a second category chip must not
// deselect the first) — an empty Set means "All" for that row. Between
// rows the combination is still AND: (any selected category) AND (any
// selected material) AND (any selected height) AND (text query).
export interface BrowserFilterState {
  categories: ReadonlySet<string>; // empty = "All"
  materials: ReadonlySet<string>; // empty = "All materials"
  heights: ReadonlySet<string>; // empty = "All heights"
  query: string;
}

// A tile "belongs" to a material family once that material covers at least
// this share of its surface — matches the owner's spec (0.15), keeps tiles
// with a small material fleck (e.g. a thin dirt edge on mostly-grass) out
// of a filter that would otherwise be misleading.
export const MATERIAL_SHARE_THRESHOLD = 0.15;

function matchesCategory(info: BrowserAssetInfo, categories: ReadonlySet<string>): boolean {
  return categories.size === 0 || categories.has(info.category);
}

// Assets without material data (all legacy space-kit props) are invisible
// under "All materials" (nothing to exclude) but hidden once at least one
// specific material is selected — we don't know what they're made of, so
// showing them under e.g. "Grass" would be a false positive.
function matchesMaterial(info: BrowserAssetInfo, materials: ReadonlySet<string>): boolean {
  if (materials.size === 0) return true;
  if (!info.materials) return false;
  for (const m of materials) {
    if ((info.materials[m] ?? 0) >= MATERIAL_SHARE_THRESHOLD) return true;
  }
  return false;
}

// Same "no data = hidden once a specific filter is picked" convention as
// matchesMaterial — a tile matches if ANY of its own height families is
// among the selected ones (a slope touches two families; either counts).
function matchesHeight(info: BrowserAssetInfo, heights: ReadonlySet<string>): boolean {
  if (heights.size === 0) return true;
  if (!info.heightFamilies) return false;
  for (const h of heights) {
    if (info.heightFamilies.has(h)) return true;
  }
  return false;
}

function matchesQuery(info: BrowserAssetInfo, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return info.label.toLowerCase().includes(q) || info.asset.toLowerCase().includes(q);
}

// Within a row: OR (any selected category / material / height matches).
// Between rows and the text query: AND.
export function filterBrowserAssets(
  items: readonly BrowserAssetInfo[],
  filter: BrowserFilterState
): BrowserAssetInfo[] {
  return items.filter(
    item =>
      matchesCategory(item, filter.categories) &&
      matchesMaterial(item, filter.materials) &&
      matchesHeight(item, filter.heights) &&
      matchesQuery(item, filter.query)
  );
}
