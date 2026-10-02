import { Suspense } from "react";
import {
  fetchSelectableAnchorDates,
} from "@/lib/scope/server";
import { redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/section-card";
import { getSession } from "@/lib/auth/session";
import { canAccessRoute } from "@/lib/auth/route-policy";
import {
  listWebsitePromptsScoped,
  listMeasuredLanguages,
  listWebsiteBrands,
  listWebsiteCountries,
} from "@/lib/db/repositories/website-sites";
import { readStandardFilters } from "@/components/dash/standard-filters";
import { standardFilterKey } from "@/components/dash/standard-filters";
import { isWebsiteBrandGeoCode } from "@/lib/scope/website-virtual-geo";
import {
  WEBSITE_PROMPTS_PAGE_SIZE,
  readWebsitePromptQuery,
  websitePromptFilterGroups,
  type SearchParamsRecord,
} from "@/lib/website/prompt-query";
import type { DimensionGroup } from "@/components/dash/dimension-filter-panel";
import { AnswerAnalysisSkeleton } from "@/components/dash/section-skeleton";
import { WebsitePromptFilters } from "./_components/prompt-filters";
import { WebsitePromptTable } from "./_components/prompt-table";
import { isAnalysisApi } from "@/lib/hgh/adapters/filters";
import {
  listWebsitePromptsApi,
  loadWebsitePromptDates,
  loadWebsitePromptOptions,
  WEBSITE_PROMPTS_API_PAGE_SIZE,
} from "@/lib/hgh/adapters/catalog";
import { throwForPage } from "@/lib/hgh/errors";

// 웹사이트 > 프롬프트 (열람 전용) — "권역별 오피셜 사이트를 무엇으로 측정하는가".
//
// 표준 프롬프트 화면과의 차이:
//   - 소스가 website_prompts (xlsx 적재) — HMG 카탈로그 분류가 없고 대신
//     brand × country × language 축을 갖는다.
//   - 9,569행이라 서버 페이징/정렬 (표준은 2,431행 클라이언트 in-memory).
//   - 엔진·기간은 측정 렌즈 — 행을 거르지 않는다
//     (근거: listWebsitePromptsScoped 주석).
//
// 수정/생성 없음: 프롬프트 적재는 시드 스크립트 소관이고 이 화면은 조회 전용이다.
//
// 원천 스위치(결정 D8, U8): HGH_SOURCE_G3=api 면 lib/hgh/adapters/catalog.ts 가
// GET /v1/filters/options·/v1/filters/dates(옵션·달력)와 GET /v1/prompts?surface=website
// (목록, 키셋 커서 D5)를 부른다. 첫 렌더 호출 3개(D6).


export default async function WebsitePromptsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("website.prompts");

  const session = await getSession();
  if (!session) redirect(`/${locale}/login`);
  // DashLayout 서버 가드 위의 defense in depth (표준 prompts 페이지와 동일).
  if (!canAccessRoute(session.user.role, "/website/prompts")) {
    redirect(`/${locale}/website`);
  }

  const sp = await searchParams;
  const scope = session.user.scope;
  const isAdmin = session.user.role === "admin";
  // 노출 축은 내보내기 라우트와 **같은 함수**에서 파생한다 — 숨은 축 URL 파라미터
  // 누수 방지를 위해 필터 파싱에도 같은 목록이 들어간다(prompt-query.ts).
  const filterGroups: DimensionGroup[] = websitePromptFilterGroups(isAdmin);

  // 원천 스위치(D8): api 면 옵션·달력 2호출(목록 1호출과 합쳐 D6 3호출). legacy 는 원래
  // 경로 그대로다(옵션 3개 병렬 뒤 달력). 정적 가드(lib/period/anchor-axis-wiring.test.ts)가
  // 아래 legacy 달력 호출식을 이 파일에서 글자 그대로 찾는다.
  const fromApi = isAnalysisApi("prompts", "website");
  const api = fromApi ? await loadApiOptions() : null;
  const legacy = api ? null : await loadLegacyOptions();

  async function loadApiOptions() {
    try {
      const [options, selectableDates] = await Promise.all([loadWebsitePromptOptions(), loadWebsitePromptDates()]);
      return { ...options, selectableDates };
    } catch (e) {
      throwForPage(e, locale);
    }
  }

  async function loadLegacyOptions() {
    const [rawGeographyOptions, languageOptions, brandOptions] = await Promise.all([
      listWebsiteCountries(scope),
      listMeasuredLanguages(scope),
      // 브랜드 축 옵션은 **website_sites.brand 실데이터**다(정적 3사 목록이 아니라).
      // 이 화면의 브랜드 술어가 실제로 `ws.brand IN (…)` 이라서(website-sites.ts
      // ::websitePromptRowWhere) 사이트 브랜드가 그대로 옵션이 되는 것이 맞다.
      // 이렇게 해야 '현대 N'(website_sites.brand='Hyundai N')이 브랜드 축에 뜬다.
      listWebsiteBrands(scope),
    ]);
    // 현대 N 은 **브랜드 축으로** 고른다(제품 책임자 2026-09-16) — 지역 드롭다운의 가상
    // 코드(HYUNDAI-N)는 이 화면에서 내린다. 술어는 그대로 살아 있으므로
    // (websiteSiteGeoPred) 그 코드가 박힌 기존 링크·북마크는 계속 동작한다.
    const geographyOptions = rawGeographyOptions.filter((c) => !isWebsiteBrandGeoCode(c));
    return { geographyOptions, languageOptions, brandOptions };
  }

  return (
    <div className="flex animate-fade-in flex-col gap-6">
      <PageHeader title={t("title")} description={t("subtitle")} />
      {api ? (
        <WebsitePromptFilters
          scope={scope}
          geographyOptions={api.geographyOptions}
          languageOptions={api.languageOptions}
          brandOptions={api.brandOptions}
          isAdmin={isAdmin}
          selectableDates={api.selectableDates}
        />
      ) : legacy ? (
        <WebsitePromptFilters
          scope={scope}
          geographyOptions={legacy.geographyOptions}
          languageOptions={legacy.languageOptions}
          brandOptions={legacy.brandOptions}
          isAdmin={isAdmin}
          // 앵커 축(스펙 §5.1) — 웹사이트 표면. 이 지면은 필터를 URL 에서 직접 파싱하고
          // 달력 목록은 값 필터를 안 받으므로(게이트웨이 계약) 빈 필터로 부른다.
          selectableDates={await fetchSelectableAnchorDates("website", {}, "all")}
        />
      ) : null}
      <SectionCard title={t("title")}>
        {/* 필터/정렬/페이지가 바뀌면 key 가 바뀌어 스켈레톤이 다시 뜬다 —
            9,569행 질의가 수백 ms 걸릴 때 이전 페이지가 굳은 채 남지 않게. */}
        <Suspense
          key={suspenseKey(sp, scope, filterGroups)}
          fallback={<AnswerAnalysisSkeleton />}
        >
          {fromApi ? (
            <PromptDataApi sp={sp} scope={scope} isAdmin={isAdmin} locale={locale} />
          ) : (
            <PromptData sp={sp} scope={scope} isAdmin={isAdmin} />
          )}
        </Suspense>
      </SectionCard>
    </div>
  );
}

// 정렬/페이지/검색까지 포함한 Suspense 키 — standardFilterKey 는 필터 축만 덮는다.
function suspenseKey(
  sp: Record<string, string | string[] | undefined>,
  scope: Parameters<typeof readStandardFilters>[1],
  groups: DimensionGroup[],
): string {
  const raw = readStandardFilters(sp, scope, groups, "website");
  return [
    standardFilterKey(raw),
    one(sp.q) ?? "",
    one(sp.sort) ?? "",
    one(sp.dir) ?? "",
    one(sp.page) ?? "",
    one(sp.cursor) ?? "",
  ].join("|");
}

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

async function PromptData({
  sp,
  scope,
  isAdmin,
}: {
  sp: SearchParamsRecord;
  scope: Parameters<typeof readStandardFilters>[1];
  isAdmin: boolean;
}) {
  // 필터·정렬·페이지 파생은 내보내기 라우트와 **한 함수**를 공유한다 — 화면과
  // 엑셀이 다른 술어를 보게 되는 자리를 구조적으로 없앤다(prompt-query.ts).
  const { filters, sort, dir, page } = readWebsitePromptQuery(sp, scope, isAdmin);

  const result = await listWebsitePromptsScoped(scope, filters, {
    sort,
    dir,
    page,
    pageSize: WEBSITE_PROMPTS_PAGE_SIZE,
  });

  // 필터를 좁히면서 ?page 가 남아 범위를 넘길 수 있다(예: page=50 → 3페이지뿐).
  // 빈 화면 대신 마지막 페이지를 보여준다 — URL 을 쓰는 주체가 필터 패널/정렬/
  // 페이징으로 나뉘어 있어 "누군가 page 를 지워주겠지"에 기댈 수 없다.
  const pages = Math.max(1, Math.ceil(result.total / WEBSITE_PROMPTS_PAGE_SIZE));
  const settled =
    page > pages && result.total > 0
      ? await listWebsitePromptsScoped(scope, filters, {
          sort,
          dir,
          page: pages,
          pageSize: WEBSITE_PROMPTS_PAGE_SIZE,
        })
      : result;

  return (
    <WebsitePromptTable
      rows={settled.rows}
      total={settled.total}
      page={Math.min(page, pages)}
      pageSize={WEBSITE_PROMPTS_PAGE_SIZE}
      sort={sort}
      dir={dir}
    />
  );
}

// Backend API source (HGH_SOURCE_G3=api, unit U8): one keyset page (?cursor, D5) of GET
// /v1/prompts?surface=website with the same derivation as the export (readWebsitePromptQuery).
// ?page is only the label index the table writes next to the cursor; without a cursor, or when
// the cursor no longer fits (restarted), this is page 1 (known_diff U8-N13).
async function PromptDataApi({
  sp,
  scope,
  isAdmin,
  locale,
}: {
  sp: SearchParamsRecord;
  scope: Parameters<typeof readStandardFilters>[1];
  isAdmin: boolean;
  locale: string;
}) {
  const { filters, sort, dir, page, cursor } = readWebsitePromptQuery(sp, scope, isAdmin);
  try {
    const res = await listWebsitePromptsApi({ filters, sort, dir }, scope ?? null, cursor);
    const shownPage = cursor && !res.restarted ? page : 1;
    return (
      <WebsitePromptTable
        rows={res.rows}
        total={res.total}
        page={shownPage}
        pageSize={WEBSITE_PROMPTS_API_PAGE_SIZE}
        sort={sort}
        dir={dir}
        cursorPaging={{ nextCursor: res.nextCursor }}
      />
    );
  } catch (e) {
    throwForPage(e, locale);
  }
}
