import { getLocale, getTranslations } from "next-intl/server";
import { RnNote, RnPageHeader } from "@/components/renewal-ui";
import { RnPageFrame } from "../../_components/filter-split";

// A page of a project that has no measured data yet (T6.3): a project added in Admin › 측정 설정 opens before Gold holds it. Its Prompt and Setting pages read the input store;
// the others answer 404 until its first round is loaded, and land here. The layout's own 404 (a project nobody holds) goes to the parent's page.
export default async function RenewalProjectNoData() {
  const [locale, t] = await Promise.all([getLocale(), getTranslations("renewal.projects.noData")]);
  return (
    <RnPageFrame header={<RnPageHeader title={t("title")} />}>
      <RnNote>
        <span data-rn-project-no-data={locale}>{t("body")}</span>
      </RnNote>
    </RnPageFrame>
  );
}
