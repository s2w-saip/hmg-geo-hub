import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { CycleSet } from "@/lib/summary/read/cycle-set";

// ════════════════════════════════════════════════════════════════════════════
// 접힘 프로브의 **문장 형태**를 고정한다 (PR⑤ U1 수용 기준 ⑥)
// ════════════════════════════════════════════════════════════════════════════
//
// `summary-trend-fold.test.ts` 는 판정 규약(폴백·무예외)을 고정하고, 여기서는 그 판정을
// 만들어 내는 SQL 이 **쌍당 인덱스 프로브**인지를 고정한다. 둘을 가르는 이유는 한 줄로
// 회귀했던 전례 때문이다:
//
//   `SELECT DISTINCT cycle_id, generation_id FROM summary_trend_brands WHERE …`
//
// 이 형태는 "이 쌍이 있는가" 를 묻는데 PostgreSQL 에 loose index scan(skip scan)이
// 없어서 **그 쌍의 파티션 전체**를 훑는다 — 프로덕션 실측(2026-09-11, 읽기 전용 세션)
// 으로 회차 13쌍에 `rows=378,304` · `shared hit=38,301` · 477 ms 였고, 출력은 정수 3개다.
// 같은 판정을 쌍당 `EXISTS` 로 바꾸면 **0.54 ms · 159 buffers**(같은 인덱스,
// `summary_trend_*_gen`). 값·판정은 한 글자도 안 바뀐다.
//
// 그 비용이 **로그에 안 보인다**는 것이 이 테스트의 존재 이유다 — 프로브는 read 가
// 아니라 게이트라 `x-hmg-read` 계측 밖에 있었고(U3 가 그것을 고친다), 마커는 경계의
// 최댓값만 준다. 문장이 다시 스캔 형태로 돌아가도 화면은 "조금 느린" 상태로만 보인다.
// 그래서 기계로 박는다.

const captured: unknown[] = [];
const execute = vi.fn<[unknown], Promise<unknown>>();
vi.mock("@/lib/db", () => ({
  getDb: () => ({
    execute: (q: unknown) => {
      captured.push(q);
      return execute(q);
    },
  }),
}));

const { trendFoldPresent } = await import("./summary-trend-fold");

const dialect = new PgDialect();
const UUID = (n: number) => `${String(n).padStart(8, "0")}-0000-0000-0000-000000000000`;

const setOf = (pairs: Array<[number, number]>): CycleSet => ({
  surface: "global",
  mode: "period",
  cycles: pairs.map(([c, g]) => ({
    cycleId: UUID(c),
    generationId: UUID(g),
    projectId: UUID(9),
    cycleAnchorAt: "2026-09-04T00:00:00.000Z",
    cycleWeek: "2026-08-31",
  })),
  cycleKey: "k",
  projectIds: [UUID(9)],
  missingProjectIds: [],
  weeks: ["2026-08-31"],
  anchorCount: pairs.length,
});

beforeEach(() => {
  captured.length = 0;
  execute.mockReset();
  execute.mockResolvedValue([]);
});

/** 마지막으로 발행된 문장을 컴파일한다 — 공백은 한 칸으로 접고 소문자로 본다. */
async function compile(
  set: CycleSet,
  tables?: Parameters<typeof trendFoldPresent>[2],
): Promise<{ text: string; params: unknown[] }> {
  await trendFoldPresent("global", set, tables);
  const q = captured.at(-1) as SQL;
  const built = dialect.sqlToQuery(q);
  return { text: built.sql.replace(/\s+/g, " ").trim().toLowerCase(), params: built.params };
}

describe("trendFoldPresent — 문장 형태(쌍당 EXISTS)", () => {
  it("표마다 `count(*) FILTER (WHERE EXISTS …)` 한 부, `UNION ALL` 로 이어진다", async () => {
    const { text } = await compile(
      setOf([
        [1, 101],
        [2, 102],
      ]),
      ["own", "domains", "brands"],
    );
    expect([...text.matchAll(/count\(\*\) filter \(where exists \(/g)]).toHaveLength(3);
    expect([...text.matchAll(/ union all /g)]).toHaveLength(2);
    for (const t of ["summary_trend_own", "summary_trend_domains", "summary_trend_brands"]) {
      expect(text, t).toContain(`from ${t} x`);
    }
  });

  it("쌍 술어는 인덱스 컬럼 등치 2개 + surface 필터다(`summary_trend_*_gen` 을 탄다)", async () => {
    const { text } = await compile(setOf([[1, 101]]), ["own"]);
    expect(text).toContain("select 1 from summary_trend_own x where x.cycle_id = p.c and x.generation_id = p.g and x.surface =");
    // 쌍은 `unnest(uuid[], uuid[])` 한 벌에서 나온다 — 표마다 같은 파라미터를 참조한다.
    expect(text).toMatch(/from unnest\(\$\d+::uuid\[\], \$\d+::uuid\[\]\) as p\(c, g\)/);
  });

  it("**스캔 형태가 다시 들어오지 않는다** — `SELECT DISTINCT cycle_id, generation_id` 금지", async () => {
    const { text } = await compile(setOf([[1, 101]]), ["own", "domains", "brands"]);
    expect(text).not.toContain("select distinct cycle_id, generation_id");
    expect(text).not.toMatch(/\(cycle_id, generation_id\) in \(/);
  });

  it("surface 는 바인딩 파라미터다(문자열 삽입이 아니다)", async () => {
    const { text, params } = await compile(setOf([[1, 101]]), ["own"]);
    expect(text).not.toContain("'global'");
    expect(params).toContain("global");
  });

  it("중복 쌍은 SQL 로 안 넘어간다 — 분모(count)가 부풀면 오판이다", async () => {
    // 같은 쌍을 3번 넣는다. 판정의 분모는 `Set` 이라 2 인데, SQL 의 `count(*) FROM p`
    // 는 `unnest` 길이를 그대로 세므로 **같은 배열**에서 나와야 한다(§2-3 ⚠️ R1).
    const { params } = await compile(
      setOf([
        [1, 101],
        [1, 101],
        [2, 102],
        [1, 101],
      ]),
      ["own"],
    );
    const arrays = params.filter(Array.isArray) as string[][];
    expect(arrays).toHaveLength(2);
    for (const a of arrays) expect(a).toHaveLength(2);
    expect(arrays[0]).toEqual([UUID(1), UUID(2)]);
    expect(arrays[1]).toEqual([UUID(101), UUID(102)]);
  });

  it("같은 `(cycle_id, generation_id)` 가 아니면 접히지 않는다 — 쌍 단위로 dedup 한다", async () => {
    // cycle 은 같고 generation 이 다른 두 행은 **서로 다른 쌍**이다(재생성).
    const { params } = await compile(
      setOf([
        [1, 101],
        [1, 102],
      ]),
      ["own"],
    );
    const arrays = params.filter(Array.isArray) as string[][];
    expect(arrays[0]).toEqual([UUID(1), UUID(1)]);
    expect(arrays[1]).toEqual([UUID(101), UUID(102)]);
  });

  it("기본 표는 `own` 하나 — 문장도 한 부다", async () => {
    const { text } = await compile(setOf([[1, 101]]));
    expect([...text.matchAll(/count\(\*\) filter \(where exists \(/g)]).toHaveLength(1);
    expect(text).not.toContain("union all");
    expect(text).toContain("summary_trend_own");
  });
});
