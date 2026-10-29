import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import { Wordmark } from "@/components/wordmark";
import { Card } from "@/components/ui/card";
import { getSession } from "@/lib/auth/session";
import { localReadOnly } from "@/lib/local-readonly";
import { hubLoginNext, passwordChangeHref } from "@/lib/hub/next-path";
import { HubPasswordForm } from "./hub-password-form";

// HUB password change (2026-10-29), in the login page's card. An account whose password an administrator issued
// (a new account, a reset) comes here from every page until it sets its own; any account may come here to change
// its password. A change ends the account's other sessions; this one continues at `next`.
export const dynamic = "force-dynamic";

export default async function HubPasswordPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  if (!localReadOnly()) notFound();
  const next = hubLoginNext((await searchParams).next, locale);
  const session = await getSession();
  if (!session) redirect(`/${locale}/login?next=${encodeURIComponent(passwordChangeHref(locale, next))}`);
  const t = await getTranslations("hubPassword");
  const forced = session.user.mustChangePassword === true;

  return (
    <main className="grid min-h-screen place-items-center bg-background px-6 py-12">
      <div className="w-full max-w-md animate-fade-in">
        <Card className="px-10 py-12">
          <div className="flex flex-col items-center gap-6">
            <Wordmark variant="hmg" className="h-12 w-auto" />
            <h1 className="font-head text-base font-semibold tracking-tight text-foreground">{t("title")}</h1>
            <p className="-mt-3 text-center text-sm text-muted-foreground">{t(forced ? "forcedDescription" : "description", { login: session.user.email })}</p>
          </div>
          <HubPasswordForm next={next} forced={forced} loginHref={`/${locale}/login`} />
        </Card>
      </div>
    </main>
  );
}
