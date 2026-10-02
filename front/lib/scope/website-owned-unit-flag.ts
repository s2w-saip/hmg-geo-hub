import "server-only";
import { summaryScreenAllowed } from "@/lib/summary/read/screens";

// ════════════════════════════════════════════════════════════════════════════
// website 자사 판정의 **단위** — 화면 키 `X.websiteOwnedUnit`
// + **프리뷰 전용** env `WEBSITE_OWNED_UNIT_FORCE`
// ════════════════════════════════════════════════════════════════════════════
//
// off  = 종전 flat 집합(`websiteDeclaredOwnedBases` 의 평면 합집합). **SQL 바이트 동일**
//        (77111d0 대비 10형태 교차커밋 실증 + `website-owned-unit.off-sql.snapshot.test.ts`
//         가 문장 텍스트를 스냅샷으로 고정한다).
// on   = 그 프롬프트가 속한 **유닛의 base + 그 유닛의 타겟 집합** 으로 판정
//        (리포트 추출기 `extract-citation-data.mts:83` 의 `OWNED` 와 같은 정의).
//
// ── 왜 키가 필요한가 ───────────────────────────────────────────────────────
// flat 로직은 **프로덕션 main 에도 있다**(`git show origin/main:lib/db/repositories/
// scope-aggregates.ts` 의 `websiteDeclaredOwnedBases`, `SELECT DISTINCT wp.owned_base_url`).
// 그러므로 이 변경은 지금 고객이 보고 있는 숫자를 바꾼다 — 자사 URL 인용률이 함대
// 90.22% → 78.62%, 리포트 '완료' 13개가 91.30% → 80.23%. 값이 **리포트 쪽으로 맞는**
// 방향이지만, 값 변경은 운영 결정이라 스위치 없이 켜지면 안 된다.
//
// ── 왜 키가 **하나**인가 ───────────────────────────────────────────────────
// 같은 화면에 두 정의가 섞이면 안 된다. website 인용 화면만 해도 자사 URL 인용률·
// owned 배지·promptSplit·공식 당사 인용 비중이 같은 판정을 써야 하고, Overview 의
// ⑤·⑥·서브 KPI·추이도 같다. 지표별로 키를 쪼개면 "자사 42%인데 자사 인용 프롬프트가
// 90%" 같은 상태가 만들어진다.
//
// ── 왜 env 오버라이드가 필요한가 ───────────────────────────────────────────
// 화면 키는 `summary_settings` 한 행에서 오는데 프리뷰와 프로덕션이 같은 DB 를 읽는지
// 미확인이다(기간 비교 Δ 설계 §11-2). 프리뷰에서 보려고 키를 켜면 프로덕션에도 켜질
// 수 있으므로, 프리뷰에서만 작동하는 두 번째 경로를 둔다. 값만 보지 않고 **환경을
// 먼저** 본다 — 프로덕션에 변수가 실수로 설정돼도 판정은 바뀌지 않는다.
//
//
// ── 배선 현황 (2026-09-20 완료) ────────────────────────────────────────────
// website 표면에서 flat 합집합을 읽던 자리를 **전부** 옮겼다. 키 하나로 함께 움직인다:
//   · `aggregateStandardFromMirror`          — KPI ⑤ 자사 인용 비중 · 도메인 행 `isOurs`
//   · `aggregateSubKpisFromMirror`           — S4 서브 KPI(`citOwned`)
//   · `aggregateStandardTrendFromMirror`     — ⑤ 추이
//   · `aggregateCitationsFromMirror`         — owned 배지 · promptSplit · officialOwnShare
//                                              · 프롬프트 드릴다운 `owned_cites`
//   · `aggregateSourceCompositionFromMirror` — 출처 구성 도넛 `isOurs`
//   · `websiteCitationJudgmentCtes`          — ⑥ 카드·추이의 **분모**(자사 인용 답변)
//   · `aggregateWebsiteTargetHitRate`        — 자사 URL 인용률·타겟 URL 인용률 카드
//   · `subKpisPrevImpl`(server.ts)           — Δ 비교 기준 스냅샷(현재 값과 같은 정의여야 한다)
// 캐시도 함께 간다 — `mirrorCache(..., ownedUnitAware = true)` 가 키에 `owned-unit` 조각을
// 붙여, 켠 직후 TTL 동안 "어떤 타일은 유닛·옆 타일은 flat" 이 되는 것을 막는다.
//
// ⚠️ **끌 때도 한 번에 꺼진다** — 키가 off 면 위 자리의 SQL 이 글자 그대로 종전이다.
//    그 성질은 세 겹으로 고정한다: `website-owned-unit.sql-shape.test.ts` ①'(같은 커밋 안
//    "인자 무해") · `website-owned-unit.off-sql.snapshot.test.ts`(**커밋 가로지르기**) ·
//    `owned-unit-statements.pglite.test.ts`(on 문장이 진짜 파서를 통과하는가).
//
// ⚠️ **⑥ 의 분자는 일부러 flat 이다.** 타겟 도달(`target`)은 화면 스코프의 타겟 집합을
//    쓰고(그쪽 주석의 "⑥ 가 flat 집합을 쓰는 것과 의도적으로 다르다"), 분모만 유닛으로
//    옮겼다. 분모를 분자보다 좁히면 비율이 100% 를 넘을 수 있다.
//
// ⚠️ **"website 표면 전체" 는 미러 경로에 한정된 말이다** (2026-09-20 검증 B). 같은 화면의
//    사실표(`summary_*`) 타일과 기간 비교 Δ 는 **이 키가 아니라 `summaryUnitFlagsAvailable()`**
//    (= `summary_answers.unit_owned` 컬럼 존재, 0060)이 스위치다. 정의는 양쪽 다 리포트 쪽이라
//    둘 다 참이면 정합하고, **키 on + 그 컬럼 없음** 조합에서만 두 정의가 남는다 —
//    그 조합은 `server.ts::warnIfOwnedUnitDefinitionSplit` 이 로그로 소리를 낸다.
//
// 전후 차이의 규모는
// `notes/hmg-anchor-table/website-citation-parity/W7-owned-unit-dashboard-formula.sql`
// 이 사이트별로 낸다(`cit_owned_*`·`k6_den_*`·`split_uncited_*` 열).
//
// ⚠️ `NEXT_PUBLIC_` 접두사를 붙이지 않는다 — 이 값은 서버에서만 읽힌다.

/** 유닛 단위 자사 판정을 켜는 화면 키. */
export const WEBSITE_OWNED_UNIT_SCREEN_KEY = "X.websiteOwnedUnit" as const;

/** 이 배포에서 env 오버라이드를 읽어도 되는 환경인가. */
export function websiteOwnedUnitOverrideAllowedHere(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.VERCEL_ENV) return env.VERCEL_ENV === "preview";
  // Vercel 밖(로컬 dev·테스트 러너)에서는 development 만 허용한다.
  return env.NODE_ENV === "development";
}

/** env 오버라이드가 **지금 켜져 있는가**. 환경 검사까지 포함한 최종 판정. */
export function websiteOwnedUnitForced(env: NodeJS.ProcessEnv = process.env): boolean {
  return websiteOwnedUnitOverrideAllowedHere(env) && env.WEBSITE_OWNED_UNIT_FORCE === "1";
}

/**
 * 이 요청에서 website 자사 판정을 유닛 단위로 하는가.
 *
 * 한 요청 안에서 **같은 값**이어야 한다(위 "키가 하나인 이유"). 호출부는 동기 SQL
 * 빌더가 아니라 `ensureWebsiteOwnedUnit()` 을 통해 읽는다 — 그 계약은
 * `website-owned-unit-state.ts` 머리 주석 참조.
 */
export async function websiteOwnedUnitEnabled(): Promise<boolean> {
  if (websiteOwnedUnitForced()) return true;
  return summaryScreenAllowed(WEBSITE_OWNED_UNIT_SCREEN_KEY);
}
