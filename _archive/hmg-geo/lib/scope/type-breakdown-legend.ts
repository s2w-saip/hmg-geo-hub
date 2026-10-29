/**
 * 유형별 100% 스택 막대의 **기타 브랜드 색 배정**과 **범례 파생** (GEO-5).
 *
 * ── 왜 분리했나 ──────────────────────────────────────────────────────────
 * 종전에는 색을 각 유형 행 안에서의 **순위 index** 로 배정해서, 같은 브랜드가
 * 행마다 다른 색으로 그려졌다. 그 상태에서는 범례를 만드는 것 자체가 불가능하다
 * ("Honda 는 무슨 색인가"에 답이 없다). 순수 함수로 빼서 **행 간 색 안정성**과
 * **범례 ↔ 막대 일치**를 테스트로 고정한다.
 */

/** 전체 합계 상위 N개 기타 브랜드에 색을 고정 배정한다. */
export function assignOtherColors(
  brandTotals: ReadonlyArray<{ brand: string; total: number }>,
  colors: readonly string[],
): Map<string, string> {
  const out = new Map<string, string>();
  [...brandTotals]
    .filter((b) => b.total > 0)
    .sort((a, b) => b.total - a.total || a.brand.localeCompare(b.brand))
    .slice(0, colors.length)
    .forEach((b, i) => out.set(b.brand, colors[i]));
  return out;
}

/** 그려진 세그먼트에서 범례를 만든다 — 색 기준 중복 제거, 첫 등장 순서 유지. */
export function legendFromSegments(
  rows: ReadonlyArray<{ segs: ReadonlyArray<{ label: string; val: number; color: string }> }>,
): Array<{ color: string; label: string }> {
  return [
    ...new Map(
      rows
        .flatMap((r) => r.segs)
        .filter((s) => s.val > 0)
        .map((s) => [s.color, { color: s.color, label: s.label }]),
    ).values(),
  ];
}
