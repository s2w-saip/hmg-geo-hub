import { getTranslations, setRequestLocale } from "next-intl/server";
import { SectionCard } from "@/components/section-card";
import * as ecat from "@/lib/hgh/adapters/admin-entities";
import { throwForPage } from "@/lib/hgh/errors";
import { EcatShell } from "../_components/ecat-shell";
import { VersionList } from "../_components/version-list";
import { ecatGate, requireAdminPage } from "../_ecat-data";

// Versions and apply requests (E7, design 7절 버전 목록·되돌리기). Reads: versions, then the apply
// list (newest 50).
export default async function EntityVersionsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("adminEcat");
  await requireAdminPage(locale);
  const gate = await ecatGate(locale);
  if (gate.kind !== "ready") return <EcatShell gate={gate} title={t("versions.pageTitle")} />;

  const applies = await ecat.listApplies({ limit: 50 }).catch((e) => throwForPage(e, locale));
  return (
    <EcatShell gate={gate} title={t("versions.pageTitle")}>
      <SectionCard title={t("versions.title")} description={t("versions.description")}>
        <VersionList
          versions={gate.versions.items}
          activeVer={gate.versions.activeVer as number}
          draftVer={gate.versions.draftVer}
          applies={applies}
          names={{}}
        />
      </SectionCard>
    </EcatShell>
  );
}
