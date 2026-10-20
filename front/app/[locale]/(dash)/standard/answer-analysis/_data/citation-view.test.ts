import { describe, expect, it } from "vitest";
import type { CitationTypeCategoryRow, StandardSubKpis } from "@/lib/db/repositories/scope-aggregates";
import type { CitationDomainLive } from "@/lib/scope/result-adapter";
import {
  applyCompetitorPick,
  applyCompetitorPickToCategories,
  categoryBars,
  categoryIncluded,
  categoryShare,
  competitorDomainOptions,
  citationDrilldownEmptyKey,
  officialOwnShareFromSub,
  pageWindow,
  typeCategoryBars,
} from "./citation-view";
import ko from "@/messages/ko.json";
import en from "@/messages/en.json";

const CATS = [
  { name: "Official (HMG)", value: 20 },
  { name: "Dealer & Marketplace", value: 30 },
  { name: "Other", value: 50 },
];

describe("categoryShare / categoryBars", () => {
  it("shares are over the slice total; null when empty", () => {
    expect(categoryShare(CATS, "Official (HMG)")).toBe(20);
    expect(categoryShare(CATS, "Dealer & Marketplace")).toBe(30);
    expect(categoryShare(CATS, "Wiki & Reference")).toBe(0);
    expect(categoryShare(null, "Other")).toBeNull();
    expect(categoryShare([], "Other")).toBeNull();
  });
  it("bars are sorted desc with pct", () => {
    expect(categoryBars(CATS).map((b) => [b.name, b.pct])).toEqual([["Other", 50], ["Dealer & Marketplace", 30], ["Official (HMG)", 20]]);
  });
});

describe("officialOwnShareFromSub", () => {
  const row = (citTotal: number, citOwned: number) =>
    ({ engine: "x", answers: 0, tracked: 0, multi: 0, top1: 0, top3: 0, avgPosition: null, totalMentions: 0, trackedMentions: 0,
       sentMentions: 0, positiveMentions: 0, negativeMentions: 0, citTotal, citOwned }) as StandardSubKpis["rows"][number];
  it("sums engines and returns null when there are no citations", () => {
    expect(officialOwnShareFromSub({ rows: [row(100, 8), row(100, 12)], promptsWithoutBrand: null, measuredPrompts: null })).toBe(10);
    expect(officialOwnShareFromSub({ rows: [row(0, 0)], promptsWithoutBrand: null, measuredPrompts: null })).toBeNull();
    expect(officialOwnShareFromSub(null)).toBeNull();
  });
});

describe("typeCategoryBars", () => {
  const rows: CitationTypeCategoryRow[] = [
    { type: "mention", total: 100, byCategory: { "Official (HMG)": 25, Other: 75 } },
    { type: "recommendation", total: 0, byCategory: {} },
    { type: "comparison", total: 40, byCategory: { Other: 30, "News & Media": 10 } },
  ];
  it("fixes the series order by grand total and closes each bar at 100", () => {
    const { series, bars } = typeCategoryBars(rows);
    expect(series).toEqual(["Other", "Official (HMG)", "News & Media"]);
    const mention = bars.find((b) => b.type === "mention")!;
    expect(mention.segments.reduce((s, x) => s + x.pct, 0)).toBe(100);
    expect(mention.officialPct).toBe(25);
    expect(bars.find((b) => b.type === "recommendation")!.officialPct).toBeNull();
    expect(bars.find((b) => b.type === "comparison")!.segments.map((s) => s.name)).toEqual(["Other", "News & Media"]);
  });
  it("returns empty for null", () => {
    expect(typeCategoryBars(null)).toEqual({ series: [], bars: [] });
  });
  it("hands the missing 0.1%p to the largest remainders, never to an empty series", () => {
    // series = A, B, C, D (D 는 comparison 에만 있다). mention 행의 D 는 0 건이다.
    const { series, bars } = typeCategoryBars([
      { type: "mention", total: 3, byCategory: { A: 1, B: 1, C: 1 } },
      { type: "recommendation", total: 11, byCategory: { A: 5, B: 5, C: 1 } },
      { type: "comparison", total: 1, byCategory: { D: 1 } },
    ]);
    expect(series).toEqual(["A", "B", "C", "D"]);
    const seg = (type: string) => bars.find((b) => b.type === type)!.segments.map((s) => [s.name, s.value, s.pct]);
    // 잔여가 같으면(33.33… 셋) 뒤 칸이 받는다. 빈 D 는 받지 않는다(종전: D 0 건이 0.1% 로 그려졌다)
    expect(seg("mention")).toEqual([["A", 1, 33.3], ["B", 1, 33.3], ["C", 1, 33.4]]);
    // 정확한 값 45.45·45.45·9.09: 잔여 큰 C(0.9)와 B(0.5, 뒤 칸)가 0.1 씩 받는다(종전 45.5·45.5·9.1 = 100.1)
    expect(seg("recommendation")).toEqual([["A", 5, 45.4], ["B", 5, 45.5], ["C", 1, 9.1]]);
  });
  it("keeps 100.0 when a tiny last segment cannot absorb a negative residual", () => {
    // 잔여 방식: 31.1 + 28.6 + 25.3 + 15.1 = 100.1 이라 마지막 칸(3건)이 −0.1 을 받고 0 으로 잘려 합 100.1
    const [bar] = typeCategoryBars([{ type: "mention", total: 15901, byCategory: { C0: 4544, C1: 3, C3: 4939, C4: 2399, C5: 4016 } }]).bars;
    expect(bar.segments.map((s) => [s.name, s.pct])).toEqual([["C3", 31.1], ["C0", 28.6], ["C5", 25.2], ["C4", 15.1], ["C1", 0]]);
  });
  it("every bar sums to 100.0 with each segment within 0.1%p of its exact share (randomized)", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let t = 0; t < 2000; t++) {
      const byCategory: Record<string, number> = {};
      const big = rnd() < 0.5;
      for (let c = 0; c < 2 + Math.floor(rnd() * 5); c++) if (rnd() > 0.35) byCategory[`C${c}`] = 1 + Math.floor(rnd() * (big ? 5000 : 30));
      const total = Object.values(byCategory).reduce((a, b) => a + b, 0);
      if (total === 0) continue;
      const rows: CitationTypeCategoryRow[] = [{ type: "mention", total, byCategory }, { type: "comparison", total: 1, byCategory: { Z: 1 } }];
      const segs = typeCategoryBars(rows).bars[0].segments;
      expect(segs.reduce((s, x) => s + Math.round(x.pct * 10), 0)).toBe(1000);
      for (const s of segs) {
        expect(s.value).toBeGreaterThan(0);
        expect(Math.abs(s.pct - (100 * s.value) / total)).toBeLessThan(0.1);
      }
    }
  });
});

describe("competitor pick", () => {
  const dom = (domain: string, category: string | null, citations: number): CitationDomainLive =>
    ({ domain, citations, share: 0, prompts: 0, coverageRate: 0, urls: [], promptList: [], isOurs: false, category, subcategory: null });
  const rows = [dom("bmw.com", "Official (Competitor)", 50), dom("toyota.com", "Official (Competitor)", 80), dom("jdpower.com", "Automotive Media", 90)];
  it("lists competitor official domains by citations", () => {
    expect(competitorDomainOptions(rows)).toEqual(["toyota.com", "bmw.com"]);
  });
  it("filters only the competitor-official rows; others stay", () => {
    expect(applyCompetitorPick(rows, new Set(["bmw.com"])).map((r) => r.domain)).toEqual(["bmw.com", "jdpower.com"]);
    expect(applyCompetitorPick(rows, new Set()).length).toBe(3);
  });
  it("categoryIncluded treats an empty filter as everything", () => {
    expect(categoryIncluded([], "Official (HMG)")).toBe(true);
    expect(categoryIncluded(["Other"], "Official (HMG)")).toBe(false);
  });
});

describe("pageWindow", () => {
  it("clamps the page and computes the 1-based range", () => {
    expect(pageWindow(120, 1, 50)).toEqual({ page: 1, pages: 3, from: 1, to: 50 });
    expect(pageWindow(120, 3, 50)).toEqual({ page: 3, pages: 3, from: 101, to: 120 });
    expect(pageWindow(120, 9, 50)).toEqual({ page: 3, pages: 3, from: 101, to: 120 });
    expect(pageWindow(0, 1, 50)).toEqual({ page: 1, pages: 1, from: 0, to: 0 });
  });
});

// QA 2차 #5-(c) — "경쟁사 선택 시 출처 카테고리별 현황 공식(경쟁사)에 수치가
// 반영되지 않는다". `?competitor=` 는 도메인 표에만 걸려 있었다(집계 축 아님).
// 반영 범위는 카테고리 현황 + 도메인 표까지(제품 결정 D6) — 클라이언트 재계산이라
// 서버·캐시키·SQL 무변경이다.
describe("applyCompetitorPickToCategories", () => {
  const domains = [
    { domain: "hyundai.com", category: "Official (HMG)", citations: 96 },
    { domain: "bmw.com", category: "Official (Competitor)", citations: 50 },
    { domain: "toyota.com", category: "Official (Competitor)", citations: 40 },
    { domain: "jdpower.com", category: "Automotive Media", citations: 30 },
  ] as unknown as CitationDomainLive[];
  const cats = [
    { name: "Official (HMG)", value: 96 },
    { name: "Official (Competitor)", value: 90 },
    { name: "Automotive Media", value: 30 },
  ];

  it("선택이 없으면 입력 배열을 **같은 참조**로 돌려준다 (무변경)", () => {
    expect(applyCompetitorPickToCategories(cats, domains, new Set())).toBe(cats);
  });
  it("공식(경쟁사) 값이 선택 도메인의 인용 수 합과 같다", () => {
    const out = applyCompetitorPickToCategories(cats, domains, new Set(["bmw.com"]))!;
    expect(out.find((c) => c.name === "Official (Competitor)")!.value).toBe(50);
    const two = applyCompetitorPickToCategories(cats, domains, new Set(["bmw.com", "toyota.com"]))!;
    expect(two.find((c) => c.name === "Official (Competitor)")!.value).toBe(90);
  });
  it("다른 카테고리 행의 값은 변하지 않는다", () => {
    const out = applyCompetitorPickToCategories(cats, domains, new Set(["bmw.com"]))!;
    expect(out.find((c) => c.name === "Official (HMG)")!.value).toBe(96);
    expect(out.find((c) => c.name === "Automotive Media")!.value).toBe(30);
    expect(out).toHaveLength(3);
  });
  it("null/undefined 카테고리는 null 로 통과시킨다", () => {
    expect(applyCompetitorPickToCategories(null, domains, new Set(["bmw.com"]))).toBeNull();
    expect(applyCompetitorPickToCategories(undefined, domains, new Set())).toBeNull();
  });
});

// 2026-09-16 고객(GGMD) QA 대응으로 드릴다운이 세 단계(상위 N 전량 / 공식 꼬리는
// URL 샘플만 / 미제공)가 됐다. "비었다"의 의미가 행마다 달라 문구를 하나로 쓰면
// 거짓이 된다 — 특히 공식 꼬리 행은 **프롬프트가 실제로 있는데** 목록만 안 실은
// 것이라 "프롬프트가 없습니다"가 반쪽 거짓이다.
describe("citationDrilldownEmptyKey", () => {
  const base = {
    category: "Official (HMG)" as string | null,
    urls: [] as CitationDomainLive["urls"],
    promptList: [] as CitationDomainLive["promptList"],
    drilldownOmitted: undefined as boolean | undefined,
  };
  const url = { url: "https://kia.no/x", title: "t", count: 1, aiProvider: "ChatGPT", promptText: "p", country: null };

  it("공식 꼬리(URL 만 실림) 프롬프트 탭 → promptsTopOnly", () => {
    expect(citationDrilldownEmptyKey({ ...base, urls: [url] }, "prompts"))
      .toBe("drilldown.promptsTopOnly");
  });

  it("공식인데 URL 도 없음 → 진짜 없는 것 (urls: noUrlsOfficial · prompts: noPrompts)", () => {
    expect(citationDrilldownEmptyKey(base, "urls")).toBe("drilldown.noUrlsOfficial");
    expect(citationDrilldownEmptyKey(base, "prompts")).toBe("drilldown.noPrompts");
  });

  it("drilldownOmitted(상한 초과·안전판)면 공식이어도 종전 '미제공' 문구", () => {
    const omitted = { ...base, drilldownOmitted: true };
    expect(citationDrilldownEmptyKey(omitted, "urls")).toBe("drilldown.noUrls");
    // URL 이 실려 있을 리 없지만, 실려 있어도 promptsTopOnly 로 새지 않아야 한다.
    expect(citationDrilldownEmptyKey({ ...omitted, urls: [url] }, "prompts"))
      .toBe("drilldown.noPrompts");
  });

  it("비공식 행은 종전 그대로", () => {
    const other = { ...base, category: "News & Media", urls: [url] };
    expect(citationDrilldownEmptyKey(other, "urls")).toBe("drilldown.noUrls");
    expect(citationDrilldownEmptyKey(other, "prompts")).toBe("drilldown.noPrompts");
    expect(citationDrilldownEmptyKey({ ...base, category: null }, "urls")).toBe("drilldown.noUrls");
  });

  it("반환하는 키가 ko/en 사전에 실제로 존재한다", () => {
    const keys = [
      "drilldown.noUrls",
      "drilldown.noUrlsOfficial",
      "drilldown.noPrompts",
      "drilldown.promptsTopOnly",
    ] as const;
    for (const k of keys) {
      const leaf = k.split(".")[1];
      const koDict = (ko as Record<string, never>)["answerAnalysis"]["citations"]["drilldown"];
      const enDict = (en as Record<string, never>)["answerAnalysis"]["citations"]["drilldown"];
      expect(typeof koDict[leaf]).toBe("string");
      expect(typeof enDict[leaf]).toBe("string");
    }
  });
});
