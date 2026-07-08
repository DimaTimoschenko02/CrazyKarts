import { describe, expect, it } from "vitest";
import { shouldDeletePropFirst, topCellYLevelAt, type CellLike } from "./deletePriority";

describe("topCellYLevelAt", () => {
  it("returns null when the column is empty", () => {
    expect(topCellYLevelAt([], 3, 4)).toBeNull();
  });

  it("ignores cells at other (x, z)", () => {
    const cells: CellLike[] = [{ x: 1, z: 1, y_level: 5 }];
    expect(topCellYLevelAt(cells, 3, 4)).toBeNull();
  });

  it("returns the single cell's y_level when only one occupies the column", () => {
    const cells: CellLike[] = [{ x: 3, z: 4, y_level: 2 }];
    expect(topCellYLevelAt(cells, 3, 4)).toBe(2);
  });

  it("returns the highest y_level among several stacked cells", () => {
    const cells: CellLike[] = [
      { x: 3, z: 4, y_level: 0 },
      { x: 3, z: 4, y_level: 3 },
      { x: 3, z: 4, y_level: 1 },
      { x: 9, z: 9, y_level: 99 }, // different column — must not win
    ];
    expect(topCellYLevelAt(cells, 3, 4)).toBe(3);
  });
});

describe("shouldDeletePropFirst", () => {
  it("never prioritizes a prop that isn't there", () => {
    expect(shouldDeletePropFirst(null, null)).toBe(false);
    expect(shouldDeletePropFirst(2, null)).toBe(false);
  });

  it("prioritizes the prop when there's no cell in that column at all", () => {
    expect(shouldDeletePropFirst(null, 0)).toBe(true);
    expect(shouldDeletePropFirst(null, 5)).toBe(true);
  });

  it("prioritizes the prop when it sits at or above the top cell (rock on top of a road)", () => {
    expect(shouldDeletePropFirst(1, 1)).toBe(true); // equal — prop is the visible top layer
    expect(shouldDeletePropFirst(1, 2)).toBe(true); // prop above the cell stack
  });

  it("prioritizes the cell when the prop sits below the top of the stack", () => {
    expect(shouldDeletePropFirst(3, 1)).toBe(false);
  });
});
