// 사실표 조회 경로 — 실 DB(read-only) 실행 검증. DATABASE_URL 이 있을 때만 돈다.
//   DATABASE_URL=... npx vitest run lib/db/repositories/summary-website-aggregates.int.test.ts
//
// 값 대조가 아니라 **실행 가능성**을 본다: 컴파일된 SQL 이 Postgres 에서 파싱·실행되고,
// 회차 행이 없을 때 판정이 폴백으로 떨어지며, 사실표가 비었을 때 반환 형태가 미러
// 경로와 같은지(0/NULL). 데이터가 들어오기 전에 확인할 수 있는 것이 여기까지다 —
// 값 동치는 §9-1 패리티 게이트의 몫이다.
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  summaryWebsiteAggregates,
  summaryWebsiteSubKpis,
  summaryWebsitePromptTopics,
  summaryWebsiteSourceComposition,
  summaryWebsiteGeoCompetition,
  summaryWebsiteCitationAccuracy,
} from "./summary-website-aggregates";
import { pickWebsiteCycles, hasOpenCycle } from "./summary-cycles";
import {
  readEnabled,
  summaryLedgerAvailable,
  summaryUnitFlagsAvailable,
} from "./summary-settings";

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

async function someWebsiteProjects(limit = 3): Promise<string[]> {
  const rows = (await getDb().execute(sql`
    SELECT DISTINCT scope_project_id::text AS id FROM website_sites
    WHERE scope_project_id IS NOT NULL LIMIT ${limit}
  `)) as unknown as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

d("summary 조회 경로 (실 DB)", () => {
  it("킬스위치는 기본 off — 원장이 적용돼 있어도 조회는 폴백", async () => {
    const enabled = await readEnabled();
    expect(typeof enabled).toBe("boolean");
    // 2026-09-06 read_enabled='1' 로 전환됨(PR #218 배포 후). 값은 운영 스위치라 단언하지
    // 않고 기록만 한다 — 어느 쪽이든 아래 쿼리들은 실행돼야 한다.
    console.log(`[int] summary read_enabled = ${enabled}`);
  });

  it("원장 프로브는 표 유무를 그대로 답한다(없으면 false = 폴백)", async () => {
    expect(typeof (await summaryLedgerAvailable())).toBe("boolean");
  });

  it("회차가 하나도 없으면 null, 일부만 있으면 그 집합 + missingProjectIds", async () => {
    const ids = await someWebsiteProjects();
    expect(ids.length).toBeGreaterThan(0);
    const picked = await pickWebsiteCycles(ids);
    // 생성기가 아직 안 돌았으면 null. 돌았으면 회차 있는 것만 + 나머지는 missing.
    if (picked) {
      expect(picked.cycles.length).toBeGreaterThan(0);
      expect(picked.cycles.length + picked.missingProjectIds.length).toBe(
        new Set(ids).size,
      );
    } else expect(picked).toBeNull();
  });

  it("열린 회차 관측은 불리언 — 실패·미정의는 false(폴백 사유가 아니다)", async () => {
    const ids = await someWebsiteProjects(1);
    const open = await hasOpenCycle(ids);
    expect(open).toBe(false);
  });

  it("사실표가 비어 있어도 6개 쿼리가 전부 실행되고 형태가 미러와 같다", async () => {
    const ids = await someWebsiteProjects();
    const scope = {
      // 존재하지 않는 회차 — 사실표 행 0건 경로.
      cycles: [
        {
          cycleId: "00000000-0000-0000-0000-000000000001",
          generationId: "00000000-0000-0000-0000-000000000002",
          projectId: ids[0],
          cycleAnchorAt: "2026-09-04T00:00:00.000Z",
          cycleWeek: "2026-08-31",
        },
      ],
      projectIds: ids,
      filters: { lang: ["ko"], websiteCountry: ["KR"], engine: ["chatgpt"] },
      ownedBasePrefixes: ["https://www.hyundai.com/kr/ko/"],
      // 0060 적용 여부를 실측해서 그 경로로 돈다 — 두 경로 다 실행 가능해야 한다.
      unitFlags: await summaryUnitFlagsAvailable(),
      // 제외 유닛 술어(`report_fs <> ALL($1::int[])`)가 실 DB 에서 바인딩되는지 — 컴파일
      // 텍스트 테스트는 record 캐스트 오류를 못 잡았다(2026-09-06).
      excludedUnits: [71, 94, 97],
    };
    // 모수 0 → null (미러 경로의 `totalAnswers === 0 → null` 과 같은 형태).
    expect(await summaryWebsiteAggregates(scope)).toBeNull();
    // 집계층 read 는 `SummaryTrendRead` 다(PR③ R3). 이 회차는 **존재하지 않으므로**
    // 모수 표(own)가 0행 = 접기 미실행 신호 → `empty`. 게이트가 세부층으로 돌린다.
    expect(await summaryWebsiteSubKpis(scope)).toEqual({ empty: true });
    expect(await summaryWebsitePromptTopics(scope)).toEqual([]);
    // 출처 도넛은 `only:["domains"]` 라 모수 표가 없다 — 신호를 못 내고 빈 값을 낸다
    // (그 경로의 접힘 판정은 셀 밖 `trendFoldPresent` 프로브가 전담한다 · R1).
    expect(await summaryWebsiteSourceComposition(scope)).toEqual({ empty: false, value: [] });
    expect(await summaryWebsiteGeoCompetition(scope)).toEqual([]);
    // 분모 0 → rate null ("측정 대기" ≠ 0%).
    expect(await summaryWebsiteCitationAccuracy(scope)).toEqual({
      ownedAnswers: 0,
      targetAnswers: 0,
      rate: null,
    });
  }, 60_000); // 전체 스위트 병렬 실행(실 DB int + 외부 부하)에서 5,407 ms 짜리가 5 s 기본
  //          타임아웃을 넘긴 flake(2026-09-11 게이트). 전례 `9b2cff9` 와 같은 처방 —
  //          이 케이스는 6문장을 순차로 태우므로 단독으로는 통과하지만 부하에서 흔들린다.
});
