import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  SummaryCyclePick,
  CycleRangeRow,
  WebsiteCyclePickResult,
  CycleRangeQuery,
} from "@/lib/db/repositories/summary-cycles";

// 회차 집합 판정 — PR② T9 / 플랜 §6-3.
//
// 여기서 고정하는 것은 셋이다:
//   ① 스냅샷 모드가 PR② 이전과 **같은 판정**을 낸다(회귀 그물).
//   ② 기간 모드의 폴백 사유가 서로 구분되고, 판정 불가는 폴백이다(fail-closed).
//   ③ `open` 회차가 구멍이 **아니다** — 이걸 구멍으로 세면 종전 `newer-runs` 처럼
//      상시 폴백이 된다(2026-09-09 회귀의 재발 방지).
// DB 는 보지 않는다: 리포지터리 세 함수를 모킹하고 판정만 본다.

const pickWebsiteCycles = vi.fn<[string[]], Promise<WebsiteCyclePickResult | null>>();
const pickGlobalCycle = vi.fn<[string], Promise<SummaryCyclePick | null>>();
const pickCyclesInRange = vi.fn<[CycleRangeQuery], Promise<CycleRangeRow[] | null>>();

vi.mock("@/lib/db/repositories/summary-cycles", () => ({
  pickWebsiteCycles: (ids: string[]) => pickWebsiteCycles(ids),
  pickGlobalCycle: (root: string) => pickGlobalCycle(root),
  pickCyclesInRange: (q: CycleRangeQuery) => pickCyclesInRange(q),
}));

const { resolveCycleSet, judgeCycleRange, dateRangeReason, isGeneratorSkipped, generatorPicksGap } =
  await import("./cycle-set");
const { ANALYSIS_GAP_MAX } = await import("./analysis-gap");

const P1 = "11111111-1111-1111-1111-111111111111";
const P2 = "22222222-2222-2222-2222-222222222222";
const ROOT = "be28fe15-c743-4a88-abb8-182b25602812";

const pick = (over: Partial<SummaryCyclePick> = {}): SummaryCyclePick => ({
  cycleId: "aaaaaaaa-0000-0000-0000-000000000001",
  generationId: "bbbbbbbb-0000-0000-0000-000000000001",
  projectId: P1,
  cycleAnchorAt: "2026-09-04T00:00:00.000Z",
  cycleWeek: "2026-08-31",
  ...over,
});

const row = (over: Partial<CycleRangeRow> = {}): CycleRangeRow => ({
  cycleId: "aaaaaaaa-0000-0000-0000-000000000001",
  generationId: "bbbbbbbb-0000-0000-0000-000000000001",
  projectId: P1,
  cycleAnchorAt: "2026-09-04T00:00:00.000Z",
  cycleWeek: "2026-08-31",
  status: "published",
  renderable: true,
  pending: false,
  analysisGapRatio: 0,
  expectedUnits: 100,
  completedUnits: 100,
  hidden: false,
  // 0071 범위 — 원장 NULL·0071 미적용은 리포지터리가 `all` 로 접어 준다(종전 동작).
  hiddenScope: "all",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  pickWebsiteCycles.mockResolvedValue({ cycles: [pick()], missingProjectIds: [] });
  pickGlobalCycle.mockResolvedValue(pick({ projectId: ROOT, cycleAnchorAt: "2026-08-31T00:00:00.000Z" }));
  pickCyclesInRange.mockResolvedValue([row()]);
});

const reasonOf = (r: Awaited<ReturnType<typeof resolveCycleSet>>): string =>
  r.ok ? "(ok)" : r.reason;

// ── 스냅샷: 종전 판정 그대로 ────────────────────────────────────────────────
describe("resolveCycleSet — snapshot", () => {
  it("글로벌은 회차 1개, 기간 조회를 쓰지 않는다", async () => {
    const r = await resolveCycleSet({ surface: "global", mode: "snapshot", projectIds: [ROOT] });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.set.cycles).toHaveLength(1);
    expect(r.set.mode).toBe("snapshot");
    expect(r.set.anchorCount).toBe(1);
    expect(r.set.weeks).toEqual(["2026-08-31"]);
    expect(r.set.projectIds).toEqual([ROOT]);
    // 스냅샷 경로는 범위 조회를 **부르지 않는다**(DB 왕복이 늘면 안 된다).
    expect(pickCyclesInRange).not.toHaveBeenCalled();
  });

  it("회차가 없으면 표면별 종전 사유", async () => {
    pickGlobalCycle.mockResolvedValue(null);
    expect(reasonOf(await resolveCycleSet({ surface: "global", mode: "snapshot", projectIds: [ROOT] }))).toBe(
      "missing-cycle",
    );
    pickWebsiteCycles.mockResolvedValue(null);
    expect(reasonOf(await resolveCycleSet({ surface: "website", mode: "snapshot", projectIds: [P1] }))).toBe(
      "missing-cycles",
    );
  });

  it("기간이 회차 하나로 안 떨어지면 종전 사유 그대로", async () => {
    expect(
      reasonOf(
        await resolveCycleSet({
          surface: "global",
          mode: "snapshot",
          projectIds: [ROOT],
          dateFrom: "2026-09-01",
          dateTo: "2026-09-06",
        }),
      ),
    ).toBe("range-outside-cycle");

    pickWebsiteCycles.mockResolvedValue({
      cycles: [pick(), pick({ projectId: P2, cycleAnchorAt: "2026-09-05T00:00:00.000Z" })],
      missingProjectIds: [],
    });
    expect(
      reasonOf(
        await resolveCycleSet({
          surface: "website",
          mode: "snapshot",
          projectIds: [P1, P2],
          dateFrom: "2026-09-01",
          dateTo: "2026-09-06",
        }),
      ),
    ).toBe("range-multi-cycle");
  });

  it("모수가 비면 판정 자체를 하지 않는다(표면별 사유)", async () => {
    expect(reasonOf(await resolveCycleSet({ surface: "website", mode: "snapshot", projectIds: [] }))).toBe(
      "missing-cycles",
    );
    expect(pickWebsiteCycles).not.toHaveBeenCalled();
  });
});

// ── 기간: §6-3 판정 ────────────────────────────────────────────────────────
describe("resolveCycleSet — period (§6-3)", () => {
  it("범위 안 published 회차를 전부 모은다 — 상한 없음(운영 D-2 (2))", async () => {
    // 13주 × 2 프로젝트 = 26 회차. 상한에 걸리지 않는다.
    const rows: CycleRangeRow[] = [];
    for (let w = 0; w < 13; w += 1) {
      const day = String(1 + w).padStart(2, "0");
      for (const p of [P1, P2]) {
        rows.push(
          row({
            cycleId: `aaaaaaaa-0000-0000-0000-0000000${String(w).padStart(2, "0")}${p === P1 ? 1 : 2}`,
            projectId: p,
            cycleAnchorAt: `2026-06-${day}T00:00:00.000Z`,
            cycleWeek: `2026-06-${day}`,
          }),
        );
      }
    }
    pickCyclesInRange.mockResolvedValue(rows);
    const r = await resolveCycleSet({
      surface: "website",
      mode: "period",
      projectIds: [P1, P2],
      dateFrom: "2026-06-01",
      dateTo: "2026-06-13",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.set.cycles).toHaveLength(26);
    expect(r.set.anchorCount).toBe(13);
    expect(r.set.weeks).toHaveLength(13);
    // 주 목록은 정렬돼 있다(파티션 술어가 안정적이어야 계획이 재사용된다).
    expect(r.set.weeks).toEqual([...r.set.weeks].sort());
  });

  it("(a′) 판정 불가는 폴백 — cycle-set-unavailable (fail-closed)", async () => {
    pickCyclesInRange.mockResolvedValue(null);
    expect(
      reasonOf(await resolveCycleSet({ surface: "global", mode: "period", projectIds: [ROOT] })),
    ).toBe("cycle-set-unavailable");
  });

  // ⚠️ `generating` 은 2026-09-11(F4)에 이 목록에서 **빠졌다** — 아래 전용 케이스 참고.
  it("(b) 범위 안에 노출 불가 회차가 섞이면 unpublished-cycle-in-range", async () => {
    for (const status of ["closed", "stale"]) {
      pickCyclesInRange.mockResolvedValue([
        row(),
        row({ cycleId: "cccc", generationId: null, status, renderable: false }),
      ]);
      expect(
        reasonOf(await resolveCycleSet({ surface: "global", mode: "period", projectIds: [ROOT] })),
      ).toBe("unpublished-cycle-in-range");
    }
  });

  it("⚠️ `generating` 도 구멍이 아니다 — 재생성 스왑 전 순간의 플랩 방지(F4)", async () => {
    pickCyclesInRange.mockResolvedValue([
      row(),
      row({ cycleId: "cccc", generationId: null, status: "generating", renderable: false }),
    ]);
    const r = await resolveCycleSet({ surface: "global", mode: "period", projectIds: [ROOT] });
    expect(reasonOf(r)).toBe("(ok)");
  });

  it("⚠️ `open` 회차는 구멍이 아니다 — 이걸 폴백으로 삼으면 상시 폴백이 된다", async () => {
    pickCyclesInRange.mockResolvedValue([
      row(),
      row({ cycleId: "dddd", generationId: null, status: "open", renderable: false }),
    ]);
    const r = await resolveCycleSet({ surface: "global", mode: "period", projectIds: [ROOT] });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    // 열린 회차는 **집합에도 안 들어간다** — 데이터가 없으므로.
    expect(r.set.cycles).toHaveLength(1);
  });

  it("⚠️ V-2 `pending`(아직 노출일 전) 회차도 구멍이 아니다 — 직전 회차만 낸다", async () => {
    // V-1 이 켜지면 새 회차는 생성 직후 1~2일간 `published` + `view_anchor_at > now()` 다.
    // 이것을 구멍으로 세면 **회차마다 지연 기간 내내 전 화면이 폴백**한다(`newer-runs` 재현).
    pickCyclesInRange.mockResolvedValue([
      row(),
      row({
        cycleId: "eeee",
        generationId: "ffff",
        status: "published",
        renderable: false,
        pending: true,
      }),
    ]);
    const r = await resolveCycleSet({ surface: "global", mode: "period", projectIds: [ROOT] });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    // 금족 회차는 집합에 **안 들어간다** — 직전 회차만 남는다.
    expect(r.set.cycles).toHaveLength(1);
    expect(r.set.cycles[0]?.cycleId).toBe("aaaaaaaa-0000-0000-0000-000000000001");
  });

  it("금족 회차 하나뿐이면 낼 것이 없다 — missing-cycles-in-range", async () => {
    pickCyclesInRange.mockResolvedValue([
      row({ cycleId: "eeee", generationId: "ffff", renderable: false, pending: true }),
    ]);
    expect(
      reasonOf(await resolveCycleSet({ surface: "global", mode: "period", projectIds: [ROOT] })),
    ).toBe("missing-cycles-in-range");
  });

  it("pending 이 아닌 비-published 는 여전히 구멍이다 (금족 예외가 넓어지지 않았다)", async () => {
    pickCyclesInRange.mockResolvedValue([
      row(),
      row({ cycleId: "cccc", generationId: null, status: "stale", renderable: false, pending: false }),
    ]);
    expect(
      reasonOf(await resolveCycleSet({ surface: "global", mode: "period", projectIds: [ROOT] })),
    ).toBe("unpublished-cycle-in-range");
  });

  it("(c) 웹사이트: 같은 (project, week) 회차 둘 이상이면 duplicate-cycle-in-week", async () => {
    pickCyclesInRange.mockResolvedValue([
      row(),
      row({ cycleId: "eeee", cycleAnchorAt: "2026-09-05T00:00:00.000Z" }), // 같은 주·같은 프로젝트
    ]);
    expect(
      reasonOf(await resolveCycleSet({ surface: "website", mode: "period", projectIds: [P1] })),
    ).toBe("duplicate-cycle-in-week");
  });

  it("(c) 글로벌은 같은 주 회차 둘을 허용한다 — 함대 규칙(§6-1 1)이 아니다", async () => {
    pickCyclesInRange.mockResolvedValue([
      row({ projectId: ROOT }),
      row({ cycleId: "ffff", projectId: ROOT, cycleAnchorAt: "2026-09-05T00:00:00.000Z" }),
    ]);
    const r = await resolveCycleSet({ surface: "global", mode: "period", projectIds: [ROOT] });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.set.cycles).toHaveLength(2);
    expect(r.set.anchorCount).toBe(2);
  });

  it("범위에 노출 가능 회차가 0개면 missing-cycles-in-range", async () => {
    pickCyclesInRange.mockResolvedValue([]);
    expect(
      reasonOf(await resolveCycleSet({ surface: "website", mode: "period", projectIds: [P1] })),
    ).toBe("missing-cycles-in-range");
  });

  it("회차가 없는 프로젝트는 제외되고 목록으로 남는다 (메우지 않는다)", async () => {
    pickCyclesInRange.mockResolvedValue([row()]);
    const r = await resolveCycleSet({
      surface: "website",
      mode: "period",
      projectIds: [P1, P2],
    });
    if (!r.ok) throw new Error("expected ok");
    expect(r.set.projectIds).toEqual([P1]);
    expect(r.set.missingProjectIds).toEqual([P2]);
  });

  it("기간 모드는 dateRangeReason 을 적용하지 않는다 — 회차가 여럿인 것이 정의다", async () => {
    pickCyclesInRange.mockResolvedValue([
      row(),
      row({ cycleId: "gggg", projectId: P2, cycleAnchorAt: "2026-09-11T00:00:00.000Z", cycleWeek: "2026-09-07" }),
    ]);
    const r = await resolveCycleSet({
      surface: "website",
      mode: "period",
      projectIds: [P1, P2],
      dateFrom: "2026-09-01",
      dateTo: "2026-09-14",
    });
    expect(r.ok).toBe(true);
  });

  it("범위를 리포지터리에 그대로 넘긴다(표면·모수 포함)", async () => {
    await resolveCycleSet({
      surface: "website",
      mode: "period",
      projectIds: [P1, P2],
      dateFrom: "2026-06-01",
      dateTo: "2026-09-01",
    });
    expect(pickCyclesInRange).toHaveBeenCalledWith({
      surface: "website",
      projectIds: [P1, P2],
      dateFrom: "2026-06-01",
      dateTo: "2026-09-01",
    });
  });
});

// ── 순수 판정 (DB 없이) ────────────────────────────────────────────────────
describe("judgeCycleRange — 순수 함수", () => {
  it("generationId 가 비면 회차로 승격하지 않는다 (renderable 이어도)", () => {
    const r = judgeCycleRange("global", [ROOT], [row({ generationId: null, renderable: true })]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected fail");
    expect(r.reason).toBe("missing-cycles-in-range");
  });

  it("구멍 판정이 빈 집합 판정보다 먼저다 — 사유가 더 정확하다", () => {
    const r = judgeCycleRange("global", [ROOT], [row({ generationId: null, status: "closed", renderable: false })]);
    if (r.ok) throw new Error("expected fail");
    expect(r.reason).toBe("unpublished-cycle-in-range");
  });
});

// ── F1: "구멍이 아닌 것" 두 가지가 더 있다 (2026-09-11) ─────────────────────
//
// 라이브 실측이 이 수리의 근거다: 글로벌 91일 창 안 `active_generation_id IS NULL` 이
// 5회차(7/07·7/11·7/19·7/24·8/25)인데 **전부 `closed` + 분석 갭 > 5%** 라 생성기가
// `--pending` 에서 영원히 안 뽑는다. 구멍으로 세면 글로벌 추이가 scope 분석 백필이
// 오기 전까지 **영구히** 미러다.
describe("judgeCycleRange — F1 구멍 면제(generating · skipped)", () => {
  const ok = (r: ReturnType<typeof judgeCycleRange>) => {
    if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
    return r.set;
  };
  const missing = (over: Partial<CycleRangeRow>) =>
    row({ generationId: null, renderable: false, ...over });
  const good = (n: number) =>
    row({
      cycleId: `aaaaaaaa-0000-0000-0000-00000000000${n}`,
      generationId: `bbbbbbbb-0000-0000-0000-00000000000${n}`,
      cycleAnchorAt: `2026-08-0${n}T00:00:00.000Z`,
      cycleWeek: `2026-08-0${n}`,
    });

  it("생성기 게이트 밖(closed + 갭 > 임계)은 구멍이 아니라 **창에서 제외**된다", () => {
    const set = ok(judgeCycleRange("global", [ROOT], [
      good(1), good(2),
      missing({ cycleId: "cccccccc-0000-0000-0000-000000000001", status: "closed", analysisGapRatio: 0.31 }),
    ]));
    // 점 개수 = **발행 회차 수**. 제외된 앵커는 점이 없다.
    expect(set.cycles).toHaveLength(2);
    expect(set.skippedCount).toBe(1);
  });

  it("갭이 임계 **이하**인 미생성 closed 는 여전히 구멍이다(백필 대기)", () => {
    const r = judgeCycleRange("global", [ROOT], [
      good(1), good(2),
      missing({ cycleId: "cccccccc-0000-0000-0000-000000000002", status: "closed", analysisGapRatio: 0.01 }),
    ]);
    if (r.ok) throw new Error("expected fail");
    expect(r.reason).toBe("unpublished-cycle-in-range");
  });

  // ⚠️ 초판은 "갭을 모르면 구멍"(fail-closed)이었다. **방향을 바꿨다**(2026-09-11):
  //    `NULL <= 0.05` 는 SQL 에서 UNKNOWN 이라 생성기가 **영원히 안 뽑는다** — 구멍으로
  //    세면 그 회차 하나 때문에 표면이 영구 미러다(웹 실측 36건). 근거는 리더 주석.
  it("갭을 **모르면**(null) 생성기가 못 뽑는다 → 구멍이 아니라 제외", () => {
    const set = ok(judgeCycleRange("global", [ROOT], [
      good(1), good(2),
      missing({ cycleId: "cccccccc-0000-0000-0000-000000000003", status: "closed", analysisGapRatio: null }),
    ]));
    expect(set.cycles).toHaveLength(2);
    expect(set.skippedCount).toBe(1);
  });

  // ⚠️ **경계**: 정확히 임계값이면 생성기의 `<= gapMax` 가 참이라 **뽑을 대상**이다.
  //    따라서 읽기에서는 구멍이어야 한다. `>` 를 `>=` 로 뒤집으면 곧 생성될 회차를
  //    조용히 창에서 빼는 fail-open 이 되는데, 픽스처에 정확히 0.05 가 없어서 그
  //    뮤테이션이 `lib/summary/read` 110건을 통과했다(2026-09-11 게이트 재검).
  it("갭이 임계와 **정확히 같으면** 구멍이다(생성기가 뽑을 대상)", () => {
    const r = judgeCycleRange("global", [ROOT], [
      good(1),
      missing({
        cycleId: "cccccccc-0000-0000-0000-000000000006",
        status: "closed",
        analysisGapRatio: ANALYSIS_GAP_MAX,
      }),
    ]);
    if (r.ok) throw new Error("expected fail");
    expect(r.reason).toBe("unpublished-cycle-in-range");
  });

  it("임계보다 아주 조금만 커도 제외된다(경계의 반대편)", () => {
    const set = ok(judgeCycleRange("global", [ROOT], [
      good(1), good(2),
      missing({
        cycleId: "cccccccc-0000-0000-0000-000000000007",
        status: "closed",
        analysisGapRatio: ANALYSIS_GAP_MAX + 1e-9,
      }),
    ]));
    expect(set.skippedCount).toBe(1);
  });

  // 유령 회차 — 관제가 멤버 0 으로 열고 즉시 닫았다. 갭이 NULL 이라 생성기 술어가
  // 3값 논리로 영원히 거짓이므로 백필이 와도 안 뽑힌다(라이브 실측 웹 2026-07-20 1건).
  it("갭 null + 멤버 0(유령 회차)은 제외된다 — 백필로도 안 풀린다", () => {
    const set = ok(judgeCycleRange("global", [ROOT], [
      good(1), good(2),
      missing({
        cycleId: "cccccccc-0000-0000-0000-000000000008",
        status: "closed",
        analysisGapRatio: null,
        expectedUnits: null,
        completedUnits: 0,
      }),
    ]));
    expect(set.cycles).toHaveLength(2);
    expect(set.skippedCount).toBe(1);
  });

  // 실측 36건(앵커 7/20·8/17·8/18·8/19)은 `completed_units` 가 **0 이 아니라 NULL** 이라
  // 종전 `completed_units = 0` 특례로는 안 잡혔다. 멤버 유무와 무관하게 갭이 `NULL` 이면
  // 생성기가 못 뽑으므로 제외다 — 특례가 아니라 여집합 하나로 흡수했다.
  it("갭 null 이면 **멤버 유무와 무관하게** 제외된다(유령 특례 흡수)", () => {
    for (const units of [
      { expectedUnits: null, completedUnits: null }, // 실측 36건의 형태
      { expectedUnits: null, completedUnits: 0 },
      { expectedUnits: 12, completedUnits: 0 },
      { expectedUnits: null, completedUnits: 3 },
    ]) {
      const set = ok(judgeCycleRange("global", [ROOT], [
        good(1), good(2),
        missing({
          cycleId: "cccccccc-0000-0000-0000-000000000009",
          status: "closed",
          analysisGapRatio: null,
          ...units,
        }),
      ]));
      expect(set.skippedCount, JSON.stringify(units)).toBe(1);
    }
  });

  // 두 술어가 **같은 명제**임을 값 표로 못 박는다. 한쪽만 고치면 여기서 걸린다.
  it("`--pending` 갭 술어와 **정확한 여집합**이다(같은 상수·같은 비교식)", () => {
    const gaps = [null, 0, 0.01, ANALYSIS_GAP_MAX - 1e-9, ANALYSIS_GAP_MAX,
      ANALYSIS_GAP_MAX + 1e-9, 0.31, 1];
    for (const gap of gaps) {
      const picked = generatorPicksGap(gap);
      const skipped = isGeneratorSkipped(
        missing({ cycleId: "cccccccc-0000-0000-0000-00000000000a", status: "closed", analysisGapRatio: gap }),
      );
      expect(skipped, `gap=${gap}`).toBe(!picked);
    }
    // 3VL — `NULL <= x` 는 참이 아니다(SQL `WHERE` 가 UNKNOWN 을 버리는 것과 같다).
    expect(generatorPicksGap(null)).toBe(false);
  });

  it("`generating` 은 면제 — 재생성 중 스왑 전 순간이 전 화면을 플랩시키면 안 된다(F4)", () => {
    const set = ok(judgeCycleRange("global", [ROOT], [
      good(1), good(2),
      missing({ cycleId: "cccccccc-0000-0000-0000-000000000004", status: "generating", analysisGapRatio: 0.01 }),
    ]));
    expect(set.cycles).toHaveLength(2);
    // `generating` 은 곧 돌아올 회차이지 **미발행 확정**이 아니다 — skipped 로 세지 않는다.
    expect(set.skippedCount).toBe(0);
  });

  it("closed+갭초과만 있는 창은 **빈 집합**이지 구멍이 아니다", () => {
    const r = judgeCycleRange("global", [ROOT], [
      missing({ cycleId: "cccccccc-0000-0000-0000-000000000005", status: "closed", analysisGapRatio: 0.4 }),
    ]);
    if (r.ok) throw new Error("expected fail");
    expect(r.reason).toBe("missing-cycles-in-range");
  });

  it("`renderable` 인 회차는 갭이 커도 제외되지 않는다(이미 발행됐다)", () => {
    const set = ok(judgeCycleRange("global", [ROOT], [
      row({ analysisGapRatio: 0.9 }),
    ]));
    expect(set.cycles).toHaveLength(1);
    expect(set.skippedCount).toBe(0);
  });
});

describe("dateRangeReason", () => {
  it("기간 미지정은 항상 통과", () => {
    expect(dateRangeReason({}, [pick()])).toBeNull();
  });
  it("경계일 포함", () => {
    expect(dateRangeReason({ dateFrom: "2026-09-04", dateTo: "2026-09-04" }, [pick()])).toBeNull();
  });
  it("null 도 미지정과 같다(리포지터리 계약이 null 을 쓴다)", () => {
    expect(dateRangeReason({ dateFrom: null, dateTo: null }, [pick()])).toBeNull();
  });
});

// ── 원장 숨김(0070) — **구멍이 아니라 skipped** ─────────────────────────────
//
// 숨김이 구멍으로 세어지면 그 창의 기간 조회가 통째로 미러로 떨어진다 = 숨김이
// 되살리려던 골짜기가 그대로 돌아온다(목적과 정반대). 그래서 판정이 여기 고정된다.
describe("원장 숨김", () => {
  it("숨긴 회차는 창에서 빠지고 나머지로 집합이 선다 — 폴백하지 않는다", async () => {
    pickCyclesInRange.mockResolvedValue([
      row({ cycleId: "aaaaaaaa-0000-0000-0000-00000000000a", cycleWeek: "2026-08-17" }),
      row({ cycleId: "aaaaaaaa-0000-0000-0000-00000000000b", cycleWeek: "2026-08-24", hidden: true }),
      row({ cycleId: "aaaaaaaa-0000-0000-0000-00000000000c", cycleWeek: "2026-08-31" }),
    ]);
    const r = await resolveCycleSet({ surface: "global", mode: "period", projectIds: [ROOT] });
    expect(reasonOf(r)).toBe("(ok)");
    if (!r.ok) return;
    expect(r.set.cycles.map((c) => c.cycleWeek)).toEqual(["2026-08-17", "2026-08-31"]);
    // 관측 — 창에서 뺀 수에 들어간다(`hit` 인데 점이 적은 이유가 헤더에 남는다).
    expect(r.set.skippedCount).toBe(1);
  });

  it("`renderable=true` 여도 뺀다 — 숨김은 노출 가능성과 직교한다", async () => {
    pickCyclesInRange.mockResolvedValue([
      row({ cycleId: "aaaaaaaa-0000-0000-0000-00000000000a", cycleWeek: "2026-08-17" }),
      row({
        cycleId: "aaaaaaaa-0000-0000-0000-00000000000b",
        cycleWeek: "2026-08-24",
        hidden: true,
        renderable: true,
        status: "published",
        analysisGapRatio: 0,
      }),
    ]);
    const r = await resolveCycleSet({ surface: "global", mode: "period", projectIds: [ROOT] });
    expect(reasonOf(r)).toBe("(ok)");
    if (!r.ok) return;
    expect(r.set.cycles).toHaveLength(1);
  });

  it("숨김이 창의 전부면 빈 집합 — 조용히 0 을 그리지 않는다", async () => {
    pickCyclesInRange.mockResolvedValue([row({ hidden: true })]);
    const r = await resolveCycleSet({ surface: "global", mode: "period", projectIds: [ROOT] });
    expect(reasonOf(r)).toBe("missing-cycles-in-range");
  });

  it("웹사이트 주 중복 판정은 숨긴 회차를 세지 않는다", async () => {
    // 같은 (project, week) 에 둘인데 하나가 숨김이면 규칙 위반이 아니다.
    pickCyclesInRange.mockResolvedValue([
      row({ cycleId: "aaaaaaaa-0000-0000-0000-00000000000a", cycleWeek: "2026-08-24", hidden: true }),
      row({ cycleId: "aaaaaaaa-0000-0000-0000-00000000000b", cycleWeek: "2026-08-24" }),
      row({ cycleId: "aaaaaaaa-0000-0000-0000-00000000000c", cycleWeek: "2026-08-31" }),
    ]);
    const r = await resolveCycleSet({ surface: "website", mode: "period", projectIds: [P1] });
    expect(reasonOf(r)).toBe("(ok)");
  });
});

// ── 숨김 **범위**(0071 hidden_scope) — period 집합만 계열화한다 (D2 §3-A1) ───
//
// 8/25 글로벌 회차는 인용만 깨졌다(chatgpt 인용률 3.8% vs 언급 83.8%). 그 회차를 사실표로
// 생성해도 `hidden_reason` 은 살아 있으므로, 판정이 `hidden` 하나만 보면 창에서 계속 빠져
// **오버뷰 언급 4 KPI 가 영원히 빈 채**로 남는다. 그래서 판정을 둘로 가른다:
//
//   면제(exempt)  = hidden || isGeneratorSkipped   → holes 에서 뺀다. **범위 무관**.
//   배제(blocked) = hidden && scope !== "citations" → usable 에서 뺀다.
//
// ⚠️ 이 describe 가 잡는 뮤테이션: `blocked` 를 `r.hidden` 으로 되돌리면 첫 두 케이스가
//    깨진다(= 8/25 언급 값이 다시 사라진다).
describe("judgeCycleRange — 숨김 범위(0071/D2)", () => {
  const ok = (r: ReturnType<typeof judgeCycleRange>) => {
    if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
    return r.set;
  };
  const other = row({
    cycleId: "aaaaaaaa-0000-0000-0000-0000000000f1",
    generationId: "bbbbbbbb-0000-0000-0000-0000000000f1",
    cycleAnchorAt: "2026-08-18T00:00:00.000Z",
    cycleWeek: "2026-08-17",
  });
  /** 8/25 회차 — 숨김이지만 범위가 인용뿐이고, 사실표 생성이 끝나 renderable 이다. */
  const citations = (over: Partial<CycleRangeRow> = {}) =>
    row({
      cycleId: "1045851c-e47d-4977-bda1-550c56d74705",
      generationId: "bbbbbbbb-0000-0000-0000-0000000000f2",
      cycleAnchorAt: "2026-08-25T12:50:33.000Z",
      cycleWeek: "2026-08-24",
      status: "published",
      renderable: true,
      hidden: true,
      hiddenScope: "citations",
      // 원장 실측 — 갭 9.3% 는 ANALYSIS_GAP_MAX(5%)를 넘어 생성기가 --pending 에서 안 뽑는다.
      analysisGapRatio: 0.09298,
      ...over,
    });

  it("citations + renderable 은 **집합에 든다** — 언급 4 KPI 가 실값으로 나오는 근거", () => {
    const set = ok(judgeCycleRange("global", [ROOT], [other, citations()]));
    expect(set.cycles.map((c) => c.cycleWeek)).toEqual(["2026-08-17", "2026-08-24"]);
    // 회차 수가 +1 된다(관측 헤더 `cycles:<n>` · G_TREND_MIN_CYCLES 하한과 같은 축).
    expect(set.anchorCount).toBe(2);
  });

  it("all 은 종전대로 빠진다 — 반쪽이 아니라 통째로 틀린 회차다", () => {
    const set = ok(judgeCycleRange("global", [ROOT], [other, citations({ hiddenScope: "all" })]));
    expect(set.cycles).toHaveLength(1);
    expect(set.cycles[0].cycleWeek).toBe("2026-08-17");
  });

  it("집합에 든 citations 회차는 skippedCount 에 **안** 잡힌다(이중 계산 금지)", () => {
    const set = ok(judgeCycleRange("global", [ROOT], [other, citations()]));
    expect(set.skippedCount).toBe(0);
    // 같은 회차가 all 이면 그때는 세어진다.
    expect(ok(judgeCycleRange("global", [ROOT], [other, citations({ hiddenScope: "all" })])).skippedCount)
      .toBe(1);
  });

  it("**미생성** citations 는 구멍이 아니다 — 면제는 범위를 안 본다", () => {
    // 코드가 먼저 배포되고 생성(U-B)이 아직인 상태. 폴백을 만들면 그 창이 통째로 미러다.
    const set = ok(
      judgeCycleRange("global", [ROOT], [
        other,
        citations({ generationId: null, renderable: false, status: "closed" }),
      ]),
    );
    expect(set.cycles).toHaveLength(1);
    expect(set.skippedCount).toBe(1);
  });

  it("범위를 **모르면** 배제한다(fail-closed) — test·scripts 는 tsc 밖이라 undefined 가 올 수 있다", () => {
    const unknown = { ...citations(), hiddenScope: undefined } as unknown as CycleRangeRow;
    const set = ok(judgeCycleRange("global", [ROOT], [other, unknown]));
    expect(set.cycles).toHaveLength(1);
  });

  it("숨김이 아니면 범위는 아무 일도 안 한다", () => {
    const set = ok(
      judgeCycleRange("global", [ROOT], [other, citations({ hidden: false, hiddenScope: "all" })]),
    );
    expect(set.cycles).toHaveLength(2);
    expect(set.skippedCount).toBe(0);
  });
});
