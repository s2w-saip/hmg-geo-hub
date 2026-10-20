import "server-only";
import { unstable_cache } from "next/cache";
import { splitFilterValues } from "@/components/dash/filter-encoding";
import { CONVERSION_PERIODS, DEFAULT_CONVERSION_DAYS } from "./conversion-window";
import { runReport, AI_CHANNEL_GROUP, isoToGa4, dateNDaysAgo } from "./client";
import { ga4TrackedEventRepository } from "@/lib/db/repositories/ga4-tracked-events";

// 24h TTL — dev 단계 기본값. GA4 data updates ~1h이지만 개발 검증 단계에선
// freshness보다 API 호출 절감이 우선. prod에선 ~6h로 좁힐 여지 있음.
// 한 곳에서만 조정.
export const GA4_CACHE_TTL_SECONDS = 24 * 60 * 60;
export const GA4_CACHE_TAG = "ga4";

// AI Conversion view-model — built from the GA4 Data API on a single
// property. Product definition agreed 2026-06-12:
//   - "AI 유입" cohort = sessionDefaultChannelGroup == "AI Assistant"
//     (GA4 native AI channel — ChatGPT/Gemini/Perplexity/Copilot/Claude/…)
//   - "전환" = GA4 key events as-is (per-property custom config; on Kia/IT
//     it's 87% configuration_conversion + 12% request_brochure +
//     0.4% test_drive + 0% purchase — surface this mix in tooltip)
//   - Unit = activeUsers (= GA4 UI "사용자"). Session-level would unfairly
//     penalize AI traffic since AI cohorts run sessions/users ≈ 1.20 vs
//     1.52 for the rest of the property (docs §2/§4).
//
// Limit (docs/kia-italy-ga4-claude-context.md §2): the "AI Assistant"
// channel started 2026-06-05 on Kia/IT, so 28d / 90d windows are
// 데이터-누적-중. Tooltip must say so.

// 전환율·격차 null = 그 코호트 세션(분모)이 0 이라 측정값이 없다(API 원천). legacy GA4 경로는 종전대로 숫자(0)를 낸다.
export interface ConversionSummary {
  aiConvRate: number | null; // %
  humanConvRate: number | null; // %
  lift: number | null; // pp
  aiUsersTotal: number; // 분모 (활성사용자)
  humanUsersTotal: number;
  aiKeyEvents: number; // 분자 (key events) — rate = keyEvents ÷ users
  humanKeyEvents: number;
}
export interface ConversionPageRow {
  url: string;
  aiUsers: number;
  humanUsers: number;
  aiConvRate: number | null;
  humanConvRate: number | null;
  lift: number | null;
}
export interface ConversionTrendPoint {
  date: string; // YYYY-MM-DD
  ai: number | null; // % (null = 그날 그 코호트 세션 0)
  human: number | null; // %
}
// Per-engine (AI source) split, ALWAYS across every filterable engine — even
// when an `engine` filter is active — so the view can compare the selected
// engine against the others instead of only ever seeing one bar. users is the
// literal rate denominator (not a proxy) so a low bar directly explains a
// noisy rate next to it (2026-07-03: Kia/IT gemini runs ~1-2 users/day vs
// chatgpt's ~5-12, so its rate swings far more per day for the same reason
// a single day's aggregate can).
export interface EngineBreakdownRow {
  engine: string; // panel canonical token — "chatgpt" | "gemini"
  users: number;
  keyEvents: number;
  convRate: number | null; // % (null = 세션 0)
}

export interface ConversionLive {
  propertyId: string;
  range: { start: string; end: string };
  summary: ConversionSummary;
  trend: ConversionTrendPoint[];
  pages: ConversionPageRow[];
  byEngine: EngineBreakdownRow[];
}

// AI 유입 KPI ⑦ tile shape — value = AI cohort conversion rate; the page's
// HumanRate / Lift is computed downstream from the same call.
export interface AiTrafficConversionKpi {
  propertyId: string;
  aiConvRate: number;
  humanConvRate: number;
  lift: number;
  aiKeyEvents: number; // 분자 — AI 채널 활성사용자의 GA4 key events 수
  aiUsers: number; // 분모 — AI 채널 활성사용자 수
}

// Region / HQ rollup — aggregates N markets into one weighted KPI plus a
// per-country breakdown the UI sorts into Top-N. Coverage (measured vs
// total markets the scope reaches) is the primary number the cards
// surface; the weighted rate is secondary (see settled design notes —
// HQ-level averages alone are misleading because each market's key events
// mix and traffic scale differ).
export interface AiTrafficConversionCountry {
  brand: string;
  country: string; // ISO alpha-2
  aiConvRate: number | null;
  humanConvRate: number | null;
  lift: number | null;
  aiUsers: number;
  humanUsers: number;
  /**
   * 전환 수 원값(반올림 전). 권역 가중 전환율을 이 값의 합으로 낸다 — 반올림된 aiConvRate × aiUsers 로
   * 되살리면 최대 0.1%p 어긋난다. 이 필드 이전의 캐시 행에는 없다(그때는 종전 역산).
   */
  aiKeyEvents?: number;
  humanKeyEvents?: number;
}
export interface AiTrafficConversionRollup {
  aiConvRate: number | null; // 활성사용자 가중 합산
  humanConvRate: number | null;
  lift: number | null;
  measuredMarkets: number; // GA4 호출이 데이터 리턴한 시장 수
  totalMarkets: number; // scope 안에 들어오는 카탈로그 시장 수
  totalAiUsers: number; // 분모
  totalHumanUsers: number;
  totalAiKeyEvents: number; // 분자
  totalHumanKeyEvents: number;
  byCountry: AiTrafficConversionCountry[]; // 측정된 시장만, UI에서 정렬
}

// View-time slicing of the GA4 cohorts. Designed from the 2026-06-23 Kia/IT
// dimension probe (npm run ga4:probe -- --dimensions): only axes with ≥2
// populated values in the AI cohort are wireable.
//   - engine     → sessionSource (chatgpt.com dominates ~86%; gemini/copilot/
//                  perplexity present). Applies to the AI cohort ONLY — the
//                  non-AI baseline isn't sourced from an assistant.
//   - device     → deviceCategory (mobile/desktop). Applies to BOTH cohorts so
//                  human = total − AI stays a like-for-like baseline.
//   - visitorType→ newVsReturning (new/returning). Same: both cohorts.
// Scope axes (promptContext/competitor/brand/depth) have no GA4 mapping and are
// not part of this type.
export interface ConversionFilters {
  engine?: string[];
  device?: string[];
  visitorType?: string[];
}

// engine token (panel canonical) → GA4 sessionSource hostname.
const ENGINE_SOURCE: Record<string, string> = {
  chatgpt: "chatgpt.com",
  gemini: "gemini.google.com",
  copilot: "copilot.com",
  perplexity: "perplexity.ai",
  claude: "claude.ai",
};

// The subset DimensionFilterPanel actually exposes for the conversion stage
// (components/dash/dimension-filter-panel.tsx `engine: ["chatgpt", "gemini"]`)
// — the engine breakdown only ever compares what a user could also filter by.
const PANEL_ENGINES = ["chatgpt", "gemini"] as const;

const AI_CHANNEL_EXPR = {
  filter: {
    fieldName: "sessionDefaultChannelGroup",
    stringFilter: { matchType: "EXACT", value: AI_CHANNEL_GROUP, caseSensitive: false },
  },
};

function inListExpr(fieldName: string, values: string[]) {
  return { filter: { fieldName, inListFilter: { values, caseSensitive: false } } };
}

// device/visitorType — cohort-agnostic attributes, applied to whichever query
// (total or AI). engine is NOT here: it only narrows the AI cohort.
function baseExpressions(f?: ConversionFilters): object[] {
  const exprs: object[] = [];
  if (f?.device?.length) exprs.push(inListExpr("deviceCategory", f.device));
  if (f?.visitorType?.length) exprs.push(inListExpr("newVsReturning", f.visitorType));
  return exprs;
}

// Collapse an expression list into a runReport dimensionFilter: undefined for
// none, the bare filter for one, an andGroup for several.
function toFilter(exprs: object[]): Record<string, unknown> | undefined {
  if (exprs.length === 0) return undefined;
  if (exprs.length === 1) return exprs[0] as Record<string, unknown>;
  return { andGroup: { expressions: exprs } };
}

// AI cohort expression list = AI channel ∧ (engine source) ∧ base attributes.
// Exposed as a list (not a collapsed filter) so callers can append the
// conversion eventName expression before collapsing. Always ≥1 expr.
function aiExprs(f?: ConversionFilters): object[] {
  const exprs: object[] = [AI_CHANNEL_EXPR];
  const sources = (f?.engine ?? []).map((e) => ENGINE_SOURCE[e]).filter(Boolean);
  if (sources.length) exprs.push(inListExpr("sessionSource", sources));
  exprs.push(...baseExpressions(f));
  return exprs;
}

// AI cohort = AI channel ∧ (engine source) ∧ base attributes. Always ≥1 expr.
function aiFilter(f?: ConversionFilters): Record<string, unknown> {
  return toFilter(aiExprs(f))!;
}

// Allowed GA4 values — never let a client-sent param reach a GA4 dimensionFilter
// unvalidated (the values become inListFilter contents). engine is validated
// against ENGINE_SOURCE keys.
const DEVICE_VALUES = new Set(["mobile", "desktop", "tablet"]);
const VISITOR_VALUES = new Set(["new", "returning"]);

// Parse Next server searchParams → a validated ConversionFilters. Unknown values
// are dropped; empty axes omitted. Used by the conversion pages.
export function parseConversionFilters(
  sp: Record<string, string | string[] | undefined>,
): ConversionFilters {
  const pick = (key: string, ok: (v: string) => boolean) =>
    splitFilterValues(sp[key]).filter(ok);
  const f: ConversionFilters = {
    engine: pick("engine", (v) => v in ENGINE_SOURCE),
    device: pick("device", (v) => DEVICE_VALUES.has(v)),
    visitorType: pick("visitorType", (v) => VISITOR_VALUES.has(v)),
  };
  return f;
}

// Allowed measurement windows (days) live in a neutral module so the client
// period selector can import them without pulling in this server-only file.
export function parseConversionPeriod(
  sp: Record<string, string | string[] | undefined>,
): number {
  const raw = Array.isArray(sp.period) ? sp.period[0] : sp.period;
  const n = Number(raw);
  return (CONVERSION_PERIODS as readonly number[]).includes(n)
    ? n
    : DEFAULT_CONVERSION_DAYS;
}

// Stable cache-key fragment for a filter set (sorted, order-independent).
function filterKey(f?: ConversionFilters): string {
  if (!f) return "_";
  const part = (xs?: string[]) => [...(xs ?? [])].sort().join("+");
  return `e:${part(f.engine)};d:${part(f.device)};v:${part(f.visitorType)}`;
}

const pct = (n: number, d: number): number =>
  d > 0 ? Math.round((n / d) * 1000) / 10 : 0;

function num(s: string | number | undefined): number {
  return Number(s ?? 0);
}

// We use (activeUsers, keyEvents) per cohort. keyEvents is an event count
// (a heavy user can fire it multiple times), so the resulting rate is
// "key events per active user" — not a strict % of converting users. That
// matches the PoC analysis (§4) which reports raw activeUsers and keyEvents
// alongside one another. The user-set overlap between AI and non-AI cohorts
// (a person who comes via ChatGPT AND another channel) is small at this
// property's scale (~8 AI users/day) and flagged in the doc — we accept
// that as a known limit rather than fabricating BigQuery-only precision.
const METRICS = [{ name: "activeUsers" }, { name: "keyEvents" }] as const;

interface CohortRow {
  users: number;
  keyEvents: number;
}

// ── Conversion numerator definition (WBS 1.2.x) ─────────────────────────────
//
// A property's "전환" numerator is EITHER the GA4 key events metric (default,
// unchanged) OR the eventCount of an admin-selected eventName set
// (ga4_tracked_events). ConvSpec = the selected names, or null for the key-
// events fallback. Resolved once per property and threaded to every fetch.
export type ConvSpec = string[] | null;

async function resolveConvSpec(propertyId: string): Promise<ConvSpec> {
  // Missing configuration is a valid default; unavailable configuration is not.
  const names = await ga4TrackedEventRepository.listForProperty(propertyId);
  return names.length ? names : null;
}

function eventNameExpr(events: string[]): object {
  return {
    filter: {
      fieldName: "eventName",
      inListFilter: { values: events, caseSensitive: false },
    },
  };
}

const rowKey = (r: { dimensionValues?: { value: string }[] }): string =>
  (r.dimensionValues ?? []).map((d) => d.value).join("|");

// Generic cohort fetch keyed by the row's dimension values ("" when no
// dimension). users always comes from an activeUsers query with only the
// cohort `exprs` (never event-filtered — else the denominator would shrink to
// converters). The conversion count (CohortRow.keyEvents) is:
//   - spec === null : the keyEvents metric from that same query (fallback,
//     byte-identical to the pre-1.2.x behavior — one query, METRICS).
//   - spec (names)  : eventCount from a SECOND query adding eventName∈names to
//     the same cohort filter; users-rows with no matching event row → 0.
async function fetchCohortMap(
  propertyId: string,
  range: { start: string; end: string },
  exprs: object[],
  dims: { name: string }[],
  limit: number | undefined,
  spec: ConvSpec,
): Promise<Map<string, CohortRow>> {
  const baseFilter = toFilter(exprs);
  const usersRep = await runReport(propertyId, {
    dateRanges: [{ startDate: range.start, endDate: range.end }],
    ...(dims.length ? { dimensions: dims } : {}),
    metrics: METRICS as unknown as Record<string, unknown>[],
    ...(baseFilter ? { dimensionFilter: baseFilter } : {}),
    ...(limit ? { limit } : {}),
  });
  const map = new Map<string, CohortRow>();
  for (const r of usersRep.rows ?? []) {
    map.set(rowKey(r), {
      users: num(r.metricValues?.[0].value),
      keyEvents: num(r.metricValues?.[1].value),
    });
  }
  if (spec) {
    const convFilter = toFilter([...exprs, eventNameExpr(spec)]);
    const convRep = await runReport(propertyId, {
      dateRanges: [{ startDate: range.start, endDate: range.end }],
      ...(dims.length ? { dimensions: dims } : {}),
      metrics: [{ name: "eventCount" }] as unknown as Record<string, unknown>[],
      ...(convFilter ? { dimensionFilter: convFilter } : {}),
      ...(limit ? { limit } : {}),
    });
    const conv = new Map<string, number>();
    for (const r of convRep.rows ?? []) conv.set(rowKey(r), num(r.metricValues?.[0].value));
    for (const [key, row] of map) row.keyEvents = conv.get(key) ?? 0;
  }
  return map;
}

const ZERO: CohortRow = { users: 0, keyEvents: 0 };

// Helper: aggregate (cohort) totals for one date range. The total (baseline)
// query carries only the cohort-agnostic filters (device/visitorType) so
// human = total − AI stays like-for-like; the AI query adds channel + engine.
async function fetchCohorts(
  propertyId: string,
  range: { start: string; end: string },
  filters?: ConversionFilters,
  spec: ConvSpec = null,
): Promise<{ ai: CohortRow; total: CohortRow }> {
  const [totalMap, aiMap] = await Promise.all([
    fetchCohortMap(propertyId, range, baseExpressions(filters), [], undefined, spec),
    fetchCohortMap(propertyId, range, aiExprs(filters), [], undefined, spec),
  ]);
  return { total: totalMap.get("") ?? ZERO, ai: aiMap.get("") ?? ZERO };
}

// Daily trend — series of (AI rate, non-AI rate). Two queries (total +
// AI-cohort) keyed on `date`; non-AI = total - AI per day.
async function fetchTrend(
  propertyId: string,
  range: { start: string; end: string },
  filters?: ConversionFilters,
  spec: ConvSpec = null,
): Promise<ConversionTrendPoint[]> {
  const dim = [{ name: "date" }];
  const [totalByDate, aiByDate] = await Promise.all([
    fetchCohortMap(propertyId, range, baseExpressions(filters), dim, 500, spec),
    fetchCohortMap(propertyId, range, aiExprs(filters), dim, 500, spec),
  ]);
  const points: ConversionTrendPoint[] = [];
  for (const [d, tot] of totalByDate) {
    const aiCell = aiByDate.get(d) ?? ZERO;
    const hum: CohortRow = {
      users: Math.max(0, tot.users - aiCell.users),
      keyEvents: Math.max(0, tot.keyEvents - aiCell.keyEvents),
    };
    points.push({
      date: isoToGa4(d),
      ai: pct(aiCell.keyEvents, aiCell.users),
      human: pct(hum.keyEvents, hum.users),
    });
  }
  return points.sort((a, b) => a.date.localeCompare(b.date));
}

// Per-page split — landingPage × (AI cohort vs rest). The total query gives
// us each page's full users/keyEvents; subtract the AI cohort row to get
// the non-AI baseline. ChatGPT users are low-cardinality (a handful of
// landing pages), so we list the top-AI pages and join the totals back.
async function fetchPageSplit(
  propertyId: string,
  range: { start: string; end: string },
  limit = 12,
  filters?: ConversionFilters,
  spec: ConvSpec = null,
): Promise<ConversionPageRow[]> {
  const dim = [{ name: "landingPagePlusQueryString" }];
  const aiByPage = await fetchCohortMap(propertyId, range, aiExprs(filters), dim, limit * 2, spec);
  // Sort by AI users DESC in code (orderBys on landing-page filter +
  // this property = 502 risk per docs/kia-italy-ga4-claude-context.md §3).
  const aiRows = [...aiByPage.entries()]
    .map(([url, c]) => ({ url, aiUsers: c.users, aiKeyEvents: c.keyEvents }))
    .sort((a, b) => b.aiUsers - a.aiUsers)
    .slice(0, limit);
  if (aiRows.length === 0) return [];

  // Baseline per page = page inList ∧ device/visitorType (NOT AI channel/engine).
  const pageExpr = {
    filter: {
      fieldName: "landingPagePlusQueryString",
      inListFilter: { values: aiRows.map((r) => r.url) },
    },
  };
  const totByUrl = await fetchCohortMap(
    propertyId,
    range,
    [pageExpr, ...baseExpressions(filters)],
    dim,
    aiRows.length,
    spec,
  );
  return aiRows
    .map((r) => {
      const tot = totByUrl.get(r.url) ?? ZERO;
      const humanUsers = Math.max(0, tot.users - r.aiUsers);
      const humanKeyEvents = Math.max(0, tot.keyEvents - r.aiKeyEvents);
      const aiConvRate = pct(r.aiKeyEvents, r.aiUsers);
      const humanConvRate = pct(humanKeyEvents, humanUsers);
      return {
        url: r.url,
        aiUsers: r.aiUsers,
        humanUsers,
        aiConvRate,
        humanConvRate,
        lift: Math.round((aiConvRate - humanConvRate) * 10) / 10,
      };
    })
    .filter((row) => row.aiUsers > 0);
}

// Per-engine totals over the whole range — one GA4 report grouped by
// sessionSource (not N per-engine queries). Deliberately ignores any active
// `engine` filter (only device/visitorType narrow it) so every engine the
// panel offers is always comparable side by side.
async function fetchEngineBreakdown(
  propertyId: string,
  range: { start: string; end: string },
  filters?: ConversionFilters,
  spec: ConvSpec = null,
): Promise<EngineBreakdownRow[]> {
  const exprs = [AI_CHANNEL_EXPR, ...baseExpressions(filters)];
  const bySource = await fetchCohortMap(
    propertyId,
    range,
    exprs,
    [{ name: "sessionSource" }],
    50,
    spec,
  );
  return PANEL_ENGINES.map((engine) => {
    const cell = bySource.get(ENGINE_SOURCE[engine]) ?? ZERO;
    return {
      engine,
      users: cell.users,
      keyEvents: cell.keyEvents,
      convRate: pct(cell.keyEvents, cell.users),
    };
  });
}

// Page-level conversion view (for /standard/ai-funnel/conversion).
// External entry point cache-wraps the inner fetch. Cache key = property + days
// so 28d KPI tile and 90d page view share neither cell nor invalidation hot
// path.
//
// Negative-caching policy: inner THROWS on transport/auth failure. The
// outer wrapper catches and returns null to the caller, but the throw
// prevents unstable_cache from saving null. Next request retries fresh.
// A "real" null (property has data but the AI cohort is empty) is a
// normal cached value.
async function getAiConversionLiveInner(
  propertyId: string,
  days = 90,
  filters?: ConversionFilters,
): Promise<ConversionLive | null> {
  const range = dateNDaysAgo(days);
  const spec = await resolveConvSpec(propertyId);
  const [cohorts, trend, pages, byEngine] = await Promise.all([
    fetchCohorts(propertyId, range, filters, spec),
    fetchTrend(propertyId, range, filters, spec),
    fetchPageSplit(propertyId, range, 12, filters, spec),
    fetchEngineBreakdown(propertyId, range, filters, spec),
  ]);
  const aiUsers = cohorts.ai.users;
  const humanUsers = Math.max(0, cohorts.total.users - aiUsers);
  const aiKey = cohorts.ai.keyEvents;
  const humanKey = Math.max(0, cohorts.total.keyEvents - aiKey);
  const aiConvRate = pct(aiKey, aiUsers);
  const humanConvRate = pct(humanKey, humanUsers);
  if (aiUsers === 0 && cohorts.total.users === 0) return null;
  return {
    propertyId,
    range,
    summary: {
      aiConvRate,
      humanConvRate,
      lift: Math.round((aiConvRate - humanConvRate) * 10) / 10,
      aiUsersTotal: aiUsers,
      humanUsersTotal: humanUsers,
      aiKeyEvents: aiKey,
      humanKeyEvents: humanKey,
    },
    trend,
    pages,
    byEngine,
  };
}

export async function getAiConversionLive(
  propertyId: string,
  days = 90,
  filters?: ConversionFilters,
): Promise<ConversionLive | null> {
  try {
    return await unstable_cache(
      () => getAiConversionLiveInner(propertyId, days, filters),
      ["ga4-conv-live-v2", propertyId, String(days), filterKey(filters)],
      { revalidate: GA4_CACHE_TTL_SECONDS, tags: [GA4_CACHE_TAG] },
    )();
  } catch (err) {
    console.warn(
      `[ga4] getAiConversionLive failed for property=${propertyId}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

// Region / HQ rollup — N mapped markets → weighted KPI + per-country table.
// Coverage (measured vs total) is the primary number the cards show; the
// weighted rate is secondary. Unmapped catalog entries count toward
// `totalMarkets` only, so coverage reads "5 / 41" honestly.
//
// markets[] is the resolveProperties() output: every (brand, country) the
// scope reaches with propertyId=null for unmapped entries.
//
// Cache key uses the sorted list of mapped property ids — so kia-eu and a
// hypothetical kia-ce ( both Europe subsets) get distinct cache cells iff
// their measured market sets differ. Unmapped catalog entries don't change
// the GA4 result (only coverage), so omitting them keeps cache hot.
async function getAiTrafficConversionRollupInner(
  markets: { brand: string; country: string; propertyId: string | null }[],
  days = 28,
  filters?: ConversionFilters,
): Promise<AiTrafficConversionRollup | null> {
  const totalMarkets = markets.length;
  if (totalMarkets === 0) return null;
  const mapped = markets.filter(
    (m): m is { brand: string; country: string; propertyId: string } =>
      m.propertyId !== null,
  );
  if (mapped.length === 0) {
    return {
      aiConvRate: 0,
      humanConvRate: 0,
      lift: 0,
      measuredMarkets: 0,
      totalMarkets,
      totalAiUsers: 0,
      totalHumanUsers: 0,
      totalAiKeyEvents: 0,
      totalHumanKeyEvents: 0,
      byCountry: [],
    };
  }
  const range = dateNDaysAgo(days);
  const specByProp = await ga4TrackedEventRepository.listForProperties(mapped.map((m) => m.propertyId));
  const perCountry = await Promise.all(
    mapped.map(async (m) => {
      try {
        const names = specByProp.get(m.propertyId);
        const spec: ConvSpec = names && names.length ? names : null;
        const c = await fetchCohorts(m.propertyId, range, filters, spec);
        return { ...m, cohorts: c };
      } catch (err) {
        console.warn(
          `[ga4] rollup fetch failed for property=${m.propertyId} (${m.brand}/${m.country}):`,
          err instanceof Error ? err.message : err,
        );
        return null;
      }
    }),
  );
  const ok = perCountry.filter(<T>(x: T | null): x is T => x !== null);
  // Only complete reads enter the normal 24-hour cache. The wrapper returns the
  // existing unavailable state outside the cache, so recovery is retried next time.
  if (ok.length !== mapped.length) throw new Error("GA4 rollup incomplete");
  let totalAiUsers = 0;
  let totalHumanUsers = 0;
  let totalAiKey = 0;
  let totalHumanKey = 0;
  const byCountry: AiTrafficConversionCountry[] = [];
  for (const row of ok) {
    const aiUsers = row.cohorts.ai.users;
    const humanUsers = Math.max(0, row.cohorts.total.users - aiUsers);
    const aiKey = row.cohorts.ai.keyEvents;
    const humanKey = Math.max(0, row.cohorts.total.keyEvents - aiKey);
    totalAiUsers += aiUsers;
    totalHumanUsers += humanUsers;
    totalAiKey += aiKey;
    totalHumanKey += humanKey;
    if (aiUsers === 0 && humanUsers === 0) continue;
    const aiConvRate = pct(aiKey, aiUsers);
    const humanConvRate = pct(humanKey, humanUsers);
    byCountry.push({
      brand: row.brand,
      country: row.country,
      aiConvRate,
      humanConvRate,
      lift: Math.round((aiConvRate - humanConvRate) * 10) / 10,
      aiUsers,
      humanUsers,
      aiKeyEvents: aiKey,
      humanKeyEvents: humanKey,
    });
  }
  const aiConvRate = pct(totalAiKey, totalAiUsers);
  const humanConvRate = pct(totalHumanKey, totalHumanUsers);
  return {
    aiConvRate,
    humanConvRate,
    lift: Math.round((aiConvRate - humanConvRate) * 10) / 10,
    measuredMarkets: byCountry.length,
    totalMarkets,
    totalAiUsers,
    totalHumanUsers,
    totalAiKeyEvents: totalAiKey,
    totalHumanKeyEvents: totalHumanKey,
    byCountry,
  };
}

export async function getAiTrafficConversionRollup(
  markets: { brand: string; country: string; propertyId: string | null }[],
  days = 28,
  filters?: ConversionFilters,
): Promise<AiTrafficConversionRollup | null> {
  if (markets.length === 0) return null;
  const mappedKey = JSON.stringify(markets.map((m) => [m.brand, m.country, m.propertyId]));
  try {
    return await unstable_cache(
      () => getAiTrafficConversionRollupInner(markets, days, filters),
      ["ga4-rollup-v2", mappedKey, String(days), filterKey(filters)],
      { revalidate: GA4_CACHE_TTL_SECONDS, tags: [GA4_CACHE_TAG] },
    )();
  } catch (err) {
    console.warn("[ga4] rollup unavailable:", err instanceof Error ? err.message : err);
    return null;
  }
}

// Dashboard KPI ⑦ — same call surface, but only the headline numbers. 28d
// keeps the tile fast and avoids the 502-risky prior-year range.
// Inner throws on transport/auth failure (same negative-caching policy as
// getAiConversionLive); the wrapper catches and returns null so the tile
// shows "측정 대기" without saving null to unstable_cache.
async function getAiTrafficConversionKpiInner(
  propertyId: string,
  days = 28,
): Promise<AiTrafficConversionKpi | null> {
  const spec = await resolveConvSpec(propertyId);
  const cohorts = await fetchCohorts(propertyId, dateNDaysAgo(days), undefined, spec);
  const aiUsers = cohorts.ai.users;
  const humanUsers = Math.max(0, cohorts.total.users - aiUsers);
  const aiKey = cohorts.ai.keyEvents;
  const humanKey = Math.max(0, cohorts.total.keyEvents - aiKey);
  if (aiUsers === 0) return null;
  const aiConvRate = pct(aiKey, aiUsers);
  const humanConvRate = pct(humanKey, humanUsers);
  return {
    propertyId,
    aiConvRate,
    humanConvRate,
    lift: Math.round((aiConvRate - humanConvRate) * 10) / 10,
    aiKeyEvents: aiKey,
    aiUsers,
  };
}

export async function getAiTrafficConversionKpi(
  propertyId: string,
  days = 28,
): Promise<AiTrafficConversionKpi | null> {
  try {
    return await unstable_cache(
      () => getAiTrafficConversionKpiInner(propertyId, days),
      ["ga4-kpi-v2", propertyId, String(days)],
      { revalidate: GA4_CACHE_TTL_SECONDS, tags: [GA4_CACHE_TAG] },
    )();
  } catch (err) {
    console.warn(
      `[ga4] getAiTrafficConversionKpi failed for property=${propertyId}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

// ── AI 유입 사이트 방문 수 (sub-KPI) ────────────────────────────────────────
//
// Deliberately a DIFFERENT lens than the conversion core KPI: that one is a RATE
// on activeUsers; this is VOLUME on sessions (회). What the core can't show —
// inflow magnitude, repeat-visit frequency (sessions/user), and which landing
// pages AI traffic enters. Definition confirmed 2026-06-25 (docs/
// ga4-conversion-backlog.md). Same AI cohort + filter surface (aiFilter), so
// engine/device/visitorType narrow it identically.
export interface AiVisitsPageRow {
  url: string;
  sessions: number;
  users: number;
}
export interface AiVisitsTrendPoint {
  date: string; // YYYY-MM-DD
  sessions: number;
}
export interface AiVisits {
  propertyId: string;
  range: { start: string; end: string };
  totalSessions: number; // 방문 수 (회) — the headline number
  totalUsers: number; // 순 방문자 (명)
  pageViews: number;
  pages: AiVisitsPageRow[]; // 입구 페이지별, sessions DESC
  trend: AiVisitsTrendPoint[];
}

async function fetchVisitsByPage(
  propertyId: string,
  range: { start: string; end: string },
  filters: ConversionFilters | undefined,
  limit = 15,
): Promise<AiVisitsPageRow[]> {
  const rep = await runReport(propertyId, {
    dateRanges: [{ startDate: range.start, endDate: range.end }],
    dimensions: [{ name: "landingPagePlusQueryString" }],
    metrics: [{ name: "sessions" }, { name: "activeUsers" }],
    dimensionFilter: aiFilter(filters),
    limit: limit * 3,
  });
  // Sort in code (orderBys on landingPage 502s this property — docs §3).
  return (rep.rows ?? [])
    .map((r) => ({
      url: r.dimensionValues?.[0].value ?? "(not set)",
      sessions: num(r.metricValues?.[0].value),
      users: num(r.metricValues?.[1].value),
    }))
    .filter((p) => p.sessions > 0)
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, limit);
}

async function fetchVisitsTrend(
  propertyId: string,
  range: { start: string; end: string },
  filters?: ConversionFilters,
): Promise<AiVisitsTrendPoint[]> {
  const rep = await runReport(propertyId, {
    dateRanges: [{ startDate: range.start, endDate: range.end }],
    dimensions: [{ name: "date" }],
    metrics: [{ name: "sessions" }],
    dimensionFilter: aiFilter(filters),
    limit: 500,
  });
  return (rep.rows ?? [])
    .map((r) => ({
      date: isoToGa4(r.dimensionValues?.[0].value ?? ""),
      sessions: num(r.metricValues?.[0].value),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function getAiVisitsLiveInner(
  propertyId: string,
  days = 90,
  filters?: ConversionFilters,
): Promise<AiVisits | null> {
  const range = dateNDaysAgo(days);
  const [totals, pages, trend] = await Promise.all([
    runReport(propertyId, {
      dateRanges: [{ startDate: range.start, endDate: range.end }],
      metrics: [{ name: "sessions" }, { name: "activeUsers" }, { name: "screenPageViews" }],
      dimensionFilter: aiFilter(filters),
    }),
    fetchVisitsByPage(propertyId, range, filters),
    fetchVisitsTrend(propertyId, range, filters),
  ]);
  const r = totals.rows?.[0];
  const totalSessions = num(r?.metricValues?.[0].value);
  if (totalSessions === 0) return null;
  return {
    propertyId,
    range,
    totalSessions,
    totalUsers: num(r?.metricValues?.[1].value),
    pageViews: num(r?.metricValues?.[2].value),
    pages,
    trend,
  };
}

export async function getAiVisitsLive(
  propertyId: string,
  days = 90,
  filters?: ConversionFilters,
): Promise<AiVisits | null> {
  try {
    return await unstable_cache(
      () => getAiVisitsLiveInner(propertyId, days, filters),
      ["ga4-visits-live", propertyId, String(days), filterKey(filters)],
      { revalidate: GA4_CACHE_TTL_SECONDS, tags: [GA4_CACHE_TAG] },
    )();
  } catch (err) {
    console.warn(
      `[ga4] getAiVisitsLive failed for property=${propertyId}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

// Dashboard sub-KPI variant of the visits metric — headline 방문 수 (sessions)
// + a daily series for the card sparkline. One date-dimensioned query (total =
// Σ trend), so it's cheap enough for the dashboard tile. 28d to match the
// conversion KPI tile's window. No sub-filters (the dashboard card is the AI
// cohort headline, same as getAiTrafficConversionKpi).
export interface AiVisitsKpi {
  propertyId: string;
  sessions: number; // 방문 수 (회) — 28d total
  trend: AiVisitsTrendPoint[]; // 일별 sessions (sparkline)
}

async function getAiVisitsKpiInner(
  propertyId: string,
  days = 28,
): Promise<AiVisitsKpi | null> {
  const trend = await fetchVisitsTrend(propertyId, dateNDaysAgo(days));
  const sessions = trend.reduce((s, p) => s + p.sessions, 0);
  if (sessions === 0) return null;
  return { propertyId, sessions, trend };
}

export async function getAiVisitsKpi(
  propertyId: string,
  days = 28,
): Promise<AiVisitsKpi | null> {
  try {
    return await unstable_cache(
      () => getAiVisitsKpiInner(propertyId, days),
      ["ga4-visits-kpi", propertyId, String(days)],
      { revalidate: GA4_CACHE_TTL_SECONDS, tags: [GA4_CACHE_TAG] },
    )();
  } catch (err) {
    console.warn(
      `[ga4] getAiVisitsKpi failed for property=${propertyId}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
