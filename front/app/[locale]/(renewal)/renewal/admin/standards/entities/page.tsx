import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { RnNote, RnPageHeader } from "@/components/renewal-ui";
import { getSession } from "@/lib/auth/session";
import { canAccessRoute } from "@/lib/auth/route-policy";
import { isHghApiError } from "@/lib/hgh/errors";
import { hubFetch } from "@/lib/hub/client";
import { hubToken } from "@/lib/hub/session";
import { RnPageFrame } from "../../../_components/filter-split";
import type { EntityListing } from "./_components/entity-roles-api";
import { EntityRolesManager } from "./_components/entity-roles-manager";

// Renewal Admin › 엔티티 카탈로그 (2026-11-02): the entity roles the HUB owns, for the top-level administrator
// (back/bff/hub_stores/entity_roles.py), next to Gold's entities and numbers. Changes go from the browser. The original
// /admin/standards/entities stays as it is; its draft, preview, approval and rollback flow is not moved (decision F).
export const dynamic = "force-dynamic";

export default async function RenewalEntitiesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("hubEntities");
  const session = await getSession();
  if (!session) redirect(`/${locale}/login`);
  // Defense in depth on top of the layout's server guard (admin only).
  if (!canAccessRoute(session.user.role, "/renewal/admin/standards/entities")) redirect(`/${locale}/no-access`);
  const loginHref = `/${locale}/login?next=${encodeURIComponent(`/${locale}/renewal/admin/standards/entities`)}`;

  const notice = (body: string, code?: string) => (
    <RnPageFrame header={<RnPageHeader title={t("title")} />}>
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
    const list = await hubFetch<{ data: EntityListing }>("GET", "/v1/hub/entity-roles", { token });
    return <EntityRolesManager initial={list.data} />;
  } catch (e) {
    if (!isHghApiError(e)) throw e;
    // a failed read is told apart from an empty list (the original screen's error boundary)
    const code = e.status === 401 ? "unauthorized" : e.status === 403 ? "forbidden" : e.status >= 500 ? "source_unavailable" : "failed";
    return notice(t(`error.${code}`, { fields: "—" }), code);
  }
}
