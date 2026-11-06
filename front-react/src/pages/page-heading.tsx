import type { ReactNode } from "react";
import { useLocale, useTranslations } from "use-intl";
import { CalendarDays } from "lucide-react";
import { RnPageHeader, RnPill, RnTag } from "@/components/renewal-ui";
import { RnCopyLinkButton } from "@/app/[locale]/(renewal)/renewal/_components/overview-filters";
import { formatAsOfDate } from "@/lib/as-of-date";
import { parseTimeRange } from "@/components/dash/filter-encoding";
import type { PageDefinition } from "~/app/pages";
import type { PageContext, Values } from "./load";

type Period = { from: string | null; to: string | null };
export function PageHeading({ page, ctx, values: v }: { page: PageDefinition; ctx: PageContext; values: Values }) {
  const t = useTranslations();
  const locale = useLocale();
  let description: ReactNode = page.group;
  let detail: ReactNode;
  let cadence = t("dashboard.overview.cadence");
  const date = (value: string | null | undefined) => value === undefined ? "…" : value ? t("dashboard.overview.lastMeasured", { date: formatAsOfDate(value) }) : "—";
  const measured = (key: string) => {
    const response = v.value<{ asOf: string | null } | null | undefined>(key);
    return date(response === undefined ? undefined : response?.asOf ?? null);
  };
  const period = (value: Period | null | undefined, namespace: string) => value && (value.from || value.to) && !(value.from && value.to && value.from > value.to)
    ? t(`${namespace}.periodRange`, { from: value.from ?? "…", to: value.to ?? "…" }) : "—";
  if (page.kind === "overview") {
    description = t("dashboard.subtitle");
    detail = measured("asof");
  } else if (page.kind === "mention") {
    description = t("answerAnalysis.mentions.description");
    const head = v.value<{ period: Period | null }>("head");
    detail = head.period ? period(head.period, "renewal.mention") : measured("asof");
  } else if (page.kind === "citation") {
    description = t("answerAnalysis.citations.description");
    detail = parseTimeRange(ctx.sp.time)
      ? period(v.value<{ period: Period | null } | null>("header")?.period, "renewal.citation")
      : measured(ctx.surface === "global" ? "meta" : "asof");
  } else if (page.kind === "acr") {
    description = t("aiFunnelAcr.subtitle");
    cadence = t("renewal.acr.cadence");
    const head = v.value<{ period: boolean; dateFrom: string | null; dateTo: string | null } | null | undefined>("header");
    const asOf = v.value<{ body: { asOf: string | null } }>("body").body.asOf;
    detail = head === undefined ? "…" : head === null ? "—" : head.period ? period({ from: head.dateFrom, to: head.dateTo }, "renewal.acr") : asOf ? t("renewal.acr.snapshotOf", { date: formatAsOfDate(asOf) }) : "—";
  }
  const beta = ["mention", "citation", "acr"].includes(page.kind);
  return <RnPageHeader
    title={<>{page.title[locale === "en" ? 1 : 0]}{beta && <RnTag className="ml-2 align-middle text-rn-11">{t(`renewal.${page.kind}.beta`)}</RnTag>}</>}
    meta={<><span>{description}</span>{detail !== undefined && <RnPill><CalendarDays className="size-3 text-rn-muted" aria-hidden />{cadence}<span aria-hidden className="h-3 w-px bg-rn-line-2" /><span className="font-semibold tabular-nums text-rn-ink-2">{detail}</span></RnPill>}</>}
    actions={<RnCopyLinkButton />}
    delayInChip={page.kind === "mention" && ctx.surface === "global"}
  />;
}
