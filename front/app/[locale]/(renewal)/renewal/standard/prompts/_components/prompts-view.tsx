"use client";

// Renewal Global prompts — the original /standard/prompts list with the renewal layout:
// left filter panel (same 11 single-choice filters, applied at once) + saved filters,
// and a results card. Reads, export and history use the original page's actions and
// helpers, so rows, totals, facets and order are the original's for the same picks.
// The list (2026-10-28, for a 1920×1050 window): one line per prompt, one column per attribute,
// cut-off cells show their full text on hover, a row opens the detail sheet (prompt-detail.tsx).
// The panel, list and sheet parts are shared with Admin › Global prompts (_components/prompt-list.tsx).

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { ArrowDownWideNarrow, ArrowUpNarrowWide, Bookmark, Download, Globe, Link2, Loader2 } from "lucide-react";
import {
  RnButton,
  RnCard,
  RnEmpty,
  RnIconButton,
  RnNote,
  RnPageHeader,
  RnPill,
  RnSearchField,
  RnSelect,
  RnTabs,
  RnTag,
  RnTextButton,
  RnToastProvider,
  RnToken,
  cx,
  useRnToast,
  useRnTruncTip,
} from "@/components/renewal-ui";
import { collationOf, rereadAfterHydration, type CatalogSort } from "@/lib/standards/catalog-page";
import { rhqLabel } from "@/lib/rhq";
import { languageName } from "@/lib/geo-catalog/language-name";
import { downloadXlsx } from "@/lib/export/xlsx";
import type { Role } from "@/lib/auth/types";
import { buildStandardPromptSheet, exportFilename, type StandardPromptExportLabels } from "@/app/[locale]/(dash)/standard/prompts/_components/prompt-export";
import type { HistoryQuery, PromptRow, PromptsHistory, PromptsPage, PromptsRemote } from "@/app/[locale]/(dash)/standard/prompts/_data/screen-types";
import { fetchPromptsExport, fetchPromptsPage } from "@/app/[locale]/(dash)/standard/prompts/_data/prompts-client";
import { RnFilterSplit } from "../../../_components/filter-split";
import {
  LIST_TD as TD,
  RnFilterPanel,
  RnFilterRail,
  RnFunnelChip,
  RnKindMark,
  RnListPager,
  RnMarkets as Markets,
  RnRadioAxis,
  RnSortHead,
  useRnMarketLabel,
} from "../../../_components/prompt-list";
import { RnSavedFiltersSection, useSavedFilters, type SavedFilter, type SavedFiltersSource } from "../../../_components/saved-filters";
import { RnAuditHistory } from "./prompt-history";
import { RnPromptDetail } from "./prompt-detail";
import {
  ALL,
  DEFAULT_SORT,
  EMPTY_FILTER,
  PROMPT_AXES,
  PROMPT_SORTS,
  activeAxes,
  axisOptions,
  filterToQuery,
  firstAsc,
  patchDraft,
  queryToFilter,
  readQuery,
  visibleAxes,
  type FilterState,
  type PromptAxis,
} from "./prompt-filter-model";

const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_OPEN: Partial<Record<PromptAxis, boolean>> = { listType: true, depth1: true, funnel: true, presence: true, kind: true, status: true };
const CHILD: Partial<Record<PromptAxis, PromptAxis>> = { listType: "depth1", depth1: "depth2", depth2: "depth3", depth3: "depth4" };

export interface PromptsViewProps {
  remote: PromptsRemote;
  scopeAll: boolean;
  scopeRole: Role;
  scopeBrands: string[];
  scopeRegions: string[];
  scopeCountries: string[];
  period: { from: string; to: string } | null;
  history: PromptsHistory;
  loadHistory?: (query: HistoryQuery) => Promise<PromptsHistory>;
  initialTab: "catalog" | "history";
  savedFilters: SavedFiltersSource;
  /** "all" opens every filter section (parity test). */
  defaultOpen?: "all";
}

export function RnPromptsView(props: PromptsViewProps) {
  return (
    <RnToastProvider>
      <PromptsView {...props} />
    </RnToastProvider>
  );
}

function PromptsView({ remote, scopeAll, scopeRole, scopeBrands, scopeRegions, scopeCountries, period, history, loadHistory, initialTab, savedFilters, defaultOpen }: PromptsViewProps) {
  const t = useTranslations("standardPromptsView");
  const tVal = useTranslations("dashboard.filters.value");
  const tAudit = useTranslations("promptAudit.history");
  const tp = useTranslations("renewal.prompts");
  const tr = useTranslations("renewal.filters");
  const ts = useTranslations("renewal.saved");
  const locale = useLocale();
  const toast = useRnToast();
  const sp = useSearchParams();
  const fromUrl = useMemo(() => queryToFilter(sp), []); // eslint-disable-line react-hooks/exhaustive-deps

  const [tab, setTab] = useState<"catalog" | "history">(initialTab);
  const [filters, setFilters] = useState<FilterState>(fromUrl.filters);
  const [search, setSearch] = useState(fromUrl.search);
  const [sort, setSort] = useState(DEFAULT_SORT);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<PromptsPage>(remote.initial);
  const [busy, setBusy] = useState(false);
  const [readError, setReadError] = useState<Error | null>(null);
  const [detail, setDetail] = useState<PromptRow | null>(null);
  const filtersRef = useRef(filters);
  const tip = useRnTruncTip();

  const marketLabel = useRnMarketLabel();
  const rows: PromptRow[] = data.rows;
  const facets = data.facets;
  const valueLabel = useCallback(
    (axis: PromptAxis, v: string): string => {
      if (v === ALL) return t("filterAll");
      if (axis === "presence") return tVal(v as "branded");
      if (axis === "kind") return v === "acr" ? t("kindAcr") : t("kindSingle");
      if (axis === "status") return v === "measured" ? t("statusMeasured") : t("statusUnmeasured");
      if (axis === "market") return marketLabel(v);
      if (axis === "lang") return languageName(v, locale);
      return v;
    },
    [locale, marketLabel, t, tVal],
  );
  const axisLabel = useCallback(
    (axis: PromptAxis): string =>
      ({
        listType: t("filterListType"),
        depth1: t("filterDepth1"),
        depth2: t("filterDepth2"),
        depth3: t("filterDepth3"),
        depth4: t("filterDepth4"),
        funnel: t("filterFunnel"),
        presence: t("presenceLabel"),
        kind: t("kindLabel"),
        market: t("marketLabel"),
        lang: t("langLabel"),
        status: t("statusLabel"),
      })[axis],
    [t],
  );

  // ── reads: the original list's loader and query, debounced 120 ms, latest wins ──
  const load = remote.load ?? fetchPromptsPage;
  const marketCodes = data.facets.marketSort ?? [];
  const collation = collationOf(typeof Intl !== "undefined" ? Intl.Collator().resolvedOptions().locale : "en");
  const query = readQuery({ filters, search, sort: sort.key, asc: sort.asc, page, pageSize, collation, marketCodes, marketLabel });
  const readKey = JSON.stringify(query);
  const firstRead = useRef(true);
  useEffect(() => {
    if (firstRead.current) {
      firstRead.current = false;
      const untouched = !filterToQuery(filters, search) && sort === DEFAULT_SORT && page === 1 && pageSize === DEFAULT_PAGE_SIZE;
      if (untouched && !rereadAfterHydration({ collation: remote.initial.collation }, collation)) return;
    }
    let active = true;
    setBusy(true);
    const timer = setTimeout(() => {
      load(JSON.parse(readKey))
        .then((res) => {
          if (!active) return;
          setData(res);
          setBusy(false);
          setReadError(null);
        })
        .catch((e: unknown) => {
          if (active) setReadError(e instanceof Error ? e : new Error("Catalog read failed"));
        });
    }, 120);
    return () => {
      active = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readKey, load]);

  // URL mirrors the picks (shareable, restorable); shallow — no server round trip.
  useEffect(() => {
    const p = new URLSearchParams(filterToQuery(filters, search));
    if (tab === "history") p.set("tab", "history");
    const qs = p.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
  }, [filters, search, tab]);

  const [open, setOpen] = useState<Partial<Record<PromptAxis, boolean>>>(() => (defaultOpen === "all" ? Object.fromEntries(PROMPT_AXES.map((a) => [a, true])) : DEFAULT_OPEN));
  const pick = (axis: PromptAxis, value: string) => {
    const next = patchDraft(filtersRef.current, { [axis]: value } as Partial<FilterState>);
    filtersRef.current = next;
    setFilters(next);
    setPage(1);
    clearOpened();
    const child = CHILD[axis];
    if (child && value !== ALL) setOpen((o) => ({ ...o, [child]: true }));
  };
  const setAll = (next: FilterState, nextSearch: string) => {
    filtersRef.current = next;
    setFilters(next);
    setSearch(nextSearch);
    setPage(1);
  };

  // ── saved filters ──
  const saved = useSavedFilters(savedFilters);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [openedWith, setOpenedWith] = useState<string | null>(null);
  const clearOpened = () => setOpenedWith(null);
  const currentQuery = filterToQuery(filters, search);
  const auto = useRef(false);
  useEffect(() => {
    if (!saved.ready || auto.current) return;
    auto.current = true;
    if (filterToQuery(fromUrl.filters, fromUrl.search)) return;
    const star = saved.items.find((p) => p.isDefault);
    if (!star) return;
    const q = queryToFilter(star.query);
    setAll(q.filters, q.search);
    setActiveId(star.id);
    setOpenedWith(star.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved.ready]);
  const summarize = useCallback(
    (q: string) => {
      const { filters: f, search: s } = queryToFilter(q);
      return [...activeAxes(f).map((a) => valueLabel(a, f[a])), ...(s ? [`“${s}”`] : [])].join(" · ");
    },
    [valueLabel],
  );

  // ── export: every filtered row in server order (the original handleExport) ──
  const [exporting, setExporting] = useState(false);
  async function handleExport() {
    if (exporting || data.total === 0) return;
    setExporting(true);
    try {
      const labels: StandardPromptExportLabels = {
        text: t("textLabel"),
        brand: t("brandLabel"),
        listType: t("filterListType"),
        depth1: t("filterDepth1"),
        depth2: t("filterDepth2"),
        depth3: t("filterDepth3"),
        depth4: t("filterDepth4"),
        funnel: t("funnelLabel"),
        market: t("marketLabel"),
        lang: t("langLabel"),
        presence: t("presenceLabel"),
        kind: t("kindLabel"),
        status: t("statusLabel"),
        common: t("common"),
        marketAll: t("marketAll"),
        branded: tVal("branded"),
        unbranded: tVal("unbranded"),
        kindAcr: t("kindAcr"),
        kindSingle: t("kindSingle"),
        statusMeasured: t("statusMeasured"),
        statusUnmeasured: t("statusUnmeasured"),
      };
      const exported = await (remote.exportRows ?? fetchPromptsExport)(query);
      const sheet = buildStandardPromptSheet(exported.rows, exported.columns, labels, {
        market: marketLabel,
        language: (code) => languageName(code, locale),
      });
      await downloadXlsx(exportFilename(t("exportFilename"), new Date()), sheet.headers, sheet.rows, t("exportSheetName"));
    } catch (err) {
      console.error("[renewal/standard/prompts] export failed:", err);
      toast(t("exportFailed"));
    } finally {
      setExporting(false);
    }
  }

  // ── scope summary (the original strip, condensed into a pill) ──
  const showRegions = scopeRole !== "country" && scopeRegions.length > 0;
  const scopeSummary = useMemo(() => {
    if (scopeAll) return t("scopeAll");
    const parts: string[] = [];
    if (scopeBrands.length) parts.push(scopeBrands.join(" · "));
    if (showRegions) parts.push(scopeRegions.map((r) => rhqLabel(r, locale === "en" ? "en" : "ko") ?? r).join(" · "));
    if (scopeCountries.length) parts.push(scopeCountries.length <= 2 ? scopeCountries.join(" · ") : t("scopeCountryCount", { count: scopeCountries.length }));
    return parts.join("  ·  ") || t("scopeAll");
  }, [scopeAll, scopeBrands, showRegions, scopeRegions, scopeCountries, locale, t]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey) return;
      const el = document.activeElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT")) return;
      e.preventDefault();
      document.querySelector<HTMLInputElement>("#rn-prompt-search")?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  if (readError) throw readError;
  // The page actually read (a page past the end falls back to the last one) and its labels.
  const { total, page: safePage, pages, rangeFrom, rangeTo } = data;
  const axes = visibleAxes(facets);
  const picked = activeAxes(filters);
  const depthCols = (["depth1", "depth2", "depth3", "depth4"] as const).filter((c) => data.columns.includes(c));
  const hasListType = axisOptions("listType", facets).length > 0;
  // the sort offers the taxonomy axes the list shows (a Depth no row of the scope has is not offered — Gold
  // metric review ⚠️ #40: Depth4 is empty everywhere); the sort in use stays listed
  const sortKeys = PROMPT_SORTS.filter((k) => k === sort.key || (k === "listType" ? hasListType : !k.startsWith("depth") || (depthCols as readonly string[]).includes(k)));
  // counts group their thousands like the tab's count (review ⚠️ #6: "표시 12164")
  const num = (n: number) => n.toLocaleString(locale);
  // a row's taxonomy levels: the list type and the Depth columns of the scope ("-" = an unset level)
  const level = (v: string | null) => (v && v.trim() !== "-" ? v : null);
  const taxonomy = (r: PromptRow) => [
    ...(hasListType ? [{ axis: "listType" as PromptAxis, label: axisLabel("listType"), value: level(r.listType) }] : []),
    ...depthCols.map((c) => ({ axis: c as PromptAxis, label: axisLabel(c), value: level(r[c]) })),
  ];
  // a column head sorts by its attribute; the active one flips the direction (the toolbar's sort stays in step)
  const head = (key: CatalogSort, label: string, className?: string) => (
    <RnSortHead
      sortKey={key}
      label={label}
      sort={sort}
      className={className}
      onSort={(k) => {
        setSort((s) => (s.key === k ? { key: k, asc: !s.asc } : { key: k, asc: firstAsc(k) }));
        setPage(1);
      }}
    />
  );

  const panel = (
    <PromptPanel
      axes={axes}
      filters={filters}
      options={(a) => axisOptions(a, facets)}
      axisLabel={axisLabel}
      valueLabel={valueLabel}
      onPick={pick}
      open={open}
      setOpen={setOpen}
      onReset={() => {
        const before = { f: filtersRef.current, s: search };
        setAll(EMPTY_FILTER, "");
        toast(tr("resetDone"), { undoLabel: tr("undo"), undo: () => setAll(before.f, before.s) });
      }}
      saved={
        <RnSavedFiltersSection
          saved={saved}
          activeId={activeId}
          onActivate={(item: SavedFilter | null) => {
            if (!item) {
              setActiveId(null);
              return;
            }
            const q = queryToFilter(item.query);
            setAll(q.filters, q.search);
            setActiveId(item.id);
            setOpenedWith(null);
          }}
          currentQuery={currentQuery}
          summarize={summarize}
          hrefOf={(q) => `${window.location.origin}${window.location.pathname}${q ? `?${q}` : ""}`}
        />
      }
    />
  );

  return (
    <div className="flex flex-col gap-4">
      <RnFilterSplit
        header={
          <RnPageHeader
            title={t("title")}
            meta={
              <>
                <RnPill title={!scopeAll && scopeCountries.length ? t("scopeMarketHintDetail") : undefined}>
                  <Globe className="size-3 text-rn-muted" aria-hidden />
                  {tp("scopePill", { scope: scopeSummary })}
                  {!scopeAll ? <span className="text-rn-muted">· {t("scopeCommonHint")}</span> : null}
                </RnPill>
                {period ? (
                  <span className="tabular-nums">
                    {t("collectionPeriod", { from: period.from, to: period.to })} · {t("lastCollectedAt", { date: period.to })}
                  </span>
                ) : null}
              </>
            }
            actions={
              <RnButton
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(window.location.href);
                    toast(tp("linkCopied"));
                  } catch {
                    toast(ts("linkFailed"));
                  }
                }}
              >
                <Link2 className="size-3.5" aria-hidden />
                {tp("copyLink")}
              </RnButton>
            }
          />
        }
        panel={panel}
        rail={<RnFilterRail count={picked.length} />}
      >
        <RnTabs
          className="self-start"
          label={tp("tabsLabel")}
          value={tab}
          onChange={setTab}
          items={[
            { value: "catalog", label: tAudit("tabCatalog"), count: data.count.toLocaleString(locale) },
            { value: "history", label: tAudit("tabHistory") },
          ]}
        />
        {tab === "history" ? (
          <RnCard className="p-5">
            <RnAuditHistory initial={history} load={loadHistory} />
          </RnCard>
        ) : (
          <>
            {picked.length || search || busy ? (
              <div aria-live="polite" className="flex min-h-7 flex-wrap items-center gap-2">
                {picked.map((a) => (
                  <RnToken key={a} label={axisLabel(a)} value={valueLabel(a, filters[a])} removeLabel={tr("removeToken", { label: axisLabel(a) })} onRemove={() => pick(a, ALL)} />
                ))}
                {search ? <RnToken label={t("searchPlaceholder")} value={`“${search}”`} removeLabel={tr("removeToken", { label: t("searchPlaceholder") })} onRemove={() => { setSearch(""); setPage(1); }} /> : null}
                {busy ? (
                  <span className="ml-auto inline-flex items-center gap-1.5 text-rn-12 text-rn-navy">
                    <Loader2 className="size-3 animate-spin" aria-hidden />
                    {tr("applying")}
                  </span>
                ) : null}
              </div>
            ) : null}
            {openedWith ? (
              <RnNote>
                <Bookmark className="size-3.5" aria-hidden />
                <span>{ts("openedWithDefault", { name: openedWith })}</span>
                <RnTextButton
                  onClick={() => {
                    setOpenedWith(null);
                    setAll(EMPTY_FILTER, "");
                  }}
                >
                  {ts("viewWithout")}
                </RnTextButton>
              </RnNote>
            ) : null}
            <RnCard busy={busy} aria-label={t("count", { count: num(data.count) })}>
              <div className="flex flex-wrap items-center gap-2 border-b border-rn-line px-5 py-3">
                <RnSearchField
                  id="rn-prompt-search"
                  className="w-full max-w-[280px] min-w-[180px] flex-1"
                  value={search}
                  onChange={(v) => {
                    setSearch(v);
                    setPage(1);
                  }}
                  placeholder={t("searchPlaceholder")}
                  label={t("searchPlaceholder")}
                />
                <RnSelect
                  label={tp("sortLabel")}
                  value={sort.key}
                  onChange={(e) => {
                    const key = e.target.value as CatalogSort;
                    setSort({ key, asc: firstAsc(key) });
                    setPage(1);
                  }}
                  options={sortKeys.map((k) => ({ value: k, label: sortLabel(k, t) }))}
                />
                <RnIconButton
                  label={sort.asc ? tp("sortAsc") : tp("sortDesc")}
                  onClick={() => {
                    setSort((s) => ({ key: s.key, asc: !s.asc }));
                    setPage(1);
                  }}
                >
                  {sort.asc ? <ArrowUpNarrowWide className="size-4" aria-hidden /> : <ArrowDownWideNarrow className="size-4" aria-hidden />}
                </RnIconButton>
                <span className="ml-auto text-rn-12 text-rn-muted tabular-nums">{t("filteredCount", { shown: num(total), total: num(data.count) })}</span>
                <RnButton size="sm" onClick={handleExport} disabled={exporting || total === 0}>
                  {exporting ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Download className="size-3.5" aria-hidden />}
                  {t("exportLabel")}
                </RnButton>
              </div>
              {total === 0 ? (
                // the scope has prompts and the picks left none: say so, not that nothing is viewable (review ⚠️ #21)
                <RnEmpty className="m-5">{data.count > 0 ? tp("emptyFiltered") : t("empty")}</RnEmpty>
              ) : (
                <div {...tip.bind}>
                  <table className="w-full table-fixed border-separate border-spacing-0 text-rn-13" data-rn-prompt-table="">
                    <colgroup>
                      <col />
                      <col className="w-[136px]" />
                      <col className="w-[108px]" />
                      <col className="w-[208px]" />
                      <col className="w-[132px]" />
                      <col className="w-[116px]" />
                    </colgroup>
                    <thead>
                      <tr className="text-left text-rn-12 text-rn-muted">
                        {head("text", t("textLabel"), "pl-5")}
                        {head("brand", t("brandLabel"))}
                        {head("funnel", t("funnelLabel"))}
                        {head("depth1", tp("columnTaxonomy"))}
                        {head("market", t("marketLabel"))}
                        {head("kind", tp("columnMeasure"))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => {
                        // the cell starts at Depth1 (the list type's 3 values would fill it on every row);
                        // the tip lists every level by name
                        const levels = taxonomy(r).filter((l) => l.value);
                        const depths = levels.filter((l) => l.axis !== "listType");
                        const path = (depths.length ? depths : levels).map((l) => l.value).join(" › ");
                        return (
                          <tr
                            key={r.id}
                            data-rn-prompt-row={r.id}
                            // a drag that selects text is not a click on the row
                            onClick={() => !window.getSelection()?.toString() && setDetail(r)}
                            className="cursor-pointer hover:bg-rn-navy-25/60"
                          >
                            <td className={cx(TD, "pl-5")}>
                              <span className="flex min-w-0 items-center gap-2">
                                {r.lang ? (
                                  <span data-rn-tip={languageName(r.lang, locale)} className="w-5 shrink-0 text-rn-11 font-semibold text-rn-faint uppercase">
                                    {r.lang}
                                  </span>
                                ) : null}
                                <button type="button" data-rn-tip="" className="min-w-0 flex-1 cursor-pointer truncate text-left text-rn-ink focus-visible:outline-2 focus-visible:outline-rn-navy">
                                  {r.text}
                                </button>
                              </span>
                            </td>
                            <td className={TD}>
                              <span className="flex min-w-0 items-center gap-1.5">
                                <RnTag className={cx("shrink-0", r.common && "bg-rn-inset text-rn-ink-2")}>{r.common ? t("common") : r.brand}</RnTag>
                                {r.presence ? (
                                  <span data-rn-tip={tVal(r.presence)} className="truncate text-rn-12 text-rn-muted">
                                    {tp(`presenceShort.${r.presence}`)}
                                  </span>
                                ) : null}
                              </span>
                            </td>
                            <td className={TD}>
                              <RnFunnelChip value={r.funnelStage} />
                            </td>
                            <td className={TD}>
                              <span data-rn-tip={levels.map((l) => `${l.label}: ${l.value}`).join("\n") || undefined} className="block truncate text-rn-12 text-rn-ink-2">
                                {path || "—"}
                              </span>
                            </td>
                            <td className={TD}>
                              <Markets markets={r.markets} labelOf={marketLabel} allLabel={t("marketAll")} allHint={t("marketAllHint")} />
                            </td>
                            <td className={TD}>
                              <span className="flex items-center gap-1.5 text-rn-12 whitespace-nowrap">
                                <RnKindMark acr={r.kind === "acr"} />
                                {r.scopePromptId === null ? (
                                  <span data-rn-tip={tp("unmeasuredHint")} className="inline-flex items-center gap-1 text-rn-muted">
                                    <i aria-hidden className="inline-block size-2 rounded-full border border-dashed border-rn-muted" />
                                    {t("statusUnmeasured")}
                                  </span>
                                ) : (
                                  <span data-rn-tip={t("statusMeasured")} className="inline-flex p-0.5">
                                    <i aria-hidden className="inline-block size-2 rounded-full bg-rn-navy" />
                                    <span className="sr-only">{t("statusMeasured")}</span>
                                  </span>
                                )}
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
              {total > 0 ? (
                <RnListPager
                  rangeFrom={rangeFrom}
                  rangeTo={rangeTo}
                  total={total}
                  page={safePage}
                  pages={pages}
                  pageSize={pageSize}
                  pageSizes={PAGE_SIZE_OPTIONS}
                  onPageSize={(n) => {
                    setPageSize(n);
                    setPage(1);
                  }}
                  onPage={setPage}
                />
              ) : null}
            </RnCard>
          </>
        )}
      </RnFilterSplit>
      <RnPromptDetail row={detail} taxonomy={taxonomy} marketLabel={marketLabel} onClose={() => setDetail(null)} />
    </div>
  );
}

function sortLabel(k: CatalogSort, t: (key: "textLabel" | "brandLabel" | "presenceLabel" | "filterListType" | "filterDepth1" | "filterDepth2" | "filterDepth3" | "filterDepth4" | "funnelLabel" | "kindLabel" | "marketLabel" | "langLabel" | "statusLabel") => string): string {
  switch (k) {
    case "text":
      return t("textLabel");
    case "brand":
      return t("brandLabel");
    case "presence":
      return t("presenceLabel");
    case "listType":
      return t("filterListType");
    case "depth1":
      return t("filterDepth1");
    case "depth2":
      return t("filterDepth2");
    case "depth3":
      return t("filterDepth3");
    case "depth4":
      return t("filterDepth4");
    case "funnel":
      return t("funnelLabel");
    case "kind":
      return t("kindLabel");
    case "market":
      return t("marketLabel");
    case "lang":
      return t("langLabel");
    case "status":
      return t("statusLabel");
    default:
      return k;
  }
}

function PromptPanel({
  axes,
  filters,
  options,
  axisLabel,
  valueLabel,
  onPick,
  open,
  setOpen,
  onReset,
  saved,
}: {
  axes: PromptAxis[];
  filters: FilterState;
  options: (a: PromptAxis) => readonly string[];
  axisLabel: (a: PromptAxis) => string;
  valueLabel: (a: PromptAxis, v: string) => string;
  onPick: (a: PromptAxis, v: string) => void;
  open: Partial<Record<PromptAxis, boolean>>;
  setOpen: (fn: (o: Partial<Record<PromptAxis, boolean>>) => Partial<Record<PromptAxis, boolean>>) => void;
  onReset: () => void;
  saved: ReactNode;
}) {
  const t = useTranslations("standardPromptsView");
  return (
    <RnFilterPanel count={activeAxes(filters).length} onReset={onReset} saved={saved}>
      {axes.map((a) => (
        <RnRadioAxis
          key={a}
          axis={a}
          label={axisLabel(a)}
          value={filters[a]}
          options={options(a)}
          valueLabel={(v) => valueLabel(a, v)}
          allLabel={t("filterAll")}
          open={open[a] ?? false}
          onToggle={() => setOpen((o) => ({ ...o, [a]: !(o[a] ?? false) }))}
          onPick={(v) => onPick(a, v)}
        />
      ))}
    </RnFilterPanel>
  );
}
