// AI Agent Funnel — sample data (Q4=샘플 하드코딩). 실 API 도착 시
// import만 교체. 모든 데이터는 HMG 컨텍스트 (Hyundai 중심) + 가상 수치.

// ─── ① Visibility: 4-quadrant page health (Q1=분위수) ───────────────

export type VisibilityPage = {
  url: string;
  seoImpressions: number; // GSC impressions (대용)
  aiCrawls: number; // ChatGPT-User + Claude-Web + PerplexityBot + Googlebot-Vertex
  quadrant: "star" | "seoGap" | "aiGap" | "deadZone";
  priority: 1 | 2 | 3; // 1=high
};

export const SAMPLE_VISIBILITY_PAGES: VisibilityPage[] = [
  { url: "/ioniq-5", seoImpressions: 12_500, aiCrawls: 480, quadrant: "star", priority: 1 },
  { url: "/genesis-gv80", seoImpressions: 9_300, aiCrawls: 320, quadrant: "star", priority: 1 },
  { url: "/electrified/charging", seoImpressions: 8_100, aiCrawls: 90, quadrant: "aiGap", priority: 1 },
  { url: "/about-hmg", seoImpressions: 6_700, aiCrawls: 35, quadrant: "aiGap", priority: 2 },
  { url: "/kia-ev9", seoImpressions: 4_200, aiCrawls: 410, quadrant: "seoGap", priority: 2 },
  { url: "/palisade", seoImpressions: 5_800, aiCrawls: 270, quadrant: "star", priority: 1 },
  { url: "/dealers/locator", seoImpressions: 1_100, aiCrawls: 28, quadrant: "deadZone", priority: 3 },
  { url: "/build/genesis", seoImpressions: 980, aiCrawls: 18, quadrant: "deadZone", priority: 3 },
  { url: "/hyundai-mobility", seoImpressions: 750, aiCrawls: 220, quadrant: "seoGap", priority: 2 },
];

export const SAMPLE_VISIBILITY_QUADRANT_COUNTS = {
  star: 3,
  seoGap: 2,
  aiGap: 2,
  deadZone: 2,
} as const;

// ─── ② ACR (Q2=Top1 + Top5 동시) ───────────────────────────────

export type AcrBrandRow = {
  brand: string;
  isOurs: boolean;
  top1Acr: number; // %
  top5Acr: number; // %
  answerCount: number;
  rank1Count: number;
};

export const SAMPLE_ACR_BRANDS: AcrBrandRow[] = [
  { brand: "Hyundai",  isOurs: true,  top1Acr: 23.4, top5Acr: 58.2, answerCount: 1240, rank1Count: 290 },
  { brand: "Toyota",   isOurs: false, top1Acr: 31.1, top5Acr: 71.0, answerCount: 1240, rank1Count: 386 },
  { brand: "Tesla",    isOurs: false, top1Acr: 18.6, top5Acr: 52.4, answerCount: 1240, rank1Count: 231 },
  { brand: "Honda",    isOurs: false, top1Acr: 12.2, top5Acr: 44.8, answerCount: 1240, rank1Count: 151 },
  { brand: "BMW",      isOurs: false, top1Acr:  9.4, top5Acr: 38.1, answerCount: 1240, rank1Count: 117 },
  { brand: "Kia",      isOurs: true,  top1Acr:  5.3, top5Acr: 33.7, answerCount: 1240, rank1Count:  66 },
];

export type AcrTrendPoint = {
  date: string;
  Hyundai: number;
  Toyota: number;
  Tesla: number;
};

export const SAMPLE_ACR_TREND: AcrTrendPoint[] = [
  { date: "2026-04-W1", Hyundai: 19.8, Toyota: 32.1, Tesla: 16.2 },
  { date: "2026-04-W2", Hyundai: 20.4, Toyota: 31.8, Tesla: 17.0 },
  { date: "2026-04-W3", Hyundai: 21.1, Toyota: 31.5, Tesla: 17.8 },
  { date: "2026-04-W4", Hyundai: 22.0, Toyota: 31.4, Tesla: 18.5 },
  { date: "2026-05-W1", Hyundai: 22.6, Toyota: 31.2, Tesla: 18.9 },
  { date: "2026-05-W2", Hyundai: 23.0, Toyota: 31.0, Tesla: 18.7 },
  { date: "2026-05-W3", Hyundai: 23.2, Toyota: 31.2, Tesla: 18.6 },
  { date: "2026-05-W4", Hyundai: 23.4, Toyota: 31.1, Tesla: 18.6 },
];

// Battle grid — 프롬프트 × 모델 cell에 우승 브랜드 표시
export type BattleCell = {
  prompt: string;
  model: string;
  winner: string; // brand name
};

export const SAMPLE_ACR_BATTLE: BattleCell[] = [
  { prompt: "가족용 SUV 추천", model: "ChatGPT",    winner: "Toyota" },
  { prompt: "가족용 SUV 추천", model: "Claude",     winner: "Hyundai" },
  { prompt: "가족용 SUV 추천", model: "Gemini",     winner: "Toyota" },
  { prompt: "가족용 SUV 추천", model: "Perplexity", winner: "Hyundai" },
  { prompt: "전기 SUV 추천",   model: "ChatGPT",    winner: "Tesla" },
  { prompt: "전기 SUV 추천",   model: "Claude",     winner: "Tesla" },
  { prompt: "전기 SUV 추천",   model: "Gemini",     winner: "Hyundai" },
  { prompt: "전기 SUV 추천",   model: "Perplexity", winner: "Hyundai" },
  { prompt: "고급 세단 추천",   model: "ChatGPT",    winner: "BMW" },
  { prompt: "고급 세단 추천",   model: "Claude",     winner: "Genesis" },
  { prompt: "고급 세단 추천",   model: "Gemini",     winner: "BMW" },
  { prompt: "고급 세단 추천",   model: "Perplexity", winner: "Genesis" },
];

// Model conversion — (브랜드 × 차종)별 shortlist→top1 전환율 Top N.
// answer.com ACR 이식: conversionRate = top1Count / shortlistCount.
// 후보(shortlist)로 등장했을 때 실제 1위로 선택될 확률을 차종 단위로 본다.
export type ModelConversionRow = {
  brand: string;
  model: string; // 차종 (AI 모델이 아니라 자동차 모델)
  isOurs: boolean;
  conversionRate: number; // % = top1Count / shortlistCount * 100
  shortlistCount: number; // 후보로 등장한 run 수
  top1Count: number; // 1위로 선택된 횟수
};

export const SAMPLE_ACR_MODEL_CONVERSION: ModelConversionRow[] = [
  { brand: "Toyota",  model: "RAV4",     isOurs: false, conversionRate: 62.5, shortlistCount: 240, top1Count: 150 },
  { brand: "Toyota",  model: "Camry",    isOurs: false, conversionRate: 57.5, shortlistCount: 160, top1Count:  92 },
  { brand: "Tesla",   model: "Model Y",  isOurs: false, conversionRate: 54.5, shortlistCount: 220, top1Count: 120 },
  { brand: "Hyundai", model: "Palisade", isOurs: true,  conversionRate: 48.9, shortlistCount: 180, top1Count:  88 },
  { brand: "Tesla",   model: "Model 3",  isOurs: false, conversionRate: 46.7, shortlistCount: 150, top1Count:  70 },
  { brand: "Hyundai", model: "Ioniq 5",  isOurs: true,  conversionRate: 45.7, shortlistCount: 210, top1Count:  96 },
  { brand: "Genesis", model: "GV80",     isOurs: true,  conversionRate: 41.7, shortlistCount:  96, top1Count:  40 },
  { brand: "Kia",     model: "EV9",      isOurs: true,  conversionRate: 40.8, shortlistCount: 142, top1Count:  58 },
  { brand: "Honda",   model: "CR-V",     isOurs: false, conversionRate: 40.0, shortlistCount: 130, top1Count:  52 },
  { brand: "Hyundai", model: "Tucson",   isOurs: true,  conversionRate: 36.7, shortlistCount: 120, top1Count:  44 },
  { brand: "BMW",     model: "X5",       isOurs: false, conversionRate: 34.5, shortlistCount: 110, top1Count:  38 },
  { brand: "Kia",     model: "Sportage", isOurs: true,  conversionRate: 34.3, shortlistCount: 105, top1Count:  36 },
];

// Territory map (battle grid 풀버전) — answer.com 이식.
// 한 sheet = (언어 × AI모델) 한 조합. 행 = 프롬프트, 열 = 10회 반복.
// 셀 = 그 반복에서 1위로 추천된 브랜드(null = NoChoice). 승자 독식 맵.
export type GridBrand = string | null;
export type BattleSheet = {
  id: string;
  lang: "KO" | "EN";
  model: string;
  prompts: string[];
  cells: GridBrand[][]; // [promptIdx][iter], 길이 10
};

// 셀 색 — HMG 3형제는 BI 토큰 계열, 경쟁사는 식별색. (mockup: 로컬 색맵 컨벤션)
// 라이브 ACR 추이에서 BATTLE_BRAND_COLORS에 없는 브랜드용 순환 팔레트
// (컴포넌트 hex 금지 규칙 때문에 데이터 파일에 둠 — BATTLE_BRAND_COLORS와 동일).
export const ACR_SERIES_FALLBACK = [
  "#4a6685",
  "#8a8f98",
  "#a36b4f",
  "#6b89b3",
  "#c4c9d4",
] as const;

export const BATTLE_BRAND_COLORS: Record<string, string> = {
  Hyundai: "#002c5f",
  Kia: "#a36b4f",
  Genesis: "#6b89b3",
  Toyota: "#e63312",
  Tesla: "#00aad2",
  BMW: "#1a4d8e",
  Honda: "#8a8f98",
};

const BATTLE_PROMPTS_KO = [
  "가족용 SUV 추천",
  "전기 SUV 추천",
  "고급 세단 추천",
  "가성비 전기차",
  "장거리 EV 추천",
  "첫차로 좋은 차",
  "7인승 패밀리카",
  "하이브리드 SUV",
];
const BATTLE_PROMPTS_EN = [
  "Best family SUV",
  "Top electric SUV",
  "Luxury sedan pick",
  "Value EV",
  "Long-range EV",
  "Good first car",
  "7-seat family car",
  "Best hybrid SUV",
];

// 가중 분포 — Toyota 우세, HMG 3형제 존재, 일부 NoChoice. (데모 수치)
const BATTLE_WEIGHTS: [GridBrand, number][] = [
  ["Toyota", 26],
  ["Hyundai", 18],
  ["Tesla", 16],
  ["Kia", 12],
  ["BMW", 9],
  ["Genesis", 7],
  ["Honda", 7],
  [null, 5],
];

// 결정론적 PRNG(mulberry32) — Math.random 미사용으로 SSR/CSR 동일 출력 보장.
function mulberry32(seed: number): () => number {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickBrand(r: number): GridBrand {
  const total = BATTLE_WEIGHTS.reduce((s, [, w]) => s + w, 0);
  let x = r * total;
  for (const [brand, w] of BATTLE_WEIGHTS) {
    x -= w;
    if (x <= 0) return brand;
  }
  return null;
}

function buildSheet(
  id: string,
  lang: "KO" | "EN",
  model: string,
  prompts: string[],
  seedBase: number,
): BattleSheet {
  const cells = prompts.map((_, p) => {
    const rnd = mulberry32(seedBase * 1000 + p * 37);
    return Array.from({ length: 10 }, () => pickBrand(rnd()));
  });
  return { id, lang, model, prompts, cells };
}

export const SAMPLE_ACR_BATTLE_SHEETS: BattleSheet[] = [
  buildSheet("ko-chatgpt", "KO", "ChatGPT", BATTLE_PROMPTS_KO, 11),
  buildSheet("ko-gemini", "KO", "Gemini", BATTLE_PROMPTS_KO, 23),
  buildSheet("en-chatgpt", "EN", "ChatGPT", BATTLE_PROMPTS_EN, 31),
  buildSheet("en-gemini", "EN", "Gemini", BATTLE_PROMPTS_EN, 43),
];

// ─── ③ Conversion (Q3=same-page baseline) ────────────────────

export type ConversionPageRow = {
  url: string;
  aiUsers: number;
  humanUsers: number;
  aiConvRate: number; // %
  humanConvRate: number; // %
  lift: number; // aiConvRate - humanConvRate (pp)
};

export const SAMPLE_CONVERSION_PAGES: ConversionPageRow[] = [
  { url: "/ioniq-5",        aiUsers: 1040, humanUsers: 12_300, aiConvRate: 4.8, humanConvRate: 2.6, lift:  2.2 },
  { url: "/genesis-gv80",   aiUsers:  740, humanUsers:  8_150, aiConvRate: 5.4, humanConvRate: 3.1, lift:  2.3 },
  { url: "/palisade",       aiUsers:  520, humanUsers:  6_050, aiConvRate: 3.9, humanConvRate: 2.7, lift:  1.2 },
  { url: "/dealers/locator",aiUsers:  360, humanUsers: 16_600, aiConvRate: 1.2, humanConvRate: 4.8, lift: -3.6 },
  { url: "/build/genesis",  aiUsers:  260, humanUsers:  5_770, aiConvRate: 6.1, humanConvRate: 5.4, lift:  0.7 },
];

export const SAMPLE_CONVERSION_SUMMARY = {
  aiConvRate: 4.3,
  humanConvRate: 3.2,
  lift: 1.1, // pp
  aiUsersTotal: 2920,
  humanUsersTotal: 48_870,
};

export type ConversionTrendPoint = {
  date: string;
  ai: number; // %
  human: number; // %
};

export const SAMPLE_CONVERSION_TREND: ConversionTrendPoint[] = [
  { date: "2026-04-W1", ai: 3.8, human: 3.0 },
  { date: "2026-04-W2", ai: 4.0, human: 3.1 },
  { date: "2026-04-W3", ai: 4.1, human: 3.1 },
  { date: "2026-04-W4", ai: 4.2, human: 3.2 },
  { date: "2026-05-W1", ai: 4.3, human: 3.2 },
  { date: "2026-05-W2", ai: 4.4, human: 3.3 },
  { date: "2026-05-W3", ai: 4.3, human: 3.2 },
  { date: "2026-05-W4", ai: 4.3, human: 3.2 },
];

export type EngineBreakdownRow = {
  engine: string; // "chatgpt" | "gemini"
  users: number;
  keyEvents: number;
  convRate: number; // %
};

// chatgpt carries almost all of the AI cohort's volume; gemini's low n is the
// demo stand-in for the low-sample badge (mirrors the live Kia/IT property).
export const SAMPLE_ENGINE_BREAKDOWN: EngineBreakdownRow[] = [
  { engine: "chatgpt", users: 2_640, keyEvents: 128, convRate: 4.8 },
  { engine: "gemini", users: 280, keyEvents: 9, convRate: 3.2 },
];
