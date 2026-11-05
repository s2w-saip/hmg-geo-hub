import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import { resolveMentionView } from "./mention-input";

// 브랜드 상세 first on Global (2026-11-05, the user's call): it leads the rail and the page opens on it; a `?kpi=`
// link (the dashboard KPI cards') still opens its KPI tab. Project and Website keep the KPI view first.

vi.mock("next/navigation", () => ({
  usePathname: () => "/ko/renewal/standard/answer-analysis/mention",
  useSearchParams: () => new URLSearchParams(),
}));

const { RnMentionTabsFallback, viewQuery } = await import("./mention-tabs");

const tabs = (html: string) => [...html.matchAll(/data-rn-tab="([^"]+)"/g)].map((m) => m[1]);
const render = (brandsFirst?: boolean) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko}>
      <RnMentionTabsFallback kpi="exposure" view="brands" brandsFirst={brandsFirst} />
    </NextIntlClientProvider>,
  );

describe("the Mention view rail", () => {
  it("brands-first: 브랜드 상세 leads the rail", () => {
    expect(tabs(render(true))).toEqual(["brands", "exposure", "sov", "favorability", "first-rank"]);
    expect(tabs(render())).toEqual(["exposure", "sov", "favorability", "first-rank", "brands"]);
  });

  it("brands-first: no param opens 브랜드 상세, `?view=kpi` or a `?kpi=` link the KPI view", () => {
    const g = (view: string | undefined, kpi: string | undefined) => resolveMentionView(view, { kpi });
    expect(g(undefined, undefined)).toBe("brands");
    expect(g(undefined, "")).toBe("brands");
    expect(g("kpi", undefined)).toBe("kpi");
    expect(g(undefined, "exposure")).toBe("kpi");
    expect(g(undefined, "sov")).toBe("kpi");
    expect(g("brands", "sov")).toBe("brands");
    // Project and Website: unchanged
    expect(resolveMentionView(undefined)).toBe("kpi");
    expect(resolveMentionView("brands")).toBe("brands");
  });

  it("brands-first: the rail links round-trip", () => {
    const q = (s: string, v: "kpi" | "brands", k: "exposure" | "sov") => viewQuery(new URLSearchParams(s), v, k, true);
    expect(q("engine=chatgpt&kpi=sov", "brands", "sov")).toBe("?engine=chatgpt");
    expect(q("engine=chatgpt", "kpi", "exposure")).toBe("?engine=chatgpt&view=kpi");
    expect(q("", "kpi", "sov")).toBe("?view=kpi&kpi=sov");
    for (const s of ["engine=chatgpt", "view=kpi&kpi=sov"]) {
      const sp = new URLSearchParams(q(s, "brands", "sov"));
      expect(resolveMentionView(sp.get("view"), { kpi: sp.get("kpi") })).toBe("brands");
    }
    const kp = new URLSearchParams(q("", "kpi", "exposure"));
    expect(resolveMentionView(kp.get("view"), { kpi: kp.get("kpi") })).toBe("kpi");
    // Project and Website: unchanged
    expect(viewQuery(new URLSearchParams("kpi=sov"), "brands", "sov")).toBe("?kpi=sov&view=brands");
    expect(viewQuery(new URLSearchParams("view=brands&kpi=sov"), "kpi", "sov")).toBe("?kpi=sov");
  });
});
