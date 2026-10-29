import { Suspense, type ReactNode } from "react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { CalendarDays } from "lucide-react";
import { getSession } from "@/lib/auth/session";
import { UnauthorizedError } from "@/lib/auth/errors";
import type { AllowedScope } from "@/lib/auth/types";
import { throwForPage } from "@/lib/hgh/errors";
import { screenGet } from "@/lib/screen";
import { RnCard, RnPageHeader, RnPill, RnSkeleton, RnTag } from "@/components/renewal-ui";
import { RnBusyScope, RnFilterRuntime } from "../../../_components/filter-runtime";
import { RnDaysPeriod } from "../../../_components/days-period";
import { loadSavedFilters } from "../../../_components/saved-filters-server";
import {
  RnCopyLinkButton,
  RnFilterSplit,
  RnOverviewApplied,
  RnOverviewFilterPanel,
  RnOverviewFilterRail,
  RnOverviewFilters,
} from "../../../_components/overview-filters";
import { RnVisBody } from "./_components/vis-body";
import { RnVisPageProvider, RnVisTabs } from "./_components/vis-context";
import type { RnVisScreen, VisChoice } from "./_data/screen-types";
import { tabOf } from "./_data/tab";

// Renewal AI Visibility (2026-10-27) — the redesigned /standard/ai-funnel/visibility. Data: screen
// visibility/renewal (back/bff/screens/visibility.py) = the original's read (analytics/visibility) for
// the period and the previous period of the same length, and every derived number; the header's
// period pill comes from visibility/renewal-header (URL only, no reads). Tabs (?view=) switch the
// body in place: every tab renders the same screen model.

type Sp = Record<string, string | string[] | undefined>;

export default async function RenewalVisibilityPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Sp>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("renewal.visibility");
  const session = await getSession();
  if (!session) throw new UnauthorizedError();
  const sp = await searchParams;
  let choice: VisChoice;
  try {
    choice = await screenGet<VisChoice>("visibility/renewal-header", sp);
  } catch (e) {
    throwForPage(e, locale);
  }
  const header = (
    <RnPageHeader
      title={
        <>
          {t("title")}
          <RnTag className="ml-2 align-middle text-rn-11">{t("beta")}</RnTag>
        </>
      }
      meta={
        <>
          <span className="text-rn-13 text-rn-muted">{t("subtitle")}</span>
          <RnPill>
            <CalendarDays className="size-3 text-rn-muted" aria-hidden />
            {t("cadence")}
            <span aria-hidden className="h-3 w-px bg-rn-line-2" />
            <span className="font-semibold tabular-nums text-rn-ink-2">
              {choice.preset != null || choice.days != null ? t("periodDays", { n: choice.preset ?? choice.days ?? 28 }) : t("range", { from: choice.from ?? "…", to: choice.to ?? "…" })}
            </span>
          </RnPill>
        </>
      }
      actions={<RnCopyLinkButton />}
    />
  );
  return (
    <RnFilterRuntime>
      <RnVisPageProvider initialTab={tabOf(sp.view)}>
        <Suspense fallback={<PageSkeleton header={header} />}>
          <RenewalVisibility sp={sp} scope={session.user.scope} userId={session.user.id} locale={locale} header={header} />
        </Suspense>
      </RnVisPageProvider>
    </RnFilterRuntime>
  );
}

async function RenewalVisibility({ sp, scope, userId, locale, header }: { sp: Sp; scope: AllowedScope; userId: string; locale: string; header: ReactNode }) {
  const t = await getTranslations("renewal.visibility");
  const saved = loadSavedFilters("visibility");
  let read: RnVisScreen;
  try {
    read = await screenGet<RnVisScreen>("visibility/renewal", sp);
  } catch (e) {
    throwForPage(e, locale);
  }
  const { body } = read;
  return (
    <RnOverviewFilters props={{ ...read.props, scope }} savedFilters={{ page: "visibility", userId, initial: await saved }}>
      <RnFilterSplit
        header={header}
        top={body.state === "ok" ? <RnVisTabs view={body.view} /> : undefined}
        panel={
          <RnOverviewFilterPanel
            basis={<RnDaysPeriod choice={body.choice} period={body.period} />}
            axisHelp={{ engine: t("filters.engineHelp"), device: t("filters.deviceHelp") }}
            hint={t("filters.hint")}
          />
        }
        rail={<RnOverviewFilterRail />}
      >
        <RnOverviewApplied />
        <RnBusyScope className="flex flex-col gap-4">
          <RnVisBody input={body} />
        </RnBusyScope>
      </RnFilterSplit>
    </RnOverviewFilters>
  );
}

function PageSkeleton({ header }: { header: ReactNode }) {
  return (
    <RnFilterSplit header={header} panel={<RnCard className="h-[480px]" />} rail={<RnCard className="h-24" />}>
      <RnCard className="flex flex-col gap-3 p-6">
        <RnSkeleton className="h-4 w-40" />
        <RnSkeleton className="h-24 w-full" />
      </RnCard>
      <RnCard className="h-[300px]" />
    </RnFilterSplit>
  );
}
