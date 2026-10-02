// ════════════════════════════════════════════════════════════════════════════
// `mirrorCache` 셀별 **회차 지문 모드** (hmg-geo PR #297 검증 반영, 2026-09-27)
// ════════════════════════════════════════════════════════════════════════════
//
// 축 on 셀 키에 싣는 회차 조각을 셀마다 고른다. 규칙은 셀 이름 하나로 정해지고, 그 규칙이
// 실제 셀 시그니처와 맞는지는 `mirror-cache-cycle-mode.test.ts` 가 `server.ts` 원문으로
// 양방향 대조한다.
//
//   · `none`   — `summary-*` 사실표 셀. 키(첫 인자)에 이미 **회차 집합 키**(`cycleKey`)가
//                들어간다(`SummaryArgs`·`GlobalSummaryArgs`·`_cycleKey`). 그 키는 요청마다
//                원장에서 다시 해소된다(`cachedWebsiteSummaryRoute` 등, React `cache`).
//                지문을 더 싣으면 앵커만 바뀐 경우에도 콜드가 되는 비용만 생긴다.
//   · `ledger` — 기간 비교 셀. 리더(`summary-period-compare.ts::ledgerScopeConds`)가 원장
//                `status`·`view_anchor_at > now()`·fleet_visible·숨김을 읽고 사실표를
//                `active_generation_id` 로 조인한다 → 그 입력을 담은 `fp_ledger`.
//   · `gate`   — 나머지 전부(미러 집계). 앵커 축 게이트(서빙·숨김·노출일) + 서빙 중 회차의
//                run 멤버십 + 서빙 중 global 회차의 세대 id 를 담은 `fp_gate`.
//                이 셀들이 원장 `status` 를 읽는 유일한 자리(`excludeHiddenCycleRuns` 원장 분기,
//                scope-aggregates.ts:3858)는 축 on 에서 도달하지 않는다(3838 에서 반환).

export type MirrorCycleMode = "none" | "gate" | "ledger";

/** 원장 전체 입력(`fp_ledger`)을 싣는 셀. */
export const LEDGER_CYCLE_CELLS: ReadonlySet<string> = new Set(["period-compare"]);

/** 회차 집합 키를 이미 인자로 받는 사실표 셀의 이름 접두사. */
export const SUMMARY_CELL_PREFIX = "summary-";

export function mirrorCycleModeOf(cell: string): MirrorCycleMode {
  if (cell.startsWith(SUMMARY_CELL_PREFIX)) return "none";
  if (LEDGER_CYCLE_CELLS.has(cell)) return "ledger";
  return "gate";
}
