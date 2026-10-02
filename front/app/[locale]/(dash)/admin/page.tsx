import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { canAccessAdmin } from "@/lib/auth/scope-policy";
import { profileRepository } from "@/lib/db/repositories/profiles";
import * as api from "@/lib/hgh/adapters/admin";
import { throwForPage } from "@/lib/hgh/errors";
import { CreateUserForm } from "./_components/create-user-form";
import { UserList } from "./_components/user-list";
import { SectionCard } from "@/components/section-card";
import { PageHeader } from "@/components/page-header";

// Admin console: user management. Two layers of gating —
//   1. DashLayout's route-policy guard already blocks non-admin URLs.
//   2. This page re-asserts the role check (defense in depth, design D4).
// Source (D8, HGH_SOURCE_G7): api reads GET /v1/admin/users (lib/hgh/adapters/admin.ts); the
// header count and the list share the same in-request deduped pages. The create form asks for
// role and scope on the api source (D10).
export default async function AdminPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const session = await getSession();
  if (!session || !canAccessAdmin(session.user)) {
    redirect(`/${locale}/no-access`);
  }

  const t = await getTranslations("admin");
  const apiSource = api.isAdminApi();
  const userCount = apiSource
    ? (await api.listAdminUsers().catch((e) => throwForPage(e, locale))).length
    : (await profileRepository.list()).length;

  return (
    <div className="flex animate-fade-in flex-col gap-6">
      <PageHeader
        title={t("title")}
        description={t("subtitle")}
        meta={t("userCount", { n: userCount })}
      />
      <SectionCard title={t("list.heading")}>
        <UserList locale={locale} />
      </SectionCard>
      <SectionCard title={t("create.heading")}>
        <CreateUserForm withRoleScope={apiSource} />
      </SectionCard>
    </div>
  );
}
