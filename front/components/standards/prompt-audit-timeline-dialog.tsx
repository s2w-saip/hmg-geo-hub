"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { PromptAuditLogView } from "@/lib/db/repositories/prompt-audit-logs";

// 프롬프트별 변경 이력 타임라인 다이얼로그 (catalog-prompt-audit) — 그리기만 한다. 열릴 때 `load` 로
// 이력을 가져온다: admin 카탈로그는 열람 게이트의 서버 액션(prompt-audit-timeline.tsx),
// /standard/prompts 뷰어는 screen catalog/prompts-timeline (GET /api/standard/prompts/timeline).

/** A timeline event (createdAt as a Date or an ISO string). */
export type TimelineRow = Omit<PromptAuditLogView, "createdAt"> & { createdAt: Date | string };

/** What a load gives: the rows, a failure, or a source that does not supply the history. */
export type TimelineLoad = { phase: "ready"; rows: TimelineRow[] } | { phase: "error" } | { phase: "unavailable" };

type LoadState = { phase: "loading" } | TimelineLoad;

export function PromptAuditTimelineDialog({
  promptId,
  promptText,
  open,
  onOpenChange,
  load,
}: {
  promptId: string;
  promptText: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  load: (promptId: string) => Promise<TimelineLoad>;
}) {
  const t = useTranslations("promptAudit");
  const locale = useLocale();
  const [state, setState] = useState<LoadState>({ phase: "loading" });

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setState({ phase: "loading" });
    load(promptId)
      .then((res) => {
        if (!cancelled) setState(res);
      })
      .catch(() => {
        if (!cancelled) setState({ phase: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [open, promptId, load]);

  const fmt = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("timelineTitle")}</DialogTitle>
        </DialogHeader>
        <p className="line-clamp-2 text-xs text-muted-foreground">{promptText}</p>
        <div className="max-h-96 overflow-y-auto">
          {state.phase === "loading" ? (
            <p className="px-1 py-4 text-sm text-muted-foreground">{t("loading")}</p>
          ) : state.phase === "error" ? (
            <p className="px-1 py-4 text-sm text-destructive">{t("loadFailed")}</p>
          ) : state.phase === "unavailable" ? (
            <p className="px-1 py-4 text-sm text-muted-foreground">{t("sourceUnavailable")}</p>
          ) : state.rows.length === 0 ? (
            <p className="px-1 py-4 text-sm text-muted-foreground">{t("empty")}</p>
          ) : (
            <ol className="flex flex-col gap-2">
              {/* 이벤트는 요약 헤더(종류·시각·수정자)만 기본 표시 — 전문 old/new는
                  펼쳐야 보인다 (2026-08-13 피드백: 전후 전문 상시 노출은 낭비). */}
              {state.rows.map((ev) => (
                <li key={ev.id} className="rounded-md border border-border bg-card">
                  <details className="group">
                    <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-3 py-2.5 text-xs [&::-webkit-details-marker]:hidden">
                      <ChevronRight
                        className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
                        aria-hidden
                      />
                      <Badge variant="secondary" className="text-[10px]">
                        {t(`events.${ev.eventType}`)}
                      </Badge>
                      <span className="tabular-nums text-muted-foreground">
                        {fmt.format(new Date(ev.createdAt))}
                      </span>
                      <span className="text-muted-foreground">
                        {ev.actorEmail ?? t("actorUnknown")}
                      </span>
                      {ev.batchId ? (
                        <Badge variant="outline" className="text-[10px] text-muted-foreground">
                          {t("bulkBadge")}
                        </Badge>
                      ) : null}
                    </summary>
                    <div className="flex flex-col gap-1.5 border-t border-border px-3 py-2.5">
                      {Object.entries(ev.changes).map(([field, c]) =>
                        field === "text" ? (
                        <div key={field} className="grid grid-cols-2 gap-2 text-xs">
                          <div className="flex flex-col gap-0.5">
                            <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                              {t("diffOld")}
                            </span>
                            <pre className="whitespace-pre-wrap rounded bg-muted/40 p-2 font-sans text-muted-foreground">
                              {c.old ?? "—"}
                            </pre>
                          </div>
                          <div className="flex flex-col gap-0.5">
                            <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                              {t("diffNew")}
                            </span>
                            <pre className="whitespace-pre-wrap rounded bg-muted/40 p-2 font-sans text-foreground">
                              {c.new ?? "—"}
                            </pre>
                          </div>
                        </div>
                        ) : (
                          <p key={field} className="text-xs text-muted-foreground">
                            <span className="font-medium text-foreground">{field}</span>
                            {": "}
                            <span className="line-through decoration-destructive/40">
                              {c.old ?? "—"}
                            </span>
                            {" → "}
                            <span className="text-foreground">{c.new ?? "—"}</span>
                          </p>
                        ),
                      )}
                    </div>
                  </details>
                </li>
              ))}
            </ol>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
