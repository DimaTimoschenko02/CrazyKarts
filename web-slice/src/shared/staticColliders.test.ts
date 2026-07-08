// Pins buildStaticColliders' placement math (wall_block AABB grid alignment,
// prop OBB/hull transform, size gates) — see design/notes/collision-v2.md §2
// and the map-building.md grid conventions this must mirror exactly.
import { describe, expect, it } from "vitest";
import { buildStaticColliders, type CollisionShapesTable } from "./staticColliders";
import { pointInPoly } from "./collision2d";
import type { MapJson } from "./heightfield";

function baseMeta(originOffset: [number, number, number] = [0, 0, 0]): MapJson["meta"] {
  return { tile_size: 1, level_height: 0.5, origin_offset: originOffset };
}

describe("buildStaticColliders — wall_block cells", () => {
  it("places a 1x1 AABB centered at the cell's world position", () => {
    const map: MapJson = { meta: baseMeta(), cells: [{ asset: "wall_block", x: 3, z: -2, y_level: 0 }] };
    const colliders = buildStaticColliders(map, {});
    expect(colliders).toHaveLength(1);
    const [a, b, c, d] = colliders[0].verts;
    expect(a).toEqual({ x: 2.5, z: -2.5 });
    expect(b).toEqual({ x: 3.5, z: -2.5 });
    expect(c).toEqual({ x: 3.5, z: -1.5 });
    expect(d).toEqual({ x: 2.5, z: -1.5 });
  });

  it("wall_block_round / wall_block_corner both get the SAME 1x1 AABB (fillets are top-edge-only, invisible in XZ)", () => {
    const map: MapJson = {
      meta: baseMeta(),
      cells: [
        { asset: "wall_block_round", x: 0, z: 0, y_level: 0 },
        { asset: "wall_block_corner", x: 1, z: 0, y_level: 0 },
      ],
    };
    const colliders = buildStaticColliders(map, {});
    expect(colliders).toHaveLength(2);
    expect(colliders[0].verts[0]).toEqual({ x: -0.5, z: -0.5 });
  });

  it("expands wall_block rect_fills to one AABB per covered cell", () => {
    const map: MapJson = {
      meta: baseMeta(),
      rect_fills: [{ asset: "wall_block", x_min: 0, x_max: 1, z_min: 0, z_max: 0, y_level: 0 }],
    };
    expect(buildStaticColliders(map, {})).toHaveLength(2);
  });

  it("non-wall terrain cells contribute NO collider (handled by the heightfield/terrain-slide path instead)", () => {
    const map: MapJson = { meta: baseMeta(), cells: [{ asset: "terrain", x: 0, z: 0, y_level: 0 }] };
    expect(buildStaticColliders(map, {})).toHaveLength(0);
  });

  it("respects origin_offset when placing a wall cell", () => {
    const map: MapJson = { meta: baseMeta([-2.5, 0, -2.5]), cells: [{ asset: "wall_block", x: 0, z: 0, y_level: 0 }] };
    const collider = buildStaticColliders(map, {})[0];
    expect(collider.verts[0]).toEqual({ x: -3, z: -3 });
  });
});

describe("buildStaticColliders — structural props (OBB)", () => {
  const shapes: CollisionShapesTable = { corridor: { type: "obb", halfX: 0.5, halfZ: 1.0 } };

  it("places an axis-aligned OBB at the prop's world position for rot=0", () => {
    const map: MapJson = { meta: baseMeta(), props: [{ asset: "corridor", x: 2, z: 3, y_level: 0, rot: 0 }] };
    const collider = buildStaticColliders(map, shapes)[0];
    expect(pointInPoly({ x: 2, z: 3 }, collider)).toBe(true);
    expect(pointInPoly({ x: 2.4, z: 3 }, collider)).toBe(true); // within halfX
    expect(pointInPoly({ x: 2.6, z: 3 }, collider)).toBe(false); // past halfX
  });

  it("rotates the OBB by the prop's rot (90deg swaps which world axis the long side faces)", () => {
    const map: MapJson = { meta: baseMeta(), props: [{ asset: "corridor", x: 0, z: 0, y_level: 0, rot: 90 }] };
    const collider = buildStaticColliders(map, shapes)[0];
    // Unrotated: long axis (halfZ=1.0) along local Z. At rot=90 the long
    // axis should now extend along world X instead.
    expect(pointInPoly({ x: 0.9, z: 0 }, collider)).toBe(true);
    expect(pointInPoly({ x: 0, z: 0.9 }, collider)).toBe(false);
  });

  it("scales the OBB by the prop's scale factor", () => {
    const map: MapJson = { meta: baseMeta(), props: [{ asset: "corridor", x: 0, z: 0, y_level: 0, scale: 2 }] };
    const collider = buildStaticColliders(map, shapes)[0];
    expect(pointInPoly({ x: 0.9, z: 0 }, collider)).toBe(true); // halfX*scale = 1.0
  });

  it("a structural prop with no matching shapes-table entry contributes no collider (degrades gracefully)", () => {
    const map: MapJson = { meta: baseMeta(), props: [{ asset: "hangar_largeA", x: 0, z: 0, y_level: 0 }] };
    expect(buildStaticColliders(map, {})).toHaveLength(0);
  });

  it("a structural prop scaled below MIN_OBSTACLE_DIAMETER gets no collider", () => {
    const map: MapJson = { meta: baseMeta(), props: [{ asset: "corridor", x: 0, z: 0, y_level: 0, scale: 0.2 }] };
    expect(buildStaticColliders(map, shapes)).toHaveLength(0);
  });
});

describe("buildStaticColliders — natural decor props (hull) — key P2 regression", () => {
  // A rock's hull is a wide, shallow footprint on the +X side (asymmetric —
  // mimics a real rock's irregular silhouette), verified against the OLD
  // circle model to show a point the circle used to block is now open.
  const shapes: CollisionShapesTable = {
    rock_largeA: {
      type: "hull",
      verts: [[-0.3, -0.3], [0.6, -0.2], [0.6, 0.2], [-0.3, 0.3]],
      heightY: 0.5,
    },
  };

  it("places the hull, rotated + translated to the prop's world position", () => {
    const map: MapJson = { meta: baseMeta(), props: [{ asset: "rock_largeA", x: 5, z: 5, y_level: 0 }] };
    const collider = buildStaticColliders(map, shapes)[0];
    expect(pointInPoly({ x: 5.5, z: 5 }, collider)).toBe(true); // inside the wide +X lobe
    expect(pointInPoly({ x: 5 - 0.3, z: 5 }, collider)).toBe(true); // still on the flatter -X edge
  });

  it("KEY P2 test: a point the old bloated circle blocked, but sits outside the real hull, is now passable", () => {
    // Old model: radius = (max(size.x,size.z)/2)*shrink. This hull's own
    // bounding box is 0.9 wide (x: -0.3..0.6) x 0.6 deep (z: -0.3..0.3) ->
    // old circle radius = (0.9/2)*0.8 = 0.36, centered on the prop's position.
    // The hull's flat -X edge sits at x=-0.3 for z in [-0.3, 0.3] — a point
    // just past that edge (x=-0.32, z=0) is OUTSIDE the real hull but well
    // inside the old centered circle (dist 0.32 < 0.36).
    const map: MapJson = { meta: baseMeta(), props: [{ asset: "rock_largeA", x: 0, z: 0, y_level: 0 }] };
    const collider = buildStaticColliders(map, shapes)[0];
    const oldCircleRadius = (0.9 / 2) * 0.8;
    const testPoint = { x: -0.32, z: 0 };
    const distFromCenter = Math.hypot(testPoint.x, testPoint.z);
    expect(distFromCenter).toBeLessThan(oldCircleRadius); // old model: blocked
    expect(pointInPoly(testPoint, collider)).toBe(false); // new model: passable
  });

  it("wide-but-flat decor (height below MIN_OBSTACLE_HEIGHT) stays walk-through", () => {
    const flatShapes: CollisionShapesTable = {
      rock: { type: "hull", verts: [[-0.4, -0.4], [0.4, -0.4], [0.4, 0.4], [-0.4, 0.4]], heightY: 0.3 },
    };
    const map: MapJson = { meta: baseMeta(), props: [{ asset: "rock", x: 0, z: 0, y_level: 0 }] };
    expect(buildStaticColliders(map, flatShapes)).toHaveLength(0);
  });

  it("bones stays walk-through via the explicit height-exception even with a tall/wide hull", () => {
    const bonesShapes: CollisionShapesTable = {
      bones: { type: "hull", verts: [[-0.4, -0.4], [0.4, -0.4], [0.4, 0.4], [-0.4, 0.4]], heightY: 0.5 },
    };
    const map: MapJson = { meta: baseMeta(), props: [{ asset: "bones", x: 0, z: 0, y_level: 0 }] };
    expect(buildStaticColliders(map, bonesShapes)).toHaveLength(0);
  });

  it("a prop asset outside both STRUCTURAL/NATURAL_DECOR sets never gets a collider", () => {
    const map: MapJson = { meta: baseMeta(), props: [{ asset: "desk_chair", x: 0, z: 0, y_level: 0 }] };
    expect(buildStaticColliders(map, { desk_chair: { type: "hull", verts: [[-1, -1], [1, -1], [1, 1], [-1, 1]], heightY: 1 } })).toHaveLength(0);
  });
});
