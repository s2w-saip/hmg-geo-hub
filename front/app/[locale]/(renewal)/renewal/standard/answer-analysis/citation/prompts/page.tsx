import { getTranslations, setRequestLocale } from "next-intl/server";
import { getSession } from "@/lib/auth/session";
import { UnauthorizedError } from "@/lib/auth/errors";
import { fetchStandardCitationOwnedPrompts, fetchStandardCitations } from "@/lib/scope/server";
import { readStandardFilters } from "@/components/dash/standard-filters";
import { throwForPage } from "@/lib/hgh/errors";
import { readCursorParam } from "@/lib/hgh/paginate";
import { isCitationsApi, loadOwnedPromptPage } from "@/lib/hgh/adapters/citations";
import { RnPageHeader, RnTag } from "@/components/renewal-ui";
import { RnCitationPromptsView } from "../_components/citation-subpages";
import { RnPageFrame } from "../../../../_components/filter-split";

export const maxDuration = 120;

// Renewal sub page — 공식(당사) URL 인용/미인용 프롬프트. The SAME reads as
// /standard/answer-analysis/citation/prompts/page.tsx (legacy readers, HGH_SOURCE_G2=api
// loadOwnedPromptPage with the keyset cursor); the route policy passes it through the parent's
// prefix (/renewal/standard/answer-analysis/citation). Keep the reads in step with the original.
export default async function RenewalCitationPromptsRoute({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("answerAnalysis.citations.v2.promptsPage");
  const tR = await getTranslations("renewal.citation");
  const session = await getSession();
  if (!session) throw new UnauthorizedError();
  const sp = await searchParams;
  // the parent's period semantics (cumulative) — the tab counts come from the same citation read
  const filters = { ...readStandardFilters(sp, session.user.scope), cumulative: true };
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const tab = one(sp.tab) === "uncited" ? "uncited" : "owned";
  const page = Math.max(1, Number.parseInt(one(sp.page) || "1", 10) || 1);
  const q = one(sp.q);
  const header = (
    <RnPageHeader
      title={
        <>
          {t("title")}
          <RnTag className="ml-2 align-middle text-rn-11">{tR("beta")}</RnTag>
        </>
      }
      meta={<span className="text-rn-13 text-rn-muted">{t("description")}</span>}
    />
  );

  if (isCitationsApi("global")) {
    let res: Awaited<ReturnType<typeof loadOwnedPromptPage>>;
    try {
      res = await loadOwnedPromptPage(filters, { surface: "global", scope: session.user.scope ?? null }, { owned: tab === "owned", q, page, cursor: readCursorParam(sp.cursor) });
    } catch (e) {
      throwForPage(e, locale);
    }
    return (
      <RnPageFrame header={header}>
        <RnCitationPromptsView tab={tab} page={res.page} q={q} ownedCount={res.ownedCount} uncitedCount={res.uncitedCount} />
      </RnPageFrame>
    );
  }
  const [list, live] = await Promise.all([
    fetchStandardCitationOwnedPrompts(filters, { owned: tab === "owned", page, q, pageSize: 50 }),
    // tab counts from the citation read's promptSplit (exact counts; shared cache)
    fetchStandardCitations(filters),
  ]);
  return (
    <RnPageFrame header={header}>
      <RnCitationPromptsView tab={tab} page={list} q={q} ownedCount={live?.promptSplit?.ownedCount ?? null} uncitedCount={live?.promptSplit?.uncitedCount ?? null} />
    </RnPageFrame>
  );
}
