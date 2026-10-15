import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readSourceText } from "@/test/source-text";

// ════════════════════════════════════════════════════════════════════════════
// 통합 배선 가드 — 플래그 → 달력 / 플래그 → 비교 (앵커 축 전환, 2026-09-20)
// ════════════════════════════════════════════════════════════════════════════
//
// 세 스트림(READERS·CALENDAR·COMPARE)은 서로를 모른 채 만들어졌다: 달력은 prop
// `selectableDates` 를 **주입받고**, 비교 리더는 옵션 `{ anchorAxis }` 를 **주입받는다**
// (계약 §4). 그 주입을 실제로 하는 코드는 통합 단계에만 있고, 값이 아니라 **배선**이라
// 단위 테스트로는 잡히지 않는다 — prop 하나를 지워도 tsc 도 vitest 도 조용하다.
//
// 그래서 여기서는 배선 자체를 기계로 고정한다. `lib/perf/read-timing.test.ts` 가
// `server.ts` 의 호출부를 소스로 보는 것과 같은 자세다.
//
// ⚠️ **런타임 import 는 못 한다.** `lib/scope/server.ts` 는 `server-only` + DB + Next
//    캐시를 끌고 오므로 vitest 러너에서 열리지 않는다(이 리포의 어떤 테스트도 그것을
//    런타임으로 import 하지 않는다 — 전부 소스 분석이다).

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readSourceText(`${REPO_ROOT}/${rel}`);

const SERVER_TS = "lib/scope/server.ts";
const SERVER_SRC = read(SERVER_TS);

/**
 * **시간 축이 뜨는 모든 지면**과 그 달력 배선. 새 지면이 `selectableDates` 없이 기간
 * 필터를 렌더하면 여기서 깨져야 한다(검증 W1: 종전 5지면만 열거해 7곳 누락을 놓쳤다).
 *
 * 계열은 D1 의 지면 단위 규칙을 따른다 — 그 지면의 데이터 리더가 쓰는 계열과 같다.
 */
const CALENDAR_SURFACES: ReadonlyArray<[label: string, file: string, expr: string]> = [
  [
    "글로벌 Overview",
    "app/[locale]/(dash)/dashboard/page.tsx",
    'selectableDates={await fetchSelectableAnchorDates("global", filters, "all")}',
  ],
  [
    "글로벌 언급",
    "app/[locale]/(dash)/standard/answer-analysis/mention/page.tsx",
    'selectableDates={await fetchSelectableAnchorDates("global", filters, "mentions")}',
  ],
  [
    "글로벌 인용",
    "app/[locale]/(dash)/standard/answer-analysis/citation/page.tsx",
    'selectableDates={await fetchSelectableAnchorDates("global", filters, "citations")}',
  ],
  [
    "글로벌 ACR",
    "app/[locale]/(dash)/standard/ai-funnel/acr/page.tsx",
    'selectableDates={await fetchSelectableAnchorDates("global", filters, "all")}',
  ],
  [
    "website Overview",
    "app/[locale]/(dash)/website/page.tsx",
    'selectableDates={await fetchSelectableAnchorDates("website", filters, "all")}',
  ],
  [
    "website 언급",
    "app/[locale]/(dash)/website/answer-analysis/mention/page.tsx",
    'selectableDates={await fetchSelectableAnchorDates("website", filters, "mentions")}',
  ],
  [
    "website 인용",
    "app/[locale]/(dash)/website/answer-analysis/citation/page.tsx",
    'selectableDates={await fetchSelectableAnchorDates("website", filters, "citations")}',
  ],
  [
    "website 프롬프트",
    "app/[locale]/(dash)/website/prompts/page.tsx",
    'selectableDates={await fetchSelectableAnchorDates("website", {}, "all")}',
  ],
  [
    "프로젝트 대시보드",
    "app/[locale]/(dash)/projects/[id]/_components/project-dashboard.tsx",
    'selectableDates={await fetchProjectSelectableAnchorDates(projectId, filters, "all")}',
  ],
  [
    "프로젝트 언급",
    "app/[locale]/(dash)/projects/[id]/analysis/mention/page.tsx",
    'selectableDates={await fetchProjectSelectableAnchorDates(id, filters, "mentions")}',
  ],
  [
    "프로젝트 인용",
    "app/[locale]/(dash)/projects/[id]/analysis/citation/page.tsx",
    'selectableDates={await fetchProjectSelectableAnchorDates(id, filters, "citations")}',
  ],
];

/**
 * 시간 축이 있는데 **의도적으로 배선하지 않은** 지면과 그 근거.
 *
 * 근거가 파일에서 사라지면(= 그 화면이 실데이터를 읽기 시작하면) 이 가드가 깨져
 * 배선을 다시 검토하게 만든다. 빈 목록으로 두고 조용히 넘어가지 않는 것이 요점이다.
 */
const CALENDAR_EXEMPT: ReadonlyArray<[label: string, file: string, reason: string]> = [
  [
    "ai-funnel 가시성",
    "app/[locale]/(dash)/standard/ai-funnel/_components/visibility-view.tsx",
    // 이 화면은 DB 를 전혀 읽지 않는다(픽스처). 회차 목록을 읽어 봐야 달력만 잠그고
    // 왕복이 는다. 실데이터로 바뀌면 아래 문장이 사라져 이 가드가 깨진다.
    "../_data/sample",
  ],
  [
    // 프로젝트 ACR·웹사이트 ACR 두 라우트가 쓰는 뷰(N6). `onlyGroups` 를 안 줘서
    // `ALL_GROUPS`(기간 축 포함)를 띄우지만 값은 픽스처다 — 실데이터 ACR 지면은
    // `acr-live-view.tsx` 쪽이고 그쪽은 배선돼 있다.
    "ai-funnel ACR (픽스처 뷰)",
    "app/[locale]/(dash)/standard/ai-funnel/_components/acr-view.tsx",
    "../_data/sample",
  ],
];

/** 지면 → 패널 사이에 prop 을 **중계**하는 컴포넌트들(끊기면 값이 조용히 사라진다). */
const CALENDAR_RELAYS: ReadonlyArray<[label: string, file: string]> = [
  ["OverviewFilters", "app/[locale]/(dash)/dashboard/_components/overview-filters.tsx"],
  [
    "AnalysisFilterBar",
    "app/[locale]/(dash)/standard/answer-analysis/_components/analysis-filter-bar.tsx",
  ],
  ["WebsiteFilters", "components/dash/website-filters.tsx"],
  [
    "MentionsView",
    "app/[locale]/(dash)/standard/answer-analysis/_components/mentions-view.tsx",
  ],
  [
    "CitationsView",
    "app/[locale]/(dash)/standard/answer-analysis/_components/citations-view.tsx",
  ],
  ["AcrLiveView", "app/[locale]/(dash)/standard/ai-funnel/_components/acr-live-view.tsx"],
  [
    "WebsitePromptFilters",
    "app/[locale]/(dash)/website/prompts/_components/prompt-filters.tsx",
  ],
];

describe("플래그 → 달력 (스펙 §5.1)", () => {
  it.each(CALENDAR_SURFACES)("%s 이 selectableDates 를 내린다", (_label, file, expr) => {
    expect(read(file)).toContain(expr);
  });

  it.each(CALENDAR_RELAYS)("%s 가 prop 을 패널까지 중계한다", (_label, file) => {
    const src = read(file);
    // 받는 자리(구조분해)와 내리는 자리(JSX)가 **둘 다** 있어야 한다.
    expect(src).toMatch(/\n\s+selectableDates,\n/);
    expect(src).toContain("selectableDates={selectableDates}");
  });

  it.each(CALENDAR_EXEMPT)("%s 는 면제이고 근거가 파일에 남아 있다", (_l, file, reason) => {
    const src = read(file);
    expect(src).not.toContain("selectableDates");
    expect(src, `면제 근거 "${reason}" 가 사라졌다 — 배선을 다시 검토할 것`).toContain(
      reason,
    );
  });

  // ⚠️ 목록은 낡는다. 그래서 **패널을 그리는 파일을 소스에서 다시 세어**, 그중
  //    `selectableDates` 를 받지도 넘기지도 않는 것이 있으면 깨뜨린다.
  //
  //    ⚠️ 술어를 "파일 안에 `"time"` 리터럴이 있는가" 로 두면 **샌다**(검증 N6):
  //    이 리포는 그룹 목록을 다른 파일의 상수로 두는 일이 흔하고(`ALL_GROUPS` ·
  //    `CONVERSION_GROUPS`), `onlyGroups` 를 아예 안 주면 패널이 `ALL_GROUPS`(= 기간 축
  //    포함)를 띄운다. `acr-view.tsx` 가 정확히 그 형태였고 가드가 조용히 건너뛰었다.
  //    그래서 판정은 **"기간 축이 없다고 증명된 경우만 제외"** 로 뒤집는다.
  it("필터 패널을 그리는 파일은 전부 selectableDates 를 넘기거나 면제 목록에 있다", () => {
    const exempt = new Set(CALENDAR_EXEMPT.map(([, f]) => f));
    const renderers = execSync(
      `grep -rlE '<(DimensionFilterPanel|AnalysisFilterBar)' "${REPO_ROOT}app" "${REPO_ROOT}components" --include=*.tsx | grep -v '\\.test\\.' || true`,
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean)
      .map((f) => f.slice(REPO_ROOT.length))
      .filter((f) => !f.endsWith("components/dash/dimension-filter-panel.tsx"));

    /**
     * 그 파일이 **기간 축이 없다고 증명하는가**. 증명 방법은 하나뿐이다:
     * `onlyGroups` 를 명시하면서 그 목록에 `"time"` 이 없는 것. 목록이 다른 파일의
     * 상수면 증명이 안 되므로 대상으로 남는다(= 배선하거나 면제에 넣어야 한다).
     */
    const provesNoTimeAxis = (src: string): boolean => {
      // (a) 인라인 목록
      const inline = /onlyGroups=\{\[([^\]]*)\]\}/.exec(src);
      if (inline) return !inline[1].includes('"time"');
      // (b) **같은 파일 안에서 정의된** 상수 목록. 다른 파일의 상수는 증명이 아니다
      //     (그쪽이 바뀌면 여기 가드가 모른 채 지나간다).
      const named = /onlyGroups=\{(\w+)\}/.exec(src);
      if (!named) return false;
      const def = new RegExp(
        `const ${named[1]}(?::[^=]*)? = \\[([^\\]]*)\\]`,
        "m",
      ).exec(src);
      return def !== null && !def[1].includes('"time"');
    };

    const missing = renderers.filter((f) => {
      if (exempt.has(f)) return false;
      const src = read(f);
      if (provesNoTimeAxis(src)) return false;
      return !src.includes("selectableDates=");
    });
    expect(
      missing,
      `기간 필터를 그리는데 달력이 안 배선된 파일: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("축이 꺼지면 두 게이트웨이가 `enforce` 전에 undefined 로 닫는다", () => {
    // off 에서 감사 행이 쌓이면 "종전 동작 무변경"이 부수효과 층에서 깨진다
    // (`fetchPeriodCompare` 의 ① 주석과 같은 규율).
    for (const fn of ["fetchSelectableAnchorDates", "fetchProjectSelectableAnchorDates"]) {
      const at = SERVER_SRC.indexOf(`export async function ${fn}(`);
      expect(at, `${SERVER_TS}: ${fn} 를 못 찾았다`).toBeGreaterThan(-1);
      const head = SERVER_SRC.slice(at, at + 600);
      const guard = head.indexOf("if (!(await ensureAnchorAxis())) return undefined;");
      expect(guard, `${fn}: 축 off 가드가 없다`).toBeGreaterThan(-1);
      // 가드가 withWebsite/withStandardRoot/withProject(= enforce) **앞**이어야 한다.
      for (const gate of ["withWebsite(", "withStandardRoot(", "withProject("]) {
        const g = head.indexOf(gate);
        if (g > -1) expect(g, `${fn}: ${gate} 가 가드보다 앞이다`).toBeGreaterThan(guard);
      }
    }
  });

  it("달력 로더에 기간·엔진·국가 필터를 넘기지 않는다 (범위는 표면·프로젝트·계열)", () => {
    // `from/to` 를 넘기면 고른 기간 밖으로 나갈 수가 없고, 엔진·국가를 값 필터로
    // 넘기면 필터를 바꿀 때마다 달력이 흔들린다. 집계층의 **회차 선택**도 그 둘을
    // 보지 않으므로(`anchorSnapshotPreds`), 안 넘기는 것이 두 축을 맞추는 쪽이다.
    // 기본 엔진 범위는 리더가 자기 안에서 건다(숨김 계열 일관성 describe).
    const at = SERVER_SRC.indexOf("async function selectableDatesFor(");
    expect(at).toBeGreaterThan(-1);
    const body = SERVER_SRC.slice(at, SERVER_SRC.indexOf("\n}", at));
    expect(body).toContain("loadSelectableAnchorDates(surface, projectIds, {}, family)");
    expect(body).not.toContain("filters");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// capability 프로브 — 축을 켜는 초석이 **최신 판 전용 컬럼**인가
// ════════════════════════════════════════════════════════════════════════════
//
// 이 리포는 머지 = 무인 배포이고 마이그레이션은 사람이 따로 적용한다. 초석이 "모든
// 판에 있는 컬럼"이면 **구판 0077 만 적용된 DB 가 프로브를 통과**하고, 리더가
// `ca.round_date` 로 42703 을 맞아 대시보드가 통째로 죽는다(N-15 의 형태).
//
// `round_date` 와 매핑 표 `scope_cycle_rounds` 는 **같은 0077 파일**에서 생기고
// 이 리포의 적용 경로는 "파일 = 한 트랜잭션"이라, 초석 하나가 둘 다를 덮는다.
describe("capability 프로브 (계약 §4)", () => {
  const AVAIL_SRC = read("lib/db/column-availability.ts");
  const MIG_0077 = read("lib/db/migrations/0077_scope_answer_cycle_anchors.sql");

  it("초석은 `round_date` 다 (구판에도 있는 컬럼이 아니다)", () => {
    const at = AVAIL_SRC.indexOf("export function answerCycleAnchorsAvailable(");
    expect(at).toBeGreaterThan(-1);
    const body = AVAIL_SRC.slice(at, AVAIL_SRC.indexOf("\n}", at));
    expect(body).toContain('columnAvailable("scope_answer_cycle_anchors", "round_date")');
    // 구판에도 있던 컬럼을 초석으로 되돌리면 이 가드가 운다.
    for (const stale of ["anchor_date", "measured_at_orig", "fleet_round_date"]) {
      expect(body).not.toContain(`"${stale}"`);
    }
  });

  it("초석과 매핑 표가 같은 마이그레이션에서 생긴다 (프로브 하나로 충분한 근거)", () => {
    expect(MIG_0077).toContain("round_date         date NOT NULL");
    expect(MIG_0077).toContain("CREATE TABLE scope_cycle_rounds");
  });

  it("축 판정으로 들어가는 문은 그 프로브 하나뿐이다", () => {
    // ⚠️ 순서는 **스위치 먼저, capability 나중**이다(READERS 검증 주의 A-1: 프로브가
    //    `ensureColumnAvailability()` 배치 밖 별도 문장이라, 앞에 두면 축이 꺼진
    //    오늘도 콜드 요청마다 왕복이 하나 는다). 가드가 보는 것은 순서가 아니라
    //    **capability 가 여전히 반환값을 지배하는가** 다 — 떼면 `ca.round_date` 가
    //    42703 으로 죽어 대시보드 전 화면이 장애가 된다.
    const flag = read("lib/period/anchor-axis-flag.ts");
    const at = flag.indexOf("export async function answerAnchorEnabled(");
    expect(at).toBeGreaterThan(-1);
    const body = flag.slice(at, flag.indexOf("\n}", at));
    expect(body).toContain("if (!switchedOn) return false;");
    // 마지막 말은 프로브가 한다 — `return answerCycleAnchorsAvailable();`
    expect(body).toContain("return answerCycleAnchorsAvailable();");
    // 상태 모듈은 플래그를 경유한다 — 프로브를 건너뛰는 두 번째 경로가 없어야 한다.
    expect(read("lib/period/anchor-axis-state.ts")).toContain("await answerAnchorEnabled()");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// `round_date` 컬럼 리터럴은 **한 곳**에서만 정의된다
// ════════════════════════════════════════════════════════════════════════════
//
// 정본은 `lib/period/anchor-axis.ts::anchorRoundDateSql` 이고 리포지토리의
// `anchorDateColumnSql` 은 그것을 부른다. 두 벌로 살면 한쪽만 고쳐질 때 달력이
// 칠하는 날짜와 기간 술어가 거는 날짜가 갈리는데, 그건 화면만 봐서는 "그날
// 데이터가 없다"로 보인다(이 전환이 없애려는 결함).
describe("round_date 리터럴 단일화", () => {
  const ANCHORS_SRC = read("lib/db/repositories/scope-answer-anchors.ts");
  const AXIS_SRC = read("lib/period/anchor-axis.ts");

  it("정본은 anchor-axis.ts 한 곳이다", () => {
    expect(AXIS_SRC).toContain('col(alias, "round_date")');
    expect(AXIS_SRC).not.toContain('col(alias, "anchor_date")');
  });

  it("리포지토리는 리터럴을 다시 적지 않고 정본을 부른다", () => {
    const code = stripComments(ANCHORS_SRC);
    expect(code).toContain("anchorRoundDateSql(alias)");
    expect(code).not.toContain("round_date`");
    expect(code).not.toContain(".anchor_date");
  });

  it("순환이 없다 — 정본 모듈은 drizzle 만 import 한다", () => {
    const imports = AXIS_SRC.split("\n").filter((l) => l.startsWith("import "));
    expect(imports).toEqual(['import { sql, type SQL } from "drizzle-orm";']);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 숨김 계열 — 한 화면 안에서 달력·기준 회차·카드가 **같은 계열**을 쓴다
// ════════════════════════════════════════════════════════════════════════════
//
// `anchorNotHiddenSql(family)` 에서 `'mentions'` 가 가장 느슨하다(0071
// `hidden_scope='citations'` 로 숨긴 회차를 **남긴다**). `'citations'`·`'all'` 은
// 같은 식으로 더 엄하다.
//
// 2026-09-20 계약: 기본은 느슨한 `'mentions'`(집계층 `DEFAULT_HIDDEN_FAMILY` 와 같은
// 값), 인용 화면만 `'citations'`. 종전처럼 달력만 `'all'` 로 두면 언급 화면에서
// **행은 보이는데 그 날짜를 고를 수 없다**.
//
// 계열이 **기준 회차를 가를 수 있다**(검증 N2): 인용만 숨긴 회차가 최신이면 언급
// 화면은 그 회차를, 인용 화면은 그 앞 회차를 본다. 한 화면 안에서 갈리지 않는 것이
// 계약이고, 아래가 그 배선을 고정한다.
describe("숨김 계열 일관성", () => {
  const ANCHORS = read("lib/db/repositories/scope-answer-anchors.ts");
  const AGG = read("lib/db/repositories/scope-aggregates.ts");
  const LOADER = read("lib/calendar/selectable-anchor-dates.ts");

  it("집계층 기본 계열은 느슨한 'mentions' 다", () => {
    expect(AGG).toContain('const DEFAULT_HIDDEN_FAMILY: AnchorHiddenFamily = "mentions";');
    expect(AGG).toContain('family === "mention" ? "mentions" : "citations"');
  });

  it("최신 회차를 고르는 서브쿼리가 바깥과 같은 계열이다 (N2)", () => {
    const at = AGG.indexOf("function anchorSnapshotPreds(");
    expect(at).toBeGreaterThan(-1);
    const body = AGG.slice(at, AGG.indexOf("\n}", at));
    // 안쪽(ca2)·바깥(ca) 둘 다 인자 `family` 를 받는다 — 'all' 고정이면 바깥 항이 죽는다.
    expect(body).toContain('anchorNotHiddenKnownSql("ca2", family)');
    expect(body).toContain('anchorNotHiddenKnownSql("ca", family)');
    expect(body).not.toContain('anchorNotHiddenKnownSql("ca2", "all")');
  });

  it("달력 리더도 계열을 받고, 기본이 집계층과 같다", () => {
    const at = ANCHORS.indexOf("export async function listSelectableAnchorDates(");
    const body = ANCHORS.slice(at, ANCHORS.indexOf("\n}\n", at));
    expect(body).toContain('family: AnchorHiddenFamily = "mentions"');
    expect(body).toContain("await anchorNotHiddenSql(family)");
    expect(body).not.toContain('anchorNotHiddenSql("all")');
  });

  it("계열이 로더 캐시 키에 들어간다", () => {
    const at = LOADER.indexOf("export function selectableAnchorDatesCacheKey(");
    const body = LOADER.slice(at, LOADER.indexOf("\n}", at));
    expect(body).toContain("family");
  });

  // ⚠️ **달력의 계열은 그 화면의 카드 리더와 같아야 한다.** 세 값이 다 쓰인다:
  //   · `'all'`        — Overview·website·프로젝트. 카드가 7 KPI 묶음
  //     (`aggregateStandardFromMirror` → `snapshotAnswerWhere(..., "all")`)이라
  //     인용만 숨긴 회차는 그 카드에서 빠진다 → 달력에서도 못 고르는 것이 맞다.
  //   · `'mentions'`   — 언급 화면. 카드가 `aggregateMentionsFromMirror`(느슨).
  //   · `'citations'`  — 인용 화면. 카드가 `aggregateCitationsFromMirror`.
  // 지면마다 **명시**한다 — 기본값에 기대면 카드 리더가 바뀔 때 조용히 갈린다.
  // ⚠️ **계열은 지면 단위다**(D1, 통합 검증 후속). 종전 이 단언은 카드 2개만 봤고,
  //    그 구멍으로 Overview 의 주제 도넛·GEO 경쟁이 `'mentions'`(느슨) 기본값에
  //    남아 있었다. N2 수리로 최신 회차 게이트가 바깥 계열을 따라가므로, 느슨한
  //    위젯은 인용만 숨긴 회차를 최신으로 잡고 나머지는 그 앞 회차를 잡는다 —
  //    달력에 없는 날짜를 그 위젯만 그린다. 그래서 **그 지면이 부르는 앵커 리더
  //    전부**가 같은 계열을 받는지로 넓힌다.
  it("한 지면의 모든 앵커 리더가 같은 계열을 받는다", () => {
    const AGG = read("lib/db/repositories/scope-aggregates.ts");

    /** 리더 하나의 본문(다음 export 직전까지). */
    const bodies = (() => {
      const out = new Map<string, string>();
      const marks = [...AGG.matchAll(/^export async function (\w+)/gm)];
      marks.forEach((m, i) => {
        const end = i + 1 < marks.length ? marks[i + 1].index! : AGG.length;
        out.set(m[1], AGG.slice(m.index!, end));
      });
      return out;
    })();

    /** 그 리더가 술어 빌더에 넘기는 계열. 인자가 없으면 기본값 'mentions'. */
    const familyOf = (name: string): string => {
      const b = bodies.get(name) ?? fnBody(name);
      expect(b, `${name} 을 찾지 못했다`).toBeDefined();
      if (/hiddenFamily: "citations"|, "citations"\)/.test(b!)) return "citations";
      if (/hiddenFamily: "all"|, "all"\)|\n\s*"all",/.test(b!)) return "all";
      return "mentions";
    };

    /** `export function` (비-async) 리더도 본다 — `acrWhere` 가 그 형태다. */
    function fnBody(name: string): string | undefined {
      const at = AGG.indexOf(`export function ${name}(`);
      if (at < 0) return undefined;
      const next = AGG.indexOf("\nexport ", at + 10);
      return AGG.slice(at, next === -1 ? undefined : next);
    }

    // 지면 → 그 지면이 그리는 앵커 리더 전부(카드·SubKPI·추이·GEO KPI·주제 도넛·
    // GEO 경쟁·출처 구성). 달력은 지면 파일에서 따로 단언한다(CALENDAR_SURFACES).
    const PAGES: ReadonlyArray<[page: string, family: string, readers: string[]]> = [
      [
        "Overview·website·프로젝트 (7 KPI 묶음 카드)",
        "all",
        [
          "aggregateStandardFromMirror",
          "aggregateSubKpisFromMirror",
          "aggregateStandardTrendFromMirror",
          "aggregateGeoKpiFromMirror",
          "aggregatePromptTopicFromMirror",
          "aggregateGeoCompetitionFromMirror",
          "aggregateSourceCompositionFromMirror",
        ],
      ],
      ["답변분석 언급", "mentions", ["aggregateMentionsFromMirror"]],
      ["답변분석 인용", "citations", ["aggregateCitationsFromMirror"]],
      // ACR 지면(N1) — 달력이 `'all'` 이므로 run 축 리더도 `'all'` 이어야 한다.
      // 기본값에 두면 인용만 숨긴 회차가 최신일 때 달력과 카드가 다른 회차를 본다.
      ["글로벌 ACR", "all", ["acrWhere"]],
    ];

    for (const [page, family, readers] of PAGES) {
      for (const r of readers) {
        expect(familyOf(r), `${page}: ${r} 의 계열이 ${family} 가 아니다`).toBe(family);
      }
    }
  });

  it("그 지면의 달력이 같은 계열을 받는다", () => {
    // CALENDAR_SURFACES 가 지면 파일의 3번째 인자를 이미 고정한다. 여기서는 그 값이
    // 위 표와 같은 낱말인지만 본다 (지면 파일과 리더가 따로 표류하지 않게).
    const byPage: ReadonlyArray<[file: string, family: string]> = [
      ["app/[locale]/(dash)/dashboard/page.tsx", "all"],
      ["app/[locale]/(dash)/website/page.tsx", "all"],
      ["app/[locale]/(dash)/projects/[id]/_components/project-dashboard.tsx", "all"],
      ["app/[locale]/(dash)/standard/answer-analysis/mention/page.tsx", "mentions"],
      ["app/[locale]/(dash)/standard/answer-analysis/citation/page.tsx", "citations"],
    ];
    for (const [file, family] of byPage) {
      expect(read(file), `${file}: 달력 계열이 ${family} 가 아니다`).toContain(
        `filters, "${family}")`,
      );
    }
  });

  it("달력의 회차 모수가 집계층의 회차 선택과 같다 (기본 엔진 범위)", () => {
    // 집계층은 엔진 필터가 비었을 때 `is_default_engine` 을 건다. 달력이 안 걸면
    // 옵트인 엔진만 있는 회차가 달력에는 뜨는데 화면은 빈다.
    const at = ANCHORS.indexOf("export function selectableAnchorDatesSql(");
    const body = ANCHORS.slice(at, ANCHORS.indexOf("\n}\n", at));
    expect(body).toContain("anchorDefaultEngineScope(filters.engines)");
    const aggAt = AGG.indexOf("function anchorSnapshotPreds(");
    expect(AGG.slice(aggAt, AGG.indexOf("\n}", aggAt))).toContain(
      "anchorDefaultEngineScope(f.engine)",
    );
  });
});

/** 주석 줄을 뺀 소스 — 리터럴 단언이 주석 안의 예시에 걸리지 않게 한다. */
function stripComments(src: string): string {
  return src
    .split("\n")
    .filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l))
    .join("\n");
}
