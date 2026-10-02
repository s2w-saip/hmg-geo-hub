import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

/**
 * 축 판정 상태기의 **계약 4종** (검증 H-2). 종전에는 전용 테스트가 없었다.
 *
 *   ① 확정 전에 동기 빌더를 부르면 **종전 축(false)** 이고 경고는 프로세스당 1회.
 *   ② `answerAnchorEnabled` 가 던져도 **throw 하지 않고** false 로 접는다.
 *   ③ TTL(30초)이 지나면 다시 판정한다 — 사람이 끄고 켜는 스위치이기 때문.
 *   ④ 동시에 여러 진입점이 불러도 **발사는 1회**(inflight 공유), 숨김 조각은
 *      두 별칭(`ca`·`ca2`)을 갖는다.
 *
 * DB 접속 0 — 판정 함수와 숨김 조각 생성기를 mock 한다.
 */

const dialect = new PgDialect();
const flagSpy = vi.fn(async () => true);
const notHiddenSpy = vi.fn(async (family: string, alias: string) =>
  sql.raw(`not_hidden(${family},${alias})`),
);
// 함대 게이트(원장이 서빙을 허락한 회차인가) — 축이 켜질 때만 별칭별로 만들어진다.
const ledgerSpy = vi.fn(async (alias: string) => sql.raw(`ledger_servable(${alias})`));

vi.mock("./anchor-axis-flag", () => ({
  answerAnchorEnabled: () => flagSpy(),
  ANSWER_ANCHOR_SCREEN_KEY: "X.answerAnchor",
  answerAnchorForced: () => false,
  answerAnchorOverrideAllowedHere: () => false,
}));
vi.mock("@/lib/db/repositories/scope-answer-anchors", () => ({
  anchorNotHiddenSql: (family: string, alias: string) => notHiddenSpy(family, alias),
  anchorLedgerServableSql: (alias: string) => ledgerSpy(alias),
}));

const {
  ensureAnchorAxis,
  anchorAxisKnownEnabled,
  anchorNotHiddenKnownSql,
  anchorLedgerServableKnownSql,
  resetAnchorAxisForTests,
  setAnchorAxisForTests,
} = await import("./anchor-axis-state");

beforeEach(() => {
  resetAnchorAxisForTests();
  flagSpy.mockReset();
  flagSpy.mockImplementation(async () => true);
  notHiddenSpy.mockClear();
  vi.useRealTimers();
});
afterEach(() => {
  resetAnchorAxisForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("① 확정 전 동기 호출 = 종전 축 + 경고 1회", () => {
  it("미확정이면 false 다", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(anchorAxisKnownEnabled()).toBe(false);
    warn.mockRestore();
  });

  it("경고는 프로세스당 한 번만 나간다", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    anchorAxisKnownEnabled();
    anchorAxisKnownEnabled();
    anchorAxisKnownEnabled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("ensureAnchorAxis");
    warn.mockRestore();
  });

  it("미확정 상태의 숨김 조각은 통과 술어(true)다", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(dialect.sqlToQuery(anchorNotHiddenKnownSql("ca")).sql).toBe("true");
    expect(dialect.sqlToQuery(anchorNotHiddenKnownSql("ca2")).sql).toBe("true");
    warn.mockRestore();
  });
});

describe("② 판정이 던져도 종전 축으로 접는다", () => {
  it("throw → false, 그리고 예외가 밖으로 새지 않는다", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    flagSpy.mockImplementation(async () => {
      throw new Error("probe boom");
    });
    await expect(ensureAnchorAxis()).resolves.toBe(false);
    expect(anchorAxisKnownEnabled()).toBe(false);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("실패 뒤에도 TTL 안에서는 재발사하지 않는다", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    flagSpy.mockImplementation(async () => {
      throw new Error("probe boom");
    });
    await ensureAnchorAxis();
    await ensureAnchorAxis();
    expect(flagSpy).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });
});

describe("③ TTL 30초 — 스위치는 사람이 끄고 켠다", () => {
  it("TTL 안에서는 한 번만 판정한다", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-20T00:00:00Z"));
    expect(await ensureAnchorAxis()).toBe(true);
    vi.setSystemTime(new Date("2026-09-20T00:00:29Z")); // 29초 — TTL 안
    expect(await ensureAnchorAxis()).toBe(true);
    expect(flagSpy).toHaveBeenCalledTimes(1);
  });

  it("TTL 이 지나면 다시 판정하고 값이 바뀐다", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-20T00:00:00Z"));
    expect(await ensureAnchorAxis()).toBe(true);
    flagSpy.mockImplementation(async () => false); // 운영자가 끔
    vi.setSystemTime(new Date("2026-09-20T00:00:31Z")); // 31초 — TTL 밖
    expect(await ensureAnchorAxis()).toBe(false);
    expect(flagSpy).toHaveBeenCalledTimes(2);
    expect(anchorAxisKnownEnabled()).toBe(false);
  });
});

describe("④ 동시 호출은 1회 발사 · 숨김 조각은 두 별칭", () => {
  it("여러 진입점이 동시에 불러도 판정은 한 번이다", async () => {
    let open = () => {};
    const gate = new Promise<void>((r) => { open = r; });
    flagSpy.mockImplementation(async () => {
      await gate;
      return true;
    });
    const all = Promise.all([ensureAnchorAxis(), ensureAnchorAxis(), ensureAnchorAxis()]);
    open();
    expect(await all).toEqual([true, true, true]);
    expect(flagSpy).toHaveBeenCalledTimes(1);
  });

  it("축이 켜지면 계열 3 × 별칭 2 = 6개 조각을 미리 만들어 둔다", async () => {
    await ensureAnchorAxis();
    expect(notHiddenSpy).toHaveBeenCalledTimes(6);
    for (const f of ["mentions", "citations", "all"]) {
      for (const a of ["ca", "ca2"]) {
        expect(notHiddenSpy).toHaveBeenCalledWith(f, a);
      }
    }
  });

  it("계열을 생략하면 'all' — 회차 집합 판정의 기본값", async () => {
    await ensureAnchorAxis();
    expect(dialect.sqlToQuery(anchorNotHiddenKnownSql("ca")).sql).toBe("not_hidden(all,ca)");
    expect(dialect.sqlToQuery(anchorNotHiddenKnownSql("ca2")).sql).toBe("not_hidden(all,ca2)");
  });

  it("계열을 지정하면 그 계열 조각을 돌려준다", async () => {
    await ensureAnchorAxis();
    expect(dialect.sqlToQuery(anchorNotHiddenKnownSql("ca", "mentions")).sql).toBe(
      "not_hidden(mentions,ca)",
    );
    expect(dialect.sqlToQuery(anchorNotHiddenKnownSql("ca", "citations")).sql).toBe(
      "not_hidden(citations,ca)",
    );
  });

  it("축이 꺼져 있으면 숨김 조각 프로브를 쏘지 않는다", async () => {
    flagSpy.mockImplementation(async () => false);
    await ensureAnchorAxis();
    expect(notHiddenSpy).not.toHaveBeenCalled();
    expect(dialect.sqlToQuery(anchorNotHiddenKnownSql("ca")).sql).toBe("true");
  });
});

describe("테스트 훅", () => {
  it("setAnchorAxisForTests 는 판정을 확정시키고 왕복을 없앤다", async () => {
    setAnchorAxisForTests(true);
    expect(anchorAxisKnownEnabled()).toBe(true);
    expect(await ensureAnchorAxis()).toBe(true);
    expect(flagSpy).not.toHaveBeenCalled();
  });

  it("notHidden 을 주입하면 동기 빌더가 그 조각을 읽는다(전 계열 공통)", () => {
    setAnchorAxisForTests(true, { ca: sql.raw("injected_ca") });
    expect(dialect.sqlToQuery(anchorNotHiddenKnownSql("ca")).sql).toBe("injected_ca");
    expect(dialect.sqlToQuery(anchorNotHiddenKnownSql("ca", "mentions")).sql).toBe(
      "injected_ca",
    );
    expect(dialect.sqlToQuery(anchorNotHiddenKnownSql("ca2")).sql).toBe("true");
  });
});

// ── 함대 게이트(프리뷰 실측 2026-09-20) ────────────────────────────────────
describe("⑤ 함대 게이트 — 축이 켜질 때만, 별칭별로", () => {
  it("축이 켜지면 두 별칭의 조각을 미리 만들어 둔다", async () => {
    ledgerSpy.mockClear();
    flagSpy.mockResolvedValue(true);
    await ensureAnchorAxis();
    expect(ledgerSpy.mock.calls.map((c) => c[0]).sort()).toEqual(["ca", "ca2"]);
    expect(dialect.sqlToQuery(anchorLedgerServableKnownSql("ca")).sql).toBe(
      "ledger_servable(ca)",
    );
    expect(dialect.sqlToQuery(anchorLedgerServableKnownSql("ca2")).sql).toBe(
      "ledger_servable(ca2)",
    );
  });

  it("축이 꺼져 있으면 만들지 않고 제약 없음(true)이다", async () => {
    ledgerSpy.mockClear();
    flagSpy.mockResolvedValue(false);
    resetAnchorAxisForTests();
    await ensureAnchorAxis();
    expect(ledgerSpy).not.toHaveBeenCalled();
    expect(dialect.sqlToQuery(anchorLedgerServableKnownSql("ca")).sql).toBe("true");
  });

  it("확정 전에는 제약 없음 — 그때는 축도 꺼져 있다", () => {
    resetAnchorAxisForTests();
    expect(dialect.sqlToQuery(anchorLedgerServableKnownSql("ca")).sql).toBe("true");
    expect(anchorAxisKnownEnabled()).toBe(false);
  });
});
