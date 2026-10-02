import { NextRequest, NextResponse } from "next/server";
import { fetchBrandCitations, fetchWebsiteBrandCitations, UnauthorizedError } from "@/lib/scope/server";
import { readStandardFilters } from "@/components/dash/standard-filters";
import { readProjectCustomFieldFiltersRaw } from "@/components/dash/project-custom-field-filters";
import { getSession } from "@/lib/auth/session";
import { cachedMembership, cachedProjectById } from "@/lib/db/repositories/request-cache";
import { hghErrorResponse, isHghApiError } from "@/lib/hgh/errors";
import { canReadAnalysis, isAnalysisApi } from "@/lib/hgh/adapters/filters";
import {
  drilldownGate,
  drilldownTarget,
  gateErrorResponse,
  isBadFilterError,
  loadBrandCitationDetail,
  loadBrandCitationDomains,
  type GateResult,
  type LegacyProjectAllowed,
} from "@/lib/hgh/adapters/drilldown";

// BFF for the mention drilldown's 인용출처 tab: the citation domains for answers
// where a brand was mentioned. Fetched lazily when a brand row's tab opens (so
// the mention aggregate stays light). Auth/audit run in fetchBrandCitations/
// fetchWebsiteBrandCitations (scope-gateway). The current dimension filters
// ride along as query params so the per-brand domains match the filtered
// mention view.
//
// NOTE: the brand selector is `mentionBrand`, NOT `brand` — `brand` is the
// prompt-brand facet that readStandardFilters parses; keeping them distinct
// avoids the mention brand leaking in as a prompt-taxonomy filter.
//
// `surface=website` (sent by mentions-drilldown.tsx when rendered under the
// website mention page) routes to the website-scoped project ids instead of
// the standard root — same data source as the rest of website answer-analysis
// (2026-07-06 fix). geography→websiteCountry remap mirrors website/page.tsx's
// server-component logic, which this client-side fetch bypasses.
//
// Unit U6: gate on both sources first (session 401, place gate 403, project page gate 404:
// drilldownGate). Source (D8) HGH_SOURCE_<G2|G3|G6> by surface.
//   api, list:   GET /v1/citations/domains?mention_brand=<name> read to the end -> {domains}
//                (rows carry skey; urls/promptList empty until a row opens)
//   api, &skey=: GET /v1/citations/domains/{skey}?mention_brand=<name> -> {urls, promptList}
//                (citation-domain-table.tsx loads it when a row opens, 3.5 #5)
//   legacy:      the unchanged readers (rows carry urls/promptList; no detail call, skey -> 400).
//                projectId reads the standard root there, as before (the project surface is api
//                only: U6-N11), so it also needs the standard place gate (403 {domains:[]})
export const dynamic = "force-dynamic";

const legacyProjectAllowed: LegacyProjectAllowed = async (id, user) => {
  const [project, membership] = await Promise.all([cachedProjectById(id), cachedMembership(id, user.id)]);
  if (!project) return false;
  return user.role === "admin" || membership?.status === "active";
};

const WEBSITE_GROUPS = ["geography", "language", "engine", "time", "source", "brand"] as const;
const SKEY_MAX = 512;

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const brand = q.get("mentionBrand");
  if (!brand) {
    return NextResponse.json({ error: "mentionBrand required" }, { status: 400 });
  }
  const skey = q.get("skey");
  if (skey !== null && (skey === "" || skey.length > SKEY_MAX)) {
    return NextResponse.json({ error: "invalid skey" }, { status: 400 });
  }
  const target = drilldownTarget(q);
  if (!target) return NextResponse.json({ domains: [] }, { status: 404 });
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let gate: GateResult;
  try {
    gate = await drilldownGate(session.user, target, legacyProjectAllowed);
  } catch (err) {
    return gateErrorResponse(err);
  }
  if (!gate.ok) {
    return NextResponse.json(skey !== null ? { urls: [], promptList: [] } : { domains: [] }, { status: gate.status });
  }

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
    const ctx = {
      surface: target.surface,
      projectId: target.projectId,
      scope: isProject ? null : session.user.scope,
      customFields: filters.customFieldFilters,
    };
    try {
      if (skey !== null) return NextResponse.json(await loadBrandCitationDetail(filters, ctx, brand, skey));
      return NextResponse.json({ domains: await loadBrandCitationDomains(filters, ctx, brand) });
    } catch (err) {
      if (isHghApiError(err) && err.status === 401) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
      if (isBadFilterError(err)) {
        return NextResponse.json(skey !== null ? { urls: [], promptList: [] } : { domains: [] }, { status: 400 });
      }
      return hghErrorResponse(err);
    }
  }
  if (skey !== null) return NextResponse.json({ error: "skey is served by the api source only" }, { status: 400 });
  // The legacy readers read the standard root even for a projectId (U6-N11), so the data surface
  // is global there: the standard place gate must hold as well (U6 verification D1: a project-only
  // menu account passed the project gate and read the standard root).
  if (target.surface === "project" && !canReadAnalysis(session.user, "analysis", "global")) {
    return NextResponse.json({ domains: [] }, { status: 403 });
  }

  // 2026-07-08 보안: 세션 스코프를 넘겨야 region/brand 격리가 걸린다. 이전엔
  // scope 없이 호출해 region 스코프 계정의 인용출처 탭이 전 권역 데이터를 봤음
  // (answer route와 동일 계약 — readStandardFilters(sp, scope)).
  // website 표면은 노출 축 allowlist 도 페이지와 동일하게 — 숨은 축 URL 파라미터가
  // 드릴다운에만 적용돼 표와 어긋나는 것을 방지 (mention 페이지의 누수 수정과 짝).
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
    const domains = isWebsite
      ? await fetchWebsiteBrandCitations(brand, filters)
      : await fetchBrandCitations(brand, filters);
    return NextResponse.json({ domains });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    throw err;
  }
}
