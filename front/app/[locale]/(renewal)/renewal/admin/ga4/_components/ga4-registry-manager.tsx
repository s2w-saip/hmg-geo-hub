"use client";

// Renewal Admin › GA4 연동 (2026-10-29): the top-level administrator keeps the GA4 property registry the collector
// reads (back/analytics/ga4_collect.py): the property ID, its market (brand × country), the conversion basis (GA4 key
// events, or the listed events), and 중지 / 재개. Reads and writes go through /api/hub/ga4-properties
// (ga4-registry-api.ts); the BFF checks every call and keeps every change as the property's history. The BFF never
// calls GA4: 수집 결과 and 마지막 수집일 are what the collector's last run left, and a change reaches the AI
// Conversion screen at its next run (반영 대기 until then). The layout is Admin › 사용자 관리's
// (hub-accounts-manager.tsx): the left filter panel with saved filters, one line per property with sortable column
// heads, and a row opens the detail sheet.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { ArrowDownWideNarrow, ArrowUpNarrowWide, Database, Loader2, Pause, Pencil, Play, Plus } from "lucide-react";
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
import { countryName } from "@/lib/geo-catalog/country-name";
import { RnFilterSplit } from "../../../_components/filter-split";
import { LIST_TD as TD, RnDetailField, RnFilterPanel, RnFilterRail, RnRadioAxis, RnSortHead, RnTimeline } from "../../../_components/prompt-list";
import { RnSavedFiltersSection, useSavedFilters, type SavedFilter, type SavedFiltersSource } from "../../../_components/saved-filters";
import { Ga4ErrorNote, Ga4PropertyForm } from "./ga4-registry-form";
import { Ga4RequestError, ga4Api, type Ga4Action, type Ga4Property, type Ga4PropertyDetail } from "./ga4-registry-api";
import {
  ALL,
  AXIS_OPTIONS,
  DEFAULT_FILTER,
  DEFAULT_SORT,
  GA4_AXES,
  GA4_SORTS,
  filterToQuery,
  firstAsc,
  matches,
  pickedAxes,
  queryToFilter,
  resultOf,
  sortProperties,
  type Ga4Axis,
  type Ga4Filter,
  type Ga4Result,
  type Ga4Sort,
} from "./ga4-registry-filter-model";

type Sheet = { mode: "create" } | { mode: "open"; id: string };

export interface Ga4RegistryManagerProps {
  initial: Ga4Property[];
  savedFilters: SavedFiltersSource;
}

export function Ga4RegistryManager(props: Ga4RegistryManagerProps) {
  return (
    <RnToastProvider>
      <Manager {...props} />
    </RnToastProvider>
  );
}

/** Labels of a property's values, shared by the list, the sheet and the history. */
function useGa4Labels() {
  const t = useTranslations("hubGa4");
  const locale = useLocale();
  return useMemo(() => {
    const country = (c: string) => countryName(c, locale);
    const basis = (p: Pick<Ga4Property, "basis" | "events">) => (p.basis === "events" ? t("basisShort.events", { n: p.events.length }) : t("basis.key_events"));
    const value = (field: string, v: unknown): string | null => {
      if (v == null || (Array.isArray(v) && !v.length)) return null;
      if (field === "country") return `${country(String(v))} (${String(v)})`;
      if (field === "basis") return t(`basis.${v as "events"}`);
      if (field === "enabled") return t(v ? "setting.enabled" : "setting.stopped");
      return Array.isArray(v) ? v.join(", ") : String(v);
    };
    return { country, basis, value };
  }, [locale, t]);
}

function Manager({ initial, savedFilters }: Ga4RegistryManagerProps) {
  const t = useTranslations("hubGa4");
  const tv = useTranslations("standardPromptsView");
  const tp = useTranslations("renewal.prompts");
  const tr = useTranslations("renewal.filters");
  const ts = useTranslations("renewal.saved");
  const locale = useLocale();
  const toast = useRnToast();
  const sp = useSearchParams();
  const labels = useGa4Labels();
  const tip = useRnTruncTip();
  const fromUrl = useMemo(() => queryToFilter(sp), []); // eslint-disable-line react-hooks/exhaustive-deps

  const [items, setItems] = useState(initial);
  const [filters, setFilters] = useState<Ga4Filter>(fromUrl.filters);
  const [search, setSearch] = useState(fromUrl.search);
  const [sort, setSort] = useState(DEFAULT_SORT);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [listError, setListError] = useState<Ga4RequestError | null>(null);
  const [open, setOpen] = useState<Partial<Record<Ga4Axis, boolean>>>({ brand: true, setting: true, result: true });

  const reload = useCallback(() => {
    ga4Api.list().then(
      (res) => {
        setItems(res.items);
        setListError(null);
      },
      (e: unknown) => setListError(e instanceof Ga4RequestError ? e : new Ga4RequestError(0, "failed")),
    );
  }, []);

  // URL mirrors the picks (shareable, restorable); shallow — no server round trip.
  useEffect(() => {
    const qs = filterToQuery(filters, search);
    window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
  }, [filters, search]);

  const axisLabel = useCallback((a: Ga4Axis) => t(`axis.${a}`), [t]);
  const valueLabel = useCallback(
    (a: Ga4Axis, v: string) => (v === ALL ? tv("filterAll") : a === "setting" ? t(`setting.${v as "enabled"}`) : a === "result" ? t(`result.${v as Ga4Result}`) : v),
    [t, tv],
  );
  const setAll = (next: Ga4Filter, nextSearch: string) => {
    setFilters(next);
    setSearch(nextSearch);
  };

  // ── saved filters ──
  const saved = useSavedFilters(savedFilters);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [openedWith, setOpenedWith] = useState<string | null>(null);
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
      return [...pickedAxes(f).map((a) => valueLabel(a, f[a])), ...(s ? [`“${s}”`] : [])].join(" · ");
    },
    [valueLabel],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey) return;
      const el = document.activeElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT")) return;
      e.preventDefault();
      document.querySelector<HTMLInputElement>("#rn-hub-ga4-search")?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const picked = pickedAxes(filters);
  const shown = useMemo(
    () => sortProperties(items.filter((p) => matches(p, filters, search, labels.country)), sort.key, sort.asc, labels.country),
    [items, filters, search, sort, labels],
  );
  const sortLabel = (k: Ga4Sort) => t(`column.${k}`);
  const head = (key: Ga4Sort, className?: string) => (
    <RnSortHead sortKey={key} label={sortLabel(key)} sort={sort} className={className} onSort={(k) => setSort((s) => (s.key === k ? { key: k, asc: !s.asc } : { key: k, asc: firstAsc(k) }))} />
  );

  const changed = (item: Ga4Property, message: string) => {
    toast(message);
    reload();
    setSheet({ mode: "open", id: item.propertyId });
  };

  const panel = (
    <RnFilterPanel
      count={picked.length}
      onReset={() => {
        const before = { f: filters, s: search };
        setAll(DEFAULT_FILTER, "");
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
          currentQuery={filterToQuery(filters, search)}
          summarize={summarize}
          hrefOf={(q) => `${window.location.origin}${window.location.pathname}${q ? `?${q}` : ""}`}
        />
      }
    >
      {GA4_AXES.map((a) => (
        <RnRadioAxis
          key={a}
          axis={a}
          label={axisLabel(a)}
          value={filters[a]}
          options={AXIS_OPTIONS[a]}
          valueLabel={(v) => valueLabel(a, v)}
          allLabel={tv("filterAll")}
          open={open[a] ?? false}
          onToggle={() => setOpen((o) => ({ ...o, [a]: !(o[a] ?? false) }))}
          onPick={(v) => {
            setFilters((f) => ({ ...f, [a]: v }));
            setOpenedWith(null);
          }}
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
                <span>{t("description")}</span>
              </>
            }
            actions={
              <RnButton variant="primary" onClick={() => setSheet({ mode: "create" })} data-hub-ga4-create="">
                <Plus className="size-3.5" aria-hidden />
                {t("create")}
              </RnButton>
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
        {picked.length || search ? (
          <div aria-live="polite" className="flex min-h-7 flex-wrap items-center gap-2">
            {picked.map((a) => (
              <RnToken key={a} label={axisLabel(a)} value={valueLabel(a, filters[a])} removeLabel={tr("removeToken", { label: axisLabel(a) })} onRemove={() => setFilters((f) => ({ ...f, [a]: ALL }))} />
            ))}
            {search ? <RnToken label={t("searchLabel")} value={`“${search}”`} removeLabel={tr("removeToken", { label: t("searchLabel") })} onRemove={() => setSearch("")} /> : null}
          </div>
        ) : null}
        {openedWith ? (
          <RnNote>
            <span>{ts("openedWithDefault", { name: openedWith })}</span>
            <button
              type="button"
              className="cursor-pointer font-semibold text-rn-navy underline-offset-4 hover:underline"
              onClick={() => {
                setOpenedWith(null);
                setAll(DEFAULT_FILTER, "");
              }}
            >
              {ts("viewWithout")}
            </button>
          </RnNote>
        ) : null}
        <RnCard aria-label={t("listLabel")}>
          <div className="flex flex-wrap items-center gap-2 border-b border-rn-line px-5 py-3">
            <RnSearchField
              id="rn-hub-ga4-search"
              className="w-full max-w-[280px] min-w-[180px] flex-1"
              value={search}
              onChange={setSearch}
              placeholder={t("searchPlaceholder")}
              label={t("searchLabel")}
            />
            <RnSelect
              label={tp("sortLabel")}
              value={sort.key}
              onChange={(e) => {
                const key = e.target.value as Ga4Sort;
                setSort({ key, asc: firstAsc(key) });
              }}
              options={GA4_SORTS.map((k) => ({ value: k, label: sortLabel(k) }))}
            />
            <RnIconButton label={sort.asc ? tp("sortAsc") : tp("sortDesc")} onClick={() => setSort((s) => ({ key: s.key, asc: !s.asc }))}>
              {sort.asc ? <ArrowUpNarrowWide className="size-4" aria-hidden /> : <ArrowDownWideNarrow className="size-4" aria-hidden />}
            </RnIconButton>
            <span className="ml-auto text-rn-12 text-rn-muted tabular-nums">{t("count", { shown: shown.length, total: items.length })}</span>
          </div>
          {listError ? (
            <Ga4ErrorNote error={listError} className="m-5" />
          ) : shown.length === 0 ? (
            <RnEmpty className="m-5">{items.length ? t("emptyFiltered") : t("empty")}</RnEmpty>
          ) : (
            <div {...tip.bind}>
              <table className="w-full table-fixed border-separate border-spacing-0 text-rn-13" data-hub-ga4-table="">
                <colgroup>
                  <col className="w-[240px]" />
                  <col className="w-[148px]" />
                  <col />
                  <col className="w-[132px]" />
                  <col className="w-[200px]" />
                  <col className="w-[132px]" />
                </colgroup>
                <thead>
                  <tr className="text-left text-rn-12 text-rn-muted">
                    {head("market", "pl-5")}
                    {head("propertyId")}
                    <th className={LIST_TH_PLAIN}>{t("column.basis")}</th>
                    <th className={LIST_TH_PLAIN}>{t("column.setting")}</th>
                    {head("result")}
                    {head("collectedTo", "pr-5")}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((p) => (
                    <tr
                      key={p.propertyId}
                      data-hub-ga4-row={p.propertyId}
                      onClick={() => !window.getSelection()?.toString() && setSheet({ mode: "open", id: p.propertyId })}
                      className="cursor-pointer hover:bg-rn-navy-25/60"
                    >
                      <td className={cx(TD, "pl-5")}>
                        <span className="flex min-w-0 items-center gap-2">
                          <button type="button" data-rn-tip="" className={cx("min-w-0 shrink cursor-pointer truncate text-left font-semibold focus-visible:outline-2 focus-visible:outline-rn-navy", p.enabled ? "text-rn-ink" : "text-rn-muted")}>
                            {p.brand} · {labels.country(p.country)}
                          </button>
                          <span className="shrink-0 text-rn-12 text-rn-muted">{p.country}</span>
                        </span>
                      </td>
                      <td className={cx(TD, "font-mono text-rn-12 text-rn-ink-2 tabular-nums")}>{p.propertyId}</td>
                      <td className={TD}>
                        <span data-rn-tip={p.events.length ? p.events.join(", ") : undefined} className="block truncate text-rn-12 text-rn-ink-2">
                          {labels.basis(p)}
                        </span>
                      </td>
                      <td className={TD}>
                        <SettingMark item={p} />
                      </td>
                      <td className={TD}>
                        <ResultMark item={p} />
                      </td>
                      <td className={cx(TD, "pr-5 text-rn-12 text-rn-muted tabular-nums")}>
                        {p.collection.collectedTo ? (
                          <span data-rn-tip={p.collection.collectedAt ? t("collectedAtTip", { at: formatTime(p.collection.collectedAt, locale) }) : undefined}>{formatDay(p.collection.collectedTo, locale)}</span>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {tip.tip}
            </div>
          )}
        </RnCard>
      </RnFilterSplit>
      <RnDrawer
        open={sheet != null}
        onClose={() => setSheet(null)}
        title={sheet?.mode === "create" ? t("createTitle") : t("detailTitle")}
        subtitle={sheet?.mode === "create" ? t("createHint") : undefined}
        closeLabel={tp("close")}
      >
        {sheet?.mode === "create" ? (
          <Ga4PropertyForm key="create" item={null} onSaved={(item) => changed(item, t("toast.created"))} onCancel={() => setSheet(null)} />
        ) : sheet ? (
          <Detail key={sheet.id} id={sheet.id} onChanged={changed} />
        ) : null}
      </RnDrawer>
    </div>
  );
}

// the basis and setting columns cannot sort; same head as the sortable ones
const LIST_TH_PLAIN = "sticky -top-1 z-[1] h-[38px] border-b border-rn-line-2 bg-rn-surface px-3 font-semibold";

/** 수집 = a filled navy dot; 중지 = a dashed one, muted. 반영 대기 when the collector has not run since the change. */
function SettingMark({ item }: { item: Ga4Property }) {
  const t = useTranslations("hubGa4");
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 text-rn-12" data-hub-ga4-setting={item.enabled ? "enabled" : "stopped"}>
      <i aria-hidden className={cx("inline-block size-2 shrink-0 rounded-full", item.enabled ? "bg-rn-navy" : "border border-dashed border-rn-muted")} />
      <span className={cx("truncate", item.enabled ? "text-rn-ink" : "text-rn-muted")}>{t(item.enabled ? "setting.enabled" : "setting.stopped")}</span>
      {item.collection.pending ? (
        <span data-rn-tip={t("pendingTip")} data-hub-ga4-pending="">
          <RnTag className="shrink-0">{t("pending")}</RnTag>
        </span>
      ) : null}
    </span>
  );
}

/** The collector's last result, as it left it, with the time of that run. */
function ResultMark({ item }: { item: Ga4Property }) {
  const t = useTranslations("hubGa4");
  const locale = useLocale();
  const result = resultOf(item);
  const c = item.collection;
  const tipText = [c.checkedAt ? t("checkedAtTip", { at: formatTime(c.checkedAt, locale) }) : null, c.error].filter(Boolean).join(" · ") || undefined;
  return (
    <span className={cx("inline-flex max-w-full items-center gap-1.5 text-rn-12", RESULT_TONE[result])} data-hub-ga4-result={result} data-rn-tip={tipText}>
      <i aria-hidden className={cx("inline-block size-2 shrink-0 rounded-full", RESULT_DOT[result])} />
      <span className="truncate">{t(`result.${result}`)}</span>
      {c.checkedAt ? <span className="shrink-0 text-rn-muted tabular-nums">{formatShort(c.checkedAt, locale)}</span> : null}
    </span>
  );
}

const RESULT_TONE: Record<Ga4Result, string> = {
  collected: "text-rn-ink",
  pending_grant: "text-rn-ink",
  failed: "text-rn-danger-ink",
  stopped: "text-rn-muted",
  never: "text-rn-muted",
};
const RESULT_DOT: Record<Ga4Result, string> = {
  collected: "bg-rn-navy",
  pending_grant: "border-[1.5px] border-rn-navy",
  failed: "bg-rn-down",
  stopped: "border border-dashed border-rn-muted",
  never: "border border-rn-muted",
};

function formatTime(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

function formatShort(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

/** A calendar day (YYYY-MM-DD) as it is, not shifted by the viewer's time zone. */
function formatDay(day: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`));
}

// ─── sheet: an existing property ─────────────────────────────────────────────

function Detail({ id, onChanged }: { id: string; onChanged: (item: Ga4Property, message: string) => void }) {
  const t = useTranslations("hubGa4");
  const locale = useLocale();
  const labels = useGa4Labels();
  const [detail, setDetail] = useState<Ga4PropertyDetail | null>(null);
  const [error, setError] = useState<Ga4RequestError | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Ga4RequestError | null>(null);
  const [conflict, setConflict] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    ga4Api.detail(id).then(
      (d) => live && (setDetail(d), setError(null)),
      (e) => live && setError(e instanceof Ga4RequestError ? e : new Ga4RequestError(0, "failed")),
    );
    return () => {
      live = false;
    };
  }, [id, nonce]);

  if (error) return <Ga4ErrorNote error={error} />;
  if (!detail) {
    return (
      <p className="flex items-center gap-2 text-rn-13 text-rn-muted">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        {t("loading")}
      </p>
    );
  }
  const { item, history } = detail;
  const c = item.collection;

  const act = async (action: Ga4Action) => {
    setPending(true);
    setFailure(null);
    try {
      const out = await ga4Api.act(item.propertyId, action);
      setConfirm(false);
      onChanged(out.item, t(action === "stop" ? "toast.stopped" : "toast.resumed"));
      setNonce((n) => n + 1);
    } catch (e) {
      setFailure(e instanceof Ga4RequestError ? e : new Ga4RequestError(0, "failed"));
    } finally {
      setPending(false);
    }
  };

  const events = history.map((e) => ({
    key: String(e.id),
    label: t(`event.${e.action}`),
    at: e.at,
    actor: e.actor ? e.actor.displayName || e.actor.login : "—",
    changes: Object.fromEntries(Object.entries(e.changes).map(([field, [before, after]]) => [field, { old: labels.value(field, before), new: labels.value(field, after) }])),
  }));

  return (
    <div className="flex flex-col gap-6" data-hub-ga4-detail={item.propertyId}>
      {c.pending ? <RnNote>{t(item.enabled ? "note.pending" : "note.pendingStop")}</RnNote> : !item.enabled ? <RnNote>{t("note.stopped")}</RnNote> : null}
      {conflict ? <Ga4ErrorNote error={new Ga4RequestError(409, "version_conflict")} /> : null}
      {editing ? (
        <Ga4PropertyForm
          key={`${item.propertyId}:${item.version}`}
          item={item}
          onSaved={(next) => {
            setEditing(false);
            setConflict(false);
            setNonce((n) => n + 1);
            onChanged(next, t("toast.updated"));
          }}
          onConflict={() => {
            setConflict(true);
            setNonce((n) => n + 1);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <>
          <section className="flex flex-col gap-3">
            <div className="flex min-w-0 items-baseline gap-2">
              <b className="min-w-0 truncate text-rn-16 text-rn-ink">
                {item.brand} · {labels.country(item.country)}
              </b>
              <span className="shrink-0 font-mono text-rn-13 text-rn-muted tabular-nums">{item.propertyId}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <RnButton size="sm" onClick={() => setEditing(true)} data-hub-ga4-edit="">
                <Pencil className="size-3.5" aria-hidden />
                {t("edit")}
              </RnButton>
              {item.enabled ? (
                <RnButton size="sm" className="ml-auto" disabled={pending} onClick={() => setConfirm(true)} data-hub-ga4-stop="">
                  <Pause className="size-3.5" aria-hidden />
                  {t("stop")}
                </RnButton>
              ) : (
                <RnButton size="sm" variant="primary" className="ml-auto" disabled={pending} onClick={() => void act("resume")} data-hub-ga4-resume="">
                  <Play className="size-3.5" aria-hidden />
                  {t("resume")}
                </RnButton>
              )}
            </div>
            {confirm ? (
              <div role="alertdialog" aria-label={t("confirm.stopTitle")} className="flex flex-col gap-3 rounded-[10px] border border-rn-line-2 bg-rn-page p-4" data-hub-ga4-confirm="stop">
                <p className="m-0 text-rn-13 text-rn-ink">{t("confirm.stop", { market: `${item.brand} · ${labels.country(item.country)}`, id: item.propertyId })}</p>
                <div className="flex gap-2">
                  <RnButton size="sm" variant="primary" disabled={pending} onClick={() => void act("stop")} data-hub-ga4-confirm-ok="">
                    {pending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
                    {t("confirm.stopAction")}
                  </RnButton>
                  <RnButton size="sm" disabled={pending} onClick={() => setConfirm(false)}>
                    {t("form.cancel")}
                  </RnButton>
                </div>
              </div>
            ) : null}
            {failure ? <Ga4ErrorNote error={failure} /> : null}
          </section>
          <section>
            <h3 className="m-0 mb-2 text-rn-13 font-bold text-rn-ink">{t("attributes")}</h3>
            <dl className="m-0 grid grid-cols-[112px_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-rn-13">
              <RnDetailField label={t("field.propertyId")}>
                <span className="font-mono tabular-nums">{item.propertyId}</span>
              </RnDetailField>
              <RnDetailField label={t("field.brand")}>{item.brand}</RnDetailField>
              <RnDetailField label={t("field.country")}>{labels.value("country", item.country)}</RnDetailField>
              <RnDetailField label={t("field.basis")}>{t(`basis.${item.basis}`)}</RnDetailField>
              {item.basis === "events" ? (
                <RnDetailField label={t("field.events")}>
                  <span className="font-mono">{item.events.join(", ")}</span>
                </RnDetailField>
              ) : null}
              <RnDetailField label={t("column.setting")}>
                <SettingMark item={item} />
              </RnDetailField>
              <RnDetailField label={t("column.result")}>
                <span className="flex flex-col gap-1">
                  <ResultMark item={item} />
                  {c.error ? (
                    <span className="text-rn-12 break-words text-rn-ink-2" data-hub-ga4-collect-error="">
                      {c.error}
                    </span>
                  ) : null}
                </span>
              </RnDetailField>
              <RnDetailField label={t("column.collectedTo")}>
                {c.collectedTo ? (
                  <span className="tabular-nums">
                    {formatDay(c.collectedTo, locale)}
                    {c.collectedAt ? <span className="text-rn-muted"> · {t("collectedAtTip", { at: formatTime(c.collectedAt, locale) })}</span> : null}
                  </span>
                ) : null}
              </RnDetailField>
              <RnDetailField label={t("created")}>
                <span className="tabular-nums">{formatTime(item.createdAt, locale)}</span>
              </RnDetailField>
            </dl>
          </section>
        </>
      )}
      <section data-hub-ga4-history="">
        <h3 className="m-0 mb-3 text-rn-13 font-bold text-rn-ink">{t("history")}</h3>
        {events.length ? <RnTimeline events={events} fieldLabel={(f) => t(`field.${f}` as "field.brand")} /> : <p className="m-0 text-rn-12 text-rn-muted">{t("noHistory")}</p>}
      </section>
    </div>
  );
}
