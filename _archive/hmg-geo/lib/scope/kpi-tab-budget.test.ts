import { describe, expect, it, vi } from "vitest";
import { UnauthorizedError } from "@/lib/auth/errors";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  kpiBudgetOf,
  mentionsBudgetOf,
  MIRROR_EXTRAS_BUDGET_MS,
  mirrorExtrasBudget,
  MIRROR_HEAVY_BUDGET_MS,
  MIRROR_HEAVY_STATEMENT_TIMEOUT_MS,
  mirrorHeavyBudget,
  KPI_TAB_ENGINE_BUDGET_MS,
  KPI_TAB_HERO_TREND_DAYS,
  KPI_TAB_SINGLE_BUDGET_MS,
  KPI_TAB_SPARK_TREND_DAYS,
  KPI_TAB_STATEMENT_TIMEOUT_MS,
  DegradedResultUncached,
  isTimeoutFailure,
  kpiDegrade,
  recoverDegraded,
  uncachedIfDegraded,
} from "./kpi-tab-budget";

// 회귀 — 2026-09-01 적대적 검증 F6·F7 + 재검증 C1·C2·C4.

describe("kpiDegrade — 시간 초과만 삼킨다 (F6 / C4)", () => {
  it("degrades a statement timeout (57014) so the page still renders", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const timeout = Object.assign(new Error("canceling statement due to statement timeout"), {
      code: "57014",
    });
    await expect(kpiDegrade("t", () => Promise.reject(timeout))).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("degrades our own wall-clock deadline abort", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const e = Object.assign(new Error("answer-set budget exhausted before statement"), {
      name: "AnswerSetDeadlineError",
    });
    await expect(kpiDegrade("t", () => Promise.reject(e))).resolves.toBeNull();
    warn.mockRestore();
  });

  // 반례(F6): 무조건 catch 라 세션 없음이 "데이터 없음"으로 나왔다.
  it("re-throws an authorization failure instead of hiding it as empty data", async () => {
    await expect(
      kpiDegrade("t", () => Promise.reject(new UnauthorizedError())),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  // 반례(C4): 거부 목록이라 인프라 장애·코드 결함까지 전부 삼켰다. 실측된 4종.
  it.each([
    ["SQL syntax error (42601)", Object.assign(new Error('syntax error at or near "SELCT"'), { code: "42601", name: "PostgresError" })],
    ["connection refused", Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" })],
    ["missing DATABASE_URL", new Error("DATABASE_URL is not set (server-only Postgres connection).")],
    ["ScopeHttpError 403", Object.assign(new Error("forbidden"), { name: "ScopeHttpError", status: 403 })],
  ])("re-throws %s rather than reporting no data", async (_label, err) => {
    await expect(kpiDegrade("t", () => Promise.reject(err))).rejects.toBe(err);
  });

  it("passes a successful value through untouched", async () => {
    await expect(kpiDegrade("t", () => Promise.resolve({ ok: 1 }))).resolves.toEqual({ ok: 1 });
  });
});

describe("isTimeoutFailure", () => {
  it.each([
    ["pg 57014", Object.assign(new Error("x"), { code: "57014" }), true],
    ["AnswerSetDeadlineError", Object.assign(new Error("x"), { name: "AnswerSetDeadlineError" }), true],
    ["syntax error", Object.assign(new Error("x"), { code: "42601" }), false],
    ["UnauthorizedError", new UnauthorizedError(), false],
    ["plain error", new Error("boom"), false],
    ["non-error", "nope", false],
    // 2026-09-01 로컬 브라우저 실측에서 드러난 실제 형태 — drizzle 은 드라이버
    // 오류를 `Failed query:` Error 로 감싸고 원본을 cause 에 넣는다. 감싼 쪽에는
    // code 가 없어(digest 만 있다) code 만 보던 판정이 57014 를 놓쳤고, 그 결과
    // 경쟁사 추이 타임아웃이 degrade 되지 못해 페이지가 통째로 에러 화면이 됐다.
    [
      "drizzle 이 감싼 57014 (cause 체인)",
      Object.assign(new Error("Failed query: WITH names AS (…)"), {
        digest: "1408917860",
        cause: Object.assign(new Error("canceling statement due to statement timeout"), {
          code: "57014",
          name: "PostgresError",
        }),
      }),
      true,
    ],
    [
      "code 를 잃은 타임아웃 (메시지 폴백)",
      new Error("canceling statement due to statement timeout"),
      true,
    ],
    [
      "drizzle 이 감싼 문법 오류는 여전히 던진다",
      Object.assign(new Error("Failed query: SELCT 1"), {
        cause: Object.assign(new Error('syntax error at or near "SELCT"'), { code: "42601" }),
      }),
      false,
    ],
  ] as const)("%s → %s", (_label, err, expected) => {
    expect(isTimeoutFailure(err)).toBe(expected);
  });

  it("survives a self-referential cause chain", () => {
    const a = new Error("a") as Error & { cause?: unknown };
    const b = new Error("b") as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;
    expect(isTimeoutFailure(a)).toBe(false);
  });

  // 가상 클래스를 지키던 이름 검사(ForbiddenError)는 제거됐다 — 리포에 없다.
  it("does not rely on a class the repo does not define", async () => {
    const errs = await import("@/lib/auth/errors");
    expect(Object.keys(errs)).not.toContain("ForbiddenError");
  });
});

describe("trend windows (F7)", () => {
  // 반례: 히어로 추이·엔진 시계열이 스파크라인 창(28일)을 공유해 주 4점으로
  // 잘려 있었다. 디자인(327:116)의 추이는 7.2~8.16 = 주 8~10점이다.
  it("gives the hero trend its own, wider window", () => {
    expect(KPI_TAB_HERO_TREND_DAYS).toBe(84);
    expect(KPI_TAB_HERO_TREND_DAYS).toBeGreaterThan(KPI_TAB_SPARK_TREND_DAYS);
  });

  // 84일 = 12주. 미러 실측 폭(61일 = 주 10 버킷)을 전부 덮는다.
  it("covers at least 10 weekly buckets", () => {
    expect(Math.floor(KPI_TAB_HERO_TREND_DAYS / 7)).toBeGreaterThanOrEqual(10);
  });

  // 문장당 상한과 벽시계 예산은 다른 것이다(C1). 종전엔 하나로 뭉개져 있었다.
  // 2026-09-02: 8s 관례를 버렸다. 그 값의 근거("최장 문장 4.44s")가 CTE 하네스로
  // 잰 틀린 측정이었고, 프로덕션 경로(TEMP TABLE)로 재니 엔진 추이의 개별 문장이
  // warm 8~10.6s 였다 — 8s 상한이 최적화를 다 하고도 매번 문장을 죽이고 있었다.
  // 이 테스트는 "그 실측(콜드 1.7배 = 18.0s)을 덮을 수 있는가"를 고정한다.
  it("keeps the per-STATEMENT guard above the measured worst statement (10.6s warm × 1.7)", () => {
    expect(KPI_TAB_STATEMENT_TIMEOUT_MS).toBeGreaterThanOrEqual(18_000);
    // 무한정 키우는 것도 막는다 — 실효 최악(budget + 이 값)이 maxDuration(120s) 안이어야 한다.
    expect(KPI_TAB_ENGINE_BUDGET_MS + KPI_TAB_STATEMENT_TIMEOUT_MS).toBeLessThan(120_000);
  });

  // C2 실측: 엔진 1단계 ≈2.97s + 2단계 ≈5.67s ≈ 8.6s. 종전의 "합 8s" 는 실측을
  // 넣어보면 애초에 들어가지 않는 값이라, 무필터 warm 로드에서도 추이가 죽었을 것이다.
  it("gives the two-phase engine aggregate a wall-clock budget above the measured 8.6s", () => {
    expect(KPI_TAB_ENGINE_BUDGET_MS).toBeGreaterThan(8600);
    expect(KPI_TAB_ENGINE_BUDGET_MS).toBeGreaterThan(KPI_TAB_SINGLE_BUDGET_MS);
  });

  it("gives single-phase aggregates a smaller budget than the two-phase one", () => {
    expect(KPI_TAB_SINGLE_BUDGET_MS).toBeGreaterThan(5700); // 실측 브랜드 추이 ≈4.5~5.6s
  });
});

// 2026-09-02 프리뷰 실증 — degrade 가 정상 반환값이라 30분 캐시에 굳었다(로그 0건).
describe("uncachedIfDegraded / recoverDegraded — degrade 결과는 캐시를 지나가지 않는다", () => {
  type R = { latest: number; trendDegraded: boolean };
  const isDeg = (r: R) => r.trendDegraded === true;

  it("passes a healthy result through so the cache stores it", async () => {
    const inner = uncachedIfDegraded(isDeg, async () => ({ latest: 1, trendDegraded: false }));
    await expect(inner()).resolves.toEqual({ latest: 1, trendDegraded: false });
  });

  it("throws on a degraded result so unstable_cache cannot store it", async () => {
    const inner = uncachedIfDegraded(isDeg, async () => ({ latest: 1, trendDegraded: true }));
    await expect(inner()).rejects.toBeInstanceOf(DegradedResultUncached);
  });

  it("recovers the degraded value outside the cache, unchanged", async () => {
    const inner = uncachedIfDegraded(isDeg, async () => ({ latest: 7, trendDegraded: true }));
    await expect(recoverDegraded(() => inner())).resolves.toEqual({ latest: 7, trendDegraded: true });
  });

  it("simulates a cache layer: degraded result is recomputed next call, healthy one is stored", async () => {
    let calls = 0;
    let degradeNext = true;
    const inner = uncachedIfDegraded(isDeg, async () => {
      calls++;
      const r = { latest: calls, trendDegraded: degradeNext };
      degradeNext = false;
      return r;
    });
    // 최소 캐시 모형: 성공값만 저장, 예외는 저장 안 함(unstable_cache 와 동일 성질).
    let stored: R | null = null;
    const cached = async () => {
      if (stored) return stored;
      const r = await inner();
      stored = r;
      return r;
    };
    expect(await recoverDegraded(cached)).toEqual({ latest: 1, trendDegraded: true });
    expect(stored).toBeNull();
    expect(await recoverDegraded(cached)).toEqual({ latest: 2, trendDegraded: false });
    expect(await recoverDegraded(cached)).toEqual({ latest: 2, trendDegraded: false });
    expect(calls).toBe(2);
  });

  it("re-throws unrelated failures untouched", async () => {
    const boom = new Error("boom");
    await expect(recoverDegraded(() => Promise.reject(boom))).rejects.toBe(boom);
  });

  it("recovers by name when the error object identity was lost", async () => {
    const shaped = Object.assign(new Error("x"), { name: "DegradedResultUncached", result: { latest: 3, trendDegraded: true } });
    await expect(recoverDegraded(() => Promise.reject(shaped))).resolves.toEqual({ latest: 3, trendDegraded: true });
  });
});

// ── E-2: 무거운 미러 read 예산 ──────────────────────────────────────────────
describe("MIRROR_HEAVY_* — 실효 최악이 Vercel 함수 상한 안이어야 한다", () => {
  it("실효 최악(예산 + 문장 상한) < maxDuration 120s", () => {
    expect(MIRROR_HEAVY_BUDGET_MS + MIRROR_HEAVY_STATEMENT_TIMEOUT_MS).toBeLessThan(120_000);
  });

  it("문장 상한은 실측 최장 문장(6.27 s)의 콜드·여유 배수를 덮는다", () => {
    // 6.27 × 1.7 × 1.3 = 13.9 s (explain-s3.ts --mirror, 2026-09-10)
    expect(MIRROR_HEAVY_STATEMENT_TIMEOUT_MS).toBeGreaterThanOrEqual(13_900);
  });

  it("페이지 예산은 실측 합(25.2 s)의 콜드 배수를 덮는다", () => {
    expect(MIRROR_HEAVY_BUDGET_MS).toBeGreaterThanOrEqual(42_800);
  });

  it("mirrorHeavyBudget() 은 **부를 때마다** 마감을 새로 잡는다(캐시 키 오염 방지)", () => {
    const a = mirrorHeavyBudget();
    const b = mirrorHeavyBudget();
    expect(a.statementTimeoutMs).toBe(MIRROR_HEAVY_STATEMENT_TIMEOUT_MS);
    expect(b.deadlineAt).toBeGreaterThanOrEqual(a.deadlineAt);
    expect(a.deadlineAt).toBeGreaterThan(Date.now());
  });
});

// ── PR③-a: S1 대시보드 extras 예산 ─────────────────────────────────────────
describe("MIRROR_EXTRAS_* — extras 4경로의 실효 최악을 45 s 로 묶는다", () => {
  const worst = MIRROR_EXTRAS_BUDGET_MS + MIRROR_HEAVY_STATEMENT_TIMEOUT_MS;

  it("경로별 실효 최악 = 45 s (**페이지 보장이 아니다**)", () => {
    expect(worst).toBe(45_000);
    // ⚠️ 초판은 "페이지 최악 ≤60 s" 라고 적었고 프리뷰에서 반증됐다 — `/ko/dashboard`
    // 콜드 18건 중 3건이 120.5 s 절단, 절단 응답엔 `dashboard:filters` 만 도착했다.
    // 죽은 곳은 캡을 씌운 extras 가 아니라 **무예산 경계**(카드 미러 폴백·집계 읽기)다.
    // 페이지 보장은 그쪽에 예산이 붙어야 성립한다 → PR③ 위생 A.
    expect(worst).toBeLessThan(120_000);
  });

  it("엔진 예산보다 낮고, 단일 예산과는 사실상 같다 — 목적은 '더 짧게' 가 아니라 '하나로'", () => {
    // 종전: brandTrend 20+24=**44 s** · firstPosition 20+30=**50 s** ·
    //       standardTrend·mentions **상한 없음(∞)**.
    expect(worst).toBeLessThan(KPI_TAB_ENGINE_BUDGET_MS + KPI_TAB_STATEMENT_TIMEOUT_MS);
    expect(
      Math.abs(worst - (KPI_TAB_SINGLE_BUDGET_MS + KPI_TAB_STATEMENT_TIMEOUT_MS)),
    ).toBeLessThanOrEqual(2_000);
  });

  it("S3(무거운 인용)보다 짧다 — 한 경계에서 도는 경로 수가 더 많다", () => {
    expect(MIRROR_EXTRAS_BUDGET_MS).toBeLessThan(MIRROR_HEAVY_BUDGET_MS);
  });

  it("mirrorExtrasBudget() 은 부를 때마다 마감을 새로 잡는다(캐시 키 오염 방지)", () => {
    const a = mirrorExtrasBudget();
    expect(a.statementTimeoutMs).toBe(MIRROR_HEAVY_STATEMENT_TIMEOUT_MS);
    expect(a.deadlineAt).toBeGreaterThan(Date.now());
    expect(mirrorExtrasBudget().deadlineAt).toBeGreaterThanOrEqual(a.deadlineAt);
  });
});

// ── 호출자별 예산 프로파일 (검증 지적: S2 탭이 15 s 상한에서 degrade 문턱) ───
describe("KpiBudgetProfile — 같은 집계를 부르는 두 화면의 예산이 다르다", () => {
  it("kpi-tab 은 종전 값(20 s/30 s), extras 는 더 짧다(15 s/30 s)", () => {
    expect(kpiBudgetOf("kpi-tab")).toEqual({
      statementTimeoutMs: KPI_TAB_STATEMENT_TIMEOUT_MS,
      budgetMs: KPI_TAB_ENGINE_BUDGET_MS,
    });
    expect(kpiBudgetOf("extras")).toEqual({
      statementTimeoutMs: MIRROR_HEAVY_STATEMENT_TIMEOUT_MS,
      budgetMs: MIRROR_EXTRAS_BUDGET_MS,
    });
  });

  it("S2 는 **유지 또는 완화**다 — 어떤 경로도 상한이 줄지 않는다", () => {
    // base(6beb6d8): firstPosition = ENGINE(20/30) · brandTrend = SINGLE(20/**24**).
    // 프로파일이 둘을 ENGINE 으로 묶으므로 brandTrend 의 벽시계가 24 → 30 s 로 **늘어난다**
    // (실효 최악 44 → 50 s). 늘어나는 방향이라 degrade 가 덜 나고 S2 는 안전하다.
    const s2 = kpiBudgetOf("kpi-tab");
    expect(s2.statementTimeoutMs).toBeGreaterThanOrEqual(KPI_TAB_STATEMENT_TIMEOUT_MS);
    expect(s2.budgetMs).toBeGreaterThanOrEqual(KPI_TAB_SINGLE_BUDGET_MS);
    expect(s2.budgetMs).toBe(KPI_TAB_ENGINE_BUDGET_MS);
  });

  it("S2 탭의 문장 상한은 우선노출도 실측(14.8~15.2 s)보다 크다 — degrade 문턱 회피", () => {
    expect(kpiBudgetOf("kpi-tab").statementTimeoutMs).toBeGreaterThan(15_200);
    // extras 쪽은 그 문턱 아래다 — 대시보드는 degrade 를 감수하고 짧게 간다는 선택.
    expect(kpiBudgetOf("extras").statementTimeoutMs).toBeLessThan(15_200);
  });
});

// ── 배선 회귀 가드 — 상수만 맞고 콜사이트가 되돌아가는 것을 잡는다 ──────────
//
// 산술 테스트만으로는 `server.ts`/`page.tsx` 가 종전 예산으로 되돌아간 것을 못 잡는다.
// 소스 형태로 못 박는다(뮤테이션: `mirrorExtrasBudget()` → `KPI_TAB_*` 로 되돌리면 깨진다).
// PR④ B2: 대시보드 경쟁사 행의 **경계 조립**이 page.tsx 에서 읽기 계층으로 옮겨졌다
// (묶음의 모양이 화면 키 `S1.competitors` 에 달려 있어서 — server.ts 머리 주석).
// 그래서 "짧은 `extras` 를 명시하는 곳" 도 그 함수 본문이다. 페이지가 아니라 **경계**를
// 본다는 점이 요점이고, 규율 자체는 종전과 같다: 옵션을 잊은 호출부가 화면을 죽이지
// 않는 방향으로 기본값이 틀려 있고, 짧은 쪽은 이 한 경계에서만 명시된다.
function competitorBoundary(src: string): string {
  const i = src.indexOf("export async function fetchStandardCompetitorSources");
  if (i < 0) throw new Error("경쟁사 경계 함수를 찾지 못했다 — 가드가 죽었다");
  const j = src.indexOf("\n}\n", i);
  return src.slice(i, j);
}

describe("배선 — 콜사이트가 실제로 extras 예산을 쓴다", () => {
  const server = readFileSync(
    fileURLToPath(new URL("./server.ts", import.meta.url)),
    "utf8",
  );
  // page.tsx 는 더 읽지 않는다 — 경쟁사 경계 조립이 `server.ts::fetchStandardCompetitorSources`
  // 로 옮겨져(PR④ B1/B2) 단언이 전부 `competitorBoundary(server)` 로 갔다(미사용 변수 경고 제거).

  it("추이 셀이 `mirrorExtrasBudget()` 을 콜백 안에서 부른다", () => {
    for (const cell of ["standard-trend"]) {
      const i = server.indexOf(`mirrorCache("${cell}"`);
      expect(i, cell).toBeGreaterThan(0);
      // 셀 정의 블록(다음 `mirrorCache(` 전까지) 안에 예산 호출이 있어야 한다.
      const next = server.indexOf("mirrorCache(", i + 20);
      const block = server.slice(i, next > 0 ? next : i + 1500);
      expect(block, cell).toContain("mirrorExtrasBudget()");
    }
  });

  it("스파크·우선노출도는 **프로파일을 캐시 키로** 받는다", () => {
    for (const cell of ["kpi-brand-trend", "kpi-first-position"]) {
      const i = server.indexOf(`mirrorCache("${cell}"`);
      const next = server.indexOf("mirrorCache(", i + 20);
      const block = server.slice(i, next > 0 ? next : i + 1200);
      expect(block, cell).toContain("profile: KpiBudgetProfile");
      expect(block, cell).toContain("kpiBudgetOf(profile)");
      // 종전 상수를 직접 박아 두면(= 프로파일 무시) 깨진다.
      expect(block, cell).not.toContain("KPI_TAB_STATEMENT_TIMEOUT_MS");
    }
  });

  it("대시보드 경계만 `extras` 프로파일을 명시한다 — S2 탭은 기본값", () => {
    const boundary = competitorBoundary(server);
    expect(boundary).toContain('fetchStandardKpiBrandTrend(filters, { budget: "extras" })');
    expect(boundary).toContain('fetchStandardKpiFirstPosition(filters, { budget: "extras" })');
    const s2 = readFileSync(
      fileURLToPath(
        new URL(
          "../../app/[locale]/(dash)/standard/answer-analysis/mention/page.tsx",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(s2).not.toContain('budget: "extras"');
  });

  it("추이 degrade 라벨이 단위별로 갈려 있다 — day/week 가 섞이면 화면이 틀린 고지를 낸다", () => {
    expect(server).toContain("degradeAware(`standardTrend:${unit}`");
  });

  // ── 언급 셀은 **호출자별 프로파일**이다 (PR③ 통합, 2026-09-11) ──────────────
  //
  // 한 셀을 대시보드 경쟁사 행과 S2 언급 화면이 나눠 쓰는데 초과의 대가가 다르다.
  // 이 셋이 함께 지켜져야 의미가 있다: (a) 프로파일이 캐시 키에 있고 (b) 기본값이
  // 보수적인 쪽이며 (c) 대시보드만 짧은 쪽을 명시한다.
  it("언급 셀은 **프로파일을 캐시 키로** 받는다 — 한 예산을 박아 두면 깨진다", () => {
    const i = server.indexOf('mirrorCache("standard-mentions"');
    expect(i).toBeGreaterThan(0);
    const next = server.indexOf("mirrorCache(", i + 20);
    const block = server.slice(i, next > 0 ? next : i + 1200);
    expect(block).toContain("profile: MentionsBudgetProfile");
    expect(block).toContain("mentionsBudgetOf(profile)");
    // 프로파일을 무시하고 한쪽 예산을 직접 부르면(= 셀 공유 복귀) 깨진다.
    expect(block).not.toContain("mirrorExtrasBudget()");
  });

  it("언급 기본값은 **보수적인 쪽**(`screen`)이고 대시보드만 `extras` 를 명시한다", () => {
    // 기본값: 옵션을 잊은 호출부가 화면을 죽이지 않는 방향으로 틀린다.
    expect(server).toContain('cachedStandardMentions(f, opts.budget ?? "screen")');
    // PR④ B1·B2 — 경계가 경쟁사 전용 페처를 `extras` 로 부르고, 그 페처가 **같은
    // 프로파일**을 미러 폴백(`fetchStandardMentions`)에 그대로 넘긴다. 둘 다 봐야
    // 배선이 고정된다(한쪽만 보면 프로파일이 중간에서 증발해도 통과한다).
    expect(competitorBoundary(server))
      .toContain('fetchStandardCompetitorBrands(filters, { budget: "extras" })');
    expect(server).toContain('fetchStandardMentions(filters, { budget: opts.budget })');
    const s2 = readFileSync(
      fileURLToPath(
        new URL(
          "../../app/[locale]/(dash)/standard/answer-analysis/mention/page.tsx",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    // S2 는 기본값을 쓴다 — 여기에 `extras` 가 생기면 콜드 헤드라인이 죽는다(아래 부등식).
    expect(s2).not.toContain("fetchStandardMentions(filters, {");
  });
});

// ── 언급 프로파일의 산술 — 왜 S2 가 `extras` 면 안 되는가 ────────────────────
//
// 이 집계의 최장 문장은 **warm exec 9.19 s**(위생 A 세션 계측, 프로덕션 DB).
// 콜드 배수 1.7 을 곱한 **15.6 s** 가 판정선이다: 문장 상한이 그보다 작으면 정상 결과가
// 콜드에서 57014 로 죽는다(8 s 상한이 매번 문장을 죽이던 사고와 같은 형태).
describe("MentionsBudgetProfile — 상한이 콜드 실측을 덮는가", () => {
  const LONGEST_WARM_MS = 9_190;
  const COLD = 1.7;
  const coldMs = LONGEST_WARM_MS * COLD; // 15,623 ms

  it("`screen` 은 콜드 외삽을 덮고, `extras` 는 못 덮는다(그래서 갈랐다)", () => {
    const screen = mentionsBudgetOf("screen");
    const extras = mentionsBudgetOf("extras");
    expect(screen.statementTimeoutMs ?? 0).toBeGreaterThan(coldMs);
    expect(extras.statementTimeoutMs ?? 0).toBeLessThan(coldMs);
    // 대시보드가 짧은 쪽을 쓰는 것은 **선택**이다 — 그 지면은 degrade 를 감수한다.
    expect(extras.statementTimeoutMs).toBe(MIRROR_HEAVY_STATEMENT_TIMEOUT_MS);
  });

  it("벽시계도 화면 쪽이 길다 — degrade 문턱이 화면에서 더 뒤에 온다", () => {
    const now = Date.now();
    const screen = mentionsBudgetOf("screen").deadlineAt - now;
    const extras = mentionsBudgetOf("extras").deadlineAt - now;
    expect(screen).toBeGreaterThan(extras);
    // 실효 최악 = 벽시계 + 문장. 화면 57 s · 대시보드 45 s (예산 지도 표와 같은 값).
    expect(Math.round(screen / 1000) + 22).toBe(57);
    expect(Math.round(extras / 1000) + 15).toBe(45);
  });
});
