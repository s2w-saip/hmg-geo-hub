import { NextRequest, NextResponse } from "next/server";
import {
  fetchStandardBrandMentionPrompts,
  fetchWebsiteBrandMentionPrompts,
  UnauthorizedError,
} from "@/lib/scope/server";
import { readStandardFilters } from "@/components/dash/standard-filters";
import { getSession } from "@/lib/auth/session";

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
export async function GET(req: NextRequest) {
  const brand = req.nextUrl.searchParams.get("mentionBrand");
  if (!brand) {
    return NextResponse.json({ error: "mentionBrand required" }, { status: 400 });
  }
  const isWebsite = req.nextUrl.searchParams.get("surface") === "website";
  const sp: Record<string, string> = {};
  req.nextUrl.searchParams.forEach((v, k) => {
    sp[k] = v;
  });
  const session = await getSession();
  // website 표면은 노출 축 allowlist 도 페이지와 동일하게 (brand-citations 와 짝).
  const rawFilters = readStandardFilters(
    sp,
    session?.user.scope,
    isWebsite
      ? ["geography", "language", "engine", "time", "source", "brand"]
      : undefined,
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
