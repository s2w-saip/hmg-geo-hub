import { useMemo, type ReactNode } from "react";
import { useLocale } from "use-intl";
import { Link, useParams } from "react-router-dom";
import { CONNECTED } from "~/api/client";
import { useSession } from "./session";
import { canAccessRoute, visibleRoutes } from "@/lib/auth/route-policy";
import { RnSidebar } from "@/app/[locale]/(renewal)/_shell/rn-sidebar";
import { RnBetaToast } from "@/app/[locale]/(renewal)/_shell/beta-toast";
import { BetaNoticeDialog } from "@/components/dash/beta-notice";
import { RnNavMain, RnNavPendingProvider } from "@/app/[locale]/(renewal)/_shell/nav-pending";
import { RnProjectTabBroadcast } from "@/app/[locale]/(renewal)/_shell/rn-project-tab";
import type { ProjectRow } from "@/app/[locale]/(renewal)/renewal/projects/_components/project-model";
import { useBundle } from "~/api/bundle";

export function Shell({ children }: { children: ReactNode }) {
  const locale = useLocale();
  const { user } = useSession();
  const { id } = useParams();
  return <RnNavPendingProvider>
    <div className="grid h-screen grid-cols-[208px_minmax(0,1fr)] grid-rows-1 bg-rn-canvas text-rn-ink xl:grid-cols-[232px_minmax(0,1fr)]">
      <RnSidebar routes={visibleRoutes(CONNECTED ? user?.role ?? "local_reader" : "admin")} user={{ email: user?.email ?? user?.login ?? "", role: user?.role ?? (CONNECTED ? "local_reader" : "admin"), local: !!user }} locale={locale} />
      <RnNavMain>{children}</RnNavMain>
    </div>
    {CONNECTED && user && !user.mustChangePassword && id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) && canAccessRoute(user.role, `/renewal/projects/${id}`) && <ProjectTabData id={id} />}
    {!CONNECTED && <Link className="sr-only focus:not-sr-only" to={`/${locale}/renewal/projects/preview`}>{locale === "en" ? "Preview project pages" : "프로젝트 상세 화면 미리보기"}</Link>}
    <BetaNoticeDialog />
    <RnBetaToast />
  </RnNavPendingProvider>;
}

function ProjectTabData({ id }: { id: string }) {
  const read = useBundle({ projects: { name: "projects/list" } });
  const list = read.data.projects as { items: ProjectRow[] } | undefined;
  const data = useMemo(() => list && !read.error ? { id, rows: list.items } : null, [id, list, read.error]);
  return data ? <RnProjectTabBroadcast data={data} /> : null;
}
