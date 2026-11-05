"use client";

import { Suspense, createContext, use, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { Bookmark, CalendarDays, ChevronLeft, Link2, Loader2, PanelLeft } from "lucide-react";
import {
  DIMENSIONS,
  ENGINE_LABEL,
  LABELED_VALUES,
  buildCommitParams,
  competitorAxisEnabled,
  isoDay,
  resolveTimeRangeView,
  shownTimeRange,
  type DimensionGroup,
  type Draft,
} from "@/components/dash/dimension-filter-panel";
import { encodeTimeRange, splitFilterValues } from "@/components/dash/filter-encoding";
import { kstToday } from "@/components/dash/selectable-dates";
import { ServiceWeekShownEnd, useServiceWeekEnd } from "@/components/service-week/provider";
import { isRegionSelected, toggleRhqRegion } from "@/components/dash/rhq-region-toggle";
import { geoCodeLabel } from "@/lib/geo-catalog/geo-code-label";
import { citationCategorySlug } from "@/lib/citation-categorizer/taxonomy";
import { rhqLabel } from "@/lib/rhq";
import {
  RnButton,
  RnCheckRow,
  RnCountBadge,
  RnGroupHeader,
  RnIconButton,
  RnNote,
  RnPanelGroupLabel,
  RnPanelSection,
  RnRoundCalendar,
  RnSearchField,
  RnTextButton,
  RnToken,
  useRnToast,
} from "@/components/renewal-ui";
import {
  axisOptions,
  clearGroup,
  customAxisOf,
  geographyGroupOf,
  normalizeDraft,
  overviewPanelModel,
  settleDraft,
  toggleValue,
  type OverviewPanelInput,
  type OverviewPanelModel,
  type PanelAxis,
} from "./overview-filter-model";
import { useRnFilterRuntime } from "./filter-runtime";
import { useRnSplit } from "./filter-split";
export { RnFilterSplit } from "./filter-split";
import { RnSavedFiltersSection, sameQuery, useSavedFilters, type SavedFilter, type SavedFiltersSource } from "./saved-filters";

const SEARCH_MIN = 8; // the app's FacetedFilter shows its search box from 8 options

export interface OverviewFilterProps extends OverviewPanelInput {
  /**
   * 경쟁사 축 옵션(인용 도메인, stage "citation") — the original passes them as a promise from the
   * heavy citation read so only that axis waits (analysis-filter-bar.tsx competitorOptions).
   */
  competitorOptions?: Promise<string[]>;
  collectionStartDay?: string | null;
  latestAnchorDay?: string | null;
  selectableDates?: string[];
}

interface Ctx {
  props: OverviewFilterProps;
  model: OverviewPanelModel;
  draft: Draft;
  nav: string[];
  filterQuery: string;
  valueLabel: (g: DimensionGroup, v: string) => string;
  /** An axis's name: the panel's word, or a project custom tag's own label (Gold dim_custom_field.label). */
  groupLabel: (g: PanelAxis) => string;
  regionLabel: (id: string) => string;
  /** `end` (the service week's last day, ServiceWeekShownEnd's): the period as the screens read it, its end at the latest that day; without, as picked */
  timeLabel: (encoded: string, end?: string | null) => string;
  /** the picked period when the screens read less of it (its end past `end`): the title of a shown label */
  timeTitle: (encoded: string, end: string | null) => string | undefined;
  change: (fn: (d: Draft, nav: string[]) => { draft: Draft; nav?: string[] }, opts?: { undoMsg?: string }) => void;
  applyQuery: (query: string) => void;
  saved: ReturnType<typeof useSavedFilters>;
  activeId: string | null;
  setActiveId: (id: string | null) => void;
  openedWith: string | null;
  setOpenedWith: (name: string | null) => void;
}

const FiltersContext = createContext<Ctx | null>(null);
const useFilters = (): Ctx => {
  const c = useContext(FiltersContext);
  if (!c) throw new Error("RnOverviewFilters missing");
  return c;
};

// The page body only needs to *act* on the filters (reset, toggle one value from a chart row).
// Those actions live in their own context whose value changes only with the URL, so a pick in
// the panel (draft) or the busy flag does not re-render the charts and tables of the body —
// with the whole Ctx a single checkbox re-rendered every card (2026-10-23: 360–480ms on Mention).
interface Actions {
  change: Ctx["change"];
  props: OverviewFilterProps;
}
const FilterActionsContext = createContext<Actions | null>(null);
const useFilterActions = (): Actions => {
  const c = useContext(FilterActionsContext);
  if (!c) throw new Error("RnOverviewFilters missing");
  return c;
};

function parseDraft(sp: { get(name: string): string | null }, groups: readonly DimensionGroup[]): Draft {
  const d: Draft = {};
  for (const g of groups) {
    const vals = splitFilterValues(sp.get(g));
    if (vals.length) d[g] = vals;
  }
  return d;
}

export function RnOverviewFilters({
  props,
  savedFilters,
  children,
}: {
  props: OverviewFilterProps;
  savedFilters: SavedFiltersSource;
  children: ReactNode;
}) {
  const tf = useTranslations("dashboard.filters");
  const tTime = useTranslations("dashboard.filters.timeRange");
  const tWeek = useTranslations("serviceWeek");
  const tr = useTranslations("renewal.filters");
  const tCat = useTranslations("citationCategories");
  const locale = useLocale();
  const sp = useSearchParams();
  const { commit } = useRnFilterRuntime();
  const toast = useRnToast();
  // The axes this account can carry do not depend on picks (scope, catalog, languages).
  const groups = useMemo(() => overviewPanelModel(props, {}).visibleGroups, [props]);
  const [draft, setDraftState] = useState<Draft>(() => parseDraft(sp, groups));
  const [nav, setNavState] = useState<string[]>([]);
  // Latest picks, updated synchronously: several picks inside one task (before React
  // re-renders) must build on each other, not on a stale render.
  const draftRef = useRef(draft);
  const navRef = useRef(nav);
  const setDraft = useCallback((d: Draft) => {
    draftRef.current = d;
    setDraftState(d);
  }, []);
  const setNav = useCallback((n: string[]) => {
    navRef.current = n;
    setNavState(n);
  }, []);
  const model = useMemo(() => overviewPanelModel(props, draft), [props, draft]);
  const filterQueryOf = useCallback((d: Draft) => buildCommitParams(new URLSearchParams(), groups, d, [], {}), [groups]);
  const filterQuery = filterQueryOf(draft);

  // External URL changes (back/forward, a link) replace the draft; our own commits do not.
  const sent = useRef<string[]>([]);
  const urlQuery = filterQueryOf(parseDraft(sp, groups));
  useEffect(() => {
    const i = sent.current.findIndex((q) => sameQuery(q, urlQuery));
    if (i >= 0) {
      if (i === sent.current.length - 1) sent.current = [];
      return;
    }
    if (!sameQuery(urlQuery, filterQueryOf(draft))) {
      setDraft(parseDraft(sp, groups));
      setNav([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlQuery]);

  const push = useCallback(
    (next: Draft, immediate = false) => {
      const qs = buildCommitParams(new URLSearchParams(sp.toString()), groups, next, [], {});
      sent.current.push(filterQueryOf(next));
      commit(qs, { immediate });
    },
    [commit, filterQueryOf, groups, sp],
  );

  const saved = useSavedFilters(savedFilters);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [openedWith, setOpenedWith] = useState<string | null>(null);

  const change = useCallback<Ctx["change"]>(
    (fn, opts) => {
      const cur = draftRef.current;
      const curNav = navRef.current;
      const before = { draft: cur, nav: curNav };
      const prevBrand = overviewPanelModel(props, cur).activeBrand;
      const out = fn(cur, curNav);
      const settled = settleDraft(props, out.draft, out.nav ?? curNav, prevBrand);
      setDraft(settled.draft);
      setNav(settled.nav);
      setOpenedWith(null);
      push(settled.draft);
      if (opts?.undoMsg) {
        toast(opts.undoMsg, {
          undoLabel: tr("undo"),
          undo: () => {
            setDraft(before.draft);
            setNav(before.nav);
            push(before.draft);
          },
        });
      }
    },
    [props, push, setDraft, setNav, toast, tr],
  );

  const applyQuery = useCallback(
    (query: string) => {
      const next = parseDraft(new URLSearchParams(query), groups);
      // A saved filter is a URL restore: no "brand changed" clearing, only pruning.
      const settled = settleDraft(props, next, [], overviewPanelModel(props, next).activeBrand);
      setDraft(settled.draft);
      setNav([]);
      push(settled.draft, true);
    },
    [groups, props, push, setDraft, setNav],
  );

  const autoOpened = useRef(false);
  useEffect(() => {
    if (!saved.ready || autoOpened.current) return;
    autoOpened.current = true;
    if (filterQuery) return; // opened with explicit filters (link, back nav)
    const star = saved.items.find((p) => p.isDefault);
    if (!star) return;
    applyQuery(star.query);
    setActiveId(star.id);
    setOpenedWith(star.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved.ready]);

  const langFmt = useMemo(() => new Intl.DisplayNames([locale], { type: "language" }), [locale]);
  const valueLabel = useCallback(
    (g: DimensionGroup, v: string): string => {
      // a custom tag's values are the project's own words
      if (customAxisOf(props, g)) return v;
      if (g === "geography") return geoCodeLabel(v, locale, (c) => tf(`value.${c}` as "value.worldwide"));
      if (g === "language") {
        try {
          return langFmt.of(v) ?? v;
        } catch {
          return v;
        }
      }
      if (g === "engine") return ENGINE_LABEL[v] ?? v;
      if (g === "source") {
        const slug = citationCategorySlug(v);
        return slug ? tCat(slug) : v;
      }
      // 경쟁사 values are domains — shown as they are (the app's facet does the same)
      if (g === "competitor") return v;
      return LABELED_VALUES.has(v) ? tf(`value.${v}` as "value.branded") : v;
    },
    [langFmt, locale, props, tCat, tf],
  );
  const groupLabel = useCallback(
    (g: PanelAxis): string => customAxisOf(props, g)?.label ?? tf(`group.${g}` as "group.geography"),
    [props, tf],
  );
  const regionLabel = useCallback((id: string) => rhqLabel(id, locale === "en" ? "en" : "ko") ?? id, [locale]);
  // the service week's end as this tab knows it (null until the shell's first read): the presets a saved filter names
  const maxDay = useServiceWeekEnd();
  // The applied chip and the time section print the period as the screens read it, its end at the latest `end` (the
  // service week's last day): the BFF reads a `to` past the week up to that day and the header says so (review r1-15:
  // '기간 2026-09-28 ~ 2026-10-25' next to a header of 09-28 ~ 10-11). They take `end` from ServiceWeekShownEnd, the
  // layout's read on the first paint (review r3-6), and name the presets of that end, as the time section does. The URL
  // keeps the pick, so a later week shows more under the same link; a saved filter's summary — and the name it suggests
  // — is the filter as saved.
  const timeLabel = useCallback(
    (encoded: string, end?: string | null) => {
      const preset = timeViewOf(props, null, end === undefined ? maxDay : end).presets.find((p) => p.encoded === encoded);
      if (preset) return tTime(preset.preset);
      const [from, to] = encoded.split("..");
      const r = end === undefined ? { from, to } : shownTimeRange({ from: from || undefined, to: to || undefined }, end);
      return `${r.from || "…"} ~ ${r.to || "…"}`;
    },
    [maxDay, props, tTime],
  );
  const timeTitle = useCallback(
    (encoded: string, end: string | null) => {
      const [from, to] = encoded.split("..");
      const read = shownTimeRange({ from: from || undefined, to: to || undefined }, end).to;
      return to && read !== to ? tWeek("periodCut", { from: from || "…", to, end: read ?? "…" }) : undefined;
    },
    [tWeek],
  );

  const value: Ctx = {
    props,
    model,
    draft,
    nav,
    filterQuery,
    valueLabel,
    groupLabel,
    regionLabel,
    timeLabel,
    timeTitle,
    change,
    applyQuery,
    saved,
    activeId,
    setActiveId,
    openedWith,
    setOpenedWith,
  };
  const actions = useMemo<Actions>(() => ({ change, props }), [change, props]);
  return (
    <FilterActionsContext.Provider value={actions}>
      <FiltersContext.Provider value={value}>{children}</FiltersContext.Provider>
    </FilterActionsContext.Provider>
  );
}

/** The time axis of the period `value`, held to `maxDay` — the service week's end (2026-11-02): no preset reaches past it; null = not known, as before. */
function timeViewOf(props: OverviewFilterProps, value: string | null, maxDay: string | null) {
  const minDay = props.collectionStartDay ? isoDay(new Date(props.collectionStartDay)) : null;
  return {
    maxDay,
    ...resolveTimeRangeView({
      value,
      minDay,
      endDay: props.latestAnchorDay ?? null,
      selectableDates: props.selectableDates,
      todayKst: kstToday(),
      now: new Date(),
      maxDay,
    }),
  };
}

/** Applied-condition summary of a filter query (saved filters, tokens). */
function useSummaries() {
  const { model, valueLabel, groupLabel, regionLabel, timeLabel, timeTitle } = useFilters();
  const tr = useTranslations("renewal.filters");
  const tokensOf = useCallback(
    /** `end` (ServiceWeekShownEnd's): the period as the screens read it, the pick in `title` (the applied chips); without, as saved */
    (d: Draft, end?: string | null): { group: DimensionGroup; label: string; text: string; title?: string }[] => {
      const out: { group: DimensionGroup; label: string; text: string; title?: string }[] = [];
      for (const s of model.sections) {
        for (const axis of s.axes) {
          if (axis === "rhqRegion") continue;
          const vals = d[axis] ?? [];
          if (!vals.length) continue;
          let text: string;
          let title: string | undefined;
          if (axis === "time") {
            text = timeLabel(vals[0], end);
            title = end === undefined ? undefined : timeTitle(vals[0], end);
          } else {
            const whole = axis === "geography" ? wholeRegions(model, vals) : null;
            if (whole) text = tr("regionCountries", { regions: whole.map((id) => tr("wholeRegion", { region: regionLabel(id) })).join(", "), count: vals.length });
            else {
              const labels = vals.map((v) => valueLabel(axis, v));
              text = labels.length > 3 ? tr("moreValues", { first: labels.slice(0, 2).join(", "), count: labels.length - 2 }) : labels.join(", ");
            }
          }
          out.push({ group: axis, label: groupLabel(axis), text, title });
        }
      }
      return out;
    },
    [groupLabel, model, regionLabel, timeLabel, timeTitle, tr, valueLabel],
  );
  const summarize = useCallback(
    (query: string) => {
      const d: Draft = {};
      const p = new URLSearchParams(query);
      for (const s of model.sections) for (const a of s.axes) if (a !== "rhqRegion") {
        const vals = splitFilterValues(p.get(a));
        if (vals.length) d[a] = vals;
      }
      return tokensOf(d).map((x) => x.text).join(" · ");
    },
    [model.sections, tokensOf],
  );
  return { tokensOf, summarize };
}

/** The picked countries are exactly whole measured 권역 (for the "유럽 전체" token). */
function wholeRegions(model: OverviewPanelModel, picked: readonly string[]): string[] | null {
  if (!model.activeBrand || !picked.length) return null;
  const whole = model.regions.filter((id) => {
    const cs = [...model.countryToRhq].filter(([, r]) => r === id).map(([c]) => c);
    return cs.length > 0 && cs.every((c) => picked.includes(c));
  });
  const covered = new Set([...model.countryToRhq].filter(([, r]) => whole.includes(r)).map(([c]) => c));
  return whole.length && picked.every((c) => covered.has(c)) && covered.size === picked.length ? whole : null;
}

// ─── panel ──────────────────────────────────────────────────────────────────

const DEFAULT_OPEN: Partial<Record<PanelAxis, boolean>> = {
  brand: true,
  rhqRegion: true,
  geography: true,
  engine: true,
  time: true,
  promptContext: true,
};

export function RnOverviewFilterPanel({
  onCollapse: onCollapseProp,
  defaultOpen,
  basis,
  axisHelp,
  hint,
}: {
  onCollapse?: () => void;
  /** "all" opens every section (parity test). */
  defaultOpen?: "all";
  /** A page's own basis row under the saved filters (AI Visibility: 측정 기간). */
  basis?: ReactNode;
  /** One line at the top of an axis section (AI Visibility: which number the axis narrows). */
  axisHelp?: Partial<Record<PanelAxis, ReactNode>>;
  /** Replaces the no-pick hint at the panel's foot. */
  hint?: ReactNode;
}) {
  const split = useRnSplit();
  const onCollapse = onCollapseProp ?? split.collapse;
  const ctx = useFilters();
  const { model, draft, change, saved, activeId, setActiveId, filterQuery, applyQuery, props } = ctx;
  const tf = useTranslations("dashboard.filters");
  const tr = useTranslations("renewal.filters");
  const { summarize } = useSummaries();
  const [open, setOpen] = useState<Partial<Record<PanelAxis, boolean>>>(() =>
    defaultOpen === "all" ? Object.fromEntries(model.sections.flatMap((s) => s.axes).map((a) => [a, true])) : DEFAULT_OPEN,
  );
  const count = model.visibleGroups.filter((g) => (draft[g]?.length ?? 0) > 0).length;
  const onActivate = (item: SavedFilter | null) => {
    if (!item) {
      setActiveId(null);
      return;
    }
    setActiveId(item.id);
    applyQuery(item.query);
  };
  return (
    <aside
      id="rn-filter-panel"
      aria-label={tr("title")}
      className="h-full overflow-auto overscroll-contain bg-rn-surface"
    >
      <div className="sticky top-0 z-[2] flex items-center gap-2 border-b border-rn-line bg-rn-surface py-3 pr-2.5 pl-5">
        <b className="text-rn-15 text-rn-ink">{tr("title")}</b>
        <span className="text-rn-12 text-rn-muted">{count ? tr("selectedAxes", { count }) : tr("noneSelected")}</span>
        {count ? (
          <button
            type="button"
            data-rn-reset=""
            onClick={() => change(() => ({ draft: {}, nav: [] }), { undoMsg: tr("resetDone") })}
            className="cursor-pointer text-rn-12 text-rn-muted underline underline-offset-3 hover:text-rn-ink"
          >
            {tf("reset")}
          </button>
        ) : null}
        <RnIconButton label={tr("collapse")} className="ml-auto" onClick={onCollapse}>
          <ChevronLeft className="size-4" aria-hidden />
        </RnIconButton>
      </div>
      <RnSavedFiltersSection
        saved={saved}
        activeId={activeId}
        onActivate={onActivate}
        currentQuery={filterQuery}
        summarize={summarize}
        hrefOf={(q) => `${window.location.origin}${window.location.pathname}${q ? `?${q}` : ""}`}
      />
      {basis}
      {model.sections.map((s) => (
        <div key={s.id} data-rn-section={s.id}>
          <RnPanelGroupLabel>{tf(`section.${s.id}` as "section.dimension")}</RnPanelGroupLabel>
          {s.axes.map((axis) => {
            const toggle = () => setOpen((o) => ({ ...o, [axis]: !(o[axis] ?? false) }));
            // a 국가 axis with nothing to offer (AI Conversion before any GA4 property, 2026-10-30) is left out,
            // unless the URL still picks a country and its clear is needed
            if (axis === "geography" && model.geographyOptions.length === 0 && !draft.geography?.length) return null;
            if (axis === "competitor" && props.competitorOptions) {
              return (
                <Suspense key={axis} fallback={<AxisSection axis={axis} open={false} onToggle={toggle} options={[]} />}>
                  <CompetitorSection options={props.competitorOptions} open={open[axis] ?? false} onToggle={toggle} />
                </Suspense>
              );
            }
            // the time section prints the period read and holds its pickers to the week's end from the first paint on
            // (the layout's read until this tab knows the week, review r3-6)
            if (axis === "time") {
              return (
                <ServiceWeekShownEnd key={axis}>
                  {(end) => <AxisSection axis={axis} open={open[axis] ?? false} onToggle={toggle} help={axisHelp?.[axis]} end={end} />}
                </ServiceWeekShownEnd>
              );
            }
            return <AxisSection key={axis} axis={axis} open={open[axis] ?? false} onToggle={toggle} help={axisHelp?.[axis]} />;
          })}
        </div>
      ))}
      <div className="flex flex-col gap-1 px-4.5 pt-3 pb-3.5 text-rn-12 text-rn-muted">
        {/* the app's hint says "최근 7일"; ACR reads the latest round when no period is picked */}
        {count === 0 ? <span>{hint ?? (props.stage === "acr" || props.stage === "mention" || props.stage === "citation" ? tr("defaultScopeHintSnapshot") : tf("defaultScopeHint"))}</span> : null}
      </div>
    </aside>
  );
}

export function RnOverviewFilterRail({ onExpand: onExpandProp }: { onExpand?: () => void }) {
  const split = useRnSplit();
  const onExpand = onExpandProp ?? split.expand;
  const { model, draft } = useFilters();
  const tr = useTranslations("renewal.filters");
  const count = model.visibleGroups.filter((g) => (draft[g]?.length ?? 0) > 0).length;
  return (
    <aside aria-label={tr("title")} className="flex h-full flex-col items-center gap-1.5 bg-rn-surface py-3">
      <RnIconButton label={tr("expand")} className="size-9" onClick={onExpand}>
        <PanelLeft className="size-[18px]" aria-hidden />
        {count ? <RnCountBadge className="absolute -top-0.5 -right-1">{count}</RnCountBadge> : null}
      </RnIconButton>
      <RnIconButton label={tr("openSaved")} className="size-9" onClick={onExpand}>
        <Bookmark className="size-[18px]" aria-hidden />
      </RnIconButton>
    </aside>
  );
}

/**
 * 경쟁사 axis (citation): the app's rule (dimension-filter-panel renderGroup "competitor") —
 * options are the cited 공식(경쟁사) domains; the axis is disabled with a hint while the 출처
 * selection leaves 공식(경쟁사) out; empty options remove the axis only when the APPLIED 출처 allows
 * competitors (a user-excluded axis stays visible, disabled, so the reason can be read).
 */
function CompetitorSection({ options: pending, open, onToggle }: { options: Promise<string[]>; open: boolean; onToggle: () => void }) {
  const options = use(pending);
  const { draft } = useFilters();
  const sp = useSearchParams();
  const applied = splitFilterValues(sp.get("source"));
  if (options.length === 0 && competitorAxisEnabled(applied)) return null;
  return <AxisSection axis="competitor" open={open} onToggle={onToggle} options={options} disabled={!competitorAxisEnabled(draft.source)} />;
}

function AxisSection({ axis, open, onToggle, options, disabled, help, end = null }: { axis: PanelAxis; open: boolean; onToggle: () => void; options?: readonly string[]; disabled?: boolean; help?: ReactNode; /** the time axis: the service week's last day (ServiceWeekShownEnd) */ end?: string | null }) {
  const ctx = useFilters();
  const { model, draft, change, regionLabel, groupLabel } = ctx;
  const tf = useTranslations("dashboard.filters");
  const tr = useTranslations("renewal.filters");
  const title = groupLabel(axis);
  const selectedRegions = axis === "rhqRegion" ? model.regions.filter((id) => isRegionSelected(id, draft.geography ?? [], model.countryToRhq)) : [];
  const picked = axis === "rhqRegion" ? selectedRegions.length : (draft[axis]?.length ?? 0);
  const timeSummary = axis === "time" && draft.time?.[0] ? ctx.timeLabel(draft.time[0], end) : undefined;
  const clear = () => {
    if (axis === "rhqRegion") {
      // the app's 권역 clear: drop the nav and the countries it selected
      change((d) => ({ draft: normalizeDraft(clearGroup(d, "geography"), "geography", ctx.props.catalogRows), nav: [] }));
    } else change((d) => ({ draft: normalizeDraft(clearGroup(d, axis), axis, ctx.props.catalogRows) }));
  };
  return (
    <RnPanelSection title={title} open={open} onToggle={onToggle} badge={axis === "time" ? undefined : picked} summary={timeSummary} note={disabled ? tr("axisNeedsCompetitor") : undefined} focusKey={`s:${axis}`}>
      {help ? <p className="mx-2.5 mb-1.5 text-rn-12 leading-[1.45] break-keep text-rn-muted">{help}</p> : null}
      {axis === "time" ? (
        <TimeBody end={end} />
      ) : axis === "rhqRegion" ? (
        <div role="group" aria-label={title}>
          {model.regions.map((id) => (
            <RnCheckRow
              key={id}
              checked={selectedRegions.includes(id)}
              label={regionLabel(id)}
              meta={[...model.countryToRhq.values()].filter((r) => r === id).length}
              focusKey={`r:${id}`}
              onToggle={() =>
                change((d, n) => {
                  const next = toggleRhqRegion(id, { nav: n, geography: d.geography ?? [] }, model.countryToRhq);
                  return { draft: normalizeDraft({ ...d, geography: next.geography }, "geography", ctx.props.catalogRows), nav: next.nav };
                })
              }
            />
          ))}
        </div>
      ) : (
        <ValueList group={axis} options={options} disabled={disabled} />
      )}
      {picked > 0 || (axis === "time" && draft.time?.length) ? (
        <RnTextButton className="mx-2.5 mt-1.5" onClick={clear}>
          {tf("clearAxis")}
        </RnTextButton>
      ) : null}
    </RnPanelSection>
  );
}

function ValueList({ group, options: given, disabled = false }: { group: DimensionGroup; options?: readonly string[]; disabled?: boolean }) {
  const ctx = useFilters();
  const { model, draft, nav, change, valueLabel, groupLabel, regionLabel, props } = ctx;
  const tf = useTranslations("dashboard.filters");
  const tr = useTranslations("renewal.filters");
  const [q, setQ] = useState("");
  const options = given ?? axisOptions(model, props, draft, group, nav);
  const query = q.trim().toLowerCase();
  const shown = query ? options.filter((o) => o.toLowerCase().includes(query) || valueLabel(group, o).toLowerCase().includes(query)) : options;
  const selected = draft[group] ?? [];
  const toggle = (v: string) => change((d) => ({ draft: normalizeDraft(toggleValue(d, group, v), group, props.catalogRows) }));
  const row = (v: string) => (
    <RnCheckRow key={v} checked={selected.includes(v)} label={valueLabel(group, v)} focusKey={`c:${group}:${v}`} onToggle={() => toggle(v)} disabled={disabled} title={disabled ? tf("competitorNeedsOfficialCompetitor") : undefined} />
  );
  let list: ReactNode;
  if (shown.length === 0) list = <p className="m-0 px-2.5 py-2 text-rn-12 text-rn-muted">—</p>;
  else if (group === "geography" && nav.length === 0) {
    const order: string[] = [];
    const buckets = new Map<string, string[]>();
    for (const v of shown) {
      const g = geographyGroupOf(v, model);
      const key = g === "globalHub" ? "globalHub" : g ? g.rhq : "";
      if (!buckets.has(key)) {
        buckets.set(key, []);
        order.push(key);
      }
      buckets.get(key)!.push(v);
    }
    list = order.map((key) => {
      const items = buckets.get(key)!;
      const anyIn = items.some((v) => selected.includes(v));
      return (
        <div key={key || "none"}>
          {key ? (
            <RnGroupHeader
              label={key === "globalHub" ? tf("group.globalHub") : regionLabel(key)}
              active={anyIn}
              title={anyIn ? tr("groupClear") : tr("groupSelectAll")}
              onToggle={() =>
                change((d) => {
                  const cur = new Set(d.geography ?? []);
                  items.forEach((v) => (anyIn ? cur.delete(v) : cur.add(v)));
                  return { draft: normalizeDraft({ ...d, geography: [...cur] }, "geography", props.catalogRows) };
                })
              }
            />
          ) : null}
          {items.map(row)}
        </div>
      );
    });
  } else list = shown.map(row);
  return (
    <>
      {disabled ? <p className="m-0 px-2.5 pb-1.5 text-rn-12 text-rn-muted">{tf("competitorNeedsOfficialCompetitor")}</p> : null}
      {options.length >= SEARCH_MIN ? (
        <RnSearchField className="mx-0.5 mb-1.5" value={q} onChange={setQ} placeholder={tf("searchPlaceholder")} label={tf("searchPlaceholder")} />
      ) : null}
      <div role="group" aria-label={groupLabel(group)}>
        {list}
      </div>
    </>
  );
}

/** `end`: the service week's last day (ServiceWeekShownEnd) — the presets, the date inputs and the calendar stop there. */
function TimeBody({ end }: { end: string | null }) {
  const ctx = useFilters();
  const { props, draft, change } = ctx;
  const tTime = useTranslations("dashboard.filters.timeRange");
  const locale = useLocale();
  const value = draft.time?.[0] ?? null;
  const view = timeViewOf(props, value, end);
  // what it shows is the period as read (view.shown: the end at the latest the service week's last day, the pick in the
  // title, review r1-15); what it commits keeps the pick (view.range)
  const cutTitle = value ? ctx.timeTitle(value, end) : undefined;
  const set = (encoded: string | null) => change((d) => ({ draft: encoded ? { ...d, time: [encoded] } : clearGroup(d, "time") }));
  const empty = view.anchored && !!(view.range.from || view.range.to) && (view.rounds ?? 0) === 0;
  const monthFmt = useMemo(() => new Intl.DateTimeFormat(locale, { year: "numeric", month: "long", timeZone: "UTC" }), [locale]);
  const weekdayFmt = useMemo(() => new Intl.DateTimeFormat(locale, { weekday: "narrow", timeZone: "UTC" }), [locale]);
  const weekdays = useMemo(() => Array.from({ length: 7 }, (_, i) => weekdayFmt.format(new Date(Date.UTC(2026, 1, 1 + i)))), [weekdayFmt]); // 2026-02-01 is a Sunday
  return (
    <div className="flex flex-col gap-1">
      {empty ? (
        <RnNote className="mx-0.5 mb-1">
          <span>{tTime("noRoundInWindow")}</span>
          {view.suggested ? (
            <RnTextButton onClick={() => set(encodeTimeRange(view.suggested!))}>
              {tTime("goToNearestRound", { from: view.suggested.from ?? "…", to: view.suggested.to ?? "…" })}
            </RnTextButton>
          ) : null}
        </RnNote>
      ) : null}
      <div role="group" aria-label={tTime("custom")}>
        {view.presets.map(({ preset, encoded }) => (
          <RnCheckRow
            key={preset}
            checked={encoded !== null && value === encoded}
            disabled={encoded === null}
            title={encoded === null ? tTime("noRoundInWindow") : undefined}
            label={tTime(preset)}
            focusKey={`t:${preset}`}
            // the app re-selects a checked preset (it never unchecks it)
            onToggle={() => encoded !== null && set(encoded)}
          />
        ))}
      </div>
      <div className="mx-2.5 mt-2 flex items-center justify-between gap-2 text-rn-12 font-bold text-rn-ink-2">
        <span className="inline-flex items-center gap-1.5">
          <CalendarDays className="size-3.5" aria-hidden />
          {tTime("custom")}
        </span>
        {view.range.from || view.range.to ? (
          <span className="font-semibold text-rn-navy tabular-nums" title={cutTitle}>
            {view.shown.from ?? "…"} ~ {view.shown.to ?? "…"}
          </span>
        ) : null}
      </div>
      {view.anchored ? (
        <div className="mx-0.5">
          <RnRoundCalendar
            selectableDates={props.selectableDates ?? []}
            value={view.shown}
            defaultDay={view.defaultDay}
            onChange={(next) => set(encodeTimeRange(next))}
            labels={{
              prev: tTime("prevMonth"),
              next: tTime("nextMonth"),
              noRound: tTime("noRoundOnDay"),
              defaultRound: tTime("defaultRound"),
              weekdays,
              month: (y, m) => monthFmt.format(new Date(Date.UTC(y, m - 1, 1))),
            }}
          />
        </div>
      ) : (
        <div className="mx-2.5 flex flex-col gap-1.5">
          {(["from", "to"] as const).map((side) => (
            <label key={side} className="flex items-center gap-2 text-rn-12 text-rn-muted">
              <span className="w-12 shrink-0">{tTime(side)}</span>
              <input
                type="date"
                value={view.shown[side] ?? ""}
                // no day past the service week; the start no later than the picked end either
                max={(side === "from" ? [view.range.to, view.maxDay].filter(Boolean).sort()[0] : view.maxDay) ?? undefined}
                onChange={(e) => set(encodeTimeRange({ ...view.range, [side]: e.target.value || undefined }))}
                className="h-8 w-full rounded-md border border-rn-line-2 px-2 text-rn-12 text-rn-ink focus:border-rn-navy focus:outline-none"
              />
            </label>
          ))}
        </div>
      )}
      <div className="mx-2.5 mt-1 flex justify-between text-rn-12 text-rn-muted">
        {view.anchored && (view.range.from || view.range.to) ? <span>{tTime("roundCount", { count: view.rounds ?? 0 })}</span> : null}
        {view.anchored && !view.range.from && !view.range.to && view.defaultDay ? (
          <span className="flex w-full items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5">
              <i aria-hidden className="inline-block size-2 rounded-[2px] shadow-[inset_0_0_0_1.5px_var(--color-rn-navy)]" />
              {tTime("defaultRound")}
            </span>
            <b className="font-semibold text-rn-ink-2 tabular-nums">{view.defaultDay}</b>
          </span>
        ) : null}
      </div>
    </div>
  );
}

// ─── applied conditions under the page title ───────────────────────────────

export function RnOverviewApplied() {
  // the period chip prints the period read from the first paint on (the layout's read until this tab knows the week, review r3-6)
  return <ServiceWeekShownEnd>{(end) => <Applied end={end} />}</ServiceWeekShownEnd>;
}

function Applied({ end }: { end: string | null }) {
  const ctx = useFilters();
  const { draft, change, openedWith, setOpenedWith, props } = ctx;
  const { busy } = useRnFilterRuntime();
  const tr = useTranslations("renewal.filters");
  const ts = useTranslations("renewal.saved");
  const { tokensOf } = useSummaries();
  const tokens = tokensOf(draft, end);
  return (
    <>
      {tokens.length || busy ? (
        <div aria-live="polite" className="flex min-h-7 flex-wrap items-center gap-2 text-rn-13">
          {tokens.map((tk) => (
            <RnToken
              key={tk.group}
              label={tk.label}
              value={tk.title ? <span title={tk.title}>{tk.text}</span> : tk.text}
              removeLabel={tr("removeToken", { label: tk.label })}
              onRemove={() =>
                change((d) =>
                  tk.group === "geography"
                    ? { draft: normalizeDraft(clearGroup(d, "geography"), "geography", props.catalogRows), nav: [] }
                    : { draft: normalizeDraft(clearGroup(d, tk.group), tk.group, props.catalogRows) },
                )
              }
            />
          ))}
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
              change(() => ({ draft: {}, nav: [] }));
            }}
          >
            {ts("viewWithout")}
          </RnTextButton>
        </RnNote>
      ) : null}
    </>
  );
}

/** Clears every filter (with the panel's undo toast) — for "no result" cards in the page body. */
export function useRnFilterReset(): () => void {
  const { change } = useFilterActions();
  const tr = useTranslations("renewal.filters");
  return useCallback(() => change(() => ({ draft: {}, nav: [] }), { undoMsg: tr("resetDone") }), [change, tr]);
}

/**
 * Toggles one value of an axis from outside the panel (a chart row, e.g. 출처 카테고리) through
 * the panel's own rules — normalize (경쟁사 cleared when 공식(경쟁사) leaves the 출처) and apply.
 */
export function useRnFilterToggle(): (group: DimensionGroup, value: string) => void {
  const { change, props } = useFilterActions();
  return useCallback(
    (group: DimensionGroup, value: string) => change((d) => ({ draft: normalizeDraft(toggleValue(d, group, value), group, props.catalogRows) })),
    [change, props.catalogRows],
  );
}

/** The engines the panel offers (Gold's on the website pages, else the static list): what a chart row may pick. */
export function useRnEngineOptions(): readonly string[] {
  return useFilterActions().props.engineOptions ?? DIMENSIONS.engine;
}

/** Copies the page URL (current conditions) to the clipboard. */
export function RnCopyLinkButton() {
  const t = useTranslations("renewal.overview");
  const ts = useTranslations("renewal.saved");
  const toast = useRnToast();
  return (
    <RnButton
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(window.location.href);
          toast(t("linkCopied"));
        } catch {
          toast(ts("linkFailed"));
        }
      }}
    >
      <Link2 className="size-3.5" aria-hidden />
      {t("copyLink")}
    </RnButton>
  );
}
