// AI 우선 노출도 표의 **행 순서 정본**(GGMD 고객 요구 #1, 2026-09-20).
//
// 종전 "순위별 보기" 토글은 래더 그래프만 접었다 열었다 했고 표의 행 순서는 두 상태가
// 같았다. 고객 요구는 그 반대다. 토글을 끄면 **당사가 맨 위**에 서고 그 아래에
// 타사가 붙는 "우리 기준" 목록이 되어야 한다.
//
//   · ownFirst = false (토글 ON)  = 집계가 낸 순서 그대로 = 평균 위치 오름차순.
//     집계(`scope-aggregates` latest)가 이미 avgPosition 오름차순 + 측정 없음 뒤로
//     정렬해 내려주므로 여기서는 복사만 한다.
//   · ownFirst = true  (토글 OFF) = 당사(추적 브랜드) 먼저, 각 묶음 안에서 평균 위치
//     오름차순. 당사가 여럿(Hyundai·Kia·Genesis)이면 그 안에서도 평균 위치 순이다.
//
// 값 계산은 건드리지 않는다. 이 파일은 **배열 순서만** 바꾼다. 순수 함수로 떼어 둔
// 이유는 두 상태의 순서를 단위 테스트가 고정하게 하기 위해서다(first-rank-row-order.test).

/** 이 정렬이 보는 필드만. `RankTableRow` 를 그대로 받되 결합은 이 두 개로 좁힌다. */
export interface RankOrderRow {
  isTracked: boolean;
  /** 평균 위치(낮을수록 앞). null = 측정 없음 → 언제나 묶음의 끝. */
  avgPosition: number | null;
}

/** 평균 위치 오름차순. `null`(측정 없음)은 항상 뒤. 동률은 입력 순서를 지킨다. */
function byPosition(a: RankOrderRow, b: RankOrderRow): number {
  if (a.avgPosition == null && b.avgPosition == null) return 0;
  if (a.avgPosition == null) return 1;
  if (b.avgPosition == null) return -1;
  return a.avgPosition - b.avgPosition;
}

/**
 * 표에 그릴 행 순서를 돌려준다. 입력 배열은 변형하지 않는다(항상 새 배열).
 *
 * `Array.prototype.sort` 는 안정 정렬이므로(ES2019) 같은 평균 위치끼리는 집계가 낸
 * 순서가 유지된다. 회차마다 동률 브랜드가 자리를 바꾸는 흔들림이 없다.
 */
export function orderRankRows<T extends RankOrderRow>(
  rows: readonly T[],
  opts: { ownFirst: boolean },
): T[] {
  if (!opts.ownFirst) return [...rows];
  const own = rows.filter((r) => r.isTracked).sort(byPosition);
  const others = rows.filter((r) => !r.isTracked).sort(byPosition);
  return [...own, ...others];
}
