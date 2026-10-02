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
