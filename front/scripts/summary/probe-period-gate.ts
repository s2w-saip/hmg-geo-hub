/**
 * 기간 게이트 라이브 판정 — 쓰기 0, 읽기만 (PR③ F1 수리 확인).
 *
 * 검증자와 같은 방식으로 `resolveGlobalSummaryRouteBase(period)` · 웹사이트 동일을
 * 그대로 태우고, 폴백이면 **왜** 인지까지 창 안 회차를 분해해 찍는다.
 *
 * 사용:
 *   bash notes/hmg-db-exec.sh <워크트리> \
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
import {
  classifyCycleRange,
  isGeneratorSkipped,
  judgeCycleRange,
} from "@/lib/summary/read/cycle-set";
import { ANALYSIS_GAP_MAX } from "@/lib/summary/read/analysis-gap";

/* eslint-disable no-console */
const log = console.log;

const argv = process.argv.slice(2);
const arg = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const WINDOW_DAYS = Number(arg("days") ?? 91);
// `--from` 이 있으면 그것이 이긴다(화면이 실제로 보내는 창을 그대로 재현할 때).
const from = arg("from")
  ?? new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
const to = arg("to") ?? null;
const ROOT = process.env.SCOPE_ROOT_PROJECT_ID ?? "be28fe15-c743-4a88-abb8-182b25602812";

async function websiteProjectIds(): Promise<string[]> {
  const rows = (await getDb().execute(sql`
    SELECT DISTINCT project_id::text AS id FROM summary_cycles WHERE surface = 'website'
  `)) as unknown as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/**
 * ⚠️ 분류는 **판정과 같은 함수**로 한다(`classifyCycleRange`). 종전에는 술어를 손으로
 * 베껴 두 벌이 갈렸다: 하네스의 면제 목록에 `hidden` 이 빠져 있어 숨긴 회차를 **구멍으로**
 * 셌고, 판정은 폴백이 아닌데 하네스만 "구멍 1" 을 찍었다(2026-09-18 F5).
 * 최종 판정도 `judgeCycleRange` 를 직접 불러 찍는다: 하네스가 "왜" 를 설명할 때
 * 게이트와 다른 답을 내면 진단 도구가 아니라 오진 도구다.
 */
async function breakdown(surface: "global" | "website", ids: string[]) {
  const rows = (await pickCyclesInRange({ surface, projectIds: ids, dateFrom: from, dateTo: to })) ?? [];
  const { exempt, holes, usable } = classifyCycleRange(rows);
  // 면제 안에서 "생성기가 안 뽑는 것" 만 따로 센다(숨김은 아래 줄에서 따로 보고한다).
  const skipped = exempt.filter(isGeneratorSkipped);
  const hiddenRows = exempt.filter((r) => r.hidden);
  const byStatus = new Map<string, number>();
  for (const h of holes) byStatus.set(h.status, (byStatus.get(h.status) ?? 0) + 1);
  const judged = judgeCycleRange(surface, ids, rows);
  log(`  창(${from}~${to ?? ""}) 회차 ${rows.length} · 발행 ${usable.length}`
    + ` · skipped ${skipped.length} · 숨김 ${hiddenRows.length} · 구멍 ${holes.length}`
    + (holes.length ? ` [${[...byStatus].map(([k, v]) => `${k}:${v}`).join(" ")}]` : ""));
  log(`  judgeCycleRange: ${judged.ok
    ? `ok · cycles ${judged.set.cycles.length}`
      + ` · 인용 제외 ${judged.set.citationExcludedCycleIds?.length ?? 0}`
    : `fallback:${judged.reason}`}`);
  if (hiddenRows.length) {
    const byScope = new Map<string, number>();
    for (const h of hiddenRows) {
      const k = h.hiddenScope ?? "all";
      byScope.set(k, (byScope.get(k) ?? 0) + 1);
    }
    log(`  숨김 스코프: ${[...byScope].map(([k, v]) => `${k}:${v}`).join(" ")}`
      + " (citations 는 집합에 남고 인용 계열에서만 빠진다)");
  }
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
  log(`창 = ${from} ~ ${to ?? "지금"}\n`);

  log("── 글로벌 (period) ──");
  const g = await resolveGlobalSummaryRouteBase(ROOT, { dateFrom: from, dateTo: to }, { mode: "period" });
  log(`  판정: ${summaryRouteHeaderValue(g)}`);
  await breakdown("global", [ROOT]);

  const ids = await websiteProjectIds();
  log(`\n── 웹사이트 (period) · 프로젝트 ${ids.length} ──`);
  const w = await resolveWebsiteSummaryRouteBase(ids, { dateFrom: from, dateTo: to }, { mode: "period" });
  log(`  판정: ${summaryRouteHeaderValue(w)}`);
  await breakdown("website", ids);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
