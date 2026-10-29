import { NextRequest, NextResponse } from "next/server";
import { fetchBrandCitations, fetchWebsiteBrandCitations, UnauthorizedError } from "@/lib/scope/server";
import { readStandardFilters } from "@/components/dash/standard-filters";
import { getSession } from "@/lib/auth/session";

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
  // 2026-07-08 보안: 세션 스코프를 넘겨야 region/brand 격리가 걸린다. 이전엔
  // scope 없이 호출해 region 스코프 계정의 인용출처 탭이 전 권역 데이터를 봤음
  // (answer route와 동일 계약 — readStandardFilters(sp, scope)).
  const session = await getSession();
  // website 표면은 노출 축 allowlist 도 페이지와 동일하게 — 숨은 축 URL 파라미터가
  // 드릴다운에만 적용돼 표와 어긋나는 것을 방지 (mention 페이지의 누수 수정과 짝).
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
