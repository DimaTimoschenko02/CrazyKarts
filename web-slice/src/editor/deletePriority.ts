// Pure decision logic for the map editor's right-click delete (main.ts).
// Split out so it's testable without dragging in THREE/DOM — main.ts wires
// this against its `cells` Map and `props` array, but the actual "which
// thing wins" rule is plain data in, boolean out.
//
// Bug this fixes: placing a prop (e.g. a rock) on top of a cell (e.g. a
// road tile) used to always delete the cell first on right-click, because
// the old handler tried cellKeyToDelete() before ever looking at props.
// From the owner's point of view the rock is the thing sitting visually on
// top, so it should be the thing that comes off first — but only when it's
// actually at or above the top of the stack at that spot; a prop floating
// above a much taller nearby cell shouldn't jump the queue.

export interface CellLike {
  readonly x: number;
  readonly z: number;
  readonly y_level: number;
}

// Highest y_level among cells occupying exactly (x, z), or null if the
// column is empty. Cell-space coordinates are integers, so exact equality
// is correct here (unlike prop matching, which is float/radius-based).
export function topCellYLevelAt(cells: Iterable<CellLike>, x: number, z: number): number | null {
  let top: number | null = null;
  for (const rec of cells) {
    if (rec.x === x && rec.z === z && (top === null || rec.y_level > top)) top = rec.y_level;
  }
  return top;
}

// Should a right-click at this spot remove the nearby prop before falling
// back to the cell-delete logic?
//   - No prop nearby (propYLevel === null) -> never.
//   - Prop nearby but no cell in that column (topCellYLevel === null) -> yes,
//     nothing else to prioritize against.
//   - Both present -> prop wins only if it sits at or above the top of the
//     cell stack (visually on top of it), so props resting below a tall
//     ramp/plateau edge don't steal the delete from the cell above them.
export function shouldDeletePropFirst(topCellYLevel: number | null, propYLevel: number | null): boolean {
  if (propYLevel === null) return false;
  if (topCellYLevel === null) return true;
  return propYLevel >= topCellYLevel;
}
