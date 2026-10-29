import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { RnNote, RnPageHeader } from "@/components/renewal-ui";
import { getSession } from "@/lib/auth/session";
import { canAccessRoute } from "@/lib/auth/route-policy";
import { isHghApiError } from "@/lib/hgh/errors";
import { hubFetch } from "@/lib/hub/client";
import { hubToken } from "@/lib/hub/session";
import { RnPageFrame } from "../_components/filter-split";
import { loadSavedFilters } from "../_components/saved-filters-server";
import type { HubAccountList } from "./_components/hub-accounts-api";
import { HubAccountsManager } from "./_components/hub-accounts-manager";

// Renewal Admin › 사용자 관리 (2026-10-29): the HUB accounts — role, data scope, status and temporary passwords —
// for the top-level administrator (back/bff/hub_stores/accounts.py). The original /admin (legacy sources) stays
// as it is. Every account and the saved filters are read here; changes go from the browser.
export const dynamic = "force-dynamic";

export default async function RenewalAccountsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("hubAccounts");
  const session = await getSession();
  if (!session) redirect(`/${locale}/login`);
  // Defense in depth on top of the layout's server guard (admin only).
  if (!canAccessRoute(session.user.role, "/renewal/admin")) redirect(`/${locale}/no-access`);
  const loginHref = `/${locale}/login?next=${encodeURIComponent(`/${locale}/renewal/admin`)}`;

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
    const [list, saved] = await Promise.all([hubFetch<{ data: HubAccountList }>("GET", "/v1/hub/accounts", { token }), loadSavedFilters("accounts")]);
    return <HubAccountsManager initial={list.data.items} roles={list.data.roles} savedFilters={{ page: "accounts", userId: session.user.id, initial: saved }} />;
  } catch (e) {
    if (!isHghApiError(e)) throw e;
    const code = e.status === 401 ? "unauthorized" : e.status === 403 ? "forbidden" : e.status >= 500 ? "source_unavailable" : "failed";
    return notice(t(`error.${code}`, { fields: "—" }), code);
  }
}
