import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { RnPageHeader } from "@/components/renewal-ui";
import { RnAccountGate } from "../../../../_components/account-gate";
import { RnPageFrame } from "../../../../_components/filter-split";
import { ProjectSocialSample } from "../../../_components/project-social-sample";
import { projectPageSession } from "../../../_components/project-filters-server";
import { shortId } from "../../../_components/project-model";

// Renewal Project › Intent › Social Scraping (2026-11-03, user): the original page's screen on sample data under the
// "DataForSEO · OpenRouter account needed" veil (U3: the prompts are generated through OpenRouter), as the other pages
// waiting on an account. It reads nothing and calls no paid API. Gold's ctx_* corpus carries no project; D-6 puts its
// read here (step 3).

type Params = Promise<{ locale: string; id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale, id } = await params;
  const [t, tApp] = await Promise.all([getTranslations({ locale, namespace: "nav.projectDetail" }), getTranslations({ locale, namespace: "app" })]);
  return { title: `${t("intentSocialScraping")} · ${shortId(id)} · ${tApp("name")}` };
}

export default async function RenewalProjectSocialScrapingPage({ params }: { params: Params }) {
  const { locale } = await params;
  setRequestLocale(locale);
  await projectPageSession(locale);
  const [t, tNav] = await Promise.all([getTranslations("renewal.projects.intent"), getTranslations("nav.projectDetail")]);
  return (
    <RnPageFrame header={<RnPageHeader title={tNav("intentSocialScraping")} meta={<span className="text-rn-13 text-rn-muted">{t("socialScraping")}</span>} />}>
      <RnAccountGate account="dataforseo">
        <div className="flex flex-col gap-2.5">
          <ProjectSocialSample />
        </div>
      </RnAccountGate>
    </RnPageFrame>
  );
}
