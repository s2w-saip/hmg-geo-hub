import { describe, it, expect } from "vitest";
import {
  citationCyclesOf,
  restrictToCompleteCycles,
  restrictToFleetVisible,
  restrictToSlotRepresentative,
  restrictToTrendSlotSet,
  trendGridApplied,
  type CycleSet,
} from "./cycle-set";
import type { SummaryCyclePick } from "@/lib/db/repositories/summary-cycles";
import { slotIsIncomplete } from "./cycle-completion";

// ── 한 자리 두 회차 → **대표 하나** (설계 §6 D4 리더 단 판본, 제품 결정 ②) ────
//
// 왜 이 규칙이 필요한가: 08-24 자리(앵커 08-18 정상 + 앵커 08-25 인용 숨김)에서
// 사실표는 `toSeries` 의 `byDay` 로 **합산**(분모 18,662)하고 미러는 자리 단위
// `DISTINCT ON` 으로 **대표 1건**(9,652)이다. 계약 §3 의 "회차 간 합산" 은 기간 안에
// 자리가 여럿일 때의 규칙이고, 한 자리 안의 규칙은 앵커 스펙 §9.2("한 자리 = 한 회차")
// 다 — 즉 미러가 맞고 사실표가 이중 계상이다.
//
// 고정하는 것 넷:
//   ① 자리마다 회차가 하나만 남고 대표는 **늦은 앵커**다.
//   ② 파생값(cycleKey·weeks·anchorCount)이 거른 뒤 집합으로 다시 선다.
//   ③ 격자가 꺼져 있으면(= `completionRatio` 미탑재) **같은 객체**다(캐시 키 불변).
//   ④ 자리가 전부 단일 회차면 **같은 객체**다(합친 자리가 없으면 아무 일도 없다).

const ROOT = "be28fe15-c743-4a88-abb8-182b25602812";

const pick = (over: Partial<SummaryCyclePick>): SummaryCyclePick =>
  ({
    cycleId: "c1",
    generationId: "g1",
    projectId: ROOT,
    cycleAnchorAt: "2026-08-18T15:48:00.000Z",
    cycleWeek: "2026-08-17",
    roundDate: "2026-08-24",
    completionRatio: 1,
    ...over,
  }) as unknown as SummaryCyclePick;

const setOf = (cycles: SummaryCyclePick[]): CycleSet => ({
  surface: "global",
  mode: "period",
  cycles,
  cycleKey: cycles.map((c) => `${c.cycleId}:${c.generationId}`).sort().join(","),
  projectIds: [ROOT],
  missingProjectIds: [],
  weeks: [...new Set(cycles.map((c) => c.cycleWeek))],
  anchorCount: new Set(cycles.map((c) => c.roundDate)).size,
});

describe("① 자리마다 대표 하나 — 늦은 앵커", () => {
  const merged = setOf([
    pick({ cycleId: "early", generationId: "ge", cycleAnchorAt: "2026-08-18T15:48:00.000Z" }),
    pick({ cycleId: "late", generationId: "gl", cycleAnchorAt: "2026-08-25T15:48:00.000Z" }),
  ]);

  it("늦은 앵커가 남는다", () => {
    const { set } = restrictToSlotRepresentative(merged);
    expect(set.cycles.map((c) => c.cycleId)).toEqual(["late"]);
  });

  it("합친 자리의 키를 보고한다 (관측용)", () => {
    expect(restrictToSlotRepresentative(merged).mergedSlots).toEqual(["2026-08-24"]);
  });

  it("앵커가 같으면 `cycleId` 사전식 최대 — 결정적이다", () => {
    const tie = setOf([
      pick({ cycleId: "aaa", generationId: "g1" }),
      pick({ cycleId: "zzz", generationId: "g2" }),
    ]);
    expect(restrictToSlotRepresentative(tie).set.cycles.map((c) => c.cycleId)).toEqual(["zzz"]);
    // 입력 순서를 뒤집어도 같은 답이어야 한다.
    const flipped = setOf([
      pick({ cycleId: "zzz", generationId: "g2" }),
      pick({ cycleId: "aaa", generationId: "g1" }),
    ]);
    expect(restrictToSlotRepresentative(flipped).set.cycles.map((c) => c.cycleId)).toEqual(["zzz"]);
  });
});

describe("② 파생값이 거른 뒤 집합으로 다시 선다", () => {
  const { set } = restrictToSlotRepresentative(
    setOf([
      pick({ cycleId: "early", generationId: "ge", cycleAnchorAt: "2026-08-18T15:48:00.000Z" }),
      pick({ cycleId: "late", generationId: "gl", cycleAnchorAt: "2026-08-25T15:48:00.000Z" }),
      pick({
        cycleId: "next", generationId: "gn", roundDate: "2026-08-31",
        cycleWeek: "2026-08-31", cycleAnchorAt: "2026-08-31T15:48:00.000Z",
      }),
    ]),
  );

  it("자리 수만큼 회차가 남는다", () => {
    expect(set.cycles).toHaveLength(2);
    expect(set.anchorCount).toBe(2);
  });

  it("캐시 키가 남은 회차만 담는다 — 뺀 회차 id 가 남으면 셀이 갈린다", () => {
    expect(set.cycleKey).not.toContain("early");
    expect(set.cycleKey).toContain("late");
  });
});

describe("③④ 아무 일도 안 하는 경우는 **같은 객체**다", () => {
  it("격자 off(`completionRatio` 미탑재)면 그대로", () => {
    const off = setOf([
      pick({ cycleId: "early", generationId: "ge", completionRatio: undefined }),
      pick({ cycleId: "late", generationId: "gl", completionRatio: undefined,
             cycleAnchorAt: "2026-08-25T15:48:00.000Z" }),
    ]);
    const out = restrictToSlotRepresentative(off);
    expect(out.set).toBe(off);
    expect(out.mergedSlots).toEqual([]);
  });

  it("합친 자리가 없으면 그대로", () => {
    const single = setOf([
      pick({ cycleId: "a", generationId: "g1", roundDate: "2026-08-24" }),
      pick({ cycleId: "b", generationId: "g2", roundDate: "2026-08-31",
             cycleAnchorAt: "2026-08-31T15:48:00.000Z" }),
    ]);
    const out = restrictToSlotRepresentative(single);
    expect(out.set).toBe(single);
    expect(out.mergedSlots).toEqual([]);
  });
});

describe("인용 제외 목록도 함께 좁아진다", () => {
  it("뺀 회차의 id 가 목록에 남지 않는다", () => {
    const base = setOf([
      pick({ cycleId: "early", generationId: "ge", cycleAnchorAt: "2026-08-18T15:48:00.000Z" }),
      pick({ cycleId: "late", generationId: "gl", cycleAnchorAt: "2026-08-25T15:48:00.000Z" }),
    ]);
    const { set } = restrictToSlotRepresentative({
      ...base,
      citationExcludedCycleIds: ["early", "late"],
    });
    expect(set.citationExcludedCycleIds).toEqual(["late"]);
  });
});

// ── 회귀(2026-09-20 프리뷰): 한 자리 두 회차 중 하나가 `citations` 숨김 ───────
//
// 08-24 자리가 갭이 된 원인 둘 중 **첫째**. 늦은 앵커만 보던 규칙이 숨김 회차
// (앵커 08-25, `hidden_scope='citations'`)를 대표로 골라, 값이 살아 있는 08-18 회차를
// 버렸다. 그러면 그 자리의 인용 계열이 통째로 죽는다(`citationCyclesOf` 가 유일한
// 회차를 빼 도메인 문장이 빈 회차 집합으로 나간다).
// ── 인용 전용 숨김은 **인용 계열 안에서만** 본다 (독립 검증 차단 2) ───────
//
// 종전에는 언급 사다리의 ② 키가 `citationExcludedCycleIds` 였다. 그러면 그 목록을
// **싣는 것만으로** `set.cycles` 가 바뀌고, 그 집합은 노출률·점유율·우호도·우선
// 노출도가 전부 쓴다 — 인용 하나를 고치려다 언급 4 KPI 의 회차가 조용히 움직였다.
// `hidden_scope='citations'` 는 "그 회차의 **인용**이 깨졌다" 이지 "언급도 깨졌다" 가
// 아니므로(제품 책임자 방침), 언급 대표는 그 목록을 무시하고 인용 대표만 반영한다.
describe("인용 전용 숨김 — 언급 대표는 영향을 받지 않는다", () => {
  const slot = (over: Partial<CycleSet> = {}): CycleSet => ({
    ...setOf([
      pick({ cycleId: "ok", generationId: "g1", cycleAnchorAt: "2026-08-18T15:48:00.000Z" }),
      pick({ cycleId: "hidden", generationId: "g2", cycleAnchorAt: "2026-08-25T15:48:00.000Z" }),
    ]),
    ...over,
  });

  // 8/24 자리의 실제 입력이다(1045851c 숨김·앵커 08-25 / 2a4f2bb1 정상·앵커 08-18).
  it("언급 대표는 늦은 앵커 그대로다 — 목록을 실어도 안 바뀐다", () => {
    const without = restrictToSlotRepresentative(slot());
    const withExcl = restrictToSlotRepresentative(slot({ citationExcludedCycleIds: ["hidden"] }));
    expect(without.set.cycles.map((c) => c.cycleId)).toEqual(["hidden"]);
    expect(withExcl.set.cycles.map((c) => c.cycleId)).toEqual(["hidden"]);
  });

  it("인용 대표는 **자기 기준**으로 숨김이 아닌 회차를 고른다", () => {
    const { set, familySplitSlots } = restrictToSlotRepresentative(
      slot({ citationExcludedCycleIds: ["hidden"] }),
    );
    expect(citationCyclesOf(set).map((c) => c.cycleId)).toEqual(["ok"]);
    expect(familySplitSlots).toEqual(["2026-08-24"]);
  });

  it("제외 목록은 살아남은 회차 기준으로 유지된다 (리더의 FILTER 가 그것을 쓴다)", () => {
    const { set } = restrictToSlotRepresentative(slot({ citationExcludedCycleIds: ["hidden"] }));
    expect(set.citationExcludedCycleIds).toEqual(["hidden"]);
  });

  it("자리의 회차가 **전부** 인용 숨김이면 인용 계열은 그 자리에서 갭이다", () => {
    const { set } = restrictToSlotRepresentative(
      slot({ citationExcludedCycleIds: ["ok", "hidden"] }),
    );
    expect(set.cycles.map((c) => c.cycleId)).toEqual(["hidden"]);
    // 인용 후보가 없다 → `citationCyclesOf` 가 빈 목록이다(= 그 자리 인용 회차 0).
    expect(citationCyclesOf(set)).toEqual([]);
    expect(set.citationExcludedCycleIds).toEqual(["hidden"]);
  });
});

// ── 차단 B2-c(2026-09-20 독립 검증): 완결성과 대표 선택이 같은 회차를 본다 ────
//
// 검증자가 실행으로 재현한 상태: 완주(1.0)와 부분(0.5)이 한 자리에 있으면 완결성은
// **최대값**으로 "갭 아님" 이라 하고 대표는 늦은 앵커라 **0.5 회차**를 골랐다 =
// 50%만 측정된 값이 실값으로 나간다. 대표 선택의 첫 키를 완결성으로 올려 닫는다.
describe("완결성이 대표 선택의 첫 키다", () => {
  const two = (a: number | undefined, b: number | undefined, over: Partial<CycleSet> = {}) => ({
    ...setOf([
      pick({
        cycleId: "early", generationId: "g1",
        cycleAnchorAt: "2026-08-18T15:48:00.000Z", completionRatio: a,
      }),
      pick({
        cycleId: "late", generationId: "g2",
        cycleAnchorAt: "2026-08-25T15:48:00.000Z", completionRatio: b,
      }),
    ]),
    ...over,
  });

  it("늦은 앵커가 미달이면 **완주한 이른 회차**가 대표다", () => {
    const { set } = restrictToSlotRepresentative(two(1.0, 0.5));
    expect(set.cycles.map((c) => c.cycleId)).toEqual(["early"]);
    expect(set.cycles[0].completionRatio).toBe(1.0);
  });

  it("둘 다 통과면 종전 순서(숨김 → 늦은 앵커)다", () => {
    expect(
      restrictToSlotRepresentative(two(0.9997, 1.0)).set.cycles.map((c) => c.cycleId),
    ).toEqual(["late"]);
  });

  it("둘 다 미달이면 자리가 안 비고 늦은 앵커가 남는다 (갭 판정이 처리한다)", () => {
    const { set } = restrictToSlotRepresentative(two(0.4, 0.5));
    expect(set.cycles.map((c) => c.cycleId)).toEqual(["late"]);
    expect(set.cycles[0].completionRatio).toBe(0.5);
  });

  it("완결성을 모르면 통과로 본다 (고객이 보던 과거를 지우지 않는다)", () => {
    // `undefined` 가 섞여 있어도 격자 on 신호(다른 회차의 ratio)는 살아 있다.
    const { set } = restrictToSlotRepresentative(two(undefined, 0.5));
    expect(set.cycles.map((c) => c.cycleId)).toEqual(["early"]);
  });

  it("완결성이 숨김보다 **먼저**다 (채택한 순서의 단언)", () => {
    // 비숨김이 미달 · 숨김이 통과 → 값이 맞는 쪽(숨김)을 고른다.
    const { set } = restrictToSlotRepresentative(
      two(0.5, 1.0, { citationExcludedCycleIds: ["late"] }),
    );
    expect(set.cycles.map((c) => c.cycleId)).toEqual(["late"]);
  });

  it("갭 판정 결과는 종전과 같다 — 자리에 통과 회차가 있으면 대표도 통과", () => {
    for (const [a, b] of [[1.0, 0.5], [0.5, 1.0], [0.95, 0.95]] as const) {
      const { set } = restrictToSlotRepresentative(two(a, b));
      expect(slotIsIncomplete([set.cycles[0].completionRatio])).toBe(false);
    }
    // 반대로 자리 전체가 미달이면 대표도 미달이다.
    const { set } = restrictToSlotRepresentative(two(0.4, 0.5));
    expect(slotIsIncomplete([set.cycles[0].completionRatio])).toBe(true);
  });
});

// ── N3(2026-09-20 독립 검증): 계열별 대표 ────────────────────────────────────
//
// "완결성 먼저" 순서의 대가: 비숨김 회차가 미달이고 `citations` 숨김 회차가 통과인
// 자리에서 언급 대표가 숨김 회차가 되고, 인용 계열은 그 자리에서 회차가 0 이 된다 —
// 옆에 인용이 멀쩡한 비숨김 회차가 있어도 그렇다. 인용 계열이 자기 기준으로 다시 고른다.
describe("계열별 대표 — 인용은 자기 기준으로 고른다", () => {
  const slot = (a: number, b: number, excluded: string[]) => ({
    ...setOf([
      pick({
        cycleId: "visible", generationId: "g1",
        cycleAnchorAt: "2026-08-18T15:48:00.000Z", completionRatio: a,
      }),
      pick({
        cycleId: "citHidden", generationId: "g2",
        cycleAnchorAt: "2026-08-25T15:48:00.000Z", completionRatio: b,
      }),
    ]),
    citationExcludedCycleIds: excluded,
  });

  it("비숨김이 미달이면 언급은 숨김 회차, 인용은 **비숨김 회차**를 읽는다", () => {
    const { set, familySplitSlots } = restrictToSlotRepresentative(
      slot(0.5, 1.0, ["citHidden"]),
    );
    expect(set.cycles.map((c) => c.cycleId)).toEqual(["citHidden"]);
    expect(citationCyclesOf(set).map((c) => c.cycleId)).toEqual(["visible"]);
    expect(familySplitSlots).toEqual(["2026-08-24"]);
  });

  it("둘 다 통과면 언급은 늦은 앵커(숨김), 인용은 비숨김 — 계열이 갈린다", () => {
    // 종전에는 언급 사다리가 숨김을 봐서 둘 다 `visible` 이었다. 차단 2 수리 뒤로는
    // 언급이 인용 전용 숨김을 무시하므로 늦은 앵커가 이기고, 인용만 갈라진다.
    const { set, familySplitSlots } = restrictToSlotRepresentative(
      slot(1.0, 1.0, ["citHidden"]),
    );
    expect(set.cycles.map((c) => c.cycleId)).toEqual(["citHidden"]);
    expect(citationCyclesOf(set).map((c) => c.cycleId)).toEqual(["visible"]);
    expect(familySplitSlots).toEqual(["2026-08-24"]);
  });

  it("자리의 회차가 전부 숨김이면 인용은 그 자리를 안 읽는다 (갭)", () => {
    const { set } = restrictToSlotRepresentative(
      slot(1.0, 1.0, ["visible", "citHidden"]),
    );
    expect(citationCyclesOf(set)).toEqual([]);
  });

  it("인용 대표도 완결성 통과를 먼저 본다", () => {
    // 비숨김 둘 중 하나가 미달이면(여기서는 `visible` 이 0.5) 인용은 통과한 쪽을 고른다.
    const three = {
      ...setOf([
        pick({ cycleId: "visible", generationId: "g1",
               cycleAnchorAt: "2026-08-18T15:48:00.000Z", completionRatio: 0.5 }),
        pick({ cycleId: "visible2", generationId: "g3",
               cycleAnchorAt: "2026-08-19T15:48:00.000Z", completionRatio: 1.0 }),
        pick({ cycleId: "citHidden", generationId: "g2",
               cycleAnchorAt: "2026-08-25T15:48:00.000Z", completionRatio: 1.0 }),
      ]),
      citationExcludedCycleIds: ["citHidden"],
    };
    const { set } = restrictToSlotRepresentative(three);
    // 언급은 숨김을 무시하므로 통과분 중 늦은 앵커 = `citHidden`.
    expect(set.cycles.map((c) => c.cycleId)).toEqual(["citHidden"]);
    // 인용은 비숨김 중 완결성 통과 = `visible2`(`visible` 은 0.5 라 탈락).
    expect(citationCyclesOf(set).map((c) => c.cycleId)).toEqual(["visible2"]);
  });
});

// ── M1(2026-09-20 독립 검증): 완결성 거르기가 `citationCycles` 를 나른다 ─────
//
// 파이프라인이 대표 → 완결성 순서라, 완결성 거르기가 그 필드를 안 나르면 창에 갭이
// **하나라도** 있는 순간 N3 수리가 통째로 사라진다(로그는 `family-split:` 인데
// `citationCyclesOf` 는 `[]`). 검증자가 실행으로 재현한 결함이다.
describe("완결성 거르기가 계열별 대표를 보존한다", () => {
  const withSplit = (): CycleSet => ({
    ...setOf([
      pick({ cycleId: "mention", generationId: "g1", roundDate: "2026-08-24",
             cycleAnchorAt: "2026-08-25T15:48:00.000Z", completionRatio: 1 }),
      pick({ cycleId: "other", generationId: "g3", roundDate: "2026-08-31",
             cycleWeek: "2026-08-31", cycleAnchorAt: "2026-08-31T15:48:00.000Z",
             completionRatio: 0.4 }),
    ]),
    citationCycles: [
      pick({ cycleId: "citation", generationId: "g2", roundDate: "2026-08-24",
             cycleAnchorAt: "2026-08-18T15:48:00.000Z", completionRatio: 1 }),
    ],
  });

  it("창에 완결성 갭이 있어도 인용 대표가 살아남는다", () => {
    const { set, gapDays } = restrictToCompleteCycles(withSplit());
    expect(gapDays).toEqual(["2026-08-31"]);
    expect(set.citationCycles?.map((c) => c.cycleId)).toEqual(["citation"]);
    expect(citationCyclesOf(set).map((c) => c.cycleId)).toEqual(["citation"]);
  });

  it("완결성으로 빠지는 **자리**의 인용 대표는 같이 빠진다", () => {
    const base = withSplit();
    const dropped: CycleSet = {
      ...base,
      // 인용 대표가 갭이 되는 자리(08-31)에 있으면 함께 빠져야 한다.
      citationCycles: [
        pick({ cycleId: "citation31", generationId: "g4", roundDate: "2026-08-31",
               cycleWeek: "2026-08-31", cycleAnchorAt: "2026-08-31T15:48:00.000Z",
               completionRatio: 1 }),
      ],
    };
    const { set } = restrictToCompleteCycles(dropped);
    // 그 자리는 화면에서 갭이다 — 계열만 값을 내면 "언급은 음영인데 인용만 점" 이 된다.
    expect(set.citationCycles).toBeUndefined();
    expect(citationCyclesOf(set).map((c) => c.cycleId)).toEqual(["mention"]);
  });

  it("갭이 없으면 **같은 객체**다 (캐시 키 불변)", () => {
    const noGap: CycleSet = {
      ...setOf([
        pick({ cycleId: "mention", generationId: "g1", roundDate: "2026-08-24",
               completionRatio: 1 }),
      ]),
      citationCycles: [pick({ cycleId: "citation", generationId: "g2" })],
    };
    const out = restrictToCompleteCycles(noGap);
    expect(out.set).toBe(noGap);
  });
});

// ── ⓪ 함대 노출이 **맨 앞** — 좁은 기간의 구멍 (2026-09-20 카드 정합 수리) ────
//
// `restrictToFleetVisible` 은 같은 `(프로젝트, 주)` 그룹에 **대표가 창 안에 있을 때만**
// 패자를 뺀다(`dropFleetLosers` 의 의도된 보수성). 기간이 하루면 그 전제가 깨진다 —
// 메인 실측 `time=2026-08-17..2026-08-17` 의 자리 08-17:
//
//   608a1e7b  주 2026-08-10 · 앵커 08-11 · fleet_visible **true**
//   a6902908  주 2026-08-17 · 앵커 08-19 · fleet_visible **false**
//     (이 주의 대표 2a4f2bb1 은 귀속 날짜가 08-24 라 **창 밖**이다)
//
// 늦은 앵커만 보면 08-19 가 이겨서 **노출이 꺼진 회차가 카드 값이 된다**. 추이는 창이
// 13주라 같은 자리에서 608a1e7b 를 고르므로 두 화면이 갈린다.
describe("⓪ 함대 노출 꺼진 회차는 대표가 되지 않는다", () => {
  const slot0817 = setOf([
    pick({
      cycleId: "608a1e7b", generationId: "g1", roundDate: "2026-08-17",
      cycleWeek: "2026-08-10", cycleAnchorAt: "2026-08-11T15:48:00.000Z",
      fleetVisible: true, completionRatio: 1,
    }),
    pick({
      cycleId: "a6902908", generationId: "g2", roundDate: "2026-08-17",
      cycleWeek: "2026-08-17", cycleAnchorAt: "2026-08-19T15:48:00.000Z",
      fleetVisible: false, completionRatio: 1,
    }),
  ]);

  it("늦은 앵커여도 `fleet_visible=false` 는 진다", () => {
    const { set } = restrictToSlotRepresentative(slot0817);
    expect(set.cycles.map((c) => c.cycleId)).toEqual(["608a1e7b"]);
  });

  it("인용 대표도 같은 조건을 먼저 본다", () => {
    const { set } = restrictToSlotRepresentative(slot0817);
    expect(citationCyclesOf(set).map((c) => c.cycleId)).toEqual(["608a1e7b"]);
  });

  it("자리의 회차가 **전부** 꺼져 있으면 자리를 비우지 않는다", () => {
    const allHidden = setOf([
      pick({ cycleId: "x", generationId: "g1", roundDate: "2026-08-17",
             cycleWeek: "2026-08-10", cycleAnchorAt: "2026-08-11T15:48:00.000Z",
             fleetVisible: false, completionRatio: 1 }),
      pick({ cycleId: "y", generationId: "g2", roundDate: "2026-08-17",
             cycleWeek: "2026-08-17", cycleAnchorAt: "2026-08-19T15:48:00.000Z",
             fleetVisible: false, completionRatio: 1 }),
    ]);
    // `dropFleetLosers` 의 "패자만 있는 그룹은 남긴다" 와 같은 방향 — 늦은 앵커가 남는다.
    expect(restrictToSlotRepresentative(allHidden).set.cycles.map((c) => c.cycleId))
      .toEqual(["y"]);
  });

  it("`fleetVisible` 이 안 실린 픽은 대표 후보다 (옛 경로 보호)", () => {
    const unknown = setOf([
      pick({ cycleId: "old", generationId: "g1", roundDate: "2026-08-17",
             cycleWeek: "2026-08-10", cycleAnchorAt: "2026-08-19T15:48:00.000Z",
             completionRatio: 1 }),
      pick({ cycleId: "loser", generationId: "g2", roundDate: "2026-08-17",
             cycleWeek: "2026-08-17", cycleAnchorAt: "2026-08-11T15:48:00.000Z",
             fleetVisible: false, completionRatio: 1 }),
    ]);
    expect(restrictToSlotRepresentative(unknown).set.cycles.map((c) => c.cycleId))
      .toEqual(["old"]);
  });
});

// ── 함대 표면은 **(프로젝트, 자리)** 마다 대표를 고른다 (2026-09-20) ──────────
//
// 날짜만으로 묶으면 그 자리의 사이트 수십 개가 회차 하나로 접힌다 — 값이 틀리는 방향이라
// `perProject` 없이 함대에 걸면 안 된다.
describe("perProject — 함대 표면의 자리 그룹", () => {
  const A = "11111111-1111-4111-8111-111111111111";
  const B = "22222222-2222-4222-8222-222222222222";
  const fleet: CycleSet = {
    ...setOf([
      pick({ cycleId: "a1", generationId: "g1", projectId: A, roundDate: "2026-09-12",
             cycleWeek: "2026-09-07", cycleAnchorAt: "2026-09-12T00:00:00.000Z" }),
      pick({ cycleId: "a2", generationId: "g2", projectId: A, roundDate: "2026-09-12",
             cycleWeek: "2026-09-14", cycleAnchorAt: "2026-09-16T00:00:00.000Z" }),
      pick({ cycleId: "b1", generationId: "g3", projectId: B, roundDate: "2026-09-12",
             cycleWeek: "2026-09-07", cycleAnchorAt: "2026-09-12T00:00:00.000Z" }),
    ]),
    surface: "website",
  };

  it("프로젝트마다 대표가 하나씩 남는다 (함대가 안 접힌다)", () => {
    const { set } = restrictToSlotRepresentative(fleet, { perProject: true });
    expect(set.cycles.map((c) => c.cycleId).sort()).toEqual(["a2", "b1"]);
  });

  it("`perProject` 없이 걸면 함대가 회차 하나로 접힌다 (그래서 기본값이 아니다)", () => {
    const { set } = restrictToSlotRepresentative(fleet);
    expect(set.cycles).toHaveLength(1);
  });

  it("합친 자리 보고는 **날짜**다 (프로젝트 키가 새지 않는다)", () => {
    expect(restrictToSlotRepresentative(fleet, { perProject: true }).mergedSlots)
      .toEqual(["2026-09-12"]);
  });
});

// ── 규칙 한 벌 — 추이와 카드가 **같은 함수**를 쓴다 (2026-09-20) ──────────────
//
// 종전에는 세 단계가 `server.ts::viaGlobalSeries` 안에만 있었고, 그래서 카드 게이트가
// 한 자리의 회차를 **전부 합산**했다(8/17 자리 카드 14.0% vs 상세 6.5%).
describe("restrictToTrendSlotSet — 합성 규칙", () => {
  it("함대 패자를 빼고 자리마다 대표 하나만 남긴다", () => {
    const set = setOf([
      pick({ cycleId: "win", generationId: "g1", roundDate: "2026-08-17",
             cycleWeek: "2026-08-10", cycleAnchorAt: "2026-08-11T00:00:00.000Z",
             fleetVisible: true, completionRatio: 1 }),
      pick({ cycleId: "lose", generationId: "g2", roundDate: "2026-08-17",
             cycleWeek: "2026-08-10", cycleAnchorAt: "2026-08-19T00:00:00.000Z",
             fleetVisible: false, completionRatio: 1 }),
    ]);
    const out = restrictToTrendSlotSet(set);
    expect(out.set.cycles.map((c) => c.cycleId)).toEqual(["win"]);
    expect(out.fleetHidden).toBe(1);
    expect(out.gapDays).toEqual([]);
  });

  it("완결성 미달 자리는 갭으로 빠진다 — 그 자리 키를 보고한다", () => {
    const set = setOf([
      pick({ cycleId: "ok", generationId: "g1", roundDate: "2026-08-17",
             cycleWeek: "2026-08-10", cycleAnchorAt: "2026-08-11T00:00:00.000Z",
             fleetVisible: true, completionRatio: 1 }),
      pick({ cycleId: "thin", generationId: "g2", roundDate: "2026-08-24",
             cycleWeek: "2026-08-17", cycleAnchorAt: "2026-08-18T00:00:00.000Z",
             fleetVisible: true, completionRatio: 0.1 }),
    ]);
    const out = restrictToTrendSlotSet(set);
    expect(out.gapDays).toEqual(["2026-08-24"]);
    expect(out.set.cycles.map((c) => c.cycleId)).toEqual(["ok"]);
  });

  it("격자 off(완결성 미탑재)면 **입력 객체 그대로**다 — 캐시 키 불변", () => {
    const off = setOf([
      pick({ cycleId: "a", generationId: "g1", roundDate: "2026-08-17",
             cycleWeek: "2026-08-10", cycleAnchorAt: "2026-08-11T00:00:00.000Z",
             completionRatio: undefined }),
      pick({ cycleId: "b", generationId: "g2", roundDate: "2026-08-17",
             cycleWeek: "2026-08-17", cycleAnchorAt: "2026-08-19T00:00:00.000Z",
             completionRatio: undefined }),
    ]);
    expect(trendGridApplied(off)).toBe(false);
    const out = restrictToTrendSlotSet(off);
    expect(out.set).toBe(off);
    expect(out.gapDays).toEqual([]);
    expect(out.mergedSlots).toEqual([]);
  });

  it("`trendGridApplied` 는 완결성 탑재 여부 하나로 판정한다", () => {
    expect(trendGridApplied(setOf([pick({ completionRatio: 1 })]))).toBe(true);
    expect(trendGridApplied(setOf([pick({ completionRatio: undefined })]))).toBe(false);
  });
});

// ── 창 폭이 자리 대표를 바꾸면 안 된다 (2026-09-20 독립 검증 차단 1) ─────────
//
// `restrictToFleetVisible` 이 파생 집합을 다시 세울 때 계열 필드를 떨어뜨리고 있었다.
// 그 함수는 `restrictToTrendSlotSet` 의 **맨 앞**이라, 창 안 어느 주에든 함대 패자가
// 하나라도 있으면 뒤의 자리 대표 판정이 인용 숨김 목록을 **못 본다**. 검증자가 실행으로
// 반증한 증상: 같은 08-24 자리인데 카드 창(자리 하나)과 추이 창(13주)이 **다른 인용
// 대표**를 골랐다. 입력은 검증자의 재현 블록(A-2)을 그대로 쓴다.
describe("창 폭 불변 — 같은 자리의 대표는 창이 달라도 같다", () => {
  const SLOT0824 = [
    pick({ cycleId: "hid", generationId: "gh", roundDate: "2026-08-24",
           cycleWeek: "2026-08-17", cycleAnchorAt: "2026-08-25T00:00:00.000Z" }),
    pick({ cycleId: "ok", generationId: "go", roundDate: "2026-08-24",
           cycleWeek: "2026-08-17", cycleAnchorAt: "2026-08-18T00:00:00.000Z" }),
  ];
  // 다른 주(08-10)에 함대 패자가 **창 안에** 있는 경우 = 넓은 추이 창의 전형.
  const WEEK0810_WITH_LOSER = [
    pick({ cycleId: "w1", generationId: "g1", roundDate: "2026-08-10",
           cycleWeek: "2026-08-10", cycleAnchorAt: "2026-08-11T00:00:00.000Z",
           fleetVisible: true }),
    pick({ cycleId: "w2", generationId: "g2", roundDate: "2026-08-11",
           cycleWeek: "2026-08-10", cycleAnchorAt: "2026-08-12T00:00:00.000Z",
           fleetVisible: false }),
  ];
  const EXCL = { citationExcludedCycleIds: ["hid"] };
  const narrowWindow = { ...setOf(SLOT0824), ...EXCL };
  const wideWindow = { ...setOf([...WEEK0810_WITH_LOSER, ...SLOT0824]), ...EXCL };

  const at0824 = (s: CycleSet) =>
    s.cycles.filter((c) => c.roundDate === "2026-08-24").map((c) => c.cycleId);

  it("넓은 창에서 함대 패자가 실제로 빠진다 (이 테스트가 공허하지 않다는 증거)", () => {
    expect(restrictToTrendSlotSet(wideWindow).fleetHidden).toBe(1);
  });

  it("언급 대표가 두 창에서 같다", () => {
    expect(at0824(restrictToTrendSlotSet(narrowWindow).set)).toEqual(["hid"]);
    expect(at0824(restrictToTrendSlotSet(wideWindow).set)).toEqual(["hid"]);
  });

  it("인용 대표도 두 창에서 같다 — 계열 필드가 끝까지 실려 간다", () => {
    for (const w of [narrowWindow, wideWindow]) {
      const { set } = restrictToTrendSlotSet(w);
      const cit = citationCyclesOf(set)
        .filter((c) => c.roundDate === "2026-08-24")
        .map((c) => c.cycleId);
      expect(cit).toEqual(["ok"]);
      expect(set.citationExcludedCycleIds).toContain("hid");
    }
  });

  it("`restrictToFleetVisible` 단독도 계열 필드를 나른다 (근본 원인 지점)", () => {
    const out = restrictToFleetVisible(wideWindow);
    expect(out.cycles).toHaveLength(3);
    expect(out.citationExcludedCycleIds).toEqual(["hid"]);
  });
});

// ── 인용 전용 숨김 목록은 **언급 계열 회차 집합을 못 바꾼다** (차단 2 회귀 가드) ──
//
// 검증자가 실행으로 반증한 상태: 목록을 싣는 것만으로 `set.cycles` 가 `hid` → `ok` 로
// 바뀌었다. 그 집합은 `trendWhere → cycleScope(scope.set)` 로 **모든 계열 문장**의 회차
// 스코프라(`summary-trend-aggregates.ts`), 노출률·점유율·우호도·우선 노출도가 전부
// 따라 움직인다. 목록의 영향은 인용 계열(`citationCyclesOf`·`citationFilter`)에 갇혀야 한다.
describe("목록 적재 불변 — 언급 계열 회차 집합은 그대로다", () => {
  const cases: Array<[string, Array<Partial<Record<string, unknown>>>]> = [
    ["한 자리 두 회차", [
      { cycleId: "a", generationId: "ga", cycleAnchorAt: "2026-08-18T00:00:00.000Z" },
      { cycleId: "b", generationId: "gb", cycleAnchorAt: "2026-08-25T00:00:00.000Z" },
    ]],
    ["두 자리", [
      { cycleId: "a", generationId: "ga", roundDate: "2026-08-17",
        cycleWeek: "2026-08-10", cycleAnchorAt: "2026-08-11T00:00:00.000Z" },
      { cycleId: "b", generationId: "gb", roundDate: "2026-08-24",
        cycleWeek: "2026-08-17", cycleAnchorAt: "2026-08-25T00:00:00.000Z" },
    ]],
  ];

  it.each(cases)("%s — 목록 유무와 무관하게 같은 집합", (_label, rows) => {
    const cycles = rows.map((r) => pick(r as Parameters<typeof pick>[0]));
    const without = restrictToTrendSlotSet(setOf(cycles));
    for (const excl of [["a"], ["b"], ["a", "b"]]) {
      const withExcl = restrictToTrendSlotSet({
        ...setOf(cycles),
        citationExcludedCycleIds: excl,
      });
      expect(withExcl.set.cycles.map((c) => c.cycleId), excl.join(","))
        .toEqual(without.set.cycles.map((c) => c.cycleId));
      expect(withExcl.set.cycleKey, excl.join(",")).toBe(without.set.cycleKey);
      expect(withExcl.set.anchorCount, excl.join(",")).toBe(without.set.anchorCount);
    }
  });
});
