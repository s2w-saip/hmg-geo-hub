import { useLocale, useTranslations } from "use-intl";
import { CalendarDays } from "lucide-react";
import { RnCard, RnCardHead, RnPageHeader, RnPill, RnSkeleton, RnTag } from "@/components/renewal-ui";
import { RnPageFrame, RnFilterSplit } from "@/app/[locale]/(renewal)/renewal/_components/filter-split";
import { RnFilterRuntime } from "@/app/[locale]/(renewal)/renewal/_components/filter-runtime";
import { RnOverviewFilters, RnOverviewFilterPanel, RnOverviewFilterRail, RnCopyLinkButton } from "@/app/[locale]/(renewal)/renewal/_components/overview-filters";
import { RnAccountGate } from "@/app/[locale]/(renewal)/renewal/_components/account-gate";
import type { PageDefinition } from "./pages";

/** Outside-account pages keep the original frame and gate, with empty chart slots instead of sample measurements. */
export function StandbyPage({ page }: { page: PageDefinition }) {
  const locale = useLocale();
  const t = useTranslations();
  const conversion = page.path.endsWith("ai-funnel/conversion");
  const visibility = page.path.endsWith("ai-funnel/visibility");
  const keyword = page.path.endsWith("google-keyword");
  const social = page.path.endsWith("social-scraping");
  const ns = conversion ? "renewal.conversion" : visibility ? "renewal.visibility" : "keywordTools";
  const heading = <RnPageHeader title={<>{conversion || visibility ? t(`${ns}.title`) : page.title[locale === "en" ? 1 : 0]}{(conversion || visibility) && <RnTag className="ml-2 align-middle text-rn-11">{t(`${ns}.beta`)}</RnTag>}</>} meta={<><span>{keyword || social ? t(`renewal.projects.intent.${keyword ? "googleKeyword" : "socialScraping"}`) : t(`${ns}.subtitle`)}</span>{(conversion || visibility) && <RnPill><CalendarDays className="size-3" />{t(`${ns}.cadence`)} · —</RnPill>}</>} actions={<RnCopyLinkButton />} />;
  const titles = conversion ? ["summary", "trend", "engine", "props", "pages", "events", "channels"].map(k => t(`${ns}.${k}.title`))
    : visibility ? page.panels.map(p => p[locale === "en" ? 1 : 0])
    : keyword ? ["trendTitle", "avgTitle", "serpTitle"].map(k => t(`projectDetail.intent.googleKeyword.${k}`))
    : social ? ["titleGeneric", "contextsSection", "conditionsSection", "combinationsSection", "catalogSection"].map(k => t(`socialScraping.contextMap.${k}`))
    : [t("keywordTools.tabs.volume"), t("keywordTools.tabs.toPrompt")];
  const slots = <div className="flex flex-col gap-2.5" data-rn-waiting-layout="">{titles.map((title, i) => <RnCard key={title}><RnCardHead title={title} /><div className="px-6 pb-5"><RnSkeleton className={i === 0 ? "h-40 w-full" : "h-56 w-full"} /></div></RnCard>)}</div>;
  const body = visibility ? slots : <RnAccountGate account={conversion ? "ga4" : "dataforseo"}>{slots}</RnAccountGate>;
  return <RnFilterRuntime>{conversion || visibility ? <RnOverviewFilters savedFilters={{ page: conversion ? "conversion" : "visibility", userId: "", initial: [] }} props={{ scope: { all: true }, surface: page.group === "Website" ? "website" : page.group === "Project" ? "project" : "standard", stage: "conversion", catalogRows: [], geographyOptions: [], languageOptions: [], engineOptions: [] }}>
    <RnFilterSplit header={heading} panel={<RnOverviewFilterPanel />} rail={<RnOverviewFilterRail />}>{body}</RnFilterSplit>
  </RnOverviewFilters> : <RnPageFrame header={heading}>{body}</RnPageFrame>}</RnFilterRuntime>;
}
