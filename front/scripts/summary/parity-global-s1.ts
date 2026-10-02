/**
 * S1 대시보드 **화면 값 레벨** 패리티 — 쓰기 0, 읽기만 (PR② T6 수용 기준 ③).
 *
 * `parity-trend.ts` 는 리더 코어(`readTrendAggregates`)의 원시 항목을 대조한다.
 * 이 하네스는 그 위층 — **화면이 실제로 받는 객체**(`StandardAggregates` ·
 * `GeoKpiResult`)를 오늘 경로와 새 경로에서 각각 만들어 정수 0 오차를 본다.
 *
 *   ① KPI 카드·도넛·지역 롤업
 *        오늘 = `summaryGlobalAggregates`(세부층 6문장, PR② 이전의 화면 경로)
 *        새   = `summaryGlobalS1FromTrend`(집계층 3문장 — 카드·GEO 공용)
 *      대조: 모수·①분자·총언급·③·④·⑤·인용답변수 + **브랜드 배열**·**지역 배열**·
 *            **도메인 배열**(개수·상위 N 항목의 값까지).
 *
 *   ② GEO(국가별 KPI 5종)
 *        오늘 = `aggregateGeoKpiFromMirror`(미러 3문장 — R5 의 "미배선" 경로)
 *        새   = 같은 read 의 `geo` (추가 문장 0 — `axes.domainCountry`)
 *      GEO 는 **오늘이 미러**라 세부층 기준선이 없다. 0 오차를 기대하지 않는다 —
 *      미러(전 이력 answerWhere)와 회차 스냅샷의 모집단 자체가 다르기 때문이다.
 *      그래서 값 차이를 그대로 찍고, 판정은 사람이 한다(보고에 표로 남긴다).
 *
 * 사용:
 *   bash notes/hmg-db-exec.sh <워크트리> \
 *     npx tsx --tsconfig scripts/summary/tsconfig.json scripts/summary/parity-global-s1.ts
 *   (GEO 절은 `SCOPE_ROOT_PROJECT_ID` 가 있을 때만 돈다 — 없으면 건너뛴다.)
 */
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  summaryGlobalAggregates,
  summaryGlobalS1FromTrend,
  S1_TREND_AXES,
  S1_TREND_LIMITS,
} from "@/lib/db/repositories/summary-global-aggregates";
import { resolveOwnVariantKey, type TrendReadScope } from "@/lib/db/repositories/summary-trend-aggregates";
import { aggregateGeoKpiFromMirror } from "@/lib/db/repositories/scope-aggregates";
import { ownedBasePrefixesForScope } from "@/lib/scope/hmg-brands";
import type { StandardFilters, StandardAggregates } from "@/lib/scope/result-adapter";
import type { CycleSet } from "@/lib/summary/read/cycle-set";

const argv = process.argv.slice(2);
const arg = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const CYCLE_ID = arg("cycle");
const WITH_GEO = argv.includes("--geo");

/* eslint-disable no-console */
const log = console.log;
const n = (v: unknown) => Number(v ?? 0);

type CycleRow = {
  cycle_id: string; generation_id: string; project_id: string;
  cycle_anchor_at: string; cycle_week: string;
};

async function loadSet(): Promise<CycleSet> {
  const rows = (await getDb().execute(sql`
    SELECT cycle_id::text, active_generation_id::text AS generation_id, project_id::text,
           cycle_anchor_at::text, cycle_week::text
    FROM summary_cycles
    WHERE surface = 'global' AND active_generation_id IS NOT NULL
      ${CYCLE_ID ? sql`AND cycle_id = ${CYCLE_ID}::uuid` : sql``}
    ORDER BY cycle_anchor_at DESC
  `)) as unknown as CycleRow[];
  if (!rows.length) throw new Error("활성 generation 이 있는 global 회차가 없다");
  const cycles = rows.slice(0, 1).map((r) => ({
    cycleId: r.cycle_id, generationId: r.generation_id, projectId: r.project_id,
    cycleAnchorAt: r.cycle_anchor_at, cycleWeek: r.cycle_week,
  }));
  return {
    surface: "global", mode: "snapshot", cycles,
    cycleKey: cycles.map((c) => `${c.cycleId}:${c.generationId}`).sort().join(","),
    projectIds: [...new Set(cycles.map((c) => c.projectId))],
    missingProjectIds: [],
    weeks: [...new Set(cycles.map((c) => c.cycleWeek))].sort(),
    anchorCount: new Set(cycles.map((c) => c.cycleAnchorAt.slice(0, 10))).size,
  };
}

/** 화면이 넘기는 `$sel` 과 같은 함수·같은 입력(`lib/scope/server.ts::scopeOwnedPrefixes`). */
const ownedPrefixesFor = (f: StandardFilters): string[] =>
  ownedBasePrefixesForScope(f.contextBrand ?? f.brand, f.ownEntities, f.websiteCountry ?? f.region, f.lang);

const CASES: Array<{ name: string; filters: StandardFilters }> = [
  { name: "무필터", filters: {} },
  { name: "국가1 (KR)", filters: { region: ["KR"] } },
  { name: "국가1+언어1 (KR/KO)", filters: { region: ["KR"], lang: ["KO"] } },
  { name: "국가2 (KR,US)", filters: { region: ["KR", "US"] } },
  { name: "언어1 (EN)", filters: { lang: ["EN"] } },
  { name: "브랜드 (Kia)", filters: { brand: ["Kia"] } },
  { name: "brandPresence (branded)", filters: { brandPresence: ["branded"] } },
];

/** 스칼라 대조 항목 — 전부 정수(비율은 분자·분모로 환원). */
function scalars(g: StandardAggregates): Record<string, number> {
  return {
    monitored: n(g.totalAnswers),
    trackedAnswers: n(g.trackedAnswerCount),
    totalMentions: n(g.totalMentions),
    ownPositive: n(g.sentiment?.positiveMentions),
    ownSignals: n(g.sentiment?.sampledMentions),
    rankedAnswers: n(g.position?.sampledAnswers),
    withCitation: n(g.citations?.answersWithCitation),
    citTotal: n(g.citations?.totalCitations),
    citOwned: n(g.citations?.ownedCitations),
    regionCount: (g.regions ?? []).length,
    regionAnswerSum: (g.regions ?? []).reduce((s, r) => s + n(r.answerCount), 0),
    regionTrackedSum: (g.regions ?? []).reduce((s, r) => s + n(r.trackedAnswerCount), 0),
  };
}

/** 배열 대조 — 이름 키로 맞춰 값이 어긋나는 항목 수와 첫 사례를 낸다. */
function diffRows<T>(
  today: T[], next: T[], keyOf: (r: T) => string, valsOf: (r: T) => Record<string, number | boolean>,
): { onlyToday: number; onlyNext: number; mismatched: number; sample: string | null } {
  const a = new Map(today.map((r) => [keyOf(r), valsOf(r)]));
  const b = new Map(next.map((r) => [keyOf(r), valsOf(r)]));
  let mismatched = 0;
  let sample: string | null = null;
  for (const [k, va] of a) {
    const vb = b.get(k);
    if (!vb) continue;
    for (const f of Object.keys(va)) {
      if (va[f] !== vb[f]) {
        mismatched += 1;
        sample ??= `${k}.${f}: ${String(va[f])} → ${String(vb[f])}`;
        break;
      }
    }
  }
  return {
    onlyToday: [...a.keys()].filter((k) => !b.has(k)).length,
    onlyNext: [...b.keys()].filter((k) => !a.has(k)).length,
    mismatched,
    sample,
  };
}

async function main() {
  const set = await loadSet();
  log(`회차 ${set.cycles[0].cycleId} · gen ${set.cycles[0].generationId} · anchor ${set.cycles[0].cycleAnchorAt}`);

  const keys = Object.keys(scalars({
    totalAnswers: 0, totalMentions: 0, trackedAnswerCount: 0, brands: [], regions: [],
    rootProjectId: "", citations: { sampledAnswers: 0, answersWithCitation: 0, totalCitations: 0, ownedCitations: 0, domains: [] },
    position: { avgPosition: null, sampledAnswers: 0 },
    sentiment: { positiveRate: null, positiveMentions: 0, sampledMentions: 0 },
  }));

  log(`\n① 카드·도넛·지역 (오늘=세부층 6문장 vs 새=집계층 3문장)`);
  log(`케이스 | ${keys.join(" | ")} | avgPos(오늘→새) | 브랜드행 | 지역행 | 도메인행`);
  for (const c of CASES) {
    const prefixes = ownedPrefixesFor(c.filters);
    const variant = resolveOwnVariantKey(c.filters);
    if (!variant) { log(`${c.name}: own_variant 없음(E4) — 건너뜀`); continue; }
    const scope: TrendReadScope = {
      set, filters: c.filters, ownVariant: variant, ownedBasePrefixes: prefixes,
      limits: S1_TREND_LIMITS, axes: S1_TREND_AXES,
    };

    const today = await summaryGlobalAggregates({
      cycle: set.cycles[0], rootProjectId: set.projectIds[0], filters: c.filters, ownedBasePrefixes: prefixes,
    });
    const read = await summaryGlobalS1FromTrend(scope);
    if (read.empty) { log(`${c.name}: 집계층 비어 있음(폴백 신호)`); continue; }
    const next = read.value.aggregates;
    if (!today || !next) { log(`${c.name}: 오늘=${today ? "값" : "null"} · 새=${next ? "값" : "null"}`); continue; }

    const a = scalars(today);
    const b = scalars(next);
    const diffs = keys.map((k) => (b[k] - a[k] === 0 ? "0" : `**${b[k] - a[k] > 0 ? "+" : ""}${b[k] - a[k]}** (${a[k]}→${b[k]})`));
    const pos = `${today.position.avgPosition ?? "-"}→${next.position.avgPosition ?? "-"}${today.position.avgPosition === next.position.avgPosition ? "" : " **≠**"}`;
    const br = diffRows(today.brands, next.brands, (r) => r.name,
      (r) => ({ m: r.mentionCount, a: r.answerCount, t: r.isTracked }));
    const rg = diffRows(today.regions, next.regions, (r) => r.region,
      (r) => ({ a: r.answerCount, t: r.trackedAnswerCount }));
    const dm = diffRows(today.citations.domains, next.citations.domains, (r) => r.host,
      (r) => ({ c: r.citationCount, o: r.ownedCitationCount, ca: r.citingAnswers, ours: r.isOurs }));
    const fmt = (d: ReturnType<typeof diffRows>) =>
      d.onlyToday + d.onlyNext + d.mismatched === 0
        ? "0"
        : `**오늘만${d.onlyToday}/새만${d.onlyNext}/불일치${d.mismatched}**${d.sample ? ` [${d.sample}]` : ""}`;
    log(`${c.name} | ${diffs.join(" | ")} | ${pos} | ${fmt(br)} | ${fmt(rg)} | ${fmt(dm)}`);
  }

  if (!WITH_GEO) { log(`\n② GEO — 생략(--geo 로 켠다)`); return; }
  log(`\n② GEO (오늘=미러 3문장 vs 새=집계층 2문장) — 0 오차 기대 아님(모집단이 다르다)`);
  for (const c of CASES.slice(0, 4)) {
    const prefixes = ownedPrefixesFor(c.filters);
    const variant = resolveOwnVariantKey(c.filters);
    if (!variant) continue;
    const read = await summaryGlobalS1FromTrend({
      set, filters: c.filters, ownVariant: variant, ownedBasePrefixes: prefixes,
      limits: S1_TREND_LIMITS, axes: S1_TREND_AXES,
    });
    if (read.empty) { log(`${c.name}: 집계층 비어 있음`); continue; }
    const next = read.value.geo;
    if (!next) { log(`${c.name}: GEO 축 미형성 → GEO 만 미러 폴백`); continue; }
    let today: Awaited<ReturnType<typeof aggregateGeoKpiFromMirror>> | null = null;
    try {
      today = await aggregateGeoKpiFromMirror(c.filters, set.projectIds[0], prefixes);
    } catch (e) {
      log(`${c.name}: 미러 GEO 실패 — ${(e as Error).message}`);
    }
    const sum = (rows: Array<{ answers?: number; citTotal?: number; citOwned?: number }>, f: "answers" | "citTotal" | "citOwned") =>
      rows.reduce((s, r) => s + n(r[f]), 0);
    log(
      `${c.name} | codes ${today?.codes.length ?? "-"}→${next.codes.length}` +
      ` | 모수합 ${today ? sum(today.codes, "answers") : "-"}→${sum(next.codes, "answers")}` +
      ` | 인용합 ${today ? sum(today.codes, "citTotal") : "-"}→${sum(next.codes, "citTotal")}` +
      ` | 당사인용 ${today ? sum(today.codes, "citOwned") : "-"}→${sum(next.codes, "citOwned")}` +
      ` | brands ${today?.brands.length ?? "-"}→${next.brands.length}`,
    );
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
