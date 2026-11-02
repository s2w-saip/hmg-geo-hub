"use client";

// Admin › 고객 관심 데이터 관리 › 수집 소스 (2026-11-02): the HUB owns the community sources to collect from (admin-todo
// decision E). Gold has no such list and no collector reads the HUB's yet, so a row is not "applied" anywhere: it shows
// whether its host is in Gold's active social snapshot (back/bff/hub_stores/interest.py), and the corpus hosts no HUB
// source has are listed to take over. Add, edit, stop and resume save at once and keep the history; the original screen's
// delete is the stop here.

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { ArrowDownWideNarrow, ArrowUpNarrowWide, History, Pause, Pencil, Play, Plus } from "lucide-react";
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
import { LIST_TD as TD, RnDetailField, RnFilterPanel, RnFilterRail, RnRadioAxis, RnSortHead } from "../../../../_components/prompt-list";
import { HistorySection, LIST_TH_PLAIN, ListPills, StateMark } from "../../citation-sources/_components/source-lists-kit";
import { INPUT, Row } from "../../prompts/_components/hub-prompt-form";
import { SOURCE_CHANNELS, interestSourceApi, type InterestBrand, type InterestSourceListing, type InterestSourceRow, type SourceChannel } from "./interest-api";
import { BrandPicks, FormFoot, Problem, useBrandsLabel, useInterestError } from "./interest-kit";
import {
  ALL,
  COMMON,
  DEFAULT_SOURCE_FILTER,
  DEFAULT_SOURCE_SORT,
  NOTE_MAX,
  SOURCE_AXES,
  SOURCE_SORTS,
  pickedSourceAxes,
  queryToSourceFilter,
  sortSources,
  sourceAxisOptions,
  sourceCounts,
  sourceFilterToQuery,
  sourceFirstAsc,
  sourceKeyOf,
  sourceMatches,
  type SourceAxis,
  type SourceFilter,
  type SourceSort,
} from "./interest-model";

type Sheet = { mode: "add"; url: string } | { mode: "edit"; key: string } | { mode: "detail"; key: string };

export function InterestSourcesManager({ initial, tabs }: { initial: InterestSourceListing; tabs?: ReactNode }) {
  return (
    <RnToastProvider>
      <Manager initial={initial} tabs={tabs} />
    </RnToastProvider>
  );
}

function Manager({ initial, tabs }: { initial: InterestSourceListing; tabs?: ReactNode }) {
  const t = useTranslations("hubInterest");
  const ts = useTranslations("hubInterest.sources");
  const tv = useTranslations("standardPromptsView");
  const tp = useTranslations("renewal.prompts");
  const tr = useTranslations("renewal.filters");
  const locale = useLocale();
  const toast = useRnToast();
  const sp = useSearchParams();
  const tip = useRnTruncTip();
  const errorText = useInterestError();
  const brandsLabel = useBrandsLabel();
  const fromUrl = useMemo(() => queryToSourceFilter(sp), []); // eslint-disable-line react-hooks/exhaustive-deps

  const [listing, setListing] = useState(initial);
  const [filters, setFilters] = useState<SourceFilter>(fromUrl.filters);
  const [search, setSearch] = useState(fromUrl.search);
  const [sort, setSort] = useState(DEFAULT_SOURCE_SORT);
  const [saving, setSaving] = useState<string | null>(null);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [open, setOpen] = useState<Partial<Record<SourceAxis, boolean>>>({ state: true, status: true });
  const nf = useMemo(() => new Intl.NumberFormat(locale), [locale]);

  const reload = () => interestSourceApi.list().then(setListing, (e) => toast(errorText(e)));

  // URL mirrors the picks (shareable, restorable); shallow — no server round trip.
  useEffect(() => {
    window.history.replaceState(null, "", `${window.location.pathname}?${sourceFilterToQuery(filters, search)}`);
  }, [filters, search]);

  const axisLabel = (a: SourceAxis) => ts(`axis.${a}`);
  const valueLabel = (a: SourceAxis, v: string) => {
    if (v === ALL) return tv("filterAll");
    if (a === "channel") return t(`channel.${v as "news"}`);
    if (a === "brand") return v === COMMON ? t("brandCommon") : v;
    if (a === "state") return ts(`state.${v as "observed"}`);
    return t(`status.${v as "active"}`);
  };
  const picked = pickedSourceAxes(filters);
  const shown = useMemo(() => sortSources(listing.items.filter((r) => sourceMatches(r, filters, search)), sort.key, sort.asc), [listing.items, filters, search, sort]);
  const total = sourceCounts(listing.items);
  const head = (key: SourceSort, className?: string) => (
    <RnSortHead sortKey={key} label={ts(`column.${key}`)} sort={sort} className={className} onSort={(k) => setSort((s) => (s.key === k ? { key: k, asc: !s.asc } : { key: k, asc: sourceFirstAsc(k) }))} />
  );

  const toggle = async (row: InterestSourceRow) => {
    const stopping = row.status === "active";
    setSaving(row.key);
    try {
      await (stopping ? interestSourceApi.stop(row.key) : interestSourceApi.resume(row.key));
      toast(ts(stopping ? "toast.stopped" : "toast.resumed", { url: row.url }));
      await reload();
    } catch (e) {
      toast(errorText(e));
    } finally {
      setSaving(null);
    }
  };
  const saved = async (url: string) => {
    setSheet(null);
    toast(ts("toast.saved", { url }));
    await reload();
  };

  const panel = (
    <RnFilterPanel
      count={picked.length}
      onReset={() => {
        const before = filters;
        setFilters(DEFAULT_SOURCE_FILTER);
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
          options={sourceAxisOptions(a)}
          valueLabel={(v) => valueLabel(a, v)}
          allLabel={tv("filterAll")}
          open={open[a] ?? false}
          onToggle={() => setOpen((o) => ({ ...o, [a]: !(o[a] ?? false) }))}
          onPick={(v) => setFilters((f) => ({ ...f, [a]: v }))}
        />
      ))}
    </RnFilterPanel>
  );

  const sheetRow = sheet && sheet.mode !== "add" ? listing.items.find((r) => r.key === sheet.key) ?? null : null;
  const sheetTitle = sheet?.mode === "add" ? ts("form.titleAdd") : sheet?.mode === "edit" ? ts("form.titleEdit") : ts("detailTitle");

  return (
    <div className="flex flex-col gap-4">
      <RnFilterSplit
        header={
          <RnPageHeader
            title={t("title")}
            meta={
              <>
                <ListPills family="interest_source" published={listing.published} />
                {listing.snapshot ? <RnPill>{ts("snapshotPill", { date: listing.snapshot.takenAt, sources: nf.format(listing.snapshot.sources) })}</RnPill> : null}
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
            <RnButton size="sm" variant="primary" disabled={saving != null} onClick={() => setSheet({ mode: "add", url: "" })} data-hub-source-add="">
              <Plus className="size-3.5" aria-hidden />
              {ts("add")}
            </RnButton>
            <RnSearchField id="rn-hub-interest-source-search" className="w-full max-w-[280px] min-w-[180px] flex-1" value={search} onChange={setSearch} placeholder={ts("searchPlaceholder")} label={t("searchLabel")} />
            <RnSelect
              label={tp("sortLabel")}
              value={sort.key}
              onChange={(e) => {
                const key = e.target.value as SourceSort;
                setSort({ key, asc: sourceFirstAsc(key) });
              }}
              options={SOURCE_SORTS.map((k) => ({ value: k, label: ts(`column.${k}`) }))}
            />
            <RnIconButton label={sort.asc ? tp("sortAsc") : tp("sortDesc")} onClick={() => setSort((s) => ({ key: s.key, asc: !s.asc }))}>
              {sort.asc ? <ArrowUpNarrowWide className="size-4" aria-hidden /> : <ArrowDownWideNarrow className="size-4" aria-hidden />}
            </RnIconButton>
            <span className="ml-auto text-rn-12 text-rn-muted tabular-nums" data-hub-source-count="">
              {ts("count", { shown: nf.format(shown.length), total: nf.format(total.total), active: nf.format(total.active), stopped: nf.format(total.stopped), upstream: nf.format(total.upstream) })}
            </span>
          </div>
          {shown.length === 0 ? (
            <RnEmpty className="m-5">{listing.items.length ? ts("emptyFiltered") : ts("empty")}</RnEmpty>
          ) : (
            <div {...tip.bind}>
              <table className="w-full table-fixed border-separate border-spacing-0 text-rn-13" data-hub-source-table="">
                <colgroup>
                  <col />
                  <col className="w-[96px]" />
                  <col className="w-[132px]" />
                  <col className="w-[112px]" />
                  <col className="w-[128px]" />
                  <col className="w-[72px]" />
                  <col className="w-[176px]" />
                </colgroup>
                <thead>
                  <tr className="text-left text-rn-12 text-rn-muted">
                    {head("url", "pl-5")}
                    {head("channel")}
                    <th className={LIST_TH_PLAIN}>{ts("column.brand")}</th>
                    {head("mentions", "text-right")}
                    {head("state")}
                    <th className={LIST_TH_PLAIN}>{ts("column.status")}</th>
                    <th className={cx(LIST_TH_PLAIN, "pr-5 text-right")}>{ts("column.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((row) => {
                    const busy = saving != null;
                    const hub = row.status != null;
                    return (
                      <tr key={row.key} data-hub-source-row={row.key} className="hover:bg-rn-navy-25/60">
                        <td className={cx(TD, "pl-5")}>
                          <span data-rn-tip="" className={cx("block min-w-0 truncate", hub ? "font-semibold" : "", row.status === "stopped" ? "text-rn-muted line-through" : hub ? "text-rn-ink" : "text-rn-ink-2")}>
                            {row.url}
                          </span>
                        </td>
                        <td className={TD}>{row.channel ? <RnTag>{t(`channel.${row.channel}`)}</RnTag> : <span className="text-rn-12 text-rn-faint">—</span>}</td>
                        <td className={cx(TD, "text-rn-12 text-rn-ink-2")}>{hub ? <span data-rn-tip="" className="block truncate">{brandsLabel(row.brands)}</span> : <span className="text-rn-faint">—</span>}</td>
                        <td className={cx(TD, "text-right text-rn-12 text-rn-ink-2 tabular-nums")} data-hub-source-mentions={row.gold?.mentions ?? 0}>
                          {row.gold ? nf.format(row.gold.mentions) : "—"}
                        </td>
                        <td className={TD}>
                          <SourceState row={row} />
                        </td>
                        <td className={cx(TD, "text-rn-12")}>{row.status ? t(`status.${row.status}`) : <span className="text-rn-faint">—</span>}</td>
                        <td className={cx(TD, "pr-5")}>
                          <span className="flex items-center justify-end gap-1">
                            {hub ? (
                              <>
                                <RnIconButton label={`${ts("edit")} · ${row.url}`} disabled={busy} onClick={() => setSheet({ mode: "edit", key: row.key })} data-hub-source-edit={row.key}>
                                  <Pencil className="size-4" aria-hidden />
                                </RnIconButton>
                                <RnButton size="sm" disabled={busy} onClick={() => void toggle(row)} data-hub-source-toggle={row.key}>
                                  {row.status === "active" ? <Pause className="size-3.5" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
                                  {t(row.status === "active" ? "stop" : "resume")}
                                </RnButton>
                                <RnIconButton label={t("historyOpen", { name: row.url })} onClick={() => setSheet({ mode: "detail", key: row.key })} data-hub-source-history={row.key}>
                                  <History className="size-4" aria-hidden />
                                </RnIconButton>
                              </>
                            ) : (
                              <RnButton size="sm" disabled={busy} onClick={() => setSheet({ mode: "add", url: row.key })} data-hub-source-adopt={row.key}>
                                <Plus className="size-3.5" aria-hidden />
                                {ts("addAsSource")}
                              </RnButton>
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
          <p className="m-0 border-t border-rn-line px-5 py-2.5 text-rn-11 text-rn-muted">{ts("hint", { date: listing.snapshot?.takenAt ?? "—" })}</p>
        </RnCard>
      </RnFilterSplit>
      <RnDrawer open={sheet != null} onClose={() => setSheet(null)} title={sheetTitle} closeLabel={tp("close")}>
        {sheet?.mode === "add" ? (
          <SourceForm key={`add:${sheet.url}`} initial={{ url: sheet.url, channel: "community", brands: [], note: "" }} editing={false} exists={(k) => listing.items.some((r) => r.key === k && r.status != null)} onSaved={saved} onCancel={() => setSheet(null)} />
        ) : sheet?.mode === "edit" && sheetRow ? (
          <SourceForm key={`edit:${sheetRow.key}:${sheetRow.updatedAt ?? ""}`} initial={{ url: sheetRow.url, channel: sheetRow.channel ?? "community", brands: sheetRow.brands, note: sheetRow.note ?? "" }} editing exists={() => false} onSaved={saved} onCancel={() => setSheet(null)} />
        ) : sheet?.mode === "detail" && sheetRow ? (
          <SourceDetail key={sheetRow.key} row={sheetRow} />
        ) : null}
      </RnDrawer>
    </div>
  );
}

/** 코퍼스에 있음 / 코퍼스에 없음 / HUB 미등록: a comparison with the corpus, never "반영됨" (nothing reads the list yet). */
export function SourceState({ row }: { row: InterestSourceRow }) {
  const ts = useTranslations("hubInterest.sources");
  return <StateMark state={row.state} attr="data-hub-source-state" label={row.state ? ts(`state.${row.state}`) : "—"} tip={row.state ? ts(`stateTip.${row.state}`) : ""} />;
}

export function SourceForm({
  initial,
  editing,
  exists,
  onSaved,
  onCancel,
}: {
  initial: { url: string; channel: SourceChannel; brands: readonly InterestBrand[]; note: string };
  editing: boolean;
  exists: (key: string) => boolean;
  onSaved: (url: string) => void | Promise<void>;
  onCancel: () => void;
}) {
  const t = useTranslations("hubInterest");
  const ts = useTranslations("hubInterest.sources");
  const errorText = useInterestError();
  const [url, setUrl] = useState(initial.url);
  const [channel, setChannel] = useState<SourceChannel>(initial.channel);
  const [brands, setBrands] = useState<InterestBrand[]>([...initial.brands]);
  const [note, setNote] = useState(initial.note);
  const [tried, setTried] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const key = sourceKeyOf(url);
  const badUrl = key == null;
  const duplicate = !editing && key != null && exists(key);
  const badNote = note.trim().length > NOTE_MAX;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTried(true);
    if (pending || badUrl || duplicate || badNote) return;
    setPending(true);
    setFailure(null);
    try {
      await interestSourceApi.set({ url: url.trim(), channel, brands, note: note.trim() || null });
      await onSaved(url.trim());
    } catch (err) {
      setFailure(errorText(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" data-hub-source-form={editing ? "edit" : "add"} noValidate>
      <Row label={t("field.url")} htmlFor="hub-source-url" invalid={tried && (badUrl || duplicate)}>
        {editing ? (
          <span className="font-mono text-rn-13 text-rn-ink">{url}</span>
        ) : (
          <>
            <input id="hub-source-url" className={cx(INPUT, "font-mono")} value={url} onChange={(e) => setUrl(e.target.value)} placeholder={ts("form.urlPlaceholder")} autoComplete="off" spellCheck={false} maxLength={520} aria-invalid={(tried && badUrl) || undefined} data-hub-source-url="" autoFocus />
            <p className="m-0 mt-1 text-rn-11 text-rn-muted">{ts("form.urlHint")}</p>
          </>
        )}
        {tried && badUrl ? <Problem attr="url">{ts("form.problem.url")}</Problem> : null}
        {tried && duplicate ? <Problem attr="duplicate">{ts("form.problem.duplicate")}</Problem> : null}
      </Row>
      <Row label={t("field.channel")}>
        <RnSelect label={t("field.channel")} value={channel} onChange={(e) => setChannel(e.target.value as SourceChannel)} options={SOURCE_CHANNELS.map((c) => ({ value: c, label: t(`channel.${c}`) }))} data-hub-source-channel="" />
      </Row>
      <Row label={t("field.brands")} top>
        <BrandPicks value={brands} onChange={setBrands} />
      </Row>
      <Row label={t("field.note")} htmlFor="hub-source-note" invalid={tried && badNote} top>
        <textarea id="hub-source-note" className={cx(INPUT, "h-20 py-2")} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("notePlaceholder")} maxLength={NOTE_MAX + 20} data-hub-source-note="" />
        {tried && badNote ? <Problem attr="note">{t("noteProblem")}</Problem> : null}
      </Row>
      <FormFoot failure={failure} pending={pending} onCancel={onCancel} />
    </form>
  );
}

function SourceDetail({ row }: { row: InterestSourceRow }) {
  const t = useTranslations("hubInterest");
  const ts = useTranslations("hubInterest.sources");
  const locale = useLocale();
  const errorText = useInterestError();
  const brandsLabel = useBrandsLabel();
  const nf = new Intl.NumberFormat(locale);
  const value = (field: string, v: unknown): string | null => {
    if (v == null) return null;
    if (field === "status") return t(`status.${v as "active"}`);
    if (field === "channel") return t(`channel.${v as "news"}`);
    if (field === "brands" && Array.isArray(v)) return brandsLabel(v as string[]);
    return String(v);
  };
  return (
    <div className="flex flex-col gap-6" data-hub-source-detail={row.key}>
      <section className="flex flex-col gap-3">
        <b className="min-w-0 truncate font-mono text-rn-16 text-rn-ink">{row.url}</b>
        <dl className="m-0 grid grid-cols-[112px_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-rn-13">
          <RnDetailField label={ts("field.key")}>
            <span className="font-mono text-rn-12">{row.key}</span>
          </RnDetailField>
          <RnDetailField label={t("field.channel")}>{row.channel ? t(`channel.${row.channel}`) : null}</RnDetailField>
          <RnDetailField label={t("field.brands")}>{row.status ? brandsLabel(row.brands) : null}</RnDetailField>
          <RnDetailField label={t("field.status")}>{row.status ? t(`status.${row.status}`) : null}</RnDetailField>
          <RnDetailField label={ts("field.host")}>
            <span className="font-mono text-rn-12">{row.host}</span>
          </RnDetailField>
          <RnDetailField label={ts("field.corpus")}>{row.gold ? ts("corpusValue", { mentions: nf.format(row.gold.mentions), entities: nf.format(row.gold.entities) }) : ts("corpusNone")}</RnDetailField>
          <RnDetailField label={t("field.note")}>{row.note}</RnDetailField>
        </dl>
      </section>
      <HistorySection load={() => interestSourceApi.history(row.key)} version={`${row.key}:${row.updatedAt ?? ""}`} eventLabel={(a) => t(`event.${a as "add"}`)} fieldLabel={(f) => t(`field.${f as "note"}`)} value={value} errorText={errorText} />
    </div>
  );
}
