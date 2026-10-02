// 프로덕션 실패 재현 — 웹사이트 사실표 경로 6개 집계의 실제 소요시간·에러를 잰다.
import { pickWebsiteCycles } from "@/lib/db/repositories/summary-cycles";
import { websiteExcludedUnits, summaryUnitFlagsAvailable } from "@/lib/db/repositories/summary-settings";
import {
  summaryWebsiteAggregates, summaryWebsiteSubKpis, summaryWebsitePromptTopics,
  summaryWebsiteSourceComposition, summaryWebsiteGeoCompetition, summaryWebsiteCitationAccuracy,
} from "@/lib/db/repositories/summary-website-aggregates";
import { getDb } from "@/lib/db";
import { sql } from "drizzle-orm";

const rows = (await getDb().execute(sql`
  SELECT scope_project_id::text AS id FROM website_sites
  WHERE scope_project_id IS NOT NULL ORDER BY 1`)) as unknown as Array<{ id: string }>;
const ids = rows.map((r) => r.id);
console.log(`website projects: ${ids.length}`);

const pick = await pickWebsiteCycles(ids);
if (!pick) { console.log("pickWebsiteCycles → null"); process.exit(0); }
console.log(`cycles: ${pick.cycles.length}, missing: ${pick.missingProjectIds.length}`);

const scope = {
  cycles: pick.cycles,
  projectIds: pick.cycles.map((c) => c.projectId),
  filters: {},
  ownedBasePrefixes: [] as string[],
  unitFlags: await summaryUnitFlagsAvailable(),
  excludedUnits: await websiteExcludedUnits(),
};
console.log(`unitFlags=${scope.unitFlags} excluded=${JSON.stringify(scope.excludedUnits)}`);

const jobs: Array<[string, () => Promise<unknown>]> = [
  ["aggregates", () => summaryWebsiteAggregates(scope as never)],
  ["subKpis", () => summaryWebsiteSubKpis(scope as never)],
  ["promptTopics", () => summaryWebsitePromptTopics(scope as never)],
  ["sourceComposition", () => summaryWebsiteSourceComposition(scope as never)],
  ["geoCompetition", () => summaryWebsiteGeoCompetition(scope as never)],
  ["citationAccuracy", () => summaryWebsiteCitationAccuracy(scope as never)],
];
for (const [name, fn] of jobs) {
  const t = Date.now();
  try { await fn(); console.log(`${name.padEnd(20)} ${Date.now() - t} ms  OK`); }
  catch (e) { console.log(`${name.padEnd(20)} ${Date.now() - t} ms  FAIL ${(e as Error).message.slice(0, 300)}`); }
}
process.exit(0);
