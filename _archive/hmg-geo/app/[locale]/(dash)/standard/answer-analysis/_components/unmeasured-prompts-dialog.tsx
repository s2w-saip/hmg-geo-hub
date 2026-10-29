"use client";

// 측정 개요 카드 "미측정" 행의 ↗ 버튼 → 미측정 프롬프트 목록 모달(피그마 1:1, 2026-09-02).
// 열릴 때마다 현재 URL 필터로 /api/scope/unmeasured-prompts 를 lazy fetch 한다 —
// 목록은 카드 값과 같은 정의(적용 − 측정)이고, 서버 카운트와 total 이 같아야 한다.

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { AlertCircle, ExternalLink, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import type { UnmeasuredPrompt } from "@/lib/db/repositories/scope-aggregates";

export function UnmeasuredPromptsButton({ count }: { count: number | null }) {
  const t = useTranslations("answerAnalysis.mentions.kpi.overview.unmeasuredDialog");
  const [open, setOpen] = useState(false);
  if (count == null || count <= 0) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t("open")}
        className="text-muted-foreground hover:text-foreground"
      >
        <ExternalLink className="h-3 w-3" aria-hidden />
      </button>
      {open ? <UnmeasuredPromptsDialog onOpenChange={setOpen} /> : null}
    </>
  );
}

function UnmeasuredPromptsDialog({ onOpenChange }: { onOpenChange: (o: boolean) => void }) {
  const t = useTranslations("answerAnalysis.mentions.kpi.overview.unmeasuredDialog");
  const sp = useSearchParams();
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ready"; total: number; rows: UnmeasuredPrompt[] }
    | { status: "error" }
  >({ status: "loading" });

  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`/api/scope/unmeasured-prompts?${sp.toString()}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("failed"))))
      .then((j: { result: { total: number; rows: UnmeasuredPrompt[] } | null }) => {
        if (!j.result) setState({ status: "error" });
        else setState({ status: "ready", total: j.result.total, rows: j.result.rows });
      })
      .catch((e: unknown) => {
        if ((e as { name?: string })?.name === "AbortError") return;
        setState({ status: "error" });
      });
    return () => ctrl.abort();
  }, [sp]);

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>
            {state.status === "ready" ? t("description", { n: state.total }) : t("descriptionLoading")}
          </DialogDescription>
        </DialogHeader>
        {state.status === "loading" ? (
          <div className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {t("loading")}
          </div>
        ) : state.status === "error" ? (
          <div className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground">
            <AlertCircle className="h-4 w-4" aria-hidden /> {t("error")}
          </div>
        ) : state.rows.length === 0 ? (
          <p className="py-10 text-center text-xs text-muted-foreground">{t("empty")}</p>
        ) : (
          <div className="max-h-[60vh] overflow-y-auto rounded-md border border-border">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-bg-soft">
                <tr className="border-b border-border text-left text-[11px] font-medium text-muted-foreground">
                  <th className="px-3 py-2">{t("col.prompt")}</th>
                  <th className="w-40 px-3 py-2">{t("col.taxonomy")}</th>
                  <th className="w-24 px-3 py-2">{t("col.funnel")}</th>
                </tr>
              </thead>
              <tbody>
                {state.rows.map((r) => (
                  <tr key={r.id} className="border-t border-border first:border-t-0">
                    <td className="px-3 py-2 text-foreground">{r.text}</td>
                    <td className="px-3 py-2 text-[11px] text-muted-foreground">
                      {[r.listType, r.depth1, r.depth2].filter(Boolean).join(" · ") || "—"}
                    </td>
                    <td className="px-3 py-2">
                      {r.funnelStage ? <Badge variant="outline" className="text-[10px]">{r.funnelStage}</Badge> : <span className="text-xs text-muted-foreground">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {state.total > state.rows.length ? (
              <p className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
                {t("truncated", { shown: state.rows.length, total: state.total })}
              </p>
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
