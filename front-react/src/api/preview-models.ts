import type { RnCitationVm } from "@/app/[locale]/(renewal)/renewal/standard/answer-analysis/citation/_components/citation-input";
import type { CitationsLive } from "@/lib/scope/result-adapter";
import type { RnAcrView } from "@/app/[locale]/(renewal)/renewal/standard/ai-funnel/acr/_data/screen-types";

// Empty presentation models: arrays contain no records and metric values stay null.
const share = { value: null, delta: { value: null, basis: null, date: null }, spark: [], sparkOn: false } as const;
export const emptyCitations: CitationsLive = { summary: { total: 0, uniqueDomains: 0 }, asOf: null, domains: [], categories: null, trend: null, categoryTrend: null, engineCategories: null };
export const emptyCitationVm: RnCitationVm = {
  rows: [], lens: { hmg: { ...share, spark: [] }, dealer: { ...share, spark: [] }, split: { kind: "notComputed" } }, hmgRank: 0, maxPct: 1, cap: 0.5, trendOn: false, findings: [],
  engineMatrix: { status: "pending", m: null }, typeMatrix: { status: "pending", m: null }, oneSource: false, bump: null,
  table: { rows: [], views: {}, categories: [] },
};
export const emptyAcrView: RnAcrView = {
  own: null, ownBrands: [], multiOwn: false, brands: [], boardOrders: { choiceShare: [], coverage: [], d: [], choiceCount: [], appearanceCount: [], brand: [] }, ownTop1Bar: null,
  dates: [], ownTrend: null, ownDelta: null, rivals: [], defaultCompare: [], showDelta: false, k: null, rank: null, leader: null, gap: null, standingN: null,
  engines: [], engineWins: [], sweeps: [], battle: { rows: [], views: { all: [], notown: [], split: [] }, hidden: { all: 0, notown: 0, split: 0 }, visible: 0, count: 0, total: 1 },
  models: { rows: [], orders: { conversionRate: [], shortlistCount: [], top1Count: [], brand: [], model: [] } }, sheets: [], sheet: null, distVisible: 0,
  conversion: { engines: [], views: { all: { n: 0, counts: { pick: 0, listed: 0, absent: 0 }, shares: { pick: null, listed: null, absent: null }, rows: [], orders: { listed: [], share: [] } } }, visible: 0 }, duels: null,
};
