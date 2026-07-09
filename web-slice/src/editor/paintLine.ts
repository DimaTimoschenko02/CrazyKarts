// Drag-paint stroke interpolation. A fast mouse flick delivers pointermove
// events several cells apart; painting only the sampled cells would leave
// holes in the stroke. This walks the integer cells along the segment from
// the PREVIOUS painted cell to the current one (endpoints excluded/included:
// (x0,z0) is assumed already painted, (x1,z1) is included) using a rounded
// DDA — one cell per step of the dominant axis, which is exactly the "fill
// where I dragged" a paint tool needs (diagonal moves paint a diagonal line,
// not a filled rectangle).
export function cellsAlongLine(
  x0: number, z0: number, x1: number, z1: number
): Array<{ x: number; z: number }> {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(z1 - z0));
  const out: Array<{ x: number; z: number }> = [];
  let prevX = x0;
  let prevZ = z0;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = Math.round(x0 + (x1 - x0) * t);
    const z = Math.round(z0 + (z1 - z0) * t);
    if (x === prevX && z === prevZ) continue;
    out.push({ x, z });
    prevX = x;
    prevZ = z;
  }
  return out;
}
