"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
import type { AuditRow, HistoryQuery, PromptsHistory } from "../_data/screen-types";
import { fetchPromptsHistory } from "../_data/prompts-client";

// 전역 변경 이력 (catalog-prompt-audit) — /standard/prompts의 이력 탭. 기간(30·90일)·이벤트
// 종류 필터와 bulk 묶음 접기는 screen(catalog/prompts-history)이 하고, 여기서는 그 결과를
// 그리고 CSV 로 내보낸다. 원천이 변경 이력을 주지 않으면 그 사실을 적는다.

export function AuditHistoryView({ initial, load = fetchPromptsHistory }: { initial: PromptsHistory; load?: (query: HistoryQuery) => Promise<PromptsHistory> }) {
  const t = useTranslations("promptAudit");
  const th = useTranslations("promptAudit.history");
  const locale = useLocale();
  const [days, setDays] = useState<"30" | "90">("90");
  const [eventFilter, setEventFilter] = useState<string>("all");
  const [openBatches, setOpenBatches] = useState<Set<string>>(new Set());
  const [history, setHistory] = useState(initial);
  const [readError, setReadError] = useState<Error | null>(null);
  const firstRead = useRef(true);

  const fmt = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }),
    [locale],
  );

  useEffect(() => {
    if (firstRead.current) {
      firstRead.current = false;
      return;
    }
    let active = true;
    load({ days, event: eventFilter })
      .then((res) => active && setHistory(res))
      .catch((e: unknown) => active && setReadError(e instanceof Error ? e : new Error("History read failed")));
    return () => {
      active = false;
    };
  }, [days, eventFilter, load]);

  const groups = history.groups;
  const filtered = useMemo(() => groups.flatMap((g) => g.rows), [groups]);

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

  function eventRow(r: AuditRow, indent = false) {
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
          {th("shownCount", { count: history.shown })}
        </span>
        <Button type="button" variant="outline" size="sm" onClick={onExport} disabled={filtered.length === 0}>
          <Download className="h-3.5 w-3.5" aria-hidden />
          {th("exportCsv")}
        </Button>
      </div>

      {readError ? (
        <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-destructive">
          {t("loadFailed")}
        </p>
      ) : groups.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          {history.available ? t("empty") : t("sourceUnavailable")}
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
