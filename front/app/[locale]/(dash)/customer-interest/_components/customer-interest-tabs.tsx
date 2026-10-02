"use client";

import { useEffect, useState, useTransition, type ComponentType } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { BarChart3, Globe2, MessagesSquare } from "lucide-react";
import { usePathname, useRouter } from "@/i18n/navigation";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

export type CustomerInterestTabId = "overview" | "keywords" | "community";

const TAB_IDS: CustomerInterestTabId[] = ["overview", "keywords", "community"];

const TAB_ICON: Record<CustomerInterestTabId, ComponentType<{ className?: string }>> = {
  overview: BarChart3,
  keywords: Globe2,
  community: MessagesSquare,
};

export function normalizeCustomerInterestTab(
  value: string | null | undefined,
): CustomerInterestTabId {
  return TAB_IDS.includes(value as CustomerInterestTabId)
    ? (value as CustomerInterestTabId)
    : "overview";
}

export function CustomerInterestTabs({
  initialTab,
}: {
  initialTab: CustomerInterestTabId;
}) {
  const t = useTranslations("customerInterest");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const [active, setActive] = useState<CustomerInterestTabId>(initialTab);

  const queryTab = normalizeCustomerInterestTab(searchParams.get("tab"));

  useEffect(() => {
    setActive(queryTab);
  }, [queryTab]);

  function updateTab(next: string) {
    const tab = normalizeCustomerInterestTab(next);
    setActive(tab);
    const params = new URLSearchParams(searchParams.toString());
    if (tab === "overview") params.delete("tab");
    else params.set("tab", tab);
    const query = params.toString();
    startTransition(() => {
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    });
  }

  return (
    <Tabs value={active} onValueChange={updateTab} className="gap-5">
      <TabsList
        aria-label={t("tabs.label")}
        className="grid !h-auto w-full grid-cols-1 items-stretch gap-2 bg-transparent p-0 md:grid-cols-3"
      >
        {TAB_IDS.map((id) => {
          const Icon = TAB_ICON[id];
          return (
            <TabsTrigger
              key={id}
              value={id}
              className={cn(
                "h-full min-h-[4.5rem] justify-start rounded-lg border border-border bg-card px-4 py-3 text-left whitespace-normal shadow-sm after:hidden",
                "data-[state=active]:border-brand-700 data-[state=active]:bg-brand-700/5 data-[state=active]:shadow-sm",
              )}
            >
              <Icon className="mt-0.5 h-4 w-4 text-brand-700" aria-hidden />
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-sm font-semibold text-foreground">
                    {t(`tabs.${id}.title`)}
                  </span>
                  <Badge variant="secondary" className="shrink-0 text-[10px]">
                    {t("status.pending")}
                  </Badge>
                </span>
                <span className="line-clamp-2 text-xs font-normal text-muted-foreground">
                  {t(`tabs.${id}.description`)}
                </span>
              </span>
            </TabsTrigger>
          );
        })}
      </TabsList>

      {TAB_IDS.map((id) => (
        <TabsContent key={id} value={id} className="mt-0">
          <div className="flex flex-col gap-3">
            <div className="border-b border-border pb-3">
              <div className="min-w-0">
                <h2 className="text-base font-semibold tracking-tight text-foreground">
                  {t(`tabs.${id}.statusTitle`)}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t(`tabs.${id}.statusDescription`)}
                </p>
              </div>
            </div>

            <EmptyState
              variant="pending"
              title={t(`tabs.${id}.empty.title`)}
              description={t(`tabs.${id}.empty.description`)}
              className="min-h-64"
            />
          </div>
        </TabsContent>
      ))}
    </Tabs>
  );
}
