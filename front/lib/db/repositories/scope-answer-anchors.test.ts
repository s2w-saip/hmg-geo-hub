/**
 * 달력 리더 `listSelectableAnchorDates` (스펙 §5.1)의 **형태와 내성**.
 *
 * 값 대조는 DB 가 필요하므로 여기서 하지 않는다. 고정하는 것은 셋이다:
 *   ① 노출 게이트가 빠지지 않는다 — 빠지면 아직 안 보여야 할 회차 날짜가 달력에 뜬다
 *   ② 표면별 날짜 컬럼(website = 함대 공통 회차일)
 *   ③ 마이그레이션 미적용 배포에서 **쿼리를 아예 안 쏜다**(42703 로 화면이 죽지 않게)
 * 그리고 반환값이 **직렬화 가능한 plain 값**인 것(unstable_cache 셀에 Map 을 넣었다가
 * HIT 부터 세그먼트가 죽은 2026-09-18 전례).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  resetColumnAvailabilityForTests,
  setColumnAvailabilityForTests,
} from "@/lib/db/column-availability";

const dialect = new PgDialect();
const compile = (q: SQL) => {
  const c = dialect.sqlToQuery(q);
  return { text: c.sql.replace(/\s+/g, " ").trim(), params: c.params };
};

const P1 = "11111111-1111-1111-1111-111111111111";
const P2 = "22222222-2222-2222-2222-222222222222";

const h = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: h.getDb }));

beforeEach(() => {
  vi.clearAllMocks();
  resetColumnAvailabilityForTests();
});

describe("① 노출 게이트", () => {
  it("view_anchor_date 가 NULL 이 아니고 오늘 이하인 것만 낸다", async () => {
    const { selectableAnchorDatesSql } = await import("./scope-answer-anchors");
    const { text } = compile(selectableAnchorDatesSql("standard", [P1]));
    expect(text).toContain("ca.view_anchor_date IS NOT NULL");
    expect(text).toContain("ca.view_anchor_date <= hmg_anchor_today()");
  });

  it("'오늘' 은 앵커 타임존 기준이다 — current_date 를 쓰지 않는다", async () => {
    const { selectableAnchorDatesSql } = await import("./scope-answer-anchors");
    const { text } = compile(selectableAnchorDatesSql("standard", [P1]));
    expect(text).not.toMatch(/\bcurrent_date\b/i);
  });
});

describe("①' 숨김 게이트 (R3 — 테이블에 복사하지 않고 원장을 조인한다)", () => {
  const setHidden = (reason: boolean, scope: boolean) => {
    setColumnAvailabilityForTests("summary_cycles", "hidden_reason", reason);
    setColumnAvailabilityForTests("summary_cycles", "hidden_scope", scope);
    // 함대 게이트(원장 발행 여부)의 프로브 — 달력 리더가 문장을 내기 전에 본다.
    // 기본을 **있음**으로 둬야 실제 배포와 같은 SQL 이 나온다(2026-09-20 프리뷰 수리).
    setColumnAvailabilityForTests("summary_cycle_runs", "attributed_by", true);
  };

  it("계열 'citations'·'all' 은 hidden_reason IS NULL (회차 전체 제외)", async () => {
    setHidden(true, true);
    const { anchorNotHiddenSql } = await import("./scope-answer-anchors");
    for (const family of ["citations", "all"] as const) {
      const { text } = compile(await anchorNotHiddenSql(family));
      expect(text).toContain("NOT EXISTS ( SELECT 1 FROM summary_cycles c");
      expect(text).toContain("c.cycle_id = ca.cycle_id");
      expect(text).toContain("c.hidden_reason IS NOT NULL");
      expect(text).not.toContain("hidden_scope");
    }
  });

  it("계열 'mentions' 는 hidden_scope='citations' 회차를 남긴다", async () => {
    setHidden(true, true);
    const { anchorNotHiddenSql } = await import("./scope-answer-anchors");
    const { text } = compile(await anchorNotHiddenSql("mentions"));
    expect(text).toContain(
      "(c.hidden_reason IS NOT NULL AND COALESCE(c.hidden_scope, 'all') = 'all')",
    );
  });

  /**
   * 의미 대조 — 새 게이트가 기존 술어와 **같은 뜻**이어야 한다.
   * 기준: `scope-aggregates.ts::excludeHiddenCycleRuns` 의 hiddenClause(숨기는 조건).
   * 이 함수는 그 부정이므로, 숨기는 절의 텍스트가 그대로 들어 있어야 한다.
   */
  it("숨기는 절이 excludeHiddenCycleRuns 의 hiddenClause 와 문자 그대로 같다", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(__dirname, "scope-aggregates.ts"), "utf8");
    // 언급 계열(범위 인지) / 그 외(회차 전체) 두 절.
    expect(src).toContain(
      "(c.hidden_reason IS NOT NULL AND COALESCE(c.hidden_scope, 'all') = 'all')",
    );
    expect(src).toContain("sql`c.hidden_reason IS NOT NULL`");

    setHidden(true, true);
    const { anchorNotHiddenSql } = await import("./scope-answer-anchors");
    expect(compile(await anchorNotHiddenSql("mentions")).text).toContain(
      "(c.hidden_reason IS NOT NULL AND COALESCE(c.hidden_scope, 'all') = 'all')",
    );
    expect(compile(await anchorNotHiddenSql("citations")).text).toContain(
      "c.hidden_reason IS NOT NULL",
    );
  });

  it("0070 미적용이면 제약 없음(true) — 42703 으로 달력이 죽지 않는다", async () => {
    setHidden(false, false);
    const { anchorNotHiddenSql } = await import("./scope-answer-anchors");
    expect(compile(await anchorNotHiddenSql("all")).text).toBe("true");
  });

  it("0070 ✓ / 0071 ✗ 이면 범위를 무시하고 회차 전체를 숨긴다", async () => {
    setHidden(true, false);
    const { anchorNotHiddenSql } = await import("./scope-answer-anchors");
    const { text } = compile(await anchorNotHiddenSql("mentions"));
    expect(text).toContain("c.hidden_reason IS NOT NULL");
    expect(text).not.toContain("hidden_scope");
  });

  it("달력 리더가 시간 게이트와 숨김 게이트를 **둘 다** 건다", async () => {
    setColumnAvailabilityForTests("scope_answer_cycle_anchors", "round_date", true);
    setHidden(true, true);
    const execute = vi.fn().mockResolvedValue([]);
    h.getDb.mockReturnValue({ execute });
    const { listSelectableAnchorDates } = await import("./scope-answer-anchors");

    await listSelectableAnchorDates("standard", [P1]);
    expect(execute).toHaveBeenCalledTimes(1);
    const { text } = compile(execute.mock.calls[0][0] as SQL);
    expect(text).toContain("ca.view_anchor_date <= hmg_anchor_today()");
    expect(text).toContain("NOT EXISTS ( SELECT 1 FROM summary_cycles c");
  });

  // 2026-09-20 계약 변경: 달력의 계열은 **그 화면의 계열**이다(기본 `'mentions'`).
  // 종전에는 `'all'` 고정이라, 인용만 깨져 숨긴 회차(`hidden_scope='citations'`)의
  // 멀쩡한 언급 값이 달력에서 사라졌다 — 언급 화면에서 행은 보이는데 그 날짜를 고를
  // 수 없는 상태다. 집계층 `DEFAULT_HIDDEN_FAMILY` 와 같은 기본값을 쓴다.
  it("기본 계열은 느슨한 'mentions' — 범위 절(hidden_scope)이 붙는다", async () => {
    setColumnAvailabilityForTests("scope_answer_cycle_anchors", "round_date", true);
    setHidden(true, true);
    const execute = vi.fn().mockResolvedValue([]);
    h.getDb.mockReturnValue({ execute });
    const { listSelectableAnchorDates } = await import("./scope-answer-anchors");

    await listSelectableAnchorDates("standard", [P1]);
    const { text } = compile(execute.mock.calls[0][0] as SQL);
    expect(text).toContain("COALESCE(c.hidden_scope, 'all') = 'all'");
  });

  it("인용 화면은 'citations' — 범위 절 없이 숨긴 회차를 전부 뺀다", async () => {
    setColumnAvailabilityForTests("scope_answer_cycle_anchors", "round_date", true);
    setHidden(true, true);
    const execute = vi.fn().mockResolvedValue([]);
    h.getDb.mockReturnValue({ execute });
    const { listSelectableAnchorDates } = await import("./scope-answer-anchors");

    await listSelectableAnchorDates("standard", [P1], {}, "citations");
    const { text } = compile(execute.mock.calls[0][0] as SQL);
    expect(text).toContain("c.hidden_reason IS NOT NULL");
    expect(text).not.toContain("hidden_scope");
  });

  // 집계층의 회차 선택(`anchorSnapshotPreds`)이 엔진 필터가 비었을 때 거는 것과
  // 같은 술어다. 안 걸면 옵트인 엔진만 있는 회차가 달력에는 뜨는데 화면이 빈다.
  it("엔진 필터가 비면 기본 엔진 범위를 건다 (집계층 회차 선택과 같은 모수)", async () => {
    setColumnAvailabilityForTests("scope_answer_cycle_anchors", "round_date", true);
    setHidden(false, false);
    const execute = vi.fn().mockResolvedValue([]);
    h.getDb.mockReturnValue({ execute });
    const { listSelectableAnchorDates } = await import("./scope-answer-anchors");

    await listSelectableAnchorDates("standard", [P1]);
    expect(compile(execute.mock.calls[0][0] as SQL).text).toContain("ca.is_default_engine");

    execute.mockClear();
    await listSelectableAnchorDates("standard", [P1], { engines: ["deepseek"] });
    expect(compile(execute.mock.calls[0][0] as SQL).text).not.toContain("ca.is_default_engine");
  });

  it("cycle_id 가 NULL 인 행은 숨김 없음 — 술어가 그 행을 거르지 않는다", async () => {
    setHidden(true, true);
    const { anchorNotHiddenSql } = await import("./scope-answer-anchors");
    const { text } = compile(await anchorNotHiddenSql("all"));
    // NOT EXISTS 는 `c.cycle_id = NULL` 이 UNKNOWN → 0행 → 참이다. 그래서
    // 별도 `ca.cycle_id IS NULL OR …` 분기를 두지 않는다(두면 술어가 두 벌이 된다).
    expect(text).toContain("NOT EXISTS (");
    expect(text).not.toContain("ca.cycle_id IS NULL");
  });
});

describe("② 표면별 날짜 컬럼 — 전 표면 round_date(정규 요일 귀속) 하나", () => {
  it("website 도 round_date 다 (anchor_date 를 읽지 않는다)", async () => {
    const { selectableAnchorDatesSql } = await import("./scope-answer-anchors");
    const { text } = compile(selectableAnchorDatesSql("website", [P1, P2]));
    expect(text).toContain("DISTINCT ca.round_date AS d");
    expect(text).not.toContain("fleet_round_date");
    expect(text).toContain("ca.surface = $1");
  });

  it("세 표면이 같은 날짜 컬럼을 쓴다 — 달력 축과 기간 술어 축이 갈리지 않는다", async () => {
    const { selectableAnchorDatesSql, anchorDateColumnSql } = await import("./scope-answer-anchors");
    for (const s of ["standard", "project", "website"] as const) {
      expect(compile(anchorDateColumnSql(s)).text).toBe("ca.round_date");
      expect(compile(selectableAnchorDatesSql(s, [P1])).text).toContain("DISTINCT ca.round_date AS d");
    }
  });
});

describe("B10 달력 상한 — 잘리는 쪽은 **과거**여야 한다", () => {
  it("안쪽에서 DESC 로 자르고 바깥에서 오름차순으로 되돌린다", async () => {
    const { selectableAnchorDatesSql } = await import("./scope-answer-anchors");
    const { text } = compile(selectableAnchorDatesSql("standard", [P1]));
    const iDesc = text.indexOf("ORDER BY d DESC");
    const iLimit = text.indexOf("LIMIT $");
    const iAsc = text.lastIndexOf("ORDER BY d");
    expect(iDesc).toBeGreaterThan(-1);
    expect(iLimit).toBeGreaterThan(iDesc); // 상한은 DESC 정렬 **뒤**에 걸린다
    expect(iAsc).toBeGreaterThan(iLimit); // 반환은 다시 오름차순
    expect(text.slice(iAsc)).not.toContain("DESC");
  });

  it("반환 계약은 그대로 오름차순 문자열 배열이다", async () => {
    setColumnAvailabilityForTests("scope_answer_cycle_anchors", "round_date", true);
    setColumnAvailabilityForTests("summary_cycles", "hidden_reason", false);
    h.getDb.mockReturnValue({
      execute: vi.fn().mockResolvedValue([{ d: "2026-09-07" }, { d: "2026-09-14" }]),
    });
    const { listSelectableAnchorDates } = await import("./scope-answer-anchors");
    await expect(listSelectableAnchorDates("standard", [P1])).resolves.toEqual([
      "2026-09-07",
      "2026-09-14",
    ]);
  });
});

describe("바인드", () => {
  it("프로젝트 id 는 배열 바인드 1개 — 인라인 0", async () => {
    const { selectableAnchorDatesSql } = await import("./scope-answer-anchors");
    const { text, params } = compile(selectableAnchorDatesSql("standard", [P1, P2]));
    expect(text).toContain("ca.project_id = ANY($2::uuid[])");
    expect(text).not.toContain(P1);
    // 세 번째는 LIMIT 상한. id 는 배열 **하나**로만 실린다(개수만큼 바인드가 늘면
    // 함대 95~126 프로젝트에서 문장 텍스트가 매번 달라져 계획 재사용이 깨진다).
    expect(params).toEqual(["standard", [P1, P2], 400]);
  });

  it("날짜 경계는 명시 캐스트다 — text 추론 42883 방지", async () => {
    const { selectableAnchorDatesSql } = await import("./scope-answer-anchors");
    const { text } = compile(
      selectableAnchorDatesSql("standard", [P1], { from: "2026-08-01", to: "2026-09-19" }),
    );
    expect(text).toMatch(/>= \$\d+::date/);
    expect(text).toMatch(/<= \$\d+::date/);
  });

  it("숫자 바인드에도 캐스트가 붙는다 (LIMIT)", async () => {
    const { selectableAnchorDatesSql } = await import("./scope-answer-anchors");
    const { text } = compile(selectableAnchorDatesSql("standard", [P1]));
    expect(text).toMatch(/LIMIT \$\d+::int/);
  });

  it("엔진·국가 필터가 없으면 scope_answers 를 조인하지 않는다", async () => {
    const { selectableAnchorDatesSql } = await import("./scope-answer-anchors");
    const { text } = compile(selectableAnchorDatesSql("standard", [P1]));
    expect(text).not.toContain("scope_answers");
  });

  it("엔진·국가 필터가 있으면 그때만 조인한다", async () => {
    const { selectableAnchorDatesSql } = await import("./scope-answer-anchors");
    const { text } = compile(
      selectableAnchorDatesSql("standard", [P1], { engines: ["chatgpt"], countries: ["KR"] }),
    );
    expect(text).toContain("JOIN scope_answers a ON a.job_id = ca.job_id");
    expect(text).toContain("a.target = ANY($");
    expect(text).toContain("a.region = ANY($");
  });
});

describe("③ 마이그레이션 미적용 내성", () => {
  it("프로브 false 면 쿼리를 쏘지 않고 빈 배열", async () => {
    setColumnAvailabilityForTests("scope_answer_cycle_anchors", "round_date", false);
    const execute = vi.fn();
    h.getDb.mockReturnValue({ execute });
    const { listSelectableAnchorDates } = await import("./scope-answer-anchors");

    await expect(listSelectableAnchorDates("standard", [P1])).resolves.toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });

  it("프로젝트가 비면 프로브조차 하지 않는다", async () => {
    const execute = vi.fn();
    h.getDb.mockReturnValue({ execute });
    const { listSelectableAnchorDates } = await import("./scope-answer-anchors");

    await expect(listSelectableAnchorDates("website", [])).resolves.toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });

  it("쿼리가 실패해도 화면을 죽이지 않고 **구조화 경고**를 남긴다", async () => {
    setColumnAvailabilityForTests("scope_answer_cycle_anchors", "round_date", true);
    const execute = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("boom"), { code: "42703" }));
    h.getDb.mockReturnValue({ execute });
    const lines: string[] = [];
    const spy = vi
      .spyOn(console, "warn")
      .mockImplementation((...a: unknown[]) => lines.push(a.map(String).join(" ")));
    const { listSelectableAnchorDates } = await import("./scope-answer-anchors");

    await expect(listSelectableAnchorDates("standard", [P1])).resolves.toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("selectable-dates-query-failed");
    expect(lines[0]).toContain("surface=standard");
    expect(lines[0]).toContain("family=mentions");
    expect(lines[0]).toContain("projects=1");
    expect(lines[0]).toContain("code=42703");
    // 비밀값이 섞일 경로가 없어야 한다.
    expect(lines[0]).not.toMatch(/postgres(ql)?:\/\//);
    spy.mockRestore();
  });
});

describe("반환값은 직렬화 가능한 plain 값만", () => {
  it("문자열 배열이고 JSON 라운드트립에서 변하지 않는다", async () => {
    setColumnAvailabilityForTests("scope_answer_cycle_anchors", "round_date", true);
    h.getDb.mockReturnValue({
      execute: vi.fn().mockResolvedValue([{ d: "2026-09-07" }, { d: "2026-09-14" }, { d: null }]),
    });
    const { listSelectableAnchorDates } = await import("./scope-answer-anchors");

    const out = await listSelectableAnchorDates("website", [P1]);
    expect(out).toEqual(["2026-09-07", "2026-09-14"]);
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
    expect(out.every((v) => typeof v === "string")).toBe(true);
  });
});

describe("표면 어휘 매핑 — 앵커 'standard' ↔ 원장 'global'", () => {
  it("매핑은 한 곳이고 양방향이 서로의 역이다", async () => {
    const m = await import("./scope-answer-anchors");
    expect(m.ANCHOR_TO_LEDGER_SURFACE).toEqual({
      standard: "global",
      website: "website",
      project: "project",
    });
    for (const s of ["standard", "website", "project"] as const) {
      expect(m.toAnchorSurface(m.toLedgerSurface(s))).toBe(s);
    }
    expect(m.toLedgerSurface("standard")).toBe("global");
    expect(m.toAnchorSurface("global")).toBe("standard");
  });

  it("모르는 원장 값은 기본값으로 접지 않고 던진다", async () => {
    const { toAnchorSurface } = await import("./scope-answer-anchors");
    expect(() => toAnchorSurface("standard" as never)).toThrow(/unknown ledger surface/);
  });

  it("SQL CASE 는 맵에서 파생되고 바인드가 없다", async () => {
    const { ledgerSurfaceSql } = await import("./scope-answer-anchors");
    const { text, params } = compile(ledgerSurfaceSql("ca"));
    expect(text).toBe(
      "(CASE ca.surface WHEN 'standard' THEN 'global' WHEN 'website' THEN 'website' WHEN 'project' THEN 'project' END)",
    );
    expect(params).toEqual([]);
    // ELSE 가 없다 = 모르는 값은 NULL → 조인 불성립(기본 거부).
    expect(text).not.toContain("ELSE");
  });

  it("양쪽 어휘가 각 테이블의 CHECK 제약과 일치한다 (0059 · 0077)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const m = await import("./scope-answer-anchors");
    const dir = path.resolve(__dirname, "../migrations");
    const ledgerSql = fs.readFileSync(path.join(dir, "0059_summary_tables.sql"), "utf8");
    const anchorSql = fs.readFileSync(path.join(dir, "0077_scope_answer_cycle_anchors.sql"), "utf8");
    const lits = (s: string | undefined) => (s?.match(/'([a-z_]+)'/g) ?? []).map((x) => x.slice(1, -1)).sort();
    const ledger = lits(ledgerSql.match(/surface\s+text NOT NULL CHECK \(surface IN \(([^)]*)\)\)/)?.[1]);
    const anchor = lits(anchorSql.match(/CHECK \(surface IN \(([^)]*)\)\)/)?.[1]);
    expect(ledger).toEqual(Object.values(m.ANCHOR_TO_LEDGER_SURFACE).sort());
    expect(anchor).toEqual(Object.keys(m.ANCHOR_TO_LEDGER_SURFACE).sort());
  });
});
