// View model of the renewal AI Conversion page: screens conversion/renewal-header and conversion/renewal
// (back/bff/screens/conversion.py). Every number is computed there from the analytics reader's answer (GA4); the
// page only formats and draws it. A null is a value the reader does not have — never a zero.

import type { RnDaysChoice, RnDaysPeriodRead } from "@/app/[locale]/(renewal)/renewal/_components/days-period";

export type ConvState = "ok" | "noprop" | "pending" | "nomatch" | "empty" | "down";
export type ConvStatus = "active" | "pending_grant" | "unmapped";

export interface ConvTotals {
  aiSessions: number | null;
  aiUsers: number | null;
  aiConv: number | null;
  aiRate: number | null;
  genSessions: number | null;
  genUsers: number | null;
  genConv: number | null;
  genRate: number | null;
  /** AI sessions ÷ all sessions × 100 */
  share: number | null;
  pageViews: number | null;
  /** every session of the site (GA4 totals) */
  siteSessions: number | null;
  /** AI − 일반 전환율, pp */
  lift: number | null;
  /** AI sessions per AI user */
  perUser: number | null;
  /** AI conversions per 100 AI sessions */
  per100: number | null;
  /** general conversions per 100 general sessions */
  genPer100: number | null;
  // vs the previous period of the same length (present when view.prevOk): counts in %, rates in pp
  dAiSessions?: number | null;
  dAiConv?: number | null;
  dAiRate?: number | null;
  dGenRate?: number | null;
  dLift?: number | null;
  dShare?: number | null;
  dSite?: number | null;
  dPageViews?: number | null;
}

export interface ConvEngine {
  engine: string;
  sessions: number | null;
  share: number | null;
  conv: number | null;
  convShare: number | null;
  /** conversions per 100 sessions */
  per100: number | null;
  /** page views per session */
  pps: number | null;
  d: number | null;
}

export interface ConvPage {
  id: number;
  url: string;
  path: string;
  sessions: number | null;
  share: number | null;
  /** running share down the table */
  cum: number | null;
  /** landing page views of every cohort */
  views: number | null;
  prev: number | null;
  d: number | null;
  /** the same page's general sessions (null: GA4 sent no general row for it) */
  genSessions: number | null;
  /** AI sessions ÷ (AI + general sessions) of the page */
  aiOfPage: number | null;
  /** GA4 주요 이벤트 of the AI · general sessions and per 100 sessions */
  aiKe: number | null;
  aiKe100: number | null;
  genKe: number | null;
  genKe100: number | null;
}

export interface ConvProp {
  id: string;
  country: string | null;
  brand: string | null;
  status: ConvStatus;
  /** 1 = GA4 주요 이벤트, 2 = 지정 전환 이벤트 */
  basis: 1 | 2;
  sessions: number | null;
  users: number | null;
  share: number | null;
  d: number | null;
  conv: number | null;
  /** AI conversions ÷ the property's AI users × 100 */
  rate: number | null;
  genSessions: number | null;
  genConv: number | null;
  genRate: number | null;
  /** rate − genRate, pp */
  lift: number | null;
}

export interface ConvEvent {
  event: string;
  count: number | null;
  tracked: boolean;
  /** share of the tracked events' counts (tracked events only) */
  share: number | null;
  aiCount: number | null;
  genCount: number | null;
  /** AI count ÷ (AI + general count) */
  aiShare: number | null;
}

/** A GA4 default channel group; conversions are GA4 주요 이벤트 (key events) here for every property. */
export interface ConvChannel {
  channel: string;
  ai: boolean;
  sessions: number | null;
  share: number | null;
  keyEvents: number | null;
  /** key events per 100 sessions */
  per100: number | null;
  /** page views per session */
  pps: number | null;
  d: number | null;
}

export interface ConvChannels {
  rows: ConvChannel[];
  /** the channels' own total */
  site: { sessions: number | null; keyEvents: number | null; per100: number | null; pps: number | null };
  /** the AI channel's competition ranks (1 = largest) among `n` channels; null without an AI row */
  aiRank: { sessions: number | null; per100: number | null; pps: number | null; n: number } | null;
  /** "engine" = no rows because an engine is picked (report 1 has no engine) */
  reason?: string | null;
}

/** One device or new/returning value: AI and general sessions, their mix shares and conversions per 100 sessions. */
export interface ConvSegment {
  value: string;
  aiSessions: number | null;
  aiShare: number | null;
  genSessions: number | null;
  genShare: number | null;
  /** aiShare − genShare, pp */
  mixGap: number | null;
  aiConv: number | null;
  aiPer100: number | null;
  genConv: number | null;
  genPer100: number | null;
}

/** ΔC = volume + rate exactly; the session change = Σ engines + rest. */
export interface ConvDecomp {
  prevConv: number;
  conv: number;
  d: number;
  volume: number;
  rate: number;
  prevSessions: number;
  sessions: number;
  dSessions: number;
  prevPer100: number;
  per100: number | null;
  engines: { engine: string; d: number }[];
  rest: number;
}

/** A period-user window as the reader sent it (the original screen's 기간 사용자 측정값). */
export interface ConvWindow {
  end: string;
  days: number;
  id: string | null;
  country: string | null;
  brand: string | null;
  cohort: string;
  page: string | null;
  users: number | null;
  /** no engine · device · visitor mask */
  all: boolean;
}

export type ConvFinding =
  | { code: "lift"; tone: "good" | "warn" | "info"; ai: number; gen: number; lift: number }
  | { code: "coverage"; tone: "warn"; active: number; total: number }
  | { code: "change"; tone: "good" | "warn" | "info"; sessions: number; conv: number | null; dConv?: number; volume?: number; rate?: number }
  | { code: "channel"; tone: "info"; rank: number; n: number; share: number | null; per100: number | null; per100Rank: number | null; site: number | null }
  | { code: "samePage"; tone: "info"; page: number; ai: number; gen: number }
  | { code: "device"; tone: "info"; device: string; ai: number; gen: number }
  | { code: "engine"; tone: "info"; engine: string; share: number | null; per100: number | null; best: string; bestPer100: number | null }
  | { code: "pages"; tone: "info"; n: number; share: number; page: number }
  | { code: "share"; tone: "info"; share: number; d: number | null };

export interface ConvView {
  days: string[];
  observed: number;
  blocks: [string, string][];
  prevOk: boolean;
  /** an engine · device · visitor filter is on: the reader has no exact period users, so no rates */
  filtered: boolean;
  totals: ConvTotals;
  spark: { sessions: (number | null)[]; conv: (number | null)[] };
  /** per day of `days`: AI, general and site columns, and the day's rates and AI share */
  trend: {
    sessions: (number | null)[];
    conv: (number | null)[];
    users: (number | null)[];
    rate: (number | null)[];
    site: (number | null)[];
    genSessions: (number | null)[];
    genConv: (number | null)[];
    genUsers: (number | null)[];
    genRate: (number | null)[];
    share: (number | null)[];
  };
  engines: ConvEngine[];
  /** AI sessions without an engine (not in `engines`) */
  engineRest: number | null;
  pages: ConvPage[];
  props: ConvProp[];
  coverage: { total: number; active: number; pending_grant: number; unmapped: number };
  multiBrand: boolean;
  events: ConvEvent[];
  /** sum of the tracked events' counts */
  tracked: number | null;
  findings: ConvFinding[];
  channels: ConvChannels;
  segments: { device: ConvSegment[]; visitorType: ConvSegment[] };
  /** null without the previous period */
  decomp: ConvDecomp | null;
  windows: ConvWindow[];
}

export interface RnConvBody {
  state: ConvState;
  choice: RnDaysChoice;
  period: RnDaysPeriodRead;
  properties: { id: string; country: string | null; brand: string | null; status: ConvStatus }[];
  prev?: { from: string; to: string } | null;
  view: ConvView | null;
}

export interface RnConvScreen {
  props: { stage: "conversion"; geographyOptions?: string[] };
  body: RnConvBody;
}
