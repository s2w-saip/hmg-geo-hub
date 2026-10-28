import type { ReactNode } from "react";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { Toaster } from "sonner";
import { resolvePageTitleRef } from "@/lib/nav/page-title";
import { perfNoCacheActive } from "@/lib/perf/nocache-probe";
import { getSession } from "@/lib/auth/session";
import { localReadOnly } from "@/lib/local-readonly";
import { canAccessRoute, isGuardBypass, visibleRoutes } from "@/lib/auth/route-policy";
import { BetaNoticeDialog } from "@/components/dash/beta-notice";
import { RnSidebar } from "./_shell/rn-sidebar";
import { RnBetaToast } from "./_shell/beta-toast";
import { RnNavMain, RnNavPendingProvider } from "./_shell/nav-pending";

// Shell of the renewal pages (S급 테마, 2026-10-23): one sidebar, no top bar — the original
// (dash) shell (header · beta strip · GNB rail · SNB) stays as is for every other page. The
// session, route guard and page title follow app/[locale]/(dash)/layout.tsx line for line;
// a change there must be made here too. The page frame ([data-rn-frame], app/renewal-theme.css)
// takes the whole viewport next to the sidebar.
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const hdrs = await headers();
  const pathname = hdrs.get("x-pathname") ?? "";
  const tApp = await getTranslations({ locale, namespace: "app" });
  const appName = tApp("name");
  // T18 probe (same as the (dash) layout): a log line + a head meta tag when this request ran uncached
  const perfNoCache = await perfNoCacheActive();
  if (perfNoCache) console.info("x-hmg-perf: nocache");
  const perfMeta = perfNoCache ? { other: { "x-hmg-perf": "nocache" } } : {};
  const ref = resolvePageTitleRef(pathname);
  if (!ref) return { title: appName, ...perfMeta };
  const t = await getTranslations({ locale, namespace: ref.namespace });
  return { title: `${t(ref.key)} · ${appName}`, ...perfMeta };
}

export default async function RenewalLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const [{ locale }, session, hdrs] = await Promise.all([params, getSession(), headers()]);
  if (!session) redirect(`/${locale}/login`);

  // server-side route guard (route-policy.ts, role + menuGroups) — the same check as (dash)
  const menuGroups = session.user.menuGroups;
  const pathname = hdrs.get("x-pathname") ?? "";
  if (pathname && !isGuardBypass(pathname) && !canAccessRoute(session.user.role, pathname, menuGroups)) {
    redirect(`/${locale}/no-access`);
  }

  return (
    <>
      {/* sidebar 232px (208px up to 1279px, design-rules.html '틀'); below lg a slim menu bar on top */}
      <RnNavPendingProvider>
        <div className="grid h-screen grid-cols-1 grid-rows-[auto_minmax(0,1fr)] bg-rn-canvas text-rn-ink lg:grid-cols-[208px_minmax(0,1fr)] lg:grid-rows-1 xl:grid-cols-[232px_minmax(0,1fr)]">
          <RnSidebar routes={visibleRoutes(session.user.role, menuGroups)} user={{ email: session.user.email, role: session.user.role, local: localReadOnly() }} locale={locale} />
          {/* the page frame fills this; content that is not in a frame (error, loading) scrolls here.
              A menu click shows its progress here at once (nav-pending.tsx). */}
          <RnNavMain>{children}</RnNavMain>
        </div>
      </RnNavPendingProvider>
      <BetaNoticeDialog />
      <RnBetaToast />
      {/* bottom-center like the renewal toasts (RnToastProvider); the beta notice holds the bottom right */}
      <Toaster position="bottom-center" richColors closeButton />
    </>
  );
}
