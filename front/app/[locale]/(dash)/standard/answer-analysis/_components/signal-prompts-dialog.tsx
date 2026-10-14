"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { usePathname, useSearchParams } from "next/navigation";
import { Loader2, AlertCircle, MessageSquareText } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { MentionsPromptLive } from "@/lib/scope/result-adapter";
import { AnswerModal } from "./answer-modal";
import { TruncatedNote } from "./citation-domain-table";

// 감정 분포 / Mention 유형 세그먼트 드릴다운 (2026-08-07 고객 피드백: 어떤
// 프롬프트에서 어떤 긍정·부정 표현이 발생했는지 확인 불가).
//
// 감정 판정 키워드 자체는 scope 가 제공하지 않는다(별도 데이터 요청 트랙) —
// 그래서 "키워드 목록" 대신 그 신호가 실제로 발생한 프롬프트를 열거하고, 행을
// 누르면 기존 답변 모달로 원문을 열어 근거를 직접 확인하게 한다.
//
// 표면(표준/웹사이트/프로젝트)은 현재 URL 로 판별해 라우트에 그대로 전달한다 —
// answer-modal 과 동일 규약.
//
// B008: 라우트가 상한(50개)으로 목록을 잘랐다고 자르기 전 개수(`total`)를 함께 보내면 목록 아래에
// 기존 "{total}개 중 {shown}개 표시" 한 줄(TruncatedNote)을 둔다. `total` 이 없으면(안 잘림) 마크업은
// 종전 그대로다.

export type SignalPromptsState =
  | { status: "loading" }
  | { status: "ready"; list: MentionsPromptLive[]; total?: number }
  | { status: "error" };

/** 라우트 응답 본문(2xx) → ready 상태. `total` 은 숫자로 왔을 때만 싣는다. */
export function readSignalReply(d: { prompts?: MentionsPromptLive[]; total?: unknown }): SignalPromptsState {
  const list = d.prompts ?? [];
  return typeof d.total === "number" ? { status: "ready", list, total: d.total } : { status: "ready", list };
}

export function SignalPromptsDialog({
  signal,
  title,
  onOpenChange,
}: {
  // null 이면 닫힘. 열릴 때마다 새로 fetch (필터가 바뀌었을 수 있다).
  signal: string | null;
  title: string;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("answerAnalysis.mentions.signalDrilldown");
  const sp = useSearchParams();
  const pathname = usePathname();
  const projectId = /\/projects\/([^/]+)\//.exec(pathname)?.[1] ?? null;
  const isWebsite = pathname.includes("/website/");

  const [state, setState] = useState<SignalPromptsState>({ status: "loading" });
  const [selected, setSelected] = useState<MentionsPromptLive | null>(null);

  useEffect(() => {
    if (!signal) return;
    setState({ status: "loading" });
    const ctrl = new AbortController();
    const params = new URLSearchParams(sp.toString());
    params.set("signal", signal);
    if (projectId) params.set("projectId", projectId);
    else if (isWebsite) params.set("surface", "website");
    fetch(`/api/scope/signal-prompts?${params.toString()}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("failed"))))
      .then((d: { prompts?: MentionsPromptLive[]; total?: unknown }) => setState(readSignalReply(d)))
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setState({ status: "error" });
      });
    return () => ctrl.abort();
  }, [signal]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <Dialog open={signal !== null} onOpenChange={onOpenChange}>
        <DialogContent className="flex max-h-[80vh] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
          <DialogHeader className="gap-1.5 border-b border-border px-5 pt-5 pb-4 text-left">
            <DialogTitle className="text-base leading-snug font-semibold">{title}</DialogTitle>
            <DialogDescription className="text-[11px]">{t("hint")}</DialogDescription>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto px-5 py-4">
            <SignalPromptsBody state={state} onSelect={setSelected} />
          </div>
        </DialogContent>
      </Dialog>

      <AnswerModal
        brand=""
        variant="citation"
        promptText={selected?.promptText ?? ""}
        answers={selected?.answers ?? []}
        open={selected !== null}
        onOpenChange={(o) => {
          if (!o) setSelected(null);
        }}
      />
    </>
  );
}

/** 다이얼로그 본문(로딩·오류·빈 목록·목록). 정적 렌더 테스트가 상태별 마크업을 고정한다. */
export function SignalPromptsBody({
  state,
  onSelect,
}: {
  state: SignalPromptsState;
  onSelect: (p: MentionsPromptLive) => void;
}) {
  const t = useTranslations("answerAnalysis.mentions.signalDrilldown");
  return state.status === "loading" ? (
    <p className="inline-flex items-center gap-2 text-xs text-muted-foreground">
      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
      {t("loading")}
    </p>
  ) : state.status === "error" ? (
    <p className="inline-flex items-center gap-2 text-xs text-destructive">
      <AlertCircle className="h-3.5 w-3.5" aria-hidden />
      {t("error")}
    </p>
  ) : state.list.length === 0 ? (
    <p className="text-xs text-muted-foreground">{t("empty")}</p>
  ) : (
    <>
      <ul className="flex flex-col gap-2">
        {state.list.map((p) => {
          const hasAnswers = p.answers.length > 0;
          return (
            <li
              key={p.id}
              className={cn(
                "rounded-md border border-border bg-card px-3 py-2",
                hasAnswers && "cursor-pointer hover:bg-muted/40",
              )}
              onClick={hasAnswers ? () => onSelect(p) : undefined}
            >
              <p className="line-clamp-2 text-sm text-foreground">
                {hasAnswers ? (
                  <span className="group inline-flex items-start gap-1.5 text-left">
                    <MessageSquareText
                      className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-500"
                      aria-hidden
                    />
                    <span className="underline-offset-2 group-hover:underline">
                      {p.promptText}
                    </span>
                  </span>
                ) : (
                  p.promptText
                )}
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                <span className="tabular-nums">{t("signalCount", { count: p.mentions })}</span>
                <span className="tabular-nums">{t("engines", { count: p.providers.length })}</span>
                {p.funnelStage ? (
                  <Badge variant="outline" className="h-5 text-[10px] capitalize">
                    {p.funnelStage}
                  </Badge>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      <TruncatedNote shown={state.list.length} total={state.total} className="mt-2 text-[11px] text-muted-foreground" />
    </>
  );
}
