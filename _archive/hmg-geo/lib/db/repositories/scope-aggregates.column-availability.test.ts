import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

/**
 * 콜드 프로세스(= Vercel 콜드 람다)의 첫 호출이 **다른 술어**를 만들던 결함을 닫는다.
 *
 * 2026-09-10 라이브 실측(글로벌 루트 무필터, PR #235 검증 중 발견):
 *   첫 호출  answers 36,308 · mentions 536,428  ← `unnest(sp.regions)` 스코핑 절 통째
 *                                                  누락 + 한국어 판정 정규식 폴백
 *   이후     answers 37,568 · mentions 566,485  (+3.5% / +5.6%)
 * 컬럼 존재 판정이 **논블로킹**이라 첫 호출은 무조건 "미확인 = 폴백"으로 나갔고, 그 값이
 * `mirrorCache`(unstable_cache · MIRROR_CACHE_TTL 7,200s = 2시간)에 굳어 고객 숫자가 콜드/웜에 따라 흔들렸다.
 *
 * 고정하는 계약 둘:
 *   ① 콜드 프로세스에서도 **진입점을 통과한** 첫 SQL == 둘째 SQL.
 *   ② 이 파일의 export 된 async 진입점은 전부 첫 줄에서 `await ensureColumnAvailability()`.
 *      (①은 지금 있는 진입점만 보지만 ②는 앞으로 생길 진입점까지 본다.)
 */

const dialect = new PgDialect();
const compile = (w: SQL) => dialect.sqlToQuery(w).sql;

const execute = vi.fn();
vi.mock("@/lib/db", () => ({ getDb: () => ({ execute, transaction: vi.fn() }) }));

const isProbe = (q: unknown) => dialect.sqlToQuery(q as SQL).sql.includes("pg_attribute");

type Mod = typeof import("./scope-aggregates");

/**
 * 프로브 응답을 흉내낸다. 두 형태를 모두 안다 —
 *   · 낱개(`runColumnProbe`): 문자열 파라미터 1개(컬럼명), 응답은 행 유무.
 *   · 배치(`ensureColumnAvailability`): (테이블, 컬럼) 쌍이 파라미터로 줄줄이,
 *     응답은 **존재하는 쌍만** `{tbl, col}` 로.
 */
export function probeReply(q: unknown, present: Record<string, boolean>): unknown[] {
  const params = dialect.sqlToQuery(q as SQL).params.filter(
    (p): p is string => typeof p === "string",
  );
  if (params.length <= 1) {
    const col = params[0];
    return col && present[col] ? [{ ok: 1 }] : [];
  }
  const rows: Array<{ tbl: string; col: string }> = [];
  for (let i = 0; i + 1 < params.length; i += 2) {
    if (present[params[i + 1]]) rows.push({ tbl: params[i], col: params[i + 1] });
  }
  return rows;
}

/** 컬럼별 존재 여부를 지정해 **새 프로세스처럼** 모듈을 다시 적재한다. */
async function coldModule(present: Record<string, boolean>): Promise<Mod> {
  vi.resetModules();
  execute.mockReset();
  execute.mockImplementation(async (q: unknown) =>
    isProbe(q) ? (probeReply(q, present) as never) : ([] as never),
  );
  return import("./scope-aggregates");
}

const ALL_PRESENT = { is_korean: true, regions: true, url_norm: true, presence_set: true };

beforeEach(() => {
  execute.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("콜드 프로세스 — 첫 호출과 둘째 호출이 같은 술어를 만든다", () => {
  it("진입점(snapshotAnswerWhere)을 통과한 첫 SQL 이 둘째 SQL 과 동일하다", async () => {
    const mod = await coldModule(ALL_PRESENT);
    const first = compile(await mod.snapshotAnswerWhere({}, undefined));
    const second = compile(await mod.snapshotAnswerWhere({}, undefined));
    expect(first).toBe(second);
    // 폴백이 아니라 **컬럼 경로**로 확정된 것까지 본다(둘 다 폴백이어도 "동일"하므로).
    expect(first).toContain("unnest(sp.regions)");
    expect(first).toContain("sp.is_korean");
    expect(first).not.toContain("sp.text ~ '[가-힣]'");
  });

  it("동기 빌더를 진입점 없이 직접 부르면 여전히 달라진다 — 이 테스트가 헛돌지 않음의 증거", async () => {
    const mod = await coldModule(ALL_PRESENT);
    const bare = compile(mod.answerWhere({}, undefined)); // ensure 를 안 거친 첫 호출
    const viaEntry = compile(await mod.snapshotAnswerWhere({}, undefined));
    expect(bare).not.toBe(viaEntry);
    expect(bare).not.toContain("unnest(sp.regions)");
  });

  it("콜드 진입은 프로브를 **한 문장**으로 묶고, 확정 뒤에는 다시 쏘지 않는다", async () => {
    const mod = await coldModule(ALL_PRESENT);
    await mod.snapshotAnswerWhere({}, undefined);
    // 키가 4개여도 왕복은 1회여야 한다(커넥션 4개 동시 수립 회피 — 실측 1,051→265 ms).
    expect(execute.mock.calls.filter(([q]) => isProbe(q))).toHaveLength(1);
    execute.mockClear();
    await mod.snapshotAnswerWhere({}, undefined);
    expect(execute.mock.calls.filter(([q]) => isProbe(q))).toHaveLength(0);
  });

  it("여러 진입점이 동시에 들어와도 프로브 발사는 1회다", async () => {
    const mod = await coldModule(ALL_PRESENT);
    const sqls = await Promise.all([
      mod.snapshotAnswerWhere({}, undefined),
      mod.snapshotAnswerWhere({}, undefined),
      mod.snapshotAnswerWhere({}, undefined),
      mod.snapshotAnswerWhere({}, undefined),
      mod.snapshotAnswerWhere({}, undefined),
    ]);
    expect(execute.mock.calls.filter(([q]) => isProbe(q))).toHaveLength(1);
    const texts = new Set(sqls.map(compile));
    expect(texts.size).toBe(1); // 다섯 개가 전부 같은 술어
    expect([...texts][0]).toContain("unnest(sp.regions)");
  });

  it("컬럼이 실제로 없으면 폴백 술어로 확정된다 (42703 내성 유지)", async () => {
    const mod = await coldModule({ ...ALL_PRESENT, regions: false, is_korean: false });
    const first = compile(await mod.snapshotAnswerWhere({}, undefined));
    const second = compile(await mod.snapshotAnswerWhere({}, undefined));
    expect(first).toBe(second);
    expect(first).not.toContain("sp.regions");
    expect(first).toContain("sp.text ~ '[가-힣]'");
  });
});

describe("ensureColumnAvailability — 실패해도 던지지 않고, 폴백이 굳지 않는다", () => {
  it("프로브가 실패하면 폴백으로 진행하되 짧은 TTL 뒤 다시 묻는다", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-10T00:00:00Z"));
    vi.resetModules();
    execute.mockReset();
    execute.mockRejectedValue(new Error("probe down"));
    const { ensureColumnAvailability, columnKnownAvailable } = await import(
      "@/lib/db/column-availability"
    );
    await expect(ensureColumnAvailability()).resolves.toBeUndefined();
    expect(columnKnownAvailable("scope_prompts", "regions")).toBe(false);

    // 프로브가 복구되면 **재배포 없이** 다음 ensure 가 컬럼 경로로 넘어간다.
    execute.mockReset();
    execute.mockImplementation(async (q: unknown) => probeReply(q, ALL_PRESENT) as never);
    vi.setSystemTime(new Date("2026-09-10T00:00:05Z")); // > PROBE_ERROR_RETRY_MS
    await ensureColumnAvailability();
    expect(columnKnownAvailable("scope_prompts", "regions")).toBe(true);
  });
});

describe("진입점 계약 — export 된 async 함수는 전부 ensure 를 먼저 await 한다", () => {
  const src = readFileSync(
    fileURLToPath(new URL("./scope-aggregates.ts", import.meta.url)),
    "utf8",
  );

  /**
   * 본문 여는 `{` 의 위치. 파라미터 안의 `{`(`opts: { … }`)와 반환 타입 안의
   * `{`(`Promise<{ … }>`)에 속지 않도록 두 조건을 함께 쓴다 — ① 시그니처 괄호가
   * 닫힌 뒤일 것, ② 그 `{` 뒤에 줄바꿈만 남을 것(본문 브레이스는 줄 끝에 온다).
   */
  function bodyStart(from: number): number {
    let depth = 0;
    let seen = false;
    for (let i = from; i < src.length; i++) {
      const ch = src[i];
      if (ch === "(") {
        depth++;
        seen = true;
      } else if (ch === ")") {
        depth--;
      } else if (ch === "{" && seen && depth === 0) {
        const eol = src.indexOf("\n", i);
        if (src.slice(i + 1, eol === -1 ? undefined : eol).trim() === "") return i;
      }
    }
    throw new Error("본문 시작을 찾지 못했다");
  }

  // `export async function f()` 와 `export const f = async () =>` 둘 다 본다 —
  // 화살표 형태를 빼두면 그 모양으로 진입점이 하나 생기는 순간 계약이 조용히 샌다
  // (검증자가 실제로 주입해 통과하는 것을 재현했다, 2026-09-10).
  const entries: Array<{ name: string; head: string }> = [];
  for (const m of src.matchAll(/^export (?:async function (\w+)|const (\w+) = async)/gm)) {
    const start = bodyStart(m.index!);
    entries.push({ name: m[1] ?? m[2], head: src.slice(start + 1, start + 400) });
  }

  it("진입점을 찾아냈다 (정규식이 조용히 0건이 되지 않게)", () => {
    expect(entries.length).toBeGreaterThanOrEqual(40);
  });

  it("화살표 형태의 export 진입점도 정규식이 잡는다", () => {
    const sample = "export const readThing = async (\n  a: number,\n): Promise<void> => {\n  await ensureColumnAvailability();\n};";
    const m = /^export (?:async function (\w+)|const (\w+) = async)/m.exec(sample);
    expect(m?.[2]).toBe("readThing");
  });

  it.each(entries.map((e) => [e.name, e.head] as const))(
    "%s 은 SQL 을 만들기 전에 ensureColumnAvailability 를 await 한다",
    (_name, head) => {
      const lines = head
        .split("\n")
        .map((l) => l.replace(/\s*\/\/.*$/, "").trim()) // 줄 끝 주석 제거
        .filter((l) => l.length > 0);
      const at = lines.indexOf("await ensureColumnAvailability();");
      expect(at).toBeGreaterThanOrEqual(0);
      // 앞설 수 있는 것은 **아무 것도 안 하고 빠져나가는 가드**뿐이다(default-deny 등).
      // 그 외 문장이 앞서면 그 사이에 SQL 이 만들어질 수 있다.
      for (const before of lines.slice(0, at)) {
        expect(before).toMatch(/^if \(.*\)\s*(throw|return)\b.*;$/);
      }
    },
  );
});
