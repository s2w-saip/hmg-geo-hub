import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { RnNote, RnPageHeader } from "@/components/renewal-ui";
import { getSession } from "@/lib/auth/session";
import { canAccessRoute } from "@/lib/auth/route-policy";
import { isHghApiError } from "@/lib/hgh/errors";
import { hubFetch } from "@/lib/hub/client";
import { hubToken } from "@/lib/hub/session";
import { SUPPORT } from "@/lib/support-contact";
import { loadSavedFilters } from "../../../_components/saved-filters-server";
import { RnPageFrame } from "../../../_components/filter-split";
import type { MeasurementListing } from "./_components/measurement-model";
import { MeasurementManager } from "./_components/measurement-manager";

// Renewal Admin › 측정 설정 (T6.3, 2026-11-07): every project's measurement settings in one list, from the input store through the hub server
// (back/hub_server/inputs/measurement.py). A renewal page with no legacy original.
export const dynamic = "force-dynamic";

const PATH = "/renewal/admin/standards/measurement";

export default async function RenewalMeasurementPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("hubMeasurement");
  const session = await getSession();
  if (!session) redirect(`/${locale}/login`);
  if (!canAccessRoute(session.user.role, PATH)) redirect(`/${locale}/no-access`);
  const loginHref = `/${locale}/login?next=${encodeURIComponent(`/${locale}${PATH}`)}`;

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
    const [list, saved] = await Promise.all([hubFetch<{ data: MeasurementListing }>("GET", "/v1/hub/measurements", { token }), loadSavedFilters("measurement-settings")]);
    return <MeasurementManager listing={list.data} savedFilters={{ page: "measurement-settings", userId: session.user.id, initial: saved }} />;
  } catch (e) {
    if (!isHghApiError(e)) throw e;
    const code = e.status === 401 ? "unauthorized" : e.status === 403 ? "forbidden" : e.status >= 500 ? "source_unavailable" : "failed";
    return notice(t(`error.${code}`, SUPPORT), code);
  }
}
