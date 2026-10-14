import { getTranslations, setRequestLocale } from "next-intl/server";
import { SectionCard } from "@/components/section-card";
import { degradeRead } from "@/lib/hgh/adapters/admin";
import * as ecat from "@/lib/hgh/adapters/admin-entities";
import { throwForPage } from "@/lib/hgh/errors";
import { EcatShell } from "../_components/ecat-shell";
import { ReviewInbox } from "../_components/review-inbox";
import { ecatGate, requireAdminPage } from "../_ecat-data";

// Review inbox (E7, decision 28). Reads: version numbers (gate), then the inbox page and the entity list
// (merge target names and types: fields=names, no own-brand attribution) together. The entity list degrades
// to empty (the merge picker then only knows the inbox's own entities).

const STATUS = new Set(["pending", "resolved", "dismissed", "all"]);
const KIND = new Set(["new_entity", "new_surface"]);
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function EntityReviewPage({
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
  const gate = await ecatGate(locale, "gate");
  if (gate.kind !== "ready") return <EcatShell gate={gate} title={t("review.pageTitle")} />;

  const status = (STATUS.has(one(sp.status)) ? one(sp.status) : "pending") as ecat.ReviewStatus | "all";
  const kind = KIND.has(one(sp.kind)) ? (one(sp.kind) as "new_entity" | "new_surface") : null;
  const q = one(sp.q).slice(0, 200);
  const [items, list] = await Promise.all([
    ecat.listReview({ status, kind, q, limit: 200 }).catch((e) => throwForPage(e, locale)),
    ecat.listEntityRows({ fields: "names" }).catch((e) => degradeRead(e, [] as Awaited<ReturnType<typeof ecat.listEntityRows>>)),
  ]);
  const options = list.map((r) => ({ entityId: r.entity_id, name: r.name, hint: r.entity_type ?? null }));
  return (
    <EcatShell gate={gate} title={t("review.pageTitle")}>
      <SectionCard title={t("review.title")} description={t("review.description")}>
        <ReviewInbox items={items} status={status} kind={kind} q={q} draftVer={gate.versions.draftVer} mergeOptions={options} />
      </SectionCard>
    </EcatShell>
  );
}
