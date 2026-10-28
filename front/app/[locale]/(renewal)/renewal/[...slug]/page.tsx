import { notFound, redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { RnPageHeader, RnTag } from "@/components/renewal-ui";
import { isMenuPath } from "@/lib/auth/route-policy";
import { resolvePageTitleRef } from "@/lib/nav/page-title";
import { RnPageFrame } from "../_components/filter-split";

// Every menu item without a renewal page yet (2026-10-28): the renewal sidebar opens /renewal<path>
// for every item, the renewal pages that exist are more specific routes and win over this catch-all,
// and the rest land here — the content area says the screen is not implemented (the renewal shell no
// longer sends a viewer to the original screens). The layout's guard permits /renewal/x as x
// (route-policy canAccessRoute); a path that is not a menu item is a 404.

/** Menu parents open their first child, as the original parent pages redirect. */
const FIRST_CHILD: Record<string, string> = {
  "/standard/answer-analysis": "/standard/answer-analysis/mention",
  "/standard/ai-funnel": "/standard/ai-funnel/acr",
  "/website/answer-analysis": "/website/answer-analysis/mention",
  "/website/ai-funnel": "/website/ai-funnel/conversion",
  "/admin/standards": "/admin/standards/prompts",
};

export default async function RenewalUnimplementedPage({ params }: { params: Promise<{ locale: string; slug: string[] }> }) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const path = "/" + slug.join("/");
  if (FIRST_CHILD[path]) redirect(`/${locale}/renewal${FIRST_CHILD[path]}`);
  const ref = resolvePageTitleRef(path);
  if (!isMenuPath(path) || !ref) notFound();
  const [t, tTitle] = await Promise.all([getTranslations("unimplemented"), getTranslations(ref.namespace)]);
  return (
    <RnPageFrame header={<RnPageHeader title={tTitle(ref.key)} />}>
      <div
        data-rn-unimplemented=""
        className="grid min-h-[min(60dvh,520px)] place-items-center rounded-2xl border border-dashed border-rn-line-2 bg-rn-surface p-8 text-center"
      >
        <div className="flex flex-col items-center gap-2.5">
          <RnTag className="px-2 py-0.5 text-rn-12">{t("label")}</RnTag>
          <p className="m-0 text-rn-15 font-semibold text-rn-ink-2">{t("body")}</p>
        </div>
      </div>
    </RnPageFrame>
  );
}
