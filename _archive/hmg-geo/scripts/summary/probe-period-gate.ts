/**
 * 기간 게이트 라이브 판정 — 쓰기 0, 읽기만 (PR③ F1 수리 확인).
 *
 * 검증자와 같은 방식으로 `resolveGlobalSummaryRouteBase(period)` · 웹사이트 동일을
 * 그대로 태우고, 폴백이면 **왜** 인지까지 창 안 회차를 분해해 찍는다.
 *
 * 사용:
 *   bash (내부 작업 파일) <워크트리> \
 *     npx tsx --tsconfig scripts/summary/tsconfig.json scripts/summary/probe-period-gate.ts
 */
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  resolveGlobalSummaryRouteBase,
  resolveWebsiteSummaryRouteBase,
  summaryRouteHeaderValue,
} from "@/lib/summary/read/gate";
import { pickCyclesInRange } from "@/lib/db/repositories/summary-cycles";
import { isGeneratorSkipped } from "@/lib/summary/read/cycle-set";
import { ANALYSIS_GAP_MAX } from "@/lib/summary/read/analysis-gap";

/* eslint-disable no-console */
const log = console.log;

const WINDOW_DAYS = 91;
const from = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
const ROOT = process.env.SCOPE_ROOT_PROJECT_ID ?? "be28fe15-c743-4a88-abb8-182b25602812";

async function websiteProjectIds(): Promise<string[]> {
  const rows = (await getDb().execute(sql`
    SELECT DISTINCT project_id::text AS id FROM summary_cycles WHERE surface = 'website'
  `)) as unknown as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

async function breakdown(surface: "global" | "website", ids: string[]) {
  const rows = (await pickCyclesInRange({ surface, projectIds: ids, dateFrom: from })) ?? [];
  const skipped = rows.filter(isGeneratorSkipped);
  const skippedIds = new Set(skipped.map((r) => r.cycleId));
  const holes = rows.filter(
    (r) => !r.renderable && r.status !== "open" && r.status !== "generating"
      && !r.pending && !skippedIds.has(r.cycleId),
  );
  const usable = rows.filter((r) => r.renderable && r.generationId);
  const byStatus = new Map<string, number>();
  for (const h of holes) byStatus.set(h.status, (byStatus.get(h.status) ?? 0) + 1);
  log(`  창(${from}~) 회차 ${rows.length} · 발행 ${usable.length}`
    + ` · skipped ${skipped.length} · 구멍 ${holes.length}`
    + (holes.length ? ` [${[...byStatus].map(([k, v]) => `${k}:${v}`).join(" ")}]` : ""));
  if (skipped.length) {
    const nullGap = skipped.filter((r) => r.analysisGapRatio == null);
    log(`  skipped ${skipped.length} = 갭>${ANALYSIS_GAP_MAX} ${skipped.length - nullGap.length}`
      + ` + 갭 null(생성기 3VL 미선택) ${nullGap.length}`);
    if (nullGap.length) {
      const anchors = [...new Set(nullGap.map((r) => r.cycleAnchorAt.slice(0, 10)))].sort();
      const noMembers = nullGap.filter((r) => r.expectedUnits == null && r.completedUnits == null);
      log(`  갭 null 앵커: ${anchors.join(", ")}`
        + ` · 카운터 미계산(units 둘 다 NULL) ${noMembers.length}/${nullGap.length}`);
    }
  }
  log(`  anchors ${new Set(usable.map((r) => r.cycleAnchorAt.slice(0, 10))).size}`
    + ` · weeks ${new Set(usable.map((r) => r.cycleWeek)).size}`);
}

async function main() {
  log(`창 = 최근 ${WINDOW_DAYS}일(${from} ~)\n`);

  log("── 글로벌 (period) ──");
  const g = await resolveGlobalSummaryRouteBase(ROOT, { dateFrom: from }, { mode: "period" });
  log(`  판정: ${summaryRouteHeaderValue(g)}`);
  await breakdown("global", [ROOT]);

  const ids = await websiteProjectIds();
  log(`\n── 웹사이트 (period) · 프로젝트 ${ids.length} ──`);
  const w = await resolveWebsiteSummaryRouteBase(ids, { dateFrom: from }, { mode: "period" });
  log(`  판정: ${summaryRouteHeaderValue(w)}`);
  await breakdown("website", ids);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
