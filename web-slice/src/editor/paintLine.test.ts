import { describe, expect, it } from "vitest";
import { cellsAlongLine } from "./paintLine";

describe("cellsAlongLine", () => {
  it("same cell → empty (start is already painted)", () => {
    expect(cellsAlongLine(3, 3, 3, 3)).toEqual([]);
  });

  it("adjacent cell → just the destination", () => {
    expect(cellsAlongLine(3, 3, 4, 3)).toEqual([{ x: 4, z: 3 }]);
  });

  it("horizontal gap fills every skipped cell, endpoint included", () => {
    expect(cellsAlongLine(0, 5, 4, 5)).toEqual([
      { x: 1, z: 5 }, { x: 2, z: 5 }, { x: 3, z: 5 }, { x: 4, z: 5 },
    ]);
  });

  it("perfect diagonal walks cell by cell", () => {
    expect(cellsAlongLine(0, 0, 3, 3)).toEqual([
      { x: 1, z: 1 }, { x: 2, z: 2 }, { x: 3, z: 3 },
    ]);
  });

  it("shallow slope: dominant axis steps once per cell, no holes on X", () => {
    const line = cellsAlongLine(0, 0, 6, 2);
    // every x from 1..6 appears exactly once
    expect(line.map(c => c.x)).toEqual([1, 2, 3, 4, 5, 6]);
    // z climbs monotonically to the target
    expect(line[line.length - 1]).toEqual({ x: 6, z: 2 });
    for (let i = 1; i < line.length; i++) {
      expect(line[i].z).toBeGreaterThanOrEqual(line[i - 1].z);
    }
  });

  it("negative direction works the same", () => {
    expect(cellsAlongLine(2, 2, 0, 2)).toEqual([{ x: 1, z: 2 }, { x: 0, z: 2 }]);
  });
});
