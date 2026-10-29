import { getTranslations, setRequestLocale } from "next-intl/server";
import { logout } from "@/lib/auth/actions";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";

// Landing page for authenticated users with zero accessible menus
// (e.g. role=country, intentional empty state per PDF Use Case 표).
// Reachable by anyone authenticated — listed in route-policy GUARD_BYPASS_PATHS.
//
// Uses EmptyState's `no-access` variant so this page matches the design-system
// vocabulary for empty/blocked states rather than rolling its own treatment.
export default async function NoAccessPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("noAccess");
  const tNav = await getTranslations("nav");

  return (
    <div className="mx-auto max-w-xl animate-fade-in py-16">
      <EmptyState
        variant="no-access"
        title={t("title")}
        description={t("description")}
        action={
          <div className="flex flex-col items-center gap-3">
            <p className="text-xs text-muted-foreground">{t("logoutHint")}</p>
            <form action={logout}>
              <input type="hidden" name="locale" value={locale} />
              <Button type="submit" variant="outline" size="sm">
                {tNav("logout")}
              </Button>
            </form>
          </div>
        }
      />
    </div>
  );
}
