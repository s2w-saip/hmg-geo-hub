import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/section-card";
import { getSession } from "@/lib/auth/session";
import { canAccessRoute } from "@/lib/auth/route-policy";
import {
  listWebsitePromptsScoped,
  listMeasuredLanguages,
  listWebsiteCountries,
  WEBSITE_PROMPT_SORT_KEYS,
  type WebsitePromptSortKey,
} from "@/lib/db/repositories/website-sites";
import { readStandardFilters } from "@/components/dash/standard-filters";
import { standardFilterKey } from "@/components/dash/standard-filters";
import type { DimensionGroup } from "@/components/dash/dimension-filter-panel";
import { AnswerAnalysisSkeleton } from "@/components/dash/section-skeleton";
import { WebsitePromptFilters } from "./_components/prompt-filters";
import { WebsitePromptTable } from "./_components/prompt-table";

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

const PAGE_SIZE = 50;

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
  // 노출 축(WebsitePromptFilters 의 groups 와 동일 구성) — 숨은 축 URL 파라미터
  // 누수 방지를 위해 필터 파싱에도 같은 목록을 전달한다.
  const filterGroups: DimensionGroup[] = [
    "geography",
    "language",
    "engine",
    "time",
    ...(isAdmin ? (["brand"] as const) : []),
  ];

  const [geographyOptions, languageOptions] = await Promise.all([
    listWebsiteCountries(scope),
    listMeasuredLanguages(scope),
  ]);

  return (
    <div className="flex animate-fade-in flex-col gap-6">
      <PageHeader title={t("title")} description={t("subtitle")} />
      <WebsitePromptFilters
        scope={scope}
        geographyOptions={geographyOptions}
        languageOptions={languageOptions}
        isAdmin={isAdmin}
      />
      <SectionCard title={t("title")}>
        {/* 필터/정렬/페이지가 바뀌면 key 가 바뀌어 스켈레톤이 다시 뜬다 —
            9,569행 질의가 수백 ms 걸릴 때 이전 페이지가 굳은 채 남지 않게. */}
        <Suspense
          key={suspenseKey(sp, scope, filterGroups)}
          fallback={<AnswerAnalysisSkeleton />}
        >
          <PromptData sp={sp} scope={scope} groups={filterGroups} />
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
  const raw = readStandardFilters(sp, scope, groups);
  return [
    standardFilterKey(raw),
    one(sp.q) ?? "",
    one(sp.sort) ?? "",
    one(sp.dir) ?? "",
    one(sp.page) ?? "",
  ].join("|");
}

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

async function PromptData({
  sp,
  scope,
  groups,
}: {
  sp: Record<string, string | string[] | undefined>;
  scope: Parameters<typeof readStandardFilters>[1];
  groups: DimensionGroup[];
}) {
  // 필터 축은 표준 파서를 그대로 쓴다 — ?geography/?language/?brand/?engine/?time
  // 규약과 scope 하드락(D4)이 화면마다 갈라지지 않게. readStandardFilters 는
  // ?geography 를 region 으로 파싱하므로 website 축(country)으로 옮긴다
  // (website/page.tsx·brand-citations 라우트와 동일한 remap).
  const raw = readStandardFilters(sp, scope, groups);

  const sortParam = one(sp.sort);
  const sort: WebsitePromptSortKey =
    sortParam && (WEBSITE_PROMPT_SORT_KEYS as readonly string[]).includes(sortParam)
      ? (sortParam as WebsitePromptSortKey)
      : "lastMeasuredAt";
  const dir = one(sp.dir) === "asc" ? "asc" : "desc";
  const requestedPage = Number.parseInt(one(sp.page) ?? "1", 10);
  const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;

  const filters = {
    brands: raw.brand,
    countries: raw.region, // geography → website country
    langs: raw.lang,
    search: one(sp.q),
    engines: raw.engine,
    dateFrom: raw.dateFrom,
    dateTo: raw.dateTo,
  };

  const result = await listWebsitePromptsScoped(scope, filters, {
    sort,
    dir,
    page,
    pageSize: PAGE_SIZE,
  });

  // 필터를 좁히면서 ?page 가 남아 범위를 넘길 수 있다(예: page=50 → 3페이지뿐).
  // 빈 화면 대신 마지막 페이지를 보여준다 — URL 을 쓰는 주체가 필터 패널/정렬/
  // 페이징으로 나뉘어 있어 "누군가 page 를 지워주겠지"에 기댈 수 없다.
  const pages = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
  const settled =
    page > pages && result.total > 0
      ? await listWebsitePromptsScoped(scope, filters, {
          sort,
          dir,
          page: pages,
          pageSize: PAGE_SIZE,
        })
      : result;

  return (
    <WebsitePromptTable
      rows={settled.rows}
      total={settled.total}
      page={Math.min(page, pages)}
      pageSize={PAGE_SIZE}
      sort={sort}
      dir={dir}
    />
  );
}
