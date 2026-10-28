import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { isMenuPath } from "@/lib/auth/route-policy";
import { resolvePageTitleRef } from "@/lib/nav/page-title";

// Admin menu items of the production web without a page here yet (분석 엔진 · 리포트 관리 · 측정 크레딧,
// 2026-10-28): the content area says the screen is not implemented. The admin pages that exist are
// more specific routes and win over this catch-all; the layout's guard applies the menu row's roles,
// and a path that is not a menu item is a 404.
export default async function AdminUnimplementedPage({ params }: { params: Promise<{ locale: string; slug: string[] }> }) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const path = "/admin/" + slug.join("/");
  const ref = resolvePageTitleRef(path);
  if (!isMenuPath(path) || !ref) notFound();
  const [t, tTitle] = await Promise.all([getTranslations("unimplemented"), getTranslations(ref.namespace)]);
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={tTitle(ref.key)} />
      <div
        data-unimplemented=""
        className="grid min-h-[50dvh] place-items-center rounded-xl border border-dashed border-border p-8 text-center"
      >
        <div className="flex flex-col items-center gap-2">
          <span className="rounded-md bg-muted px-2 py-0.5 text-xs font-semibold text-muted-foreground">{t("label")}</span>
          <p className="text-sm text-muted-foreground">{t("body")}</p>
        </div>
      </div>
    </div>
  );
}
