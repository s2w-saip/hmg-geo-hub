import { describe, it, expect } from "vitest";
import {
  aggregateMentionsFrom,
  anchorAxisCarried,
  anchorDefaultEnginePasses,
  anchorRepresentativeJobIds,
  anchorViewPasses,
  buildMentionTrend,
  type AnchoredJob,
  type PromptMap,
} from "./result-adapter";
// `kstDay` 는 일자 산술 정본(`lib/period/day-arith.ts`)으로 옮겼다 — 구현·기대값은
// 그대로이고 import 경로만 바뀐다.
import { kstDay } from "@/lib/period/day-arith";
import type { ResolvedMention } from "./types";

// ════════════════════════════════════════════════════════════════════════════
// 앵커 축(0077) — **JS 롤업 경로**의 값 단언 (DB 없이, 인메모리 픽스처)
// ════════════════════════════════════════════════════════════════════════════
//
// 계약: `notes/hmg-anchor-table/streams/CONTRACT.md` §3.
//   · 기간 = `round_date BETWEEN from AND to`(양 끝 포함, KST)
//   · 기간에 회차가 여럿이면 **회차마다** 셀(질문 × 엔진 × 지역)당 대표 1건
//     (`measured_at_orig` 최신) → 회차 간 **합산**
//
// 날짜 기대값은 전부 **손계산 리터럴**이다(구현과 같은 함수로 기대값을 만들지 않는다).
// 회차 귀속은 매핑 표가 정하므로 여기서는 픽스처가 그 표 역할을 한다 — 아래
// `2026-09-11`(금)은 글로벌 정규 요일(월)이 아니지만 매핑이 그렇게 앉혔다고 본다.

const NO_PROMPTS: PromptMap = new Map();

function mention(name: string, count: number): ResolvedMention {
  return {
    entity_id: `e-${name}`,
    entity_type: "Brand",
    display_name: name,
    rollups: { product_entity_id: null, brand_entity_id: null, company_entity_id: null },
    surfaces: [name],
    mention_count: count,
  };
}

/** 앵커를 실은 답변 한 건. 셀 = (promptId, target, region). */
function anchored(
  id: string,
  o: {
    promptId?: string;
    target?: string;
    region?: string | null;
    count: number;
    roundDate: string;
    anchorWeek: string;
    measuredOrig: string;
    measuredAt?: string;
    defaultEngine?: boolean;
    viewAnchorDate?: string | null;
  },
): AnchoredJob {
  return {
    job_id: id,
    prompt_id: o.promptId ?? "p1",
    target: o.target ?? "chatgpt",
    region: o.region ?? "KR",
    status: "completed",
    // 0053 접기 뒤의 값 — 날짜부가 앵커로 덮여 있다(그래서 대표 정렬에 쓰면 안 된다).
    measured_at: o.measuredAt ?? `${o.roundDate}T00:00:00Z`,
    analysis: { status: "completed", resolved_mentions: [mention("Hyundai", o.count)] },
    round_date: o.roundDate,
    anchor_week: o.anchorWeek,
    measured_at_orig: o.measuredOrig,
    is_default_engine: o.defaultEngine ?? true,
    view_anchor_date: o.viewAnchorDate === undefined ? o.roundDate : o.viewAnchorDate,
  };
}

/** 종전 축(앵커 미투영) 답변 — off 경로 대조용. */
function plain(id: string, measuredAt: string, count: number): AnchoredJob {
  return {
    job_id: id,
    prompt_id: "p1",
    target: "chatgpt",
    region: "KR",
    status: "completed",
    measured_at: measuredAt,
    analysis: { status: "completed", resolved_mentions: [mention("Hyundai", count)] },
  };
}

// 회차 2개 × 같은 셀 재측정 2건씩. 회차마다 최신(`measured_at_orig`) 하나만 남고
// 회차 간에는 합산된다 → 기대 답변 수 2, 기대 언급 합 3 + 30 = 33.
const TWO_ROUNDS: AnchoredJob[] = [
  anchored("r1-old", {
    count: 1,
    roundDate: "2026-09-07",
    anchorWeek: "2026-09-07",
    measuredOrig: "2026-09-07T01:00:00Z",
  }),
  anchored("r1-new", {
    count: 3,
    roundDate: "2026-09-07",
    anchorWeek: "2026-09-07",
    measuredOrig: "2026-09-07T09:00:00Z",
  }),
  anchored("r2-old", {
    count: 10,
    roundDate: "2026-09-11",
    anchorWeek: "2026-09-07",
    measuredOrig: "2026-09-10T22:35:00Z",
  }),
  anchored("r2-new", {
    count: 30,
    roundDate: "2026-09-11",
    anchorWeek: "2026-09-07",
    measuredOrig: "2026-09-11T02:00:00Z",
  }),
];

describe("앵커 축 — 조각 술어", () => {
  it("anchorAxisCarried — round_date 가 축의 존재 신호다", () => {
    expect(anchorAxisCarried({ round_date: "2026-09-07" })).toBe(true);
    expect(anchorAxisCarried({ round_date: null })).toBe(false);
    expect(anchorAxisCarried({ anchor_week: "2026-09-07" })).toBe(false);
    expect(anchorAxisCarried(undefined)).toBe(false);
  });

  it("kstDay — UTC+9 경계(손계산)", () => {
    // 2026-09-10 22:35Z + 9h = 2026-09-11 07:35 KST → 09-11
    expect(kstDay(Date.parse("2026-09-10T22:35:00Z"))).toBe("2026-09-11");
    // 2026-08-31 14:59:59Z + 9h = 2026-08-31 23:59:59 KST → 08-31
    expect(kstDay(Date.parse("2026-08-31T14:59:59Z"))).toBe("2026-08-31");
    expect(kstDay(Date.parse("2026-08-31T15:00:00Z"))).toBe("2026-09-01");
  });

  it("anchorViewPasses — undefined(미투영) / null(비노출) / 날짜 비교", () => {
    expect(anchorViewPasses({}, "2026-09-12")).toBe(true);
    expect(anchorViewPasses({ view_anchor_date: null }, "2026-09-12")).toBe(false);
    expect(anchorViewPasses({ view_anchor_date: "2026-09-12" }, "2026-09-12")).toBe(true);
    expect(anchorViewPasses({ view_anchor_date: "2026-09-13" }, "2026-09-12")).toBe(false);
  });

  it("anchorDefaultEnginePasses — 엔진 선택이 기본 범위를 이긴다", () => {
    expect(anchorDefaultEnginePasses({}, { is_default_engine: false })).toBe(false);
    expect(anchorDefaultEnginePasses({}, { is_default_engine: true })).toBe(true);
    expect(anchorDefaultEnginePasses({ engine: ["deepseek"] }, { is_default_engine: false })).toBe(
      true,
    );
    // 값이 안 실려 오면 좁히지 않는다(모르는 값으로 모수를 지우지 않는다).
    expect(anchorDefaultEnginePasses({}, {})).toBe(true);
  });
});

describe("앵커 축 — 회차마다 셀당 대표 1건", () => {
  it("회차 2개 × 재측정 2건 → 회차별 최신 1건(job id 리터럴)", () => {
    const ids = anchorRepresentativeJobIds(TWO_ROUNDS);
    expect(ids && [...ids].sort()).toEqual(["r1-new", "r2-new"]);
  });

  it("대표 정렬은 `measured_at_orig` 다 — 접힌 measured_at 이 반대여도 뒤집히지 않는다", () => {
    // 0053 접기 뒤의 `measured_at` 은 old 가 더 크게 보이도록 일부러 어긋나게 둔다.
    const jobs: AnchoredJob[] = [
      anchored("old", {
        count: 1,
        roundDate: "2026-09-07",
        anchorWeek: "2026-09-07",
        measuredOrig: "2026-09-06T01:00:00Z",
        measuredAt: "2026-09-07T23:59:00Z",
      }),
      anchored("new", {
        count: 2,
        roundDate: "2026-09-07",
        anchorWeek: "2026-09-07",
        measuredOrig: "2026-09-07T09:00:00Z",
        measuredAt: "2026-09-07T00:01:00Z",
      }),
    ];
    expect([...anchorRepresentativeJobIds(jobs)!]).toEqual(["new"]);
  });

  it("셀이 다르면(엔진·지역) 각자 대표를 갖는다", () => {
    const jobs: AnchoredJob[] = [
      ...TWO_ROUNDS,
      anchored("r1-gemini", {
        count: 5,
        target: "gemini",
        roundDate: "2026-09-07",
        anchorWeek: "2026-09-07",
        measuredOrig: "2026-09-07T03:00:00Z",
      }),
      anchored("r1-us", {
        count: 7,
        region: "US",
        roundDate: "2026-09-07",
        anchorWeek: "2026-09-07",
        measuredOrig: "2026-09-07T04:00:00Z",
      }),
    ];
    expect([...anchorRepresentativeJobIds(jobs)!].sort()).toEqual([
      "r1-gemini",
      "r1-new",
      "r1-us",
      "r2-new",
    ]);
  });

  it("`pass` 에서 떨어진 답변은 대표 자리를 차지하지 못한다", () => {
    const ids = anchorRepresentativeJobIds(TWO_ROUNDS, {
      pass: (j) => j.job_id !== "r1-new",
    });
    expect([...ids!].sort()).toEqual(["r1-old", "r2-new"]);
  });

  it("앵커를 실은 행이 하나도 없으면 null (= 종전 축)", () => {
    expect(anchorRepresentativeJobIds([plain("a", "2026-09-07T00:00:00Z", 1)])).toBeNull();
  });

  it("동점(measured_at_orig 같음)은 job_id 사전식 최대로 결정적으로 깬다", () => {
    const same = {
      count: 1,
      roundDate: "2026-09-07",
      anchorWeek: "2026-09-07",
      measuredOrig: "2026-09-07T09:00:00Z",
    };
    expect([...anchorRepresentativeJobIds([anchored("aaa", same), anchored("zzz", same)])!]).toEqual(
      ["zzz"],
    );
    expect([...anchorRepresentativeJobIds([anchored("zzz", same), anchored("aaa", same)])!]).toEqual(
      ["zzz"],
    );
  });
});

describe("앵커 축 — aggregateMentionsFrom 값 단언", () => {
  it("회차 2개가 회차별 대표 1건씩으로 합산된다 (답변 2 · 언급 33)", () => {
    const out = aggregateMentionsFrom(TWO_ROUNDS, NO_PROMPTS, {}, { today: "2026-09-12" })!;
    expect(out.summary.total).toBe(33); // 3 + 30
    expect(out.brands[0]?.mentions).toBe(33);
    // 같은 셀(질문×엔진×지역)이라 답변 참조는 1건으로 접히고 `runs` 가 회차 수다.
    expect(out.perBrandPrompts.Hyundai?.[0]?.answers[0]?.runs).toBe(2);
    // 측정 기준일 = max(round_date) — 손계산 리터럴.
    expect(out.asOf).toBe("2026-09-11");
  });

  it("기간은 `round_date` 로 건다 — 양 끝 포함, 접힌 measured_at 이 아니다", () => {
    const only2nd = aggregateMentionsFrom(
      TWO_ROUNDS,
      NO_PROMPTS,
      { dateFrom: "2026-09-08", dateTo: "2026-09-11" },
      { today: "2026-09-12" },
    )!;
    expect(only2nd.summary.total).toBe(30);
    expect(only2nd.perBrandPrompts.Hyundai?.[0]?.answers[0]?.runs).toBe(1);
    expect(only2nd.asOf).toBe("2026-09-11");

    // 상한이 그 날을 **포함**한다: to=09-11 이 2회차를 담았고, to=09-10 은 못 담는다.
    const only1st = aggregateMentionsFrom(
      TWO_ROUNDS,
      NO_PROMPTS,
      { dateFrom: "2026-09-01", dateTo: "2026-09-10" },
      { today: "2026-09-12" },
    )!;
    expect(only1st.summary.total).toBe(3);
    expect(only1st.asOf).toBe("2026-09-07");
  });

  it("노출 전(view_anchor_date > 오늘) 회차는 빠진다", () => {
    const jobs: AnchoredJob[] = [
      ...TWO_ROUNDS.slice(0, 2),
      anchored("r2-pending", {
        count: 99,
        roundDate: "2026-09-11",
        anchorWeek: "2026-09-07",
        measuredOrig: "2026-09-11T02:00:00Z",
        viewAnchorDate: "2026-09-13",
      }),
    ];
    const out = aggregateMentionsFrom(jobs, NO_PROMPTS, {}, { today: "2026-09-12" })!;
    expect(out.summary.total).toBe(3);
    expect(out.asOf).toBe("2026-09-07");
  });

  it("엔진 필터가 비면 기본 엔진만, 고르면 그 엔진이 이긴다", () => {
    const jobs: AnchoredJob[] = [
      ...TWO_ROUNDS.slice(1, 2), // r1-new (기본 엔진)
      anchored("r1-deepseek", {
        count: 100,
        target: "deepseek",
        roundDate: "2026-09-07",
        anchorWeek: "2026-09-07",
        measuredOrig: "2026-09-07T10:00:00Z",
        defaultEngine: false,
      }),
    ];
    expect(aggregateMentionsFrom(jobs, NO_PROMPTS, {}, { today: "2026-09-12" })!.summary.total).toBe(
      3,
    );
    expect(
      aggregateMentionsFrom(jobs, NO_PROMPTS, { engine: ["deepseek"] }, { today: "2026-09-12" })!
        .summary.total,
    ).toBe(100);
  });

  it("주 버킷은 저장된 `anchor_week` 다 — 09-11(금) 회차도 09-07 주에 들어간다", () => {
    const jobs: AnchoredJob[] = [
      ...TWO_ROUNDS,
      anchored("r0", {
        count: 2,
        roundDate: "2026-08-31",
        anchorWeek: "2026-08-31",
        measuredOrig: "2026-08-31T09:00:00Z",
      }),
    ];
    const out = aggregateMentionsFrom(jobs, NO_PROMPTS, {}, { today: "2026-09-12" })!;
    expect(out.trend?.points.map((p) => p.week)).toEqual(["2026-08-31", "2026-09-07"]);
    // 09-07 주 = 1회차 대표 3 + 1회차 패자 1 + 2회차 둘 10+30 (추이는 스냅샷 밖 행도 센다).
    expect(out.trend?.points[1]?.Hyundai).toBe(44);
  });

  it("`anchorAxis: false` 를 명시하면 필드가 실려 있어도 종전 축이다", () => {
    const out = aggregateMentionsFrom(
      TWO_ROUNDS,
      NO_PROMPTS,
      {},
      { anchorAxis: false, today: "2026-09-12" },
    )!;
    // dedup 이 없으므로 네 건 전부 계상된다: 1 + 3 + 10 + 30.
    expect(out.summary.total).toBe(44);
    expect(out.perBrandPrompts.Hyundai?.[0]?.answers[0]?.runs).toBe(4);
    // 기준일은 접힌 measured_at 의 최대값(ISO).
    expect(out.asOf).toBe("2026-09-11T00:00:00Z");
  });

  it("앵커 미투영(종전 축) 입력은 종전 그대로 — 전 건 계상", () => {
    const jobs = [
      plain("a", "2026-09-07T01:00:00Z", 1),
      plain("b", "2026-09-07T09:00:00Z", 3),
    ];
    const out = aggregateMentionsFrom(jobs, NO_PROMPTS)!;
    expect(out.summary.total).toBe(4);
    expect(out.asOf).toBe("2026-09-07T09:00:00Z");
  });
});

describe("앵커 축 — 주 버킷 폴백", () => {
  it("buildMentionTrend — `week` 가 실리면 그것이 이기고, 없으면 date 계산", () => {
    const trend = buildMentionTrend(
      [
        // week 를 싣지 않은 행: 2026-09-11(금) → 계산상 그 주 월요일 09-07.
        { date: "2026-09-11T02:00:00Z", brand: "Hyundai", count: 1 },
        // week 를 실은 행: 계산값과 다른 주를 일부러 준다 — 실린 값이 이겨야 한다.
        { date: "2026-09-11T02:00:00Z", brand: "Hyundai", count: 5, week: "2026-08-31" },
      ],
      ["Hyundai"],
    );
    expect(trend?.points).toEqual([
      { week: "2026-08-31", Hyundai: 5 },
      { week: "2026-09-07", Hyundai: 1 },
    ]);
  });
});
