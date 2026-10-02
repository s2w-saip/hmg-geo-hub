import { describe, it, expect, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { __testables } from "./summary-global-aggregates";
import type { SummaryCyclePick } from "./summary-cycles";
import type { StandardFilters } from "@/lib/scope/result-adapter";
import {
  resetColumnAvailabilityForTests,
  setColumnAvailabilityForTests,
} from "@/lib/db/column-availability";
import { COL_COMMON } from "@/lib/summary/generate/types";
import { HIDDEN_STANDARD_REGIONS } from "@/lib/scope/hidden-regions";

// 사실표 조회 술어의 형태 고정 — 설계 v4.1 §6-2 **글로벌 열**.
// "글로벌 전용 게이트 4종이 실제로 들어가는가"·"브랜드가 배열 any-match 인가"·
// "숨김 국가가 빠지는가" 를 컴파일된 SQL 문자열로 본다. 값 대조는 데이터가 들어온
// 뒤 패리티 게이트(§9-1)의 몫이다.

const dialect = new PgDialect();
const compile = (w: SQL) => {
  const q = dialect.sqlToQuery(w);
  return { text: q.sql, params: q.params };
};

const ROOT = "be28fe15-c743-4a88-abb8-182b25602812";
const CYCLE: SummaryCyclePick = {
  cycleId: "cccccccc-0000-0000-0000-000000000001",
  generationId: "dddddddd-0000-0000-0000-000000000001",
  projectId: ROOT,
  cycleAnchorAt: "2026-08-31T00:00:00.000Z",
  cycleWeek: "2026-08-31",
};
// 0061 적용 후를 기본 전제로 둔다(판정을 고정하면 프로브가 DB 를 건드리지 않는다).
beforeEach(() => {
  resetColumnAvailabilityForTests();
  setColumnAvailabilityForTests("summary_answers", "presence_set", true);
});

const scope = (filters: StandardFilters = {}) => ({
  cycle: CYCLE,
  rootProjectId: ROOT,
  filters,
  ownedBasePrefixes: ["https://www.hyundai.com/kr/ko/", "kia.com/my"],
});

describe("answerWhere — 글로벌 열 게이트", () => {
  it("회차는 (cycle_id, generation_id) 쌍 + 주 파티션 키 + 루트 프로젝트로 좁힌다", () => {
    const { text, params } = compile(__testables.answerWhere(scope()));
    expect(text).toContain("cycle_week =");
    expect(text).toContain("cycle_id =");
    expect(text).toContain("generation_id =");
    expect(text).toContain("project_id =");
    expect(params).toContain(CYCLE.cycleId);
    expect(params).toContain(CYCLE.generationId);
    expect(params).toContain(CYCLE.cycleWeek);
    expect(params).toContain(ROOT);
  });

  it("run 상태 게이트는 조회 시 적용된다", () => {
    const { text } = compile(__testables.answerWhere(scope()));
    expect(text).toContain("run_status IN ('completed', 'partial_failed')");
  });

  it("글로벌 전용 게이트 3종이 전부 들어간다 (§6-2 S1 열)", () => {
    const { text } = compile(__testables.answerWhere(scope()));
    // 705 루트 카탈로그 · 지역태그/한국어 비-KR 제외 · full-cycle 프롬프트 게이트.
    expect(text).toContain("in_root_catalog = 1");
    expect(text).toContain("in_tagged_region = 1");
    expect(text).toContain("in_full_cycle = 1");
  });

  it("숨김 국가 목록이 비면 국가 제외 절이 없다 (2026-09-28 ID 해제 — hidden-regions.ts)", () => {
    const { text, params } = compile(__testables.answerWhere(scope()));
    expect(HIDDEN_STANDARD_REGIONS).toEqual([]);
    expect(text).not.toContain("country <> ALL");
    expect(params).not.toContain("ID");
  });

  it("국가는 filters.region (ISO) — RHQ 환원은 상류에서 끝났다", () => {
    const { text, params } = compile(__testables.answerWhere(scope({ region: ["KR", "AE"] })));
    expect(text).toContain("country = ANY");
    expect(params).toContain("KR");
    expect(params).toContain("AE");
    // 웹사이트 축(가상 코드 project_id 환원)은 글로벌에 없다.
    expect(text).not.toContain("website_sites");
  });

  it("언어는 대문자 (scope_prompts.lang 원천 — 웹사이트와 반대)", () => {
    const { text, params } = compile(__testables.answerWhere(scope({ lang: ["ko", "EN"] })));
    expect(text).toContain("lang = ANY");
    expect(params).toContain("KO");
    expect(params).toContain("EN");
    expect(params).not.toContain("ko");
  });

  it("브랜드는 catalog_brands 배열 any-match (오늘의 prompts.brand 세미조인 재현)", () => {
    const { text, params } = compile(__testables.answerWhere(scope({ brand: ["Kia", "HMG"] })));
    expect(text).toContain("catalog_brands &&");
    expect(params).toContain("Kia");
    // 비admin 락의 'HMG' 는 **상류**(standard-filters.ts)가 넣는다 — 여기서 더하지
    // 않는다(더하면 admin 이 브랜드를 고른 화면의 모수가 오늘과 달라진다).
    expect(params).toContain("HMG");
    const admin = compile(__testables.answerWhere(scope({ brand: ["Kia"] })));
    expect(admin.params).not.toContain("HMG");
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
    // 대시보드(S1) 의 funnel 원천은 catalog — COALESCE(인용 화면 규칙)가 아니다.
    expect(text).toContain("funnel_catalog = ANY");
    expect(text).not.toContain("funnel_scope");
    expect(text).toContain("list_type = ANY");
    expect(text).toContain("depth1 = ANY");
    expect(params).toContain("chatgpt");
    expect(params).toContain("EV");
    expect(params).toContain("d3");
  });

  // brandPresence 는 스칼라 등호가 아니라 **유도 집합 교집합**이다(0061). 미러가
  // ① 유도값(COALESCE(brand_presence, brand 규칙))이고 ② 카탈로그 중복 행 any-match 라,
  // 원값 스칼라로 비교하면 갈린다(2026-09-06: branded 격자 답변 12,776 vs 20,712).
  it("brandPresence 는 presence_set 교집합으로 좁힌다 (둘 다 = 무필터)", () => {
    const one = compile(__testables.answerWhere(scope({ brandPresence: ["unbranded"] })));
    expect(one.text).toContain("presence_set &&");
    expect(one.text).not.toContain("brand_presence_resolved");
    // 배열은 반드시 바인드 파라미터로 — 템플릿 직접 삽입은 실 DB 에서 record 캐스트로 죽는다.
    expect(one.text).toContain("::text[]");
    expect(one.params).toContainEqual(["unbranded"]);
    const both = compile(
      __testables.answerWhere(scope({ brandPresence: ["branded", "unbranded"] })),
    );
    expect(both.text).not.toContain("presence_set");
    expect(both.text).not.toContain("brand_presence_resolved");
  });

  it("0061 미적용(프로브 false)이면 종전 술어로 폴백한다", () => {
    setColumnAvailabilityForTests("summary_answers", "presence_set", false);
    const one = compile(__testables.answerWhere(scope({ brandPresence: ["branded"] })));
    expect(one.text).toContain("brand_presence_resolved =");
    expect(one.text).not.toContain("presence_set");
    expect(one.params).toContain("branded");
  });

  it("웹사이트 전용 축(report_fs 유닛 게이트)은 글로벌에 없다", () => {
    const { text } = compile(__testables.answerWhere(scope()));
    expect(text).not.toContain("report_fs");
    expect(text).not.toContain("unit_owned");
  });
});

// ── T10 · E4 세부층 폴백 경로: 조인 제거의 전제를 형태로 고정 ────────────────
//
// `factScope` 는 이제 `answerWhere` 를 브랜드·도메인 표에 **그대로** 건다. 그것이
// 성립하는 유일한 근거는 "세부층 3표가 공통 차원 19열(COL_COMMON)을 같은 한 행에서
// 받아 적는다"이다. 그래서 여기서 고정할 것은 두 가지다:
//   ① 두 술어가 **글자 그대로 같다**(차집합 0)
//   ② 술어가 참조하는 컬럼이 전부 COL_COMMON(+ 회차 키) 안에 있다
// ②가 깨지는 순간(= 답변 표에만 있는 축이 answerWhere 에 추가되는 순간) 이 테스트가
// 먼저 터진다 — 웹사이트 열의 `report_fs` 가 정확히 그런 축이고, 그쪽은
// `sharedWhere`/`unitWhere` 로 갈라 두었다.
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
  "coalesce", "select", "from", "where",
]);
/** 술어 텍스트에서 컬럼 후보 식별자만 뽑는다(문자열 리터럴 제거 후). */
function columnsOf(text: string): string[] {
  const stripped = text.replace(/'[^']*'/g, " ");
  const ids = [...stripped.matchAll(/\b[a-z_][a-z0-9_]*\b/g)].map((m) => m[0]);
  return [...new Set(ids)].filter((id) => !SQL_TOKENS.has(id));
}

describe("factScope — 세부층 3표에 답변 모수 술어를 직접 건다 (T10 · 조인 제거)", () => {
  const WORST: StandardFilters = {
    region: ["KR", "US"],
    lang: ["KO", "EN"],
    engine: ["chatgpt", "gemini"],
    funnelStage: ["인지/탐색"],
    listType: ["Brand Message"],
    depth1: ["EV"],
    depth2: ["d2"],
    depth3: ["d3"],
    brandPresence: ["branded"],
    brand: ["Hyundai", "Kia"],
  };

  it("job 세미조인이 없다 (오늘의 `job_id IN (SELECT … summary_answers)` 제거)", () => {
    const { text } = compile(__testables.factScope(scope(WORST)));
    expect(text).not.toContain("job_id IN (");
    expect(text).not.toContain("summary_answers");
    // 회차 술어는 자식 표에도 직접 걸린다(파티션 프루닝).
    expect(text).toContain("cycle_week =");
  });

  it("factScope 와 answerWhere 의 술어 차집합이 0 (`a ∩ o` 의미론 불변)", () => {
    const f = compile(__testables.factScope(scope(WORST)));
    const w = compile(__testables.answerWhere(scope(WORST)));
    expect(f.text).toBe(w.text);
    expect(f.params).toEqual(w.params);
  });

  it("술어가 참조하는 컬럼이 전부 COL_COMMON(+회차 키) 안에 있다", () => {
    for (const filters of [{} as StandardFilters, WORST]) {
      const { text } = compile(__testables.answerWhere(scope(filters)));
      const unknown = columnsOf(text).filter((c) => !ALLOWED_COLUMNS.has(c));
      expect(unknown, `COL_COMMON 밖 컬럼: ${unknown.join(", ")}`).toEqual([]);
    }
  });

  // 탐지기가 공허하지 않은지 스스로 증명한다 — `report_fs`(답변 표 전용)를 넣으면 잡혀야 한다.
  it("탐지기 자체 검증: COL_COMMON 밖 컬럼은 실제로 잡힌다", () => {
    const probe = "report_fs IS NOT NULL AND country = ANY($1::text[]) AND unit_owned = 1";
    expect(columnsOf(probe).filter((c) => !ALLOWED_COLUMNS.has(c)).sort()).toEqual([
      "report_fs",
      "unit_owned",
    ]);
  });

  it("0061 미적용 폴백(brand_presence_resolved)도 COL_COMMON 안이다", () => {
    setColumnAvailabilityForTests("summary_answers", "presence_set", false);
    const { text } = compile(__testables.answerWhere(scope({ brandPresence: ["branded"] })));
    expect(columnsOf(text).filter((c) => !ALLOWED_COLUMNS.has(c))).toEqual([]);
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
    // 서픽스 정규식은 **라벨 경계 앵커드**(SA:305-308): 서브도메인은 잡고 부분일치는 안 잡는다.
    const pattern = params.find((p) => typeof p === "string" && p.startsWith("(^|\\."));
    expect(pattern).toBeTruthy();
    const re = new RegExp(String(pattern), "i");
    expect(re.test("hyundai.com")).toBe(true);
    expect(re.test("www.hyundai.com")).toBe(true);
    expect(re.test("shop.kia.com")).toBe(true);
    expect(re.test("nothyundai.com")).toBe(false);
    // 다른 등록가능 도메인(hyundai.com.mx)은 그 도메인이 base 로 선언됐을 때만 잡힌다 —
    // `hyundai.com` base 하나로 자동으로 잡히지 않는다(스코프 누수 방지).
    expect(re.test("www.hyundai.com.mx")).toBe(false);
  });

  it("$sel 은 matched_base 와 같은 정규형으로 접힌다 (ownedBasePrefixFromUrl)", () => {
    const { params } = compile(
      __testables.ownedCitationExpr(["https://www.hyundai.com/kr/ko/", "http://www.hyundai.com/kr/ko"]),
    );
    // 두 표기가 한 값으로 접혀 배열 원소가 1개여야 한다(스킴·`www.`·끝슬래시 제거).
    const bases = params.filter((p) => typeof p === "string" && String(p).startsWith("hyundai.com"));
    expect(bases).toEqual(["hyundai.com/kr/ko"]);
  });

  it("base 목록이 비면 판정은 false (공집합이 전부를 자사로 만들지 않는다)", () => {
    const { text } = compile(__testables.ownedCitationExpr([]));
    expect(text).toContain("false");
    expect(text).not.toContain("matched_base = ANY");
  });
});
