import { NextRequest, NextResponse } from "next/server";
import {
  fetchStandardSignalPrompts,
  fetchWebsiteSignalPrompts,
  fetchProjectSignalPrompts,
  UnauthorizedError,
} from "@/lib/scope/server";
import { isSignalKey } from "@/lib/db/repositories/scope-aggregates";
import { readStandardFilters } from "@/components/dash/standard-filters";
import { readProjectCustomFieldFiltersRaw } from "@/components/dash/project-custom-field-filters";
import { getSession } from "@/lib/auth/session";
import { cachedMembership, cachedProjectById } from "@/lib/db/repositories/request-cache";
import { hghErrorResponse, isHghApiError } from "@/lib/hgh/errors";
import { isAnalysisApi } from "@/lib/hgh/adapters/filters";
import {
  drilldownGate,
  drilldownTarget,
  isBadFilterError,
  isSignalKeyApi,
  loadSignalPrompts,
  type LegacyProjectAllowed,
} from "@/lib/hgh/adapters/drilldown";

// BFF — 감정 분포 / Mention 유형 카드의 세그먼트 드릴다운(2026-08-07 고객 피드백:
// "어떤 프롬프트에서 어떤 긍정·부정 표현이 발생했는지 확인 불가"). 클릭한 신호가
// 실제로 발생한 프롬프트 목록만 lazy fetch 하고, 각 행은 기존 답변 모달로 원문을
// 연다. 감정 판정 키워드 자체는 scope 가 제공하지 않아(별도 요청 트랙) 근거는
// 원문으로 확인하는 경로다.
//
// 표면 라우팅은 brand-citations / answer 라우트와 동일 규약:
//   projectId → 프로젝트(접근 검증 포함), surface=website → 웹사이트, 그 외 표준.
//
// Unit U6: gate on both sources first (session 401, place gate 403, project page gate 404:
// drilldownGate). Source (D8) HGH_SOURCE_<G2|G3|G6> by surface. api -> GET /v1/mentions/prompts
// mode=signal (top 50 prompts, 6 answer references, the legacy reference shape).
// Body: {prompts} on both sources; the api source adds `total` (prompts before the cap) only when the
// cap cut the list (B008), and the dialog then shows its existing "{total}개 중 {shown}개 표시" line.
// The legacy readers answer the capped rows alone, so their body stays {prompts} (no line, as before).
export const dynamic = "force-dynamic";

const legacyProjectAllowed: LegacyProjectAllowed = async (id, user) => {
  const [project, membership] = await Promise.all([cachedProjectById(id), cachedMembership(id, user.id)]);
  if (!project) return false;
  return user.role === "admin" || membership?.status === "active";
};

const WEBSITE_GROUPS = ["geography", "language", "engine", "time", "brand"] as const;

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const signal = q.get("signal");
  if (!signal || !isSignalKey(signal) || !isSignalKeyApi(signal)) {
    return NextResponse.json({ error: "valid signal required" }, { status: 400 });
  }
  const target = drilldownTarget(q);
  if (!target) return NextResponse.json({ prompts: [] }, { status: 404 });
  const sp: Record<string, string> = {};
  q.forEach((v, k) => {
    sp[k] = v;
  });
  try {
    const session = await getSession();
    if (!session) throw new UnauthorizedError();
    const gate = await drilldownGate(session.user, target, legacyProjectAllowed);
    if (!gate.ok) return NextResponse.json({ prompts: [] }, { status: gate.status });
    const projectId = target.projectId ?? null;
    // Same routing as drilldownTarget: projectId wins, then ?surface=website.
    const isWebsite = !target.projectId && q.get("surface") === "website";
    // 프로젝트 표면은 프로파일 스코프를 주입하지 않는다 — 프로젝트 프롬프트는
    // 표준 카탈로그 밖(prompts.brand NULL)이라 스코프 계정의 brand 하드락이
    // 전부 오차단해 Viewer 멤버의 감정·유형 드릴다운이 항상 빈 목록이 됐다
    // (2026-08-31 고객 피드백; /api/scope/answer 의 2026-08-06 수정과 같은 계열).
    // 접근 게이트는 fetchProjectSignalPrompts→assertProjectInScope(멤버십/
    // brand×country)가 담당 — 프로젝트 페이지 본문(readStandardFilters 무스코프)
    // 과 동일 계약이라 넓어지는 접근은 없다.
    const rawFilters = readStandardFilters(
      sp,
      projectId ? undefined : session.user.scope,
      isWebsite ? WEBSITE_GROUPS : undefined,
      isWebsite ? "website" : "standard",
    );

    if (isAnalysisApi("analysis", target.surface)) {
      const filters = projectId ? { ...rawFilters, customFieldFilters: readProjectCustomFieldFiltersRaw(sp) } : rawFilters;
      try {
        // {prompts} or {prompts, total}: total only when the 50-row cap cut the list (B008).
        const list = await loadSignalPrompts(
          filters,
          {
            surface: target.surface,
            projectId: projectId ?? undefined,
            scope: projectId ? null : session.user.scope,
            customFields: filters.customFieldFilters,
          },
          signal,
        );
        return NextResponse.json(list);
      } catch (err) {
        if (isBadFilterError(err)) return NextResponse.json({ prompts: [] }, { status: 400 });
        throw err;
      }
    }

    // 프로젝트 표면은 커스텀 태그 축도 함께 — 카드가 태그 필터를 반영하도록
    // (태그 필터 적용 수정과 같은 계약).
    // 답변분석 드릴다운 — 본문과 같은 '기간 내 누적' 의미론 (2026-09-04).
    const filters = projectId
      ? { ...rawFilters, customFieldFilters: readProjectCustomFieldFiltersRaw(sp), cumulative: true }
      : isWebsite
        ? { ...rawFilters, websiteCountry: rawFilters.region, region: undefined, cumulative: true }
        : { ...rawFilters, cumulative: true };

    const prompts = projectId
      ? await fetchProjectSignalPrompts(projectId, signal, filters)
      : isWebsite
        ? await fetchWebsiteSignalPrompts(signal, filters)
        : await fetchStandardSignalPrompts(signal, filters);
    return NextResponse.json({ prompts });
  } catch (err) {
    if (err instanceof UnauthorizedError || (isHghApiError(err) && err.status === 401)) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (isHghApiError(err)) return hghErrorResponse(err);
    throw err;
  }
}
