import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { SectionCard } from "@/components/section-card";
import { getSession } from "@/lib/auth/session";
import { loadAllProjectPromptIds, loadProjectCandidateRows, loadProjectPromptRows, loadProjectPromptScreen } from "./_page-actions";
import { CandidateList } from "./_components/candidate-list";
import { ManualPromptInput } from "./_components/manual-input";
import { PromptList } from "./_components/prompt-list";

// Project detail > Prompt (v23 IA, v22 user flow #3).
// Owner sees: candidate pool with multi-select promotion, manual input,
// and the working prompts list with type/category classification + execute.
// Viewer sees: same data, read-only (no checkboxes, no inputs, no buttons).
export default async function ProjectPromptPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("projectDetail.prompt");

  const session = await getSession();
  if (!session) redirect(`/${locale}/login`);

  const { canEdit, candidatePage, promptPage, customFields } = await loadProjectPromptScreen(id);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="font-head text-lg font-semibold tracking-tight text-foreground">
          {t("title")}
        </h2>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard
          title={t("candidates.title")}
          description={t("candidates.description")}
        >
          <CandidateList
            projectId={id}
            candidates={candidatePage.rows}
            remote={{ initial: candidatePage, load: loadProjectCandidateRows.bind(null, id) }}
            canEdit={canEdit}
          />
        </SectionCard>

        {canEdit ? (
          <SectionCard
            title={t("manual.title")}
            description={t("manual.description")}
          >
            <ManualPromptInput projectId={id} />
          </SectionCard>
        ) : (
          <div aria-hidden />
        )}
      </div>

      <SectionCard
        title={t("list.title")}
        description={t("list.description", { count: promptPage.total })}
      >
        <PromptList
          projectId={id}
          prompts={promptPage.rows}
          remote={{ initial: promptPage, load: loadProjectPromptRows.bind(null, id), selectAll: loadAllProjectPromptIds.bind(null, id) }}
          customFields={customFields}
          canEdit={canEdit}
          locale={locale}
        />
      </SectionCard>
    </div>
  );
}
