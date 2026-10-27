// View model of the renewal AI Visibility page: screens visibility/renewal-header and
// visibility/renewal (back/bff/screens/visibility.py). Every number is computed there from the
// analytics reader's rows; the page only formats and draws it. Row ids index into `view.rows`.

export type VisState = "ok" | "nosite" | "nomatch" | "empty" | "down";
export type VisBand = "none" | "low" | "mid" | "high";
export type VisQuad = "seo_only" | "crawl_only" | "both" | "neither";
export type VisTab = "sum" | "page" | "engine" | "site";

/** The period the URL asks for: a preset (7 · 28 · 90 days) or a custom from / to. */
export interface VisChoice {
  preset: number | null;
  days: number | null;
  from: string | null;
  to: string | null;
}

export interface VisRow {
  id: number;
  url: string | null;
  title: string | null;
  path: string;
  section: string;
  brand: string | null;
  country: string | null;
  prio: number | null;
  seo: number | null;
  ai: number | null;
  exp: number | null;
  ach: number | null;
  short: number | null;
  band: VisBand | null;
  int: number | null;
  read: number | null;
  ago: number | null;
  q: VisQuad | null;
  d: number | null;
  prevAi: number | null;
  /** AI 크롤 per engine, in `view.engines` order. */
  eng: number[];
}

export interface VisTotals {
  seo: number | null;
  ai: number | null;
  pages: number;
  complete: number;
  incomplete: number;
  sites: number;
  days: number;
  observed: number;
  p1: number;
  int: number | null;
  cov: number | null;
  cov1: number | null;
  stale1: number;
  top10: number | null;
  topN: number;
  gini: number | null;
  dAi?: number | null;
  dSeo?: number | null;
  dInt?: number | null;
  dCov1?: number | null;
}

export interface VisEngine {
  engine: string;
  on: boolean;
  hits: number;
  share: number | null;
  cov: number | null;
  cov1: number | null;
  d: number | null;
  spark: number[];
  bots: { code: string; hits: number; share: number | null }[];
}

export interface VisSection {
  sec: string;
  pages: number;
  seo: number;
  ai: number;
  seoShare: number | null;
  aiShare: number | null;
  gap: number;
  cov: number | null;
  int: number | null;
  /** coverage per engine, in `view.engines` order */
  engCov: (number | null)[];
}

export interface VisTier {
  prio: number | null;
  pages: number;
  pageShare: number | null;
  seoShare: number | null;
  aiShare: number | null;
  /** pages per 읽힌 날 bucket: daily · often · rare · none */
  freq: [number, number, number, number];
}

export type VisHeatKey = "ai" | "d" | "int" | "top10" | "short" | "cov1" | "read";

export interface VisSite {
  key: number;
  brand: string | null;
  country: string | null;
  pages: number;
  seo: number;
  ai: number;
  d: number | null;
  int: number | null;
  cov1: number | null;
  read: number | null;
  top10: number | null;
  short: number;
  stale1: number;
  /** 0–4 per column; `ai` is volume (no judgement), the others good (4) ↔ bad (0) */
  heat: Record<VisHeatKey, number | null>;
}

export type VisFinding =
  | { code: "stale"; tone: "warn"; n: number; rows: number[]; days: number }
  | { code: "section"; tone: "warn"; sec: string; seoShare: number | null; aiShare: number | null; int: number | null; totalInt: number | null; cov: number | null }
  | { code: "shortfall"; tone: "warn"; n: number; sum: number; row: number }
  | { code: "engineCoverage"; tone: "info"; low: string; lowCov: number; lowCov1: number | null; high: string; highCov: number; highCov1: number | null }
  | { code: "change"; tone: "warn" | "good"; dAi: number; fresh: number; lost: number }
  | { code: "concentration"; tone: "info"; top10: number; topN: number; gini: number | null };

export type VisOrderKey = "prio" | "seo" | "ai" | "short" | "int" | "read" | "ago";

export interface VisView {
  days: string[];
  observed: number;
  /** 7-day blocks [first day, last day], counted back from the period's last day */
  blocks: [string, string][];
  prevOk: boolean;
  staleDays: number;
  /** AI 크롤 per 10,000 검색 노출 of the selection = the 기대 baseline */
  expectedRate: number | null;
  totals: VisTotals;
  spark: { ai: number[]; int: (number | null)[]; cov1: (number | null)[]; stale1: number[] };
  trend: { seo: number[]; ai: number[]; engines: number[][] };
  engines: VisEngine[];
  /** per block: each engine's share (%), in `engines` order */
  engineShare: number[][];
  combos: { set: string[]; n: number; share: number | null }[];
  sections: VisSection[];
  tiers: VisTier[];
  lorenz: { points: [number, number][]; top1: number | null; top10: number | null; top50: number | null };
  devices: { device: string; imp: number; share: number | null; on: boolean }[];
  sites: VisSite[];
  multiBrand: boolean;
  rows: VisRow[];
  orders: Record<VisOrderKey, { asc: number[]; desc: number[] }>;
  /** rows below half of the baseline (or never read) by 부족분: priority 1 · 2 only, or every priority */
  work: { p12: number[]; all: number[] };
  bands: { band: VisBand; n: number; p1: number; seoShare: number | null; aiShare: number | null }[];
  changes: { fresh: number[]; lost: number[]; up: number[]; down: number[] } | null;
  quads: { q: VisQuad; n: number }[];
  findings: VisFinding[];
}

export interface RnVisBody {
  state: VisState;
  choice: VisChoice;
  period: { from: string | null; to: string | null; days: number | null };
  sites: number;
  prev?: { from: string; to: string } | null;
  view: VisView | null;
}

export interface RnVisScreen {
  props: { stage: "visibility"; geographyOptions?: string[] };
  body: RnVisBody;
}
