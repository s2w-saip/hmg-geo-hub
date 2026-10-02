import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

// 회차 사슬 감시 리포지토리의 **SQL 형태 계약**.
//
// ── 왜 이 파일이 생겼나 (2026-09-16 독립 검증) ────────────────────────────
// 이 리포지토리는 195줄이 거의 전부 SQL 인데 **테스트가 0건**이었다. 검증자가 넣은
// 뮤테이션 4개(묶음 키 · 숨김 게이트 · 갭 여집합의 `IS NULL` 절 · 판정의 null 절)가
// **전부 통과해 버렸다** — 판정 쪽 테스트가 아무리 촘촘해도 리포지토리가 다른 SQL 을
// 내면 감시는 조용히 다른 것을 본다.
//
// 그래서 여기서는 "행이 이렇게 나온다" 가 아니라 **문장이 이렇게 생겼다** 를 못 박는다.
// 값 검증은 통합 테스트(라이브 DB)의 몫이고, 여기서 잡아야 하는 것은 **술어가 사라지는
// 뮤테이션**이다.

const dialect = new PgDialect();
const captured: string[] = [];
const capturedParams: unknown[][] = [];
let rows: unknown[] = [];
let boom: Error | null = null;
const execute = vi.fn(async (q: SQL) => {
  const built = dialect.sqlToQuery(q);
  captured.push(built.sql);
  capturedParams.push(built.params);
  if (boom) throw boom;
  return rows as unknown as never;
});
vi.mock("@/lib/db", () => ({ getDb: () => ({ execute }) }));

/** 마지막 문장 원문 — 대소문자가 의미 있는 단언(to_char 포맷)에만 쓴다. */
const lastRaw = () => captured.at(-1) ?? "";
/** 식별자·키워드 단언용. drizzle 은 원문 대소문자를 보존하므로 낮춰서 본다. */
const last = () => lastRaw().toLowerCase();

beforeEach(async () => {
  execute.mockClear();
  captured.length = 0;
  capturedParams.length = 0;
  rows = [];
  boom = null;
  const ca = await import("@/lib/db/column-availability");
  ca.resetColumnAvailabilityForTests();
  // 0070 적용 후(= 프로덕션) 경로를 기본값으로 본다.
  //
  // ⚠️ `hidden_reason` 은 `SYNC_PROBED_COLUMNS` 에 **없다**(비동기 판정 전용) —
  //    `resolveColumnAvailabilityForTests` 로는 안 덮인다. 명시적으로 세우지 않으면
  //    프로브가 모킹된 `execute` 를 한 번 더 태우고, 그 응답(테스트가 세운 `rows`)을
  //    컬럼 존재 여부로 **오독**한다. 실제로 이 파일 초판이 그 사고를 냈다:
  //    `rows=[{n:3}]` 인 테스트만 우연히 통과하고 `rows=[]` 인 테스트는 실패했다.
  ca.resolveColumnAvailabilityForTests(true);
  ca.setColumnAvailabilityForTests("summary_cycles", "hidden_reason", true);
});

describe("readCycleLedger — 묶음 키와 시각 축", () => {
  it("글로벌 묶음 키는 toISOString() 과 같은 축이다 (`::text` 금지)", async () => {
    // ⚠️ 이 단언이 이 파일의 존재 이유 중 하나다.
    // `::text` 는 `2026-09-13 15:48:44.276+00`, 픽은 `2026-09-13T15:48:44.276Z` 를 낸다.
    // 판정은 둘을 **문자열로 비교**하므로 인덱스 10 에서 `' ' < 'T'` 가 되어 같은
    // 날짜의 더 최신 회차가 '밀림' 으로 안 잡힌다(2026-09-16 실측 cmp:false).
    // 세션 TimeZone 이 UTC 가 아니면 방향이 뒤집혀 영구 오탐이 된다.
    const m = await import("./summary-cycle-health");
    await m.readCycleLedger("global");
    expect(lastRaw()).toContain(`AT TIME ZONE 'UTC'`);
    expect(lastRaw()).toContain(`'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`);
    // 앵커를 로캘 의존 표기로 내보내는 경로가 남아 있으면 안 된다.
    expect(last()).not.toContain("c.cycle_anchor_at::text");
  });

  it("웹사이트 묶음 키는 **주**다 — 앵커가 아니다", async () => {
    // 행(=프로젝트)으로 세면 한 주 밀림이 95로 잡혀 등급이 언제나 2가 된다.
    const m = await import("./summary-cycle-health");
    await m.readCycleLedger("website");
    expect(lastRaw()).toContain("to_char(c.cycle_week, 'YYYY-MM-DD')");
  });

  it("due_at 은 VIEW_ANCHOR_DELAY 를 그대로 쓴다 (표면별로 다르다)", async () => {
    const m = await import("./summary-cycle-health");
    await m.readCycleLedger("global");
    expect(last()).toContain("interval '2 days'");
    await m.readCycleLedger("website");
    expect(last()).toContain("interval '1 day'");
  });

  it("숨김 게이트가 붙는다 (0070 적용 환경)", async () => {
    const m = await import("./summary-cycle-health");
    await m.readCycleLedger("global");
    expect(last()).toContain("hidden_reason is null");
  });

  it("0070 미적용이면 숨김 술어를 빼고 나간다 (42703 로 감시가 죽지 않게)", async () => {
    const ca = await import("@/lib/db/column-availability");
    ca.resetColumnAvailabilityForTests();
    ca.resolveColumnAvailabilityForTests(false);
    ca.setColumnAvailabilityForTests("summary_cycles", "hidden_reason", false);
    const m = await import("./summary-cycle-health");
    await m.readCycleLedger("global");
    expect(last()).not.toContain("hidden_reason");
  });

  it("fleet_visible 을 **술어로** 걸지 않는다 — 의도된 비대칭이다", async () => {
    // `pickWebsiteCycles` 는 건다. 여기서 걸면 한 주가 통째로 '패자' 만 남는 병리를
    // 감시가 못 본다(2026-09-16 실측 website 61행).
    const m = await import("./summary-cycle-health");
    await m.readCycleLedger("website");
    const sql = last();
    expect(sql.slice(sql.indexOf("where"))).not.toContain("fleet_visible");
  });

  it("fleet_visible·cycle_week 을 **열로는** 낸다 — 판정이 중복 패자를 접는다", async () => {
    // 접는 자리는 `cycle-chain.ts::judgeViewLagSurface`(글로벌). 열이 없으면 접지 못해
    // 중복 주마다 "한 회차 밀림" 오탐이 상시로 뜬다(2026-09-18 픽 변경의 귀결).
    const m = await import("./summary-cycle-health");
    for (const surface of ["global", "website"] as const) {
      await m.readCycleLedger(surface);
      expect(last(), surface).toContain("as fleet_visible");
      expect(last(), surface).toContain("as cycle_week");
      // 접기 그룹은 관제 파티션과 같은 `(프로젝트, 주)` 다 — 프로젝트가 없으면 같은 주
      // 다른 사이트의 대표가 이 프로젝트의 패자를 지운다.
      expect(last(), surface).toContain("as project_id");
    }
  });
});

describe("readGapExcludedCycles — 3값 논리 여집합", () => {
  it("`analysis_gap_ratio IS NULL` 을 **명시**한다", async () => {
    // `NOT (gap <= MAX)` 만 쓰면 gap 이 NULL 일 때 UNKNOWN 이라 WHERE 가 버린다.
    // 그러면 갭 미상 회차(2026-09-11 실측 웹사이트 36건)가 통째로 안 보인다 —
    // `isGeneratorSkipped` 는 그것들을 '생성기가 영원히 안 뽑는' 집합으로 센다.
    const m = await import("./summary-cycle-health");
    await m.readGapExcludedCycles(0.05, ["global", "website"]);
    const sql = last();
    expect(sql).toContain("analysis_gap_ratio is null");
    expect(sql).toContain("analysis_gap_ratio >");
    expect(sql).toContain("active_generation_id is null");
  });

  it("표면을 좁힌다 — project 표면이 딸려 나오면 영구 오탐이다", async () => {
    const m = await import("./summary-cycle-health");
    await m.readGapExcludedCycles(0.05, ["global", "website"]);
    expect(last()).toContain("surface = any(");
    expect(capturedParams.at(-1)).toContainEqual(["global", "website"]);
  });
});

describe("readStaleCycles — 둘째 술어 (F7)", () => {
  it("stale_since 와 활성 generation 을 **함께** 건다", async () => {
    // 활성 generation 이 없는 stale 회차는 갭 여집합이 이미 세고 있다 —
    // 좁히지 않으면 이중 계상이다(2026-09-16 실측: 나머지 5건이 정확히 그 집합).
    const m = await import("./summary-cycle-health");
    await m.readStaleCycles(["global", "website"]);
    const sql = last();
    expect(sql).toContain("stale_since is not null");
    expect(sql).toContain("active_generation_id is not null");
    expect(sql).toContain("hidden_reason is null");
    // 시각은 판정이 Date.parse 하므로 같은 ISO 축이어야 한다.
    expect(lastRaw()).toContain(`'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`);
  });
});

describe("countViewableCycles — 픽의 null 을 해석하는 프로브", () => {
  it("**던진다** — 이것이 존재 이유다(catch 하면 F3 이 되살아난다)", async () => {
    // 픽은 `catch → null` 이라 '고를 게 없다' 와 '조회가 죽었다' 가 겹친다.
    // 이 프로브가 조용히 0 을 돌려주면 DB 순간 오류가 곧바로 긴급 2 로 나간다.
    const m = await import("./summary-cycle-health");
    boom = new Error("connection terminated");
    await expect(m.countViewableCycles("global")).rejects.toThrow("connection terminated");
  });

  it("픽과 같은 술어를 쓴다 (노출 게이트 + 숨김 + 활성 generation)", async () => {
    const m = await import("./summary-cycle-health");
    rows = [{ n: 3 }];
    await expect(m.countViewableCycles("global")).resolves.toBe(3);
    const sql = last();
    expect(sql).toContain("view_anchor_at is not null");
    expect(sql).toContain("view_anchor_at <= now()");
    expect(sql).toContain("active_generation_id is not null");
    expect(sql).toContain("hidden_reason is null");
    // 글로벌에는 함대 술어가 없다.
    expect(sql).not.toContain("fleet_visible");
  });

  it("웹사이트는 fleet_visible 까지 건다 (픽이 거는 것과 같은 조건)", async () => {
    const m = await import("./summary-cycle-health");
    rows = [{ n: 0 }];
    await m.countViewableCycles("website");
    expect(last()).toContain("fleet_visible");
  });

  it("행이 없으면 0 (undefined 를 흘리지 않는다)", async () => {
    const m = await import("./summary-cycle-health");
    rows = [];
    await expect(m.countViewableCycles("global")).resolves.toBe(0);
  });
});

describe("readCycleWaitingSince — 대기 시작 시각", () => {
  it("closed_at 이 없으면 created_at 으로 떨어진다", async () => {
    // `summary_cycles` 에는 updated_at 이 없다(0059 DDL).
    const m = await import("./summary-cycle-health");
    rows = [];
    await m.readCycleWaitingSince(["11111111-1111-1111-1111-111111111111"]);
    expect(last()).toContain("coalesce(closed_at, created_at)");
  });

  it("빈 목록이면 DB 를 보지 않는다", async () => {
    const m = await import("./summary-cycle-health");
    await expect(m.readCycleWaitingSince([])).resolves.toEqual(new Map());
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("readPendingCycles — `--pending` 정본을 그대로 쓴다", () => {
  it("생성기와 같은 문장이 나간다 (술어를 새로 쓰지 않았다는 증거)", async () => {
    const m = await import("./summary-cycle-health");
    const { pendingCyclesSql } = await import("@/lib/summary/generate/cycle");
    rows = [];
    await m.readPendingCycles({ surface: "global", gapMax: 0.05, limit: 1000 });
    const mine = lastRaw();
    const canonical = dialect.sqlToQuery(
      pendingCyclesSql({ surface: "global", gapMax: 0.05, limit: 1000 }),
    ).sql;
    expect(mine).toBe(canonical);
  });
});
