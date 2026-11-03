import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { RnPageHeader } from "@/components/renewal-ui";
import { RnAccountGate } from "../../../../_components/account-gate";
import { RnPageFrame } from "../../../../_components/filter-split";
import { ProjectKeywordSample } from "../../../_components/project-keyword-sample";
import { projectPageSession } from "../../../_components/project-filters-server";
import { shortId } from "../../../_components/project-model";

// Renewal Project › Intent › Google Keyword (2026-11-03, user): the original page's screen on sample data under the
// "DataForSEO · OpenRouter account needed" veil (U3), as the other pages waiting on an account. It reads nothing and calls
// no paid API. Gold's kw_* rows carry no project; D-6 puts their read and the tracked keyword input here (step 3).

type Params = Promise<{ locale: string; id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale, id } = await params;
  const [t, tApp] = await Promise.all([getTranslations({ locale, namespace: "nav.projectDetail" }), getTranslations({ locale, namespace: "app" })]);
  return { title: `${t("intentGoogleKeyword")} · ${shortId(id)} · ${tApp("name")}` };
}

export default async function RenewalProjectGoogleKeywordPage({ params }: { params: Params }) {
  const { locale } = await params;
  setRequestLocale(locale);
  await projectPageSession(locale);
  const [t, tNav] = await Promise.all([getTranslations("renewal.projects.intent"), getTranslations("nav.projectDetail")]);
  return (
    <RnPageFrame header={<RnPageHeader title={tNav("intentGoogleKeyword")} meta={<span className="text-rn-13 text-rn-muted">{t("googleKeyword")}</span>} />}>
      <RnAccountGate account="dataforseo">
        <div className="flex flex-col gap-2.5">
          <ProjectKeywordSample />
        </div>
      </RnAccountGate>
    </RnPageFrame>
  );
}
