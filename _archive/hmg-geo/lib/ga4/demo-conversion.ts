// Synthetic AI-traffic conversion data for the always-mock DEMO project.
//
// The real conversion KPI (KPI ⑦) + the AI Agent Funnel > Conversion page read
// GA4 via getAiTrafficConversionKpi / getAiConversionLive / getAiVisitsLive,
// which need a real GA4 property + OAuth. A synthetic capture project has no
// property, so those return null and the widgets show "GA4 미연동". This module
// fabricates coherent, flattering numbers (AI cohort converts better than the
// rest — the product thesis) so the demo's conversion surfaces render populated.
// Wired only for isDemoProject(...) callers; never touches GA4.
import type {
  AiTrafficConversionKpi,
  AiVisits,
  ConversionLive,
  ConversionTrendPoint,
  ConversionPageRow,
  EngineBreakdownRow,
} from "./conversion";

export const DEMO_GA4_PROPERTY_ID = "demo-ga4-property";

// Headline rates — AI ~2x the non-AI baseline (positive lift = good demo).
const AI_RATE = 8.5; // %
const HUMAN_RATE = 4.2; // %
const AI_USERS = 1240;
const HUMAN_USERS = 48200;
const AI_KEY_EVENTS = Math.round((AI_RATE / 100) * AI_USERS); // 105
const HUMAN_KEY_EVENTS = Math.round((HUMAN_RATE / 100) * HUMAN_USERS); // 2024
const round1 = (n: number) => Math.round(n * 10) / 10;

// Deterministic wobble (stable across reseeds — captures don't flicker).
const wobble = (base: number, i: number, spread: number) =>
  round1(base + Math.sin(i * 0.7 + base) * spread);

function ymd(daysAgo: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

function trend(days: number): ConversionTrendPoint[] {
  const out: ConversionTrendPoint[] = [];
  for (let i = 0; i < days; i++) {
    out.push({
      date: ymd(days - 1 - i),
      ai: wobble(AI_RATE, i, 1.3),
      human: wobble(HUMAN_RATE, i, 0.5),
    });
  }
  return out;
}

const PAGES: ConversionPageRow[] = [
  { url: "/kr/ko/e/vehicles/palisade", aiUsers: 386, humanUsers: 14200, aiConvRate: 10.4, humanConvRate: 5.1, lift: 5.3 },
  { url: "/kr/ko/e/vehicles/santafe", aiUsers: 274, humanUsers: 11800, aiConvRate: 9.1, humanConvRate: 4.6, lift: 4.5 },
  { url: "/kr/ko/e/vehicles/tucson", aiUsers: 198, humanUsers: 9300, aiConvRate: 7.8, humanConvRate: 4.0, lift: 3.8 },
  { url: "/kr/ko/e/promotions", aiUsers: 142, humanUsers: 6100, aiConvRate: 8.9, humanConvRate: 3.7, lift: 5.2 },
  { url: "/kr/ko/e/test-drive", aiUsers: 96, humanUsers: 2800, aiConvRate: 12.5, humanConvRate: 6.4, lift: 6.1 },
];

const BY_ENGINE: EngineBreakdownRow[] = [
  { engine: "chatgpt", users: 892, keyEvents: 82, convRate: 9.2 },
  { engine: "gemini", users: 348, keyEvents: 23, convRate: 6.6 },
];

export function demoConversionKpi(): AiTrafficConversionKpi {
  return {
    propertyId: DEMO_GA4_PROPERTY_ID,
    aiConvRate: AI_RATE,
    humanConvRate: HUMAN_RATE,
    lift: round1(AI_RATE - HUMAN_RATE),
    aiKeyEvents: AI_KEY_EVENTS,
    aiUsers: AI_USERS,
  };
}

export function demoConversionLive(days = 28): ConversionLive {
  return {
    propertyId: DEMO_GA4_PROPERTY_ID,
    range: { start: ymd(days - 1), end: ymd(0) },
    summary: {
      aiConvRate: AI_RATE,
      humanConvRate: HUMAN_RATE,
      lift: round1(AI_RATE - HUMAN_RATE),
      aiUsersTotal: AI_USERS,
      humanUsersTotal: HUMAN_USERS,
      aiKeyEvents: AI_KEY_EVENTS,
      humanKeyEvents: HUMAN_KEY_EVENTS,
    },
    trend: trend(days),
    pages: PAGES,
    byEngine: BY_ENGINE,
  };
}

export function demoVisits(days = 90): AiVisits {
  const totalSessions = 1490;
  const totalUsers = AI_USERS;
  return {
    propertyId: DEMO_GA4_PROPERTY_ID,
    range: { start: ymd(days - 1), end: ymd(0) },
    totalSessions,
    totalUsers,
    pageViews: 5230,
    pages: PAGES.map((p) => ({
      url: p.url,
      sessions: Math.round(p.aiUsers * 1.2),
      users: p.aiUsers,
    })),
    trend: Array.from({ length: days }, (_, i) => ({
      date: ymd(days - 1 - i),
      sessions: Math.max(12, Math.round(totalSessions / days + Math.sin(i * 0.6) * 8)),
    })),
  };
}
