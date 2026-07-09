import { describe, expect, it } from "vitest";
import { filterBrowserAssets, type BrowserAssetInfo, type BrowserFilterState } from "./assetBrowserFilter";

const ITEMS: BrowserAssetInfo[] = [
  { asset: "roadTile_001", label: "001 Water", category: "Water", materials: { Water: 1 }, heightFamilies: new Set(["0.23"]) },
  {
    asset: "roadTile_012", label: "012 Grass straight", category: "Roads: Straight",
    materials: { Grass: 0.85, Asphalt: 0.15 }, heightFamilies: new Set(["0.60"]),
  },
  {
    asset: "roadTile_013", label: "013 Grass fleck", category: "Roads: Straight",
    materials: { Grass: 0.95, Sand: 0.05 }, heightFamilies: new Set(["0.60"]),
  },
  {
    asset: "roadTile_020", label: "020 Sand slope", category: "Slopes",
    materials: { Sand: 1 }, heightFamilies: new Set(["0.60", "1.71"]),
  },
  { asset: "rock_largeA", label: "Rock Large A", category: "Legacy: Props" }, // no materials/heightFamilies data
];

function baseFilter(overrides: Partial<BrowserFilterState> = {}): BrowserFilterState {
  return { categories: new Set(), materials: new Set(), heights: new Set(), query: "", ...overrides };
}

describe("filterBrowserAssets", () => {
  it("no filters (empty sets) → everything matches", () => {
    expect(filterBrowserAssets(ITEMS, baseFilter())).toHaveLength(5);
  });

  it("single category selected keeps only that category", () => {
    const result = filterBrowserAssets(ITEMS, baseFilter({ categories: new Set(["Roads: Straight"]) }));
    expect(result.map(i => i.asset)).toEqual(["roadTile_012", "roadTile_013"]);
  });

  it("multiple selected categories OR together (multiselect)", () => {
    const result = filterBrowserAssets(ITEMS, baseFilter({ categories: new Set(["Water", "Slopes"]) }));
    expect(result.map(i => i.asset)).toEqual(["roadTile_001", "roadTile_020"]);
  });

  it("material filter uses the >=0.15 share threshold, not mere presence", () => {
    // roadTile_013's Sand share (0.05) is below threshold → excluded from "Sand"
    const sand = filterBrowserAssets(ITEMS, baseFilter({ materials: new Set(["Sand"]) }));
    expect(sand.map(i => i.asset)).toEqual(["roadTile_020"]);

    // roadTile_012's Asphalt share (0.15) is exactly at threshold → included
    const asphalt = filterBrowserAssets(ITEMS, baseFilter({ materials: new Set(["Asphalt"]) }));
    expect(asphalt.map(i => i.asset)).toEqual(["roadTile_012"]);

    const grass = filterBrowserAssets(ITEMS, baseFilter({ materials: new Set(["Grass"]) }));
    expect(grass.map(i => i.asset)).toEqual(["roadTile_012", "roadTile_013"]);
  });

  it("multiple selected materials OR together (multiselect)", () => {
    const result = filterBrowserAssets(ITEMS, baseFilter({ materials: new Set(["Water", "Sand"]) }));
    // Sand only counts for roadTile_020 (1.0 share) — roadTile_013's 0.05 Sand fleck stays excluded.
    expect(result.map(i => i.asset)).toEqual(["roadTile_001", "roadTile_020"]);
  });

  it("assets without material data are hidden once any material is selected", () => {
    const result = filterBrowserAssets(ITEMS, baseFilter({ materials: new Set(["Grass"]) }));
    expect(result.some(i => i.asset === "rock_largeA")).toBe(false);
  });

  it("assets without material data are NOT hidden under 'All materials' (empty set)", () => {
    const result = filterBrowserAssets(ITEMS, baseFilter());
    expect(result.some(i => i.asset === "rock_largeA")).toBe(true);
  });

  it("single height family selected keeps only tiles touching it", () => {
    const result = filterBrowserAssets(ITEMS, baseFilter({ heights: new Set(["1.71"]) }));
    expect(result.map(i => i.asset)).toEqual(["roadTile_020"]);
  });

  it("a tile touching multiple height families matches on ANY of them (slope low+high edge)", () => {
    const result = filterBrowserAssets(ITEMS, baseFilter({ heights: new Set(["0.60"]) }));
    // roadTile_020 is a slope whose low edge is 0.60 — matches even though its
    // label says "Sand slope" and its high edge is a different family (1.71).
    expect(result.map(i => i.asset)).toEqual(["roadTile_012", "roadTile_013", "roadTile_020"]);
  });

  it("multiple selected height families OR together (multiselect)", () => {
    const result = filterBrowserAssets(ITEMS, baseFilter({ heights: new Set(["0.23", "1.71"]) }));
    expect(result.map(i => i.asset)).toEqual(["roadTile_001", "roadTile_020"]);
  });

  it("assets without height data are hidden once any height family is selected", () => {
    const result = filterBrowserAssets(ITEMS, baseFilter({ heights: new Set(["0.60"]) }));
    expect(result.some(i => i.asset === "rock_largeA")).toBe(false);
  });

  it("assets without height data are NOT hidden under 'All heights' (empty set)", () => {
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

  it("rows combine with AND (row-internal OR, cross-row AND)", () => {
    const result = filterBrowserAssets(
      ITEMS,
      baseFilter({
        categories: new Set(["Roads: Straight", "Slopes"]), // OR: matches roadTile_012/013 AND roadTile_020
        materials: new Set(["Grass"]), // AND: only Grass-majority tiles survive → roadTile_020 (pure Sand) drops out
        query: "fleck",
      })
    );
    expect(result.map(i => i.asset)).toEqual(["roadTile_013"]);
  });

  it("height row ANDs against category/material rows too", () => {
    const result = filterBrowserAssets(
      ITEMS,
      baseFilter({
        categories: new Set(["Slopes"]),
        heights: new Set(["0.60"]), // roadTile_020 matches (low edge), a Roads:Straight tile would too but category excludes it
      })
    );
    expect(result.map(i => i.asset)).toEqual(["roadTile_020"]);
  });

  it("whitespace-only query behaves like no query", () => {
    expect(filterBrowserAssets(ITEMS, baseFilter({ query: "   " }))).toHaveLength(5);
  });
});
