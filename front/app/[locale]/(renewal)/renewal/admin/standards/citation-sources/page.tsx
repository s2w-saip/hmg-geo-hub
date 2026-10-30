import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { RnNote, RnPageHeader } from "@/components/renewal-ui";
import { getSession } from "@/lib/auth/session";
import { canAccessRoute } from "@/lib/auth/route-policy";
import { isHghApiError } from "@/lib/hgh/errors";
import { hubFetch } from "@/lib/hub/client";
import { hubToken } from "@/lib/hub/session";
import { RnPageFrame } from "../../../_components/filter-split";
import type { SourceListing } from "./_components/source-overrides-api";
import { SourceOverridesManager } from "./_components/source-overrides-manager";

// Renewal Admin › 인용 출처 분류 (2026-10-30): the source category corrections the HUB owns, next to Gold's own
// classification of its latest global round, for the top-level administrator (back/bff/hub_stores/source_overrides.py).
// The original /admin/standards/citation-sources stays as it is. The list is read here; changes go from the browser.
export const dynamic = "force-dynamic";

export default async function RenewalCitationSourcesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("hubSourceOverrides");
  const session = await getSession();
  if (!session) redirect(`/${locale}/login`);
  // Defense in depth on top of the layout's server guard (admin only).
  if (!canAccessRoute(session.user.role, "/renewal/admin/standards/citation-sources")) redirect(`/${locale}/no-access`);
  const loginHref = `/${locale}/login?next=${encodeURIComponent(`/${locale}/renewal/admin/standards/citation-sources`)}`;

  const notice = (body: string, code?: string) => (
    <RnPageFrame header={<RnPageHeader title={t("title")} meta={<span>{t("description")}</span>} />}>
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
    const list = await hubFetch<{ data: SourceListing }>("GET", "/v1/hub/source-overrides", { token });
    return <SourceOverridesManager initial={list.data} />;
  } catch (e) {
    if (!isHghApiError(e)) throw e;
    // a failed read is told apart from an empty list (the original screen's error boundary)
    const code = e.status === 401 ? "unauthorized" : e.status === 403 ? "forbidden" : e.status >= 500 ? "source_unavailable" : "failed";
    return notice(t(`error.${code}`, { fields: "—" }), code);
  }
}
