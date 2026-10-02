import { NextRequest, NextResponse } from "next/server";
import {
  fetchStandardAnswerBody,
  fetchProjectAnswerBody,
  fetchWebsiteAnswerBody,
  UnauthorizedError,
} from "@/lib/scope/server";
import { readStandardFilters } from "@/components/dash/standard-filters";
import { getSession } from "@/lib/auth/session";
import { cachedMembership, cachedProjectById } from "@/lib/db/repositories/request-cache";
import { hghErrorResponse, isHghApiError } from "@/lib/hgh/errors";
import { isAnalysisApi } from "@/lib/hgh/adapters/filters";
import { drilldownGate, drilldownTarget, type LegacyProjectAllowed } from "@/lib/hgh/adapters/drilldown";
import { loadAnswerDetail } from "@/lib/hgh/adapters/answers";

// BFF passthrough for a single AI answer body, looked up by job_id (the id the
// mention answer modal already holds on each answer ref). The browser never
// talks to scope directly; auth/audit run server-side in fetchStandardAnswerBody
// (scope-gateway spec). Body is fetched per click (lazy), never prefetched into
// the mention aggregate.
//
// 당사 배지 단위 컨텍스트 (2026-07-03 결정: 모달도 KPI와 동일 규칙):
//  - 모달이 현재 화면의 URL 필터를 그대로 전달 → readStandardFilters가 계정
//    스코프(brand 락 포함)로 해석.
//  - 프로젝트 화면이면 ?projectId= 도 전달 → 서버가 project.brand를 조회해
//    contextBrand로 주입 (클라이언트는 프로젝트를 지목만 할 뿐, 값은 서버 조회
//    — 위조해도 다른 프로젝트의 "표시 기준"이 될 뿐 데이터 접근과 무관).
//
// Gate (unit U6, both sources, before any read): session (401 {error: "unauthorized"}), the
// (dash) place gate of the screen family (403 {available: false}) and, on a project, the project
// page gate (404 {available: false}): lib/hgh/adapters/drilldown.ts drilldownGate.
// Source (D8): HGH_SOURCE_<G2|G3|G6> by surface. api -> GET /v1/answers/{job_id}
// (lib/hgh/adapters/answers.ts: 404/403/422 -> {available: false}, 401 -> 401).
export const dynamic = "force-dynamic";

const legacyProjectAllowed: LegacyProjectAllowed = async (id, user) => {
  const [project, membership] = await Promise.all([cachedProjectById(id), cachedMembership(id, user.id)]);
  if (!project) return false;
  return user.role === "admin" || membership?.status === "active";
};

export async function GET(req: NextRequest) {
  const jobId = req.nextUrl.searchParams.get("jobId");
  if (!jobId) {
    return NextResponse.json({ error: "jobId required" }, { status: 400 });
  }
  const target = drilldownTarget(req.nextUrl.searchParams);
  if (!target) return NextResponse.json({ available: false }, { status: 404 });
  try {
    const session = await getSession();
    if (!session) throw new UnauthorizedError();
    const gate = await drilldownGate(session.user, target, legacyProjectAllowed);
    if (!gate.ok) return NextResponse.json({ available: false }, { status: gate.status });
    const sp: Record<string, string> = {};
    req.nextUrl.searchParams.forEach((v, k) => {
      sp[k] = v;
    });
    const projectId = target.projectId ?? null;
    // Same routing as drilldownTarget: projectId wins, then ?surface=website.
    const isWebsite = !target.projectId && req.nextUrl.searchParams.get("surface") === "website";
    // 프로젝트 표면은 프로파일 스코프 미주입 (signal-prompts 와 동일 근거) —
    // 스코프 계정의 region 락이 스코프 밖 시장을 측정하는 프로젝트의 답변
    // 본문을 available:false 로 오차단했다. 접근 게이트는 fetchProjectAnswerBody
    // 의 assertProjectInScope + run 소속 게이트가 담당한다.
    const scope = projectId ? undefined : session.user.scope;
    const rawFilters = readStandardFilters(sp, scope, undefined, isWebsite ? "website" : "standard");

    if (isAnalysisApi("analysis", target.surface)) {
      const body = await loadAnswerDetail({
        jobId,
        surface: target.surface,
        filters: rawFilters,
        scope: scope ?? null,
      });
      return NextResponse.json(body);
    }

    // 웹사이트 표면의 지오 축 리맵 — 형제 드릴다운 API 3종(brand-citations /
    // brand-mention-prompts / signal-prompts)과 website/page.tsx 가 이미 하는 것과
    // 동일하다. 이 라우트에만 빠져 있었다(2026-09-04 고객 리포트: Website >
    // Mention 에서 "AI 실제 원문 답변이 보이지 않습니다").
    //
    // 왜 필요한가: 웹사이트의 지오 축은 **사이트 국가**(website_sites.country_code)
    // 이고 `worldwide`·`EU`·`MIDDLEEAST` 같은 가상 코드를 갖는다. 반면 답변의
    // `scope_answers.region` 은 **측정 로케일**(실 ISO)이다 — 실측(2026-09-04):
    // Genesis worldwide 사이트의 답변 region 은 전부 KR/US 다. 리맵 없이 넘기면
    // getMirrorAnswerBody 의 IDOR 게이트가 `region IN ('worldwide')` 로 걸려
    // **모든 답변이 available:false**(= 본문 미수집 안내문)가 된다.
    // 접근 게이트는 fetchWebsiteAnswerBody 의 run project id 소속이 담당하므로
    // region 을 비워도 방어 강도는 그대로다.
    const filters =
      isWebsite && !projectId
        ? { ...rawFilters, websiteCountry: rawFilters.region, region: undefined }
        : rawFilters;
    // 표면별 게이트 (2026-08-07): 프로젝트/웹사이트 프롬프트는 표준 카탈로그 밖
    // (brand NULL)이라 표준 brand 게이트가 비admin 을 오차단했다. 프로젝트는
    // fetchProjectAnswerBody 가 접근 검증(assertProjectInScope)+run 게이트+
    // contextBrand 주입을 함께 수행한다 (종전 route 의 미검증 projectId 조회보다
    // 강한 검증).
    const body = projectId
      ? await fetchProjectAnswerBody(projectId, jobId, filters)
      : isWebsite
        ? await fetchWebsiteAnswerBody(jobId, filters)
        : await fetchStandardAnswerBody(jobId, filters);
    // null = mock / root unset → no body surface at all.
    if (!body) return NextResponse.json({ available: false });
    return NextResponse.json(body);
  } catch (err) {
    if (err instanceof UnauthorizedError || (isHghApiError(err) && err.status === 401)) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (isHghApiError(err)) return hghErrorResponse(err);
    throw err;
  }
}
