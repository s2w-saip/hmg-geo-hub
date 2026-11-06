import type { PageDefinition } from "~/app/pages";
import { Frame, Load, commonReads, screenRead, usePageContext, useReads } from "./load";
import { RnProjectList } from "@/app/[locale]/(renewal)/renewal/projects/_components/project-list";
import { RnProjectPrompts, type ProjectPromptsView } from "@/app/[locale]/(renewal)/renewal/projects/_components/project-prompts";
import { RnProjectGeneral, RnProjectMember, type ProjectSettingsView } from "@/app/[locale]/(renewal)/renewal/projects/_components/project-settings";
import type { ProjectRow } from "@/app/[locale]/(renewal)/renewal/projects/_components/project-model";
import type { OverviewFilterProps } from "@/app/[locale]/(renewal)/renewal/_components/overview-filters";
import { parseTimeRange, splitFilterValues } from "@/components/dash/filter-encoding";
import { countryName } from "@/lib/geo-catalog/country-name";
import { aiEngineLabel } from "@/lib/scope/engines";

export default function ProjectsPage({ page }: { page: PageDefinition }) {
  const ctx = usePageContext(page);
  const prompts = page.kind === "project-prompts";
  const range = parseTimeRange(ctx.sp.time);
  const lens = [...splitFilterValues(ctx.sp.geography).map(c => countryName(c, ctx.locale)), ...splitFilterValues(ctx.sp.engine).map(e => aiEngineLabel(e.toLowerCase())), ...(range ? [`${range.from ?? "…"} ~ ${range.to ?? "…"}`] : [])];
  const result = useReads({ ...commonReads(ctx, prompts ? "project-prompt" : undefined),
    ...(page.kind !== "member" ? { body: screenRead(page.kind === "projects" ? "projects/list" : prompts ? "projects/prompts" : "projects/settings", ctx.query) } : {}),
    ...(prompts ? { filters: screenRead("projects/filters", ctx.query) } : {}),
  });
  return <Load result={result}>{v => <Frame page={page} ctx={ctx} values={v} {...(prompts ? { savedPage: "project-prompt" as const, filters: { ...v.value<OverviewFilterProps>("filters"), scope: ctx.user.scope, surface: "project" as const, stage: "overview" as const } } : {})}>
    {page.kind === "projects" ? <RnProjectList rows={v.value<{ items: ProjectRow[] }>("body").items} /> : prompts ? <RnProjectPrompts key={v.stamp} id={ctx.id} view={v.value<ProjectPromptsView>("body")} lens={lens} /> : page.kind === "member" ? <RnProjectMember /> : <RnProjectGeneral view={v.value<ProjectSettingsView>("body")} />}
  </Frame>}</Load>;
}
