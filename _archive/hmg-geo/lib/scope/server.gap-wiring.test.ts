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
  // `withTrendGapBuckets`, 주별 Top-N(`WeeklyTrend`)은 `withWeeklyGaps`.
  const cases: [string, string][] = [
    ["export async function fetchProjectMentions(", "withWeeklyGaps("],
    ["export async function fetchProjectCitations(", "withWeeklyGaps("],
    ["export async function fetchProjectTrend(", "withTrendGapBuckets("],
  ];

  it.each(cases)("%s 는 %s 로 갭을 얹는다", (decl, helper) => {
    const body = bodyOf(decl);
    expect(body, `${decl} 에 ${helper} 배선이 없다 — 같은 화면의 다른 차트와 축이 갈린다`)
      .toContain(helper);
  });

  it.each(cases)("%s 의 갭 스코프는 그 프로젝트 하나다", (decl) => {
    const body = bodyOf(decl);
    // 스코프 인자는 **한 곳**에서 나온다(`gapProjectIds`) — 세 페처가 같은 규칙을
    // 쓰게 하려고 헬퍼로 묶었다. 전역 루트 스코프(`rootProjectIdsForGaps`)를 쓰면
    // 남의 프로젝트 숨김이 이 프로젝트 축에 갭으로 찍힌다.
    expect(body).toContain("gapProjectIds(localProjectId)");
    expect(body, `${decl} 가 전역 루트 스코프를 쓴다`).not.toContain("rootProjectIdsForGaps()");
  });

  it("표면은 `null` 이다 — 원장의 website·project 를 가리지 않는다", () => {
    for (const [decl] of cases) {
      const body = bodyOf(decl);
      expect(body, `${decl} 가 표면을 단정한다`).not.toMatch(/"(website|project|global)"/);
    }
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

  it("4-KPI 탭 3종은 언급 계열이다 — 히어로·브랜드 추이·우선 노출도", () => {
    const body = bodyOf("async function withKpiTrendGaps<");
    expect(body).toContain('trendGapWeekKeys(unit, "global", rootProjectIdsForGaps(), "mention")');
  });

  it("혼합 버킷(오버뷰·프로젝트·웹사이트 추이)에는 계열을 주지 않는다 — 버킷 마커가 가른다", () => {
    for (const decl of [
      "export async function fetchStandardTrend(",
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

  it("`withWeeklyGaps` 의 계열 인자에 기본값이 없다 — 새 콜사이트는 컴파일 에러", () => {
    const sig = /async function withWeeklyGaps<[\s\S]*?\): Promise<T \| null> \{/.exec(SRC)?.[0] ?? "";
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
    expect(body).toContain("withWeeklyGaps(");
    expect(body).toContain('"website"');
    // 갭은 degrade 보호 **안**이다 — 게이트보다 뒤에 온다.
    expect(body.indexOf("withWeeklyGaps(")).toBeGreaterThan(body.indexOf("withWebsite("));
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
