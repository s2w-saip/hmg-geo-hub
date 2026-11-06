// Treemap tile geometry (display only: the values and their order come from the API).

/** Squarified treemap (Bruls et al.): items sorted desc → rects inside (x, y, w, h). */
export function squarify<T extends { value: number }>(items: readonly T[], x: number, y: number, w: number, h: number): Array<T & { x: number; y: number; w: number; h: number }> {
  const out: Array<T & { x: number; y: number; w: number; h: number }> = [];
  const total = items.reduce((s, i) => s + i.value, 0);
  if (total <= 0 || w <= 0 || h <= 0) return out;
  const scale = (w * h) / total;
  let rest = items.map((i) => ({ item: i, area: i.value * scale }));
  let rx = x,
    ry = y,
    rw = w,
    rh = h;
  const worst = (row: number[], side: number) => {
    const s = row.reduce((a, b) => a + b, 0);
    const max = Math.max(...row),
      min = Math.min(...row);
    return Math.max((side * side * max) / (s * s), (s * s) / (side * side * min));
  };
  while (rest.length) {
    const side = Math.min(rw, rh);
    const row: typeof rest = [rest[0]];
    let i = 1;
    while (i < rest.length && worst([...row, rest[i]].map((r) => r.area), side) <= worst(row.map((r) => r.area), side)) row.push(rest[i++]);
    const sum = row.reduce((s, r) => s + r.area, 0);
    if (rw >= rh) {
      const cw = sum / rh;
      let cy = ry;
      for (const r of row) {
        const ch = r.area / cw;
        out.push({ ...r.item, x: rx, y: cy, w: cw, h: ch });
        cy += ch;
      }
      rx += cw;
      rw -= cw;
    } else {
      const ch = sum / rw;
      let cx = rx;
      for (const r of row) {
        const cw = r.area / ch;
        out.push({ ...r.item, x: cx, y: ry, w: cw, h: ch });
        cx += cw;
      }
      ry += ch;
      rh -= ch;
    }
    rest = rest.slice(i);
  }
  return out;
}
