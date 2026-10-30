import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { RnNote, RnPageHeader } from "@/components/renewal-ui";
import { getSession } from "@/lib/auth/session";
import { canAccessRoute } from "@/lib/auth/route-policy";
import { isHghApiError } from "@/lib/hgh/errors";
import { hubFetch } from "@/lib/hub/client";
import { hubToken } from "@/lib/hub/session";
import { RnPageFrame } from "../../../_components/filter-split";
import type { CodeListing, SeedListing, SocialListing } from "./_components/source-lists-api";
import { tabOf } from "./_components/source-lists-model";
import { SourceCodesManager } from "./_components/source-codes-manager";
import type { SourceListing } from "./_components/source-overrides-api";
import { SourceOverridesManager } from "./_components/source-overrides-manager";
import { SourceSeedsManager } from "./_components/source-seeds-manager";
import { SourceSocialsManager } from "./_components/source-socials-manager";
import { SourceTabs } from "./_components/source-tabs";

// Renewal Admin › 인용 출처 분류 (2026-10-30): the source classification inputs the HUB owns, for the top-level
// administrator — 교정 (back/bff/hub_stores/source_overrides.py), 시드 · 공식 소셜 · 코드표
// (back/bff/hub_stores/source_lists.py), each next to what Gold applies. `?tab=` picks the list read here; changes go
// from the browser. The original /admin/standards/citation-sources stays as it is.
export const dynamic = "force-dynamic";

export default async function RenewalCitationSourcesPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("hubSourceOverrides");
  const session = await getSession();
  if (!session) redirect(`/${locale}/login`);
  // Defense in depth on top of the layout's server guard (admin only).
  if (!canAccessRoute(session.user.role, "/renewal/admin/standards/citation-sources")) redirect(`/${locale}/no-access`);
  const tab = tabOf((await searchParams).tab);
  const here = `/${locale}/renewal/admin/standards/citation-sources${tab === "overrides" ? "" : `?tab=${tab}`}`;
  const loginHref = `/${locale}/login?next=${encodeURIComponent(here)}`;
  const tabs = <SourceTabs value={tab} />;

  const notice = (body: string, code?: string) => (
    <RnPageFrame header={<RnPageHeader title={t("title")} meta={<span>{t("description")}</span>} actions={tabs} />}>
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
    if (tab === "seeds") {
      const list = await hubFetch<{ data: SeedListing }>("GET", "/v1/hub/source-seeds", { token });
      return <SourceSeedsManager initial={list.data} tabs={tabs} />;
    }
    if (tab === "social") {
      const list = await hubFetch<{ data: SocialListing }>("GET", "/v1/hub/source-socials", { token });
      return <SourceSocialsManager initial={list.data} tabs={tabs} />;
    }
    if (tab === "codes") {
      const list = await hubFetch<{ data: CodeListing }>("GET", "/v1/hub/source-codes", { token });
      return <SourceCodesManager initial={list.data} tabs={tabs} />;
    }
    const list = await hubFetch<{ data: SourceListing }>("GET", "/v1/hub/source-overrides", { token });
    return <SourceOverridesManager initial={list.data} tabs={tabs} />;
  } catch (e) {
    if (!isHghApiError(e)) throw e;
    // a failed read is told apart from an empty list (the original screen's error boundary)
    const code = e.status === 401 ? "unauthorized" : e.status === 403 ? "forbidden" : e.status >= 500 ? "source_unavailable" : "failed";
    return notice(t(`error.${code}`, { fields: "—" }), code);
  }
}
