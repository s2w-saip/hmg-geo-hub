import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { RnNote, RnPageHeader } from "@/components/renewal-ui";
import { getSession } from "@/lib/auth/session";
import { canAccessRoute } from "@/lib/auth/route-policy";
import { isHghApiError } from "@/lib/hgh/errors";
import { hubFetch } from "@/lib/hub/client";
import { hubToken } from "@/lib/hub/session";
import { RnPageFrame } from "../../_components/filter-split";
import { loadSavedFilters } from "../../_components/saved-filters-server";
import type { Ga4Property } from "./_components/ga4-registry-api";
import { Ga4RegistryManager } from "./_components/ga4-registry-manager";

// Renewal Admin › GA4 연동 (2026-10-29): the GA4 property registry the collector reads — market, conversion basis,
// 중지 / 재개 — for the top-level administrator (back/bff/hub_stores/ga4_registry.py). The original /admin/ga4
// stays as it is. Every property and the saved filters are read here; changes go from the browser.
export const dynamic = "force-dynamic";

export default async function RenewalGa4Page({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("hubGa4");
  const session = await getSession();
  if (!session) redirect(`/${locale}/login`);
  // Defense in depth on top of the layout's server guard (admin only).
  if (!canAccessRoute(session.user.role, "/renewal/admin/ga4")) redirect(`/${locale}/no-access`);
  const loginHref = `/${locale}/login?next=${encodeURIComponent(`/${locale}/renewal/admin/ga4`)}`;

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
    const [list, saved] = await Promise.all([hubFetch<{ data: { items: Ga4Property[] } }>("GET", "/v1/hub/ga4-properties", { token }), loadSavedFilters("ga4")]);
    return <Ga4RegistryManager initial={list.data.items} savedFilters={{ page: "ga4", userId: session.user.id, initial: saved }} />;
  } catch (e) {
    if (!isHghApiError(e)) throw e;
    const code = e.status === 401 ? "unauthorized" : e.status === 403 ? "forbidden" : e.status >= 500 ? "source_unavailable" : "failed";
    return notice(t(`error.${code}`, { fields: "—", propertyId: "—" }), code);
  }
}
