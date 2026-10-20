"use client";

// Change history of the renewal Global prompts page — the original page's two history
// surfaces in the renewal design, with their data and rules unchanged:
//   RnPromptTimeline  per-prompt timeline (fetchPromptAuditTimeline, newest first)
//   RnAuditHistory    the 90-day feed tab (30/90-day and event filters, bulk grouping, CSV)

import { Fragment, useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ChevronRight, Download } from "lucide-react";
import { RnButton, RnDrawer, RnEmpty, RnSelect, cx } from "@/components/renewal-ui";
import { fetchPromptAuditTimeline } from "@/app/[locale]/(dash)/standard/prompts/_actions";
import { PROMPT_AUDIT_EVENT_TYPES } from "@/lib/standards/audit";
import { dateStamp, downloadCsv } from "@/lib/export/csv";
import type { PromptAuditLogView } from "@/lib/db/repositories/prompt-audit-logs";

type LoadState = { phase: "loading" } | { phase: "error" } | { phase: "ready"; rows: PromptAuditLogView[] };

function Changes({ changes, textToggle }: { changes: PromptAuditLogView["changes"]; textToggle: string }) {
  const t = useTranslations("promptAudit");
  return (
    <div className="flex flex-col gap-1.5">
      {Object.entries(changes).map(([field, c]) =>
        field === "text" ? (
          <details key={field} className="group/text">
            <summary className="cursor-pointer list-none text-rn-12 font-semibold text-rn-navy underline decoration-dotted underline-offset-3 [&::-webkit-details-marker]:hidden">{textToggle}</summary>
            <div className="mt-1.5 grid grid-cols-2 gap-2 text-rn-12">
              <div className="flex flex-col gap-0.5">
                <span className="text-rn-11 font-semibold text-rn-muted">{t("diffOld")}</span>
                <p className="m-0 rounded-md bg-rn-page p-2 whitespace-pre-wrap text-rn-muted">{c.old ?? "—"}</p>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-rn-11 font-semibold text-rn-muted">{t("diffNew")}</span>
                <p className="m-0 rounded-md bg-rn-page p-2 whitespace-pre-wrap text-rn-ink">{c.new ?? "—"}</p>
              </div>
            </div>
          </details>
        ) : (
          <p key={field} className="m-0 text-rn-12 break-all text-rn-muted">
            <span className="font-semibold text-rn-ink-2">{field}</span>
            {": "}
            <span className="line-through decoration-rn-down/40">{c.old ?? "—"}</span>
            {" → "}
            <span className="text-rn-ink">{c.new ?? "—"}</span>
          </p>
        ),
      )}
    </div>
  );
}

export function RnPromptTimeline({ row, onClose, closeLabel }: { row: { id: string; text: string } | null; onClose: () => void; closeLabel: string }) {
  const t = useTranslations("promptAudit");
  const th = useTranslations("promptAudit.history");
  const locale = useLocale();
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  useEffect(() => {
    if (!row) return;
    let cancelled = false;
    setState({ phase: "loading" });
    fetchPromptAuditTimeline(row.id)
      .then((res) => !cancelled && setState(res.ok ? { phase: "ready", rows: res.value } : { phase: "error" }))
      .catch(() => !cancelled && setState({ phase: "error" }));
    return () => {
      cancelled = true;
    };
  }, [row]);
  const fmt = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }), [locale]);
  return (
    <RnDrawer open={row !== null} onClose={onClose} title={t("timelineTitle")} subtitle={row?.text} closeLabel={closeLabel}>
      {state.phase === "loading" ? (
        <p className="m-0 text-rn-13 text-rn-muted">{t("loading")}</p>
      ) : state.phase === "error" ? (
        <p className="m-0 text-rn-13 text-rn-danger-ink">{t("loadFailed")}</p>
      ) : state.rows.length === 0 ? (
        <RnEmpty>{t("empty")}</RnEmpty>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-0 p-0">
          {state.rows.map((ev, i) => (
            <li key={ev.id} className="relative grid grid-cols-[16px_minmax(0,1fr)] gap-3 pb-4">
              <span aria-hidden className={cx("mt-1 size-2.5 rounded-full", i === 0 ? "bg-rn-navy" : "bg-rn-navy-300")} />
              {i < state.rows.length - 1 ? <span aria-hidden className="absolute top-4 bottom-0 left-[4px] w-px bg-rn-line-2" /> : null}
              <div className="flex min-w-0 flex-col gap-1.5">
                <div className="flex flex-wrap items-center gap-2 text-rn-12">
                  <span className="rounded-md bg-rn-navy/8 px-1.5 py-px font-bold text-rn-navy">{t(`events.${ev.eventType}` as "events.created")}</span>
                  <span className="text-rn-muted tabular-nums">{fmt.format(new Date(ev.createdAt))}</span>
                  <span className="text-rn-muted">{ev.actorEmail ?? t("actorUnknown")}</span>
                  {ev.batchId ? <span className="rounded-md px-1.5 text-rn-muted shadow-[inset_0_0_0_1px_var(--color-rn-line-2)]">{t("bulkBadge")}</span> : null}
                </div>
                <Changes changes={ev.changes} textToggle={th("viewTextDiff")} />
              </div>
            </li>
          ))}
        </ol>
      )}
    </RnDrawer>
  );
}

interface BatchGroup {
  key: string;
  batchId: string | null;
  rows: PromptAuditLogView[];
}

export function RnAuditHistory({ initialRows }: { initialRows: PromptAuditLogView[] }) {
  const t = useTranslations("promptAudit");
  const th = useTranslations("promptAudit.history");
  const locale = useLocale();
  const [days, setDays] = useState<"30" | "90">("90");
  const [eventFilter, setEventFilter] = useState<string>("all");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const fmt = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }), [locale]);
  const filtered = useMemo(() => {
    const since = Date.now() - Number(days) * 24 * 60 * 60 * 1000;
    return initialRows.filter((r) => new Date(r.createdAt).getTime() >= since && (eventFilter === "all" || r.eventType === eventFilter));
  }, [initialRows, days, eventFilter]);
  // consecutive rows of one bulk batch fold into one expandable group (the original rule)
  const groups = useMemo<BatchGroup[]>(() => {
    const out: BatchGroup[] = [];
    for (const row of filtered) {
      const last = out[out.length - 1];
      if (row.batchId && last && last.batchId === row.batchId) last.rows.push(row);
      else out.push({ key: row.id, batchId: row.batchId, rows: [row] });
    }
    return out;
  }, [filtered]);
  const onExport = () =>
    downloadCsv(
      `prompt-audit-${dateStamp()}`,
      [th("colWhen"), th("colPrompt"), th("colEvent"), th("colActor"), th("colChanges")],
      filtered.map((r) => [
        fmt.format(new Date(r.createdAt)),
        r.promptText ?? r.promptId,
        t(`events.${r.eventType}` as "events.created"),
        r.actorEmail ?? t("actorUnknown"),
        Object.entries(r.changes)
          .map(([f, c]) => `${f}: ${c.old ?? "—"} → ${c.new ?? "—"}`)
          .join(" | "),
      ]),
    );
  const eventRow = (r: PromptAuditLogView, indent = false) => (
    <tr key={r.id} className={cx("align-top", indent && "bg-rn-page")}>
      <td className="border-b border-rn-line py-2.5 pr-3 pl-1 text-rn-12 whitespace-nowrap text-rn-muted tabular-nums">{(indent ? "· " : "") + fmt.format(new Date(r.createdAt))}</td>
      <td className="border-b border-rn-line px-3 py-2.5 text-rn-12 text-rn-ink">
        <span className="line-clamp-2">{r.promptText ?? r.promptId}</span>
      </td>
      <td className="border-b border-rn-line px-3 py-2.5">
        <span className="rounded-md bg-rn-navy/8 px-1.5 py-px text-rn-12 font-bold text-rn-navy">{t(`events.${r.eventType}` as "events.created")}</span>
      </td>
      <td className="border-b border-rn-line px-3 py-2.5 text-rn-12 break-all text-rn-muted">{r.actorEmail ?? t("actorUnknown")}</td>
      <td className="border-b border-rn-line px-3 py-2.5">
        <Changes changes={r.changes} textToggle={th("viewTextDiff")} />
      </td>
    </tr>
  );
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="m-0 text-rn-15 font-bold text-rn-ink">{th("sectionTitle")}</h2>
        <p className="m-0 mt-1 text-rn-12 text-rn-muted">{th("sectionDescription")}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <RnSelect label={th("filterPeriod")} value={days} onChange={(e) => setDays(e.target.value as "30" | "90")} options={[{ value: "30", label: th("days30") }, { value: "90", label: th("days90") }]} />
        <RnSelect
          label={th("filterEvent")}
          value={eventFilter}
          onChange={(e) => setEventFilter(e.target.value)}
          options={[{ value: "all", label: `${th("filterEvent")} · ${th("filterAll")}` }, ...PROMPT_AUDIT_EVENT_TYPES.map((ev) => ({ value: ev, label: t(`events.${ev}` as "events.created") }))]}
        />
        <span className="ml-auto text-rn-12 text-rn-muted tabular-nums">{th("shownCount", { count: filtered.length })}</span>
        <RnButton size="sm" onClick={onExport} disabled={filtered.length === 0}>
          <Download className="size-3.5" aria-hidden />
          {th("exportCsv")}
        </RnButton>
      </div>
      {groups.length === 0 ? (
        <RnEmpty>{t("empty")}</RnEmpty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full table-fixed border-separate border-spacing-0 text-rn-13">
            <colgroup>
              <col className="w-[150px]" />
              <col />
              <col className="w-[104px]" />
              <col className="w-[150px]" />
              <col className="w-[34%]" />
            </colgroup>
            <thead>
              <tr className="text-left text-rn-12 font-semibold text-rn-muted">
                {[th("colWhen"), th("colPrompt"), th("colEvent"), th("colActor"), th("colChanges")].map((h, i) => (
                  <th key={h} scope="col" className={cx("h-[38px] border-b border-rn-line-2 font-semibold", i === 0 ? "pr-3 pl-1" : "px-3")}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groups.map((g) =>
                g.rows.length === 1 ? (
                  eventRow(g.rows[0])
                ) : (
                  <Fragment key={g.key}>
                    <tr className="bg-rn-page">
                      <td className="border-b border-rn-line py-2 pr-3 pl-1 text-rn-12 whitespace-nowrap text-rn-muted tabular-nums">{fmt.format(new Date(g.rows[0].createdAt))}</td>
                      <td colSpan={4} className="border-b border-rn-line px-3 py-2">
                        <button
                          type="button"
                          aria-expanded={open.has(g.key)}
                          onClick={() =>
                            setOpen((cur) => {
                              const n = new Set(cur);
                              if (n.has(g.key)) n.delete(g.key);
                              else n.add(g.key);
                              return n;
                            })
                          }
                          className="inline-flex cursor-pointer items-center gap-1.5 text-rn-12 font-semibold text-rn-ink focus-visible:outline-2 focus-visible:outline-rn-navy"
                        >
                          <ChevronRight aria-hidden className={cx("size-3.5 transition-transform", open.has(g.key) && "rotate-90")} />
                          {th("bulkGroup", { count: g.rows.length })}
                          <span className="font-normal text-rn-muted">{g.rows[0].actorEmail ?? t("actorUnknown")}</span>
                        </button>
                      </td>
                    </tr>
                    {open.has(g.key) ? g.rows.map((r) => eventRow(r, true)) : null}
                  </Fragment>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
