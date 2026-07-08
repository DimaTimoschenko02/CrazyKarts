// Regression tests for the terrain_sideCliff / terrain_sideCornerInner /
// terrain_sideEnd branches and the mirror-flag handling in heightCellFor
// (see docs/space-kit-terrain-catalog.md for the vertex-verified facts these
// encode). Uses Heightfield.fromMapJson directly — no THREE, no asset
// templates needed, since this module is pure math shared between the
// client renderer (map/mapLoader.ts wraps it) and the Colyseus match server
// (server/config/arena.ts).
import { describe, expect, it } from "vitest";
import { Heightfield, heightCellFor, normRot, type MapJson } from "./heightfield";

function makeHeightfield(cells: MapJson["cells"]): Heightfield {
  return Heightfield.fromMapJson({
    meta: { tile_size: 1, level_height: 0.5, origin_offset: [0, 0, 0] },
    cells,
  });
}

describe("wall_block* shares ground_block's cube physics (owner decision 2026-07-08)", () => {
  it("every cube family member samples its TOP face at (y_level + 1) * level_height", () => {
    // Blocks stopped being infinite walls: сквозь нельзя (ступень 0.5 >
    // MAX_STEP), сверху можно. All four cubes go through the same
    // heightCellFor branch.
    for (const asset of ["wall_block", "wall_block_round", "wall_block_corner", "ground_block"]) {
      const hf = makeHeightfield([{ asset, x: 0, z: 0, y_level: 0 }]);
      expect(hf.sample(0, 0)).toBeCloseTo(0.5);
    }
  });
});

describe("ground_block: drivable cube — walkable surface is the cube TOP (y_level + 1)", () => {
  it("samples the top face of the cube, one level above the pivot", () => {
    const hf = makeHeightfield([{ asset: "ground_block", x: 0, z: 0, y_level: 0 }]);
    expect(hf.sample(0, 0)).toBeCloseTo(0.5); // cube spans [0, 0.5], top = 0.5
  });

  it("stacked ground_blocks read as the top of the stack (MAX across layers)", () => {
    const hf = makeHeightfield([
      { asset: "ground_block", x: 0, z: 0, y_level: 0 },
      { asset: "ground_block", x: 0, z: 0, y_level: 1 },
    ]);
    expect(hf.sample(0, 0)).toBeCloseTo(1.0); // second cube spans [0.5, 1.0]
  });

  it("is flat across the whole cell (no gradient) and counts as an authored column", () => {
    const hf = makeHeightfield([{ asset: "ground_block", x: 0, z: 0, y_level: 2 }]);
    expect(hf.sample(-0.49, -0.49)).toBeCloseTo(1.5);
    expect(hf.sample(0.49, 0.49)).toBeCloseTo(1.5);
    expect(hf.hasColumn(0, 0)).toBe(true);
  });
});

describe("heightCellFor branch ordering (startsWith prefix traps)", () => {
  it("terrain_sideCornerInner does NOT fall into the generic terrain_sideCorner branch", () => {
    // "terrain_sideCornerInner".startsWith("terrain_sideCorner") is true —
    // must resolve to the two-gradient (ax2/az2) MAX shape, not the plain
    // single-diagonal CORNER_ASCENT shape.
    const innerCell = heightCellFor("terrain_sideCornerInner", 0, 0, 0.5);
    const outerCell = heightCellFor("terrain_sideCorner", 0, 0, 0.5);
    expect(innerCell.ax2).toBeDefined();
    expect(innerCell.az2).toBeDefined();
    expect(outerCell.ax2).toBeUndefined();
    expect(outerCell.az2).toBeUndefined();
    // Outer uses a diagonal unit gradient (1/sqrt2); inner uses axis-aligned
    // unit gradients (magnitude 1) — different shape entirely, not just a
    // relabeling.
    expect(Math.abs(innerCell.ax)).toBeCloseTo(1, 6);
    expect(Math.abs(outerCell.ax)).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it("terrain_sideCliff does NOT fall into the generic terrain_side branch", () => {
    // "terrain_sideCliff".startsWith("terrain_side") is true — must resolve
    // to the CLIFF y_level=LOW/above-pivot semantics, not plain side's
    // y_level=HIGH/below-pivot semantics (a full level_height offset apart).
    const cliff = heightCellFor("terrain_sideCliff", 1, 0, 0.5);
    const side = heightCellFor("terrain_side", 1, 0, 0.5);
    expect(cliff.base).toBeCloseTo(0.5, 6); // y_level(1) * lh — LOW edge
    expect(side.base).toBeCloseTo(0.0, 6); // y_level(1) * lh - lh — HIGH edge semantics
  });

  it("terrain_sideEnd does NOT fall into the generic terrain_side branch", () => {
    // "terrain_sideEnd".startsWith("terrain_side") is true — same trap as
    // sideCliff. sideEnd's real Y-span sits above the pivot (ramp-like), so
    // it needs the y_level=LOW/above-pivot semantics too, not plain side's.
    const end = heightCellFor("terrain_sideEnd", 1, 0, 0.5);
    const side = heightCellFor("terrain_side", 1, 0, 0.5);
    expect(end.base).toBeCloseTo(0.5, 6); // y_level(1) * lh — LOW edge
    expect(side.base).toBeCloseTo(0.0, 6); // y_level(1) * lh - lh — HIGH edge semantics
  });
});

describe("terrain_sideCliff: drivable steep slope (reverted from wall-only)", () => {
  it("rot=0..270 ascend +Z/+X/-Z/-X — same rotation table as terrain_side, y_level=LOW edge", () => {
    const cases: Array<{ rot: number; lowProbe: [number, number]; highProbe: [number, number] }> = [
      { rot: 0, lowProbe: [0, -0.4], highProbe: [0, 0.4] },
      { rot: 90, lowProbe: [-0.4, 0], highProbe: [0.4, 0] },
      { rot: 180, lowProbe: [0, 0.4], highProbe: [0, -0.4] },
      { rot: 270, lowProbe: [0.4, 0], highProbe: [-0.4, 0] },
    ];
    for (const c of cases) {
      const hf = makeHeightfield([{ asset: "terrain_sideCliff", x: 0, z: 0, y_level: 0, rot: c.rot }]);
      const low = hf.sample(...c.lowProbe)!;
      const high = hf.sample(...c.highProbe)!;
      expect(low).toBeLessThan(high);
      expect(low).toBeCloseTo(0.05, 1); // near-zero, low edge
      expect(high).toBeCloseTo(0.45, 1); // near-full rise, high edge
    }
  });

  it("a lone sideCliff column is fully walkable (no longer a wall)", () => {
    const hf = makeHeightfield([{ asset: "terrain_sideCliff", x: 0, z: 0, y_level: 0, rot: 0 }]);
    expect(hf.sample(0, -0.4)).not.toBeNull();
    expect(hf.sample(0, 0)).not.toBeNull();
    expect(hf.sample(0, 0.4)).not.toBeNull();
  });

  it("wall_block samples its flat TOP across the whole cell (cube at y_level=1 → top = 1.0)", () => {
    const hf = makeHeightfield([{ asset: "wall_block", x: 2, z: 3, y_level: 1, rot: 0 }]);
    expect(hf.sample(2, 3)).toBeCloseTo(1.0);
    expect(hf.sample(2.3, 3)).toBeCloseTo(1.0);
  });

  it("wall_block_round and wall_block_corner sample the same cube top (fillets are visual-only)", () => {
    const hf = makeHeightfield([
      { asset: "wall_block_round", x: 0, z: 0, y_level: 0, rot: 90 },
      { asset: "wall_block_corner", x: 1, z: 0, y_level: 0, rot: 0 },
    ]);
    expect(hf.sample(0, 0)).toBeCloseTo(0.5);
    expect(hf.sample(1, 0)).toBeCloseTo(0.5);
  });
});

describe("terrain_sideEnd: approximated as a straight axial ramp (y_level = LOW edge)", () => {
  it("rot=0 ascends +Z like terrain_side/sideCliff — low near Z=-0.5, high near Z=+0.5", () => {
    const hf = makeHeightfield([{ asset: "terrain_sideEnd", x: 0, z: 0, y_level: 0, rot: 0 }]);
    const low = hf.sample(0, -0.4)!;
    const high = hf.sample(0, 0.4)!;
    expect(low).toBeLessThan(high);
    expect(hf.sample(0, -0.4)).not.toBeNull();
  });
});

describe("terrain_sideCornerInner: two-gradient MAX shape, y_level = LOW corner", () => {
  it("rot=0: low corner (+X-Z) near-corner probe is close to base (low)", () => {
    const hf = makeHeightfield([{ asset: "terrain_sideCornerInner", x: 0, z: 0, y_level: 0, rot: 0 }]);
    // Probe near, not exactly at, the low corner — same ±0.4 convention as
    // the existing sideCorner test in mapLoader.test.ts (exact ±0.5 rounds
    // into the empty neighbor cell).
    const nearCorner = hf.sample(0.4, -0.4)!;
    expect(nearCorner).toBeCloseTo(0.05, 5);
  });

  it("rot=0: center sits exactly halfway (where both edge-ramps agree) — NOT full rise", () => {
    // Both gradients evaluate to t=0.5 at the cell center (lx=lz=0), so
    // MAX(0.5, 0.5) = 0.5 — same center value a single diagonal gradient
    // would also give. The two-gradient MAX only changes behavior away from
    // the center, along the two straight high edges (see next test) — that
    // is the actual bug this shape variant fixes, not the center value.
    const hf = makeHeightfield([{ asset: "terrain_sideCornerInner", x: 0, z: 0, y_level: 0, rot: 0 }]);
    expect(hf.sample(0, 0)).toBeCloseTo(0.25, 5); // base(0) + rise(0.5) * 0.5
  });

  it("rot=0: the -X high edge reaches EXACTLY full rise at the boundary (the fix vs. a single diagonal gradient)", () => {
    // wx=-0.5 rounds (JS round-half-towards-+Inf on -0.5 → -0 → cell 0) into
    // this cell, giving an exact (not approximated) boundary sample.
    const hf = makeHeightfield([{ asset: "terrain_sideCornerInner", x: 0, z: 0, y_level: 0, rot: 0 }]);
    expect(hf.sample(-0.5, 0)).toBeCloseTo(0.5, 10); // base(0) + rise(0.5) * 1.0 exactly

    // Contrast: a single-diagonal gradient of the same magnitude convention
    // as CORNER_ASCENT (1/sqrt2 per axis) would undershoot badly at this same
    // point — computed inline here (not imported) purely to document the
    // magnitude of the bug the max2 shape fixes.
    const D = Math.SQRT1_2;
    const singleDiagonalT = Math.min(Math.max(0.5 + -0.5 * -D + 0 * D, 0), 1);
    const singleDiagonalHeight = 0 + 0.5 * singleDiagonalT;
    expect(singleDiagonalHeight).toBeCloseTo(0.5 * (0.5 + 0.5 * D), 5);
    expect(singleDiagonalHeight).toBeLessThan(0.43); // well short of the 0.5 full-rise the real mesh has here
  });

  it("rot=0: the +Z high edge also approaches full rise (near-boundary probe, ties resolve away from this cell)", () => {
    const hf = makeHeightfield([{ asset: "terrain_sideCornerInner", x: 0, z: 0, y_level: 0, rot: 0 }]);
    expect(hf.sample(0, 0.49)).toBeCloseTo(0.5, 1);
  });

  it("rot=90/180/270 low-corner directions match the catalog table", () => {
    // Sanity check the whole CORNER_INNER_ASCENT table via near-corner probes
    // for each rotation, per docs/space-kit-terrain-catalog.md:
    //   rot=0   low corner +X-Z
    //   rot=90  low corner +X+Z
    //   rot=180 low corner -X+Z
    //   rot=270 low corner -X-Z
    const cases: Array<{ rot: number; x: number; z: number }> = [
      { rot: 90, x: 0.4, z: 0.4 },
      { rot: 180, x: -0.4, z: 0.4 },
      { rot: 270, x: -0.4, z: -0.4 },
    ];
    for (const c of cases) {
      const hf = makeHeightfield([{ asset: "terrain_sideCornerInner", x: 0, z: 0, y_level: 0, rot: c.rot }]);
      expect(hf.sample(c.x, c.z)).toBeCloseTo(0.05, 5);
    }
  });
});

describe("mirror flag: reflect-then-rotate ascent gradient (CellDef.mirror)", () => {
  it("straight-axis families (ramp/side/sideCliff/sideEnd) are unaffected by mirror — base vector has ax0=0", () => {
    for (const asset of ["terrain_ramp", "terrain_side", "terrain_sideCliff", "terrain_sideEnd"]) {
      for (const rot of [0, 90, 180, 270]) {
        const withMirror = heightCellFor(asset, 0, rot, 0.5, true);
        const withoutMirror = heightCellFor(asset, 0, rot, 0.5, false);
        expect(withMirror.ax).toBeCloseTo(withoutMirror.ax, 10);
        expect(withMirror.az).toBeCloseTo(withoutMirror.az, 10);
      }
    }
  });

  it("terrain_sideCorner: mirror at rot=R equals the UNMIRRORED gradient at rot=R+90 (diagonal-shape identity)", () => {
    // Hand-derived: reflecting CORNER_ASCENT[0]=(-D,D) across local X gives
    // (D,D), which rotated by rot lands on a DIFFERENT tile corner than the
    // unmirrored rot=R gradient — specifically the one the unmirrored table
    // reaches at rot=R+90. This is the actual mismatch the old (mirror-
    // ignoring) code produced: a mirrored sideCorner cell physically raises
    // one corner while the old physics gradient pointed at another.
    const rotPairs: Array<[number, number]> = [[0, 90], [90, 180], [180, 270], [270, 0]];
    for (const [mirroredRot, equivalentUnmirroredRot] of rotPairs) {
      const mirrored = heightCellFor("terrain_sideCorner", 0, mirroredRot, 0.5, true);
      const equivalent = heightCellFor("terrain_sideCorner", 0, equivalentUnmirroredRot, 0.5, false);
      expect(mirrored.ax).toBeCloseTo(equivalent.ax, 10);
      expect(mirrored.az).toBeCloseTo(equivalent.az, 10);
    }
  });

  it("terrain_sideCorner: mirror genuinely changes the gradient vs. ignoring it (the bug this fixes)", () => {
    const cell = { asset: "terrain_sideCorner", x: 0, z: 0, y_level: 0, rot: 0, mirror: true };
    const mirrored = heightCellFor(cell.asset, cell.y_level, cell.rot, 0.5, true);
    const unmirrored = heightCellFor(cell.asset, cell.y_level, cell.rot, 0.5, false);
    expect(mirrored.ax).not.toBeCloseTo(unmirrored.ax, 5);
  });

  it("terrain_sideCornerInner: mirror reflects the ax0≠0 gradient, leaves the ax0=0 second gradient's ax2 untouched", () => {
    // Base at rot=0: (ax0,az0)=(-1,0) [first gradient], (ax20,az20)=(0,1)
    // [second gradient]. Reflecting negates only the first (ax0=-1 -> +1);
    // the second (ax0=0) is unaffected, matching the straight-axis no-op
    // rule above.
    const mirrored = heightCellFor("terrain_sideCornerInner", 0, 0, 0.5, true);
    const unmirrored = heightCellFor("terrain_sideCornerInner", 0, 0, 0.5, false);
    expect(mirrored.ax).toBeCloseTo(-unmirrored.ax, 10);
    expect(mirrored.az).toBeCloseTo(unmirrored.az, 10);
    expect(mirrored.ax2).toBeCloseTo(unmirrored.ax2 ?? 0, 10);
    expect(mirrored.az2).toBeCloseTo(unmirrored.az2 ?? 0, 10);
  });

  it("Heightfield.fromMapJson wires cell.mirror through to heightCellFor for sideCorner", () => {
    // End-to-end: a mirrored sideCorner cell at rot=0 must sample like the
    // UNMIRRORED rot=90 shape (per the rot+90 identity above), not like its
    // own unmirrored rot=0 shape.
    const mirroredHf = makeHeightfield([
      { asset: "terrain_sideCorner", x: 0, z: 0, y_level: 0, rot: 0, mirror: true },
    ]);
    const equivalentHf = makeHeightfield([{ asset: "terrain_sideCorner", x: 0, z: 0, y_level: 0, rot: 90 }]);
    // Near the +X+Z corner, both should agree (that's where rot=90's high
    // corner sits, and where the mirrored rot=0 cell's high corner now sits).
    expect(mirroredHf.sample(0.4, 0.4)).toBeCloseTo(equivalentHf.sample(0.4, 0.4)!, 5);
  });
});

describe("2-cell ramps (terrain_rampLarge*) expand to two half-height ramp cells", () => {
  it("rot=0 spans one full level over cells z and z+1 (low half then high half)", () => {
    const hf = makeHeightfield([{ asset: "terrain_rampLarge", x: 0, z: 0, y_level: 0, rot: 0 }]);
    // Low cell (z=0): rises 0 -> 0.25 across its own -Z..+Z span.
    expect(hf.sample(0, -0.49)).toBeCloseTo(0.0, 2); // outer/low edge
    expect(hf.sample(0, 0.0)).toBeCloseTo(0.125, 2); // mid of low cell
    // Seam between the two cells is continuous at 0.25.
    expect(hf.sample(0, 0.49)).toBeCloseTo(0.25, 2);
    expect(hf.sample(0, 0.51)).toBeCloseTo(0.25, 2);
    // High cell (z=1): rises 0.25 -> 0.5.
    expect(hf.sample(0, 1.49)).toBeCloseTo(0.5, 2); // inner/high edge
    // Off the 2-cell footprint entirely -> no cell (wall).
    expect(hf.sample(0, 2.0)).toBeNull();
  });

  it("rot=90 extends along +X instead of +Z", () => {
    const hf = makeHeightfield([{ asset: "terrain_rampLarge_detailed", x: 5, z: 3, y_level: 1, rot: 90 }]);
    expect(hf.sample(5, 3)).toBeCloseTo(0.5 + 0.125, 2); // low cell mid (base y_level=1 -> 0.5)
    expect(hf.sample(6, 3)).toBeCloseTo(0.5 + 0.375, 2); // high cell mid at x+1
    expect(hf.sample(5, 4)).toBeNull(); // not along the long axis
  });
});

describe("stacked columns (several assets sharing one XZ) — topmost solid wins the walkable sample", () => {
  it("a flat top at y_level 2 shadows a slope below it in the same column, regardless of JSON order", () => {
    // Two ramps (y0, y1) form a 2-level slope; a flat terrain at y2 is the
    // walkable top of that column. The kart must stand on the top (1.0),
    // never on the lower ramp's own peak (0.5).
    const top = makeHeightfield([
      { asset: "terrain_ramp", x: 0, z: 0, y_level: 0, rot: 0 },
      { asset: "terrain_ramp", x: 0, z: 0, y_level: 1, rot: 0 },
      { asset: "terrain", x: 0, z: 0, y_level: 2, rot: 0 },
    ]);
    expect(top.sample(0, 0)).toBeCloseTo(1.0, 6);
  });

  it("order-independent: the lower layer listed LAST still does not shadow the higher one", () => {
    const highFirst = makeHeightfield([
      { asset: "terrain", x: 3, z: 3, y_level: 2, rot: 0 },
      { asset: "terrain_ramp", x: 3, z: 3, y_level: 0, rot: 0 },
    ]);
    // Without the keep-max rule this would be the ramp's peak (0.5); with it,
    // the flat y2 top (1.0) survives even though it was written first.
    expect(highFirst.sample(3, 3)).toBeCloseTo(1.0, 6);
  });

  it("wall_block sharing a column with flat terrain is just another layer — its cube TOP wins either JSON order", () => {
    // A wall_block at y_level=3 spans [1.5, 2.0]; the flat terrain layer at
    // y_level=1 sits at 0.5. The per-point MAX picks the cube top (2.0)
    // regardless of authoring order — the kart drives on top of the block.
    const wallFirst = makeHeightfield([
      { asset: "wall_block", x: 0, z: 0, y_level: 3, rot: 0 },
      { asset: "terrain", x: 0, z: 0, y_level: 1, rot: 0 },
    ]);
    const terrainFirst = makeHeightfield([
      { asset: "terrain", x: 0, z: 0, y_level: 1, rot: 0 },
      { asset: "wall_block", x: 0, z: 0, y_level: 3, rot: 0 },
    ]);
    expect(wallFirst.sample(0, 0)).toBeCloseTo(2.0, 6);
    expect(terrainFirst.sample(0, 0)).toBeCloseTo(2.0, 6);
  });
});

describe("Heightfield.hasColumn — authored footprint vs genuine off-map edges", () => {
  it("true for a walkable cell", () => {
    const hf = makeHeightfield([{ asset: "terrain", x: 0, z: 0, y_level: 0 }]);
    expect(hf.hasColumn(0, 0)).toBe(true);
  });

  it("true for a wall_block cell — and sample() there is the cube top, not null", () => {
    const hf = makeHeightfield([{ asset: "wall_block", x: 2, z: 3, y_level: 0 }]);
    expect(hf.hasColumn(2, 3)).toBe(true);
    expect(hf.sample(2, 3)).toBeCloseTo(0.5);
  });

  it("false for a genuinely unauthored column (real off-map edge)", () => {
    const hf = makeHeightfield([{ asset: "terrain", x: 0, z: 0, y_level: 0 }]);
    expect(hf.hasColumn(50, 50)).toBe(false);
  });

  it("tracks wall_block rect_fills too, not just individual cells", () => {
    const hf = Heightfield.fromMapJson({
      meta: { tile_size: 1, level_height: 0.5, origin_offset: [0, 0, 0] },
      rect_fills: [{ asset: "wall_block", x_min: 0, x_max: 2, z_min: 0, z_max: 0, y_level: 0 }],
    });
    expect(hf.hasColumn(1, 0)).toBe(true);
    expect(hf.sample(1, 0)).toBeCloseTo(0.5);
  });
});

describe("normRot / heightCellFor exports used directly by the diagnostic scan script", () => {
  it("normRot wraps to [0, 360)", () => {
    expect(normRot(-90)).toBe(270);
    expect(normRot(450)).toBe(90);
  });
});

describe("Heightfield.listCellCoords — drivable-footprint enumeration used by the spawn fallback", () => {
  it("lists every authored column — wall_block cells included (their cube top is drivable now)", () => {
    const hf = makeHeightfield([
      { asset: "terrain", x: 0, z: 0, y_level: 0, rot: 0 },
      { asset: "terrain", x: 1, z: 0, y_level: 0, rot: 0 },
      { asset: "wall_block", x: 2, z: 0, y_level: 0, rot: 0 },
    ]);
    const coords = hf.listCellCoords();
    expect(coords).toHaveLength(3);
    expect(coords).toEqual(expect.arrayContaining([{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }]));
  });
});
