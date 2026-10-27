import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { PageHeader } from "@/components/page-header";
import { screenGet } from "@/lib/screen";

type Project = { id: string; prompts: number; answers: number; last_measured_day: string | null; regions: string[] | null };
type Prompt = { prompt_id: string; text: string; lang: string | null; answers: number; last_measured_day: string | null };
type Kpis = Record<"visibility" | "share_of_voice" | "sentiment" | "citation_share", number | null>;

export async function GoldProjects() {
  const [t, data] = await Promise.all([getTranslations("gold"), screenGet<{ items: Project[] }>("projects/list")]);
  return <div className="flex flex-col gap-6">
    <PageHeader title={t("projects")} description={t("metadataUnavailable")} />
    <div className="overflow-auto rounded-xl border bg-card">
      <table className="w-full text-left text-sm"><thead className="bg-muted/40"><tr>
        {[t("projectId"), t("prompts"), t("answers"), t("lastMeasured")].map(label => <th key={label} className="p-3">{label}</th>)}
      </tr></thead><tbody>{data.items.map(p => <tr key={p.id} className="border-t">
        <td className="p-3"><Link href={`/projects/${p.id}`} className="text-brand-700 underline">{p.id}</Link></td>
        <td className="p-3 tabular-nums">{p.prompts.toLocaleString()}</td><td className="p-3 tabular-nums">{p.answers.toLocaleString()}</td>
        <td className="p-3">{p.last_measured_day ?? "데이터 없음"}</td>
      </tr>)}</tbody></table>
    </div>
  </div>;
}

export async function GoldProject({ id }: { id: string }) {
  const [t, data] = await Promise.all([
    getTranslations("gold"),
    screenGet<{ project: { project_id: string; scope_project_id: string }; prompts: Prompt[]; kpis: Kpis }>("projects/detail", { "ctx.project_id": id, "ctx.kpis": "true" }),
  ]);
  const kpi = await getTranslations("dashboard.kpi.name");
  const keys = [["visibility", "visibility"], ["share_of_voice", "shareOfVoice"], ["sentiment", "sentiment"], ["citation_share", "citationShare"]] as const;
  return <div className="flex flex-col gap-6">
    <PageHeader title={id} description={t("metadataUnavailable")} />
    <div className="grid gap-3 sm:grid-cols-4">{keys.map(([key, label]) => {
      const value = data.kpis[key];
      return <div key={key} className="rounded-xl border bg-card p-4"><p className="text-sm text-muted-foreground">{kpi(label)}</p>
        <p className="mt-2 text-2xl font-semibold tabular-nums">{typeof value === "number" ? `${value.toFixed(1)}%` : "데이터 없음"}</p>
      </div>;
    })}</div>
    <div className="overflow-auto rounded-xl border bg-card"><table className="w-full text-left text-sm"><thead className="bg-muted/40"><tr>
      <th className="p-3">{t("prompts")}</th><th className="p-3">{t("answers")}</th><th className="p-3">{t("lastMeasured")}</th>
    </tr></thead><tbody>{data.prompts.map(p => <tr key={p.prompt_id} className="border-t"><td className="p-3">{p.text}</td>
      <td className="p-3 tabular-nums">{p.answers.toLocaleString()}</td><td className="p-3">{p.last_measured_day ?? "—"}</td></tr>)}</tbody></table></div>
  </div>;
}
