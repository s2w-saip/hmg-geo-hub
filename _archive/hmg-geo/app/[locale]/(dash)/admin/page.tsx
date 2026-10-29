import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { canAccessAdmin } from "@/lib/auth/scope-policy";
import { profileRepository } from "@/lib/db/repositories/profiles";
import { CreateUserForm } from "./_components/create-user-form";
import { UserList } from "./_components/user-list";
import { SectionCard } from "@/components/section-card";
import { PageHeader } from "@/components/page-header";

// Admin console: user management. Two layers of gating —
//   1. DashLayout's route-policy guard already blocks non-admin URLs.
//   2. This page re-asserts the role check (defense in depth, design D4).
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
  const profiles = await profileRepository.list();

  return (
    <div className="flex animate-fade-in flex-col gap-6">
      <PageHeader
        title={t("title")}
        description={t("subtitle")}
        meta={t("userCount", { n: profiles.length })}
      />
      <SectionCard title={t("list.heading")}>
        <UserList />
      </SectionCard>
      <SectionCard title={t("create.heading")}>
        <CreateUserForm />
      </SectionCard>
    </div>
  );
}
