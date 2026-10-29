import { useTranslations } from "next-intl";
import { EmptyState } from "@/components/empty-state";

// Shared placeholder body for the 3 customer-interest sub-pages while the
// P2 data pipeline is on hold. Each sub-page passes its tab id so the
// status copy + empty-state strings come from the right i18n branch.
export function CustomerInterestPendingView({
  tabId,
}: {
  tabId: "overview" | "keywords" | "community";
}) {
  const t = useTranslations("customerInterest");
  return (
    <div className="flex flex-col gap-3">
      <div className="border-b border-border pb-3">
        <h2 className="text-base font-semibold tracking-tight text-foreground">
          {t(`tabs.${tabId}.statusTitle`)}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t(`tabs.${tabId}.statusDescription`)}
        </p>
      </div>
      <EmptyState
        variant="pending"
        title={t(`tabs.${tabId}.empty.title`)}
        description={t(`tabs.${tabId}.empty.description`)}
        className="min-h-64"
      />
    </div>
  );
}
