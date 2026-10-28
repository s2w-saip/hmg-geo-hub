"use client";

// Change history of the renewal Global prompts page — the original page's two history
// surfaces in the renewal design, with their data and rules unchanged:
//   RnPromptTimeline  per-prompt timeline (screen catalog/prompts-timeline, newest first), the
//                     history part of the prompt detail sheet (prompt-detail.tsx)
//   RnAuditHistory    the 90-day feed tab (30/90-day and event filters and bulk grouping by the
//                     screen catalog/prompts-history; CSV of what it shows)

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ChevronRight, Download } from "lucide-react";
import { RnButton, RnEmpty, RnSelect, cx } from "@/components/renewal-ui";
import { PROMPT_AUDIT_EVENT_TYPES } from "@/lib/standards/audit";
import { dateStamp, downloadCsv } from "@/lib/export/csv";
import type { AuditRow, HistoryQuery, PromptsHistory } from "@/app/[locale]/(dash)/standard/prompts/_data/screen-types";
import { fetchPromptTimeline, fetchPromptsHistory } from "@/app/[locale]/(dash)/standard/prompts/_data/prompts-client";
import { RnChanges, RnTimeline } from "../../../_components/prompt-list";

type LoadState = { phase: "loading" } | { phase: "error" } | { phase: "unavailable" } | { phase: "ready"; rows: AuditRow[] };

export function RnPromptTimeline({ id }: { id: string }) {
  const t = useTranslations("promptAudit");
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  useEffect(() => {
    let cancelled = false;
    setState({ phase: "loading" });
    fetchPromptTimeline(id)
      .then((res) => !cancelled && setState(res.available ? { phase: "ready", rows: res.rows } : { phase: "unavailable" }))
      .catch(() => !cancelled && setState({ phase: "error" }));
    return () => {
      cancelled = true;
    };
  }, [id]);
  if (state.phase === "loading") return <p className="m-0 text-rn-13 text-rn-muted">{t("loading")}</p>;
  if (state.phase === "error") return <p className="m-0 text-rn-13 text-rn-danger-ink">{t("loadFailed")}</p>;
  if (state.phase === "unavailable") return <RnEmpty>{t("sourceUnavailable")}</RnEmpty>;
  if (state.rows.length === 0) return <RnEmpty>{t("empty")}</RnEmpty>;
  return (
    <RnTimeline
      events={state.rows.map((ev) => ({
        key: ev.id,
        label: t(`events.${ev.eventType}` as "events.created"),
        at: ev.createdAt,
        actor: ev.actorEmail ?? t("actorUnknown"),
        marks: ev.batchId ? [t("bulkBadge")] : [],
        changes: ev.changes,
      }))}
    />
  );
}

export function RnAuditHistory({ initial, load = fetchPromptsHistory }: { initial: PromptsHistory; load?: (query: HistoryQuery) => Promise<PromptsHistory> }) {
  const t = useTranslations("promptAudit");
  const th = useTranslations("promptAudit.history");
  const locale = useLocale();
  const [days, setDays] = useState<"30" | "90">("90");
  const [eventFilter, setEventFilter] = useState<string>("all");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [history, setHistory] = useState(initial);
  const [readError, setReadError] = useState(false);
  const firstRead = useRef(true);
  const fmt = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }), [locale]);
  useEffect(() => {
    if (firstRead.current) {
      firstRead.current = false;
      return;
    }
    let active = true;
    load({ days, event: eventFilter })
      .then((res) => {
        if (!active) return;
        setHistory(res);
        setReadError(false);
      })
      .catch(() => active && setReadError(true));
    return () => {
      active = false;
    };
  }, [days, eventFilter, load]);
  // consecutive rows of one bulk batch come folded into one expandable group (the original rule)
  const groups = history.groups;
  const filtered = useMemo(() => groups.flatMap((g) => g.rows), [groups]);
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
  const eventRow = (r: AuditRow, indent = false) => (
    <tr key={r.id} className={cx("align-top", indent && "bg-rn-page")}>
      <td className="border-b border-rn-line py-2.5 pr-3 pl-1 text-rn-12 text-rn-muted">
        <span className="block whitespace-nowrap tabular-nums">{(indent ? "· " : "") + fmt.format(new Date(r.createdAt))}</span>
        <span className="mt-0.5 block break-all text-rn-11">{r.actorEmail ?? t("actorUnknown")}</span>
      </td>
      <td className="border-b border-rn-line px-3 py-2.5 text-rn-12 text-rn-ink">
        <span className="rounded-md bg-rn-navy/8 px-1.5 py-px text-rn-12 font-bold text-rn-navy">{t(`events.${r.eventType}` as "events.created")}</span>
        <span className="mt-1 line-clamp-2">{r.promptText ?? r.promptId}</span>
      </td>
      <td className="border-b border-rn-line px-3 py-2.5">
        <RnChanges changes={r.changes} textToggle={th("viewTextDiff")} />
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
        <span className="ml-auto text-rn-12 text-rn-muted tabular-nums">{th("shownCount", { count: history.shown })}</span>
        <RnButton size="sm" onClick={onExport} disabled={filtered.length === 0}>
          <Download className="size-3.5" aria-hidden />
          {th("exportCsv")}
        </RnButton>
      </div>
      {readError ? (
        <p className="m-0 text-rn-13 text-rn-danger-ink">{t("loadFailed")}</p>
      ) : groups.length === 0 ? (
        <RnEmpty>{history.available ? t("empty") : t("sourceUnavailable")}</RnEmpty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full table-fixed border-separate border-spacing-0 text-rn-13">
            {/* the actor sits under the date and the event badge above the prompt (not their
                own columns) so the prompt column stays readable with the filter panel open */}
            <colgroup>
              <col className="w-[156px]" />
              <col />
              <col className="w-[34%]" />
            </colgroup>
            <thead>
              <tr className="text-left text-rn-12 font-semibold text-rn-muted">
                {[`${th("colWhen")} · ${th("colActor")}`, `${th("colEvent")} · ${th("colPrompt")}`, th("colChanges")].map((h, i) => (
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
                      <td colSpan={2} className="border-b border-rn-line px-3 py-2">
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
