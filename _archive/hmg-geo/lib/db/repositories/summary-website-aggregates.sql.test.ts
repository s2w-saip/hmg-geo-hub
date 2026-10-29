import { describe, it, expect, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { __testables } from "./summary-website-aggregates";
import type { WebsiteCyclePick } from "./summary-cycles";
import type { StandardFilters } from "@/lib/scope/result-adapter";
import {
  resetColumnAvailabilityForTests,
  setColumnAvailabilityForTests,
} from "@/lib/db/column-availability";
import { COL_COMMON } from "@/lib/summary/generate/types";

// 사실표 조회 술어의 형태 고정 — 설계 v4.1 §6-2 웹사이트 열.
// "필터가 WHERE 에 실제로 들어가는가" 와 "글로벌 전용 게이트가 들어가지 않는가" 를
// 컴파일된 SQL 문자열로 본다. 값 대조는 데이터가 들어온 뒤 패리티 게이트(§9)의 몫이다.

const dialect = new PgDialect();
const compile = (w: SQL) => {
  const q = dialect.sqlToQuery(w);
  return { text: q.sql, params: q.params };
};

// 0063 적용 후를 기본 전제로 둔다(판정을 고정하면 프로브가 DB 를 건드리지 않는다).
beforeEach(() => {
  resetColumnAvailabilityForTests();
  setColumnAvailabilityForTests("summary_answers", "presence_set", true);
});

const CYCLES: WebsiteCyclePick[] = [
  {
    cycleId: "aaaaaaaa-0000-0000-0000-000000000001",
    generationId: "bbbbbbbb-0000-0000-0000-000000000001",
    projectId: "11111111-1111-1111-1111-111111111111",
    cycleAnchorAt: "2026-09-04T00:00:00.000Z",
    cycleWeek: "2026-08-31",
  },
];
const scope = (filters: StandardFilters = {}, unitFlags = false) => ({
  cycles: CYCLES,
  projectIds: ["11111111-1111-1111-1111-111111111111"],
  filters,
  ownedBasePrefixes: ["https://www.hyundai.com/kr/ko/", "kia.com/my"],
  unitFlags,
});

describe("answerWhere — 웹사이트 열 게이트", () => {
  it("항상 (cycle_id, generation_id) 쌍 + 주 파티션 키로 좁힌다", () => {
    const { text, params } = compile(__testables.answerWhere(scope()));
    expect(text).toContain("cycle_week = ANY");
    expect(text).toContain("(cycle_id, generation_id) IN");
    // (cycle_id, generation_id) 는 배열 바인드 1쌍(B4-a) — 쌍 의미론은 unnest 조인으로 유지.
    expect(text).toContain("unnest(");
    expect(params).toContainEqual(["aaaaaaaa-0000-0000-0000-000000000001"]);
    expect(params).toContainEqual(["bbbbbbbb-0000-0000-0000-000000000001"]);
    // 주(파티션 키)는 스칼라 펼침 — date[] 배열 바인드는 drizzle 직렬화기 함정, text[] 우회는 프루닝 소실.
    expect(text).toMatch(/ARRAY\[\$\d+\]::date\[\]/);
    expect(params).toContain("2026-08-31");
  });

  it("run 상태 게이트는 조회 시 적용된다", () => {
    const { text } = compile(__testables.answerWhere(scope()));
    expect(text).toContain("run_status IN ('completed', 'partial_failed')");
  });

  it("글로벌 전용 게이트(in_root_catalog · in_tagged_region · in_full_cycle · 숨김 국가)는 없다", () => {
    const { text } = compile(__testables.answerWhere(scope({ websiteCountry: ["KR"] })));
    expect(text).not.toContain("in_root_catalog");
    expect(text).not.toContain("in_tagged_region");
    expect(text).not.toContain("in_full_cycle");
    expect(text).not.toContain("NOT IN");
  });

  it("국가는 websiteCountry verbatim (가상 코드 환원 없음)", () => {
    const { text, params } = compile(
      __testables.answerWhere(scope({ websiteCountry: ["worldwide", "middleeast"] })),
    );
    expect(text).toContain("country IN");
    expect(params).toContain("worldwide");
    expect(params).toContain("middleeast");
  });

  it("브랜드 가상 코드(HYUNDAI-N)는 그 브랜드 사이트의 project_id 로 푼다 (website-geo-pred)", () => {
    const { text, params } = compile(
      __testables.answerWhere(scope({ websiteCountry: ["worldwide", "HYUNDAI-N"] })),
    );
    expect(text).toContain("country IN");
    expect(text).toContain("project_id IN (SELECT scope_project_id::uuid FROM website_sites WHERE brand IN");
    expect(params).toContain("worldwide");
    expect(params).toContain("Hyundai N");
    expect(params).not.toContain("HYUNDAI-N");
  });

  it("언어는 소문자 (website_prompts.lang_code 원천)", () => {
    const { text, params } = compile(__testables.answerWhere(scope({ lang: ["KO", "en"] })));
    expect(text).toContain("lang = ANY");
    expect(params).toContain("ko");
    expect(params).toContain("en");
    expect(params).not.toContain("KO");
  });

  it("엔진·퍼널·리스트·depth 축이 WHERE 에 들어간다", () => {
    const { text, params } = compile(
      __testables.answerWhere(
        scope({
          engine: ["chatgpt"],
          funnelStage: ["인지/탐색"],
          listType: ["Brand Message"],
          depth1: ["EV"],
          depth2: ["d2"],
          depth3: ["d3"],
        }),
      ),
    );
    expect(text).toContain("engine = ANY");
    // 대시보드(S4) 의 funnel 원천은 catalog — COALESCE(인용 화면 규칙)가 아니다.
    expect(text).toContain("funnel_catalog = ANY");
    expect(text).not.toContain("funnel_scope");
    expect(text).toContain("list_type = ANY");
    expect(text).toContain("depth1 = ANY");
    expect(params).toContain("chatgpt");
    expect(params).toContain("EV");
    expect(params).toContain("d3");
  });

  // 글로벌 열과 **같은 술어**(lib/summary/read/presence.ts). 웹사이트 표면에서는 값이
  // 바뀌지 않는다 — website_prompts 12,685건 중 루트 카탈로그 매칭 0건(2026-09-06 실측).
  it("brandPresence 는 presence_set 교집합으로 좁힌다 (둘 다 = 무필터)", () => {
    const one = compile(__testables.answerWhere(scope({ brandPresence: ["unbranded"] })));
    expect(one.text).toContain("presence_set &&");
    expect(one.text).toContain("::text[]");
    expect(one.params).toContainEqual(["unbranded"]);
    const both = compile(
      __testables.answerWhere(scope({ brandPresence: ["branded", "unbranded"] })),
    );
    expect(both.text).not.toContain("presence_set");
    expect(both.text).not.toContain("brand_presence_resolved");
  });

  it("0063 미적용(프로브 false)이면 종전 술어로 폴백한다", () => {
    setColumnAvailabilityForTests("summary_answers", "presence_set", false);
    const one = compile(__testables.answerWhere(scope({ brandPresence: ["branded"] })));
    expect(one.text).toContain("brand_presence_resolved =");
    expect(one.text).not.toContain("presence_set");
  });
});

describe("factScope — 브랜드·도메인·타겟 표는 답변 모수를 조인한다", () => {
  // 집계층 경로(S4/S6)와 ⑥(`summary_target_hits`)은 종전 술어를 그대로 쓴다.
  // 세부층 폴백만 `detailFactScope` 로 갈아탄다(아래 T10 블록).
  it("job 집합을 summary_answers 에서 가져온다 (표 간 모수 일치)", () => {
    const { text } = compile(__testables.factScope(scope({ lang: ["ko"] })));
    expect(text).toContain("job_id IN (");
    expect(text).toContain("FROM summary_answers WHERE");
    // 회차 술어는 자식 표에도 직접 걸린다(파티션 프루닝).
    expect(text).toContain("cycle_week = ANY");
  });
});

// ── T10 · E4 세부층 폴백 경로: 조인 제거의 전제를 형태로 고정 ────────────────
//
// `detailFactScope` 는 공유 축(`sharedWhere`)을 사실표에 **직접** 걸고, 답변 표에만
// 있는 유닛 게이트(`report_fs`)만 좁은 세미조인으로 남긴다. 근거는 세부층 3표가
// 공통 차원 19열(COL_COMMON)을 같은 한 행에서 받아 적는다는 생성기 계약이다.
const ALLOWED_COLUMNS = new Set([
  ...COL_COMMON.split(",").map((c) => c.trim()),
  "cycle_week",
  "cycle_id",
  "generation_id",
]);
/** 컴파일된 술어에 등장하는 SQL 키워드·타입·함수 — 컬럼 후보에서 뺀다. */
const SQL_TOKENS = new Set([
  "and", "or", "not", "in", "is", "null", "any", "all", "array", "true", "false",
  "text", "uuid", "date", "int", "int4", "integer", "numeric", "boolean",
  "coalesce", "select", "from", "where", "unnest", "as", "p", "c", "g",
  "scope_project_id", "website_sites", "brand",
]);
function columnsOf(text: string): string[] {
  const stripped = text.replace(/'[^']*'/g, " ");
  const ids = [...stripped.matchAll(/\b[a-z_][a-z0-9_]*\b/g)].map((m) => m[0]);
  return [...new Set(ids)].filter((id) => !SQL_TOKENS.has(id));
}

describe("detailFactScope — 세부층 폴백은 공유 축을 사실표에 직접 건다 (T10)", () => {
  const WORST: StandardFilters = {
    websiteCountry: ["DE", "worldwide"],
    lang: ["ko", "en"],
    engine: ["chatgpt", "gemini"],
    funnelStage: ["인지/탐색"],
    listType: ["Brand Message"],
    depth1: ["EV"],
    depth2: ["d2"],
    depth3: ["d3"],
    brandPresence: ["branded"],
  };

  it("유닛 게이트가 없으면 세미조인 자체가 없다", () => {
    const { text } = compile(__testables.detailFactScope(scope(WORST, false)));
    expect(text).not.toContain("job_id IN (");
    expect(text).not.toContain("summary_answers");
    expect(text).toContain("cycle_week = ANY");
  });

  it("유닛 게이트가 없으면 detailFactScope 와 answerWhere 의 술어 차집합이 0", () => {
    const d = compile(__testables.detailFactScope(scope(WORST, false)));
    const w = compile(__testables.answerWhere(scope(WORST, false)));
    expect(d.text).toBe(w.text);
    expect(d.params).toEqual(w.params);
  });

  it("공유 축(sharedWhere)이 참조하는 컬럼은 전부 COL_COMMON(+회차 키) 안이다", () => {
    for (const filters of [{} as StandardFilters, WORST]) {
      const { text } = compile(
        __testables.answerWhere({ ...scope(filters, false) }),
      );
      const unknown = columnsOf(text).filter((c) => !ALLOWED_COLUMNS.has(c));
      expect(unknown, `COL_COMMON 밖 컬럼: ${unknown.join(", ")}`).toEqual([]);
    }
  });

  it("유닛 게이트가 있으면 그 축만 세미조인에 남는다 (필터 축 복제 없음)", () => {
    const { text } = compile(
      __testables.detailFactScope({ ...scope(WORST, true), excludedUnits: [71] }),
    );
    // 바깥: 공유 축이 사실표에 직접 걸린다.
    expect(text).toContain("depth3 = ANY");
    // 안쪽: 회차·프로젝트·유닛 게이트만.
    const inner = text.slice(text.indexOf("job_id IN ("));
    expect(inner).toContain("report_fs IS NOT NULL");
    expect(inner).toContain("report_fs <> ALL");
    expect(inner).not.toContain("depth3");
    expect(inner).not.toContain("funnel_catalog");
    expect(inner).not.toContain("presence_set");
    // 유닛 게이트는 답변 표 전용 축이라 공유 축에는 없어야 한다.
    expect(text.slice(0, text.indexOf("job_id IN ("))).not.toContain("report_fs");
  });

  // 가상 브랜드 코드(HYUNDAI-N)는 `project_id IN (SELECT … website_sites …)` 가 된다.
  // 사실표와 **상관 없는 독립 서브쿼리**(값 조회)라 조인 제거의 전제를 깨지 않는다 —
  // 바깥 컬럼은 여전히 `project_id` 하나다.
  it("가상 브랜드 코드도 바깥 컬럼은 project_id 하나다", () => {
    const { text } = compile(__testables.detailFactScope(scope({ websiteCountry: ["HYUNDAI-N"] }, false)));
    expect(text).toContain("project_id IN (SELECT");
    expect(text).toContain("FROM website_sites");
    expect(text).not.toContain("summary_answers");
  });

  it("unitWhere 는 report_fs 축만 낸다", () => {
    expect(__testables.unitWhere(scope({}, false))).toEqual([]);
    const on = __testables.unitWhere({ ...scope({}, true), excludedUnits: [71] });
    expect(on).toHaveLength(2);
    for (const cond of on) expect(compile(cond).text).toContain("report_fs");
  });

  // 탐지기가 공허하지 않은지 스스로 증명한다.
  it("탐지기 자체 검증: COL_COMMON 밖 컬럼은 실제로 잡힌다", () => {
    const probe = "report_fs IS NOT NULL AND country = ANY($1::text[]) AND unit_owned = 1";
    expect(columnsOf(probe).filter((c) => !ALLOWED_COLUMNS.has(c)).sort()).toEqual([
      "report_fs",
      "unit_owned",
    ]);
  });
});

describe("유닛 고유 플래그(0060) — 보고서 v2.4 정합", () => {
  it("플래그가 있으면 유닛 밖 프롬프트를 모수에서 뺀다", () => {
    const { text } = compile(__testables.answerWhere(scope({}, true)));
    expect(text).toContain("report_fs IS NOT NULL");
  });

  it("보고서 제외 유닛(website_excluded_fs)은 플래그가 있을 때만 모수에서 뺀다", () => {
    const { text, params } = compile(__testables.answerWhere({ ...scope({}, true), excludedUnits: [71, 94, 97] }));
    expect(text).toContain("report_fs <> ALL");
    expect(JSON.stringify(params)).toContain("71");
    const off = compile(__testables.answerWhere({ ...scope({}, false), excludedUnits: [71, 94, 97] }));
    expect(off.text).not.toContain("report_fs");
    const none = compile(__testables.answerWhere({ ...scope({}, true), excludedUnits: [] }));
    expect(none.text).not.toContain("<> ALL");
  });

  it("플래그가 없으면(0060 미적용) 모수 게이트도 없다 — 종전 동작", () => {
    const { text } = compile(__testables.answerWhere(scope({}, false)));
    expect(text).not.toContain("report_fs");
  });

  it("⑤ 분자는 유닛 카운트를 그대로 더한다(판정 없음)", () => {
    const { text } = compile(__testables.ownedCitationsSum(scope({}, true)));
    expect(text).toContain("sum(unit_owned_citations)");
    expect(text).not.toContain("matched_base");
  });

  it("인용 표 isOurs 도 같은 유닛 판정 (⑤ 와 대조 가능해야 한다)", () => {
    const { text } = compile(__testables.ownedDomainAgg(scope({}, true)));
    expect(text).toContain("bool_or(unit_owned_citations > 0)");
  });

  it("플래그 없으면 ⑤ 분자는 종전 $sel/matched_base 판정으로 폴백", () => {
    const { text } = compile(__testables.ownedCitationsSum(scope({}, false)));
    expect(text).toContain("matched_base = ANY");
    expect(text).not.toContain("unit_owned_citations");
  });
});

describe("ownedCitationExpr — ⑤ 분자", () => {
  it("matched_base 최장 일치 + base 정규화 불가 행의 도메인 서픽스 폴백", () => {
    const { text, params } = compile(
      __testables.ownedCitationExpr(["https://www.hyundai.com/kr/ko/", "kia.com/my"]),
    );
    expect(text).toContain("matched_base <> ''");
    expect(text).toContain("matched_base = ANY");
    expect(text).toContain("base_norm_null = 1");
    expect(text).toContain("domain ~*");
    // 서픽스 정규식은 라벨 경계 앵커드 — nothyundai.com 이 걸리면 안 된다.
    const pattern = params.find((p) => typeof p === "string" && p.startsWith("(^|\\.)"));
    expect(pattern).toBeTruthy();
    expect(new RegExp(String(pattern), "i").test("www.hyundai.com")).toBe(true);
    expect(new RegExp(String(pattern), "i").test("nothyundai.com")).toBe(false);
  });

  it("base 목록이 비면 판정은 false (공집합이 전부를 자사로 만들지 않는다)", () => {
    const { text } = compile(__testables.ownedCitationExpr([]));
    expect(text).toContain("false");
    expect(text).not.toContain("matched_base = ANY");
  });
});

// ── 바인드 수 (B4-a) ────────────────────────────────────────────────────────
// 웹사이트 함대는 회차 95개 = 프로젝트 95개다. 종전에는 회차 쌍·프로젝트 id 가
// 전부 개별 바인드로 펼쳐져 문장 하나가 수백 개의 `$n` 을 갖고 있었고(실측:
// answerWhere $286 · factScope $477 · 프로덕션 pgss $773), id 개수가 바뀔 때마다
// 문장 텍스트가 달라져 계획이 재사용되지 않았다. 배열 바인드로 상수화한다.
describe("cycle_week 배열 바인딩 형태 — 프루닝·직렬화 함정 고정", () => {
  // drizzle-orm/postgres-js 가 date[](OID 1182) 직렬화기를 항등으로 덮어써 `sql.param(배열)::date[]`
  // 는 실DB 에서 죽고, `::text[]::date[]` 우회는 파티션 프루닝을 없앤다(2026-09-10 실측).
  // 주는 1~2개라 스칼라 펼침 `ARRAY[$n, $m]::date[]` 가 정답 — 그 형태를 고정한다.
  const pick = (week: string, i: number): WebsiteCyclePick => ({
    cycleId: `aaaaaaaa-0000-0000-0000-${String(i).padStart(12, "0")}`,
    generationId: `bbbbbbbb-0000-0000-0000-${String(i).padStart(12, "0")}`,
    projectId: `11111111-1111-1111-1111-${String(i).padStart(12, "0")}`,
    cycleAnchorAt: `${week}T00:00:00.000Z`,
    cycleWeek: week,
  });
  const scopeOf = (weeks: string[]) => ({
    cycles: weeks.map((w, i) => pick(w, i + 1)),
    projectIds: weeks.map((_, i) => pick("2026-08-31", i + 1).projectId),
    filters: {} as StandardFilters,
    ownedBasePrefixes: ["https://www.hyundai.com/kr/ko/"],
    unitFlags: false,
  });
  it("주 2개 → ARRAY[$n, $m]::date[] (sql.param 배열·text[] 우회 금지)", () => {
    const q = compile(__testables.factScope(scopeOf(["2026-08-31", "2026-09-07"])));
    expect(q.text).toMatch(/ARRAY\[\$\d+, \$\d+\]::date\[\]/);
    expect(q.text).not.toContain("::text[]::date[]");
    expect(q.text).not.toMatch(/\$\d+::date\[\]/);
    expect(q.params).toEqual(expect.arrayContaining(["2026-08-31", "2026-09-07"]));
  });
});

// ⚠️ 아래 상한(30)은 **대표 필터 기준**이지 진짜 최악이 아니다(T11 검증 F3).
// 축마다 값을 더 넣거나 주가 2개면 넘는다 — 검증자 실측 HEAVY·2주 조합 = **32**.
// 규율의 목적은 "회차·프로젝트 개수가 늘어도 바인드가 안 는다"(B4-a, 배열 바인드)를
// 지키는 것이지 절대 상한이 아니다. 새 축을 더할 때는 이 테스트를 통과시키려 값을
// 줄이지 말고, **배열 바인드 1개** 형태를 지키는지부터 보라.
describe("바인드 수 — 함대 95 회차에서도 상수 (대표 필터 기준)", () => {
  const hex = (n: number) => n.toString(16).padStart(12, "0");
  const FLEET: WebsiteCyclePick[] = Array.from({ length: 95 }, (_, i) => ({
    cycleId: `aaaaaaaa-0000-0000-0000-${hex(i + 1)}`,
    generationId: `bbbbbbbb-0000-0000-0000-${hex(i + 1)}`,
    projectId: `11111111-1111-1111-1111-${hex(i + 1)}`,
    cycleAnchorAt: "2026-09-04T00:00:00.000Z",
    cycleWeek: "2026-08-31",
  }));
  const fleetScope = (filters: StandardFilters = {}) => ({
    cycles: FLEET,
    projectIds: FLEET.map((c) => c.projectId),
    filters,
    ownedBasePrefixes: ["https://www.hyundai.com/kr/ko/"],
    unitFlags: false,
  });
  const maxBind = (text: string) =>
    Math.max(0, ...[...text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));

  it("answerWhere · factScope · detailFactScope 의 최대 바인드 번호가 30 이하", () => {
    const w = compile(__testables.answerWhere(fleetScope()));
    const f = compile(__testables.factScope(fleetScope()));
    expect(maxBind(w.text)).toBeLessThanOrEqual(30);
    expect(maxBind(f.text)).toBeLessThanOrEqual(30);
    // 세부층 폴백(T10). 유닛 게이트 on 이 최악(안쪽 세미조인이 회차·프로젝트를 한 번 더 쓴다).
    const d = compile(
      __testables.detailFactScope({ ...fleetScope(), unitFlags: true, excludedUnits: [71, 94] }),
    );
    expect(maxBind(d.text)).toBeLessThanOrEqual(30);
  });

  it("대표 필터를 얹어도 30 이하 (필터 축 텍스트 배열은 종전 형태 유지)", () => {
    const REP: StandardFilters = {
      lang: ["ko", "en"],
      engine: ["chatgpt", "gemini"],
      funnelStage: ["인지/탐색"],
      listType: ["Brand Message"],
      depth1: ["EV"],
      depth2: ["d2"],
      depth3: ["d3"],
    };
    const d = compile(
      __testables.detailFactScope({ ...fleetScope(REP), unitFlags: true, excludedUnits: [71, 94] }),
    );
    expect(maxBind(d.text)).toBeLessThanOrEqual(30);
    const f = compile(
      __testables.factScope(
        fleetScope({
          lang: ["ko", "en"],
          engine: ["chatgpt", "gemini"],
          funnelStage: ["인지/탐색"],
          listType: ["Brand Message"],
          depth1: ["EV"],
          depth2: ["d2"],
          depth3: ["d3"],
        }),
      ),
    );
    expect(maxBind(f.text)).toBeLessThanOrEqual(30);
  });

  it("회차 개수가 달라져도 SQL 텍스트가 같다 (계획 재사용)", () => {
    const one = compile(__testables.answerWhere(scope())).text;
    const many = compile(__testables.answerWhere(fleetScope())).text;
    expect(many).toBe(one);
  });

  it("쌍 의미론 유지 — cycle × generation 교차곱이 아니다", () => {
    const { text } = compile(__testables.cycleScope(FLEET));
    expect(text).toContain("(cycle_id, generation_id) IN");
    expect(text).not.toMatch(/cycle_id = ANY[\s\S]*generation_id = ANY/);
  });
});
