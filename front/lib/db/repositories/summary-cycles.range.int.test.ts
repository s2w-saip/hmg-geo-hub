// 회차 **집합** 조회(`pickCyclesInRange`) — 실 DB(read-only) 실행 검증. PR② T9.
//   DATABASE_URL=... npx vitest run lib/db/repositories/summary-cycles.range.int.test.ts
//
// 왜 실 DB 가 필요한가: 이 문장의 위험은 **컴파일 텍스트로 안 보인다.**
//   · date/timestamp 바인드는 drizzle-orm/postgres-js 가 직렬화기를 항등함수로
//     덮어써 있어 형태에 따라 실행 시점에 죽는다(2026-09-10 `dateArray` 실증).
//   · `AT TIME ZONE 'UTC'` 경계가 실제로 UTC 일을 자르는지는 서버 TimeZone 이
//     걸린 문제라 텍스트로는 판정 불가다.
// 값 대조가 아니라 **실행 가능성과 경계 의미론**을 본다.
import { describe, expect, it } from "vitest";
import { pickCyclesInRange } from "./summary-cycles";
import { getDb } from "@/lib/db";
import { sql } from "drizzle-orm";

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

async function ledgerProjects(surface: "global" | "website"): Promise<string[]> {
  const rows = (await getDb().execute(sql`
    SELECT DISTINCT project_id::text AS id FROM summary_cycles WHERE surface = ${surface}
  `)) as unknown as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

d("pickCyclesInRange (실 DB)", () => {
  it("웹사이트 함대 전체 + 기간 — 실행되고 노출 가능 회차를 돌려준다", async () => {
    const ids = await ledgerProjects("website");
    expect(ids.length).toBeGreaterThan(0);
    const rows = await pickCyclesInRange({
      surface: "website",
      projectIds: ids,
      dateFrom: "2026-01-01",
      dateTo: "2026-12-31",
    });
    // null = 판정 불가. 여기서 null 이면 문장이 실 DB 에서 죽은 것이다.
    expect(rows).not.toBeNull();
    if (!rows) throw new Error("statement failed on live DB");
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.cycleAnchorAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(r.cycleWeek).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(typeof r.status).toBe("string");
      expect(typeof r.renderable).toBe("boolean");
      // renderable 의 정의가 generation 유무와 일관되어야 한다.
      if (r.renderable) expect(r.generationId).toBeTruthy();
    }
  });

  it("기간 없음 = 무한 범위 — 기간 준 것보다 적지 않다(상한 없음, D-2 (2))", async () => {
    const ids = await ledgerProjects("website");
    const all = await pickCyclesInRange({ surface: "website", projectIds: ids });
    const ranged = await pickCyclesInRange({
      surface: "website",
      projectIds: ids,
      dateFrom: "2026-01-01",
      dateTo: "2026-12-31",
    });
    expect(all).not.toBeNull();
    expect(ranged).not.toBeNull();
    expect((all ?? []).length).toBeGreaterThanOrEqual((ranged ?? []).length);
  });

  it("UTC 일 경계 — dateTo 는 그날을 **포함**한다(상계 반열림 `< to+1일`)", async () => {
    const ids = await ledgerProjects("website");
    const all = await pickCyclesInRange({ surface: "website", projectIds: ids });
    if (!all || all.length === 0) return; // 원장이 비었으면 볼 것이 없다
    const day = all[0]!.cycleAnchorAt.slice(0, 10);
    const sameDay = await pickCyclesInRange({
      surface: "website",
      projectIds: ids,
      dateFrom: day,
      dateTo: day,
    });
    expect(sameDay).not.toBeNull();
    expect((sameDay ?? []).length).toBeGreaterThan(0);
    for (const r of sameDay ?? []) expect(r.cycleAnchorAt.slice(0, 10)).toBe(day);

    // 하루 전으로 상계를 당기면 그 회차는 빠진다(경계가 실제로 작동한다).
    const prev = new Date(`${day}T00:00:00Z`);
    prev.setUTCDate(prev.getUTCDate() - 1);
    const before = await pickCyclesInRange({
      surface: "website",
      projectIds: ids,
      dateTo: prev.toISOString().slice(0, 10),
    });
    expect(before).not.toBeNull();
    for (const r of before ?? []) expect(r.cycleAnchorAt.slice(0, 10) < day).toBe(true);
  });

  it("표면이 갈린다 — 글로벌 조회에 웹사이트 회차가 섞이지 않는다", async () => {
    const gids = await ledgerProjects("global");
    if (gids.length === 0) return;
    const rows = await pickCyclesInRange({ surface: "global", projectIds: gids });
    expect(rows).not.toBeNull();
    const wids = new Set(await ledgerProjects("website"));
    for (const r of rows ?? []) expect(wids.has(r.projectId)).toBe(false);
  });

  it("uuid 가 아닌 모수는 DB 를 보지 않고 빈 범위", async () => {
    await expect(
      pickCyclesInRange({ surface: "global", projectIds: ["mock-root-project"] }),
    ).resolves.toEqual([]);
  });
});
