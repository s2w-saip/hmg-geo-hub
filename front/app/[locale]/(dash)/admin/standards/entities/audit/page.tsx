import { getTranslations, setRequestLocale } from "next-intl/server";
import { SectionCard } from "@/components/section-card";
import * as ecat from "@/lib/hgh/adapters/admin-entities";
import { throwForPage } from "@/lib/hgh/errors";
import { AuditLog } from "../_components/audit-log";
import { EcatShell } from "../_components/ecat-shell";
import { ecatGate, requireAdminPage } from "../_ecat-data";

// Entity versioning audit history (E7). Reads: versions (gate), then one audit page.

const LIMIT = 100;

export default async function EntityAuditPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const sp = await searchParams;
  setRequestLocale(locale);
  const t = await getTranslations("adminEcat");
  await requireAdminPage(locale);
  const gate = await ecatGate(locale);
  if (gate.kind !== "ready") return <EcatShell gate={gate} title={t("audit.pageTitle")} />;

  const raw = Array.isArray(sp.before_id) ? sp.before_id[0] : sp.before_id;
  const before = raw && /^\d{1,10}$/.test(raw) ? Number(raw) : null;
  const items = await ecat.listAudit({ beforeId: before, limit: LIMIT }).catch((e) => throwForPage(e, locale));
  return (
    <EcatShell gate={gate} title={t("audit.pageTitle")}>
      <SectionCard title={t("audit.title")} description={t("audit.description")}>
        <AuditLog items={items} limit={LIMIT} beforeId={before} />
      </SectionCard>
    </EcatShell>
  );
}
