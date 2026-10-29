// Fake fixtures for the Social Research (social-scraping) flow.
//
// This is a `.ts` data module, not JSX, so `npm run check:strings` (which only
// scans `.tsx`) does not flag hardcoded copy here — the same convention as
// app/.../intent/_data/sample.ts. UI *chrome* strings still go through i18n
// (messages/*.json); only the demo *content* is hardcoded, with a KO and EN
// variant selected by the caller's locale so the whole route reads as one
// language.
//
// One coherent scenario — keyword "패밀리 SUV" / "family SUV" — drives every
// screen: INPUT seed → EXPLORING timeline → CONTEXT-MAP matrix → prompt
// candidates. Replace with live scope reads when the measurement pipeline lands.

import type {
  ContextMatrix,
  ExploringStep,
  ExploringSnapshot,
  ExploringWorker,
  GeneratedPrompt,
} from "./types";

type SampleLocale = "ko" | "en";

function pick<T>(locale: string, ko: T, en: T): T {
  return locale === "ko" ? ko : en;
}

// ─── Research purpose presets (S1) ────────────────────────────────────────
// id is stable for i18n lookup; the purpose body itself is localized copy so
// it lives in messages, keyed by id. `rows` hints the textarea height.
export const RESEARCH_PURPOSES = [
  { id: "purchase-context", rows: 8, default: true },
  { id: "competitor-voc", rows: 6, default: false },
  { id: "feature-demand", rows: 6, default: false },
  { id: "custom", rows: 4, default: false },
] as const;

export type ResearchPurposeId = (typeof RESEARCH_PURPOSES)[number]["id"];

// Seed keyword suggestions — would be the admin's standard_keywords
// (source_type = 'community_voc'). Hardcoded for the demo.
const SEED_KEYWORDS_KO = [
  "패밀리 SUV",
  "전기 SUV 추천",
  "하이브리드 SUV",
  "7인승 SUV",
  "차박 SUV",
];

const SEED_KEYWORDS_EN = [
  "family SUV",
  "electric SUV recommendations",
  "hybrid SUV",
  "7-seater SUV",
  "car camping SUV",
];

export function getSeedKeywords(locale: string): string[] {
  return pick(locale, SEED_KEYWORDS_KO, SEED_KEYWORDS_EN);
}

// ════════════════════════════════════════════════════════════════════════
// CONTEXT MATRIX — the main deliverable (구매 맥락 지도 / Purchase Context Map)
// ════════════════════════════════════════════════════════════════════════

const SAMPLE_MATRIX_KO: ContextMatrix = {
  keyword: "패밀리 SUV",
  themes: [
    { id: "th-house", name: "가구 형태", description: "동거 구성·가족 규모에 따른 구매 맥락" },
    { id: "th-life", name: "라이프스타일", description: "여가·취미 활동 중심의 구매 맥락" },
    { id: "th-usage", name: "사용 환경", description: "주행 환경·구매 경험에 따른 맥락" },
  ],
  contexts: [
    {
      id: "ctx-multikid",
      themeId: "th-house",
      name: "다자녀 가구",
      mentionCount: 142,
      perspective: { buyer: 118, seller: 6, neutral: 18 },
      sourceDomains: { "bobaedream.co.kr": 41, "cafe.naver.com": 38, "clien.net": 22, "youtube.com": 19 },
      evidenceQuotes: [
        {
          quote: "애 셋이라 3열에 카시트 두 개 들어가는 풀사이즈 아니면 답이 없어요.",
          sourceTitle: "보배드림 - 패밀리카 고민",
          sourceUrl: "bobaedream.co.kr/view/123",
          perspective: "buyer",
        },
        {
          quote: "유모차에 캠핑 짐까지 실으려면 트렁크 깊이가 진짜 중요합니다.",
          sourceTitle: "네이버 카페 - 차린이 모임",
          sourceUrl: "cafe.naver.com/familycar/456",
          perspective: "buyer",
        },
      ],
    },
    {
      id: "ctx-newparent",
      themeId: "th-house",
      name: "신혼·예비 부모",
      mentionCount: 96,
      perspective: { buyer: 80, seller: 4, neutral: 12 },
      sourceDomains: { "cafe.naver.com": 44, "clien.net": 21, "dcinside.com": 17, "youtube.com": 14 },
      evidenceQuotes: [
        {
          quote: "첫 애 태우는 거라 안전 옵션은 풀로 넣고 싶은데 예산이 빠듯하네요.",
          sourceTitle: "클리앙 - 출산 준비 차 추천",
          sourceUrl: "clien.net/service/board/777",
          perspective: "buyer",
        },
      ],
    },
    {
      id: "ctx-3gen",
      themeId: "th-house",
      name: "3세대 동거",
      mentionCount: 58,
      perspective: { buyer: 47, seller: 3, neutral: 8 },
      sourceDomains: { "bobaedream.co.kr": 19, "cafe.naver.com": 22, "clien.net": 9, "youtube.com": 8 },
      evidenceQuotes: [
        {
          quote: "부모님 모시고 다니려면 2열 승하차가 편한 게 1순위예요.",
          sourceTitle: "보배드림 - 부모님 모시는 차",
          sourceUrl: "bobaedream.co.kr/view/234",
          perspective: "buyer",
        },
      ],
    },
    {
      id: "ctx-camping",
      themeId: "th-life",
      name: "캠핑·차박",
      mentionCount: 124,
      perspective: { buyer: 98, seller: 9, neutral: 17 },
      sourceDomains: { "youtube.com": 48, "dcinside.com": 33, "cafe.naver.com": 25, "clien.net": 18 },
      evidenceQuotes: [
        {
          quote: "2열 풀폴딩 돼서 차박 매트 깔면 성인 둘은 누워요. 그게 핵심.",
          sourceTitle: "유튜브 - 차박 성지 SUV 비교",
          sourceUrl: "youtube.com/watch?v=cmp1",
          perspective: "buyer",
        },
        {
          quote: "오프로드 들어가는 캠핑장 많아서 4WD는 거의 필수입니다.",
          sourceTitle: "디시인사이드 - 차박 갤러리",
          sourceUrl: "dcinside.com/board/camping/88",
          perspective: "neutral",
        },
      ],
    },
    {
      id: "ctx-pet",
      themeId: "th-life",
      name: "반려동물 동반",
      mentionCount: 71,
      perspective: { buyer: 58, seller: 4, neutral: 9 },
      sourceDomains: { "cafe.naver.com": 28, "youtube.com": 21, "clien.net": 12, "bobaedream.co.kr": 10 },
      evidenceQuotes: [
        {
          quote: "대형견 둘이라 적재공간 넓고 시트 폴딩 평평한 차를 찾아요.",
          sourceTitle: "네이버 카페 - 댕댕이 차박",
          sourceUrl: "cafe.naver.com/petcar/91",
          perspective: "buyer",
        },
      ],
    },
    {
      id: "ctx-commute",
      themeId: "th-usage",
      name: "장거리 출퇴근",
      mentionCount: 109,
      perspective: { buyer: 86, seller: 7, neutral: 16 },
      sourceDomains: { "clien.net": 34, "bobaedream.co.kr": 31, "youtube.com": 26, "cafe.naver.com": 18 },
      evidenceQuotes: [
        {
          quote: "왕복 120km라 실연비랑 반자율주행 없으면 몸이 못 버팁니다.",
          sourceTitle: "클리앙 - 장거리 출퇴근 차",
          sourceUrl: "clien.net/service/board/812",
          perspective: "buyer",
        },
      ],
    },
    {
      id: "ctx-snow",
      themeId: "th-usage",
      name: "눈길·험로 지역",
      mentionCount: 47,
      perspective: { buyer: 38, seller: 2, neutral: 7 },
      sourceDomains: { "bobaedream.co.kr": 16, "dcinside.com": 14, "clien.net": 9, "youtube.com": 8 },
      evidenceQuotes: [
        {
          quote: "강원도 산간이라 겨울엔 4WD 아니면 출근을 못 해요.",
          sourceTitle: "보배드림 - 4WD 후기",
          sourceUrl: "bobaedream.co.kr/view/345",
          perspective: "buyer",
        },
      ],
    },
    {
      id: "ctx-firstcar",
      themeId: "th-usage",
      name: "첫 차 구매",
      mentionCount: 88,
      perspective: { buyer: 72, seller: 5, neutral: 11 },
      sourceDomains: { "cafe.naver.com": 33, "clien.net": 24, "bobaedream.co.kr": 18, "youtube.com": 13 },
      evidenceQuotes: [
        {
          quote: "첫 차라 나중에 팔 때 감가 적은 차로 가고 싶어요. 예산은 5천 안쪽.",
          sourceTitle: "네이버 카페 - 첫차 고민",
          sourceUrl: "cafe.naver.com/firstcar/12",
          perspective: "buyer",
        },
      ],
    },
  ],
  categories: [
    { id: "cat-space", name: "공간·시트", description: "탑승·적재 공간과 시트 활용성" },
    { id: "cat-power", name: "동력·효율", description: "파워트레인·연비·전동화 관련 조건" },
    { id: "cat-safety", name: "안전·편의", description: "안전 사양과 주행 보조 기능" },
    { id: "cat-cost", name: "비용", description: "구매 예산과 보유 비용 관련 조건" },
  ],
  conditions: [
    {
      id: "cond-3row",
      categoryId: "cat-space",
      name: "3열 풀사이즈",
      mentionCount: 156,
      perspective: { buyer: 131, seller: 8, neutral: 17 },
      sourceDomains: { "bobaedream.co.kr": 52, "cafe.naver.com": 41, "youtube.com": 38, "clien.net": 25 },
      evidenceQuotes: [
        {
          quote: "3열에 성인이 앉을 수 있는 건 팰리세이드급 풀사이즈뿐이에요.",
          sourceTitle: "유튜브 - 3열 SUV 실측 비교",
          sourceUrl: "youtube.com/watch?v=row3",
          perspective: "buyer",
        },
      ],
      relatedConditionIds: ["cond-trunk", "cond-fold"],
    },
    {
      id: "cond-trunk",
      categoryId: "cat-space",
      name: "트렁크 적재",
      mentionCount: 118,
      perspective: { buyer: 96, seller: 6, neutral: 16 },
      sourceDomains: { "cafe.naver.com": 39, "youtube.com": 33, "bobaedream.co.kr": 27, "dcinside.com": 19 },
      evidenceQuotes: [
        {
          quote: "유모차 + 캠핑박스 동시에 들어가는지가 합격 기준입니다.",
          sourceTitle: "네이버 카페 - 적재 끝판왕",
          sourceUrl: "cafe.naver.com/loadtest/5",
          perspective: "buyer",
        },
      ],
      relatedConditionIds: ["cond-3row", "cond-fold"],
    },
    {
      id: "cond-fold",
      categoryId: "cat-space",
      name: "시트 풀폴딩",
      mentionCount: 84,
      perspective: { buyer: 67, seller: 5, neutral: 12 },
      sourceDomains: { "youtube.com": 31, "dcinside.com": 22, "cafe.naver.com": 18, "clien.net": 13 },
      evidenceQuotes: [
        {
          quote: "2·3열 완전 평탄화 돼야 차박 매트가 뜨지 않아요.",
          sourceTitle: "디시 - 차박 평탄화",
          sourceUrl: "dcinside.com/board/camping/99",
          perspective: "buyer",
        },
      ],
      relatedConditionIds: ["cond-trunk", "cond-3row"],
    },
    {
      id: "cond-hybrid",
      categoryId: "cat-power",
      name: "하이브리드",
      mentionCount: 132,
      perspective: { buyer: 104, seller: 11, neutral: 17 },
      sourceDomains: { "clien.net": 41, "bobaedream.co.kr": 36, "youtube.com": 31, "cafe.naver.com": 24 },
      evidenceQuotes: [
        {
          quote: "장거리 위주라 디젤 단종 후엔 하이브리드가 답이더라고요.",
          sourceTitle: "클리앙 - HEV 실연비",
          sourceUrl: "clien.net/service/board/901",
          perspective: "buyer",
        },
      ],
      relatedConditionIds: ["cond-mpg", "cond-evsubsidy"],
    },
    {
      id: "cond-mpg",
      categoryId: "cat-power",
      name: "실연비",
      mentionCount: 97,
      perspective: { buyer: 79, seller: 6, neutral: 12 },
      sourceDomains: { "bobaedream.co.kr": 34, "clien.net": 28, "youtube.com": 21, "cafe.naver.com": 14 },
      evidenceQuotes: [
        {
          quote: "공인연비 말고 실제 고속 연비 영상으로 검증된 차만 봅니다.",
          sourceTitle: "유튜브 - 실연비 측정",
          sourceUrl: "youtube.com/watch?v=mpg",
          perspective: "neutral",
        },
      ],
      relatedConditionIds: ["cond-hybrid"],
    },
    {
      id: "cond-evsubsidy",
      categoryId: "cat-power",
      name: "전기차 보조금",
      mentionCount: 63,
      perspective: { buyer: 49, seller: 4, neutral: 10 },
      sourceDomains: { "cafe.naver.com": 22, "clien.net": 18, "bobaedream.co.kr": 13, "youtube.com": 10 },
      evidenceQuotes: [
        {
          quote: "보조금 지자체별로 달라서 받는 금액에 따라 견적이 완전 바뀌어요.",
          sourceTitle: "네이버 카페 - EV 보조금",
          sourceUrl: "cafe.naver.com/evsubsidy/3",
          perspective: "buyer",
        },
      ],
      relatedConditionIds: ["cond-mpg"],
    },
    {
      id: "cond-adas",
      categoryId: "cat-safety",
      name: "첨단 안전(ADAS)",
      mentionCount: 111,
      perspective: { buyer: 88, seller: 9, neutral: 14 },
      sourceDomains: { "clien.net": 37, "youtube.com": 29, "bobaedream.co.kr": 26, "cafe.naver.com": 19 },
      evidenceQuotes: [
        {
          quote: "고속 차로유지 보조 있는 거랑 없는 거랑 장거리 피로도가 천지차이.",
          sourceTitle: "클리앙 - ADAS 후기",
          sourceUrl: "clien.net/service/board/950",
          perspective: "buyer",
        },
      ],
      relatedConditionIds: ["cond-rearmon"],
    },
    {
      id: "cond-rearmon",
      categoryId: "cat-safety",
      name: "후방·후석 모니터",
      mentionCount: 54,
      perspective: { buyer: 43, seller: 3, neutral: 8 },
      sourceDomains: { "cafe.naver.com": 21, "youtube.com": 15, "clien.net": 10, "bobaedream.co.kr": 8 },
      evidenceQuotes: [
        {
          quote: "뒷자리 애들 카메라로 보이는 후석 모니터가 의외로 만족도 높아요.",
          sourceTitle: "네이버 카페 - 후석 모니터",
          sourceUrl: "cafe.naver.com/rearmon/7",
          perspective: "buyer",
        },
      ],
      relatedConditionIds: ["cond-adas"],
    },
    {
      id: "cond-4wd",
      categoryId: "cat-safety",
      name: "사륜구동(4WD)",
      mentionCount: 76,
      perspective: { buyer: 61, seller: 4, neutral: 11 },
      sourceDomains: { "bobaedream.co.kr": 27, "dcinside.com": 20, "youtube.com": 17, "clien.net": 12 },
      evidenceQuotes: [
        {
          quote: "캠핑+눈길 둘 다라 4WD는 옵션이 아니라 필수로 봅니다.",
          sourceTitle: "보배드림 - 4WD vs 2WD",
          sourceUrl: "bobaedream.co.kr/view/456",
          perspective: "buyer",
        },
      ],
      relatedConditionIds: ["cond-fold"],
    },
    {
      id: "cond-budget",
      categoryId: "cat-cost",
      name: "예산 5천 이하",
      mentionCount: 93,
      perspective: { buyer: 78, seller: 5, neutral: 10 },
      sourceDomains: { "cafe.naver.com": 31, "clien.net": 26, "bobaedream.co.kr": 21, "youtube.com": 15 },
      evidenceQuotes: [
        {
          quote: "풀옵 넣으면 6천 넘어가서 트림 타협 어디서 할지가 고민.",
          sourceTitle: "클리앙 - 견적 5천 한계",
          sourceUrl: "clien.net/service/board/980",
          perspective: "buyer",
        },
      ],
      relatedConditionIds: ["cond-resale"],
    },
    {
      id: "cond-resale",
      categoryId: "cat-cost",
      name: "잔존가치",
      mentionCount: 67,
      perspective: { buyer: 52, seller: 6, neutral: 9 },
      sourceDomains: { "bobaedream.co.kr": 25, "cafe.naver.com": 18, "clien.net": 14, "youtube.com": 10 },
      evidenceQuotes: [
        {
          quote: "3년 뒤 팔 거라 감가 적게 떨어지는 인기 모델 위주로 봅니다.",
          sourceTitle: "보배드림 - 잔존가치 순위",
          sourceUrl: "bobaedream.co.kr/view/567",
          perspective: "neutral",
        },
      ],
      relatedConditionIds: ["cond-budget"],
    },
    {
      id: "cond-tco",
      categoryId: "cat-cost",
      name: "유지비",
      mentionCount: 49,
      perspective: { buyer: 39, seller: 3, neutral: 7 },
      sourceDomains: { "clien.net": 17, "cafe.naver.com": 14, "bobaedream.co.kr": 11, "youtube.com": 7 },
      evidenceQuotes: [
        {
          quote: "보험+연료+정비 합치면 결국 하이브리드가 장기적으로 쌉니다.",
          sourceTitle: "클리앙 - 5년 유지비",
          sourceUrl: "clien.net/service/board/995",
          perspective: "buyer",
        },
      ],
      relatedConditionIds: ["cond-hybrid"],
    },
  ],
  drives: [
    { contextId: "ctx-multikid", conditionId: "cond-3row", strength: "high" },
    { contextId: "ctx-multikid", conditionId: "cond-trunk", strength: "medium" },
    { contextId: "ctx-multikid", conditionId: "cond-rearmon", strength: "low" },
    { contextId: "ctx-newparent", conditionId: "cond-adas", strength: "high" },
    { contextId: "ctx-newparent", conditionId: "cond-rearmon", strength: "medium" },
    { contextId: "ctx-newparent", conditionId: "cond-budget", strength: "medium" },
    { contextId: "ctx-3gen", conditionId: "cond-3row", strength: "high" },
    { contextId: "ctx-3gen", conditionId: "cond-fold", strength: "low" },
    { contextId: "ctx-camping", conditionId: "cond-4wd", strength: "high" },
    { contextId: "ctx-camping", conditionId: "cond-fold", strength: "high" },
    { contextId: "ctx-camping", conditionId: "cond-trunk", strength: "medium" },
    { contextId: "ctx-pet", conditionId: "cond-fold", strength: "high" },
    { contextId: "ctx-pet", conditionId: "cond-trunk", strength: "medium" },
    { contextId: "ctx-commute", conditionId: "cond-hybrid", strength: "high" },
    { contextId: "ctx-commute", conditionId: "cond-mpg", strength: "high" },
    { contextId: "ctx-commute", conditionId: "cond-adas", strength: "medium" },
    { contextId: "ctx-snow", conditionId: "cond-4wd", strength: "high" },
    { contextId: "ctx-firstcar", conditionId: "cond-budget", strength: "high" },
    { contextId: "ctx-firstcar", conditionId: "cond-resale", strength: "high" },
    { contextId: "ctx-firstcar", conditionId: "cond-tco", strength: "medium" },
  ],
  combinations: [
    {
      id: "combo-3row-trunk",
      conditionIds: ["cond-3row", "cond-trunk"],
      frequency: "high",
      description: "3열 풀사이즈를 원하는 사람은 트렁크 적재량도 함께 따진다",
      coOccurrenceCount: 89,
      totalSpeakers: 240,
      justification: "240명 중 89명 (37%)",
      sourceUrls: ["bobaedream.co.kr/view/123", "cafe.naver.com/loadtest/5"],
    },
    {
      id: "combo-hybrid-mpg",
      conditionIds: ["cond-hybrid", "cond-mpg"],
      frequency: "high",
      description: "하이브리드 관심층은 공인연비가 아닌 실연비 검증을 요구한다",
      coOccurrenceCount: 71,
      totalSpeakers: 240,
      justification: "240명 중 71명 (30%)",
      sourceUrls: ["clien.net/service/board/901", "youtube.com/watch?v=mpg"],
    },
    {
      id: "combo-4wd-fold",
      conditionIds: ["cond-4wd", "cond-fold"],
      frequency: "medium",
      description: "차박·아웃도어 맥락에서 4WD와 풀폴딩이 한 세트로 언급된다",
      coOccurrenceCount: 52,
      totalSpeakers: 240,
      justification: "240명 중 52명 (22%)",
      sourceUrls: ["youtube.com/watch?v=cmp1", "dcinside.com/board/camping/99"],
    },
    {
      id: "combo-budget-resale",
      conditionIds: ["cond-budget", "cond-resale"],
      frequency: "medium",
      description: "첫 차·예산 제약층은 구매 예산과 잔존가치를 동시에 계산한다",
      coOccurrenceCount: 44,
      totalSpeakers: 240,
      justification: "240명 중 44명 (18%)",
      sourceUrls: ["cafe.naver.com/firstcar/12", "bobaedream.co.kr/view/567"],
    },
    {
      id: "combo-adas-rearmon",
      conditionIds: ["cond-adas", "cond-rearmon"],
      frequency: "medium",
      description: "영유아 동반 안전 민감층은 ADAS와 후석 모니터를 함께 고려한다",
      coOccurrenceCount: 38,
      totalSpeakers: 240,
      justification: "240명 중 38명 (16%)",
      sourceUrls: ["clien.net/service/board/950", "cafe.naver.com/rearmon/7"],
    },
    {
      id: "combo-evsubsidy-tco",
      conditionIds: ["cond-evsubsidy", "cond-tco"],
      frequency: "low",
      description: "전동화 검토층은 보조금과 장기 유지비를 묶어서 본다",
      coOccurrenceCount: 21,
      totalSpeakers: 240,
      justification: "240명 중 21명 (9%)",
      sourceUrls: ["cafe.naver.com/evsubsidy/3", "clien.net/service/board/995"],
    },
  ],
  stats: {
    contexts: 8,
    conditions: 12,
    relationships: 26,
    sources: 287,
    workers: 24,
    cost: 1.42,
  },
};

const SAMPLE_MATRIX_EN: ContextMatrix = {
  keyword: "family SUV",
  themes: [
    { id: "th-house", name: "Household Type", description: "Purchase context driven by household composition and family size" },
    { id: "th-life", name: "Lifestyle", description: "Purchase context centered on leisure and hobby activities" },
    { id: "th-usage", name: "Usage Environment", description: "Context shaped by driving environment and ownership experience" },
  ],
  contexts: [
    {
      id: "ctx-multikid",
      themeId: "th-house",
      name: "Multi-child household",
      mentionCount: 142,
      perspective: { buyer: 118, seller: 6, neutral: 18 },
      sourceDomains: { "bobaedream.co.kr": 41, "cafe.naver.com": 38, "clien.net": 22, "youtube.com": 19 },
      evidenceQuotes: [
        {
          quote: "With three kids, nothing works except a full-size SUV that fits two car seats in the third row.",
          sourceTitle: "Bobaedream - Family car dilemma",
          sourceUrl: "bobaedream.co.kr/view/123",
          perspective: "buyer",
        },
        {
          quote: "If you need to fit a stroller plus camping gear, trunk depth really matters.",
          sourceTitle: "Naver Cafe - New car owners group",
          sourceUrl: "cafe.naver.com/familycar/456",
          perspective: "buyer",
        },
      ],
    },
    {
      id: "ctx-newparent",
      themeId: "th-house",
      name: "Newlyweds & expecting parents",
      mentionCount: 96,
      perspective: { buyer: 80, seller: 4, neutral: 12 },
      sourceDomains: { "cafe.naver.com": 44, "clien.net": 21, "dcinside.com": 17, "youtube.com": 14 },
      evidenceQuotes: [
        {
          quote: "Since it's for our first baby, we want every safety option, but the budget is tight.",
          sourceTitle: "Clien - Car recommendations for new parents",
          sourceUrl: "clien.net/service/board/777",
          perspective: "buyer",
        },
      ],
    },
    {
      id: "ctx-3gen",
      themeId: "th-house",
      name: "Three-generation household",
      mentionCount: 58,
      perspective: { buyer: 47, seller: 3, neutral: 8 },
      sourceDomains: { "bobaedream.co.kr": 19, "cafe.naver.com": 22, "clien.net": 9, "youtube.com": 8 },
      evidenceQuotes: [
        {
          quote: "Easy second-row entry and exit is priority #1 when I'm driving my parents around.",
          sourceTitle: "Bobaedream - Cars for driving parents",
          sourceUrl: "bobaedream.co.kr/view/234",
          perspective: "buyer",
        },
      ],
    },
    {
      id: "ctx-camping",
      themeId: "th-life",
      name: "Camping & car camping",
      mentionCount: 124,
      perspective: { buyer: 98, seller: 9, neutral: 17 },
      sourceDomains: { "youtube.com": 48, "dcinside.com": 33, "cafe.naver.com": 25, "clien.net": 18 },
      evidenceQuotes: [
        {
          quote: "The second row folds fully flat, so two adults can lie down with a car-camping mat. That's the key thing.",
          sourceTitle: "YouTube - Comparing top car-camping SUVs",
          sourceUrl: "youtube.com/watch?v=cmp1",
          perspective: "buyer",
        },
        {
          quote: "A lot of campsites require off-road access, so 4WD is nearly a must.",
          sourceTitle: "DCInside - Car camping gallery",
          sourceUrl: "dcinside.com/board/camping/88",
          perspective: "neutral",
        },
      ],
    },
    {
      id: "ctx-pet",
      themeId: "th-life",
      name: "Traveling with pets",
      mentionCount: 71,
      perspective: { buyer: 58, seller: 4, neutral: 9 },
      sourceDomains: { "cafe.naver.com": 28, "youtube.com": 21, "clien.net": 12, "bobaedream.co.kr": 10 },
      evidenceQuotes: [
        {
          quote: "I have two large dogs, so I'm looking for a car with a spacious cargo area and flat-folding seats.",
          sourceTitle: "Naver Cafe - Car camping with dogs",
          sourceUrl: "cafe.naver.com/petcar/91",
          perspective: "buyer",
        },
      ],
    },
    {
      id: "ctx-commute",
      themeId: "th-usage",
      name: "Long-distance commute",
      mentionCount: 109,
      perspective: { buyer: 86, seller: 7, neutral: 16 },
      sourceDomains: { "clien.net": 34, "bobaedream.co.kr": 31, "youtube.com": 26, "cafe.naver.com": 18 },
      evidenceQuotes: [
        {
          quote: "My round trip is 120km, so without good real-world mileage and semi-autonomous driving, my body can't handle it.",
          sourceTitle: "Clien - Cars for long commutes",
          sourceUrl: "clien.net/service/board/812",
          perspective: "buyer",
        },
      ],
    },
    {
      id: "ctx-snow",
      themeId: "th-usage",
      name: "Snowy & rough-road regions",
      mentionCount: 47,
      perspective: { buyer: 38, seller: 2, neutral: 7 },
      sourceDomains: { "bobaedream.co.kr": 16, "dcinside.com": 14, "clien.net": 9, "youtube.com": 8 },
      evidenceQuotes: [
        {
          quote: "I live in the Gangwon mountains, so without 4WD I can't even get to work in winter.",
          sourceTitle: "Bobaedream - 4WD review",
          sourceUrl: "bobaedream.co.kr/view/345",
          perspective: "buyer",
        },
      ],
    },
    {
      id: "ctx-firstcar",
      themeId: "th-usage",
      name: "First car purchase",
      mentionCount: 88,
      perspective: { buyer: 72, seller: 5, neutral: 11 },
      sourceDomains: { "cafe.naver.com": 33, "clien.net": 24, "bobaedream.co.kr": 18, "youtube.com": 13 },
      evidenceQuotes: [
        {
          quote: "It's my first car, so I want one with low depreciation for resale later. Budget is under 50 million won.",
          sourceTitle: "Naver Cafe - First car dilemma",
          sourceUrl: "cafe.naver.com/firstcar/12",
          perspective: "buyer",
        },
      ],
    },
  ],
  categories: [
    { id: "cat-space", name: "Space & Seating", description: "Passenger and cargo space, and seat versatility" },
    { id: "cat-power", name: "Powertrain & Efficiency", description: "Conditions related to powertrain, fuel efficiency, and electrification" },
    { id: "cat-safety", name: "Safety & Convenience", description: "Safety features and driver assistance functions" },
    { id: "cat-cost", name: "Cost", description: "Conditions related to purchase budget and ownership cost" },
  ],
  conditions: [
    {
      id: "cond-3row",
      categoryId: "cat-space",
      name: "Full-size 3rd row",
      mentionCount: 156,
      perspective: { buyer: 131, seller: 8, neutral: 17 },
      sourceDomains: { "bobaedream.co.kr": 52, "cafe.naver.com": 41, "youtube.com": 38, "clien.net": 25 },
      evidenceQuotes: [
        {
          quote: "Only a full-size SUV like the Palisade lets an adult actually sit in the third row.",
          sourceTitle: "YouTube - Measuring 3rd-row SUVs",
          sourceUrl: "youtube.com/watch?v=row3",
          perspective: "buyer",
        },
      ],
      relatedConditionIds: ["cond-trunk", "cond-fold"],
    },
    {
      id: "cond-trunk",
      categoryId: "cat-space",
      name: "Trunk cargo capacity",
      mentionCount: 118,
      perspective: { buyer: 96, seller: 6, neutral: 16 },
      sourceDomains: { "cafe.naver.com": 39, "youtube.com": 33, "bobaedream.co.kr": 27, "dcinside.com": 19 },
      evidenceQuotes: [
        {
          quote: "Whether a stroller and a camping box both fit at once is the pass/fail test.",
          sourceTitle: "Naver Cafe - Ultimate cargo capacity",
          sourceUrl: "cafe.naver.com/loadtest/5",
          perspective: "buyer",
        },
      ],
      relatedConditionIds: ["cond-3row", "cond-fold"],
    },
    {
      id: "cond-fold",
      categoryId: "cat-space",
      name: "Full seat folding",
      mentionCount: 84,
      perspective: { buyer: 67, seller: 5, neutral: 12 },
      sourceDomains: { "youtube.com": 31, "dcinside.com": 22, "cafe.naver.com": 18, "clien.net": 13 },
      evidenceQuotes: [
        {
          quote: "The 2nd and 3rd rows need to fold completely flat, or the car-camping mat won't sit right.",
          sourceTitle: "DCInside - Flat-folding for car camping",
          sourceUrl: "dcinside.com/board/camping/99",
          perspective: "buyer",
        },
      ],
      relatedConditionIds: ["cond-trunk", "cond-3row"],
    },
    {
      id: "cond-hybrid",
      categoryId: "cat-power",
      name: "Hybrid",
      mentionCount: 132,
      perspective: { buyer: 104, seller: 11, neutral: 17 },
      sourceDomains: { "clien.net": 41, "bobaedream.co.kr": 36, "youtube.com": 31, "cafe.naver.com": 24 },
      evidenceQuotes: [
        {
          quote: "Since I mostly drive long distances, once diesel got discontinued, hybrid turned out to be the answer.",
          sourceTitle: "Clien - Real-world hybrid mileage",
          sourceUrl: "clien.net/service/board/901",
          perspective: "buyer",
        },
      ],
      relatedConditionIds: ["cond-mpg", "cond-evsubsidy"],
    },
    {
      id: "cond-mpg",
      categoryId: "cat-power",
      name: "Real-world mileage",
      mentionCount: 97,
      perspective: { buyer: 79, seller: 6, neutral: 12 },
      sourceDomains: { "bobaedream.co.kr": 34, "clien.net": 28, "youtube.com": 21, "cafe.naver.com": 14 },
      evidenceQuotes: [
        {
          quote: "I only consider cars verified by actual highway mileage videos, not the official rating.",
          sourceTitle: "YouTube - Real-world mileage tests",
          sourceUrl: "youtube.com/watch?v=mpg",
          perspective: "neutral",
        },
      ],
      relatedConditionIds: ["cond-hybrid"],
    },
    {
      id: "cond-evsubsidy",
      categoryId: "cat-power",
      name: "EV subsidy",
      mentionCount: 63,
      perspective: { buyer: 49, seller: 4, neutral: 10 },
      sourceDomains: { "cafe.naver.com": 22, "clien.net": 18, "bobaedream.co.kr": 13, "youtube.com": 10 },
      evidenceQuotes: [
        {
          quote: "Subsidies vary by local government, so the quote changes completely depending on the amount you get.",
          sourceTitle: "Naver Cafe - EV subsidies",
          sourceUrl: "cafe.naver.com/evsubsidy/3",
          perspective: "buyer",
        },
      ],
      relatedConditionIds: ["cond-mpg"],
    },
    {
      id: "cond-adas",
      categoryId: "cat-safety",
      name: "Advanced safety (ADAS)",
      mentionCount: 111,
      perspective: { buyer: 88, seller: 9, neutral: 14 },
      sourceDomains: { "clien.net": 37, "youtube.com": 29, "bobaedream.co.kr": 26, "cafe.naver.com": 19 },
      evidenceQuotes: [
        {
          quote: "Highway lane-keeping assist makes a world of difference in fatigue on long drives.",
          sourceTitle: "Clien - ADAS review",
          sourceUrl: "clien.net/service/board/950",
          perspective: "buyer",
        },
      ],
      relatedConditionIds: ["cond-rearmon"],
    },
    {
      id: "cond-rearmon",
      categoryId: "cat-safety",
      name: "Rear & back-seat monitor",
      mentionCount: 54,
      perspective: { buyer: 43, seller: 3, neutral: 8 },
      sourceDomains: { "cafe.naver.com": 21, "youtube.com": 15, "clien.net": 10, "bobaedream.co.kr": 8 },
      evidenceQuotes: [
        {
          quote: "The back-seat monitor that shows the kids via camera is surprisingly satisfying.",
          sourceTitle: "Naver Cafe - Back-seat monitor",
          sourceUrl: "cafe.naver.com/rearmon/7",
          perspective: "buyer",
        },
      ],
      relatedConditionIds: ["cond-adas"],
    },
    {
      id: "cond-4wd",
      categoryId: "cat-safety",
      name: "4WD",
      mentionCount: 76,
      perspective: { buyer: 61, seller: 4, neutral: 11 },
      sourceDomains: { "bobaedream.co.kr": 27, "dcinside.com": 20, "youtube.com": 17, "clien.net": 12 },
      evidenceQuotes: [
        {
          quote: "Between camping and snowy roads, I see 4WD as a must-have, not an option.",
          sourceTitle: "Bobaedream - 4WD vs 2WD",
          sourceUrl: "bobaedream.co.kr/view/456",
          perspective: "buyer",
        },
      ],
      relatedConditionIds: ["cond-fold"],
    },
    {
      id: "cond-budget",
      categoryId: "cat-cost",
      name: "Budget under 50M won",
      mentionCount: 93,
      perspective: { buyer: 78, seller: 5, neutral: 10 },
      sourceDomains: { "cafe.naver.com": 31, "clien.net": 26, "bobaedream.co.kr": 21, "youtube.com": 15 },
      evidenceQuotes: [
        {
          quote: "Fully loaded goes over 60M won, so the question is where to compromise on trim.",
          sourceTitle: "Clien - Staying under a 50M won quote",
          sourceUrl: "clien.net/service/board/980",
          perspective: "buyer",
        },
      ],
      relatedConditionIds: ["cond-resale"],
    },
    {
      id: "cond-resale",
      categoryId: "cat-cost",
      name: "Resale value",
      mentionCount: 67,
      perspective: { buyer: 52, seller: 6, neutral: 9 },
      sourceDomains: { "bobaedream.co.kr": 25, "cafe.naver.com": 18, "clien.net": 14, "youtube.com": 10 },
      evidenceQuotes: [
        {
          quote: "I'll sell it in 3 years, so I'm focusing on popular models with low depreciation.",
          sourceTitle: "Bobaedream - Resale value rankings",
          sourceUrl: "bobaedream.co.kr/view/567",
          perspective: "neutral",
        },
      ],
      relatedConditionIds: ["cond-budget"],
    },
    {
      id: "cond-tco",
      categoryId: "cat-cost",
      name: "Ownership cost",
      mentionCount: 49,
      perspective: { buyer: 39, seller: 3, neutral: 7 },
      sourceDomains: { "clien.net": 17, "cafe.naver.com": 14, "bobaedream.co.kr": 11, "youtube.com": 7 },
      evidenceQuotes: [
        {
          quote: "Adding up insurance, fuel, and maintenance, a hybrid ends up cheaper long-term.",
          sourceTitle: "Clien - 5-year ownership cost",
          sourceUrl: "clien.net/service/board/995",
          perspective: "buyer",
        },
      ],
      relatedConditionIds: ["cond-hybrid"],
    },
  ],
  drives: [
    { contextId: "ctx-multikid", conditionId: "cond-3row", strength: "high" },
    { contextId: "ctx-multikid", conditionId: "cond-trunk", strength: "medium" },
    { contextId: "ctx-multikid", conditionId: "cond-rearmon", strength: "low" },
    { contextId: "ctx-newparent", conditionId: "cond-adas", strength: "high" },
    { contextId: "ctx-newparent", conditionId: "cond-rearmon", strength: "medium" },
    { contextId: "ctx-newparent", conditionId: "cond-budget", strength: "medium" },
    { contextId: "ctx-3gen", conditionId: "cond-3row", strength: "high" },
    { contextId: "ctx-3gen", conditionId: "cond-fold", strength: "low" },
    { contextId: "ctx-camping", conditionId: "cond-4wd", strength: "high" },
    { contextId: "ctx-camping", conditionId: "cond-fold", strength: "high" },
    { contextId: "ctx-camping", conditionId: "cond-trunk", strength: "medium" },
    { contextId: "ctx-pet", conditionId: "cond-fold", strength: "high" },
    { contextId: "ctx-pet", conditionId: "cond-trunk", strength: "medium" },
    { contextId: "ctx-commute", conditionId: "cond-hybrid", strength: "high" },
    { contextId: "ctx-commute", conditionId: "cond-mpg", strength: "high" },
    { contextId: "ctx-commute", conditionId: "cond-adas", strength: "medium" },
    { contextId: "ctx-snow", conditionId: "cond-4wd", strength: "high" },
    { contextId: "ctx-firstcar", conditionId: "cond-budget", strength: "high" },
    { contextId: "ctx-firstcar", conditionId: "cond-resale", strength: "high" },
    { contextId: "ctx-firstcar", conditionId: "cond-tco", strength: "medium" },
  ],
  combinations: [
    {
      id: "combo-3row-trunk",
      conditionIds: ["cond-3row", "cond-trunk"],
      frequency: "high",
      description: "People who want a full-size 3rd row also weigh trunk cargo capacity",
      coOccurrenceCount: 89,
      totalSpeakers: 240,
      justification: "89 of 240 (37%)",
      sourceUrls: ["bobaedream.co.kr/view/123", "cafe.naver.com/loadtest/5"],
    },
    {
      id: "combo-hybrid-mpg",
      conditionIds: ["cond-hybrid", "cond-mpg"],
      frequency: "high",
      description: "Hybrid-interested buyers demand real-world mileage verification, not the official rating",
      coOccurrenceCount: 71,
      totalSpeakers: 240,
      justification: "71 of 240 (30%)",
      sourceUrls: ["clien.net/service/board/901", "youtube.com/watch?v=mpg"],
    },
    {
      id: "combo-4wd-fold",
      conditionIds: ["cond-4wd", "cond-fold"],
      frequency: "medium",
      description: "In car-camping and outdoor contexts, 4WD and full seat folding are mentioned together as a set",
      coOccurrenceCount: 52,
      totalSpeakers: 240,
      justification: "52 of 240 (22%)",
      sourceUrls: ["youtube.com/watch?v=cmp1", "dcinside.com/board/camping/99"],
    },
    {
      id: "combo-budget-resale",
      conditionIds: ["cond-budget", "cond-resale"],
      frequency: "medium",
      description: "First-car buyers on a tight budget calculate purchase price and resale value together",
      coOccurrenceCount: 44,
      totalSpeakers: 240,
      justification: "44 of 240 (18%)",
      sourceUrls: ["cafe.naver.com/firstcar/12", "bobaedream.co.kr/view/567"],
    },
    {
      id: "combo-adas-rearmon",
      conditionIds: ["cond-adas", "cond-rearmon"],
      frequency: "medium",
      description: "Safety-conscious parents of young children weigh ADAS and the back-seat monitor together",
      coOccurrenceCount: 38,
      totalSpeakers: 240,
      justification: "38 of 240 (16%)",
      sourceUrls: ["clien.net/service/board/950", "cafe.naver.com/rearmon/7"],
    },
    {
      id: "combo-evsubsidy-tco",
      conditionIds: ["cond-evsubsidy", "cond-tco"],
      frequency: "low",
      description: "Buyers considering electrification weigh the subsidy against long-term ownership cost",
      coOccurrenceCount: 21,
      totalSpeakers: 240,
      justification: "21 of 240 (9%)",
      sourceUrls: ["cafe.naver.com/evsubsidy/3", "clien.net/service/board/995"],
    },
  ],
  stats: {
    contexts: 8,
    conditions: 12,
    relationships: 26,
    sources: 287,
    workers: 24,
    cost: 1.42,
  },
};

export function getSampleMatrix(locale: string): ContextMatrix {
  return pick(locale, SAMPLE_MATRIX_KO, SAMPLE_MATRIX_EN);
}

// ════════════════════════════════════════════════════════════════════════
// EXPLORING timeline — scripted stand-in for the SSE stream (§5)
// ════════════════════════════════════════════════════════════════════════

const EXPLORING_STEPS_KO: ExploringStep[] = [
  { kind: "log", logKind: "reasoning", title: "리서치 전략 수립 중", detail: "키워드 '패밀리 SUV'를 가구 형태·라이프스타일·사용 환경 3축으로 분해합니다." },
  { kind: "wave", wave: 1, strategy: "구매 맥락 1차 census — 누가, 어떤 상황에서 검색하는가" },
  { kind: "dispatch", workerId: "w1", wave: 1, label: "다자녀 적재", query: "7인승 SUV 카시트 두 개 3열 후기" },
  { kind: "dispatch", workerId: "w2", wave: 1, label: "차박 수요", query: "차박 SUV 2열 풀폴딩 평탄화 추천" },
  { kind: "dispatch", workerId: "w3", wave: 1, label: "출퇴근 연비", query: "패밀리 SUV 장거리 실연비 하이브리드" },
  { kind: "cost", cost: 0.18, firecrawl: 6 },
  { kind: "sources", workerId: "w1", sourceCount: 14 },
  { kind: "log", logKind: "search", title: "보배드림·네이버 카페에서 14개 소스 수집", detail: "다자녀 가구의 3열·적재 요구가 반복 등장" },
  { kind: "sources", workerId: "w2", sourceCount: 18 },
  { kind: "sources", workerId: "w3", sourceCount: 12 },
  { kind: "complete", workerId: "w1" },
  { kind: "log", logKind: "worker", title: "Worker 완료: 다자녀 적재", detail: "맥락 '다자녀 가구' → 조건 '3열 풀사이즈/트렁크 적재' 도출" },
  { kind: "complete", workerId: "w2" },
  { kind: "complete", workerId: "w3" },
  { kind: "log", logKind: "discover", title: "Wave 1 완료 — 커버리지 점검", detail: "맥락 6종·조건 8종 발견. 비용·전동화 신호가 아직 약함." },
  { kind: "cost", cost: 0.46, firecrawl: 11 },
  { kind: "wave", wave: 2, strategy: "갭 보강 — 비용·전동화·안전 축 심화 탐색" },
  { kind: "dispatch", workerId: "w4", wave: 2, label: "예산·잔가", query: "첫차 패밀리 SUV 예산 5천 감가 적은 차" },
  { kind: "dispatch", workerId: "w5", wave: 2, label: "전동화", query: "패밀리 SUV 전기차 보조금 유지비 비교" },
  { kind: "dispatch", workerId: "w6", wave: 2, label: "영유아 안전", query: "신생아 카시트 SUV ADAS 후석 모니터" },
  { kind: "sources", workerId: "w4", sourceCount: 16 },
  { kind: "sources", workerId: "w5", sourceCount: 13 },
  { kind: "log", logKind: "reasoning", title: "조합 패턴 분석", detail: "'3열+적재', '하이브리드+실연비'가 강한 동시 언급으로 확인됨." },
  { kind: "sources", workerId: "w6", sourceCount: 11 },
  { kind: "complete", workerId: "w4" },
  { kind: "complete", workerId: "w5" },
  { kind: "complete", workerId: "w6" },
  { kind: "cost", cost: 0.92, firecrawl: 19 },
  { kind: "log", logKind: "discover", title: "Wave 2 완료 — 맥락·조건 포화 접근", detail: "신규 맥락 증가율 둔화. 매트릭스 산출 준비 완료." },
  { kind: "cost", cost: 1.42, firecrawl: 24 },
];

const EXPLORING_STEPS_EN: ExploringStep[] = [
  { kind: "log", logKind: "reasoning", title: "Building research strategy", detail: "Breaking down the keyword 'family SUV' into three axes: household type, lifestyle, and usage environment." },
  { kind: "wave", wave: 1, strategy: "First-pass census of purchase contexts — who is searching, and in what situation" },
  { kind: "dispatch", workerId: "w1", wave: 1, label: "Multi-child cargo", query: "7-seater SUV two car seats 3rd row review" },
  { kind: "dispatch", workerId: "w2", wave: 1, label: "Car-camping demand", query: "car camping SUV 2nd row full-fold flat recommendation" },
  { kind: "dispatch", workerId: "w3", wave: 1, label: "Commute mileage", query: "family SUV long-distance real mileage hybrid" },
  { kind: "cost", cost: 0.18, firecrawl: 6 },
  { kind: "sources", workerId: "w1", sourceCount: 14 },
  { kind: "log", logKind: "search", title: "Collected 14 sources from Bobaedream and Naver Cafe", detail: "Multi-child households repeatedly cite 3rd-row and cargo needs" },
  { kind: "sources", workerId: "w2", sourceCount: 18 },
  { kind: "sources", workerId: "w3", sourceCount: 12 },
  { kind: "complete", workerId: "w1" },
  { kind: "log", logKind: "worker", title: "Worker complete: Multi-child cargo", detail: "Context 'Multi-child household' → derived conditions 'full-size 3rd row / trunk cargo'" },
  { kind: "complete", workerId: "w2" },
  { kind: "complete", workerId: "w3" },
  { kind: "log", logKind: "discover", title: "Wave 1 complete — coverage check", detail: "Found 6 contexts and 8 conditions. Cost and electrification signals are still weak." },
  { kind: "cost", cost: 0.46, firecrawl: 11 },
  { kind: "wave", wave: 2, strategy: "Filling gaps — deeper exploration of cost, electrification, and safety axes" },
  { kind: "dispatch", workerId: "w4", wave: 2, label: "Budget & resale", query: "first family SUV budget under 50M won low depreciation" },
  { kind: "dispatch", workerId: "w5", wave: 2, label: "Electrification", query: "family SUV EV subsidy ownership cost comparison" },
  { kind: "dispatch", workerId: "w6", wave: 2, label: "Infant safety", query: "newborn car seat SUV ADAS back-seat monitor" },
  { kind: "sources", workerId: "w4", sourceCount: 16 },
  { kind: "sources", workerId: "w5", sourceCount: 13 },
  { kind: "log", logKind: "reasoning", title: "Analyzing combination patterns", detail: "'3rd row + cargo' and 'hybrid + real mileage' confirmed as strongly co-mentioned pairs." },
  { kind: "sources", workerId: "w6", sourceCount: 11 },
  { kind: "complete", workerId: "w4" },
  { kind: "complete", workerId: "w5" },
  { kind: "complete", workerId: "w6" },
  { kind: "cost", cost: 0.92, firecrawl: 19 },
  { kind: "log", logKind: "discover", title: "Wave 2 complete — approaching context/condition saturation", detail: "Rate of new contexts is slowing. Ready to generate the matrix." },
  { kind: "cost", cost: 1.42, firecrawl: 24 },
];

export function getExploringSteps(locale: string): ExploringStep[] {
  return pick(locale, EXPLORING_STEPS_KO, EXPLORING_STEPS_EN);
}

// Fold a prefix of the timeline into the snapshot the view renders.
// Pure + deterministic — the view slices the exploring steps [0..n] and calls
// this, avoiding any mutable streaming state / race conditions.
export function reduceExploring(steps: ExploringStep[]): ExploringSnapshot {
  const waves: ExploringSnapshot["waves"] = [];
  const workerMap = new Map<string, ExploringWorker>();
  const order: string[] = [];
  const log: ExploringSnapshot["log"] = [];
  let cost = 0;
  let firecrawl = 0;
  let logSeq = 0;

  for (const step of steps) {
    switch (step.kind) {
      case "wave":
        waves.push({ wave: step.wave, strategy: step.strategy });
        log.push({
          id: `log-${logSeq++}`,
          kind: "wave",
          title: `Wave ${step.wave}`,
          detail: step.strategy,
        });
        break;
      case "dispatch":
        if (!workerMap.has(step.workerId)) order.push(step.workerId);
        workerMap.set(step.workerId, {
          id: step.workerId,
          wave: step.wave,
          label: step.label,
          query: step.query,
          status: "searching",
          sourceCount: 0,
        });
        break;
      case "sources": {
        const w = workerMap.get(step.workerId);
        if (w) {
          w.status = "analyzing";
          w.sourceCount = step.sourceCount;
        }
        break;
      }
      case "complete": {
        const w = workerMap.get(step.workerId);
        if (w) w.status = "completed";
        break;
      }
      case "log":
        log.push({
          id: `log-${logSeq++}`,
          kind: step.logKind,
          title: step.title,
          detail: step.detail,
        });
        break;
      case "cost":
        cost = step.cost;
        firecrawl = step.firecrawl;
        break;
    }
  }

  const workers = order.map((id) => workerMap.get(id)!);
  const sources = workers.reduce((sum, w) => sum + w.sourceCount, 0);
  return { waves, workers, log, cost, firecrawl, sources };
}

// ════════════════════════════════════════════════════════════════════════
// PROMPT CANDIDATES — the bridge to prompt_candidates (source=social_scraping)
// ════════════════════════════════════════════════════════════════════════

const GENERATED_PROMPTS_KO: GeneratedPrompt[] = [
  { id: "gp1", question: "다자녀 가족에게 맞는 7인승 SUV 추천해줘", layer: "L1-context", funnelStage: "awareness", sourceLabel: "다자녀 가구", priority: 92 },
  { id: "gp2", question: "차박하기 좋은 2열 풀폴딩 SUV는?", layer: "L1-context", funnelStage: "awareness", sourceLabel: "캠핑·차박", priority: 86 },
  { id: "gp3", question: "장거리 출퇴근에 가장 연비 좋은 하이브리드 SUV 알려줘", layer: "L1-context", funnelStage: "consideration", sourceLabel: "장거리 출퇴근", priority: 84 },
  { id: "gp4", question: "3열에 성인이 편하게 앉는 풀사이즈 SUV 비교해줘", layer: "L2-condition", funnelStage: "consideration", sourceLabel: "3열 풀사이즈", priority: 90 },
  { id: "gp5", question: "패밀리 SUV 하이브리드 실연비 순위는?", layer: "L2-condition", funnelStage: "consideration", sourceLabel: "실연비", priority: 81 },
  { id: "gp6", question: "5천만 원 이하로 살 수 있는 패밀리 SUV는?", layer: "L2-condition", funnelStage: "purchase", sourceLabel: "예산 5천 이하", priority: 78 },
  { id: "gp7", question: "ADAS와 후석 모니터를 모두 갖춘 SUV 추천", layer: "L2-condition", funnelStage: "consideration", sourceLabel: "첨단 안전(ADAS)", priority: 74 },
  { id: "gp8", question: "3열 넓고 트렁크도 큰 SUV 중 가성비 좋은 차는?", layer: "L3-intersection", funnelStage: "consideration", sourceLabel: "3열 풀사이즈 × 트렁크 적재", priority: 88 },
  { id: "gp9", question: "차박용으로 4WD에 풀폴딩 되는 SUV 비교해줘", layer: "L3-intersection", funnelStage: "consideration", sourceLabel: "사륜구동 × 시트 풀폴딩", priority: 79 },
  { id: "gp10", question: "첫 차로 살 때 예산 대비 잔존가치 좋은 패밀리 SUV는?", layer: "L3-intersection", funnelStage: "purchase", sourceLabel: "예산 5천 이하 × 잔존가치", priority: 76 },
];

const GENERATED_PROMPTS_EN: GeneratedPrompt[] = [
  { id: "gp1", question: "Recommend a 7-seater SUV suited for a large family", layer: "L1-context", funnelStage: "awareness", sourceLabel: "Multi-child household", priority: 92 },
  { id: "gp2", question: "Which SUVs are good for car camping with a fully folding 2nd row?", layer: "L1-context", funnelStage: "awareness", sourceLabel: "Camping & car camping", priority: 86 },
  { id: "gp3", question: "Tell me the most fuel-efficient hybrid SUV for a long commute", layer: "L1-context", funnelStage: "consideration", sourceLabel: "Long-distance commute", priority: 84 },
  { id: "gp4", question: "Compare full-size SUVs where an adult can sit comfortably in the 3rd row", layer: "L2-condition", funnelStage: "consideration", sourceLabel: "Full-size 3rd row", priority: 90 },
  { id: "gp5", question: "What's the real-world mileage ranking for hybrid family SUVs?", layer: "L2-condition", funnelStage: "consideration", sourceLabel: "Real-world mileage", priority: 81 },
  { id: "gp6", question: "Which family SUVs can I buy for under 50 million won?", layer: "L2-condition", funnelStage: "purchase", sourceLabel: "Budget under 50M won", priority: 78 },
  { id: "gp7", question: "Recommend an SUV with both ADAS and a back-seat monitor", layer: "L2-condition", funnelStage: "consideration", sourceLabel: "Advanced safety (ADAS)", priority: 74 },
  { id: "gp8", question: "Which SUV with a spacious 3rd row and big trunk offers the best value?", layer: "L3-intersection", funnelStage: "consideration", sourceLabel: "Full-size 3rd row × trunk cargo", priority: 88 },
  { id: "gp9", question: "Compare 4WD SUVs with full seat folding for car camping", layer: "L3-intersection", funnelStage: "consideration", sourceLabel: "4WD × full seat folding", priority: 79 },
  { id: "gp10", question: "Which family SUV offers the best resale value for the price as a first car?", layer: "L3-intersection", funnelStage: "purchase", sourceLabel: "Budget under 50M won × resale value", priority: 76 },
];

export function getGeneratedPrompts(locale: string): GeneratedPrompt[] {
  return pick(locale, GENERATED_PROMPTS_KO, GENERATED_PROMPTS_EN);
}

export type { SampleLocale };
