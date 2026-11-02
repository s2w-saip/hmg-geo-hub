"use client";

// Admin › 고객 관심 데이터 관리 › 키워드 (2026-11-02): the HUB owns the seed keywords (admin-todo decisions A · E, '기준값 편집
// 공통 구조'): a term, the conditions to collect it under, what it seeds and its brands. Add, edit, stop and resume save at
// once and keep the history; each row shows Gold's seed rows for the term and whether they hold every condition yet
// (back/bff/hub_stores/interest.py). Gold's seeds the HUB lacks are listed as upstream rows to take over. The original
// screen's delete is the stop here (a row is never deleted, as Admin › GA4 연동).

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import type { SavedFiltersSource } from "../../../../_components/saved-filters";
import { useAdminSavedFilters } from "../../../_components/admin-saved-filters";
import { ArrowDownWideNarrow, ArrowUpNarrowWide, History, Pause, Pencil, Play, Plus } from "lucide-react";
import {
  RnButton,
  RnCard,
  RnCheckRow,
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
import { RnFilterSplit } from "../../../../_components/filter-split";
import { LIST_TD as TD, RnDetailField, RnFilterPanel, RnFilterRail, RnRadioAxis, RnSortHead } from "../../../../_components/prompt-list";
import { HistorySection, LIST_TH_PLAIN, ListPills, StateMark, formatTime } from "../../citation-sources/_components/source-lists-kit";
import { INPUT, Row } from "../../prompts/_components/hub-prompt-form";
import { KEYWORD_SOURCES, keywordApi, type InterestBrand, type KeywordCondition, type KeywordListing, type KeywordRow, type KeywordSource } from "./interest-api";
import { BrandPicks, ConditionPicker, FormFoot, Problem, useBrandsLabel, useInterestError } from "./interest-kit";
import {
  ALL,
  COMMON,
  DEFAULT_KEYWORD_FILTER,
  DEFAULT_KEYWORD_SORT,
  KEYWORD_AXES,
  KEYWORD_SORTS,
  NOTE_MAX,
  TERM_MAX,
  conditionKey,
  conditionLabel,
  conditionOfKey,
  keywordAxisOptions,
  keywordCounts,
  keywordFilterToQuery,
  keywordFirstAsc,
  keywordMarkets,
  keywordMatches,
  keywordProblems,
  pickedKeywordAxes,
  queryToKeywordFilter,
  sortKeywords,
  type KeywordAxis,
  type KeywordFilter,
  type KeywordProblem,
  type KeywordSort,
} from "./interest-model";

type Sheet = { mode: "add"; term: string; conditions: KeywordCondition[] } | { mode: "edit"; key: string } | { mode: "detail"; key: string };

export function InterestKeywordsManager({ initial, tabs, savedFilters }: { initial: KeywordListing; tabs?: ReactNode; savedFilters: SavedFiltersSource }) {
  return (
    <RnToastProvider>
      <Manager initial={initial} tabs={tabs} savedFilters={savedFilters} />
    </RnToastProvider>
  );
}

function Manager({ initial, tabs, savedFilters }: { initial: KeywordListing; tabs?: ReactNode; savedFilters: SavedFiltersSource }) {
  const t = useTranslations("hubInterest");
  const tk = useTranslations("hubInterest.keywords");
  const tv = useTranslations("standardPromptsView");
  const tp = useTranslations("renewal.prompts");
  const tr = useTranslations("renewal.filters");
  const locale = useLocale();
  const toast = useRnToast();
  const sp = useSearchParams();
  const tip = useRnTruncTip();
  const errorText = useInterestError();
  const brandsLabel = useBrandsLabel();
  const fromUrl = useMemo(() => queryToKeywordFilter(sp), []); // eslint-disable-line react-hooks/exhaustive-deps

  const [listing, setListing] = useState(initial);
  const [filters, setFilters] = useState<KeywordFilter>(fromUrl.filters);
  const [search, setSearch] = useState(fromUrl.search);
  const [sort, setSort] = useState(DEFAULT_KEYWORD_SORT);
  const [saving, setSaving] = useState<string | null>(null);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [open, setOpen] = useState<Partial<Record<KeywordAxis, boolean>>>({ state: true, status: true });
  const nf = useMemo(() => new Intl.NumberFormat(locale), [locale]);

  const reload = () => keywordApi.list().then(setListing, (e) => toast(errorText(e)));

  // URL mirrors the picks (shareable, restorable); shallow — no server round trip.
  useEffect(() => {
    const query = keywordFilterToQuery(filters, search);
    window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
  }, [filters, search]);

  const markets = useMemo(() => keywordMarkets(listing.items), [listing.items]);
  const axisLabel = (a: KeywordAxis) => tk(`axis.${a}`);
  const valueLabel = (a: KeywordAxis, v: string) => {
    if (v === ALL) return tv("filterAll");
    if (a === "market") return conditionLabel(conditionOfKey(v), locale);
    if (a === "source") return t(`source.${v as "google_keyword"}`);
    if (a === "brand") return v === COMMON ? t("brandCommon") : v;
    if (a === "state") return tk(`state.${v as "applied"}`);
    return t(`status.${v as "active"}`);
  };
  const picked = pickedKeywordAxes(filters);
  const savedList = useAdminSavedFilters({
    source: savedFilters,
    query: keywordFilterToQuery(filters, search),
    filtered: picked.length > 0 || Boolean(search),
    apply: (q) => {
      const next = queryToKeywordFilter(q);
      setFilters(next.filters);
      setSearch(next.search);
    },
    summarize: (q) => {
      const next = queryToKeywordFilter(q);
      return [...pickedKeywordAxes(next.filters).map((a) => valueLabel(a, next.filters[a])), ...(next.search ? [`“${next.search}”`] : [])].join(" · ");
    },
  });
  const shown = useMemo(() => sortKeywords(listing.items.filter((r) => keywordMatches(r, filters, search)), sort.key, sort.asc, locale), [listing.items, filters, search, sort, locale]);
  const total = keywordCounts(listing.items);
  const head = (key: KeywordSort, className?: string) => (
    <RnSortHead sortKey={key} label={tk(`column.${key}`)} sort={sort} className={className} onSort={(k) => setSort((s) => (s.key === k ? { key: k, asc: !s.asc } : { key: k, asc: keywordFirstAsc(k) }))} />
  );

  const toggle = async (row: KeywordRow) => {
    const stopping = row.status === "active";
    setSaving(row.termNorm);
    try {
      await (stopping ? keywordApi.stop(row.term) : keywordApi.resume(row.term));
      toast(tk(stopping ? "toast.stopped" : "toast.resumed", { term: row.term }));
      await reload();
    } catch (e) {
      toast(errorText(e));
    } finally {
      setSaving(null);
    }
  };
  const saved = async (term: string) => {
    setSheet(null);
    toast(tk("toast.saved", { term }));
    await reload();
  };

  const panel = (
    <RnFilterPanel
      count={picked.length}
      onReset={() => {
        const before = filters;
        setFilters(DEFAULT_KEYWORD_FILTER);
        toast(tr("resetDone"), { undoLabel: tr("undo"), undo: () => setFilters(before) });
      }}
      saved={savedList.section}
    >
      {KEYWORD_AXES.map((a) => (
        <RnRadioAxis
          key={a}
          axis={a}
          label={axisLabel(a)}
          value={filters[a]}
          options={keywordAxisOptions(a, markets)}
          valueLabel={(v) => valueLabel(a, v)}
          allLabel={tv("filterAll")}
          open={open[a] ?? false}
          onToggle={() => setOpen((o) => ({ ...o, [a]: !(o[a] ?? false) }))}
          onPick={(v) => setFilters((f) => ({ ...f, [a]: v }))}
        />
      ))}
    </RnFilterPanel>
  );

  const sheetRow = sheet && sheet.mode !== "add" ? listing.items.find((r) => r.termNorm === sheet.key) ?? null : null;
  const sheetTitle = sheet?.mode === "add" ? tk("form.titleAdd") : sheet?.mode === "edit" ? tk("form.titleEdit") : tk("detailTitle");

  return (
    <div className="flex flex-col gap-4">
      <RnFilterSplit
        header={
          <RnPageHeader
            title={t("title")}
            meta={
              <>
                <ListPills family="interest_keyword" published={listing.published} />
                <span>{tk("description")}</span>
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
          <span>{tk("flowNote")}</span>
        </RnNote>
        {savedList.note}
        {picked.length || search ? (
          <div aria-live="polite" className="flex min-h-7 flex-wrap items-center gap-2">
            {picked.map((a) => (
              <RnToken key={a} label={axisLabel(a)} value={valueLabel(a, filters[a])} removeLabel={tr("removeToken", { label: axisLabel(a) })} onRemove={() => setFilters((f) => ({ ...f, [a]: ALL }))} />
            ))}
            {search ? <RnToken label={t("searchLabel")} value={`“${search}”`} removeLabel={tr("removeToken", { label: t("searchLabel") })} onRemove={() => setSearch("")} /> : null}
          </div>
        ) : null}
        <RnCard aria-label={tk("listLabel")}>
          <div className="flex flex-wrap items-center gap-2 border-b border-rn-line px-5 py-3">
            <RnButton size="sm" variant="primary" disabled={saving != null} onClick={() => setSheet({ mode: "add", term: "", conditions: [] })} data-hub-keyword-add="">
              <Plus className="size-3.5" aria-hidden />
              {tk("add")}
            </RnButton>
            <RnSearchField id="rn-hub-keyword-search" className="w-full max-w-[280px] min-w-[180px] flex-1" value={search} onChange={setSearch} placeholder={tk("searchPlaceholder")} label={t("searchLabel")} />
            <RnSelect
              label={tp("sortLabel")}
              value={sort.key}
              onChange={(e) => {
                const key = e.target.value as KeywordSort;
                setSort({ key, asc: keywordFirstAsc(key) });
              }}
              options={KEYWORD_SORTS.map((k) => ({ value: k, label: tk(`column.${k}`) }))}
            />
            <RnIconButton label={sort.asc ? tp("sortAsc") : tp("sortDesc")} onClick={() => setSort((s) => ({ key: s.key, asc: !s.asc }))}>
              {sort.asc ? <ArrowUpNarrowWide className="size-4" aria-hidden /> : <ArrowDownWideNarrow className="size-4" aria-hidden />}
            </RnIconButton>
            <span className="ml-auto text-rn-12 text-rn-muted tabular-nums" data-hub-keyword-count="">
              {tk("count", { shown: nf.format(shown.length), total: nf.format(total.total), active: nf.format(total.active), stopped: nf.format(total.stopped), pending: nf.format(total.pending), upstream: nf.format(total.upstream) })}
            </span>
          </div>
          {shown.length === 0 ? (
            <RnEmpty className="m-5">{listing.items.length ? tk("emptyFiltered") : tk("empty")}</RnEmpty>
          ) : (
            <div {...tip.bind}>
              <table className="w-full table-fixed border-separate border-spacing-0 text-rn-13" data-hub-keyword-table="">
                <colgroup>
                  <col />
                  <col className="w-[210px]" />
                  <col className="w-[148px]" />
                  <col className="w-[116px]" />
                  <col className="w-[148px]" />
                  <col className="w-[104px]" />
                  <col className="w-[72px]" />
                  <col className="w-[176px]" />
                </colgroup>
                <thead>
                  <tr className="text-left text-rn-12 text-rn-muted">
                    {head("term", "pl-5")}
                    {head("conditions")}
                    <th className={LIST_TH_PLAIN}>{tk("column.source")}</th>
                    <th className={LIST_TH_PLAIN}>{tk("column.brand")}</th>
                    {head("observed")}
                    {head("state")}
                    <th className={LIST_TH_PLAIN}>{tk("column.status")}</th>
                    <th className={cx(LIST_TH_PLAIN, "pr-5 text-right")}>{tk("column.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((row) => {
                    const busy = saving != null;
                    const hub = row.status != null;
                    const labels = row.conditions.map((c) => conditionLabel(c, locale));
                    return (
                      <tr key={row.termNorm} data-hub-keyword-row={row.termNorm} className="hover:bg-rn-navy-25/60">
                        <td className={cx(TD, "pl-5")}>
                          <span data-rn-tip="" className={cx("block min-w-0 truncate font-semibold", row.status === "stopped" ? "text-rn-muted line-through" : "text-rn-ink")}>
                            {row.term}
                          </span>
                        </td>
                        <td className={cx(TD, "text-rn-12 text-rn-ink-2")}>
                          <span data-rn-tip={labels.join(", ")} className="block truncate" data-hub-keyword-conditions={row.conditions.length}>
                            {labels.length > 1 ? tk("conditionsMore", { first: labels[0], more: labels.length - 1 }) : labels[0]}
                          </span>
                        </td>
                        <td className={TD}>
                          {row.sourceTypes.length ? (
                            <span className="flex flex-wrap gap-1">
                              {row.sourceTypes.map((s) => (
                                <RnTag key={s}>{t(`sourceShort.${s}`)}</RnTag>
                              ))}
                            </span>
                          ) : (
                            <span className="text-rn-12 text-rn-faint">—</span>
                          )}
                        </td>
                        <td className={cx(TD, "text-rn-12 text-rn-ink-2")}>{hub ? <span data-rn-tip="" className="block truncate">{brandsLabel(row.brands)}</span> : <span className="text-rn-faint">—</span>}</td>
                        <td className={cx(TD, "text-rn-12 text-rn-ink-2 tabular-nums")}>
                          <span data-rn-tip={row.gold ? tk("goldTip", { collected: row.collected, total: row.conditions.length }) : tk("goldNone")} className="block truncate" data-hub-keyword-gold={row.collected}>
                            {row.gold ? `${row.collected}/${row.conditions.length} · ${row.gold.observedAt.slice(0, 10)}` : "—"}
                          </span>
                        </td>
                        <td className={TD}>
                          <KeywordState row={row} />
                        </td>
                        <td className={cx(TD, "text-rn-12")}>{row.status ? t(`status.${row.status}`) : <span className="text-rn-faint">—</span>}</td>
                        <td className={cx(TD, "pr-5")}>
                          <span className="flex items-center justify-end gap-1">
                            {hub ? (
                              <>
                                <RnIconButton label={`${tk("edit")} · ${row.term}`} disabled={busy} onClick={() => setSheet({ mode: "edit", key: row.termNorm })} data-hub-keyword-edit={row.termNorm}>
                                  <Pencil className="size-4" aria-hidden />
                                </RnIconButton>
                                <RnButton size="sm" disabled={busy} onClick={() => void toggle(row)} data-hub-keyword-toggle={row.termNorm}>
                                  {row.status === "active" ? <Pause className="size-3.5" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
                                  {t(row.status === "active" ? "stop" : "resume")}
                                </RnButton>
                                <RnIconButton label={t("historyOpen", { name: row.term })} onClick={() => setSheet({ mode: "detail", key: row.termNorm })} data-hub-keyword-history={row.termNorm}>
                                  <History className="size-4" aria-hidden />
                                </RnIconButton>
                              </>
                            ) : (
                              <RnButton size="sm" disabled={busy} onClick={() => setSheet({ mode: "add", term: row.term, conditions: row.conditions })} data-hub-keyword-adopt={row.termNorm}>
                                <Plus className="size-3.5" aria-hidden />
                                {tk("addAsKeyword")}
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
          <p className="m-0 border-t border-rn-line px-5 py-2.5 text-rn-11 text-rn-muted">{tk("hint")}</p>
        </RnCard>
      </RnFilterSplit>
      <RnDrawer open={sheet != null} onClose={() => setSheet(null)} title={sheetTitle} closeLabel={tp("close")}>
        {sheet?.mode === "add" ? (
          <KeywordForm key={`add:${sheet.term}`} initial={{ term: sheet.term, conditions: sheet.conditions, sourceTypes: ["google_keyword"], brands: [], note: "" }} editing={false} exists={(k) => listing.items.some((r) => r.termNorm === k && r.status != null)} onSaved={saved} onCancel={() => setSheet(null)} />
        ) : sheet?.mode === "edit" && sheetRow ? (
          <KeywordForm key={`edit:${sheetRow.termNorm}:${sheetRow.updatedAt ?? ""}`} initial={{ term: sheetRow.term, conditions: sheetRow.conditions, sourceTypes: sheetRow.sourceTypes, brands: sheetRow.brands, note: sheetRow.note ?? "" }} editing exists={() => false} onSaved={saved} onCancel={() => setSheet(null)} />
        ) : sheet?.mode === "detail" && sheetRow ? (
          <KeywordDetail key={sheetRow.termNorm} row={sheetRow} />
        ) : null}
      </RnDrawer>
    </div>
  );
}

/** 반영됨 / 반영 대기 / 업스트림 키워드 / — (a stopped keyword: nothing to compare). */
export function KeywordState({ row }: { row: KeywordRow }) {
  const tk = useTranslations("hubInterest.keywords");
  return <StateMark state={row.state} attr="data-hub-keyword-state" label={row.state ? tk(`state.${row.state}`) : "—"} tip={tk(`stateTip.${row.state ?? "none"}`)} />;
}

export function KeywordForm({
  initial,
  editing,
  exists,
  onSaved,
  onCancel,
}: {
  initial: { term: string; conditions: readonly KeywordCondition[]; sourceTypes: readonly KeywordSource[]; brands: readonly InterestBrand[]; note: string };
  editing: boolean;
  exists: (termNorm: string) => boolean;
  onSaved: (term: string) => void | Promise<void>;
  onCancel: () => void;
}) {
  const t = useTranslations("hubInterest");
  const tk = useTranslations("hubInterest.keywords");
  const errorText = useInterestError();
  const [term, setTerm] = useState(initial.term);
  const [conditions, setConditions] = useState<KeywordCondition[]>(initial.conditions.map((c) => ({ ...c })));
  const [sourceTypes, setSourceTypes] = useState<KeywordSource[]>([...initial.sourceTypes]);
  const [brands, setBrands] = useState<InterestBrand[]>([...initial.brands]);
  const [note, setNote] = useState(initial.note);
  const [tried, setTried] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const problems = keywordProblems({ term, conditions, sourceTypes, note });
  const duplicate = !editing && exists(term.trim().toLowerCase());
  const shown = (p: KeywordProblem) => tried && problems.includes(p);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTried(true);
    if (pending || problems.length || duplicate) return;
    setPending(true);
    setFailure(null);
    try {
      const out = await keywordApi.set({ term: term.trim(), conditions, sourceTypes, brands, note: note.trim() || null });
      await onSaved(out.term);
    } catch (err) {
      setFailure(errorText(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" data-hub-keyword-form={editing ? "edit" : "add"} noValidate>
      <Row label={t("field.term")} htmlFor="hub-keyword-term" invalid={shown("term") || (tried && duplicate)}>
        {editing ? (
          <span className="text-rn-13 font-semibold text-rn-ink">{term}</span>
        ) : (
          <>
            <input id="hub-keyword-term" className={INPUT} value={term} onChange={(e) => setTerm(e.target.value)} placeholder={tk("form.termPlaceholder")} autoComplete="off" spellCheck={false} maxLength={TERM_MAX + 20} aria-invalid={shown("term") || undefined} data-hub-keyword-term="" autoFocus />
            <p className="m-0 mt-1 text-rn-11 text-rn-muted">{tk("form.termHint")}</p>
          </>
        )}
        {shown("term") ? <Problem attr="term">{tk("form.problem.term")}</Problem> : null}
        {tried && duplicate ? <Problem attr="duplicate">{tk("form.problem.duplicate")}</Problem> : null}
      </Row>
      <Row label={t("field.conditions")} invalid={shown("conditions")} top>
        <ConditionPicker value={conditions} onChange={setConditions} invalid={shown("conditions")} />
        {shown("conditions") ? <Problem attr="conditions">{tk("form.problem.conditions")}</Problem> : null}
      </Row>
      <Row label={t("field.source_types")} invalid={shown("sources")} top>
        <div className="flex flex-col" data-hub-keyword-sources="">
          {KEYWORD_SOURCES.map((s) => (
            <RnCheckRow key={s} checked={sourceTypes.includes(s)} label={t(`source.${s}`)} onToggle={() => setSourceTypes(KEYWORD_SOURCES.filter((x) => (x === s ? !sourceTypes.includes(s) : sourceTypes.includes(x))))} />
          ))}
        </div>
        {shown("sources") ? <Problem attr="sources">{tk("form.problem.sources")}</Problem> : null}
      </Row>
      <Row label={t("field.brands")} top>
        <BrandPicks value={brands} onChange={setBrands} />
      </Row>
      <Row label={t("field.note")} htmlFor="hub-keyword-note" invalid={shown("note")} top>
        <textarea id="hub-keyword-note" className={cx(INPUT, "h-20 py-2")} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("notePlaceholder")} maxLength={NOTE_MAX + 20} data-hub-keyword-note="" />
        {shown("note") ? <Problem attr="note">{t("noteProblem")}</Problem> : null}
      </Row>
      <FormFoot failure={failure} pending={pending} onCancel={onCancel} />
    </form>
  );
}

function KeywordDetail({ row }: { row: KeywordRow }) {
  const t = useTranslations("hubInterest");
  const tk = useTranslations("hubInterest.keywords");
  const locale = useLocale();
  const errorText = useInterestError();
  const brandsLabel = useBrandsLabel();
  const value = (field: string, v: unknown): string | null => {
    if (v == null) return null;
    if (field === "status") return t(`status.${v as "active"}`);
    if (field === "conditions" && Array.isArray(v)) return (v as KeywordCondition[]).map((c) => conditionLabel(c, locale)).join(", ");
    if (field === "source_types" && Array.isArray(v)) return (v as KeywordSource[]).map((s) => t(`source.${s}`)).join(", ");
    if (field === "brands" && Array.isArray(v)) return brandsLabel(v as string[]);
    return String(v);
  };
  const gold = new Map((row.gold?.conditions ?? []).map((c) => [conditionKey(c), c.observedAt]));
  const extra = (row.gold?.conditions ?? []).filter((c) => !row.conditions.some((x) => conditionKey(x) === conditionKey(c)));
  return (
    <div className="flex flex-col gap-6" data-hub-keyword-detail={row.termNorm}>
      <section className="flex flex-col gap-3">
        <b className="min-w-0 truncate text-rn-16 text-rn-ink">{row.term}</b>
        <dl className="m-0 grid grid-cols-[112px_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-rn-13">
          <RnDetailField label={t("field.conditions")}>
            <ul className="m-0 flex list-none flex-col gap-1 p-0 text-rn-12" data-hub-keyword-detail-conditions="">
              {row.conditions.map((c) => {
                const at = gold.get(conditionKey(c));
                return (
                  <li key={conditionKey(c)}>
                    {conditionLabel(c, locale)} <span className="text-rn-muted">· {at ? tk("collectedAt", { at: formatTime(at, locale) }) : tk("notCollected")}</span>
                  </li>
                );
              })}
            </ul>
          </RnDetailField>
          {extra.length ? (
            <RnDetailField label={tk("field.goldExtra")}>
              <ul className="m-0 flex list-none flex-col gap-1 p-0 text-rn-12">
                {extra.map((c) => (
                  <li key={conditionKey(c)}>
                    {conditionLabel(c, locale)} <span className="text-rn-muted">· {tk("collectedAt", { at: formatTime(c.observedAt, locale) })}</span>
                  </li>
                ))}
              </ul>
            </RnDetailField>
          ) : null}
          <RnDetailField label={t("field.source_types")}>{row.sourceTypes.map((s) => t(`source.${s}`)).join(", ") || null}</RnDetailField>
          <RnDetailField label={t("field.brands")}>{row.status ? brandsLabel(row.brands) : null}</RnDetailField>
          <RnDetailField label={t("field.status")}>{row.status ? t(`status.${row.status}`) : null}</RnDetailField>
          <RnDetailField label={t("field.origin")}>{row.origin ? tk(`origin.${row.origin}`) : null}</RnDetailField>
          <RnDetailField label={tk("field.state")}>
            <KeywordState row={row} />
          </RnDetailField>
          <RnDetailField label={t("field.note")}>{row.note}</RnDetailField>
        </dl>
      </section>
      <HistorySection load={() => keywordApi.history(row.term)} version={`${row.termNorm}:${row.updatedAt ?? ""}`} eventLabel={(a) => t(`event.${a as "add"}`)} fieldLabel={(f) => t(`field.${f as "note"}`)} value={value} errorText={errorText} />
    </div>
  );
}
