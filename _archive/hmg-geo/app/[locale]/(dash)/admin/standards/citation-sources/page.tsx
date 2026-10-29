import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/section-card";
import { getSession } from "@/lib/auth/session";
import { canAccessAdmin } from "@/lib/auth/scope-policy";
import { citationOverrideRepository } from "@/lib/db/repositories/citation-overrides";
import { DomainList } from "./_components/domain-list";

// Admin > 글로벌 관리 > 인용 출처 분류 — 실제 인용 데이터의 가중치 상위 도메인
// 목록과, 도메인별 카테고리 교정(citation_domain_overrides). 분류는 read-time
// 파생이라 저장 즉시 전 이력이 재분류된다(백필 없음).
//
// 목록이 비어 있는 정상적인 경우가 둘 있다: ① 미러(scope_citations)에 인용이
// 없을 때 ② 마이그레이션 0043 미적용(테이블 없음). 둘 다 화면이 죽지 않도록
// 빈 목록으로 접는다 — 로더(loadCitationOverrides)의 자세와 동일하다.
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

  const rows = await citationOverrideRepository
    .listDomainCuration(CURATION_LIMIT)
    .catch(() => []);

  return (
    <div className="flex animate-fade-in flex-col gap-6">
      <PageHeader title={t("title")} description={t("subtitle")} />
      <SectionCard title={t("list.title")} description={t("list.description")}>
        <DomainList rows={rows} limit={CURATION_LIMIT} />
      </SectionCard>
    </div>
  );
}
