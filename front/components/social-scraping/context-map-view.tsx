"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  addCandidates,
  generateMoreSocialPrompts,
  generateSelectedSocialPrompts,
  removeSocialPrompts,
} from "@/app/[locale]/(dash)/projects/[id]/intent/_actions";
import {
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  Plus,
  Search,
  Send,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SortableHeader } from "@/components/ui/sortable-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSortableTable } from "@/hooks/use-sortable-table";
import { cn } from "@/lib/utils";
import { getGeneratedPrompts } from "./sample-data";
import {
  pageSampleCombinations,
  pageSampleConditions,
  pageSampleContexts,
  sampleEntityDetail,
} from "@/lib/social-scraping/page-matrix";
import { dateStamp } from "@/lib/export/csv";
import {
  fetchContextMapPage,
  usePagedTab,
  type PagedTabState,
} from "./use-paged-tab";
import type {
  CombinationListRow,
  CombinationListSort,
  ConditionListRow,
  ConditionListSort,
  ContextEntityDetail,
  ContextListRow,
  ContextListSort,
  ContextMapExportData,
  ContextMapQuery,
  ContextMapStats,
  ContextMatrix,
  GeneratedPrompt,
  GraphSelection,
  Paged,
  Perspective,
  PerspectiveBreakdown,
  PromptLayer,
} from "./types";

// Names read naturally ascending; counts descending.
const ASC_BY_DEFAULT = ["name"] as const;

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// 4 stacked card-tables (2026-06-08 restructure). The original cytoscape
// graph + side-rail browse panel was replaced with explicit tables so
// the page reads as a flat, sortable inventory: 구매 맥락 / 구매 조건 /
// 조합 패턴 / 추천 프롬프트(2026-09-03 개명 — 이전 라벨 "프롬프트 카탈로그에
// 추가 리스트"는 탭 이름이 아니라 동작 설명이었다). Per-row 자세히보기 opens
// the previous DetailPanel content as a centered Dialog.
export function ContextMapView({
  keyword,
  sampleMatrix,
  stats,
  initialPages,
  mode,
  projectId,
  generatedPrompts,
  addedTexts,
  onBack,
  readOnly = false,
  genericTitle = false,
}: {
  /** Header keyword. Absent on the live route (genericTitle covers it). */
  keyword?: string;
  /**
   * Present ⇒ SAMPLE source: the fixture is paged in memory here, because the
   * demo routes have no endpoint to page against. Absent ⇒ LIVE source: pages
   * come from /api/context-map. Everything below this prop is identical either
   * way — the view never branches on data source again.
   */
  sampleMatrix?: ContextMatrix;
  /** Corpus-wide totals for the header line. */
  stats: ContextMapStats;
  /** Server-rendered first page of each tab. */
  initialPages: {
    contexts: Paged<ContextListRow>;
    conditions: Paged<ConditionListRow>;
    combinations: Paged<CombinationListRow>;
  };
  mode: "standard" | "admin";
  /**
   * Project intent route only — lets the 프롬프트 카탈로그 추가 send action
   * persist to that project's candidate pool. Absent elsewhere → demo toast.
   */
  projectId?: string;
  /** Omit in read-only mode — no "back" anchors to a prior stage. */
  onBack?: () => void;
  /**
   * Read-only renders 3 tables (구매 맥락 / 구매 조건 / 조합 패턴) + export.
   * The 프롬프트 카탈로그 추가 list is hidden because that table's send action
   * implies write access (project/standard catalog mutation).
   */
  readOnly?: boolean;
  /**
   * Drops the `: "{keyword}"` suffix from the header — every project shows
   * the same fake industry-wide sample matrix, so labeling it with a
   * per-project/per-search keyword is misleading (nothing is actually
   * scoped to that keyword).
   */
  genericTitle?: boolean;
  /**
   * Server-generated candidate prompts (decision B, 2026-07-09) built from the
   * real context matrix + this project's brand context. Absent on read-only /
   * admin surfaces (or when generation failed) → CatalogTable falls back to the
   * static sample fixture.
   */
  generatedPrompts?: GeneratedPrompt[];
  /** Candidate texts already in the pool → CatalogTable marks them 이미 추가됨. */
  addedTexts?: string[];
}) {
  const t = useTranslations("socialScraping.contextMap");
  const locale = useLocale();
  const [selection, setSelection] = useState<GraphSelection>(null);
  const [activeTab, setActiveTab] = useState("contexts");

  // Prompt list lives HERE, not in CatalogTable: Radix unmounts inactive tab
  // content, and the 구성(composer) flow appends generated rows from outside
  // the catalog tab — both need the state to outlive the tab.
  //
  // Fixture policy (2026-07-16): on the REAL surface (projectId), the list is
  // the server cache — when it's empty, CatalogTable auto-generates on tab open
  // and failures show an honest empty+retry state, never the sample fixture. A
  // fixture row is indistinguishable from a real one in the UI and can be sent
  // to the real candidate pool. Demo surfaces (no projectId) keep the fixture.
  const [prompts, setPrompts] = useState<GeneratedPrompt[]>(() => {
    if (generatedPrompts) return generatedPrompts.filter((p) => !p.removed);
    if (projectId) return [];
    return getGeneratedPrompts(locale);
  });

  // ─── 구성(composition) picks — explore rows the user has 담기'd. ───
  // Generation + the per-project cache are project-scoped, so the flow only
  // exists on the project intent route (projectId) and never in read-only.
  const canCompose = Boolean(projectId) && !readOnly;
  const [pickedContexts, setPickedContexts] = useState<ReadonlyMap<string, string>>(
    new Map(),
  );
  const [pickedConditions, setPickedConditions] = useState<ReadonlyMap<string, string>>(
    new Map(),
  );
  const [pickedCombos, setPickedCombos] = useState<ReadonlyMap<string, CombinationListRow>>(
    new Map(),
  );

  function toggleIn<V>(
    set: React.Dispatch<React.SetStateAction<ReadonlyMap<string, V>>>,
    key: string,
    value: V,
  ) {
    set((prev) => {
      const next = new Map(prev);
      if (next.has(key)) next.delete(key);
      else next.set(key, value);
      return next;
    });
  }

  function clearPicks() {
    setPickedContexts(new Map());
    setPickedConditions(new Map());
    setPickedCombos(new Map());
  }

  function handleComposed(fresh: GeneratedPrompt[]) {
    setPrompts((prev) => {
      const ids = new Set(prev.map((p) => p.id));
      return [...prev, ...fresh.filter((p) => !ids.has(p.id))];
    });
    clearPicks();
    setActiveTab("catalog");
  }

  // One fetcher per tab, picked once from the data source. Stable identity —
  // usePagedTab lists it in an effect's deps.
  const fetchContexts = useMemo(
    () =>
      sampleMatrix
        ? async (q: ContextMapQuery<ContextListSort>) => pageSampleContexts(sampleMatrix, q)
        : fetchContextMapPage<ContextListRow, ContextListSort>("contexts"),
    [sampleMatrix],
  );
  const fetchConditions = useMemo(
    () =>
      sampleMatrix
        ? async (q: ContextMapQuery<ConditionListSort>) => pageSampleConditions(sampleMatrix, q)
        : fetchContextMapPage<ConditionListRow, ConditionListSort>("conditions"),
    [sampleMatrix],
  );
  const fetchCombinations = useMemo(
    () =>
      sampleMatrix
        ? async (q: ContextMapQuery<CombinationListSort>) =>
            pageSampleCombinations(sampleMatrix, q)
        : fetchContextMapPage<CombinationListRow, CombinationListSort>("combinations"),
    [sampleMatrix],
  );

  const contextsTab = usePagedTab<ContextListRow, ContextListSort>({
    initial: initialPages.contexts,
    defaultSort: "mentions",
    ascByDefault: ASC_BY_DEFAULT,
    fetchPage: fetchContexts,
  });
  const conditionsTab = usePagedTab<ConditionListRow, ConditionListSort>({
    initial: initialPages.conditions,
    defaultSort: "mentions",
    ascByDefault: ASC_BY_DEFAULT,
    fetchPage: fetchConditions,
  });
  const combinationsTab = usePagedTab<CombinationListRow, CombinationListSort>({
    initial: initialPages.combinations,
    defaultSort: "cooccurrence",
    fetchPage: fetchCombinations,
  });

  // ─── Excel 내보내기 ───
  //
  // 2026-09-03: 이 버튼은 도입 이래 `toast.success(… "(데모)")` 만 호출하는
  // 스텁이어서, 누르면 성공 토스트가 뜨는데 파일은 만들어지지 않았다. 고객이
  // 보고한 "동작하지 않는다"의 정체가 이것이다.
  //
  // 두 데이터 소스를 그대로 따른다 — LIVE 는 /api/context-map/export 가
  // repository 전량 조회(listAllForExport) 후 서버에서 워크북을 만들고,
  // SAMPLE 은 붙을 DB 가 없으니 같은 빌더를 브라우저에서 돌린다(exceljs 는
  // 동적 import 라 초기 번들에 들어가지 않는다).
  //
  // 시트명·헤더는 전부 messages/{ko,en}.json 에서 읽어 넘긴다(경계 #4).
  const [exporting, setExporting] = useState(false);

  async function handleExport() {
    if (exporting) return;
    setExporting(true);
    const labels = {
      sheets: {
        contexts: t("contextsSection"),
        conditions: t("conditionsSection"),
        combinations: t("combinationsSection"),
      },
      cols: {
        name: t("col.name"),
        theme: t("col.theme"),
        category: t("col.category"),
        positive: t("perspective.buyer"),
        negative: t("perspective.seller"),
        neutral: t("perspective.neutral"),
        drivenConditions: t("col.drivenConditions"),
        drivenByContexts: t("col.drivenByContexts"),
        mentions: t("col.mentions"),
        conditionA: t("col.conditionA"),
        conditionB: t("col.conditionB"),
        frequency: t("col.frequency"),
        cooccurrence: t("col.cooccurrence"),
      },
      frequency: {
        high: t("frequency.high"),
        medium: t("frequency.medium"),
        low: t("frequency.low"),
      },
    };
    const filename = `${t("exportFilename")}-${dateStamp()}.xlsx`;

    try {
      let blob: Blob;
      if (sampleMatrix) {
        const { buildContextMapWorkbook } = await import(
          "@/lib/social-scraping/context-map-export"
        );
        // The fixture pager has no size clamp (the live repository does) — one
        // "page" the size of the fixture IS the whole fixture.
        const all = { page: 0, size: Number.MAX_SAFE_INTEGER } as const;
        const data: ContextMapExportData = {
          contexts: pageSampleContexts(sampleMatrix, {
            sort: "mentions",
            dir: "desc",
            ...all,
          }).rows,
          conditions: pageSampleConditions(sampleMatrix, {
            sort: "mentions",
            dir: "desc",
            ...all,
          }).rows,
          combinations: pageSampleCombinations(sampleMatrix, {
            sort: "cooccurrence",
            dir: "desc",
            ...all,
          }).rows,
        };
        const bytes = await buildContextMapWorkbook(data, labels);
        blob = new Blob([bytes], { type: XLSX_MIME });
      } else {
        const res = await fetch("/api/context-map/export", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // lang (C4, unit U10): the API source builds the sheets server-side in this language.
          body: JSON.stringify({ labels, filename, lang: locale }),
        });
        if (!res.ok) throw new Error(`export failed: ${res.status}`);
        blob = await res.blob();
      }

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success(t("exportSuccess"));
    } catch (err) {
      console.error("[context-map] export failed:", err);
      toast.error(t("exportError"));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {/* ─── Header ─── */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-center gap-2">
          {onBack ? (
            <Button variant="ghost" size="icon-sm" onClick={onBack} title={t("back")}>
              <ArrowLeft className="h-4 w-4" aria-hidden />
            </Button>
          ) : null}
          <div className="min-w-0">
            <h2 className="truncate font-head text-lg font-semibold tracking-tight text-foreground">
              {genericTitle ? t("titleGeneric") : t("title", { keyword: keyword ?? "" })}
            </h2>
            {/* 관계·소스가 무엇을 세는지 숫자만으로는 알 수 없다 — "관계"는 두 종류의
                간선(맥락→조건 drives + 조건↔조건 combinations)의 합이라 어느 탭의
                행 수와도 일치하지 않고, "소스"는 문서가 아니라 고유 도메인 수다.
                라벨을 "출처 도메인"으로 좁히고, 합의 내역은 tooltip 으로 드러낸다.
                (수치 자체는 2026-09-03 미러 실측으로 검증 — 산식 오류는 없었다.) */}
            <p
              className="text-xs text-muted-foreground"
              title={t("summaryHint", {
                drives: stats.drives,
                combinations: stats.combinations,
              })}
            >
              {t("summaryLine", {
                contexts: stats.contexts,
                conditions: stats.conditions,
                relations: stats.relationships,
                sources: stats.sources,
              })}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleExport}
            disabled={exporting}
          >
            {exporting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <Download className="h-3.5 w-3.5" aria-hidden />
            )}
            {exporting ? t("exportPending") : t("exportExcel")}
          </Button>
        </div>
      </div>

      {/* ─── 구성 bar — visible while anything is 담긴 ─── */}
      {canCompose && projectId ? (
        <ComposerBar
          projectId={projectId}
          contexts={pickedContexts}
          conditions={pickedConditions}
          combos={pickedCombos}
          onRemoveContext={(id) => setPickedContexts((prev) => deleteKey(prev, id))}
          onRemoveCondition={(id) => setPickedConditions((prev) => deleteKey(prev, id))}
          onRemoveCombo={(id) => setPickedCombos((prev) => deleteKey(prev, id))}
          onClear={clearPicks}
          onGenerated={handleComposed}
        />
      ) : null}

      {/* ─── Tables, tabbed ─── */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="gap-4">
        <TabsList variant="line" className="self-start">
          <TabsTrigger value="contexts">{t("contextsSection")}</TabsTrigger>
          <TabsTrigger value="conditions">{t("conditionsSection")}</TabsTrigger>
          <TabsTrigger value="combinations">{t("combinationsSection")}</TabsTrigger>
          {readOnly ? null : (
            <TabsTrigger value="catalog">{t("catalogSection")}</TabsTrigger>
          )}
        </TabsList>
        <TabsContent value="contexts">
          <ContextsTable
            tab={contextsTab}
            onDetail={(id) => setSelection({ kind: "context", id })}
            picked={canCompose ? pickedContexts : undefined}
            onPick={
              canCompose ? (r) => toggleIn(setPickedContexts, r.id, r.name) : undefined
            }
          />
        </TabsContent>
        <TabsContent value="conditions">
          <ConditionsTable
            tab={conditionsTab}
            onDetail={(id) => setSelection({ kind: "condition", id })}
            picked={canCompose ? pickedConditions : undefined}
            onPick={
              canCompose ? (r) => toggleIn(setPickedConditions, r.id, r.name) : undefined
            }
          />
        </TabsContent>
        <TabsContent value="combinations">
          <CombinationsTable
            tab={combinationsTab}
            onDetail={(r) =>
              setSelection({
                kind: "combination",
                id: r.id,
                label: `${r.condAName} × ${r.condBName}`,
                condAId: r.condAId,
                condAName: r.condAName,
                condBId: r.condBId,
                condBName: r.condBName,
                coOccurrenceCount: r.coOccurrenceCount,
              })
            }
            picked={canCompose ? pickedCombos : undefined}
            onPick={canCompose ? (r) => toggleIn(setPickedCombos, r.id, r) : undefined}
          />
        </TabsContent>
        {readOnly ? null : (
          <TabsContent value="catalog">
            <CatalogTable
              mode={mode}
              projectId={projectId}
              prompts={prompts}
              setPrompts={setPrompts}
              addedTexts={addedTexts}
            />
          </TabsContent>
        )}
      </Tabs>

      <DetailDialog
        selection={selection}
        sampleMatrix={sampleMatrix}
        onClose={() => setSelection(null)}
        onJump={setSelection}
      />
    </div>
  );
}

function deleteKey<V>(map: ReadonlyMap<string, V>, key: string): ReadonlyMap<string, V> {
  const next = new Map(map);
  next.delete(key);
  return next;
}

// ─── Table shell ──────────────────────────────────────────────────────────

function TableShell({
  title,
  count,
  children,
  toolbar,
  footer,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
  /** Optional action bar rendered above the table (below the title header). */
  toolbar?: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-2.5">
        <h3 className="text-sm font-semibold tracking-tight text-foreground">
          {title}
        </h3>
        <Badge variant="secondary" className="font-normal tabular-nums">
          {count}
        </Badge>
      </div>
      {toolbar ? (
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
          {toolbar}
        </div>
      ) : null}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">{children}</table>
      </div>
      {footer ? (
        <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-2.5">
          {footer}
        </div>
      ) : null}
    </section>
  );
}

function DetailButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <Button type="button" variant="outline" size="sm" onClick={onClick}>
      <Search className="h-3 w-3" aria-hidden />
      {label}
    </Button>
  );
}

// 구성 flow row action — toggles the row in/out of the composer selection.
function PickButton({ picked, onClick }: { picked: boolean; onClick: () => void }) {
  const t = useTranslations("socialScraping.contextMap");
  return (
    <Button
      type="button"
      variant={picked ? "secondary" : "outline"}
      size="sm"
      onClick={onClick}
      className={cn(picked && "text-brand-700")}
    >
      {picked ? (
        <Check className="h-3 w-3" aria-hidden />
      ) : (
        <Plus className="h-3 w-3" aria-hidden />
      )}
      {picked ? t("pickAdded") : t("pickAdd")}
    </Button>
  );
}

// ─── 구성(composer) bar ─────────────────────────────────────────────────────
//
// Shows what the user has 담긴 from the three explore tables and turns exactly
// that selection into catalog prompts (server action → per-project cache). Only
// rendered on the project intent route; hidden while nothing is picked.

function ComposerBar({
  projectId,
  contexts,
  conditions,
  combos,
  onRemoveContext,
  onRemoveCondition,
  onRemoveCombo,
  onClear,
  onGenerated,
}: {
  projectId: string;
  contexts: ReadonlyMap<string, string>;
  conditions: ReadonlyMap<string, string>;
  combos: ReadonlyMap<string, CombinationListRow>;
  onRemoveContext: (id: string) => void;
  onRemoveCondition: (id: string) => void;
  onRemoveCombo: (id: string) => void;
  onClear: () => void;
  onGenerated: (fresh: GeneratedPrompt[]) => void;
}) {
  const t = useTranslations("socialScraping.contextMap.composer");
  const [cross, setCross] = useState(true);
  const [pending, startTransition] = useTransition();

  const total = contexts.size + conditions.size + combos.size;
  if (total === 0) return null;
  const canCross = contexts.size > 0 && conditions.size > 0;

  function onGenerate() {
    if (pending) return;
    startTransition(async () => {
      const r = await generateSelectedSocialPrompts(projectId, {
        contextIds: [...contexts.keys()],
        conditionIds: [...conditions.keys()],
        combinations: [...combos.values()].map((c) => ({
          condAId: c.condAId,
          condBId: c.condBId,
        })),
        cross: cross && canCross,
      });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      const { prompts: fresh, skippedExisting } = r.value;
      if (fresh.length === 0) {
        toast.info(t("noneGenerated"));
        return;
      }
      if (skippedExisting > 0) {
        toast.success(t("generatedSkipped", { count: fresh.length, skipped: skippedExisting }));
      } else {
        toast.success(t("generated", { count: fresh.length }));
      }
      onGenerated(fresh);
    });
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-brand-700/30 bg-brand-700/[0.03] px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <h3 className="text-sm font-semibold tracking-tight text-foreground">
            {t("title")}
          </h3>
          <p className="text-xs text-muted-foreground">{t("description")}</p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onClear}
          disabled={pending}
          className="shrink-0 text-muted-foreground"
        >
          {t("clear")}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {[...contexts.entries()].map(([id, name]) => (
          <PickedChip key={`ctx-${id}`} label={name} kind="context" onRemove={() => onRemoveContext(id)} />
        ))}
        {[...conditions.entries()].map(([id, name]) => (
          <PickedChip key={`cond-${id}`} label={name} kind="condition" onRemove={() => onRemoveCondition(id)} />
        ))}
        {[...combos.entries()].map(([id, c]) => (
          <PickedChip
            key={`combo-${id}`}
            label={`${c.condAName} × ${c.condBName}`}
            kind="combo"
            onRemove={() => onRemoveCombo(id)}
          />
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <label
          className={cn(
            "flex items-center gap-1.5 text-xs",
            canCross ? "cursor-pointer text-muted-foreground" : "text-muted-foreground/50",
          )}
        >
          <Checkbox
            checked={cross && canCross}
            disabled={!canCross || pending}
            onCheckedChange={(v) => setCross(v === true)}
            aria-label={t("crossLabel")}
          />
          {t("crossLabel")}
        </label>
        <Button onClick={onGenerate} disabled={pending} size="sm">
          <Sparkles className="h-4 w-4" aria-hidden />
          {pending ? t("generating") : t("generate")}
        </Button>
      </div>
    </section>
  );
}

function PickedChip({
  label,
  kind,
  onRemove,
}: {
  label: string;
  kind: "context" | "condition" | "combo";
  onRemove: () => void;
}) {
  const t = useTranslations("socialScraping.contextMap.composer");
  const kindLabel =
    kind === "context"
      ? t("chipContext")
      : kind === "condition"
        ? t("chipCondition")
        : t("chipCombo");
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs",
        kind === "context"
          ? "border-teal-200 bg-teal-50 text-teal-900"
          : kind === "condition"
            ? "border-amber-200 bg-amber-50 text-amber-900"
            : "border-border bg-muted/40 text-foreground",
      )}
    >
      <span className="text-[10px] font-semibold uppercase opacity-60">{kindLabel}</span>
      <span className="max-w-48 truncate">{label}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={t("removeChip", { name: label })}
        className="rounded-full p-0.5 opacity-60 transition-opacity hover:opacity-100"
      >
        <X className="h-3 w-3" aria-hidden />
      </button>
    </span>
  );
}

// ─── Shared list chrome (search + pagination) ─────────────────────────────

// Search box. Deferred inside usePagedTab, so this stays fully responsive.
function SearchBox({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div className="relative w-full max-w-xs">
      <Search
        className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <Input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-8 pl-8 text-xs"
      />
    </div>
  );
}

// "N results" + prev/next. `total` is the count across the whole corpus, so this
// is also what tells the user the list is not truncated — the header stats and
// the table used to disagree with nothing to explain the gap.
function Pager<T, S extends string>({ tab }: { tab: PagedTabState<T, S> }) {
  const t = useTranslations("socialScraping.contextMap");
  const first = tab.data.total === 0 ? 0 : tab.page * tab.data.size + 1;
  const last = Math.min((tab.page + 1) * tab.data.size, tab.data.total);
  return (
    <>
      <span className="text-[11px] tabular-nums text-muted-foreground">
        {t("pageRange", { first, last, total: tab.data.total })}
      </span>
      <div className="flex items-center gap-1.5">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={tab.page <= 0 || tab.loading}
          onClick={() => tab.setPage(tab.page - 1)}
          icon={<ChevronLeft className="h-3.5 w-3.5" />}
        >
          {t("prevPage")}
        </Button>
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {t("pageOf", { page: tab.page + 1, pages: tab.pageCount })}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={tab.page + 1 >= tab.pageCount || tab.loading}
          onClick={() => tab.setPage(tab.page + 1)}
        >
          {t("nextPage")}
          <ChevronRight className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </div>
    </>
  );
}

// Body state for a list: loading / error / empty. Every one of these was missing
// before — a zero-row table rendered as a bare header with an empty <tbody>.
function ListState({
  colSpan,
  loading,
  error,
  empty,
  onRetry,
}: {
  colSpan: number;
  loading: boolean;
  error: boolean;
  empty: boolean;
  onRetry: () => void;
}) {
  const t = useTranslations("socialScraping.contextMap");
  if (!loading && !error && !empty) return null;
  return (
    <tr>
      <td colSpan={colSpan} className="px-3 py-10 text-center">
        {loading ? (
          <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            {t("loading")}
          </span>
        ) : error ? (
          <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
            {t("loadError")}
            <Button type="button" variant="outline" size="sm" onClick={onRetry}>
              {t("retry")}
            </Button>
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">{t("noResults")}</span>
        )}
      </td>
    </tr>
  );
}

/** Rows are hidden (not unmounted) while a page is in flight, so the table does
 *  not collapse and re-expand on every keystroke. */
function bodyRows(loading: boolean, error: boolean, empty: boolean): boolean {
  return !loading && !error && !empty;
}

// ─── Table 1: Customer Contexts ───────────────────────────────────────────

function ContextsTable({
  tab,
  onDetail,
  picked,
  onPick,
}: {
  tab: PagedTabState<ContextListRow, ContextListSort>;
  onDetail: (id: string) => void;
  /** 구성 flow (project route only) — which rows are 담긴, and the toggle. */
  picked?: ReadonlyMap<string, string>;
  onPick?: (row: ContextListRow) => void;
}) {
  const t = useTranslations("socialScraping.contextMap");
  const show = bodyRows(tab.loading, tab.error, tab.data.rows.length === 0);
  return (
    <TableShell
      title={t("contextsSection")}
      count={tab.data.total}
      toolbar={
        <SearchBox
          value={tab.search}
          onChange={tab.setSearch}
          placeholder={t("searchContexts")}
        />
      }
      footer={<Pager tab={tab} />}
    >
      <thead>
        <tr className="border-b border-border text-left text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
          <th className="px-3 py-2">
            <SortableHeader
              active={tab.sort === "name"}
              asc={tab.dir === "asc"}
              onClick={() => tab.toggleSort("name")}
            >
              {t("col.name")}
            </SortableHeader>
          </th>
          <th className="px-3 py-2">{t("col.theme")}</th>
          <th className="px-3 py-2">{t("col.perspective")}</th>
          <th className="px-3 py-2 text-right">{t("col.drivenConditions")}</th>
          <th className="px-3 py-2 text-right">
            <SortableHeader
              active={tab.sort === "mentions"}
              asc={tab.dir === "asc"}
              onClick={() => tab.toggleSort("mentions")}
              align="right"
            >
              {t("col.mentions")}
            </SortableHeader>
          </th>
          <th className="w-24 px-3 py-2"></th>
        </tr>
      </thead>
      <tbody>
        <ListState
          colSpan={6}
          loading={tab.loading}
          error={tab.error}
          empty={tab.data.rows.length === 0}
          onRetry={tab.retry}
        />
        {show &&
          tab.data.rows.map((r) => (
            <tr key={r.id} className="border-t border-border first:border-t-0">
              <td className="px-3 py-2.5 text-sm font-medium text-foreground">{r.name}</td>
              <td className="px-3 py-2.5 text-xs text-muted-foreground">{r.themeName}</td>
              <td className="px-3 py-2.5">
                <PerspectiveBadge p={r.perspective} />
              </td>
              <td className="px-3 py-2.5 text-right text-xs tabular-nums text-muted-foreground">
                {r.linkedCount}
              </td>
              <td className="px-3 py-2.5 text-right text-xs tabular-nums text-foreground">
                {r.mentionCount.toLocaleString()}
              </td>
              <td className="px-3 py-2.5 text-right">
                <span className="inline-flex items-center gap-1.5">
                  {onPick ? (
                    <PickButton
                      picked={picked?.has(r.id) ?? false}
                      onClick={() => onPick(r)}
                    />
                  ) : null}
                  <DetailButton onClick={() => onDetail(r.id)} label={t("detailButton")} />
                </span>
              </td>
            </tr>
          ))}
      </tbody>
    </TableShell>
  );
}

// ─── Table 2: Purchase Conditions ─────────────────────────────────────────

function ConditionsTable({
  tab,
  onDetail,
  picked,
  onPick,
}: {
  tab: PagedTabState<ConditionListRow, ConditionListSort>;
  onDetail: (id: string) => void;
  picked?: ReadonlyMap<string, string>;
  onPick?: (row: ConditionListRow) => void;
}) {
  const t = useTranslations("socialScraping.contextMap");
  const show = bodyRows(tab.loading, tab.error, tab.data.rows.length === 0);
  return (
    <TableShell
      title={t("conditionsSection")}
      count={tab.data.total}
      toolbar={
        <SearchBox
          value={tab.search}
          onChange={tab.setSearch}
          placeholder={t("searchConditions")}
        />
      }
      footer={<Pager tab={tab} />}
    >
      <thead>
        <tr className="border-b border-border text-left text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
          <th className="px-3 py-2">
            <SortableHeader
              active={tab.sort === "name"}
              asc={tab.dir === "asc"}
              onClick={() => tab.toggleSort("name")}
            >
              {t("col.name")}
            </SortableHeader>
          </th>
          <th className="px-3 py-2">{t("col.category")}</th>
          <th className="px-3 py-2">{t("col.perspective")}</th>
          <th className="px-3 py-2 text-right">{t("col.drivenByContexts")}</th>
          <th className="px-3 py-2 text-right">
            <SortableHeader
              active={tab.sort === "mentions"}
              asc={tab.dir === "asc"}
              onClick={() => tab.toggleSort("mentions")}
              align="right"
            >
              {t("col.mentions")}
            </SortableHeader>
          </th>
          <th className="w-24 px-3 py-2"></th>
        </tr>
      </thead>
      <tbody>
        <ListState
          colSpan={6}
          loading={tab.loading}
          error={tab.error}
          empty={tab.data.rows.length === 0}
          onRetry={tab.retry}
        />
        {show &&
          tab.data.rows.map((r) => (
            <tr key={r.id} className="border-t border-border first:border-t-0">
              <td className="px-3 py-2.5 text-sm font-medium text-foreground">{r.name}</td>
              <td className="px-3 py-2.5 text-xs text-muted-foreground">{r.categoryId}</td>
              <td className="px-3 py-2.5">
                <PerspectiveBadge p={r.perspective} />
              </td>
              <td className="px-3 py-2.5 text-right text-xs tabular-nums text-muted-foreground">
                {r.linkedCount}
              </td>
              <td className="px-3 py-2.5 text-right text-xs tabular-nums text-foreground">
                {r.mentionCount.toLocaleString()}
              </td>
              <td className="px-3 py-2.5 text-right">
                <span className="inline-flex items-center gap-1.5">
                  {onPick ? (
                    <PickButton
                      picked={picked?.has(r.id) ?? false}
                      onClick={() => onPick(r)}
                    />
                  ) : null}
                  <DetailButton onClick={() => onDetail(r.id)} label={t("detailButton")} />
                </span>
              </td>
            </tr>
          ))}
      </tbody>
    </TableShell>
  );
}

// ─── Table 3: Combinations ────────────────────────────────────────────────

function CombinationsTable({
  tab,
  onDetail,
  picked,
  onPick,
}: {
  tab: PagedTabState<CombinationListRow, CombinationListSort>;
  onDetail: (row: CombinationListRow) => void;
  picked?: ReadonlyMap<string, CombinationListRow>;
  onPick?: (row: CombinationListRow) => void;
}) {
  const t = useTranslations("socialScraping.contextMap");
  const show = bodyRows(tab.loading, tab.error, tab.data.rows.length === 0);
  return (
    <TableShell
      title={t("combinationsSection")}
      count={tab.data.total}
      toolbar={
        <SearchBox
          value={tab.search}
          onChange={tab.setSearch}
          placeholder={t("searchCombinations")}
        />
      }
      footer={<Pager tab={tab} />}
    >
      <thead>
        <tr className="border-b border-border text-left text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
          <th className="px-3 py-2">{t("col.conditionA")}</th>
          <th className="px-3 py-2">{t("col.conditionB")}</th>
          <th className="px-3 py-2">{t("col.frequency")}</th>
          <th className="px-3 py-2 text-right">
            <SortableHeader
              active={tab.sort === "cooccurrence"}
              asc={tab.dir === "asc"}
              onClick={() => tab.toggleSort("cooccurrence")}
              align="right"
            >
              {t("col.cooccurrence")}
            </SortableHeader>
          </th>
          <th className="w-24 px-3 py-2"></th>
        </tr>
      </thead>
      <tbody>
        <ListState
          colSpan={5}
          loading={tab.loading}
          error={tab.error}
          empty={tab.data.rows.length === 0}
          onRetry={tab.retry}
        />
        {show &&
          tab.data.rows.map((r) => (
            <tr key={r.id} className="border-t border-border first:border-t-0">
              <td className="px-3 py-2.5 text-sm text-foreground">{r.condAName}</td>
              <td className="px-3 py-2.5 text-sm text-foreground">{r.condBName}</td>
              <td className="px-3 py-2.5">
                <Badge variant="secondary" className="font-normal">
                  {t(`frequency.${r.frequency}`)}
                </Badge>
              </td>
              <td className="px-3 py-2.5 text-right text-xs tabular-nums text-foreground">
                {r.coOccurrenceCount.toLocaleString()}
              </td>
              <td className="px-3 py-2.5 text-right">
                <span className="inline-flex items-center gap-1.5">
                  {onPick ? (
                    <PickButton
                      picked={picked?.has(r.id) ?? false}
                      onClick={() => onPick(r)}
                    />
                  ) : null}
                  <DetailButton onClick={() => onDetail(r)} label={t("detailButton")} />
                </span>
              </td>
            </tr>
          ))}
      </tbody>
    </TableShell>
  );
}

const LAYER_KEY: Record<PromptLayer, string> = {
  "L1-context": "l1",
  "L2-condition": "l2",
  "L3-intersection": "l3",
};

function CatalogTable({
  mode,
  projectId,
  prompts,
  setPrompts,
  addedTexts,
}: {
  mode: "standard" | "admin";
  projectId?: string;
  /** Lifted to ContextMapView — the 구성 flow appends rows from outside this
   *  tab, and Radix unmounts inactive tab content. */
  prompts: GeneratedPrompt[];
  setPrompts: React.Dispatch<React.SetStateAction<GeneratedPrompt[]>>;
  addedTexts?: string[];
}) {
  const t = useTranslations("socialScraping.contextMap");
  // Texts already in the candidate pool → rendered "이미 추가됨", not sendable.
  const [added, setAdded] = useState<Set<string>>(() => new Set(addedTexts ?? []));
  const isAdded = (p: GeneratedPrompt) => added.has(p.question);

  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(prompts.filter((p) => !added.has(p.question)).map((p) => p.id)),
  );
  const [sent, setSent] = useState(false);
  // Last generation attempt failed → the empty state explains + points at 재시도.
  const [genFailed, setGenFailed] = useState(false);

  // Rows appended from outside (구성 flow / "더 생성") arrive via the prompts
  // prop — auto-select the sendable newcomers so they're ready to 전송.
  const knownIds = useRef(new Set(prompts.map((p) => p.id)));
  useEffect(() => {
    const fresh = prompts.filter((p) => !knownIds.current.has(p.id));
    if (fresh.length === 0) return;
    for (const p of fresh) knownIds.current.add(p.id);
    setSelected((prev) => {
      const next = new Set(prev);
      for (const p of fresh) if (!added.has(p.question)) next.add(p.id);
      return next;
    });
    setSent(false);
  }, [prompts, added]);
  // "추가됨 표시" filter — hide rows already in the candidate pool when off.
  const [showAdded, setShowAdded] = useState(true);
  const [pending, startTransition] = useTransition();
  const [generating, startGenerating] = useTransition();

  const { sorted, headerProps } = useSortableTable<GeneratedPrompt, "question" | "layer" | "funnel" | "priority">(
    prompts,
    {
      question: (r) => r.question,
      layer: (r) => r.layer,
      funnel: (r) => r.funnelStage,
      priority: (r) => r.priority,
    },
    { defaultKey: "priority", ascByDefault: ["question", "layer", "funnel"] },
  );

  const visible = showAdded ? sorted : sorted.filter((p) => !isAdded(p));
  const selectable = sorted.filter((p) => !isAdded(p));
  const allChecked = selectable.length > 0 && selected.size === selectable.length;

  function toggle(id: string) {
    setSent(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    setSent(false);
    setSelected(allChecked ? new Set() : new Set(selectable.map((r) => r.id)));
  }
  function onSend() {
    if (selected.size === 0 || pending) return;
    const chosen = sorted.filter((p) => selected.has(p.id) && !isAdded(p));
    if (chosen.length === 0) return;

    // Admin / read-only surfaces have no project to write into — demo toast.
    if (!projectId) {
      toast.success(t("catalogSendSuccess", { count: chosen.length }));
      return;
    }

    startTransition(async () => {
      const r = await addCandidates(
        projectId,
        "social_scraping",
        chosen.map((p) => ({ text: p.question, sourceKeyword: p.sourceLabel })),
      );
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      const { count, skipped } = r.value;
      // Mark the sent prompts as added and drop them from the selection.
      const chosenTexts = new Set(chosen.map((p) => p.question));
      setAdded((prev) => new Set([...prev, ...chosenTexts]));
      setSelected((prev) => {
        const next = new Set(prev);
        for (const p of chosen) next.delete(p.id);
        return next;
      });
      setSent(true);
      if (count === 0) toast.info(t("catalogSaveNone"));
      else if (skipped > 0)
        toast.success(t("catalogSaveSkipped", { count, skipped }));
      else toast.success(t("catalogSaveSuccess", { count }));
    });
  }
  function onRemove(ids: string[]) {
    if (!projectId || ids.length === 0) return;
    startTransition(async () => {
      const r = await removeSocialPrompts(projectId, ids);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      const removedIds = new Set(ids);
      setPrompts((prev) => prev.filter((p) => !removedIds.has(p.id)));
      setSelected((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.delete(id);
        return next;
      });
      toast.success(t("catalogRemoveSuccess", { count: r.value.count }));
    });
  }
  function onGenerateMore() {
    if (!projectId || generating) return;
    startGenerating(async () => {
      const r = await generateMoreSocialPrompts(projectId);
      if (!r.ok) {
        setGenFailed(true);
        toast.error(r.error);
        return;
      }
      setGenFailed(false);
      const fresh = r.value.prompts;
      if (r.value.exhausted || fresh.length === 0) {
        toast.info(t("catalogGenerateMoreExhausted"));
        return;
      }
      // Selection of the newcomers is handled by the fresh-rows effect above.
      setPrompts((prev) => {
        const ids = new Set(prev.map((p) => p.id));
        return [...prev, ...fresh.filter((p) => !ids.has(p.id))];
      });
      toast.success(t("catalogGenerateMoreSuccess", { count: fresh.length }));
    });
  }

  // First open with an empty cache: kick off generation automatically. The
  // page deliberately no longer generates during SSR (an OpenRouter call
  // against Vercel's function limit rendered as an infinite page load), so the
  // LLM wait happens here, visible as the in-tab 생성 중 state. Ref-guarded:
  // StrictMode double-mount and later prompt updates must not re-fire it.
  const autoGenerated = useRef(false);
  useEffect(() => {
    if (!projectId || autoGenerated.current) return;
    if (prompts.length > 0) {
      autoGenerated.current = true;
      return;
    }
    autoGenerated.current = true;
    onGenerateMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only kick
  }, []);

  return (
    <TableShell
      title={t("catalogSection")}
      count={visible.length}
      toolbar={
        <>
          <span className="text-xs text-muted-foreground">
            {t("catalogSelectedCount", { count: selected.size })}
          </span>
          {projectId ? (
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
              <Checkbox
                checked={showAdded}
                onCheckedChange={(v) => setShowAdded(v === true)}
                aria-label={t("catalogShowAdded")}
              />
              {t("catalogShowAdded")}
            </label>
          ) : null}
          {projectId ? (
            <Button
              onClick={() => onRemove(Array.from(selected))}
              disabled={selected.size === 0 || pending}
              size="sm"
              variant="outline"
              className="text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="h-4 w-4" aria-hidden />
              {t("catalogRemoveSelected")}
            </Button>
          ) : null}
          {projectId ? (
            <Button
              onClick={onGenerateMore}
              disabled={generating}
              size="sm"
              variant="outline"
            >
              <Sparkles className="h-4 w-4" aria-hidden />
              {generating ? t("catalogGenerating") : t("catalogGenerateMore")}
            </Button>
          ) : null}
          <Button
            onClick={onSend}
            disabled={selected.size === 0 || pending || sent}
            size="sm"
          >
            <Send className="h-4 w-4" aria-hidden />
            {mode === "admin" ? t("catalogSendToStandard") : t("catalogSendToPool")}
          </Button>
        </>
      }
    >
      <thead>
        <tr className="border-b border-border bg-muted/20 text-left text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
          <th className="w-10 px-3 py-2 text-center">
            <Checkbox
              checked={allChecked}
              onCheckedChange={toggleAll}
              aria-label={t("catalogSelectAll")}
            />
          </th>
          <th className="px-3 py-2">
            <SortableHeader {...headerProps("question")}>
              {t("col.question")}
            </SortableHeader>
          </th>
          <th className="w-28 px-3 py-2">
            <SortableHeader {...headerProps("layer")}>{t("col.layer")}</SortableHeader>
          </th>
          <th className="w-28 px-3 py-2">
            <SortableHeader {...headerProps("funnel")}>{t("col.funnel")}</SortableHeader>
          </th>
          <th className="w-20 px-3 py-2">
            <SortableHeader {...headerProps("priority")} align="right">
              {t("col.priority")}
            </SortableHeader>
          </th>
          {projectId ? <th className="w-10 px-3 py-2" /> : null}
        </tr>
      </thead>
      <tbody>
        {visible.length === 0 ? (
          <tr>
            <td colSpan={7} className="px-3 py-10 text-center text-xs text-muted-foreground">
              {generating ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  {t("catalogGenerating")}
                </span>
              ) : genFailed && prompts.length === 0 ? (
                t("catalogGenerateFailed")
              ) : (
                t("catalogEmpty")
              )}
            </td>
          </tr>
        ) : null}
        {visible.map((p) => {
          const alreadyAdded = isAdded(p);
          return (
          <tr
            key={p.id}
            className={cn(
              "border-t border-border first:border-t-0 align-top",
              alreadyAdded && "opacity-50",
            )}
          >
            <td className="px-3 py-2.5 text-center">
              {alreadyAdded ? (
                <Badge variant="secondary" className="text-[10px]">
                  {t("catalogAddedBadge")}
                </Badge>
              ) : (
                <Checkbox
                  checked={selected.has(p.id)}
                  onCheckedChange={() => toggle(p.id)}
                  aria-label={p.question}
                />
              )}
            </td>
            <td className="px-3 py-2.5">
              <p className="text-sm text-foreground">{p.question}</p>
              <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                {p.origin === "composed" ? (
                  <Badge
                    variant="outline"
                    className="shrink-0 border-brand-700/40 text-[10px] text-brand-700"
                  >
                    {t("catalogComposedBadge")}
                  </Badge>
                ) : null}
                <span className="truncate">{p.sourceLabel}</span>
              </p>
              {p.similarTo ? (
                <p className="mt-1 flex items-start gap-1.5 text-[11px] text-amber-700 dark:text-amber-500">
                  <Badge
                    variant="outline"
                    className="shrink-0 border-amber-400/60 text-[10px] text-amber-700 dark:text-amber-500"
                  >
                    {t("catalogSimilarBadge", {
                      percent: Math.round(p.similarTo.score * 100),
                    })}
                  </Badge>
                  <span className="min-w-0 truncate" title={p.similarTo.text}>
                    {t(
                      p.similarTo.kind === "prompt"
                        ? "catalogSimilarToPrompt"
                        : "catalogSimilarToCandidate",
                      { text: p.similarTo.text },
                    )}
                  </span>
                </p>
              ) : null}
            </td>
            <td className="px-3 py-2.5">
              <Badge variant="secondary" className="text-[10px]">
                {t(`layer.${LAYER_KEY[p.layer]}`)}
              </Badge>
            </td>
            <td className="px-3 py-2.5 text-xs text-muted-foreground">
              {t(`funnel.${p.funnelStage}`)}
            </td>
            <td className="px-3 py-2.5 text-right">
              <span
                className={cn(
                  "text-xs font-semibold tabular-nums",
                  p.priority >= 85
                    ? "text-brand-700"
                    : p.priority >= 78
                      ? "text-foreground"
                      : "text-muted-foreground",
                )}
              >
                {p.priority}
              </span>
            </td>
            {projectId ? (
              <td className="px-3 py-2.5 text-center">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-muted-foreground hover:text-destructive"
                  disabled={pending}
                  onClick={() => onRemove([p.id])}
                  aria-label={t("catalogRemove")}
                  title={t("catalogRemove")}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                </Button>
              </td>
            ) : null}
          </tr>
          );
        })}
      </tbody>
    </TableShell>
  );
}

// ─── Perspective helpers ──────────────────────────────────────────────────

function dominant(p: PerspectiveBreakdown): Perspective {
  if (p.seller > p.buyer && p.seller > p.neutral) return "seller";
  if (p.neutral > p.buyer && p.neutral > p.seller) return "neutral";
  return "buyer";
}

function PerspectiveBadge({ p }: { p: PerspectiveBreakdown }) {
  const t = useTranslations("socialScraping.contextMap.perspective");
  const top = dominant(p);
  const cls =
    top === "buyer"
      ? "bg-teal-100 text-teal-900"
      : top === "seller"
        ? "bg-red-100 text-red-900"
        : "bg-slate-100 text-slate-700";
  return (
    <Badge variant="secondary" className={cn("text-[10px]", cls)}>
      {t(top)}
    </Badge>
  );
}

// ─── Detail dialog (per-row 자세히보기) ───────────────────────────────────

function DetailDialog({
  selection,
  sampleMatrix,
  onClose,
  onJump,
}: {
  selection: GraphSelection;
  /** Sample source pages/details in memory; live fetches /api/context-map. */
  sampleMatrix?: ContextMatrix;
  onClose: () => void;
  onJump: (sel: GraphSelection) => void;
}) {
  const t = useTranslations("socialScraping.contextMap.detail");
  const open = selection !== null;

  // Detail (quotes / domains / links) is fetched HERE, on open — it is no longer
  // shipped with the list. This is the change that removed the Top-N caps: the
  // old bundle preloaded evidence for all 350 rows, and that was 3.9s of the
  // 6.4s page cost. Only combinations render straight from the row they were
  // opened from; they have no evidence of their own.
  const [detail, setDetail] = useState<ContextEntityDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const entityId =
    selection?.kind === "context" || selection?.kind === "condition" ? selection.id : null;

  useEffect(() => {
    if (!entityId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(false);
    setDetail(null);
    void (async () => {
      try {
        const next = sampleMatrix
          ? sampleEntityDetail(sampleMatrix, entityId)
          : await fetchEntityDetail(entityId);
        if (cancelled) return;
        setDetail(next);
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entityId, sampleMatrix]);

  const isContext = selection?.kind === "context";
  const title =
    selection?.kind === "combination"
      ? selection.label
      : (detail?.name ?? (loading ? "" : "\u2014"));
  const kindLabel =
    selection?.kind === "combination"
      ? t("combinationKind")
      : isContext
        ? t("contextKind")
        : t("conditionKind");

  let body: React.ReactNode = null;
  if (selection?.kind === "combination") {
    body = (
      <>
        <StatRow label={t("cooccurrenceCount", { count: selection.coOccurrenceCount })} />
        <JumpBlock
          title={t("relatedConditions")}
          items={[
            { id: selection.condAId, name: selection.condAName },
            { id: selection.condBId, name: selection.condBName },
          ]}
          onJump={(id) => onJump({ kind: "condition", id })}
        />
      </>
    );
  } else if (loading) {
    body = <DetailSkeleton />;
  } else if (error) {
    body = <p className="py-6 text-center text-xs text-muted-foreground">{t("loadError")}</p>;
  } else if (detail) {
    body = (
      <>
        <StatRow label={t("mentions", { count: detail.mentionCount })} />
        <PerspectiveBlock p={detail.perspective} />
        {detail.linked.length > 0 && (
          <JumpBlock
            title={isContext ? t("drivenConditions") : t("drivenByContexts")}
            items={detail.linked}
            onJump={(id) => onJump({ kind: isContext ? "condition" : "context", id })}
          />
        )}
        <EvidenceBlock quotes={detail.evidenceQuotes} title={t("evidenceTitle")} />
        <DomainBlock domains={detail.sourceDomains} title={t("domainsTitle")} />
      </>
    );
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="truncate">{title}</DialogTitle>
          <DialogDescription>{kindLabel}</DialogDescription>
        </DialogHeader>
        <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto">{body}</div>
      </DialogContent>
    </Dialog>
  );
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true" aria-hidden="true">
      <div className="h-4 w-32 animate-pulse rounded bg-ink-100" />
      <div className="h-16 w-full animate-pulse rounded bg-ink-100" />
      <div className="h-24 w-full animate-pulse rounded bg-ink-100" />
    </div>
  );
}

async function fetchEntityDetail(id: string): Promise<ContextEntityDetail | null> {
  const res = await fetch(`/api/context-map?tab=detail&id=${encodeURIComponent(id)}`);
  if (res.status === 404) return null;
  const json = await res.json();
  if (!res.ok || !json.success) throw new Error(json.error ?? "failed");
  return json.detail as ContextEntityDetail;
}

function StatRow({ label }: { label: string }) {
  return <p className="text-xs font-medium text-foreground">{label}</p>;
}

function PerspectiveBlock({ p }: { p: PerspectiveBreakdown }) {
  const t = useTranslations("socialScraping.contextMap.detail");
  const total = Math.max(1, p.buyer + p.seller + p.neutral);
  const seg = [
    { key: "buyer", v: p.buyer, cls: "bg-teal-500" },
    { key: "seller", v: p.seller, cls: "bg-red-500" },
    { key: "neutral", v: p.neutral, cls: "bg-slate-400" },
  ];
  return (
    <div>
      <p className="mb-1.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
        {t("perspectiveTitle")}
      </p>
      <div className="flex h-2.5 overflow-hidden rounded-full">
        {seg.map((s) => (
          <div key={s.key} className={s.cls} style={{ width: `${(s.v / total) * 100}%` }} />
        ))}
      </div>
      <div className="mt-1.5 flex gap-3 text-[10px] text-muted-foreground">
        {seg.map((s) => (
          <span key={s.key} className="flex items-center gap-1">
            <span className={cn("h-2 w-2 rounded-full", s.cls)} />
            {t(`perspective.${s.key}`)} {s.v}
          </span>
        ))}
      </div>
    </div>
  );
}

function JumpBlock({
  title,
  items,
  onJump,
}: {
  title: string;
  items: { id: string; name: string; strength?: "high" | "medium" | "low" }[];
  onJump: (id: string) => void;
}) {
  const t = useTranslations("socialScraping.contextMap.detail");
  return (
    <div>
      <p className="mb-1.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </p>
      <ul className="flex flex-col gap-1">
        {items.map((it) => (
          <li key={it.id}>
            <button
              onClick={() => onJump(it.id)}
              className="flex w-full items-center justify-between gap-2 rounded-md border border-border px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:border-brand-700/40 hover:bg-muted/40"
            >
              <span className="truncate">{it.name}</span>
              <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
                {it.strength && (
                  <span className="text-[10px]">{t(`strength.${it.strength}`)}</span>
                )}
                <ChevronRight className="h-3 w-3" aria-hidden />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function EvidenceBlock({
  quotes,
  title,
}: {
  quotes: { quote: string; sourceTitle: string; sourceUrl: string }[];
  title: string;
}) {
  if (quotes.length === 0) return null;
  return (
    <div>
      <p className="mb-1.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </p>
      <ul className="flex flex-col gap-2">
        {quotes.map((q, i) => (
          <li key={`${q.sourceUrl}-${i}`} className="rounded-md bg-muted/40 p-2.5">
            <p className="text-xs leading-5 text-foreground">“{q.quote}”</p>
            <a
              // 미러의 source_url 은 스킴 포함 원문 — 무조건 https:// 를 덧붙이면
              // "https://https//…" 로 깨진다(2026-08-06 고객 피드백). 스킴 없는
              // 샘플 데이터만 보정한다 (node-map 쪽과 동일 규칙).
              href={/^https?:\/\//i.test(q.sourceUrl) ? q.sourceUrl : `https://${q.sourceUrl}`}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 block truncate text-[10px] text-brand-700 hover:underline"
            >
              {q.sourceTitle}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DomainBlock({
  domains,
  title,
}: {
  domains: Record<string, number>;
  title: string;
}) {
  const entries = Object.entries(domains).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map(([, v]) => v));
  return (
    <div>
      <p className="mb-1.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </p>
      <ul className="flex flex-col gap-1.5">
        {entries.map(([d, v]) => (
          <li key={d} className="flex items-center gap-2">
            <span className="w-28 shrink-0 truncate text-[11px] text-muted-foreground">{d}</span>
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
              <span
                className="block h-full rounded-full bg-brand-700/70"
                style={{ width: `${(v / max) * 100}%` }}
              />
            </span>
            <span className="w-6 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
              {v}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
