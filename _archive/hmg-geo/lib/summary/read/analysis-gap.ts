// 분석 갭 임계 — **정본은 여기 하나다** (2026-09-11, PR③ F1).
//
// 종전에는 같은 0.05 가 세 곳에 따로 적혀 있었다: `scripts/summary/generate-cycle.ts`
// (`--pending` 이 뽑을 회차의 조건) · `scripts/summary/surface-global.ts`(적재 거부 임계) ·
// 그리고 `lib/summary/generate/cycle.ts` 의 SQL 에 인자로 흘러가는 값. 여기에 **읽기 쪽**
// (`cycle-set.ts` 의 "생성기가 영원히 안 뽑을 회차 = 구멍이 아니라 미발행 확정" 판정)이
// 네 번째로 필요해지면서, 값을 또 복제하는 대신 중립 leaf 모듈로 올린다.
//
// `server-only` 를 **달지 않는다** — 생성기 스크립트(tsx)와 읽기 경로가 함께 쓴다.

/**
 * 회차를 발행(생성)해도 되는 분석 갭 상한.
 *
 * `summary_cycles.analysis_gap_ratio` = 그 회차 답변 중 **분석이 안 붙은 비율**이다.
 * 이 값을 넘으면 생성기가 `--pending` 에서 **뽑지 않는다**(`generate-cycle.ts` 의
 * `analysis_gap_ratio <= gapMax`) — 즉 scope 분석 백필이 오기 전에는 영원히 안 뽑힌다.
 * 그 사실이 읽기 쪽 판정에도 필요하다: 그런 회차는 "아직 안 만들어진 구멍" 이 아니라
 * **미발행이 확정된 회차**이므로, 기간 조회는 그 앵커를 빼고 나머지로 시계열을 낸다.
 */
export const ANALYSIS_GAP_MAX = 0.05;
