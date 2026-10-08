import { getTranslations, setRequestLocale } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/section-card";
import { listDiscoveredBrands } from "@/lib/db/repositories/entity-registry";
import * as api from "@/lib/hgh/adapters/admin";
import * as ecat from "@/lib/hgh/adapters/admin-entities";
import { throwForPage } from "@/lib/hgh/errors";
import { EntityCatalog } from "./_components/entity-catalog";
import { EntityManager } from "./_components/entity-manager";
import { DraftBar } from "./_components/draft-bar";
import { EcatNav, Notice } from "./_components/ecat-shared";
import { draftChangeCount, ecatGate, requireAdminPage } from "./_ecat-data";

// Admin > 표준 관리 > 엔티티 카탈로그 — "누가 자사인가"의 전사 공통 명부
// (entity_registry) 관리 화면. 측정에서 발견된 브랜드 엔티티 전체를 언급량과
// 함께 보여주고, admin이 역할(자사/경쟁사/제외)을 지정한다. 경쟁사는 파생
// 기본값(명부 미등재)이라 저장되지 않는다 — 2026-07-03 결정.
// Source (D8, HGH_SOURCE_G7): api reads GET /v1/admin/entities?surface=global (latest exposed
// cycle, attributed display brand numbers: DC-13); rows carry the brand code an own assignment
// needs (U11-N2). Failed reads reach the existing dashboard error boundary.
// E7 (entity versioning): once an active version exists the page becomes the version manager:
// the list (GET /v1/admin/entities + active and draft version rows, the real role incl. hidden
// and removed), the draft bar and the entity drawer. Reads: versions and the list together, then
// the active and draft details together (two round trips, at most four calls).
export default async function AdminStandardEntitiesPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("adminStandardEntities");
  const te = await getTranslations("adminEcat");
  await requireAdminPage(locale);

  const apiSource = api.isAdminApi();
  if (apiSource) {
    const [gate, list] = await Promise.all([
      ecatGate(locale),
      ecat.listEntityRows().catch((e) => {
        throwForPage(e, locale);
      }),
    ]);
    if (gate.kind === "unavailable") {
      // Versions unreadable (5xx): the notice plus an empty catalog (never the old role editor
      // with rows: its PUT is refused after the cutover), as the degrade-to-empty read did.
      return (
        <div className="flex animate-fade-in flex-col gap-6">
          <PageHeader title={t("title")} description={te("page.subtitle")} />
          <Notice tone="danger">{te("page.unavailable")}</Notice>
          <SectionCard title={t("catalog.title")} description={t("catalog.description")}>
            <EntityCatalog rows={[]} source="api" />
          </SectionCard>
        </div>
      );
    }
    if (gate.kind === "ready") {
      const { activeVer, draftVer } = gate.versions;
      const [active, draft] = await Promise.all([
        ecat.getVersion(activeVer as number),
        draftVer ? ecat.getVersion(draftVer) : Promise.resolve(null),
      ]).catch((e) => throwForPage(e, locale));
      const rows = ecat.mergeEntityRows(list, active, draft);
      return (
        <div className="flex animate-fade-in flex-col gap-6">
          <PageHeader title={t("title")} description={te("page.subtitle")} />
          <EcatNav />
          <DraftBar
            activeVer={activeVer as number}
            draftVer={draftVer}
            draftTitle={draft?.version.title ?? null}
            changes={draftChangeCount(rows, active, draft)}
          />
          <SectionCard title={te("list.title")} description={te("list.description")}>
            <EntityManager
              rows={rows}
              activeVer={activeVer as number}
              draftVer={draftVer}
              draftSurfaces={(draft ?? active)?.surfaces ?? []}
              reviewCount={null}
            />
          </SectionCard>
        </div>
      );
    }
    // legacy role editor until the cutover (no active version yet)
    const legacyRows = list.map(api.toEntityRow);
    return (
      <div className="flex animate-fade-in flex-col gap-6">
        <PageHeader title={t("title")} description={t("subtitle")} />
        <SectionCard title={t("catalog.title")} description={t("catalog.description")}>
          <EntityCatalog rows={legacyRows} source="api" />
        </SectionCard>
      </div>
    );
  }

  const rows = await listDiscoveredBrands();
  return (
    <div className="flex animate-fade-in flex-col gap-6">
      <PageHeader title={t("title")} description={t("subtitle")} />
      <SectionCard title={t("catalog.title")} description={t("catalog.description")}>
        <EntityCatalog rows={rows} source="legacy" />
      </SectionCard>
    </div>
  );
}
