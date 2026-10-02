/**
 * 기간 모드 S1 값 검증: **쓰기 0, 읽기만** (2026-09-18, AC-G1 빌더 자가 대조).
 *
 * 이 change 가 새로 만드는 값은 하나다: "기간 창 = 회차 N개를 집계층에서 합산한 카드".
 * 그것을 **두 갈래로 독립 재계산**해 대조한다.
 *
 *   ① 가산성(additivity): 회차 N개를 **한 번에** 읽은 값 vs 회차마다 **따로** 읽어
 *      더한 값. 두 경로는 SQL 술어의 모양이 다르다(기간은 `cycle_id = ANY × generation_id
 *      = ANY` 의 교차곱, 단일은 상수 등치). 교차곱이 남의 generation 행을 빨아들이면
 *      여기서 **정수 오차로 드러난다**. 카운터 오차 허용 0.
 *
 *   ② 원시 SQL: 리더를 통하지 않고 집계층 표를 **평 집계**로 직접 읽는다. 회차 술어도
 *      `(cycle_id, generation_id) IN (VALUES …)` **행 단위**로 써서 교차곱 형태를
 *      쓰지 않는다. 비율 지표는 여기서 **분자 합 / 분모 합**임을 확인한다
 *      (회차별 비율의 평균이 아니다: 스펙 "누적 비율 지표" 요구사항).
 *
 * 읽기 전용: 모든 문장이 `SET LOCAL transaction_read_only = on` 트랜잭션 안에서 돈다.
 *
 * 사용:
 *   bash notes/hmg-db-exec.sh <워크트리> \
 *     npx tsx --tsconfig scripts/summary/tsconfig.json scripts/summary/verify-period-s1.ts \
 *       --from=2026-08-20 --to=2026-09-18
 */
import { sql, type SQL } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  S1_TREND_AXES,
  S1_TREND_LIMITS,
  summaryGlobalS1FromTrend,
} from "@/lib/db/repositories/summary-global-aggregates";
import { planTrendRead, type TrendReadScope } from "@/lib/db/repositories/summary-trend-aggregates";
import { pickCyclesInRange } from "@/lib/db/repositories/summary-cycles";
import { globalBaseUniverse, hiddenStandardRegions } from "@/lib/summary/tenant/hmg";
import { ownedBasePrefixesForScope } from "@/lib/scope/hmg-brands";
import { citationCyclesOf, judgeCycleRange, type CycleSet } from "@/lib/summary/read/cycle-set";
import type { StandardAggregates, StandardFilters } from "@/lib/scope/result-adapter";

const argv = process.argv.slice(2);
const arg = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const FROM = arg("from") ?? new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
const TO = arg("to") ?? new Date().toISOString().slice(0, 10);
const ROOT = process.env.SCOPE_ROOT_PROJECT_ID ?? "be28fe15-c743-4a88-abb8-182b25602812";
const BRAND = arg("brand");
const COUNTRY = arg("country");
const FILTERS: StandardFilters = {
  ...(BRAND ? { brand: [BRAND] } : {}),
  ...(COUNTRY ? { region: [COUNTRY] } : {}),
};

/* eslint-disable no-console */
const log = console.log;
const n = (v: unknown) => Number(v ?? 0);
let failures = 0;

function eq(label: string, got: number, want: number, tol = 0): void {
  const diff = Math.abs(got - want);
  const ok = diff <= tol;
  if (!ok) failures += 1;
  log(`  ${ok ? "✓" : "✗"} ${label.padEnd(34)} ${String(got).padStart(12)} vs ${String(want).padStart(12)}`
    + (ok ? "" : `   diff ${diff}`));
}

/** 읽기 전용 트랜잭션: 하네스가 postgres 롤을 주므로 스스로 막는다. */
async function ro<T>(q: SQL): Promise<T> {
  return (await getDb().transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL transaction_read_only = on`);
    return tx.execute(q);
  })) as unknown as T;
}

const scopeOf = (set: CycleSet): TrendReadScope => {
  const plan = planTrendRead({ surface: "global", filters: FILTERS });
  if (!plan.ok) throw new Error(plan.reason);
  return {
    set, filters: FILTERS, ownVariant: plan.ownVariant,
    ownedBasePrefixes: Object.keys(FILTERS).length
      ? ownedBasePrefixesForScope(FILTERS.brand, undefined, FILTERS.region, FILTERS.lang)
      : globalBaseUniverse(),
    limits: S1_TREND_LIMITS, axes: S1_TREND_AXES,
  };
};

/**
 * 회차 하나짜리 집합. **인용 제외 목록은 떼어낸다**: 그래야 그 회차의 원값(0071
 * 회차라면 깨진 인용까지)이 나오고, 아래 대조에서 "무엇이 얼마나 빠졌나" 를 셀 수 있다.
 */
const singleOf = (set: CycleSet, i: number): CycleSet => {
  const c = set.cycles[i];
  const { citationExcludedCycleIds: _drop, ...rest } = set;
  return {
    ...rest, mode: "snapshot", cycles: [c],
    cycleKey: `${c.cycleId}:${c.generationId}`,
    projectIds: [c.projectId], weeks: [c.cycleWeek], anchorCount: 1,
  };
};

/**
 * 원시 술어: 리더와 **다른 모양**으로 쓴다(독립성의 요점).
 * 회차는 행 단위 `IN (VALUES …)`, 범위 BETWEEN 없음.
 */
function rawWhere(set: CycleSet, family: "mention" | "citation" = "mention"): SQL {
  // 인용 계열은 0071 회차를 뺀 목록으로 술어를 만든다(리더와 **다른 방식**으로 같은 규칙).
  const cycles = family === "citation" ? citationCyclesOf(set) : set.cycles;
  const pairs = cycles.map(
    (c) => sql`(${c.cycleId}::uuid, ${c.generationId}::uuid)`,
  );
  const hidden = hiddenStandardRegions();
  const hide = hidden.length
    ? sql` AND country <> ALL(${sql.param([...hidden])}::text[])`
    : sql``;
  // 값 필터도 **손으로** 다시 쓴다(리더의 `trendWhere` 를 부르지 않는 것이 독립성의 요점).
  const brand = FILTERS.brand?.length
    ? sql` AND catalog_brands && ${sql.param([...FILTERS.brand])}::text[]`
    : sql``;
  const region = FILTERS.region?.length
    ? sql` AND country = ANY(${sql.param([...FILTERS.region])}::text[])`
    : sql``;
  return sql`surface = 'global'
    AND (cycle_id, generation_id) IN (${sql.join(pairs, sql`, `)})
    AND run_status IN ('completed', 'partial_failed')
    AND in_root_catalog = 1 AND in_tagged_region = 1 AND in_full_cycle = 1${hide}${brand}${region}`;
}

async function main() {
  const rows = await pickCyclesInRange({
    surface: "global", projectIds: [ROOT], dateFrom: FROM, dateTo: TO,
  });
  if (!rows) throw new Error("회차 범위 조회 불가");
  const judged = judgeCycleRange("global", [ROOT], rows);
  if (!judged.ok) throw new Error(`기간 판정이 폴백이다: ${judged.reason}`);
  const set = judged.set;
  log(`필터 ${JSON.stringify(FILTERS)}`);
  log(`창 ${FROM}..${TO} · 회차 ${set.cycles.length}개 · anchors ${set.anchorCount} · weeks ${set.weeks.length}`);
  for (const c of set.cycles) log(`  · ${c.cycleAnchorAt.slice(0, 10)} ${c.cycleId}`);

  // ── 기간 1회 읽기 ────────────────────────────────────────────────────────
  const read = await summaryGlobalS1FromTrend(scopeOf(set));
  if (read.empty) throw new Error("기간 read 가 empty 다(폴백 상태)");
  const P = read.value.aggregates;

  // ── ① 가산성: 회차마다 따로 읽어 더한다 ──────────────────────────────────
  log(`\n══ ① 가산성: 기간 1회 읽기 vs 회차 ${set.cycles.length}회 따로 읽어 합산 ══`);
  const parts: StandardAggregates[] = [];
  for (let i = 0; i < set.cycles.length; i += 1) {
    const r = await summaryGlobalS1FromTrend(scopeOf(singleOf(set, i)));
    if (r.empty) throw new Error(`회차 ${i} read 가 empty`);
    parts.push(r.value.aggregates);
  }
  // 계열마다 **분모가 되는 회차 집합이 다르다**(0071). 언급 계열은 전 회차, 인용 계열은
  // 인용 제외를 뺀 회차. 두 집합을 섞어 더하면 이 change 가 고친 그 결함이 된다.
  const citIdx = new Set(
    set.cycles
      .map((c, i) => ((set.citationExcludedCycleIds ?? []).includes(c.cycleId) ? -1 : i))
      .filter((i) => i >= 0),
  );
  const sum = (f: (a: StandardAggregates) => number) => parts.reduce((s, a) => s + f(a), 0);
  const sumCit = (f: (a: StandardAggregates) => number) =>
    parts.reduce((s, a, i) => (citIdx.has(i) ? s + f(a) : s), 0);

  eq("[언급] 총 답변(모수)", P.totalAnswers, sum((a) => a.totalAnswers));
  eq("[언급] 당사 등장 답변", P.trackedAnswerCount, sum((a) => a.trackedAnswerCount));
  eq("[언급] 총 언급", P.totalMentions, sum((a) => a.totalMentions));
  eq("[인용] 인용 있는 답변", P.citations.answersWithCitation, sumCit((a) => a.citations.answersWithCitation));
  eq("[인용] 총 인용", P.citations.totalCitations, sumCit((a) => a.citations.totalCitations));
  eq("[인용] 자사 인용", P.citations.ownedCitations, sumCit((a) => a.citations.ownedCitations));
  eq("[인용] 인용 분모", P.citations.sampledAnswers, sumCit((a) => a.totalAnswers));
  eq("[언급] 순위 있는 답변(④ 분모)", P.position.sampledAnswers, sum((a) => a.position.sampledAnswers));
  eq("[언급] 긍정 언급(③ 분자)", P.sentiment.positiveMentions, sum((a) => a.sentiment.positiveMentions));
  eq("[언급] 감정 신호(③ 분모)", P.sentiment.sampledMentions, sum((a) => a.sentiment.sampledMentions));

  // 브랜드 축: 이름 합집합이지 개수 합이 아니다(GROUP BY 가 회차를 접는다).
  const names = new Set(parts.flatMap((a) => a.brands.map((b) => b.name)));
  log(`  · 브랜드 타일 ${P.brands.length}개 · 회차별 이름 합집합 ${names.size}개`
    + ` (SUM ${sum((a) => a.brands.length)} 이 아니어야 정상: 절단 top-200 은 창마다 다르다)`);
  const perBrand = new Map<string, number>();
  for (const a of parts) for (const b of a.brands) {
    perBrand.set(b.name, (perBrand.get(b.name) ?? 0) + b.mentionCount);
  }
  let brandMiss = 0;
  for (const b of P.brands.slice(0, 10)) {
    const want = perBrand.get(b.name);
    if (want == null) { brandMiss += 1; continue; }
    eq(`  브랜드 ${b.name}`, b.mentionCount, want);
  }
  if (brandMiss) log(`  · 상위 10 중 ${brandMiss}개는 일부 회차 절단 밖이라 대조 생략`);

  // 지역 롤업.
  const perRegion = new Map<string, number>();
  for (const a of parts) for (const r of a.regions) {
    perRegion.set(r.region, (perRegion.get(r.region) ?? 0) + r.answerCount);
  }
  let regionBad = 0;
  for (const r of P.regions) if (r.answerCount !== (perRegion.get(r.region) ?? 0)) regionBad += 1;
  eq("지역 롤업 불일치 국가 수", regionBad, 0);

  // ── ② 원시 SQL: 리더를 통하지 않은 평 집계 ─────────────────────────────
  log(`\n══ ② 원시 SQL 평 집계(행 단위 회차 술어) ══`);
  const variant = scopeOf(set).ownVariant;
  const own = (await ro<Array<Record<string, unknown>>>(sql`
    SELECT COALESCE(sum(monitored), 0)::bigint       AS monitored,
           COALESCE(sum(tracked_answers), 0)::bigint AS tracked,
           COALESCE(sum(rank_sum), 0)::double precision AS rank_sum,
           COALESCE(sum(ranked_answers), 0)::bigint  AS ranked,
           COALESCE(sum(own_positive), 0)::bigint    AS own_positive,
           COALESCE(sum(own_signals), 0)::bigint     AS own_signals
    FROM summary_trend_own
    WHERE ${rawWhere(set)} AND own_variant = ${variant}
  `))[0];
  // 인용 계열은 **다른 회차 술어**로 따로 읽는다(분자와 분모를 같은 집합에서).
  const ownCit = (await ro<Array<Record<string, unknown>>>(sql`
    SELECT COALESCE(sum(citing_answers), 0)::bigint AS citing,
           COALESCE(sum(monitored), 0)::bigint      AS cit_monitored
    FROM summary_trend_own
    WHERE ${rawWhere(set, "citation")} AND own_variant = ${variant}
  `))[0];
  eq("[언급] 총 답변(모수)", P.totalAnswers, n(own.monitored));
  eq("[언급] 당사 등장 답변", P.trackedAnswerCount, n(own.tracked));
  eq("[인용] 인용 있는 답변", P.citations.answersWithCitation, n(ownCit.citing));
  eq("[인용] 인용 분모", P.citations.sampledAnswers, n(ownCit.cit_monitored));
  eq("[언급] 순위 있는 답변(④ 분모)", P.position.sampledAnswers, n(own.ranked));
  eq("[언급] 긍정 언급(③ 분자)", P.sentiment.positiveMentions, n(own.own_positive));
  eq("[언급] 감정 신호(③ 분모)", P.sentiment.sampledMentions, n(own.own_signals));

  const brands = (await ro<Array<Record<string, unknown>>>(sql`
    SELECT COALESCE(sum(mentions), 0)::bigint AS mentions
    FROM summary_trend_brands
    WHERE ${rawWhere(set)} AND is_competitor = 1
  `))[0];
  eq("[언급] 총 언급", P.totalMentions, n(brands.mentions));

  const dom = (await ro<Array<Record<string, unknown>>>(sql`
    SELECT COALESCE(sum(citations), 0)::bigint AS citations
    FROM summary_trend_domains
    WHERE ${rawWhere(set, "citation")}
  `))[0];
  eq("[인용] 총 인용", P.citations.totalCitations, n(dom.citations));

  // ── ③ 비율은 **분자 합 / 분모 합** 이다 ─────────────────────────────────
  log(`\n══ ③ 비율 지표: 분자 합 / 분모 합(회차별 비율의 평균이 아니다) ══`);
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const wantPos = n(own.ranked) > 0 ? r1(n(own.rank_sum) / n(own.ranked)) : null;
  const wantSent = n(own.own_signals) > 0 ? r1((100 * n(own.own_positive)) / n(own.own_signals)) : null;
  eq("④ 우선노출도", P.position.avgPosition ?? -1, wantPos ?? -1);
  eq("③ 긍정 비율(%)", P.sentiment.positiveRate ?? -1, wantSent ?? -1);
  // 회차별 비율의 산술 평균은 **다른 값**이어야 한다(같으면 대조가 무의미하다).
  const naivePos = parts.filter((a) => a.position.avgPosition != null);
  if (naivePos.length > 1) {
    const mean = r1(
      naivePos.reduce((s, a) => s + (a.position.avgPosition as number), 0) / naivePos.length,
    );
    log(`  · 참고: 회차별 ④ 의 산술 평균 ${mean} (가중 ${P.position.avgPosition}): 두 값이 다른 것이 정상`);
  }

  // ── ④ 인용 계열 회차 스코프 (0071) ──────────────────────────────────────
  const excluded = set.citationExcludedCycleIds ?? [];
  log(`\n══ ④ 인용 계열 회차 스코프: 제외 ${excluded.length}개 ══`);
  if (excluded.length === 0) {
    log("  (창 안에 hidden_scope='citations' 회차가 없다)");
  } else {
    for (const id of excluded) log(`  · 제외 ${id}`);
    // 인용 계열 합계는 "제외한 회차만 따로 읽은 값" 만큼 작아야 한다.
    const gone = parts.filter((_, i) => excluded.includes(set.cycles[i].cycleId));
    const keep = parts.filter((_, i) => !excluded.includes(set.cycles[i].cycleId));
    // `parts` 는 제외 목록을 뗀 단일 회차 읽기라, `gone` 에는 그 회차의 **원값**이 있다.
    const sumOf = (xs: StandardAggregates[], f: (a: StandardAggregates) => number) =>
      xs.reduce((s2, a) => s2 + f(a), 0);
    eq("총 인용 = 남은 회차 합", P.citations.totalCitations,
      sumOf(keep, (a) => a.citations.totalCitations));
    eq("자사 인용 = 남은 회차 합", P.citations.ownedCitations,
      sumOf(keep, (a) => a.citations.ownedCitations));
    eq("인용 보유 답변 = 남은 회차 합", P.citations.answersWithCitation,
      sumOf(keep, (a) => a.citations.answersWithCitation));
    eq("인용 분모 = 남은 회차 모수 합", P.citations.sampledAnswers,
      sumOf(keep, (a) => a.totalAnswers));
    // 언급 계열은 **전 회차** 합 그대로다(그 회차 값이 살아 있어야 한다).
    eq("총 언급 = 전 회차 합", P.totalMentions, sumOf(parts, (a) => a.totalMentions));
    eq("총 답변 = 전 회차 합", P.totalAnswers, sumOf(parts, (a) => a.totalAnswers));
    log(`  · 제외분(참고): 총 인용 ${sumOf(gone, (a) => a.citations.totalCitations)}`
      + ` · 자사 인용 ${sumOf(gone, (a) => a.citations.ownedCitations)}`
      + ` · 인용 보유 답변 ${sumOf(gone, (a) => a.citations.answersWithCitation)}`
      + ` · 모수 ${sumOf(gone, (a) => a.totalAnswers)}`);
    const rate = P.citations.sampledAnswers > 0
      ? (100 * P.citations.answersWithCitation) / P.citations.sampledAnswers
      : 0;
    log(`  · 인용 보유 답변 비율 ${rate.toFixed(2)}%`
      + ` (= ${P.citations.answersWithCitation} / ${P.citations.sampledAnswers})`);
  }

  log(`\n측정 기준일(asOf) ${P.asOf} · 창 안 최신 회차 앵커와 같아야 한다`);
  log(failures === 0 ? "\n✅ 전 항목 오차 0" : `\n✗ 불일치 ${failures}건`);
  if (failures) process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
