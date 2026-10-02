import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  resetColumnAvailabilityForTests,
  setColumnAvailabilityForTests,
} from "@/lib/db/column-availability";
// ⚠️ 정적 import 다. 동적 `await import()` + `vi.resetModules()` 를 쓰면 프로브 상태를
//    쥔 모듈 인스턴스가 갈려, `setColumnAvailabilityForTests` 가 **다른 맵**에 쓴다.
import { anchorLedgerServableSql, anchorNotHiddenSql } from "./scope-answer-anchors";
import { cycleNotHiddenSql, cycleViewableSql } from "./summary-cycles";

// ════════════════════════════════════════════════════════════════════════════
// 함대 게이트 — 집계층과 **같은 회차**를 고르는가 (프리뷰 실측 2026-09-20)
// ════════════════════════════════════════════════════════════════════════════
//
// 관찰: `/ko/website` 에서 메인 카드는 09-11, 달력의 기본 회차 표식과 하위 탭은 09-18.
// 원인: 두 경로의 완결성 기준이 달랐다.
//   · 집계층(`summary-cycles.ts::pickWebsiteCycles`) — 원장에서 `fleet_visible` ·
//     `view_anchor_at <= now()` · **`active_generation_id IS NOT NULL`** · 숨김 아님
//   · 앵커 축 — 행 단위 게이트만(`ca.view_anchor_date` · 숨김 · 기본 엔진)
// 미러 싱크는 요약 생성과 독립이라, 답변은 들어왔고 요약은 아직인 창에서 갈렸다.
//
// 이 파일이 고정하는 것 둘:
//   ① 술어의 **텍스트가 집계층 정의와 같다**(정의가 두 벌인 것을 감수하되 드리프트는 막는다)
//   ② 함대 픽스처에서 **집계층 규칙과 앵커 규칙이 같은 날짜**를 고른다

const dialect = new PgDialect();
const compile = (q: SQL) => dialect.sqlToQuery(q).sql;

beforeEach(() => {
  resetColumnAvailabilityForTests();
  setColumnAvailabilityForTests("summary_cycle_runs", "attributed_by", true);
  setColumnAvailabilityForTests("summary_cycles", "hidden_reason", true);
  setColumnAvailabilityForTests("summary_cycles", "hidden_scope", true);
});
afterEach(() => resetColumnAvailabilityForTests());

describe("① 술어가 집계층 정의와 같은 텍스트다", () => {
  it("노출 게이트는 `cycleViewableSql` 과 글자가 같다", async () => {
    // `cycleViewableSql("sc")` = `sc.view_anchor_at IS NOT NULL AND sc.view_anchor_at <= now()`
    expect(compile(await anchorLedgerServableSql())).toContain(compile(cycleViewableSql("sc")));
  });

  // ⚠️ 2026-09-20 수리 — **숨김은 이 조각에 없다.** 있으면 범위를 안 봐서
  //    `hidden_scope='citations'` 회차가 **언급 계열에서도** 빠진다(0071 결정 위반).
  //    판정은 계열 인자를 받는 `anchorNotHiddenSql(family)` 한 곳이 쥔다.
  it("숨김 항은 이 조각에 **없다** (계열 판정이 따로 쥔다)", async () => {
    const t = compile(await anchorLedgerServableSql());
    expect(t).not.toContain("hidden_reason");
    expect(t).not.toContain("hidden_scope");
    // 원장 픽(집계층)은 여전히 자기 자리에서 숨김을 본다 — 그쪽 정의는 안 건드렸다.
    expect(compile(cycleNotHiddenSql(true, "sc"))).toContain("sc.hidden_reason IS NULL");
  });

  it("집계층 픽의 **함대 조건 셋**을 전부 본다", async () => {
    const t = compile(await anchorLedgerServableSql());
    for (const frag of [
      "sc.fleet_visible",
      "sc.active_generation_id IS NOT NULL",
      "sc.view_anchor_at <= now()",
    ]) {
      expect(t, frag).toContain(frag);
    }
  });

  it("프로젝트 표면은 통과시킨다 — 그 표면엔 회차 원장이 없다", async () => {
    expect(compile(await anchorLedgerServableSql())).toContain("ca.surface = 'project' OR");
  });

  it("별칭을 갈아 끼운다 (max() 서브쿼리는 `ca2` 다)", async () => {
    const t = compile(await anchorLedgerServableSql("ca2"));
    expect(t).toContain("sc.cycle_id = ca2.cycle_id");
    expect(t).not.toContain("= ca.cycle_id");
  });

  it("원장이 없는 배포에서는 제약 없음 — 종전과 바이트 동일", async () => {
    resetColumnAvailabilityForTests();
    setColumnAvailabilityForTests("summary_cycle_runs", "attributed_by", false);
    expect(compile(await anchorLedgerServableSql())).toBe("true");
  });

  // 이 조각을 **손으로 복사한 픽스처가 셋** 있다(덤프 매니페스트 + pglite 가드 2종).
  // 복사본이 낡으면 그 가드들이 프로덕션에 없는 술어를 검증하게 된다 — 값 싼 드리프트
  // 가드를 여기 둔다(전문 대조가 아니라 "숨김 항이 없다" 한 줄).
  it("손복사 픽스처 셋도 숨김 항을 안 갖는다", () => {
    const root = fileURLToPath(new URL("../../..", import.meta.url));
    for (const rel of [
      "scripts/db/axis-on-sql-manifest.ts",
      "lib/db/repositories/trend-grid-statements.pglite.test.ts",
      "lib/db/repositories/trend-aligned-preds.test.ts",
    ]) {
      const src = readFileSync(`${root}${rel}`, "utf8");
      const frag = src.slice(src.indexOf("sc.fleet_visible"), src.indexOf("sc.fleet_visible") + 400);
      expect(frag, rel).not.toContain("sc.hidden_reason");
    }
  });

  it("0070 유무와 무관하게 **같은 텍스트**다 (숨김 분리 뒤로는 프로브가 필요 없다)", async () => {
    const withCols = compile(await anchorLedgerServableSql());
    setColumnAvailabilityForTests("summary_cycles", "hidden_reason", false);
    setColumnAvailabilityForTests("summary_cycles", "hidden_scope", false);
    expect(compile(await anchorLedgerServableSql())).toBe(withCols);
  });
});

// ── ③ 계열 분리 — 인용만 숨긴 회차가 **언급에서는 남는다** (0071, 2026-09-20 수리) ──
//
// 이 수리가 없애는 결함: 함대 조각이 `hidden_reason IS NULL` 을 범위 구분 없이 묶고
// 있어서, 언급 계열의 달력·기준 회차·기간 술어에서도 `hidden_scope='citations'` 회차가
// 빠졌다. 사실표는 그 회차를 언급 계열에 **남긴다**(`cycle-set.ts::judgeCycleRange` 가
// usable 로 넣고 인용 계열만 `citationExcludedCycleIds` 로 뺀다) — 즉 미러만 좁았다.
describe("③ 계열 판정이 숨김을 혼자 쥔다", () => {
  it("언급 계열 조각은 범위를 본다 — `hidden_scope='all'` 만 제외", async () => {
    const t = compile(await anchorNotHiddenSql("mentions"));
    expect(t).toContain("c.hidden_reason IS NOT NULL");
    expect(t).toContain("COALESCE(c.hidden_scope, 'all') = 'all'");
  });

  it("인용 계열 조각은 범위를 안 본다 — 숨겼으면 전부 제외", async () => {
    const t = compile(await anchorNotHiddenSql("citations"));
    expect(t).toContain("c.hidden_reason IS NOT NULL");
    expect(t).not.toContain("hidden_scope");
  });

  it("두 조각이 **다르다** — 같아지면 계열 결정이 죽은 것이다", async () => {
    expect(compile(await anchorNotHiddenSql("mentions"))).not.toBe(
      compile(await anchorNotHiddenSql("citations")),
    );
  });

  // 달력·기준 회차 선택의 귀결을 픽스처로 고정한다(위 ② 와 같은 자세).
  type ScopedRow = {
    roundDate: string;
    fleetVisible: boolean;
    viewAnchorAtPassed: boolean;
    published: boolean;
    hiddenScope: "all" | "citations" | null;
  };
  const base = { fleetVisible: true, viewAnchorAtPassed: true, published: true } as const;
  const ROWS: ScopedRow[] = [
    { ...base, roundDate: "2026-08-17", hiddenScope: null },
    // 최신 회차가 **인용만** 깨졌다(0071 의 8/25 형태).
    { ...base, roundDate: "2026-08-24", hiddenScope: "citations" },
  ];

  /** 수리 **후** 규칙: 함대 셋 + 계열별 숨김. */
  const pick = (rows: readonly ScopedRow[], family: "mentions" | "citations"): string | null => {
    const hiddenFor = (r: ScopedRow) =>
      family === "mentions" ? r.hiddenScope === "all" : r.hiddenScope !== null;
    const ok = rows.filter(
      (r) => r.fleetVisible && r.viewAnchorAtPassed && r.published && !hiddenFor(r),
    );
    return ok.map((r) => r.roundDate).sort().at(-1) ?? null;
  };

  /** 수리 **전** 규칙: 함대 조각이 범위를 무시하고 숨김을 함께 걸었다. */
  const pickBeforeFix = (rows: readonly ScopedRow[]): string | null => {
    const ok = rows.filter(
      (r) => r.fleetVisible && r.viewAnchorAtPassed && r.published && r.hiddenScope === null,
    );
    return ok.map((r) => r.roundDate).sort().at(-1) ?? null;
  };

  it("언급 지면은 인용만 숨긴 최신 회차를 **그대로 본다**", () => {
    expect(pick(ROWS, "mentions")).toBe("2026-08-24");
  });

  it("인용 지면은 그 앞 회차를 본다 (그 회차엔 인용 값이 없다)", () => {
    expect(pick(ROWS, "citations")).toBe("2026-08-17");
  });

  it("수리 전에는 **언급 지면도** 한 회차 뒤로 밀렸다 — 이 PR 이 없앤 형태", () => {
    expect(pickBeforeFix(ROWS)).toBe("2026-08-17");
    expect(pickBeforeFix(ROWS)).not.toBe(pick(ROWS, "mentions"));
  });

  it("`hidden_scope='all'` 은 두 계열 모두에서 빠진다 (범위가 넓으면 그대로)", () => {
    const allHidden = ROWS.map((r) =>
      r.roundDate === "2026-08-24" ? { ...r, hiddenScope: "all" as const } : r,
    );
    expect(pick(allHidden, "mentions")).toBe("2026-08-17");
    expect(pick(allHidden, "citations")).toBe("2026-08-17");
  });
});

// ── ② 함대 픽스처: 두 규칙이 같은 날짜를 고른다 ────────────────────────────
//
// 실측 모사(메인, 미러 읽기 전용 2026-09-20): website 함대 최근 회차 `round_date`
// 09-04 · 09-11 · 09-18 이 각각 프로젝트 95개. 09-18 회차 하나는 `hidden_scope='all'`
// (1개 프로젝트, 답변 102). **그리고 09-18 의 요약 세대가 아직 발행되지 않았다**
// (= `active_generation_id IS NULL`) — 관찰에서 카드가 09-11 을 본 이유다.
//
// 기대값은 손계산 리터럴 `2026-09-11` 이다.

type LedgerRow = {
  projectId: string;
  roundDate: string;
  cycleWeek: string;
  fleetVisible: boolean;
  viewAnchorAtPassed: boolean;
  published: boolean;
  hidden: boolean;
};

const PROJECTS = Array.from({ length: 95 }, (_, i) => `p${i + 1}`);

/** 09-04·09-11 은 완전 발행, 09-18 은 **미발행**(요약 세대 없음) + 1개 프로젝트 숨김. */
const FLEET: LedgerRow[] = [
  ...PROJECTS.map((projectId) => ({
    projectId,
    roundDate: "2026-09-04",
    cycleWeek: "2026-08-31",
    fleetVisible: true,
    viewAnchorAtPassed: true,
    published: true,
    hidden: false,
  })),
  ...PROJECTS.map((projectId) => ({
    projectId,
    roundDate: "2026-09-11",
    cycleWeek: "2026-09-07",
    fleetVisible: true,
    viewAnchorAtPassed: true,
    published: true,
    hidden: false,
  })),
  ...PROJECTS.map((projectId, i) => ({
    projectId,
    roundDate: "2026-09-18",
    cycleWeek: "2026-09-14",
    fleetVisible: true,
    viewAnchorAtPassed: true,
    published: false, // 요약 세대 미발행
    hidden: i === 0, // 1개 프로젝트가 hidden_scope='all'
  })),
];

/** 집계층 규칙 — `pickWebsiteCycles` 의 술어 그대로(발행·노출·대표·숨김 아님). */
function aggregateLatest(rows: readonly LedgerRow[]): string | null {
  const ok = rows.filter(
    (r) => r.fleetVisible && r.viewAnchorAtPassed && r.published && !r.hidden,
  );
  if (ok.length === 0) return null;
  const week = ok.map((r) => r.cycleWeek).sort().at(-1)!;
  return ok
    .filter((r) => r.cycleWeek === week)
    .map((r) => r.roundDate)
    .sort()
    .at(-1)!;
}

/** 앵커 축 규칙(수리 후) — 행 단위 게이트 **+ 함대 게이트**. */
function anchorLatest(rows: readonly LedgerRow[]): string | null {
  const ok = rows.filter(
    (r) =>
      r.viewAnchorAtPassed && // ca.view_anchor_date <= today
      !r.hidden && // anchorNotHiddenSql
      r.fleetVisible &&
      r.published, // ← 이번 수리로 추가된 함대 게이트
  );
  if (ok.length === 0) return null;
  return ok.map((r) => r.roundDate).sort().at(-1)!;
}

/** 수리 **전** 앵커 규칙 — 함대 게이트가 없다(회귀를 재현해 둔다). */
function anchorLatestBeforeFix(rows: readonly LedgerRow[]): string | null {
  const ok = rows.filter((r) => r.viewAnchorAtPassed && !r.hidden);
  if (ok.length === 0) return null;
  return ok.map((r) => r.roundDate).sort().at(-1)!;
}

describe("② website 함대 — 집계층과 앵커 축이 같은 회차를 고른다", () => {
  it("집계층 규칙은 2026-09-11 이다 (미발행 09-18 을 건너뛴다)", () => {
    expect(aggregateLatest(FLEET)).toBe("2026-09-11");
  });

  it("수리 후 앵커 규칙도 2026-09-11 이다", () => {
    expect(anchorLatest(FLEET)).toBe("2026-09-11");
    expect(anchorLatest(FLEET)).toBe(aggregateLatest(FLEET));
  });

  it("수리 전에는 09-18 로 갈렸다 — 관찰된 그 형태", () => {
    expect(anchorLatestBeforeFix(FLEET)).toBe("2026-09-18");
    expect(anchorLatestBeforeFix(FLEET)).not.toBe(aggregateLatest(FLEET));
  });

  it("숨김 1개만으로는 회차가 빠지지 않는다 — 발행됐다면 09-18 이 맞다", () => {
    // 09-18 을 발행 상태로 바꾸면(숨김 1개는 그대로) 두 규칙 다 09-18 을 고른다.
    const published = FLEET.map((r) =>
      r.roundDate === "2026-09-18" ? { ...r, published: true } : r,
    );
    expect(aggregateLatest(published)).toBe("2026-09-18");
    expect(anchorLatest(published)).toBe("2026-09-18");
  });

  it("노출일이 아직 안 온 회차는 둘 다 건너뛴다", () => {
    const notYet = FLEET.map((r) =>
      r.roundDate === "2026-09-18"
        ? { ...r, published: true, viewAnchorAtPassed: false }
        : r,
    );
    expect(aggregateLatest(notYet)).toBe("2026-09-11");
    expect(anchorLatest(notYet)).toBe("2026-09-11");
  });

  it("기간을 명시해 09-18 을 포함해도 두 규칙이 같은 집합을 낸다", () => {
    // 기간 술어에도 같은 게이트가 붙으므로 09-18 행은 양쪽에서 빠진다.
    const inWindow = (r: LedgerRow) =>
      r.roundDate >= "2026-09-01" && r.roundDate <= "2026-09-30";
    const agg = new Set(
      FLEET.filter(
        (r) => inWindow(r) && r.fleetVisible && r.viewAnchorAtPassed && r.published && !r.hidden,
      ).map((r) => r.roundDate),
    );
    const anchor = new Set(
      FLEET.filter(
        (r) => inWindow(r) && r.viewAnchorAtPassed && !r.hidden && r.fleetVisible && r.published,
      ).map((r) => r.roundDate),
    );
    expect([...anchor].sort()).toEqual([...agg].sort());
    expect([...anchor].sort()).toEqual(["2026-09-04", "2026-09-11"]);
  });
});
