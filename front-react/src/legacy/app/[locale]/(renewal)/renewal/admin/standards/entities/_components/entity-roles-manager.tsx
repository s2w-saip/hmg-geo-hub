import { useServedState } from "@/hooks/use-served-state";
import { replaceUiHistory } from "~/app/navigation";
"use client";

// Admin › 엔티티 카탈로그 (2026-11-02): the HUB owns who is own and who is excluded (admin-todo decisions A · F); competitor is
// the default. The list is Gold's entities with their display brand and all-time numbers, each with its role
// (back/bff/hub_stores/entity_roles.py). A row opens its sheet: role, Gold's evidence, history. A role saves at once; the original's draft, preview
// and approval are not here, because applying and previewing would be the HUB rewriting or recomputing Gold.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocale, useTranslations } from "use-intl";
import { useSearchParams } from "~/app/navigation";
import type { SavedFiltersSource } from "../../../../_components/saved-filters";
import { useAdminListPage } from "../../../_components/admin-list-page";
import { useAdminSavedFilters } from "../../../_components/admin-saved-filters";
import { ArrowDownWideNarrow, ArrowUpNarrowWide, History } from "lucide-react";
import {
  RnButton,
  RnCard,
  RnDrawer,
  RnEmpty,
  RnIconButton,
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
import { RnFilterSplit } from "../../../../_components/filter-split";
import { LIST_TD as TD, RnFilterPanel, RnFilterRail, RnRadioAxis, RnSortHead } from "../../../../_components/prompt-list";
import { HistorySection, LIST_TH_PLAIN, ListPills } from "../../citation-sources/_components/source-lists-kit";
import { entityRoleApi, type EntityListing, type EntityRow } from "./entity-roles-api";
import { EntitySheet, useEntityError, useRoleLabel } from "./entity-role-sheet";
import {
  ALL,
  DEFAULT_ENTITY_FILTER,
  DEFAULT_ENTITY_SORT,
  ENTITY_AXES,
  ENTITY_SORTS,
  entityAxisOptions,
  entityCounts,
  entityFilterToQuery,
  entityFirstAsc,
  entityMatches,
  pickedEntityAxes,
  queryToEntityFilter,
  sortEntities,
  type EntityAxis,
  type EntityFilter,
  type EntitySort,
} from "./entity-roles-model";

type Sheet = { mode: "entity"; key: string } | { mode: "recent" };

export function EntityRolesManager({ initial, savedFilters }: { initial: EntityListing; savedFilters: SavedFiltersSource }) {
  return (
    <RnToastProvider>
      <Manager initial={initial} savedFilters={savedFilters} />
    </RnToastProvider>
  );
}

function Manager({ initial, savedFilters }: { initial: EntityListing; savedFilters: SavedFiltersSource }) {
  const t = useTranslations("hubEntities");
  const tv = useTranslations("standardPromptsView");
  const tp = useTranslations("renewal.prompts");
  const tr = useTranslations("renewal.filters");
  const locale = useLocale();
  const toast = useRnToast();
  const sp = useSearchParams();
  const tip = useRnTruncTip();
  const errorText = useEntityError();
  const roleLabel = useRoleLabel();
  const fromUrl = useMemo(() => queryToEntityFilter(sp), []); // eslint-disable-line react-hooks/exhaustive-deps

  const [listing, setListing] = useServedState(initial);
  const [filters, setFilters] = useState<EntityFilter>(fromUrl.filters);
  const [search, setSearch] = useState(fromUrl.search);
  const [sort, setSort] = useState(DEFAULT_ENTITY_SORT);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [open, setOpen] = useState<Partial<Record<EntityAxis, boolean>>>({ role: true });
  const nf = useMemo(() => new Intl.NumberFormat(locale), [locale]);

  const reload = () => entityRoleApi.list().then(setListing, (e) => toast(errorText(e)));

  // URL mirrors the picks (shareable, restorable); shallow — no server round trip.
  useEffect(() => {
    const query = entityFilterToQuery(filters, search);
    replaceUiHistory(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
  }, [filters, search]);

  const axisLabel = (a: EntityAxis) => t(`axis.${a}`);
  const valueLabel = (a: EntityAxis, v: string) => {
    if (v === ALL) return tv("filterAll");
    if (a === "role") return t(`role.${v as "own"}`);
    if (a === "kind") return t(`kind.${v as "own"}`);
    return v;
  };
  const picked = pickedEntityAxes(filters);
  const savedList = useAdminSavedFilters({
    source: savedFilters,
    query: entityFilterToQuery(filters, search),
    filtered: picked.length > 0 || Boolean(search),
    apply: (q) => {
      const next = queryToEntityFilter(q);
      setFilters(next.filters);
      setSearch(next.search);
    },
    summarize: (q) => {
      const next = queryToEntityFilter(q);
      return [...pickedEntityAxes(next.filters).map((a) => valueLabel(a, next.filters[a])), ...(next.search ? [`“${next.search}”`] : [])].join(" · ");
    },
  });
  const matched = useMemo(() => sortEntities(listing.items.filter((r) => entityMatches(r, filters, search)), sort.key, sort.asc, locale), [listing.items, filters, search, sort, locale]);
  const paged = useAdminListPage(matched, [filters, search, sort]);
  const total = entityCounts(listing.items);
  const names = useMemo(() => new Map(listing.items.map((r) => [r.entityId, r.name] as const)), [listing.items]);
  const head = (key: EntitySort, className?: string) => (
    <RnSortHead sortKey={key} label={t(`column.${key}`)} sort={sort} className={className} onSort={(k) => setSort((s) => (s.key === k ? { key: k, asc: !s.asc } : { key: k, asc: entityFirstAsc(k) }))} />
  );

  const panel = (
    <RnFilterPanel
      count={picked.length}
      onReset={() => {
        const before = filters;
        setFilters(DEFAULT_ENTITY_FILTER);
        toast(tr("resetDone"), { undoLabel: tr("undo"), undo: () => setFilters(before) });
      }}
      saved={savedList.section}
    >
      {ENTITY_AXES.map((a) => (
        <RnRadioAxis
          key={a}
          axis={a}
          label={axisLabel(a)}
          value={filters[a]}
          options={entityAxisOptions(a)}
          valueLabel={(v) => valueLabel(a, v)}
          allLabel={tv("filterAll")}
          open={open[a] ?? false}
          onToggle={() => setOpen((o) => ({ ...o, [a]: !(o[a] ?? false) }))}
          onPick={(v) => setFilters((f) => ({ ...f, [a]: v }))}
        />
      ))}
    </RnFilterPanel>
  );

  const sheetRow = sheet?.mode === "entity" ? listing.items.find((r) => r.entityId === sheet.key) ?? null : null;
  const historyValue = (field: string, v: unknown): string | null => {
    if (v == null) return null;
    if (field === "role") return t(`role.${v as "own"}`);
    if (field === "status") return t(`status.${v as "active"}`);
    return String(v);
  };

  return (
    <div className="flex flex-col gap-4">
      <RnFilterSplit
        header={
          <RnPageHeader
            title={t("title")}
            meta={
              <>
                <ListPills family="entity_role" published={listing.published} />
                <span>{t("description")}</span>
              </>
            }
          />
        }
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
            <RnSearchField id="rn-hub-entity-search" className="w-full max-w-[280px] min-w-[180px] flex-1" value={search} onChange={setSearch} placeholder={t("searchPlaceholder")} label={t("searchLabel")} />
            <RnSelect
              label={tp("sortLabel")}
              value={sort.key}
              onChange={(e) => {
                const key = e.target.value as EntitySort;
                setSort({ key, asc: entityFirstAsc(key) });
              }}
              options={ENTITY_SORTS.map((k) => ({ value: k, label: t(`column.${k}`) }))}
            />
            <RnIconButton label={sort.asc ? tp("sortAsc") : tp("sortDesc")} onClick={() => setSort((s) => ({ key: s.key, asc: !s.asc }))}>
              {sort.asc ? <ArrowUpNarrowWide className="size-4" aria-hidden /> : <ArrowDownWideNarrow className="size-4" aria-hidden />}
            </RnIconButton>
            <RnButton size="sm" onClick={() => setSheet({ mode: "recent" })} data-hub-entity-recent="">
              <History className="size-3.5" aria-hidden />
              {t("recent")}
            </RnButton>
            <span className="ml-auto text-rn-12 text-rn-muted tabular-nums" data-hub-entity-count="">
              {t("count", { shown: nf.format(matched.length), total: nf.format(total.total), own: nf.format(total.own), excluded: nf.format(total.excluded) })}
            </span>
          </div>
          {matched.length === 0 ? (
            <RnEmpty className="m-5">{listing.items.length ? t("emptyFiltered") : t("empty")}</RnEmpty>
          ) : (
            <div {...tip.bind}>
              <table className="w-full table-fixed border-separate border-spacing-0 text-rn-13" data-hub-entity-table="">
                <colgroup>
                  <col />
                  <col className="w-[156px]" />
                  <col className="w-[92px]" />
                  <col className="w-[92px]" />
                  <col className="w-[92px]" />
                  <col className="w-[108px]" />
                  <col className="w-[136px]" />
                  <col className="w-[88px]" />
                </colgroup>
                <thead>
                  <tr className="text-left text-rn-12 text-rn-muted">
                    {head("name", "pl-5")}
                    <th className={LIST_TH_PLAIN}>{t("column.displayBrand")}</th>
                    <th className={LIST_TH_PLAIN}>{t("column.kind")}</th>
                    {head("answers", "text-right")}
                    {head("mentions", "text-right")}
                    {head("firstSeen")}
                    <th className={LIST_TH_PLAIN}>{t("column.role")}</th>
                    <th className={cx(LIST_TH_PLAIN, "pr-5 text-right")}>{t("column.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {paged.rows.map((row) => (
                    <tr key={row.entityId} data-hub-entity-row={row.entityId} className="hover:bg-rn-navy-25/60">
                      <td className={cx(TD, "pl-5")}>
                        <span data-rn-tip="" className="block min-w-0 truncate font-semibold text-rn-ink">
                          {row.name}
                        </span>
                      </td>
                      <td className={cx(TD, "text-rn-12 text-rn-ink-2")}>
                        <span data-rn-tip="" className="block truncate">
                          {row.displayBrand ?? <span className="text-rn-faint">—</span>}
                        </span>
                      </td>
                      <td className={cx(TD, "text-rn-12 text-rn-ink-2")}>{row.kind ? t(`kind.${row.kind}`) : <span className="text-rn-faint">—</span>}</td>
                      <td className={cx(TD, "text-right text-rn-12 text-rn-ink-2 tabular-nums")}>{nf.format(row.answers)}</td>
                      <td className={cx(TD, "text-right text-rn-12 text-rn-ink-2 tabular-nums")}>{nf.format(row.mentions)}</td>
                      <td className={cx(TD, "text-rn-12 text-rn-ink-2 tabular-nums")}>{row.firstSeen ? formatAsOfDate(row.firstSeen) : "—"}</td>
                      <td className={TD} data-hub-entity-role={row.role}>
                        {row.role === "competitor" ? <span className="text-rn-12 text-rn-muted">{t("role.competitor")}</span> : <RnTag>{roleLabel(row.role, row.brand)}</RnTag>}
                      </td>
                      <td className={cx(TD, "pr-5 text-right")}>
                        <RnButton size="sm" onClick={() => setSheet({ mode: "entity", key: row.entityId })} data-hub-entity-open={row.entityId}>
                          {t("open")}
                        </RnButton>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {paged.pager}
              {tip.tip}
            </div>
          )}
          <p className="m-0 border-t border-rn-line px-5 py-2.5 text-rn-11 text-rn-muted">{t("hint")}</p>
        </RnCard>
      </RnFilterSplit>
      <RnDrawer open={sheet != null} onClose={() => setSheet(null)} title={sheet?.mode === "recent" ? t("recent") : t("detailTitle")} closeLabel={tp("close")}>
        {sheet?.mode === "entity" && sheetRow ? (
          <EntitySheet
            key={sheetRow.entityId}
            row={sheetRow}
            onSaved={async () => {
              toast(t("saved", { name: sheetRow.name }));
              await reload();
            }}
          />
        ) : sheet?.mode === "recent" ? (
          <RecentChanges names={names} value={historyValue} version={listing.published?.changeSeq ?? 0} />
        ) : null}
      </RnDrawer>
    </div>
  );
}

function RecentChanges({ names, value, version }: { names: ReadonlyMap<string, string>; value: (field: string, v: unknown) => string | null; version: number }): ReactNode {
  const t = useTranslations("hubEntities");
  const errorText = useEntityError();
  return (
    <div data-hub-entity-recent-list="">
      <HistorySection
        load={() => entityRoleApi.history()}
        version={String(version)}
        eventLabel={(a) => t(`event.${a as "set"}`)}
        eventTitle={(e) => `${names.get(e.key ?? "") ?? e.key} · ${t(`event.${e.action as "set"}`)}`}
        fieldLabel={(f) => t(`field.${f as "role"}`)}
        value={value}
        errorText={errorText}
      />
    </div>
  );
}
