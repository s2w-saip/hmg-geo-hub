"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Check, Download, Info, Mail } from "lucide-react";
import { NoticeDialogFrame, useSessionNotice } from "@/components/dash/notice-dialog";

// Beta-period operational notice (2026-08 Figma GGMD 1차 고도화, node 267:2).
// Two surfaces, both shown to every authenticated user for the beta period:
//  - <BetaNoticeBanner/>: persistent strip under the top header, all pages.
//  - <BetaNoticeDialog/>: popup on first entry per browser session, with a
//    "hide for today" option persisted in localStorage (per browser, resets
//    at local midnight — server-side persistence deliberately not used).
//    틀·표시 규칙은 notice-dialog.tsx 공용 템플릿(페이지별 안내 팝업과 공유).
export const FEEDBACK_EMAILS = ["feedback-hmg@example.com", "feedback-partner@example.com"] as const;
// 2026-08-28 고객 요청: 메일 클릭 = 아웃룩 연결(mailto) → **클립보드 복사**.
// 두 주소를 모두 포함해 보내달라는 안내문과 짝이 맞도록 둘을 한 번에 복사한다.
export const FEEDBACK_EMAIL_TEXT = FEEDBACK_EMAILS.join(", ");
const MANUAL_HREF = "/manual/GGMD_beta_manual_v0.2_260713.pdf";
const MANUAL_FILENAME = "GGMD(beta) manual_v0.2_260713.pdf";
const MANUAL_DISPLAY = "GGMD(beta) manual_v0.2_260713";

const HIDE_TODAY_KEY = "ggmd-beta-notice-hide-date";
const SESSION_SHOWN_KEY = "ggmd-beta-notice-shown";


// 메일 주소 복사 버튼 — 배너와 팝업이 공유한다.
//
// 링크(mailto)가 아니라 버튼인 이유: 클릭의 결과가 "이동"이 아니라 "복사"라서
// <a> 로 두면 스크린리더가 링크로 읽고 새 탭/주소창 복사 같은 링크 관용구가
// 의미를 잃는다.
//
// 피드백이 없으면 복사가 됐는지 알 수 없으므로 아이콘을 Check 로 바꾸고 상태
// 문구를 aria-live 로 알린다(2초 후 복귀). navigator.clipboard 는 비보안
// 컨텍스트·권한 거부에서 실패할 수 있어 execCommand 폴백을 두고, 둘 다 실패하면
// 실패 상태를 노출한다 — 주소 텍스트는 항상 화면에 남아 있으므로 수동 선택이
// 최후 수단이 된다.
function useCopyEmails() {
  const [state, setState] = useState<"idle" | "copied" | "error">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const copy = useCallback(async () => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(FEEDBACK_EMAIL_TEXT);
      ok = true;
    } catch {
      ok = legacyCopy(FEEDBACK_EMAIL_TEXT);
    }
    setState(ok ? "copied" : "error");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2000);
  }, []);

  return { state, copy };
}

// 아이콘 + 상태 문구. 문구는 aria-live 라 스크린리더에도 결과가 전달된다.
function CopyStatus({
  state,
  t,
}: {
  state: "idle" | "copied" | "error";
  t: (key: string) => string;
}) {
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <span aria-live="polite" className="text-xs">
        {state === "copied" ? t("copied") : state === "error" ? t("copyFailed") : ""}
      </span>
      {state === "copied" ? (
        <Check className="size-4 shrink-0" aria-hidden />
      ) : (
        <Mail className="size-4 shrink-0" aria-hidden />
      )}
    </span>
  );
}

function legacyCopy(text: string): boolean {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function BetaNoticeBanner() {
  const t = useTranslations("betaNotice");
  const { state, copy } = useCopyEmails();
  // Fixed h-10 — the KPI filter panel's sticky offset (top-24 =
  // header h-14 + this h-10) depends on it. Text clamps to one line.
  //
  // z-30 = **크롬 레이어**(헤더 h-14 + 이 배너 h-10). 본문의 sticky 필터 패널은
  // z-20 이라 어떤 경우에도 이 띠를 덮지 못한다. 종전엔 배너도 z-20 이어서 패널과
  // 동률이었고, 동률이면 DOM 뒤쪽(=본문)이 이긴다 — 패널의 sticky 가 어떤 이유로든
  // 무력화되면(2026-09-09 #231: 필터 박스가 자기 높이와 같은 grid 행의 아이템이 되어
  // sticky 이동거리가 0) 패널이 배너 위를 그대로 덮고 지나갔다. 층을 분리해 그
  // 실패 양식 자체를 없앤다. 모달·팝오버(z-50, 포털)는 여전히 이 위다.
  return (
    <div className="sticky top-14 z-30 flex h-10 items-center justify-between gap-4 bg-primary px-4 text-primary-foreground sm:px-6">
      <p className="flex min-w-0 items-center gap-2 text-xs leading-relaxed sm:text-[13px]">
        <Info className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{t("banner")}</span>
      </p>
      <button
        type="button"
        onClick={copy}
        aria-label={t("mailAria")}
        className="hidden shrink-0 cursor-pointer items-center gap-4 text-[13px] underline-offset-4 hover:underline lg:flex"
      >
        {FEEDBACK_EMAILS.map((email) => (
          <span key={email}>{email}</span>
        ))}
        <CopyStatus state={state} t={t} />
      </button>
    </div>
  );
}

export function BetaNoticeDialog() {
  const t = useTranslations("betaNotice");
  const { state, copy } = useCopyEmails();
  const { open, onOpenChange, close, hideToday } = useSessionNotice({
    sessionKey: SESSION_SHOWN_KEY,
    hideKey: HIDE_TODAY_KEY,
    primary: true,
  });

  return (
    <NoticeDialogFrame
      open={open}
      onOpenChange={onOpenChange}
      onClose={close}
      onHideToday={hideToday}
      title={t("title")}
      panel={
        <>
          <div className="flex items-center gap-4 text-sm">
            <span className="w-24 shrink-0 font-semibold">{t("mailLabel")}</span>
            <button
              type="button"
              onClick={copy}
              aria-label={t("mailAria")}
              className="flex min-w-0 flex-1 cursor-pointer items-center justify-between gap-4 text-left underline-offset-4 hover:underline"
            >
              <span className="flex min-w-0 flex-wrap gap-x-4">
                {FEEDBACK_EMAILS.map((email) => (
                  <span key={email}>{email}</span>
                ))}
              </span>
              <CopyStatus state={state} t={t} />
            </button>
          </div>
          <div className="flex items-center gap-4 text-sm">
            <span className="w-24 shrink-0 font-semibold">
              {t("manualLabel")}
            </span>
            <a
              href={MANUAL_HREF}
              download={MANUAL_FILENAME}
              aria-label={t("manualAria")}
              className="flex min-w-0 flex-1 items-center justify-between gap-4 underline-offset-4 hover:underline"
            >
              <span className="truncate">{MANUAL_DISPLAY}</span>
              <Download className="size-4 shrink-0" aria-hidden />
            </a>
          </div>
        </>
      }
    >
      <p>{t("intro")}</p>
      <p>
        {t("betaLine1")}
        <br />
        {t("betaLine2")}
      </p>
      <p>
        {t("feedbackLine1")}
        <br />
        {t("feedbackLine2")}
        <br />
        {t("feedbackLine3")}
      </p>
    </NoticeDialogFrame>
  );
}
