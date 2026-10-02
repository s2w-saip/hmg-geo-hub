import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import * as ecat from "@/lib/hgh/adapters/admin-entities";
import { throwForPage } from "@/lib/hgh/errors";
import { ApplyDetail } from "../../_components/apply-detail";
import { EcatShell } from "../../_components/ecat-shell";
import { ecatGate, requireAdminPage } from "../../_ecat-data";

// One apply request (E7, design 7절 미리보기·반영): preview, approval, progress and rollback.
// The client polls GET /v1/admin/entities/applies/{id} while the loader works.
export default async function EntityApplyPage({ params }: { params: Promise<{ locale: string; applyId: string }> }) {
  const { locale, applyId } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("adminEcat");
  await requireAdminPage(locale);
  const id = Number(applyId);
  if (!Number.isInteger(id) || id <= 0 || id >= 2_147_483_647) notFound();
  const gate = await ecatGate(locale);
  if (gate.kind !== "ready") return <EcatShell gate={gate} title={t("applyDetail.pageTitle")} />;

  const detail = await ecat.getApply(id).catch((e) => throwForPage(e, locale));
  // The draft's lint gates "preview again" (the backend re-lints and answers ECAT_LINT_BLOCKED). A rollback draft is
  // exempt while it keeps the previous content, so its lint does not gate the button. The diff against the version
  // the request started from lists hidden role changes when the preview does not (hidden applies to every period).
  const [version, diff] = await Promise.all([
    ecat.getVersion(detail.ver).catch(() => null),
    detail.fromVer != null && detail.fromVer !== detail.ver ? ecat.getVersionDiff(detail.ver, detail.fromVer).catch(() => null) : null,
  ]);
  const lint = version && version.version.status === "draft" && version.version.origin !== "rollback" ? version.lint : null;
  return (
    <EcatShell gate={gate} title={t("applyDetail.pageTitle")}>
      <ApplyDetail
        key={`${detail.applyId}:${detail.status}`}
        initial={detail}
        lint={lint}
        hiddenFromDiff={diff ? ecat.hiddenChangesInDiff(diff) : null}
      />
    </EcatShell>
  );
}
