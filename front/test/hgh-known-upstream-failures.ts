// hub known failures of the vendored upstream (hmg-geo) front tests.
//
// Why. front/ is the hmg-geo tree (vendor sync, docs/design sync plans); hub does not edit the
// upstream legacy code. A few upstream unit tests fail on the upstream tree itself, because the
// upstream changed the code a source guard counts and did not update the guard (classified (b):
// upstream code and test disagree). They are isolated here by FULL TEST NAME, so the other cases
// of the same files keep running (a file level exclude would drop 70 passing cases with them).
// Not it.skip: the upstream test files stay byte identical to the vendor snapshot.
//
// Mechanism. vitest.config.ts turns this list into test.testNamePattern (a negative lookahead):
// a listed test is reported as skipped, everything else runs as before. A vitest full name is
// "<describe> <test>" (the file is not part of it); hgh-known-upstream-failures.test.ts checks
// that every entry still names exactly one test in its file and nowhere else.
//
// Release. Each entry names the upstream commit that broke it and what the upstream fix is. At
// the next sync, run the listed files with the list off and drop every entry that passes:
//   HGH_RUN_KNOWN_FAILURES=1 npx vitest run <file> ...
// Classification of the six at sync S1 (hmg-geo 2670a16): all (b). None is clock dependent (a)
// or environment dependent (c): each fails the same way on the pure vendor tree
// (68705274 front/, run 2026-09-30) and the counts match the commit that broke it.

export interface KnownUpstreamFailure {
  /** Test file, relative to front/. */
  file: string;
  /** describe() title. */
  suite: string;
  /** it() title. */
  test: string;
  /** (a) clock, (b) upstream code vs test, (c) environment. */
  kind: "a" | "b" | "c";
  /** Upstream commit whose code change the test was not updated for. */
  brokenBy: string;
  /** What fails and what the upstream fix is (the release condition). */
  why: string;
}

const DASH = "—";

export const KNOWN_UPSTREAM_FAILURES: readonly KnownUpstreamFailure[] = [
  {
    file: "lib/period/trend-grid-wiring.test.ts",
    suite: `리더 경계 ${DASH} 추이 셋만 게이트를 뺀다`,
    test: "추이 read 세 곳이 전부 `withTrendGrid` 를 거친다",
    kind: "b",
    brokenBy: "d175da4 (citation category Δ base = previous round slot, #322)",
    why:
      "expects 3 `await withTrendGrid(scope)` in summary-global-trend-read.ts; d175da4 added a 4th " +
      "(readGlobalSlotGroupCitations, the category Δ slot read). Upstream fix: count 4 and list the new reader",
  },
  {
    file: "lib/scope/mirror-cache-cycle-mode.test.ts",
    suite: "mirrorCycleModeOf",
    test: "② 회차 집합 키를 받는 셀은 전부 summary-* 이름이다",
    kind: "b",
    brokenBy: "d175da4 (new mirrorCache cell citation-categories-prev-round)",
    why:
      "the new cell takes a cycle set key (_cycleKey) but is not named summary-*, so mirrorCycleModeOf gives it " +
      "the gate fingerprint on top of the key (harmless per the module header, colder cache only). Upstream fix: " +
      "rename the cell summary-citation-categories-prev-round, or list it as an exception in the test",
  },
  {
    file: "lib/summary/health/url-hits-coverage.test.ts",
    suite: "cycle-chain-watch 라우트 배선",
    test: "감시 ③ 을 다른 둘과 **독립으로** 판정하고 Slack 으로 보낸다",
    kind: "b",
    brokenBy: "2d310ec (#327 anchor gap watch ④)",
    why:
      "expects `Math.max(viewLag.severity, backlog.severity, urlHits.severity)` in the cycle-chain-watch route; " +
      "#327 added anchorGap.severity to it. Upstream fix: expect the four-argument Math.max",
  },
  {
    file: "lib/db/repositories/trend-grid-body-window.sql.test.ts",
    suite: `배선 ${DASH} 헬퍼가 읽기 필터를 건드리지 않는다`,
    test: "자리 창을 거는 페처는 추이 전용이다",
    kind: "b",
    brokenBy: "d175da4 (citationCategoriesPrevRound)",
    why:
      "expects 5 withTrendGridWindow( calls in lib/scope/server.ts; d175da4 added a 6th in " +
      "citationCategoriesPrevRound (the card Δ slot set, a trend derived read). Upstream fix: count 6 and add it to TREND_ONLY or an allow list",
  },
  {
    file: "app/[locale]/(dash)/standard/answer-analysis/_components/citations-standard-view.category-competitor.test.tsx",
    suite: "출처 카테고리별 현황 × 경쟁사 선택",
    test: `선택 중에는 카테고리 Δ 배지를 숨긴다 (제품 결정 D5 ${DASH} 비교 기준이 다르다)`,
    kind: "b",
    brokenBy: "12c9d0c (keep the full citation total as the category denominator under a competitor pick)",
    why:
      "expects no Δ badge in the category section while a competitor is picked; 12c9d0c narrowed D5 on purpose " +
      "(only the Official (Competitor) bar hides its Δ, the others keep theirs). Upstream fix: assert that bar only",
  },
  {
    file: "app/[locale]/(dash)/standard/answer-analysis/_data/overview-read-filters.test.ts",
    suite: "Overview 원천 밖 read 는 누적 의미론 그대로다",
    test: "정규화는 노출률 두 read 에만 걸린다",
    kind: "b",
    brokenBy: "d175da4 (citationCategoriesPrevRound reads overviewReadFilters(filters))",
    why:
      "expects 5 `overviewReadFilters(filters)` in lib/scope/server.ts; d175da4 added a 6th (the category Δ reads " +
      "the card Δ input on purpose). Upstream fix: count 6 and name the new call site",
  },
];

/** "<describe> <test>", the name vitest matches testNamePattern against. */
export function fullName(f: Pick<KnownUpstreamFailure, "suite" | "test">): string {
  return `${f.suite} ${f.test}`;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Matches every full name except the listed ones (vitest skips a test whose name does not match). */
export function knownFailurePattern(list: readonly KnownUpstreamFailure[] = KNOWN_UPSTREAM_FAILURES): RegExp | undefined {
  if (!list.length) return undefined;
  return new RegExp(`^(?!(?:${list.map((f) => escape(fullName(f))).join("|")})$)`);
}
