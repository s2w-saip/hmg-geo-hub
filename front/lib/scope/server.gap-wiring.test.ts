/**
 * 0070 갭 슬롯 **배선 가드** — 핫픽스 C 후속(검증자 D1·D2).
 *
 * 두 가지를 고정한다. 둘 다 "화면을 열어도 안 보이는" 종류의 결함이다.
 *
 * ── D1. 한 화면 안에서 규칙이 갈리지 않는다 ────────────────────────────────
 * 프로젝트 답변분석 페이지(`/projects/[id]/analysis/{mention,citation}`)는 추이와
 * 주별 Top-N 을 같은 축 위에 나란히 그린다. 핫픽스 C 는 `fetchProjectTrend` 에만
 * 갭을 얹었고 `fetchProjectMentions`·`fetchProjectCitations` 를 빼놓았다 — 실측으로
 * 추이는 14주(8/24 GAP)인데 주별 인용은 13주에 마커가 없었다. 값이 사라진 것이
 * 아니라 **그 주가 없었던 것처럼** 보이는, 숨김이 만드는 두 번째 거짓말이다.
 *
 * ── D2. degrade 보호가 게이트를 덮는다 ─────────────────────────────────────
 * `withWebsite` 안에는 `enforce`·`cachedProjectIdsForScope`·`ownEntitiesForJudgment`
 * 가 있다. 핫픽스 C 가 중첩을 뒤집어(`withWebsite(… degradeAware …)`) 이 세 단계가
 * degrade 보호 **밖**으로 나갔다 — 그 상태에서 게이트 조회가 `57014`(statement
 * timeout)를 맞으면 `null` degrade 가 아니라 throw 가 되어 지면이 비는 대신 500 이
 * 난다. 표준 표면(`fetchStandardMentions`/`fetchStandardCitations`)은 뒤집히지
 * 않았으므로 그쪽 형태가 정본이고, 아래 소스 대조가 두 표면을 같은 형태로 묶는다.
 *
 * 소스 대조가 필요한 이유: 중첩 순서는 **정상 경로에서 값이 같다**. 실패를 주입해야만
 * 갈리므로, 배선 자체를 텍스트로 못 박지 않으면 다음 리팩터가 조용히 되돌린다.
 */
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ════════════════════════════════════════════════════════════════════════════
// ① 소스 대조 — 배선 형태
// ════════════════════════════════════════════════════════════════════════════

const SRC = fs.readFileSync(path.join(__dirname, "server.ts"), "utf8");

/** 줄 주석 제거 — 주석에 적힌 함수 이름이 중첩 순서 판정에 섞이지 않게. */
function stripLineComments(s: string): string {
  return s
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");
}

/**
 * 선언 지점부터 **다음 최상위 선언 직전**까지 = 그 페처의 본문.
 * 창을 고정 길이로 자르지 않는다 — 본문이 길어지면 조용히 절반만 보게 된다.
 */
function bodyOf(decl: string): string {
  const i = SRC.indexOf(decl);
  expect(i, `${decl} 를 server.ts 에서 못 찾았다 (선언이 바뀌었으면 이 가드를 고칠 것)`)
    .toBeGreaterThanOrEqual(0);
  const rest = SRC.slice(i + decl.length);
  const j = rest.search(/\nexport (?:async function|function|const) /);
  const body = stripLineComments(rest.slice(0, j === -1 ? rest.length : j));
  // 비공허성 — 슬라이스가 빈 문자열이면 아래 단언이 전부 무의미하게 통과한다.
  expect(body.trim().length, `${decl} 본문이 비었다`).toBeGreaterThan(20);
  return body;
}

describe("D1 — 프로젝트 표면 3종이 전부 갭을 얹는다", () => {
  // 축이 둘이라 헬퍼도 둘이다: 버킷 배열(`StandardTrendBucket[]`)은
  // `withTrendGapBuckets`, 주별 Top-N(`WeeklyTrend`)은 `withWeeklyTrendGrid`.
  const cases: [string, string][] = [
    ["export async function fetchProjectMentions(", "withWeeklyTrendGrid("],
    ["export async function fetchProjectCitations(", "withWeeklyTrendGrid("],
    ["export async function fetchProjectTrend(", "withTrendGapBuckets("],
  ];

  it.each(cases)("%s 는 %s 로 갭을 얹는다", (decl, helper) => {
    const body = bodyOf(decl);
    expect(body, `${decl} 에 ${helper} 배선이 없다 — 같은 화면의 다른 차트와 축이 갈린다`)
      .toContain(helper);
  });

  // 스코프는 **그 프로젝트 하나**다. 전역 루트 스코프(`rootProjectIdsForGaps`)를 쓰면
  // 남의 프로젝트 숨김이 이 프로젝트 축에 갭으로 찍힌다.
  //
  // ⚠️ 2026-09-20(통합 B1) — 주별 Top-N 둘은 헬퍼가 `withProject` **안**으로 들어가면서
  //    `gapProjectIds` 재조회 대신 이미 풀린 `scopeProjectId` 를 쓴다(값은 같다). 헬퍼를
  //    밖에 두면 **`enforce` 전에 원장을 읽게** 되므로 안쪽이 맞다.
  it.each(cases)("%s 의 갭 스코프는 그 프로젝트 하나다", (decl) => {
    const body = bodyOf(decl);
    expect(body).toMatch(/gapProjectIds\(localProjectId\)|projectIds: \[scopeProjectId\]/);
    expect(body, `${decl} 가 전역 루트 스코프를 쓴다`).not.toContain("rootProjectIdsForGaps()");
  });

  // ⚠️ 2026-09-20 — 판정을 **갭 헬퍼 호출 안**으로 좁혔다. 종전에는 함수 본문 전체에
  //    표면 리터럴이 없는지를 봤는데, 공용 추이 격자(D5)가 `buildTrendGrid({ surface:
  //    "project" … })` 를 같은 본문에 두면서 그 판정이 통째로 틀렸다. 두 호출은 **다른
  //    것을 묻는다**: 숨긴 회차 조회는 표면을 가리면 안 되고(원장에 website·project 가
  //    섞여 있다), 자리 목록은 **반드시** 가려야 한다(안 가리면 자리가 두 요일로 선다).
  it("갭 헬퍼의 숨김 표면은 `null` 이다 — 원장의 website·project 를 가리지 않는다", () => {
    for (const [decl] of cases) {
      const body = bodyOf(decl);
      // 주별 Top-N 은 이름 인자(`surface:`), 버킷 경로는 위치 인자다. 둘 다 훑는다.
      const named = /surface:\s*null/.test(body);
      const positional = /withTrendGapBuckets\([^;]*?\bnull\b/.test(body);
      expect(named || positional, `${decl} 의 숨김 조회가 표면을 단정한다`).toBe(true);
    }
  });

  // 자리 목록(D5)은 반대다 — 표면을 **반드시** 준다. 프로젝트 표면은 정규 요일이 없어
  // 자리 키가 앵커 KST 일자이고, 표면을 안 가리면 같은 축에 website 금요일 자리가 섞인다.
  it("자리 목록(trendSlotsFor)은 프로젝트 표면을 명시한다", () => {
    const body = bodyOf("export async function fetchProjectTrend(");
    expect(body).toContain("trendSlotsFor(");
    expect(body).toMatch(/surface:\s*"project"/);
  });
});

// ── 0071 계열 배선 — 페처마다 맞는 계열을 넘기는가 ──────────────────────────
//
// 이 배선이 틀려도 **정상 경로에서 값이 같다**(범위가 all 이면 두 계열이 동일하다).
// 원장이 `citations` 로 바뀐 뒤에야 갈리므로, 배선을 텍스트로 못 박는다.
//   · 언급 페처에 "citation" 이 들어가면 → 값이 살아난 8/24 에 음영이 덮인다.
//   · 인용 페처에 "mention" 이 들어가면 → 깨진 인용 주가 갭 없이 사라진다(그 주가
//     없었던 것처럼 보인다 = 숨김의 두 번째 거짓말).
describe("0071 — 갭 키 계열 배선", () => {
  const cases: Array<[string, "mention" | "citation"]> = [
    ["export async function fetchProjectMentions(", "mention"],
    ["export async function fetchProjectCitations(", "citation"],
    ["export const fetchStandardMentions = requestDeduped(", "mention"],
    ["export const fetchStandardCitations = requestDeduped(", "citation"],
    ["export const fetchWebsiteMentions = requestDeduped(", "mention"],
    ["export const fetchWebsiteCitations = requestDeduped(", "citation"],
  ];

  it.each(cases)("%s → %s", (decl, family) => {
    const body = bodyOf(decl);
    const other = family === "mention" ? "citation" : "mention";
    expect(body, `${decl} 에 계열 인자가 없다`).toContain(`"${family}"`);
    expect(body, `${decl} 에 반대 계열이 들어갔다`).not.toContain(`"${other}"`);
  });

  // 2026-09-20 — 표면·스코프·계열이 **한 인자**(`KpiTrendScope`)가 됐다. 계열만 인자로
  // 받고 표면을 글로벌로 박아 두면 website 탭이 생겼을 때 금요일 자리 대신 월요일 자리를
  // 조용히 상속한다. 박는 것 셋: ① 갭 키와 자리 목록이 **같은 스코프**를 본다
  // ② 계열 어휘 변환이 한 곳이다 ③ 기본 스코프가 글로벌이다.
  it("4-KPI 탭 3종은 언급 계열이고 갭 키·자리 목록이 같은 스코프를 본다", () => {
    const body = bodyOf("async function withKpiTrendGaps<");
    expect(body).toContain("trendGapWeekKeys(\n    unit,\n    scope.surface,\n    scope.projectIds,");
    expect(body).toContain('scope.family === "citations" ? "citation" : "mention"');
    expect(body).toContain("kpiTabTrendGrid(scope)");
    const sig = /async function withKpiTrendGaps<[\s\S]*?\): Promise<T \| null> \{/.exec(SRC)?.[0] ?? "";
    // 2026-09-20(검증 C1) — 스코프에 **기본값이 없다**. 기본값이 있으면 새 콜사이트가
    // 기간 없는 글로벌 스코프를 조용히 상속해 축이 기간 밖으로 넓어진다.
    expect(sig, "스코프 인자에 기본값이 남아 있다").toContain("scope: KpiTrendScope,");
    const kpiScope = /interface KpiTrendScope \{[\s\S]*?\n\}/.exec(SRC)?.[0] ?? "";
    expect(kpiScope, "KPI 스코프가 기간을 안 싣는다").toContain("filters: StandardFilters");
  });

  // 브랜드 추이 페처는 **두 지면이 공유**한다: 4-KPI 탭 라인차트(격자 축)와 대시보드
  // 경쟁사 스파크(28일, 직전 4회차). 뒤쪽에 13자리 격자를 얹으면 4점짜리 스파크가
  // 13자리로 늘고 9개가 `no-value` 갭이 된다 — 안 읽은 것을 결측이라 말하는 화면이다.
  // 지면 구분은 이미 있는 `weekAxis` 가 한다.
  it("브랜드 추이는 4-KPI 탭 호출에만 격자를 얹는다", () => {
    const body = bodyOf("export async function fetchStandardKpiBrandTrend(");
    expect(body).toContain('const onKpiTab = opts.weekAxis === "S2.mentionTrend"');
    // 격자 attach 와 창 확장이 **같은 조건**을 봐야 한다 — 한쪽만 걸리면 축과 값의
    // 창이 갈려 그 차이만큼 자리가 갭이 된다.
    expect(body).toContain('"week", globalKpiTrendScope(filters, "mentions"), onKpiTab)');
    expect(body).toContain("onKpiTab\n    ? await kpiTabTrendWindow(");
  });

  // 격자 자리 목록도 **같은 표면·같은 스코프**여야 한다 — 그것이 "언급 탭과 Overview 가
  // 같은 자리 집합을 쓴다"(설계 §1 이 고치려는 것)의 기계적 근거다.
  it("KPI 탭 자리 목록은 Overview 와 같은 표면·스코프다", () => {
    const scope = bodyOf("const globalKpiTrendScope = (");
    expect(scope).toMatch(/surface:\s*"global"/);
    expect(scope).toContain("rootProjectIdsForGaps()");
    const overview = bodyOf("async function fetchStandardTrendImpl(");
    expect(overview).toMatch(/surface:\s*"global"/);
    expect(overview).toContain("rootProjectIdsForGaps()");
  });

  // 주별 Top-N 추이(`WeeklyTrend`) — 표면 인자가 **둘**이다. 숨김 조회는 프로젝트 지면에서
  // `null`(원장의 website·project 를 안 가린다), 자리 목록은 **반드시** 가린다.
  // 둘을 한 인자로 합치면 프로젝트 축에 website 금요일 자리가 섞인다.
  it("주별 Top-N 추이의 자리 표면은 그 지면 것이다", () => {
    const req = /interface WeeklyTrendGridRequest<T> \{[\s\S]*?\n\}/.exec(SRC)?.[0] ?? "";
    expect(req, "요청 타입을 못 찾았다").toContain("gridSurface: CycleSurface;");
    // 선택 필드(`?:`)가 되면 새 콜사이트가 조용히 빠뜨린다.
    expect(req).not.toContain("gridSurface?:");
    expect(req).not.toContain("family?:");
    expect(req).not.toContain("filters?:");
    const wanted: Array<[string, RegExp]> = [
      ["export async function fetchProjectMentions(", /gridSurface: "project"/],
      ["export async function fetchProjectCitations(", /gridSurface: "project"/],
      ["export const fetchWebsiteMentions = requestDeduped(", /gridSurface: "website"/],
      ["export const fetchWebsiteCitations = requestDeduped(", /gridSurface: "website"/],
      ["export const fetchStandardMentions = requestDeduped(", /gridSurface: "global"/],
      ["export const fetchStandardCitations = requestDeduped(", /gridSurface: "global"/],
    ];
    for (const [decl, re] of wanted) {
      expect(bodyOf(decl), `${decl} 의 자리 표면이 틀렸다`).toMatch(re);
    }
  });

  it("혼합 버킷(오버뷰·프로젝트·웹사이트 추이)에는 계열을 주지 않는다 — 버킷 마커가 가른다", () => {
    for (const decl of [
      "async function fetchStandardTrendImpl(",
      "export async function fetchProjectTrend(",
      "export async function fetchWebsiteTrend(",
    ]) {
      const body = bodyOf(decl);
      expect(body).toContain("withTrendGapBuckets(");
      // `withTrendGapBuckets` 는 인자가 4개다 — 계열이 붙으면 설계가 바뀐 것이다.
      const call = /withTrendGapBuckets\([^;]*?\)/.exec(body)?.[0] ?? "";
      expect(call).not.toMatch(/"(mention|citation)"/);
    }
  });

  it("`withWeeklyTrendGrid` 의 계열 인자에 기본값이 없다 — 새 콜사이트는 컴파일 에러", () => {
    const sig = /interface WeeklyTrendGridRequest<T> \{[\s\S]*?\n\}/.exec(SRC)?.[0] ?? "";
    expect(sig.length).toBeGreaterThan(50);
    expect(sig).toMatch(/family: TrendGapFamily/);
    expect(sig).not.toMatch(/family: TrendGapFamily\s*=/);
  });
});

describe("D2 — degrade 가 게이트보다 바깥이다 (표준 표면과 같은 형태)", () => {
  // [선언, 게이트 헬퍼] — degrade 는 이 헬퍼 **바깥**에 있어야 한다.
  const cases: [string, string][] = [
    ["export const fetchWebsiteMentions = requestDeduped(", "withWebsite("],
    ["export const fetchWebsiteCitations = requestDeduped(", "withWebsite("],
    // 정본 — 핫픽스 C 가 안 건드린 표준 표면. 같은 단언이 두 표면에 걸린다.
    ["export const fetchStandardMentions = requestDeduped(", "withStandardRoot("],
    ["export const fetchStandardCitations = requestDeduped(", "withStandardRoot("],
  ];

  it.each(cases)("%s — degradeAware( 가 %s 보다 바깥", (decl, gate) => {
    const body = bodyOf(decl);
    const iDegrade = body.indexOf("degradeAware(");
    const iGate = body.indexOf(gate);
    expect(iDegrade, `${decl} 에 degradeAware 가 없다`).toBeGreaterThanOrEqual(0);
    expect(iGate, `${decl} 에 ${gate} 가 없다`).toBeGreaterThanOrEqual(0);
    expect(
      iDegrade,
      `${decl}: ${gate} 안의 enforce·스코프 조회가 degrade 보호 밖으로 나갔다`,
    ).toBeLessThan(iGate);
  });

  it.each(cases.slice(0, 2))("%s 는 website 표면 갭을 그 스코프의 ids 로 얹는다", (decl) => {
    const body = bodyOf(decl);
    expect(body).toContain("withWeeklyTrendGrid(");
    expect(body).toContain('"website"');
    // 갭은 degrade 보호 **안**이다 — 게이트보다 뒤에 온다.
    expect(body.indexOf("withWeeklyTrendGrid(")).toBeGreaterThan(body.indexOf("withWebsite("));
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ② 실패 주입 — 게이트 단계 57014 가 throw 가 아니라 null degrade 여야 한다
// ════════════════════════════════════════════════════════════════════════════

vi.mock("react", async () => {
  const { createRequire } = await import("node:module");
  const { dirname, join } = await import("node:path");
  const req = createRequire(import.meta.url);
  const root = dirname(req.resolve("react/package.json"));
  return req(join(root, "cjs", "react.react-server.development.js"));
});
vi.mock("next/cache", () => ({
  unstable_cache: <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => fn,
  revalidateTag: () => {},
  revalidatePath: () => {},
}));
vi.mock("@/lib/auth/session", () => ({
  getSession: async () => ({ user: { id: "u1", role: "admin", scope: { all: true } } }),
}));
vi.mock("@/lib/audit", () => ({ auditScopeCall: () => {}, auditDataAccess: () => {} }));
vi.mock("@/lib/db/repositories/entity-registry", () => ({
  entityRegistryRepository: { listOwn: async () => [] },
}));

// 프로젝트 표면의 게이트와 gapProjectIds 가 함께 읽는 요청 캐시 원본. 첫 실패가
// React cache 에 거절로 저장된 뒤 보호 밖에서 다시 관찰되는 회귀를 그대로 만든다.
const getProjectById = vi.fn<[string], Promise<unknown>>();
vi.mock("@/lib/db/repositories/projects", () => ({
  projectRepository: {
    getById: (id: string) => getProjectById(id),
  },
}));

// `withWebsite` 안의 **첫 DB 단계**. 여기서 실패를 주입하면 게이트가 degrade 보호
// 안에 있는지가 그대로 갈린다(밖이면 throw, 안이면 null).
const getProjectIdsForScope = vi.fn<[unknown], Promise<string[]>>();
vi.mock("@/lib/db/repositories/website-sites", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getProjectIdsForScope: (s: unknown) => getProjectIdsForScope(s) };
});

const { withRequestScope } = await import("@/test/request-scope");
const {
  fetchProjectMentions,
  fetchProjectCitations,
  fetchProjectTrend,
  fetchWebsiteMentions,
  fetchWebsiteCitations,
  wasDegraded,
} = await import("./server");

/** 드라이버가 내는 진짜 형태 — drizzle 이 감싸고 원본은 `cause` 에 있다. */
function statementTimeout(): Error {
  const inner = Object.assign(new Error("canceling statement due to statement timeout"), {
    code: "57014",
  });
  return Object.assign(new Error("Failed query: SELECT …"), { cause: inner });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("D2 — 게이트 단계 실패 주입", () => {
  const surfaces: [string, () => Promise<unknown>, string][] = [
    ["websiteMentions", () => fetchWebsiteMentions({}), "websiteMentions"],
    ["websiteCitations", () => fetchWebsiteCitations({}), "websiteCitations"],
  ];

  it.each(surfaces)("%s — 스코프 조회 57014 는 null 로 내려온다 (던지지 않는다)", async (
    _name,
    call,
    label,
  ) => {
    getProjectIdsForScope.mockRejectedValue(statementTimeout());
    const seen = await withRequestScope(async () => {
      const v = await call();
      return { v, degraded: wasDegraded(label) };
    });
    expect(seen.v).toBeNull();
    expect(seen.degraded, `${label} degrade 표식이 없다`).toBe(true);
    expect(getProjectIdsForScope).toHaveBeenCalled();
  });

  it.each(surfaces)("%s — 시간 초과가 아닌 실패는 그대로 던진다", async (_name, call) => {
    getProjectIdsForScope.mockRejectedValue(new Error("permission denied for table"));
    await expect(withRequestScope(() => call())).rejects.toThrow("permission denied");
  });

  it.each(surfaces)("%s — 스코프가 비면 null 이고 degrade 표식은 없다", async (
    _name,
    call,
    label,
  ) => {
    getProjectIdsForScope.mockResolvedValue([]);
    const seen = await withRequestScope(async () => {
      const v = await call();
      return { v, degraded: wasDegraded(label) };
    });
    expect(seen.v).toBeNull();
    expect(seen.degraded).toBe(false);
  });
});

describe("D1 — 프로젝트 게이트의 요청 캐시 실패 주입", () => {
  const projectId = "11111111-1111-4111-8111-111111111111";
  const surfaces: [string, () => Promise<unknown>, string][] = [
    ["projectMentions", () => fetchProjectMentions(projectId), "projectMentions"],
    ["projectCitations", () => fetchProjectCitations(projectId), "projectCitations"],
    // 추이는 라벨이 **단위별**이다 — 기본 단위가 `week` 이므로 표식도 `projectTrend:week`.
    // (같은 요청의 KPI Δ 칩은 `projectTrend:day` 라 서로를 덮지 않는다.)
    ["projectTrend", () => fetchProjectTrend(projectId), "projectTrend:week"],
  ];

  it.each(surfaces)("%s — 게이트 57014 는 null + degrade 로 내려온다", async (
    _name,
    call,
    label,
  ) => {
    getProjectById.mockRejectedValue(statementTimeout());
    const seen = await withRequestScope(async () => {
      const v = await call();
      return { v, degraded: wasDegraded(label) };
    });
    expect(seen.v).toBeNull();
    expect(seen.degraded, `${label} degrade 표식이 없다`).toBe(true);
    expect(getProjectById).toHaveBeenCalledTimes(1);
  });

  it.each(surfaces)("%s — 시간 초과가 아닌 게이트 실패는 그대로 던진다", async (
    _name,
    call,
  ) => {
    getProjectById.mockRejectedValue(new Error("permission denied for projects"));
    await expect(withRequestScope(() => call())).rejects.toThrow("permission denied");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 격자 배선 전수 — **추이를 그리는 페처가 전부 같은 자리를 쓰는가** (검증 B4)
// ════════════════════════════════════════════════════════════════════════════
//
// 한 지면 안에서 한 차트만 격자를 안 타면 축이 둘이 된다(수용 기준 G4 위반). 그래서
// "격자를 탄다"와 "의도적으로 제외한다"를 **표로 박는다** — 새 추이 페처가 생기면
// 둘 중 하나로 등록해야 하고, 안 하면 이 목록의 개수 단언이 깨진다.
describe("격자 배선 전수", () => {
  /** 격자를 타는 페처 — 자리 목록의 **유일한 입구**(`trendSlotsFor`)를 불러야 한다. */
  const ON: Array<[string, string]> = [
    ["async function fetchStandardTrendImpl(", '"global"'],
    ["export async function fetchWebsiteTrend(", '"website"'],
    ["export async function fetchProjectTrend(", '"project"'],
    ["export async function fetchWebsiteCitationAccuracyTrend(", '"website"'],
    ["export async function fetchProjectCitationAccuracyTrend(", '"project"'],
    ["async function withWeeklyTrendGrid<", "gridSurface"],
    ["function kpiTabTrendGrid(", "trendSlotsFor(scope)"],
    ["async function competitorSeries<", '"global"'],
  ];

  it.each(ON)("%s 가 자리 목록을 세운다", (decl, marker) => {
    const body = bodyOf(decl);
    expect(body, `${decl} 에 trendSlotsFor 배선이 없다`).toContain("trendSlotsFor(");
    expect(body, `${decl} 의 표면 배선이 틀렸다`).toContain(marker);
  });

  // 검증 C1 — 자리 목록을 만드는 곳은 **한 곳뿐**이어야 한다. 두 벌이 되면 한쪽만
  // 기간 가드를 빠뜨린 상태가 다시 생긴다(2주 기간에서 13자리 중 11칸 거짓 결측).
  it("buildTrendGrid 를 직접 부르는 곳은 없다 — 입구는 trendSlotsFor 하나다", () => {
    // 주석의 예시(`buildTrendGrid({...})`)는 세지 않는다.
    const direct = [...stripLineComments(SRC).matchAll(/buildTrendGrid\(/g)].length;
    expect(direct, "server.ts 가 buildTrendGrid 를 직접 부른다").toBe(1);
    const entry = /function trendSlotsFor\(req: TrendSlotRequest\)[\s\S]*?\n\}/.exec(SRC)?.[0] ?? "";
    expect(entry).toContain("buildTrendGrid({");
    // 입구가 기간과 단위를 **둘 다** 건다.
    expect(entry).toContain("from: req.filters.dateFrom ?? null");
    expect(entry).toContain("to: req.filters.dateTo ?? null");
    expect(entry).toContain('if ((req.unit ?? "week") !== "week") return Promise.resolve(null);');
  });

  // 기간 인자에 **기본값이 없어야** 새 콜사이트가 빠뜨릴 수 없다.
  it("withWeeklyTrendGrid 의 기간 인자에 기본값이 없다", () => {
    const req = /interface WeeklyTrendGridRequest<T> \{[\s\S]*?\n\}/.exec(SRC)?.[0] ?? "";
    expect(req).toContain("filters: StandardFilters;");
    expect(req).not.toContain("filters?:");
  });

  // 인용 정확도 추이 ⑥ 는 **가두기만** 한다 — 자리를 세우는 것은 메인 추이다.
  it.each([
    "export async function fetchWebsiteCitationAccuracyTrend(",
    "export async function fetchProjectCitationAccuracyTrend(",
  ])("%s 는 restrictToTrendGrid 로 가둔다(갭 행을 만들지 않는다)", (decl) => {
    const body = bodyOf(decl);
    expect(body).toContain("restrictToTrendGrid(");
    expect(body, "⑥ 이 갭 행을 만들면 같은 자리에 행이 둘이 된다")
      .not.toContain("applyTrendGridToBuckets(");
  });

  // 일 버킷에는 격자를 안 건다 — Δ 칩 30일·프로젝트 일 추이. 가드는 이제 **입구 한 곳**
  // (`trendSlotsFor`)에 있고, 호출부는 `unit` 을 **넘기기만** 하면 된다.
  it.each([
    "async function fetchStandardTrendImpl(",
    "export async function fetchWebsiteTrend(",
    "export async function fetchProjectTrend(",
    "export async function fetchWebsiteCitationAccuracyTrend(",
    "export async function fetchProjectCitationAccuracyTrend(",
  ])("%s 는 단위를 입구에 넘긴다", (decl) => {
    const body = bodyOf(decl);
    expect(body).toContain("trendSlotsFor(");
    expect(body, `${decl} 가 unit 을 안 넘긴다 — 일 버킷에 자리가 생긴다`).toMatch(/\bunit,\n/);
  });

  // 의도적 제외 — 이유를 코드에 남겼는가. 주석이 지워지면 다음 사람이 "빠뜨린 것"
  // 으로 읽고 잇는다(그러면 스파크가 13자리로 늘거나 ACR 의 일별 분해가 사라진다).
  it("의도적 제외 셋은 사유가 코드에 있다", () => {
    // ① 대시보드 경쟁사 스파크(28일)
    expect(bodyOf("export async function fetchStandardKpiBrandTrend("))
      .toContain('const onKpiTab = opts.weekAxis === "S2.mentionTrend"');
    // ② ACR 일별 선택률
    expect(SRC).toContain("공용 추이 격자(D5)를 **안 건다**");
    // ③ Δ 전용 30일 — 일 버킷 가드가 그 사유를 적고 있다.
    //    ⚠️ `bodyOf` 는 줄 주석을 떼므로 여기서는 원문(SRC)을 본다.
    expect(SRC).toContain("Δ 전용 30일은 건드리지 않는다");
  });

  // 검증 N4 — 캐시 키에 `now` 기준 일수를 넣으면 UTC 자정마다 셀이 전부 콜드가 된다.
  it("KPI 탭 캐시 키는 일수가 아니라 자리 날짜다", () => {
    const win = /interface KpiTrendWindow \{[\s\S]*?\n\}/.exec(SRC)?.[0] ?? "";
    expect(win, "KpiTrendWindow 를 못 찾았다").toContain("floor: string | null");
    expect(win).toContain("last: string | null");
    for (const call of [
      "cachedKpiBrandTrend(f, win, topBrands, profile, weekSource)",
      "cachedKpiEngineTrend(f, win, weekSource)",
      "cachedKpiFirstPosition(f, win, profile)",
    ]) {
      expect(SRC, `${call} 가 없다 — 캐시 키가 일수로 되돌아갔다`).toContain(call);
    }
  });

  // 검증 B1 — 회차 집합의 바닥은 상수가 아니라 자리에서 온다.
  it("viaGlobalSeries 가 자리 바닥을 받아 globalSeriesFilters 에 넘긴다", () => {
    const sig = /async function viaGlobalSeries<T>\([\s\S]*?\): Promise<T> \{/.exec(SRC)?.[0] ?? "";
    expect(sig).toContain("gridFloor: string | null = null");
    expect(SRC).toContain("globalSeriesFilters(filters, Date.now(), gridFloor)");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 격자에 얹히는 **값 원천은 반드시 자리 창을 받는다** (통합 검증 B1)
// ════════════════════════════════════════════════════════════════════════════
//
// 종전 가드는 "`windowDays` 를 **넘기면** `trendFloorDays()` 여야 한다" 만 봤다. 그래서
// **안 넘기는** 호출부가 사각이었고, 주별 Top-N 두 리더가 바닥 120일에 남은 채 자리는
// 180일까지 뻗어 121~180일 구간이 `no_value` 갭(화면에서는 수집 오류와 같은 음영)이 됐다.
//
// 이제 판정 기준을 뒤집는다: **격자가 값을 가두는 경로는 전부 읽기 전에 창을 좁힌다.**
// 값이 격자에 닿는 길은 셋뿐이므로(`applyTrendGridToWeeklyTrend`·`applyTrendGridToBuckets`·
// `restrictToTrendGrid`) 그 셋의 입력을 만드는 자리를 전수 열거한다.
describe("격자에 갇히는 값 원천 전수 — 자리 창을 받는가", () => {
  /** 격자에 값을 넣는 적용 함수 셋. 새 함수가 생기면 이 목록에 등록해야 한다. */
  const APPLIERS = [
    "applyTrendGridToWeeklyTrend",
    "applyTrendGridToBuckets",
    "restrictToTrendGrid",
  ] as const;

  it("적용 함수는 셋뿐이고 전부 server.ts 에서 쓰인다", () => {
    for (const fn of APPLIERS) {
      expect(stripLineComments(SRC), `${fn} 배선이 없다`).toContain(`${fn}(`);
    }
  });

  /**
   * 값 원천 전수. `window` 는 그 호출부가 창을 좁히는 방식이다.
   *   `grid-window` — `withTrendGridWindow(filters, slots)` 를 읽기 **전에** 건다.
   *   `helper`      — `withWeeklyTrendGrid` 가 대신 건다(그 안에서 같은 함수를 쓴다).
   */
  const SOURCES: Array<[string, "grid-window" | "helper" | "kpi-window"]> = [
    // 버킷 경로(메인 추이 3종) — 자기 본문에서 직접 좁힌다.
    ["async function fetchStandardTrendImpl(", "grid-window"],
    ["export async function fetchWebsiteTrend(", "grid-window"],
    ["export async function fetchProjectTrend(", "grid-window"],
    // 인용 정확도 ⑥ 2종 — `restrictToTrendGrid` 로 가두고 창도 같이 좁힌다.
    ["export async function fetchWebsiteCitationAccuracyTrend(", "grid-window"],
    ["export async function fetchProjectCitationAccuracyTrend(", "grid-window"],
    // KPI 탭 추이 3종 — `withKpiTrendGaps` 가 `restrictToTrendGrid` 로 가둔다(버킷 2곳).
    // 창은 다른 기구로 좁힌다: `kpiTabTrendWindow` → `KpiTrendWindow.floor = S0` →
    // `kpiWindowDays` → 미러의 `measured_at` 바닥, 집계층은 `globalSeriesFilters(f, _, floor)`.
    ["async function withKpiTrendGaps<", "kpi-window"],
    // 주별 Top-N 6지면 — 헬퍼가 읽기 전에 좁힌다.
    ["export async function fetchProjectMentions(", "helper"],
    ["export async function fetchProjectCitations(", "helper"],
    ["export const fetchStandardMentions = requestDeduped(", "helper"],
    ["export const fetchStandardCitations = requestDeduped(", "helper"],
    ["export const fetchWebsiteMentions = requestDeduped(", "helper"],
    ["export const fetchWebsiteCitations = requestDeduped(", "helper"],
  ];

  it.each(SOURCES)("%s 는 읽기 전에 자리 창을 건다", (decl, how) => {
    const body = bodyOf(decl);
    if (how === "grid-window") {
      expect(body, `${decl} 가 withTrendGridWindow 를 안 건다`).toContain(
        "withTrendGridWindow(",
      );
    } else if (how === "kpi-window") {
      // 이 지면은 `KpiTrendWindow`(자리 첫·끝 날짜)로 창을 나른다.
      expect(body, `${decl} 가 KPI 창 기구를 안 쓴다`).toContain("kpiTabTrendGrid(scope)");
      expect(SRC).toContain("trendGridDateFloor(slots)");
      expect(SRC).toContain("globalSeriesFilters(filters, Date.now(), gridFloor)");
    } else {
      expect(body, `${decl} 가 헬퍼를 안 쓴다`).toContain("withWeeklyTrendGrid(");
    }
  });

  // 적용 함수 호출 수를 **고정**한다 — 새 호출부가 생기면 SOURCES 에 등록하지 않고는
  // 통과할 수 없다(이 describe 가 "전수" 를 자처하는 근거).
  it("적용 함수 호출 수가 고정돼 있다 — 늘리면 SOURCES 에 등록해야 한다", () => {
    const src = stripLineComments(SRC);
    expect([...src.matchAll(/applyTrendGridToBuckets\(/g)]).toHaveLength(3);
    expect([...src.matchAll(/restrictToTrendGrid\(/g)]).toHaveLength(4);
    expect([...src.matchAll(/applyTrendGridToWeeklyTrend\(/g)]).toHaveLength(1);
  });

  // ⚠️ 2026-09-20 회귀 수리 — 헬퍼는 **읽기 필터를 안 건드린다.**
  //
  //    종전에는 여기서 `req.read(withTrendGridWindow(filters, slots))` 를 단언했는데,
  //    그 좁히기가 **본문 집계까지** 13주 누적 창으로 끌고 가 인용 화면이 예산을 넘겼다
  //    (고객 보고: "이 구간의 집계가 시간 안에 끝나지 않아 표시하지 않습니다").
  //    이 페처들은 추이만 읽는 것이 아니라 지면 전체를 읽는다.
  //
  //    자리 창은 **추이 리더 안쪽**에서 걸린다(`onTrendGrid` → 바닥 180). 자리가
  //    `TREND_GRID_MAX_DAYS`(180) 안에서만 만들어지므로 모든 자리가 읽기 창 안이고,
  //    축이 기간 밖으로 넓어지는 문제는 `trendSlotsFor` 의 `from`/`to` 가 닫는다.
  //    상세 단언은 `lib/db/repositories/trend-grid-body-window.sql.test.ts`.
  it("헬퍼는 자리 목록을 세우고, 읽기는 **원래 필터**로 한다", () => {
    const body = bodyOf("async function withWeeklyTrendGrid<");
    const slots = body.indexOf("const slots = await trendSlotsFor(");
    const read = body.indexOf("const result = await req.read(filters);");
    expect(slots, "자리 목록 생성을 못 찾았다").toBeGreaterThan(0);
    expect(read, "원래 필터로 읽는 줄을 못 찾았다").toBeGreaterThan(slots);
    expect(body, "본문까지 좁히면 지면이 누적 창으로 떨어진다")
      .not.toContain("withTrendGridWindow(");
  });

  // 헬퍼 밖에서 주별 Top-N 을 격자에 얹는 경로가 새로 생기면 같은 사각이 열린다.
  it("applyTrendGridToWeeklyTrend 는 헬퍼 안에서만 불린다", () => {
    const body = bodyOf("async function withWeeklyTrendGrid<");
    const all = [...stripLineComments(SRC).matchAll(/applyTrendGridToWeeklyTrend\(/g)].length;
    expect(body).toContain("applyTrendGridToWeeklyTrend(");
    expect(all, "헬퍼 밖에서도 부른다").toBe(1);
  });
});
