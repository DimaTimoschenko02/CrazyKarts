import { describe, expect, it } from "vitest";
import { filterBrowserAssets, type BrowserAssetInfo, type BrowserFilterState } from "./assetBrowserFilter";

const ITEMS: BrowserAssetInfo[] = [
  { asset: "roadTile_001", label: "001 Water", category: "Water", materials: { Water: 1 } },
  { asset: "roadTile_012", label: "012 Grass straight", category: "Roads: Straight", materials: { Grass: 0.85, Asphalt: 0.15 } },
  { asset: "roadTile_013", label: "013 Grass fleck", category: "Roads: Straight", materials: { Grass: 0.95, Sand: 0.05 } },
  { asset: "rock_largeA", label: "Rock Large A", category: "Legacy: Props" }, // no materials data
];

function baseFilter(overrides: Partial<BrowserFilterState> = {}): BrowserFilterState {
  return { category: null, material: null, query: "", ...overrides };
}

describe("filterBrowserAssets", () => {
  it("no filters → everything matches", () => {
    expect(filterBrowserAssets(ITEMS, baseFilter())).toHaveLength(4);
  });

  it("category filter keeps only that category", () => {
    const result = filterBrowserAssets(ITEMS, baseFilter({ category: "Roads: Straight" }));
    expect(result.map(i => i.asset)).toEqual(["roadTile_012", "roadTile_013"]);
  });

  it("material filter uses the >=0.15 share threshold, not mere presence", () => {
    // roadTile_013's Sand share (0.05) is below threshold → excluded from "Sand"
    const sand = filterBrowserAssets(ITEMS, baseFilter({ material: "Sand" }));
    expect(sand).toHaveLength(0);

    // roadTile_012's Asphalt share (0.15) is exactly at threshold → included
    const asphalt = filterBrowserAssets(ITEMS, baseFilter({ material: "Asphalt" }));
    expect(asphalt.map(i => i.asset)).toEqual(["roadTile_012"]);

    const grass = filterBrowserAssets(ITEMS, baseFilter({ material: "Grass" }));
    expect(grass.map(i => i.asset)).toEqual(["roadTile_012", "roadTile_013"]);
  });

  it("assets without material data are hidden once a material is selected", () => {
    const result = filterBrowserAssets(ITEMS, baseFilter({ material: "Grass" }));
    expect(result.some(i => i.asset === "rock_largeA")).toBe(false);
  });

  it("assets without material data are NOT hidden under 'All materials'", () => {
    const result = filterBrowserAssets(ITEMS, baseFilter());
    expect(result.some(i => i.asset === "rock_largeA")).toBe(true);
  });

  it("text query matches label or asset id, case-insensitively", () => {
    expect(filterBrowserAssets(ITEMS, baseFilter({ query: "grass" })).map(i => i.asset)).toEqual([
      "roadTile_012", "roadTile_013",
    ]);
    expect(filterBrowserAssets(ITEMS, baseFilter({ query: "ROCK_LARGEA" })).map(i => i.asset)).toEqual([
      "rock_largeA",
    ]);
    expect(filterBrowserAssets(ITEMS, baseFilter({ query: "nonexistent" }))).toHaveLength(0);
  });

  it("filters combine with AND", () => {
    const result = filterBrowserAssets(ITEMS, baseFilter({ category: "Roads: Straight", material: "Grass", query: "fleck" }));
    expect(result.map(i => i.asset)).toEqual(["roadTile_013"]);
  });

  it("whitespace-only query behaves like no query", () => {
    expect(filterBrowserAssets(ITEMS, baseFilter({ query: "   " }))).toHaveLength(4);
  });
});
