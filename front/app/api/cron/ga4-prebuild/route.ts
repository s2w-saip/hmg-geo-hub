import { requireCronSecret } from "@/lib/cron-auth";
import { getAllMappedMarkets } from "@/lib/ga4/property-map";
import {
  getAiTrafficConversionKpi,
  getAiConversionLive,
} from "@/lib/ga4/conversion";
import {
  crossCheckCycleChain,
  type CycleChainCrossCheck,
} from "@/lib/summary/health/cross-check";

// GA4 cache warmer. Hits every mapped market with (KPI 28d) + (Live 90d) so
// the unstable_cache cells in lib/ga4/conversion are populated before the
// first user lands. Without this, a user opening /dashboard cold pays the
// GA4 round-trip in the request.
//
// Rollup KPI cells are scope-shaped (key = sorted mapped property ids), so
// prebuild only warms the single-property paths. The first region/HQ visit
// after rollup TTL still pays one cold round, but its underlying KPI cells
// are warm — the slowest path stays bounded.
//
// Guarded by CRON_SECRET (Vercel Cron sends Authorization: Bearer …).
// /api/cron/* is outside the (dash) auth area (middleware excludes /api).
//
// ── 곁다리: 회차 사슬 **교차 확인** (2026-09-16) ───────────────────────────
// 이 라우트는 GA4 캐시 워머다. 회차와 아무 상관이 없다 — 그것이 정확히 여기에
// 한 줄을 두는 이유다. 회차 사슬 감시(`/api/cron/cycle-chain-watch`, 6시간)가
// **아예 안 도는 경우는 그 감시 자신이 못 잡는다**(크론 등록이 지워졌다, 라우트가
// 500 을 낸다, 배포가 그 파일을 빼먹었다). alert-routing 룰 7 이 요구하는
// "다른 스케줄에 한 줄" 이고, scope 리포 `ontology-health.yml` 의 카탈로그 냉각
// 교차감시가 선례다.
//
// 성격이 다르다는 점이 중요하다: 주 감시는 **표면화**(Slack·이슈)가 목적이고,
// 이 줄은 **독립 관측자**다. 둘 다 같은 판정 함수를 쓰되 목적지가 다르다 —
// 여기서는 제목이 다른 GitHub Issue 하나로만 간다(라이브 채널을 두 곳에서 울리면
// 사람이 어느 쪽이 정본인지 모른다). 주 감시가 살아 있으면 이 이슈는 이미
// 열려 있는 적체 이슈와 함께 뜨고, 주 감시가 죽었으면 **이것만** 뜬다.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request): Promise<Response> {
  const denied = requireCronSecret(req);
  if (denied) return denied;
  // 교차 확인을 **먼저** 돌린다. GA4 워머가 예산을 다 써서 죽으면 뒷단이 같이
  // 죽는다 — sync-mirror 가 2026-09-14 에 그 방식으로 관제를 굶겼다(이슈 #262).
  // 스스로 throw 하지 않고 수 초 안에 끝난다(SQL 몇 문장 + 최대 이슈 1건).
  let cycleChainCrossCheck: CycleChainCrossCheck;
  try {
    cycleChainCrossCheck = await crossCheckCycleChain();
  } catch (err) {
    console.error("[cycle-chain/cross-check] 판정 실패:", err);
    cycleChainCrossCheck = {
      checked: false,
      severity: 0,
      alert: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
  const markets = await getAllMappedMarkets();
  const results: Array<{
    brand: string;
    country: string;
    kpiOk: boolean;
    liveOk: boolean;
  }> = [];
  for (const m of markets) {
    const [kpi, live] = await Promise.all([
      getAiTrafficConversionKpi(m.propertyId, 28),
      getAiConversionLive(m.propertyId, 90),
    ]);
    results.push({
      brand: m.brand,
      country: m.country,
      kpiOk: kpi !== null,
      liveOk: live !== null,
    });
  }
  // Diagnostic: which GA4 envs the runtime can actually see.
  // Values themselves are NEVER exposed — only the presence boolean.
  // Helps tell "env not wired" from "env wired but GA4 call failed".
  const envSeen = {
    GA4_OAUTH_CLIENT_ID: Boolean(process.env.GA4_OAUTH_CLIENT_ID),
    GA4_OAUTH_CLIENT_SECRET: Boolean(process.env.GA4_OAUTH_CLIENT_SECRET),
    GA4_OAUTH_REFRESH_TOKEN: Boolean(process.env.GA4_OAUTH_REFRESH_TOKEN),
    GA4_PROPERTY_ID_KIA_IT: Boolean(process.env.GA4_PROPERTY_ID_KIA_IT),
    GA4_PROPERTY_ID: Boolean(process.env.GA4_PROPERTY_ID),
  };
  return Response.json({
    ok: true,
    refreshed: results.length,
    markets: results,
    envSeen,
    cycleChainCrossCheck,
    at: new Date().toISOString(),
  });
}
