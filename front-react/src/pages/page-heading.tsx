import type { ReactNode } from "react";
import { useTranslations } from "use-intl";
import { CalendarDays } from "lucide-react";
import { RnPageHeader, RnPill, RnTag } from "@/components/renewal-ui";
import { RnCopyLinkButton } from "@/app/[locale]/(renewal)/renewal/_components/overview-filters";
import { formatAsOfDate } from "@/lib/as-of-date";
import { parseTimeRange } from "@/components/dash/filter-encoding";
import type { ProjectRow } from "@/app/[locale]/(renewal)/renewal/projects/_components/project-model";
import type { PageDefinition } from "~/app/pages";
import type { PageContext, Values } from "./load";

type Period = { from: string | null; to: string | null };

/** Each renewal page's header as its Next page writes it: title, description, cadence pill, copy link. A page with a project has no cadence in the pill. */
export function PageHeading({ page, ctx, values: v }: { page: PageDefinition; ctx: PageContext; values: Values }) {
  const t = useTranslations();
  const surface = ctx.surface;
  const beta = (ns: string) => <RnTag className="ml-2 align-middle text-rn-11">{t(`${ns}.beta`)}</RnTag>;
  const text = (message: string) => <span className="text-rn-13 text-rn-muted">{message}</span>;
  const pill = (detail: ReactNode, cadence?: string | null) => <RnPill><CalendarDays className="size-3 text-rn-muted" aria-hidden />{cadence ? <>{cadence}<span aria-hidden className="h-3 w-px bg-rn-line-2" /></> : null}<span className="font-semibold tabular-nums text-rn-ink-2">{detail}</span></RnPill>;
  const cadence = surface === "project" ? null : t("dashboard.overview.cadence");
  const copy = <RnCopyLinkButton />;
  const measured = (key: string, kst: boolean) => {
    const response = v.value<{ asOf: string | null } | null | undefined>(key);
    if (response === undefined) return "…";
    const day = response?.asOf ?? null;
    return day ? t("dashboard.overview.lastMeasured", { date: kst ? formatAsOfDate(day) : day.slice(0, 10) }) : "—";
  };
  const range = (value: Period | null | undefined, ns: string) => value && (value.from || value.to) && !(value.from && value.to && value.from > value.to) ? t(`${ns}.periodRange`, { from: value.from ?? "…", to: value.to ?? "…" }) : "—";
  const rounds = (first?: string, last?: string) => first ? t("renewal.website.prompts.basisRounds", { from: first.slice(0, 10), to: (last ?? first).slice(0, 10) }) : null;

  switch (page.kind) {
    case "overview": {
      const title = surface === "global" ? t("dashboard.overview.title") : surface === "website" ? t("renewal.website.overview.title") : t("nav.projectDetail.dashboard");
      const about = surface === "global" ? t("dashboard.subtitle") : surface === "website" ? t("website.dashboard.subtitle") : t("renewal.projects.dashboard.description");
      return <RnPageHeader title={title} meta={<>{text(about)}{pill(measured("asof", true), cadence)}</>} actions={copy} />;
    }
    case "mention": {
      const head = v.value<{ period: Period | null }>("head");
      const title = surface === "website" ? t("renewal.website.mention.title") : t("renewal.mention.title");
      return <RnPageHeader title={<>{title}{beta("renewal.mention")}</>} meta={<>{text(t("answerAnalysis.mentions.description"))}{pill(head.period ? t("renewal.mention.periodRange", { from: head.period.from ?? "…", to: head.period.to ?? "…" }) : measured("asof", false), cadence)}</>} actions={copy} delayInChip={surface === "global"} />;
    }
    case "citation": {
      const time = parseTimeRange(ctx.sp.time);
      const title = surface === "website" ? t("renewal.website.citation.title") : t("renewal.citation.title");
      const detail = time?.from || time?.to ? (v.value("header") === undefined ? "…" : range(v.value<{ period: Period | null } | null>("header")?.period, "renewal.citation")) : measured(surface === "global" ? "meta" : "asof", false);
      return <RnPageHeader title={<>{title}{beta("renewal.citation")}</>} meta={<>{text(t("answerAnalysis.citations.description"))}{pill(detail, cadence)}</>} actions={copy} />;
    }
    case "citation-prompts": {
      const ns = surface === "website" ? "renewal.website.citation.promptsPage" : surface === "project" ? "renewal.projects.citation.promptsPage" : "answerAnalysis.citations.v2.promptsPage";
      return <RnPageHeader title={<>{t(`${ns}.title`)}{beta("renewal.citation")}</>} meta={text(surface === "global" ? t("renewal.citation.sub.promptsDescription") : t(`${ns}.description`))} />;
    }
    case "citation-tone":
      return <RnPageHeader title={<>{t("answerAnalysis.citations.v2.toneUrlsPage.title")}{beta("renewal.citation")}</>} meta={text(t("answerAnalysis.citations.v2.toneUrlsPage.description"))} />;
    case "acr": {
      const head = v.value<{ period: boolean; dateFrom: string | null; dateTo: string | null } | null | undefined>("header");
      const asOf = v.value<{ body: { asOf: string | null } }>("body").body.asOf;
      const detail = head?.period ? (head.dateFrom || head.dateTo ? t("renewal.acr.periodRange", { from: head.dateFrom ?? "…", to: head.dateTo ?? "…" }) : "—") : asOf ? t("renewal.acr.snapshotOf", { date: asOf }) : "—";
      return <RnPageHeader title={<>{t("renewal.acr.title")}{beta("renewal.acr")}</>} meta={<>{text(t("aiFunnelAcr.subtitle"))}{pill(detail, t("renewal.acr.cadence"))}</>} actions={copy} />;
    }
    case "website-prompts": {
      const axis = v.value<{ roundAxis?: string[] }>("catalog").roundAxis ?? [];
      return <RnPageHeader title={t("website.prompts.title")} meta={<>{text(t("website.prompts.subtitle"))}{pill(rounds(axis[0], axis[axis.length - 1]) ?? "—", cadence)}</>} actions={copy} />;
    }
    case "project-prompts": {
      const list = v.value<{ rounds?: string[] }>("body").rounds;
      return <RnPageHeader title={t("nav.projectDetail.prompt")} meta={<>{text(t("renewal.projects.prompts.description"))}{pill(list?.length ? rounds(list[0], list[list.length - 1]) : list ? t("renewal.projects.prompts.noRound") : "—")}</>} actions={copy} />;
    }
    case "projects": {
      const rows = v.value<{ items: ProjectRow[] }>("body").items;
      const last = rows.reduce<string | null>((m, r) => (r.last_measured_day && (!m || r.last_measured_day > m) ? r.last_measured_day : m), null);
      return <RnPageHeader title={t("renewal.projects.title")} meta={<>{text(t("renewal.projects.description"))}{last ? <RnPill><CalendarDays className="size-3 text-rn-muted" aria-hidden />{t("renewal.projects.lastMeasured", { date: last })}</RnPill> : null}</>} />;
    }
    case "project-setting":
      return <RnPageHeader title={t("nav.projectDetail.general")} meta={text(t("renewal.projects.setting.description"))} />;
    case "member":
      return <RnPageHeader title={t("nav.projectDetail.member")} meta={text(t("renewal.projects.member.description"))} />;
    default:
      return <RnPageHeader title={page.title[0]} />;
  }
}
