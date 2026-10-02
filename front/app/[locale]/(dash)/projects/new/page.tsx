import { setRequestLocale, getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { Link } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { ChevronLeft } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { getSession } from "@/lib/auth/session";
import { projectCreationOptions } from "@/lib/auth/scope-policy";
import { canCreateProject } from "@/lib/auth/operator-policy";
import { isProjectsApi, loadCreationOptions } from "@/lib/hgh/adapters/projects";
import { NewProjectForm } from "./_form";

// /projects/new — simple 5-field project creation form (v23, 2026-06-02).
// Replaces the v22 5-step wizard. Brand + Country options are computed
// server-side from the caller's scope; the action re-validates on submit.
//
// Access: route-policy keeps vendor out; project creation is a COST action
// gated by operator authority (canCreateProject: global | admin). A non-operator
// who navigates here directly is redirected back to the project list — the
// create action re-checks too (defense in depth).
export default async function NewProjectPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("projectNew");

  const session = await getSession();
  if (!session) redirect(`/${locale}/login`);
  if (!canCreateProject(session.user)) redirect(`/${locale}/projects`);

  // Data source (D8): HGH_SOURCE_G6=api reads GET /v1/projects/creation-options (BG-37: the
  // server's sets, re-ranked into the legacy order; 403 operator_forbidden -> back to the list);
  // legacy computes the options from the session scope.
  let options: { brands: readonly string[]; countries: readonly string[] };
  let brandLocked: boolean;
  if (isProjectsApi()) {
    const api = await loadCreationOptions(locale, session.user);
    if (!api) redirect(`/${locale}/projects`);
    options = api;
    brandLocked = api.brandLocked;
  } else {
    options = projectCreationOptions(session.user);
    // 어드민(무제한 scope) 제외 — 브랜드 스코프 계정은 자기 브랜드로
    // 고정되므로 브랜드 드롭다운을 잠근다(선택 불가).
    brandLocked = !session.user.scope.all && options.brands.length === 1;
  }

  return (
    <div className="flex animate-fade-in flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Button
          asChild
          variant="ghost"
          size="sm"
          className="w-fit -ml-2 text-muted-foreground"
        >
          <Link href="/projects">
            <ChevronLeft className="h-4 w-4" aria-hidden />
            {t("back")}
          </Link>
        </Button>
        <PageHeader title={t("title")} description={t("subtitle")} />
      </div>

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle className="font-head text-base font-semibold tracking-tight">
            {t("form.title")}
          </CardTitle>
          <CardDescription className="mt-1">{t("form.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <NewProjectForm
            locale={locale}
            allowedBrands={options.brands}
            allowedCountries={options.countries}
            brandLocked={brandLocked}
          />
        </CardContent>
      </Card>
    </div>
  );
}
