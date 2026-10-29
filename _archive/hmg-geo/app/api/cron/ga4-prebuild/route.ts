import { requireCronSecret } from "@/lib/cron-auth";
import { getAllMappedMarkets } from "@/lib/ga4/property-map";
import {
  getAiTrafficConversionKpi,
  getAiConversionLive,
} from "@/lib/ga4/conversion";

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
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request): Promise<Response> {
  const denied = requireCronSecret(req);
  if (denied) return denied;
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
    at: new Date().toISOString(),
  });
}
