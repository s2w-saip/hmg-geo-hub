import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  buildTrendStatements,
  planTrendRead,
  resolveOwnVariantKey,
  trendUnsupportedAxisReason,
  __testables,
  type TrendReadScope,
} from "./summary-trend-aggregates";
import type { CycleSet } from "@/lib/summary/read/cycle-set";
import type { StandardFilters } from "@/lib/scope/result-adapter";
import { OWN_VARIANT_ALL } from "@/lib/summary/generate/fold";

// 집계층 리더의 **형태**를 고정한다 — PR② T4 수용 기준 ①②③.
//   ① 대시보드 1회 렌더의 집계층 문장 수 ≤ 4
//   ② 컴파일 SQL 최대 바인드 ≤ 30
//   ③ 회차 집합 파라미터화(id 인라인 0)
// 값 대조는 패리티 게이트(플랜 §7)의 몫이고, 여기는 컴파일된 SQL 문자열만 본다.

const dialect = new PgDialect();
const compile = (q: SQL) => {
  const c = dialect.sqlToQuery(q);
  return { text: c.sql, params: c.params };
};

const UUID = (n: number) => `${String(n).padStart(8, "0")}-0000-0000-0000-000000000000`;

const globalSet: CycleSet = {
  surface: "global",
  mode: "snapshot",
  cycles: [
    {
      cycleId: UUID(1),
      generationId: UUID(2),
      projectId: UUID(3),
      cycleAnchorAt: "2026-08-31T00:00:00.000Z",
      cycleWeek: "2026-08-31",
    },
  ],
  cycleKey: `${UUID(1)}:${UUID(2)}`,
  projectIds: [UUID(3)],
  missingProjectIds: [],
  weeks: ["2026-08-31"],
  anchorCount: 1,
};

/** 웹사이트 함대 — 회차 3개(프로젝트 3개), 주 2개. 기간 모드. */
const websiteSet: CycleSet = {
  surface: "website",
  mode: "period",
  cycles: [10, 20, 30].map((n, i) => ({
    cycleId: UUID(n),
    generationId: UUID(n + 1),
    projectId: UUID(n + 2),
    cycleAnchorAt: i === 2 ? "2026-09-07T03:00:00.000Z" : "2026-09-04T00:00:00.000Z",
    cycleWeek: i === 2 ? "2026-09-07" : "2026-08-31",
  })),
  cycleKey: "k",
  projectIds: [UUID(12), UUID(22), UUID(32)],
  missingProjectIds: [],
  weeks: ["2026-08-31", "2026-09-07"],
  anchorCount: 2,
};

const scopeOf = (set: CycleSet, filters: StandardFilters = {}): TrendReadScope => ({
  set,
  filters,
  ownVariant: OWN_VARIANT_ALL,
  ownedBasePrefixes: ["https://www.hyundai.com/kr/ko/", "kia.com/my"],
});

/** 지원 축을 전부 채운 "최악" 필터 — 바인드 상한 검사용. */
const HEAVY_GLOBAL: StandardFilters = {
  region: ["KR", "US", "DE"],
  lang: ["ko", "en"],
  engine: ["chatgpt", "gemini"],
  funnelStage: ["인지"],
  listType: ["single"],
  depth1: ["구매"],
  brand: ["Hyundai", "Kia"],
};

const HEAVY_WEBSITE: StandardFilters = {
  websiteCountry: ["KR", "worldwide", "HYUNDAI-N"],
  lang: ["ko", "en"],
  engine: ["chatgpt", "gemini"],
  funnelStage: ["인지"],
  listType: ["single"],
  depth1: ["구매"],
};

// ── 수용 기준 ① 문장 수 ─────────────────────────────────────────────────────

describe("수용 기준 ① — 대시보드 1회 렌더의 집계층 문장 ≤ 4", () => {
  it("정확히 4문장이고 표가 서로 다르다", () => {
    for (const set of [globalSet, websiteSet]) {
      const st = buildTrendStatements(scopeOf(set));
      expect(st).toHaveLength(4);
      expect(new Set(st.map((s) => s.table)).size).toBe(4);
      expect(st.map((s) => s.key).sort()).toEqual(["answers", "brands", "domains", "own"]);
    }
  });

  it("브랜드 표는 한 문장에서 브랜드축·국가×브랜드축을 함께 낸다(두 번 스캔 금지)", () => {
    const { text } = compile(__testables.trendBrandsSql(scopeOf(globalSet)));
    expect(text).toContain("GROUPING SETS ((brand_name), (country, brand_name))");
    // 같은 표를 다시 읽는 서브쿼리가 없다.
    expect(text.match(/summary_trend_brands/g)).toHaveLength(1);
  });

  it("도메인 표는 한 문장에서 그룹·도메인·전체를 함께 낸다", () => {
    const { text } = compile(__testables.trendDomainsSql(scopeOf(globalSet)));
    expect(text).toContain("GROUPING SETS ((group_key), (domain), ())");
    expect(text.match(/summary_trend_domains/g)).toHaveLength(1);
  });

  it("own 표는 카드·엔진 일관성·지역 롤업을 한 스캔에서 낸다", () => {
    const { text } = compile(__testables.trendOwnSql(scopeOf(globalSet)));
    expect(text).toContain("GROUPING SETS ((), (engine), (country))");
    expect(text.match(/summary_trend_own/g)).toHaveLength(1);
  });

  it("답변 표는 모수·퍼널·주제·엔진·국가를 한 스캔에서 낸다", () => {
    const { text } = compile(__testables.trendAnswersSql(scopeOf(globalSet)));
    expect(text).toContain("GROUPING SETS ((), (funnel), (depth1), (engine), (country))");
    expect(text.match(/summary_trend_answers/g)).toHaveLength(1);
  });
});

// ── 수용 기준 ② 바인드 상한 ─────────────────────────────────────────────────

describe("수용 기준 ② — 컴파일 SQL 바인드 ≤ 30", () => {
  const cases: Array<[string, CycleSet, StandardFilters]> = [
    ["글로벌 무필터", globalSet, {}],
    ["글로벌 전축", globalSet, HEAVY_GLOBAL],
    ["웹사이트 무필터(회차 3)", websiteSet, {}],
    ["웹사이트 전축(회차 3)", websiteSet, HEAVY_WEBSITE],
  ];
  for (const [name, set, filters] of cases) {
    it(name, () => {
      for (const st of buildTrendStatements(scopeOf(set, filters))) {
        const { params } = compile(st.sql);
        expect(params.length, `${st.key} 바인드 ${params.length}`).toBeLessThanOrEqual(30);
      }
    });
  }

  it("배열 축은 바인드 1개로 간다(스칼라 펼침 금지 — PR① B4-a)", () => {
    const { text, params } = compile(__testables.trendWhere(scopeOf(globalSet, HEAVY_GLOBAL)));
    // 국가 3개·언어 2개·엔진 2개·브랜드 2개가 전부 배열 파라미터 1개씩.
    expect(params).toContainEqual(["KR", "US", "DE"]);
    expect(params).toContainEqual(["KO", "EN"]); // 글로벌은 대문자 원천
    expect(text).not.toMatch(/ARRAY\[\$\d+, \$\d+, \$\d+\]::text\[\]/);
  });

  it("회차가 늘어도 회차 술어의 바인드 수는 고정(6개)이다", () => {
    const one = compile(__testables.cycleScope(globalSet)).params.length;
    const three = compile(__testables.cycleScope(websiteSet)).params.length;
    expect(one).toBe(three);
    expect(one).toBe(6);
  });
});

// ── 수용 기준 ③ 회차 집합 파라미터화 ────────────────────────────────────────

describe("수용 기준 ③ — 회차 집합 파라미터화(id 인라인 0)", () => {
  it("cycle/generation/project id 가 SQL 텍스트에 나타나지 않는다", () => {
    for (const set of [globalSet, websiteSet]) {
      const ids = [
        ...set.cycles.map((c) => c.cycleId),
        ...set.cycles.map((c) => c.generationId),
        ...set.projectIds,
      ];
      for (const st of buildTrendStatements(scopeOf(set))) {
        const { text } = compile(st.sql);
        for (const id of ids) expect(text, `${st.key}`).not.toContain(id);
      }
    }
  });

  it("기간(회차 N개) = cycle_id ANY × generation_id ANY — 세미조인 금지", () => {
    const { text, params } = compile(__testables.cycleScope(websiteSet));
    // ⚠️ 세미조인(`(a,b) IN (SELECT … unnest)`)은 확장 통계가 안 붙어 추정이 1.4만 배
    //    과소가 되고 104 MB PK 가 뽑힌다(0067 조사). 형태를 여기서 잠근다.
    expect(text).not.toContain("(cycle_id, generation_id) IN");
    expect(text).not.toContain("unnest(");
    expect(text).toContain("cycle_id = ANY(");
    expect(text).toContain("generation_id = ANY(");
    expect(text).not.toContain("summary_cycles");
    expect(params).toContainEqual([UUID(10), UUID(20), UUID(30)]);
    expect(params).toContainEqual([UUID(11), UUID(21), UUID(31)]);
  });

  it("스냅샷(회차 1개) = **상수 등치** — 확장 통계가 붙는 유일한 형태", () => {
    const { text, params } = compile(__testables.cycleScope(globalSet));
    expect(text).toContain("cycle_id = $");
    expect(text).toContain("generation_id = $");
    // 회차 축에는 ANY 가 없다 — project_id 만 배열이다(그것도 글로벌은 1개).
    expect(text).not.toContain("cycle_id = ANY(");
    expect(text).not.toContain("generation_id = ANY(");
    expect(params).toContain(UUID(1));
    expect(params).toContain(UUID(2));
  });

  it("인덱스 진입점(surface + anchor 범위)을 함께 건다 — 0065 *_read 선두 컬럼", () => {
    const { text, params } = compile(__testables.cycleScope(websiteSet));
    expect(text).toContain("surface = ");
    expect(text).toContain("cycle_anchor_at BETWEEN");
    expect(params).toContain("website");
    // 집합의 최소·최대 anchor 가 범위가 된다.
    expect(params).toContain("2026-09-04T00:00:00.000Z");
    expect(params).toContain("2026-09-07T03:00:00.000Z");
  });

  it("집계층은 파티션이 아니므로 cycle_week 를 걸지 않는다(date[] 직렬화 함정 회피)", () => {
    for (const st of buildTrendStatements(scopeOf(websiteSet))) {
      const { text } = compile(st.sql);
      expect(text, st.key).not.toContain("cycle_week");
      expect(text, st.key).not.toContain("::date[]");
    }
  });
});

// ── 표면 분기표 (§6-2) ──────────────────────────────────────────────────────

describe("필터 술어 — 표면 분기(§6-2)", () => {
  it("글로벌은 3게이트 + 숨김 국가 + catalog_brands any-match", () => {
    const { text } = compile(__testables.trendWhere(scopeOf(globalSet, HEAVY_GLOBAL)));
    expect(text).toContain("in_root_catalog = 1");
    expect(text).toContain("in_tagged_region = 1");
    expect(text).toContain("in_full_cycle = 1");
    expect(text).toContain("country <> ALL");
    expect(text).toContain("catalog_brands &&");
    expect(text).toContain("run_status IN ('completed', 'partial_failed')");
  });

  it("웹사이트는 글로벌 전용 게이트를 걸지 않고 국가는 verbatim", () => {
    const { text, params } = compile(__testables.trendWhere(scopeOf(websiteSet, HEAVY_WEBSITE)));
    expect(text).not.toContain("in_root_catalog");
    expect(text).not.toContain("in_tagged_region");
    expect(text).not.toContain("in_full_cycle");
    expect(text).not.toContain("catalog_brands &&");
    expect(text).toContain("country IN");
    expect(params).toContain("worldwide");
    // 언어는 소문자 원천(웹사이트) — 글로벌 대문자와 갈린다.
    expect(params).toContainEqual(["ko", "en"]);
  });

  it("funnel 은 catalog 하나뿐 — funnel_scope 어휘를 새로 만들지 않는다", () => {
    for (const set of [globalSet, websiteSet]) {
      const { text } = compile(
        __testables.trendWhere(scopeOf(set, { funnelStage: ["인지"] })),
      );
      expect(text).toContain("funnel_catalog");
      expect(text).not.toContain("funnel_scope");
    }
  });
});

// ── 가산성 방어 ─────────────────────────────────────────────────────────────

describe("가산성 — 그룹 간 SUM 이 깨지는 컬럼은 읽지 않는다(§3-4 16·17)", () => {
  it("prompts_measured · prompts_tracked 를 SELECT 하지 않는다", () => {
    const { text } = compile(__testables.trendOwnSql(scopeOf(globalSet)));
    expect(text).not.toContain("prompts_measured");
    expect(text).not.toContain("prompts_tracked");
  });

  it("브랜드 표는 is_competitor = 1 모집단으로 좁힌다(비경쟁 노이즈 제외)", () => {
    const { text } = compile(__testables.trendBrandsSql(scopeOf(globalSet)));
    expect(text).toContain("is_competitor = 1");
  });

  it("own 문장은 own_variant 를 파라미터로 고정한다", () => {
    const { text, params } = compile(
      __testables.trendOwnSql({ ...scopeOf(globalSet), ownVariant: "Kia" }),
    );
    expect(text).toContain("own_variant = ");
    expect(params).toContain("Kia");
  });
});

// ── ⑤ owned 판정 ────────────────────────────────────────────────────────────

describe("is_ours — 리더 두 곳의 ownedCitationExpr 과 같은 두 갈래", () => {
  it("matched_base 최장 일치 + base_norm_null 도메인 서픽스 폴백", () => {
    const { text, params } = compile(__testables.ownedCitationExpr(["https://www.hyundai.com/kr/ko/"]));
    expect(text).toContain("matched_base <> ''");
    expect(text).toContain("matched_base = ANY(");
    expect(text).toContain("base_norm_null = 1");
    expect(text).toContain("domain ~* ");
    // 라벨 경계 앵커 — 서브도메인만 맞고 접미 문자열은 안 맞아야 한다.
    expect(params.some((p) => typeof p === "string" && p.startsWith("(^|\\.)("))).toBe(true);
  });

  it("base 도 폴백도 없으면 false 두 갈래 — 조용히 전부 owned 가 되지 않는다", () => {
    const { text } = compile(__testables.ownedCitationExpr([]));
    expect(text).toBe("(false OR false)");
  });
});

// ── own_variant 선택 규칙 ───────────────────────────────────────────────────

const ROSTER = [
  { id: UUID(301), name: "Hyundai" },
  { id: UUID(302), name: "Kia" },
  { id: UUID(303), name: "Genesis" },
];

describe("own_variant 선택 규칙 (플랜 §3-2 · 실측 R2)", () => {
  it("선택 없음 → ALL", () => {
    expect(resolveOwnVariantKey({ ownEntities: ROSTER })).toBe(OWN_VARIANT_ALL);
  });

  it("3사 전부 선택 → ALL (Hyundai+Genesis+Kia 락)", () => {
    expect(
      resolveOwnVariantKey({ brand: ["Hyundai", "Genesis", "Kia"], ownEntities: ROSTER }),
    ).toBe(OWN_VARIANT_ALL);
  });

  it("오타 락(HYNDAI+KIA) → 교집합 공집합 폴백 → ALL", () => {
    expect(resolveOwnVariantKey({ brand: ["HYNDAI", "KIA"], ownEntities: ROSTER })).toBe(
      OWN_VARIANT_ALL,
    );
  });

  it("한 브랜드 락 → 그 브랜드 키", () => {
    expect(resolveOwnVariantKey({ brand: ["Kia"], ownEntities: ROSTER })).toBe("Kia");
    expect(resolveOwnVariantKey({ brand: ["Genesis"], ownEntities: ROSTER })).toBe("Genesis");
  });

  it("알리아스 표기('기아')도 정본 키로 접힌다", () => {
    const roster = [
      { id: UUID(311), name: "기아" },
      { id: UUID(302), name: "Kia" },
      { id: UUID(301), name: "Hyundai" },
    ];
    expect(resolveOwnVariantKey({ brand: ["Kia"], ownEntities: roster })).toBe("Kia");
  });

  it("admin 임의 2브랜드 조합 → null(E4 폴백 신호)", () => {
    expect(resolveOwnVariantKey({ brand: ["Hyundai", "Kia"], ownEntities: ROSTER })).toBeNull();
  });

  it("contextBrand 가 brand 를 이긴다(프로젝트 컨텍스트 주입)", () => {
    expect(
      resolveOwnVariantKey({ brand: ["Hyundai", "Kia"], contextBrand: ["Genesis"], ownEntities: ROSTER }),
    ).toBe("Genesis");
  });
});

// ── 미지원 축 ───────────────────────────────────────────────────────────────

describe("집계층 미지원 축 — 폴백 신호", () => {
  const g = (filters: StandardFilters, unitFlags = false) =>
    trendUnsupportedAxisReason({ surface: "global", filters, unitFlags });

  it("depth2 · depth3 는 집계층 키 밖(0059 PK 는 depth1 까지)", () => {
    expect(g({ depth2: ["x"] })).toBe("unsupported-agg:depth2");
    expect(g({ depth3: ["x"] })).toBe("unsupported-agg:depth3");
  });

  it("brandPresence 는 0066 이후 **폴백이 아니다** — presence_set 술어로 표현된다", () => {
    expect(g({ brandPresence: ["branded"] })).toBeNull();
    expect(g({ brandPresence: ["branded", "unbranded"] })).toBeNull();
    expect(g({ brandPresence: [] })).toBeNull();
  });

  it("웹사이트 유닛 게이트도 0066 이후 폴백이 아니다 — report_fs 술어", () => {
    expect(
      trendUnsupportedAxisReason({ surface: "website", filters: {}, unitFlags: true }),
    ).toBeNull();
  });

  it("지원 축만 있으면 통과", () => {
    expect(g(HEAVY_GLOBAL)).toBeNull();
  });
});

describe("planTrendRead — 축 판정 + 변형 선택을 한 번에", () => {
  it("지원 축 + 단일 브랜드 → ok", () => {
    expect(
      planTrendRead({ surface: "global", filters: { brand: ["Kia"], ownEntities: ROSTER } }),
    ).toEqual({ ok: true, ownVariant: "Kia" });
  });

  it("축 판정이 변형 선택보다 먼저 이긴다", () => {
    expect(
      planTrendRead({
        surface: "global",
        filters: { depth2: ["x"], brand: ["Hyundai", "Kia"], ownEntities: ROSTER },
      }),
    ).toEqual({ ok: false, reason: "unsupported-agg:depth2" });
  });

  it("admin 임의 조합 → E4 폴백", () => {
    expect(
      planTrendRead({
        surface: "global",
        filters: { brand: ["Hyundai", "Kia"], ownEntities: ROSTER },
      }),
    ).toEqual({ ok: false, reason: "unsupported-agg:own-variant" });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 라운드 2 — 0066 술어 2개 · ⑤ 분자 소스 · 페이로드 절단
// ════════════════════════════════════════════════════════════════════════════

describe("0066 술어 ① brandPresence → presence_set any-match", () => {
  it("한쪽만 고르면 presence_set && ARRAY[$want] (스칼라 컬럼은 쓰지 않는다)", () => {
    const { text, params } = compile(
      __testables.trendWhere(scopeOf(globalSet, { brandPresence: ["branded"] })),
    );
    expect(text).toContain("presence_set &&");
    expect(text).not.toContain("brand_presence_resolved");
    expect(params).toContainEqual(["branded"]);
  });

  it("unbranded 도 같은 형태", () => {
    const { params } = compile(
      __testables.trendWhere(scopeOf(globalSet, { brandPresence: ["unbranded"] })),
    );
    expect(params).toContainEqual(["unbranded"]);
  });

  it("양쪽/0개 = 무필터 (0061 정본과 같은 규칙)", () => {
    for (const v of [["branded", "unbranded"], []]) {
      const { text } = compile(__testables.trendWhere(scopeOf(globalSet, { brandPresence: v })));
      expect(text).not.toContain("presence_set");
    }
  });

  it("웹사이트 표면에서도 같은 술어다", () => {
    const { text } = compile(
      __testables.trendWhere(scopeOf(websiteSet, { brandPresence: ["branded"] })),
    );
    expect(text).toContain("presence_set &&");
  });
});

describe("0066 술어 ② 웹사이트 유닛 게이트 → report_fs", () => {
  const wsScope = (unitFlags: boolean, excludedUnits?: number[]) => ({
    ...scopeOf(websiteSet),
    unitFlags,
    excludedUnits,
  });

  it("unitFlags 면 report_fs <> 0 (0 = 미부여 sentinel, NULL 아님)", () => {
    const { text } = compile(__testables.trendWhere(wsScope(true)));
    expect(text).toContain("report_fs <> 0");
    expect(text).not.toContain("report_fs IS NOT NULL");
  });

  it("제외 유닛은 int[] 바인드 1개로 배제된다", () => {
    const { text, params } = compile(__testables.trendWhere(wsScope(true, [71, 94, 97])));
    expect(text).toContain("report_fs <> ALL(");
    expect(params).toContainEqual([71, 94, 97]);
  });

  it("unitFlags 가 false 면 게이트가 없다(0060 미적용 DB 폴백)", () => {
    const { text } = compile(__testables.trendWhere(wsScope(false)));
    expect(text).not.toContain("report_fs");
  });

  it("글로벌 표면에는 유닛 게이트가 절대 안 붙는다(세부층 report_fs 전량 NULL→0)", () => {
    const { text } = compile(
      __testables.trendWhere({ ...scopeOf(globalSet), unitFlags: true, excludedUnits: [71] }),
    );
    expect(text).not.toContain("report_fs");
  });
});

describe("⑤ 분자 소스 — 표면 분기", () => {
  it("글로벌은 matched_base $sel FILTER (오늘 리더의 ownedCitationExpr 그대로)", () => {
    const { text } = compile(__testables.trendDomainsSql(scopeOf(globalSet)));
    expect(text).toContain("FILTER (WHERE ((matched_base <> ''");
    expect(text).toContain("base_norm_null = 1");
    expect(text).not.toContain("unit_owned_citations");
  });

  it("웹사이트 + unitFlags 는 굳힌 unit_owned_citations 를 더한다", () => {
    const { text } = compile(
      __testables.trendDomainsSql({ ...scopeOf(websiteSet), unitFlags: true }),
    );
    expect(text).toContain("sum(unit_owned_citations)");
    // bool_or(x > 0) ≡ sum(x) > 0 (음수 없음) — 오늘 리더 ownedDomainAgg 와 동치.
    expect(text).toContain("> 0");
    expect(text).not.toContain("matched_base");
  });

  it("웹사이트라도 unitFlags 가 false 면 종전 $sel 경로로 폴백한다", () => {
    const { text } = compile(
      __testables.trendDomainsSql({ ...scopeOf(websiteSet), unitFlags: false }),
    );
    expect(text).toContain("matched_base");
    expect(text).not.toContain("unit_owned_citations");
  });

  it("own 문장의 own_citations 는 감사값으로 계속 읽는다(⑤ 분자로 쓰지 않는다)", () => {
    const { text } = compile(__testables.trendOwnSql(scopeOf(globalSet)));
    expect(text).toContain("own_citations");
  });
});

describe("페이로드 절단 — 잘라도 분모·개수가 보존된다", () => {
  it("기본값: 도메인 top-80 · 브랜드 top-200 · GEO 국가당 20, 카테고리는 무절단", () => {
    const d = compile(__testables.trendDomainsSql(scopeOf(globalSet)));
    // 도메인 축은 창(window)이 아니라 top-N heapsort 를 쓰는 `ORDER BY … LIMIT` 다.
    expect(d.text).toContain("ORDER BY citations DESC");
    expect(d.text).toContain("ORDER BY citing_answers DESC");
    expect(d.text).not.toContain("row_number() OVER");
    expect(d.params).toContain(80);
    const b = compile(__testables.trendBrandsSql(scopeOf(globalSet)));
    expect(b.params).toContain(200);
    expect(b.params).toContain(20);
  });

  it("잔여 합계 행을 함께 낸다(is_rest=1 · rest_count) — 버리지 않는다", () => {
    for (const q of [
      __testables.trendDomainsSql(scopeOf(globalSet)),
      __testables.trendBrandsSql(scopeOf(globalSet)),
    ]) {
      const { text } = compile(q);
      expect(text).toContain("UNION ALL");
      expect(text).toContain("1::int");
      expect(text).toContain("count(*)::bigint");
    }
  });

  it("GEO 축은 **국가당** 상위 N 이다(전역 N 이 아니다)", () => {
    const { text } = compile(__testables.trendBrandsSql(scopeOf(globalSet)));
    expect(text).toContain("PARTITION BY by_country, country");
  });

  it("카테고리(group) 축은 기본 무절단 — 매핑이 조회 시각 파생이라 꼬리를 못 버린다", () => {
    const { text } = compile(__testables.trendDomainsSql(scopeOf(globalSet)));
    expect(text).not.toContain("ORDER BY citations DESC, group_key");
  });

  it("limits 를 전부 null 로 주면 라운드 1과 같은 무절단 문장", () => {
    const scope = {
      ...scopeOf(globalSet),
      limits: { domain: null, group: null, brand: null, geoBrandPerCountry: null },
    };
    for (const q of [__testables.trendDomainsSql(scope), __testables.trendBrandsSql(scope)]) {
      const { text } = compile(q);
      expect(text).not.toContain("row_number()");
      expect(text).not.toContain("UNION ALL");
      expect(text).not.toContain("LIMIT");
    }
  });

  it("절단을 켜도 표 스캔은 여전히 1회다(CTE 1개, 표 이름 1회)", () => {
    expect(
      compile(__testables.trendDomainsSql(scopeOf(globalSet))).text.match(/summary_trend_domains/g),
    ).toHaveLength(1);
    expect(
      compile(__testables.trendBrandsSql(scopeOf(globalSet))).text.match(/summary_trend_brands/g),
    ).toHaveLength(1);
  });

  it("절단·게이트를 다 켜도 문장 4개·바인드 ≤ 30 이 유지된다", () => {
    const scope = {
      ...scopeOf(websiteSet, HEAVY_WEBSITE),
      unitFlags: true,
      excludedUnits: [71, 94, 97],
      filters: { ...HEAVY_WEBSITE, brandPresence: ["branded"] },
    };
    const st = buildTrendStatements(scope);
    expect(st).toHaveLength(4);
    for (const one of st) {
      expect(compile(one.sql).params.length, one.key).toBeLessThanOrEqual(30);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 라운드 3 — only 선택자 · 회차 축 · brands 엔진 축 · domains 국가 축 · empty 수리
// ════════════════════════════════════════════════════════════════════════════

describe("only 선택자 — 위젯이 안 쓰는 표를 읽지 않는다", () => {
  it("고른 표만 발행한다(선택 밖 문장 0)", () => {
    const cases: Array<[string[], number]> = [
      [["own", "brands", "domains"], 3], // S4 aggregates
      [["domains"], 1], // 출처 도넛
      [["brands"], 1], // GEO
      [["own"], 1],
    ];
    for (const [only, len] of cases) {
      const st = buildTrendStatements(scopeOf(globalSet), { only: only as never });
      expect(st).toHaveLength(len);
      expect(st.map((s) => s.key).sort()).toEqual([...only].sort());
    }
  });

  it("생략하면 4개 전부 — 라운드 2와 같다", () => {
    expect(buildTrendStatements(scopeOf(globalSet))).toHaveLength(4);
    expect(buildTrendStatements(scopeOf(globalSet), {})).toHaveLength(4);
  });

  it("수용 기준 ① 은 **함수당** ≤ 4 다 — only 는 그 이하로만 내린다", () => {
    for (const only of [["own"], ["own", "answers"], ["own", "answers", "brands", "domains"]]) {
      expect(
        buildTrendStatements(scopeOf(globalSet), { only: only as never }).length,
      ).toBeLessThanOrEqual(4);
    }
  });
});

// ── PR③ 회차 축 2종 — **축 판별자**를 형태로 고정한다 (검증자 GG-2) ──────────
//
// 두 뮤테이션이 전체 스위트를 통과했다. 둘 다 "값이 조용히 틀리는" 종류다:
//   (a) 브랜드 절단의 `row_number()` PARTITION 에서 `by_cycle, cycle_anchor_at` 제거
//       → 회차 축 행과 브랜드 축 행이 **한 순위 창**에 섞여 named/rest 가 왜곡된다
//         (회차별 top-N 이 "전 회차 통합 top-N" 이 되어 옛 회차가 통째로 잘린다).
//   (b) 도메인 `axis` CASE 의 `WHEN GROUPING(cycle_anchor_at) = 0 THEN 'cycle'` **절 삭제**
//       → 그 행이 `'total'` 로 접혀 **`axis='cycle'` 이 사라지고 `total` 이 2행**이 된다
//         (⑤ 분모가 회차 수만큼 부푼다).
// ⚠️ 위험은 WHEN **순서**가 아니라 **절의 부재**다 — grouping set 들은 서로 배타라
//    한 행이 두 WHEN 을 동시에 만족하지 않는다.
describe("회차 축 (axes.cycleBrand / cycleDomain) — 축 판별자", () => {
  const brands = (axes?: Record<string, boolean>) =>
    compile(__testables.trendBrandsSql({ ...scopeOf(globalSet), axes })).text;
  const domains = (axes?: Record<string, boolean>) =>
    compile(__testables.trendDomainsSql({ ...scopeOf(globalSet), axes })).text;

  it("끄면 두 문장에 회차 흔적이 없다(회귀 0)", () => {
    expect(brands()).not.toContain("(cycle_anchor_at, brand_name)");
    expect(brands()).toContain("1::int AS by_cycle");
    expect(domains()).not.toContain("'cycle'");
    expect(domains()).toContain("NULL::timestamptz AS cycle_anchor_at");
  });

  it("cycleBrand 를 켜면 `(cycle_anchor_at, brand_name)` grouping set 이 붙는다", () => {
    const text = brands({ cycleBrand: true });
    expect(text).toContain("(cycle_anchor_at, brand_name)");
    expect(text).toContain("GROUPING(cycle_anchor_at)::int AS by_cycle");
  });

  it("(a) 브랜드 절단 PARTITION 에 축 판별자가 **전부** 있다", () => {
    // 하나라도 빠지면 서로 다른 축의 행이 한 순위 창에 섞인다.
    expect(brands({ cycleBrand: true })).toContain(
      "PARTITION BY by_country, country, by_engine, engine, by_cycle, cycle_anchor_at",
    );
    // 잔여 행 GROUP BY 도 같은 목록이어야 축별 합계가 유지된다.
    expect(brands({ cycleBrand: true })).toContain(
      "GROUP BY by_country, by_engine, by_cycle, country, engine, cycle_anchor_at",
    );
  });

  it("(b) 도메인 CASE 에 회차 절이 **존재**한다 — 없으면 `total` 로 접힌다", () => {
    const text = domains({ cycleDomain: true });
    expect(text).toContain("WHEN GROUPING(cycle_anchor_at) = 0 THEN 'cycle'");
    expect(text).toContain("(cycle_anchor_at)");
    // 잔여 행 GROUP BY 에도 회차가 들어가야 축별 합계가 유지된다.
    expect(text).toContain("GROUP BY axis, country, cycle_anchor_at");
  });

  it("국가 축과 함께 켜도 두 절이 모두 남는다(축이 서로 먹지 않는다)", () => {
    const text = domains({ cycleDomain: true, domainCountry: true });
    expect(text).toContain("WHEN GROUPING(cycle_anchor_at) = 0 THEN 'cycle'");
    expect(text).toContain("WHEN GROUPING(country) = 0 THEN 'country'");
    expect(text).toContain("(country), (cycle_anchor_at), ()");
  });

  it("brandNames 는 **브랜드 표만** 좁힌다(2단 조회의 2단)", () => {
    const withNames = compile(__testables.trendBrandsSql({
      ...scopeOf(globalSet), axes: { cycleBrand: true }, brandNames: ["Hyundai", "Kia"],
    }));
    expect(withNames.text).toContain("brand_name = ANY(");
    // 바인드로만 — 이름이 SQL 텍스트에 인라인되면 계획 재사용이 깨진다.
    expect(withNames.text).not.toContain("Hyundai");
    expect(withNames.params).toContainEqual(["Hyundai", "Kia"]);
    // 이름이 없으면 절 자체가 없다(라운드 2와 바이트 동일).
    expect(brands({ cycleBrand: true })).not.toContain("brand_name = ANY(");
  });
});

describe("회차 축 (axes.cycle) — 추이가 1문장", () => {
  const on = (set = globalSet) => ({ ...scopeOf(set), axes: { cycle: true } });

  it("끄면 cycle_anchor_at 이 문장에 아예 없다(라운드 2 회귀 0)", () => {
    for (const q of [
      __testables.trendOwnSql(scopeOf(globalSet)),
      __testables.trendAnswersSql(scopeOf(globalSet)),
    ]) {
      const { text } = compile(q);
      expect(text).not.toContain("cycle_anchor_at)");
      expect(text).toContain("NULL::timestamptz");
    }
  });

  it("켜면 own 이 (cycle_anchor_at)·(cycle_anchor_at, engine) 를 함께 낸다", () => {
    const { text } = compile(__testables.trendOwnSql(on()));
    expect(text).toContain("GROUPING SETS ((), (engine), (country), (cycle_anchor_at), (cycle_anchor_at, engine))");
    expect(text).toContain("'cycle-engine'");
    expect(text.match(/summary_trend_own/g)).toHaveLength(1); // 여전히 한 스캔
  });

  it("켜면 answers 도 같은 두 셋을 낸다", () => {
    const { text } = compile(__testables.trendAnswersSql(on()));
    expect(text).toContain("(cycle_anchor_at), (cycle_anchor_at, engine)");
    expect(text.match(/summary_trend_answers/g)).toHaveLength(1);
  });

  it("회차 N개 집합에서도 문장은 4개다(회차마다 발행 금지)", () => {
    expect(buildTrendStatements(on(websiteSet))).toHaveLength(4);
  });
});

describe("brands 엔진 축 (axes.engineBrand) — Sub-KPI negativeMentions", () => {
  it("끄면 engine 컬럼도 grouping set 도 없다", () => {
    const { text } = compile(__testables.trendBrandsSql(scopeOf(globalSet)));
    expect(text).toContain("GROUPING SETS ((brand_name), (country, brand_name))");
    expect(text).toContain("NULL::text AS engine");
  });

  it("켜면 (engine, brand_name) 이 붙고 한 스캔을 유지한다", () => {
    const { text } = compile(
      __testables.trendBrandsSql({ ...scopeOf(globalSet), axes: { engineBrand: true } }),
    );
    expect(text).toContain("(engine, brand_name)");
    expect(text).toContain("GROUPING(engine)");
    expect(text.match(/summary_trend_brands/g)).toHaveLength(1);
  });

  it("negative 는 항상 SELECT 된다(엔진 축이 그 값을 국가/브랜드 축과 나눠 쓴다)", () => {
    const { text } = compile(__testables.trendBrandsSql(scopeOf(globalSet)));
    expect(text).toContain("sum(negative)");
  });
});

describe("domains 국가 축 (axes.domainCountry) — GEO 인용 분모·분자", () => {
  it("끄면 country 컬럼도 grouping set 도 없다", () => {
    const { text } = compile(__testables.trendDomainsSql(scopeOf(globalSet)));
    expect(text).toContain("GROUPING SETS ((group_key), (domain), ())");
    expect(text).toContain("NULL::text AS country");
  });

  it("domainCountry 만 켜면 (country) 만 붙는다 — 국가 45행, 사실상 공짜", () => {
    const { text } = compile(
      __testables.trendDomainsSql({ ...scopeOf(globalSet), axes: { domainCountry: true } }),
    );
    expect(text).toContain("GROUPING SETS ((group_key), (domain), (country), ())");
    expect(text).not.toContain("(country, group_key)");
  });

  it("domainCountryGroup 을 켜야 (country, group_key) 가 붙는다(비싼 축)", () => {
    const { text } = compile(
      __testables.trendDomainsSql({ ...scopeOf(globalSet), axes: { domainCountryGroup: true } }),
    );
    expect(text).toContain("(country), (country, group_key)");
    expect(text).toContain("'country-group'");
    expect(text.match(/summary_trend_domains/g)).toHaveLength(1);
  });
});

describe("empty 수리 — key_rows 로 판정한다", () => {
  it("네 문장 전부 key_rows 를 낸다(존재 증거)", () => {
    for (const st of buildTrendStatements(scopeOf(globalSet))) {
      expect(compile(st.sql).text, st.key).toContain("AS key_rows");
    }
  });

  it("own·answers·domains 는 () 그룹핑 셋이 있어 빈 입력에도 합계 행이 나온다", () => {
    // 그래서 "행 0개" 판정이 발화하지 않는다 — 이 사실이 결함의 원인이었다.
    for (const q of [
      __testables.trendOwnSql(scopeOf(globalSet)),
      __testables.trendAnswersSql(scopeOf(globalSet)),
      __testables.trendDomainsSql(scopeOf(globalSet)),
    ]) {
      expect(compile(q).text).toMatch(/GROUPING SETS \(\(\)|\(\)\)/);
    }
  });
});

describe("축을 전부 켜도 수용 기준이 유지된다", () => {
  const allAxes = {
    ...scopeOf(websiteSet, HEAVY_WEBSITE),
    unitFlags: true,
    excludedUnits: [71, 94, 97],
    axes: { cycle: true, engineBrand: true, domainCountryGroup: true },
  };

  it("문장 4개", () => {
    expect(buildTrendStatements(allAxes)).toHaveLength(4);
  });

  it("바인드 ≤ 30", () => {
    for (const st of buildTrendStatements(allAxes)) {
      expect(compile(st.sql).params.length, st.key).toBeLessThanOrEqual(30);
    }
  });

  it("표당 스캔 1회", () => {
    for (const st of buildTrendStatements(allAxes)) {
      expect(compile(st.sql).text.match(new RegExp(st.table, "g")), st.key).toHaveLength(1);
    }
  });
});
