import { describe, expect, it } from "vitest";
import type { CitationDomainLive } from "@/lib/scope/result-adapter";
import { categoryIncluded, citationDrilldownEmptyKey } from "./citation-view";
import ko from "@/messages/ko.json";
import en from "@/messages/en.json";

// The citation screen's display rules left in Next: the 출처 filter state and the empty-list wording
// of the domain drilldown. Category shares, bars, the competitor pick and the page windows are the
// screen's (back/bff/screens/citation.py).

describe("categoryIncluded", () => {
  it("treats an empty filter as everything", () => {
    expect(categoryIncluded([], "Official (HMG)")).toBe(true);
    expect(categoryIncluded(["Other"], "Official (HMG)")).toBe(false);
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
