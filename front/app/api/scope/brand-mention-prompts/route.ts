import { NextRequest, NextResponse } from "next/server";
import {
  fetchStandardBrandMentionPrompts,
  fetchWebsiteBrandMentionPrompts,
  UnauthorizedError,
} from "@/lib/scope/server";
import { readStandardFilters } from "@/components/dash/standard-filters";
import { readProjectCustomFieldFiltersRaw } from "@/components/dash/project-custom-field-filters";
import { getSession } from "@/lib/auth/session";
import { cachedMembership, cachedProjectById } from "@/lib/db/repositories/request-cache";
import { hghErrorResponse, isHghApiError } from "@/lib/hgh/errors";
import { isAnalysisApi } from "@/lib/hgh/adapters/filters";
import {
  drilldownGate,
  drilldownTarget,
  gateErrorResponse,
  isBadFilterError,
  isForbiddenError,
  loadBrandMentionPrompts,
  type BrandTarget,
  type GateResult,
  type LegacyProjectAllowed,
} from "@/lib/hgh/adapters/drilldown";

// BFF for the mention drilldown's 프롬프트 tab: the per-brand prompt list (with
// answer refs) for one mentioned brand. Fetched lazily when a brand row expands
// (2026-07-08) — the main mentions aggregate no longer embeds perBrandPrompts
// because it was 99.9% of a 12.4MB payload that blew Next.js's 2MB cache limit,
// so the cached KPI/table stays slim and each brand's drilldown loads on demand.
// Auth/audit/scope run in fetchStandardBrandMentionPrompts / fetchWebsite... —
// exactly the same contract as /api/scope/brand-citations.
//
// The brand selector is `mentionBrand` (the mentioned brand), NOT `brand`
// (the prompt-brand facet readStandardFilters parses) — keeping them distinct
// avoids the mention brand leaking in as a prompt-taxonomy filter.
//
// `surface=website` routes to the website-scoped project ids (same remap as
// brand-citations); otherwise the standard root. Session scope is passed so
// region/brand isolation applies (2026-07-08 security parity).
//
// Unit U6: gate on both sources first (session 401, place gate 403, project page gate 404:
// lib/hgh/adapters/drilldown.ts drilldownGate). Source (D8) HGH_SOURCE_<G2|G3|G6> by surface.
// api -> GET /v1/mentions/prompts mode=brand in one request (up to 2,000 prompts): a competitor row
// by name (mention_brand, BG-17), the own row by own=1 (+ ownCode=<brand code> for one brand of a
// split perspective, D13). projectId selects the project surface (the project page drilldown is
// lazy on the api source). {prompts} as before, plus `total` only when the cap cut the list. A
// backend 403 answers 403 {prompts:[]} (an error for the tab, not "no prompts"); 404
// brand_not_found stays 200 {prompts:[]}. legacy -> the unchanged readers; a projectId there
// answers 404 {prompts:[]} (no project reader: the project page stays eager, and the readers would
// read the standard root).
export const dynamic = "force-dynamic";

const legacyProjectAllowed: LegacyProjectAllowed = async (id, user) => {
  const [project, membership] = await Promise.all([cachedProjectById(id), cachedMembership(id, user.id)]);
  if (!project) return false;
  return user.role === "admin" || membership?.status === "active";
};

const WEBSITE_GROUPS = ["geography", "language", "engine", "time", "source", "brand"] as const;

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const brand = q.get("mentionBrand");
  if (!brand) {
    return NextResponse.json({ error: "mentionBrand required" }, { status: 400 });
  }
  const target = drilldownTarget(q);
  if (!target) return NextResponse.json({ prompts: [] }, { status: 404 });
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let gate: GateResult;
  try {
    gate = await drilldownGate(session.user, target, legacyProjectAllowed);
  } catch (err) {
    return gateErrorResponse(err);
  }
  if (!gate.ok) return NextResponse.json({ prompts: [] }, { status: gate.status });

  // Same routing as drilldownTarget: projectId wins, then ?surface=website.
  const isWebsite = !target.projectId && q.get("surface") === "website";
  const sp: Record<string, string> = {};
  q.forEach((v, k) => {
    sp[k] = v;
  });

  if (isAnalysisApi("analysis", target.surface)) {
    const isProject = target.surface === "project";
    const filters = isProject
      ? { ...readStandardFilters(sp), customFieldFilters: readProjectCustomFieldFiltersRaw(sp) }
      : readStandardFilters(sp, session.user.scope, isWebsite ? WEBSITE_GROUPS : undefined, isWebsite ? "website" : "standard");
    const own = q.get("own") === "1";
    const ownCode = q.get("ownCode");
    const brandTarget: BrandTarget = own ? { own: true, ...(ownCode ? { ownBrandCode: ownCode } : {}) } : { mentionBrand: brand };
    try {
      const list = await loadBrandMentionPrompts(
        filters,
        {
          surface: target.surface,
          projectId: target.projectId,
          scope: isProject ? null : session.user.scope,
          customFields: filters.customFieldFilters,
        },
        brandTarget,
      );
      return NextResponse.json(list);
    } catch (err) {
      if (isHghApiError(err) && err.status === 401) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
      if (isForbiddenError(err)) return NextResponse.json({ prompts: [] }, { status: 403 });
      if (isBadFilterError(err)) return NextResponse.json({ prompts: [] }, { status: 400 });
      return hghErrorResponse(err);
    }
  }

  // Legacy has no project reader here: the unchanged readers below read the standard root, so a
  // project request would serve standard data behind the project gate (U6 verification D1: a
  // project-only menu account passed the project gate and read the standard root). The legacy
  // project page is eager and never calls this route, so the project surface ends here.
  if (target.surface === "project") return NextResponse.json({ prompts: [] }, { status: 404 });

  // website 표면은 노출 축 allowlist 도 페이지와 동일하게 (brand-citations 와 짝).
  const rawFilters = readStandardFilters(
    sp,
    session.user.scope,
    isWebsite ? WEBSITE_GROUPS : undefined,
    isWebsite ? "website" : "standard",
  );
  // 답변분석 드릴다운 — 본문 카드·표와 같은 '기간 내 누적' 의미론을 써야
  // 숫자가 어긋나지 않는다 (2026-09-04 기획 수정).
  const filters = isWebsite
    ? { ...rawFilters, websiteCountry: rawFilters.region, region: undefined, cumulative: true }
    : { ...rawFilters, cumulative: true };
  try {
    const prompts = isWebsite
      ? await fetchWebsiteBrandMentionPrompts(brand, filters)
      : await fetchStandardBrandMentionPrompts(brand, filters);
    return NextResponse.json({ prompts });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    throw err;
  }
}
