"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Info, X } from "lucide-react";
import { CopyStatus, FEEDBACK_EMAILS, useCopyEmails } from "@/components/dash/beta-notice";

// Beta-period notice of the renewal shell (2026-10-23, user: "베타 안내를 우측 하단 토스트로").
// The original shell's strip under the header (BetaNoticeBanner) has no place in the S급
// shell (no top bar), so the same copy and the same two-address copy button sit in a card at
// the bottom right. × hides it for this browser session; the first-entry popup
// (BetaNoticeDialog) stays as in the original shell.

const HIDDEN_KEY = "rn-beta-toast-hidden";

export function RnBetaToast() {
  const t = useTranslations("betaNotice");
  const ts = useTranslations("renewal.shell");
  const { state, copy } = useCopyEmails();
  // hidden until mounted: sessionStorage is client-only (no flash on the server render)
  const [hidden, setHidden] = useState(true);
  useEffect(() => {
    let off = false;
    try {
      off = window.sessionStorage.getItem(HIDDEN_KEY) === "1";
    } catch {
      off = false;
    }
    setHidden(off);
  }, []);
  if (hidden) return null;
  const close = () => {
    setHidden(true);
    try {
      window.sessionStorage.setItem(HIDDEN_KEY, "1");
    } catch {
      // storage blocked: hidden until the next page load
    }
  };
  return (
    <section
      aria-label={t("title")}
      data-rn-beta-toast=""
      className="fixed right-5 bottom-5 z-30 w-[min(360px,calc(100vw-2.5rem))] rounded-rn-card bg-rn-surface py-3.5 pr-2.5 pl-4 shadow-[var(--shadow-rn-3),0_0_0_1px_var(--color-rn-line)]"
    >
      <div className="flex items-start gap-2.5">
        <Info className="mt-0.5 size-4 shrink-0 text-rn-navy" aria-hidden />
        <div className="min-w-0 flex-1">
          <b className="block text-rn-13 text-rn-ink">{t("title")}</b>
          <p className="m-0 mt-1 text-rn-12 leading-[1.55] break-keep text-rn-ink-2">{t("banner")}</p>
          <button
            type="button"
            onClick={copy}
            aria-label={t("mailAria")}
            className="mt-2.5 flex w-full cursor-pointer items-center justify-between gap-2 rounded-rn-control bg-rn-page px-2.5 py-2 text-left text-rn-12 font-semibold text-rn-navy hover:bg-rn-navy/6 focus-visible:outline-2 focus-visible:outline-rn-navy"
          >
            <span className="flex min-w-0 flex-col">
              {FEEDBACK_EMAILS.map((email) => (
                <span key={email} className="truncate">
                  {email}
                </span>
              ))}
            </span>
            <CopyStatus state={state} t={t} />
          </button>
        </div>
        <button
          type="button"
          aria-label={ts("closeNotice")}
          onClick={close}
          className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-rn-muted hover:bg-rn-page hover:text-rn-ink focus-visible:outline-2 focus-visible:outline-rn-navy"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
    </section>
  );
}
