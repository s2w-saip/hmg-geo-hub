"use client";

// Admin › 인용 출처 분류 (2026-10-30): 교정 · 시드 · 공식 소셜 · 코드표. A tab is a page view (`?tab=`): the server reads
// the picked list, so switching navigates instead of fetching in place. 교정 is the page without a tab.
import { useTranslations } from "next-intl";
import { usePathname, useRouter } from "next/navigation";
import { RnTabs } from "@/components/renewal-ui";
import { SOURCE_TABS, type SourceTab } from "./source-lists-model";

export function SourceTabs({ value }: { value: SourceTab }) {
  const t = useTranslations("hubSourceLists.tabs");
  const router = useRouter();
  const pathname = usePathname();
  return (
    <RnTabs<SourceTab>
      label={t("label")}
      value={value}
      onChange={(v) => router.push(v === "overrides" ? pathname : `${pathname}?tab=${v}`)}
      items={SOURCE_TABS.map((v) => ({ value: v, label: t(v) }))}
    />
  );
}
