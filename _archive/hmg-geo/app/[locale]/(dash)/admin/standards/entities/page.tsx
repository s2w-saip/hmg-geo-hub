import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/section-card";
import { getSession } from "@/lib/auth/session";
import { canAccessAdmin } from "@/lib/auth/scope-policy";
import { listDiscoveredBrands } from "@/lib/db/repositories/entity-registry";
import { EntityCatalog } from "./_components/entity-catalog";

// Admin > 표준 관리 > 엔티티 카탈로그 — "누가 자사인가"의 전사 공통 명부
// (entity_registry) 관리 화면. 측정에서 발견된 브랜드 엔티티 전체를 언급량과
// 함께 보여주고, admin이 역할(자사/경쟁사/제외)을 지정한다. 경쟁사는 파생
// 기본값(명부 미등재)이라 저장되지 않는다 — 2026-07-03 결정.
export default async function AdminStandardEntitiesPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("adminStandardEntities");

  const session = await getSession();
  if (!session) redirect(`/${locale}/login`);
  if (!canAccessAdmin(session.user)) redirect(`/${locale}/dashboard`);

  const rows = await listDiscoveredBrands().catch(() => []);

  return (
    <div className="flex animate-fade-in flex-col gap-6">
      <PageHeader title={t("title")} description={t("subtitle")} />
      <SectionCard title={t("catalog.title")} description={t("catalog.description")}>
        <EntityCatalog rows={rows} />
      </SectionCard>
    </div>
  );
}
