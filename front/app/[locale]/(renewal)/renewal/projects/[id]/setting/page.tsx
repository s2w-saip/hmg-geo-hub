import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { screenGet } from "@/lib/screen";
import { throwForPage } from "@/lib/hgh/errors";
import { RnPageHeader } from "@/components/renewal-ui";
import { RnPageFrame } from "../../../_components/filter-split";
import { RnProjectGeneral, type ProjectSettingsView } from "../../_components/project-settings";
import { projectPageSession, projectQuery } from "../../_components/project-filters-server";
import { shortId } from "../../_components/project-model";

// Renewal Project › Setting › General (2026-11-03, read part): what Gold holds of the project's settings (screen
// projects/settings) under the original sections; the rest is the operations DB's (D-7 decides the write path).

type Params = Promise<{ locale: string; id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale, id } = await params;
  const [t, tApp] = await Promise.all([getTranslations({ locale, namespace: "nav.projectDetail" }), getTranslations({ locale, namespace: "app" })]);
  return { title: `${t("general")} · ${shortId(id)} · ${tApp("name")}` };
}

export default async function RenewalProjectSettingPage({ params }: { params: Params }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  await projectPageSession(locale);
  const [t, tNav] = await Promise.all([getTranslations("renewal.projects.setting"), getTranslations("nav.projectDetail")]);
  let view: ProjectSettingsView;
  try {
    view = await screenGet<ProjectSettingsView>("projects/settings", projectQuery(id, {}));
  } catch (e) {
    throwForPage(e, locale);
  }
  return (
    <RnPageFrame header={<RnPageHeader title={tNav("general")} meta={<span className="text-rn-13 text-rn-muted">{t("description")}</span>} />}>
      <RnProjectGeneral view={view} />
    </RnPageFrame>
  );
}
