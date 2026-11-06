"use client";

// Renewal Project › Prompt (2026-11-03): the project's prompts as the HUB holds them (decision '프로젝트 프롬프트 적재': the
// HUB is the 정본, the rows Gold imported first), in the one-line list of the renewal prompt pages, with a column per custom
// tag. The original page's writes are here: add drafts (one per line), a tag value in place or on the selected rows, the tag
// columns, a prompt's text and language while it is a draft, its measurement kind, pause · resume · delete · restore. Sending
// drafts to Scope (the
// original 실행) waits for the Scope path. Answers, engines, rounds and dates are Gold's in the lens (측정 국가 · AI 엔진 ·
// 기간: the answers a row counts, never the rows); the tags in the panel narrow the rows. A project holds ≤ 237 prompts, so the
// page filters, searches, sorts, pages and exports them here. A row opens its sheet.

import { useMemo, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Download, Loader2, Lock, Plus, Tags } from "lucide-react";
import { RnButton, RnCard, RnDrawer, RnEmpty, RnNote, RnSearchField, RnSegmented, RnSelect, cx, useRnToast, useRnTruncTip } from "@/components/renewal-ui";
import { ENGINE_LABEL } from "@/components/dash/dimension-filter-panel";
import { countryName } from "@/lib/geo-catalog/country-name";
import { languageName } from "@/lib/geo-catalog/language-name";
import { downloadXlsx } from "@/lib/export/xlsx";
import { exportFilename } from "@/app/[locale]/(dash)/standard/prompts/_components/prompt-export";
import { LIST_TD as TD, RnDetailField as Field, RnListPager, RnPromptText, RnSortHead } from "../../_components/prompt-list";
import { byEngineOrder, engineColor } from "../../website/prompts/_components/website-prompt-model";
import { StateMark } from "../../admin/standards/citation-sources/_components/source-lists-kit";
import { shortId } from "./project-model";
import { AddPromptsSheet, PromptHistory, TagFieldsSheet, TagInput, useWriteError, type ProjectPromptField } from "./project-prompt-edit";
import { LIVE_STATUSES, projectPromptApi, type PromptAction, type PromptState, type PromptStatus } from "./project-prompts-api";

/** A row of projects/prompts. */
export interface ProjectPromptRow {
  id: string;
  text: string;
  kind: string | null;
  lang: string | null;
  /** field id → the prompt's value (the HUB's) */
  custom: Record<string, string>;
  status: PromptStatus;
  state: PromptState | null;
  /** the HUB revision a write names; null = Gold's row only (read only) */
  version: number | null;
  origin: "gold" | "hub";
  funnel: string | null;
  regions: string[] | null;
  targets: string[];
  answers: number;
  firstMeasured: string | null;
  lastMeasured: string | null;
  rounds: string[];
  countries: string[];
  engineAnswers: Record<string, number>;
}

/** Screen projects/prompts. */
export interface ProjectPromptsView {
  rows: ProjectPromptRow[];
  /** rows before the tag picks */
  listed: number;
  fields: ProjectPromptField[];
  /** writes are possible (the HUB catalog holds the project and editing is configured) */
  editable: boolean;
  /** the language codes Gold knows (a draft's language) */
  languages: string[];
  /** the lens's rounds, oldest first */
  rounds: string[];
}

type StatusTab = "live" | "active" | "draft" | "paused" | "deleted";
const STATUS_TABS: readonly StatusTab[] = ["live", "active", "draft", "paused", "deleted"];
type SortKey = "prompt" | "status" | "lang" | "answers" | "lastMeasured" | `cf:${string}`;
type Sort = { key: SortKey; asc: boolean };
const PAGE_SIZES = [25, 50, 100] as const;
const STATUS_ORDER: Record<PromptStatus, number> = { draft: 0, active: 1, paused: 2, archived: 3, removed: 4 };
const firstAsc = (k: SortKey) => k !== "answers" && k !== "lastMeasured";

export function inTab(status: PromptStatus, tab: StatusTab): boolean {
  if (tab === "live") return (LIVE_STATUSES as readonly string[]).includes(status);
  if (tab === "deleted") return status === "archived" || status === "removed";
  return status === tab;
}

/** A row the page can write: the HUB holds it and it is not deleted. */
export const isEditable = (r: ProjectPromptRow) => r.version !== null && (LIVE_STATUSES as readonly string[]).includes(r.status);

/** The rows matching the search (prompt text or a tag value), sorted by the key; ties and empty values in the HUB's order. */
export function listedRows(rows: readonly ProjectPromptRow[], query: string, sort: Sort): ProjectPromptRow[] {
  const q = query.trim().toLowerCase();
  const hit = q ? rows.filter((r) => r.text.toLowerCase().includes(q) || Object.values(r.custom).some((v) => v.toLowerCase().includes(q))) : [...rows];
  const value = (r: ProjectPromptRow): string | number | null =>
    sort.key === "prompt" ? r.text
    : sort.key === "status" ? STATUS_ORDER[r.status]
    : sort.key === "lang" ? r.lang
    : sort.key === "answers" ? r.answers
    : sort.key === "lastMeasured" ? r.lastMeasured
    : (r.custom[sort.key.slice(3)] ?? null);
  const indexed = hit.map((r, i) => ({ r, i, v: value(r) }));
  indexed.sort((a, b) => {
    if (a.v == null || b.v == null) return a.v == null && b.v == null ? a.i - b.i : a.v == null ? 1 : -1;
    const c = typeof a.v === "number" && typeof b.v === "number" ? a.v - b.v : String(a.v).localeCompare(String(b.v));
    return (sort.asc ? c : -c) || a.i - b.i;
  });
  return indexed.map((x) => x.r);
}

/** The values each tag column already has, for the inputs' suggestions. */
function valuesByField(rows: readonly ProjectPromptRow[]): Record<string, string[]> {
  const out: Record<string, Set<string>> = {};
  for (const r of rows) for (const [f, v] of Object.entries(r.custom)) (out[f] ??= new Set()).add(v);
  return Object.fromEntries(Object.entries(out).map(([f, s]) => [f, [...s].sort((a, b) => a.localeCompare(b))]));
}

export function RnProjectPrompts({ id, view, lens }: { id: string; view: ProjectPromptsView; lens: string[] }) {
  const t = useTranslations("renewal.projects.prompts");
  const tw = useTranslations("website.prompts");
  const locale = useLocale();
  const toast = useRnToast();
  const tip = useRnTruncTip();
  const router = useRouter();
  const writeError = useWriteError();
  const [refreshing, startRefresh] = useTransition();
  const [tab, setTab] = useState<StatusTab>("live");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>({ key: "lastMeasured", asc: false });
  const [pageSize, setPageSize] = useState<number>(50);
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [cell, setCell] = useState<string | null>(null);
  const [sheet, setSheet] = useState<"add" | "tags" | null>(null);
  const num = (n: number) => n.toLocaleString(locale);
  const refresh = () => startRefresh(() => router.refresh());

  const columns = view.fields.filter((f) => !f.archived);
  const options = useMemo(() => valuesByField(view.rows), [view.rows]);
  const tabCounts = useMemo(() => Object.fromEntries(STATUS_TABS.map((k) => [k, view.rows.filter((r) => inTab(r.status, k)).length])) as Record<StatusTab, number>, [view.rows]);
  const inStatus = useMemo(() => view.rows.filter((r) => inTab(r.status, tab)), [view.rows, tab]);
  const listed = useMemo(() => listedRows(inStatus, query, sort), [inStatus, query, sort]);
  const pages = Math.max(1, Math.ceil(listed.length / pageSize));
  const current = Math.min(page, pages);
  const shown = listed.slice((current - 1) * pageSize, current * pageSize);
  const selectable = view.editable ? shown.filter(isEditable) : [];
  const picked = view.rows.filter((r) => selected.has(r.id) && isEditable(r));
  const drafts = view.rows.filter((r) => r.status === "draft").length;
  const open = openId ? (view.rows.find((r) => r.id === openId) ?? null) : null;
  const fieldLabel = (field: string) =>
    field === "text" ? tw("promptLabel") : field === "kind" ? t("kind") : field === "lang" ? tw("langLabel")
    : field.startsWith("tag:") ? (view.fields.find((f) => f.id === field.slice(4))?.label ?? t("tags")) : field;

  const onSort = (key: SortKey) => {
    setSort((s) => (s.key === key ? { key, asc: !s.asc } : { key, asc: firstAsc(key) }));
    setPage(1);
  };
  const head = (key: SortKey, text: string, className?: string) => <RnSortHead sortKey={key} label={text} sort={sort} onSort={onSort} className={className} />;
  const toggle = (rowId: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(rowId);
      else next.delete(rowId);
      return next;
    });
  const allShown = selectable.length > 0 && selectable.every((r) => selected.has(r.id));

  async function saveTag(ids: string[], fieldId: string, value: string | null) {
    try {
      const out = await projectPromptApi.tag(id, ids, fieldId, value);
      toast(out.changed.length ? t("tagSaved", { count: out.changed.length }) : t("tagUnchanged"));
      refresh();
    } catch (e) {
      toast(writeError(e));
      throw e;
    }
  }

  async function exportRows() {
    setExporting(true);
    try {
      const engines = byEngineOrder([...new Set(listed.flatMap((r) => Object.keys(r.engineAnswers)))]);
      const headers = [tw("promptLabel"), t("statusLabel"), tw("langLabel"), ...columns.map((f) => f.label), t("countries"), tw("answersLabel"),
        ...engines.map((e) => ENGINE_LABEL[e] ?? e), t("rounds"), t("firstMeasured"), tw("lastMeasuredLabel")];
      const cells = listed.map((r) => [r.text, t(`status.${r.status}`), r.lang ?? "", ...columns.map((f) => r.custom[f.id] ?? ""), r.countries.join(", "), r.answers,
        ...engines.map((e) => r.engineAnswers[e] ?? 0), r.rounds.length, r.firstMeasured ?? "", r.lastMeasured ?? ""]);
      await downloadXlsx(exportFilename(`${t("exportFilename")}-${shortId(id)}`, new Date()), headers, cells, t("exportSheetName"));
    } catch (err) {
      console.error("[renewal/projects/prompt] export failed:", err);
      toast(t("exportFailed"));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <RnCard data-rn-project-prompts="" data-rn-editable={view.editable ? "" : undefined}>
        <div className="flex flex-wrap items-center gap-2.5 border-b border-rn-line px-5 py-3">
          <RnSegmented
            label={t("statusLabel")}
            value={tab}
            onChange={(v) => {
              setTab(v);
              setPage(1);
            }}
            items={STATUS_TABS.map((k) => ({ value: k, label: <span className="tabular-nums">{t(`filter.${k}`, { count: num(tabCounts[k]) })}</span> }))}
          />
          <RnSearchField
            id="rn-project-prompt-search"
            className="w-full max-w-[300px] min-w-[200px] flex-1"
            value={query}
            onChange={(v) => {
              setQuery(v);
              setPage(1);
            }}
            placeholder={t("searchPlaceholder")}
            label={t("searchLabel")}
          />
          <span className="text-rn-12 text-rn-muted tabular-nums" data-rn-prompt-count="">
            {listed.length === inStatus.length ? t("count", { count: num(listed.length) }) : t("countOf", { count: num(listed.length), listed: num(inStatus.length) })}
          </span>
          {refreshing ? <Loader2 aria-label={t("refreshing")} className="size-3.5 animate-spin text-rn-muted" /> : null}
          <span className="ml-auto flex items-center gap-2">
            {view.editable ? (
              <>
                <span className="text-rn-12 text-rn-muted tabular-nums" data-rn-draft-count={drafts}>
                  {t("drafts", { count: num(drafts) })}
                </span>
                <RnButton disabled data-rn-tip={t("runTip")} aria-describedby="rn-project-run-tip" data-rn-project-run="">
                  <Lock className="size-3.5" aria-hidden />
                  {t("run")}
                </RnButton>
                <span id="rn-project-run-tip" className="sr-only">
                  {t("runTip")}
                </span>
                <RnButton onClick={() => setSheet("tags")} data-rn-project-tags-open="">
                  <Tags className="size-3.5" aria-hidden />
                  {t("tagsManage")}
                </RnButton>
                <RnButton variant="primary" onClick={() => setSheet("add")} data-rn-project-prompt-add-open="">
                  <Plus className="size-3.5" aria-hidden />
                  {t("add")}
                </RnButton>
              </>
            ) : null}
            <RnButton onClick={exportRows} disabled={exporting || listed.length === 0}>
              {exporting ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Download className="size-3.5" aria-hidden />}
              {t("export")}
            </RnButton>
          </span>
        </div>
        {picked.length ? (
          <BulkBar
            count={picked.length}
            fields={columns}
            options={options}
            onApply={(fieldId, value) => saveTag(picked.map((r) => r.id), fieldId, value).then(() => setSelected(new Set()))}
            onClear={() => setSelected(new Set())}
          />
        ) : null}
        {listed.length === 0 ? (
          <RnEmpty className="m-6">{view.listed === 0 ? t("empty") : t("emptyFiltered")}</RnEmpty>
        ) : (
          <div className="overflow-x-auto" {...tip.bind}>
            <table className="w-full min-w-[1040px] table-fixed border-separate border-spacing-0 text-rn-13" data-rn-project-prompt-table="">
              <colgroup>
                {view.editable ? <col className="w-[40px]" /> : null}
                <col />
                <col className="w-[120px]" />
                <col className="w-[88px]" />
                {columns.map((f) => (
                  <col key={f.id} className="w-[132px]" />
                ))}
                <col className="w-[96px]" />
                <col className="w-[104px]" />
              </colgroup>
              <thead>
                <tr className="text-left text-rn-12 text-rn-muted">
                  {view.editable ? (
                    <th className="sticky -top-1 z-[1] h-[38px] border-b border-rn-line-2 bg-rn-surface pl-5">
                      <input
                        type="checkbox"
                        aria-label={t("selectPage")}
                        className="size-3.5 cursor-pointer accent-rn-navy"
                        checked={allShown}
                        disabled={selectable.length === 0}
                        onChange={(e) =>
                          setSelected((prev) => {
                            const next = new Set(prev);
                            for (const r of selectable) {
                              if (e.target.checked) next.add(r.id);
                              else next.delete(r.id);
                            }
                            return next;
                          })
                        }
                        data-rn-select-page=""
                      />
                    </th>
                  ) : null}
                  {head("prompt", tw("promptLabel"), view.editable ? undefined : "pl-5")}
                  {head("status", t("statusLabel"))}
                  {head("lang", tw("langLabel"))}
                  {columns.map((f) => (
                    <RnSortHead key={f.id} sortKey={`cf:${f.id}` as SortKey} label={f.label} sort={sort} onSort={onSort} />
                  ))}
                  {head("answers", tw("answersLabel"))}
                  {head("lastMeasured", tw("lastMeasuredLabel"), "pr-5")}
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const writable = view.editable && isEditable(r);
                  const live = inTab(r.status, "live");
                  return (
                    <tr
                      key={r.id}
                      data-rn-project-prompt-row={r.id}
                      data-rn-status={r.status}
                      onClick={() => !window.getSelection()?.toString() && setOpenId(r.id)}
                      className={cx("cursor-pointer hover:bg-rn-navy-25/60", selected.has(r.id) && "bg-rn-navy-25/80")}
                    >
                      {view.editable ? (
                        <td className={cx(TD, "pl-5")} onClick={(e) => e.stopPropagation()}>
                          {writable ? (
                            <input
                              type="checkbox"
                              aria-label={t("selectRow")}
                              className="size-3.5 cursor-pointer accent-rn-navy"
                              checked={selected.has(r.id)}
                              onChange={(e) => toggle(r.id, e.target.checked)}
                              data-rn-select-row={r.id}
                            />
                          ) : null}
                        </td>
                      ) : null}
                      <td className={cx(TD, !view.editable && "pl-5")}>
                        <button
                          type="button"
                          data-rn-tip=""
                          className={cx("block w-full cursor-pointer truncate text-left focus-visible:outline-2 focus-visible:outline-rn-navy", live ? "text-rn-ink" : "text-rn-muted line-through decoration-rn-faint")}
                        >
                          {r.text}
                        </button>
                      </td>
                      <td className={TD}>
                        <StatusCell row={r} />
                      </td>
                      <td className={cx(TD, "text-rn-12 text-rn-ink-2")}>{r.lang ? languageName(r.lang, locale) : <span className="text-rn-faint">—</span>}</td>
                      {columns.map((f) => (
                        <td key={f.id} className={TD} data-rn-tag={f.id} onClick={writable ? (e) => e.stopPropagation() : undefined}>
                          {writable && cell === `${r.id}:${f.id}` ? (
                            <TagInput
                              value={r.custom[f.id] ?? null}
                              options={options[f.id] ?? []}
                              label={t("tagEdit", { label: f.label })}
                              onSave={(v) => saveTag([r.id], f.id, v)}
                              onDone={() => setCell(null)}
                            />
                          ) : writable ? (
                            <button
                              type="button"
                              aria-label={t("tagEdit", { label: f.label })}
                              onClick={() => setCell(`${r.id}:${f.id}`)}
                              className="flex w-full min-w-0 cursor-text items-center rounded-md px-1 py-0.5 text-left hover:bg-rn-inset focus-visible:outline-2 focus-visible:outline-rn-navy"
                              data-rn-tag-cell=""
                            >
                              <TagValue value={r.custom[f.id]} />
                            </button>
                          ) : (
                            <TagValue value={r.custom[f.id]} />
                          )}
                        </td>
                      ))}
                      <td className={TD}>
                        <Answers row={r} />
                      </td>
                      <td className={cx(TD, "pr-5 text-rn-12 whitespace-nowrap tabular-nums")}>{r.lastMeasured ?? <span className="text-rn-muted">{tw("notMeasured")}</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {tip.tip}
          </div>
        )}
        {listed.length > 0 ? (
          <RnListPager
            rangeFrom={(current - 1) * pageSize + 1}
            rangeTo={Math.min(current * pageSize, listed.length)}
            total={listed.length}
            page={current}
            pages={pages}
            pageSize={pageSize}
            pageSizes={PAGE_SIZES}
            onPageSize={(n) => {
              setPageSize(n);
              setPage(1);
            }}
            onPage={setPage}
          />
        ) : null}
      </RnCard>
      <RnNote data-rn-prompt-note="">{view.editable ? t("note") : t("noteReadOnly")}</RnNote>
      <RnProjectPromptDetail
        pid={id}
        row={open}
        fields={columns}
        options={options}
        languages={view.languages}
        editable={view.editable}
        axis={view.rounds}
        lens={lens}
        fieldLabel={fieldLabel}
        onSaveTag={saveTag}
        onChanged={refresh}
        onClose={() => setOpenId(null)}
      />
      <AddPromptsSheet
        pid={id}
        open={sheet === "add"}
        onClose={() => setSheet(null)}
        onDone={() => {
          // the new drafts are never measured, so they would sort last: show the drafts instead
          setTab("draft");
          setQuery("");
          setPage(1);
          refresh();
        }}
      />
      <TagFieldsSheet pid={id} fields={view.fields} editable={view.editable} open={sheet === "tags"} onClose={() => setSheet(null)} onDone={refresh} />
    </div>
  );
}

function TagValue({ value }: { value: string | undefined }) {
  return value ? (
    <span data-rn-tip="" className="inline-block max-w-full truncate rounded-md bg-rn-navy/8 px-1.5 py-px align-middle text-rn-12 font-semibold text-rn-navy">
      {value}
    </span>
  ) : (
    <span className="text-rn-faint">—</span>
  );
}

/** The HUB status, and under it why a row Gold alone has cannot be edited. */
function StatusCell({ row }: { row: ProjectPromptRow }) {
  const t = useTranslations("renewal.projects.prompts");
  const tone = row.status === "draft" ? "text-rn-navy" : row.status === "active" ? "text-rn-ink" : "text-rn-muted";
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className={cx("text-rn-12 font-semibold", tone)} data-rn-status-label="">
        {t(`status.${row.status}`)}
      </span>
      {row.state === "upstream" ? <StateMark state="upstream" label={t("state.upstream")} tip={t("stateTip.upstream")} attr="data-rn-prompt-state" /> : null}
    </span>
  );
}

/** Selected rows: one tag value on all of them, or cleared. */
function BulkBar({
  count,
  fields,
  options,
  onApply,
  onClear,
}: {
  count: number;
  fields: readonly ProjectPromptField[];
  options: Record<string, string[]>;
  onApply: (fieldId: string, value: string | null) => Promise<void>;
  onClear: () => void;
}) {
  const t = useTranslations("renewal.projects.prompts");
  const [fieldId, setFieldId] = useState(fields[0]?.id ?? "");
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const run = async (v: string | null) => {
    setSaving(true);
    try {
      await onApply(fieldId, v);
      setValue("");
    } catch {
      // the toast said why; the selection stays
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2.5 border-b border-rn-line bg-rn-navy-25 px-5 py-2.5" data-rn-bulk-bar="">
      <span className="text-rn-13 font-semibold text-rn-navy tabular-nums">{t("selected", { count })}</span>
      {fields.length ? (
        <>
          <RnSelect label={t("bulkField")} value={fieldId} onChange={(e) => setFieldId(e.target.value)} options={fields.map((f) => ({ value: f.id, label: f.label }))} />
          <input
            aria-label={t("bulkValue")}
            list="rn-bulk-values"
            value={value}
            maxLength={500}
            onChange={(e) => setValue(e.target.value)}
            placeholder={t("bulkValue")}
            className="h-[30px] w-[220px] rounded-md border border-rn-line-2 bg-rn-surface px-2.5 text-rn-12 text-rn-ink outline-none focus:border-rn-navy focus:ring-3 focus:ring-rn-navy/12"
            data-rn-bulk-value=""
          />
          <datalist id="rn-bulk-values">
            {(options[fieldId] ?? []).map((o) => (
              <option key={o} value={o} />
            ))}
          </datalist>
          <RnButton size="sm" variant="primary" disabled={saving || !value.trim() || !fieldId} onClick={() => run(value.trim())} data-rn-bulk-apply="">
            {saving ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
            {t("bulkApply")}
          </RnButton>
          <RnButton size="sm" disabled={saving || !fieldId} onClick={() => run(null)}>
            {t("bulkClearValue")}
          </RnButton>
        </>
      ) : (
        <span className="text-rn-12 text-rn-muted">{t("bulkNoTags")}</span>
      )}
      <RnButton size="sm" variant="ghost" className="ml-auto" onClick={onClear}>
        {t("deselect")}
      </RnButton>
    </div>
  );
}

/** The answers and a dot per engine, the counts by engine in the tip. */
function Answers({ row }: { row: ProjectPromptRow }) {
  const locale = useLocale();
  const engines = byEngineOrder(Object.keys(row.engineAnswers));
  const parts = engines.map((e) => `${ENGINE_LABEL[e] ?? e} ${row.engineAnswers[e].toLocaleString(locale)}`).join(" · ");
  return (
    <span data-rn-tip={parts || undefined} className="flex min-w-0 items-center gap-2">
      <span className="text-rn-12 tabular-nums text-rn-ink">{row.answers > 0 ? row.answers.toLocaleString(locale) : "—"}</span>
      <span className="inline-flex shrink-0 gap-0.5">
        {engines.map((e) => (
          <i key={e} aria-hidden data-engine={e} className="inline-block size-2 rounded-full" style={{ background: engineColor(e) }} />
        ))}
      </span>
      {parts ? <span className="sr-only">{parts}</span> : null}
    </span>
  );
}

// the actions a status offers, in the order the sheet shows them
const ACTIONS: Record<PromptStatus, PromptAction[]> = { active: ["pause", "archive"], paused: ["resume", "archive"], draft: ["archive"], archived: ["restore"], removed: [] };

/** The sheet: the full text, the HUB's values (editable where the original allowed), Gold's measurement under the lens and the history. */
export function RnProjectPromptDetail({
  pid,
  row,
  fields,
  options,
  languages,
  editable,
  axis,
  lens,
  fieldLabel,
  onSaveTag,
  onChanged,
  onClose,
}: {
  pid: string;
  row: ProjectPromptRow | null;
  fields: readonly ProjectPromptField[];
  options: Record<string, string[]>;
  languages: readonly string[];
  editable: boolean;
  axis: string[];
  lens: string[];
  fieldLabel: (field: string) => string;
  onSaveTag: (ids: string[], fieldId: string, value: string | null) => Promise<void>;
  onChanged: () => void;
  onClose: () => void;
}) {
  const t = useTranslations("renewal.projects.prompts");
  const tw = useTranslations("website.prompts");
  const tp = useTranslations("renewal.prompts");
  const tc = useTranslations("renewal.website.prompts.columns");
  const tm = useTranslations("renewal.website.prompts");
  const locale = useLocale();
  if (!row) return null;
  const writable = editable && isEditable(row);
  const engines = byEngineOrder(Object.keys(row.engineAnswers));
  const measured = new Set(row.rounds);
  const section = (title: string, children: ReactNode, attr?: string) => (
    <section {...(attr ? { [attr]: "" } : {})}>
      <h3 className="m-0 mb-2 text-rn-13 font-bold text-rn-ink">{title}</h3>
      {children}
    </section>
  );
  const grid = "m-0 grid grid-cols-[112px_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-rn-13";
  return (
    <RnDrawer open onClose={onClose} title={tp("detail.title")} closeLabel={tp("close")}>
      <div className="flex flex-col gap-6" data-rn-project-prompt-detail={row.id} data-rn-status={row.status}>
        <StatusBar pid={pid} row={row} editable={editable && row.version !== null} onChanged={onChanged} />
        {writable ? (
          <PromptForm key={`${row.id}:${row.version}`} pid={pid} row={row} languages={languages} onChanged={onChanged} />
        ) : (
          <>
            <RnPromptText text={row.text} />
            {section(
              tp("detail.attributes"),
              <dl className={grid}>
                <Field label={t("kind")}>{row.kind}</Field>
                <Field label={tw("langLabel")}>{row.lang ? `${languageName(row.lang, locale)} (${row.lang.toUpperCase()})` : null}</Field>
              </dl>,
            )}
          </>
        )}
        {fields.length
          ? section(
              t("tags"),
              <dl className={grid}>
                {fields.map((f) => (
                  <Field key={f.id} label={f.label}>
                    {writable ? (
                      <TagInput value={row.custom[f.id] ?? null} options={options[f.id] ?? []} label={t("tagEdit", { label: f.label })} onSave={(v) => onSaveTag([row.id], f.id, v)} />
                    ) : (
                      (row.custom[f.id] ?? null)
                    )}
                  </Field>
                ))}
              </dl>,
              "data-rn-project-prompt-tags",
            )
          : null}
        {section(
          t("goldAttributes"),
          <dl className={grid}>
            <Field label={t("funnel")}>{row.funnel}</Field>
            <Field label={t("regions")}>{row.regions?.length ? row.regions.join(", ") : null}</Field>
            <Field label={t("targets")}>{row.targets.length ? row.targets.join(", ") : null}</Field>
          </dl>,
        )}
        {section(
          tm("measurement"),
          <>
            {lens.length ? <p className="m-0 mb-2 text-rn-12 text-rn-muted">{tm("measurementLens", { lens: lens.join(" · ") })}</p> : null}
            <dl className={grid}>
              <Field label={tw("answersLabel")}>{row.answers > 0 ? row.answers.toLocaleString(locale) : null}</Field>
              <Field label={tw("enginesLabel")}>
                {engines.length ? (
                  <span className="flex flex-col gap-1">
                    {engines.map((e) => (
                      <span key={e} className="inline-flex items-center gap-1.5">
                        <i aria-hidden className="inline-block size-2 rounded-full" style={{ background: engineColor(e) }} />
                        {ENGINE_LABEL[e] ?? e}
                        <b className="font-semibold tabular-nums">{row.engineAnswers[e].toLocaleString(locale)}</b>
                      </span>
                    ))}
                  </span>
                ) : null}
              </Field>
              <Field label={t("countries")}>{row.countries.length ? row.countries.map((c) => `${countryName(c, locale)} (${c})`).join(", ") : null}</Field>
              <Field label={tw("lastMeasuredLabel")}>{row.lastMeasured ?? tw("notMeasured")}</Field>
              <Field label={tc("firstMeasured")}>{row.firstMeasured}</Field>
              <Field label={tc("rounds")}>
                <span className="flex flex-col gap-1.5">
                  <span className="tabular-nums">{tc("roundsOf", { count: row.rounds.length, total: axis.length })}</span>
                  <span className="flex min-w-0 items-center gap-[3px]" data-rn-round-strip="">
                    {axis.map((d) => (
                      <i key={d} aria-hidden title={d} className={cx("block h-4 max-w-[18px] min-w-[3px] flex-1 rounded-[2px]", measured.has(d) ? "bg-rn-navy" : "bg-rn-line-2")} />
                    ))}
                  </span>
                  {row.rounds.length ? <span className="text-rn-12 break-words text-rn-muted tabular-nums">{row.rounds.join(" · ")}</span> : null}
                </span>
              </Field>
            </dl>
          </>,
        )}
        {row.version !== null ? <PromptHistory pid={pid} id={row.id} version={row.version} fieldLabel={fieldLabel} /> : null}
      </div>
    </RnDrawer>
  );
}

/** The status, why a row Gold alone has cannot be edited, and the actions the status offers (delete asks once). */
function StatusBar({ pid, row, editable, onChanged }: { pid: string; row: ProjectPromptRow; editable: boolean; onChanged: () => void }) {
  const t = useTranslations("renewal.projects.prompts");
  const writeError = useWriteError();
  const toast = useRnToast();
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState<PromptAction | null>(null);
  async function act(action: PromptAction) {
    if (row.version === null) return;
    setSaving(action);
    try {
      await projectPromptApi.act(pid, row.id, action, row.version);
      toast(t(`actionDone.${action}`));
      setConfirming(false);
      onChanged();
    } catch (e) {
      toast(writeError(e));
    } finally {
      setSaving(null);
    }
  }
  return (
    <div className="flex flex-col gap-2 rounded-[10px] bg-rn-page p-3" data-rn-project-prompt-status="">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-rn-13 font-bold text-rn-ink">{t(`status.${row.status}`)}</span>
        {row.state === "upstream" ? <StateMark state="upstream" label={t("state.upstream")} tip={t("stateTip.upstream")} attr="data-rn-prompt-state" /> : null}
        {editable ? (
          <span className="ml-auto flex gap-2">
            {ACTIONS[row.status].map((a) => (
              <RnButton key={a} size="sm" disabled={saving !== null} onClick={() => (a === "archive" ? setConfirming(true) : act(a))} data-rn-prompt-action={a}>
                {saving === a ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
                {t(`action.${a}`)}
              </RnButton>
            ))}
          </span>
        ) : null}
      </div>
      <p className="m-0 text-rn-12 text-rn-muted">{t(`statusHint.${row.status}`)}</p>
      {confirming ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-rn-line pt-2" role="alertdialog" aria-label={t("archiveConfirm")}>
          <span className="text-rn-12 text-rn-ink-2">{t("archiveConfirm")}</span>
          <RnButton size="sm" className="ml-auto" onClick={() => setConfirming(false)} disabled={saving !== null}>
            {t("cancel")}
          </RnButton>
          <RnButton size="sm" variant="primary" onClick={() => act("archive")} disabled={saving !== null} data-rn-prompt-archive-confirm="">
            {saving === "archive" ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
            {t("action.archive")}
          </RnButton>
        </div>
      ) : null}
    </div>
  );
}

/** The original's edit: a draft's text and language, any live prompt's measurement kind. */
function PromptForm({ pid, row, languages, onChanged }: { pid: string; row: ProjectPromptRow; languages: readonly string[]; onChanged: () => void }) {
  const t = useTranslations("renewal.projects.prompts");
  const tw = useTranslations("website.prompts");
  const locale = useLocale();
  const writeError = useWriteError();
  const toast = useRnToast();
  const draft = row.status === "draft";
  const [text, setText] = useState(row.text);
  const [lang, setLang] = useState(row.lang ?? "");
  const [kind, setKind] = useState<"single" | "acr">(row.kind === "acr" ? "acr" : "single");
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const changed = text.trim() !== row.text || (lang || null) !== (row.lang ?? null) || kind !== (row.kind === "acr" ? "acr" : "single");
  async function save() {
    if (row.version === null) return;
    setSaving(true);
    setFailure(null);
    try {
      await projectPromptApi.edit(pid, row.id, { expectedVersion: row.version, kind, ...(draft ? { text, language: lang || null } : {}) });
      toast(t("saved"));
      onChanged();
    } catch (e) {
      setFailure(writeError(e));
    } finally {
      setSaving(false);
    }
  }
  const label = "text-rn-12 font-semibold text-rn-muted";
  return (
    <section className="flex flex-col gap-3" data-rn-project-prompt-form="">
      {draft ? (
        <label className="flex flex-col gap-1">
          <span className={label}>{tw("promptLabel")}</span>
          <textarea
            value={text}
            rows={4}
            maxLength={4000}
            onChange={(e) => setText(e.target.value.replace(/\r?\n/g, " "))}
            className="w-full resize-y rounded-[10px] border border-rn-line-2 bg-rn-surface p-3 text-rn-13 leading-relaxed text-rn-ink outline-none focus:border-rn-navy focus:ring-3 focus:ring-rn-navy/12"
            data-rn-prompt-text-input=""
          />
        </label>
      ) : (
        <RnPromptText text={row.text} />
      )}
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className={label}>{t("kind")}</span>
          <RnSelect label={t("kind")} value={kind} onChange={(e) => setKind(e.target.value as "single" | "acr")} options={[{ value: "single", label: "single" }, { value: "acr", label: "acr" }]} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={label}>{tw("langLabel")}</span>
          {draft ? (
            <RnSelect
              label={tw("langLabel")}
              value={lang}
              onChange={(e) => setLang(e.target.value)}
              options={[{ value: "", label: t("languageNone") }, ...languages.map((l) => ({ value: l, label: `${languageName(l, locale)} (${l.toUpperCase()})` }))]}
            />
          ) : (
            <span className="h-[30px] text-rn-13 leading-[30px] text-rn-ink-2">{row.lang ? `${languageName(row.lang, locale)} (${row.lang.toUpperCase()})` : "—"}</span>
          )}
        </label>
        <RnButton variant="primary" size="sm" className="ml-auto" disabled={!changed || saving || !text.trim()} onClick={save} data-rn-prompt-save="">
          {saving ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
          {t("save")}
        </RnButton>
      </div>
      {draft ? null : <p className="m-0 text-rn-12 text-rn-muted">{t("draftOnly")}</p>}
      {failure ? (
        <p role="alert" className="m-0 text-rn-12 text-rn-danger-ink">
          {failure}
        </p>
      ) : null}
    </section>
  );
}
