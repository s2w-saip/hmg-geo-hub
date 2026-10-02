import type { ScopeClient } from "./client";
import type { TrendGapRow } from "@/lib/viz/trend-gap";
import {
  COLLECTION_ERROR_GAP,
  TREND_GAP_FIELD,
  insertTrendGapSlots,
} from "@/lib/viz/trend-gap";
import { isMockMode } from "./index";
import { isoDaySlice, kstDay, weekStartOf } from "@/lib/period/day-arith";
import { brandPresenceOf } from "./brand-presence";
import {
  trackedBrandNameSetFor,
  trackedEntityIdsFor,
  rollupCanonicalPairs,
  hmgRollupIdByNamePrefix,
  HMG_BRAND_ENTITY_IDS,
} from "./hmg-brands";
import { canonicalBrandDisplayName } from "./brand-display-aliases";
import { pageAll, PROMPT_MAX_PAGES } from "./paging";
import { isNonCompetitorMention } from "./non-competitor-brands";
import { geoEntryForUrl } from "@/lib/geo-catalog";
import { ownedBaseEntryForUrl, ownedBrandOf } from "@/lib/geo-catalog/owned";
import { registrableDomainOfHost } from "@/lib/public-suffix";
import { citationGroupKey } from "@/lib/citation-categorizer/official-social";
import {
  resolveCitationCategory,
  type CitationOverrideMap,
} from "@/lib/citation-categorizer";
import { displayCitationUrl } from "@/lib/url-display";
import type {
  BrandMention,
  Citation,
  MeasurementJob,
  MeasurementRunSummary,
  MentionSentimentBreakdown,
  MentionTypeBreakdown,
  Prompt,
  QueryRunView,
  ResolvedMention,
} from "./types";

// Result adapter — reaggregates scope's REAL measurement surface into generic
// brand/region/citation tallies for the standard (표준) enterprise dashboard.
//
// scope exposes NO named result endpoints (overview/brand-scores/...); the data
// lives in /projects/{id}/measurements/{runId}/jobs (per-job analysis WITH
// region) and /results (citations). This module pulls those and rolls them up.
// It returns SCOPE-DOMAIN shapes only — the dashboard view-model mapping
// (KpiSummary/RankingRow/GeoRow) lives in the dashboard's _data/live.ts so
// lib/scope stays free of app types.
//
// Honest by construction: only metrics the data actually supports are computed
// (visibility, share-of-voice, per-region, citation domains). Sentiment,
// position, mention-type, ACR, trend are absent from this surface and are NOT
// fabricated here — the dashboard renders them as unavailable / omits them.

// HMG tracked brands — 문자열 폴백용(entity_id 없는 레거시/공개 API 행).
// 정본은 lib/scope/hmg-brands (entity_id 기반, 2026-07-02 축D/E) — 이 파일에
// 자체 문자열 셋을 두지 않는다 (판정 단일 소스, 2026-07-03 잔재 제거).

// 미러/HTTP 공통 브랜드 해석기 (2026-07-02 축D/E/모델포함 구현):
//  - rollups.brand_entity_id 가 있으면(미러 100%) 모델(Product) 언급을 소속
//    브랜드로 합산하고 entity_id 로 당사 판정 — 표기 변형에 안전, 자사·경쟁 대칭.
//  - id 가 없는 행은 종전 규칙(Brand 행 display_name 문자열)으로 폴백.
//  - 당사 집합은 축E 스코프(활성 brand 필터 ∩ 3사, 락 포함)를 따른다.
// 브랜드 표기는 jobs 안의 Brand 행 display_name 을 대표로 쓴다; Brand 행이 한 번도
// 등장하지 않은 rollup(모델만 언급된 브랜드)은 표기를 알 수 없어 제외된다.
function makeBrandResolver(
  jobs: MeasurementJob[],
  brandFilter?: string[],
  roster?: { id: string; name: string }[],
  // 전역 엔티티→표기 맵 (SQL ROLLUP_NAMES 트윈). 이 답변들 안에 Brand 행이
  // 없어 모델로만 등장한 브랜드도 부모 브랜드로 해석해, 모수에서 조용히
  // 탈락하던 문제를 없앤다. 미지정(HTTP/테스트) 시 기존처럼 jobs 스캔만 사용.
  globalNames?: Map<string, string>,
) {
  const trackedIds = new Set(trackedEntityIdsFor(brandFilter, roster));
  const trackedNames = trackedBrandNameSetFor(brandFilter, roster);
  // 표기 변형 정규화(2026-08-05): scope 가 자국어 표기('기아'·'هيونداي' 등)에 별도
  // entity_id 를 부여한다 — SQL 경로(scope-aggregates::canonRollupSql)와 같은
  // 접기를 JS 롤업(프로젝트 표면)에도 적용. 알리아스 id 는 정본 id 로 바꾼 뒤
  // 이름·tracked 를 판정하므로 'هيونداي' 행이 'Hyundai' 행에 합쳐진다. 정본
  // 3사 id 의 표기는 정적 사전이 우선 — 이 프로젝트 답변에 정본 Brand 행이 한
  // 번도 없어도(알리아스 표기만 등장) 대표 표기가 흔들리지 않는다.
  const aliasToCanon = new Map(rollupCanonicalPairs(roster));
  const canonBrandNames = new Map<string, string>(
    Object.entries(HMG_BRAND_ENTITY_IDS).map(([brand, id]) => [id, brand]),
  );
  const names = new Map<string, string>();
  // 전역 표기 맵을 먼저 시드 (alias id 는 정본 id 로 접어 SQL 경로와 동일 키).
  if (globalNames) {
    for (const [id, brand] of globalNames) {
      const cid = aliasToCanon.get(id) ?? id;
      if (!names.has(cid)) names.set(cid, brand);
    }
  }
  for (const job of jobs) {
    for (const m of job.analysis?.resolved_mentions ?? []) {
      if (m.entity_type === "Brand" && m.display_name) {
        const raw = m.entity_id ?? m.rollups?.brand_entity_id;
        const id = raw ? (aliasToCanon.get(raw) ?? raw) : null;
        if (id && !names.has(id)) names.set(id, m.display_name);
      }
    }
  }
  return (m: ResolvedMention): { name: string; isTracked: boolean } | null => {
    const rawRollupId =
      m.rollups?.brand_entity_id ??
      (m.entity_type === "Brand" ? m.entity_id : null);
    // 표기 접두 교정 (2026-08-28) — SQL 경로 canonRollupSql 과 동일 규칙·동일
    // 우선순위(표기가 당사면 rollup 이 무엇이든 당사). scope rollup 이 틀린
    // 브랜드를 가리키거나(`Genesis G70 3.3T`→Dodge) 당사 파생 표기를 별도
    // rollup 으로 떼어 놓는(`Kia Charge`) 두 결함을 함께 잡는다.
    const byPrefix = hmgRollupIdByNamePrefix(m.display_name);
    const rollupId = byPrefix
      ? byPrefix
      : rawRollupId
        ? (aliasToCanon.get(rawRollupId) ?? rawRollupId)
        : null;
    if (rollupId) {
      const raw =
        canonBrandNames.get(rollupId) ??
        names.get(rollupId) ??
        (m.entity_type === "Brand" ? m.display_name : null);
      // 표시명 병합(SQL 경로 canonBrandNameSql 과 동일 사전) — '폭스바겐' 등
      // 경쟁사 자국어 표기 rollup 도 정본 표기 행으로 합쳐진다.
      const name = raw ? canonicalBrandDisplayName(raw) : null;
      // 비경쟁 제외는 rollup 표기로 판정하되, 자기 표기가 그 이름을 확장한 하위
      // 제품이면(예: rollup "Smart" 밑의 "Smart Fortwo") 살린다 — SQL 쌍둥이
      // excludeNonCompetitorBrandsSql(brandCol, ownCol) 과 동일 규칙(2026-08-29).
      if (!name || isNonCompetitorMention(name, m.display_name)) return null;
      return { name, isTracked: trackedIds.has(rollupId) };
    }
    if (m.entity_type !== "Brand" || !m.display_name) return null;
    const name = canonicalBrandDisplayName(m.display_name);
    // rollup 이 없는 행 — 자기 표기가 곧 rollup 표기다(확장 여지 없음).
    if (isNonCompetitorMention(name, name)) return null;
    return { name, isTracked: trackedNames.has(name) || trackedNames.has(m.display_name) };
  };
}
// HMG-owned citation detection now uses the canonical geo-catalog base URLs
// (ownedBaseEntryForUrl) — consistent with the SQL mirror path (scope-aggregates).

export interface RootConfig {
  projectId: string;
}

// The standard dashboard + standard-prompt admin read ONE hardcoded root
// project (env-fixed, not a caller argument — removes the arbitrary-project
// surface while gating is still pass-through). null in mock mode or when unset
// → callers fall back to sample data / the local DB.
export function getRootConfig(): RootConfig | null {
  if (isMockMode()) return null;
  const projectId = process.env.SCOPE_ROOT_PROJECT_ID;
  if (!projectId) return null;
  return { projectId };
}

// Placeholder root id used in dev (SCOPE_MODE=mock) so the mirror-backed 표준
// reads are addressable without a live scope key. It is never sent to scope — the
// mirror path (lib/db/repositories/scope-aggregates) reads the scope_* tables in
// the local DB and ignores the project id entirely.
export const MOCK_ROOT_PROJECT_ID = "mock-root-project";

// The project id that GATES + STAMPS every mirror-backed 표준/root read (dashboard
// aggregates, 답변 분석 mention/citation, answer body). Live: env-fixed
// SCOPE_ROOT_PROJECT_ID (via getRootConfig). Dev/mock: the placeholder above, so
// those pages render straight off the scope_* mirror — which is synced into the
// local DB out-of-band (lib/scope/mirror), so it exists even when the scope HTTP
// client is mocked. This only decides "is the root addressable"; the mirror
// aggregations still return null on their own when the mirror is empty, so no rows
// are fabricated (keeps the live-only, no-sample-fixtures rule). null only when
// neither is set (live mode, SCOPE_ROOT_PROJECT_ID unconfigured) → callers null.
export function getStandardRootId(): string | null {
  if (isMockMode()) return MOCK_ROOT_PROJECT_ID;
  return getRootConfig()?.projectId ?? null;
}

export interface BrandAgg {
  name: string;
  mentionCount: number; // total mentions across answers
  answerCount: number; // answers this brand appeared in
  isTracked: boolean;
}
export interface RegionAgg {
  region: string; // ISO country (KR/US/...) — scope's "region"
  answerCount: number;
  trackedAnswerCount: number; // answers mentioning >= 1 tracked brand
}
export interface DomainAgg {
  host: string; // registrable domain
  citingAnswers: number;
  citationCount: number; // ALL citations under this registrable domain (raw volume — includes subdomains/paths outside the owned base-URL prefixes, e.g. an owners-portal or staging subdomain)
  // Citations that individually matched an owned base-URL prefix — the same
  // row-level predicate ⑤ 인용 점유율's numerator uses. isOurs=true only means
  // "at least one citation here matched"; summing citationCount for isOurs
  // domains overcounts vs ⑤ (2026-07-03 dashboard ranking bug) — use this field
  // wherever a domain-level number needs to reconcile with the ⑤ tile.
  ownedCitationCount: number;
  isOurs: boolean;
}
export interface StandardAggregates {
  rootProjectId: string;
  // 측정 기준일 — 이 집계 모집단(필터·full-cycle 게이트 적용 후)의 최신 measured_at
  // (ISO). 필터바 "측정 기준일" 배지가 쓴다. 구 캐시 엔트리에는 없으므로 optional
  // (부재 시 배지만 비고 수치는 그대로). 측정 0건이면 null.
  asOf?: string | null;
  totalAnswers: number; // analyzed jobs
  totalMentions: number; // total brand mentions
  trackedAnswerCount: number; // answers mentioning >= 1 tracked brand
  brands: BrandAgg[]; // desc by mentionCount
  regions: RegionAgg[];
  citations: {
    sampledAnswers: number; // /results answers scanned (capped 200)
    answersWithCitation: number;
    totalCitations: number;
    ownedCitations: number;
    /**
     * **글로벌 ⑤ 분자**(제품 책임자 2026-09-29) — 출처 카테고리가 `Official (HMG)` 인 인용 수.
     * 인용 탭 카테고리 차트와 같은 분류(`resolveCitationCategory` + 오버라이드)다.
     * 글로벌(표준) 리더만 싣는다. website·project 는 이 필드가 없고 ⑤ 는 종전
     * `ownedCitations`(base URL prefix)다 — 읽을 때는 `citationShareNumerator` 로만.
     */
    officialHmgCitations?: number;
    domains: DomainAgg[]; // desc by citingAnswers
  };
  // ④ AI 우선 노출도 (Average Position). Derived from answer_text first-
  // occurrence offsets (scope ships no per-mention rank field), so it's scoped
  // to the answers that carry text — the /results sample, not all jobs.
  position: {
    avgPosition: number | null; // mean rank of our earliest tracked brand; unranked answers excluded
    sampledAnswers: number; // answers with answer_text used as the denominator
  };
  // ③ AI 우호도 (Sentiment) — MENTION-unit positive rate, aligned with scope's
  // canonical `getTrackedKpiAggregate` (2026-07-29). Both counters are sums of
  // per-mention sentiment SIGNAL counts, **not answer counts**. positiveRate is
  // null while no tracked mention carries sentiment (측정 대기, ≠ 0%).
  sentiment: {
    positiveRate: number | null;
    positiveMentions: number; // Σ positive signals (numerator)
    sampledMentions: number; // Σ (positive+neutral+negative+mixed) signals (denominator)
  };
}

const TARGET_LABEL: Record<string, string> = {
  chatgpt: "ChatGPT",
  gemini: "Gemini",
  deepseek: "DeepSeek",
  perplexity: "Perplexity",
  claude: "Claude",
  "claude-web": "Claude",
  "claude-sonnet": "Claude",
  "claude-opus": "Claude",
};
// exported: SQL 미러 인용 집계(scope-aggregates)가 동일한 엔진 표기 규칙을 쓴다.
export function providerLabel(t: string): string {
  return TARGET_LABEL[t] ?? t;
}
// one-decimal percent
function pct(n: number, d: number): number {
  return d > 0 ? Math.round((n / d) * 1000) / 10 : 0;
}

function hostFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

// eTLD 정규화 정본은 lib/public-suffix 하나뿐 — 라이브(result-adapter)와 미러
// (mirror/sync)가 같은 그룹핑 키를 내야 두 읽기 경로의 집계가 일치한다.
function registrableDomain(host: string): string {
  return registrableDomainOfHost(host) ?? host;
}

// Earliest character offset at which any of a brand's surface forms appears in
// the answer text (Infinity if none do).
function earliestOffset(text: string, surfaces: string[], fallback: string): number {
  const surfs = surfaces.length ? surfaces : [fallback];
  let idx = Infinity;
  for (const s of surfs) {
    if (!s) continue;
    const i = text.indexOf(s);
    if (i >= 0 && i < idx) idx = i;
  }
  return idx;
}

// Highlight terms for the answer modal. scope's ontology rolls a Product (a
// model, e.g. "Ioniq 5" / "EV6" / "G80") up to its parent Brand via
// resolved_mentions[].rollups.brand_entity_id. So a brand's footprint in an
// answer is the brand's own surface forms PLUS every entity that rolls up to it.
// We split them so the UI can paint the brand and its models in two colors.
//   brand: the drilled brand's display_name + surfaces (what was literally said)
//   model: surfaces/names of any entity whose rollups.brand_entity_id == brand id
// Surfaces are the verbatim strings as they appeared in answer_text, so they are
// the most reliable match targets; display_name is added as a canonical fallback.
/** 드릴다운 중인 mention 에서 대상 브랜드의 entity id 를 꺼낸다 (GEO-4). */
function brandRollupIdOf(m: ResolvedMention): string | null {
  if (m.entity_type === "Brand") return m.entity_id ?? null;
  return m.rollups?.brand_entity_id ?? null;
}

function highlightTermsForBrand(
  mentions: ResolvedMention[],
  brandName: string,
  // 드릴다운 대상 브랜드의 entity id. **답변에 Brand 행이 없어도** 그 브랜드로
  // 롤업되는 Product 행을 찾으려면 이 값이 필요하다 — mentions 안의 rollups 는
  // id 만 갖고 이름이 없어서, Brand 행이 빠지면 답변 내부만 봐서는 대상 브랜드의
  // id 를 알 방법이 없다(GEO-4). 호출부는 드릴다운 중인 mention 에서 넘긴다.
  rollupBrandId?: string | null,
): { brand: string[]; model: string[] } {
  const brandSet = new Set<string>();
  const modelSet = new Set<string>();
  const push = (set: Set<string>, s?: string | null) => {
    const v = s?.trim();
    if (v && v.length >= 2) set.add(v);
  };

  // 표기 변형 대응: 병합된 행 이름('Kia'·'Volkswagen')으로 드릴다운해도 답변 속
  // Brand 행이 알리아스 표기('기아'·'هيونداي'·'폭스바겐')일 수 있다 — 표시명
  // 사전으로 접어 매칭한다(비등재 브랜드는 항등이라 종전 동작 그대로). 매칭된
  // 모든 표기의 surfaces 를 하이라이트 대상에 합친다.
  const canonOf = (n: string | null | undefined) =>
    n ? canonicalBrandDisplayName(n) : null;
  const target = canonOf(brandName);
  const brandMentions = mentions.filter(
    (m) => m.entity_type === "Brand" && m.display_name && canonOf(m.display_name) === target,
  );
  push(brandSet, brandName);
  const brandIds = new Set<string>();
  for (const bm of brandMentions) {
    push(brandSet, bm.display_name);
    for (const s of bm.surfaces ?? []) push(brandSet, s);
    if (bm.entity_id) brandIds.add(bm.entity_id);
  }
  // 호출부가 준 id 를 합친다. 종전에는 여기가 `if (brandIds.size)` 가드였고,
  // 답변에 Brand 행이 없으면 brandIds 가 비어 **모델 하이라이트를 통째로
  // 건너뛰었다** — 본문에 "Creta" 만 있고 "Hyundai" 가 없는 답변은 형광펜이
  // 하나도 안 칠해졌다(GEO-4).
  if (rollupBrandId) brandIds.add(rollupBrandId);
  for (const m of mentions) {
    if (m.entity_type === "Brand") continue;
    if (m.rollups?.brand_entity_id && brandIds.has(m.rollups.brand_entity_id)) {
      push(modelSet, m.display_name);
      for (const s of m.surfaces ?? []) push(modelSet, s);
    }
  }
  // A term claimed by the brand wins over the same term as a model (avoids a
  // model surface that merely repeats the brand name being painted twice).
  for (const t of brandSet) modelSet.delete(t);
  return { brand: [...brandSet], model: [...modelSet] };
}

// ④ AI 우선 노출도 — for each answer, rank brands by where they first appear in
// answer_text and take our earliest tracked brand's rank (1-based). The mean is
// taken ONLY over answers where our brand is actually ranked; answers where our
// brand never appears are excluded from the calculation entirely (per the metric
// definition). scope ships no rank field, so this is the honest derivation from
// the raw answer + resolved brand surfaces.
function computeAvgPosition(
  results: QueryRunView[],
  // 당사 판정 컨텍스트 (contextBrand ?? brand) — SQL 경로(trackedRollupIn)와
  // 같은 단위 규칙. entity_id 우선, 없으면 표기 폴백 (makeBrandResolver와 동일).
  brandFilter?: string[],
  roster?: { id: string; name: string }[],
): { avgPosition: number | null; sampledAnswers: number } {
  const trackedIds = new Set(trackedEntityIdsFor(brandFilter, roster));
  const trackedNames = trackedBrandNameSetFor(brandFilter, roster);
  let sum = 0;
  let count = 0;
  for (const r of results) {
    if (r.status !== "completed") continue;
    const text = r.result?.answer_text;
    const mentions = r.analysis?.resolved_mentions;
    if (!text || !mentions?.length) continue;
    const brands: { offset: number; tracked: boolean }[] = [];
    for (const m of mentions) {
      if (m.entity_type !== "Brand" || !m.display_name) continue;
      const offset = earliestOffset(text, m.surfaces ?? [], m.display_name);
      if (offset < Infinity) {
        const id = m.entity_id ?? m.rollups?.brand_entity_id;
        brands.push({
          offset,
          tracked: id ? trackedIds.has(id) : trackedNames.has(m.display_name),
        });
      }
    }
    brands.sort((a, b) => a.offset - b.offset);
    const rank = brands.findIndex((b) => b.tracked); // 0-based, -1 if absent
    if (rank < 0) continue; // unranked answers are excluded from the mean
    sum += rank + 1;
    count++;
  }
  if (count === 0) return { avgPosition: null, sampledAnswers: 0 };
  return { avgPosition: Math.round((sum / count) * 10) / 10, sampledAnswers: count };
}

// 이 파일에 있던 `pageAll` 사본(maxPages 30, 조용한 절단)은 2026-08-30 전수
// 조사에서 제거하고 lib/scope/paging.ts 의 공용 헬퍼로 합쳤다. 사본이 남아 있으면
// 한쪽만 고쳐지고 다른 쪽은 조용히 잘린다 — 실제로 미러 쪽 상한을 50→300 으로
// 고쳤을 때 이 사본은 30 그대로였다.
//
// 상한값은 **합치지 않았다.** 프롬프트는 총량이 유한하므로 공유
// `PROMPT_MAX_PAGES`(300)를 쓰지만, runs·jobs 는 무한 증가 소스라 소비자마다
// 값이 달라야 한다:

/**
 * 라이브 집계(사용자 요청 경로)의 `listMeasurementRuns` / `listRunJobs` 상한.
 *
 * **종전 동작 그대로인 30 을 유지한다.** 미러 싱크는 같은 소스를 50 으로 읽지만
 * 그쪽은 백그라운드 크론이고 이쪽은 **화면 렌더를 막는 요청 경로**다 —
 * `fetchJobsForRuns` 는 run 마다 동시에 돌기까지 한다. 이번 변경의 목적은
 * "조용한 절단을 없애는 것"이지 라이브 경로의 요청량을 늘리는 것이 아니므로,
 * 값은 그대로 두고 소진 시 `PAGE CAP HIT` 로그로만 드러나게 했다.
 * 이 로그가 실제로 뜨면 그때 근거를 갖고 올린다.
 */
const LIVE_RUN_MAX_PAGES = 30;
const LIVE_JOB_MAX_PAGES = 30;

// scope is ~1.5–2s per request (server-side analysis payload). The job set is
// spread across runs, each independently paginated — fetch every run's jobs
// CONCURRENTLY so wall-clock is the slowest single run, not the sum. Shared by
// the standard dashboard + both answer-analysis aggregations.
function fetchAllRuns(
  client: ScopeClient,
  projectId: string,
): Promise<MeasurementRunSummary[]> {
  return pageAll<MeasurementRunSummary>(
    (cursor) => client.listMeasurementRuns(projectId, { limit: 100, cursor }),
    { maxPages: LIVE_RUN_MAX_PAGES, label: `live runs(project=${projectId})` },
  ).then((r) => r.items);
}

async function fetchJobsForRuns(
  client: ScopeClient,
  projectId: string,
  runs: MeasurementRunSummary[],
  opts: { includeResult?: boolean } = {},
): Promise<MeasurementJob[]> {
  const perRun = await Promise.all(
    runs.map((run) =>
      pageAll<MeasurementJob>(
        (cursor) =>
          client.listRunJobs(projectId, run.measurement_run_id, {
            limit: 200,
            cursor,
            // ?include=result attaches the answer body + citations to each job —
            // needed for per-project citations (the /results feed is root-scoped).
            ...(opts.includeResult ? { include: "result" } : {}),
          }),
        {
          maxPages: LIVE_JOB_MAX_PAGES,
          label: `live jobs(project=${projectId} run=${run.measurement_run_id})`,
        },
      ).then((r) => r.items),
    ),
  );
  return perRun.flat();
}

// Dashboard dimension filters that scope can actually honor at the job/result
// level. Each is optional; an absent field = no narrowing on that axis.
//   region      → job.region (US / KR)        — mentions only (/results has no region)
//   engine      → job.target / r.target       — both mentions and citations
//   funnelStage → prompt.funnel_stage         — both, via prompt_id join
// Product/Vehicle, sub-model, time-series, source-type and sales weighting have
// no scope source and are intentionally absent (see docs/scope-requests).
// Multi-select: each axis is a set of accepted values (OR within an axis, AND
// across axes). undefined / empty array = no narrowing on that axis.
export interface StandardFilters {
  region?: string[];
  engine?: string[];
  funnelStage?: string[];
  // 측정 기간 (YYYY-MM-DD, inclusive). measured_at 기준으로 답변을 좁힌다.
  // 기간 필터가 활성이면 스냅샷의 "최신 배치" 제한 대신 기간 내 모든 런을
  // 집계한다 (기간 = 그 기간의 측정 전체). 한쪽만 있으면 open-ended.
  dateFrom?: string;
  dateTo?: string;
  // 기간 의미론 스위치 (2026-09-04 기획 수정, 고객 피드백 "7일·30일을 바꿔도
  // 숫자가 안 바뀐다"). 기본(false/undefined)은 스냅샷 = 기간 내 최신 배치.
  // true 면 **기간 내 누적** — 그 기간에 완료된 모든 답변을 합산한다(같은
  // 프롬프트가 여러 번 측정됐으면 측정마다 계상. 단 프롬프트 단위 지표는
  // prompt_id GROUP BY 라 고유 개수로 남는다).
  //
  // ── 2026-09-16 개정 (제품 확정) ─────────────────────────────────────────
  // ① **표면 제한을 없앤다.** 종전 주석은 "답변분석 화면 전용이며, 대시보드·
  //    웹사이트 KPI 는 스냅샷 의미론을 유지한다"였다. 그 결정은 #225(2026-09-06)
  //    가 웹사이트 대시보드를 기간=누적으로 옮기면서 이미 절반이 뒤집혔고, 남은
  //    절반(표준 대시보드·프로젝트 개요·ACR)만 다른 의미론을 쓰는 상태였다.
  //    한 계정이 같은 기간을 걸고 두 화면을 열면 다른 숫자를 보는 것이 그 대가라,
  //    표면별 예외를 없애고 **기간 필터가 걸리는 모든 곳**을 하나로 맞춘다.
  //    ⚠️ Core 7 KPI 산식이 바뀐다 — 기간을 건 대시보드는 "기간말 시점 상태"가
  //    아니라 "기간 누적"을 센다. 기간 미지정(기본) 화면은 불변이다.
  // ② **이 값이 곧 누적을 뜻하지는 않는다.** 판정 정본은
  //    `lib/db/repositories/scope-aggregates.ts:1087` 의 `cumulativeMode` 이고,
  //    거기서 "기간(dateFrom‖dateTo)이 실제로 걸렸을 때만" 누적이 된다.
  //    호출부는 "이 표면은 누적 대상"임만 선언하면 된다.
  cumulative?: boolean;
  // Per-prompt catalog taxonomy (HMG framework). Resolved through the prompt map
  // (the SQL-mirror path joins the prompts catalog); absent on the HTTP path.
  brand?: string[];
  // 당사(축E) 판정 전용 컨텍스트 — 단위 통일 규칙 (2026-07-03):
  //   당사 = HMG 자사 집합 ∩ 단위 컨텍스트.
  //   표준·웹사이트 = 계정 브랜드 스코프(위 brand 축 겸용) → 미지정(brand 폴백),
  //   프로젝트 = project.brand (게이트웨이 withProject가 서버에서 주입).
  // brand 축과 분리한 이유: brand는 프롬프트 카탈로그(catalogIn)도 좁히는데,
  // 프로젝트 프롬프트는 카탈로그 brand 태깅이 없어 그 경로로 주입하면 모집단이
  // 통째로 사라진다. contextBrand는 당사 판정(trackedRollupIn/브랜드 해석기)에만
  // 관여한다. 클라이언트 입력 아님 — 서버 심에서만 세팅.
  contextBrand?: string[];
  // 자사 명부 (entity_registry role='own') — 게이트웨이가 캐시 로드해 주입.
  // 미주입/빈 배열이면 판정부가 hmg-brands 시드로 폴백 (migration 0023 적용 전
  // 동작 불변). 클라이언트 입력 아님 — 서버 심에서만 세팅.
  ownEntities?: { id: string; name: string }[];
  // Branded vs unbranded prompt: "branded" | "unbranded", classified from the
  // brand tag via brandPresenceOf. Both / neither selected = no narrowing.
  brandPresence?: string[];
  listType?: string[];
  depth1?: string[];
  depth2?: string[];
  depth3?: string[];
  // 인용 출처 카테고리 (lib/citation-categorizer taxonomy 값 그대로). citation
  // 집계에서만 의미 — 분류가 집계 시점에 파생되므로 행 단위로 좁힌다. URL 파라미터는
  // ?source= (DimensionFilterPanel의 source 그룹 재활용).
  sourceCategory?: string[];
  // BCP-47 언어 코드 (website 전용). website_prompts.lang_code 와 1:1 매칭.
  // standard 답변분석 경로에서는 무시 — website 집계(answerWhere)에서만 소비.
  // URL 파라미터: ?language= (DimensionFilterPanel의 language 그룹).
  lang?: string[];
  // website_sites.country_code 기반 geography (website 전용).
  // standard의 region(scope_answers.region) 과 기준이 달라 별도 필드로 분리.
  // page.tsx가 readStandardFilters.region 을 여기로 이식해 answerWhere에 주입.
  websiteCountry?: string[];
  // 프로젝트 커스텀 필드 필터 (project_custom_fields/prompt_custom_field_values,
  // 2026-07-06). fieldId → 선택값. 표준/웹사이트 경로는 이 값을 채우는 UI가
  // 없으므로 항상 undefined — sourceCategory/lang과 같은 "특정 경로 전용, 다른
  // 경로는 무시" 패턴. STANDARD_FILTER_ARRAY_AXES에는 넣지 않는다(string[]이
  // 아니라 Record라 모양이 다름) — 대신 lib/scope/server.ts::normalizeFilters에
  // 별도 분기로 캐시 키에 포함시킨다(빠뜨리면 sourceCategory 3차 사고와 같은
  // 종류의 stale-cache 버그가 남).
  // 2026-07-31: 커스텀 태그가 메인 필터 패널의 다중 선택 축으로 흡수되면서
  // fieldId → 선택값 '목록'(같은 태그 안에서 OR)으로 확장. 태그 간에는 AND.
  customFieldFilters?: Record<string, string[]>;
}

// 클라이언트가 고르는 multi-select 필터 축 전체(문자열 배열 필드만) — dateFrom/
// dateTo(스칼라)와 contextBrand/ownEntities(서버 주입 컨텍스트, 클라이언트 입력
// 아님)는 제외. lib/scope/server.ts::normalizeFilters의 캐시키 allowlist와
// components/dash/standard-filters.ts::standardFilterKey 둘 다 여기서 파생시킨다
// — 축을 하나 추가할 때 여기 한 곳만 고치면 됨. 안 그러면 brandPresence(1차),
// lang/websiteCountry(2차), sourceCategory(3차)처럼 같은 축이 두 곳 중 한 곳에서만
// 등록되고 다른 한 곳에서 조용히 빠지는 사고가 반복된다(2026-07-03~07-06 세 번
// 실제로 터짐).
export const STANDARD_FILTER_ARRAY_AXES = [
  "region",
  "engine",
  "funnelStage",
  "brand",
  "brandPresence",
  "listType",
  "depth1",
  "depth2",
  "depth3",
  "sourceCategory",
  "lang",
  "websiteCountry",
] as const satisfies readonly (keyof StandardFilters)[];

export interface PromptMetaValue {
  text: string;
  funnel: string | null;
  // v0.4 taxonomy — populated only on the SQL-mirror path (joined from prompts).
  brand?: string | null;
  // 브랜드 유무 정본 (prompts.brand_presence, migration 0032) — 있으면
  // brandPresenceOf가 이 값을 우선한다 (brand 태그 폴백은 값 없는 카탈로그용).
  brandPresence?: string | null;
  listType?: string | null;
  depth1?: string | null;
  depth2?: string | null;
  depth3?: string | null;
}
type PromptMeta = Map<string, PromptMetaValue>;

// True when a prompt's catalog taxonomy satisfies the active filters. An axis
// with no values is a pass; an active axis requires a matching value (null /
// absent → excluded). Only meaningful on the mirror path, where these are set.
function promptAttrPasses(f: StandardFilters, meta: PromptMetaValue | null): boolean {
  const ok = (vals: string[] | undefined, v: string | null | undefined) =>
    !vals?.length || (v != null && vals.includes(v));
  // brandPresence narrows on the derived class, not the raw brand value.
  const presenceOk =
    !f.brandPresence?.length ||
    (() => {
      const p = brandPresenceOf(meta?.brand, meta?.brandPresence);
      return p != null && f.brandPresence.includes(p);
    })();
  return (
    ok(f.brand, meta?.brand) &&
    presenceOk &&
    ok(f.listType, meta?.listType) &&
    ok(f.depth1, meta?.depth1) &&
    ok(f.depth2, meta?.depth2) &&
    ok(f.depth3, meta?.depth3)
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 앵커 축(0077 `scope_answer_cycle_anchors`) — **JS 롤업 경로의 투영 필드**
// ════════════════════════════════════════════════════════════════════════════
//
// 계약: `notes/hmg-anchor-table/streams/CONTRACT.md` §2·§3 · SQL 조각 정본은
// `lib/period/anchor-axis.ts`. 이 블록은 그 축의 **JS 짝**이다 — SQL 이 못 가는
// 자리(프로젝트 표면·드릴다운·public 경로)가 같은 규칙으로 돌게 한다.
//
// ── 왜 필드가 전부 optional 인가 ────────────────────────────────────────────
// 이 파일은 축을 **켜지 않는다**. 값이 실려 오면 앵커 축, 안 실려 오면 종전 축이다.
// 축을 켜는 판정은 `lib/period/anchor-axis-flag.ts::answerAnchorEnabled()` 하나이고,
// 그 판정이 참일 때만 미러 조회(`scope-aggregates.ts`)가 이 필드를 투영한다.
// 그래서 **끄면 바이트 동일**이다: 필드가 없으면 아래 술어가 전부 종전 식으로 접힌다.
//
// ── 투영 요구서(미러 조회가 답변마다 실어야 하는 것) ────────────────────────
// `AnswerAnchorFields` 가 그 목록이고, 다섯 값이 각각 없으면 이렇게 퇴화한다:
//   · `round_date`       없으면 **축 자체가 꺼진다**(이 값이 축의 존재 신호다).
//   · `measured_at_orig` 없으면 대표 선택이 `measured_at` 으로 폴백 — 0053 접기가
//                        날짜부를 앵커로 덮어써 시:분만 비교하게 되므로 **틀릴 수 있다**.
//                        `round_date` 를 실으면서 이것을 빼는 것은 계약 위반이다.
//   · `anchor_week`      없으면 주 버킷이 `weekStartUTC(measured_at)` 으로 폴백.
//   · `is_default_engine` 없으면 기본 엔진 범위 좁히기가 없다(종전과 같다).
//   · `view_anchor_date`  **키가 없으면** 노출 게이트가 없다(종전). 키가 있고 값이
//                        `null` 이면 그 답변은 비노출이다 — `undefined` 와 `null` 의
//                        구분이 게이트의 on/off 다.

/** 앵커 축에서 답변 한 건이 실어야 하는 값(계약 §2). 전부 optional = 옵트인. */
export interface AnswerAnchorFields {
  /** 회차 **귀속** 날짜(KST `YYYY-MM-DD`). 기간 술어·dedup 의 키이자 축의 존재 신호. */
  round_date?: string | null;
  /** `round_date` 가 속한 KST 주의 월요일 — 주 버킷 키. */
  anchor_week?: string | null;
  /** 대표 답변 정렬 키(원본 측정 시각, 접기 이전). */
  measured_at_orig?: string | null;
  /** 기본 타깃(ChatGPT·Gemini) 여부. 엔진 필터가 비었을 때의 기본 범위. */
  is_default_engine?: boolean | null;
  /** 노출 게이트. `undefined` = 미투영(게이트 없음) · `null` = 비노출 · 값 = 그날부터. */
  view_anchor_date?: string | null;
}

/** 앵커 필드를 실은 job/result — `MeasurementJob`/`QueryRunView` 를 그대로 받는다. */
export type AnchoredJob = MeasurementJob & AnswerAnchorFields;
export type AnchoredResult = QueryRunView & AnswerAnchorFields;

/** 이 행이 앵커 축으로 읽히는가 = `round_date` 가 실려 왔는가. */
export function anchorAxisCarried(row: AnswerAnchorFields | null | undefined): boolean {
  return typeof row?.round_date === "string" && row.round_date.length > 0;
}

/**
 * 노출 게이트(계약 §2 `view_anchor_date`). 3값이다:
 *   `undefined` = 미투영 → **통과**(종전 동작) · `null` = 비노출 → 차단 ·
 *   값 = `today`(KST) 이상이면 아직 안 됐다 → 차단.
 */
export function anchorViewPasses(
  row: AnswerAnchorFields | null | undefined,
  today: string,
): boolean {
  const v = row?.view_anchor_date;
  if (v === undefined) return true;
  if (v === null) return false;
  return v <= today;
}

/**
 * 기본 엔진 범위 — **엔진 필터가 비어 있을 때만** 건다(계약 §3, `anchorDefaultEngineScope`).
 * 사용자가 엔진을 고르면 그 선택이 이긴다(고른 엔진이 화면에서 사라지면 결함으로 읽힌다).
 * 값이 안 실려 오면(`undefined`·`null`) 좁히지 않는다 — 모르는 값으로 모수를 지우지 않는다.
 */
export function anchorDefaultEnginePasses(
  f: StandardFilters,
  row: AnswerAnchorFields | null | undefined,
): boolean {
  if (f.engine?.length) return true;
  const d = row?.is_default_engine;
  return d == null || d === true;
}

let warnedMissingOrig = false;

/** 대표 정렬 키 — `measured_at_orig` 가 정본이고, 없으면 접힌 시각으로 폴백(계약 위반 신호). */
function anchorSortKey(job: AnchoredJob): string {
  const orig = job.measured_at_orig;
  if (orig) return orig;
  if (!warnedMissingOrig) {
    warnedMissingOrig = true;
    console.warn(
      "[anchor-axis] round_date 는 실렸는데 measured_at_orig 가 없다 — 대표 선택이 " +
        "접힌 measured_at 으로 폴백한다(스펙 §2-16: 날짜부가 앵커로 덮여 시:분만 비교된다). " +
        "미러 조회의 투영을 고쳐야 한다.",
    );
  }
  return job.measured_at ?? "";
}

/**
 * **회차마다 셀당 대표 1건**(계약 §3) — SQL 의
 * `DISTINCT ON (ca.round_date, prompt_id, target, region) … ORDER BY … ca.measured_at_orig DESC`
 * 와 같은 규칙을 인메모리로 낸다. 셀 = 프롬프트 × 엔진(`target`) × 지역(`region`).
 *
 * 기간에 회차가 여럿이면 **회차마다** 대표를 하나씩 고르고, 호출부가 그 집합을
 * `snapshotJobIds` 로 써서 회차 간 **합산**한다(회차는 통째로 들어오거나 나간다).
 *
 * 반환:
 *   · `null` — 앵커를 실은 행이 **하나도 없다**(= 종전 축). 호출부는 자기 스냅샷 집합을 쓴다.
 *   · `Set`  — 대표 job id 집합.
 *
 * `opts.pass` 는 dedup **이전에** 거는 술어다(SQL 의 `WHERE`). 필터에서 떨어질 답변이
 * 대표 자리를 차지하면 그 셀이 통째로 사라진다 — 순서가 곧 값이다.
 *
 * 동점(같은 `measured_at_orig`)은 `job_id` 사전식 최대로 깬다. 임의지만 **결정적**이다.
 */
export function anchorRepresentativeJobIds(
  jobs: readonly AnchoredJob[],
  opts: { pass?: (job: AnchoredJob) => boolean } = {},
): Set<string> | null {
  let sawAnchor = false;
  const best = new Map<string, AnchoredJob>();
  for (const job of jobs) {
    if (!anchorAxisCarried(job)) continue;
    sawAnchor = true;
    if (opts.pass && !opts.pass(job)) continue;
    const key = `${job.round_date}|${job.prompt_id ?? ""}|${job.target ?? ""}|${job.region ?? ""}`;
    const cur = best.get(key);
    if (!cur) {
      best.set(key, job);
      continue;
    }
    const a = anchorSortKey(job);
    const b = anchorSortKey(cur);
    if (a > b || (a === b && job.job_id > cur.job_id)) best.set(key, job);
  }
  if (!sawAnchor) return null;
  const out = new Set<string>();
  for (const job of best.values()) out.add(job.job_id);
  return out;
}

// 기간(dateFrom/dateTo, inclusive) 판정 — job/result/public 행이 공유하는 단일
// 규칙. 활성 기간 필터에서 measured_at 없는 행은 제외(funnel 부재 시와 동일 정책).
//
// 앵커 축(`anchor.round_date` 가 실려 있으면)에서는 **회차 귀속 날짜**로 판정한다 —
// 계약 §3 의 `round_date BETWEEN :from AND :to`(양 끝 포함)와 같은 집합이다. 종전 축은
// 답변의 측정 시각을 UTC 일자로 잘라 같은 비교를 한다(값은 27% 자리에서 갈린다).
function datePasses(
  f: StandardFilters,
  measuredAt: string | null | undefined,
  anchor?: AnswerAnchorFields | null,
): boolean {
  if (!f.dateFrom && !f.dateTo) return true;
  // 앞 10자 = 그 날(파싱 아님) — 정본 `lib/period/day-arith.ts::isoDaySlice`.
  const day = anchorAxisCarried(anchor)
    ? (anchor?.round_date as string)
    : measuredAt
      ? isoDaySlice(measuredAt)
      : null;
  if (!day) return false;
  if (f.dateFrom && day < f.dateFrom) return false;
  if (f.dateTo && day > f.dateTo) return false;
  return true;
}

// Job-level predicate shared by every aggregation (standard / mentions). Jobs
// carry region + target directly; funnel_stage is resolved through the prompt
// map. An absent filter field = no narrowing on that axis. `promptMap` may be
// null when no funnel filter is active (the map is fetched lazily there).
//
// 앵커 축: `opts.anchorAxis` 가 참이면 기간을 `round_date` 로 보고, 노출 게이트
// (`view_anchor_date`)와 기본 엔진 범위(`is_default_engine`)를 함께 건다. 값이 안 실린
// 행에서는 셋 다 통과이므로 **축이 꺼진 경로는 술어가 바뀌지 않는다**.
function makeJobPasses(
  filters: StandardFilters,
  promptMap: PromptMeta | null,
  opts: { anchorAxis?: boolean; today?: string } = {},
) {
  const today = opts.today ?? kstDay();
  return (job: AnchoredJob): boolean => {
    if (filters.region?.length && (job.region == null || !filters.region.includes(job.region))) return false;
    if (filters.engine?.length && !filters.engine.includes(job.target)) return false;
    if (!datePasses(filters, job.measured_at, opts.anchorAxis ? job : null)) return false;
    if (opts.anchorAxis) {
      if (!anchorViewPasses(job, today)) return false;
      if (!anchorDefaultEnginePasses(filters, job)) return false;
    }
    const meta = job.prompt_id ? promptMap?.get(job.prompt_id) ?? null : null;
    if (filters.funnelStage?.length && (!meta?.funnel || !filters.funnelStage.includes(meta.funnel))) return false;
    if (!promptAttrPasses(filters, meta)) return false;
    return true;
  };
}

// Result-level predicate shared by standard + citations. The /results feed has
// NO region (documented scope gap), so region cannot narrow citations — only
// engine (r.target) and funnel_stage (via job_id → prompt) apply.
function makeResultPasses(
  filters: StandardFilters,
  jobToPrompt: Map<string, string | null>,
  promptMap: PromptMeta | null,
  // job_id → region. The /results feed itself has no region, but on the mirror
  // path every result maps to a job that carries one, so region CAN narrow
  // citations there. Omit it (HTTP path) → an active region filter excludes
  // results whose job/region is unknown, same policy as funnel.
  jobToRegion?: Map<string, string | null>,
  // 앵커 축: 결과 행 자체에 앵커가 없으면 job 쪽에서 가져온다(미러 경로는 같은
  // answer 메타에서 jobs/results 두 형태를 만들므로 job 맵 하나면 족하다).
  opts: {
    anchorAxis?: boolean;
    anchorOf?: (jobId: string) => AnswerAnchorFields | null | undefined;
    today?: string;
  } = {},
) {
  const today = opts.today ?? kstDay();
  return (r: AnchoredResult): boolean => {
    if (filters.engine?.length && !filters.engine.includes(r.target)) return false;
    if (filters.region?.length) {
      const region = jobToRegion?.get(r.job_id) ?? null;
      if (!region || !filters.region.includes(region)) return false;
    }
    const anchor = opts.anchorAxis ? (opts.anchorOf?.(r.job_id) ?? r) : null;
    // 기간 — 미러 경로는 readMirrorResults 가 answer.measured_at 을 싣는다.
    if (!datePasses(filters, r.result?.measured_at, anchor)) return false;
    if (opts.anchorAxis) {
      if (!anchorViewPasses(anchor, today)) return false;
      if (!anchorDefaultEnginePasses(filters, anchor)) return false;
    }
    const pid = jobToPrompt.get(r.job_id);
    const meta = pid ? promptMap?.get(pid) ?? null : null;
    if (filters.funnelStage?.length && (!meta?.funnel || !filters.funnelStage.includes(meta.funnel))) return false;
    if (!promptAttrPasses(filters, meta)) return false;
    return true;
  };
}

// Pull + roll up the root project's measurement data. Returns null when there
// is nothing analyzed yet (caller renders sample / EmptyState). Never throws on
// empty; transport errors propagate to the gateway caller. `filters` narrows the
// in-memory job/result set before aggregation (scope's public reads take no
// value filter, so slicing happens here).
export async function aggregateStandard(
  client: ScopeClient,
  root: RootConfig,
  filters: StandardFilters = {},
): Promise<StandardAggregates | null> {
  // 1) all runs → all jobs (jobs carry region + analysis.resolved_mentions).
  // Jobs (all runs in parallel) and the citation /results feed are independent —
  // fetch them concurrently so page-entry latency is max(slowest), not the sum.
  // Prompts are only needed to resolve funnel_stage, so fetch them lazily.
  const runs = await fetchAllRuns(client, root.projectId);
  const [jobs, results, promptMap] = await Promise.all([
    fetchJobsForRuns(client, root.projectId, runs),
    client.listResults({ limit: 200 }).then((r) => r.results),
    filters.funnelStage?.length
      ? fetchPromptMap(client, root.projectId)
      : Promise.resolve(null),
  ]);

  // job_id → prompt_id, so the region-less /results feed can still be filtered
  // by funnel_stage (results carry job_id but neither region nor prompt).
  const jobToPrompt = new Map(jobs.map((j) => [j.job_id, j.prompt_id]));
  const jobToRegion = new Map(jobs.map((j) => [j.job_id, j.region]));
  const jobPasses = makeJobPasses(filters, promptMap);
  const filteredResults = results.filter(
    makeResultPasses(filters, jobToPrompt, promptMap, jobToRegion),
  );
  // 모델 rollup + 축E 당사 판정 (미러 SQL 경로와 동일 규칙).
  const resolveBrand = makeBrandResolver(jobs, filters.contextBrand ?? filters.brand, filters.ownEntities);

  // 2) brand + region tallies from analyzed jobs
  const brandMap = new Map<string, BrandAgg>();
  const regionMap = new Map<string, RegionAgg>();
  let totalAnswers = 0;
  let totalMentions = 0;
  let trackedAnswerCount = 0;
  // ③ sentiment — MENTION-unit signal sums over tracked mentions (mirror SQL 과
  // 동일 정의). 답변별 우세(dominant) 판정은 2026-07-29 언급 단위 정렬로 폐지.
  // 신호가 하나도 없으면 분모 0 → positiveRate null → 카드는 "측정 대기".
  const trackedSentTotals = { positive: 0, neutral: 0, negative: 0, mixed: 0 };

  for (const job of jobs) {
    if (job.status !== "completed" || job.analysis?.status !== "completed") {
      continue;
    }
    if (!jobPasses(job)) continue;
    totalAnswers++;
    const region = job.region ?? "UNKNOWN";
    let reg = regionMap.get(region);
    if (!reg) {
      reg = { region, answerCount: 0, trackedAnswerCount: 0 };
      regionMap.set(region, reg);
    }
    reg.answerCount++;

    let hasTracked = false;
    for (const m of job.analysis.resolved_mentions ?? []) {
      const resolved = resolveBrand(m);
      if (!resolved) continue;
      const { name, isTracked } = resolved;
      let b = brandMap.get(name);
      if (!b) {
        b = { name, mentionCount: 0, answerCount: 0, isTracked };
        brandMap.set(name, b);
      }
      b.mentionCount += m.mention_count;
      b.answerCount += 1; // resolved_mentions is grouped → one entry per answer
      totalMentions += m.mention_count;
      if (isTracked) {
        hasTracked = true;
        if (m.sentiment) {
          trackedSentTotals.positive += m.sentiment.positive;
          trackedSentTotals.neutral += m.sentiment.neutral;
          trackedSentTotals.negative += m.sentiment.negative;
          trackedSentTotals.mixed += m.sentiment.mixed;
        }
      }
    }
    if (hasTracked) {
      trackedAnswerCount++;
      reg.trackedAnswerCount++;
    }
  }

  if (totalAnswers === 0) return null;

  // 3) citation domains from /results (no region; capped 200, workspace-scoped).
  // `filteredResults` already had engine/funnel narrowing applied.
  const domainMap = new Map<string, DomainAgg>();
  let sampledAnswers = 0;
  let answersWithCitation = 0;
  let totalCitations = 0;
  let ownedCitations = 0;

  for (const r of filteredResults) {
    if (r.status !== "completed") continue;
    sampledAnswers++;
    const cits = r.result?.citations ?? [];
    if (cits.length) answersWithCitation++;
    const seenDomains = new Set<string>();
    for (const c of cits) {
      totalCitations++;
      const host = hostFromUrl(c?.url);
      if (!host) continue;
      const owned = c?.url ? ownedBaseEntryForUrl(c.url) !== null : false;
      if (owned) ownedCitations++;
      const dom = registrableDomain(host);
      let d = domainMap.get(dom);
      if (!d) {
        d = { host: dom, citingAnswers: 0, citationCount: 0, ownedCitationCount: 0, isOurs: owned };
        domainMap.set(dom, d);
      }
      d.citationCount++;
      if (owned) {
        d.ownedCitationCount++;
        d.isOurs = true;
      }
      if (!seenDomains.has(dom)) {
        seenDomains.add(dom);
        d.citingAnswers++;
      }
    }
  }

  return {
    rootProjectId: root.projectId,
    totalAnswers,
    totalMentions,
    trackedAnswerCount,
    brands: [...brandMap.values()].sort((a, b) => b.mentionCount - a.mentionCount),
    regions: [...regionMap.values()],
    citations: {
      sampledAnswers,
      answersWithCitation,
      totalCitations,
      ownedCitations,
      domains: [...domainMap.values()].sort(
        (a, b) => b.citingAnswers - a.citingAnswers,
      ),
    },
    position: computeAvgPosition(filteredResults, filters.contextBrand ?? filters.brand, filters.ownEntities),
    sentiment: (() => {
      const sampledMentions =
        trackedSentTotals.positive +
        trackedSentTotals.neutral +
        trackedSentTotals.negative +
        trackedSentTotals.mixed;
      return {
        positiveRate:
          sampledMentions > 0 ? pct(trackedSentTotals.positive, sampledMentions) : null,
        positiveMentions: trackedSentTotals.positive,
        sampledMentions,
      };
    })(),
  };
}

// ── Answer-analysis: mentions + citations detail (표준 답변 분석 pages) ───────

async function fetchAllJobs(
  client: ScopeClient,
  projectId: string,
  opts: { includeResult?: boolean } = {},
): Promise<MeasurementJob[]> {
  const runs = await fetchAllRuns(client, projectId);
  return fetchJobsForRuns(client, projectId, runs, opts);
}

async function fetchPromptMap(
  client: ScopeClient,
  projectId: string,
): Promise<Map<string, { text: string; funnel: string | null }>> {
  const prompts = (
    await pageAll<Prompt>(
      (cursor) => client.listPrompts(projectId, { limit: 100, cursor }),
      { maxPages: PROMPT_MAX_PAGES, label: `live prompts(project=${projectId})` },
    )
  ).items;
  return new Map(
    prompts.map((p) => [
      p.prompt_id,
      { text: p.text, funnel: p.funnel_stage ?? null },
    ]),
  );
}

/**
 * 대시보드 KPI 카드 **경쟁사 행**이 실제로 소비하는 필드만 — `MentionsBrandLive` 의
 * 구조적 부분집합이다(그 타입은 이 타입에 그대로 대입된다).
 *
 * 왜 따로 두는가: 경쟁사 행의 원천을 집계층(회차 스냅샷)으로 옮기면서
 * (`S1.competitors`, PR④ B1) 그 경로가 낼 수 있는 것이 이 여섯 필드뿐이기 때문이다.
 * `prompts`·`multi` 같은 언급 화면 전용 필드를 0 으로 채워 `MentionsBrandLive` 인 척
 * 하면, 나중에 그 필드를 읽는 소비자가 생겼을 때 **조용히 0** 이 그려진다.
 * 타입이 없다고 말하게 두는 편이 낫다.
 *
 * 소비처는 `dashboard/_components/overview-kpi-cards.tsx::competitorMinis` 하나다.
 */
export interface CompetitorBrandValue {
  brand: string;
  mentions: number;
  /** % of total mentions */
  share: number;
  /** % of answers mentioning the brand */
  mentionRate: number;
  avgPosition: number | null;
  isTracked: boolean;
  sentiment?: { positive: number; neutral: number; negative: number; mixed: number };
  /**
   * 새 백엔드(API 원천, U4)만 채우는 브랜드 키(rd.dim_brand_name.brand_key). 추이
   * brand_key[](BG-11)·언급 드릴다운(M-3 mode=brand) 입력이다. 옛 경로는 채우지 않는다.
   */
  brandKey?: number;
}

export interface MentionsBrandLive {
  brand: string;
  mentions: number;
  prompts: number; // distinct prompts the brand appeared in
  share: number; // % of total mentions
  mentionRate: number; // % of answers mentioning the brand
  avgPosition: number | null; // avg mention position (null until backfilled)
  isTracked: boolean;
  /**
   * 복수 언급(2026-09-02) — 한 답변 안에서 이 브랜드가 2회 이상 언급된 답변만의
   * 합계. 공통 하단 "브랜드 복수 언급" 토글의 원천. 표준 SQL 경로만 채우고
   * 구 캐시 셀·JS/mock 경로에는 없다(optional) → 토글이 값을 못 찾으면 "—".
   */
  multi?: { mentions: number; answers: number; prompts: number };
  /** 브랜드별 감정 신호 합(2026-09-02, Overview 카드 경쟁사 우호도). 표준 SQL 경로만. */
  sentiment?: { positive: number; neutral: number; negative: number; mixed: number };
  /**
   * 새 백엔드(API 원천, U4)만 채우는 브랜드 키(rd.dim_brand_name.brand_key). 브랜드
   * 드릴다운(M-3 mode=brand)이 이 키를 받는다(BG-17). 옛 경로는 채우지 않는다.
   */
  brandKey?: number;
}
// A clickable answer variant behind a (brand, prompt) cell — one per job
// (engine × region) the brand appears in. This is just a REFERENCE: it carries
// no answer body. The body is fetched lazily by job_id when the modal opens
// (fetchStandardAnswerBody), because scope exposes the body only via the
// capped /results feed today and (gap #6) a per-job body endpoint later — either
// way it's a per-click single fetch, never prefetched into this aggregate.
// `highlights` are derived from THIS job's resolved_mentions so the brand/model
// painting matches whatever body comes back.
export interface MentionAnswerLive {
  jobId: string;
  provider: string; // engine label (ChatGPT / Gemini / …)
  region: string | null; // ISO country from the job
  mentionCount: number; // brand's mention_count IN THIS answer (table's 언급수 = Σ over answers)
  position: number | null; // brand's mention position in THIS answer (null until backfilled)
  // surface forms to highlight, split so the UI can two-tone brand vs its models
  highlights: { brand: string[]; model: string[] };
  measuredAt: string | null; // ISO — the representative answer's measurement time
  // 같은 프롬프트×엔진×지역이 기간 내 반복 측정된 횟수. 리스트에는 최신 1건만
  // 남기고(모달이 길어지지 않게) 반복 측정은 이 카운트로만 노출.
  runs: number;
}
export interface MentionsPromptLive {
  id: string;
  promptText: string;
  mentions: number;
  share: number; // % of this brand's mentions
  funnelStage: string | null;
  providers: string[];
  answers: MentionAnswerLive[]; // one ref per job (engine × region); body lazy-loaded
}
// Weekly Top-N brand mention trend. `points` are recharts rows keyed by
// `week` (ISO date of the Monday week-start) with one numeric column per
// series brand. null when there isn't ≥2 dated weeks to draw a line.
// Weekly Top-N trend: recharts rows keyed by `week` (ISO Monday week-start),
// one numeric column per series key. Used for both brand mentions and citation
// domains (same shape, generic builder below).
export interface WeeklyTrend {
  series: string[]; // top-N series keys (line series), desc by total
  /**
   * [{ week, KeyA, KeyB, … }]. 수집 오류 회차는 시리즈 값이 전부 `null` 이고
   * `gap` 마커가 붙는다(lib/viz/trend-gap.ts). 그 외 값은 종전대로 숫자다.
   */
  points: Array<TrendGapRow>;
}
export type MentionTrend = WeeklyTrend; // top-N brand names
export type CitationTrend = WeeklyTrend; // top-N domains

// 유형 × 브랜드 점유율. 두 집계 경로(JS/SQL)가 동일 규칙으로 채운다(design D3).
export interface MentionTypesByBrand {
  totals: MentionTypeBreakdown; // 유형별 전 브랜드 합 (컷 전 전량 = 점유율 분모)
  brands: Array<{
    brand: string;
    isTracked: boolean;
    types: MentionTypeBreakdown;
  }>;
}

export interface MentionsLive {
  /** totalAnswers: 측정 답변 수(언급률 분모). 표준 SQL 경로만 채운다(optional — 복수 언급 토글용). */
  summary: { total: number; uniqueBrands: number; totalPrompts: number; totalAnswers?: number };
  // 대표 측정 기준일 — 이 집계(기간 내 최신 배치)에 든 답변의 최신 measured_at(ISO).
  // 요약 헤더 "측정 기준일" 배지에 노출. 데이터 없으면 null.
  asOf: string | null;
  brands: MentionsBrandLive[];
  perBrandPrompts: Record<string, MentionsPromptLive[]>;
  // Aggregate breakdowns across all brand mentions. null until scope's
  // sentiment/classification backfill lands → the view shows a placeholder.
  sentimentTotals: MentionSentimentBreakdown | null;
  typeTotals: MentionTypeBreakdown | null;
  // 유형 × 브랜드 점유율 매트릭스 (2026-08-12). totals = top-N 컷 이전 전 브랜드
  // 합(각 유형 점유율의 분모), brands = 랭킹과 동일 컷의 상위 브랜드별 유형 카운트.
  // null = 유형 백필 전(typeTotals 와 동일 시맨틱) → UI 는 현행 카드로 폴백.
  // optional: 구 캐시 엔트리엔 없으므로 부재 시 폴백(캐시 세대 승격 불필요).
  typesByBrand?: MentionTypesByBrand | null;
  hasPosition: boolean;
  // Weekly Top-N brand mention trend (null until ≥2 dated weeks exist).
  trend: MentionTrend | null;
  /**
   * true = 추이 롤업이 시간 초과로 빠졌다(null 이 "2주 미만"이 아니라 degrade).
   * 서버 캐시는 이 값이 true 인 결과를 저장하지 않는다(kpi-tab-budget 규칙 —
   * 2026-09-02 실증: degrade 가 30분 캐시에 굳어 하단 차트가 "준비 중"으로 남았다).
   */
  trendDegraded?: boolean;
}

// Monday-based ISO week start (UTC) of a measured_at timestamp — matches the
// app's weekly measurement basis (date_trunc('week') on the mirror path).
// 계산 정본은 `lib/period/day-arith.ts::weekStartOf` 다 — 같은 월요일 계산이
// `utcMondayOf`(summary-website-aggregates)·`mondayOf`(parity 스크립트)에도 있었다.
// 타임존은 오늘 쓰는 값(ANCHOR_DAY_TZ = UTC)을 그대로 쓴다(값 무변경).
const weekStartUTC = (iso: string | null | undefined): string | null => weekStartOf(iso);

/**
 * 추이 입력 한 건. `week` 가 실려 있으면 그것이 버킷이고(앵커 축의 `ca.anchor_week`),
 * 없으면 종전대로 `date` 에서 UTC 월요일을 계산한다.
 *
 * 앵커 축에서 계산을 안 하는 이유: `anchor_week` 는 쓰기 시점에 KST 로 굳은 `date` 라
 * 세션 타임존·접힌 `measured_at` 과 무관하다(`lib/period/sql-day.ts` 머리 주석의
 * 세션 TZ 의존 문제를 JS 쪽에서도 같은 방식으로 피한다).
 */
export interface WeeklyTrendEntry {
  date: string | null | undefined;
  key: string;
  count: number;
  /** 앵커 축의 주 버킷(`anchor_week`, KST 월요일). 없으면 `date` 에서 계산. */
  week?: string | null;
}

/** 이 행의 주 버킷 — 실린 `week` 가 이기고, 없으면 종전 계산. */
const trendWeekOf = (e: { date?: string | null; week?: string | null }): string | null =>
  e.week ?? weekStartUTC(e.date);

// 추이 시리즈 선정 — 창 내 "어느 주차든" top-N 에 든 적 있는 key 의 합집합.
// 현재 스냅샷 top-N 만 쓰면 (a) 과거 상위였다 지금 빠진 key, (b) 최근 진입 중이라
// 스냅샷 순위는 낮은 key 가 라인에서 사라진다 — 사용자 요청(2026-07-30)으로 union.
// 라인 과다를 막기 위해 cap 으로 창 누적 합 상위만 남긴다(색 팔레트·가독성).
export function weeklyTopNUnion(
  entries: WeeklyTrendEntry[],
  n: number,
  cap: number,
): string[] {
  const perWeek = new Map<string, Map<string, number>>();
  const totals = new Map<string, number>();
  for (const e of entries) {
    const wk = trendWeekOf(e);
    if (!wk || !e.key) continue;
    let bm = perWeek.get(wk);
    if (!bm) {
      bm = new Map();
      perWeek.set(wk, bm);
    }
    bm.set(e.key, (bm.get(e.key) ?? 0) + e.count);
    totals.set(e.key, (totals.get(e.key) ?? 0) + e.count);
  }
  const union = new Set<string>();
  for (const bm of perWeek.values()) {
    [...bm.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .forEach(([k]) => union.add(k));
  }
  return [...union]
    .sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0))
    .slice(0, cap);
}

// Pure: bucket dated (key, count) entries into weekly points for the given
// series keys. Shared by mentions (brand) and citations (domain). Returns null
// unless ≥2 weeks carry data (a single point isn't a trend line).
export function buildWeeklyTrend(
  entries: WeeklyTrendEntry[],
  series: string[],
  /**
   * 숨긴 회차(0070)의 주 격자 키(`cycle_week`) 목록 — 그 주를 **시리즈 값 전부 null +
   * `gap` 마커** 행으로 끼워 넣는다.
   *
   * 규칙 셋(정본 `lib/viz/trend-gap.ts`):
   *   ① 축 **안쪽**만 — 첫/마지막 주 밖의 갭은 이을 이웃이 없어 축만 늘린다.
   *   ② 그 주에 **측정이 남아 있으면 넣지 않는다** — 숨긴 회차 말고 다른 회차의 인용이
   *      그 주에 남아 있다면 그 주는 구멍이 아니다(값이 줄었을 뿐이고 그건 사실이다).
   *   ③ 갭 주는 "2주 이상이어야 선" 판정(`weeks.size < 2`)에 **세지 않는다** — 갭만
   *      둘 있는 차트는 선이 아니다.
   */
  gapWeeks: readonly string[] = [],
): WeeklyTrend | null {
  if (series.length === 0) return null;
  const inSeries = new Set(series);
  const weeks = new Map<string, Map<string, number>>();
  for (const e of entries) {
    if (!inSeries.has(e.key)) continue;
    const wk = trendWeekOf(e);
    if (!wk) continue;
    let bm = weeks.get(wk);
    if (!bm) {
      bm = new Map();
      weeks.set(wk, bm);
    }
    bm.set(e.key, (bm.get(e.key) ?? 0) + e.count);
  }
  if (weeks.size < 2) return null; // need ≥2 weeks for a line (갭 주는 세지 않는다 — 규칙 ③)
  const measured = [...weeks.keys()].sort();
  const points: TrendGapRow[] = measured.map((wk) => {
    const bm = weeks.get(wk)!;
    const row: TrendGapRow = { week: wk };
    for (const k of series) row[k] = bm.get(k) ?? 0;
    return row;
  });
  return applyWeeklyTrendGaps({ series, points }, gapWeeks);
}

/**
 * 주별 추이에 **숨긴 회차 갭 슬롯**을 얹는다(0070). 순수 함수 — 값은 하나도 안 바꾸고
 * 없던 주 하나를 "전부 null + `gap`" 행으로 끼워 넣을 뿐이다.
 *
 * `buildWeeklyTrend` 안에서도 쓰고, **이미 만들어진 추이**(미러 집계가 돌려준 것)에
 * 페처 경계에서 얹을 때도 쓴다 — 두 벌로 갈라지면 한쪽만 고치는 결함이 생긴다.
 * 규칙(축 안쪽만 · 값이 남은 주는 제외)은 `insertTrendGapSlots` 한 곳이 쥔다.
 */
export function applyWeeklyTrendGaps(
  trend: WeeklyTrend | null,
  gapWeeks: readonly string[] = [],
): WeeklyTrend | null {
  if (!trend || gapWeeks.length === 0) return trend;
  const out = insertTrendGapSlots(
    trend.points,
    gapWeeks,
    (r) => String(r.week),
    (wk) => {
      const row: TrendGapRow = { week: wk, [TREND_GAP_FIELD]: COLLECTION_ERROR_GAP };
      // 계약 — 갭 슬롯의 측정값은 **전부 null**. 0 으로 두면 골짜기가 그대로 남는다.
      for (const k of trend.series) row[k] = null;
      return row;
    },
  );
  return out === trend.points ? trend : { series: trend.series, points: [...out] };
}

// Back-compat wrapper (brand semantics) — used by mentions + its unit test.
export function buildMentionTrend(
  entries: {
    date: string | null | undefined;
    brand: string;
    count: number;
    week?: string | null;
  }[],
  seriesBrands: string[],
  gapWeeks: readonly string[] = [],
): MentionTrend | null {
  return buildWeeklyTrend(
    entries.map((e) => ({ date: e.date, key: e.brand, count: e.count, week: e.week })),
    seriesBrands,
    gapWeeks,
  );
}

// Prompt id → { text, funnel } map, shared by the live + mirror aggregation paths.
export type PromptMap = Map<string, PromptMetaValue>;

export async function aggregateMentions(
  client: ScopeClient,
  projectId: string,
  filters: StandardFilters = {},
): Promise<MentionsLive | null> {
  // Jobs carry region + the brand analysis (resolved_mentions); the answer body
  // is NOT here (and not prefetched — it's lazy-loaded per click). So a single
  // jobs+prompts fetch is all the aggregate needs.
  const [jobs, promptMap] = await Promise.all([
    fetchAllJobs(client, projectId),
    fetchPromptMap(client, projectId),
  ]);
  return aggregateMentionsFrom(jobs, promptMap, filters);
}

// Pure transform over already-fetched jobs + prompts — reused by the scope_*
// mirror path (lib/db/repositories/scope-aggregates) so the SAME rollup
// (highlights, per-prompt drilldown, sentiment/type/position) runs on mirrored
// data and Gemini (absent from the capped /results) is included.
export function aggregateMentionsFrom(
  jobs: AnchoredJob[],
  promptMap: PromptMap,
  filters: StandardFilters = {},
  // snapshotJobIds: 표준 경로의 최신 측정일 배치(answerWhere와 동일 집합). 지정되면
  // 수치·순위·드릴다운은 스냅샷 답변만 집계하고(대시보드 KPI와 같은 날), 주간 추이만
  // 전체 이력으로 남긴다. 미지정(HTTP/프로젝트 경로) 시 기존처럼 전 job 집계.
  //
  // brandPrompts (2026-07-08 캐시 크기 대응): 드릴다운용 perBrandPrompts를 어디까지
  // 채울지. "all"(기본)=전 브랜드, "none"=빈 객체(캐시되는 표준/웹사이트 집계용 —
  // perBrandPrompts가 페이로드의 99.9%(12.4MB)라 이를 빼야 2MB 캐시 한도 안에 든다),
  // {onlyBrand}=그 브랜드만(드릴다운 클릭 시 lazy fetch). 수치·순위·추이는 이 옵션과
  // 무관하게 항상 전 브랜드로 계산된다.
  opts: {
    snapshotJobIds?: Set<string> | null;
    brandPrompts?: "all" | "none" | { onlyBrand: string };
    // 전역 엔티티→표기 맵 (미러 경로가 주입; SQL ROLLUP_NAMES 트윈). 모델로만
    // 언급된 브랜드도 부모 브랜드로 해석해 모수에서 조용히 탈락하지 않게 한다.
    globalNames?: Map<string, string>;
    /**
     * 앵커 축(0077)으로 읽는가. **생략 = 자동 판정**(job 하나라도 `round_date` 를
     * 실었으면 켠다) — 투영이 됐는데 옵션을 안 넘겨 축이 반만 켜지는 상태를 없앤다.
     * `false` 를 명시하면 필드가 실려 있어도 종전 축이다.
     */
    anchorAxis?: boolean;
    /** 노출 게이트의 "오늘"(KST). 테스트가 고정하기 위한 자리. */
    today?: string;
  } = {},
): MentionsLive | null {
  // 앵커 축 판정 — 자동이면 "앵커를 실은 job 이 하나라도 있는가".
  const anchorAxis = opts.anchorAxis ?? jobs.some(anchorAxisCarried);
  // Jobs carry region + target; funnel resolves via promptMap. All three filter
  // axes therefore narrow the mention rollup.
  const jobPasses = makeJobPasses(filters, promptMap, { anchorAxis, today: opts.today });
  // 앵커 축의 스냅샷 집합 = **회차마다 셀당 대표 1건**(계약 §3). 여럿이면 회차 간 합산이
  // 되는 것은 이 집합의 원소가 회차마다 하나씩 들어 있기 때문이다. 축이 꺼져 있으면
  // `null` 이라 호출부가 준 집합(종전 SQL 스냅샷)이 그대로 이긴다.
  const anchorSnapshotIds = anchorAxis
    ? anchorRepresentativeJobIds(jobs, {
        pass: (j) =>
          j.status === "completed" && j.analysis?.status === "completed" && jobPasses(j),
      })
    : null;
  const snapshotJobIds = anchorSnapshotIds ?? opts.snapshotJobIds;
  // 브랜드 해석(모델 rollup 합산 + 축E 당사 판정) — 감정·유형 분포도 같은 당사
  // 집합을 쓴다. 감정은 언급(멘션 sentiment 신호) 단위 카운트라 긍정 세그먼트
  // 비율 == 대시보드 positiveRate (동일 모집단·동일 산식, 2026-07-29 정렬).
  const resolveBrand = makeBrandResolver(jobs, filters.contextBrand ?? filters.brand, filters.ownEntities, opts.globalNames);

  interface BrandAcc {
    mentions: number;
    answers: Set<string>;
    promptIds: Set<string>;
    posSum: number;
    posCount: number;
    isTracked: boolean;
    types: MentionTypeBreakdown; // 유형×브랜드 점유율용 — 전 브랜드 누적
  }
  const zeroTypes = (): MentionTypeBreakdown => ({
    mention: 0,
    recommendation: 0,
    comparison: 0,
    definition: 0,
    final_choice: 0,
  });
  const brand = new Map<string, BrandAcc>();
  const bpp = new Map<string, Map<string, { mentions: number; providers: Set<string> }>>();
  // (brand → prompt → answer refs). One ref per job (engine × region); no body.
  const answersFor = new Map<string, Map<string, MentionAnswerLive[]>>();
  const measuredPromptIds = new Set<string>();
  let completedJobs = 0; // analyzed jobs BEFORE filtering (root-empty signal)
  let totalAnswers = 0; // …AFTER filtering (the active-filter answer count)
  let totalMentions = 0;
  const sentimentTotals: MentionSentimentBreakdown = { positive: 0, neutral: 0, negative: 0, mixed: 0 };
  const typeTotals: MentionTypeBreakdown = { mention: 0, recommendation: 0, comparison: 0, definition: 0, final_choice: 0 };
  let typesSeen = false;
  let positionSeen = false;
  // 측정 기준일 — 종전 축은 스냅샷 배치의 최신 `measured_at`(ISO), 앵커 축은
  // `max(round_date)`(계약 §3, KST `YYYY-MM-DD`). 축 안에서는 형식이 균일하다.
  let asOf: string | null = null;
  const trendEntries: {
    date: string | null | undefined;
    brand: string;
    count: number;
    week?: string | null;
  }[] = [];

  for (const job of jobs) {
    if (job.status !== "completed" || job.analysis?.status !== "completed") {
      continue;
    }
    completedJobs++;
    if (!jobPasses(job)) continue;
    // 스냅샷 밖(과거 측정일) 답변은 주간 추이에만 기여하고 수치에서는 제외.
    // 앵커 축에서는 이 집합이 "회차마다 셀당 대표 1건"이라 회차가 여럿이면 **회차마다
    // 한 건씩** 들어온다 = 회차 간 합산(계약 §3).
    const inSnapshot = !snapshotJobIds || snapshotJobIds.has(job.job_id);
    if (inSnapshot) {
      totalAnswers++;
      if (job.prompt_id) measuredPromptIds.add(job.prompt_id);
      const stamp = anchorAxis && job.round_date ? job.round_date : job.measured_at;
      if (stamp && (!asOf || stamp > asOf)) asOf = stamp;
    }
    const mentions = job.analysis.resolved_mentions ?? [];
    for (const m of mentions) {
      const resolved = resolveBrand(m);
      if (!resolved) continue;
      const { name, isTracked } = resolved;
      trendEntries.push({
        date: job.measured_at,
        brand: name,
        count: m.mention_count,
        // 앵커 축의 주 버킷은 저장 컬럼(KST). 없으면 `date` 에서 계산한다.
        ...(anchorAxis && job.anchor_week ? { week: job.anchor_week } : {}),
      });
      if (!inSnapshot) continue;
      let b = brand.get(name);
      if (!b) {
        b = { mentions: 0, answers: new Set(), promptIds: new Set(), posSum: 0, posCount: 0, isTracked, types: zeroTypes() };
        brand.set(name, b);
      }
      b.mentions += m.mention_count;
      // 유형×브랜드 — 전 브랜드 누적(당사 한정 typeTotals 와 별개). SQL 헤드라인
      // 경로의 sum(type_*) GROUP BY 와 동일 규칙(design D3) — parity 대상.
      if (m.type_breakdown) {
        b.types.mention += m.type_breakdown.mention;
        b.types.recommendation += m.type_breakdown.recommendation;
        b.types.comparison += m.type_breakdown.comparison;
        b.types.definition += m.type_breakdown.definition;
        b.types.final_choice += m.type_breakdown.final_choice;
      }
      b.answers.add(job.job_id);
      totalMentions += m.mention_count;
      // per-mention rollups (present only after the scope backfill).
      // 감정 분포는 언급(신호) 단위 누적 — 대시보드 ③ 우호도와 같은 단위·같은
      // 분모라 긍정 세그먼트 비율 == positiveRate (parity).
      if (m.sentiment && isTracked) {
        sentimentTotals.positive += m.sentiment.positive;
        sentimentTotals.neutral += m.sentiment.neutral;
        sentimentTotals.negative += m.sentiment.negative;
        sentimentTotals.mixed += m.sentiment.mixed;
      }
      // 유형 분포도 감정과 동일하게 당사(스코프 브랜드) 언급만 — "내 브랜드가
      // 추천/비교/정의 중 어떤 방식으로 등장하나" (2026-07-02 결정).
      if (m.type_breakdown && isTracked) {
        typesSeen = true;
        typeTotals.mention += m.type_breakdown.mention;
        typeTotals.recommendation += m.type_breakdown.recommendation;
        typeTotals.comparison += m.type_breakdown.comparison;
        typeTotals.definition += m.type_breakdown.definition;
        typeTotals.final_choice += m.type_breakdown.final_choice;
      }
      if (m.avg_position != null) {
        positionSeen = true;
        b.posSum += m.avg_position;
        b.posCount += 1;
      }
      if (job.prompt_id) {
        b.promptIds.add(job.prompt_id);
        // 모든 브랜드(추적+경쟁사)가 자기 프롬프트 드릴다운을 가진다.
        let perPrompt = bpp.get(name);
        if (!perPrompt) {
          perPrompt = new Map();
          bpp.set(name, perPrompt);
        }
        let e = perPrompt.get(job.prompt_id);
        if (!e) {
          e = { mentions: 0, providers: new Set() };
          perPrompt.set(job.prompt_id, e);
        }
        e.mentions += m.mention_count;
        if (job.target) e.providers.add(job.target);

        // One clickable answer ref per 프롬프트×엔진×지역 — 기간 내 반복 측정
        // (여러 run 의 job)은 최신 measured_at 1건으로 접고 runs 로 횟수만 남긴다
        // (모달 리스트가 누적 이력만큼 길어지지 않게). Body is lazy-loaded by
        // job_id on click; highlights come from the representative job's mentions.
        let ans = answersFor.get(name);
        if (!ans) {
          ans = new Map();
          answersFor.set(name, ans);
        }
        let list = ans.get(job.prompt_id);
        if (!list) {
          list = [];
          ans.set(job.prompt_id, list);
        }
        const provider = providerLabel(job.target);
        const region = job.region ?? null;
        const measuredAt = job.measured_at || null;
        const existing = list.find(
          (a) => a.provider === provider && a.region === region,
        );
        if (!existing) {
          list.push({
            jobId: job.job_id,
            provider,
            region,
            mentionCount: m.mention_count,
            position: m.avg_position ?? null,
            highlights: highlightTermsForBrand(mentions, name, brandRollupIdOf(m)),
            measuredAt,
            runs: 1,
          });
        } else if (existing.jobId !== job.job_id) {
          existing.runs += 1;
          // ISO strings compare lexicographically — keep the latest measurement
          // as the representative answer (null measured_at never wins).
          if (measuredAt && (!existing.measuredAt || measuredAt > existing.measuredAt)) {
            existing.jobId = job.job_id;
            existing.mentionCount = m.mention_count;
            existing.position = m.avg_position ?? null;
            existing.highlights = highlightTermsForBrand(mentions, name, brandRollupIdOf(m));
            existing.measuredAt = measuredAt;
          }
        }
      }
    }
  }
  // 신호 합 0 = 아직 채점된 당사 언급이 없음 → sentimentTotals: null (측정 대기).
  // 값 0%(신호는 있으나 긍정 0)와 구분된다.
  const sentimentSeen =
    sentimentTotals.positive +
      sentimentTotals.neutral +
      sentimentTotals.negative +
      sentimentTotals.mixed >
    0;
  // null ⇒ the project has NO analyzed data at all (→ EmptyState, filters
  // pointless). A filter that merely narrows to zero matching jobs falls through
  // to an empty-but-non-null shape so the page keeps the DimensionFilterPanel
  // mounted and shows the filter-aware empty-table row (the user can clear it).
  if (completedJobs === 0) return null;

  const brands: MentionsBrandLive[] = [...brand.entries()]
    .map(([name, b]) => ({
      brand: name,
      mentions: b.mentions,
      prompts: b.promptIds.size,
      share: pct(b.mentions, totalMentions),
      mentionRate: pct(b.answers.size, totalAnswers),
      avgPosition: b.posCount > 0 ? Math.round((b.posSum / b.posCount) * 10) / 10 : null,
      isTracked: b.isTracked,
    }))
    .sort((a, b) => b.mentions - a.mentions);

  const bpMode = opts.brandPrompts ?? "all";
  const perBrandPrompts: Record<string, MentionsPromptLive[]> = {};
  if (bpMode !== "none") {
    const onlyBrand = typeof bpMode === "object" ? bpMode.onlyBrand : null;
    for (const [name, perPrompt] of bpp) {
      if (onlyBrand !== null && name !== onlyBrand) continue;
      const bTotal = brand.get(name)?.mentions ?? 0;
      for (const [pid, e] of perPrompt) {
        (perBrandPrompts[name] ??= []).push({
          id: pid,
          promptText: promptMap.get(pid)?.text ?? pid,
          mentions: e.mentions,
          share: pct(e.mentions, bTotal),
          funnelStage: promptMap.get(pid)?.funnel ?? null,
          providers: [...e.providers].map(providerLabel),
          answers: answersFor.get(name)?.get(pid) ?? [],
        });
      }
    }
    for (const name of Object.keys(perBrandPrompts)) {
      perBrandPrompts[name].sort((a, b) => b.mentions - a.mentions);
    }
  }

  // 유형×브랜드 매트릭스 — totals = 전 브랜드 합(컷 전, 점유율 분모), brands =
  // 랭킹 순서 그대로(슬리밍이 top-N 컷). null 규약 = totals 합 > 0 (SQL 헤드라인
  // 경로와 동일 — type_* 컬럼이 notNull default 0 이라 값 유무로 백필을 판정).
  const typesByBrandTotals = [...brand.values()].reduce((acc, b) => {
    acc.mention += b.types.mention;
    acc.recommendation += b.types.recommendation;
    acc.comparison += b.types.comparison;
    acc.definition += b.types.definition;
    acc.final_choice += b.types.final_choice;
    return acc;
  }, zeroTypes());
  const typesByBrandSum =
    typesByBrandTotals.mention +
    typesByBrandTotals.recommendation +
    typesByBrandTotals.comparison +
    typesByBrandTotals.definition +
    typesByBrandTotals.final_choice;
  const typesByBrand: MentionTypesByBrand | null =
    typesByBrandSum > 0
      ? {
          totals: typesByBrandTotals,
          brands: brands.map((br) => ({
            brand: br.brand,
            isTracked: br.isTracked,
            types: brand.get(br.brand)?.types ?? zeroTypes(),
          })),
        }
      : null;

  return {
    summary: {
      total: totalMentions,
      uniqueBrands: brand.size,
      totalPrompts: measuredPromptIds.size,
    },
    asOf,
    brands,
    perBrandPrompts,
    sentimentTotals: sentimentSeen ? sentimentTotals : null,
    typeTotals: typesSeen ? typeTotals : null,
    typesByBrand,
    hasPosition: positionSeen,
    trend: buildMentionTrend(trendEntries, brands.slice(0, 10).map((b) => b.brand)),
  };
}

export interface CitationUrlLive {
  url: string;
  title: string;
  count: number;
  aiProvider: string;
  promptText: string;
  // The cited *site's* country (geo-catalog URL match — resolves shared hosts
  // like hyundai.com/kr → South Korea). null when the URL can't be pinned.
  country?: string | null;
}
// A prompt that cited this domain, carrying the underlying answers so the
// citation drilldown can open the real answer modal — the SAME MentionAnswerLive
// refs the mention drilldown uses (body lazy-loaded by job_id).
export interface CitationPromptLive {
  id: string;
  promptText: string;
  funnelStage: string | null;
  citations: number; // this domain's citations coming from this prompt's answers
  // 그 중 **자사 base 에 실제로 맞은** 인용 행 수 (KPI ⑤ 분자와 같은 행 단위 규칙).
  // 자사/미인용 프롬프트 분할이 이 값으로 갈린다 — 도메인 단위 `isOurs` 로 가르면
  // genesis.com 처럼 국가 경로로 갈리는 공유 호스트에서 타국 페이지만 인용한
  // 프롬프트가 자사로 승격된다(2026-09-08). 구 캐시 엔트리에는 없으므로 optional.
  ownedCitations?: number;
  providers: string[];
  answers: MentionAnswerLive[];
}
export interface CitationDomainLive {
  domain: string;
  citations: number;
  share: number;
  prompts: number;
  coverageRate: number;
  urls: CitationUrlLive[];
  promptList: CitationPromptLive[]; // prompts that cited this domain → answer modal
  isOurs: boolean;
  category: string | null; // scope per-domain classifier (null until backfilled)
  subcategory: string | null;
  /**
   * 이 행의 드릴다운(urls·promptList)을 **일부러 싣지 않았다**는 표시.
   * 미러 집계가 상위 N 밖 도메인의 드릴다운을 안 가져오거나, 캐시 예산 슬리밍이
   * 드릴다운을 떨궜을 때 붙는다(공식(HMG) 행에만 — 비공식 행은 화면 문구가
   * 종전 그대로라 표시가 필요 없고, 9천 행에 붙이면 페이로드만 는다).
   *
   * 화면이 "URL이 아직 없습니다"(정말 없음)와 "미제공"(우리가 안 실었음)을
   * 구분하는 데 쓴다 — 공식 도메인은 순위와 무관하게 드릴다운을 싣지만
   * 상한(CITATION_OFFICIAL_DRILLDOWN_MAX)을 넘는 초과분이 존재할 수 있고,
   * 그 행에 "아직 없습니다"를 띄우면 거짓말이 된다.
   * undefined = 표시 없음(구 캐시 엔트리 포함).
   */
  drilldownOmitted?: boolean;
  /**
   * 새 백엔드(API 원천, U4)만 채우는 출처 그룹 키(공식 소셜 계정 그룹 포함). 도메인
   * 드릴다운 상세(GET /v1/citations/domains/{skey})를 펼칠 때 부르는 키다(urls·promptList
   * 는 목록에 없다). 옛 경로는 채우지 않는다.
   */
  skey?: string;
}
export interface CitationCategorySlice {
  name: string;
  value: number;
}
// Per-engine citation-category composition (100% stacked bar). byCategory keys
// are taxonomy values (or scope-sent strings); engine is the display label.
export interface EngineCategorySlice {
  engine: string;
  total: number;
  byCategory: Record<string, number>;
}
// 프롬프트 단위 자사 인용 분할 — 서버(SQL)에서 전체 모집단으로 계산한 정확한
// 판정. 미러 경로가 도메인 드릴다운을 top-N 캡으로 슬림화(2MB 캐시 한도)해도
// "자사 인용/미인용 프롬프트" 카운트가 흔들리지 않도록 도메인 리스트와 분리해
// 싣는다. owned/uncited 리스트는 표시용 상위 일부(캡)이고, 카운트가 정본.
export interface CitationsPromptSplit {
  owned: CitationPromptLive[]; // 자사 도메인이 인용된 프롬프트 (상위 일부)
  uncited: CitationPromptLive[]; // 자사 인용이 없는 프롬프트 (상위 일부)
  ownedCount: number; // 전체 모집단 기준 정확한 카운트
  uncitedCount: number;
}

export interface CitationsLive {
  // officialOwnShare: 공식(당사) 인용 비중 % (round1) — 분자 = 콜사이트가 전달한
  // 당사 owned base 판정(KPI ⑤ 분자와 동일 규칙)에 매칭된 인용 수, 분모 = 전체
  // 인용 수. null = 분모 0(측정 대기 — 0% 와 구분), undefined = 미계산(구 캐시
  // 엔트리·live/public 어댑터 경로 — 뷰가 종전 카테고리 슬라이스 타일로 폴백).
  summary: { total: number; uniqueDomains: number; officialOwnShare?: number | null };
  // 측정 기준일 — 이 집계에 든 답변의 최신 measured_at(ISO). 요약 헤더 배지에 노출.
  asOf: string | null;
  domains: CitationDomainLive[];
  // category pie slices — locally classified via lib/citation-categorizer
  // (scope sends no category), so non-null whenever citations exist.
  categories: CitationCategorySlice[] | null;
  // Weekly Top-N domain citation trend (null until ≥2 dated weeks exist).
  trend: CitationTrend | null;
  // Weekly per-CATEGORY citation trend (same ≥2-week rule; series = categories
  // present, desc by total). Feeds the 100% stacked composition chart.
  categoryTrend: CitationTrend | null;
  // Per-engine category composition (null when no engine-attributed rows).
  engineCategories: EngineCategorySlice[] | null;
  // 프롬프트 단위 자사 인용 분할. undefined = 미계산(live/public 경로 — 뷰가
  // domains.promptList 로 직접 계산하는 종전 방식 유지), null = 계산했으나
  // 자사 인용 프롬프트 없음(섹션 숨김 — 종전 판정과 동일).
  promptSplit?: CitationsPromptSplit | null;
}

export async function aggregateCitations(
  client: ScopeClient,
  projectId: string,
  filters: StandardFilters = {},
  // 운영자 인용 카테고리 오버라이드. 이 모듈은 순수(서버 전용 import 없음)로
  // 유지하므로 로더를 직접 부르지 않는다 — 호출부가 loadCitationOverrides() 한
  // 결과를 넘긴다. 생략 시 오버라이드 도입 이전과 동일 동작.
  overrides?: CitationOverrideMap,
): Promise<CitationsLive | null> {
  const [jobs, promptMap, allResults] = await Promise.all([
    fetchAllJobs(client, projectId),
    fetchPromptMap(client, projectId),
    client.listResults({ limit: 200 }).then((r) => r.results),
  ]);
  return aggregateCitationsFrom(jobs, promptMap, allResults, filters, {}, overrides);
}

// ── Per-PROJECT answer analysis from the PUBLIC read surface ─────────────────
// The internal measurement endpoints (/results, /measurements, /query) are NOT
// the HMG public surface (docs/scope-integration-handoff.md): calling them 500s
// in prod. A single project's mention/citation detail therefore comes from the
// PUBLIC, project-scoped reads — /projects/{id}/brand-mentions and
// /projects/{id}/citations — which already carry prompt_id/prompt_text/
// query_run_id (mentions) and domain/category/query_run_id (citations), enough
// to build the same view shapes WITHOUT the internal feeds. region/engine
// filters apply on the rows; funnel/catalog axes have no public-row source and
// are skipped (they only exist on the mirror path).

// 앵커 축: public API 행은 앵커를 싣지 않으므로 `datePasses` 가 종전 축으로 접힌다.
// 행을 그대로 넘겨 두는 것은 나중에 싣게 될 때 자리를 만들어 두기 위해서다.
function publicRowPasses<
  T extends AnswerAnchorFields & {
    region?: string | null;
    target?: string | null;
    measured_at?: string | null;
  },
>(filters: StandardFilters): (r: T) => boolean {
  const regions = filters.region?.length ? new Set(filters.region) : null;
  const engines = filters.engine?.length
    ? new Set(filters.engine.map((e) => e.toLowerCase()))
    : null;
  return (r) =>
    (!regions || (r.region != null && regions.has(r.region))) &&
    (!engines || (r.target != null && engines.has(String(r.target).toLowerCase()))) &&
    datePasses(filters, r.measured_at, r);
}

// BrandMention rows (one brand × one answer) → MentionsLive. Each row is a
// single mention occurrence carrying its prompt + query_run (job) ids, so the
// per-brand → per-prompt → per-answer drilldown reconstructs faithfully.
export function aggregateMentionsFromPublic(
  rows: BrandMention[],
  filters: StandardFilters = {},
): MentionsLive | null {
  if (rows.length === 0) return null; // no analyzed data → EmptyState
  const pass = publicRowPasses<BrandMention>(filters);

  interface BAcc {
    mentions: number;
    answers: Set<string>;
    promptIds: Set<string>;
    posSum: number;
    posCount: number;
    isTracked: boolean;
  }
  const brand = new Map<string, BAcc>();
  const bpp = new Map<string, Map<string, { mentions: number; providers: Set<string> }>>();
  const answersFor = new Map<string, Map<string, MentionAnswerLive[]>>();
  const answerIds = new Set<string>();
  const measuredPromptIds = new Set<string>();
  const sentimentTotals: MentionSentimentBreakdown = { positive: 0, neutral: 0, negative: 0, mixed: 0 };
  const typeTotals: MentionTypeBreakdown = { mention: 0, recommendation: 0, comparison: 0, definition: 0, final_choice: 0 };
  let sentimentSeen = false;
  let typesSeen = false;
  let positionSeen = false;
  let totalMentions = 0;
  const trendEntries: { date: string | null | undefined; brand: string; count: number }[] = [];

  // 당사 판정 — 단위 규칙 (contextBrand ?? brand). 공개 API 행은 entity_id가
  // 없어 표기 기반: 컨텍스트가 3사 전체(무축소)면 상류 is_tracked(그룹 판정,
  // 로컬라이즈 표기도 잡음)를 존중하고, 단위가 좁혀졌으면 이름 매칭으로 그
  // 브랜드만 당사 처리한다 (Kia 프로젝트에서 Hyundai 배지 제거).
  const scopedNames = trackedBrandNameSetFor(filters.contextBrand ?? filters.brand, filters.ownEntities);
  const fullGroup =
    scopedNames.size === trackedBrandNameSetFor(undefined, filters.ownEntities).size;
  const isTrackedRow = (name: string, upstream: boolean | null | undefined) =>
    fullGroup ? (upstream ?? scopedNames.has(name)) : scopedNames.has(name);

  for (const r of rows) {
    if (!pass(r)) continue;
    const name = r.brand_name;
    if (!name) continue;
    const jobId = r.query_run_id ?? r.brand_mention_id ?? "";
    answerIds.add(jobId);
    let b = brand.get(name);
    if (!b) {
      b = { mentions: 0, answers: new Set(), promptIds: new Set(), posSum: 0, posCount: 0, isTracked: isTrackedRow(name, r.is_tracked) };
      brand.set(name, b);
    }
    b.mentions += 1;
    totalMentions += 1;
    trendEntries.push({ date: r.measured_at, brand: name, count: 1 });
    if (jobId) b.answers.add(jobId);
    if (isTrackedRow(name, r.is_tracked)) b.isTracked = true;
    // 감정 분포는 **당사(tracked) 행만** 계상한다 — UI 힌트가 "당사 브랜드 언급"을
    // 약속하는데 종전엔 전 브랜드 행을 세어 계약을 어겼다. 공개 API 행은 행당
    // brand_sentiment 1값이라 이미 언급 단위이며, mixed 는 별도 세그먼트로 분류
    // (종전엔 neutral 로 흡수됐다). 2026-07-29 언급 단위 정렬.
    if (r.brand_sentiment && isTrackedRow(name, r.is_tracked)) {
      sentimentSeen = true;
      if (r.brand_sentiment === "positive") sentimentTotals.positive += 1;
      else if (r.brand_sentiment === "negative") sentimentTotals.negative += 1;
      else if (r.brand_sentiment === "mixed") sentimentTotals.mixed += 1;
      else sentimentTotals.neutral += 1;
    }
    if (r.mention_type) {
      typesSeen = true;
      if (r.mention_type === "recommendation") typeTotals.recommendation += 1;
      else if (r.mention_type === "comparison") typeTotals.comparison += 1;
      else typeTotals.mention += 1; // "mention" | "listing" → general mention
    }
    if (typeof r.mention_position === "number") {
      positionSeen = true;
      b.posSum += r.mention_position;
      b.posCount += 1;
    }
    const pid = r.prompt_id ?? null;
    if (pid) {
      measuredPromptIds.add(pid);
      b.promptIds.add(pid);
      let perPrompt = bpp.get(name);
      if (!perPrompt) { perPrompt = new Map(); bpp.set(name, perPrompt); }
      let e = perPrompt.get(pid);
      if (!e) { e = { mentions: 0, providers: new Set() }; perPrompt.set(pid, e); }
      e.mentions += 1;
      if (r.target) e.providers.add(r.target);
      // one answer ref per job (query_run); body lazy-loaded by jobId on click.
      let ans = answersFor.get(name);
      if (!ans) { ans = new Map(); answersFor.set(name, ans); }
      let list = ans.get(pid);
      if (!list) { list = []; ans.set(pid, list); }
      const existing = list.find((a) => a.jobId === jobId);
      if (existing) existing.mentionCount += 1;
      else list.push({
        jobId,
        provider: providerLabel(r.target ?? ""),
        region: r.region ?? null,
        mentionCount: 1,
        position: r.mention_position ?? null,
        highlights: { brand: [name], model: [] },
        measuredAt: null,
        runs: 1,
      });
    }
  }

  const promptTextById = new Map<string, string>();
  const promptFunnelById = new Map<string, string | null>();
  for (const r of rows) {
    if (r.prompt_id && r.prompt_text && !promptTextById.has(r.prompt_id)) {
      promptTextById.set(r.prompt_id, r.prompt_text);
    }
  }

  const brands: MentionsBrandLive[] = [...brand.entries()]
    .map(([name, b]) => ({
      brand: name,
      mentions: b.mentions,
      prompts: b.promptIds.size,
      share: pct(b.mentions, totalMentions),
      mentionRate: pct(b.answers.size, answerIds.size),
      avgPosition: b.posCount > 0 ? Math.round((b.posSum / b.posCount) * 10) / 10 : null,
      isTracked: b.isTracked,
    }))
    .sort((a, b) => b.mentions - a.mentions);

  const perBrandPrompts: Record<string, MentionsPromptLive[]> = {};
  for (const [name, perPrompt] of bpp) {
    const bTotal = brand.get(name)?.mentions ?? 0;
    for (const [pid, e] of perPrompt) {
      (perBrandPrompts[name] ??= []).push({
        id: pid,
        promptText: promptTextById.get(pid) ?? pid,
        mentions: e.mentions,
        share: pct(e.mentions, bTotal),
        funnelStage: promptFunnelById.get(pid) ?? null,
        providers: [...e.providers].map(providerLabel),
        answers: answersFor.get(name)?.get(pid) ?? [],
      });
    }
    perBrandPrompts[name].sort((a, b) => b.mentions - a.mentions);
  }

  // 측정 기준일 = 이 집계에 든 행들의 최신 measured_at (public 경로는 스냅샷
  // 개념이 없어 전 행 max). ISO 문자열은 사전식 비교로 최신 판정.
  const asOf = trendEntries.reduce<string | null>(
    (mx, e) => (e.date && (!mx || e.date > mx) ? e.date : mx),
    null,
  );
  return {
    summary: { total: totalMentions, uniqueBrands: brand.size, totalPrompts: measuredPromptIds.size },
    asOf,
    brands,
    perBrandPrompts,
    sentimentTotals: sentimentSeen ? sentimentTotals : null,
    typeTotals: typesSeen ? typeTotals : null,
    hasPosition: positionSeen,
    trend: buildMentionTrend(trendEntries, brands.slice(0, 10).map((b) => b.brand)),
  };
}

// Citation rows (one cited URL × answer) → CitationsLive (flat domain table +
// URL drilldown + category column). Citation rows carry no prompt linkage, so
// the per-prompt drilldown (promptList) is empty — the URL drilldown + category
// are the supported leaf.
export function aggregateCitationsFromPublic(
  rows: Citation[],
  filters: StandardFilters = {},
  // 운영자 오버라이드(정규화 도메인 → 카테고리). 생략 = 종전 분류와 동일.
  overrides?: CitationOverrideMap,
): CitationsLive | null {
  if (rows.length === 0) return null;
  const pass = publicRowPasses<Citation>(filters);

  interface UAcc { title: string; count: number; providers: Set<string> }
  interface DAcc {
    citations: number;
    answers: Set<string>;
    urls: Map<string, UAcc>;
    isOurs: boolean;
    category: string | null;
    subcategory: string | null;
  }
  const domainMap = new Map<string, DAcc>();
  const categoryTotals = new Map<string, number>();
  const engineCats = new Map<string, Map<string, number>>();
  let categorySeen = false;
  let totalCitations = 0;
  const answerIds = new Set<string>();
  const trendEntries: { date: string | null | undefined; key: string; count: number }[] = [];
  const categoryTrendEntries: { date: string | null | undefined; key: string; count: number }[] = [];

  for (const r of rows) {
    if (!pass(r)) continue;
    const rawHost = r.domain || hostFromUrl(r.url) || "";
    if (!rawHost) continue;
    const baseDom = r.domain ? r.domain.toLowerCase() : registrableDomain(rawHost);
  // 그룹 키 — 공식 HMG 소셜 계정만 `도메인+계정경로`, 나머지는 종전과 동일한
  // registrable domain. 미러(SQL) 경로의 citationGroupKeySql 과 **같은 배열**
  // (OFFICIAL_SOCIAL_ACCOUNTS)을 통과하므로 두 경로가 같은 값을 만든다.
    const dom = citationGroupKey(baseDom, r.url);
    // scope sends no citation category (confirmed 2026-07-02) — classify
    // locally; a scope-provided value still wins if it ever appears.
    const cat = resolveCitationCategory(r.category, dom, overrides);
    // 출처 카테고리 축 — 분류가 여기서 파생되므로 행 단위로 좁힌다 (다른 축은
    // publicRowPasses가 이미 처리).
    if (filters.sourceCategory?.length && !filters.sourceCategory.includes(cat)) continue;
    const weight = r.mention_count ?? 1;
    totalCitations += weight;
    trendEntries.push({ date: r.measured_at, key: dom, count: weight });
    categoryTrendEntries.push({ date: r.measured_at, key: cat, count: weight });
    if (r.target) {
      const eng = providerLabel(r.target);
      const m = engineCats.get(eng) ?? new Map<string, number>();
      m.set(cat, (m.get(cat) ?? 0) + weight);
      engineCats.set(eng, m);
    }
    const jobId = r.query_run_id ?? "";
    if (jobId) answerIds.add(jobId);
    let d = domainMap.get(dom);
    if (!d) {
      d = {
        citations: 0,
        answers: new Set(),
        urls: new Map(),
        isOurs: r.url ? ownedBaseEntryForUrl(r.url) !== null : ownedBrandOf(dom) !== null,
        category: cat,
        subcategory: r.subcategory ?? null,
      };
      domainMap.set(dom, d);
    }
    if (!d.category) d.category = cat;
    if (!d.subcategory && r.subcategory) d.subcategory = r.subcategory;
    categorySeen = true;
    categoryTotals.set(cat, (categoryTotals.get(cat) ?? 0) + weight);
    d.citations += weight;
    if (jobId) d.answers.add(jobId);
    const url = r.url ?? "";
    let u = d.urls.get(url);
    if (!u) { u = { title: r.title || displayCitationUrl(url), count: 0, providers: new Set() }; d.urls.set(url, u); }
    u.count += weight;
    if (r.target) u.providers.add(r.target);
  }
  if (totalCitations === 0) return null;

  const domains: CitationDomainLive[] = [...domainMap.entries()]
    .map(([dom, d]) => ({
      domain: dom,
      citations: d.citations,
      share: pct(d.citations, totalCitations),
      prompts: 0,
      coverageRate: pct(d.answers.size, answerIds.size),
      isOurs: d.isOurs,
      category: d.category,
      subcategory: d.subcategory,
      urls: [...d.urls.entries()]
        .map(([url, u]) => ({
          url,
          title: u.title,
          count: u.count,
          aiProvider: [...u.providers].map(providerLabel).join(", "),
          promptText: "",
          country: geoEntryForUrl(url)?.country ?? null,
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10),
      promptList: [],
    }))
    .sort((a, b) => b.citations - a.citations);

  const categories: CitationCategorySlice[] | null = categorySeen
    ? [...categoryTotals.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value)
    : null;

  return {
    summary: { total: totalCitations, uniqueDomains: domainMap.size },
    asOf: trendEntries.reduce<string | null>(
      (mx, e) => (e.date && (!mx || e.date > mx) ? e.date : mx),
      null,
    ),
    domains,
    categories,
    trend: buildWeeklyTrend(trendEntries, domains.slice(0, 10).map((d) => d.domain)),
    categoryTrend: buildWeeklyTrend(categoryTrendEntries, (categories ?? []).map((c) => c.name)),
    engineCategories: engineCategorySlices(engineCats),
  };
}

// Map<engine, Map<category, count>> → sorted EngineCategorySlice[] (null when
// nothing was engine-attributed). Shared by both citation aggregators and the
// SQL mirror fold (scope-aggregates) — exported so all three stay identical.
export function engineCategorySlices(m: Map<string, Map<string, number>>): EngineCategorySlice[] | null {
  if (m.size === 0) return null;
  return [...m.entries()]
    .map(([engine, cats]) => ({
      engine,
      total: [...cats.values()].reduce((s, v) => s + v, 0),
      byCategory: Object.fromEntries(cats),
    }))
    .sort((a, b) => b.total - a.total);
}

// Pure transform — reused by the scope_* mirror path so citations roll up the
// SAME way over mirrored data (every engine present, no /results cap).
// 게이트웨이 미배선(테스트 전용 레거시, 2026-08-05 확인): 프로덕션 인용 읽기는
// 전부 aggregateCitationsFromMirror. 그래서 축E/프로젝트 당사 판정 파라미터를
// 받지 않고 전사 카탈로그 판정(ownedBaseEntryForUrl)을 유지하며,
// summary.officialOwnShare 도 싣지 않는다(undefined → 뷰 폴백).
export function aggregateCitationsFrom(
  jobs: AnchoredJob[],
  promptMap: PromptMap,
  allResults: AnchoredResult[],
  filters: StandardFilters = {},
  // snapshotJobIds: aggregateMentionsFrom과 동일 — 수치는 최신 측정일 스냅샷만,
  // 주간 도메인 추이는 전체 이력.
  // anchorAxis/today: aggregateMentionsFrom 과 같은 계약(생략 = 자동 판정).
  opts: {
    snapshotJobIds?: Set<string> | null;
    anchorAxis?: boolean;
    today?: string;
  } = {},
  // 운영자 오버라이드 — 미러 경로(aggregateCitationsFromMirror)와 같은 맵을 받아
  // live/mirror 패리티가 파라미터로 보장된다(숨은 전역 상태 아님).
  overrides?: CitationOverrideMap,
): CitationsLive | null {
  const jobToPrompt = new Map(jobs.map((j) => [j.job_id, j.prompt_id]));
  // On the mirror path every result maps to a job that carries region, so
  // geography narrows citations too — alongside engine, funnel_stage and the
  // v0.4 taxonomy (via r.target and the job_id → prompt join).
  const jobToRegion = new Map(jobs.map((j) => [j.job_id, j.region]));
  // job_id → measured_at for the weekly domain trend (the /results-shaped feed
  // carries no date on the mirror path; the job does).
  const jobToMeasuredAt = new Map(jobs.map((j) => [j.job_id, j.measured_at]));
  // 앵커 축 — 결과 행에는 앵커가 없을 수 있으므로 job 쪽 앵커를 조회로 넘긴다.
  const anchorAxis = opts.anchorAxis ?? jobs.some(anchorAxisCarried);
  const jobToAnchor = anchorAxis
    ? new Map<string, AnswerAnchorFields>(jobs.map((j) => [j.job_id, j]))
    : null;
  // 주 버킷 — 앵커 축이면 저장 컬럼(`anchor_week`), 아니면 `date` 에서 계산(폴백).
  const jobToWeek = anchorAxis
    ? new Map(jobs.map((j) => [j.job_id, j.anchor_week ?? null]))
    : null;
  const results = allResults.filter(
    makeResultPasses(filters, jobToPrompt, promptMap, jobToRegion, {
      anchorAxis,
      anchorOf: (id) => jobToAnchor?.get(id),
      today: opts.today,
    }),
  );
  // 계약 §3 — 회차마다 셀당 대표 1건. 축이 꺼져 있으면 null 이라 호출부 집합이 이긴다.
  const citationJobPasses = makeJobPasses(filters, promptMap, {
    anchorAxis,
    today: opts.today,
  });
  const snapshotJobIds =
    (anchorAxis
      ? anchorRepresentativeJobIds(jobs, {
          pass: (j) => j.status === "completed" && citationJobPasses(j),
        })
      : null) ?? opts.snapshotJobIds;
  // Pre-filter signal: did the project surface ANY citation at all? Reserves the
  // null return strictly for a citation-less project (→ EmptyState); a filter
  // that narrows to zero citations instead yields an empty-but-non-null shape so
  // the page keeps the filter panel mounted (the user can clear the filter).
  const anyCitationUnfiltered = allResults.some(
    (r) => r.status === "completed" && (r.result?.citations?.length ?? 0) > 0,
  );
  const trendEntries: WeeklyTrendEntry[] = [];

  interface UrlAcc {
    title: string;
    count: number;
    providers: Set<string>;
    promptText: string;
  }
  interface PromptAcc {
    promptText: string;
    funnelStage: string | null;
    citations: number;
    ownedCitations: number; // 그 중 owned base 에 맞은 행 수 (자사/미인용 분할의 기준)
    providers: Set<string>;
    answers: Map<string, MentionAnswerLive>; // jobId → ref (one per engine × region)
  }
  interface DomAcc {
    citations: number;
    promptIds: Set<string>;
    answers: Set<string>;
    urls: Map<string, UrlAcc>;
    prompts: Map<string, PromptAcc>; // promptId → prompt rollup for the drilldown
    isOurs: boolean;
    category: string | null;
    subcategory: string | null;
  }
  const domainMap = new Map<string, DomAcc>();
  const categoryTotals = new Map<string, number>();
  const engineCats = new Map<string, Map<string, number>>();
  const categoryTrendEntries: WeeklyTrendEntry[] = [];
  let categorySeen = false;
  let totalCitations = 0;
  let sampledAnswers = 0;

  for (const r of results) {
    if (r.status !== "completed") continue;
    // 스냅샷 밖(과거 측정일) 답변은 주간 추이에만 기여하고 수치에서는 제외.
    const inSnapshot = !snapshotJobIds || snapshotJobIds.has(r.job_id);
    if (inSnapshot) sampledAnswers++;
    const pid = jobToPrompt.get(r.job_id) ?? null;
    const pText = pid ? (promptMap.get(pid)?.text ?? "") : "";
    for (const c of r.result?.citations ?? []) {
      // Prefer scope's classified host; fall back to parsing the URL.
      const rawHost = c?.host || hostFromUrl(c?.url);
      if (!rawHost) continue;
      const baseDom = c?.host ? c.host.toLowerCase() : registrableDomain(rawHost);
  // 그룹 키 — 공식 HMG 소셜 계정만 `도메인+계정경로`, 나머지는 종전과 동일한
  // registrable domain. 미러(SQL) 경로의 citationGroupKeySql 과 **같은 배열**
  // (OFFICIAL_SOCIAL_ACCOUNTS)을 통과하므로 두 경로가 같은 값을 만든다.
      const domForTrend = citationGroupKey(baseDom, c?.url);
      // Mirror rows carry category=null (scope sends none) — classify locally.
      // 출처 카테고리 축은 분류가 파생되는 이 지점에서 행 단위로 좁힌다 (추이 포함
      // — 다른 축과 동일하게 모든 산출물이 일관되게 좁혀진다).
      const cat = resolveCitationCategory(c?.category, domForTrend, overrides);
      if (filters.sourceCategory?.length && !filters.sourceCategory.includes(cat)) continue;
      // 앵커 축이면 주 버킷이 저장 컬럼(`anchor_week`)이다 — `undefined` 면 종전 계산.
      const trendWeek = jobToWeek?.get(r.job_id) ?? undefined;
      trendEntries.push({ date: jobToMeasuredAt.get(r.job_id), key: domForTrend, count: 1, week: trendWeek });
      categoryTrendEntries.push({ date: jobToMeasuredAt.get(r.job_id), key: cat, count: 1, week: trendWeek });
      if (!inSnapshot) continue;
      totalCitations++;
      const dom = domForTrend;
      if (r.target) {
        const eng = providerLabel(r.target);
        const m = engineCats.get(eng) ?? new Map<string, number>();
        m.set(cat, (m.get(cat) ?? 0) + 1);
        engineCats.set(eng, m);
      }
      const owned = c?.url ? ownedBaseEntryForUrl(c.url) !== null : ownedBrandOf(dom) !== null;
      let d = domainMap.get(dom);
      if (!d) {
        d = {
          citations: 0,
          promptIds: new Set(),
          answers: new Set(),
          urls: new Map(),
          prompts: new Map(),
          isOurs: owned,
          category: cat,
          subcategory: c?.subcategory ?? null,
        };
        domainMap.set(dom, d);
      }
      if (!d.category) d.category = cat;
      if (!d.subcategory && c?.subcategory) d.subcategory = c.subcategory;
      categorySeen = true;
      categoryTotals.set(cat, (categoryTotals.get(cat) ?? 0) + 1);
      d.citations++;
      d.answers.add(r.job_id);
      if (owned) d.isOurs = true;
      if (pid) {
        d.promptIds.add(pid);
        let pa = d.prompts.get(pid);
        if (!pa) {
          const meta = promptMap.get(pid);
          pa = {
            promptText: meta?.text ?? "",
            funnelStage: meta?.funnel ?? null,
            citations: 0,
            ownedCitations: 0,
            providers: new Set(),
            answers: new Map(),
          };
          d.prompts.set(pid, pa);
        }
        pa.citations++;
        if (owned) pa.ownedCitations++;
        if (r.target) pa.providers.add(r.target);
        let ans = pa.answers.get(r.job_id);
        if (!ans) {
          ans = {
            jobId: r.job_id,
            provider: providerLabel(r.target),
            region: jobToRegion.get(r.job_id) ?? null,
            mentionCount: 0,
            position: null,
            highlights: { brand: [], model: [] },
            measuredAt: null,
            runs: 1,
          };
          pa.answers.set(r.job_id, ans);
        }
        ans.mentionCount++; // # of this domain's citations in this answer
      }
      const url = c?.url ?? "";
      let u = d.urls.get(url);
      if (!u) {
        u = { title: c?.title || displayCitationUrl(url), count: 0, providers: new Set(), promptText: pText };
        d.urls.set(url, u);
      }
      u.count++;
      if (r.target) u.providers.add(r.target);
    }
  }
  if (totalCitations === 0 && !anyCitationUnfiltered) return null;

  const domains: CitationDomainLive[] = [...domainMap.entries()]
    .map(([dom, d]) => ({
      domain: dom,
      citations: d.citations,
      share: pct(d.citations, totalCitations),
      prompts: d.promptIds.size,
      coverageRate: pct(d.answers.size, sampledAnswers),
      isOurs: d.isOurs,
      category: d.category,
      subcategory: d.subcategory,
      urls: [...d.urls.entries()]
        .map(([url, u]) => ({
          url,
          title: u.title,
          count: u.count,
          aiProvider: [...u.providers].map(providerLabel).join(", "),
          promptText: u.promptText,
          country: geoEntryForUrl(url)?.country ?? null,
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10),
      promptList: [...d.prompts.entries()]
        .map(([pid, pa]) => ({
          id: pid,
          promptText: pa.promptText,
          funnelStage: pa.funnelStage,
          citations: pa.citations,
          ownedCitations: pa.ownedCitations,
          providers: [...pa.providers].map(providerLabel),
          answers: [...pa.answers.values()],
        }))
        .sort((a, b) => b.citations - a.citations),
    }))
    .sort((a, b) => b.citations - a.citations);

  const categories: CitationCategorySlice[] | null = categorySeen
    ? [...categoryTotals.entries()]
        .map(([name, value]) => ({ name, value }))
        .sort((a, b) => b.value - a.value)
    : null;

  return {
    summary: { total: totalCitations, uniqueDomains: domainMap.size },
    asOf: trendEntries.reduce<string | null>(
      (mx, e) => (e.date && (!mx || e.date > mx) ? e.date : mx),
      null,
    ),
    domains,
    categories,
    trend: buildWeeklyTrend(trendEntries, domains.slice(0, 10).map((d) => d.domain)),
    categoryTrend: buildWeeklyTrend(categoryTrendEntries, (categories ?? []).map((c) => c.name)),
    engineCategories: engineCategorySlices(engineCats),
  };
}

// Per-domain citation rollup over an already-filtered result set, optionally
// restricted to `jobIds` (per-brand: only the answers where a brand was
// mentioned). Mirrors the rollup inside aggregateCitationsFrom — kept as a
// separate function so the citation-tab path stays byte-for-byte unchanged —
// and feeds the mention drilldown's 인용출처 tab the SAME domain shape.
function buildCitationDomains(
  results: QueryRunView[],
  jobToPrompt: Map<string, string | null>,
  jobToRegion: Map<string, string | null>,
  promptMap: PromptMap,
  jobIds?: Set<string>,
  overrides?: CitationOverrideMap,
): CitationDomainLive[] {
  interface UrlAcc { title: string; count: number; providers: Set<string>; promptText: string }
  interface PromptAcc {
    promptText: string;
    funnelStage: string | null;
    citations: number;
    ownedCitations: number;
    providers: Set<string>;
    answers: Map<string, MentionAnswerLive>;
  }
  interface DomAcc {
    citations: number;
    promptIds: Set<string>;
    answers: Set<string>;
    urls: Map<string, UrlAcc>;
    prompts: Map<string, PromptAcc>;
    isOurs: boolean;
    category: string | null;
    subcategory: string | null;
  }
  const domainMap = new Map<string, DomAcc>();
  let totalCitations = 0;
  let sampledAnswers = 0;

  for (const r of results) {
    if (r.status !== "completed") continue;
    if (jobIds && !jobIds.has(r.job_id)) continue;
    sampledAnswers++;
    const pid = jobToPrompt.get(r.job_id) ?? null;
    const pText = pid ? (promptMap.get(pid)?.text ?? "") : "";
    for (const c of r.result?.citations ?? []) {
      const rawHost = c?.host || hostFromUrl(c?.url);
      if (!rawHost) continue;
      totalCitations++;
      const baseDom = c?.host ? c.host.toLowerCase() : registrableDomain(rawHost);
  // 그룹 키 — 공식 HMG 소셜 계정만 `도메인+계정경로`, 나머지는 종전과 동일한
  // registrable domain. 미러(SQL) 경로의 citationGroupKeySql 과 **같은 배열**
  // (OFFICIAL_SOCIAL_ACCOUNTS)을 통과하므로 두 경로가 같은 값을 만든다.
      const dom = citationGroupKey(baseDom, c?.url);
      const cat = resolveCitationCategory(c?.category, dom, overrides);
      const owned = c?.url ? ownedBaseEntryForUrl(c.url) !== null : ownedBrandOf(dom) !== null;
      let d = domainMap.get(dom);
      if (!d) {
        d = { citations: 0, promptIds: new Set(), answers: new Set(), urls: new Map(), prompts: new Map(), isOurs: owned, category: cat, subcategory: c?.subcategory ?? null };
        domainMap.set(dom, d);
      }
      if (!d.category) d.category = cat;
      if (!d.subcategory && c?.subcategory) d.subcategory = c.subcategory;
      d.citations++;
      d.answers.add(r.job_id);
      if (owned) d.isOurs = true;
      if (pid) {
        d.promptIds.add(pid);
        let pa = d.prompts.get(pid);
        if (!pa) {
          const meta = promptMap.get(pid);
          pa = { promptText: meta?.text ?? "", funnelStage: meta?.funnel ?? null, citations: 0, ownedCitations: 0, providers: new Set(), answers: new Map() };
          d.prompts.set(pid, pa);
        }
        pa.citations++;
        if (owned) pa.ownedCitations++;
        if (r.target) pa.providers.add(r.target);
        let ans = pa.answers.get(r.job_id);
        if (!ans) {
          ans = { jobId: r.job_id, provider: providerLabel(r.target), region: jobToRegion.get(r.job_id) ?? null, mentionCount: 0, position: null, highlights: { brand: [], model: [] }, measuredAt: null, runs: 1 };
          pa.answers.set(r.job_id, ans);
        }
        ans.mentionCount++;
      }
      const url = c?.url ?? "";
      let u = d.urls.get(url);
      if (!u) { u = { title: c?.title || displayCitationUrl(url), count: 0, providers: new Set(), promptText: pText }; d.urls.set(url, u); }
      u.count++;
      if (r.target) u.providers.add(r.target);
    }
  }

  return [...domainMap.entries()]
    .map(([dom, d]) => ({
      domain: dom,
      citations: d.citations,
      share: pct(d.citations, totalCitations),
      prompts: d.promptIds.size,
      coverageRate: pct(d.answers.size, sampledAnswers),
      isOurs: d.isOurs,
      category: d.category,
      subcategory: d.subcategory,
      urls: [...d.urls.entries()]
        .map(([url, u]) => ({ url, title: u.title, count: u.count, aiProvider: [...u.providers].map(providerLabel).join(", "), promptText: u.promptText, country: geoEntryForUrl(url)?.country ?? null }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10),
      promptList: [...d.prompts.entries()]
        .map(([pid, pa]) => ({ id: pid, promptText: pa.promptText, funnelStage: pa.funnelStage, citations: pa.citations, ownedCitations: pa.ownedCitations, providers: [...pa.providers].map(providerLabel), answers: [...pa.answers.values()] }))
        .sort((a, b) => b.citations - a.citations),
    }))
    .sort((a, b) => b.citations - a.citations);
}

// Per-brand citation domains for the mention drilldown's 인용출처 tab — the same
// rollup, but only over answers where `brandName` is a resolved Brand mention
// (so it matches exactly what that brand's row in the mention table represents).
export function aggregateBrandCitationsFrom(
  jobs: AnchoredJob[],
  promptMap: PromptMap,
  allResults: AnchoredResult[],
  brandName: string,
  filters: StandardFilters = {},
  // 부모 멘션 테이블이 최신 측정일 스냅샷이므로 드릴다운 인용출처도 동일 집합으로.
  // `globalNames` — 전역 엔티티→표기 맵(SQL `ROLLUP_NAMES` 트윈). 2026-09-16 에
  // 추가했다: 미러 호출부가 그 브랜드의 job 으로 **선축소**해 넘기기 시작했는데,
  // `makeBrandResolver` 가 jobs 스캔으로만 표기를 시드하면 축소가 해석을 바꿀 수
  // 있다(그 브랜드의 Brand 행이 축소 밖 job 에만 있는 경우 → 이름 미상 → 드릴다운
  // 공집합). 이 맵을 넘기면 해석이 **job 집합과 무관**해진다 — 언급 경로
  // (`aggregateMentionsFrom`)는 이미 같은 맵을 쓴다.
  // anchorAxis/today: aggregateMentionsFrom 과 같은 계약(생략 = 자동 판정).
  opts: {
    snapshotJobIds?: Set<string> | null;
    globalNames?: Map<string, string>;
    anchorAxis?: boolean;
    today?: string;
  } = {},
  // 운영자 오버라이드 — 인용 탭과 드릴다운이 같은 분류를 보도록 같은 맵을 받는다.
  overrides?: CitationOverrideMap,
): CitationDomainLive[] {
  const jobToPrompt = new Map(jobs.map((j) => [j.job_id, j.prompt_id]));
  const jobToRegion = new Map(jobs.map((j) => [j.job_id, j.region]));
  const anchorAxis = opts.anchorAxis ?? jobs.some(anchorAxisCarried);
  const jobToAnchor = anchorAxis
    ? new Map<string, AnswerAnchorFields>(jobs.map((j) => [j.job_id, j]))
    : null;
  const results = allResults.filter(
    makeResultPasses(filters, jobToPrompt, promptMap, jobToRegion, {
      anchorAxis,
      anchorOf: (id) => jobToAnchor?.get(id),
      today: opts.today,
    }),
  );
  const jobPasses = makeJobPasses(filters, promptMap, { anchorAxis, today: opts.today });
  // 부모 멘션 테이블과 **같은 대표 집합**을 써야 드릴다운이 같은 모수를 본다(계약 §3).
  const snapshotJobIds =
    (anchorAxis
      ? anchorRepresentativeJobIds(jobs, {
          pass: (j) =>
            j.status === "completed" && j.analysis?.status === "completed" && jobPasses(j),
        })
      : null) ?? opts.snapshotJobIds;
  // 멘션 랭킹과 동일한 rollup 해석 — 브랜드 행뿐 아니라 그 브랜드로 rollup 되는
  // 모델 언급 답변도 이 브랜드의 인용출처 드릴다운에 포함.
  const resolveBrand = makeBrandResolver(
    jobs,
    filters.contextBrand ?? filters.brand,
    filters.ownEntities,
    opts.globalNames,
  );
  const brandJobs = new Set<string>();
  for (const j of jobs) {
    if (j.status !== "completed" || j.analysis?.status !== "completed") continue;
    if (!jobPasses(j)) continue;
    if (snapshotJobIds && !snapshotJobIds.has(j.job_id)) continue;
    const hit = (j.analysis.resolved_mentions ?? []).some(
      (m) => resolveBrand(m)?.name === brandName,
    );
    if (hit) brandJobs.add(j.job_id);
  }
  return buildCitationDomains(results, jobToPrompt, jobToRegion, promptMap, brandJobs, overrides);
}
