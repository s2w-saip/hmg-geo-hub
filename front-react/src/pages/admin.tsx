import type { ComponentProps } from "react";
import type { PageDefinition } from "~/app/pages";
import { PageWeek, screenRead, hubRead, Load, savedSource, usePageContext, useReads, type Values } from "./load";
import { HubAccountsManager } from "@/app/[locale]/(renewal)/renewal/admin/_components/hub-accounts-manager";
import type { HubAccountList } from "@/app/[locale]/(renewal)/renewal/admin/_components/hub-accounts-api";
import { HubPromptsManager } from "@/app/[locale]/(renewal)/renewal/admin/standards/prompts/_components/hub-prompts-manager";
import type { HubOptions, HubPromptPage } from "@/app/[locale]/(renewal)/renewal/admin/standards/prompts/_components/hub-prompts-api";
import { DEFAULT_PAGE_SIZE, DEFAULT_SORT, listSearch, queryToFilter } from "@/app/[locale]/(renewal)/renewal/admin/standards/prompts/_components/hub-prompt-filter-model";
import { Ga4RegistryManager } from "@/app/[locale]/(renewal)/renewal/admin/ga4/_components/ga4-registry-manager";
import { SourceOverridesManager } from "@/app/[locale]/(renewal)/renewal/admin/standards/citation-sources/_components/source-overrides-manager";
import { SourceSeedsManager } from "@/app/[locale]/(renewal)/renewal/admin/standards/citation-sources/_components/source-seeds-manager";
import { SourceSocialsManager } from "@/app/[locale]/(renewal)/renewal/admin/standards/citation-sources/_components/source-socials-manager";
import { SourceCodesManager } from "@/app/[locale]/(renewal)/renewal/admin/standards/citation-sources/_components/source-codes-manager";
import { SourceTabs } from "@/app/[locale]/(renewal)/renewal/admin/standards/citation-sources/_components/source-tabs";
import { tabOf as sourceTab } from "@/app/[locale]/(renewal)/renewal/admin/standards/citation-sources/_components/source-lists-model";
import { InterestKeywordsManager } from "@/app/[locale]/(renewal)/renewal/admin/standards/customer-interest/_components/interest-keywords-manager";
import { InterestSourcesManager } from "@/app/[locale]/(renewal)/renewal/admin/standards/customer-interest/_components/interest-sources-manager";
import { InterestTabs } from "@/app/[locale]/(renewal)/renewal/admin/standards/customer-interest/_components/interest-tabs";
import { tabOf as interestTab } from "@/app/[locale]/(renewal)/renewal/admin/standards/customer-interest/_components/interest-model";
import { EntityRolesManager } from "@/app/[locale]/(renewal)/renewal/admin/standards/entities/_components/entity-roles-manager";
import { MeasurementManager } from "@/app/[locale]/(renewal)/renewal/admin/standards/measurement/_components/measurement-manager";
import type { MeasurementListing } from "@/app/[locale]/(renewal)/renewal/admin/standards/measurement/_components/measurement-model";
import type { SavedFilterPage } from "@/app/[locale]/(renewal)/renewal/_components/saved-filters";

type Initial<C extends React.ElementType> = ComponentProps<C>["initial"];
export default function AdminPage({ page }: { page: PageDefinition }) {
  const ctx = usePageContext(page);
  const source = sourceTab(ctx.sp.tab);
  const interest = interestTab(ctx.sp.tab);
  const endpoint = page.kind === "accounts" ? "accounts" : page.kind === "hub-prompts" ? "global-prompts" : page.kind === "ga4" ? "ga4-properties" : page.kind === "entities" ? "entity-roles" : page.kind === "measurement" ? "measurements" : page.kind === "interest" ? `interest-${interest}` : source === "overrides" ? "source-overrides" : source === "social" ? "source-socials" : `source-${source}`;
  const savedPage = (page.kind === "hub-prompts" ? "hub-prompts" : page.kind === "ga4" ? "ga4" : page.kind === "measurement" ? "measurement-settings" : endpoint) as SavedFilterPage;
  const { filters, search } = queryToFilter(new URLSearchParams(ctx.search));
  const initialSearch = listSearch({ filters, search, sort: DEFAULT_SORT.key, asc: DEFAULT_SORT.asc, page: 1, pageSize: DEFAULT_PAGE_SIZE });
  const needsSaved = page.kind !== "sources" || (source !== "social" && source !== "codes");
  const result = useReads({
    ...(page.kind === "sources" && source !== "codes" ? { week: screenRead("shared/service-week", {}, true) } : {}),
    list: hubRead(endpoint, page.kind === "hub-prompts" ? Object.fromEntries(new URLSearchParams(initialSearch)) : {}),
    ...(page.kind === "hub-prompts" ? { options: hubRead("global-prompts/options") } : {}),
  });
  return <Load result={result}>{v => <PageWeek ctx={ctx} values={v}>{renderBody(v)}</PageWeek>}</Load>;

  function renderBody(v: Values) {
    const savedFilters = needsSaved ? savedSource(ctx, savedPage) : { page: savedPage, userId: ctx.user.id, initial: null };
    if (page.kind === "accounts") { const data = v.value<HubAccountList>("list"); return <HubAccountsManager key={v.stamp} initial={data.items} roles={data.roles} savedFilters={savedFilters} />; }
    if (page.kind === "hub-prompts") return <HubPromptsManager key={v.stamp} initial={v.value<HubPromptPage>("list")} initialSearch={initialSearch} options={v.value<HubOptions>("options")} loginHref={`/${ctx.locale}/login`} savedFilters={savedFilters} />;
    if (page.kind === "ga4") return <Ga4RegistryManager key={v.stamp} initial={v.value<{ items: Initial<typeof Ga4RegistryManager> }>("list").items} savedFilters={savedFilters} />;
    if (page.kind === "entities") return <EntityRolesManager key={v.stamp} initial={v.value<Initial<typeof EntityRolesManager>>("list")} savedFilters={savedFilters} />;
    if (page.kind === "measurement") return <MeasurementManager listing={v.value<MeasurementListing>("list")} savedFilters={savedFilters} />;
    if (page.kind === "interest") { const tabs = <InterestTabs value={interest} />; return interest === "sources" ? <InterestSourcesManager key={v.stamp} initial={v.value<Initial<typeof InterestSourcesManager>>("list")} tabs={tabs} savedFilters={savedFilters} /> : <InterestKeywordsManager key={v.stamp} initial={v.value<Initial<typeof InterestKeywordsManager>>("list")} tabs={tabs} savedFilters={savedFilters} />; }
    const tabs = <SourceTabs value={source} />;
    if (source === "seeds") return <SourceSeedsManager key={v.stamp} initial={v.value<Initial<typeof SourceSeedsManager>>("list")} tabs={tabs} savedFilters={savedFilters} />;
    if (source === "social") return <SourceSocialsManager key={v.stamp} initial={v.value<Initial<typeof SourceSocialsManager>>("list")} tabs={tabs} />;
    if (source === "codes") return <SourceCodesManager key={v.stamp} initial={v.value<Initial<typeof SourceCodesManager>>("list")} tabs={tabs} />;
    return <SourceOverridesManager key={v.stamp} initial={v.value<Initial<typeof SourceOverridesManager>>("list")} tabs={tabs} savedFilters={savedFilters} />;
  }
}
