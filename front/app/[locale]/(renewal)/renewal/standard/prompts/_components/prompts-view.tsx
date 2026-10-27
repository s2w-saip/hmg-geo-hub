"use client";

// Renewal Global prompts — the original /standard/prompts list with the renewal layout:
// left filter panel (same 11 single-choice filters, applied at once) + saved filters,
// and a results card. Reads, export and history use the original page's actions and
// helpers, so rows, totals, facets and order are the original's for the same picks.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { ArrowDownWideNarrow, ArrowUpNarrowWide, Bookmark, ChevronLeft, ChevronRight, Download, Globe, History, Link2, Loader2, PanelLeft, Swords, Tag } from "lucide-react";
import {
  RnButton,
  RnCard,
  RnCheckRow,
  RnCountBadge,
  RnEmpty,
  RnIconButton,
  RnNote,
  RnPageHeader,
  RnPanelSection,
  RnPill,
  RnSearchField,
  RnSelect,
  RnTabs,
  RnTag,
  RnTextButton,
  RnToastProvider,
  RnToken,
  useRnToast,
} from "@/components/renewal-ui";
import { collationOf, rereadAfterHydration, type CatalogSort } from "@/lib/standards/catalog-page";
import { countryName } from "@/lib/geo-catalog/country-name";
import { rhqLabel } from "@/lib/rhq";
import { languageName } from "@/lib/geo-catalog/language-name";
import { isPseudoRegion, pseudoRegionLabelKey } from "@/lib/standards/prompt-markets";
import { downloadXlsx } from "@/lib/export/xlsx";
import type { Role } from "@/lib/auth/types";
import { buildStandardPromptSheet, exportFilename, type StandardPromptExportLabels } from "@/app/[locale]/(dash)/standard/prompts/_components/prompt-export";
import type { HistoryQuery, PromptRow, PromptsHistory, PromptsPage, PromptsRemote } from "@/app/[locale]/(dash)/standard/prompts/_data/screen-types";
import { fetchPromptsExport, fetchPromptsPage } from "@/app/[locale]/(dash)/standard/prompts/_data/prompts-client";
import { RnFilterSplit, useRnSplit } from "../../../_components/filter-split";
import { RnSavedFiltersSection, useSavedFilters, type SavedFilter } from "../../../_components/saved-filters";
import { RnAuditHistory, RnPromptTimeline } from "./prompt-history";
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
const MARKET_BADGE_LIMIT = 3;
const SEARCH_MIN = 8;
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
  storageKey: string;
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

function PromptsView({ remote, scopeAll, scopeRole, scopeBrands, scopeRegions, scopeCountries, period, history, loadHistory, initialTab, storageKey, defaultOpen }: PromptsViewProps) {
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
  const [timelineRow, setTimelineRow] = useState<{ id: string; text: string } | null>(null);
  const filtersRef = useRef(filters);
  // The taxonomy column needs room; on a narrow card it folds into the prompt cell
  // (columns are switched, not CSS-hidden: hidden cells would shift into other columns).
  const listRef = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(true);
  const listEmpty = data.total === 0;
  useEffect(() => {
    const el = listRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => setWide(entry.contentRect.width >= 760));
    ro.observe(el);
    return () => ro.disconnect();
  }, [tab, listEmpty]);

  const marketLabel = useCallback(
    (code: string) => {
      if (!isPseudoRegion(code)) return countryName(code, locale);
      const key = pseudoRegionLabelKey(code);
      return key ? tVal(key as "pseudoWorldwide") : code;
    },
    [locale, tVal],
  );
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
  const saved = useSavedFilters(storageKey);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [openedWith, setOpenedWith] = useState<string | null>(null);
  const clearOpened = () => setOpenedWith(null);
  const currentQuery = filterToQuery(filters, search);
  const auto = useRef(false);
  useEffect(() => {
    if (!saved.ready || auto.current) return;
    auto.current = true;
    if (filterToQuery(fromUrl.filters, fromUrl.search)) return;
    const star = saved.items.find((p) => p.star);
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
        rail={<PromptRail count={picked.length} />}
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
            <RnCard busy={busy} aria-label={t("count", { count: data.count })}>
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
                  options={PROMPT_SORTS.map((k) => ({ value: k, label: sortLabel(k, t) }))}
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
                <span className="ml-auto text-rn-12 text-rn-muted tabular-nums">{t("filteredCount", { shown: total, total: data.count })}</span>
                <RnButton size="sm" onClick={handleExport} disabled={exporting || total === 0}>
                  {exporting ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Download className="size-3.5" aria-hidden />}
                  {t("exportLabel")}
                </RnButton>
              </div>
              {total === 0 ? (
                <RnEmpty className="m-5">{t("empty")}</RnEmpty>
              ) : (
                <div ref={listRef} className="overflow-x-auto">
                  <table className="w-full table-fixed border-separate border-spacing-0 text-rn-13" data-rn-prompt-table="" data-wide={wide || undefined}>
                    <colgroup>
                      <col />
                      {wide ? <col className="w-[210px]" /> : null}
                      <col className="w-[160px]" />
                      <col className="w-[104px]" />
                      <col className="w-[48px]" />
                    </colgroup>
                    <thead>
                      <tr className="text-left text-rn-12 font-semibold text-rn-muted">
                        <th scope="col" className="h-[38px] border-b border-rn-line-2 pr-3 pl-5 font-semibold">{t("textLabel")}</th>
                        {wide ? <th scope="col" className="h-[38px] border-b border-rn-line-2 px-3 font-semibold">{tp("columnTaxonomy")}</th> : null}
                        <th scope="col" className="h-[38px] border-b border-rn-line-2 px-3 font-semibold">{t("marketLabel")}</th>
                        <th scope="col" className="h-[38px] border-b border-rn-line-2 px-3 font-semibold">{tp("columnMeasure")}</th>
                        <th scope="col" className="h-[38px] border-b border-rn-line-2 pr-4 pl-2 text-right font-semibold">
                          <span className="sr-only">{t("historyColumn")}</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => {
                        const path = [hasListType ? r.listType : null, ...depthCols.map((c) => r[c])].filter(Boolean) as string[];
                        return (
                          <tr key={r.id} data-rn-prompt-row={r.id} className="align-top hover:bg-rn-navy-25/60">
                            <td className="border-b border-rn-line py-3 pr-3 pl-5">
                              <div className="leading-snug text-rn-ink">{r.text}</div>
                              <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-rn-12 text-rn-muted">
                                <RnTag className={r.common ? "bg-rn-inset text-rn-ink-2" : undefined}>
                                  {r.common ? t("common") : r.brand}
                                </RnTag>
                                {r.presence ? <span>{tVal(r.presence)}</span> : null}
                                {r.lang ? <span>· {languageName(r.lang, locale)}</span> : null}
                              </div>
                              {!wide && (path.length || r.funnelStage) ? (
                                <div className="mt-1 text-rn-12 text-rn-muted">
                                  {path.join(" › ")}
                                  {r.funnelStage ? ` · ${r.funnelStage}` : ""}
                                </div>
                              ) : null}
                            </td>
                            {wide ? (
                              <td className="border-b border-rn-line px-3 py-3">
                                <div className="text-rn-12 leading-snug break-words text-rn-ink-2">{path.length ? path.join(" › ") : "—"}</div>
                                {r.funnelStage ? <span className="mt-1.5 inline-block rounded-md bg-rn-navy/8 px-1.5 py-px text-rn-12 font-semibold text-rn-navy">{r.funnelStage}</span> : null}
                              </td>
                            ) : null}
                            <td className="border-b border-rn-line px-3 py-3">
                              <Markets markets={r.markets} labelOf={marketLabel} allLabel={t("marketAll")} allHint={t("marketAllHint")} moreHint={t("marketMoreHint")} />
                            </td>
                            <td className="border-b border-rn-line px-3 py-3">
                              <div className="flex flex-col items-start gap-1.5">
                                {r.kind === "acr" ? (
                                  <span className="inline-flex items-center gap-1 rounded-md px-1.5 py-px text-rn-12 font-bold text-rn-navy shadow-[inset_0_0_0_1px_var(--color-rn-navy-300)]">
                                    <Swords className="size-3" aria-hidden />
                                    {t("kindAcr")}
                                  </span>
                                ) : (
                                  <span className="text-rn-12 text-rn-muted">{t("kindSingle")}</span>
                                )}
                                {r.scopePromptId === null ? (
                                  <span className="inline-flex items-center gap-1 text-rn-12 text-rn-muted" title={t("statusUnmeasuredHint")}>
                                    <i aria-hidden className="inline-block size-2 rounded-full border border-dashed border-rn-muted" />
                                    {t("statusUnmeasured")}
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center gap-1 text-rn-12 text-rn-ink-2">
                                    <i aria-hidden className="inline-block size-2 rounded-full bg-rn-navy" />
                                    {t("statusMeasured")}
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className="border-b border-rn-line py-2.5 pr-4 pl-2 text-right">
                              <RnIconButton label={t("historyColumn")} onClick={() => setTimelineRow({ id: r.id, text: r.text })}>
                                <History className="size-3.5" aria-hidden />
                              </RnIconButton>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {total > 0 ? (
                <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-rn-12 text-rn-muted">
                  <span className="flex items-center gap-2">
                    <span className="tabular-nums">{t("pageRange", { from: rangeFrom, to: rangeTo, total })}</span>
                    <RnSelect
                      label={t("pageSize")}
                      value={String(pageSize)}
                      onChange={(e) => {
                        setPageSize(Number(e.target.value));
                        setPage(1);
                      }}
                      options={PAGE_SIZE_OPTIONS.map((n) => ({ value: String(n), label: `${t("pageSize")} ${n}` }))}
                    />
                  </span>
                  {pages > 1 ? (
                    <span className="flex items-center gap-2">
                      <RnButton size="sm" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>
                        <ChevronLeft className="size-3.5" aria-hidden />
                        {t("prev")}
                      </RnButton>
                      <span className="tabular-nums">{t("pageOf", { page: safePage, pages })}</span>
                      <RnButton size="sm" disabled={safePage >= pages} onClick={() => setPage(safePage + 1)}>
                        {t("next")}
                        <ChevronRight className="size-3.5" aria-hidden />
                      </RnButton>
                    </span>
                  ) : null}
                </div>
              ) : null}
            </RnCard>
          </>
        )}
      </RnFilterSplit>
      <RnPromptTimeline row={timelineRow} onClose={() => setTimelineRow(null)} closeLabel={tp("close")} />
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

/** The original MarketCell rule: real countries first (top 3 + "+N"), pseudo slots always shown, unset = "전체". */
function Markets({ markets, labelOf, allLabel, allHint, moreHint }: { markets: PromptRow["markets"]; labelOf: (c: string) => string; allLabel: string; allHint: string; moreHint: string }) {
  const { real, pseudo } = markets;
  if (real.length === 0 && pseudo.length === 0) {
    return (
      <span title={allHint} className="inline-flex items-center gap-1 rounded-md bg-rn-inset px-1.5 py-px text-rn-12 text-rn-ink-2">
        <Globe className="size-3" aria-hidden />
        {allLabel}
      </span>
    );
  }
  const shown = [...real.slice(0, MARKET_BADGE_LIMIT), ...pseudo];
  const hidden = real.slice(MARKET_BADGE_LIMIT);
  const all = [...real, ...pseudo].map(labelOf).join(" · ");
  return (
    <div className="flex flex-wrap items-center gap-1">
      {shown.map((code) =>
        isPseudoRegion(code) ? (
          <span key={code} className="inline-flex items-center gap-1 rounded-md border border-dashed border-rn-faint px-1.5 text-rn-12 text-rn-muted">
            <Tag className="size-3" aria-hidden />
            {labelOf(code)}
          </span>
        ) : (
          <span key={code} className="rounded-md bg-rn-inset px-1.5 py-px text-rn-12 text-rn-ink-2">
            {labelOf(code)}
          </span>
        ),
      )}
      {hidden.length ? (
        <span title={all} aria-label={moreHint} className="rounded-md px-1.5 py-px text-rn-12 text-rn-muted tabular-nums shadow-[inset_0_0_0_1px_var(--color-rn-line-2)]">
          +{hidden.length}
        </span>
      ) : null}
    </div>
  );
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
  const tf = useTranslations("dashboard.filters");
  const tr = useTranslations("renewal.filters");
  const { collapse } = useRnSplit();
  const count = activeAxes(filters).length;
  return (
    <aside id="rn-filter-panel" aria-label={tr("title")} className="max-h-full overflow-auto overscroll-contain rounded-rn-card bg-rn-surface shadow-rn-card">
      <div className="sticky top-0 z-[2] rounded-t-rn-card flex items-center gap-2 border-b border-rn-line bg-rn-surface py-3 pr-2.5 pl-4.5">
        <b className="text-rn-15 text-rn-ink">{tr("title")}</b>
        <span className="text-rn-12 text-rn-muted">{count ? tr("selectedAxes", { count }) : tr("noneSelected")}</span>
        {count ? (
          <button type="button" data-rn-reset="" onClick={onReset} className="cursor-pointer text-rn-12 text-rn-muted underline underline-offset-3 hover:text-rn-ink">
            {tf("reset")}
          </button>
        ) : null}
        <RnIconButton label={tr("collapse")} className="ml-auto" onClick={collapse}>
          <ChevronLeft className="size-4" aria-hidden />
        </RnIconButton>
      </div>
      {saved}
      <div className="pt-1.5" data-rn-section="prompt">
        {axes.map((a) => (
          <AxisList
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
      </div>
      <div className="h-3" />
    </aside>
  );
}

function AxisList({
  axis,
  label,
  value,
  options,
  valueLabel,
  allLabel,
  open,
  onToggle,
  onPick,
}: {
  axis: PromptAxis;
  label: string;
  value: string;
  options: readonly string[];
  valueLabel: (v: string) => string;
  allLabel: string;
  open: boolean;
  onToggle: () => void;
  onPick: (v: string) => void;
}) {
  const tp = useTranslations("renewal.prompts");
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const shown = query ? options.filter((o) => o.toLowerCase().includes(query) || valueLabel(o).toLowerCase().includes(query)) : options;
  return (
    <RnPanelSection title={label} open={open} onToggle={onToggle} summary={value !== ALL ? valueLabel(value) : undefined} focusKey={`s:${axis}`}>
      {options.length >= SEARCH_MIN ? (
        <RnSearchField className="mx-0.5 mb-1.5" value={q} onChange={setQ} placeholder={tp("optionSearch", { label })} label={tp("optionSearch", { label })} />
      ) : null}
      <div role="radiogroup" aria-label={label}>
        <RnCheckRow radio checked={value === ALL} label={allLabel} focusKey={`v:${axis}:${ALL}`} onToggle={() => onPick(ALL)} />
        {shown.map((v) => (
          <RnCheckRow key={v} radio checked={value === v} label={valueLabel(v)} focusKey={`v:${axis}:${v}`} onToggle={() => onPick(v)} />
        ))}
      </div>
    </RnPanelSection>
  );
}

function PromptRail({ count }: { count: number }) {
  const tr = useTranslations("renewal.filters");
  const { expand } = useRnSplit();
  return (
    <aside aria-label={tr("title")} className="flex flex-col items-center gap-1.5 rounded-rn-card bg-rn-surface py-2 shadow-rn-card">
      <RnIconButton label={tr("expand")} className="size-9" onClick={expand}>
        <PanelLeft className="size-[18px]" aria-hidden />
        {count ? <RnCountBadge className="absolute -top-0.5 -right-1">{count}</RnCountBadge> : null}
      </RnIconButton>
      <RnIconButton label={tr("openSaved")} className="size-9" onClick={expand}>
        <Bookmark className="size-[18px]" aria-hidden />
      </RnIconButton>
    </aside>
  );
}

