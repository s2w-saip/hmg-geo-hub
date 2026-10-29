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
  /** AI − 일반 전환율, pp */
  lift: number | null;
  /** AI sessions per AI user */
  perUser: number | null;
  /** AI conversions per 100 AI sessions */
  per100: number | null;
  // vs the previous period of the same length (present when view.prevOk): counts in %, rates in pp
  dAiSessions?: number | null;
  dAiConv?: number | null;
  dAiRate?: number | null;
  dGenRate?: number | null;
  dLift?: number | null;
  dShare?: number | null;
}

export interface ConvEngine {
  engine: string;
  sessions: number | null;
  share: number | null;
  conv: number | null;
  convShare: number | null;
  /** conversions per 100 sessions */
  per100: number | null;
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
}

export interface ConvEvent {
  event: string;
  count: number | null;
  tracked: boolean;
  /** share of the tracked events' counts (tracked events only) */
  share: number | null;
}

export type ConvFinding =
  | { code: "sample"; tone: "warn"; users: number; min: number }
  | { code: "lift"; tone: "good" | "warn" | "info"; ai: number; gen: number; lift: number }
  | { code: "coverage"; tone: "warn"; active: number; total: number }
  | { code: "change"; tone: "good" | "warn" | "info"; sessions: number; conv: number | null }
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
  lowSample: number;
  totals: ConvTotals;
  spark: { sessions: (number | null)[]; conv: (number | null)[] };
  /** per day of `days` */
  trend: { sessions: (number | null)[]; conv: (number | null)[]; users: (number | null)[]; rate: (number | null)[] };
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
