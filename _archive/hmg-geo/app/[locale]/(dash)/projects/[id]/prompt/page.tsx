import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import { SectionCard } from "@/components/section-card";
import { getSession } from "@/lib/auth/session";
import { projectRepository } from "@/lib/db/repositories/projects";
import { projectMemberRepository } from "@/lib/db/repositories/project-members";
import {
  promptCandidateRepository,
  promptRepository,
} from "@/lib/db/repositories/prompts";
import { projectCustomFieldRepository } from "@/lib/db/repositories/project-custom-fields";
import { CandidateList, type CandidateRow } from "./_components/candidate-list";
import { ManualPromptInput } from "./_components/manual-input";
import { PromptList, type PromptRow } from "./_components/prompt-list";
import { type CustomFieldRow } from "./_components/custom-fields-panel";

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

  const project = await projectRepository.getById(id);
  if (!project) notFound();

  const membership = await projectMemberRepository.findMembership(
    id,
    session.user.id,
  );
  // admin = developer superuser (resolved 2026-06-02): can view + edit
  // every project's prompt tab regardless of membership.
  const isAdmin = session.user.role === "admin";
  if (!isAdmin && (!membership || membership.status !== "active")) notFound();

  const canEdit = isAdmin || membership?.role === "owner";

  const [candidatesRaw, promptsRaw, customFieldsRaw, customValuesRaw] = await Promise.all([
    promptCandidateRepository.listForProject(id),
    promptRepository.listForProject(id),
    projectCustomFieldRepository.listForProject(id),
    projectCustomFieldRepository.listValuesForProject(id),
  ]);

  const candidates: CandidateRow[] = candidatesRaw.map((c) => ({
    id: c.id,
    source: c.source,
    sourceKeyword: c.sourceKeyword,
    text: c.text,
    createdAt: c.createdAt.toISOString(),
  }));

  const customFields: CustomFieldRow[] = customFieldsRaw.map((f) => ({
    id: f.id,
    label: f.label,
    archived: f.archived,
  }));

  // promptId -> fieldId -> value, so each PromptRow carries just its own slice.
  const valuesByPrompt = new Map<string, Record<string, string>>();
  for (const v of customValuesRaw) {
    const bucket = valuesByPrompt.get(v.promptId) ?? {};
    bucket[v.fieldId] = v.value;
    valuesByPrompt.set(v.promptId, bucket);
  }

  const prompts: PromptRow[] = promptsRaw.map((p) => ({
    id: p.id,
    text: p.text,
    promptType: p.promptType,
    category: p.category,
    brand: p.brand,
    status: p.status,
    scopePromptId: p.scopePromptId ?? null,
    customValues: valuesByPrompt.get(p.id) ?? {},
  }));

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
            candidates={candidates}
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
        description={t("list.description", { count: prompts.length })}
      >
        <PromptList
          projectId={id}
          prompts={prompts}
          customFields={customFields}
          canEdit={canEdit}
          locale={locale}
        />
      </SectionCard>
    </div>
  );
}
