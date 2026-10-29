// 글로벌(S1) 사실표 조회 경로 — 실 DB(read-only) 실행 검증. DATABASE_URL 이 있을 때만 돈다.
//   DATABASE_URL=... npx vitest run lib/db/repositories/summary-global-aggregates.int.test.ts
//
// 값 대조가 아니라 **실행 가능성**을 본다: 컴파일된 SQL 이 Postgres 에서 파싱·실행되고,
// 회차 행이 없을 때 판정이 폴백으로 떨어지며, 사실표가 비었을 때 반환 형태가 미러
// 경로와 같은지(0/NULL). 값 동치는 §9-1 패리티 게이트의 몫이다.
//
// 웹사이트판(summary-website-aggregates.int.test.ts)과 같은 자세이고, 글로벌만의
// 함정을 하나 더 본다: **배열 파라미터가 실 DB 에서 바인딩되는가**. 컴파일 텍스트
// 테스트는 `cannot cast type record to …` 를 못 잡는다(2026-09-06 실증) —
// 여기 격자에 `region`(country = ANY)·`brand`(catalog_brands &&)·숨김 국가
// (country <> ALL) 세 배열 축을 전부 태운다.
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  summaryGlobalAggregates,
  summaryGlobalSubKpis,
  summaryGlobalPromptTopics,
  summaryGlobalSourceComposition,
  summaryGlobalGeoCompetition,
} from "./summary-global-aggregates";
import { pickGlobalCycle, hasOpenCycle } from "./summary-cycles";
import { readEnabled, summaryLedgerAvailable } from "./summary-settings";
import {
  resolveGlobalSummaryRoute,
  summaryRouteHeaderValue,
} from "@/lib/summary/read/gate";

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

// 루트 = scope 표준 루트 프로젝트. env 가 있으면 그것을, 없으면 8/31 회차의 루트를
// 쓴다(설계 §8-1 — 백필 대상 회차의 프로젝트 id).
const ROOT =
  process.env.SCOPE_ROOT_PROJECT_ID ?? "be28fe15-c743-4a88-abb8-182b25602812";

d("summary 글로벌 조회 경로 (실 DB)", () => {
  it("스위치·원장 프로브는 boolean 을 돌려준다(실패·미적용은 false = 폴백)", async () => {
    const enabled = await readEnabled();
    expect(typeof enabled).toBe("boolean");
    expect(typeof (await summaryLedgerAvailable())).toBe("boolean");
    console.log(`[int] summary read_enabled = ${enabled}`);
  });

  it("루트 회차 선택은 회차 1개 또는 null (생성 전이면 null = 폴백)", async () => {
    const picked = await pickGlobalCycle(ROOT);
    if (picked) {
      expect(picked.projectId).toBe(ROOT);
      expect(picked.cycleId).toMatch(/^[0-9a-f-]{36}$/);
      expect(picked.generationId).toMatch(/^[0-9a-f-]{36}$/);
      expect(picked.cycleWeek).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      console.log(
        `[int] global cycle ${picked.cycleId} anchor=${picked.cycleAnchorAt} week=${picked.cycleWeek}`,
      );
    } else {
      console.log("[int] global cycle 없음 — 생성기 미적재(폴백 경로)");
      expect(picked).toBeNull();
    }
  });

  it("uuid 가 아닌 루트 id(mock 모드)는 DB 를 때리지 않고 null", async () => {
    expect(await pickGlobalCycle("mock-root-project")).toBeNull();
  });

  it("게이트 전체가 실 DB 에서 판정된다 — 사유는 항상 구분 가능해야 한다", async () => {
    const route = await resolveGlobalSummaryRoute(ROOT, {}, "S1.dashboard");
    const header = summaryRouteHeaderValue(route);
    console.log(`[int] x-hmg-summary(global) = ${header}`);
    // 지금 이 DB 상태에서 나올 수 있는 값의 전체 집합. "그 외" 가 나오면 판정이
    // 새로 생긴 것이므로 테스트가 알려줘야 한다.
    // 열린 회차가 있으면 `hit open-cycle`(관측 꼬리표)이다 — 더 이상 newer-runs
    // 폴백도, `measuring:<pct>%` 진척도 아니다(배지 제거, 운영 2026-09-10).
    expect(
      header === "hit" ||
        header === "hit open-cycle" ||
        [
          "fallback:disabled",
          "fallback:screen-not-allowed",
          "fallback:ledger-unavailable",
          "fallback:missing-cycle",
        ].includes(header),
    ).toBe(true);
  });

  it("미지원 축은 DB 를 보기 전에 폴백 사유를 낸다", async () => {
    expect(
      summaryRouteHeaderValue(await resolveGlobalSummaryRoute(ROOT, { cumulative: true }, "S1.dashboard")),
    ).toBe("fallback:cumulative");
    expect(
      summaryRouteHeaderValue(
        await resolveGlobalSummaryRoute(ROOT, { websiteCountry: ["worldwide"] }, "S1.dashboard"),
      ),
    ).toBe("fallback:unsupported-filter:website-country");
  });

  it("열린 회차 관측은 불리언 — 없는 회차 id 는 false(폴백이 아니다)", async () => {
    // 없는 회차 id → bound 가 NULL 이라 "회차 밖 최신 run" 을 정의할 수 없다 = false.
    expect(
      await hasOpenCycle([ROOT]),
    ).toBe(false);
    // 인자가 비면 DB 를 보지 않고 false.
    expect(await hasOpenCycle([])).toBe(false);
  });

  it("[int] 실 DB 열린 회차 관측 — 값을 로그로 남긴다", async () => {
    const cycle = await pickGlobalCycle(ROOT);
    if (!cycle) return;
    const open = await hasOpenCycle([cycle.projectId]);
    console.log(`[int] openRuns = ${open}`);
    expect(typeof open).toBe("boolean");
  });

  it("사실표가 비어 있어도 5개 읽기가 전부 실행되고 형태가 미러와 같다", async () => {
    const scope = {
      // 존재하지 않는 회차 — 사실표 행 0건 경로.
      cycle: {
        cycleId: "00000000-0000-0000-0000-000000000001",
        generationId: "00000000-0000-0000-0000-000000000002",
        projectId: ROOT,
        cycleAnchorAt: "2026-08-31T00:00:00.000Z",
        cycleWeek: "2026-08-31",
      },
      rootProjectId: ROOT,
      // 배열 축을 전부 태운다(record 캐스트 함정 확인).
      filters: {
        region: ["KR", "US"],
        lang: ["ko"],
        engine: ["chatgpt"],
        brand: ["Hyundai", "HMG"],
        depth1: ["EV"],
      },
      ownedBasePrefixes: ["https://www.hyundai.com/kr/ko/", "kia.com/my"],
    };
    // 모수 0 → null (미러 경로의 `totalAnswers === 0 → null` 과 같은 형태).
    expect(await summaryGlobalAggregates(scope)).toBeNull();
    expect(await summaryGlobalSubKpis(scope)).toEqual({
      rows: [],
      promptsWithoutBrand: null,
      measuredPrompts: null,
    });
    expect(await summaryGlobalPromptTopics(scope)).toEqual([]);
    expect(await summaryGlobalSourceComposition(scope)).toEqual([]);
    expect(await summaryGlobalGeoCompetition(scope)).toEqual([]);
  }, 60_000); // 전체 스위트 병렬 실행(실 DB int + 외부 부하)에서 2.6 s 짜리가 5 s 기본 타임아웃을 넘긴 flake(2026-09-10 게이트) — 단독 실행은 통과

  it("무필터(admin)·브랜드 락 두 슬라이스도 실행된다 — 배열이 비었을 때 포함", async () => {
    const base = {
      cycle: {
        cycleId: "00000000-0000-0000-0000-000000000001",
        generationId: "00000000-0000-0000-0000-000000000002",
        projectId: ROOT,
        cycleAnchorAt: "2026-08-31T00:00:00.000Z",
        cycleWeek: "2026-08-31",
      },
      rootProjectId: ROOT,
      ownedBasePrefixes: [] as string[], // $sel 공집합 → owned 판정 false 분기
    };
    expect(await summaryGlobalAggregates({ ...base, filters: {} })).toBeNull();
    expect(
      await summaryGlobalSourceComposition({ ...base, filters: {} }),
    ).toEqual([]);
    expect(
      await summaryGlobalGeoCompetition({
        ...base,
        filters: { brand: ["Genesis", "HMG"], brandPresence: ["unbranded"] },
      }),
    ).toEqual([]);
  });

  it("실제 회차가 있으면 그 회차로 5개 읽기가 돌고 값 형태가 계약대로다", async () => {
    const picked = await pickGlobalCycle(ROOT);
    if (!picked) {
      console.log("[int] 회차 미적재 — 값 검증 skip(형태 검증은 위 케이스가 담당)");
      return;
    }
    const scope = {
      cycle: picked,
      rootProjectId: ROOT,
      filters: {},
      ownedBasePrefixes: ["https://www.hyundai.com/kr/ko/"],
    };
    const agg = await summaryGlobalAggregates(scope);
    // 회차가 있는데 모수가 0 이면 그것도 정보다 — 그대로 기록하고 형태만 본다.
    if (!agg) {
      console.log("[int] 회차는 있으나 사실표 행 0건");
      return;
    }
    expect(agg.totalAnswers).toBeGreaterThan(0);
    // asOf = 회차 anchor(P3).
    expect(agg.asOf).toBe(picked.cycleAnchorAt);
    // 가산성: 지역 롤업 합 = 총합.
    expect(agg.regions.reduce((s, r) => s + r.answerCount, 0)).toBe(agg.totalAnswers);
    expect(agg.regions.reduce((s, r) => s + r.trackedAnswerCount, 0)).toBe(
      agg.trackedAnswerCount,
    );
    // ① 분자 ≤ 분모.
    expect(agg.trackedAnswerCount).toBeLessThanOrEqual(agg.totalAnswers);
    // ⑤ 분자 ≤ 분모.
    expect(agg.citations.ownedCitations).toBeLessThanOrEqual(agg.citations.totalCitations);
    // 숨김 국가는 모수에 없다.
    expect(agg.regions.map((r) => r.region)).not.toContain("ID");

    const sub = await summaryGlobalSubKpis(scope);
    for (const row of sub.rows) {
      expect(row.tracked).toBeLessThanOrEqual(row.answers);
      expect(row.top3).toBeGreaterThanOrEqual(row.top1);
      expect(row.trackedMentions).toBeLessThanOrEqual(row.totalMentions);
      expect(row.citOwned).toBeLessThanOrEqual(row.citTotal);
    }
    // 엔진별 답변 수 합 = 총 답변 수(같은 모수).
    expect(sub.rows.reduce((s, r) => s + r.answers, 0)).toBe(agg.totalAnswers);

    const topics = await summaryGlobalPromptTopics(scope);
    expect(Array.isArray(topics)).toBe(true);

    const src = await summaryGlobalSourceComposition(scope);
    if (src.length) {
      // ⚠️ **반올림된 share 를 더하면 100 이 되지 않는다.** 종전 단언(`|Σshare − 100| < 2`)은
      // 이 케이스가 vitest 기본 5s 타임아웃에 가려 한 번도 끝까지 안 돌았기 때문에 살아
      // 있었다(실측 7.6 s). 2026-09-10 실측: 도메인 10,823개 중 **10,588개가 0.0% 로 접히고**
      // (그 안에 인용 73,042/189,217 = 38.6%), Σ(반올림 share) = 65.1 → 손실 34.9pp.
      // 이건 집계 결함이 아니라 긴 꼬리 + 소수 1자리 반올림의 성질이다. 계약으로 고정할 것은
      // ① 정규화되지 않은 비율의 합이 100 ② 각 행의 share 가 그 비율의 반올림값, 두 가지다.
      // (화면이 '기타' 를 만들 때는 share 가 아니라 citations 로 계산해야 한다.)
      const total = src.reduce((s, r) => s + r.citations, 0);
      expect(total).toBeGreaterThan(0);
      const exact = src.reduce((s, r) => s + (100 * r.citations) / total, 0);
      expect(Math.abs(exact - 100)).toBeLessThan(0.01);
      for (const r of src) {
        expect(r.share).toBe(Math.round((1000 * r.citations) / total) / 10);
      }
      const rounded = src.reduce((s, r) => s + r.share, 0);
      console.log(
        `[int] source composition: 도메인 ${src.length}개 · 인용 ${total} · ` +
          `Σ(반올림 share)=${rounded.toFixed(1)} (반올림 손실 ${(100 - rounded).toFixed(1)}pp)`,
      );
    }

    const geo = await summaryGlobalGeoCompetition(scope);
    expect(Array.isArray(geo)).toBe(true);
    // 타임아웃 60s — 실측 7.6 s(2026-09-10, ap-south-1 세션 모드). vitest 기본 5 s 로는
    // 이 케이스가 **회차가 실렸을 때만** 터지는데, 회차 미적재 환경에서는 조기 return 이라
    // 초록으로 보인다(= 실 DB 회귀가 CI 에서 조용히 숨는다).
  }, 60_000);
});

// 사실표에 회차가 실렸을 때 모수 계약(셀당 1건)이 지켜지는지 — 조회 계층이
// 의존하는 성질이라 여기서 직접 단언한다(§3-3 `summary_cycle_jobs` UNIQUE).
d("summary 글로벌 모수 계약 (실 DB)", () => {
  it("한 회차 안에서 (prompt, engine, country) 는 job 1개다", async () => {
    const picked = await pickGlobalCycle(ROOT);
    if (!picked) return;
    const rows = (await getDb().execute(sql`
      SELECT count(*)::int AS dup FROM (
        SELECT prompt_id, engine, country, count(*) c
        FROM summary_answers
        WHERE cycle_id = ${picked.cycleId}::uuid AND generation_id = ${picked.generationId}::uuid
        GROUP BY 1, 2, 3 HAVING count(*) > 1
      ) t
    `)) as unknown as Array<{ dup: number }>;
    expect(Number(rows[0]?.dup ?? 0)).toBe(0);
  });
});
