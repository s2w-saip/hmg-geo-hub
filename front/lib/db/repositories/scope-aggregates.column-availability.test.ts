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
  // 앵커 축 판정을 **확정한 채로** 시작한다. 이 파일의 관심사는 컬럼 가용성 프로브의
  // 콜드 동작이고, 축 판정은 별도 프로브(0077 테이블)를 한 번 더 쏘므로 여기서 고정해
  // 두지 않으면 "왕복 1회" 단언이 두 관심사를 함께 세게 된다. 축 전환 자체의 단언은
  // `lib/period/anchor-axis*.test.ts` 와 `scope-aggregates.anchor-axis.test.ts` 가 한다.
  const state = await import("@/lib/period/anchor-axis-state");
  state.setAnchorAxisForTests(false);
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

// ── 앵커 축 판정의 **페어링** (검증 H-1) ──────────────────────────────────────
//
// `ensureColumnAvailability` 와 같은 계약이 `ensureAnchorAxis` 에도 있다
// (`anchor-axis-state.ts` 머리 주석의 ①): 동기 빌더 `anchorAxisKnownEnabled()` 는
// 미확정이면 **종전 축(false)** 으로 떨어지므로, 진입점 하나가 ensure 를 빠뜨리면
// 한 렌더 안에서 카드는 앵커 축·추이는 측정 축이 되어 모수가 갈린다.
//
// 계약을 "전 진입점"이 아니라 **"앵커 술어를 만드는 진입점"** 으로 좁힌다: 축과
// 무관한 진입점까지 ensure 를 강제하면 아무 이득 없이 왕복만 는다. 판별은
// `anchorAxisKnownEnabled` 를 직접 부르는지가 아니라(대부분 하위 빌더가 부른다)
// **이미 ensure 를 부르고 있는가**의 역방향이 아니라, 아래처럼 소스에서 축 관련
// 심볼을 쓰는 진입점을 모아 본다.
describe("앵커 축 계약 — 축을 쓰는 진입점은 ensureAnchorAxis 를 먼저 await 한다", () => {
  const src = readFileSync(
    fileURLToPath(new URL("./scope-aggregates.ts", import.meta.url)),
    "utf8",
  );

  /** `ensureColumnAvailability` 계약과 같은 본문 추출(위 describe 의 로직 재사용). */
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

  /** 진입점 하나의 본문 전체(다음 진입점 직전까지) — 축 심볼 사용 여부를 본다. */
  const all: Array<{ name: string; head: string; body: string }> = [];
  const marks = [...src.matchAll(/^export (?:async function (\w+)|const (\w+) = async)/gm)];
  marks.forEach((m, i) => {
    const start = bodyStart(m.index!);
    const end = i + 1 < marks.length ? marks[i + 1].index! : src.length;
    all.push({
      name: m[1] ?? m[2],
      head: src.slice(start + 1, start + 400),
      body: src.slice(start + 1, end),
    });
  });

  // 축을 실제로 만지는 진입점 = 본문에서 `anchorAxisKnownEnabled` 또는 앵커 SQL
  // 조각(`anchor…Sql` / `anchorRoundCellAnswerIds` / `cycleAsOf…`)을 직접 쓰는 것.
  const AXIS_SYMBOLS =
    /\b(anchorAxisKnownEnabled|anchorJoinSql|anchorAsOfJoinSql|anchorJobIdIn|anchorRunIdIn|anchorRoundCellAnswerIds|anchorRoundDateSql|anchorWeekSql|cycleAsOf(?:Sql|RowSql|DisplaySql))\b/;
  const axisEntries = all.filter((e) => AXIS_SYMBOLS.test(e.body));

  it("축을 만지는 진입점을 찾아냈다 (정규식이 조용히 0건이 되지 않게)", () => {
    expect(axisEntries.length).toBeGreaterThanOrEqual(3);
  });

  it.each(axisEntries.map((e) => [e.name, e.head] as const))(
    "%s 은 SQL 을 만들기 전에 ensureAnchorAxis 를 await 한다",
    (_name, head) => {
      const lines = head
        .split("\n")
        .map((l) => l.replace(/\s*\/\/.*$/, "").trim())
        .filter((l) => l.length > 0);
      const at = lines.indexOf("await ensureAnchorAxis();");
      expect(at).toBeGreaterThanOrEqual(0);
      for (const before of lines.slice(0, at)) {
        // 앞설 수 있는 것: 빠져나가는 가드, 그리고 같은 계약의 컬럼 프로브 ensure.
        expect(before).toMatch(
          /^(if \(.*\)\s*(throw|return)\b.*;|await ensureColumnAvailability\(\);)$/,
        );
      }
    },
  );
});

// ── 숨김 게이트 **계열 배선**의 소스 계약 (검증 D 후속) ──────────────────────
//
// 계열은 SQL 텍스트로 구분되지 않는다(조각 모양이 같다). 그래서 지키는 자리를
// **소스**에 둔다: 인용 계열 리더는 술어 빌더에 `"citations"` 를, 언급+인용을 함께
// 내는 롤업은 `"all"` 을 넘겨야 한다. 새 인용 리더가 계열 없이 추가되면 여기서 깨진다.
describe("숨김 게이트 계열 — 인용 리더는 citations, 혼합 롤업은 all", () => {
  const src = readFileSync(
    fileURLToPath(new URL("./scope-aggregates.ts", import.meta.url)),
    "utf8",
  );

  /** 리더 하나의 본문(다음 export 직전까지). */
  function bodiesOf(): Map<string, string> {
    const out = new Map<string, string>();
    const marks = [...src.matchAll(/^export async function (\w+)/gm)];
    marks.forEach((m, i) => {
      const end = i + 1 < marks.length ? marks[i + 1].index! : src.length;
      out.set(m[1], src.slice(m.index!, end));
    });
    return out;
  }
  const bodies = bodiesOf();

  /**
   * 인용 **전용** 산출을 내는 리더(반환 타입이 Citation* 계열)이면서
   * **인용 지면에서만** 쓰이는 것.
   *
   * ⚠️ `aggregateSourceCompositionFromMirror`(출처 구성 도넛)는 여기 없다 — 산출은
   * 인용이지만 소비처가 Overview·website·프로젝트 지면뿐이라 **그 지면의 계열**
   * `'all'` 을 쓴다(D1 지면 단위 통일). 두 계열의 SQL 은 문자 단위로 같다.
   */
  const CITATION_READERS = [
    "aggregateCitationsFromMirror",
    "aggregateBrandCitationsFromMirror",
    "aggregateCitationAccuracy",
    "aggregateCitationAccuracyTrend",
    "aggregateWebsiteCitationAccuracy",
    "aggregateWebsiteTargetHitRate",
    "aggregateWebsiteCitationAccuracyTrend",
    "aggregateCitationCategoryTotalsFromMirror",
    "aggregateCitationTypeCategoriesFromMirror",
    "aggregateCitationToneSummaryFromMirror",
    "aggregateCitationToneUrlsFromMirror",
    "aggregateCitationOwnedPromptsFromMirror",
  ];

  /**
   * `'all'` 계열을 쓰는 리더. 두 부류가 섞여 있다:
   *   ① 언급과 인용을 **함께** 내는 롤업 — 회차를 반쪽만 넣을 수 없다(0071 COMMENT)
   *   ② Overview·website·프로젝트 **지면 전용** 위젯 — 그 지면의 계열이 `'all'` 이라
   *      같은 값을 받는다(D1). 기본값에 두면 한 화면에서 기준 회차가 갈린다.
   */
  const MIXED_READERS = [
    "aggregateStandardFromMirror",
    "aggregateSubKpisFromMirror",
    "aggregateStandardTrendFromMirror",
    "aggregateGeoKpiFromMirror",
    // ② 지면 전용 위젯
    "aggregatePromptTopicFromMirror",
    "aggregateGeoCompetitionFromMirror",
    "aggregateSourceCompositionFromMirror",
  ];

  it("목록의 리더가 전부 실재한다 (이름이 바뀌면 조용히 0건이 되지 않게)", () => {
    for (const n of [...CITATION_READERS, ...MIXED_READERS]) {
      expect(bodies.has(n), `${n} 을 찾지 못했다`).toBe(true);
    }
  });

  it.each(CITATION_READERS)("%s 는 citations 계열을 넘긴다", (name) => {
    expect(bodies.get(name)!).toMatch(/hiddenFamily: "citations"|, "citations"\)/);
  });

  it.each(MIXED_READERS)("%s 는 all 계열을 넘긴다", (name) => {
    expect(bodies.get(name)!).toMatch(/hiddenFamily: "all"|, "all"\)/);
  });

  it("언급 전용 리더는 계열을 안 넘긴다(기본값 mentions)", () => {
    for (const n of [
      "aggregateMentionsFromMirror",
      "aggregateBrandTrendFromMirror",
      "aggregateTypeKpiFromMirror",
      "aggregateFirstPositionFromMirror",
      "aggregateAcrFromMirror",
    ]) {
      expect(bodies.get(n), `${n} 을 찾지 못했다`).toBeDefined();
      expect(bodies.get(n)!).not.toContain('hiddenFamily: "citations"');
      expect(bodies.get(n)!).not.toContain('hiddenFamily: "all"');
    }
  });

  it("최신 회차 선택 게이트가 계열을 받는다 (N2 — 고정값이면 바깥 인자가 죽는다)", () => {
    expect(src).toContain('anchorNotHiddenKnownSql("ca2", family)');
    // 안쪽만 `'all'` 고정이던 형태가 되살아나지 않게 못 박는다.
    expect(src).not.toContain('anchorNotHiddenKnownSql("ca2")]');
  });

  it("카드·상세가 같은 스냅샷 빌더를 부른다 (N1 — 조건이 갈리면 모수가 갈린다)", () => {
    const body = (n: string) => {
      const at = src.indexOf(`export function ${n}(`);
      expect(at, `${n} 을 찾지 못했다`).toBeGreaterThan(-1);
      const next = src.indexOf("\nexport ", at + 10);
      return src.slice(at, next === -1 ? undefined : next);
    };
    for (const n of ["answerWhere", "detailAnswerWhere", "snapshotRunFilter"]) {
      expect(body(n), `${n} 이 snapshotAnswerIds 를 안 부른다`).toContain("snapshotAnswerIds(");
    }
    // 상세의 축 on 분기 조건이 카드와 같은 형태인지(명시 allRuns 만 본다).
    expect(body("detailAnswerWhere")).toContain(
      "anchorAxisKnownEnabled() && opts.allRuns !== true",
    );
  });

  it("요청단위 공유 답변셋의 키에 계열이 들어간다", () => {
    // 없으면 한 요청 안에서 언급 화면과 인용 화면이 같은 집합을 공유한다.
    expect(src).toContain("stableKey([filters, projectCtx, family])");
  });
});
