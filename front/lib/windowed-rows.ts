/** Variable row offsets without retaining off-screen row content. */
export class RowHeights {
  private tree: Float64Array;
  private measured = new Map<number, number>();
  constructor(readonly count: number, readonly estimate: number) { this.tree = new Float64Array(count + 1); }
  offset(index: number): number {
    let result = Math.min(index, this.count) * this.estimate;
    for (let n = Math.min(index, this.count); n > 0; n -= n & -n) result += this.tree[n];
    return result;
  }
  measure(index: number, height: number): boolean {
    if (index < 0 || index >= this.count || !Number.isFinite(height) || height <= 0) return false;
    const before = this.measured.get(index) ?? this.estimate;
    if (Math.abs(before - height) < .5) return false;
    this.measured.set(index, height);
    for (let n = index + 1; n <= this.count; n += n & -n) this.tree[n] += height - before;
    return true;
  }
  indexAt(offset: number): number {
    let lo = 0, hi = this.count;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (this.offset(mid + 1) <= offset) lo = mid + 1;
      else hi = mid;
    }
    return Math.min(lo, Math.max(0, this.count - 1));
  }
}
