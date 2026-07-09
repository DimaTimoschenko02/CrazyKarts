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
}

export interface BrowserFilterState {
  category: string | null; // null = "All"
  material: string | null; // null = "All materials"
  query: string;
}

// A tile "belongs" to a material family once that material covers at least
// this share of its surface — matches the owner's spec (0.15), keeps tiles
// with a small material fleck (e.g. a thin dirt edge on mostly-grass) out
// of a filter that would otherwise be misleading.
export const MATERIAL_SHARE_THRESHOLD = 0.15;

function matchesCategory(info: BrowserAssetInfo, category: string | null): boolean {
  return category === null || info.category === category;
}

// Assets without material data (all legacy space-kit props) are invisible
// under "All materials" (nothing to exclude) but hidden once a specific
// material is picked — we don't know what they're made of, so showing them
// under e.g. "Grass" would be a false positive.
function matchesMaterial(info: BrowserAssetInfo, material: string | null): boolean {
  if (material === null) return true;
  if (!info.materials) return false;
  return (info.materials[material] ?? 0) >= MATERIAL_SHARE_THRESHOLD;
}

function matchesQuery(info: BrowserAssetInfo, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return info.label.toLowerCase().includes(q) || info.asset.toLowerCase().includes(q);
}

// All filter types AND together (category AND material AND text search).
export function filterBrowserAssets(
  items: readonly BrowserAssetInfo[],
  filter: BrowserFilterState
): BrowserAssetInfo[] {
  return items.filter(
    item =>
      matchesCategory(item, filter.category) &&
      matchesMaterial(item, filter.material) &&
      matchesQuery(item, filter.query)
  );
}
