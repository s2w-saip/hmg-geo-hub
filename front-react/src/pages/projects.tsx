import { useTranslations } from "use-intl";
import type { PageDefinition } from "~/app/pages";
import { Frame, Load, commonReads, screenRead, usePageContext, useReads } from "./load";
import { projectFilterProps } from "./analytics";
import { RnProjectList } from "@/app/[locale]/(renewal)/renewal/projects/_components/project-list";
import { RnProjectPrompts, type ProjectPromptsView } from "@/app/[locale]/(renewal)/renewal/projects/_components/project-prompts";
import { RnProjectGeneral, RnProjectMember, type ProjectSettingsView } from "@/app/[locale]/(renewal)/renewal/projects/_components/project-settings";
import type { ProjectRow } from "@/app/[locale]/(renewal)/renewal/projects/_components/project-model";
import { parseTimeRange, splitFilterValues } from "@/components/dash/filter-encoding";
import { countryName } from "@/lib/geo-catalog/country-name";
import { aiEngineLabel } from "@/lib/scope/engines";

export default function ProjectsPage({ page }: { page: PageDefinition }) {
  const ctx = usePageContext(page);
  const t = useTranslations("renewal.projects.prompts");
  const tw = useTranslations("renewal.website.prompts");
  const prompts = page.kind === "project-prompts";
  const range = parseTimeRange(ctx.sp.time);
  const lens = [...splitFilterValues(ctx.sp.geography).map(c => countryName(c, ctx.locale)), ...splitFilterValues(ctx.sp.engine).map(e => aiEngineLabel(e.toLowerCase())), ...(range?.from || range?.to ? [`${range.from ?? "…"} ~ ${range.to ?? "…"}`] : [])];
  const projectOnly = { "ctx.surface": ctx.query["ctx.surface"], "ctx.project_id": ctx.query["ctx.project_id"] };
  const result = useReads({ ...commonReads(ctx),
    ...(page.kind === "projects" ? { body: screenRead("projects/list") } : prompts ? { body: screenRead("projects/prompts", ctx.query) } : page.kind === "project-setting" ? { body: screenRead("projects/settings", projectOnly) } : {}),
    ...(prompts ? { filters: screenRead("projects/filters", { ...ctx.query, "ctx.family": "mentions" }) } : {}),
  });
  return <Load result={result}>{v => <Frame page={page} ctx={ctx} values={v} {...(prompts ? {
    savedPage: "project-prompt" as const,
    filters: projectFilterProps(ctx, v.value<Parameters<typeof projectFilterProps>[1]>("filters"), "overview"),
    panel: { axisHelp: { geography: t("countryHelp"), engine: tw("engineHelp"), time: tw("timeHelp") }, hint: t("noPickHint") },
  } : {})}>
    {page.kind === "projects" ? <RnProjectList rows={v.value<{ items: ProjectRow[] }>("body").items} /> : prompts ? <RnProjectPrompts id={ctx.id} view={v.value<ProjectPromptsView>("body")} lens={lens} /> : page.kind === "member" ? <RnProjectMember /> : <RnProjectGeneral view={v.value<ProjectSettingsView>("body")} />}
  </Frame>}</Load>;
}
