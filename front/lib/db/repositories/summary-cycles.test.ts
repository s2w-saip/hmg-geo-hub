import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

// 회차 프로브의 **실패 자세**를 고정한다 — PR① R7(2026-09-10).
//
// `hasOpenCycle` 은 관측 전용이다: 결과가 화면에 나가지 않고 게이트 판정도
// 바꾸지 않는다(`x-hmg-summary` 꼬리표뿐). 그래서 표가 없거나 DB 가 죽어도
// **폴백하지 않고 false** 여야 한다 — 배지 시절의 `open-cycle-unavailable`(= 미러
// 폴백)은 값이 화면에 나갔기 때문에 필요했던 자세이고, 배지가 사라진 뒤에는
// "관측 실패 때문에 전 화면이 느려지는" 손해만 남는다(제품 결정 2026-09-10).
//
// `pickWebsiteCycles`/`pickGlobalCycle` 의 `catch → null` 은 반대로 **폴백해야**
// 한다(회차를 모르면 사실표를 읽을 수 없다) — 그것도 여기서 함께 못 박는다.

const dialect = new PgDialect();
const captured: string[] = [];
const capturedParams: unknown[][] = [];
let rows: unknown[] = [];
let boom: Error | null = null;
const execute = vi.fn(async (q: SQL) => {
  const built = dialect.sqlToQuery(q);
  captured.push(built.sql);
  capturedParams.push(built.params);
  if (boom) throw boom;
  return rows as unknown as never;
});
vi.mock("@/lib/db", () => ({ getDb: () => ({ execute }) }));

const PIDS = ["11111111-1111-1111-1111-111111111111"];

beforeEach(() => {
  execute.mockClear();
  captured.length = 0;
  capturedParams.length = 0;
  rows = [];
  boom = null;
});

describe("hasOpenCycle — 관측 전용, 실패해도 판정에 영향 0", () => {
  it("DB 가 던지면 false (예외를 게이트로 흘리지 않는다)", async () => {
    const m = await import("./summary-cycles");
    boom = new Error('relation "summary_cycles" does not exist');
    await expect(m.hasOpenCycle(PIDS)).resolves.toBe(false);
    // 프로브는 실제로 시도했다 — 조용히 건너뛴 것이 아니다.
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("행이 없어도 false (판정 불가 ≠ 폴백)", async () => {
    const m = await import("./summary-cycles");
    rows = [];
    await expect(m.hasOpenCycle(PIDS)).resolves.toBe(false);
  });

  it("EXISTS 결과를 그대로 돌려준다", async () => {
    const m = await import("./summary-cycles");
    rows = [{ open_cycle: true }];
    await expect(m.hasOpenCycle(PIDS)).resolves.toBe(true);
    rows = [{ open_cycle: false }];
    await expect(m.hasOpenCycle(PIDS)).resolves.toBe(false);
    // null(드라이버 변형)도 true 가 아니다.
    rows = [{ open_cycle: null }];
    await expect(m.hasOpenCycle(PIDS)).resolves.toBe(false);
  });

  it("인자가 비면 DB 를 보지 않는다", async () => {
    const m = await import("./summary-cycles");
    await expect(m.hasOpenCycle([])).resolves.toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it("원장을 직접 본다 — summary_cycles.status='open' (미귀속 run 프록시가 아니다)", async () => {
    // T16 검증 6-②: 종전 술어(회차 마지막 run 뒤의 미귀속 run)는 회차 관제가
    // 착지하면 **거꾸로** 작동한다 — 관제가 그 run 을 전부 귀속하므로 실측 1,232 → 0
    // 이 되어, 회차가 열려 있는 동안 오히려 관측이 꺼진다.
    const m = await import("./summary-cycles");
    rows = [{ open_cycle: true }];
    await m.hasOpenCycle(PIDS);
    const sql = (captured[0] ?? "").toLowerCase();
    expect(sql).toContain("select exists (");
    expect(sql).toContain("from summary_cycles");
    expect(sql).toContain("c.status = 'open'");
    // 프록시 술어의 흔적이 남아 있으면 안 된다.
    expect(sql).not.toContain("max(r.started_at)");
    expect(sql).not.toContain("summary_cycle_runs");
    // 진척을 세지 않는다 — EXISTS 한 방.
    expect(sql).not.toContain("count(");
    expect(sql).not.toContain("filter (where");
  });
});

describe("회차 선택은 반대 자세 — 모르면 폴백(null)", () => {
  it("pickGlobalCycle: DB 오류는 null", async () => {
    const m = await import("./summary-cycles");
    boom = new Error("boom");
    await expect(m.pickGlobalCycle("be28fe15-c743-4a88-abb8-182b25602812")).resolves.toBeNull();
  });

  it("pickGlobalCycle: uuid 가 아니면 DB 를 보지 않는다", async () => {
    const m = await import("./summary-cycles");
    await expect(m.pickGlobalCycle("mock-root-project")).resolves.toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it("pickWebsiteCycles: DB 오류는 null (부분 결과를 만들지 않는다)", async () => {
    const m = await import("./summary-cycles");
    boom = new Error("boom");
    await expect(m.pickWebsiteCycles(PIDS)).resolves.toBeNull();
  });
});

// ── pickCyclesInRange (PR② T9 / §6-3) — 문장 형태 ──────────────────────────
//
// 단위 테스트는 컴파일 텍스트만 본다. 그래서 여기서 잡는 것은 **실 DB 에서 조용히
// 죽거나 조용히 틀리는 형태**뿐이다:
//   · date **배열** 바인드(drizzle-orm/postgres-js 가 직렬화기를 덮어써 실DB 에서 죽는다)
//   · uuid 목록의 `ARRAY[$1,$2,…]` 펼침(바인드 폭주 → 계획 재사용 불가, PR① B4-a)
//   · 표면별 술어 혼입(글로벌에 fleet_visible 이 붙으면 조용히 공집합)
//   · 판정 열 누락(`status`·renderable 이 없으면 `open` 을 구멍으로 오판한다)
describe("pickCyclesInRange — 문장 형태", () => {
  const IDS = [
    "11111111-1111-1111-1111-111111111111",
    "22222222-2222-2222-2222-222222222222",
  ];

  it("바인드는 배열 1개 + 스칼라 — 상한 30 규율 안(id 수와 무관)", async () => {
    const m = await import("./summary-cycles");
    const many = Array.from({ length: 95 }, (_, i) =>
      `1111111${(i % 10)}-1111-1111-1111-${String(i).padStart(12, "0")}`,
    );
    await m.pickCyclesInRange({
      surface: "website",
      projectIds: many,
      dateFrom: "2026-06-01",
      dateTo: "2026-09-10",
    });
    // surface + uuid[] + from + to = 4.
    expect(capturedParams[0]).toHaveLength(4);
    expect(capturedParams[0]?.length).toBeLessThanOrEqual(30);
    const sql = captured[0] ?? "";
    // id 는 배열 바인드 1개다 — `ARRAY[$1,$2,…]` 펼침이 아니다.
    expect(sql).toContain("::uuid[]");
    expect(sql).not.toMatch(/\$3,\s*\$4,\s*\$5/);
  });

  it("날짜는 **스칼라** 바인드 — `::date[]` 배열을 만들지 않는다", async () => {
    const m = await import("./summary-cycles");
    await m.pickCyclesInRange({
      surface: "global",
      projectIds: [IDS[0] as string],
      dateFrom: "2026-06-01",
      dateTo: "2026-09-10",
    });
    const sql = captured[0] ?? "";
    expect(sql).not.toContain("::date[]");
    // UTC 일 경계를 서버 TimeZone 에 맡기지 않는다(게이트 `utcDay` 와 같은 축).
    expect(sql).toContain("::date)::timestamp AT TIME ZONE 'UTC'");
    // 상계는 반열림 — to 그날 안의 어느 시각 anchor 도 포함된다.
    expect(sql).toContain("+ 1)");
    expect(sql).toContain("cycle_anchor_at >=");
    expect(sql).toContain("cycle_anchor_at <");
  });

  it("기간이 없으면 날짜 술어 자체가 안 붙는다(바인드 2개)", async () => {
    const m = await import("./summary-cycles");
    await m.pickCyclesInRange({ surface: "global", projectIds: [IDS[0] as string] });
    expect(capturedParams[0]).toHaveLength(2);
    expect(captured[0] ?? "").not.toContain("cycle_anchor_at >=");
  });

  // fleet_visible 은 **술어와 열이 다른 명제**다(2026-09-18).
  //   · 술어(WHERE) = 웹사이트 회차의 정의(0053/0054). 글로벌에 걸면 누적·구멍 판정까지 바뀐다.
  //   · 열(SELECT)  = 두 표면 다. 글로벌 **추이**가 같은 주 패자를 거르는 입력이다
  //                   (`cycle-set.ts::restrictToFleetVisible`).
  const whereOf = (text: string): string => text.slice(text.indexOf("WHERE"));

  it("fleet_visible **술어**는 웹사이트에만 붙는다", async () => {
    const m = await import("./summary-cycles");
    await m.pickCyclesInRange({ surface: "website", projectIds: IDS });
    expect(whereOf(captured[0] ?? "")).toContain("fleet_visible");
    captured.length = 0;
    await m.pickCyclesInRange({ surface: "global", projectIds: IDS });
    // 글로벌은 술어가 없다 — 있으면 한 주 두 회차의 누적 합산이 조용히 반쪽이 된다.
    expect(whereOf(captured[0] ?? "")).not.toContain("fleet_visible");
  });

  it("fleet_visible **열**은 두 표면 다 낸다 — 추이 거르기의 입력", async () => {
    const m = await import("./summary-cycles");
    for (const surface of ["global", "website"] as const) {
      captured.length = 0;
      await m.pickCyclesInRange({ surface, projectIds: IDS });
      expect((captured[0] ?? "").toLowerCase(), surface).toContain("as fleet_visible");
    }
  });

  it("판정에 필요한 열을 전부 낸다 — status 와 renderable", async () => {
    const m = await import("./summary-cycles");
    await m.pickCyclesInRange({ surface: "global", projectIds: IDS });
    const sql = (captured[0] ?? "").toLowerCase();
    expect(sql).toContain("c.status");
    // "노출 가능" 의 정의(V-2) = 앵커 존재 + **노출일 도래** + generation. 스냅샷 픽과 같은 술어.
    expect(sql).toContain(
      "c.view_anchor_at is not null and c.view_anchor_at <= now() and c.active_generation_id is not null",
    );
    // 구멍(미생성)과 금족(아직 노출일 전)을 가르는 열도 함께 낸다.
    expect(sql).toContain("c.view_anchor_at > now()");
    expect(sql).toContain("as pending");
    // 회차 원장만 본다 — run·세부층을 조인하지 않는다(게이트 오버헤드 예산).
    expect(sql).not.toContain("summary_cycle_runs");
    expect(sql).not.toContain("scope_runs");
    expect(sql).not.toContain("join");
  });

  // ── D2 §5-F2: 성능 예산 — 컬럼 하나가 늘 뿐 **왕복은 그대로**다 ─────────────
  //
  // 0071 범위를 별도 조회로 붙이면 기간 표면의 게이트 왕복이 2배가 된다(PR⑤ 목표
  // `kpi-competitors` p95 ≤ 1,080 ms 를 갉아먹는다). 같은 문장의 SELECT 목록에만 얹는다.
  it("hidden_scope 는 같은 문장에 컬럼 하나로 붙는다 — 문장 수 1 (D2 F2)", async () => {
    const m = await import("./summary-cycles");
    // 컬럼 프로브(0070·0071)는 프로세스당 1회다 — 먼저 태워 보내고 캡처를 비운다.
    await m.pickCyclesInRange({ surface: "global", projectIds: IDS });
    captured.length = 0;
    capturedParams.length = 0;
    execute.mockClear();

    await m.pickCyclesInRange({ surface: "global", projectIds: IDS });
    expect(execute, "게이트 왕복은 문장 하나다").toHaveBeenCalledTimes(1);
    const text = captured[0] ?? "";
    const lower = text.toLowerCase();
    expect(lower).toContain("as hidden");
    expect(lower).toContain("as hidden_scope");
    // 판정 열 12 + 범위 1 + fleet_visible 1 = 14. 늘면 "행이 좁아 전송 비용 무시" 근거가 바뀐다.
    expect((text.match(/\sAS\s/g) ?? []).length).toBe(14);
    // 범위는 원장 조인이 아니라 **같은 행의 컬럼**이다.
    expect(lower).not.toContain("join");
    // 바인드는 늘지 않는다(surface + uuid[]).
    expect(capturedParams[0]).toHaveLength(2);
  });

  it("노출 불가 회차도 걷어 온다 — WHERE 에 view_anchor_at 필터가 없다", async () => {
    // 이 필터를 넣으면 §6-3 (b)(구멍) 판정이 원천적으로 불가능해진다.
    const m = await import("./summary-cycles");
    await m.pickCyclesInRange({ surface: "global", projectIds: IDS });
    const where = (captured[0] ?? "").toLowerCase().split("where")[1] ?? "";
    expect(where).not.toContain("view_anchor_at is not null");
  });

  // ── 어휘 밖 `hidden_scope` 는 **넓은 쪽**으로 접는다 (검증자 커버리지 지적 2026-09-11) ──
  //
  // 이 매핑을 지워도 테스트가 0 FAIL 이었다. 원장 CHECK 가 두 값을 강제하지만, 구 원장·
  // 드라이버 변형·0071 롤백 중간 상태에서 다른 문자열이 올 수 있다. 그때 `citations` 가
  // 아닌 것을 `citations` 로 읽으면 **반쪽 회차가 조용히 합계에 든다** — 방향을 못 박는다.
  it("어휘 밖 hidden_scope 는 'all' 로 접혀 judgeCycleRange 가 **배제**한다", async () => {
    const m = await import("./summary-cycles");
    const { judgeCycleRange } = await import("@/lib/summary/read/cycle-set");
    const normal = {
      cycle_id: "aaaaaaaa-0000-0000-0000-0000000000f1",
      generation_id: "bbbbbbbb-0000-0000-0000-0000000000f1",
      project_id: IDS[0] as string,
      cycle_anchor_at: "2026-08-18T01:00:00.000Z",
      cycle_week: "2026-08-17",
      status: "published",
      renderable: true,
      pending: false,
      analysis_gap_ratio: "0.01",
      expected_units: 9068,
      completed_units: 9068,
      hidden: false,
      hidden_scope: "all",
    };
    rows = [
      normal,
      {
        cycle_id: "1045851c-e47d-4977-bda1-550c56d74705",
        generation_id: "bbbbbbbb-0000-0000-0000-0000000000f2",
        project_id: IDS[0] as string,
        cycle_anchor_at: "2026-08-25T12:50:33.000Z",
        cycle_week: "2026-08-24",
        status: "published",
        renderable: true,
        pending: false,
        analysis_gap_ratio: "0.09298",
        expected_units: 9652,
        completed_units: 9652,
        hidden: true,
        hidden_scope: "weird",
      },
    ];
    const picked = (await m.pickCyclesInRange({ surface: "global", projectIds: IDS })) ?? [];
    expect(picked.map((r) => r.hiddenScope)).toEqual(["all", "all"]);
    // 접힌 값이 실제로 배제로 이어지는가 — 매핑만 보면 "그래서 뭐가 달라지나" 를 놓친다.
    const r = judgeCycleRange("global", [IDS[0] as string], picked);
    if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
    expect(r.set.cycles.map((c) => c.cycleWeek)).toEqual(["2026-08-17"]);
    expect(r.set.skippedCount).toBe(1);
    // `citations` 였다면 집합에 들었을 것이다(대조군).
    const asCitations = picked.map((row) =>
      row.hidden ? { ...row, hiddenScope: "citations" as const } : row,
    );
    const r2 = judgeCycleRange("global", [IDS[0] as string], asCitations);
    if (!r2.ok) throw new Error(`expected ok, got ${r2.reason}`);
    expect(r2.set.cycles).toHaveLength(2);
  });

  it("DB 오류는 null (판정 불가 → 폴백), uuid 가 하나도 없으면 [] (판정 가능·빈 범위)", async () => {
    const m = await import("./summary-cycles");
    boom = new Error("boom");
    await expect(
      m.pickCyclesInRange({ surface: "global", projectIds: IDS }),
    ).resolves.toBeNull();

    boom = null;
    execute.mockClear();
    await expect(
      m.pickCyclesInRange({ surface: "global", projectIds: ["mock-root-project"] }),
    ).resolves.toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });

  it("날짜 형식이 깨지면 DB 를 보지 않고 null (fail-closed)", async () => {
    const m = await import("./summary-cycles");
    await expect(
      m.pickCyclesInRange({ surface: "global", projectIds: IDS, dateFrom: "2026/06/01" }),
    ).resolves.toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });
});

// ── V-2 뷰 앵커 게이트 (PR② T14) ───────────────────────────────────────────
//
// `view_anchor_at` = 고객이 기대하는 **값이 보이는 날짜**. 그날 전에는 published 회차여도
// 서빙하지 않고 직전 회차를 그대로 낸다. 술어 정본은 `cycleViewableSql` 한 곳이며, 네
// 조회 경로가 **전부** 그것을 쓴다는 것을 여기서 못 박는다 — 한 곳만 빠지면 "게이트는
// 통과했는데 조회는 빈" 회차가 생긴다.
describe("V-2 · 노출 술어가 네 경로에서 같다", () => {
  const IDS = [
    "11111111-1111-1111-1111-111111111111",
    "22222222-2222-2222-2222-222222222222",
  ];
  /** `<= now()` 가 앵커 존재 검사와 **짝으로** 들어갔는지. */
  const gatePairs = (text: string) =>
    (text.toLowerCase().match(/view_anchor_at is not null and (?:c\.)?view_anchor_at <= now\(\)/g) ?? [])
      .length;

  it("cycleViewableSql: 별칭 유무로 두 형태를 낸다", async () => {
    const { __testables } = await import("./summary-cycles");
    const compile = (q: Parameters<typeof dialect.sqlToQuery>[0]) => dialect.sqlToQuery(q).sql;
    expect(compile(__testables.cycleViewableSql())).toBe(
      "view_anchor_at IS NOT NULL AND view_anchor_at <= now()",
    );
    expect(compile(__testables.cycleViewableSql("c"))).toBe(
      "c.view_anchor_at IS NOT NULL AND c.view_anchor_at <= now()",
    );
  });

  it("pickGlobalCycle: 노출일이 안 된 회차를 건너뛰도록 술어가 붙는다", async () => {
    const m = await import("./summary-cycles");
    await m.pickGlobalCycle("be28fe15-c743-4a88-abb8-182b25602812");
    const text = (captured[0] ?? "").toLowerCase();
    // 2단(주 선택 `wk` + 그 주 조회) 양쪽에 붙는다 — `pickWebsiteCycles` 와 같은 자세.
    // 한 쪽만 붙으면 "미래 앵커 회차의 주를 골라 놓고 그 주에서 아무것도 못 고름" 이 된다.
    expect(
      (text.match(/view_anchor_at is not null and [cw]\.view_anchor_at <= now\(\)/g) ?? []).length,
    ).toBe(2);
    // 직전 회차로 떨어지는 경로가 살아 있다 — **주**를 anchor 내림차순 1개로 고른다.
    expect(text).toContain("order by w.cycle_anchor_at desc");
    expect(text).toContain("limit 1");
    // 본 조회는 그 주 **전부**를 앵커 내림차순으로 — 대표 선택은 JS(`dropFleetLosers`)다.
    // 이 조인이 빠지면 2단이 사라져 픽이 다시 "최신 앵커 1개" 가 된다.
    expect(text).toContain("c.cycle_week = wk.cycle_week");
    // 1단은 `max(cycle_week)` 가 아니라 **최신 앵커의 주**다 — 앵커가 사후 보정돼
    // 주와 어긋난 회차가 있을 때 둘이 갈린다(종전 판정 보존 쪽이 최신 앵커다).
    expect(text).not.toContain("max(cycle_week)");
    expect(text).toContain("order by c.cycle_anchor_at desc");
    // 술어로 걸면 대표가 숨김·미발행인 주에서 **더 과거 회차**로 후퇴한다.
    expect(text.slice(text.indexOf("from summary_cycles c"))).not.toContain("and c.fleet_visible");
  });

  it("pickWebsiteCycles: 주 선택(wk)과 본 조회 **양쪽**에 붙는다", async () => {
    const m = await import("./summary-cycles");
    await m.pickWebsiteCycles(PIDS);
    // 한 쪽만 붙으면 "최신 주는 미래 앵커인데 그 주에서 고르려다 공집합" 이 된다.
    expect(gatePairs(captured[0] ?? "")).toBe(2);
  });

  it("pickCyclesInRange: renderable 은 게이트를, pending 은 금족을 각각 센다", async () => {
    const m = await import("./summary-cycles");
    await m.pickCyclesInRange({ surface: "global", projectIds: IDS });
    const text = (captured[0] ?? "").toLowerCase().replace(/\s+/g, " ");
    expect(gatePairs(text)).toBe(1);
    // pending 은 renderable 의 여집합이 아니라 **그 중 노출일 전인 것**이다.
    expect(text).toContain(
      "(c.view_anchor_at is not null and c.view_anchor_at > now() and c.active_generation_id is not null) as pending",
    );
  });

  it("fleet 순위는 2단 — 서빙 중이 미래 앵커를 이기고, 미래 앵커가 미생성을 이긴다", async () => {
    const { __testables } = await import("./summary-cycles");
    const text = dialect.sqlToQuery(__testables.cycleFleetSql({ now: new Date("2026-09-09T00:00:00Z") })).sql;
    const norm = text.replace(/\s+/g, " ");
    const first = norm.indexOf("ORDER BY (c.view_anchor_at IS NOT NULL AND c.view_anchor_at <= $1::timestamptz) DESC");
    const second = norm.indexOf("(c.view_anchor_at IS NOT NULL) DESC");
    const expected = norm.indexOf("COALESCE(c.expected_units, 0) DESC");
    expect(first, "1단 = 지금 서빙 중").toBeGreaterThanOrEqual(0);
    expect(second, "2단 = 생성됨").toBeGreaterThan(first);
    expect(expected, "3단 = expected").toBeGreaterThan(second);
    // 기준 시각은 관제 tx 의 주입 시계를 쓴다(다섯 문장이 같은 now 를 본다).
    expect(dialect.sqlToQuery(__testables.cycleFleetSql({ now: new Date("2026-09-09T00:00:00Z") })).params)
      .toEqual(["2026-09-09T00:00:00.000Z"]);
  });

  it("게이트는 **읽기 전용** — 노출 술어 어디서도 view_anchor_at 을 SET 하지 않는다", async () => {
    const m = await import("./summary-cycles");
    captured.length = 0;
    await m.pickGlobalCycle("be28fe15-c743-4a88-abb8-182b25602812");
    await m.pickWebsiteCycles(PIDS);
    await m.pickCyclesInRange({ surface: "website", projectIds: IDS });
    for (const text of captured) expect(text).not.toMatch(/view_anchor_at\s*=/);
  });
});
