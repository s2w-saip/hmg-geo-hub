"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  LineChart,
  Line,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import {
  AlertCircle,
  Check,
  ListChecks,
  ListTree,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { countryName } from "@/lib/geo-catalog/country-name";
import { CHART_TOOLTIP_STYLE } from "@/lib/viz/chart-tooltip";
import { useSortableTable } from "@/hooks/use-sortable-table";
import { SortableHeader } from "@/components/ui/sortable-header";
import { TooltipProvider as InfoTooltipProvider } from "@/components/ui/tooltip";
import { ColInfo } from "@/components/dash/col-info";
import { type SearchIntent } from "../_data/sample";
import {
  addCandidate,
  addTrackedKeyword,
  removeTrackedKeyword,
  removeTrackedKeywords,
} from "../_actions";
import { KeywordSearchStart } from "./keyword-search-start";
import { nextActiveAfterRemoval, restoreHidden } from "./keyword-selection";

// Google Keyword 분기 — wired to live data (2026-06):
//   - 관심도 추이 / 평균 관심도 ← DataForSEO Google Ads monthly_searches
//     (/api/keyword/insight — lib/keyword/insight.ts). Google Trends가 아니라
//     월별 검색량을 기간 내 최대=100 상대 지수로 그린 것 (2026-07-23 출처
//     ⓘ툴팁 추가하며 오기 정정).
//   - SERP & 프롬프트 생성       ← DataForSEO SERP + OpenRouter keyword→prompt
//   - 관련 검색어 패널           ← DataForSEO keyword suggestions (/api/keyword/related)
// Each keyword tab lazily loads its own bundle, keyed by (tab, country, range),
// so switching tabs / filters fetches once and caches. Adding a keyword (manual
// or promoted from the related panel) spawns a tab whose bundle then loads.
// Period filter = how many months of the 12-month volume series to show. The
// insight always carries 12 monthly points; the filter slices client-side
// (no refetch), so it is NOT part of the insight cache key.
const RANGES = ["3m", "6m", "12m"] as const;
// Country is a free ISO alpha-2 string (not the closed base list) so a project
// whose market is outside COUNTRIES (e.g. "IT") still auto-applies correctly.
type Country = string;
type Range = (typeof RANGES)[number];
const MONTHS_FOR_RANGE: Record<Range, number> = { "3m": 3, "6m": 6, "12m": 12 };

type SerpSortKey = "rank" | "applied" | "url" | "title" | "suggested";

const INTENT_TONE: Record<SearchIntent, string> = {
  transactional: "bg-emerald-50 text-emerald-700",
  commercial: "bg-amber-50 text-amber-700",
  informational: "bg-blue-50 text-blue-700",
  navigational: "bg-purple-50 text-purple-700",
};

// ── Live wire types (mirror /api/keyword/* JSON) ──────────────────────────────
type SerpRow = {
  id: string;
  rank: number;
  url: string;
  title: string;
  snippet: string;
  suggestedPrompt: string;
};
type TrendPoint = { week: string; primary: number }; // primary = raw monthly volume
type Insight = { label: string; trend: TrendPoint[]; serp: SerpRow[] };
type RelatedItem = { id: string; term: string; volume: number; intent: SearchIntent };
type RelatedBundle = { foundCount: number; items: RelatedItem[] };
type Tab = { id: string; label: string };
type Async<T> = { status: "loading" | "ready" | "error"; data?: T };

export function GoogleKeywordView({
  projectId,
  canEdit,
  projectCountry,
  allowedCountries,
  initialKeywords,
}: {
  projectId: string;
  canEdit: boolean;
  /** ISO alpha-2 of the project's market — auto-applied as the default filter. */
  projectCountry: string;
  /**
   * The account's own country access (server-resolved via
   * scope-policy::resolveDimensionState — same authority as the dashboard
   * filter row), NOT a hardcoded sample list. A country-scoped account only
   * sees its own market here.
   */
  allowedCountries: readonly string[];
  /** Persisted tracked keywords for this project (tab id = DB row id). */
  initialKeywords: Tab[];
}) {
  const t = useTranslations("projectDetail.intent.googleKeyword");
  const locale = useLocale();

  // Default market = the project's country (auto-applied), normalized to the
  // ISO alpha-2 the keyword APIs expect. Falls back to KR if unset.
  const defaultCountry = (projectCountry || "KR").toUpperCase();
  const countryOptions = useMemo(
    () => Array.from(new Set([defaultCountry, ...allowedCountries])),
    [defaultCountry, allowedCountries],
  );

  const [tabs, setTabs] = useState<Tab[]>(() => initialKeywords);
  const [active, setActive] = useState(() => initialKeywords[0]?.id ?? "");
  const [range, setRange] = useState<Range>("12m");
  const [country, setCountry] = useState<Country>(defaultCountry);

  const [insightCache, setInsightCache] = useState<Record<string, Async<Insight>>>({});
  const [relatedCache, setRelatedCache] = useState<Record<string, Async<RelatedBundle>>>({});
  const insightRequested = useRef<Set<string>>(new Set());
  const relatedRequested = useRef<Set<string>>(new Set());

  // Keyword tab management + interaction state.
  const [adding, setAdding] = useState(false);
  const [newKeyword, setNewKeyword] = useState("");
  const [relatedFor, setRelatedFor] = useState<string | null>(null);
  const [checkedRelated, setCheckedRelated] = useState<Set<string>>(() => new Set());
  const [appliedMap, setAppliedMap] = useState<Record<string, boolean>>({});
  const [addedSerpIds, setAddedSerpIds] = useState<Set<string>>(() => new Set());
  const [pending, startTransition] = useTransition();

  // 키워드 선택 삭제 — the tab strip doubles as the tracked-keyword list, so
  // multi-select is a mode toggle rather than always-on checkboxes: a tab's
  // primary job is navigation, and a permanent checkbox column would compete
  // with that on every visit for a delete that is occasional.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedTabs, setSelectedTabs] = useState<Set<string>>(() => new Set());
  const [deletingKeywords, setDeletingKeywords] = useState(false);

  // SERP 선택 삭제 — session-scoped. SERP row ids are positional (serp-0-1, …)
  // and re-derived on every regeneration, so persisting a hidden-id set would
  // silently mask *whichever* row landed in that slot next time. Hiding stays
  // client-side and is namespaced by the same rowKey tuple as the other
  // per-row state; 재생성 / reload brings rows back (surfaced via removeHint).
  const [hiddenSerpIds, setHiddenSerpIds] = useState<Set<string>>(() => new Set());

  const activeTab = tabs.find((k) => k.id === active) ?? tabs[0] ?? null;
  // Insight is independent of range (range only slices the displayed trend).
  const insightKey = useCallback((id: string) => `${id}|${country}`, [country]);
  const relatedKeyOf = useCallback((id: string) => `${id}|${country}`, [country]);

  const currentInsight = activeTab ? insightCache[insightKey(activeTab.id)] : undefined;
  const insightData = currentInsight?.status === "ready" ? currentInsight.data : undefined;
  const allSerpRows = useMemo(() => insightData?.serp ?? [], [insightData]);

  // SERP ids (serp-0-1, …) repeat across tabs/countries/ranges, so per-row
  // interaction state (applied checkbox, added-to-pool) must be namespaced by
  // the same (tab, country, range) tuple the insight is cached under — otherwise
  // checking/adding a row on one keyword tab leaks onto every other tab's
  // same-ranked row.
  const rowKey = useCallback(
    (rowId: string) => `${active}|${country}|${rowId}`,
    [active, country],
  );

  // Rows the user removed from the generated-prompt list drop out of every
  // downstream read (sort, counts, bulk send) — hiddenSerpIds is the single
  // gate, so a removed row can never be silently sent to the candidate pool.
  const serpRows = useMemo(
    () => allSerpRows.filter((r) => !hiddenSerpIds.has(rowKey(r.id))),
    [allSerpRows, hiddenSerpIds, rowKey],
  );
  const hiddenCount = allSerpRows.length - serpRows.length;

  const relatedSeed = tabs.find((k) => k.id === relatedFor) ?? null;
  const currentRelated = relatedSeed ? relatedCache[relatedKeyOf(relatedSeed.id)] : undefined;
  const relatedData = currentRelated?.status === "ready" ? currentRelated.data : undefined;

  const existingLabels = useMemo(
    () => new Set(tabs.map((k) => k.label)),
    [tabs],
  );

  // ── data loaders ──
  const loadInsight = useCallback(
    (tab: Tab, force = false) => {
      const key = `${tab.id}|${country}`;
      if (!force && insightRequested.current.has(key)) return;
      insightRequested.current.add(key);
      setInsightCache((prev) => ({ ...prev, [key]: { status: "loading" } }));
      void (async () => {
        try {
          const res = await fetch("/api/keyword/insight", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            // `force` (재생성 button) bypasses the server-side insight cache.
            // projectId (C1, unit U10): the API source gates and collects per project;
            // the standard screen (projectId "") sends none.
            body: JSON.stringify({ keyword: tab.label, country, fresh: force, projectId: projectId || undefined }),
          });
          const json = await res.json();
          if (!res.ok || !json.success) throw new Error(json.error ?? "failed");
          setInsightCache((prev) => ({
            ...prev,
            [key]: { status: "ready", data: json.insight as Insight },
          }));
        } catch {
          insightRequested.current.delete(key); // allow retry
          setInsightCache((prev) => ({ ...prev, [key]: { status: "error" } }));
        }
      })();
    },
    [country, projectId],
  );

  const loadRelated = useCallback(
    (tab: Tab, force = false) => {
      const key = `${tab.id}|${country}`;
      if (!force && relatedRequested.current.has(key)) return;
      relatedRequested.current.add(key);
      setRelatedCache((prev) => ({ ...prev, [key]: { status: "loading" } }));
      void (async () => {
        try {
          const res = await fetch("/api/keyword/related", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ keyword: tab.label, country, projectId: projectId || undefined }),
          });
          const json = await res.json();
          if (!res.ok || !json.success) throw new Error(json.error ?? "failed");
          setRelatedCache((prev) => ({
            ...prev,
            [key]: {
              status: "ready",
              data: { foundCount: json.foundCount ?? 0, items: json.items ?? [] },
            },
          }));
        } catch {
          relatedRequested.current.delete(key);
          setRelatedCache((prev) => ({ ...prev, [key]: { status: "error" } }));
        }
      })();
    },
    [country, projectId],
  );

  // Lazily load the active tab's insight whenever it / the filters change.
  useEffect(() => {
    if (activeTab) loadInsight(activeTab);
  }, [activeTab, loadInsight]);

  // Load related keywords when a panel opens (or country changes while open).
  useEffect(() => {
    if (relatedSeed) loadRelated(relatedSeed);
  }, [relatedSeed, loadRelated]);

  const appliedCount = useMemo(
    () => serpRows.filter((r) => appliedMap[rowKey(r.id)]).length,
    [serpRows, appliedMap, rowKey],
  );
  // Checked rows still eligible for a bulk add (excludes ones already sent).
  const pendingApplied = useMemo(
    () => serpRows.filter((r) => appliedMap[rowKey(r.id)] && !addedSerpIds.has(rowKey(r.id))),
    [serpRows, appliedMap, addedSerpIds, rowKey],
  );

  // Slice the 12-month trend to the selected window and normalize that window to
  // 0-100 (relative to its own peak month) for the interest chart + avg gauge.
  const { displayTrend, avgInterest } = useMemo(() => {
    const raw = insightData?.trend ?? [];
    if (raw.length === 0) return { displayTrend: [] as TrendPoint[], avgInterest: 0 };
    const sliced = raw.slice(-MONTHS_FOR_RANGE[range]);
    const max = Math.max(...sliced.map((p) => p.primary), 0);
    const norm = sliced.map((p) => ({
      week: p.week,
      primary: max > 0 ? Math.round((p.primary / max) * 100) : 0,
    }));
    const avg = norm.length
      ? Math.round(norm.reduce((s, p) => s + p.primary, 0) / norm.length)
      : 0;
    return { displayTrend: norm, avgInterest: avg };
  }, [insightData, range]);

  const { sorted: serpSorted, headerProps: serpHeader } = useSortableTable<
    SerpRow,
    SerpSortKey
  >(
    serpRows,
    {
      rank: (r) => r.rank,
      applied: (r) => (appliedMap[rowKey(r.id)] ? 1 : 0),
      url: (r) => r.url,
      title: (r) => r.title,
      suggested: (r) => r.suggestedPrompt,
    },
    { defaultKey: "rank", defaultAsc: true, ascByDefault: ["rank", "url", "title", "suggested"] },
  );

  // Addable related terms (not already tracked) for the select-all checkbox.
  const addableTerms = (relatedData?.items ?? [])
    .map((r) => r.term)
    .filter((term) => !existingLabels.has(term));
  const allChecked =
    addableTerms.length > 0 && addableTerms.every((term) => checkedRelated.has(term));

  // ── keyword tab actions ──
  // Each tab IS a persisted tracked keyword: adding/removing a tab writes
  // through to tracked_keywords under this project (auto-stamped with the
  // current market). The DB row id becomes the tab id so per-tab caches stay
  // stable across refreshes.
  const [savingKeyword, setSavingKeyword] = useState(false);

  async function addKeyword(term: string): Promise<boolean> {
    const value = term.trim();
    if (!value) return false;
    if (existingLabels.has(value)) {
      toast.error(t("keywordExists"));
      return false;
    }
    setSavingKeyword(true);
    const res = await addTrackedKeyword(projectId, { term: value, country });
    setSavingKeyword(false);
    if (!res.ok) {
      toast.error(res.error);
      return false;
    }
    const tab = { id: res.value.id, label: value };
    setTabs((prev) => [...prev, tab]);
    setActive(tab.id);
    toast.success(t("keywordAdded"));
    return true;
  }

  async function deleteKeyword(id: string) {
    const idx = tabs.findIndex((k) => k.id === id);
    const next = tabs.filter((k) => k.id !== id);
    setTabs(next);
    if (active === id) setActive(next[Math.max(0, idx - 1)]?.id ?? "");
    if (relatedFor === id) setRelatedFor(null);
    const res = await removeTrackedKeyword(projectId, id);
    if (!res.ok) {
      // restore on failure so the UI doesn't silently lose the tab
      setTabs(tabs);
      toast.error(res.error);
      return;
    }
    toast.success(t("keywordDeleted"));
  }

  // ── 키워드 선택 삭제 ──
  function toggleSelectMode() {
    setSelectMode((on) => !on);
    setSelectedTabs(new Set());
  }

  function toggleTabSelected(id: string) {
    setSelectedTabs((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  const allTabsSelected = tabs.length > 0 && tabs.every((k) => selectedTabs.has(k.id));

  function toggleAllTabs() {
    setSelectedTabs(allTabsSelected ? new Set() : new Set(tabs.map((k) => k.id)));
  }

  async function deleteSelectedKeywords() {
    const ids = [...selectedTabs];
    if (ids.length === 0) return;

    // Pessimistic: the tabs only disappear once the server confirms the delete.
    // The single-tab delete is optimistic-with-rollback, but rolling back N tabs
    // (and the active/related selections that moved with them) is far more state
    // to unwind than a brief spinner is worth.
    setDeletingKeywords(true);
    const res = await removeTrackedKeywords(projectId, ids);
    setDeletingKeywords(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }

    const removed = new Set(ids);
    setActive(nextActiveAfterRemoval(tabs, removed, active));
    if (relatedFor && removed.has(relatedFor)) setRelatedFor(null);
    setTabs(tabs.filter((k) => !removed.has(k.id)));
    setSelectedTabs(new Set());
    setSelectMode(false);
    toast.success(t("deleteSelectedSuccess", { count: res.value.count }));
  }

  async function submitManualAdd() {
    if (await addKeyword(newKeyword)) {
      setNewKeyword("");
      setAdding(false);
    }
  }

  async function addSelectedRelated() {
    const terms = [...checkedRelated].filter((term) => !existingLabels.has(term));
    if (terms.length === 0) return;
    setSavingKeyword(true);
    const created: Tab[] = [];
    for (const term of terms) {
      const res = await addTrackedKeyword(projectId, { term, country });
      if (res.ok) created.push({ id: res.value.id, label: term });
      else toast.error(res.error);
    }
    setSavingKeyword(false);
    if (created.length === 0) return;
    setTabs((prev) => [...prev, ...created]);
    setActive(created[created.length - 1].id);
    setCheckedRelated(new Set());
    toast.success(t("keywordAdded"));
  }

  function toggleChecked(term: string) {
    setCheckedRelated((prev) => {
      const n = new Set(prev);
      if (n.has(term)) n.delete(term);
      else n.add(term);
      return n;
    });
  }

  function toggleAllRelated() {
    setCheckedRelated(allChecked ? new Set() : new Set(addableTerms));
  }

  function toggleApplied(rowId: string) {
    const key = rowKey(rowId);
    setAppliedMap((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  function onAddSerpCandidate(rowId: string, prompt: string) {
    if (!canEdit || !activeTab) return;
    startTransition(async () => {
      const r = await addCandidate(projectId, "google_keyword", prompt, activeTab.label);
      if (r.ok) {
        toast.success(t("addToPromptSuccess"));
        setAddedSerpIds((prev) => new Set(prev).add(rowKey(rowId)));
      } else {
        toast.error(r.error);
      }
    });
  }

  // Bulk-add every "적용" (applied) checked row that hasn't been sent yet —
  // previously the checkbox only fed the count badge, with no batch action.
  function onAddSelectedSerpCandidates() {
    if (!canEdit || !activeTab || pendingApplied.length === 0) return;
    const targets = pendingApplied;
    startTransition(async () => {
      const addedKeys: string[] = [];
      for (const row of targets) {
        const r = await addCandidate(projectId, "google_keyword", row.suggestedPrompt, activeTab.label);
        if (r.ok) addedKeys.push(rowKey(row.id));
        else toast.error(r.error);
      }
      if (addedKeys.length > 0) {
        setAddedSerpIds((prev) => {
          const next = new Set(prev);
          addedKeys.forEach((k) => next.add(k));
          return next;
        });
        toast.success(t("addToPromptSuccess"));
      }
    });
  }

  // ── SERP 선택 삭제 ──
  // The "적용" checkbox already marks rows for the bulk send, so it doubles as
  // the selection for removal rather than adding a second checkbox column.
  // Removing also clears the row's applied/added marks: if 재생성 brings the row
  // back it should return unmarked, not silently pre-checked.
  function removeSelectedSerpRows() {
    const keys = serpRows.map((r) => rowKey(r.id)).filter((k) => appliedMap[k]);
    if (keys.length === 0) return;
    setHiddenSerpIds((prev) => {
      const next = new Set(prev);
      keys.forEach((k) => next.add(k));
      return next;
    });
    setAppliedMap((prev) => {
      const next = { ...prev };
      keys.forEach((k) => delete next[k]);
      return next;
    });
    setAddedSerpIds((prev) => {
      const next = new Set(prev);
      keys.forEach((k) => next.delete(k));
      return next;
    });
    toast.success(t("removeSelectedSuccess", { count: keys.length }));
  }

  // Restore only the rows hidden under the current (tab, country).
  function restoreHiddenSerpRows() {
    const keys = new Set(allSerpRows.map((r) => rowKey(r.id)));
    setHiddenSerpIds((prev) => restoreHidden(prev, keys));
  }

  // Fresh project, no tracked keyword yet — a full trend/SERP dashboard with
  // nothing to show would just be empty states everywhere. Show a dedicated
  // search-first flow instead; saving at least one keyword populates `tabs`,
  // which flips this component into the normal dashboard below on re-render.
  if (tabs.length === 0) {
    return (
      <KeywordSearchStart
        projectId={projectId}
        canEdit={canEdit}
        country={country}
        onSaved={(created) => {
          setTabs((prev) => [...prev, ...created]);
          setActive(created[created.length - 1]?.id ?? "");
        }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* ─── Keyword tab strip (manage/delete/add) + filters ─── */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div
          role={selectMode ? "group" : "tablist"}
          aria-label={t("keywordTabsLabel")}
          className="flex flex-wrap items-center gap-1.5"
        >
          {tabs.map((k) => {
            const sel = k.id === active;
            const panelOpen = relatedFor === k.id;

            // In select mode the chip stops being a tab: the whole chip becomes
            // one checkbox label, so a mis-aimed click selects instead of
            // silently navigating away mid-selection.
            if (selectMode) {
              const checked = selectedTabs.has(k.id);
              return (
                <label
                  key={k.id}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 transition-colors",
                    checked
                      ? "border-brand-700 bg-brand-700/5"
                      : "border-border bg-card hover:border-brand-700/40",
                  )}
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={() => toggleTabSelected(k.id)}
                    disabled={deletingKeywords}
                  />
                  <span className="max-w-[11rem] truncate text-xs font-medium text-foreground">
                    {k.label}
                  </span>
                </label>
              );
            }

            return (
              <div
                key={k.id}
                className={cn(
                  "flex items-center rounded-md border transition-colors",
                  sel ? "border-brand-700 bg-brand-700/5" : "border-border bg-card",
                )}
              >
                <button
                  role="tab"
                  aria-selected={sel}
                  onClick={() => setActive(k.id)}
                  className={cn(
                    "max-w-[11rem] truncate rounded-l-md px-3 py-1.5 text-xs font-medium transition-colors",
                    sel ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {k.label}
                </button>
                <button
                  type="button"
                  onClick={() => setRelatedFor((cur) => (cur === k.id ? null : k.id))}
                  aria-label={t("manage")}
                  title={t("manage")}
                  className={cn(
                    "px-1.5 py-1.5 transition-colors hover:text-brand-700",
                    panelOpen ? "text-brand-700" : "text-muted-foreground",
                  )}
                >
                  <ListTree className="h-3.5 w-3.5" aria-hidden />
                </button>
                {canEdit && (
                  <button
                    type="button"
                    onClick={() => deleteKeyword(k.id)}
                    disabled={savingKeyword}
                    aria-label={t("delete")}
                    title={t("delete")}
                    className="rounded-r-md px-1.5 py-1.5 text-muted-foreground transition-colors hover:text-destructive disabled:opacity-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </button>
                )}
              </div>
            );
          })}
          {canEdit &&
            !selectMode &&
            (adding ? (
              <Input
                autoFocus
                value={newKeyword}
                onChange={(e) => setNewKeyword(e.target.value)}
                disabled={savingKeyword}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void submitManualAdd();
                  } else if (e.key === "Escape") {
                    setNewKeyword("");
                    setAdding(false);
                  }
                }}
                onBlur={() => {
                  if (!newKeyword.trim()) setAdding(false);
                }}
                placeholder={t("addKeywordPlaceholder")}
                className="h-8 w-44 text-xs"
              />
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t("addKeyword")}
                title={t("addKeyword")}
                onClick={() => setAdding(true)}
                className="text-muted-foreground"
              >
                <Plus className="h-4 w-4" aria-hidden />
              </Button>
            ))}
        </div>
        <div className="flex items-center gap-2">
          {canEdit && (
            <Button
              type="button"
              variant={selectMode ? "secondary" : "outline"}
              size="sm"
              onClick={toggleSelectMode}
              disabled={deletingKeywords}
              icon={selectMode ? <X className="h-3.5 w-3.5" /> : <ListChecks className="h-3.5 w-3.5" />}
            >
              {selectMode ? t("exitSelect") : t("enterSelect")}
            </Button>
          )}
          <Select value={range} onValueChange={(v) => setRange(v as Range)}>
            <SelectTrigger size="sm" className="min-w-[6rem]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RANGES.map((r) => (
                <SelectItem key={r} value={r}>
                  {t(`range.${r}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={country} onValueChange={(v) => setCountry(v as Country)}>
            <SelectTrigger size="sm" className="min-w-[8rem]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {countryOptions.map((c) => (
                <SelectItem key={c} value={c}>
                  {countryName(c, locale)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* ─── 키워드 선택 삭제 바 ─── */}
      {selectMode && (
        <div className="animate-fade-in flex flex-wrap items-center gap-3 rounded-lg border border-border bg-muted/30 px-4 py-2.5">
          <label className="flex cursor-pointer items-center gap-2">
            <Checkbox
              checked={allTabsSelected}
              onCheckedChange={toggleAllTabs}
              disabled={deletingKeywords}
              aria-label={t("selectAllKeywords")}
            />
            <span className="text-xs font-medium text-foreground">
              {t("selectAllKeywords")}
            </span>
          </label>
          <Badge variant="secondary" className="font-normal">
            {t("keywordsSelected", { count: selectedTabs.size })}
          </Badge>
          <div className="ml-auto flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={selectedTabs.size === 0}
              pending={deletingKeywords}
              onClick={deleteSelectedKeywords}
              className="text-muted-foreground hover:text-destructive"
              icon={<Trash2 className="h-3.5 w-3.5" />}
            >
              {t("deleteSelected")}
            </Button>
          </div>
        </div>
      )}

      {/* ─── 관련 검색어 패널 ─── */}
      {relatedSeed && (
        <RelatedSearchPanel
          seedLabel={relatedSeed.label}
          status={currentRelated?.status ?? "loading"}
          items={relatedData?.items ?? []}
          foundCount={relatedData?.foundCount ?? 0}
          checked={checkedRelated}
          allChecked={allChecked}
          existingLabels={existingLabels}
          onClose={() => setRelatedFor(null)}
          onRetry={() => loadRelated(relatedSeed, true)}
          onToggleChecked={toggleChecked}
          onToggleAll={toggleAllRelated}
          onAdd={addKeyword}
          onAddSelected={addSelectedRelated}
        />
      )}

      {/* ─── Trend chart + average-interest gauge ─── */}
      <InfoTooltipProvider delayDuration={200}>
      <div className="grid gap-4 lg:grid-cols-[1fr_220px]">
        <div className="rounded-lg border border-border bg-card p-4">
          <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {t("trendTitle")}
            <ColInfo title={t("trendTitle")} definition={t("trendInfo")} />
          </h3>
          <div className="h-56 min-w-0">
            {currentInsight?.status === "loading" ? (
              <CenterState icon="spin" label={t("loading")} />
            ) : currentInsight?.status === "error" ? (
              <CenterState
                icon="error"
                label={t("loadError")}
                action={
                  activeTab ? (
                    <Button variant="outline" size="sm" onClick={() => loadInsight(activeTab, true)}>
                      <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                      {t("retry")}
                    </Button>
                  ) : null
                }
              />
            ) : displayTrend.length === 0 ? (
              <CenterState label={t("trendEmpty")} />
            ) : (
              <ResponsiveContainer
                width="100%"
                height="100%"
                initialDimension={{ width: 560, height: 224 }}
              >
                <LineChart data={displayTrend} margin={{ left: -16, right: 8, top: 4, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" />
                  <XAxis dataKey="week" tick={{ fontSize: 11 }} stroke="rgba(0,0,0,0.4)" minTickGap={24} />
                  <YAxis tick={{ fontSize: 11 }} stroke="rgba(0,0,0,0.4)" domain={[0, 100]} />
                  <Tooltip contentStyle={CHART_TOOLTIP_STYLE} itemSorter={(item) => -Number(item.value ?? 0)} wrapperStyle={{ zIndex: 50 }} />
                  <Line
                    type="monotone"
                    dataKey="primary"
                    name={activeTab?.label}
                    stroke="var(--color-brand-700)"
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
        <AvgInterestGauge
          value={avgInterest}
          ready={currentInsight?.status === "ready" && displayTrend.length > 0}
          label={t("avgTitle")}
          info={<ColInfo title={t("avgTitle")} definition={t("avgInfo")} />}
        />
      </div>
      </InfoTooltipProvider>

      {/* ─── SERP & 프롬프트 생성 ─── */}
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold tracking-tight text-foreground">
              {t("serpTitle")}
            </h3>
            {hiddenCount > 0 && (
              <span className="text-[11px] text-muted-foreground" title={t("removeHint")}>
                {t("removedCount", { count: hiddenCount })}
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary" className="font-normal">
              {t("appliedCount", { count: appliedCount })}
            </Badge>
            {canEdit && appliedCount > 0 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={removeSelectedSerpRows}
                className="text-muted-foreground hover:text-destructive"
                icon={<Trash2 className="h-3.5 w-3.5" />}
              >
                {t("removeSelected")}
              </Button>
            )}
            {hiddenCount > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={restoreHiddenSerpRows}
                className="text-muted-foreground"
                icon={<Undo2 className="h-3.5 w-3.5" />}
              >
                {t("restoreRemoved")}
              </Button>
            )}
            {canEdit && pendingApplied.length > 0 && (
              <Button
                type="button"
                size="sm"
                pending={pending}
                onClick={onAddSelectedSerpCandidates}
                icon={<Plus className="h-3.5 w-3.5" />}
              >
                {t("addSelected")}
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!activeTab}
              pending={currentInsight?.status === "loading"}
              onClick={() => activeTab && loadInsight(activeTab, true)}
              icon={<RefreshCw className="h-3.5 w-3.5" />}
            >
              {t("regenerate")}
            </Button>
          </div>
        </div>
        {currentInsight?.status === "loading" ? (
          <div className="py-12">
            <CenterState icon="spin" label={t("loading")} />
          </div>
        ) : currentInsight?.status === "error" ? (
          <div className="py-12">
            <CenterState
              icon="error"
              label={t("loadError")}
              action={
                activeTab ? (
                  <Button variant="outline" size="sm" onClick={() => loadInsight(activeTab, true)}>
                    <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                    {t("retry")}
                  </Button>
                ) : null
              }
            />
          </div>
        ) : serpRows.length === 0 ? (
          <div className="py-12">
            <CenterState label={t("serpEmpty")} />
          </div>
        ) : (
          <table className="w-full table-fixed text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30 text-left text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                <th className="w-14 px-3 py-2 text-center">
                  <SortableHeader {...serpHeader("applied")}>{t("apply")}</SortableHeader>
                </th>
                <th className="w-10 px-3 py-2">
                  <SortableHeader {...serpHeader("rank")} align="right">#</SortableHeader>
                </th>
                <th className="w-[26%] px-3 py-2">
                  <SortableHeader {...serpHeader("title")}>{t("col.titleUrl")}</SortableHeader>
                </th>
                <th className="w-[32%] px-3 py-2">{t("col.snippet")}</th>
                <th className="w-[26%] px-3 py-2">
                  <SortableHeader {...serpHeader("suggested")}>{t("suggested")}</SortableHeader>
                </th>
                <th className="w-12 px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {serpSorted.map((row) => (
                <tr key={row.id} className="border-t border-border first:border-t-0 align-top">
                  <td className="px-3 py-3 text-center">
                    <Checkbox
                      checked={appliedMap[rowKey(row.id)] ?? false}
                      onCheckedChange={() => toggleApplied(row.id)}
                      aria-label={t("apply")}
                    />
                  </td>
                  <td className="px-3 py-3 text-right text-xs font-semibold tabular-nums text-muted-foreground">
                    {row.rank}
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex min-w-0 flex-col gap-1">
                      <span className="line-clamp-2 text-sm font-medium text-foreground">
                        {row.title}
                      </span>
                      <a
                        href={`https://${row.url}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={row.url}
                        className="block truncate text-[11px] text-brand-700 hover:underline"
                      >
                        {row.url}
                      </a>
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <span className="line-clamp-3 text-xs text-muted-foreground">
                      {row.snippet}
                    </span>
                  </td>
                  <td className="px-3 py-3">
                    <span className="line-clamp-3 text-xs text-foreground">
                      {row.suggestedPrompt}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-center">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={!canEdit || pending || addedSerpIds.has(rowKey(row.id))}
                      onClick={() => onAddSerpCandidate(row.id, row.suggestedPrompt)}
                      aria-label={addedSerpIds.has(rowKey(row.id)) ? t("addToPromptDone") : t("addToPrompt")}
                      title={addedSerpIds.has(rowKey(row.id)) ? t("addToPromptDone") : t("addToPrompt")}
                      className={cn(addedSerpIds.has(rowKey(row.id)) ? "text-emerald-600" : "text-brand-700")}
                    >
                      {addedSerpIds.has(rowKey(row.id)) ? (
                        <Check className="h-4 w-4" aria-hidden />
                      ) : (
                        <Plus className="h-4 w-4" aria-hidden />
                      )}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// Centered loading / error / empty placeholder for a card body.
function CenterState({
  icon,
  label,
  action,
}: {
  icon?: "spin" | "error";
  label: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex h-full min-h-32 flex-col items-center justify-center gap-2 text-center">
      {icon === "spin" ? (
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden />
      ) : icon === "error" ? (
        <AlertCircle className="h-5 w-5 text-destructive" aria-hidden />
      ) : null}
      <span className="text-xs text-muted-foreground">{label}</span>
      {action}
    </div>
  );
}

// 관련 검색어 패널 — live keyword suggestions for a seed. Each row promotes to a
// new tracked keyword via "+". Flat list (DataForSEO suggestions have no
// long-tail hierarchy); volume + intent come straight from the API.
function RelatedSearchPanel({
  seedLabel,
  status,
  items,
  foundCount,
  checked,
  allChecked,
  existingLabels,
  onClose,
  onRetry,
  onToggleChecked,
  onToggleAll,
  onAdd,
  onAddSelected,
}: {
  seedLabel: string;
  status: "loading" | "ready" | "error";
  items: RelatedItem[];
  foundCount: number;
  checked: Set<string>;
  allChecked: boolean;
  existingLabels: Set<string>;
  onClose: () => void;
  onRetry: () => void;
  onToggleChecked: (term: string) => void;
  onToggleAll: () => void;
  onAdd: (term: string) => void;
  onAddSelected: () => void;
}) {
  const t = useTranslations("projectDetail.intent.googleKeyword");
  const selectedCount = checked.size;

  return (
    <div className="animate-fade-in overflow-hidden rounded-lg border border-border bg-card shadow-soft">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold tracking-tight text-foreground">
            {t("related.title", { keyword: seedLabel })}
          </h3>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {status === "ready"
              ? `${t("related.analysisComplete")} · ${t("related.found", { count: foundCount })}`
              : status === "loading"
                ? t("related.loading")
                : t("related.error")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {status === "ready" && selectedCount > 0 && (
            <Button type="button" size="sm" onClick={onAddSelected}>
              <Plus className="h-3.5 w-3.5" aria-hidden />
              {t("related.addSelected")} · {t("related.selected", { count: selectedCount })}
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label={t("related.close")}
            title={t("related.close")}
            className="text-muted-foreground"
          >
            <X className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      </div>

      {status === "loading" ? (
        <div className="py-10">
          <CenterState icon="spin" label={t("related.loading")} />
        </div>
      ) : status === "error" ? (
        <div className="py-10">
          <CenterState
            icon="error"
            label={t("related.error")}
            action={
              <Button variant="outline" size="sm" onClick={onRetry}>
                <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                {t("retry")}
              </Button>
            }
          />
        </div>
      ) : items.length === 0 ? (
        <div className="py-10">
          <CenterState label={t("related.empty")} />
        </div>
      ) : (
        <div className="max-h-80 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10">
              <tr className="border-b border-border bg-muted/40 text-left text-[10px] font-semibold tracking-wide text-muted-foreground uppercase backdrop-blur">
                <th className="w-10 px-3 py-2 text-center">
                  <Checkbox checked={allChecked} onCheckedChange={onToggleAll} aria-label={t("related.selectAll")} />
                </th>
                <th className="px-3 py-2">{t("related.colKeyword")}</th>
                <th className="w-28 px-3 py-2 text-right">{t("related.colVolume")}</th>
                <th className="w-28 px-3 py-2">{t("related.colIntent")}</th>
                <th className="w-10 px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <RelatedRow
                  key={r.id}
                  term={r.term}
                  volume={r.volume}
                  intent={r.intent}
                  added={existingLabels.has(r.term)}
                  isChecked={checked.has(r.term)}
                  onToggleChecked={() => onToggleChecked(r.term)}
                  onAdd={() => onAdd(r.term)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function RelatedRow({
  term,
  volume,
  intent,
  added,
  isChecked,
  onToggleChecked,
  onAdd,
}: {
  term: string;
  volume: number;
  intent: SearchIntent;
  added: boolean;
  isChecked: boolean;
  onToggleChecked: () => void;
  onAdd: () => void;
}) {
  const t = useTranslations("projectDetail.intent.googleKeyword");
  return (
    <tr className="border-t border-border first:border-t-0">
      <td className="px-3 py-2 text-center">
        <Checkbox checked={isChecked} onCheckedChange={onToggleChecked} aria-label={term} />
      </td>
      <td className="px-3 py-2">
        <span className="text-sm text-foreground">{term}</span>
      </td>
      <td className="px-3 py-2 text-right text-xs tabular-nums text-foreground">
        {volume.toLocaleString()}
      </td>
      <td className="px-3 py-2">
        <span className={cn("inline-flex rounded px-1.5 py-0.5 text-[10px] font-medium", INTENT_TONE[intent])}>
          {t(`intent.${intent}`)}
        </span>
      </td>
      <td className="px-3 py-2 text-center">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={added}
          onClick={onAdd}
          aria-label={added ? t("related.added") : t("related.add")}
          title={added ? t("related.added") : t("related.add")}
          className={added ? "text-emerald-600" : "text-brand-700"}
        >
          {added ? <Check className="h-4 w-4" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />}
        </Button>
      </td>
    </tr>
  );
}

// 평균 관심도 vertical gauge — thermometer-like fill proportional to the score.
function AvgInterestGauge({
  value,
  ready,
  label,
  info,
}: {
  value: number;
  ready: boolean;
  label: string;
  info?: React.ReactNode;
}) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div className="flex flex-col items-stretch gap-3 rounded-lg border border-border bg-card p-4">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {label}
        {info}
      </h3>
      <div className="flex flex-1 items-end gap-3">
        <div className="relative h-40 w-3 flex-shrink-0 overflow-hidden rounded-full bg-muted">
          <div
            className="absolute right-0 bottom-0 left-0 rounded-full bg-brand-700 transition-[height]"
            style={{ height: `${ready ? clamped : 0}%` }}
          />
        </div>
        <div className="flex flex-col">
          <span className="font-head text-3xl font-semibold tracking-tight tabular-nums text-foreground">
            {ready ? clamped : "–"}
          </span>
          <span className="text-[11px] text-muted-foreground">/100</span>
        </div>
      </div>
    </div>
  );
}
