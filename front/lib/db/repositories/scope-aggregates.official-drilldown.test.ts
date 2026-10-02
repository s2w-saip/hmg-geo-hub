import { describe, it, expect } from "vitest";
import {
  citationDomainRollup,
  foldCitationsLive,
  selectCitationDrilldownDomains,
  CITATION_OFFICIAL_DRILLDOWN_MAX,
  CITATION_OFFICIAL_TAIL_URLS,
  type CitDomainGroupRow,
  type CitationDomainAgg,
} from "./scope-aggregates";
import { OFFICIAL_HMG_CATEGORY } from "@/lib/citation-categorizer/taxonomy";

// 2026-09-16 고객(GGMD) QA — "인용 수와 상관 없이 공식(HMG) 도메인이면 샘플 URL도
// 제공하는 게 맞다". 미러 집계는 드릴다운 대상을 `상위 N ∪ 공식(HMG)` 으로 고르는데,
// 그 공식 판정은 **화면 카테고리 배지와 같은 값**이어야 한다. 배지를 만드는
// foldCitationsLive 와 선정에 쓰는 citationDomainRollup 이 같은 함수를 보는지
// (=대표 카테고리가 도메인마다 일치하는지) 고정한다.

function g(
  domain: string,
  target: string,
  citations: number,
  category: string | null = null,
): CitDomainGroupRow {
  return { domain, category, target, citations, owned: false, owned_citations: 0 };
}

describe("citationDomainRollup — 배지 카테고리와 같은 소스", () => {
  const groups: CitDomainGroupRow[] = [
    // 공식(HMG): geo-catalog owned 도메인 — 인용 수는 꼴찌
    g("hyundai.com", "chatgpt", 1),
    // 공식(HMG): seed.json 경로
    g("hyundai.news", "gemini", 2),
    // 비공식 상위 도메인
    g("caranddriver.com", "chatgpt", 900),
    g("caranddriver.com", "gemini", 100),
    g("reddit.com", "chatgpt", 500),
  ];

  it("대표 카테고리가 foldCitationsLive 의 행 category 와 도메인마다 일치", () => {
    const rollup = citationDomainRollup(groups, undefined, null);
    const live = foldCitationsLive({
      sampledAnswers: 10,
      groups,
      stats: [],
      urls: [],
      promptRows: [],
      promptRefs: [],
      split: null,
      filters: {},
    });
    expect(live.domains.length).toBe(rollup.size);
    for (const row of live.domains) {
      expect(rollup.get(row.domain)?.category).toBe(row.category);
      expect(rollup.get(row.domain)?.citations).toBe(row.citations);
      expect(rollup.get(row.domain)?.isOurs).toBe(row.isOurs);
    }
  });

  it("인용 수 꼴찌여도 공식(HMG) 로 판정된다 (드릴다운 합집합의 술어)", () => {
    const rollup = citationDomainRollup(groups, undefined, null);
    const official = [...rollup.entries()]
      .filter(([, a]) => a.category === OFFICIAL_HMG_CATEGORY)
      .map(([d]) => d)
      .sort();
    expect(official).toEqual(["hyundai.com", "hyundai.news"]);
    // 인용 수 기준 상위 2개에는 공식 도메인이 하나도 없다 — 즉 순위만으로 고르면
    // 이 둘이 탈락한다.
    const top2 = [...rollup.entries()]
      .sort((a, b) => b[1].citations - a[1].citations || a[0].localeCompare(b[0]))
      .slice(0, 2)
      .map(([d]) => d);
    expect(top2).toEqual(["caranddriver.com", "reddit.com"]);
  });

  it("sourceCategory 필터는 두 경로에서 같은 지점에 적용된다", () => {
    const filters = { sourceCategory: [OFFICIAL_HMG_CATEGORY] };
    const rollup = citationDomainRollup(groups, undefined, new Set(filters.sourceCategory));
    const live = foldCitationsLive({
      sampledAnswers: 10,
      groups,
      stats: [],
      urls: [],
      promptRows: [],
      promptRefs: [],
      split: null,
      filters,
    });
    expect([...rollup.keys()].sort()).toEqual(["hyundai.com", "hyundai.news"]);
    expect(live.domains.map((d) => d.domain).sort()).toEqual(["hyundai.com", "hyundai.news"]);
  });
});

// ── 드릴다운 선정 술어 (고객 요구의 집행 지점) ────────────────────────────────
// 이 블록의 존재 이유: `officialMax` 를 0 으로 바꾸면 "인용 수와 상관 없이 공식
// 도메인이면 샘플 URL" 요구가 **통째로 사라지는데** 다른 3,984건은 전부 통과한다.
// 그 뮤테이션을 죽이는 것이 아래 테스트들의 임무다.

function agg(citations: number, category: string | null): CitationDomainAgg {
  return { citations, isOurs: false, category };
}

function rankedFixture(): Array<readonly [string, CitationDomainAgg]> {
  // 상위 3개는 비공식, 그 뒤로 공식 4개가 꼬리에 붙는다.
  return [
    ["news-a.com", agg(900, "News & Media")],
    ["news-b.com", agg(800, "News & Media")],
    ["news-c.com", agg(700, "News & Media")],
    ["hyundai.no", agg(50, OFFICIAL_HMG_CATEGORY)],
    ["kia.cz", agg(40, OFFICIAL_HMG_CATEGORY)],
    ["hyundai.pl", agg(30, OFFICIAL_HMG_CATEGORY)],
    ["genesis.com.vn", agg(1, OFFICIAL_HMG_CATEGORY)],
  ] as const as Array<readonly [string, CitationDomainAgg]>;
}

describe("selectCitationDrilldownDomains", () => {
  const ranked = rankedFixture();

  it("상한이 0 이 아니다 — 공식 예외가 켜져 있어야 고객 요구가 산다", () => {
    expect(CITATION_OFFICIAL_DRILLDOWN_MAX).toBeGreaterThan(0);
    expect(CITATION_OFFICIAL_TAIL_URLS).toBeGreaterThan(0);
  });

  it("라이브 상수로 선정하면 순위 밖 공식 도메인이 전부 IN 리스트에 든다", () => {
    // 상수를 그대로 먹인다 — CITATION_OFFICIAL_DRILLDOWN_MAX 가 0 으로 바뀌면
    // 이 단언이 죽는다(뮤테이션 킬).
    const pick = selectCitationDrilldownDomains(ranked, 3, CITATION_OFFICIAL_DRILLDOWN_MAX);
    expect(pick.top).toEqual(["news-a.com", "news-b.com", "news-c.com"]);
    expect(pick.officialTail).toEqual(["hyundai.no", "kia.cz", "hyundai.pl", "genesis.com.vn"]);
    expect(pick.officialOmitted).toEqual([]);
    expect(pick.domains).toEqual([...pick.top, ...pick.officialTail]);
    // 인용 1회짜리 최하위 공식 도메인도 반드시 포함 = 고객 요구 그 자체
    expect(pick.domains).toContain("genesis.com.vn");
  });

  it("officialMax=0 이면 고객 요구가 사라진다 (대조군 — 이 동작을 금지한다)", () => {
    const off = selectCitationDrilldownDomains(ranked, 3, 0);
    expect(off.officialTail).toEqual([]);
    expect(off.officialOmitted).toHaveLength(4);
    const on = selectCitationDrilldownDomains(ranked, 3, CITATION_OFFICIAL_DRILLDOWN_MAX);
    expect(on.domains).not.toEqual(off.domains); // 라이브 상수는 0 이면 안 된다
  });

  it("상한 초과분은 officialOmitted 로 분리된다 (문구 거짓 차단의 입력)", () => {
    const pick = selectCitationDrilldownDomains(ranked, 3, 2);
    expect(pick.officialTail).toEqual(["hyundai.no", "kia.cz"]);
    expect(pick.officialOmitted).toEqual(["hyundai.pl", "genesis.com.vn"]);
    expect(pick.domains).toHaveLength(5);
  });

  it("상위 N 안의 공식 도메인은 꼬리로 중복 계상되지 않는다", () => {
    const pick = selectCitationDrilldownDomains(ranked, 5, CITATION_OFFICIAL_DRILLDOWN_MAX);
    expect(pick.top).toContain("hyundai.no");
    expect(pick.officialTail).toEqual(["hyundai.pl", "genesis.com.vn"]);
    expect(new Set(pick.domains).size).toBe(pick.domains.length);
  });

  it("공식이 하나도 없으면 종전(상위 N)과 완전히 같다", () => {
    const plain = ranked.filter(([, a]) => a.category !== OFFICIAL_HMG_CATEGORY);
    const pick = selectCitationDrilldownDomains(plain, 2, CITATION_OFFICIAL_DRILLDOWN_MAX);
    expect(pick.domains).toEqual(["news-a.com", "news-b.com"]);
    expect(pick.officialTail).toEqual([]);
    expect(pick.officialOmitted).toEqual([]);
  });
});

describe("foldCitationsLive — drilldownOmitted", () => {
  it("상한 초과 공식 도메인 행에만 플래그가 붙는다", () => {
    const groups: CitDomainGroupRow[] = [
      g("news-a.com", "chatgpt", 900),
      g("hyundai.no", "chatgpt", 50),
      g("kia.cz", "chatgpt", 40),
    ];
    const live = foldCitationsLive({
      sampledAnswers: 10,
      groups,
      stats: [],
      urls: [],
      promptRows: [],
      promptRefs: [],
      split: null,
      filters: {},
      drilldownOmitted: ["kia.cz"],
    });
    const by = new Map(live.domains.map((d) => [d.domain, d]));
    expect(by.get("kia.cz")!.drilldownOmitted).toBe(true);
    expect(by.get("hyundai.no")!.drilldownOmitted).toBeUndefined();
    expect(by.get("news-a.com")!.drilldownOmitted).toBeUndefined();
  });
});

describe("citationDomainRollup — 대표 카테고리 tie-break", () => {
  it("동률이면 먼저 집계된 분류가 이긴다 (엄격 > 유지)", () => {
    // 같은 도메인이 두 분류로 같은 인용수를 갖는 인위적 입력. 저장 category 가
    // 택소노미 안이면 그대로 신뢰되므로(resolveCitationCategory) 재현된다.
    const groups: CitDomainGroupRow[] = [
      g("mixed.example", "chatgpt", 10, "News & Media"),
      g("mixed.example", "gemini", 10, "Blogs & Reviews"),
    ];
    expect(citationDomainRollup(groups, undefined, null).get("mixed.example")?.category)
      .toBe("News & Media");
    // 입력 순서를 뒤집으면 결과도 뒤집힌다 = "먼저 집계된 것이 이긴다" 의 증명.
    const flipped: CitDomainGroupRow[] = [groups[1], groups[0]];
    expect(citationDomainRollup(flipped, undefined, null).get("mixed.example")?.category)
      .toBe("Blogs & Reviews");
  });

  it("동률이 아니면 인용수 최다가 이긴다", () => {
    const groups: CitDomainGroupRow[] = [
      g("mixed.example", "chatgpt", 10, "News & Media"),
      g("mixed.example", "gemini", 11, "Blogs & Reviews"),
    ];
    expect(citationDomainRollup(groups, undefined, null).get("mixed.example")?.category)
      .toBe("Blogs & Reviews");
  });
});
