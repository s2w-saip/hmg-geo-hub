/**
 * 앵커 축이 **켜졌을 때만** 나가는 문장들의 전수 목록 (2026-09-20).
 *
 * 왜 한 곳인가: 같은 목록을 **두 소비자**가 쓴다.
 *   · `scripts/db/dump-axis-on-sql.ts` — 사람이 미러에 붙여 넣을 파일로 떨군다.
 *   · `lib/db/repositories/axis-on-statements.pglite.test.ts` — 같은 문장을 pglite 에
 *     `PREPARE` 해서 **이름·컬럼이 해석되는지** 오프라인으로 단언한다.
 * 목록이 두 벌이 되면 "덤프에는 있는데 가드에는 없는" 문장이 생긴다.
 *
 * 배경(이 파일이 생긴 이유): 2026-09-20 프리뷰에서 축 on 의 글로벌 대시보드가
 * `column "round_date" does not exist`(42703)로 통째로 죽었다. **문장 텍스트 스냅샷은
 * 컬럼의 존재를 검증하지 않는다** — 그 글자가 가리키는 컬럼이 실제로 있는지는 파서·
 * 플래너가 이름을 해석해 봐야 안다.
 *
 * 산출물 규약(그대로 실행 가능해야 한다):
 *   · 바인드 파라미터를 **리터럴로 인라인**한다. uuid 로 보이는 값에는 `::uuid` 를 붙인다
 *     (지난번 website 달력 덤프가 `uuid = text[]` 로 깨진 이유가 캐스트 누락이었다).
 *   · **단일 문장**, 세미콜론·트랜잭션 래퍼 없음.
 *   · `_answer_set`(TEMP)을 쓰는 문장은 같은 파일 안에서 **CTE 로 치환**해 단독 실행 가능.
 *   · 읽기 전용(SELECT)만 낸다.
 *
 * 이 모듈은 **DB 에 접속하지 않는다** — 판정을 테스트용 세터로 고정하고 빌더만 돌린다.
 */
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import {
  SYNC_PROBED_COLUMNS,
  setColumnAvailabilityForTests,
} from "@/lib/db/column-availability";
import { setAnchorAxisForTests } from "@/lib/period/anchor-axis-state";
import type { StandardFilters } from "@/lib/scope/result-adapter";

export interface AxisOnStatement {
  /** 파일명 겸 식별자. */
  name: string;
  /** 파일 머리에 붙는 `--` 주석(판정선 포함). */
  header: string;
  /** 단일 SELECT 문장. 세미콜론 없음. */
  body: string;
}

const dialect = new PgDialect();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 프로덕션의 숨김 게이트와 **같은 텍스트**(동일성은 fleet-gate 테스트가 대조한다). */
const notHiddenFrag = (alias: string): SQL => sql`NOT EXISTS (
    SELECT 1 FROM summary_cycles c
     WHERE c.cycle_id = ${sql.raw(alias)}.cycle_id
       AND c.hidden_reason IS NOT NULL
  )`;
/** 프로덕션의 함대 게이트와 **같은 텍스트**. */
const fleetFrag = (alias: string): SQL => sql`(${sql.raw(alias)}.surface = 'project' OR EXISTS (
    SELECT 1 FROM summary_cycles sc
     WHERE sc.cycle_id = ${sql.raw(alias)}.cycle_id
       AND sc.fleet_visible
       AND sc.view_anchor_at IS NOT NULL AND sc.view_anchor_at <= now()
       AND sc.active_generation_id IS NOT NULL
  ))`;

/** 축 on 판정과 컬럼 프로브를 DB 없이 고정한다. */
export function fixAxisOnForDump(): void {
  for (const [t, c] of SYNC_PROBED_COLUMNS) setColumnAvailabilityForTests(t, c, true);
  setAnchorAxisForTests(
    true,
    { ca: notHiddenFrag("ca"), ca2: notHiddenFrag("ca2") },
    undefined,
    { ca: fleetFrag("ca"), ca2: fleetFrag("ca2") },
  );
}

/** 리터럴 인라인 — uuid 로 보이면 `::uuid`. 배열 캐스트는 빌더가 붙이므로 여기선 안 붙인다. */
function literal(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v instanceof Date) return `'${v.toISOString()}'::timestamptz`;
  if (Array.isArray(v)) return `ARRAY[${v.map((x) => literal(x)).join(", ")}]`;
  const s = String(v).replace(/'/g, "''");
  return UUID_RE.test(String(v)) ? `'${s}'::uuid` : `'${s}'`;
}

/** 컴파일 + 인라인. `$12` 를 `$1` 보다 먼저 치환하려고 번호 내림차순으로 돈다. */
function compile(q: SQL): string {
  const { sql: text, params } = dialect.sqlToQuery(q);
  let out = text;
  for (let i = params.length; i >= 1; i -= 1) {
    out = out.split(`$${i}`).join(literal(params[i - 1]));
  }
  if (/\$\d/.test(out)) throw new Error(`인라인 안 된 바인드가 남았다: ${out.slice(0, 200)}`);
  if (out.includes(";")) throw new Error("세미콜론이 들어갔다 — 단일 문장 규약 위반");
  return out.trim();
}

const indent = (s: string): string =>
  s.split("\n").map((l) => `  ${l}`).join("\n");

/** 글로벌 루트 프로젝트(프로덕션 미러의 실제 값). 스코프를 좁히는 용도일 뿐이다. */
const ROOT = "be28fe15-c743-4a88-abb8-182b25602812";
/** 회차를 포함한 **주 단위 창** — 프리뷰에서 대시보드가 죽던 그 창이다. */
const WEEK: StandardFilters = { dateFrom: "2026-09-07", dateTo: "2026-09-13" };
/** 달 창 — MoM 비교가 이 모수를 쓴다. */
const MONTH: StandardFilters = { dateFrom: "2026-08-01", dateTo: "2026-08-31" };

export async function buildAxisOnStatements(): Promise<AxisOnStatement[]> {
  fixAxisOnForDump();
  const agg = await import("@/lib/db/repositories/scope-aggregates");
  const anchors = await import("@/lib/db/repositories/scope-answer-anchors");
  const web = await import("@/lib/db/repositories/website-sites");
  const out: AxisOnStatement[] = [];

  out.push({
    name: "01-answer-where-standard-week.sql",
    header: `-- ① 기간 술어(글로벌 · 주 단위 창) — \`scope-aggregates.ts::answerWhere\`
--
-- 축 on 에서 기간이 \`ca.round_date\` 로 걸린다(축 off 는 a.measured_at). 이 술어가
-- 모든 카드·집계의 모수다. 아래는 그것을 그대로 세는 형태로 감쌌다.`,
    body: `SELECT count(*)::int AS answers, min(a.measured_at) AS first_at, max(a.measured_at) AS last_at
  FROM scope_answers a
 WHERE ${compile(agg.answerWhere(WEEK, ROOT))}`,
  });

  out.push({
    name: "02-answer-where-standard-month.sql",
    header: `-- ② 같은 술어의 **달 창**(2026-08-01..08-31) — MoM 비교가 이 모수를 쓴다.`,
    body: `SELECT count(*)::int AS answers, min(a.measured_at) AS first_at, max(a.measured_at) AS last_at
  FROM scope_answers a
 WHERE ${compile(agg.answerWhere(MONTH, ROOT))}`,
  });

  // ③④ KPI 탭 추이 — 프리뷰에서 42703 으로 죽던 자리.
  for (const unit of ["week", "day"] as const) {
    const axis = await agg.__testables.kpiTabTrendAxis(unit, "measured");
    const proj = compile(
      sql`SELECT ${axis.cols} FROM scope_answers a${axis.join} WHERE ${agg.answerWhere(WEEK, ROOT)}`,
    );
    const snap = compile(agg.__testables.kpiTabCellSnapshot());
    out.push({
      name: `0${unit === "week" ? 3 : 4}-kpi-trend-${unit}.sql`,
      header: `-- ${unit === "week" ? "③" : "④"} KPI 탭 추이(${unit} 버킷) — **프리뷰에서 42703 으로 죽던 자리**
--
-- 프로덕션은 이 투영을 \`CREATE TEMP TABLE _answer_set AS …\` 로 굳힌 뒤 소비 문장이
-- 그 위에서 돈다. 여기서는 단독 실행되게 **CTE 로 치환**했다(의미 동일).
-- 판정선: 에러 없이 돌면 투영 ⊇ 소비다. \`round_date\` 가 없다는 에러가 나면 그것이 결함.`,
      body: `WITH _answer_set AS (
${indent(proj)}
), ans AS (
${indent(snap)}
)
SELECT bucket,
       count(*)::int AS answers,
       count(DISTINCT date_trunc('day', measured_at))::int AS measured_days
  FROM ans GROUP BY bucket ORDER BY bucket`,
    });
  }

  out.push({
    name: "05-snapshot-run-filter.sql",
    header: `-- ⑤ 드릴다운 모집단 — \`snapshotRunFilter\`. 카드(①)와 **같은 회차**를 봐야 한다.
-- 판정선: ① 과 이 문장의 answers 가 같다(기간·계열이 같을 때).`,
    body: `SELECT count(*)::int AS answers
  FROM scope_answers a
 WHERE ${compile(agg.snapshotRunFilter(ROOT, WEEK))}`,
  });

  out.push({
    name: "06-detail-answer-where-citations.sql",
    header: `-- ⑥ 상세(인용) 답변셋 — \`detailAnswerWhere\`, 숨김 계열 \`citations\`(지면 단위 규칙 D1).
-- 판정선: 같은 기간에서 ① 보다 크지 않다(계열이 더 엄격하다).`,
    body: `SELECT count(*)::int AS answers
  FROM scope_answers a
 WHERE ${compile(agg.detailAnswerWhere(WEEK, ROOT, { hiddenFamily: "citations" }))}`,
  });

  out.push({
    name: "07-acr-where.sql",
    header: `-- ⑦ ACR 답변셋 — \`acrWhere\`. job 축이 아니라 **run 축 semi-join** 이다.
-- 계열은 \`'all'\`(ACR 은 언급·인용 어느 쪽도 아니다).`,
    body: `SELECT count(*)::int AS rows_in_scope
  FROM scope_acr_rollups x
 WHERE ${compile(agg.acrWhere(WEEK))}`,
  });

  out.push({
    name: "08-latest-acr-prompt-run-ids.sql",
    header: `-- ⑧ ACR 최신 회차 run 목록 — \`latestAcrPromptRunIds\`.`,
    body: `SELECT count(*)::int AS run_ids FROM (${compile(agg.latestAcrPromptRunIds(WEEK))}) s`,
  });

  out.push({
    name: "09-website-prompt-lens.sql",
    header: `-- ⑨ website 프롬프트 표의 **측정 렌즈** — \`website-sites.ts::websitePromptLens\`.
--
-- 축 off 는 축이 둘이었다(기간 = a.measured_at, 마지막 측정일 = cycle_anchor_at).
-- 축 on 은 둘 다 \`ca.round_date\` 로 한 축이 되고 노출 게이트가 같은 조인 위에 붙는다.
-- 판정선: 마지막 열이 카드의 "측정 기준일"과 같은 날짜여야 한다.`,
    body: `SELECT count(*)::int AS answers, to_char(max(ca.round_date), 'YYYY-MM-DD') AS last_round
  FROM scope_answers a
  JOIN scope_answer_cycle_anchors ca ON ca.job_id = a.job_id
 WHERE ${compile(web.__testables.websitePromptLens({ ...WEEK } as never))}`,
  });

  // ⑩⑪⑫ 달력 — 표면 3종. 프로젝트 목록은 앱에서 스코프로 좁혀 들어오므로 고정 배열로
  // 적을 수 없다 — 자리표시자 uuid 로 컴파일한 뒤 그 자리를 전수 서브쿼리로 바꾼다.
  const PLACEHOLDER = "00000000-0000-4000-8000-000000000000";
  const scopeRe = /ca\.project_id = ANY\(ARRAY\[[^\]]*\](?:::uuid\[\])*\)/;
  const calendars: Array<[string, "standard" | "website" | "project", string, string]> = [
    [
      "10-calendar-standard.sql",
      "standard",
      `ca.project_id = ANY(ARRAY['${ROOT}'::uuid]::uuid[])`,
      "글로벌(standard) — 루트 프로젝트 1개",
    ],
    [
      "11-calendar-website.sql",
      "website",
      "ca.project_id IN (SELECT ws.scope_project_id::uuid FROM website_sites ws WHERE ws.scope_project_id IS NOT NULL)",
      "website — 함대 전체(admin 스코프와 같은 집합)",
    ],
    [
      "12-calendar-project.sql",
      "project",
      "ca.project_id IN (SELECT p.scope_project_id::uuid FROM projects p WHERE p.scope_project_id IS NOT NULL)",
      "project — 프로젝트 표면 전체(정규 요일이 없어 round_date = anchor_date)",
    ],
  ];
  for (const [name, surface, scopeExpr, title] of calendars) {
    const text0 = compile(
      anchors.selectableAnchorDatesSql(
        surface,
        [PLACEHOLDER],
        {},
        notHiddenFrag("ca"),
        fleetFrag("ca"),
      ),
    );
    if (!scopeRe.test(text0)) throw new Error(`${name}: 스코프 자리를 못 찾았다`);
    out.push({
      name,
      header: `-- ${title} 표면의 달력 "선택 가능한 회차 날짜"
--
-- \`scope-answer-anchors.ts::selectableAnchorDatesSql\` 이 실제로 내보내는 문장이다.
-- 판정선: 반환된 **마지막 날짜** = 그 지면 달력의 기본 회차 표식 = 카드의 "측정 기준일".`,
      body: text0.replace(scopeRe, scopeExpr),
    });
  }

  // ⑬⑭ 공용 추이 격자(D5)의 **자리 목록**. 축 on 에서만 나가는 문장이고
  //     `round_date` 를 두 곳(파생 표 · COALESCE 폴백)에서 본다 — 42703 가 나기 딱 좋은 형태다.
  const grid = await import("@/lib/db/repositories/trend-grid-slots");
  const gridCases: Array<[string, "global" | "website", string, string]> = [
    [
      "13-trend-grid-slots-global.sql",
      "global",
      `c.project_id = ANY(ARRAY['${ROOT}'::uuid]::uuid[])`,
      "글로벌 — 루트 프로젝트 1개. 자리는 KST 월요일이어야 한다",
    ],
    [
      "14-trend-grid-slots-website.sql",
      "website",
      "c.project_id IN (SELECT ws.scope_project_id::uuid FROM website_sites ws WHERE ws.scope_project_id IS NOT NULL)",
      "website — 함대 전체. 자리는 KST 금요일이어야 한다",
    ],
  ];
  const gridScopeRe = /c\.project_id = ANY\(ARRAY\[[^\]]*\](?:::uuid\[\])*\)/;
  for (const [name, surface, scopeExpr, title] of gridCases) {
    const text0 = compile(
      grid.trendGridSlotSql({
        surface,
        projectIds: [ROOT],
        // 지면 계열: Overview·website 는 `'all'`(앵커 스펙 §10.2).
        family: "all",
        maxDays: 180,
        hiddenCols: true,
        scopeCol: true,
      }),
    );
    if (!gridScopeRe.test(text0)) throw new Error(`${name}: 스코프 자리를 못 찾았다`);
    out.push({
      name,
      header: `-- ${title}
--
-- \`trend-grid-slots.ts::trendGridSlotSql\` 이 실제로 내보내는 문장이다(빌더 한 벌).
-- 판정선: 한 행 = 한 자리. \`servable_cycles = 0\` 인 자리가 갭이고,
-- \`operator_cycles = total_cycles\` 이면 화면에서 자리 자체가 사라진다.`,
      // 바깥 스코프만 넓힌다 — 파생 표 안의 `ca.project_id` 는 좁힌 채로 두면
      // 자리 키가 빈다. 두 자리를 함께 바꾼다.
      body: text0
        .replace(gridScopeRe, scopeExpr)
        .replace(
          /ca\.project_id = ANY\(ARRAY\[[^\]]*\](?:::uuid\[\])*\)/,
          scopeExpr.replace(/\bc\.project_id\b/, "ca.project_id"),
        ),
    });
  }
  // ⑮⑯ **인용 주간 추이 2종** — 축 on 에서만 앵커를 조인하고, 창 바닥을 앵커로 거는
  //     자리다. 2026-09-20 검증에서 이 둘이 `sv` 별칭을 조인 없이 참조해
  //     `42P01 missing FROM-clause entry for table "sv"` 로 죽는 것이 발견됐다
  //     (격자 off · 축 on = 통합 프리뷰의 상태). 텍스트 스냅샷은 별칭 해석을 못 본다.
  //
  //     숨김 게이트(`excludeHiddenCycleRuns`)는 DB 를 읽으므로 여기서는 뺐다 — 이 덤프가
  //     보는 것은 **창 바닥과 조인 별칭**이고, 숨김 술어는 ⑥ 이 이미 덮는다.
  const citationTrendFloor = compile(
    sql`a.measured_at IS NOT NULL AND ${agg.__testables.trendWindowFloor(undefined, undefined, true)}`,
  );
  out.push({
    name: "15-citation-domain-week-trend.sql",
    header: `-- ⑮ 인용 도메인 **주간 추이** — \`scope-aggregates.ts::readCitationDomainDayCounts\`.
--
-- 판정선: 에러 없이 돌면 별칭이 전부 해석된다. \`sv\`(회차 노출 조인)를 조인 없이
-- 참조하면 42P01 로 죽는다 — 그것이 이 문장이 잡는 결함이다.`,
    body: `SELECT count(*)::int AS answers
  FROM scope_answers a
  JOIN scope_answer_cycle_anchors ca ON ca.job_id = a.job_id
 WHERE ${citationTrendFloor} AND ${compile(agg.answerWhere({}, ROOT, { allRuns: true }))}`,
  });
  out.push({
    name: "16-website-citation-accuracy-trend.sql",
    header: `-- ⑯ 웹 인용 **정확도 추이** — \`scope-aggregates.ts::aggregateWebsiteCitationAccuracyTrend\`.
-- ⑮ 와 같은 바닥·같은 조인을 쓰는 두 번째 자리다(함대 스코프).`,
    body: `SELECT count(*)::int AS answers
  FROM scope_answers a
  JOIN scope_answer_cycle_anchors ca ON ca.job_id = a.job_id
 WHERE ${compile(agg.answerWhere({}, [ROOT], { allRuns: true }))} AND ${citationTrendFloor}`,
  });

  return out;
}
