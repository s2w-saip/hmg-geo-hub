"use client";

// Admin › 인용 출처 분류 › 시드 (2026-10-30): the HUB owns the seed list (admin-todo decision G): a domain's base
// category that people set, below a correction, an official social account and an owned domain. Add, change, remove
// and restore save at once; each row shows Gold's own value for the source and whether Gold applies the HUB's seed
// yet (back/bff/hub_stores/source_lists.py). Gold seeds the HUB lacks are listed as upstream rows to take over. A
// removal keeps the row and its history. Same layout as the 교정 tab.

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { ArrowDownWideNarrow, ArrowUpNarrowWide, History, Loader2, Plus, RotateCcw, Undo2 } from "lucide-react";
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
  RnToastProvider,
  RnToken,
  cx,
  useRnToast,
  useRnTruncTip,
} from "@/components/renewal-ui";
import { RnFilterSplit } from "../../../../_components/filter-split";
import { LIST_TD as TD, RnDetailField, RnFilterPanel, RnFilterRail, RnRadioAxis, RnSortHead } from "../../../../_components/prompt-list";
import { INPUT } from "../../prompts/_components/hub-prompt-form";
import { seedApi, type SeedListing, type SeedRow } from "./source-lists-api";
import { HistorySection, LIST_TH_PLAIN, ListPills, StateMark, useCategoryLabel, useListError } from "./source-lists-kit";
import {
  ALL,
  DEFAULT_SEED_FILTER,
  DEFAULT_SEED_SORT,
  SEED_AXES,
  SEED_SORTS,
  pickedSeedAxes,
  queryToSeedFilter,
  seedAxisOptions,
  seedCitations,
  seedCounts,
  seedFilterToQuery,
  seedFirstAsc,
  seedKeyOf,
  seedMatches,
  sortSeeds,
  type SeedAxis,
  type SeedFilter,
  type SeedSort,
} from "./source-lists-model";

export function SourceSeedsManager({ initial, tabs }: { initial: SeedListing; tabs?: ReactNode }) {
  return (
    <RnToastProvider>
      <Manager initial={initial} tabs={tabs} />
    </RnToastProvider>
  );
}

function Manager({ initial, tabs }: { initial: SeedListing; tabs?: ReactNode }) {
  const t = useTranslations("hubSourceLists");
  const ts = useTranslations("hubSourceLists.seeds");
  const to = useTranslations("hubSourceOverrides");
  const tv = useTranslations("standardPromptsView");
  const tp = useTranslations("renewal.prompts");
  const tr = useTranslations("renewal.filters");
  const locale = useLocale();
  const toast = useRnToast();
  const sp = useSearchParams();
  const tip = useRnTruncTip();
  const errorText = useListError();
  const fromUrl = useMemo(() => queryToSeedFilter(sp), []); // eslint-disable-line react-hooks/exhaustive-deps

  const [listing, setListing] = useState(initial);
  const [filters, setFilters] = useState<SeedFilter>(fromUrl.filters);
  const [search, setSearch] = useState(fromUrl.search);
  const [sort, setSort] = useState(DEFAULT_SEED_SORT);
  const [saving, setSaving] = useState<string | null>(null);
  const [sheet, setSheet] = useState<string | null>(null);
  const [open, setOpen] = useState<Partial<Record<SeedAxis, boolean>>>({ state: true, status: true });
  const label = useCategoryLabel(listing.categories);
  const nf = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const categoryOrder = useMemo(() => new Map(listing.categories.map((c, i) => [c.slug, i] as const)), [listing.categories]);
  const categories = listing.categories.map((c) => ({ value: c.slug, label: label(c.slug) }));

  const reload = () => seedApi.list().then(setListing, (e) => toast(errorText(e)));

  // URL mirrors the picks (shareable, restorable); shallow — no server round trip.
  useEffect(() => {
    window.history.replaceState(null, "", `${window.location.pathname}?${seedFilterToQuery(filters, search)}`);
  }, [filters, search]);

  const axisLabel = (a: SeedAxis) => ts(`axis.${a}`);
  const valueLabel = (a: SeedAxis, v: string) =>
    v === ALL ? tv("filterAll") : a === "category" ? label(v) : a === "state" ? ts(`state.${v as "applied"}`) : ts(`status.${v as "active"}`);
  const picked = pickedSeedAxes(filters);
  const shown = useMemo(
    () => sortSeeds(listing.items.filter((r) => seedMatches(r, filters, search)), sort.key, sort.asc, categoryOrder),
    [listing.items, filters, search, sort, categoryOrder],
  );
  const total = seedCounts(listing.items);
  const head = (key: SeedSort, className?: string) => (
    <RnSortHead sortKey={key} label={ts(`column.${key === "domain" ? "domain" : key}`)} sort={sort} className={className} onSort={(k) => setSort((s) => (s.key === k ? { key: k, asc: !s.asc } : { key: k, asc: seedFirstAsc(k) }))} />
  );

  const write = async (skey: string, run: () => Promise<unknown>, done: string) => {
    setSaving(skey);
    try {
      await run();
      toast(done);
      await reload();
    } catch (e) {
      toast(errorText(e));
    } finally {
      setSaving(null);
    }
  };
  const setCategory = (row: SeedRow, category: string) => {
    if (row.status === "active" && row.category === category) return;
    return write(row.skey, () => seedApi.set(row.skey, category), ts("toast.saved", { domain: row.skey }));
  };
  const remove = (row: SeedRow) => write(row.skey, () => seedApi.remove(row.skey), ts("toast.removed", { domain: row.skey }));

  const panel = (
    <RnFilterPanel
      count={picked.length}
      onReset={() => {
        const before = filters;
        setFilters(DEFAULT_SEED_FILTER);
        toast(tr("resetDone"), { undoLabel: tr("undo"), undo: () => setFilters(before) });
      }}
      saved={null}
    >
      {SEED_AXES.map((a) => (
        <RnRadioAxis
          key={a}
          axis={a}
          label={axisLabel(a)}
          value={filters[a]}
          options={seedAxisOptions(a, listing.categories.map((c) => c.slug))}
          valueLabel={(v) => valueLabel(a, v)}
          allLabel={tv("filterAll")}
          open={open[a] ?? false}
          onToggle={() => setOpen((o) => ({ ...o, [a]: !(o[a] ?? false) }))}
          onPick={(v) => setFilters((f) => ({ ...f, [a]: v }))}
        />
      ))}
    </RnFilterPanel>
  );

  const sheetRow = sheet ? listing.items.find((r) => r.skey === sheet) ?? null : null;

  return (
    <div className="flex flex-col gap-4">
      <RnFilterSplit
        header={
          <RnPageHeader
            title={to("title")}
            meta={
              <>
                <ListPills family="source_seed" published={listing.published} asOf={listing.asOf} />
                <span>{ts("description")}</span>
              </>
            }
            actions={tabs}
          />
        }
        panel={panel}
        rail={<RnFilterRail count={picked.length} />}
      >
        <RnNote>
          <b className="text-rn-ink">{t("flowNoteTitle")}</b>
          <span>{ts("flowNote")}</span>
        </RnNote>
        <AddSeed
          categories={categories}
          exists={(k) => listing.items.some((r) => r.skey === k && r.status != null)}
          onAdd={(skey, category) => write(skey, () => seedApi.set(skey, category), ts("toast.saved", { domain: skey }))}
          busy={saving != null}
        />
        {picked.length || search ? (
          <div aria-live="polite" className="flex min-h-7 flex-wrap items-center gap-2">
            {picked.map((a) => (
              <RnToken key={a} label={axisLabel(a)} value={valueLabel(a, filters[a])} removeLabel={tr("removeToken", { label: axisLabel(a) })} onRemove={() => setFilters((f) => ({ ...f, [a]: ALL }))} />
            ))}
            {search ? <RnToken label={t("searchLabel")} value={`“${search}”`} removeLabel={tr("removeToken", { label: t("searchLabel") })} onRemove={() => setSearch("")} /> : null}
          </div>
        ) : null}
        <RnCard aria-label={ts("listLabel")}>
          <div className="flex flex-wrap items-center gap-2 border-b border-rn-line px-5 py-3">
            <RnSearchField id="rn-hub-seed-search" className="w-full max-w-[280px] min-w-[180px] flex-1" value={search} onChange={setSearch} placeholder={ts("searchPlaceholder")} label={t("searchLabel")} />
            <RnSelect
              label={tp("sortLabel")}
              value={sort.key}
              onChange={(e) => {
                const key = e.target.value as SeedSort;
                setSort({ key, asc: seedFirstAsc(key) });
              }}
              options={SEED_SORTS.map((k) => ({ value: k, label: ts(`column.${k}`) }))}
            />
            <RnIconButton label={sort.asc ? tp("sortAsc") : tp("sortDesc")} onClick={() => setSort((s) => ({ key: s.key, asc: !s.asc }))}>
              {sort.asc ? <ArrowUpNarrowWide className="size-4" aria-hidden /> : <ArrowDownWideNarrow className="size-4" aria-hidden />}
            </RnIconButton>
            <span className="ml-auto text-rn-12 text-rn-muted tabular-nums" data-hub-seed-count="">
              {ts("count", {
                shown: nf.format(shown.length),
                total: nf.format(total.total),
                active: nf.format(total.active),
                removed: nf.format(total.removed),
                pending: nf.format(total.pending),
                upstream: nf.format(total.upstream),
              })}
            </span>
          </div>
          {shown.length === 0 ? (
            <RnEmpty className="m-5">{listing.items.length ? ts("emptyFiltered") : ts("empty")}</RnEmpty>
          ) : (
            <div {...tip.bind}>
              <table className="w-full table-fixed border-separate border-spacing-0 text-rn-13" data-hub-seed-table="">
                <colgroup>
                  <col />
                  <col className="w-[96px]" />
                  <col className="w-[196px]" />
                  <col className="w-[200px]" />
                  <col className="w-[132px]" />
                  <col className="w-[88px]" />
                  <col className="w-[132px]" />
                </colgroup>
                <thead>
                  <tr className="text-left text-rn-12 text-rn-muted">
                    {head("domain", "pl-5")}
                    {head("citations", "text-right")}
                    {head("category")}
                    <th className={LIST_TH_PLAIN}>{ts("column.gold")}</th>
                    {head("state")}
                    <th className={LIST_TH_PLAIN}>{ts("column.status")}</th>
                    <th className={cx(LIST_TH_PLAIN, "pr-5 text-right")}>{ts("column.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((row) => {
                    const busy = saving != null;
                    const hub = row.status != null;
                    const goldCategory = row.gold?.category ?? null;
                    return (
                      <tr key={row.skey} data-hub-seed-row={row.skey} className={cx("hover:bg-rn-navy-25/60", row.status === "removed" && "text-rn-muted")}>
                        <td className={cx(TD, "pl-5")}>
                          <span data-rn-tip="" className={cx("block min-w-0 truncate font-semibold", row.status === "removed" ? "text-rn-muted line-through" : "text-rn-ink")}>
                            {row.skey}
                          </span>
                        </td>
                        <td className={cx(TD, "text-right text-rn-12 text-rn-ink-2 tabular-nums")}>{nf.format(seedCitations(row))}</td>
                        <td className={TD}>
                          {hub ? (
                            <span className="flex items-center gap-1.5">
                              <RnSelect
                                label={ts("categoryOf", { domain: row.skey })}
                                className="min-w-0 flex-1 [&_select]:w-full"
                                value={row.category ?? ""}
                                disabled={busy || row.status === "removed"}
                                onChange={(e) => void setCategory(row, e.target.value)}
                                options={categories.some((c) => c.value === row.category) ? categories : [{ value: row.category ?? "", label: label(row.category) }, ...categories]}
                                data-hub-seed-category={row.skey}
                              />
                              {saving === row.skey ? <Loader2 className="size-3.5 shrink-0 animate-spin text-rn-muted" aria-hidden /> : null}
                            </span>
                          ) : (
                            <span className="text-rn-12 text-rn-faint">—</span>
                          )}
                        </td>
                        <td className={cx(TD, "text-rn-12 text-rn-ink-2")}>
                          <span data-rn-tip="" className="block truncate" data-hub-seed-gold={row.gold?.source ?? ""}>
                            {row.gold ? `${label(goldCategory)} · ${row.gold.source ? to(`source.${row.gold.source}`) : "—"}` : ts("goldNone")}
                          </span>
                        </td>
                        <td className={TD}>
                          <SeedState row={row} />
                        </td>
                        <td className={cx(TD, "text-rn-12")}>{row.status ? ts(`status.${row.status}`) : <span className="text-rn-faint">—</span>}</td>
                        <td className={cx(TD, "pr-5")}>
                          <span className="flex items-center justify-end gap-1">
                            {!hub && goldCategory ? (
                              <RnButton size="sm" disabled={busy} onClick={() => void setCategory(row, goldCategory)} data-hub-seed-adopt={row.skey}>
                                <Plus className="size-3.5" aria-hidden />
                                {ts("addAsSeed")}
                              </RnButton>
                            ) : null}
                            {row.status === "active" ? (
                              <RnButton size="sm" disabled={busy} onClick={() => void remove(row)} data-hub-seed-remove={row.skey}>
                                <Undo2 className="size-3.5" aria-hidden />
                                {ts("remove")}
                              </RnButton>
                            ) : null}
                            {row.status === "removed" && row.category ? (
                              <RnButton size="sm" disabled={busy} onClick={() => void setCategory(row, row.category ?? "")} data-hub-seed-restore={row.skey}>
                                <RotateCcw className="size-3.5" aria-hidden />
                                {ts("restore")}
                              </RnButton>
                            ) : null}
                            {hub ? (
                              <RnIconButton label={t("historyOpen", { name: row.skey })} onClick={() => setSheet(row.skey)} data-hub-seed-history={row.skey}>
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
          <p className="m-0 border-t border-rn-line px-5 py-2.5 text-rn-11 text-rn-muted">{ts("hint", { date: listing.asOf ?? "—" })}</p>
        </RnCard>
      </RnFilterSplit>
      <RnDrawer open={sheetRow != null} onClose={() => setSheet(null)} title={ts("detailTitle")} closeLabel={tp("close")}>
        {sheetRow ? <SeedDetail key={sheetRow.skey} row={sheetRow} label={label} /> : null}
      </RnDrawer>
    </div>
  );
}

/** 반영됨 / 반영 대기 (제외 대기) / 상위 분류 우선 / 업스트림 시드 / — (Gold has no such source). */
export function SeedState({ row }: { row: SeedRow }) {
  const ts = useTranslations("hubSourceLists.seeds");
  const removing = row.state === "pending" && row.status === "removed";
  const key = removing ? "pendingRemove" : row.state;
  return <StateMark state={row.state} attr="data-hub-seed-state" label={key ? ts(`state.${key}`) : "—"} tip={ts(`stateTip.${key ?? "none"}`)} />;
}

function AddSeed({
  categories,
  exists,
  onAdd,
  busy,
}: {
  categories: { value: string; label: string }[];
  exists: (key: string) => boolean;
  onAdd: (skey: string, category: string) => Promise<void> | void;
  busy: boolean;
}) {
  const ts = useTranslations("hubSourceLists.seeds");
  const [domain, setDomain] = useState("");
  const [category, setCategory] = useState(categories[0]?.value ?? "");
  const [problem, setProblem] = useState<"invalid" | "exists" | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const key = seedKeyOf(domain);
    if (!key) return setProblem("invalid");
    if (exists(key)) return setProblem("exists");
    setProblem(null);
    await onAdd(key, category);
    setDomain("");
  }

  return (
    <RnCard aria-label={ts("add.title")}>
      <form onSubmit={submit} className="flex flex-wrap items-center gap-2 px-5 py-3" data-hub-seed-add="" noValidate>
        <b className="mr-2 text-rn-13 text-rn-ink">{ts("add.title")}</b>
        <input
          className={cx(INPUT, "w-[260px] font-mono")}
          value={domain}
          onChange={(e) => {
            setDomain(e.target.value);
            setProblem(null);
          }}
          placeholder={ts("add.domainPlaceholder")}
          aria-label={ts("add.domain")}
          aria-invalid={problem != null || undefined}
          autoComplete="off"
          spellCheck={false}
          maxLength={320}
          data-hub-seed-add-domain=""
        />
        <RnSelect label={ts("add.category")} value={category} onChange={(e) => setCategory(e.target.value)} options={categories} data-hub-seed-add-category="" />
        <RnButton type="submit" size="sm" variant="primary" disabled={busy || !domain.trim()}>
          <Plus className="size-3.5" aria-hidden />
          {ts("add.submit")}
        </RnButton>
        {problem ? (
          <span role="alert" className="text-rn-12 text-rn-danger-ink" data-hub-seed-add-problem={problem}>
            {ts(`add.${problem}`)}
          </span>
        ) : null}
      </form>
    </RnCard>
  );
}

function SeedDetail({ row, label }: { row: SeedRow; label: (slug: string | null | undefined) => string }) {
  const t = useTranslations("hubSourceLists");
  const ts = useTranslations("hubSourceLists.seeds");
  const to = useTranslations("hubSourceOverrides");
  const locale = useLocale();
  const value = (field: string, v: unknown): string | null => {
    if (v == null) return null;
    if (field === "category") return label(String(v));
    if (field === "status") return ts(`status.${v as "active"}`);
    return String(v);
  };
  return (
    <div className="flex flex-col gap-6" data-hub-seed-detail={row.skey}>
      <section className="flex flex-col gap-3">
        <b className="min-w-0 truncate text-rn-16 text-rn-ink">{row.skey}</b>
        <dl className="m-0 grid grid-cols-[112px_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-rn-13">
          <RnDetailField label={ts("field.citations")}>
            <span className="tabular-nums">{new Intl.NumberFormat(locale).format(seedCitations(row))}</span>
          </RnDetailField>
          <RnDetailField label={ts("field.hub")}>{row.status ? `${label(row.category)} · ${ts(`status.${row.status}`)}` : ts("noSeed")}</RnDetailField>
          <RnDetailField label={ts("field.origin")}>{row.origin ? t(`origin.${row.origin}`) : null}</RnDetailField>
          <RnDetailField label={ts("field.gold")}>
            {row.gold ? `${label(row.gold.category)} · ${row.gold.source ? to(`source.${row.gold.source}`) : "—"}` : ts("goldNone")}
          </RnDetailField>
          <RnDetailField label={ts("field.state")}>
            <SeedState row={row} />
          </RnDetailField>
          <RnDetailField label={ts("field.note")}>{row.note}</RnDetailField>
        </dl>
      </section>
      <HistorySection
        load={() => seedApi.history(row.skey)}
        version={`${row.skey}:${row.updatedAt ?? ""}`}
        eventLabel={(a) => ts(`event.${a as "add"}`)}
        fieldLabel={(f) => ts(`field.${f as "category"}`)}
        value={value}
      />
    </div>
  );
}
