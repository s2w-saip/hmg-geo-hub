"use client";

// Renewal Admin › 인용 출처 분류 (2026-10-30): the top-level administrator corrects the category of the sources AI answers
// cite. The HUB keeps the corrections only; Gold's automatic classification and its social / seed lists are shown as
// Gold has them (back/bff/hub_stores/source_overrides.py). A category change saves at once (as the original screen);
// the correction reaches the citation numbers after the pipeline reads the HUB's list and Gold is rebuilt, so each
// row shows whether Gold applies it yet (반영 대기 / 반영됨). 원복 keeps the correction's row and history. The layout
// is Admin › GA4 연동's: the left filter panel, one line per source with sortable heads, and a sheet for the history.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { AlertTriangle, ArrowDownWideNarrow, ArrowUpNarrowWide, Database, History, Loader2, RotateCcw } from "lucide-react";
import {
  RnButton,
  RnCard,
  RnDrawer,
  RnEmpty,
  RnIconButton,
  RnNote,
  RnPageHeader,
  RnPill,
  RnSearchField,
  RnSelect,
  RnTag,
  RnToastProvider,
  RnToken,
  cx,
  useRnToast,
  useRnTruncTip,
} from "@/components/renewal-ui";
import { RnFilterSplit } from "../../../../_components/filter-split";
import { LIST_TD as TD, RnDetailField, RnFilterPanel, RnFilterRail, RnRadioAxis, RnSortHead, RnTimeline } from "../../../../_components/prompt-list";
import { SourceRequestError, sourceApi, type SourceHistory, type SourceListing, type SourceRow } from "./source-overrides-api";
import {
  ALL,
  DEFAULT_FILTER,
  DEFAULT_SORT,
  SOURCE_AXES,
  SOURCE_SORTS,
  axisOptions,
  counts,
  filterToQuery,
  firstAsc,
  matches,
  pickedAxes,
  queryToFilter,
  sortRows,
  type SourceAxis,
  type SourceFilter,
  type SourceSort,
} from "./source-overrides-model";

export function SourceOverridesManager({ initial }: { initial: SourceListing }) {
  return (
    <RnToastProvider>
      <Manager initial={initial} />
    </RnToastProvider>
  );
}

/** Category labels by Gold slug (citationCategories messages), Gold's own name for a slug the front does not know. */
function useCategoryLabel(listing: SourceListing) {
  const tc = useTranslations("citationCategories");
  return useCallback(
    (slug: string | null) => {
      if (!slug) return "—";
      if (tc.has(slug as "other")) return tc(slug as "other");
      return listing.categories.find((c) => c.slug === slug)?.name ?? slug;
    },
    [tc, listing.categories],
  );
}

function Manager({ initial }: { initial: SourceListing }) {
  const t = useTranslations("hubSourceOverrides");
  const tv = useTranslations("standardPromptsView");
  const tp = useTranslations("renewal.prompts");
  const tr = useTranslations("renewal.filters");
  const locale = useLocale();
  const toast = useRnToast();
  const sp = useSearchParams();
  const tip = useRnTruncTip();
  const fromUrl = useMemo(() => queryToFilter(sp), []); // eslint-disable-line react-hooks/exhaustive-deps

  const [listing, setListing] = useState(initial);
  const [filters, setFilters] = useState<SourceFilter>(fromUrl.filters);
  const [search, setSearch] = useState(fromUrl.search);
  const [otherOnly, setOtherOnly] = useState(fromUrl.otherOnly);
  const [sort, setSort] = useState(DEFAULT_SORT);
  const [saving, setSaving] = useState<string | null>(null);
  const [sheet, setSheet] = useState<SourceRow | null>(null);
  const [open, setOpen] = useState<Partial<Record<SourceAxis, boolean>>>({ source: true, state: true });
  const label = useCategoryLabel(listing);
  const nf = useMemo(() => new Intl.NumberFormat(locale), [locale]);

  const categoryOrder = useMemo(() => new Map(listing.categories.map((c, i) => [c.slug, i] as const)), [listing.categories]);
  const reload = useCallback(() => {
    sourceApi.list().then(setListing, () => toast(t("error.source_unavailable")));
  }, [t, toast]);

  // URL mirrors the picks (shareable, restorable); shallow — no server round trip.
  useEffect(() => {
    const qs = filterToQuery(filters, search, otherOnly);
    window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
  }, [filters, search, otherOnly]);

  const axisLabel = (a: SourceAxis) => t(`axis.${a}`);
  const valueLabel = (a: SourceAxis, v: string) =>
    v === ALL ? tv("filterAll") : a === "category" ? label(v) : a === "source" ? t(`source.${v as "override"}`) : t(`state.${v as "applied"}`);

  const picked = pickedAxes(filters);
  const shown = useMemo(
    () => sortRows(listing.items.filter((r) => matches(r, filters, search, otherOnly)), sort.key, sort.asc, categoryOrder),
    [listing.items, filters, search, otherOnly, sort, categoryOrder],
  );
  const total = counts(listing.items);
  const head = (key: SourceSort, className?: string) => (
    <RnSortHead sortKey={key} label={t(`column.${key}`)} sort={sort} className={className} onSort={(k) => setSort((s) => (s.key === k ? { key: k, asc: !s.asc } : { key: k, asc: firstAsc(k) }))} />
  );

  const failure = (e: unknown) => {
    const err = e instanceof SourceRequestError ? e : new SourceRequestError(0, "failed");
    toast(errorText(t, err));
  };
  const change = async (row: SourceRow, category: string) => {
    if (category === row.category && row.override?.status === "active") return;
    setSaving(row.key);
    try {
      await sourceApi.set(row.key, category);
      toast(t("toast.saved", { domain: row.skey }));
      reload();
    } catch (e) {
      failure(e);
    } finally {
      setSaving(null);
    }
  };
  const revert = async (row: SourceRow) => {
    setSaving(row.key);
    try {
      await sourceApi.clear(row.key);
      toast(t("toast.reverted", { domain: row.skey }));
      reload();
    } catch (e) {
      failure(e);
    } finally {
      setSaving(null);
    }
  };

  const categories = listing.categories.map((c) => ({ value: c.slug, label: label(c.slug) }));
  const panel = (
    <RnFilterPanel
      count={picked.length}
      onReset={() => {
        const before = filters;
        setFilters(DEFAULT_FILTER);
        toast(tr("resetDone"), { undoLabel: tr("undo"), undo: () => setFilters(before) });
      }}
      saved={null}
    >
      {SOURCE_AXES.map((a) => (
        <RnRadioAxis
          key={a}
          axis={a}
          label={axisLabel(a)}
          value={filters[a]}
          options={axisOptions(a, listing.categories.map((c) => c.slug))}
          valueLabel={(v) => valueLabel(a, v)}
          allLabel={tv("filterAll")}
          open={open[a] ?? false}
          onToggle={() => setOpen((o) => ({ ...o, [a]: !(o[a] ?? false) }))}
          onPick={(v) => setFilters((f) => ({ ...f, [a]: v }))}
        />
      ))}
    </RnFilterPanel>
  );

  return (
    <div className="flex flex-col gap-4">
      <RnFilterSplit
        header={
          <RnPageHeader
            title={t("title")}
            meta={
              <>
                <RnPill>
                  <Database className="size-3 text-rn-muted" aria-hidden />
                  {t("storePill")}
                </RnPill>
                {listing.asOf ? <RnPill>{t("roundPill", { date: listing.asOf })}</RnPill> : null}
                {listing.published ? (
                  <RnPill title={t("publishedTip", { seq: listing.published.changeSeq, at: formatTime(listing.published.recordedAt, locale) })}>
                    <span data-hub-source-published={listing.published.changeSeq}>{t("publishedPill", { version: listing.published.version, items: listing.published.items })}</span>
                  </RnPill>
                ) : null}
                <span>{t("description")}</span>
              </>
            }
          />
        }
        panel={panel}
        rail={<RnFilterRail count={picked.length} />}
      >
        <RnNote>
          <b className="text-rn-ink">{t("flowNoteTitle")}</b>
          <span>{t("flowNote")}</span>
        </RnNote>
        {picked.length || search || otherOnly ? (
          <div aria-live="polite" className="flex min-h-7 flex-wrap items-center gap-2">
            {picked.map((a) => (
              <RnToken key={a} label={axisLabel(a)} value={valueLabel(a, filters[a])} removeLabel={tr("removeToken", { label: axisLabel(a) })} onRemove={() => setFilters((f) => ({ ...f, [a]: ALL }))} />
            ))}
            {otherOnly ? <RnToken label={t("otherOnly")} value="✓" removeLabel={tr("removeToken", { label: t("otherOnly") })} onRemove={() => setOtherOnly(false)} /> : null}
            {search ? <RnToken label={t("searchLabel")} value={`“${search}”`} removeLabel={tr("removeToken", { label: t("searchLabel") })} onRemove={() => setSearch("")} /> : null}
          </div>
        ) : null}
        <RnCard aria-label={t("listLabel")}>
          <div className="flex flex-wrap items-center gap-2 border-b border-rn-line px-5 py-3">
            <RnSearchField
              id="rn-hub-source-search"
              className="w-full max-w-[280px] min-w-[180px] flex-1"
              value={search}
              onChange={setSearch}
              placeholder={t("searchPlaceholder")}
              label={t("searchLabel")}
            />
            <label className="inline-flex cursor-pointer items-center gap-1.5 text-rn-12 font-semibold text-rn-ink-2">
              <input type="checkbox" className="size-3.5 cursor-pointer accent-rn-navy" checked={otherOnly} onChange={(e) => setOtherOnly(e.target.checked)} data-hub-source-other-only="" />
              {t("otherOnly")}
            </label>
            <RnSelect
              label={tp("sortLabel")}
              value={sort.key}
              onChange={(e) => {
                const key = e.target.value as SourceSort;
                setSort({ key, asc: firstAsc(key) });
              }}
              options={SOURCE_SORTS.map((k) => ({ value: k, label: t(`column.${k}`) }))}
            />
            <RnIconButton label={sort.asc ? tp("sortAsc") : tp("sortDesc")} onClick={() => setSort((s) => ({ key: s.key, asc: !s.asc }))}>
              {sort.asc ? <ArrowUpNarrowWide className="size-4" aria-hidden /> : <ArrowDownWideNarrow className="size-4" aria-hidden />}
            </RnIconButton>
            <span className="ml-auto text-rn-12 text-rn-muted tabular-nums" data-hub-source-count="">
              {t("count", { shown: nf.format(shown.length), total: nf.format(total.total), overrides: nf.format(total.overrides), other: nf.format(total.other), pending: nf.format(total.pending) })}
            </span>
          </div>
          {shown.length === 0 ? (
            <RnEmpty className="m-5">{listing.items.length ? t("emptyFiltered") : t("empty")}</RnEmpty>
          ) : (
            <div {...tip.bind}>
              <table className="w-full table-fixed border-separate border-spacing-0 text-rn-13" data-hub-source-table="">
                <colgroup>
                  <col />
                  <col className="w-[96px]" />
                  <col className="w-[196px]" />
                  <col className="w-[176px]" />
                  <col className="w-[112px]" />
                  <col className="w-[160px]" />
                  <col className="w-[112px]" />
                </colgroup>
                <thead>
                  <tr className="text-left text-rn-12 text-rn-muted">
                    {head("domain", "pl-5")}
                    {head("citations", "text-right")}
                    {head("category")}
                    {head("source")}
                    {head("state")}
                    <th className={LIST_TH_PLAIN}>{t("column.note")}</th>
                    <th className={cx(LIST_TH_PLAIN, "pr-5 text-right")}>{t("column.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((row) => {
                    const busy = saving != null;
                    const active = row.override?.status === "active";
                    return (
                      <tr key={row.key} data-hub-source-row={row.key} className="hover:bg-rn-navy-25/60">
                        <td className={cx(TD, "pl-5")}>
                          <span className="flex min-w-0 items-center gap-2">
                            <span data-rn-tip="" className="min-w-0 shrink truncate font-semibold text-rn-ink">
                              {row.skey}
                            </span>
                            {row.isSocial ? <RnTag className="shrink-0">{t("social")}</RnTag> : null}
                          </span>
                        </td>
                        <td className={cx(TD, "text-right text-rn-12 text-rn-ink-2 tabular-nums")}>{nf.format(row.citations)}</td>
                        <td className={TD}>
                          <span className="flex items-center gap-1.5">
                            <RnSelect
                              label={t("categoryOf", { domain: row.skey })}
                              className="min-w-0 flex-1 [&_select]:w-full"
                              value={row.category}
                              disabled={busy}
                              onChange={(e) => void change(row, e.target.value)}
                              options={categories.some((c) => c.value === row.category) ? categories : [{ value: row.category, label: label(row.category) }, ...categories]}
                              data-hub-source-category={row.key}
                            />
                            {saving === row.key ? <Loader2 className="size-3.5 shrink-0 animate-spin text-rn-muted" aria-hidden /> : null}
                          </span>
                        </td>
                        <td className={TD}>
                          <SourceMark row={row} label={label} />
                        </td>
                        <td className={TD}>
                          <StateMark row={row} />
                        </td>
                        <td className={cx(TD, "text-rn-12 text-rn-muted")}>
                          <span data-rn-tip="" className="block truncate">
                            {row.override?.note ?? ""}
                          </span>
                        </td>
                        <td className={cx(TD, "pr-5")}>
                          <span className="flex items-center justify-end gap-1">
                            {active ? (
                              <RnButton size="sm" disabled={busy} onClick={() => void revert(row)} data-hub-source-revert={row.key}>
                                <RotateCcw className="size-3.5" aria-hidden />
                                {t("revert")}
                              </RnButton>
                            ) : null}
                            {row.override ? (
                              <RnIconButton label={t("historyOpen", { domain: row.skey })} onClick={() => setSheet(row)} data-hub-source-history={row.key}>
                                <History className="size-4" aria-hidden />
                              </RnIconButton>
                            ) : null}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {tip.tip}
            </div>
          )}
          <p className="m-0 border-t border-rn-line px-5 py-2.5 text-rn-11 text-rn-muted">{t("hint", { date: listing.asOf ?? "—", limit: nf.format(listing.limit) })}</p>
        </RnCard>
      </RnFilterSplit>
      <RnDrawer open={sheet != null} onClose={() => setSheet(null)} title={t("detailTitle")} closeLabel={tp("close")}>
        {sheet ? <Detail key={sheet.key} row={listing.items.find((r) => r.key === sheet.key) ?? sheet} label={label} /> : null}
      </RnDrawer>
    </div>
  );
}

// the note and actions columns cannot sort; same head as the sortable ones
const LIST_TH_PLAIN = "sticky -top-1 z-[1] h-[38px] border-b border-rn-line-2 bg-rn-surface px-3 font-semibold";

function errorText(t: ReturnType<typeof useTranslations<"hubSourceOverrides">>, e: SourceRequestError): string {
  const known = ["invalid_value", "not_found", "unauthorized", "forbidden", "source_unavailable"];
  return t(`error.${known.includes(e.code) ? (e.code as "failed") : "failed"}`, { fields: (e.details?.fields ?? []).join(", ") || "—" });
}

/** The layer that decided the category; Gold's own layer under a HUB correction; the owned-domain warning. */
function SourceMark({ row, label }: { row: SourceRow; label: (slug: string | null) => string }) {
  const t = useTranslations("hubSourceOverrides");
  const corrected = row.source === "override";
  const goldTip = row.gold ? t("goldValue", { category: label(row.gold.category), source: row.gold.source ? t(`source.${row.gold.source}`) : "—" }) : t("goldNone");
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 text-rn-12" data-hub-source-layer={row.source} data-rn-tip={goldTip}>
      <span className={cx("truncate rounded px-1.5 py-px font-semibold", corrected ? "bg-rn-navy text-white" : "bg-rn-inset text-rn-ink-2")}>{t(`source.${row.source}`)}</span>
      {row.shadowsOwned ? (
        <span className="inline-flex shrink-0 items-center gap-1 text-rn-danger-ink" data-hub-source-shadows-owned="" title={t("shadowsOwned")}>
          <AlertTriangle className="size-3.5" aria-hidden />
          <span className="sr-only">{t("shadowsOwned")}</span>
        </span>
      ) : null}
    </span>
  );
}

/** 반영됨 / 반영 대기 / 업스트림 교정: the HUB's decision against what Gold applies now. */
function StateMark({ row }: { row: SourceRow }) {
  const t = useTranslations("hubSourceOverrides");
  if (!row.state) return <span className="text-rn-12 text-rn-faint">—</span>;
  const clearing = row.state === "pending" && row.override?.status === "cleared";
  return (
    <span className={cx("inline-flex max-w-full items-center gap-1.5 text-rn-12", row.state === "applied" ? "text-rn-ink" : "text-rn-ink-2")} data-hub-source-state={row.state} data-rn-tip={t(`stateTip.${clearing ? "pendingClear" : row.state}`)}>
      <i aria-hidden className={cx("inline-block size-2 shrink-0 rounded-full", STATE_DOT[row.state])} />
      <span className="truncate">{t(clearing ? "state.pendingClear" : `state.${row.state}`)}</span>
    </span>
  );
}

const STATE_DOT: Record<string, string> = {
  applied: "bg-rn-navy",
  pending: "border-[1.5px] border-rn-navy",
  upstream: "border border-dashed border-rn-muted",
};

function formatTime(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

// ─── sheet: one source's correction and history ─────────────────────────────

function Detail({ row, label }: { row: SourceRow; label: (slug: string | null) => string }) {
  const t = useTranslations("hubSourceOverrides");
  const locale = useLocale();
  const [data, setData] = useState<SourceHistory | null>(null);
  const [error, setError] = useState<SourceRequestError | null>(null);

  useEffect(() => {
    let live = true;
    sourceApi.history(row.key).then(
      (d) => live && (setData(d), setError(null)),
      (e) => live && setError(e instanceof SourceRequestError ? e : new SourceRequestError(0, "failed")),
    );
    return () => {
      live = false;
    };
  }, [row.key, row.override?.updatedAt]);

  const value = (field: string, v: unknown): string | null => {
    if (v == null) return null;
    if (field === "category") return label(String(v));
    if (field === "status") return t(`status.${v as "active"}`);
    return String(v);
  };
  const events = (data?.history ?? []).map((e) => ({
    key: String(e.id),
    label: t(`event.${e.action}`),
    at: e.at,
    actor: e.actor ? e.actor.displayName || e.actor.login : t("system"),
    changes: Object.fromEntries(Object.entries(e.changes).map(([field, [before, after]]) => [field, { old: value(field, before), new: value(field, after) }])),
  }));
  const o = row.override;

  return (
    <div className="flex flex-col gap-6" data-hub-source-detail={row.key}>
      <section className="flex flex-col gap-3">
        <div className="flex min-w-0 items-baseline gap-2">
          <b className="min-w-0 truncate text-rn-16 text-rn-ink">{row.skey}</b>
          {row.isSocial ? <RnTag className="shrink-0">{t("social")}</RnTag> : null}
        </div>
        <dl className="m-0 grid grid-cols-[112px_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-rn-13">
          <RnDetailField label={t("field.citations")}>
            <span className="tabular-nums">{new Intl.NumberFormat(locale).format(row.citations)}</span>
          </RnDetailField>
          <RnDetailField label={t("field.hub")}>{o ? `${label(o.category)} · ${t(`status.${o.status}`)}` : t("noOverride")}</RnDetailField>
          <RnDetailField label={t("field.origin")}>{o ? t(`origin.${o.origin}`) : null}</RnDetailField>
          <RnDetailField label={t("field.gold")}>{row.gold ? `${label(row.gold.category)} · ${row.gold.source ? t(`source.${row.gold.source}`) : "—"}` : t("goldNone")}</RnDetailField>
          <RnDetailField label={t("field.state")}>
            <StateMark row={row} />
          </RnDetailField>
          <RnDetailField label={t("field.note")}>{o?.note ?? null}</RnDetailField>
        </dl>
      </section>
      <section data-hub-source-timeline="">
        <h3 className="m-0 mb-3 text-rn-13 font-bold text-rn-ink">{t("history")}</h3>
        {error ? (
          <p role="alert" className="m-0 rounded-[10px] bg-rn-page p-3.5 text-rn-12 text-rn-ink-2">
            {errorText(t, error)}
          </p>
        ) : !data ? (
          <p className="flex items-center gap-2 text-rn-13 text-rn-muted">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            {t("loading")}
          </p>
        ) : events.length ? (
          <RnTimeline events={events} fieldLabel={(f) => t(`field.${f}` as "field.category")} />
        ) : (
          <p className="m-0 text-rn-12 text-rn-muted">{t("noHistory")}</p>
        )}
      </section>
    </div>
  );
}
