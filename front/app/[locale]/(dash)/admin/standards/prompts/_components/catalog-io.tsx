"use client";

import { useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Download, Upload, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  exportStandardCatalogXlsx,
  previewStandardCatalogImport,
  applyStandardCatalogChunk,
  type CatalogBulkItem,
  type CatalogImportPreview,
} from "../../_actions";

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// 벌크 xlsx (catalog-prompt-audit): 내보내기(=편집 템플릿) → 수정본 업로드 →
// 프리뷰(변경 대조) → 청크 적용(진행률·실패 재시도). 585행 × Scope PATCH를 한
// 액션에 못 태우므로(서버리스 타임아웃) 클라이언트가 CHUNK 단위로 순차 호출한다.
const CHUNK = 25;

type ApplyState =
  | { phase: "idle" }
  | { phase: "applying"; done: number; total: number }
  | { phase: "done"; applied: number; failed: { id: string; error: string }[] };

export function CatalogIo() {
  const t = useTranslations("adminStandardPrompts.io");
  const [exporting, startExport] = useTransition();
  const [previewing, startPreview] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<CatalogImportPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [apply, setApply] = useState<ApplyState>({ phase: "idle" });

  function onExport() {
    startExport(async () => {
      const r = await exportStandardCatalogXlsx();
      if (!r.ok) {
        setPreviewError(r.error);
        return;
      }
      const bin = atob(r.value.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes], { type: XLSX_MIME }));
      const a = document.createElement("a");
      a.href = url;
      a.download = r.value.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    });
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;
    const fd = new FormData();
    fd.set("file", file);
    setPreviewError(null);
    startPreview(async () => {
      const r = await previewStandardCatalogImport(fd);
      if (!r.ok) {
        setPreviewError(r.error);
        return;
      }
      setApply({ phase: "idle" });
      setPreview(r.value);
    });
  }

  async function applyItems(items: CatalogBulkItem[], batchId: string) {
    let applied = 0;
    const failed: { id: string; error: string }[] = [];
    for (let i = 0; i < items.length; i += CHUNK) {
      const chunk = items.slice(i, i + CHUNK);
      setApply({ phase: "applying", done: i, total: items.length });
      const r = await applyStandardCatalogChunk(chunk, batchId);
      if (!r.ok) {
        // 청크 자체가 거부된 경우(권한 등) — 남은 항목 전부 실패 처리.
        for (const it of items.slice(i)) failed.push({ id: it.id, error: r.error });
        break;
      }
      applied += r.value.applied;
      failed.push(...r.value.failed);
    }
    setApply({ phase: "done", applied, failed });
  }

  function onApply() {
    if (!preview) return;
    void applyItems(preview.items.map((i) => i.item), preview.batchId);
  }

  function onRetryFailed() {
    if (!preview || apply.phase !== "done" || apply.failed.length === 0) return;
    const failedIds = new Set(apply.failed.map((f) => f.id));
    const items = preview.items.filter((i) => failedIds.has(i.id)).map((i) => i.item);
    void applyItems(items, preview.batchId);
  }

  function closePreview() {
    // 적용 도중에는 닫기 방지(청크 순차 호출 중단 혼란 방지).
    if (apply.phase === "applying") return;
    setPreview(null);
    setApply({ phase: "idle" });
  }

  return (
    <div className="flex items-center gap-2">
      {previewError ? (
        <span className="text-[11px] text-destructive">{previewError}</span>
      ) : null}
      <Button type="button" variant="outline" size="sm" onClick={onExport} disabled={exporting}>
        <Download className="h-3.5 w-3.5" aria-hidden />
        {t("export")}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => fileRef.current?.click()}
        disabled={previewing}
        aria-busy={previewing}
      >
        {previewing ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        ) : (
          <Upload className="h-3.5 w-3.5" aria-hidden />
        )}
        {t("import")}
      </Button>
      <input ref={fileRef} type="file" accept=".xlsx" className="hidden" onChange={onFile} />

      <Dialog open={preview !== null} onOpenChange={(open) => (!open ? closePreview() : null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t("previewTitle")}</DialogTitle>
          </DialogHeader>
          {preview ? (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Badge variant="secondary" className="tabular-nums">
                  {t("previewChanges", { count: preview.items.length })}
                </Badge>
                <Badge variant="outline" className="tabular-nums text-muted-foreground">
                  {t("previewUnchanged", { count: preview.unchanged })}
                </Badge>
                {preview.unmatchedIds.length > 0 ? (
                  <Badge variant="outline" className="border-amber-400 bg-amber-50 tabular-nums text-amber-900">
                    {t("previewUnmatched", { count: preview.unmatchedIds.length })}
                  </Badge>
                ) : null}
              </div>
              {preview.warnings.length > 0 ? (
                <ul className="max-h-24 list-disc overflow-y-auto pl-4 text-[11px] text-amber-700">
                  {preview.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              ) : null}
              <div className="max-h-80 overflow-y-auto rounded-md border border-border">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-muted/50">
                    <tr className="text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      <th className="px-2 py-1.5">{t("colPrompt")}</th>
                      <th className="px-2 py-1.5">{t("colChanges")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.items.map((item) => (
                      <tr key={item.id} className="border-t border-border align-top">
                        <td className="max-w-64 px-2 py-2 text-muted-foreground">
                          <span className="line-clamp-2">{item.currentText}</span>
                        </td>
                        <td className="px-2 py-2">
                          <div className="flex flex-col gap-1">
                            {Object.entries(item.changes).map(([field, c]) => (
                              <div key={field} className="flex flex-col">
                                <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                                  {field}
                                </span>
                                <span className="text-destructive/80 line-through decoration-destructive/40">
                                  {c.old ?? "—"}
                                </span>
                                <span className="text-foreground">{c.new ?? "—"}</span>
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {apply.phase === "applying" ? (
                <p className="text-xs text-muted-foreground tabular-nums" aria-live="polite">
                  {t("applying", { done: apply.done, total: apply.total })}
                </p>
              ) : null}
              {apply.phase === "done" ? (
                <div className="flex flex-col gap-1.5">
                  <p className="text-xs text-foreground tabular-nums">
                    {t("applyDone", { applied: apply.applied, failed: apply.failed.length })}
                  </p>
                  {apply.failed.length > 0 ? (
                    <ul className="max-h-24 list-disc overflow-y-auto pl-4 text-[11px] text-destructive">
                      {apply.failed.slice(0, 10).map((f) => (
                        <li key={f.id}>
                          {f.id}: {f.error}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={closePreview}
              disabled={apply.phase === "applying"}
            >
              {apply.phase === "done" ? t("previewClose") : t("previewCancel")}
            </Button>
            {apply.phase === "done" && apply.failed.length > 0 ? (
              <Button type="button" variant="outline" size="sm" onClick={onRetryFailed}>
                {t("applyRetryFailed")}
              </Button>
            ) : null}
            {apply.phase === "idle" && preview && preview.items.length > 0 ? (
              <Button type="button" size="sm" onClick={onApply}>
                {t("previewApply", { count: preview.items.length })}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
