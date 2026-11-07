import { Link, Navigate, useLocation } from "react-router-dom";
import { useLocale, useTranslations } from "use-intl";
import { CONNECTED } from "~/api/client";
import { useSession } from "./session";
import { Wordmark } from "@/components/wordmark";
import { Card } from "@/components/ui/card";
import { HubLoginForm } from "@/app/[locale]/login/hub-login-form";
import { HubPasswordForm } from "@/app/[locale]/login/password/hub-password-form";
import { passwordChangeHref } from "@/lib/hub/next-path";
import { PageLoading } from "./states";

/** Where a sign-in returns to: a page of this site, else the dashboard. */
export function safeNext(raw: string | null, locale: string): string {
  const fallback = `/${locale}/renewal/dashboard`;
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || /[\\\u0000- ]/.test(raw) || /%(?:2f|5c|00)/i.test(raw)) return fallback;
  let parsed: URL;
  try { parsed = new URL(raw, "https://hub.invalid"); }
  catch { return fallback; }
  const inside = parsed.pathname === `/${locale}/renewal` || parsed.pathname.startsWith(`/${locale}/renewal/`) || parsed.pathname === `/${locale}/login/password`;
  if (parsed.origin !== "https://hub.invalid" || !inside) return fallback;
  return raw;
}
/** The address a sign-in carries forward. `next` of the password page may itself hold an encoded address, which safeNext refuses at the top level only. */
function nextOf(search: string, locale: string): string {
  const raw = new URLSearchParams(search).get("next");
  if (!raw) return `/${locale}/renewal/dashboard`;
  const [path, query] = raw.split("?", 2);
  return safeNext(path, locale) === path ? (query ? `${path}?${query}` : path) : `/${locale}/renewal/dashboard`;
}
function Frame({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return <main className="grid min-h-screen place-items-center bg-background px-6 py-12"><div className="w-full max-w-md animate-fade-in"><Card className="px-10 py-12">
    <div className="flex flex-col items-center gap-6"><Wordmark variant="hmg" className="h-12 w-auto" /><h1 className="font-head text-base font-semibold tracking-tight text-foreground">{title}</h1><p className="-mt-3 text-center text-sm text-muted-foreground">{description}</p></div>
    {children}
  </Card></div></main>;
}
export function AuthPage({ password = false }: { password?: boolean }) {
  const locale = useLocale();
  const tLogin = useTranslations("hubLogin");
  const tPassword = useTranslations("hubPassword");
  const { search } = useLocation();
  const { user, loading } = useSession();
  const next = nextOf(search, locale);
  if (CONNECTED && loading) return <PageLoading />;
  if (!CONNECTED) return <Frame title={tLogin("title")} description={locale === "en" ? "Sign-in will be available after the HUB connection." : "허브에 연결한 뒤 로그인할 수 있습니다."}>
    <fieldset disabled className="contents"><HubLoginForm next={next} passwordHref={passwordChangeHref(locale, next)} /></fieldset>
    <Link to={`/${locale}/renewal/dashboard`} className="mt-6 block text-center text-sm font-semibold text-rn-navy">{locale === "en" ? "Explore prepared pages" : "준비된 화면 살펴보기"}</Link>
  </Frame>;
  if (password) {
    // an account comes here on its own, or until it replaces a password an administrator issued
    if (!user) return <Navigate replace to={`/${locale}/login?next=${encodeURIComponent(passwordChangeHref(locale, next))}`} />;
    const forced = user.mustChangePassword === true;
    return <Frame title={tPassword("title")} description={tPassword(forced ? "forcedDescription" : "description", { login: user.email ?? user.login })}><HubPasswordForm next={next} forced={forced} loginHref={`/${locale}/login`} /></Frame>;
  }
  // a signed-in visitor goes straight back
  if (user) return <Navigate replace to={user.mustChangePassword ? passwordChangeHref(locale, next) : next} />;
  return <Frame title={tLogin("title")} description={tLogin("description")}><HubLoginForm next={next} passwordHref={passwordChangeHref(locale, next)} /></Frame>;
}
