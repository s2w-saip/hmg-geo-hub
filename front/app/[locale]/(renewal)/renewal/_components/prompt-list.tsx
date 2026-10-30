"use client";

// Parts the two renewal prompt lists share (2026-10-28), so they read as one screen: Global › Global
// prompts (standard/prompts/_components/prompts-view.tsx) and Admin › Global prompts
// (admin/standards/prompts/_components/hub-prompts-manager.tsx).
//   panel     the left filter panel of single-choice axes ("all" = 전체), its rail
//   list      the one-line list's cell classes, sortable column heads, market cell and pager
//   sheet     the detail sheet's attribute rows, market list and change timeline

import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ArrowDown, ArrowUp, Bookmark, ChevronLeft, ChevronRight, Copy, Globe, PanelLeft, Tag } from "lucide-react";
import { RnButton, RnCheckRow, RnCountBadge, RnIconButton, RnPanelSection, RnSearchField, RnSelect, cx, useRnToast } from "@/components/renewal-ui";
import { countryName } from "@/lib/geo-catalog/country-name";
import type { PromptAuditChanges } from "@/lib/standards/audit";
import { isPseudoRegion, pseudoRegionLabelKey } from "@/lib/standards/prompt-markets";
import { useRnSplit } from "./filter-split";

const ALL = "all";
const SEARCH_MIN = 8;

/** A target market's label: the country name, a pseudo region's label (x:WW), else the code. */
export function useRnMarketLabel() {
  const tVal = useTranslations("dashboard.filters.value");
  const locale = useLocale();
  return useCallback(
    (code: string) => {
      if (!isPseudoRegion(code)) return countryName(code, locale);
      const key = pseudoRegionLabelKey(code);
      return key ? tVal(key as "pseudoWorldwide") : code;
    },
    [locale, tVal],
  );
}

// ─── panel ───────────────────────────────────────────────────────────────────

/** The filter panel: its head (picked axes · reset · collapse), the saved filters, then the axes. */
export function RnFilterPanel({ count, onReset, saved, children }: { count: number; onReset: () => void; saved: ReactNode; children: ReactNode }) {
  const tf = useTranslations("dashboard.filters");
  const tr = useTranslations("renewal.filters");
  const { collapse } = useRnSplit();
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
        {children}
      </div>
      <div className="h-3" />
    </aside>
  );
}

/** The collapsed panel: expand (with the picked-axis count) and open the saved filters. */
export function RnFilterRail({ count }: { count: number }) {
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

/**
 * One axis of the panel: "전체" and the values as radios, a search box from 8 values. The head shows the
 * picked value unless it is the axis default (`defaultValue`, "all" unless the list says otherwise).
 */
export function RnRadioAxis({
  axis,
  label,
  value,
  defaultValue = ALL,
  options,
  valueLabel,
  allLabel,
  open,
  onToggle,
  onPick,
}: {
  axis: string;
  label: string;
  value: string;
  defaultValue?: string;
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
    <RnPanelSection title={label} open={open} onToggle={onToggle} summary={value !== defaultValue ? valueLabel(value) : undefined} focusKey={`s:${axis}`}>
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

// ─── list ────────────────────────────────────────────────────────────────────

// Cell classes of the one-line list: every cell one 40px line, cut off with "…".
// The head sticks at the scrolling area's top edge: -top-1 takes back its 4px top padding (filter-split FRAME_SCROLL).
export const LIST_TH = "sticky -top-1 z-[1] h-[38px] border-b border-rn-line-2 bg-rn-surface px-3 font-semibold";
export const LIST_TD = "h-10 border-b border-rn-line px-3 align-middle";

/** A column head that sorts by its attribute; `onSort` flips the direction of the active one. */
export function RnSortHead<K extends string>({ sortKey, label, sort, onSort, className }: { sortKey: K; label: string; sort: { key: K; asc: boolean }; onSort: (key: K) => void; className?: string }) {
  const active = sort.key === sortKey;
  return (
    <th scope="col" aria-sort={active ? (sort.asc ? "ascending" : "descending") : undefined} className={cx(LIST_TH, className)}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cx("inline-flex max-w-full cursor-pointer items-center gap-1 rounded-[3px] hover:text-rn-ink focus-visible:outline-2 focus-visible:outline-rn-navy", active && "text-rn-ink")}
      >
        <span className="truncate">{label}</span>
        {active ? sort.asc ? <ArrowUp className="size-3 shrink-0" aria-hidden /> : <ArrowDown className="size-3 shrink-0" aria-hidden /> : null}
      </button>
    </th>
  );
}

/** A prompt's funnel stage as a navy chip, or "—". */
export function RnFunnelChip({ value }: { value: string | null }) {
  return value ? (
    <span data-rn-tip="" className="inline-block max-w-full truncate rounded-md bg-rn-navy/8 px-1.5 py-px align-middle text-rn-12 font-semibold text-rn-navy">
      {value}
    </span>
  ) : (
    <span className="text-rn-faint">—</span>
  );
}

/** A prompt's measurement kind: ACR outlined in navy, single muted. */
export function RnKindMark({ acr }: { acr: boolean }) {
  const t = useTranslations("standardPromptsView");
  return acr ? (
    <span className="rounded-md px-1.5 py-px font-bold text-rn-navy shadow-[inset_0_0_0_1px_var(--color-rn-navy-300)]">{t("kindAcr")}</span>
  ) : (
    <span className="text-rn-muted">{t("kindSingle")}</span>
  );
}

/**
 * One line of a prompt's markets (real countries first, then pseudo slots; none = "전체"): the first
 * market and "+N", the full list on hover and in the detail sheet.
 */
export function RnMarkets({ markets, labelOf, allLabel, allHint }: { markets: { real: string[]; pseudo: string[] }; labelOf: (c: string) => string; allLabel: string; allHint: string }) {
  const codes = [...markets.real, ...markets.pseudo];
  if (codes.length === 0) {
    return (
      <span data-rn-tip={allHint} className="inline-flex items-center gap-1 rounded-md bg-rn-inset px-1.5 py-px align-middle text-rn-12 text-rn-ink-2">
        <Globe className="size-3" aria-hidden />
        {allLabel}
      </span>
    );
  }
  const [first, ...rest] = codes;
  const pseudo = isPseudoRegion(first);
  return (
    <span data-rn-tip={rest.length ? codes.map(labelOf).join(" · ") : undefined} className="flex min-w-0 items-center gap-1">
      <span
        data-rn-tip={rest.length ? undefined : ""}
        className={cx(
          "inline-flex min-w-0 items-center gap-1 rounded-md px-1.5 py-px text-rn-12",
          pseudo ? "border border-dashed border-rn-faint text-rn-muted" : "bg-rn-inset text-rn-ink-2",
        )}
      >
        {pseudo ? <Tag className="size-3 shrink-0" aria-hidden /> : null}
        <span className="truncate">{labelOf(first)}</span>
      </span>
      {rest.length ? <span className="shrink-0 rounded-md px-1.5 py-px text-rn-12 text-rn-muted tabular-nums shadow-[inset_0_0_0_1px_var(--color-rn-line-2)]">+{rest.length}</span> : null}
    </span>
  );
}

/** The list's foot: the shown range, rows per page, and the page buttons. */
export function RnListPager({
  rangeFrom,
  rangeTo,
  total,
  page,
  pages,
  pageSize,
  pageSizes,
  onPageSize,
  onPage,
}: {
  rangeFrom: number;
  rangeTo: number;
  total: number;
  page: number;
  pages: number;
  pageSize: number;
  pageSizes: readonly number[];
  onPageSize: (n: number) => void;
  onPage: (page: number) => void;
}) {
  const t = useTranslations("standardPromptsView");
  const locale = useLocale();
  // thousands grouped ("1–50 / 12,164"), as the counts beside the list
  const num = (n: number) => n.toLocaleString(locale);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-rn-12 text-rn-muted">
      <span className="flex items-center gap-2">
        <span className="tabular-nums">{t("pageRange", { from: num(rangeFrom), to: num(rangeTo), total: num(total) })}</span>
        <RnSelect
          label={t("pageSize")}
          value={String(pageSize)}
          onChange={(e) => onPageSize(Number(e.target.value))}
          options={pageSizes.map((n) => ({ value: String(n), label: `${t("pageSize")} ${n}` }))}
        />
      </span>
      {pages > 1 ? (
        <span className="flex items-center gap-2">
          <RnButton size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
            <ChevronLeft className="size-3.5" aria-hidden />
            {t("prev")}
          </RnButton>
          <span className="tabular-nums">{t("pageOf", { page: num(page), pages: num(pages) })}</span>
          <RnButton size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
            {t("next")}
            <ChevronRight className="size-3.5" aria-hidden />
          </RnButton>
        </span>
      ) : null}
    </div>
  );
}

// ─── detail sheet ────────────────────────────────────────────────────────────

/** The sheet's head: the prompt's full text and "문장 복사" (`actions` after it). */
export function RnPromptText({ text, actions }: { text: string; actions?: ReactNode }) {
  const tp = useTranslations("renewal.prompts");
  const toast = useRnToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast(tp("detail.copied"));
    } catch {
      toast(tp("detail.copyFailed"));
    }
  };
  return (
    <section className="flex flex-col gap-2">
      <p className="m-0 rounded-xl bg-rn-page px-4 py-3 text-rn-15 leading-relaxed break-words whitespace-pre-wrap text-rn-ink">{text}</p>
      <div className="flex flex-wrap items-center gap-2">
        <RnButton size="sm" onClick={copy}>
          <Copy className="size-3.5" aria-hidden />
          {tp("detail.copy")}
        </RnButton>
        {actions}
      </div>
    </section>
  );
}

/** One attribute row of the sheet's list (an empty value shows "—"). */
export function RnDetailField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-rn-12 font-semibold text-rn-muted">{label}</dt>
      <dd className="m-0 min-w-0 break-words text-rn-ink">{children ?? <span className="text-rn-faint">—</span>}</dd>
    </>
  );
}

/** Every market of a prompt, or "전체" and what it means. */
export function RnMarketList({ codes, labelOf, allLabel, allHint }: { codes: string[]; labelOf: (c: string) => string; allLabel: string; allHint: string }) {
  return codes.length ? (
    <span className="flex flex-wrap gap-1">
      {codes.map((code) => (
        <span
          key={code}
          className={cx(
            "inline-flex items-center gap-1 rounded-md px-1.5 py-px text-rn-12",
            isPseudoRegion(code) ? "border border-dashed border-rn-faint text-rn-muted" : "bg-rn-inset text-rn-ink-2",
          )}
        >
          {isPseudoRegion(code) ? <Tag className="size-3" aria-hidden /> : null}
          {labelOf(code)}
        </span>
      ))}
    </span>
  ) : (
    <span className="flex flex-col items-start gap-1">
      <span className="inline-flex items-center gap-1 rounded-md bg-rn-inset px-1.5 py-px text-rn-12 text-rn-ink-2">
        <Globe className="size-3" aria-hidden />
        {allLabel}
      </span>
      <span className="text-rn-12 text-rn-muted">{allHint}</span>
    </span>
  );
}

/** What one change did: the text as a before / after toggle, other fields as old → new. */
export function RnChanges({ changes, textToggle, fieldLabel = (f) => f }: { changes: PromptAuditChanges; textToggle: string; fieldLabel?: (field: string) => string }) {
  const t = useTranslations("promptAudit");
  return (
    <div className="flex flex-col gap-1.5">
      {Object.entries(changes).map(([field, c]) =>
        field === "text" ? (
          <details key={field} className="group/text">
            <summary className="cursor-pointer list-none text-rn-12 font-semibold text-rn-navy underline decoration-dotted underline-offset-3 [&::-webkit-details-marker]:hidden">{textToggle}</summary>
            <div className="mt-1.5 grid grid-cols-2 gap-2 text-rn-12">
              <div className="flex flex-col gap-0.5">
                <span className="text-rn-11 font-semibold text-rn-muted">{t("diffOld")}</span>
                <p className="m-0 rounded-md bg-rn-page p-2 whitespace-pre-wrap text-rn-muted">{c.old ?? "—"}</p>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-rn-11 font-semibold text-rn-muted">{t("diffNew")}</span>
                <p className="m-0 rounded-md bg-rn-page p-2 whitespace-pre-wrap text-rn-ink">{c.new ?? "—"}</p>
              </div>
            </div>
          </details>
        ) : (
          <p key={field} className="m-0 text-rn-12 break-all text-rn-muted">
            <span className="font-semibold text-rn-ink-2">{fieldLabel(field)}</span>
            {": "}
            <span className="line-through decoration-rn-down/40">{c.old ?? "—"}</span>
            {" → "}
            <span className="text-rn-ink">{c.new ?? "—"}</span>
          </p>
        ),
      )}
    </div>
  );
}

export interface RnTimelineEvent {
  key: string;
  /** The event's name (생성 · 수정 · …). */
  label: string;
  at: string;
  actor: string;
  /** Small outlined marks after the actor (a bulk change, a version). */
  marks?: string[];
  changes: PromptAuditChanges;
  /** Shown instead of the changes when there are none. */
  note?: string;
}

/** A prompt's change history, newest first: a dot per event on one line down the left. */
export function RnTimeline({ events, fieldLabel }: { events: RnTimelineEvent[]; fieldLabel?: (field: string) => string }) {
  const th = useTranslations("promptAudit.history");
  const locale = useLocale();
  const fmt = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }), [locale]);
  return (
    <ol className="m-0 flex list-none flex-col gap-0 p-0">
      {events.map((ev, i) => (
        <li key={ev.key} className="relative grid grid-cols-[16px_minmax(0,1fr)] gap-3 pb-4">
          <span aria-hidden className={cx("mt-1 size-2.5 rounded-full", i === 0 ? "bg-rn-navy" : "bg-rn-navy-300")} />
          {i < events.length - 1 ? <span aria-hidden className="absolute top-4 bottom-0 left-[4px] w-px bg-rn-line-2" /> : null}
          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2 text-rn-12">
              <span className="rounded-md bg-rn-navy/8 px-1.5 py-px font-bold text-rn-navy">{ev.label}</span>
              <span className="text-rn-muted tabular-nums">{fmt.format(new Date(ev.at))}</span>
              <span className="text-rn-muted">{ev.actor}</span>
              {(ev.marks ?? []).map((m) => (
                <span key={m} className="rounded-md px-1.5 text-rn-muted shadow-[inset_0_0_0_1px_var(--color-rn-line-2)]">
                  {m}
                </span>
              ))}
            </div>
            {Object.keys(ev.changes).length || !ev.note ? <RnChanges changes={ev.changes} textToggle={th("viewTextDiff")} fieldLabel={fieldLabel} /> : <p className="m-0 text-rn-12 text-rn-muted">{ev.note}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}
