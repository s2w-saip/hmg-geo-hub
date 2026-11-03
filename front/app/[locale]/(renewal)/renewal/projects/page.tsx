import { redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { CalendarDays } from "lucide-react";
import { getSession } from "@/lib/auth/session";
import { canAccessRoute } from "@/lib/auth/route-policy";
import { screenGet } from "@/lib/screen";
import { throwForPage } from "@/lib/hgh/errors";
import { RnPageHeader, RnPill } from "@/components/renewal-ui";
import { RnPageFrame } from "../_components/filter-split";
import { RnProjectList } from "./_components/project-list";
import type { ProjectRow } from "./_components/project-model";

// Renewal Project › Project list (2026-11-03, menu option D): Gold's projects (surface 3) told apart by their Gold
// values; a row opens the project in the project tab (project-model.ts). The administrator's (route-policy
// /renewal/projects; the BFF refuses gold/projects to a scoped account, F20). The original /projects stays as it is.
export const dynamic = "force-dynamic";

export default async function RenewalProjectsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const session = await getSession();
  if (!session) redirect(`/${locale}/login`);
  // Defense in depth on top of the layout's server guard.
  if (!canAccessRoute(session.user.role, "/renewal/projects")) redirect(`/${locale}/no-access`);
  const t = await getTranslations("renewal.projects");
  let rows: ProjectRow[];
  try {
    rows = (await screenGet<{ items: ProjectRow[] }>("projects/list")).items;
  } catch (e) {
    throwForPage(e, locale);
  }
  const last = rows.reduce<string | null>((m, r) => (r.last_measured_day && (!m || r.last_measured_day > m) ? r.last_measured_day : m), null);
  return (
    <RnPageFrame
      header={
        <RnPageHeader
          title={t("title")}
          meta={
            <>
              <span className="text-rn-13 text-rn-muted">{t("description")}</span>
              {last ? (
                <RnPill>
                  <CalendarDays className="size-3 text-rn-muted" aria-hidden />
                  {t("lastMeasured", { date: last })}
                </RnPill>
              ) : null}
            </>
          }
        />
      }
    >
      <RnProjectList rows={rows} />
    </RnPageFrame>
  );
}
