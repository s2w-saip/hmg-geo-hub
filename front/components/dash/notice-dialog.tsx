"use client";

import {
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useTranslations } from "next-intl";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";

// 알림 팝업 공용 템플릿 — 메인 첫 접속 팝업(<BetaNoticeDialog/>, Figma GGMD
// 1차 고도화 node 267:2)의 틀을 그대로 쓴다. 페이지별 안내 팝업(예: AI 유입
// 전환 샘플 안내)도 이 틀을 써서 모양·버튼·"오늘 다시 보지 않기" 동작이 같다.
//
//  - <NoticeDialogFrame/>: 제목 + 본문 + (선택) 회색 정보 박스 + 하단 버튼.
//    onHideToday 를 주면 "오늘 다시 보지 않기" | "닫기" 2개, 없으면 "닫기" 1개.
//  - useSessionNotice(): 브라우저 세션당 첫 진입에 1회, "오늘 다시 보지 않기"는
//    localStorage 에 로컬 날짜로 저장(자정에 초기화, 서버 저장 없음). 메인 팝업용.
//  - usePageNotice(): 조건 없이 마운트될 때마다 연다(저장소 미사용). 페이지 안내용.

// Local calendar date (not UTC) — "today" must roll over at the user's midnight.
function localDateStamp(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// 메인 팝업이 떠 있는 동안 페이지 팝업이 겹쳐 뜨지 않게 하는 신호.
// 첫 접속이 곧바로 페이지 팝업이 있는 경로면 두 팝업이 같은 커밋에서 열리려
// 한다 — 메인 팝업이 먼저 뜨고, 닫히면 페이지 팝업이 이어서 뜬다.
let primaryOpen = false;
const primaryListeners = new Set<() => void>();

function setPrimaryOpen(next: boolean) {
  if (primaryOpen === next) return;
  primaryOpen = next;
  for (const fn of primaryListeners) fn();
}

function subscribePrimary(fn: () => void) {
  primaryListeners.add(fn);
  return () => {
    primaryListeners.delete(fn);
  };
}

function usePrimaryOpen(): boolean {
  return useSyncExternalStore(
    subscribePrimary,
    () => primaryOpen,
    () => false,
  );
}

export function useSessionNotice({
  sessionKey,
  hideKey,
  primary = false,
}: {
  sessionKey: string;
  hideKey: string;
  // true = 메인 팝업. 떠 있는 동안 다른(페이지) 팝업을 대기시킨다.
  primary?: boolean;
}) {
  const [wanted, setWanted] = useState(false);
  const blocked = usePrimaryOpen();
  const open = wanted && (primary || !blocked);

  useEffect(() => {
    try {
      if (sessionStorage.getItem(sessionKey)) return;
      if (localStorage.getItem(hideKey) === localDateStamp()) return;
    } catch {
      // Storage unavailable (private mode, blocked) — fail open, show once.
    }
    // 메인 팝업은 결정과 같은 틱에 신호를 올린다 — 같은 커밋의 페이지 팝업이
    // 한 프레임이라도 먼저 열리지 않게.
    if (primary) setPrimaryOpen(true);
    setWanted(true);
  }, [sessionKey, hideKey, primary]);

  // "봤다" 표시는 실제로 열렸을 때 남긴다 — 메인 팝업 뒤에서 대기하다 페이지를
  // 떠난 경우 그 세션에서 한 번도 못 본 것으로 둔다.
  useEffect(() => {
    if (!open) return;
    try {
      sessionStorage.setItem(sessionKey, "1");
    } catch {
      // ignore — worst case the popup reappears on the next entry
    }
  }, [open, sessionKey]);

  useEffect(() => {
    if (!primary) return;
    return () => setPrimaryOpen(false);
  }, [primary]);

  const close = useCallback(() => {
    if (primary) setPrimaryOpen(false);
    setWanted(false);
  }, [primary]);

  const onOpenChange = useCallback(
    (next: boolean) => {
      if (!next) close();
    },
    [close],
  );

  const hideToday = useCallback(() => {
    try {
      localStorage.setItem(hideKey, localDateStamp());
    } catch {
      // ignore — worst case the popup reappears next session
    }
    close();
  }, [hideKey, close]);

  return { open, onOpenChange, close, hideToday };
}

// 페이지 안내 팝업 — 조건 없이 진입할 때마다 뜬다(세션·"오늘 다시 보지 않기"
// 저장 없음). 메인 팝업이 떠 있는 동안만 대기했다가 닫히면 이어서 뜬다(겹침 방지).
// 필터·기간을 바꿀 때마다 다시 뜨지 않도록 페이지가 아니라 레이아웃에 마운트한다.
export function usePageNotice() {
  const [wanted, setWanted] = useState(false);
  const blocked = usePrimaryOpen();
  const open = wanted && !blocked;

  // 마운트 직후 연다 — 같은 커밋의 메인 팝업 결정(primary 신호)이 먼저 반영되도록
  // 초기값이 아니라 effect 에서 연다.
  useEffect(() => {
    setWanted(true);
  }, []);

  const close = useCallback(() => setWanted(false), []);
  const onOpenChange = useCallback(
    (next: boolean) => {
      if (!next) close();
    },
    [close],
  );

  return { open, onOpenChange, close };
}

export function NoticeDialogFrame({
  open,
  onOpenChange,
  onClose,
  onHideToday,
  title,
  children,
  panel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onClose: () => void;
  // 없으면 "오늘 다시 보지 않기" 버튼을 그리지 않고 "닫기" 하나만 둔다.
  onHideToday?: () => void;
  title: ReactNode;
  // 본문 문단들. <p> 를 나란히 넣으면 템플릿 간격(space-y-6)이 적용된다.
  children: ReactNode;
  // 본문 아래 회색 정보 박스(메일·설명서 등). 없으면 생략.
  panel?: ReactNode;
}) {
  const t = useTranslations("betaNotice");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="gap-0 overflow-hidden p-0 sm:max-w-[809px]"
      >
        <div
          className={
            panel
              ? "px-8 pt-8 sm:px-14 sm:pt-14"
              : "px-8 pt-8 pb-10 sm:px-14 sm:pt-14 sm:pb-14"
          }
        >
          <DialogTitle className="text-base font-bold sm:text-lg">
            {title}
          </DialogTitle>
          <DialogDescription asChild>
            <div className="mt-8 space-y-6 text-sm leading-relaxed text-foreground sm:text-[15px]">
              {children}
            </div>
          </DialogDescription>
        </div>

        {panel ? (
          <div className="mx-8 mt-10 mb-8 space-y-4 rounded-lg bg-muted px-5 py-4 sm:mx-14 sm:mb-14">
            {panel}
          </div>
        ) : null}

        <div className="flex border-t">
          {onHideToday ? (
            <button
              type="button"
              onClick={onHideToday}
              className="flex-1 border-r py-5 text-sm text-muted-foreground transition-colors hover:bg-muted"
            >
              {t("hideToday")}
            </button>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            className="flex-1 py-5 text-sm font-medium transition-colors hover:bg-muted"
          >
            {t("close")}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
