// 미러 추이(aggregateStandardTrendFromMirror)의 마지막 버킷 vs 사실표 카드(summaryWebsiteAggregates) 대조. 읽기 전용.
// 실행: bash notes/hmg-db-exec.sh <워크트리> npx tsx --tsconfig scripts/summary/tsconfig.json scripts/summary/compare-trend-last-point.ts [brand]
import { aggregateStandardTrendFromMirror, aggregateStandardFromMirror } from "@/lib/db/repositories/scope-aggregates";
import { summaryWebsiteAggregates } from "@/lib/db/repositories/summary-website-aggregates";
import { pickWebsiteCycles } from "@/lib/db/repositories/summary-cycles";
import { websiteExcludedUnits, summaryUnitFlagsAvailable } from "@/lib/db/repositories/summary-settings";
import { getWebsiteScopeProjectIds, listWebsiteSites } from "@/lib/db/repositories/website-sites";
import { websiteDeclaredOwnedBases } from "@/lib/db/repositories/scope-aggregates";
import type { StandardFilters } from "@/components/dash/standard-filters";

const brand = process.argv[2];
const WEBSITE_TARGETS_OWNED = true;
const pct = (n: number, d: number) => (d ? Math.round((1000 * n) / d) / 10 : null);

const ids: string[] = brand ? [...new Set((await listWebsiteSites()).filter((w: any) => w.brand === brand && w.scopeProjectId).map((w: any) => String(w.scopeProjectId)))] : await getWebsiteScopeProjectIds();
const filters: StandardFilters = brand ? ({ contextBrand: brand } as unknown as StandardFilters) : ({} as StandardFilters);
const own = await websiteDeclaredOwnedBases(filters, ids);
console.log(`scope brand=${brand ?? "ALL"} projects=${ids.length} bases=${own.prefixes.length}`);

const trend = await aggregateStandardTrendFromMirror(filters, "week", ids, own.prefixes, own.universe, WEBSITE_TARGETS_OWNED);
const last = trend[trend.length - 1];
const prev = trend[trend.length - 2];
const show = (b: typeof last) => b && `${b.bucketStart.slice(0, 10)} answers ${b.answers} ①${pct(b.trackedAnswers, b.answers)} ②${pct(b.trackedMentions, b.totalMentions)} ③${pct(b.positiveMentions, b.sentMentions)} ④${b.avgPosition} ⑤${pct(b.ownedCitations, b.totalCitations)} (owned ${b.ownedCitations}/${b.totalCitations}) days ${b.measuredDays} ${b.firstAt?.slice(0, 10)}~${b.lastAt?.slice(0, 10)}`;
console.log("trend prev :", show(prev));
console.log("trend last :", show(last));

const snap = await aggregateStandardFromMirror(filters, ids, own.prefixes, own.universe, WEBSITE_TARGETS_OWNED);
console.log("mirror snap:", snap && `answers ${snap.totalAnswers} ①${pct(snap.trackedAnswerCount, snap.totalAnswers)} ③${snap.sentiment.positiveRate} ④${snap.position.avgPosition} ⑤${pct(snap.citations.ownedCitations, snap.citations.totalCitations)} (owned ${snap.citations.ownedCitations}/${snap.citations.totalCitations}) asOf ${snap.asOf}`);

const picked = await pickWebsiteCycles(ids);
const unitFlags = await summaryUnitFlagsAvailable();
const excludedUnits = await websiteExcludedUnits();
if (!picked) { console.log("summary: no cycles"); process.exit(0); }
const s = await summaryWebsiteAggregates({ cycles: picked.cycles, projectIds: picked.cycles.map((c) => c.projectId), filters, ownedBasePrefixes: own.prefixes, unitFlags, excludedUnits });
console.log(`summary card (cycles ${picked.cycles.length}/${ids.length}, unitFlags ${unitFlags}, excluded ${JSON.stringify(excludedUnits)}):`, s && `answers ${s.totalAnswers} ①${pct(s.trackedAnswerCount, s.totalAnswers)} ③${s.sentiment.positiveRate} ④${s.position.avgPosition} ⑤${pct(s.citations.ownedCitations, s.citations.totalCitations)} (owned ${s.citations.ownedCitations}/${s.citations.totalCitations}) asOf ${s.asOf}`);
process.exit(0);
