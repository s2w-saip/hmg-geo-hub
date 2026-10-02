import { sql, type SQL } from "drizzle-orm";
import { getRootConfig } from "@/lib/scope/result-adapter";

/**
 * **표면(surface) 어휘·판정·루트 식별의 단일 정본.**
 *
 * "이 run(또는 프로젝트)이 글로벌인가 · 웹사이트인가 · 개별 프로젝트인가"를 코드
 * 네 군데가 서로 **다른 어휘와 다른 순서**로 답하고 있었다:
 *
 * | 생산자 | 어휘 | 판정 순서 |
 * | --- | --- | --- |
 * | 원장 `summary-cycles::surfaceExpr` | `global`·`website`·`project` | 루트(env) → website → project |
 * | QA 콘솔 `qa-review::RUN_SURFACE_CTE` | `standard`·`website`·`project` | website → project → **standard(폴백)** |
 * | 필터 축 `scope-aggregates::FilterSurface` | `standard`·`project` | run 이 아니라 **호출부가 project id 를 들고 왔는가** |
 * | 생성기 `SummarySurface`·`CycleSetSurface` | `global`·`website` | (project 개념 없음) |
 *
 * 이 모듈은 **어휘 매핑과 순서를 값으로** 들고 있다. 이번 정리는 값을 바꾸지 않으므로
 * 각 생산자는 지금 쓰는 순서를 그대로 넘긴다 — 순서가 인자가 되면 "어디가 다른가"가
 * 코드에서 보이고, 맞추는 일은 인자 한 줄 교체가 된다.
 *
 * ⚠️ **알려진 오분류(이번에 고치지 않는다)**: QA 콘솔은 `projects` 조회를 website 다음,
 * 루트 판정 **앞**에 둔다. 글로벌 루트도 `projects` 에 행이 있으므로 `project` 로
 * 라벨되고, `project_id` 가 NULL 인 레거시 run 이 대신 `standard` 로 떨어진다.
 * 고치면 QA 콘솔의 표면 필터 결과가 **바뀐다** — 값이 바뀌는 수정이라 축 전환 단계에서
 * 별도로 처리한다. 지금은 그 순서를 `QA_CONSOLE_SURFACE_ORDER` 로 명시해 둔다.
 */

/** 앵커·QA 어휘 — 글로벌을 `standard` 로 부른다. */
export type AnchorSurface = "standard" | "website" | "project";

/** 회차 원장 어휘 — 글로벌을 `global` 로 부른다. */
export type LedgerSurface = "global" | "website" | "project";

/** 어휘 매핑 — **여기 한 곳**. 두 어휘가 갈리는 지점은 글로벌 이름뿐이다. */
const ANCHOR_TO_LEDGER: Record<AnchorSurface, LedgerSurface> = {
  standard: "global",
  website: "website",
  project: "project",
};

const LEDGER_TO_ANCHOR: Record<LedgerSurface, AnchorSurface> = {
  global: "standard",
  website: "website",
  project: "project",
};

export const toLedgerSurface = (s: AnchorSurface): LedgerSurface => ANCHOR_TO_LEDGER[s];
export const toAnchorSurface = (s: LedgerSurface): AnchorSurface => LEDGER_TO_ANCHOR[s];

/** 판정 팔의 종류. 순서가 결과를 가르므로 배열로 선언한다. */
export type SurfaceArm = "root" | "website" | "project";

/** 원장 생산자(`summary-cycles::surfaceExpr`)의 순서. 루트가 가장 앞이다. */
export const LEDGER_SURFACE_ORDER: readonly SurfaceArm[] = ["root", "website", "project"];

/**
 * QA 콘솔(`qa-review::RUN_SURFACE_CTE`)의 순서. 위 머리 주석의 오분류가 여기서 나온다 —
 * 값이 바뀌므로 이번 정리에서 순서를 건드리지 않았다.
 */
export const QA_CONSOLE_SURFACE_ORDER: readonly SurfaceArm[] = [
  "website",
  "project",
  "root",
];

/** 팔이 내는 라벨 — 어휘를 고르는 자리. */
export const SURFACE_LABEL: Record<"anchor" | "ledger", Record<SurfaceArm, string>> = {
  anchor: { root: "standard", website: "website", project: "project" },
  ledger: { root: "global", website: "website", project: "project" },
};

// ── 판정 팔 조각 ─────────────────────────────────────────────────────────────
//
// `CASE` 전체가 아니라 **팔 하나씩**을 낸다. 생산자마다 들여쓰기와 팔 순서가 다른데,
// 이번 정리는 SQL 텍스트를 바이트 단위로 보존해야 하므로 조립은 호출부에 남긴다.
// 대신 "무엇으로 판정하는가"와 "어떤 라벨을 붙이는가"가 여기 한 곳에 있다.

/**
 * 루트 판정 팔 — run/프로젝트 id 를 루트 scope project id 와 **직접 비교**한다.
 * 루트를 모르는 환경이면 빈 조각(종전 `globalArm` 과 동일한 처리).
 */
export function rootSurfaceArmSql(
  col: SQL,
  rootProjectId: string | null,
  label: string,
): SQL {
  if (!rootProjectId) return sql``;
  return sql`WHEN ${col} = ${rootProjectId}::uuid THEN ${sql.raw(`'${label}'`)}`;
}

/** website 판정 팔 — `website_sites` 에 그 scope project id 가 있는가. */
export function websiteSurfaceArmSql(col: SQL, label: string): SQL {
  return sql`WHEN EXISTS (SELECT 1 FROM website_sites ws WHERE ws.scope_project_id = ${col}::text) THEN ${sql.raw(`'${label}'`)}`;
}

// ── 루트 프로젝트 식별 ───────────────────────────────────────────────────────
//
// 이름이 비슷한 값이 둘이라 매번 혼동된다:
//   · `SCOPE_ROOT_PROJECT_ID`(env) → scope 워크스페이스의 글로벌 루트 **scope** project id.
//     `scope_runs.project_id` 와 비교하는 값이다. mock 에서는 없다(null).
//   · `STANDARD_ROOT_PROJECT_ID`  → **로컬** `prompts` 테이블의 project_id(카탈로그 게이트).
//     이 모듈과 무관하다.
//
// 아래 래퍼는 전자만 다룬다.

/**
 * 술어에 쓸 수 있는 글로벌 루트 scope project id. 주소 지정이 불가능하면(mock·미설정)
 * `null` — 그때 호출부는 스코프를 걸지 않는다(종전 동작 그대로).
 */
export function addressableRootProjectId(): string | null {
  return getRootConfig()?.projectId ?? null;
}

/**
 * 루트 run 스코프 술어. `prefix` 는 컬럼 표기(별칭 있는 경로는 `"r."`).
 * 루트를 모르면 `true`(= 제한 없음) — 종전 3자리의 삼항과 **같은 SQL** 이다.
 */
export function rootRunScopeSql(prefix: "" | "r." = "", rootProjectId?: string | null): SQL {
  const id = rootProjectId === undefined ? addressableRootProjectId() : rootProjectId;
  if (!id) return sql`true`;
  return sql`${sql.raw(`${prefix}project_id`)} = ${id}`;
}
