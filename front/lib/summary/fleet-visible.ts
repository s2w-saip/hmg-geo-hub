// ════════════════════════════════════════════════════════════════════════════
// 같은 주 두 회차 중 **대표만** — 규칙 한 벌 (2026-09-18, 제품 확정)
// ════════════════════════════════════════════════════════════════════════════
//
// 관제 5단계(`summary-cycles.ts::cycleFleetSql`)가 `(표면, 프로젝트, 주)` 마다
// `fleet_visible` 을 하나만 참으로 둔다. **읽기는 그 값을 소비만 한다** — 대표 판정을
// 새로 쓰지 않는다(판정 두 벌 금지).
//
// 이 파일이 존재하는 이유는 그 소비가 **세 군데**이기 때문이다:
//   ① 추이 회차 집합  `read/cycle-set.ts::restrictToFleetVisible`
//   ② 스냅샷 픽       `db/repositories/summary-cycles.ts::pickGlobalCycle`
//   ③ 회차 사슬 감시  `health/cycle-chain.ts::judgeViewLagSurface`
// 셋이 조금씩 다르면 "화면이 내는 회차" 와 "감시가 기대하는 회차" 가 갈려 상시 오탐이
// 된다(2026-09-13 사건의 교훈: 감시가 화면과 다른 것을 보면 감시는 거짓말을 시작한다).
//
// ⚠️ 의존이 없어야 한다. `lib/db/**` 와 `lib/summary/**` 양쪽이 이 파일을 import 하므로
//    무엇이든 끌어오면 순환이 난다. 제네릭 순수 함수 하나만 둔다.

/**
 * 같은 그룹에 **대표가 있으면** 패자를 뺀다. 없으면 그 그룹은 **통째로 남긴다**.
 *
 * 두 가지를 일부러 보수적으로 둔다 — 방향이 비대칭이기 때문이다:
 *
 *   · **패자만 있는 그룹은 남긴다.** 관제가 대표를 못 찍은 병리(그 주가 전부 `false`)나
 *     대표가 숨김·미발행이라 후보에서 빠진 경우가 실재한다. 그때 그냥 거르면 **그 주가
 *     통째로 사라진다** — 결손 회차를 지우려다 주 하나를 지우는 것은 더 큰 거짓말이다.
 *     회차 건강 감시가 `fleet_visible` 을 술어로 안 거는 이유와 같다
 *     (`summary-cycle-health.ts::readCycleLedger` 머리 주석).
 *   · **`undefined` 는 대표로 본다.** 값이 안 실린 경로(tsc 밖 테스트·스크립트, 옛 배포)
 *     에서 온 항목을 패자로 접으면 점·회차가 조용히 사라진다.
 *
 * 순서는 입력 순서를 그대로 보존한다(호출부가 정렬을 쥔다).
 * 뺄 것이 없으면 **입력 배열을 그대로** 돌려준다(캐시 키·객체 동일성이 이유 없이 안 바뀌게).
 */
export function dropFleetLosers<T>(
  items: readonly T[],
  groupOf: (item: T) => string,
  visibleOf: (item: T) => boolean | undefined,
): readonly T[] {
  const isWinner = (item: T): boolean => visibleOf(item) !== false;
  if (items.every(isWinner)) return items;
  const groupsWithWinner = new Set<string>();
  for (const item of items) {
    if (isWinner(item)) groupsWithWinner.add(groupOf(item));
  }
  const kept = items.filter((item) => isWinner(item) || !groupsWithWinner.has(groupOf(item)));
  return kept.length === items.length ? items : kept;
}
