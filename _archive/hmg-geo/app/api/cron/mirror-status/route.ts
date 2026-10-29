import { requireCronSecret } from "@/lib/cron-auth";
import { getMirrorStatus } from "@/lib/db/repositories/scope-aggregates";

// Mirror 상태 진단 — scope_answers의 누적 카운트와 측정 cadence를 한 번에
// 노출. trend chart가 "측정이 누적되는 중"으로 멈춰있을 때 mirror가 비어
// 있는지 / measured_at이 없는지 / distinct bucket이 1개뿐인지 가른다.
//
// Guarded by CRON_SECRET (fail-closed — lib/cron-auth.ts). 로컬 디버그도
// .env.local 에 CRON_SECRET 을 두고 Authorization: Bearer 헤더를 붙여 호출한다.
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: Request): Promise<Response> {
  const denied = requireCronSecret(req);
  if (denied) return denied;
  const s = await getMirrorStatus();
  // 진단: SCOPE_EXTRA_PROJECT_IDS 가 prod runtime 에 인식되는지 (값 자체는
  // 노출하지 않고, 등록 여부 + UUID 개수만).
  const extraRaw = process.env.SCOPE_EXTRA_PROJECT_IDS;
  const extraCount = extraRaw
    ? extraRaw.split(",").map((s) => s.trim()).filter(Boolean).length
    : 0;
  return Response.json({
    ok: true,
    envSeen: {
      SCOPE_ROOT_PROJECT_ID: Boolean(process.env.SCOPE_ROOT_PROJECT_ID),
      SCOPE_API_KEY: Boolean(process.env.SCOPE_API_KEY),
      SCOPE_EXTRA_PROJECT_IDS_count: extraCount,
    },
    answers: { total: s.totalAnswers, withMeasuredAt: s.measuredAnswers },
    cadence: {
      distinctWeeks: s.distinctWeeks,
      distinctDays: s.distinctDays,
      firstMeasuredAt: s.firstMeasuredAt,
      lastMeasuredAt: s.lastMeasuredAt,
    },
    side: {
      mentionRows: s.mentionRows,
      citationRows: s.citationRows,
      trackedMentionRows: s.trackedMentionRows,
    },
    brandSample: s.brandSample,
    trendWillRender: s.distinctWeeks >= 2,
    at: new Date().toISOString(),
  });
}
