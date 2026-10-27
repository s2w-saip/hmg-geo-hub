import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ── 웹사이트 오버뷰의 빈 지면 문구와 섹션 지연 고지 ───────────────────────────────
//
// 카드가 비는 이유는 두 가지다:
//   ① 이 필터에 데이터가 없다            → `dashboard.empty`
//   ② 읽기가 일시 실패했다(degrade)      → 글로벌 대시보드와 **같은** 지연 문구
// With the BFF port the screens say which one it is (`state: "empty" | "degraded"`; a transient
// failure of the screen itself reads as degraded) — the old request-scope degrade registry is gone.
//
// Source checks (the wording sits in page-local async functions that cannot be exported):
//   (a) both pages pick the wording from the screen state with the same i18n namespace and keys
//   (b) composition and GEO draw the existing notice card when their screen degraded
//   (c) a non-transient rejection of the deferred tiles screen goes to the page error path

const here = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8").replace(/\r\n/g, "\n");

const websitePage = here("./page.tsx");
const dashboardPage = here("../dashboard/page.tsx");
const ko = JSON.parse(here("../../../../messages/ko.json")) as Record<string, unknown>;
const en = JSON.parse(here("../../../../messages/en.json")) as Record<string, unknown>;

/** `const <name> = await getTranslations("<ns>")` 의 네임스페이스. */
function namespaceOf(src: string, name: string): string | null {
  const m = src.match(new RegExp(`const ${name} = await getTranslations\\("([^"]+)"\\)`));
  return m?.[1] ?? null;
}

/** `<x>.state === "degraded" ? <t>("<key>") : <t2>("<key2>")` 삼항을 뜯는다. */
function degradeTernary(src: string) {
  const m = src.match(/\.state === "degraded"\s*\?\s*(\w+)\("([^"]+)"\)\s*:\s*(\w+)\("([^"]+)"\)/);
  if (!m) return null;
  return { hotVar: m[1], hotKey: m[2], coldVar: m[3], coldKey: m[4] };
}

function dig(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined),
    obj,
  );
}

const body = (src: string, fn: string): string => {
  const s = src.slice(src.indexOf(`async function ${fn}(`));
  return s.slice(0, s.indexOf("\n}\n"));
};

describe("웹사이트 오버뷰 빈 지면: 일시 실패와 데이터 없음을 가른다", () => {
  const web = degradeTernary(websitePage);
  const dash = degradeTernary(dashboardPage);

  it("두 지면 다 화면 상태 삼항으로 문구를 가른다", () => {
    expect(web, "website/page.tsx").not.toBeNull();
    expect(dash, "dashboard/page.tsx").not.toBeNull();
    // the summary screen's transient failure reads as degraded
    expect(body(websitePage, "WebsiteSummarySection")).toContain('view = { state: "degraded" };');
  });

  it("degrade 문구는 글로벌 대시보드와 **같은 네임스페이스·키**다 (AC1.1)", () => {
    const webNs = namespaceOf(websitePage, web?.hotVar as string);
    const dashNs = namespaceOf(dashboardPage, dash?.hotVar as string);
    expect(webNs, "website degrade 네임스페이스").not.toBeNull();
    expect(webNs).toBe(dashNs);
    expect(web?.hotKey).toBe(dash?.hotKey);
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

describe("웹사이트 오버뷰: 섹션 지연 고지와 Δ·배지 화면의 4xx (B027)", () => {
  it("구성: 출처가 비고 화면이 degraded 면 그 자리에 지연 고지를 그린다", () => {
    const b = body(websitePage, "WebsiteCompositionSection");
    expect(b).toContain("c = await composition;");
    expect(b).toContain('{c.degraded ? <PendingNotice title={t("composition.title")} /> : null}');
  });

  it("GEO: 화면이 degraded 이거나 일시 실패면 빈 지도 대신 지연 고지를 그린다", () => {
    const b = body(websitePage, "WebsiteGeoSection");
    expect(b).toContain('v = "failed";');
    expect(b).toContain('<PendingNotice title={tGeo("title")} />');
  });

  it("Δ·배지 화면의 거부는 일시 실패가 아니면 페이지 오류 경로로 오른다(타일은 그대로)", () => {
    const summary = body(websitePage, "WebsiteSummarySection");
    expect(summary).toContain(".catch(() => tiles)");
    expect(summary).toContain("<RaiseOnRejection read={deferred} locale={locale} />");
    expect(body(websitePage, "RaiseOnRejection")).toContain("throwForPage(e, locale)");
  });
});
