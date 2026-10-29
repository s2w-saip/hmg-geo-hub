"use client";

import { useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ChevronDown, ChevronRight, Download } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { downloadCsv, dateStamp } from "@/lib/export/csv";
import { PROMPT_AUDIT_EVENT_TYPES } from "@/lib/standards/audit";
import type { PromptAuditLogView } from "@/lib/db/repositories/prompt-audit-logs";

// 전역 변경 이력 (catalog-prompt-audit) — /standard/prompts의 이력 탭. 서버가
// 최근 90일(상한 500건)을 브랜드 스코프로 내려주고, 여기서는 클라이언트 필터
// (기간·이벤트 종류) + batch 접기 + CSV export만 한다. 카탈로그 규모(수백 행 ×
// admin 편집)에서 페이지네이션은 YAGNI.

interface BatchGroup {
  key: string;
  batchId: string | null;
  rows: PromptAuditLogView[];
}

export function AuditHistoryView({ initialRows }: { initialRows: PromptAuditLogView[] }) {
  const t = useTranslations("promptAudit");
  const th = useTranslations("promptAudit.history");
  const locale = useLocale();
  const [days, setDays] = useState<"30" | "90">("90");
  const [eventFilter, setEventFilter] = useState<string>("all");
  const [openBatches, setOpenBatches] = useState<Set<string>>(new Set());

  const fmt = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }),
    [locale],
  );

  const filtered = useMemo(() => {
    const since = Date.now() - Number(days) * 24 * 60 * 60 * 1000;
    return initialRows.filter((r) => {
      if (new Date(r.createdAt).getTime() < since) return false;
      if (eventFilter !== "all" && r.eventType !== eventFilter) return false;
      return true;
    });
  }, [initialRows, days, eventFilter]);

  // 같은 batchId의 연속 행을 한 그룹으로 접는다 (행은 이미 최신순 정렬).
  const groups = useMemo<BatchGroup[]>(() => {
    const out: BatchGroup[] = [];
    for (const row of filtered) {
      const last = out[out.length - 1];
      if (row.batchId && last && last.batchId === row.batchId) {
        last.rows.push(row);
      } else {
        out.push({ key: row.id, batchId: row.batchId, rows: [row] });
      }
    }
    return out;
  }, [filtered]);

  function toggleBatch(key: string) {
    setOpenBatches((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function onExport() {
    downloadCsv(
      `prompt-audit-${dateStamp()}`,
      [th("colWhen"), th("colPrompt"), th("colEvent"), th("colActor"), th("colChanges")],
      filtered.map((r) => [
        fmt.format(new Date(r.createdAt)),
        r.promptText ?? r.promptId,
        t(`events.${r.eventType}`),
        r.actorEmail ?? t("actorUnknown"),
        Object.entries(r.changes)
          .map(([f, c]) => `${f}: ${c.old ?? "—"} → ${c.new ?? "—"}`)
          .join(" | "),
      ]),
    );
  }

  function eventRow(r: PromptAuditLogView, indent = false) {
    return (
      <tr key={r.id} className={"border-t border-border align-top" + (indent ? " bg-muted/20" : "")}>
        <td className="whitespace-nowrap px-3 py-2.5 text-xs tabular-nums text-muted-foreground">
          {(indent ? "· " : "") + fmt.format(new Date(r.createdAt))}
        </td>
        <td className="max-w-72 px-3 py-2.5 text-xs text-foreground">
          <span className="line-clamp-2">{r.promptText ?? r.promptId}</span>
        </td>
        <td className="px-3 py-2.5">
          <Badge variant="secondary" className="text-[10px]">
            {t(`events.${r.eventType}`)}
          </Badge>
        </td>
        <td className="whitespace-nowrap px-3 py-2.5 text-xs text-muted-foreground">
          {r.actorEmail ?? t("actorUnknown")}
        </td>
        <td className="px-3 py-2.5 text-xs text-muted-foreground">
          <div className="flex flex-col gap-0.5">
            {/* 본문(text) 전문 old/new는 상시 노출하지 않는다 — 펼쳐야 보인다
                (2026-08-13 피드백). 짧은 라벨 필드는 인라인 유지. */}
            {Object.entries(r.changes).map(([f, c]) =>
              f === "text" ? (
                <details key={f}>
                  <summary className="cursor-pointer list-none text-foreground underline decoration-dotted underline-offset-2 [&::-webkit-details-marker]:hidden">
                    {th("viewTextDiff")}
                  </summary>
                  <div className="mt-1 flex flex-col gap-1">
                    <span className="break-all line-through decoration-destructive/40">
                      {c.old ?? "—"}
                    </span>
                    <span className="break-all text-foreground">{c.new ?? "—"}</span>
                  </div>
                </details>
              ) : (
                <span key={f} className="break-all">
                  <span className="font-medium text-foreground">{f}</span>
                  {": "}
                  <span className="line-through decoration-destructive/40">{c.old ?? "—"}</span>
                  {" → "}
                  {c.new ?? "—"}
                </span>
              ),
            )}
          </div>
        </td>
      </tr>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor="pa-days" className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {th("filterPeriod")}
        </Label>
        <Select value={days} onValueChange={(v) => setDays(v as typeof days)}>
          <SelectTrigger id="pa-days" size="sm" className="w-fit min-w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="30">{th("days30")}</SelectItem>
            <SelectItem value="90">{th("days90")}</SelectItem>
          </SelectContent>
        </Select>
        <Label htmlFor="pa-event" className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {th("filterEvent")}
        </Label>
        <Select value={eventFilter} onValueChange={setEventFilter}>
          <SelectTrigger id="pa-event" size="sm" className="w-fit min-w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{th("filterAll")}</SelectItem>
            {PROMPT_AUDIT_EVENT_TYPES.map((ev) => (
              <SelectItem key={ev} value={ev}>
                {t(`events.${ev}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
          {th("shownCount", { count: filtered.length })}
        </span>
        <Button type="button" variant="outline" size="sm" onClick={onExport} disabled={filtered.length === 0}>
          <Download className="h-3.5 w-3.5" aria-hidden />
          {th("exportCsv")}
        </Button>
      </div>

      {groups.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          {t("empty")}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2 w-40">{th("colWhen")}</th>
                <th className="min-w-56 px-3 py-2">{th("colPrompt")}</th>
                <th className="px-3 py-2 w-28">{th("colEvent")}</th>
                <th className="px-3 py-2 w-44">{th("colActor")}</th>
                <th className="min-w-64 px-3 py-2">{th("colChanges")}</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) =>
                g.rows.length === 1 ? (
                  eventRow(g.rows[0])
                ) : (
                  [
                    <tr key={g.key} className="border-t border-border bg-muted/30">
                      <td className="whitespace-nowrap px-3 py-2 text-xs tabular-nums text-muted-foreground">
                        {fmt.format(new Date(g.rows[0].createdAt))}
                      </td>
                      <td colSpan={4} className="px-3 py-2">
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 text-xs font-medium text-foreground"
                          onClick={() => toggleBatch(g.key)}
                          aria-expanded={openBatches.has(g.key)}
                        >
                          {openBatches.has(g.key) ? (
                            <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5" aria-hidden />
                          )}
                          {th("bulkGroup", { count: g.rows.length })}
                          <span className="font-normal text-muted-foreground">
                            {g.rows[0].actorEmail ?? t("actorUnknown")}
                          </span>
                        </button>
                      </td>
                    </tr>,
                    ...(openBatches.has(g.key) ? g.rows.map((r) => eventRow(r, true)) : []),
                  ]
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
