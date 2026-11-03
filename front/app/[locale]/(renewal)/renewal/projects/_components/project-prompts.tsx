"use client";

// Renewal Project › Prompt (2026-11-03, P4): the project's prompts as Gold holds them, in the one-line list of the
// renewal prompt pages, with a column per custom tag (Gold dim_custom_field · prompt_custom_value) — the original's tag
// columns, read only. Answers, engines, rounds and dates are the lens's (측정 국가 · AI 엔진 · 기간: the answers a row
// counts, never the rows); the tags in the panel narrow the rows (screen projects/prompts). A project holds ≤ 237
// prompts, so the page searches, sorts, pages and exports them here (as the Project list does). A row opens its sheet.

import { useMemo, useState, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Download, Loader2 } from "lucide-react";
import { RnButton, RnCard, RnDrawer, RnEmpty, RnNote, RnSearchField, cx, useRnToast, useRnTruncTip } from "@/components/renewal-ui";
import { ENGINE_LABEL } from "@/components/dash/dimension-filter-panel";
import { countryName } from "@/lib/geo-catalog/country-name";
import { languageName } from "@/lib/geo-catalog/language-name";
import { downloadXlsx } from "@/lib/export/xlsx";
import { exportFilename } from "@/app/[locale]/(dash)/standard/prompts/_components/prompt-export";
import { LIST_TD as TD, RnDetailField as Field, RnListPager, RnPromptText, RnSortHead } from "../../_components/prompt-list";
import { byEngineOrder, engineColor } from "../../website/prompts/_components/website-prompt-model";
import { shortId } from "./project-model";

/** A row of projects/prompts. */
export interface ProjectPromptRow {
  id: string;
  text: string;
  kind: string | null;
  lang: string | null;
  funnel: string | null;
  regions: string[] | null;
  targets: string[];
  answers: number;
  firstMeasured: string | null;
  lastMeasured: string | null;
  rounds: string[];
  countries: string[];
  engineAnswers: Record<string, number>;
  /** field id → the prompt's value */
  custom: Record<string, string>;
}

/** Screen projects/prompts. */
export interface ProjectPromptsView {
  rows: ProjectPromptRow[];
  /** rows before the tag picks */
  listed: number;
  fields: { id: string; label: string }[];
  /** the lens's rounds, oldest first */
  rounds: string[];
}

type SortKey = "prompt" | "lang" | "answers" | "lastMeasured" | `cf:${string}`;
type Sort = { key: SortKey; asc: boolean };
const PAGE_SIZES = [25, 50, 100] as const;
const firstAsc = (k: SortKey) => k !== "answers" && k !== "lastMeasured";

/** The rows matching the search (prompt text or a tag value), sorted by the key; ties and empty values in Gold's order. */
export function listedRows(rows: readonly ProjectPromptRow[], query: string, sort: Sort): ProjectPromptRow[] {
  const q = query.trim().toLowerCase();
  const hit = q ? rows.filter((r) => r.text.toLowerCase().includes(q) || Object.values(r.custom).some((v) => v.toLowerCase().includes(q))) : [...rows];
  const value = (r: ProjectPromptRow): string | number | null =>
    sort.key === "prompt" ? r.text
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

export function RnProjectPrompts({ id, view, lens }: { id: string; view: ProjectPromptsView; lens: string[] }) {
  const t = useTranslations("renewal.projects.prompts");
  const tw = useTranslations("website.prompts");
  const locale = useLocale();
  const toast = useRnToast();
  const tip = useRnTruncTip();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>({ key: "lastMeasured", asc: false });
  const [pageSize, setPageSize] = useState<number>(50);
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<ProjectPromptRow | null>(null);
  const [exporting, setExporting] = useState(false);
  const num = (n: number) => n.toLocaleString(locale);
  const listed = useMemo(() => listedRows(view.rows, query, sort), [view.rows, query, sort]);
  const pages = Math.max(1, Math.ceil(listed.length / pageSize));
  const current = Math.min(page, pages);
  const shown = listed.slice((current - 1) * pageSize, current * pageSize);
  const onSort = (key: SortKey) => {
    setSort((s) => (s.key === key ? { key, asc: !s.asc } : { key, asc: firstAsc(key) }));
    setPage(1);
  };
  const head = (key: SortKey, text: string, className?: string) => <RnSortHead sortKey={key} label={text} sort={sort} onSort={onSort} className={className} />;

  async function exportRows() {
    setExporting(true);
    try {
      const engines = byEngineOrder([...new Set(listed.flatMap((r) => Object.keys(r.engineAnswers)))]);
      const headers = [tw("promptLabel"), tw("langLabel"), ...view.fields.map((f) => f.label), t("countries"), tw("answersLabel"),
        ...engines.map((e) => ENGINE_LABEL[e] ?? e), t("rounds"), t("firstMeasured"), tw("lastMeasuredLabel")];
      const cells = listed.map((r) => [r.text, r.lang ?? "", ...view.fields.map((f) => r.custom[f.id] ?? ""), r.countries.join(", "), r.answers,
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
      <RnCard data-rn-project-prompts="">
        <div className="flex flex-wrap items-center gap-2.5 border-b border-rn-line px-5 py-3">
          <RnSearchField
            id="rn-project-prompt-search"
            className="w-full max-w-[340px] min-w-[200px] flex-1"
            value={query}
            onChange={(v) => {
              setQuery(v);
              setPage(1);
            }}
            placeholder={t("searchPlaceholder")}
            label={t("searchLabel")}
          />
          <span className="text-rn-12 text-rn-muted tabular-nums" data-rn-prompt-count="">
            {listed.length === view.listed ? t("count", { count: num(listed.length) }) : t("countOf", { count: num(listed.length), listed: num(view.listed) })}
          </span>
          <RnButton className="ml-auto" onClick={exportRows} disabled={exporting || listed.length === 0}>
            {exporting ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Download className="size-3.5" aria-hidden />}
            {t("export")}
          </RnButton>
        </div>
        {listed.length === 0 ? (
          <RnEmpty className="m-6">{view.listed === 0 ? t("empty") : t("emptyFiltered")}</RnEmpty>
        ) : (
          <div className="overflow-x-auto" {...tip.bind}>
            <table className="w-full min-w-[960px] table-fixed border-separate border-spacing-0 text-rn-13" data-rn-project-prompt-table="">
              <colgroup>
                <col />
                <col className="w-[88px]" />
                {view.fields.map((f) => (
                  <col key={f.id} className="w-[128px]" />
                ))}
                <col className="w-[96px]" />
                <col className="w-[104px]" />
              </colgroup>
              <thead>
                <tr className="text-left text-rn-12 text-rn-muted">
                  {head("prompt", tw("promptLabel"), "pl-5")}
                  {head("lang", tw("langLabel"))}
                  {view.fields.map((f) => (
                    <RnSortHead key={f.id} sortKey={`cf:${f.id}` as SortKey} label={f.label} sort={sort} onSort={onSort} />
                  ))}
                  {head("answers", tw("answersLabel"))}
                  {head("lastMeasured", tw("lastMeasuredLabel"), "pr-5")}
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.id} data-rn-project-prompt-row={r.id} onClick={() => !window.getSelection()?.toString() && setOpen(r)} className="cursor-pointer hover:bg-rn-navy-25/60">
                    <td className={cx(TD, "pl-5")}>
                      <button type="button" data-rn-tip="" className="block w-full cursor-pointer truncate text-left text-rn-ink focus-visible:outline-2 focus-visible:outline-rn-navy">
                        {r.text}
                      </button>
                    </td>
                    <td className={cx(TD, "text-rn-12 text-rn-ink-2")}>{r.lang ? languageName(r.lang, locale) : <span className="text-rn-faint">—</span>}</td>
                    {view.fields.map((f) => (
                      <td key={f.id} className={TD} data-rn-tag={f.id}>
                        {r.custom[f.id] ? (
                          <span data-rn-tip="" className="inline-block max-w-full truncate rounded-md bg-rn-navy/8 px-1.5 py-px align-middle text-rn-12 font-semibold text-rn-navy">
                            {r.custom[f.id]}
                          </span>
                        ) : (
                          <span className="text-rn-faint">—</span>
                        )}
                      </td>
                    ))}
                    <td className={TD}>
                      <Answers row={r} />
                    </td>
                    <td className={cx(TD, "pr-5 text-rn-12 whitespace-nowrap tabular-nums")}>{r.lastMeasured ?? <span className="text-rn-muted">{tw("notMeasured")}</span>}</td>
                  </tr>
                ))}
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
      <RnNote data-rn-prompt-note="">{t("note")}</RnNote>
      <RnProjectPromptDetail row={open} fields={view.fields} axis={view.rounds} lens={lens} onClose={() => setOpen(null)} />
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

/** The sheet: the full text, Gold's attributes and tag values, the measurement under the lens. */
export function RnProjectPromptDetail({
  row,
  fields,
  axis,
  lens,
  onClose,
}: {
  row: ProjectPromptRow | null;
  fields: ProjectPromptsView["fields"];
  axis: string[];
  lens: string[];
  onClose: () => void;
}) {
  const t = useTranslations("renewal.projects.prompts");
  const tw = useTranslations("website.prompts");
  const tp = useTranslations("renewal.prompts");
  const tc = useTranslations("renewal.website.prompts.columns");
  const tm = useTranslations("renewal.website.prompts");
  const locale = useLocale();
  if (!row) return null;
  const engines = byEngineOrder(Object.keys(row.engineAnswers));
  const measured = new Set(row.rounds);
  const section = (title: string, children: ReactNode) => (
    <section>
      <h3 className="m-0 mb-2 text-rn-13 font-bold text-rn-ink">{title}</h3>
      {children}
    </section>
  );
  const grid = "m-0 grid grid-cols-[112px_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-rn-13";
  return (
    <RnDrawer open onClose={onClose} title={tp("detail.title")} closeLabel={tp("close")}>
      <div className="flex flex-col gap-6" data-rn-project-prompt-detail={row.id}>
        <RnPromptText text={row.text} />
        {section(
          tp("detail.attributes"),
          <dl className={grid}>
            <Field label={t("kind")}>{row.kind}</Field>
            <Field label={tw("langLabel")}>{row.lang ? `${languageName(row.lang, locale)} (${row.lang.toUpperCase()})` : null}</Field>
            <Field label={t("funnel")}>{row.funnel}</Field>
            <Field label={t("regions")}>{row.regions?.length ? row.regions.join(", ") : null}</Field>
            <Field label={t("targets")}>{row.targets.length ? row.targets.join(", ") : null}</Field>
          </dl>,
        )}
        {fields.length
          ? section(
              t("tags"),
              <dl className={grid}>
                {fields.map((f) => (
                  <Field key={f.id} label={f.label}>
                    {row.custom[f.id] ?? null}
                  </Field>
                ))}
              </dl>,
            )
          : null}
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
      </div>
    </RnDrawer>
  );
}
