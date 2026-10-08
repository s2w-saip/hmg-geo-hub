import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/section-card";
import { getSession } from "@/lib/auth/session";
import { canAccessAdmin } from "@/lib/auth/scope-policy";
import { citationOverrideRepository } from "@/lib/db/repositories/citation-overrides";
import * as api from "@/lib/hgh/adapters/admin";
import { throwForPage } from "@/lib/hgh/errors";
import { DomainList } from "./_components/domain-list";

// Admin > 글로벌 관리 > 인용 출처 분류 — 실제 인용 데이터의 가중치 상위 도메인
// 목록과, 도메인별 카테고리 교정(citation_domain_overrides). 분류는 read-time
// 파생이라 저장 즉시 전 이력이 재분류된다(백필 없음).
//
// 정상 빈 목록과 조회 장애를 구분한다. 테이블 누락·DB 장애도 기존 오류 경계로 전달한다.
// Source (D8, HGH_SOURCE_G7): api reads GET /v1/admin/citation-overrides/candidates?surface=global
// (latest exposed cycle weights, DC-14; 'social' layer and shadows_owned from the backend, BG-42).
// Failed reads use the existing dashboard error boundary and its retry action.
export const dynamic = "force-dynamic";

const CURATION_LIMIT = 500;

export default async function AdminCitationSourcesPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("adminCitationSources");

  const session = await getSession();
  if (!session) redirect(`/${locale}/login`);
  if (!canAccessAdmin(session.user)) redirect(`/${locale}/dashboard`);

  const apiSource = api.isAdminApi();
  const rows: api.AdminCurationRow[] = apiSource
    ? await api.listCitationCuration(CURATION_LIMIT).catch((e) => {
        throwForPage(e, locale);
      })
    : await citationOverrideRepository.listDomainCuration(CURATION_LIMIT);

  return (
    <div className="flex animate-fade-in flex-col gap-6">
      <PageHeader title={t("title")} description={t("subtitle")} />
      <SectionCard title={t("list.title")} description={t("list.description")}>
        <DomainList rows={rows} limit={CURATION_LIMIT} source={apiSource ? "api" : "legacy"} />
      </SectionCard>
    </div>
  );
}
