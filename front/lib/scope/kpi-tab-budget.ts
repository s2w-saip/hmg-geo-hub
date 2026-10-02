// 4-KPI 탭 집계의 **소비 규약** — 예산·창·degrade 판정·Sub KPI 파트 선택.
//
// server.ts 본문에서 떼어낸 이유는 두 가지다: (1) 이 규칙들이 "얼마나 기다리고,
// 무엇을 삼키고, 무엇을 다시 던지는가"라는 정책이라 테스트로 고정돼야 하고,
// (2) server.ts 는 DB·Supabase 를 끌고 오므로 정책만 검증하려면 무거운 모듈을
// 통째로 적재해야 한다. 런타임 의존은 없다(아래 파트 타입도 type-only import).

import type { SubKpiPart } from "@/lib/db/repositories/scope-aggregates";

// ── 예산 (2026-09-01 재검증 C1·C2 이후) ─────────────────────────────────────
//
// 상한이 두 종류라는 것이 핵심이다. 종전에는 8s 하나만 두고 "집계가 8s 를 넘지
// 않는다"고 적었는데 **거짓이었다**: `statement_timeout` 은 문장당이고 한 단계가
// 여러 문장(2026-09-01 실측: 스냅샷 단계 6개·추이 단계 7개)을 발행하므로, 8s 는 단계당
// 최악 ~32s 를 뜻했다. 이제 문장 상한과 벽시계 예산을 분리하고, 정직한 식은:
//
//     실효 최악 = budgetMs + KPI_TAB_STATEMENT_TIMEOUT_MS
//
// (마감 직전에 보낸 문장 하나는 끝까지 기다려야 한다 — 진행 중 문장은 취소 못 한다.)

/**
 * 문장 하나의 상한(ms) — 진짜 `statement_timeout`.
 *
 * 2026-09-02 상향(8s → 20s). **8s 의 근거가 틀린 측정이었다.** 종전 주석은
 * "최장 문장은 엔진 추이의 멘션 조인 4.44s" 라 적었는데, 그 수치는 프로덕션
 * 경로(TEMP TABLE + ANALYZE)가 아니라 MATERIALIZED CTE 하네스로 잰 것이라
 * 비용 귀속이 틀렸다(같은 하네스가 ROLLUP_NAMES 를 ~1s 로 오진했다 — 실제 19ms).
 *
 * 실제 경로로 다시 재니 엔진 추이의 개별 문장이 **warm 8~10.6s** 다. 즉 8s 상한은
 * 최적화를 다 하고도 **매번 문장을 죽이고 있었다** — 2026-09-02 프리뷰에서 히어로
 * 스칼라(36.7%)는 정상인데 우측 추이만 계속 비던 것이 그 발현이다. 벽시계 예산을
 * 24s→60s 로 키워도 결과가 같았던 것도 같은 이유다(A/B 실증: 등장 시각·degrade
 * 여부 동일). **범인은 예산이 아니라 이 상수였다.**
 *
 * 산정: warm 최장 10.6s × 콜드 1.7 = 18.0s → 20s (여유 ~10%).
 * 실효 최악 = ENGINE_BUDGET + 이 값 = 50s 로 페이지 `maxDuration`(120s) 안.
 *
 * ⚠️ 이 값을 다시 올리는 것으로 느려진 문장을 덮지 마라. 자주 발동한다면 집계가
 * 회귀했다는 신호다 — **프로덕션과 같은 TEMP TABLE 경로로** EXPLAIN 하라
 * (CTE 하네스로 재면 이 주석이 한 번 겪은 오진을 반복한다).
 */
export const KPI_TAB_STATEMENT_TIMEOUT_MS = 20_000;

// ── 벽시계 예산 (2026-09-01 프로덕션 EXPLAIN 실측 근거) ──────────────────────
//
//   엔진 1단계(스냅샷)  CREATE TEMP 0.93s + ANALYZE ~0.05s + 답변 0.24s + 멘션 1.75s ≈ 2.97s
//   엔진 2단계(추이 84일) CREATE TEMP 0.20s + ANALYZE ~0.05s + 답변 0.98s + 멘션 4.44s ≈ 5.67s
//   합 ≈ 8.6s
//
// 종전의 "두 단계 합 8s" 는 실측을 넣어보면 **애초에 들어가지 않는 값**이었다
// (재검증 C2: 1단계가 2.97s 라 2단계에 4.9s 밖에 안 남는데 5.67s 가 필요했다 —
// 무필터 warm 로드에서도 추이가 degrade 됐을 것이다).

// ── 2026-09-02 재조정: 예산이 캐시를 굶기고 있었다 ─────────────────────────
//
// 구조가 `kpiDegrade(… cachedX(…) …)` 라 **캐시가 안쪽, degrade 가 바깥쪽**이다.
// 그래서 집계가 예산에 걸려 throw 되면 `unstable_cache` 는 값을 저장하지 못하고,
// 다음 요청도 캐시 미스로 **전체 비용을 처음부터 다시** 치른다. 한 번도 성공하지
// 못하면 캐시가 영영 안 채워지는 **악순환**이 된다 — 2026-09-02 프리뷰에서
// 노출률 탭 추이가 최적화 3라운드 뒤에도 계속 비어 있던 진짜 이유가 이것이다.
// (개별 쿼리는 이미 9s 이하로 내려왔고 19.8s 짜리는 소멸했다. 그런데도 한 지면이
//  45개 쿼리·79콜을 던지고 서로 경합하면서 20s 예산을 못 지켰다.)
//
// 그래서 예산의 역할을 다시 정의한다: 이것은 **"이 요청을 포기한다"는 상한**이지
// 성능 목표가 아니다. 페이지가 죽는 것을 막는 진짜 안전망은 `maxDuration`(120s)
// 이고, 그 안에서 **한 번만 성공하면 이후 30분(MIRROR_CACHE_TTL)은 캐시 히트로
// 즉시** 응답한다. 매번 20s 를 쓰고도 빈 화면을 주는 것보다, 첫 요청이 한 번
// 오래 걸리고 그 뒤가 빠른 쪽이 낫다.
//
// ⚠️ 그러므로 이 값을 다시 올리는 것으로 **느려진 쿼리를 덮지 마라**. 예산이 자주
// 발동한다면 그건 집계가 회귀했다는 신호다 — EXPLAIN 으로 원인을 찾아라.

// ── 2026-09-02 후속 재조정: 섹션이 독립되면 상한이 덜 치명적이다 ─────────────
//
// 위 "악순환" 설명은 그대로 유효하다(캐시가 안쪽·degrade 가 바깥쪽이라 실패는
// 캐시를 못 채운다). **바뀐 것은 초과의 대가다.** 같은 날 KPI 탭 본문을
// `Promise.all` 하나에서 **섹션별 <Suspense> 경계**로 쪼갰다
// (mention/page.tsx · mention-kpi-tab.tsx). 이전에는 한 집계가 예산에 걸리면
// 그 지면만이 아니라 **탭 전체가 그만큼 늦어졌다** — 경계가 하나라 스칼라·표까지
// 인질이었다. 그래서 예산을 "웬만하면 걸리지 말라"는 뜻으로 크게 잡았다(60s/40s).
//
// 이제는 히어로 스칼라·경쟁사 표·엔진·유형이 각자 도착한다. 느린 하나가 예산에
// 걸려도 나머지 세 지면은 이미 그려져 있고, 걸린 지면만 대체 문구가 된다.
// 즉 예산 초과 = "한 섹션의 degrade"이지 "빈 화면"이 아니다. 60s/40s 는 이제
// **degrade 를 영원히 미루는 값**일 뿐이다 — 사용자는 그 사이 빈 카드를 본다.
//
// 하향이 안전한지는 **A/B 로 확인했다**(2026-09-02, 로컬 프로덕션 빌드 + 매번
// `.next/cache` 삭제한 콜드 로드, 무필터):
//   A) 엔진 24s / 단일 18s → 엔진 19.0s · 유형 22.6s · 히어로·경쟁사 29.9s
//   B) 엔진 60s / 단일 18s → 엔진 19.0s · 유형 21.7s · 히어로·경쟁사 29.4s
// 두 회차 모두 히어로 우측 추이는 degrade 됐고 **결과가 동일했다** — 즉 이 환경의
// 추이 degrade 는 벽시계 예산이 아니라 문장 상한(8s)에서 나온다. 예산을 60s 로
// 들고 있어도 얻는 것이 없다는 뜻이다.
// ⚠️ 이 A/B 는 노트북 → ap-south-1 풀러 경로라 왕복 지연이 프로덕션보다 크다.
// 절대 시각이 아니라 **A와 B의 차이가 없다**는 것만 근거로 쓸 것.
//
// 산정식(이 라운드에서 고정):
//     예산 = warm 실측 × 콜드 배수 1.7 × 여유 1.3
// 콜드 배수 1.7 은 2026-09-02 pg_stat_statements 리셋 후 콜드 1회 실측에서
// 나온 값이고, 여유 30% 는 동시 요청 경합분이다.
//
//   엔진      10.8s × 1.7 × 1.3 = 23.9s  →  **24s**
//   브랜드추이  7.5s × 1.7 × 1.3 = 16.6s  →  **18s**(단일 예산 = 둘 중 큰 쪽)
//   유형       4.2s × 1.7 × 1.3 =  9.3s   (18s 안에 여유롭게 들어온다)
//
// 실효 최악은 여전히 `budgetMs + KPI_TAB_STATEMENT_TIMEOUT_MS` 이므로
// 엔진 32s · 단일 26s 이고, 페이지 `maxDuration` 120s 안이다. 세 집계가 동시에
// 최악을 쳐도 경계가 각자라 서로를 밀지 않는다.

/**
 * 엔진 집계(2단계 합)의 벽시계 예산.
 *
 * 2026-09-02 상향(12s → 20s). 이유는 성능이 나빠져서가 아니라 **예산의 성격**이다:
 * 이 값은 성능 목표가 아니라 "이 이상 걸리면 그 지면을 포기한다"는 안전망이다.
 *
 * 안전성: 실효 최악 = budgetMs + KPI_TAB_STATEMENT_TIMEOUT_MS = 50s 로,
 * 페이지 `maxDuration` 120s 안에 충분히 들어온다. 지면은 Suspense 경계 안이라
 * 셸·필터바·스칼라는 먼저 뜨고 이 섹션만 늦게 채워진다.
 *
 * ── 2026-09-02 후속: 남은 레버를 적용했고, 그래도 12s 로는 못 되돌린다 ──────
 *
 * 이 주석이 지목했던 `ansRows`+`menRows` 단일 패스 병합을 실제로 적용했다
 * (`ENGINE_KPI_PER_JOB`, 동치성 증명은 그쪽 주석 — 미러 전수 반증 포함).
 * 프로덕션 무필터 실측: **12.5s → 10.8s**(3회 중앙값, 콜드/웜 동일).
 *
 * 원복 판정(기준: warm × 1.7 ≤ 예산의 70%):
 *   10.8 × 1.7 = 18.4s.  12s 예산의 70% = 8.4s  →  **원복 불가**.
 *   현행 20s 예산 기준으로도 18.4/20 = 92% 라 여유가 크지 않다.
 *
 * 더 줄일 곳이 이 계층에 남아 있지 않다는 것이 EXPLAIN 의 결론이다. 병합 후 남은
 * 비용은 식 평가가 아니라 **행 인출**이다 — 언급 조인 Nested Loop 2,999 ms
 * (853,909행 · shared hit 403,486 · 100,130 loops). 커버링 인덱스로 index-only
 * scan 을 만드는 안은 loop 당 4.03 페이지 중 힙이 1 페이지뿐이라 상한이 ~25%,
 * 대가는 ~200MB 인덱스 + 미러 동기화 쓰기 증폭이라 기각했다.
 *
 * ⚠️ 다음 사람에게: 이 값을 **또 올려서 덮지 마라**. 다음 절감은 이 계층이 아니라
 * 모집단·저장 계층에서 온다(답변셋 창 축소, 또는 job 단위 언급 사전집계 테이블).
 *
 * ── 2026-09-02 하향(60s → 24s) ──────────────────────────────────────────────
 * 성능이 좋아져서가 아니라 **섹션별 스트리밍으로 초과의 대가가 작아져서**다
 * (위 재조정 블록). 근거: warm 10.8s × 콜드 1.7 × 여유 1.3 = 23.9s.
 * 종전의 원복 판정 기준(콜드 추정 ≤ 예산의 70%)으로는 18.4 / 24 = 77% 라 아슬하다.
 * 그 기준을 여기서 완화하는 이유를 분명히 적어 둔다: 그것은 **초과 = 빈 화면**이던
 * 단일 경계 시절의 안전율이다. 지금 초과는 이 섹션 하나의 degrade 이고 히어로·
 * 경쟁사 표는 이미 그려져 있다. 대신 여유분(×1.3)을 산정식에 명시적으로 넣었다.
 */
export const KPI_TAB_ENGINE_BUDGET_MS = 30_000;

/**
 * 단일 단계 집계(브랜드 추이·유형)의 벽시계 예산.
 * 2026-09-02 상향(9s → 12s) — 최적화 후 warm 실측 brandTrend 5.5s · typeKpi 4.4s
 * 로 여유가 있으나, 콜드 배수(~1.7)를 곱하면 9.4s/7.5s 라 brandTrend 가 종전
 * 예산을 넘긴다. 엔진 예산과 같은 취지(안전망이지 성능 목표가 아니다).
 *
 * 2026-09-02 재측정(pg_stat_statements 리셋 후 콜드 1회): brandTrend 7.5s ·
 * typeKpi 4.2s. brandTrend × 1.7 = 12.7s 로 이 예산을 살짝 넘으므로 9s 로는
 * 되돌릴 수 없고 12s 도 여유가 없다 — 두 집계는 이 라운드의 대상이 아니었다.
 *
 * ── 2026-09-02 하향(40s → 18s) ──────────────────────────────────────────────
 * 엔진 예산과 같은 이유(섹션별 스트리밍 — 위 재조정 블록). 이 예산은 두 집계가
 * 공유하므로 **느린 쪽**으로 잡는다: brandTrend 7.5s × 1.7 × 1.3 = 16.6s → 18s.
 * typeKpi 는 4.2s × 1.7 × 1.3 = 9.3s 라 여유가 크다.
 */
export const KPI_TAB_SINGLE_BUDGET_MS = 24_000;

// ── 무거운 미러 read 의 예산 (E-2, 2026-09-10) ─────────────────────────────
//
// 위 KPI 탭 예산과 **같은 규약**(문장 상한 + 벽시계 마감, 실효 최악 = 합)이고 값만
// 다르다. 여기 상수를 따로 두는 이유는 대상이 다르기 때문이다: KPI 탭 집계는
// `withAnswerSet` 트랜잭션 하나짜리지만, 인용(S3) 계열은 **문장 10개를 병렬 발행**하는
// 미러 집계라 문장당 비용이 크고 총합이 길다.
//
// ── 왜 필요했나 (T12 프리뷰 실측, 2026-09-10) ───────────────────────────────
// `/ko/standard/answer-analysis/citation`(S3 · `cumulative:true` → 미러 경로)이
// Vercel 함수 상한 **120 s 를 2회 초과**해 HTML 이 절단됐다 — 1,519 KB → **319 KB**,
// 로그 `Task timed out after 120 seconds`. P1 22.5~120.7 s. `mirrorCache` TTL(7,200 s)
// 만료 뒤 **첫 사용자가 잘린 페이지를 받는** 경로다. 예산이 없으면 degrade 도 못 하고
// 그냥 잘린다 — 절단은 빈 화면보다 나쁘다(부분 HTML 은 하이드레이션도 깨진다).
//
// ── 산정 (EXPLAIN ANALYZE, warm, 2026-09-10 `scripts/summary/explain-s3.ts --mirror`) ──
//   `aggregateCitationsFromMirror` 문장 10개 합 **25,179 ms**, 최장 문장 **6,271 ms**.
//   문장  6.27 s × 콜드 1.7 × 여유 1.3 = 13.9 s  →  **15 s**
//   페이지 25.2 s × 콜드 1.7          = 42.8 s  →  **45 s**
//   실효 최악 = 45 + 15 = **60 s** < `maxDuration` 120 s. 섹션이 각자 Suspense 경계라
//   한 섹션이 최악을 쳐도 나머지는 이미 그려져 있다.
//
// ⚠️ 이 값을 올려서 느려진 집계를 덮지 마라 — KPI 탭 상수 주석의 경고와 같다.
//    S3 의 근본 해결은 집계층 전환이고(같은 EXPLAIN 에서 미러 29,175 ms vs 집계층
//    478 ms), 이 예산은 그때까지 **절단을 degrade 로 바꾸는 안전망**이다.

/** 무거운 미러 read 의 문장 상한(진짜 `statement_timeout`). */
export const MIRROR_HEAVY_STATEMENT_TIMEOUT_MS = 15_000;

/** 무거운 미러 read 의 벽시계 예산(한 페처 기준). */
export const MIRROR_HEAVY_BUDGET_MS = 45_000;

/**
 * 위 예산을 그대로 실은 `AnswerSetBudget` — **호출 시점**에 마감을 계산한다.
 *
 * ⚠️ 반드시 캐시 콜백 **안에서** 부를 것. 모듈 로드 시점이나 캐시 키 자리에서 만들면
 *    (a) 마감이 프로세스 기동 시각 기준이 되고 (b) `Date.now()` 가 캐시 키에 섞여
 *    셀이 매 요청 갈린다.
 */
export function mirrorHeavyBudget(
  profile: MirrorHeavyProfile = "citationsGlobal",
  // `statementTimeoutMs` 가 없는 프로파일이 있다(`mentionsJs` — 전송 지배라 문장 상한을
  // 걸면 정상 결과를 죽인다). 소비처(`budgetedMirrorDb`·`budgetedReader`)는 둘 중
  // 하나만 있어도 그것만 집행한다.
): { statementTimeoutMs?: number; deadlineAt: number } {
  const p = MIRROR_HEAVY_PROFILES[profile];
  return {
    statementTimeoutMs: p.statementTimeoutMs,
    deadlineAt: Date.now() + p.budgetMs,
  };
}

// ── S1 대시보드 extras 예산 (2026-09-10, PR③-a) ────────────────────────────
//
// `/ko/dashboard` 의 **첫 캐시 채움 요청**이 `Vercel Runtime Timeout Error: Task timed
// out after 120 seconds` 로 죽었다(프리뷰 8465aa9 런타임 로그). 그때 헤더는
// `x-hmg-summary(global S1.dashboard): hit` 이었다 — **집계층이 아니라 미러 extras** 가
// 범인이다. 그 지면은 두 Suspense 경계로 갈려 있고 각각이 미러 read 를 띄운다:
//
//   dashboard:kpi-extras       Δ 롤업 + 주 버킷 추이  = `fetchStandardTrend` ×2
//   dashboard:kpi-competitors  언급 + 스파크 + 순위 + 인용 도메인
//
// 문제는 **상한이 없거나(둘) 너무 컸다는 것(둘)** 이다:
//
//   | 경로 | 종전 상한 | 실효 최악 | warm 실측(2026-09-10, 세션 5432) |
//   | --- | --- | --- | --- |
//   | `fetchStandardTrend` | **없음** | ∞ | **55.6 s** (주 버킷) |
//   | `fetchStandardMentions` | **없음** | ∞ | **55.0 s** |
//   | `fetchStandardKpiFirstPosition` | 30 s + 20 s | 50 s | 19.2 s |
//   | `fetchStandardKpiBrandTrend` | 24 s + 20 s | 44 s | 8.9 s |
//
// 상한 없는 둘이 각자 55 s 를 쓰고, 상한 있는 둘이 최악 50 s·44 s 를 쓰면서 서로 경합하면
// 120 s 는 쉽게 넘는다. 게이트 ON 콜드 프리뷰에서 extras 36.6~40.6 s · 경쟁사 23~26 s
// 였고, **첫 채움 요청**은 캐시 쓰기·동시 실행이 겹쳐 그보다 느리다.
//
// 산정: **이 4경로의 실효 최악을 45 s 로 묶는다.**
//     경로별 최악 = MIRROR_EXTRAS_BUDGET_MS + MIRROR_HEAVY_STATEMENT_TIMEOUT_MS
//                 = 30 s + 15 s = **45 s**
//
// ⚠️ **이것은 페이지 보장이 아니다.** 초판 주석은 "두 경계가 병렬이므로 페이지 벽시계 ≈
//    경로별 최악의 최대값 ≤ 60 s" 라고 적었는데 **프리뷰에서 반증됐다**: `/ko/dashboard`
//    콜드 18건 중 **3건이 120.5 s 로 절단**됐고, 절단 응답에는 `dashboard:filters` 만
//    도착하고 `kpi-cards` 가 오지 않았다. 죽은 곳은 캡을 씌운 extras 가 아니라
//    **무예산 경계** — 카드의 미러 폴백(`server.ts` `cachedStandardAggregates`)과
//    `summary-global-*` 집계 읽기에는 `statement_timeout` 이 **0건**이다.
//    페이지 최악은 그 경로들에 예산이 붙어야 계산 가능해진다 → **PR③ 위생 A**.
// 문장 상한은 S3 과 같은 값을 쓴다(`MIRROR_HEAVY_STATEMENT_TIMEOUT_MS`) — 같은 미러
// 계열이고 최장 문장 규모도 같은 자릿수(언급 조인 9.2 s 실측)다.
//
// 이 라운드의 값어치를 정직하게 적어 둔다: `brandTrend` 의 실효 최악은 44 s → **45 s 로
// 오히려 1 s 늘었다**. 얻는 것은 미세 조정이 아니라 **상한 없던 둘(추이·언급)에 상한이
// 생기고, 네 경로가 한 캡을 공유해 페이지 최악이 계산 가능해진 것**이다.
//
// ⚠️ 이 예산에서는 **warm 55 s 짜리 두 경로가 콜드에 degrade 될 수 있다.** 그것이 의도다 —
//    종전 동작은 degrade 가 아니라 **페이지 전체가 120 s 로 죽는 것**이었다. 카드 본체
//    (①~⑤ 값·모수)는 집계층이라 영향이 없고, 빠지는 것은 Δ 배지·스파크라인·경쟁사 행뿐이다.
//    근본 해결은 그 둘의 집계층 전환이고(추이는 `axes.cycle`, 언급은 S2 전환) 이 예산은
//    그때까지 **죽는 대신 degrade 하는** 안전망이다.

/** S1 대시보드 extras(추이·언급·스파크·순위)의 벽시계 예산(경로당). */
export const MIRROR_EXTRAS_BUDGET_MS = 30_000;

/** 위 예산 + S3 과 공유하는 문장 상한. `mirrorHeavyBudget()` 과 같은 규약(호출 시점 마감). */
export function mirrorExtrasBudget(): {
  statementTimeoutMs: number;
  deadlineAt: number;
} {
  return {
    statementTimeoutMs: MIRROR_HEAVY_STATEMENT_TIMEOUT_MS,
    deadlineAt: Date.now() + MIRROR_EXTRAS_BUDGET_MS,
  };
}

// ── 예산 지도 — 어느 경로가 어느 상한을 쓰는가 (2026-09-11 현재) ─────────────
//
// | 예산 | 문장 | 벽시계 | 실효 최악 | 쓰는 경로 |
// | --- | --- | --- | --- | --- |
// | `KPI_TAB_*` (SINGLE) | 20 s | 24 s | 44 s | 4-KPI 탭: 유형·인용 카테고리/톤/prev · 미측정 목록 · GEO KPI |
// | `KPI_TAB_*` (ENGINE) | 20 s | 30 s | 50 s | 4-KPI 탭 2단계 집계: 엔진 추이 · **S2 탭의 스파크·우선노출도**(스파크는 24→30 s 완화) |
// | `MIRROR_HEAVY_*` | 15 s | 45 s | 60 s | **S3 표준 인용**(`fetchStandardCitations`, 문장 10개·warm 25.2 s) |
// | `MIRROR_EXTRAS_*` | 15 s | 30 s | 45 s | **S1 대시보드 extras**: 추이 ×2 · **언급(경쟁사 행)** · 스파크 · 우선노출도 |
// | `…PROFILES.mentions` | 25 s | 35 s | 60 s | **S2 표준 언급 화면**(`mentionsBudgetOf("screen")`) · **S5 웹사이트 언급** |
// | `…PROFILES.citationsWide` | 20 s | 45 s | 65 s | **S6 웹사이트 인용** · **프로젝트 인용** |
// | `…PROFILES.mentionsJs` | **없음** | 75 s | 75 s + 전송 | **프로젝트 언급**(JS 경로 — 전송 지배, 아래 ⚠️) |
// | `…PROFILES.cardsMirror` | 10 s | 30 s | 40 s | **카드 미러 폴백**: S1·S4 카드(`aggregateStandardFromMirror`) · GEO 경쟁 |
// | `…PROFILES.summaryRead` | 15 s | 20 s | 35 s | **집계층 read**(`readTrendAggregates` 문장) · **게이트 프로브**(`sharedSnapshotAnswerIds`) |
// | `…PROFILES.detail` | 10 s | 20 s | 30 s | **세부층 폴백**(`onDetail` — S1 카드·S3 출처·S4 대시보드/GEO·S5 Sub-KPI·S6 출처) |
//
// (`…PROFILES` = `MIRROR_HEAVY_PROFILES` — 값과 산정 근거는 그 선언 위 실측 표.)
// **위 표에 "예산 없음" 행은 더 이상 없다.** PR③-a 가 extras 를, 위생 A 가 카드 미러
// 폴백·집계층 read·게이트 프로브·세부층 폴백을 닫았다. 남은 미적용 경로는 이 파일 아래쪽
// "아직 예산을 안 건 미러 경로" 블록이 목록으로 갖고 있다.
//
// ⚠️ **언급(`standard-mentions`)도 호출자마다 예산이 다르다** — 같은 셀을 S1 대시보드
//    경쟁사 행과 S2 언급 화면이 나눠 쓰는데, S2 는 이 집계가 **화면 본문**이라 degrade 되면
//    지면이 통째로 빈다. 그래서 `MentionsBudgetProfile` 로 갈랐고 **프로파일이 캐시 키에
//    들어간다**(안 그러면 먼저 채운 쪽의 예산으로 만든 셀을 다른 쪽이 그대로 받는다).
//    한 표에 두 행으로 나온 이유가 이것이다.
//
// ⚠️ **스파크(`brandTrend`)·우선노출도(`firstPosition`)는 호출자마다 예산이 다르다.**
//    같은 집계를 S1 대시보드 경쟁사 행과 S2 4-KPI 탭이 함께 쓰는데, S2 쪽 우선노출도의
//    실측이 **14.8~15.2 s** 라 15 s 문장 상한을 씌우면 **degrade 문턱에 걸린다**. 그래서
//    `KpiBudgetProfile` 로 갈랐고, **프로파일이 캐시 키에 들어간다** — 안 그러면 먼저
//    채운 쪽의 예산으로 만들어진 셀을 다른 쪽이 그대로 받는다.
//
// ⚠️ 정확히 말하면 S2 는 "무변경" 이 아니라 **유지 또는 완화**다(2026-09-11 재검 지적 ④).
//    `firstPosition` 은 종전 그대로(ENGINE 20 s/30 s)지만, `brandTrend` 는 base
//    (`6beb6d8`)에서 **SINGLE**(20 s/**24 s**)이었는데 프로파일이 ENGINE 으로 묶어
//    **벽시계 24 → 30 s**(실효 최악 44 → 50 s)로 **완화**됐다. 프로파일을 더 가르지
//    않는 이유는 그 방향이 안전한 쪽이기 때문이다 — 상한이 늘면 degrade 가 덜 나고,
//    S2 는 섹션별 Suspense 라 초과의 대가가 그 지면 하나다. 줄이는 변경이었다면
//    프로파일을 하나 더 만들었을 것이다.
//
// 규약은 넷 다 같다 — 문장 상한(`SET LOCAL statement_timeout`) + 벽시계 마감(문장 발행
// 전 확인), 실효 최악 = 둘의 합, degrade 는 **캐시 바깥**(그래야 저장되지 않는다).
// 값이 다른 이유는 화면마다 (a) 문장 수 (b) 동시에 도는 경로 수 (c) 초과했을 때 잃는 것이
// 다르기 때문이다. 새 경로를 붙일 때 **새 상수를 만들기 전에** 이 표에서 가장 가까운
// 성격을 먼저 찾아라.

/**
 * 같은 집계를 부르는 **호출자별 예산 프로파일**.
 *   `kpi-tab` — 4-KPI 탭(S2). 종전 값 그대로(20 s / 30 s).
 *   `extras`  — S1 대시보드 경쟁사 행·Δ. 한 경계에서 넷이 함께 도므로 더 짧다(15 s / 30 s).
 * ⚠️ 이 값은 **캐시 키의 일부**여야 한다(`cachedKpi*` 인자로 넘긴다).
 */
export type KpiBudgetProfile = "kpi-tab" | "extras";

export function kpiBudgetOf(profile: KpiBudgetProfile): {
  statementTimeoutMs: number;
  budgetMs: number;
} {
  return profile === "extras"
    ? { statementTimeoutMs: MIRROR_HEAVY_STATEMENT_TIMEOUT_MS, budgetMs: MIRROR_EXTRAS_BUDGET_MS }
    : { statementTimeoutMs: KPI_TAB_STATEMENT_TIMEOUT_MS, budgetMs: KPI_TAB_ENGINE_BUDGET_MS };
}

/**
 * 언급 헤드라인 집계(`aggregateMentionsFromMirror(..., "none")`)의 **호출자별 프로파일**
 * — 위 `KpiBudgetProfile` 과 같은 패턴이고, 같은 이유로 **캐시 키의 일부**여야 한다.
 *
 * 왜 갈랐나(PR③ 통합, 2026-09-11): 한 셀(`standard-mentions`)을 두 지면이 나눠 쓰는데
 * **초과의 대가가 다르다**.
 *   · `extras` — 대시보드 경쟁사 행. 빠져도 카드 본체(①~⑤)는 이미 그려져 있고
 *     `DegradeNotice` 가 지연을 고지한다. 그래서 짧게 가고 degrade 를 감수한다(15/30).
 *   · `screen` — S2 언급 화면. 이 집계가 **화면의 본문 그 자체**라 degrade 되면 지면이
 *     통째로 빈다. 그래서 실측이 요구하는 만큼 준다(25/35 — 산정식과 재산정 경위는
 *     `MIRROR_HEAVY_PROFILES.mentions` 주석이 정본이다).
 *
 * 문장 상한의 근거는 오폴백 방지다 — 이 집계의 최장 문장이 **warm exec 11.2 s**
 * (2026-09-17 재측정, 추이 주 격자 키가 회차 주로 바뀐 뒤)라 콜드 배수 1.7 을 곱하면
 * **19.1 s** 로 `extras` 의 문장 상한 15 s 를 넘는다. 즉 S2 를 `extras` 로 두면
 * **정상 결과가 콜드에서 죽는다**(8 s 상한이 매번 문장을 죽이던
 * `KPI_TAB_STATEMENT_TIMEOUT_MS` 주석의 사고와 같은 형태).
 *
 * ⚠️ 기본값은 **보수적인 쪽(`screen`)** 이다. 새 호출부가 옵션을 잊어도 화면이 죽지 않는
 *    방향으로 틀리게 두는 것이 이 기본값의 목적이다 — 대시보드만 명시한다.
 */
export type MentionsBudgetProfile = "screen" | "extras";

/**
 * ⚠️ 반드시 캐시 콜백 **안에서** 부를 것 — 두 갈래 다 `Date.now()` 로 마감을 만든다
 * (`mirrorHeavyBudget()` 주석과 같은 이유).
 */
export function mentionsBudgetOf(
  profile: MentionsBudgetProfile,
): { statementTimeoutMs?: number; deadlineAt: number } {
  return profile === "extras" ? mirrorExtrasBudget() : mirrorHeavyBudget("mentions");
}

/**
 * 표준 인용 미러 집계(`aggregateCitationsFromMirror`)의 호출자별 프로파일 (PR④ A3).
 *
 * 언급 셀과 **같은 문제·같은 해법**이다 — 한 셀(`standard-citations`)을 S3 인용 화면과
 * 대시보드 경쟁사 행이 나눠 쓰는데 초과의 대가가 다르다:
 *   · `screen` — S3 인용 화면. 이 집계가 화면 본문이라 degrade 되면 지면이 통째로 빈다.
 *     종전 값 그대로 `citationsGlobal`(15/45, 실효 최악 60 s).
 *   · `extras` — 대시보드 경쟁사 행의 **미러 폴백**. 그 경계는 네 read 의 실효 최악을
 *     45 s 로 묶는 것이 규약이라(`MIRROR_EXTRAS_BUDGET_MS` 주석) 60 s 짜리를 끼워 넣으면
 *     그 계산이 깨진다. 빠져도 카드 본체(①~⑤)는 이미 그려져 있다.
 *
 * 두 프로파일의 **문장 상한은 같다**(15 s) — 갈리는 것은 벽시계뿐(45 → 30 s)이다.
 * 그래서 이 분기가 정상 문장을 죽이지는 않는다: 죽는 것은 "문장 여럿을 다 돌기엔
 * 시간이 모자란" 경우이고, 그때 대시보드는 degrade 를, 화면은 완주를 택한다.
 *
 * ⚠️ 프로파일은 **캐시 키**다(`mirrorCache` 가 인자를 키에 넣는다) — 두 호출자가 셀을
 *    공유하지 않는다. 대시보드 폴백이 S3 의 warm 셀에 얹혀 가던 것이 없어지는 것이
 *    이 분리의 대가이고, 그 경로는 `S3.citation` 이 켜져 있는 한 거의 밟히지 않는다.
 * ⚠️ 반드시 캐시 콜백 **안에서** 부를 것(`mentionsBudgetOf` 와 같은 이유).
 */
export type CitationsBudgetProfile = "screen" | "extras";

export function citationsBudgetOf(
  profile: CitationsBudgetProfile,
): { statementTimeoutMs?: number; deadlineAt: number } {
  return profile === "extras" ? mirrorExtrasBudget() : mirrorHeavyBudget("citationsGlobal");
}

// ── 나머지 무거운 미러 read 의 예산 표 (PR③ 위생 A, 2026-09-10) ─────────────
//
// E-2 는 S3 하나만 켰다. 나머지 다섯 경로는 같은 위험(무예산 + 무degrade → 함수
// 120 s 초과 시 **HTML 절단**)을 그대로 갖고 있었다. 경로마다 문장 분포가 달라
// 상수 하나로 덮을 수 없으므로 **프로파일 표**로 둔다.
//
// ── 실측 (프로덕션 DB · warm · 무필터 · 2026-09-10) ─────────────────────────
// 하네스: `scripts/summary/explain-mirror-heavy.ts --explain`. 드라이버 세션을 계측해
// **프로덕션과 같은 경로**(`withAnswerSet` TEMP TABLE 포함)에서 문장별 왕복을 재고,
// 같은 트랜잭션 안에서 `EXPLAIN (ANALYZE, BUFFERS)` 를 한 번 더 보내 서버측
// Execution Time 을 받는다. 문장을 밖으로 떼어 재면 `_answer_set` 이 없어 못 돌고,
// CTE 로 바꿔 재면 비용 귀속이 틀린다(이 파일 `KPI_TAB_STATEMENT_TIMEOUT_MS` 주석이
// 그 오진의 대가를 적어 뒀다). 아래 값은 전부 **exec**(서버측)이다.
//
//   경로                              문장  exec 합   최장 exec   (wall 합)
//   S3 표준 인용   (기존 E-2)          10   25.2 s     6.27 s      —
//   S2 표준 언급                       10   16.6 s     9.19 s     23.7 s
//   S5 웹사이트 언급                    8    7.8 s     5.83 s     10.2 s
//   S6 웹사이트 인용                    8   26.0 s     8.89 s     37.2 s
//   프로젝트 인용                       8   20.3 s     6.88 s     36.9 s
//   프로젝트 언급 (JS 경로)             5   11.9 s     9.95 s     65.9 s ⚠️
//
// 산정식은 KPI 탭 상수와 같다: **문장 = 최장 exec × 콜드 1.7 × 여유 1.3**,
// **경로 = exec 합 × 콜드 1.7**. 실효 최악 = 경로 예산 + 문장 상한.
//
// ⚠️ 프로젝트 언급(JS 경로)만 성격이 다르다 — 지배 비용이 **행 전송**이다(최장 문장
//    exec 1.5 s / wall 47 s: 답변 201,806건의 `scope_mentions` 전 행 로드).
//
//    그리고 **`statement_timeout` 은 전송 시간을 포함한다**(2026-09-10 실측: 이 경로에
//    22 s 상한을 걸었더니 정상 결과가 57014 로 죽었다 — 서버 실행은 1.5 s 인데 클라이언트가
//    행을 다 받는 데 47 s 가 걸리는 동안 문장이 살아 있기 때문이다). 즉 "서버 작업량"으로
//    산정한 상한을 전송 지배 문장에 걸면 **정상 화면을 죽인다**. 그래서 이 프로파일만
//    문장 상한을 **걸지 않고** 벽시계 마감만 둔다. 마감은 문장을 보내기 **전**에만 보므로
//    이미 나간 전송을 끊지도 않는다 — 막는 것은 그 뒤에 나갈 문장들뿐이다.
//
//    즉 이 경로는 이 계층에서 완전히 바운드되지 않는다. 근본 해결은 그 표면을 SQL
//    헤드라인 경로("none")로 옮기는 것이고(그러면 전송이 GROUP BY 결과 수십 행으로 준다),
//    그 전까지 남는 위험은 "루트 카탈로그처럼 답변이 20만 건인 프로젝트 화면"뿐이다.
export const MIRROR_HEAVY_PROFILES = {
  /** S3 표준 인용 — E-2(2026-09-10) 에서 정한 값. 실효 최악 60 s. */
  citationsGlobal: { statementTimeoutMs: MIRROR_HEAVY_STATEMENT_TIMEOUT_MS, budgetMs: MIRROR_HEAVY_BUDGET_MS },
  /**
   * 인용 계열 넓은 모수 — S6 웹사이트(126 프로젝트) · 프로젝트 인용.
   * 문장 8.89 × 1.7 × 1.3 = 19.6 → 20 s · 경로 26.0 × 1.7 = 44.1 → 45 s. 실효 최악 65 s.
   */
  citationsWide: { statementTimeoutMs: 20_000, budgetMs: 45_000 },
  /**
   * 언급 계열(SQL 헤드라인 경로) — S2 표준 · S5 웹사이트.
   *
   * 2026-09-17 재산정 — 추이 주 격자 키가 원장 회차 주로 바뀌면서 이 경로의 **최장 문장이
   * 늘었다**(`scope-aggregates.ts::trendWeekKey`: `ans` CTE 에 LEFT JOIN 하나 추가).
   * 프로덕션 warm 실측(같은 세션 A/B 교대, 중앙값): measured **9,966 ms** → cycle **11,219 ms**.
   *   문장 11.219 × 1.7 × 1.3 = 24.8 → **25 s** (종전 9.19 기준 22 s)
   *   경로 (16.6 + 1.1 + TEMP 1.6) × 1.7 = 32.8 → **35 s**(무변경)
   * 실효 최악 **60 s** — 답변분석 `maxDuration` 120 s 안이고, 같은 지면의 S3 인용(60 s)과
   * 같은 수준이다. 대시보드 경계는 이 프로파일을 쓰지 않는다(`extras` = 15/30 → 45 s).
   *
   * ⚠️ 화면 키 `S2.mentionTrend` 가 **off 인 경로도 같은 프로파일을 쓴다** — off 면 문장이
   *    종전(9,966 ms)이므로 25 s 는 그만큼 **상한만 느슨해지는 것**이고 값·동작은 안 바뀐다.
   *    프로파일을 키별로 가르지 않는 이유는 그 방향이 안전한 쪽이기 때문이다(상한이 늘면
   *    degrade 가 덜 난다 — `KpiBudgetProfile` 의 "유지 또는 완화" 와 같은 판단).
   * ⚠️ 프로젝트 JS 경로의 최장 문장(9.95 s)도 여전히 덮는다.
   */
  mentions: { statementTimeoutMs: 25_000, budgetMs: 35_000 },
  /**
   * 프로젝트 언급(JS 경로) — **문장 상한 없음**(위 ⚠️: `statement_timeout` 이 전송을
   * 포함해서, 서버 작업량으로 잡은 상한이 정상 결과를 죽인다. 22 s 로 실증했다).
   * 벽시계 마감만 둬서 "이미 늦었으면 다음 문장을 안 보낸다" 까지만 한다.
   */
  mentionsJs: { statementTimeoutMs: undefined, budgetMs: 75_000 },
  /**
   * **카드 계열 미러 폴백** — S1 카드(`aggregateStandardFromMirror`, 루트) · S4 카드
   * (같은 함수, 웹사이트 126 프로젝트) · GEO 경쟁(`aggregateGeoCompetitionFromMirror`).
   *
   * 게이트가 summary 경로를 거부했을 때 가는 길이고, 여기가 **캡이 없는 마지막 경계**
   * 였다(2026-09-10 PR #235 프리뷰: `/ko/dashboard` 콜드 18건 중 3건이 120.5 s 절단,
   * 절단 응답은 `dashboard:filters` 만 도착하고 `kpi-cards` 는 미도착).
   *
   * 실측(같은 하네스, warm exec): S1 카드 문장 12개 **16.2 s**(최장 4.16 s) ·
   * S4 카드 10개 **9.7 s**(최장 4.47 s) · GEO 4개 **2.5 s**(최장 2.51 s).
   *   문장 4.47 × 1.7 × 1.3 = 9.9 → **10 s** · 경로 16.2 × 1.7 = 27.6 → **30 s**
   * 실효 최악 **40 s** ≤ 대시보드 경계 목표 45 s.
   */
  cardsMirror: { statementTimeoutMs: 10_000, budgetMs: 30_000 },
  /**
   * **집계층 읽기**(`readTrendAggregates` 경유 문장 + 게이트 프로브). 정상값이 수백 ms
   * 인 경로라 이 상한은 성능 목표가 아니라 **순수 안전망**이다 — 발동하면 그건 집계층이
   * 회귀했거나 락·풀 경합이 있다는 신호다.
   *
   * 15 s 는 실측 대비 ~20 배 여유다(집계층 read 415 ms · 게이트 프로브 ~1 s).
   * 실효 최악 20 + 15 = **35 s** ≤ 45 s.
   */
  summaryRead: { statementTimeoutMs: 15_000, budgetMs: 20_000 },
  /**
   * **세부층 폴백**(`onDetail`) — R2. 집계층이 거부된 축에서 가는 길이라 미러보다 훨씬
   * 싸지만(T11 재검 실측 **2.4~4.3 s**) 상한이 없는 것은 마찬가지였다.
   *
   * 산정: 그 실측은 경로 합이므로 어떤 단일 문장도 그보다 클 수 없다 — 상한으로 쓴다.
   *   문장 4.3 × 1.7 × 1.3 = 9.5 → **10 s**
   *   경로 — 4.3 × 1.7 = 7.3 s 지만 측정이 1회뿐이라 여유를 크게 둔다 → **20 s**
   * 실효 최악 30 s. 초과하면 **미러가 아니라 degrade** 다(T11 기준 6: 세부층이 거부됐다고
   * 미러로 내려가면 한 화면에 두 원천이 섞인다 — 느린 것보다 그쪽이 나쁘다).
   */
  detail: { statementTimeoutMs: 10_000, budgetMs: 20_000 },
} as const;

export type MirrorHeavyProfile = keyof typeof MIRROR_HEAVY_PROFILES;

// ── 경계별 실효 최악 표 (2026-09-10) ───────────────────────────────────────
//
// 실효 최악 = `budgetMs + statementTimeoutMs` (마감 직전에 보낸 문장 하나는 끝까지
// 기다린다). 경계(<Suspense>)는 서로 병렬이므로 **페이지의 최악 = 경계 최댓값**이다.
//
// 대시보드(`/ko/dashboard` · `maxDuration` 120 s) — 목표는 경계당 45 s:
//
//   경계                      기다리는 read                       프로파일         최악
//   dashboard:filters         측정 기준일 슬롯(카드와 같은 read)   ─ 카드와 동일 ─   40 s
//   dashboard:kpi-cards       집계층 S1 → 세부층 → 미러 폴백       summaryRead 35 s
//                                                                 detail      30 s
//                                                                 cardsMirror 40 s  **40 s** ✅
//   dashboard:kpi-extras      추이 ×2                             MIRROR_EXTRAS    **45 s** ✅
//   dashboard:kpi-competitors 언급 + 스파크 + 순위 + 인용 도메인    MIRROR_EXTRAS    **45 s** ✅
//
//   웹사이트 대시보드(S4)은 같은 프로파일을 쓰므로 카드 경계 최악도 40 s 다.
//
// ✅ PR③ 통합(2026-09-11)으로 **대시보드의 모든 경계가 45 s 이하**가 됐다. 위생 A 초판이
//    "57 s · ∞" 로 적어 둔 두 경계를 PR③-a 의 `MIRROR_EXTRAS_*` 가 닫았다. 초판이 제안했던
//    "언급 슬림 read" 는 값을 낮추는 수단이 아니라 **degrade 빈도를 줄이는** 후속으로 남는다
//    (extras 예산에서는 warm 55 s 짜리 두 경로가 콜드에 degrade 될 수 있고, 그것이 의도다).
//
// 답변분석(`maxDuration` 120 s) — 목표는 절단(120 s) 방지:
//   S2 언급 60 s · S3 인용 60 s · S5 언급 60 s · S6 인용 65 s · 프로젝트 인용 65 s
//   · 프로젝트 언급 75 s + 전송(상한 없음, `mentionsJs` 주석)
//
// ⚠️ **45 s 는 상한이지 소요가 아니다.** 경계가 그 값을 쓰는 것은 초과했을 때뿐이고,
//    초과의 대가는 그 경계 하나의 degrade 다(페이지는 그대로 서빙된다).
// ⚠️ 그리고 이 표는 **큐 대기를 포함하지 않는다.** 2026-09-10 프리뷰 실측: 동시 콜드 4건에서
//    1건 504 · 1건 120.6 s 절단이었는데 **DB 작업은 ~50 s 안에 전부 끝났고 락 대기는 0**
//    (`pg_stat_activity` 의 `wait_event` 전량 null)이었다. 즉 남는 시간은 DB 밖에서 갔다.
//
//    **유력 가설 = 커넥션 대기**다 — 콜드 렌더 1회가 `DB_POOL_MAX`(10)를 **10/10** 으로
//    채우는 것은 실측이다. 다만 그 대기가 어느 층인지는 **아직 분리되지 않았다**:
//      (a) 앱 풀(postgres.js `max`) 큐  (b) Supavisor 서버측 `default_pool_size` 큐
//      (c) Node 이벤트 루프 — 프로젝트 언급 JS 롤업처럼 대용량 행을 JS 로 접는 경로가
//          같은 인스턴스에서 돌면 대기 시간이 DB 와 무관하게 늘어난다.
//    (a)/(b) 를 가르려면 Supavisor 쪽 pool_size·큐 지표가 필요하고(대시보드 전용),
//    (c) 는 함수 CPU 프로파일이 필요하다. **셋 다 예산으로는 못 고친다** — 예산이 하는
//    일은 절단을 degrade 로 바꾸는 것뿐이다. 풀 크기 변경(env)은 그 다음 수단이고
//    승인 대상이다.

// ── 아직 예산을 안 건 미러 경로 (PR③ 통합 시점, 2026-09-11) ─────────────────
//
// PR③-a(extras)와 위생 A(나머지 미러·집계층·프로브)가 합류하면서 목록이 줄었다.
// 켤 때는 위와 같은 하네스로 문장 분포를 먼저 재고(최장 exec × 1.7 × 1.3 ≤ 문장 상한),
// degrade 시 화면이 무엇을 보여주는지 확인할 것.
//
//   · `fetchWebsiteTrend` · `fetchWebsiteCitationAccuracyTrend` (S4 추이 — 미러 유지)
//   · `fetchProjectTrend`                                       (프로젝트 표면 추이)
//   · `fetchStandardKpiEngineTrend` · `fetchStandardKpiTypes` (4-KPI 탭 — `KPI_TAB_*` 는
//     있으나 실효 최악 50 s 라 S2 지면 합산 기준으로 재검토 대상)
//
// 이번 라운드에 빠져나간 것:
//   PR③-a → `MIRROR_EXTRAS_*`: `fetchStandardMentions` · `fetchStandardTrend` ·
//           `fetchStandardKpiBrandTrend` · `fetchStandardKpiFirstPosition`
//   위생 A → `MIRROR_HEAVY_PROFILES`: `fetchWebsiteMentions`(mentions) ·
//           `fetchWebsiteCitations`·`fetchProjectCitations`(citationsWide) ·
//           `fetchProjectMentions`(mentionsJs) · 카드 미러 폴백(cardsMirror) ·
//           집계층 read·게이트 프로브(summaryRead) · 세부층 폴백(detail)

// ── 창(trendDays) 두 개, 그리고 그 근거 (2026-09-01 프로덕션 EXPLAIN 실측) ──
//
// 종전에는 두 용도가 28일 하나를 공유해, **히어로 KPI 추이·엔진 시계열·커버리지
// 라벨이 전부 주 4점으로 잘려 있었다**(검증 지적 F7 — 디자인 327:116 의 추이는
// 7.2~8.16 구간 8~10 포인트다). 창을 줄인 근거였던 "창이 지배 비용"도 반증됐다:
//
//   미러 실측 데이터 폭        2026-07-02 ~ 2026-09-01 = 61일 = **주 버킷 10개**
//   ENGINE_KPI 멘션 조인 84일  4,571ms   (답변셋 132,687행)
//   ENGINE_KPI 멘션 조인 120일 4,403ms   (답변셋 132,687행 — **완전히 동일**)
//   ENGINE_KPI 답변 집계 84일  1,116ms
//
// 84일과 120일이 같은 이유는 미러가 61일치뿐이라 두 창이 같은 행을 덮기 때문이다.
// 이 쿼리의 비용은 창이 아니라 (a) ROLLUP_NAMES CTE(~0.9~1.05s, 창 무관)와
// (b) 답변 10만 × 멘션 ~9행 중첩 루프가 만든다. 28일로 줄여도 행은 70%(92,576)
// 밖에 안 줄어든다 — 화면을 반쪽 내는 대가로 얻는 것이 거의 없었다.

/**
 * 히어로 KPI 추이 · 엔진별 시계열 — 12주. 현재 미러 전 구간(10 버킷)을 덮고,
 * 데이터가 길어져도 스캔을 상수화한다. 트렌드 트랜잭션 실측 합 ≈ 5.6s
 * (답변셋 ~0.2s + 1.0s + 4.4s) < 8s 가드. 여유가 ~2.4s 라 넉넉하지 않으므로,
 * 초과하면 설계대로 그 지면만 degrade 된다. 근본 절감은 ROLLUP_NAMES 슬림화
 * (집계 계층, 후속)가 맡는다.
 */
export const KPI_TAB_HERO_TREND_DAYS = 84;

/**
 * 경쟁사 스파크라인 — 직전 4회차만 그리므로 28일. 여기서는 창 축소가 실제로
 * 유효하다(브랜드 추이는 버킷×브랜드 GROUP BY 라 행수에 비례). 다만 절감폭은
 * 창 비율이 아니라 행 비율(28일 = 92,576/132,687 ≈ 70%)이다.
 */
export const KPI_TAB_SPARK_TREND_DAYS = 28;

/**
 * degrade 해도 되는 실패인가.
 *
 * ⚠️ **권한 실패는 절대 삼키지 않는다**(2026-09-01 검증 지적 F6). 무조건 catch 로
 * 두면 세션 없음·스코프 밖 프로젝트 접근이 "데이터 없음"으로 보이고, 권한 게이트
 * 회귀가 화면상 정상으로 위장된다 — 경계 #1/#2 를 조용히 무력화하는 가장 싼
 * 경로다. degrade 는 **집계가 느려서 죽은 경우**에만 허용한다.
 */
/**
 * degrade 해도 되는 실패인가 — **허용 목록**이다(2026-09-01 재검증 C4).
 *
 * 종전에는 "권한 오류만 재throw, 나머지는 삼킴"이라는 **거부 목록**이었다. 그건
 * 모듈이 스스로 선언한 계약("degrade 는 집계가 느려서 죽은 경우에만")과 모순이었고,
 * 실측에서 42601(SQL 문법 오류)·ECONNREFUSED·`DATABASE_URL is not set`·403
 * ScopeHttpError 를 전부 삼켜 "데이터 없음"으로 위장했다. 인프라 장애와 코드 결함이
 * 빈 화면으로 보이면 아무도 못 잡는다.
 *
 * 이제 삼키는 것은 **진짜 시간 초과 두 가지뿐**이다:
 *   - Postgres `57014` (canceling statement due to statement timeout)
 *   - 우리가 만든 벽시계 마감(`AnswerSetDeadlineError`)
 * 그 외 모든 오류(권한·연결·문법·설정)는 그대로 던져 상위에서 드러나게 한다.
 */
const PG_QUERY_CANCELED = "57014";

// ── Sub KPI 파트 선택 (2026-09-02) ─────────────────────────────────────────
//
// 히어로가 30초를 기다리던 이유는 `aggregateSubKpisFromMirror` 가 **탭과 무관하게
// 5개 문장을 전부** 돌렸기 때문이다(로컬 실측 warm: Q1 3.0s · Q2 1.8s · Q3 2.8s ·
// Q4 3.2s · Q5 3.0s + 답변셋 2.3s = 17.0s). 탭이 실제로 읽는 것은 그중 1~2개다.
//
// **소비 지점(전수)** — KPI 탭이 Sub KPI 에서 읽는 값은 `kpiHero` 하나뿐이다:
//   app/[locale]/(dash)/standard/answer-analysis/_data/kpi-view.ts:62-63 (kpiHero)
//     exposure → sum(rows[].tracked) / sum(rows[].answers)          = Q1(answers)
//     sov      → sum(rows[].trackedMentions) / sum(rows[].totalMentions)
//                                                                    = Q2(mentions)
//   호출부: mention-kpi-tab.tsx:187(HeroBlock) · :237(HeroDelta, prev 스냅샷) ·
//           :332(CompetitorBlock — 표의 Gap 기준선인 당사 합산 pct)
//   그 외 필드(sentiment·citations·prompts)를 읽는 KPI 탭 지면은 **없다**.
//
// ⚠️ sov 가 `answers` 도 요구하는 이유: 엔진(target) 행 골격이 Q1 에서 나온다.
// 집계가 Q1 을 항상 돌리므로 안전장치가 이중이지만, 의도를 표에 남긴다.
//
// 이 표가 틀리면 화면이 **조용히 빈다**(계산 안 한 파트는 0/null = "측정 없음"과
// 구분 불가). 그래서 kpi-view.test.ts 가 "좁힌 입력의 kpiHero == 전량의 kpiHero"
// 를 metric 별로 고정한다 — 소비가 늘면 그 테스트가 먼저 깨진다.
//
// 실측(로컬 프로덕션 빌드 · 매번 `.next/cache` 삭제한 콜드 · 무필터 · 40ms 폴링,
// 하네스 notes/hmg-perf/kpi-stream-observe.mjs):
//
//   노출률   before  엔진 18.6~20.4s · 유형 22.4s · 히어로/경쟁사 29.9~31.3s
//            after   **히어로 9.5s** · 경쟁사 23.1s · 유형 23.1s · 엔진 24.5s
//   점유율   before  엔진 18.9s · 유형 22.6s · 히어로/경쟁사 31.0s
//            after   **히어로 14.2s** · 경쟁사 23.0s · 유형 23.0s · 엔진 24.7s
//
// 첫 섹션도 마지막 섹션도 앞당겨졌다(노출률 18.6→9.5s · 31.3→24.5s). 대신 엔진
// 섹션은 자기 시각이 ~5s 밀렸다 — 부분 계산이 **트랜잭션을 하나 더** 만들어
// 콜드 구간의 커넥션 경합이 늘기 때문이다(왕복 165→182, 드라이버 레벨 실측).
// prev 를 안 좁히는 변형도 측정했다(왕복 173 · 엔진 22.9s)지만, Δ 배지가 히어로
// 숫자보다 20s 늦게 튀어나오는 대가라 기각했다.
export const KPI_TAB_SUB_KPI_PARTS: Record<
  "exposure" | "sov" | "favorability" | "citation",
  readonly SubKpiPart[]
> = {
  exposure: ["answers"],
  sov: ["answers", "mentions"],
  // 우호도 히어로(2026-09-02) — 긍정·부정 ÷ 전체 감정 신호. Q3 하나. (answers 는
  // 행 골격이라 어차피 돈다 — SubKpiOptions 주석.)
  favorability: ["sentiment"],
  // 인용 개편 히어로(PR ④) — 공식(당사) 인용 비중의 직전 스냅샷 Δ. Q4 하나.
  citation: ["citations"],
};

// ── S4 웹사이트 카드의 엔진 일관성 배지 (PR④ A4) ────────────────────────────
//
// 이 배지가 읽는 것은 `sub.rows` 뿐이다 — `website/page.tsx` 의
// `subKpis.then((sub) => applyEngineConsistency(items, sub.rows))`.
//
// **소비 지점(전수)** — `dashboard/_data/live.ts::applyEngineConsistency` 의 5 지표:
//   visibility     `r.tracked / r.answers`                = Q1(answers)
//   shareOfVoice   `r.trackedMentions / r.totalMentions`   = Q2(mentions)
//   sentiment      `r.positiveMentions / r.sentMentions`   = Q3(sentiment)
//   position       `r.avgPosition`                         = Q1(answers)
//   citationShare  `r.citOwned / r.citTotal`               = Q4(citations)
// Q5(`prompts`)가 채우는 `promptsWithoutBrand`·`measuredPrompts` 는 **S4 배지 경로
// (`screen:"S4.subkpi"`)만** parts 를 좁히며 안 읽는다. 웹사이트 언급 화면(S5)은
// `screen` 미지정 전량 호출로 그 두 필드를 **소비한다** —
// `website/answer-analysis/mention/page.tsx:147` 의 `fetchWebsiteSubKpis(filters)` 가
// 같은 파일 154행에서 `buildMentionSubKpis` 로 들어가고, 그 빌더가
// `standard/answer-analysis/_data/sub-kpis.ts:54,63` 에서 두 필드를 읽는다
// (`missingPrompts` · `measuredPrompts`). 값은 무결하다 — 좁히는 것은 S4 배지뿐이다.
// (⚠️ 소비처를 필드명 grep 으로만 세면 이 경로가 안 보인다. 웹사이트 지면은 표준
//  화면의 빌더를 **재사용**해서 읽으므로, 필드명이 웹사이트 파일에 나타나지 않는다.
//  2026-09-10 최초 주석의 "웹사이트 지면 0건" 이 정확히 그 오판이었다.)
//
// ⚠️ S5 언급 화면(`fetchWebsiteSubKpis` 기본 키 `S5.mention`)은 **좁히지 않는다** —
//    그쪽은 표준 언급 화면과 같은 뷰를 쓰므로 Q5 가 필요하다. 좁힌 결과를 그 지면으로
//    흘리면 화면이 조용히 빈다(`SubKpiOptions.parts` 주석의 경고 그대로).
//
// ⚠️ parts 와 달리 **예산은 두 화면에 다 걸린다.** A4 가 `cachedWebsiteSubKpis` 에 붙인
//    상한(문장 `MIRROR_HEAVY_STATEMENT_TIMEOUT_MS` 15 s + 마감 `MIRROR_EXTRAS_BUDGET_MS`
//    30 s)은 종전 **무제한**이던 S5 미러 경로에도 새로 적용된다. 초과하면 그 지면은
//    던지지 않고 `degradeAware("websiteSubKpis")` 가 **빈 결과**로 닫는다(화면의
//    "데이터 없음" 과 값으로는 구분되지 않는다 — degrade 표식이 가른다).
export const S4_BADGE_SUB_KPI_PARTS: readonly SubKpiPart[] = [
  "answers",
  "mentions",
  "sentiment",
  "citations",
];

export function isTimeoutFailure(e: unknown): boolean {
  // ⚠️ 최상위 객체만 보면 안 된다 — drizzle 은 드라이버 오류를 `Error: Failed query: …`
  // 로 **감싸고 원본을 `cause` 에 넣는다**. 감싼 쪽에는 `code` 가 없고 `digest` 만
  // 있으므로, code 만 보던 종전 판정은 실제 런타임에서 57014 를 놓쳤다
  // (2026-09-01 로컬 브라우저 실측: 경쟁사 추이 타임아웃이 degrade 되지 못하고
  // 그대로 던져져 페이지 전체가 에러 바운더리로 떨어졌다 — 단위 테스트는 순수
  // PostgresError 를 던져서 통과했다). cause 체인을 따라가고, 드라이버가 code 를
  // 잃는 경우를 대비해 메시지 폴백도 둔다.
  const seen = new Set<unknown>();
  let cur: unknown = e;
  for (let depth = 0; cur && typeof cur === "object" && depth < 8; depth++) {
    if (seen.has(cur)) break;
    seen.add(cur);
    if ((cur as { code?: unknown }).code === PG_QUERY_CANCELED) return true;
    if (cur instanceof Error) {
      if (cur.name === "AnswerSetDeadlineError") return true;
      // 드라이버·풀러 계층이 code 를 떨어뜨려도 문구는 남는다.
      if (/statement timeout|canceling statement due to/i.test(cur.message)) return true;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * 시간 초과로 죽은 집계만 그 지면 null 로 내린다. 그 외 실패는 그대로 던진다.
 * 삼킬 때도 warn 을 남긴다(readMentionBrandDayCounts 호출부와 같은 형태).
 */
export async function kpiDegrade<T>(
  label: string,
  run: () => Promise<T>,
): Promise<T | null> {
  try {
    return await run();
  } catch (e) {
    if (!isTimeoutFailure(e)) throw e;
    console.warn(
      `[kpi-tabs] ${label} timed out (page still served):`,
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}

/**
 * 부분 degrade 결과(예: `trendDegraded: true`)를 **캐시에 넣지 않게** 하는 장치.
 *
 * 2026-09-02 프리뷰 실증: 배포 직후 콜드 첫 요청 두 건에서만
 * `[engineKpiTrend] trend phase degraded` 경고가 찍히고, 그 뒤 수 시간 동안 화면은
 * 계속 "집계가 시간 안에 끝나지 않아…" 인데 로그는 0건이었다. degrade 는 예외가
 * 아니라 **정상 반환값**이어서 `unstable_cache`(TTL 30분) 에 그대로 저장됐고, 이후
 * 요청은 전부 캐시 HIT 라 DB 도 안 가고 warn 도 안 남긴 것이다. TTL 뒤에도
 * stale-while-revalidate 가 옛 값을 먼저 내주므로 사실상 굳는다.
 *
 * 규칙: 캐시 안쪽 함수는 degrade 결과를 이 예외로 **던져** 저장을 막고, 캐시 바깥
 * 호출부가 `recoverDegraded` 로 그 값을 회수해 화면엔 종전처럼 내린다. 다음 요청은
 * 캐시 MISS 라 다시 계산한다 — 성공하면 그때 저장된다.
 */
export class DegradedResultUncached<T = unknown> extends Error {
  constructor(readonly result: T) {
    super("degraded result — deliberately not cached");
    this.name = "DegradedResultUncached";
  }
}

/** 캐시 안쪽 래퍼: `isDegraded(result)` 면 저장 대신 던진다. */
export function uncachedIfDegraded<A extends unknown[], R>(
  isDegraded: (r: R) => boolean,
  fn: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return async (...args: A) => {
    const r = await fn(...args);
    if (isDegraded(r)) throw new DegradedResultUncached(r);
    return r;
  };
}

/** 캐시 바깥 호출부: 위 예외면 감싸 둔 결과를 그대로 돌려준다. 다른 실패는 통과. */
export async function recoverDegraded<R>(run: () => Promise<R>): Promise<R> {
  try {
    return await run();
  } catch (e) {
    // unstable_cache 가 예외 객체를 그대로 재던지지 않는 런타임을 대비해 name 도 본다.
    if (
      e instanceof DegradedResultUncached ||
      (e instanceof Error && e.name === "DegradedResultUncached" && "result" in e)
    ) {
      return (e as DegradedResultUncached<R>).result;
    }
    throw e;
  }
}

/**
 * Δ 전용 추이 롤업의 창(일) — **정본은 여기다**(2026-09-11, PR③ GG-4).
 *
 * 종전 정본은 `app/[locale]/(dash)/dashboard/_data/live.ts` 였는데, 집계층 추이 경로
 * (`lib/scope/server.ts::globalSeriesFilters`)가 "이 바닥은 사용자 기간이 아니라 Δ 페처가
 * 얹은 것" 을 알아야 하면서 lib → app 역방향 import 가 필요해졌다. 값을 두 곳에 적는
 * 대신 중립 모듈로 올린다 — `live.ts` 는 재수출만 한다.
 */
export const DELTA_TREND_WINDOW_DAYS = 30;
