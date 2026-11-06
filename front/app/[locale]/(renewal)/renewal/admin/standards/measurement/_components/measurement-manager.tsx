"use client";

// Admin › 측정 설정 (T6.3, 2026-11-07): every project in one list, so what is left to register shows at a glance. A row's sheet is the form of Project › Setting, which
// writes through the same route; a save refreshes the page's listing.

import { useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowDownWideNarrow, ArrowUpNarrowWide, Plus } from "lucide-react";
import {
  RnButton,
  RnCard,
  RnDrawer,
  RnEmpty,
  RnIconButton,
  RnNote,
  RnPageHeader,
  RnSearchField,
  RnSelect,
  RnTag,
  RnToastProvider,
  RnToken,
  cx,
  useRnToast,
  useRnTruncTip,
} from "@/components/renewal-ui";
import { formatAsOfDate } from "@/lib/as-of-date";
import { countryName } from "@/lib/geo-catalog/country-name";
import { aiEngineLabel } from "@/lib/scope/engines";
import type { SavedFiltersSource } from "../../../../_components/saved-filters";
import { RnFilterSplit } from "../../../../_components/filter-split";
import { LIST_TD as TD, RnFilterPanel, RnFilterRail, RnRadioAxis, RnSortHead } from "../../../../_components/prompt-list";
import { RnProjectMeasurement } from "../../../../projects/_components/project-measurement";
import { useAdminListPage } from "../../../_components/admin-list-page";
import { useAdminSavedFilters } from "../../../_components/admin-saved-filters";
import { LIST_TH_PLAIN } from "../../citation-sources/_components/source-lists-kit";
import { MeasurementAdd } from "./measurement-add";
import {
  ALL,
  DEFAULT_MEASUREMENT_FILTER,
  DEFAULT_MEASUREMENT_SORT,
  MEASUREMENT_AXES,
  MEASUREMENT_SORTS,
  measurementAxisOptions,
  measurementFilterToQuery,
  measurementFirstAsc,
  measurementMatches,
  ownedState,
  pickedMeasurementAxes,
  queryToMeasurementFilter,
  registeredUrls,
  rowName,
  sortMeasurements,
  unregisteredCount,
  type MeasurementAxis,
  type MeasurementFilter,
  type MeasurementListing,
  type MeasurementSort,
} from "./measurement-model";

type Sheet = { mode: "project"; id: string } | { mode: "add" };

export function MeasurementManager({ listing, savedFilters }: { listing: MeasurementListing; savedFilters: SavedFiltersSource }) {
  return (
    <RnToastProvider>
      <Manager listing={listing} savedFilters={savedFilters} />
    </RnToastProvider>
  );
}

function Manager({ listing, savedFilters }: { listing: MeasurementListing; savedFilters: SavedFiltersSource }) {
  const t = useTranslations("hubMeasurement");
  const tv = useTranslations("standardPromptsView");
  const tp = useTranslations("renewal.prompts");
  const tr = useTranslations("renewal.filters");
  const tm = useTranslations("renewal.projects.setting.measurement");
  const locale = useLocale();
  const router = useRouter();
  const toast = useRnToast();
  const sp = useSearchParams();
  const tip = useRnTruncTip();
  const brands = listing.options.brands;
  const fromUrl = useMemo(() => queryToMeasurementFilter(sp, brands), []); // eslint-disable-line react-hooks/exhaustive-deps

  const [filters, setFilters] = useState<MeasurementFilter>(fromUrl.filters);
  const [search, setSearch] = useState(fromUrl.search);
  const [sort, setSort] = useState(DEFAULT_MEASUREMENT_SORT);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [open, setOpen] = useState<Partial<Record<MeasurementAxis, boolean>>>({ surface: true, owned: true });
  const nf = useMemo(() => new Intl.NumberFormat(locale), [locale]);

  useEffect(() => {
    const query = measurementFilterToQuery(filters, search);
    window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
  }, [filters, search]);

  const brandLabel = (code: string) => (tm.has(`brandNames.${code}`) ? tm(`brandNames.${code}`) : code);
  const axisLabel = (a: MeasurementAxis) => t(`axis.${a}`);
  const valueLabel = (a: MeasurementAxis, v: string) => {
    if (v === ALL) return tv("filterAll");
    if (a === "surface") return t(`surface.${v as "1"}`);
    if (a === "owned") return t(`owned.${v as "registered"}`);
    return brandLabel(v);
  };
  const picked = pickedMeasurementAxes(filters);
  const savedList = useAdminSavedFilters({
    source: savedFilters,
    query: measurementFilterToQuery(filters, search),
    filtered: picked.length > 0 || Boolean(search),
    apply: (q) => {
      const next = queryToMeasurementFilter(q, brands);
      setFilters(next.filters);
      setSearch(next.search);
    },
    summarize: (q) => {
      const next = queryToMeasurementFilter(q, brands);
      return [...pickedMeasurementAxes(next.filters).map((a) => valueLabel(a, next.filters[a])), ...(next.search ? [`“${next.search}”`] : [])].join(" · ");
    },
  });
  const named = useMemo(
    () => listing.items.map((row) => ({ row, name: rowName(row, { global: t("surface.1"), brand: brandLabel, country: (c) => countryName(c, locale) }) })),
    [listing.items, locale], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const matched = useMemo(
    () => sortMeasurements(named.filter((n) => measurementMatches(n.row, n.name, filters, search)), sort.key, sort.asc, locale),
    [named, filters, search, sort, locale],
  );
  const paged = useAdminListPage(matched, [filters, search, sort]);
  const head = (key: MeasurementSort, className?: string) => (
    <RnSortHead sortKey={key} label={t(`column.${key}`)} sort={sort} className={className} onSort={(k) => setSort((s) => (s.key === k ? { key: k, asc: !s.asc } : { key: k, asc: measurementFirstAsc(k) }))} />
  );

  const panel = (
    <RnFilterPanel
      count={picked.length}
      onReset={() => {
        const before = filters;
        setFilters(DEFAULT_MEASUREMENT_FILTER);
        toast(tr("resetDone"), { undoLabel: tr("undo"), undo: () => setFilters(before) });
      }}
      saved={savedList.section}
    >
      {MEASUREMENT_AXES.map((a) => (
        <RnRadioAxis
          key={a}
          axis={a}
          label={axisLabel(a)}
          value={filters[a]}
          options={measurementAxisOptions(a, brands)}
          valueLabel={(v) => valueLabel(a, v)}
          allLabel={tv("filterAll")}
          open={open[a] ?? false}
          onToggle={() => setOpen((o) => ({ ...o, [a]: !(o[a] ?? false) }))}
          onPick={(v) => setFilters((f) => ({ ...f, [a]: v }))}
        />
      ))}
    </RnFilterPanel>
  );

  const sheetId = sheet?.mode === "project" ? sheet.id : null;
  const sheetRow = sheetId ? named.find((n) => n.row.projectId === sheetId) ?? null : null;
  const muted = <span className="text-rn-faint">—</span>;

  return (
    <div className="flex flex-col gap-4">
      <RnFilterSplit
        header={<RnPageHeader title={t("title")} meta={<span>{t("description")}</span>} />}
        panel={panel}
        rail={<RnFilterRail count={picked.length} />}
      >
        {savedList.note}
        {picked.length || search ? (
          <div aria-live="polite" className="flex min-h-7 flex-wrap items-center gap-2">
            {picked.map((a) => (
              <RnToken key={a} label={axisLabel(a)} value={valueLabel(a, filters[a])} removeLabel={tr("removeToken", { label: axisLabel(a) })} onRemove={() => setFilters((f) => ({ ...f, [a]: ALL }))} />
            ))}
            {search ? <RnToken label={t("searchLabel")} value={`“${search}”`} removeLabel={tr("removeToken", { label: t("searchLabel") })} onRemove={() => setSearch("")} /> : null}
          </div>
        ) : null}
        <RnCard aria-label={t("listLabel")}>
          <div className="flex flex-wrap items-center gap-2 border-b border-rn-line px-5 py-3">
            <RnSearchField id="rn-hub-measurement-search" className="w-full max-w-[280px] min-w-[180px] flex-1" value={search} onChange={setSearch} placeholder={t("searchPlaceholder")} label={t("searchLabel")} />
            <RnSelect
              label={tp("sortLabel")}
              value={sort.key}
              onChange={(e) => {
                const key = e.target.value as MeasurementSort;
                setSort({ key, asc: measurementFirstAsc(key) });
              }}
              options={MEASUREMENT_SORTS.map((k) => ({ value: k, label: t(`column.${k}`) }))}
            />
            <RnIconButton label={sort.asc ? tp("sortAsc") : tp("sortDesc")} onClick={() => setSort((s) => ({ key: s.key, asc: !s.asc }))}>
              {sort.asc ? <ArrowUpNarrowWide className="size-4" aria-hidden /> : <ArrowDownWideNarrow className="size-4" aria-hidden />}
            </RnIconButton>
            <span className="ml-auto text-rn-12 text-rn-muted tabular-nums" data-hub-measurement-count="">
              {t("count", { shown: nf.format(matched.length), total: nf.format(listing.items.length), unregistered: nf.format(unregisteredCount(listing.items)) })}
            </span>
            <RnButton size="sm" onClick={() => setSheet({ mode: "add" })} disabled={!listing.editing} data-hub-measurement-new="">
              <Plus className="size-3.5" aria-hidden />
              {t("add")}
            </RnButton>
          </div>
          {matched.length === 0 ? (
            <RnEmpty className="m-5">{listing.items.length ? t("emptyFiltered") : t("empty")}</RnEmpty>
          ) : (
            <div {...tip.bind}>
              <table className="w-full table-fixed border-separate border-spacing-0 text-rn-13" data-hub-measurement-table="">
                <colgroup>
                  <col className="w-[92px]" />
                  <col />
                  <col className="w-[120px]" />
                  <col className="w-[132px]" />
                  <col className="w-[136px]" />
                  <col className="w-[84px]" />
                  <col className="w-[92px]" />
                  <col className="w-[84px]" />
                  <col className="w-[104px]" />
                  <col className="w-[76px]" />
                </colgroup>
                <thead>
                  <tr className="text-left text-rn-12 text-rn-muted">
                    {head("surface", "pl-5")}
                    {head("name")}
                    <th className={LIST_TH_PLAIN}>{t("column.brands")}</th>
                    <th className={LIST_TH_PLAIN}>{t("column.countries")}</th>
                    <th className={LIST_TH_PLAIN}>{t("column.engines")}</th>
                    <th className={LIST_TH_PLAIN}>{t("column.cadence")}</th>
                    {head("ownedUrls", "text-right")}
                    <th className={cx(LIST_TH_PLAIN, "text-right")}>{t("column.trackedUrls")}</th>
                    {head("recordedAt")}
                    <th className={cx(LIST_TH_PLAIN, "pr-5 text-right")}>{t("column.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {paged.rows.map(({ row, name }) => {
                    const m = row.measurement;
                    const countries = m.countries.map((c) => countryName(c, locale));
                    return (
                      <tr key={row.projectId} data-hub-measurement-row={row.projectId} className="hover:bg-rn-navy-25/60">
                        <td className={cx(TD, "pl-5 text-rn-12 text-rn-ink-2")}>{t(`surface.${String(row.surface) as "1"}`)}</td>
                        <td className={TD}>
                          <span data-rn-tip="" className="block min-w-0 truncate font-semibold text-rn-ink">
                            {name}
                          </span>
                        </td>
                        <td className={cx(TD, "text-rn-12 text-rn-ink-2")}>
                          <span data-rn-tip="" className="block truncate">
                            {m.brands.length ? m.brands.map(brandLabel).join(", ") : muted}
                          </span>
                        </td>
                        <td className={cx(TD, "text-rn-12 text-rn-ink-2")}>
                          <span data-rn-tip="" className="block truncate">
                            {countries.length === 0 ? muted : countries.length === 1 ? countries[0] : t("countryMore", { first: countries[0], more: nf.format(countries.length - 1) })}
                          </span>
                        </td>
                        <td className={cx(TD, "text-rn-12 text-rn-ink-2")}>
                          <span data-rn-tip="" className="block truncate">
                            {m.engines.length ? m.engines.map(aiEngineLabel).join(", ") : muted}
                          </span>
                        </td>
                        <td className={cx(TD, "text-rn-12 text-rn-ink-2")}>{m.cadence ? tm(`cadences.${m.cadence}`) : muted}</td>
                        <td className={cx(TD, "text-right text-rn-12 tabular-nums")} data-hub-measurement-owned={ownedState(row)}>
                          {ownedState(row) === "none" ? muted : ownedState(row) === "registered" ? <span className="text-rn-ink-2">{nf.format(registeredUrls(row).length)}</span> : <RnTag>{t("owned.unregistered")}</RnTag>}
                        </td>
                        <td className={cx(TD, "text-right text-rn-12 text-rn-ink-2 tabular-nums")}>{m.trackedUrls.length ? nf.format(m.trackedUrls.length) : muted}</td>
                        <td className={cx(TD, "text-rn-12 text-rn-ink-2 tabular-nums")}>{m.recordedAt ? formatAsOfDate(m.recordedAt) : muted}</td>
                        <td className={cx(TD, "pr-5 text-right")}>
                          <RnButton size="sm" onClick={() => setSheet({ mode: "project", id: row.projectId })} data-hub-measurement-open={row.projectId}>
                            {t("open")}
                          </RnButton>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {paged.pager}
              {tip.tip}
            </div>
          )}
          <p className="m-0 border-t border-rn-line px-5 py-2.5 text-rn-11 text-rn-muted">{t("hint")}</p>
        </RnCard>
      </RnFilterSplit>
      <RnDrawer open={sheet != null} onClose={() => setSheet(null)} title={sheet?.mode === "add" ? t("add") : sheetRow?.name ?? t("title")} closeLabel={tp("close")} wide>
        {sheet?.mode === "add" ? (
          <MeasurementAdd
            options={listing.options}
            disabled={!listing.editing}
            onAdded={(id) => {
              toast(t("added"));
              setSheet({ mode: "project", id });
              router.refresh();
            }}
          />
        ) : sheetRow ? (
          <RnProjectMeasurement key={sheetRow.row.projectId} projectId={sheetRow.row.projectId} view={{ item: sheetRow.row.measurement, options: listing.options, editing: listing.editing }} />
        ) : sheet ? (
          <RnNote>{t("loading")}</RnNote>
        ) : null}
      </RnDrawer>
    </div>
  );
}
