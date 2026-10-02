import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

// ════════════════════════════════════════════════════════════════════════════
// 앵커 축(0077) — 회차 **범위 조회**의 SQL 형태 (실 DB 없이)
// ════════════════════════════════════════════════════════════════════════════
//
// 계약: `notes/hmg-anchor-table/streams/CONTRACT.md` §3·§5.
//
// 고정하는 것 다섯:
//   ① 축이 꺼져 있으면 문장에 `scope_cycle_rounds` 도 `round_date` 도 **없다**
//      (= 오늘 프로덕션이 내는 그 문장). 0077 미적용 DB 에서 42703 이 날 자리가 없다.
//   ② 축이 켜지면 매핑 표를 **LEFT JOIN** 한다 — 상관 서브쿼리가 아니다(§5).
//   ③ 조인 키는 `(project_id, anchor_date)` 이고 `surface` 를 **넣지 않는다**
//      (원장은 'global', 매핑 표는 'standard' 로 같은 개념을 부른다 — 넣으면 0행).
//   ④ 기간 술어가 귀속 날짜에 **양 끝 포함**으로 걸린다(`>= … AND <= …`).
//      종전의 반열림 상한(`< (to+1)`)은 사라진다.
//   ⑤ 앵커 일자는 **KST**(`AT TIME ZONE 'Asia/Seoul'`)로 자른다 — UTC 가 아니다.
//      (`hmg_anchor_date` 와 같은 절단. 0077 자가검증이 같은 경계를 단언한다.)

const dialect = new PgDialect();
const captured: string[] = [];
let rows: unknown[] = [];
const execute = vi.fn(async (q: SQL) => {
  captured.push(dialect.sqlToQuery(q).sql);
  return rows as unknown as never;
});
vi.mock("@/lib/db", () => ({ getDb: () => ({ execute }) }));
// 0070/0071 프로브는 이 테스트의 관심사가 아니다 — 양쪽 축에서 같은 값을 준다.
// 부분 모킹: 다른 프로브(0077 쓰기 가능 여부 등)는 원본을 그대로 쓴다.
vi.mock("@/lib/db/column-availability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/column-availability")>()),
  hiddenCycleColumnsAvailable: async () => false,
  hiddenCycleScopeAvailable: async () => false,
}));

const { pickCyclesInRange, pickGlobalCycle, pickWebsiteCycles } = await import("./summary-cycles");

const P1 = "11111111-1111-1111-1111-111111111111";
const ROOT = "be28fe15-c743-4a88-abb8-182b25602812";

beforeEach(() => {
  captured.length = 0;
  rows = [];
  execute.mockClear();
});

const last = () => captured[captured.length - 1] ?? "";

describe("pickCyclesInRange — 축이 꺼져 있으면 종전 문장", () => {
  it("매핑 표도 귀속 날짜도 문장에 없다", async () => {
    await pickCyclesInRange({
      surface: "global",
      projectIds: [ROOT],
      dateFrom: "2026-09-01",
      dateTo: "2026-09-30",
    });
    expect(last()).not.toContain("scope_cycle_rounds");
    expect(last()).not.toContain("round_date");
    // 종전 경계 — 하한은 그 날 00:00(UTC), 상한은 반열림 `< (to+1)`.
    expect(last()).toContain("c.cycle_anchor_at >= ((");
    expect(last()).toContain("c.cycle_anchor_at < (((");
  });
});

describe("pickCyclesInRange — 축이 켜지면 귀속 날짜 축", () => {
  // ⚠️ 2026-09-20 계약 변경: 매핑 표를 **원장 앵커로 찾지 않는다.** 매핑 표의
  //    `anchor_date` 는 앵커 표가 실제로 쓴 앵커(0053 registry 보정 반영)라 원장
  //    `cycle_anchor_at` 의 KST 일자와 다를 수 있고, 그러면 조인이 빗나가 폴백이
  //    앵커 KST 일자를 낸다(website 추이 x축에 토·일 라벨이 선 원인).
  //    이제 **앵커 표에서 `cycle_id` 로 직접** 읽는다.
  it("앵커 표를 cycle_id 로 LEFT JOIN 하고 기간을 양 끝 포함으로 건다", async () => {
    await pickCyclesInRange({
      surface: "global",
      projectIds: [ROOT],
      dateFrom: "2026-09-01",
      dateTo: "2026-09-30",
      anchorAxis: true,
    });
    const sql = last();
    const flat = sql.replace(/\s+/g, " ");
    // 파생 표 — 회차당 1행(`round_date` 는 회차 안에서 유일하다).
    expect(flat).toContain("LEFT JOIN ( SELECT ca.cycle_id AS cycle_id");
    expect(flat).toContain("min(ca.round_date) AS round_date");
    expect(flat).toContain("FROM scope_answer_cycle_anchors ca");
    expect(flat).toContain("GROUP BY ca.cycle_id ) cr ON cr.cycle_id = c.cycle_id");
    // 파생 표는 바깥 질의와 **같은 프로젝트 집합**으로 좁힌다(상관이 아니다).
    expect(flat).toContain("WHERE ca.cycle_id IS NOT NULL AND ca.project_id =");
    // 매핑 표를 원장 앵커로 찾던 종전 조인은 사라진다.
    expect(sql).not.toContain("scope_cycle_rounds");
    expect(sql).not.toContain("m.anchor_date");
    // 기간 술어 — 양 끝 포함, 폴백은 앵커의 KST 일자.
    expect(sql).toContain(
      "COALESCE(cr.round_date, (c.cycle_anchor_at AT TIME ZONE 'Asia/Seoul')::date) >= $",
    );
    expect(sql).toContain(
      "COALESCE(cr.round_date, (c.cycle_anchor_at AT TIME ZONE 'Asia/Seoul')::date) <= $",
    );
    // 종전 반열림 상한은 사라진다.
    expect(sql).not.toContain("c.cycle_anchor_at < (((");
    // 판정용 열로 실려 나간다.
    expect(sql).toContain("AS round_date");
    // 상관 서브쿼리 금지(§5) — **파생 표 본문**이 바깥 별칭(`c.`)을 참조하지 않는다.
    const derived = flat.slice(
      flat.indexOf("SELECT ca.cycle_id"),
      flat.indexOf(") cr ON"),
    );
    expect(derived).not.toMatch(/\bc\./);
    expect(sql).not.toContain("hmg_round_date_of");
  });

  it("기간이 없으면 조인은 붙되 경계 술어는 안 붙는다", async () => {
    await pickCyclesInRange({ surface: "website", projectIds: [P1], anchorAxis: true });
    expect(last()).toContain("scope_answer_cycle_anchors ca");
    expect(last()).not.toContain(">= $");
  });

  it("행 매핑 — `round_date` 가 오면 실리고, 없으면 필드 자체가 없다", async () => {
    const base = {
      cycle_id: "c-1",
      generation_id: "g-1",
      project_id: ROOT,
      cycle_anchor_at: "2026-09-10T22:35:00.000Z",
      cycle_week: "2026-09-07",
      status: "published",
      renderable: true,
      pending: false,
      analysis_gap_ratio: "0",
      expected_units: 10,
      completed_units: 10,
      hidden: false,
      hidden_scope: "all",
      fleet_visible: true,
    };
    rows = [{ ...base, round_date: "2026-09-07" }];
    const on = await pickCyclesInRange({ surface: "global", projectIds: [ROOT], anchorAxis: true });
    expect(on?.[0]?.roundDate).toBe("2026-09-07");

    rows = [base];
    const off = await pickCyclesInRange({ surface: "global", projectIds: [ROOT] });
    expect(off?.[0] && "roundDate" in off[0]).toBe(false);
  });
});

describe("스냅샷 픽 — 같은 계약", () => {
  it("pickGlobalCycle: 꺼짐 = 종전 문장 / 켜짐 = 귀속 날짜를 싣는다", async () => {
    rows = [];
    await pickGlobalCycle(ROOT);
    expect(last()).not.toContain("scope_answer_cycle_anchors");

    await pickGlobalCycle(ROOT, { anchorAxis: true });
    expect(last()).toContain("scope_answer_cycle_anchors ca");
    expect(last()).toContain("cr.cycle_id = c.cycle_id");
    expect(last()).toContain("AS round_date");
    // 선택 자체는 안 바뀐다 — 주를 고르는 1단 CTE 는 종전 그대로다.
    expect(last()).toContain("ORDER BY w.cycle_anchor_at DESC");
  });

  it("pickWebsiteCycles: 꺼짐 = 종전 문장 / 켜짐 = 귀속 날짜를 싣는다", async () => {
    rows = [];
    await pickWebsiteCycles([P1]);
    expect(last()).not.toContain("scope_answer_cycle_anchors");

    await pickWebsiteCycles([P1], { anchorAxis: true });
    expect(last()).toContain("scope_answer_cycle_anchors ca");
    expect(last()).toContain("cr.cycle_id = c.cycle_id");
    expect(last()).toContain("AS round_date");
    // 함대 주 선택(`max(cycle_week)`)은 축과 무관하다 — 파티션 키이기 때문이다.
    expect(last()).toContain("c.cycle_week = wk.w");
  });
});
