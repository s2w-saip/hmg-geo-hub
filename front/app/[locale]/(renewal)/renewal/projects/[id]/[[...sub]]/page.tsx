import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getSession } from "@/lib/auth/session";
import { canAccessRoute } from "@/lib/auth/route-policy";
import { resolvePageTitleRef } from "@/lib/nav/page-title";
import { RnUnimplementedPage } from "../../../_components/unimplemented";
import { projectHref, projectPageOf, shortId } from "../../_components/project-model";

// The pages of a project tab (menu option D, 2026-11-03): the original project menu's paths under
// /renewal/projects/{id} (project-model PROJECT_PAGES; a menu parent opens its first child, any other path is a 404).
// None has its renewal page yet (renewal-pages RENEWAL_PROJECT_PAGES): each says it is not implemented. A page that
// gets built is a more specific route next to this one. The browser tab's title names the project.

type Params = Promise<{ locale: string; id: string; sub?: string[] }>;

const titleRef = (id: string, page: string) => resolvePageTitleRef(`/projects/${id}${page ? `/${page}` : ""}`)!;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale, id, sub } = await params;
  const at = projectPageOf(sub);
  const ref = titleRef(id, at && "page" in at ? at.page : "");
  const [t, tApp] = await Promise.all([getTranslations({ locale, namespace: ref.namespace }), getTranslations({ locale, namespace: "app" })]);
  return { title: `${t(ref.key)} · ${shortId(id)} · ${tApp("name")}` };
}

export default async function RenewalProjectPage({ params }: { params: Params }) {
  const { locale, id, sub } = await params;
  setRequestLocale(locale);
  const session = await getSession();
  if (!session) redirect(`/${locale}/login`);
  // Defense in depth on top of the layout's server guard (the administrator's).
  if (!canAccessRoute(session.user.role, "/renewal/projects")) redirect(`/${locale}/no-access`);
  const at = projectPageOf(sub);
  if (!at) notFound();
  if ("redirect" in at) redirect(`/${locale}${projectHref(id, at.redirect)}`);
  const ref = titleRef(id, at.page);
  const [t, tTitle] = await Promise.all([getTranslations("unimplemented"), getTranslations(ref.namespace)]);
  return <RnUnimplementedPage title={tTitle(ref.key)} label={t("label")} body={t("body")} />;
}
