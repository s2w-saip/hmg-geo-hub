import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { resolveDimensionState } from "@/lib/auth/scope-policy";
import {
  cachedProjectById,
  cachedMembership,
} from "@/lib/db/repositories/request-cache";
import { trackedKeywordRepository } from "@/lib/db/repositories/tracked-entities";
import { hghSource } from "@/lib/hgh/client";
import { throwForPage } from "@/lib/hgh/errors";
import { requireProjectPage } from "@/lib/hgh/adapters/project-gate";
import { isIntentApi, listTrackedKeywordTabs } from "@/lib/hgh/adapters/intent";
import { GoogleKeywordView } from "../_components/google-keyword-view";

// Project > Intent > Google Keyword (split from /intent in the 2026-06-04
// GNB reorg — SNB now owns the 4depth navigation instead of in-page tabs).
//
// Sources (D8): the page gate follows HGH_SOURCE_SESSION (api = GET /v1/projects/{id}, the one
// project gate of unit U2: admin or active member, else notFound; canEdit = admin or the active
// Owner, as legacy). The tracked keyword tabs follow HGH_SOURCE_G6 (unit U10): api =
// GET /v1/intent/keywords (created order, tab id = keyword_id), legacy = the repository.
export default async function ProjectIntentGoogleKeywordPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("projectDetail.intent.googleKeyword");

  const session = await getSession();
  if (!session) redirect(`/${locale}/login`);

  const isAdmin = session.user.role === "admin";
  let canEdit: boolean;
  let projectCountry: string;
  if (hghSource("SESSION") === "api") {
    const project = await requireProjectPage(locale, id);
    canEdit = isAdmin || project.myRole === "owner";
    projectCountry = project.country;
  } else {
    // Request-scoped memos, already warmed by the (dash) layout's SNB lookup.
    const [project, membership] = await Promise.all([
      cachedProjectById(id),
      cachedMembership(id, session.user.id),
    ]);
    if (!project) notFound();

    if (!isAdmin && (!membership || membership.status !== "active")) {
      notFound();
    }
    canEdit = isAdmin || membership?.role === "owner";
    projectCountry = project.country;
  }

  // The tracked keyword set + the project's country (auto-applied as the
  // keyword view's default market) are loaded server-side and seeded into the
  // client view — no hardcoded sample defaults.
  let initialKeywords: { id: string; label: string }[];
  if (isIntentApi()) {
    try {
      initialKeywords = await listTrackedKeywordTabs(id);
    } catch (e) {
      throwForPage(e, locale, { permission: "not-found" });
    }
  } else {
    const trackedKeywords = await trackedKeywordRepository.listForProject(id);
    initialKeywords = trackedKeywords.map((k) => ({ id: k.id, label: k.term }));
  }

  // Country filter options = the account's own country access (scope-policy,
  // same authority resolution the dashboard filter row uses) — not a fixed
  // sample list. Unrestricted roles (admin/hq/no country scope) get the full
  // RHQ country universe; a country-scoped account only sees its own market.
  const allowedCountries = resolveDimensionState(session.user, "country").options;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="font-head text-lg font-semibold tracking-tight text-foreground">
          {t("title", { default: "Google Keyword" })}
        </h2>
      </div>
      <GoogleKeywordView
        projectId={id}
        canEdit={canEdit}
        projectCountry={projectCountry}
        allowedCountries={allowedCountries}
        initialKeywords={initialKeywords}
      />
    </div>
  );
}
