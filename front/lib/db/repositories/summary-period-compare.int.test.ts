// 기간 비교 리더 — 실 DB(**읽기 전용**) 실행 검증. `DATABASE_URL` 이 있을 때만 돈다.
//   DATABASE_URL=... npx vitest run lib/db/repositories/summary-period-compare.int.test.ts
//
// 컴파일 텍스트 테스트가 못 잡는 것을 본다: 배열 파라미터가 실 DB 에서 바인딩되는가,
// 날짜 캐스트가 42883 없이 파싱되는가, 그리고 **골든이 재현되는가**.
// 값 대조가 여기 있는 이유는 2026-09-16 사고다 — 단위 테스트는 SQL 경로를 안 탄다.
//
// ⚠️ 골든은 `E = 2026-09-13`(글로벌) 시점의 라이브 값이다. 새 회차가 공개되면 `E` 가
//    앞으로 가므로 창이 달라진다 — 그래서 **창을 고정해** 읽고, `E` 해소는 형태만 본다.
import { describe, expect, it } from "vitest";
import {
  readComparePeriods,
  resolveWindowEnd,
  type ComparePeriodWindow,
} from "./summary-period-compare";
import {
  computeCompare,
  resolveWindows,
  windowKey,
  type ComparePeriod,
} from "@/lib/kpi/period-compare";
import type { StandardFilters } from "@/lib/scope/result-adapter";

/**
 * 리더는 **배열**을 돌려준다(캐시 직렬화를 견디려고 — `readComparePeriods` 머리 주석).
 * 키로 찾는 이 테스트들만 여기서 Map 으로 접는다. 게이트웨이도 같은 일을 **캐시 경계
 * 밖에서** 한다(`lib/scope/server.ts::fetchPeriodCompare`).
 */
const byKey = (rows: ComparePeriod[] | null) => new Map((rows ?? []).map((r) => [r.key, r]));

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

const ROOT = process.env.SCOPE_ROOT_PROJECT_ID ?? "be28fe15-c743-4a88-abb8-182b25602812";
const E = "2026-09-13"; // 골든 시점의 글로벌 끝점

const windowsFor = (days: number): ComparePeriodWindow[] => {
  const { cur, prev } = resolveWindows(E, days);
  return [
    { key: windowKey(prev), ...prev },
    { key: windowKey(cur), ...cur },
  ];
};

const globalScope = (days: number, family: "mention" | "citation") => ({
  surface: "global" as const,
  projectIds: [ROOT],
  filters: {} as StandardFilters,
  ownVariant: "ALL",
  ownedBasePrefixes: [],
  family,
  windows: windowsFor(days),
});

d("기간 비교 리더 (실 DB, 읽기 전용)", () => {
  it("`E` 해소는 UTC 일 또는 null 이다(표면별)", async () => {
    for (const surface of ["global", "website"] as const) {
      const end = await resolveWindowEnd(surface, surface === "global" ? [ROOT] : []);
      if (end !== null) expect(end).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    // 프로젝트 id 가 없으면 해소 불가 → null(호출부는 오늘로 폴백).
    expect(await resolveWindowEnd("global", [])).toBe(null);
  });

  it("문장 2개로 두 구간을 채운다 — 골든 G1(7일, 언급 계열)", async () => {
    const periods = await readComparePeriods(globalScope(7, "mention"));
    expect(periods).not.toBe(null);
    const ws = windowsFor(7);
    const prev = byKey(periods).get(ws[0]!.key)!;
    const cur = byKey(periods).get(ws[1]!.key)!;
    expect(prev).toBeTruthy();
    expect(cur).toBeTruthy();
    console.log(
      `[int] G1 prev=${JSON.stringify(prev.measures.visibility)} cur=${JSON.stringify(cur.measures.visibility)}`,
    );
    // 라이브 실측(2026-09-18): 24,336/37,570 vs 56,033/75,138.
    expect(prev.measures.visibility).toEqual({ numerator: 24336, denominator: 37570 });
    expect(cur.measures.visibility).toEqual({ numerator: 56033, denominator: 75138 });
    expect(prev.ledger.publishedCycles).toBe(1);
    expect(cur.ledger.publishedCycles).toBe(2);
    // ⚠️ design §9 G4 는 글로벌 첫 앵커를 `2026-06-07` 로 적었는데 그것은 **구조 게이트 없는**
    // 원장 min 이다. `F` 는 **값이 볼 수 있는** 첫 회차여야 하므로 프로브(in_root_catalog·
    // in_tagged_region·in_full_cycle)를 통과한 `2026-07-02` 다(2026-09-18 독립 SQL 재확인).
    // 06-07·06-14 회차는 집계층에 기여 행이 없어 원장 자체에서도 빠진다.
    expect(prev.ledger.firstPublishedAnchor).toBe("2026-07-02");

    const [r] = computeCompare(prev, cur, { kind: "window", days: 7, metrics: ["visibility"] });
    expect(r!.delta!).toBeCloseTo(9.7984, 4);
    expect(r!.reason).toBe(null);
  });

  it("골든 G2(14일) — `hidden_scope='citations'` 회차가 언급 계열에 **남는다**", async () => {
    const periods = await readComparePeriods(globalScope(14, "mention"));
    const ws = windowsFor(14);
    const prev = byKey(periods).get(ws[0]!.key)!;
    expect(prev.measures.visibility).toEqual({ numerator: 14234, denominator: 19536 });
    expect(prev.ledger.publishedCycles).toBe(3); // 08-18 · 08-19 · 08-25(숨김 회차 포함)
  });

  it("골든 G2(14일) — 인용 계열은 그 회차를 **뺀다**", async () => {
    const periods = await readComparePeriods(globalScope(14, "citation"));
    const ws = windowsFor(14);
    const prev = byKey(periods).get(ws[0]!.key)!;
    const cur = byKey(periods).get(ws[1]!.key)!;
    // 분모가 언급 계열(19,536)보다 작아야 한다 = 숨김 회차가 빠졌다.
    expect(prev.measures.citationsPerAnswer!.denominator).toBe(9886);
    const [r] = computeCompare(prev, cur, {
      kind: "window",
      days: 14,
      metrics: ["citationsPerAnswer"],
    });
    expect(r!.prev!).toBeCloseTo(14.8635, 3);
    expect(r!.cur!).toBeCloseTo(5.3553, 3);
    // 언급 계열 지표는 인용 읽기에 실리지 않는다(두 벌의 ①을 만들지 않는다).
    expect(prev.measures.visibility).toBeUndefined();
  });

  it("골든 G3(30일) — 직전 창 누락 40.846% 로 억제된다", async () => {
    const periods = await readComparePeriods(globalScope(30, "mention"));
    const ws = windowsFor(30);
    const prev = byKey(periods).get(ws[0]!.key)!;
    const cur = byKey(periods).get(ws[1]!.key)!;
    expect(prev.ledger.missingUnits / prev.ledger.plannedUnits).toBeCloseTo(0.40846, 5);
    const [r] = computeCompare(prev, cur, { kind: "window", days: 30, metrics: ["visibility"] });
    expect(r!.reason).toBe("missing_share");
    expect(r!.delta).toBe(null);
  });

  it("골든 G4(1년) — 직전 창에 회차가 0이라 no_prev", async () => {
    const periods = await readComparePeriods(globalScope(365, "mention"));
    const ws = windowsFor(365);
    const prev = byKey(periods).get(ws[0]!.key)!;
    const cur = byKey(periods).get(ws[1]!.key)!;
    expect(prev.ledger.publishedCycles).toBe(0);
    const [r] = computeCompare(prev, cur, { kind: "window", days: 365, metrics: ["visibility"] });
    expect(r!.reason).toBe("no_prev");
  });

  it("구간이 3개여도(달력 월 대비) 같은 리더가 받는다", async () => {
    const periods = await readComparePeriods({
      ...globalScope(7, "mention"),
      windows: [
        { key: "2026-07", lo: "2026-07-01", hi: "2026-07-31" },
        { key: "2026-08", lo: "2026-08-01", hi: "2026-08-31" },
        { key: "2026-09", lo: "2026-09-01", hi: "2026-09-30" },
      ],
    });
    expect(periods).not.toBe(null);
    expect([...byKey(periods).keys()].sort()).toEqual(["2026-07", "2026-08", "2026-09"]);
    for (const p of periods!) expect(p.ledger.plannedUnits).toBeGreaterThanOrEqual(0);
  });

  it("프로젝트 표면은 모수가 없어 null 또는 빈 결과로 떨어진다(폴백)", async () => {
    expect(await readComparePeriods({ ...globalScope(7, "mention"), projectIds: [] })).toBe(null);
  });
});

d("함대 앵커 분포 (Q4 로그 입력)", () => {
  it("웹사이트 함대의 최신 앵커가 몇 가지인지 함께 낸다", async () => {
    const { resolveWindowEndInfo } = await import("./summary-period-compare");
    const info = await resolveWindowEndInfo("global", [ROOT]);
    expect(info.fleet).toBe(1);
    expect(info.distinctAnchors).toBe(1); // 루트 1개 = 언제나 1
    if (info.end) expect(info.end).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    console.log(`[int] global anchor info = ${JSON.stringify(info)}`);
  });

  it("프로젝트가 없으면 0/0/null (호출부는 오늘로 폴백)", async () => {
    const { resolveWindowEndInfo } = await import("./summary-period-compare");
    expect(await resolveWindowEndInfo("website", [])).toEqual({
      end: null,
      fleet: 0,
      distinctAnchors: 0,
    });
  });
});
