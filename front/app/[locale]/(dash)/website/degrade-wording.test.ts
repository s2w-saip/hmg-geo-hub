import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ── 웹사이트 오버뷰의 빈 지면 문구 (2순위) ──────────────────────────────────
//
// 카드가 비는 이유는 두 가지이고 값으로는 못 가른다(둘 다 `null`):
//   ① 이 필터에 데이터가 없다        → `dashboard.empty`
//   ② 집계가 예산에 걸렸다(degrade)  → 글로벌 대시보드와 **같은** 지연 문구
//
// 왜 렌더 테스트가 아니라 소스 대조인가: `wasDegraded` 는 RSC 요청 스코프 밖에서
// fail-closed(`false`)라, 렌더 테스트를 세워도 ②를 재현하지 못하고 ①만 통과시킨다
// (`dashboard/degrade-labels.test.ts` 머리 주석이 같은 이유로 소스를 본다).
// 게다가 문구를 내는 자리(`WebsiteSummarySection`)는 page 모듈 안의 지역 async 함수라
// 테스트용으로 export 하면 Next 의 page export 검사에 걸린다.
//
// 그래서 이 가드가 보는 것은 셋이다:
//   (a) 두 지면이 **같은 i18n 네임스페이스·키**를 쓰는가 (새 키 금지)
//   (b) 웹사이트가 읽는 degrade 라벨이 server.ts 가 실제로 심는 라벨인가
//       (라벨이 어긋나면 문구가 영원히 안 뜬다: W1.2)
//   (c) "데이터 없음" 갈래가 종전 `empty` 그대로 남아 있는가

const here = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

const websitePage = here("./page.tsx");
const dashboardPage = here("../dashboard/page.tsx");
const server = here("../../../../lib/scope/server.ts");
const ko = JSON.parse(here("../../../../messages/ko.json")) as Record<string, unknown>;
const en = JSON.parse(here("../../../../messages/en.json")) as Record<string, unknown>;

/** `const <name> = await getTranslations("<ns>")` 의 네임스페이스. */
function namespaceOf(src: string, name: string): string | null {
  const m = src.match(
    new RegExp(`const ${name} = await getTranslations\\("([^"]+)"\\)`),
  );
  return m?.[1] ?? null;
}

/** `wasDegraded("<label>") ? <t>("<key>") : <t2>("<key2>")` 삼항을 뜯는다. */
function degradeTernary(src: string): {
  label: string;
  hotVar: string;
  hotKey: string;
  coldVar: string;
  coldKey: string;
} | null {
  const m = src.match(
    /wasDegraded\("([^"]+)"\)\s*\?\s*(\w+)\("([^"]+)"\)\s*:\s*(\w+)\("([^"]+)"\)/,
  );
  if (!m) return null;
  return { label: m[1], hotVar: m[2], hotKey: m[3], coldVar: m[4], coldKey: m[5] };
}

function dig(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined),
    obj,
  );
}

describe("웹사이트 오버뷰 빈 지면: 예산 초과와 데이터 없음을 가른다", () => {
  const web = degradeTernary(websitePage);
  const dash = degradeTernary(dashboardPage);

  it("두 지면 다 `wasDegraded` 삼항으로 문구를 가른다", () => {
    expect(web, "website/page.tsx").not.toBeNull();
    expect(dash, "dashboard/page.tsx").not.toBeNull();
  });

  it("웹사이트가 읽는 라벨은 server.ts 가 실제로 심는 라벨이다 (W1.2)", () => {
    // 라벨이 한 글자만 달라도 문구가 영원히 안 뜬다. 추출기가 죽지 않았는지도 함께 본다.
    const declared = new Set(
      [...server.matchAll(/degradeAware\(\s*[`"]([^`"]+)[`"]/g)].map((m) => m[1]),
    );
    expect(declared.size).toBeGreaterThanOrEqual(5);
    expect(declared).toContain(web?.label);
    expect(web?.label).toBe("websiteAggregates");
    // 그 라벨을 심는 것이 카드 페처인지까지 본다(같은 이름의 다른 read 로 흘러가지 않게).
    const i = server.indexOf("export const fetchWebsiteAggregates");
    expect(i).toBeGreaterThan(0);
    expect(server.slice(i, i + 400)).toContain('degradeAware("websiteAggregates"');
  });

  it("degrade 문구는 글로벌 대시보드와 **같은 네임스페이스·키**다 (AC1.1)", () => {
    const webNs = namespaceOf(websitePage, web?.hotVar as string);
    const dashNs = namespaceOf(dashboardPage, dash?.hotVar as string);
    expect(webNs, "website degrade 네임스페이스").not.toBeNull();
    expect(webNs).toBe(dashNs);
    expect(web?.hotKey).toBe(dash?.hotKey);
    // 키가 두 로케일에 실재한다 = 새 키를 만들지 않았다.
    const path = `${webNs}.${web?.hotKey}`;
    expect(typeof dig(ko, path), `ko ${path}`).toBe("string");
    expect(typeof dig(en, path), `en ${path}`).toBe("string");
  });

  it("데이터 없음 갈래는 종전 `dashboard.empty` 그대로다 (AC1.2)", () => {
    expect(namespaceOf(websitePage, web?.coldVar as string)).toBe("dashboard");
    expect(web?.coldKey).toBe("empty");
    expect(typeof dig(ko, "dashboard.empty")).toBe("string");
    expect(typeof dig(en, "dashboard.empty")).toBe("string");
  });
});

// ── 섹션 지연 고지(B027) ─────────────────────────────────────────────────────────
// 구성 도넛·GEO 는 일시 실패면 종전과 같은 빈 모양 + 라벨로 닫힌다(_data/live.ts degradeOnApiFailure, legacy 는
// server.ts degradeAware). 그대로 그리면 섹션이 조용히 사라지거나(구성) 빈 지도가 "측정 결과"처럼 보인다(GEO).
// api 경로에서는 그 자리에 기존 `DegradeNotice`(kpi.degraded)를 낸다 — 라벨 문자열이 어긋나면 고지가 영원히
// 안 뜨므로 두 원천과 대조한다.
describe("웹사이트 오버뷰: 섹션 지연 고지와 엔진 배지 4xx (B027)", () => {
  const page = websitePage.replace(/\r\n/g, "\n");
  const live = here("./_data/live.ts");
  const declared = new Set(
    [...server.matchAll(/degradeAware\(\s*[`"]([^`"]+)[`"]/g)].map((m) => m[1]),
  );
  const labelsOf = (name: string): string[] => {
    const m = page.match(new RegExp(`const ${name} = \\[([^\\]]*)\\] as const;`));
    expect(m, name).not.toBeNull();
    return [...m![1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  };
  const body = (fn: string): string => {
    const s = page.slice(page.indexOf(`async function ${fn}(`));
    return s.slice(0, s.indexOf("\n}\n"));
  };

  it.each([
    ["COMPOSITION_LABELS", "websiteSourceComposition", "WebsiteCompositionSection"],
    ["GEO_LABELS", "websiteGeoCompetition", "WebsiteGeoSection"],
  ])("%s: 종전 리더 라벨 = api 가 남기는 라벨, 그 섹션이 api 에서 고지를 그린다", (name, label, section) => {
    expect(labelsOf(name)).toEqual([label]);
    expect(declared).toContain(label);
    expect(live).toContain(`degradeOnApiFailure("${label}"`);
    expect(body(section)).toContain(`<DegradeNotice labels={${name}}`);
    // legacy 경로는 종전 그대로(고지는 api 에서만)
    expect(body(section)).toMatch(/\bapi\b/);
  });

  it("엔진 배지 조회의 거부는 api 에서 페이지 오류 경로로 오른다(배지 병합의 `.catch(() => items)` 는 그대로)", () => {
    const summary = body("WebsiteSummarySection");
    expect(summary).toContain(".catch(() => items)");
    expect(summary).toMatch(/apiCtx \? \(\s*<Suspense fallback=\{null\}>\s*<RaiseOnRejection read=\{subKpis\} locale=\{locale\} \/>/);
    expect(body("RaiseOnRejection")).toContain("throwForPage(e, locale)");
  });
});
