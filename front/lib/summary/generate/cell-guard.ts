/**
 * 셀 선택 가드 — "굳힌 `cycle_jobs` 수가 관측 완료 셀 수와 같은가".
 *
 * 스크립트에서 빼낸 **순수 판정**이다. 원래는 `surface-website.ts` 안에 인라인이라
 * 픽스처로 고정할 수 없었고, 그래서 그레인이 어긋난 채 실전에서야 드러났다
 * (2026-09-10: `cycle_jobs(200) ≠ completed_units(345)` 로 백필 정지).
 *
 * 그레인 규약:
 *   · `completedRegionGrain` — 원장 카운터(`cycleCountersCte`)가 세는 값. **region 그레인**.
 *   · `completedCellGrain`   — 셀 선택과 **같은 열**(prompt_id, target, country)로 센 값.
 * 가드는 후자와만 비교한다. 둘의 차이는 결함이 아니라 **같은 셀의 재측정을 접은 수**다
 * (측정 프록시가 바뀐 주에만 > 0). 그 수는 버리지 않고 돌려주어 로그·timings 에 남긴다.
 */
export type CellGuardInput = {
  /** 굳힌 `summary_cycle_jobs` 행 수. */
  jobs: number;
  /** 완료 답변을 (prompt_id, target, region) 로 센 수 — 원장 카운터와 같은 그레인. */
  completedRegionGrain: number;
  /** 완료 답변을 (prompt_id, target, country) 로 센 수 — 셀 선택과 같은 그레인. */
  completedCellGrain: number;
};

export type CellGuardResult = {
  /** region → country 로 접힌 셀 수. 0 이 정상. */
  collapsed: number;
  /** 통과 여부. */
  ok: boolean;
};

export function checkCellSelection(i: CellGuardInput): CellGuardResult {
  // 접힘은 음수가 될 수 없다 — country 그레인은 region 그레인보다 항상 같거나 좁다.
  const collapsed = Math.max(0, i.completedRegionGrain - i.completedCellGrain);
  return { collapsed, ok: i.jobs === i.completedCellGrain };
}
