"use client";

// Admin › 고객 관심 데이터 관리 (2026-11-02): 키워드 · 수집 소스. A tab is a page view (`?tab=`): the server reads the picked
// list, so switching navigates instead of fetching in place. 키워드 is the page without a tab.
import { useTranslations } from "use-intl";
import { usePathname, useRouter } from "~/app/navigation";
import { RnTabs } from "@/components/renewal-ui";
import { INTEREST_TABS, type InterestTab } from "./interest-model";

export function InterestTabs({ value }: { value: InterestTab }) {
  const t = useTranslations("hubInterest.tabs");
  const router = useRouter();
  const pathname = usePathname();
  return (
    <RnTabs<InterestTab>
      label={t("label")}
      value={value}
      onChange={(v) => router.push(v === "keywords" ? pathname : `${pathname}?tab=${v}`)}
      items={INTEREST_TABS.map((v) => ({ value: v, label: t(v) }))}
    />
  );
}
