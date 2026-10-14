import { getTranslations, setRequestLocale } from "next-intl/server";
import * as ecat from "@/lib/hgh/adapters/admin-entities";
import { throwForPage } from "@/lib/hgh/errors";
import { DraftBar } from "../_components/draft-bar";
import { DraftPanel } from "../_components/draft-panel";
import { EcatShell } from "../_components/ecat-shell";
import { ecatGate, namesOf, requireAdminPage } from "../_ecat-data";

// Draft editing (E7, design 7절 초안 편집): the one open draft (decision 29), its change list
// against the version it was based on, lint and the apply request. Reads: the version numbers
// (versions?view=gate), then the draft detail and its diff together.
export default async function EntityDraftPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("adminEcat");
  await requireAdminPage(locale);
  const gate = await ecatGate(locale, "gate");
  if (gate.kind !== "ready") return <EcatShell gate={gate} title={t("draft.pageTitle")} />;

  const { activeVer, draftVer } = gate.versions;
  if (!draftVer) {
    return (
      <EcatShell gate={gate} title={t("draft.pageTitle")}>
        <DraftBar activeVer={activeVer as number} draftVer={null} showOpen={false} />
      </EcatShell>
    );
  }
  const [draft, diff] = await Promise.all([
    ecat.getVersion(draftVer),
    ecat.getVersionDiff(draftVer).catch((e) => {
      console.warn(`[ecat] draft diff read failed: ${e instanceof Error ? e.name : typeof e}`);
      return null;
    }),
  ]).catch((e) => throwForPage(e, locale));
  return (
    <EcatShell gate={gate} title={t("draft.pageTitle")}>
      <DraftPanel
        version={draft.version}
        diff={diff}
        names={namesOf([draft], [diff])}
        lint={draft.lint}
        globalBlocks={draft.surfaces.filter((s) => s.entityId == null)}
      />
    </EcatShell>
  );
}
