import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { __testables } from "./summary-period-compare";
import type { Day } from "@/lib/kpi/period-compare";
import { HIDDEN_STANDARD_REGIONS } from "@/lib/scope/hidden-regions";

// 앵커 축(옵트인) 전용 형태 고정. 수용 기준의 **첫 번째**가 여기 있다:
// `anchorAxis` 가 꺼져 있으면 종전 SQL 과 **바이트가 같다**.
//
// ⚠️ 실행 검증은 범위 밖이다 — `scope_answer_cycle_anchors` 는 아직 어떤 DB 에도 없다
//    (계약 §2·§5). 여기서 고정하는 것은 컴파일된 문자열과 순수 배정 규칙뿐이다.

const dialect = new PgDialect();
const compile = (q: SQL) => {
  const c = dialect.sqlToQuery(q);
  return { text: c.sql.toLowerCase(), params: c.params };
};

const UUID = (n: number) => `${String(n).padStart(8, "0")}-0000-0000-0000-000000000000`;
const ST_FULL = { hidden: true, scope: true };

const GLOBAL_Q = {
  surface: "global" as const,
  projectIds: [UUID(3)],
  from: "2026-08-17",
  to: "2026-09-13",
};

const WEBSITE_Q = {
  surface: "website" as const,
  projectIds: [UUID(3), UUID(4)],
  from: "2026-08-15",
  to: "2026-09-11",
  unitFlags: true,
  excludedUnits: [71, 94, 97],
};

describe("끄면 종전과 바이트가 같다", () => {
  it("`anchorAxis` 생략 = `false` = 종전 문자열", () => {
    for (const q of [GLOBAL_Q, WEBSITE_Q]) {
      const off = compile(__testables.compareCycleRowsSql(q, ST_FULL));
      const explicit = compile(__testables.compareCycleRowsSql({ ...q, anchorAxis: false }, ST_FULL));
      expect(explicit.text).toBe(off.text);
      expect(explicit.params).toEqual(off.params);
      // KST 조각도 KST 전용 컬럼도 한 글자 나가지 않는다.
      expect(off.text).not.toContain("asia/seoul");
      expect(off.text).not.toContain("kst_day");
    }
  });
});

describe("앵커 축 원장 문장", () => {
  const on = compile(__testables.compareCycleRowsSql({ ...GLOBAL_Q, anchorAxis: true }, ST_FULL));

  it("`F` 를 **KST** 로 자른다(`prev.lo` 가 round_date 공간이라 축이 같아야 한다)", () => {
    expect(on.text).toContain("at time zone 'asia/seoul'");
    expect(on.text).toContain("first_published_anchor");
    // UTC 판 `F` 는 사라진다 — 같은 문장에 두 벌을 두지 않는다(전 이력 스캔이 두 번 된다).
    expect(on.text.match(/min\(\(c1\.cycle_anchor_at at time zone 'utc'\)/g) ?? []).toHaveLength(0);
  });

  it("KST 일자 컬럼을 하나 더 싣는다(미발행 회차의 폴백 입력)", () => {
    expect(on.text).toContain("as kst_day");
  });

  it("술어는 종전과 같다 — 범위가 느슨해지지 않는다", () => {
    const off = compile(__testables.compareCycleRowsSql(GLOBAL_Q, ST_FULL));
    // 발행 술어·구조 프로브·창 경계는 글자가 같다(차이는 `F` 의 타임존과 추가 컬럼뿐).
    for (const frag of [
      "view_anchor_at is not null and c.view_anchor_at <= now()",
      "c.active_generation_id is not null",
      "o.in_root_catalog = 1",
    ]) {
      expect(off.text).toContain(frag);
      expect(on.text).toContain(frag);
    }
    // 축 on 은 **같은 `F` 술어를 한 벌 더** 싣는다(귀속 날짜 컬럼, D5). 새 값이
    // 들어오지 않는다는 것이 "범위가 안 느슨해진다" 의 기계적 의미다.
    expect(new Set(on.params.map((p) => JSON.stringify(p)))).toEqual(
      new Set(off.params.map((p) => JSON.stringify(p))),
    );
    // +4: `F` 술어 한 벌(3) + 파생 표의 프로젝트 스코프(1). 숨김 국가 절은 목록이 있을 때만
    // 바인드 하나를 싣는다 — 2026-09-28 ID 해제(hmg-geo PR #302)로 목록이 비면 +3.
    expect(on.params).toHaveLength(off.params.length + (HIDDEN_STANDARD_REGIONS.length ? 4 : 3));
  });

  // ── D5: `F` 의 귀속은 **저장된 배정**이 이긴다 ────────────────────────────
  //
  // 공식("같은 주의 정규 요일")은 옆 주로 밀린 배정(`next_empty`·`nearest`·`merged`)을
  // 재현하지 못한다.
  //
  // ⚠️ 2026-09-20 계약 변경: 배정을 **원장 앵커로 찾지 않는다.** 매핑 표의
  //    `anchor_date` 는 앵커 표가 실제로 쓴 앵커(0053 registry 보정 반영)라 원장
  //    `cycle_anchor_at` 의 KST 일자와 다를 수 있고, 그러면 조인이 빗나가 `F` 가
  //    조용히 NULL 이 된다(= 공식 폴백 → 옆 주 분기를 놓친다).
  //    이제 `summary-cycles.ts` 와 **같은 DATA 헬퍼**로 `cycle_id` 를 키로 읽는다.
  it("`F` 의 귀속 날짜를 앵커 표에서 cycle_id 로 한 컬럼 더 읽는다", () => {
    const flat = on.text.replace(/\s+/g, " ");
    expect(on.text).toContain("first_published_round");
    expect(flat).toContain("m1 on m1.cycle_id = c1.cycle_id");
    expect(flat).toContain("from scope_answer_cycle_anchors ca");
    // 매핑 표를 원장 앵커로 찾던 종전 조인은 사라진다.
    expect(on.text).not.toContain("scope_cycle_rounds");
    expect(on.text).not.toContain("m1.anchor_date");
    // COALESCE 로 메우지 않는다 — 메우면 "배정이 있었는지" 를 JS 가 구분 못 한다.
    expect(on.text).not.toContain("coalesce(m1.round_date");
  });

  // N8: "가장 이른 앵커를 가진 **그 회차의** round_date" 여야 한다.
  it("min() 이 아니라 ORDER BY + LIMIT 1 로 그 회차 한 행을 고른다", () => {
    // `compile` 은 줄바꿈을 접지 않으므로 공백을 한 칸으로 눌러 본다.
    const flat = on.text.replace(/\s+/g, " ");
    expect(flat).toContain("order by c1.cycle_anchor_at, c1.project_id limit 1");
    expect(on.text).not.toContain("min(m1.round_date)");
  });

  it("조인이 LEFT 다 — 앵커 행 없는 회차가 집합에서 빠지지 않는다", () => {
    const flat = on.text.replace(/\s+/g, " ");
    expect(flat).toContain("left join ( select ca.cycle_id");
    expect(flat).not.toMatch(/[^t] join \( select ca\.cycle_id/);
  });

  it("축 off 에는 그 컬럼도 조인도 한 글자 안 나간다", () => {
    const off = compile(__testables.compareCycleRowsSql(GLOBAL_Q, ST_FULL));
    expect(off.text).not.toContain("first_published_round");
    expect(off.text).not.toContain("scope_cycle_rounds");
  });

  it("`CASE` 안 숫자 바인드가 없다(42883 방어)", () => {
    expect(on.text).not.toContain("case");
    expect(
      compile(__testables.compareCycleRowsSql({ ...WEBSITE_Q, anchorAxis: true }, ST_FULL)).text,
    ).not.toContain("case");
  });
});

describe("③ 회차 → 귀속 날짜 문장", () => {
  const q = compile(
    __testables.compareRoundDatesSql({
      surface: "global",
      projectIds: [UUID(3), UUID(3)],
      from: "2026-08-03",
      to: "2026-09-27",
    }),
  );

  it("표면 어휘를 원장이 아니라 **앵커 테이블** 것으로 넘긴다(global → standard)", () => {
    expect(q.params).toContain("standard");
    expect(q.params).not.toContain("global");
  });

  it("웹사이트는 어휘가 같다", () => {
    const w = compile(
      __testables.compareRoundDatesSql({
        surface: "website",
        projectIds: [UUID(4)],
        from: "2026-08-03",
        to: "2026-09-27",
      }),
    );
    expect(w.params).toContain("website");
  });

  it("날짜 경계는 `::date` 명시 캐스트다", () => {
    expect(q.text).toMatch(/ca\.round_date >= \$\d+::date/);
    expect(q.text).toMatch(/ca\.round_date <= \$\d+::date/);
  });

  it("프로젝트 id 는 배열 바인드 1개(인라인 0·중복 제거)", () => {
    expect(q.text).toContain("::uuid[]");
    expect(q.text).not.toContain(UUID(3).toLowerCase());
    expect(q.params).toContainEqual([UUID(3)]);
  });

  it("회차 하나로 묶고 `count(DISTINCT)` 를 쓰지 않는다(정렬을 부른다)", () => {
    expect(q.text).toContain("group by 1");
    expect(q.text).not.toContain("count(distinct");
    expect(q.text).toContain("min(ca.round_date)");
    expect(q.text).toContain("max(ca.round_date)");
  });

  it("주·월 키는 **저장값을 읽는다**(파생을 다시 계산하지 않는다)", () => {
    expect(q.text).toContain("ca.anchor_week");
    expect(q.text).toContain("ca.anchor_month");
  });

  it("노출·숨김·엔진 게이트를 걸지 않는다 — 날짜 대응표이지 값의 필터가 아니다", () => {
    // 노출 게이트를 걸면 미발행 회차의 귀속 날짜가 사라져 누락 비중이 구조적으로 0 이 된다.
    expect(q.text).not.toContain("view_anchor_date");
    expect(q.text).not.toContain("hidden_reason");
    expect(q.text).not.toContain("is_default_engine");
  });

  it("문장은 하나다", () => {
    expect(q.text.split(";").filter((s) => s.trim().length > 0)).toHaveLength(1);
  });
});

// ── 구간 배정 규칙(순수) ────────────────────────────────────────────────────

const ROW = (
  cycleId: string,
  day: string,
  expectedUnits: number,
  published: boolean,
): Parameters<typeof __testables.assignLedgers>[0]["rows"][number] => ({
  cycleId,
  generationId: published ? `${cycleId}-g` : null,
  projectId: UUID(3),
  day: day as Day,
  cycleAnchorAt: `${day}T00:00:00.000Z`,
  cycleWeek: day as Day,
  expectedUnits,
  published,
  citationHidden: false,
});

const WINDOWS = [
  { key: "prev", lo: "2026-09-07" as Day, hi: "2026-09-13" as Day },
  { key: "cur", lo: "2026-09-14" as Day, hi: "2026-09-20" as Day },
];

describe("assignLedgers — 합쳐진 회차의 계획량 합산 규칙", () => {
  it("종전 축은 원장 행 하나가 곧 한 회차다", () => {
    const out = __testables.assignLedgers({
      windows: WINDOWS,
      rows: [ROW("c1", "2026-09-08", 1_000, true), ROW("c2", "2026-09-10", 500, true)],
      roundByCycle: new Map(),
      firstPublishedAnchor: "2026-01-05" as Day,
      countRounds: false,
    });
    expect(out.get("prev")!.ledger.publishedCycles).toBe(2);
    expect(out.get("prev")!.ledger.plannedUnits).toBe(1_500);
  });

  it("앵커 축에서 두 회차가 한 자리로 합쳐지면 **회차 수는 1, 계획량은 합**이다", () => {
    const out = __testables.assignLedgers({
      windows: WINDOWS,
      rows: [ROW("c1", "2026-09-08", 1_000, true), ROW("c2", "2026-09-10", 500, true)],
      // 스펙 §9.2 "둘 다 차 있으면 가까운 회차에 합침" — 둘 다 09-07 자리로 간다.
      roundByCycle: new Map([
        ["c1", "2026-09-07" as Day],
        ["c2", "2026-09-07" as Day],
      ]),
      firstPublishedAnchor: "2026-01-05" as Day,
      countRounds: true,
    });
    const l = out.get("prev")!.ledger;
    expect(l.publishedCycles).toBe(1);
    expect(l.plannedUnits).toBe(1_500);
    expect(l.missingUnits).toBe(0);
  });

  it("한 자리에서 한쪽만 발행됐으면 다른 쪽 계획량은 **그대로 누락**이다", () => {
    const out = __testables.assignLedgers({
      windows: WINDOWS,
      rows: [ROW("c1", "2026-09-08", 1_000, true), ROW("c2", "2026-09-10", 500, false)],
      roundByCycle: new Map([
        ["c1", "2026-09-07" as Day],
        ["c2", "2026-09-07" as Day],
      ]),
      firstPublishedAnchor: "2026-01-05" as Day,
      countRounds: true,
    });
    const l = out.get("prev")!.ledger;
    expect(l.publishedCycles).toBe(1);
    expect(l.plannedUnits).toBe(1_500);
    expect(l.missingUnits).toBe(500); // 누락 비중 1/3 — 0 으로 접지 않는다
  });

  it("귀속 날짜가 원래 앵커일과 다른 구간으로 옮겨 간다(축 전환의 요점)", () => {
    const out = __testables.assignLedgers({
      windows: WINDOWS,
      // 앵커는 09-13(일)인데 귀속은 다음 주 월요일 09-14 다.
      rows: [ROW("c1", "2026-09-13", 800, true)],
      roundByCycle: new Map([["c1", "2026-09-14" as Day]]),
      firstPublishedAnchor: "2026-01-05" as Day,
      countRounds: true,
    });
    expect(out.get("prev")!.ledger.plannedUnits).toBe(0);
    expect(out.get("cur")!.ledger.plannedUnits).toBe(800);
  });

  it("여유분으로 읽혔지만 어느 구간에도 안 들어오는 회차는 버린다", () => {
    const out = __testables.assignLedgers({
      windows: WINDOWS,
      rows: [ROW("c9", "2026-08-31", 900, true)],
      roundByCycle: new Map([["c9", "2026-08-31" as Day]]),
      firstPublishedAnchor: "2026-01-05" as Day,
      countRounds: true,
    });
    expect(out.get("prev")!.ledger.plannedUnits).toBe(0);
    expect(out.get("cur")!.ledger.plannedUnits).toBe(0);
  });

  it("계획 단위가 0 인 구간은 `plannedKnown=false`(누락 0% 가 아니다)", () => {
    const out = __testables.assignLedgers({
      windows: WINDOWS,
      rows: [ROW("c1", "2026-09-08", 0, true)],
      roundByCycle: new Map(),
      firstPublishedAnchor: null,
      countRounds: false,
    });
    expect(out.get("prev")!.ledger.plannedKnown).toBe(false);
    expect(out.get("prev")!.ledger.publishedCycles).toBe(1);
  });
});
