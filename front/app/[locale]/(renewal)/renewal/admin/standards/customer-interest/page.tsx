import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { RnNote, RnPageHeader } from "@/components/renewal-ui";
import { getSession } from "@/lib/auth/session";
import { canAccessRoute } from "@/lib/auth/route-policy";
import { isHghApiError } from "@/lib/hgh/errors";
import { hubFetch } from "@/lib/hub/client";
import { hubToken } from "@/lib/hub/session";
import { loadSavedFilters } from "../../../_components/saved-filters-server";
import { RnPageFrame } from "../../../_components/filter-split";
import type { InterestSourceListing, KeywordListing } from "./_components/interest-api";
import { tabOf } from "./_components/interest-model";
import { InterestKeywordsManager } from "./_components/interest-keywords-manager";
import { InterestSourcesManager } from "./_components/interest-sources-manager";
import { InterestTabs } from "./_components/interest-tabs";

// Renewal Admin › 고객 관심 데이터 관리 (2026-11-02): the collection inputs the HUB owns, for the top-level administrator —
// seed keywords and community sources (back/bff/hub_stores/interest.py), each next to what Gold collected. `?tab=` picks
// the list read here; changes go from the browser. The original /admin/standards/customer-interest stays as it is; its
// social research card is not moved (it always shows the empty state, Gold has no research run).
export const dynamic = "force-dynamic";

export default async function RenewalCustomerInterestPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("hubInterest");
  const session = await getSession();
  if (!session) redirect(`/${locale}/login`);
  // Defense in depth on top of the layout's server guard (admin only).
  if (!canAccessRoute(session.user.role, "/renewal/admin/standards/customer-interest")) redirect(`/${locale}/no-access`);
  const tab = tabOf((await searchParams).tab);
  const here = `/${locale}/renewal/admin/standards/customer-interest${tab === "keywords" ? "" : `?tab=${tab}`}`;
  const loginHref = `/${locale}/login?next=${encodeURIComponent(here)}`;
  const tabs = <InterestTabs value={tab} />;

  const notice = (body: string, code?: string) => (
    <RnPageFrame header={<RnPageHeader title={t("title")} actions={tabs} />}>
      <RnNote>
        <span data-hub-page-error={code ?? "login"}>{body}</span>
        {!code || code === "unauthorized" ? (
          <a href={loginHref} className="font-semibold text-rn-navy underline-offset-4 hover:underline">
            {t("login")}
          </a>
        ) : null}
      </RnNote>
    </RnPageFrame>
  );

  const token = await hubToken();
  if (!token) return notice(t("loginRequired"));
  try {
    if (tab === "sources") {
      const [list, saved] = await Promise.all([hubFetch<{ data: InterestSourceListing }>("GET", "/v1/hub/interest-sources", { token }), loadSavedFilters("interest-sources")]);
      return <InterestSourcesManager initial={list.data} tabs={tabs} savedFilters={{ page: "interest-sources", userId: session.user.id, initial: saved }} />;
    }
    const [list, saved] = await Promise.all([hubFetch<{ data: KeywordListing }>("GET", "/v1/hub/interest-keywords", { token }), loadSavedFilters("interest-keywords")]);
    return <InterestKeywordsManager initial={list.data} tabs={tabs} savedFilters={{ page: "interest-keywords", userId: session.user.id, initial: saved }} />;
  } catch (e) {
    if (!isHghApiError(e)) throw e;
    // a failed read is told apart from an empty list (the original screen's error boundary)
    const code = e.status === 401 ? "unauthorized" : e.status === 403 ? "forbidden" : e.status >= 500 ? "source_unavailable" : "failed";
    return notice(t(`error.${code}`, { fields: "—" }), code);
  }
}
