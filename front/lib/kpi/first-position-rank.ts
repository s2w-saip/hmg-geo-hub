import type { FirstPositionRow } from "@/lib/db/repositories/scope-aggregates";

// ════════════════════════════════════════════════════════════════════════════
// 우선 노출도 순위표의 **정렬·경쟁 순위 규칙**
// ════════════════════════════════════════════════════════════════════════════
//
// 이 함수를 쓰는 곳은 둘이다:
//   · 미러 집계 `aggregateFirstPositionFromMirror` 의 `latest`(서버)
//   · 언급 > 우선 노출도 탭이 Overview 경쟁사 값으로 `avgPosition` 을 덮은 뒤의 재순위
//     (`standard/answer-analysis/_data/kpi-view.ts::overlayFirstPositionValues`, 클라이언트)
// 값을 덮고 나서 순위를 다른 식으로 다시 매기면 표의 순위 열과 값 열이 서로 다른 규칙이 된다.
//
// ⚠️ **사본이 하나 더 있다**: 집계층 경로의 `summary-global-trend-read.ts::rankByPosition`
//    (`S1.firstPosition`·경쟁사 행의 `toFirstPosition`). 순위 규칙(①②)은 같지만 동률·null
//    행의 이름 타이브레이커가 그쪽은 로케일 비교라 이름 순서만 다를 수 있다. 통합은 이번
//    변경 범위 밖이다(그 함수는 입력 행을 제자리에서 바꾸는 계약이라 호출부가 함께 바뀐다).
//
// `server-only` 를 붙이지 않는다: 클라이언트 뷰모델도 부른다. 입력을 변경하지 않는다(새 배열).
//
// 규칙:
//   ① `avgPosition` 오름차순 경쟁 순위. 동률은 공동 순위이고 다음 순위를 건너뛴다(1, 1, 3).
//   ② `avgPosition` 이 null 인 행은 순위도 null 이고 표 끝에 붙는다(언급 수 내림차순).
//   ③ 동률·null 행의 순서는 브랜드 이름의 **코드 단위 비교**로 고정한다(`byName`).
//      로케일 미지정 비교는 실행 환경의 ICU·기본 로케일을 따르므로 서버 렌더와 브라우저가
//      다른 순서를 낼 수 있다("use client" 탭의 hydration 불일치 여지). 이 함수는 서버 집계와
//      클라이언트 재순위가 함께 쓰므로 둘 다 로케일 무관 규칙으로 바꿨다(2026-09-28).
//      값·순위는 그대로이고, 대소문자·비라틴 이름이 동률일 때 **표시 순서만** 종전과 다를 수 있다.

/**
 * 순위표 모집단 = **언급 수 상위 N 브랜드(자사 포함)**. 우선 노출도 탭 순위표·래더·추이
 * 시리즈의 상한이고(미러 `KPI_TAB_DEFAULT_TOP_BRANDS`, 집계층 `fetchStandardKpiFirstPosition`
 * 의 `cap`), 경쟁사 미니값 4개(Overview 카드·탭 히어로)의 후보 모집단이다
 * (`lib/scope/competitor-row.ts::competitorCandidates` position 분기, 2026-09-29).
 * 세 곳이 이 값 하나를 읽는다. 타일이 순위표 밖 브랜드를 고르지 않게.
 */
export const RANK_TABLE_TOP_BRANDS = 10;

/** 로케일 무관 결정적 이름 비교(UTF-16 코드 단위). */
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function rankFirstPositionRows(
  rows: ReadonlyArray<Omit<FirstPositionRow, "rank"> & { rank?: number | null }>,
): FirstPositionRow[] {
  const rankable = rows
    .filter((r) => r.avgPosition != null)
    .sort(
      (a, b) =>
        (a.avgPosition as number) - (b.avgPosition as number) ||
        byName(a.brand, b.brand),
    );
  const rankOf = new Map<string, number>();
  rankable.forEach((r, i) => {
    const prev = rankable[i - 1];
    const prevRank = prev ? rankOf.get(prev.brand) : undefined;
    rankOf.set(
      r.brand,
      prev && prevRank != null && prev.avgPosition === r.avgPosition ? prevRank : i + 1,
    );
  });
  return rows
    .map((r) => ({ ...r, rank: rankOf.get(r.brand) ?? null }))
    .sort((a, b) => {
      if (a.rank == null && b.rank == null) {
        return b.mentions - a.mentions || byName(a.brand, b.brand);
      }
      if (a.rank == null) return 1;
      if (b.rank == null) return -1;
      return a.rank - b.rank || byName(a.brand, b.brand);
    });
}
