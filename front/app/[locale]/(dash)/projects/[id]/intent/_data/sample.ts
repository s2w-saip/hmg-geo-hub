// Sample fixtures for the Intent page (Google Keyword + Social Scraping).
// Mirrors the wireframe's content shapes so the UI can demo end-to-end
// before the real keyword API + scraping pipeline land. Replace with live
// fetches when the data layer is ready.

export type KeywordTrendPoint = {
  // ISO week label like "W1", "W2", … per the wireframe x-axis
  week: string;
  // 0-100 interest score (Google Trends style)
  primary: number;
  // optional comparison series (sibling keyword)
  compare: number;
};

export type SerpPromptRow = {
  id: string;
  rank: number;
  url: string; // short display URL
  title: string;
  snippet: string;
  // suggested prompt drafted from this SERP entry — what the user can add
  // to the Prompt pool via the "+" action button on the wireframe.
  suggestedPrompt: string;
  // applied state — checkbox on the wireframe
  applied: boolean;
};

export type Keyword = {
  id: string;
  label: string;
  // 0-100, drives the 평균 관심도 gauge
  avgInterest: number;
  trend: KeywordTrendPoint[];
  serp: SerpPromptRow[];
};

const WEEKS = ["W1", "W2", "W3", "W4", "W5", "W6", "W7", "W8", "W9", "W10"];

function trend(primary: number[], compare: number[]): KeywordTrendPoint[] {
  return WEEKS.map((w, i) => ({
    week: w,
    primary: primary[i] ?? 0,
    compare: compare[i] ?? 0,
  }));
}

export const SAMPLE_KEYWORDS: Keyword[] = [
  {
    id: "k1",
    label: "전기차 SUV 추천",
    avgInterest: 72,
    trend: trend(
      [42, 48, 55, 61, 58, 70, 72, 80, 76, 82],
      [38, 40, 45, 50, 52, 56, 60, 58, 62, 64],
    ),
    serp: [
      {
        id: "s1-1",
        rank: 1,
        url: "carblog.kr/ev-suv-2026",
        title: "2026년 전기 SUV 추천 TOP 10",
        snippet: "주행거리·가격·실내공간 기준 상위 10종을 비교한 가이드",
        suggestedPrompt: "2026년 가족용 전기 SUV 추천해줘",
        applied: true,
      },
      {
        id: "s1-2",
        rank: 2,
        url: "motorgraph.com/best-ev-suv",
        title: "전기 SUV 베스트셀러 비교",
        snippet: "현대 아이오닉5, 기아 EV9, 테슬라 Model Y 직접 비교 분석",
        suggestedPrompt: "아이오닉5 vs 기아 EV9 비교",
        applied: true,
      },
      {
        id: "s1-3",
        rank: 3,
        url: "topgear.kr/ev-suv-review",
        title: "전기 SUV 시승기 모음",
        snippet: "장단점 정리, 충전 인프라, 보조금까지 한번에",
        suggestedPrompt: "전기 SUV 보조금 어떻게 받나요?",
        applied: false,
      },
      {
        id: "s1-4",
        rank: 4,
        url: "youtube.com/@evdaily/ev-suv",
        title: "EV SUV 실주행 영상 모음",
        snippet: "영상 기반 리뷰, 댓글 반응까지 종합",
        suggestedPrompt: "전기 SUV 장거리 주행 실주행 후기",
        applied: false,
      },
    ],
  },
  {
    id: "k2",
    label: "현대 팰리세이드",
    avgInterest: 65,
    trend: trend(
      [55, 60, 58, 62, 70, 68, 65, 72, 70, 74],
      [50, 52, 54, 56, 58, 60, 62, 60, 64, 66],
    ),
    serp: [
      {
        id: "s2-1",
        rank: 1,
        url: "hyundai.com/kr/palisade",
        title: "팰리세이드 공식 페이지",
        snippet: "가격, 트림, 옵션 안내",
        suggestedPrompt: "팰리세이드 가격은 얼마인가요?",
        applied: true,
      },
      {
        id: "s2-2",
        rank: 2,
        url: "encar.com/palisade",
        title: "팰리세이드 중고차 시세",
        snippet: "연식별·트림별 시세 트렌드",
        suggestedPrompt: "팰리세이드 중고 가성비 좋은 연식",
        applied: false,
      },
      {
        id: "s2-3",
        rank: 3,
        url: "bobaedream.co.kr/palisade",
        title: "팰리세이드 실오너 후기",
        snippet: "장단점, 연비, 옵션 평가",
        suggestedPrompt: "팰리세이드 실연비 어느 정도인가요?",
        applied: false,
      },
    ],
  },
  {
    id: "k3",
    label: "기아 EV9 가격",
    avgInterest: 58,
    trend: trend(
      [30, 35, 40, 45, 50, 55, 58, 60, 62, 64],
      [28, 32, 36, 40, 44, 48, 50, 52, 56, 58],
    ),
    serp: [
      {
        id: "s3-1",
        rank: 1,
        url: "kia.com/kr/ev9",
        title: "EV9 가격표",
        snippet: "트림별 가격, 옵션, 보조금 안내",
        suggestedPrompt: "EV9 모든 트림 가격 알려줘",
        applied: true,
      },
      {
        id: "s3-2",
        rank: 2,
        url: "motorgraph.com/ev9-cost",
        title: "EV9 유지비 분석",
        snippet: "충전비 + 보험료 + 정비 비용",
        suggestedPrompt: "EV9 1년 유지비 얼마나 드나요?",
        applied: false,
      },
    ],
  },
  {
    id: "k4",
    label: "현대 아반떼",
    avgInterest: 78,
    trend: trend(
      [60, 65, 70, 72, 75, 78, 80, 82, 78, 82],
      [55, 58, 60, 62, 65, 68, 70, 72, 70, 72],
    ),
    serp: [
      {
        id: "s4-1",
        rank: 1,
        url: "hyundai.com/kr/avante",
        title: "아반떼 공식 페이지",
        snippet: "가격, 트림, 색상 안내",
        suggestedPrompt: "아반떼 신차 가격 얼마인가요?",
        applied: false,
      },
    ],
  },
  {
    id: "k5",
    label: "제네시스 GV80",
    avgInterest: 45,
    trend: trend(
      [38, 40, 42, 44, 45, 46, 48, 45, 47, 48],
      [35, 38, 40, 42, 44, 45, 46, 44, 46, 47],
    ),
    serp: [
      {
        id: "s5-1",
        rank: 1,
        url: "genesis.com/kr/gv80",
        title: "GV80 공식",
        snippet: "프리미엄 SUV의 정수",
        suggestedPrompt: "GV80과 BMW X5 비교",
        applied: false,
      },
    ],
  },
];

// Default seed terms for the (now live) Google Keyword view — the tabs the
// page opens with before the operator adds their own. Kept here (a .ts data
// file) so the Korean seed strings stay out of JSX (check:strings) and reuse
// the sample labels.
export const DEFAULT_KEYWORD_TERMS: string[] = SAMPLE_KEYWORDS.map((k) => k.label);

// ─── Social Scraping ──────────────────────────────────────────────────────

export type SocialMetric = { key: string; label: string; value: number };

export const SAMPLE_SOCIAL_METRICS: SocialMetric[] = [
  { key: "contexts", label: "수집 맥락", value: 719 },
  { key: "conversations", label: "대화 수", value: 2330 },
  { key: "relations", label: "연관 관계", value: 2833 },
  { key: "sources", label: "수집 소스", value: 714 },
  { key: "workers", label: "분석 워커", value: 77 },
  { key: "total", label: "전체 소스", value: 714 },
];

export type SocialContextRow = {
  id: string;
  topic: string;
  context: string;
  // count of mentions across community sources
  mentions: number;
  // -1..1 sentiment
  sentiment: number;
  // Buyer / Seller / Neutral classification
  intent: "buyer" | "seller" | "neutral";
};

export const SAMPLE_SOCIAL_CONTEXTS: SocialContextRow[] = [
  {
    id: "c1",
    topic: "Family SUV — 3rd row use",
    context:
      "Looking for a 7-seater that's actually usable in the third row for adults; Palisade vs. Telluride keeps coming up.",
    mentions: 142,
    sentiment: 0.45,
    intent: "buyer",
  },
  {
    id: "c2",
    topic: "EV charging anxiety",
    context:
      "Mixed reports about Ioniq 5 charging speed at non-Tesla chargers; some users say it slows down sharply in cold weather.",
    mentions: 98,
    sentiment: -0.12,
    intent: "buyer",
  },
  {
    id: "c3",
    topic: "Resale value",
    context:
      "EV9 owners worried about resale, but a few sellers note demand is steady in markets with strong EV adoption.",
    mentions: 76,
    sentiment: 0.22,
    intent: "neutral",
  },
  {
    id: "c4",
    topic: "Korean brand perception (US)",
    context:
      "Younger US buyers describe Hyundai/Kia design as 'leapfrogged' incumbents, particularly compared to Honda/Toyota interiors.",
    mentions: 64,
    sentiment: 0.58,
    intent: "buyer",
  },
  {
    id: "c5",
    topic: "Dealership experience",
    context:
      "Several threads complain about markups and inventory shortages on EV9 and Ioniq 5 N — recommended buying from out-of-state dealerships.",
    mentions: 58,
    sentiment: -0.41,
    intent: "buyer",
  },
  {
    id: "c6",
    topic: "Genesis brand growth",
    context:
      "Discussion about Genesis as a 'value luxury' play vs. established German brands; GV80 named as the most credible entry.",
    mentions: 47,
    sentiment: 0.39,
    intent: "neutral",
  },
];

export type PurchaseCondition = {
  id: string;
  label: string;
  // mention share among contexts (0-100)
  share: number;
};

export const SAMPLE_PURCHASE_CONDITIONS: PurchaseCondition[] = [
  { id: "pc1", label: "Price under $50k", share: 38 },
  { id: "pc2", label: "AWD / 4WD required", share: 22 },
  { id: "pc3", label: "Range > 300mi", share: 31 },
  { id: "pc4", label: "Third-row seating", share: 18 },
  { id: "pc5", label: "Apple CarPlay / Android Auto", share: 27 },
];

export type CombinationPattern = {
  id: string;
  pair: [string, string];
  // co-occurrence count (number of contexts mentioning both)
  cooccurrence: number;
};

export const SAMPLE_COMBINATION_PATTERNS: CombinationPattern[] = [
  { id: "cp1", pair: ["Family SUV", "Resale value"], cooccurrence: 41 },
  { id: "cp2", pair: ["EV charging", "Range anxiety"], cooccurrence: 38 },
  { id: "cp3", pair: ["Genesis", "Value luxury"], cooccurrence: 26 },
  {
    id: "cp4",
    pair: ["Dealer markup", "Out-of-state purchase"],
    cooccurrence: 22,
  },
  { id: "cp5", pair: ["Korean brand", "Design quality"], cooccurrence: 19 },
];

// ─── Google Keyword: 관련 검색어 (related search terms) ──────────────────────
// Opened from a keyword tab's manage icon. Each row is a discovered keyword the
// operator can promote to a new tracked keyword tab (the "+" action). Parents
// can expand to long-tail children. Fake — replace with the keyword API later.

export type SearchIntent =
  | "transactional"
  | "informational"
  | "navigational"
  | "commercial";

export type RelatedKeyword = {
  id: string;
  term: string;
  languages: number; // "N개 언어"
  volume: number; // 검색량 (monthly)
  intent: SearchIntent;
  children?: RelatedKeyword[]; // long-tail expansion
};

// Total discovered count shown in the panel header ("N개 키워드 발견").
export const RELATED_FOUND_COUNT = 900;

export const SAMPLE_RELATED_KEYWORDS: RelatedKeyword[] = [
  { id: "rk1", term: "기아 셀토스", languages: 8, volume: 74000, intent: "transactional" },
  { id: "rk2", term: "기아 스포티지", languages: 8, volume: 49500, intent: "informational" },
  {
    id: "rk3",
    term: "기아 텔루라이드",
    languages: 8,
    volume: 49500,
    intent: "navigational",
    children: [
      { id: "rk3-1", term: "텔루라이드 국내 출시일", languages: 3, volume: 480, intent: "informational" },
      { id: "rk3-2", term: "텔루라이드 국내 가격", languages: 3, volume: 720, intent: "commercial" },
      { id: "rk3-3", term: "텔루라이드 병행수입 가격", languages: 2, volume: 320, intent: "commercial" },
      { id: "rk3-4", term: "기아 텔루라이드 국내", languages: 2, volume: 210, intent: "navigational" },
      { id: "rk3-5", term: "텔루라이드 옵션", languages: 1, volume: 90, intent: "informational" },
      { id: "rk3-6", term: "텔루라이드 풀체인지", languages: 1, volume: 140, intent: "informational" },
    ],
  },
  { id: "rk4", term: "패밀리 suv", languages: 8, volume: 12100, intent: "transactional" },
  {
    id: "rk5",
    term: "쏘렌토 하이브리드",
    languages: 8,
    volume: 12100,
    intent: "informational",
    children: [
      { id: "rk5-1", term: "쏘렌토 하이브리드 연비", languages: 2, volume: 880, intent: "informational" },
      { id: "rk5-2", term: "쏘렌토 하이브리드 가격", languages: 2, volume: 1300, intent: "commercial" },
      { id: "rk5-3", term: "쏘렌토 하이브리드 대기기간", languages: 1, volume: 390, intent: "transactional" },
    ],
  },
  { id: "rk6", term: "7인승 suv", languages: 8, volume: 4400, intent: "transactional" },
  { id: "rk7", term: "패밀리카 추천", languages: 8, volume: 4400, intent: "commercial" },
  { id: "rk8", term: "중형 suv 순위", languages: 8, volume: 4400, intent: "commercial" },
  { id: "rk9", term: "기아 suv 종류", languages: 8, volume: 2900, intent: "transactional" },
  { id: "rk10", term: "가성비 suv", languages: 8, volume: 2400, intent: "commercial" },
];

// Deterministic synthesis of a new Keyword from a term (manual add or promoted
// related keyword). Deterministic (hash of term, not Math.random) so the same
// term always yields the same fake trend/SERP — stable across re-renders.
function hashTerm(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function createKeywordFromTerm(term: string): Keyword {
  const h = hashTerm(term);
  const base = 30 + (h % 45); // 30..74
  const primary = WEEKS.map((_, i) =>
    Math.max(5, Math.min(100, base + Math.round(18 * Math.sin((i + (h % 7)) / 1.8)))),
  );
  const compare = primary.map((v) => Math.max(5, v - 8 - (h % 10)));
  const id = `kw-${h}`;
  const enc = encodeURIComponent(term);
  return {
    id,
    label: term,
    avgInterest: base,
    trend: trend(primary, compare),
    serp: [
      {
        id: `${id}-1`,
        rank: 1,
        url: `search.naver.com/search?q=${enc}`,
        title: `${term} 추천 정리`,
        snippet: `${term} 관련 인기 검색 결과와 비교 포인트 요약`,
        suggestedPrompt: `${term} 추천해줘`,
        applied: false,
      },
      {
        id: `${id}-2`,
        rank: 2,
        url: `youtube.com/results?q=${enc}`,
        title: `${term} 실사용 리뷰 영상`,
        snippet: `${term} 장단점과 실사용 후기 영상 모음`,
        suggestedPrompt: `${term} 실사용 후기 알려줘`,
        applied: false,
      },
      {
        id: `${id}-3`,
        rank: 3,
        url: `blog.naver.com/search?q=${enc}`,
        title: `${term} 구매 가이드`,
        snippet: `${term} 가격·옵션 비교 및 구매 팁`,
        suggestedPrompt: `${term} 가격이 궁금해`,
        applied: false,
      },
    ],
  };
}
