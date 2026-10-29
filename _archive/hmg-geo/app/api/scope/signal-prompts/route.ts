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

// BFF — 감정 분포 / Mention 유형 카드의 세그먼트 드릴다운(2026-08-07 고객 피드백:
// "어떤 프롬프트에서 어떤 긍정·부정 표현이 발생했는지 확인 불가"). 클릭한 신호가
// 실제로 발생한 프롬프트 목록만 lazy fetch 하고, 각 행은 기존 답변 모달로 원문을
// 연다. 감정 판정 키워드 자체는 scope 가 제공하지 않아(별도 요청 트랙) 근거는
// 원문으로 확인하는 경로다.
//
// 표면 라우팅은 brand-citations / answer 라우트와 동일 규약:
//   projectId → 프로젝트(접근 검증 포함), surface=website → 웹사이트, 그 외 표준.
export async function GET(req: NextRequest) {
  const signal = req.nextUrl.searchParams.get("signal");
  if (!signal || !isSignalKey(signal)) {
    return NextResponse.json({ error: "valid signal required" }, { status: 400 });
  }
  const projectId = req.nextUrl.searchParams.get("projectId");
  const isWebsite = req.nextUrl.searchParams.get("surface") === "website";
  const sp: Record<string, string> = {};
  req.nextUrl.searchParams.forEach((v, k) => {
    sp[k] = v;
  });
  try {
    const session = await getSession();
    // 프로젝트 표면은 프로파일 스코프를 주입하지 않는다 — 프로젝트 프롬프트는
    // 표준 카탈로그 밖(prompts.brand NULL)이라 스코프 계정의 brand 하드락이
    // 전부 오차단해 Viewer 멤버의 감정·유형 드릴다운이 항상 빈 목록이 됐다
    // (2026-08-31 고객 피드백; /api/scope/answer 의 2026-08-06 수정과 같은 계열).
    // 접근 게이트는 fetchProjectSignalPrompts→assertProjectInScope(멤버십/
    // brand×country)가 담당 — 프로젝트 페이지 본문(readStandardFilters 무스코프)
    // 과 동일 계약이라 넓어지는 접근은 없다.
    const rawFilters = readStandardFilters(
      sp,
      projectId ? undefined : session?.user.scope,
      isWebsite ? ["geography", "language", "engine", "time", "brand"] : undefined,
    );
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
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    throw err;
  }
}
