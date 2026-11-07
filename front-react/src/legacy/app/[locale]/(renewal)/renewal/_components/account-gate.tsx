import type { ReactNode } from "react";
import { useTranslations } from "use-intl";
import { KeyRound } from "lucide-react";
import { cx, RnTag } from "@/components/renewal-ui";
import type { RnAccount } from "../../_shell/renewal-pages";

// A page whose data waits on an outside account the HUB does not hold yet (2026-11-02, user): instead of an empty page,
// or one that only says it cannot work, the viewer sees the whole screen drawn on sample data under a translucent veil,
// with a notice naming the account. The sample cannot be used: it is inert (no clicks, focus, tooltips or selection,
// hidden from assistive tech), and the notice stays in view while the screen scrolls under it. Wrap sample data only —
// a page with measured values never renders this (the pages are listed in _shell/renewal-pages.ts ACCOUNT_PAGES).

/** Inert content under the veil; `notice` stays in view on top of it while the content area scrolls. */
export function RnSampleVeil({ notice, className, children }: { notice?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <div data-rn-sample-veil="" className={cx("relative", className)}>
      <div inert className="h-full select-none">
        {children}
      </div>
      {/* the veil is the shell's background, so the gaps between cards do not show it; it sits over the sample's sticky
          heads and bars (z ≤ 20) and under the drawers and toasts of the page */}
      <div className="absolute inset-0 z-[25] rounded-rn-card bg-rn-canvas/55">
        {notice ? <div className="sticky top-[16dvh] flex justify-center px-6">{notice}</div> : null}
      </div>
    </div>
  );
}

/** The sample screen of a page waiting on `account`, under the veil with the notice naming the account. */
export function RnAccountGate({ account, children }: { account: RnAccount; children: ReactNode }) {
  const t = useTranslations("accountGate");
  return (
    <RnSampleVeil
      notice={
        <section
          data-rn-account-gate={account}
          className="flex w-[460px] max-w-full flex-col items-center gap-2 rounded-rn-card bg-rn-surface px-7 pt-6 pb-5 text-center shadow-rn-3"
        >
          <span className="grid size-11 place-items-center rounded-full bg-rn-navy-50 text-rn-navy">
            <KeyRound className="size-5" aria-hidden />
          </span>
          <RnTag className="mt-1 py-0.5">{t("sample")}</RnTag>
          <h2 className="m-0 text-rn-16 font-bold text-rn-ink">{t(`${account}.label`)}</h2>
          <p className="m-0 text-rn-13 leading-[1.6] break-keep text-rn-ink-2">{t(`${account}.body`)}</p>
          <p className="m-0 text-rn-12 text-rn-muted">{t("note")}</p>
        </section>
      }
    >
      {children}
    </RnSampleVeil>
  );
}
