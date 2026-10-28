"use client";

// Renewal Admin › Global prompts (2026-10-27): the top-level administrator manages the HUB catalog's Global
// prompts. HUB-owned ones are created, edited, archived and restored; Gold-imported ones are shown read-only
// (the Gold import would overwrite a change). Every change is a new version; the sheet shows the history.
// Reads and writes go through /api/hub/global-prompts (hub-prompts-api.ts); the BFF checks every call.
// The layout (2026-10-28) is Global › Global prompts' (prompts-view.tsx), with the parts both lists share
// (prompt-list.tsx): left filter panel with saved filters (hub-prompt-filter-model.ts), picks applied at
// once, one line per prompt with sortable column heads, and a row opens the detail sheet — here with
// 편집 · 보관 · 복원. The create / edit form is hub-prompt-form.tsx; an unfinished new prompt is kept here
// when the sheet closes (Esc, backdrop, ×) and comes back with 새 프롬프트.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { Archive, ArrowDownWideNarrow, ArrowUpNarrowWide, Bookmark, Database, Link2, Loader2, Pencil, Plus, RotateCcw } from "lucide-react";
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
  RnTextButton,
  RnToastProvider,
  RnToken,
  cx,
  useRnToast,
  useRnTruncTip,
} from "@/components/renewal-ui";
import { languageName } from "@/lib/geo-catalog/language-name";
import { splitMarkets } from "@/lib/standards/prompt-markets";
import { RnFilterSplit } from "../../../../_components/filter-split";
import {
  LIST_TD as TD,
  RnDetailField,
  RnFilterPanel,
  RnFilterRail,
  RnFunnelChip,
  RnKindMark,
  RnListPager,
  RnMarketList,
  RnMarkets,
  RnPromptText,
  RnRadioAxis,
  RnSortHead,
  RnTimeline,
  useRnMarketLabel,
} from "../../../../_components/prompt-list";
import { RnSavedFiltersSection, useSavedFilters, type SavedFilter, type SavedFiltersSource } from "../../../../_components/saved-filters";
import { ErrorNote, HubPromptForm, isBlankDraft, useFieldLabel } from "./hub-prompt-form";
import { HubRequestError, hubApi, type Draft, type HubOptions, type HubPrompt, type HubPromptDetail, type HubPromptPage } from "./hub-prompts-api";
import {
  ALL,
  DEFAULT_FILTER,
  DEFAULT_PAGE_SIZE,
  DEFAULT_SORT,
  HUB_SORTS,
  axisOptions,
  filterToQuery,
  firstAsc,
  listSearch,
  patchFilter,
  pickedAxes,
  queryToFilter,
  visibleAxes,
  type HubAxis,
  type HubFilter,
  type HubSort,
} from "./hub-prompt-filter-model";

const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;
const DEFAULT_OPEN: Partial<Record<HubAxis, boolean>> = { status: true, origin: true, listType: true, depth1: true, funnel: true, kind: true };
const CHILD: Partial<Record<HubAxis, HubAxis>> = { listType: "depth1", depth1: "depth2", depth2: "depth3", depth3: "depth4" };
const TAXONOMY = ["listType", "depth1", "depth2", "depth3", "depth4"] as const;

type Editing = { mode: "create" } | { mode: "open"; id: string };

export interface HubPromptsManagerProps {
  initial: HubPromptPage;
  /** The list query the server read `initial` with (listSearch of the URL's picks). */
  initialSearch: string;
  options: HubOptions;
  loginHref: string;
  savedFilters: SavedFiltersSource;
}

export function HubPromptsManager(props: HubPromptsManagerProps) {
  return (
    <RnToastProvider>
      <Manager {...props} />
    </RnToastProvider>
  );
}

function Manager({ initial, initialSearch, options, loginHref, savedFilters }: HubPromptsManagerProps) {
  const t = useTranslations("hubPrompts");
  const tv = useTranslations("standardPromptsView");
  const tVal = useTranslations("dashboard.filters.value");
  const tp = useTranslations("renewal.prompts");
  const tr = useTranslations("renewal.filters");
  const ts = useTranslations("renewal.saved");
  const locale = useLocale();
  const toast = useRnToast();
  const sp = useSearchParams();
  const fromUrl = useMemo(() => queryToFilter(sp), []); // eslint-disable-line react-hooks/exhaustive-deps
  const fieldLabel = useFieldLabel();
  const marketLabel = useRnMarketLabel();
  const tip = useRnTruncTip();

  const [filters, setFilters] = useState<HubFilter>(fromUrl.filters);
  const [search, setSearch] = useState(fromUrl.search);
  const [sort, setSort] = useState(DEFAULT_SORT);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [page, setPage] = useState(1);
  const [data, setData] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [editing, setEditing] = useState<Editing | null>(null);
  // a new prompt not saved yet: closing the sheet keeps it (취소 and a save drop it)
  const [createDraft, setCreateDraftState] = useState<Draft | null>(null);
  const setCreateDraft = useCallback((d: Draft | null) => setCreateDraftState(d && !isBlankDraft(d) ? d : null), []);
  const filtersRef = useRef(filters);

  const axisLabel = useCallback((a: HubAxis) => (a === "status" ? t("statusLabel") : a === "origin" ? t("originLabel") : fieldLabel(a)), [t, fieldLabel]);
  const valueLabel = useCallback(
    (a: HubAxis, v: string): string => {
      if (v === ALL) return tv("filterAll");
      if (a === "status") return t(`status.${v as HubPrompt["status"]}`);
      if (a === "origin") return t(`origin.${v as HubPrompt["origin"]}`);
      if (a === "kind") return v === "acr" ? tv("kindAcr") : tv("kindSingle");
      if (a === "brandPresence") return v === "branded" || v === "unbranded" ? tVal(v) : v;
      if (a === "region") return marketLabel(v);
      if (a === "language") return languageName(v, locale);
      return v;
    },
    [locale, marketLabel, t, tv, tVal],
  );

  // ── reads: debounced 120 ms, latest wins; the server read the first page ──
  const readKey = listSearch({ filters, search, sort: sort.key, asc: sort.asc, page, pageSize });
  const firstRead = useRef(true);
  useEffect(() => {
    if (firstRead.current) {
      firstRead.current = false;
      if (readKey === initialSearch) return;
    }
    let active = true;
    setBusy(true);
    const timer = setTimeout(() => {
      hubApi.list(readKey).then(
        (res) => {
          if (!active) return;
          // a page past the end (its last prompts archived away) falls back to the last one
          if (res.items.length === 0 && res.page.offset > 0 && res.page.total > 0) {
            setPage(Math.ceil(res.page.total / pageSize));
            return;
          }
          setData(res);
          setListError(null);
          setBusy(false);
        },
        (e: unknown) => {
          if (!active) return;
          setListError(e instanceof HubRequestError ? e.code : "failed");
          setBusy(false);
        },
      );
    }, 120);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [readKey, initialSearch, pageSize, nonce]);

  // URL mirrors the picks (shareable, restorable); shallow — no server round trip.
  useEffect(() => {
    const qs = filterToQuery(filters, search);
    window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
  }, [filters, search]);

  const [open, setOpen] = useState<Partial<Record<HubAxis, boolean>>>(DEFAULT_OPEN);
  const pick = (axis: HubAxis, value: string) => {
    const next = patchFilter(filtersRef.current, { [axis]: value });
    filtersRef.current = next;
    setFilters(next);
    setPage(1);
    setOpenedWith(null);
    const child = CHILD[axis];
    if (child && value !== ALL) setOpen((o) => ({ ...o, [child]: true }));
  };
  const setAll = (next: HubFilter, nextSearch: string) => {
    filtersRef.current = next;
    setFilters(next);
    setSearch(nextSearch);
    setPage(1);
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
      document.querySelector<HTMLInputElement>("#rn-hub-prompt-search")?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const changed = (item: HubPrompt, message: string) => {
    toast(message);
    setNonce((n) => n + 1);
    setEditing({ mode: "open", id: item.id });
  };

  const picked = pickedAxes(filters);
  const { total, offset } = data.page;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const sortLabel = (k: HubSort) => (k === "changed" ? t("columnChanged") : k === "status" || k === "origin" ? axisLabel(k) : fieldLabel(k));
  const head = (key: HubSort, label: string, className?: string) => (
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
    <RnFilterPanel
      count={picked.length}
      onReset={() => {
        const before = { f: filtersRef.current, s: search };
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
      {visibleAxes(options).map((a) => (
        <RnRadioAxis
          key={a}
          axis={a}
          label={axisLabel(a)}
          value={filters[a]}
          defaultValue={DEFAULT_FILTER[a]}
          options={axisOptions(a, options)}
          valueLabel={(v) => valueLabel(a, v)}
          allLabel={tv("filterAll")}
          open={open[a] ?? false}
          onToggle={() => setOpen((o) => ({ ...o, [a]: !(o[a] ?? false) }))}
          onPick={(v) => pick(a, v)}
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
                  {t("catalogPill")}
                </RnPill>
                <span>{t("description")}</span>
              </>
            }
            actions={
              <>
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
                <RnButton variant="primary" onClick={() => setEditing({ mode: "create" })} data-hub-create="">
                  <Plus className="size-3.5" aria-hidden />
                  {t("create")}
                </RnButton>
              </>
            }
          />
        }
        panel={panel}
        rail={<RnFilterRail count={picked.length} />}
      >
        <RnNote>
          <b className="text-rn-ink">{t("notMeasuredTitle")}</b>
          <span>{t("notMeasured")}</span>
        </RnNote>
        {picked.length || search || busy ? (
          <div aria-live="polite" className="flex min-h-7 flex-wrap items-center gap-2">
            {picked.map((a) => (
              <RnToken key={a} label={axisLabel(a)} value={valueLabel(a, filters[a])} removeLabel={tr("removeToken", { label: axisLabel(a) })} onRemove={() => pick(a, DEFAULT_FILTER[a])} />
            ))}
            {search ? (
              <RnToken
                label={tv("searchPlaceholder")}
                value={`“${search}”`}
                removeLabel={tr("removeToken", { label: tv("searchPlaceholder") })}
                onRemove={() => {
                  setSearch("");
                  setPage(1);
                }}
              />
            ) : null}
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
                setAll(DEFAULT_FILTER, "");
              }}
            >
              {ts("viewWithout")}
            </RnTextButton>
          </RnNote>
        ) : null}
        <RnCard busy={busy} aria-label={t("listLabel")}>
          <div className="flex flex-wrap items-center gap-2 border-b border-rn-line px-5 py-3">
            <RnSearchField
              id="rn-hub-prompt-search"
              className="w-full max-w-[280px] min-w-[180px] flex-1"
              value={search}
              onChange={(v) => {
                setSearch(v);
                setPage(1);
              }}
              placeholder={tv("searchPlaceholder")}
              label={tv("searchPlaceholder")}
            />
            <RnSelect
              label={tp("sortLabel")}
              value={sort.key}
              onChange={(e) => {
                const key = e.target.value as HubSort;
                setSort({ key, asc: firstAsc(key) });
                setPage(1);
              }}
              options={HUB_SORTS.map((k) => ({ value: k, label: sortLabel(k) }))}
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
            <span className="ml-auto text-rn-12 text-rn-muted tabular-nums">{tv("filteredCount", { shown: total, total: data.counts.total })}</span>
          </div>
          {listError ? (
            <ErrorNote code={listError} loginHref={loginHref} className="m-5" />
          ) : total === 0 ? (
            <RnEmpty className="m-5">{t("empty")}</RnEmpty>
          ) : (
            <div {...tip.bind}>
              <table className="w-full table-fixed border-separate border-spacing-0 text-rn-13" data-hub-prompt-table="">
                <colgroup>
                  <col />
                  <col className="w-[76px]" />
                  <col className="w-[104px]" />
                  <col className="w-[168px]" />
                  <col className="w-[128px]" />
                  <col className="w-[72px]" />
                  <col className="w-[112px]" />
                  <col className="w-[132px]" />
                </colgroup>
                <thead>
                  <tr className="text-left text-rn-12 text-rn-muted">
                    {head("text", tv("textLabel"), "pl-5")}
                    {head("origin", t("originLabel"))}
                    {head("funnel", tv("funnelLabel"))}
                    {head("depth1", tp("columnTaxonomy"))}
                    {head("region", tv("marketLabel"))}
                    {head("kind", tp("columnMeasure"))}
                    {head("status", t("statusLabel"))}
                    {head("changed", t("columnChanged"), "pr-5")}
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((p) => {
                    // the cell starts at Depth1 (as on Global prompts); the tip lists every level by name
                    const levels = TAXONOMY.filter((f) => p[f]).map((f) => ({ field: f, label: fieldLabel(f), value: p[f] }));
                    const depths = levels.filter((l) => l.field !== "listType");
                    const path = (depths.length ? depths : levels).map((l) => l.value).join(" › ");
                    return (
                      <tr
                        key={p.id}
                        data-hub-prompt-row={p.id}
                        // a drag that selects text is not a click on the row
                        onClick={() => !window.getSelection()?.toString() && setEditing({ mode: "open", id: p.id })}
                        className="cursor-pointer hover:bg-rn-navy-25/60"
                      >
                        <td className={cx(TD, "pl-5")}>
                          <span className="flex min-w-0 items-center gap-2">
                            {p.language ? (
                              <span data-rn-tip={languageName(p.language, locale)} className="w-5 shrink-0 text-rn-11 font-semibold text-rn-faint uppercase">
                                {p.language}
                              </span>
                            ) : null}
                            <button
                              type="button"
                              data-rn-tip=""
                              className={cx(
                                "min-w-0 flex-1 cursor-pointer truncate text-left focus-visible:outline-2 focus-visible:outline-rn-navy",
                                p.status === "active" ? "text-rn-ink" : "text-rn-muted",
                              )}
                            >
                              {p.text}
                            </button>
                          </span>
                        </td>
                        <td className={TD}>
                          <OriginTag origin={p.origin} />
                        </td>
                        <td className={TD}>
                          <RnFunnelChip value={p.funnel} />
                        </td>
                        <td className={TD}>
                          <span data-rn-tip={levels.map((l) => `${l.label}: ${l.value}`).join("\n") || undefined} className="block truncate text-rn-12 text-rn-ink-2">
                            {path || "—"}
                          </span>
                        </td>
                        <td className={TD}>
                          <RnMarkets markets={splitMarkets(p.regions)} labelOf={marketLabel} allLabel={tv("marketAll")} allHint={tv("marketAllHint")} />
                        </td>
                        <td className={cx(TD, "text-rn-12 whitespace-nowrap")}>
                          <RnKindMark acr={p.kind === "acr"} />
                        </td>
                        <td className={TD}>
                          <StatusMark status={p.status} />
                        </td>
                        <td className={cx(TD, "pr-5")}>
                          <span data-rn-tip={formatTime(p.recordedAt, locale)} className="block truncate text-rn-12 text-rn-muted tabular-nums">
                            v{p.version} · {formatDate(p.recordedAt, locale)}
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
          {total > 0 && !listError ? (
            <RnListPager
              rangeFrom={offset + 1}
              rangeTo={Math.min(offset + data.items.length, total)}
              total={total}
              page={Math.floor(offset / pageSize) + 1}
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
      </RnFilterSplit>
      <RnDrawer
        open={editing != null}
        onClose={() => setEditing(null)}
        title={editing?.mode === "create" ? t("createTitle") : tp("detail.title")}
        subtitle={editing?.mode === "create" ? t("createHint") : undefined}
        closeLabel={tp("close")}
      >
        {editing?.mode === "create" ? (
          <HubPromptForm
            key="create"
            item={null}
            initial={createDraft ?? undefined}
            options={options}
            loginHref={loginHref}
            onDraft={setCreateDraft}
            onSaved={(item, another) => {
              if (another) {
                toast(t("form.createdAnother"));
                setNonce((n) => n + 1);
                return;
              }
              setCreateDraft(null);
              changed(item, t("toast.created"));
            }}
            onCancel={() => {
              setCreateDraft(null);
              setEditing(null);
            }}
          />
        ) : editing ? (
          <Detail key={editing.id} id={editing.id} options={options} loginHref={loginHref} onChanged={changed} />
        ) : null}
      </RnDrawer>
    </div>
  );
}

function OriginTag({ origin }: { origin: HubPrompt["origin"] }) {
  const t = useTranslations("hubPrompts");
  return <RnTag className={origin === "gold" ? "bg-rn-inset text-rn-ink-2" : undefined}>{t(`origin.${origin}`)}</RnTag>;
}

/** 사용 중 = a filled navy dot (as "measured" on Global prompts); archived / left Gold = a dashed one, muted. */
function StatusMark({ status }: { status: HubPrompt["status"] }) {
  const t = useTranslations("hubPrompts");
  return (
    <span className={cx("inline-flex max-w-full items-center gap-1.5 text-rn-12", status === "active" ? "text-rn-ink" : "text-rn-muted")}>
      <i aria-hidden className={cx("inline-block size-2 shrink-0 rounded-full", status === "active" ? "bg-rn-navy" : "border border-dashed border-rn-muted")} />
      <span className="truncate">{t(`status.${status}`)}</span>
    </span>
  );
}

function formatTime(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

function formatDate(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(iso));
}

// ─── sheet: an existing prompt ──────────────────────────────────────────────

function Detail({ id, options, loginHref, onChanged }: { id: string; options: HubOptions; loginHref: string; onChanged: (item: HubPrompt, message: string) => void }) {
  const t = useTranslations("hubPrompts");
  const tv = useTranslations("standardPromptsView");
  const tVal = useTranslations("dashboard.filters.value");
  const tp = useTranslations("renewal.prompts");
  const locale = useLocale();
  const fieldLabel = useFieldLabel();
  const marketLabel = useRnMarketLabel();
  const [detail, setDetail] = useState<HubPromptDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<HubRequestError | null>(null);
  // kept here: a version conflict reloads the prompt, which re-mounts the form with the latest version
  const [conflict, setConflict] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    hubApi.detail(id).then(
      (d) => live && (setDetail(d), setError(null)),
      (e) => live && setError(e instanceof HubRequestError ? e.code : "failed"),
    );
    return () => {
      live = false;
    };
  }, [id, nonce]);

  if (error) return <ErrorNote code={error} loginHref={loginHref} />;
  if (!detail) {
    return (
      <p className="flex items-center gap-2 text-rn-13 text-rn-muted">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        {t("loading")}
      </p>
    );
  }
  const { item, history } = detail;
  const done = (next: HubPrompt, message: string) => {
    setConflict(false);
    setEditing(false);
    setNonce((n) => n + 1);
    onChanged(next, message);
  };
  const setStatus = async (action: "archive" | "restore") => {
    setPending(true);
    setFailure(null);
    try {
      const out = await hubApi.setStatus(item.id, item.version, action);
      done(out.item, t(action === "archive" ? "toast.archived" : "toast.restored"));
    } catch (e) {
      const err = e instanceof HubRequestError ? e : new HubRequestError(0, "failed");
      setFailure(err);
      if (err.code === "version_conflict") setNonce((n) => n + 1);
    } finally {
      setPending(false);
    }
  };
  const show = (v: unknown) => (Array.isArray(v) ? v.join(", ") || null : v == null || v === "" ? null : String(v));
  const markets = splitMarkets(item.regions);

  return (
    <div className="flex flex-col gap-6">
      {item.status === "removed" ? <RnNote>{t("removedNote")}</RnNote> : !item.editable ? <RnNote>{t("goldReadOnly")}</RnNote> : item.status === "archived" ? <RnNote>{t("archivedNote")}</RnNote> : null}
      {conflict ? <ErrorNote code="version_conflict" loginHref={loginHref} /> : null}
      {editing ? (
        <HubPromptForm
          key={`${item.id}:${item.version}`}
          item={item}
          options={options}
          loginHref={loginHref}
          onSaved={(next) => done(next, t("toast.updated"))}
          onConflict={() => {
            setConflict(true);
            setNonce((n) => n + 1);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <>
          <RnPromptText
            text={item.text}
            actions={
              item.editable && item.status === "active" ? (
                <>
                  <RnButton size="sm" onClick={() => setEditing(true)} data-hub-edit="">
                    <Pencil className="size-3.5" aria-hidden />
                    {t("edit")}
                  </RnButton>
                  <RnButton size="sm" className="ml-auto" disabled={pending} onClick={() => void setStatus("archive")} data-hub-archive="">
                    <Archive className="size-3.5" aria-hidden />
                    {t("archive")}
                  </RnButton>
                </>
              ) : item.editable && item.status === "archived" ? (
                <RnButton size="sm" variant="primary" className="ml-auto" disabled={pending} onClick={() => void setStatus("restore")} data-hub-restore="">
                  <RotateCcw className="size-3.5" aria-hidden />
                  {t("restore")}
                </RnButton>
              ) : null
            }
          />
          {failure ? <ErrorNote code={failure.code} fields={failure.details?.fields} loginHref={loginHref} /> : null}
          <section>
            <h3 className="m-0 mb-2 text-rn-13 font-bold text-rn-ink">{tp("detail.attributes")}</h3>
            <dl className="m-0 grid grid-cols-[112px_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-rn-13">
              <RnDetailField label={t("originLabel")}>
                <OriginTag origin={item.origin} />
              </RnDetailField>
              <RnDetailField label={fieldLabel("brandPresence")}>{item.brandPresence ? (item.brandPresence === "branded" || item.brandPresence === "unbranded" ? tVal(item.brandPresence) : item.brandPresence) : null}</RnDetailField>
              <RnDetailField label={fieldLabel("language")}>{item.language ? `${languageName(item.language, locale)} (${item.language.toUpperCase()})` : null}</RnDetailField>
              {TAXONOMY.filter((f) => f !== "depth4" || item[f]).map((f) => (
                <RnDetailField key={f} label={fieldLabel(f)}>
                  {item[f]}
                </RnDetailField>
              ))}
              <RnDetailField label={fieldLabel("funnel")}>{item.funnel}</RnDetailField>
              <RnDetailField label={fieldLabel("regions")}>
                <RnMarketList codes={[...markets.real, ...markets.pseudo]} labelOf={marketLabel} allLabel={tv("marketAll")} allHint={tv("marketAllHint")} />
              </RnDetailField>
              <RnDetailField label={fieldLabel("kind")}>{item.kind === "acr" ? tv("kindAcr") : tv("kindSingle")}</RnDetailField>
              <RnDetailField label={t("statusLabel")}>
                <StatusMark status={item.status} />
              </RnDetailField>
              <RnDetailField label={t("version")}>
                <span className="tabular-nums">
                  v{item.version} · {formatTime(item.recordedAt, locale)}
                </span>
              </RnDetailField>
              <RnDetailField label={t("registeredAt")}>
                <span className="tabular-nums">{formatTime(item.registeredAt, locale)}</span>
              </RnDetailField>
            </dl>
          </section>
        </>
      )}
      <section data-hub-history="">
        <h3 className="m-0 mb-3 text-rn-13 font-bold text-rn-ink">{tp("detail.history")}</h3>
        <RnTimeline
          fieldLabel={fieldLabel}
          events={history.map((e) => ({
            key: String(e.version),
            label: t(`event.${e.event}`),
            at: e.recordedAt,
            actor: e.actor ? e.actor.displayName || e.actor.login : (e.recordedBy ?? t("goldSync")),
            marks: [`v${e.version}`],
            changes: Object.fromEntries(Object.entries(e.changes).map(([f, c]) => [f, { old: show(c.old), new: show(c.new) }])),
            note: e.event === "updated" ? t("goldOnlyChange") : undefined,
          }))}
        />
      </section>
    </div>
  );
}
