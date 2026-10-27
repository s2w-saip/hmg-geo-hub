import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/section-card";
import { getSession } from "@/lib/auth/session";
import { canAccessRoute } from "@/lib/auth/route-policy";
import { AnswerAnalysisSkeleton } from "@/components/dash/section-skeleton";
import { WebsitePromptFilters } from "./_components/prompt-filters";
import { WebsitePromptTable, type WebsitePromptTableProps } from "./_components/prompt-table";
import { screenGet } from "@/lib/screen";
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
// 데이터는 BFF 화면 두 개에서 받는다: website/prompts-options(필터 옵션·달력·목록 Suspense 키),
// website/prompts-list(키셋 커서 한 페이지 + 페이지 표시값). 필터 파싱·정렬 화이트리스트·
// 페이지 계산은 모두 API(back/bff/screens/website_prompts.py)가 한다.


type SearchParams = Record<string, string | string[] | undefined>;

interface PromptOptionsScreen {
  geographyOptions: string[];
  languageOptions: string[];
  brandOptions: string[];
  selectableDates: string[] | null;
  /** Suspense key of the list: filters + q, sort, dir, page, cursor (a change shows the skeleton again). */
  listKey: string;
}

export default async function WebsitePromptsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<SearchParams>;
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
  let options: PromptOptionsScreen;
  try {
    options = await screenGet<PromptOptionsScreen>("website/prompts-options", { ...sp, "ctx.admin": isAdmin });
  } catch (e) {
    throwForPage(e, locale);
  }

  return (
    <div className="flex animate-fade-in flex-col gap-6">
      <PageHeader title={t("title")} description={t("subtitle")} />
      <WebsitePromptFilters
        scope={scope}
        geographyOptions={options.geographyOptions}
        languageOptions={options.languageOptions}
        brandOptions={options.brandOptions}
        isAdmin={isAdmin}
        selectableDates={options.selectableDates ?? undefined}
      />
      <SectionCard title={t("title")}>
        {/* 필터/정렬/페이지가 바뀌면 key 가 바뀌어 스켈레톤이 다시 뜬다 —
            9,569행 질의가 수백 ms 걸릴 때 이전 페이지가 굳은 채 남지 않게. */}
        <Suspense key={options.listKey} fallback={<AnswerAnalysisSkeleton />}>
          <PromptData sp={sp} isAdmin={isAdmin} locale={locale} />
        </Suspense>
      </SectionCard>
    </div>
  );
}

// One keyset page (?cursor, D5) of the website prompts; ?page is only the label index the table
// writes next to the cursor (a cursor that no longer fits restarts at page 1, known_diff U8-N13).
async function PromptData({ sp, isAdmin, locale }: { sp: SearchParams; isAdmin: boolean; locale: string }) {
  try {
    const vm = await screenGet<WebsitePromptTableProps>("website/prompts-list", { ...sp, "ctx.admin": isAdmin });
    return <WebsitePromptTable {...vm} />;
  } catch (e) {
    throwForPage(e, locale);
  }
}
