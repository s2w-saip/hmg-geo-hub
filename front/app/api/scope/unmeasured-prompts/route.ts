import { NextRequest, NextResponse } from "next/server";
import { fetchStandardUnmeasuredPrompts, UnauthorizedError } from "@/lib/scope/server";
import { readStandardFilters } from "@/components/dash/standard-filters";
import { getSession } from "@/lib/auth/session";
import { hghErrorResponse, isHghApiError } from "@/lib/hgh/errors";
import { canReadAnalysis, isAnalysisApi } from "@/lib/hgh/adapters/filters";
import { isBadFilterError, loadUnmeasuredPrompts } from "@/lib/hgh/adapters/drilldown";

// BFF — 측정 개요 카드의 "미측정 프롬프트" 모달(2026-09-02 피그마 1:1, 제품 결정).
// 글로벌(표준) 표면 전용: 적용(카탈로그) − 측정(스냅샷 답변) 차집합을 lazy fetch 한다.
// 필터 파라미터는 화면 URL 그대로 실려 오고, 스코프는 세션에서 주입(readStandardFilters).
//
// Unit U6: the (dash) place gate of the global answer-analysis screens runs first on both
// sources (403 {result: null}; the dialog shows its error state). Source (D8) HGH_SOURCE_G2.
// api -> GET /v1/kpi/unmeasured-prompts (BG-04: same window, filters and predicate as the
// summary card's applied − measured, 200 rows, meta.page.total = the count before the cap).
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const sp: Record<string, string> = {};
  req.nextUrl.searchParams.forEach((v, k) => {
    sp[k] = v;
  });
  try {
    const session = await getSession();
    if (!session) throw new UnauthorizedError();
    if (!canReadAnalysis(session.user, "analysis", "global")) {
      return NextResponse.json({ result: null }, { status: 403 });
    }
    if (isAnalysisApi("analysis", "global")) {
      const filters = readStandardFilters(sp, session.user.scope);
      try {
        const result = await loadUnmeasuredPrompts(filters, { surface: "global", scope: session.user.scope });
        return NextResponse.json({ result });
      } catch (err) {
        if (isBadFilterError(err)) return NextResponse.json({ result: null }, { status: 400 });
        throw err;
      }
    }
    // 이 모달을 여는 두 화면(답변분석 언급·인용)은 둘 다 `cumulative: true` 다.
    // 카드의 "미측정" 숫자는 그 화면에서 누적 모집단으로 계산되므로, 목록도 같은
    // 의미론이어야 모달 `total` 과 카드 값이 일치한다(2026-09-16).
    const filters = { ...readStandardFilters(sp, session.user.scope), cumulative: true };
    const result = await fetchStandardUnmeasuredPrompts(filters);
    return NextResponse.json({ result });
  } catch (err) {
    if (err instanceof UnauthorizedError || (isHghApiError(err) && err.status === 401)) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (isHghApiError(err)) return hghErrorResponse(err);
    throw err;
  }
}
