/**
 * 사실표 생성기 **코어** — 표면(글로벌·웹사이트) 공통 타입과 컬럼 상수.
 *
 * 경계(설계 v4.1 §7-5 / PR① T8): 이 디렉토리(`lib/summary/generate/*`)는 **테넌트 상수를
 * 모른다.** `lib/scope/hmg-brands`·`lib/geo-catalog/owned`·`lib/scope/non-competitor-brands`·
 * `lib/scope/hidden-regions`·`lib/geo-catalog/official-social` 를 직접 import 하지 않고,
 * 필요한 값은 전부 **인자로 받는다**. 테넌트 값의 유일한 통로는 `lib/summary/tenant/hmg.ts`.
 * (기계 집행: `lib/summary/summary.tenant-boundary.test.ts` — 소스 grep)
 *
 * 판정 규칙(롤업·표시명·비경쟁·그룹키·URL 정규화)은 **재구현하지 않고**
 * `lib/db/repositories/*` 의 SQL 빌더를 import 해 쓴다 — 규칙이 두 벌이 되는 순간
 * 화면과 사실표가 갈린다.
 */
import { sql, type SQL } from "drizzle-orm";

export type SummarySurface = "global" | "website";

/**
 * 노출 지연(V-1) — `cycle_anchor_at`(= 고객이 기대하는 **측정일**) 에서 며칠 뒤부터 그 회차를
 * 내보내는가. **표면 상수**다: 테넌트(HMG) 값이 아니라 표면의 배달 리듬이라 코어에 둔다
 * (테넌트 상수의 유일한 통로는 `lib/summary/tenant/hmg.ts` — 그 경계를 넘지 않는다).
 *
 * 운영 확정 2026-09-10: 글로벌 +2일 · 웹사이트 +1일.
 *
 * ⚠️ 정의가 여기(`types.ts`) 인 이유 — 쓰는 쪽이 둘이고 방향이 반대다.
 *   · 쓰기(V-1): `swap.ts::publishCycleSql` 이 `view_anchor_at` 을 찍는다.
 *   · 읽기(V-2 / 미러 폴백): `summary-cycles.ts::cycleViewableSql` · `scope-aggregates.ts::
 *     excludeHiddenCycleRuns` 가 "아직 노출 시각이 안 왔는가" 를 본다.
 * `scope-aggregates.ts` 가 `swap.ts` 를 직접 import 하면 `swap → context → scope-aggregates`
 * 로 **런타임 순환**이 생긴다. `types.ts` 는 drizzle 밖에 아무것도 import 하지 않아 순환이
 * 없다 — 그래서 상수는 여기 한 벌만 두고 `swap.ts` 는 재수출한다. **리터럴 복사 금지.**
 */
export const VIEW_ANCHOR_DELAY: Record<SummarySurface, string> = {
  global: "2 days",
  website: "1 day",
};

/**
 * 코어가 보는 DB 포트 — **최소 구조만** 안다.
 *
 * `@/lib/db` 를 코어가 직접 import 하지 않는 것은 취향이 아니라 규칙이다(CLAUDE.md
 * data-access-security: 원 DB 클라이언트는 `lib/db/**` 밖에서 import 금지, ESLint 집행).
 * 커넥션은 실행 스크립트가 잡아 넘긴다.
 */
export type SqlExecutor = { execute: (q: SQL) => Promise<unknown> };
export type GeneratorDb = SqlExecutor & {
  transaction: <T>(
    fn: (tx: SqlExecutor) => Promise<T>,
    config?: { isolationLevel?: "repeatable read" },
  ) => Promise<T>;
};

/** 한 번의 generation 이 쓰는 키 3종. 세부층 6표가 전부 이 셋을 달고 적재된다. */
export type GenerationKeys = {
  /** 주 파티션 키 — `date_trunc('week', anchor AT TIME ZONE 'UTC')` 의 date. */
  cycleWeek: string;
  cycleId: string;
  generationId: string;
};

/** 자사 명부 1행 — 코어는 구조만 안다(테넌트의 `OwnEntity` 와 구조 동일). */
export type RosterEntity = { id: string; name: string };

/** 세부층 3표가 공유하는 공통 차원 — `d` CTE 의 컬럼 목록(§3-2). */
export const D_COMMON = sql.raw(
  "d.job_id, d.prompt_id, d.engine, d.country, d.project_id, d.lang, d.catalog_brands, " +
    "d.funnel_catalog, d.funnel_scope, d.brand_presence_resolved, d.presence_set, d.list_type, " +
    "d.depth1, d.depth2, d.depth3, d.in_root_catalog, d.in_tagged_region, d.in_full_cycle, d.run_status",
);

/** 위와 짝인 INSERT 컬럼 목록. 두 문자열은 **같은 순서**여야 한다. */
export const COL_COMMON =
  "job_id, prompt_id, engine, country, project_id, lang, catalog_brands, " +
  "funnel_catalog, funnel_scope, brand_presence_resolved, presence_set, list_type, " +
  "depth1, depth2, depth3, in_root_catalog, in_tagged_region, in_full_cycle, run_status";

/** 세부층 6표 — 옛 generation 정리·timings 키의 정본 순서. */
export const DETAIL_TABLES = [
  "summary_cycle_jobs",
  "summary_answers",
  "summary_brand_mentions",
  "summary_domain_citations",
  "summary_target_hits",
  "summary_prompt_dim",
] as const;

/**
 * 집계층(추이층) 4표 — 접기(`fold.ts`)의 정본 순서. 세부층과 달리 **파티션이 아니다** →
 * 정리는 파티션 DROP 이 아니라 `DELETE … WHERE cycle_id` 다(플랜 §5-1).
 */
export const AGG_TABLES = [
  "summary_trend_answers",
  "summary_trend_brands",
  "summary_trend_domains",
  "summary_trend_own",
] as const;

/** `summary_generations.timings` 에 넣는 표별 소요(ms). 표면과 무관하게 **6키 전부** 채운다 —
 *  글로벌은 `summary_target_hits` 를 만들지 않으므로 0 이고, "키가 없다"와 "0 이다"를 구분한다. */
export type GenerationTimings = Record<string, number>;

export const TIMING_KEYS = [
  "cycle_jobs",
  "answers",
  "brand_mentions",
  "domain_citations",
  "target_hits",
  "prompt_dim",
] as const;

/** 접기 소요 4키(§8 M5 의 실측 창구). `AGG_TABLES` 와 **같은 순서**여야 한다. */
export const AGG_TIMING_KEYS = [
  "fold_answers",
  "fold_brands",
  "fold_domains",
  "fold_own",
] as const;
