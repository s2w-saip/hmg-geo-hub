import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { RnPageHeader } from "@/components/renewal-ui";
import { RnPageFrame } from "../../../_components/filter-split";
import { RnProjectMember } from "../../_components/project-settings";
import { projectPageSession } from "../../_components/project-filters-server";
import { shortId } from "../../_components/project-model";

// Renewal Project › Setting › Member (2026-11-03, read part): members, roles, invites and their history are neither
// in Gold nor in the HUB (the original operations DB only): every section says 데이터 없음 until D-7 gives them a home.

type Params = Promise<{ locale: string; id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale, id } = await params;
  const [t, tApp] = await Promise.all([getTranslations({ locale, namespace: "nav.projectDetail" }), getTranslations({ locale, namespace: "app" })]);
  return { title: `${t("member")} · ${shortId(id)} · ${tApp("name")}` };
}

export default async function RenewalProjectMemberPage({ params }: { params: Params }) {
  const { locale } = await params;
  setRequestLocale(locale);
  await projectPageSession(locale);
  const [t, tNav] = await Promise.all([getTranslations("renewal.projects.member"), getTranslations("nav.projectDetail")]);
  return (
    <RnPageFrame header={<RnPageHeader title={tNav("member")} meta={<span className="text-rn-13 text-rn-muted">{t("description")}</span>} />}>
      <RnProjectMember />
    </RnPageFrame>
  );
}
