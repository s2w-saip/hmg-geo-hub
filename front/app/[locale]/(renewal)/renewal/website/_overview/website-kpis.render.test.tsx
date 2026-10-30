import { describe, expect, it } from "vitest";
import type { TilesView } from "@/app/[locale]/(dash)/dashboard/_data/screen-types";
import { KpiCard, RnWebsiteKpis } from "./website-kpis";
import { websiteDetailHref } from "./website-format";
import { TILES, part, text, tile, wrap } from "./_fixtures";
import { WebsiteFindingList } from "./website-findings-view";

// Renewal Website Overview KPI card (W1, 2026-10-30): the website tiles in the renewal look, with the 핵심 요약 slot.

const tileOf = (out: string, k: string) => part(out, "data-rn-kpi", k);

describe("renewal Website Overview KPI", () => {
  const out = wrap(<KpiCard view={TILES} qs="geography=US&engine=gpt" deltas findings={<p data-findings="">요약</p>} />);

  it("puts the findings under the head, then the tiles by category in the screen's order", () => {
    expect(out.indexOf("data-findings")).toBeLessThan(out.indexOf("data-rn-kpi-group"));
    expect([...out.matchAll(/data-rn-kpi-group="(\w+)"/g)].map((m) => m[1])).toEqual(["content", "source"]);
    expect([...out.matchAll(/data-rn-kpi="(\w+)"/g)].map((m) => m[1])).toEqual(["visibility", "shareOfVoice", "sentiment", "position", "ownedUrlRate", "citationAccuracy"]);
  });

  it("shows the value, the Δ in the screen's tone and direction, the engine badge and the ratio", () => {
    const v = tileOf(out, "visibility");
    expect(text(v)).toContain("88.0%");
    expect(v).toMatch(/data-tone="down"[^>]*>.*5\.2pp/);
    // the engine badge leads the value's base list: label (ⓘ) left, number right
    const engine = v.slice(v.indexOf("data-rn-engine="), v.indexOf('data-rn-ratio="visibility.num"'));
    expect(text(engine)).toMatch(/^data-rn-engine="visibility"[^>]*>엔진 간 일관성/);
    expect(engine).toMatch(/<dd[^>]*>34\.7%<\/dd>/);
    expect(text(v)).toContain("브랜드 언급 답변17,796");
    expect(text(v)).toContain("모니터링 답변20,216");
    const p = tileOf(out, "position");
    expect(text(p)).toContain("1.1번째");
    // a Δ that rounds to 0 reads 변화 없음 (as the renewal Overview's brand table and Mention), never "0.0번째"
    expect(p).toMatch(/data-tone="flat"[^>]*>.*변화 없음/);
    expect(text(p)).not.toContain("0.0번째");
  });

  it("keeps the 경쟁사 대비 SOV row as the screen computed it, and the provenance line", () => {
    // the same ratio read as a multiple (41067.2% = 410.7배), the percent kept in its title
    expect(text(tileOf(out, "shareOfVoice"))).toContain("경쟁사 대비 SOV (vs Tata)410.7배");
    expect(tileOf(out, "shareOfVoice")).toContain('title="41067.2%"');
    expect(text(tileOf(out, "ownedUrlRate"))).toContain("실시간 집계 · 발행 리포트 범위 밖");
  });

  it("says no data for a pending tile, and in muted text (no chip) that a tile has no Δ", () => {
    expect(text(tileOf(out, "sentiment"))).toContain("데이터 없음");
    expect(tileOf(out, "sentiment")).not.toContain("data-tone=");
    expect(tileOf(out, "ownedUrlRate")).not.toContain("data-tone=");
    expect(tileOf(out, "ownedUrlRate")).toMatch(/data-rn-no-delta=""[^>]*>증감 미제공/);
  });

  it("opens each tile's website analysis page in a new tab with the filters", () => {
    expect(tileOf(out, "visibility")).toMatch(/<a target="_blank"[^>]*href="\/ko\/renewal\/website\/answer-analysis\/mention\?kpi=exposure&amp;geography=US&amp;engine=gpt"/);
    expect(tileOf(out, "citationAccuracy")).toContain('href="/ko/renewal/website/answer-analysis/citation?geography=US&amp;engine=gpt"');
  });

  it("names the Δ basis: the last round, or the period compare when the tiles carry period chips", () => {
    expect(text(out)).toContain("증감 = 직전 회차 대비");
    const period: TilesView = {
      groups: [{ category: "content", tiles: [tile({ key: "visibility", value: 88, period: { key: "visibility", unit: "pp", suppressed: false, value: 2.1, direction: "up" } })] }],
      suppressionCaption: { key: "reason.noPrevWeek", params: {} },
    };
    const p = wrap(<KpiCard view={period} qs="" deltas />);
    expect(text(p)).toContain("증감 = 선택 기간과 바로 앞 같은 길이의 기간 비교");
    expect(p).toMatch(/data-tone="up"[^>]*>.*2\.1pp/);
    expect(p).toContain('data-rn-period-reason="noPrevWeek"');
  });

  it("in a period compare, a tile without a period result says so instead of showing its round Δ", () => {
    const view: TilesView = {
      groups: [{ category: "source", tiles: [
        tile({ key: "visibility", value: 88, period: { key: "visibility", unit: "pp", suppressed: false, value: 2.1, direction: "up" } }),
        tile({ key: "citationAccuracy", value: 64.6, delta: 1.4, direction: "up", tone: "good" }),
      ] }],
      suppressionCaption: null,
    };
    const out = wrap(<KpiCard view={view} qs="" deltas />);
    const acc = tileOf(out, "citationAccuracy");
    expect(acc).not.toContain("1.4pp");
    expect(acc).toMatch(/data-rn-no-delta=""[^>]*>기간 증감 미제공/);
  });

  it("holds the Δ place while the card-speed tiles wait for it", () => {
    const fast = wrap(<RnWebsiteKpis tiles={TILES} deferred={new Promise<TilesView>(() => {})} qs="" />);
    expect(tileOf(fast, "visibility")).not.toContain("data-tone=");
    expect(text(tileOf(fast, "visibility"))).toContain("88.0%");
  });
});

describe("renewal Website Overview 핵심 요약 cards", () => {
  const out = wrap(
    <WebsiteFindingList
      items={[
        { key: "change", tone: "warn", tag: "직전 회차 대비", note: "나빠짐 2 · 좋아짐 0 · 같음 0", rows: [
          { label: "노출률", value: "5.2pp", change: { dir: "down", tone: "down" } },
          { label: "우선 노출도", value: "0.3번째", change: { dir: "up", tone: "down" } },
        ] },
        { key: "engine", tone: "info", tag: "엔진 차이가 가장 큰 지표", note: "노출률 일관성 34.7%", rows: [
          { label: "Gemini", meta: "답변 9,939", value: "89.4%", mark: { text: "가장 앞섬", best: true } },
          { label: "DeepSeek", meta: "답변 284", value: "31.0%", mark: { text: "가장 뒤짐", best: false } },
        ] },
        { key: "brand", tone: "info", tag: "브랜드별 인용 점유율", rows: [], empty: "바뀐 지표 없음" },
      ]}
    />,
  );
  const items = (k: string) => [...part(out, "data-rn-finding", k).matchAll(/<li[^>]*>(.*?)<\/li>/g)].map((m) => text(m[1]));

  it("shows each card as a list: the head (tag, note), then one label · value row per value", () => {
    expect(text(part(out, "data-rn-finding", "change"))).toMatch(/^[^<]*직전 회차 대비나빠짐 2 · 좋아짐 0 · 같음 0/);
    expect(items("change")).toEqual(["노출률▼5.2pp", "우선 노출도▲0.3번째"]);
    expect(items("engine")).toEqual(["Gemini답변 9,939가장 앞섬89.4%", "DeepSeek답변 284가장 뒤짐31.0%"]);
  });

  it("colours a change by better / worse and points its arrow the value's way", () => {
    expect(part(out, "data-rn-finding", "change")).toMatch(/data-tone="down"[^>]*>▲0\.3번째/);
    expect(part(out, "data-rn-finding", "engine")).toContain('data-rn-mark="worst"');
  });

  it("says why a card has no rows", () => {
    expect(text(part(out, "data-rn-finding", "brand"))).toContain("바뀐 지표 없음");
    expect(part(out, "data-rn-finding", "brand")).not.toContain("<li");
  });
});

describe("websiteDetailHref", () => {
  it("sends the content KPIs to Mention, the source KPIs to Citation and the conversion to AI Conversion", () => {
    expect(websiteDetailHref("sentiment", "ko", "")).toBe("/ko/renewal/website/answer-analysis/mention?kpi=favorability");
    expect(websiteDetailHref("position", "en", "brand=Kia")).toBe("/en/renewal/website/answer-analysis/mention?kpi=first-rank&brand=Kia");
    expect(websiteDetailHref("targetUrlRate", "ko", "brand=Kia")).toBe("/ko/renewal/website/answer-analysis/citation?brand=Kia");
    expect(websiteDetailHref("trafficConversion", "ko", "")).toBe("/ko/renewal/website/ai-funnel/conversion");
  });
});
