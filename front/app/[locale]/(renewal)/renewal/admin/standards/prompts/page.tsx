import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { RnNote, RnPageHeader } from "@/components/renewal-ui";
import { getSession } from "@/lib/auth/session";
import { canAccessRoute } from "@/lib/auth/route-policy";
import { isHghApiError } from "@/lib/hgh/errors";
import { hubFetch } from "@/lib/hub/client";
import { hubToken } from "@/lib/hub/session";
import { RnPageFrame } from "../../../_components/filter-split";
import type { HubOptions, HubPromptPage } from "./_components/hub-prompts-api";
import { HubPromptsManager } from "./_components/hub-prompts-manager";

// Renewal Admin › Global prompts (2026-10-27): Global prompt editing on the HUB data catalog, for the
// top-level administrator signed in through the HUB login. The original /admin/standards/prompts (legacy
// sources) stays as it is. First page and the code options are read here; the rest from the browser.
export const dynamic = "force-dynamic";

export default async function RenewalHubPromptsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("hubPrompts");
  const session = await getSession();
  if (!session) redirect(`/${locale}/login`);
  // Defense in depth on top of the layout's server guard (admin only).
  if (!canAccessRoute(session.user.role, "/renewal/admin/standards/prompts")) redirect(`/${locale}/no-access`);
  const loginHref = `/${locale}/login?next=${encodeURIComponent(`/${locale}/renewal/admin/standards/prompts`)}`;

  const notice = (body: string, code?: string) => (
    <RnPageFrame header={<RnPageHeader title={t("title")} meta={<span>{t("description")}</span>} />}>
      <RnNote>
        <span data-hub-page-error={code ?? "login"}>{body}</span>
        {!code || code === "unauthorized" ? (
          <a href={loginHref} className="font-semibold text-rn-navy underline-offset-4 hover:underline">
            {t("login")}
          </a>
        ) : null}
      </RnNote>
    </RnPageFrame>
  );

  // An administrator of another sign-in (not the HUB login) has no HUB session.
  const token = await hubToken();
  if (!token) return notice(t("loginRequired"));
  try {
    const [page, options] = await Promise.all([
      hubFetch<{ data: HubPromptPage }>("GET", "/v1/hub/global-prompts", { token, query: "status=active&origin=all&limit=50&offset=0" }),
      hubFetch<{ data: HubOptions }>("GET", "/v1/hub/global-prompts/options", { token }),
    ]);
    return <HubPromptsManager initial={page.data} options={options.data} loginHref={loginHref} />;
  } catch (e) {
    if (!isHghApiError(e)) throw e;
    const code = e.status === 401 ? "unauthorized" : e.status >= 500 ? "source_unavailable" : "failed";
    return notice(t(`error.${code}`, { fields: "—" }), code);
  }
}
