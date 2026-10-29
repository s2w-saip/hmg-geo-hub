import { describe, it, expect } from "vitest";
import {
  slimMentionsLiveForCache,
  slimCitationsLiveForCache,
  slimBrandCitationDomainsForCache,
} from "./scope-aggregates";
import type {
  MentionsLive,
  CitationsLive,
  CitationDomainLive,
  MentionAnswerLive,
} from "@/lib/scope/result-adapter";

// 캐시 2MB 한도(unstable_cache 는 초과 항목을 조용히 캐시하지 않음) 보장 검증.
// 실측 규모(2026-07-22: 표준 창 브랜드×프롬프트 쌍 10,612 · 도메인 8,877)를
// 웃도는 합성 뷰모델을 만들어 (a) 직렬화 바이트가 예산(1.5MB) 이내로 내려오고
// (b) 헤드라인 수치·판정(요약/랭킹행/분류/카운트)은 바이트 단위로 불변이며
// (c) 드릴다운 리스트는 원본의 prefix(top-N) 임을 고정한다.

const BUDGET = 1_500_000;
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));

function makeRef(i: number, terms: number): MentionAnswerLive {
  return {
    jobId: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
    provider: i % 2 ? "ChatGPT" : "Gemini",
    region: i % 3 ? "KR" : "US",
    mentionCount: (i % 5) + 1,
    position: null,
    highlights: {
      brand: Array.from({ length: terms }, (_, k) => `현대자동차표기${k}`),
      model: Array.from({ length: terms * 2 }, (_, k) => `아이오닉모델명${k}`),
    },
    measuredAt: "2026-07-20T00:00:00.000Z",
    runs: 1,
  };
}

function makeMentions(
  brands: number,
  promptsPerBrand: number,
  refs: number,
  highlightTerms = 10,
): MentionsLive {
  const perBrandPrompts: MentionsLive["perBrandPrompts"] = {};
  const brandRows = [];
  for (let b = 0; b < brands; b++) {
    const name = `브랜드-${b}`;
    brandRows.push({
      brand: name,
      mentions: 10_000 - b,
      prompts: promptsPerBrand,
      share: 1.1,
      mentionRate: 42.5,
      avgPosition: 2.5,
      isTracked: b < 3,
    });
    perBrandPrompts[name] = Array.from({ length: promptsPerBrand }, (_, p) => ({
      id: `prompt-${b}-${p}`,
      promptText: `전기차 구매를 고민하는 사용자가 묻는 한국어 프롬프트 본문 예시 ${b}-${p} — 어떤 브랜드가 좋은가요?`,
      mentions: 1_000 - p, // 내림차순 정렬 전제 (실코드와 동일)
      share: 3.3,
      funnelStage: "인지/탐색",
      providers: ["ChatGPT", "Gemini"],
      answers: Array.from({ length: refs }, (_, r) => makeRef(b * 1000 + p * 12 + r, highlightTerms)),
    }));
  }
  return {
    summary: { total: 555_555, uniqueBrands: brands, totalPrompts: 705 },
    brands: brandRows,
    perBrandPrompts,
    sentimentTotals: { positive: 10, neutral: 5, negative: 2, mixed: 1 },
    typeTotals: { mention: 1, recommendation: 2, comparison: 3, definition: 4, final_choice: 5 },
    hasPosition: true,
    trend: {
      series: ["브랜드-0", "브랜드-1"],
      points: Array.from({ length: 12 }, (_, w) => ({ week: `2026-0${(w % 9) + 1}-01`, "브랜드-0": w, "브랜드-1": w * 2 })),
    },
  };
}

function makeDomain(i: number, withDrilldown: boolean): CitationDomainLive {
  return {
    domain: `domain-${String(i).padStart(5, "0")}.example.com`,
    citations: 100_000 - i, // 내림차순 정렬 전제
    share: 0.5,
    prompts: 12,
    coverageRate: 3.2,
    isOurs: i % 40 === 0,
    category: "News & Media",
    subcategory: null,
    urls: withDrilldown
      ? Array.from({ length: 10 }, (_, u) => ({
          url: `https://domain-${i}.example.com/very/long/path/segment/for/testing?query=park&ref=${u}`,
          title: `인용 페이지 제목 예시 ${i}-${u}`,
          count: 10 - u,
          aiProvider: "ChatGPT, Gemini",
          promptText: "가족용 SUV 추천해줘 — 국내에서 살 수 있는 모델 위주로",
          country: "South Korea",
        }))
      : [],
    promptList: withDrilldown
      ? Array.from({ length: 12 }, (_, p) => ({
          id: `prompt-${i}-${p}`,
          promptText: `이 도메인을 인용한 프롬프트 본문 예시 ${i}-${p} — 전기차 충전 인프라는 어떤가요?`,
          funnelStage: "비교/검증",
          citations: 50 - p,
          providers: ["ChatGPT", "Gemini"],
          answers: Array.from({ length: 8 }, (_, r) => ({
            ...makeRef(i * 100 + p * 8 + r, 0),
            highlights: { brand: [], model: [] },
            measuredAt: null,
          })),
        }))
      : [],
  };
}

function makeCitations(domains: number, drilldown: number): CitationsLive {
  const split = {
    owned: Array.from({ length: 20 }, (_, p) => ({
      id: `sp-owned-${p}`,
      promptText: `자사 인용 프롬프트 ${p}`,
      funnelStage: null,
      citations: 500 - p,
      providers: ["ChatGPT"],
      answers: Array.from({ length: 8 }, (_, r) => ({
        ...makeRef(p * 8 + r, 0),
        highlights: { brand: [], model: [] },
        measuredAt: null,
      })),
    })),
    uncited: Array.from({ length: 20 }, (_, p) => ({
      id: `sp-uncited-${p}`,
      promptText: `미인용 프롬프트 ${p}`,
      funnelStage: null,
      citations: 400 - p,
      providers: ["Gemini"],
      answers: [],
    })),
    ownedCount: 1234,
    uncitedCount: 6943,
  };
  return {
    summary: { total: 174_516, uniqueDomains: domains },
    domains: Array.from({ length: domains }, (_, i) => makeDomain(i, i < drilldown)),
    categories: [
      { name: "News & Media", value: 100 },
      { name: "Official (HMG)", value: 50 },
    ],
    trend: { series: ["a.com"], points: [{ week: "2026-07-01", "a.com": 3 }] },
    categoryTrend: null,
    engineCategories: [{ engine: "ChatGPT", total: 10, byCategory: { "News & Media": 10 } }],
    promptSplit: split,
  };
}

describe("slimMentionsLiveForCache — 2MB 캐시 예산", () => {
  const live = makeMentions(180, 80, 12); // 실측(쌍 10,612)을 웃도는 14,400쌍
  const slim = slimMentionsLiveForCache(live);

  it("직렬화 바이트가 예산 이내로 내려온다 (원본은 초과)", () => {
    expect(bytes(live)).toBeGreaterThan(BUDGET);
    expect(bytes(slim)).toBeLessThanOrEqual(BUDGET);
  });

  it("헤드라인(요약·브랜드 랭킹행·감정/유형·추이)은 불변", () => {
    expect(slim.summary).toEqual(live.summary);
    expect(slim.brands).toEqual(live.brands);
    expect(slim.sentimentTotals).toEqual(live.sentimentTotals);
    expect(slim.typeTotals).toEqual(live.typeTotals);
    expect(slim.trend).toEqual(live.trend);
  });

  it("드릴다운은 원본의 prefix(top-N) — 재정렬·재작성 없음", () => {
    for (const [brand, prompts] of Object.entries(slim.perBrandPrompts)) {
      const orig = live.perBrandPrompts[brand];
      expect(prompts.length).toBeLessThanOrEqual(orig.length);
      prompts.forEach((p, i) => {
        expect(p.id).toBe(orig[i].id);
        expect(p.mentions).toBe(orig[i].mentions);
        expect(p.answers.length).toBeLessThanOrEqual(orig[i].answers.length);
        p.answers.forEach((a, r) => expect(a.jobId).toBe(orig[i].answers[r].jobId));
      });
    }
  });

  it("예산 이내 입력은 무손실 통과 (캡 미적용)", () => {
    const small = makeMentions(5, 10, 3, 4);
    const out = slimMentionsLiveForCache(small);
    expect(out).toBe(small); // 첫 후보(원본)가 예산 이내 → 그대로 반환
    expect(bytes(out)).toBeLessThanOrEqual(BUDGET);
  });

  // main 8c42657(멘션 드릴다운 lazy fetch)과의 이중 캡 정합 계약: {onlyBrand}
  // lazy 페이로드(한 브랜드의 전체 프롬프트 목록)는 예산 이내인 한 레벨 캡
  // (프롬프트 25개)에 잘리지 않고 전량 통과해야 한다 — 잘리면 드릴다운이 깨진다.
  it("한 브랜드 전량(onlyBrand lazy 페이로드)은 예산 이내면 캡 없이 통과", () => {
    const lazy = makeMentions(1, 120, 8, 4); // 120 프롬프트 > 레벨0 캡(25)
    expect(bytes(lazy)).toBeLessThanOrEqual(BUDGET);
    const out = slimMentionsLiveForCache(lazy);
    expect(out.perBrandPrompts["브랜드-0"].length).toBe(120);
  });
});

describe("slimCitationsLiveForCache — 2MB 캐시 예산", () => {
  const live = makeCitations(9000, 80); // 실측(8,877 도메인) 스케일
  const slim = slimCitationsLiveForCache(live);

  it("직렬화 바이트가 예산 이내로 내려온다 (원본은 초과)", () => {
    expect(bytes(live)).toBeGreaterThan(BUDGET);
    expect(bytes(slim)).toBeLessThanOrEqual(BUDGET);
  });

  it("요약·분류·엔진 구성·promptSplit 카운트는 불변", () => {
    expect(slim.summary).toEqual(live.summary); // uniqueDomains 는 행 캡과 무관
    expect(slim.categories).toEqual(live.categories);
    expect(slim.engineCategories).toEqual(live.engineCategories);
    expect(slim.promptSplit!.ownedCount).toBe(1234);
    expect(slim.promptSplit!.uncitedCount).toBe(6943);
  });

  it("도메인 행은 원본 상위 prefix — 수치 컬럼 불변", () => {
    expect(slim.domains.length).toBeLessThanOrEqual(live.domains.length);
    slim.domains.forEach((d, i) => {
      const o = live.domains[i];
      expect(d.domain).toBe(o.domain);
      expect(d.citations).toBe(o.citations);
      expect(d.share).toBe(o.share);
      expect(d.prompts).toBe(o.prompts);
      expect(d.coverageRate).toBe(o.coverageRate);
      expect(d.isOurs).toBe(o.isOurs);
    });
  });

  it("promptSplit 리스트는 prefix 캡, EMPTY/null 은 통과", () => {
    expect(slim.promptSplit!.owned.length).toBeLessThanOrEqual(20);
    const noSplit = { ...makeCitations(10, 5), promptSplit: null };
    expect(slimCitationsLiveForCache(noSplit).promptSplit).toBeNull();
  });
});

describe("slimBrandCitationDomainsForCache — 2MB 캐시 예산", () => {
  it("대형 브랜드(도메인 2,000·풀 드릴다운)도 예산 이내", () => {
    const domains = Array.from({ length: 2000 }, (_, i) => makeDomain(i, true));
    expect(bytes(domains)).toBeGreaterThan(BUDGET);
    const slim = slimBrandCitationDomainsForCache(domains);
    expect(bytes(slim)).toBeLessThanOrEqual(BUDGET);
    // 수치 컬럼은 prefix 불변
    slim.forEach((d, i) => {
      expect(d.domain).toBe(domains[i].domain);
      expect(d.citations).toBe(domains[i].citations);
    });
  });
});
