import { getTranslations, setRequestLocale } from "next-intl/server";
import { LoginForm } from "./login-form";
import { Wordmark } from "@/components/wordmark";
import { Card } from "@/components/ui/card";

// Single centered card layout — modeled after account.hyundai.com. The
// previous two-column "brand wall + form" arrangement was an editorial
// invention; the real Hyundai account login is a single quiet card centered
// on a Sand page. We follow that exactly: large H monogram, single-line
// title in font-head, icon-prefixed inputs, full-width LOGIN button.
export default async function LoginPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("login");

  return (
    <main className="grid min-h-screen place-items-center bg-background px-6 py-12">
      <div className="w-full max-w-md animate-fade-in">
        <Card className="px-10 py-12">
          <div className="flex flex-col items-center gap-6">
            {/* HMG group lockup on the login card — same mark as the dashboard
                header (account.hyundai.com pattern: the brand mark dominates
                the top of a single centered card). The wordmark is a wide
                two-line lockup, so it sizes by height at roughly half the old
                H-monogram's cap height to keep the card balanced. */}
            <Wordmark variant="hmg" className="h-12 w-auto" />
            <h1 className="font-head text-base font-semibold tracking-tight text-foreground">
              {t("cardTitle")}
            </h1>
          </div>
          <LoginForm />
        </Card>
      </div>
    </main>
  );
}
