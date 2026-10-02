// 키 off 문장의 **스냅샷** — 커밋을 가로질러 "종전과 같다" 를 고정한다 (2026-09-20).
//
// ── 왜 sql-shape.test 의 ①' 로는 부족한가 ──────────────────────────────────
// ①' 는 **같은 커밋 안에서** "유닛을 넘겼을 때 vs 안 넘겼을 때" 를 비교한다. 그것은
// "인자가 무해하다" 는 증명이지 **"종전 배포와 같다" 는 증명이 아니다** — 리팩터로
// 템플릿 들여쓰기나 주석이 바뀌면 양쪽 다 새 텍스트라 통과한다.
//
// 실제로 그 틈으로 나갔다(2026-09-20 독립 검증 A): 기반 커밋에서
// `aggregateWebsiteTargetHitRate` 의 off 문장에 **빈 줄 1 + `--` 주석 3줄**이 들어가
// 77111d0 대비 바이트가 갈렸다. 값·바인드는 같았지만 `pg_stat_statements` 의 queryid 와
// 서버측 plan cache 항목이 한 번 갈린다. 그 델타를 텍스트로 박아 두면 다음 사람이
// 같은 실수를 할 때 **diff 로 보인다**.
//
// 운용: off 문장을 **의도적으로** 바꿀 때만 `-u` 로 갱신하고, 그 커밋에서 왜 바꿨는지를
// 적는다. 갱신 없이 이 파일이 실패하면 off 경로가 의도치 않게 움직인 것이다.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { WebsiteOwnedUnit } from "@/lib/scope/website-owned-unit";
import {
  setWebsiteOwnedUnitForTests,
  resetWebsiteOwnedUnitForTests,
} from "@/lib/scope/website-owned-unit-state";

const dialect = new PgDialect();
const captured: string[] = [];
let stubRows: unknown[] = [];
const execute = vi.fn(async (q: SQL) => {
  try {
    captured.push(dialect.sqlToQuery(q).sql);
  } catch {
    /* raw SET 등 */
  }
  return stubRows as unknown as never;
});
vi.mock("@/lib/db", () => ({
  getDb: () => ({
    execute,
    transaction: async (fn: (t: unknown) => unknown) => fn({ execute }),
  }),
}));

const PIDS = ["11111111-1111-1111-1111-111111111111"];
const BASES = ["kia.com/kr"];
/** 넘겨도 키가 꺼져 있으면 **무시돼야 하는** 유닛(①' 와 같은 취지를 스냅샷으로도 고정). */
const UNITS: WebsiteOwnedUnit[] = [
  { siteId: "22222222-2222-2222-2222-222222222222", fileSeq: 66,
    base: "kia.com/kr", sibs: ["kia.com/kr/en"], homeHost: null },
];

/** 빈 결과 조기 반환을 지나가게 하는 최소 행(값은 스냅샷에 들어가지 않는다). */
const STUB_ROW = {
  region: "KR", answers: 1, tracked: 1, last_measured_at: null,
  domain: "kia.com", category: null, target: "chatgpt",
  citations: 1, owned: true, owned_citations: 1,
  prompt_id: "44444444-4444-4444-4444-444444444444",
  job_id: "55555555-5555-5555-5555-555555555555",
  url: "https://kia.com/kr", cites: 1, bucket_total: 1, targets: ["chatgpt"],
  day: "2026-09-11", key: "kia.com", n: 1,
  total: 1, with_cit: 1, bucket: "2026-09-08",
  measured_prompts: 1, hit_prompts: 1, owned_prompts: 1,
  owned_answers: 1, target_answers: 1, measured_days: 1, first_at: null, last_at: null,
};

type Mod = typeof import("./scope-aggregates");
const SITES: Array<[string, (m: Mod, u?: WebsiteOwnedUnit[]) => Promise<unknown>]> = [
  ["코어 ⑤", (m, u) => m.aggregateStandardFromMirror({}, PIDS, BASES, BASES, true, undefined, u)],
  ["Sub KPI Q4", (m, u) => m.aggregateSubKpisFromMirror({}, PIDS, BASES, BASES, true, {}, u)],
  ["⑤ 추이", (m, u) => m.aggregateStandardTrendFromMirror({}, "week", PIDS, BASES, BASES, true, undefined, u)],
  ["인용 화면", (m, u) => m.aggregateCitationsFromMirror({}, PIDS, BASES, BASES, true, undefined, u)],
  ["출처 구성", (m, u) => m.aggregateSourceCompositionFromMirror({}, PIDS, BASES, u)],
  ["⑥ 카드", (m, u) => m.aggregateWebsiteCitationAccuracy({}, PIDS, BASES, BASES, u)],
  ["⑥ 추이", (m, u) => m.aggregateWebsiteCitationAccuracyTrend({}, "week", PIDS, BASES, BASES, u)],
  ["자사·타겟 URL 인용률", (m, u) => m.aggregateWebsiteTargetHitRate({}, PIDS, BASES, BASES, u)],
];

beforeAll(async () => {
  const m = await import("./scope-aggregates");
  m.answerWhere({}, undefined);
  await new Promise((r) => setTimeout(r, 50));
});

beforeEach(() => {
  resetWebsiteOwnedUnitForTests();
  stubRows = [STUB_ROW];
});

afterEach(() => {
  resetWebsiteOwnedUnitForTests();
  stubRows = [];
});

async function offStatements(
  call: (m: Mod, u?: WebsiteOwnedUnit[]) => Promise<unknown>,
  units?: WebsiteOwnedUnit[],
): Promise<string[]> {
  setWebsiteOwnedUnitForTests(false);
  const m = await import("./scope-aggregates");
  // 모듈 메모(프로브·판정)가 첫 호출에서만 문장을 내므로 예열 후 두 번째를 본다.
  await call(m, units);
  captured.length = 0;
  await call(m, units);
  return captured.slice();
}

describe("키 off 문장 스냅샷 — 커밋을 가로질러 고정한다", () => {
  it.each(SITES)("%s", async (name, call) => {
    const off = await offStatements(call);
    expect(off.join("\n\n/* ── 다음 문장 ── */\n\n")).toMatchSnapshot(name);
  });

  it("유닛을 넘겨도 키가 꺼져 있으면 같은 스냅샷이다", async () => {
    for (const [name, call] of SITES) {
      expect(await offStatements(call, UNITS), name).toEqual(await offStatements(call));
    }
  });
});
