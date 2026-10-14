"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useWindowedRows } from "@/hooks/use-windowed-rows";
import { usePagedQuery } from "@/hooks/use-paged-query";
import { CATALOG_EXPORT_PAGE_SIZE, collationOf, exportCatalogPages, rereadAfterHydration, reuseCatalogMeta, type CatalogPageQuery, type RemoteCatalog } from "@/lib/standards/catalog-page";
import { useTranslations } from "next-intl";
import {
  Zap,
  Download,
  CircleCheck,
  CircleAlert,
  Swords,
  Pencil,
  Trash2,
  RotateCcw,
  History,
} from "lucide-react";
import { PromptAuditTimeline } from "@/components/standards/prompt-audit-timeline";
import {
  setStandardPromptKind,
  softDeleteStandardPrompt,
  restoreStandardPrompt,
} from "../../_actions";
import { PromptEditDialog } from "./prompt-edit-dialog";
import { Button } from "@/components/ui/button";
import { downloadCsv, dateStamp } from "@/lib/export/csv";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSortableTable } from "@/hooks/use-sortable-table";
import { SortableHeader } from "@/components/ui/sortable-header";
import type { PromptType } from "@/lib/db/repositories/prompts";
import { brandPresenceOf } from "@/lib/scope/brand-presence";

// Row shape mirrors `StandardCatalogRow` in lib/db/repositories/standards.ts.
// The fields are the prompts catalog + the scope-link state.
// catalog-prompt-audit(2026-08-12) 이후 이 UI가 편집의 정본 경로다 — 단건 편집
// 다이얼로그·soft-delete/복원·벌크 xlsx 전부 감사 원장을 남긴다. 구 배치 로더
// (gen-standard-prompts-v04.mjs + reconcile-v04.ts)는 초기 시드 전용으로 강등.
export interface StandardPromptRow {
  id: string;
  text: string;
  promptType: PromptType | null;
  category: string | null; // 2026-06-10 deprecated in UI — shown only in CSV export for history
  brand: string | null;
  // 브랜드 유무 (migration 0032) — 프롬프트 문구의 브랜드명 포함 여부.
  brandPresence: string | null;
  listType: string | null;
  depth1: string | null;
  depth2: string | null;
  depth3: string | null;
  depth4: string | null; // placeholder until editorial finalizes the 4-th axis
  funnelStage: string | null;
  // 언어·시장 축 (H5). `regions` NULL/빈 배열 = 미지정(상속) = 전체 —
  // "아무 시장도 아님"이 아니다. `lang` 은 표시·필터·언어 프리셋 전용이며
  // 측정 축이 아니다(측정 축은 regions).
  regions: string[] | null;
  lang: string | null;
  // 측정 종류 — 'single' | 'acr' (migration 0025). 여기서만 편집 가능(카탈로그
  // 텍스트/택소노미는 스크립트 관리 read-only지만 kind는 측정 정책이라 UI 토글).
  kind: string;
  // null → catalog entry not yet pushed to scope = 미추적 badge.
  scopePromptId: string | null;
  scopeText: string | null;
  // soft-delete (0041) — null이면 활성. 삭제 행은 "삭제됨" 뷰에서만 보인다.
  deletedAt: Date | null;
}

export interface StandardCatalogStats {
  total: number;
  tracked: number;
  untracked: number;
  scopeOrphans: number;
  acr: number;
  deleted: number;
}

/**
 * Every filtered row for the CSV export, in server order. A rows-only reader (include_meta=false) takes
 * 5,000-row batches (fewer reads); the full-page loader keeps 500-row pages. Same rows and order either way.
 */
export function exportCatalogRows(remote: RemoteCatalog, query: CatalogPageQuery) {
  return remote.rows ? exportCatalogPages(remote.rows, query, CATALOG_EXPORT_PAGE_SIZE) : exportCatalogPages(remote.load, query);
}

type SortKey =
  | "text"
  | "presence"
  | "brand"
  | "depth1"
  | "depth2"
  | "funnel"
  | "kind"
  | "tracked";

export function StandardPromptList({
  rows,
  stats: initialStats,
  markets,
  remote,
}: {
  rows: StandardPromptRow[];
  stats: StandardCatalogStats;
  /** 선택 가능한 시장 어휘 — 서버가 루트 프로젝트 실황에서 내려준다. */
  markets: string[];
  remote?: RemoteCatalog;
}) {
  const t = useTranslations("adminStandardPrompts.list");
  // 프롬프트 유형(prompt_type) 열은 표준 카탈로그에서 전부 NULL이라 제거하고,
  // brand 태그에서 파생한 "브랜드 포함 여부"(branded/unbranded)로 대체.
  const tVal = useTranslations("dashboard.filters.value");
  const [metadata, setMetadata] = useState(remote?.initial);
  const stats = metadata?.stats ?? initialStats;
  const presenceLabel = (brand: string | null) => {
    const p = brandPresenceOf(brand);
    return p ? tVal(p) : "";
  };

  // Filters: depth1 / funnel / tracking-state / kind. "all" = no narrowing.
  const [depth1Filter, setDepth1Filter] = useState<string>("all");
  const [funnelFilter, setFunnelFilter] = useState<string>("all");
  const [trackFilter, setTrackFilter] = useState<"all" | "tracked" | "untracked">("all");
  const [kindFilter, setKindFilter] = useState<"all" | "acr" | "single">("all");
  // 활성/삭제됨 뷰 (catalog-prompt-audit soft-delete).
  const [view, setView] = useState<"active" | "deleted">("active");
  // 행 단위 mutation(kind 토글·삭제·복원) — scope PATCH가 실패하면 서버 액션이
  // 로컬을 안 바꾸므로 revalidatePath 후 서버 값이 그대로 돌아온다 (낙관적 갱신
  // 없음). 에러는 인라인 표시.
  const [isPending, startTransition] = useTransition();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [editRow, setEditRow] = useState<StandardPromptRow | null>(null);
  const [timelineRow, setTimelineRow] = useState<StandardPromptRow | null>(null);
  function onToggleKind(row: StandardPromptRow) {
    const next = row.kind === "acr" ? "single" : "acr";
    const confirmed = window.confirm(
      next === "acr" ? t("kindConfirmAcr") : t("kindConfirmSingle"),
    );
    if (!confirmed) return;
    setRowError(null);
    setPendingId(row.id);
    startTransition(async () => {
      const res = await setStandardPromptKind(row.id, next);
      if (!res.ok) setRowError(res.error || t("kindUpdateFailed"));
      setPendingId(null);
    });
  }
  function onDelete(row: StandardPromptRow) {
    if (!window.confirm(t("deleteConfirm"))) return;
    setRowError(null);
    setPendingId(row.id);
    startTransition(async () => {
      const res = await softDeleteStandardPrompt(row.id);
      if (!res.ok) setRowError(res.error || t("deleteFailed"));
      setPendingId(null);
    });
  }
  function onRestore(row: StandardPromptRow) {
    if (!window.confirm(t("restoreConfirm"))) return;
    setRowError(null);
    setPendingId(row.id);
    startTransition(async () => {
      const res = await restoreStandardPrompt(row.id);
      if (!res.ok) setRowError(res.error || t("restoreFailed"));
      setPendingId(null);
    });
  }

  const depth1Options = useMemo(() => {
    if (metadata) return metadata.facets.depth1;
    const set = new Set<string>();
    for (const r of rows) if (r.depth1) set.add(r.depth1);
    return [...set].sort();
  }, [rows, metadata]);

  const funnelOptions = useMemo(() => {
    if (metadata) return metadata.facets.funnel;
    const set = new Set<string>();
    for (const r of rows) if (r.funnelStage) set.add(r.funnelStage);
    return [...set].sort();
  }, [rows, metadata]);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (view === "active" ? r.deletedAt !== null : r.deletedAt === null) return false;
      if (depth1Filter !== "all" && r.depth1 !== depth1Filter) return false;
      if (funnelFilter !== "all" && r.funnelStage !== funnelFilter) return false;
      if (trackFilter === "tracked" && r.scopePromptId === null) return false;
      if (trackFilter === "untracked" && r.scopePromptId !== null) return false;
      if (kindFilter !== "all" && r.kind !== kindFilter) return false;
      return true;
    });
  }, [rows, view, depth1Filter, funnelFilter, trackFilter, kindFilter]);

  const { sorted, sortKey, asc, headerProps } = useSortableTable<StandardPromptRow, SortKey>(
    filtered,
    {
      text: (r) => r.text,
      // unbranded(HMG) sorts before branded so the brand-agnostic block groups.
      presence: (r) => brandPresenceOf(r.brand, r.brandPresence) ?? "~",
      brand: (r) => r.brand ?? "",
      depth1: (r) => r.depth1 ?? "~",
      depth2: (r) => r.depth2 ?? "~",
      funnel: (r) => r.funnelStage ?? "~",
      kind: (r) => (r.kind === "acr" ? 1 : 0),
      // tracked rows sort to the top by default (true=1, false=0; descending)
      tracked: (r) => (r.scopePromptId !== null ? 1 : 0),
    },
    {
      defaultKey: "depth1",
      defaultAsc: true,
      ascByDefault: ["text", "presence", "brand", "depth1", "depth2", "funnel"],
    },
  );

  const filters = { view, depth1: depth1Filter, funnel: funnelFilter, status: trackFilter, kind: kindFilter };
  const resetKey = JSON.stringify([filters, sortKey, asc]);
  const windowed = useWindowedRows(metadata?.total ?? sorted.length, resetKey, 96, !!remote);
  const collation = collationOf(Intl.Collator().resolvedOptions().locale);
  const readQuery: CatalogPageQuery = { filters, sort: sortKey, asc, offset: windowed.start, limit: windowed.limit, collation };
  // Same draft → rows and total only; facets and stats stay from the last read (a write re-renders a new remote).
  const load = useMemo(() => (remote ? reuseCatalogMeta(remote) : undefined), [remote]);
  // The first page is read again after hydration only when the browser's comparator differs from the server read's.
  const page = usePagedQuery(remote?.initial, load, readQuery, rereadAfterHydration(remote?.initial ?? {}, collation));
  useEffect(() => { if (page.data) setMetadata(page.data); }, [page.data]);
  const visible = page.data?.rows ?? sorted;
  const total = page.data?.total ?? sorted.length;
  const offset = page.data?.offset ?? 0;
  const topSpace = remote ? windowed.top(offset) : 0;
  const bottomSpace = remote ? windowed.bottom(offset, visible.length) : 0;
  const [exporting, setExporting] = useState(false);
  async function onExport() {
    setExporting(true);
    try {
    const exportRows = remote ? await exportCatalogRows(remote, readQuery) : sorted;
    downloadCsv(
      `standard-prompts-${dateStamp()}`,
      [
        t("textLabel"),
        t("brandLabel"),
        t("col.listType"),
        t("col.depth1"),
        t("col.depth2"),
        t("col.depth3"),
        t("col.depth4"),
        t("filterFunnel"),
        t("presenceLabel"),
        t("kindColumn"),
        t("trackingColumn"),
      ],
      exportRows.map((r) => [
        r.text,
        r.brand ?? "",
        r.listType ?? "",
        r.depth1 ?? "",
        r.depth2 ?? "",
        r.depth3 ?? "",
        r.depth4 ?? "",
        r.funnelStage ?? "",
        presenceLabel(r.brand),
        r.kind === "acr" ? t("kindAcr") : t("kindSingle"),
        r.scopePromptId !== null ? t("inUse") : t("untracked"),
      ]),
    );
    } catch {
      setRowError(t("exportFailed"));
    } finally { setExporting(false); }
  }

  if (page.error) throw page.error;
  return (
    <div className="flex flex-col gap-5">
      {/* ─ Catalog stats + filter strip ─ */}
      <div className="flex flex-col gap-2 rounded-md border border-border bg-card px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <span className="inline-flex items-center gap-1.5 font-semibold text-foreground">
            <Zap className="h-3.5 w-3.5 text-brand-700" aria-hidden />
            {t("catalogStrip")}
          </span>
          <Badge variant="secondary" className="font-normal tabular-nums">
            {t("statsTotal", { count: stats.total })}
          </Badge>
          <Badge variant="outline" className="border-emerald-400 bg-emerald-50 text-[10px] text-emerald-900">
            <CircleCheck className="h-3 w-3" aria-hidden />
            {t("statsInUse", { count: stats.tracked })}
          </Badge>
          {stats.untracked > 0 ? (
            <Badge variant="outline" className="border-amber-400 bg-amber-50 text-[10px] text-amber-900">
              <CircleAlert className="h-3 w-3" aria-hidden />
              {t("statsUntracked", { count: stats.untracked })}
            </Badge>
          ) : null}
          {stats.scopeOrphans > 0 ? (
            <Badge variant="outline" className="text-[10px] text-muted-foreground">
              {t("statsScopeOrphans", { count: stats.scopeOrphans })}
            </Badge>
          ) : null}
          <Badge variant="outline" className="border-brand-700/40 bg-brand-700/5 text-[10px] text-brand-700">
            <Swords className="h-3 w-3" aria-hidden />
            {t("statsAcr", { count: stats.acr })}
          </Badge>
          <div className="ml-auto flex items-center gap-1">
            <Button
              type="button"
              variant={view === "active" ? "secondary" : "ghost"}
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={() => setView("active")}
            >
              {t("viewActive")}
            </Button>
            <Button
              type="button"
              variant={view === "deleted" ? "secondary" : "ghost"}
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={() => setView("deleted")}
            >
              {t("viewDeleted", { count: stats.deleted })}
            </Button>
          </div>
          {rowError ? (
            <span className="text-[11px] text-destructive">{rowError}</span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor="sp-d1-filter" className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
            {t("filterDepth1")}
          </Label>
          <Select value={depth1Filter} onValueChange={setDepth1Filter}>
            <SelectTrigger id="sp-d1-filter" size="sm" className="w-fit min-w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("filterAll")}</SelectItem>
              {depth1Options.map((opt) => (
                <SelectItem key={opt} value={opt}>{opt}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Label htmlFor="sp-funnel-filter" className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
            {t("filterFunnel")}
          </Label>
          <Select value={funnelFilter} onValueChange={setFunnelFilter}>
            <SelectTrigger id="sp-funnel-filter" size="sm" className="w-fit min-w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("filterAll")}</SelectItem>
              {funnelOptions.map((f) => (
                <SelectItem key={f} value={f}>{f}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Label htmlFor="sp-track-filter" className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
            {t("filterTracking")}
          </Label>
          <Select value={trackFilter} onValueChange={(v) => setTrackFilter(v as typeof trackFilter)}>
            <SelectTrigger id="sp-track-filter" size="sm" className="w-fit min-w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("filterAll")}</SelectItem>
              <SelectItem value="tracked">{t("inUse")}</SelectItem>
              <SelectItem value="untracked">{t("untracked")}</SelectItem>
            </SelectContent>
          </Select>
          <Label htmlFor="sp-kind-filter" className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
            {t("filterKind")}
          </Label>
          <Select value={kindFilter} onValueChange={(v) => setKindFilter(v as typeof kindFilter)}>
            <SelectTrigger id="sp-kind-filter" size="sm" className="w-fit min-w-24">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("filterAll")}</SelectItem>
              <SelectItem value="acr">{t("kindAcr")}</SelectItem>
              <SelectItem value="single">{t("kindSingle")}</SelectItem>
            </SelectContent>
          </Select>
          {(depth1Filter !== "all" || funnelFilter !== "all" || trackFilter !== "all" || kindFilter !== "all") ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setDepth1Filter("all");
                setFunnelFilter("all");
                setTrackFilter("all");
                setKindFilter("all");
              }}
              className="text-muted-foreground"
            >
              {t("filterReset")}
            </Button>
          ) : null}
          <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
            {t("filteredCount", { shown: total, total: metadata?.count ?? rows.length })}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onExport}
            disabled={exporting || total === 0}
          >
            <Download className="h-3.5 w-3.5" aria-hidden />
            {t("exportCsv")}
          </Button>
        </div>
      </div>

      {total === 0 ? (
        <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          {t("empty")}
        </p>
      ) : (
        // 측정 종류 컬럼 추가로 좁은 뷰포트에서 넘칠 수 있다 — 잘리는 대신
        // 테이블 가로 스크롤.
        <div className="overflow-x-auto rounded-md border border-border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30 text-left text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                <th className="min-w-64 px-3 py-2"><SortableHeader {...headerProps("text")}>{t("textLabel")}</SortableHeader></th>
                <th className="px-3 py-2 w-24">
                  <SortableHeader {...headerProps("brand")}>{t("brandLabel")}</SortableHeader>
                </th>
                <th className="px-3 py-2 w-52">
                  <SortableHeader {...headerProps("depth1")}>{t("frameworkColumn")}</SortableHeader>
                </th>
                <th className="px-3 py-2 w-28">
                  <SortableHeader {...headerProps("funnel")}>{t("filterFunnel")}</SortableHeader>
                </th>
                <th className="px-3 py-2 w-32"><SortableHeader {...headerProps("presence")}>{t("presenceLabel")}</SortableHeader></th>
                <th className="px-3 py-2 w-28">
                  <SortableHeader {...headerProps("kind")}>{t("kindColumn")}</SortableHeader>
                </th>
                <th className="px-3 py-2 w-24">
                  <SortableHeader {...headerProps("tracked")} align="right">{t("trackingColumn")}</SortableHeader>
                </th>
                <th className="px-3 py-2 w-20 text-right">{t("actionsColumn")}</th>
              </tr>
            </thead>
            <tbody ref={windowed.containerRef} aria-busy={page.loading}>
              {topSpace > 0 ? <tr aria-hidden><td colSpan={8} style={{ height: topSpace, padding: 0, border: 0 }} /></tr> : null}
              {visible.map((r, index) => (
                <tr key={r.id} data-window-row={offset + index} className="border-t border-border first:border-t-0 align-top">
                  <td className="px-3 py-3 text-sm text-foreground">{r.text}</td>
                  <td className="px-3 py-3">
                    {r.brand ? (
                      <Badge variant="outline" className="text-[10px]">{r.brand}</Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    {r.depth1 || r.listType ? (
                      <div className="flex flex-col items-start gap-1">
                        {r.listType ? (
                          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                            {r.listType}
                          </span>
                        ) : null}
                        {r.depth1 ? (
                          <Badge variant="secondary" className="text-[10px]">
                            {r.depth1}
                          </Badge>
                        ) : null}
                        <span className="text-[10px] leading-snug text-muted-foreground">
                          {r.depth2}
                          {r.depth3 ? ` · ${r.depth3}` : null}
                          {r.depth4 ? ` · ${r.depth4}` : null}
                        </span>
                      </div>
                    ) : (
                      <span className="text-[10px] text-muted-foreground">{t("unlabeled")}</span>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    {r.funnelStage ? (
                      <Badge variant="outline" className="text-[10px]">
                        {r.funnelStage}
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    {brandPresenceOf(r.brand, r.brandPresence) === "branded" ? (
                      <Badge variant="secondary" className="text-[10px]">{tVal("branded")}</Badge>
                    ) : brandPresenceOf(r.brand, r.brandPresence) === "unbranded" ? (
                      <Badge variant="outline" className="text-[10px] text-muted-foreground">{tVal("unbranded")}</Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-1.5">
                      {r.kind === "acr" ? (
                        <Badge variant="outline" className="border-brand-700/40 bg-brand-700/5 text-[10px] text-brand-700">
                          <Swords className="h-3 w-3" aria-hidden />
                          {t("kindAcr")}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-[10px] text-muted-foreground">
                          {t("kindSingle")}
                        </Badge>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 px-1.5 text-[10px] text-muted-foreground"
                        disabled={isPending && pendingId === r.id}
                        onClick={() => onToggleKind(r)}
                      >
                        {r.kind === "acr" ? t("kindToSingle") : t("kindToAcr")}
                      </Button>
                    </div>
                  </td>
                  <td className="px-3 py-3 text-right">
                    {r.scopePromptId !== null ? (
                      <Badge variant="secondary" className="bg-emerald-50 text-[10px] text-emerald-900">
                        {t("inUse")}
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="border-amber-400 bg-amber-50 text-[10px] text-amber-900">
                        {t("untracked")}
                      </Badge>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex items-center justify-end gap-0.5">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0 text-muted-foreground"
                        aria-label={t("historyColumn")}
                        title={t("historyColumn")}
                        onClick={() => setTimelineRow(r)}
                      >
                        <History className="h-3.5 w-3.5" aria-hidden />
                      </Button>
                      {view === "active" ? (
                        <>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0 text-muted-foreground"
                            aria-label={t("edit")}
                            title={t("edit")}
                            disabled={isPending && pendingId === r.id}
                            onClick={() => setEditRow(r)}
                          >
                            <Pencil className="h-3.5 w-3.5" aria-hidden />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                            aria-label={t("delete")}
                            title={t("delete")}
                            disabled={isPending && pendingId === r.id}
                            onClick={() => onDelete(r)}
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden />
                          </Button>
                        </>
                      ) : (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-6 px-1.5 text-[10px] text-muted-foreground"
                          disabled={isPending && pendingId === r.id}
                          onClick={() => onRestore(r)}
                        >
                          <RotateCcw className="h-3 w-3" aria-hidden />
                          {t("restore")}
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {bottomSpace > 0 ? <tr aria-hidden><td colSpan={8} style={{ height: bottomSpace, padding: 0, border: 0 }} /></tr> : null}
            </tbody>
          </table>
        </div>
      )}
      {editRow ? (
        <PromptEditDialog
          row={editRow}
          markets={markets}
          open={editRow !== null}
          onOpenChange={(open) => {
            if (!open) setEditRow(null);
          }}
        />
      ) : null}
      {timelineRow ? (
        <PromptAuditTimeline
          promptId={timelineRow.id}
          promptText={timelineRow.text}
          open={timelineRow !== null}
          onOpenChange={(open) => {
            if (!open) setTimelineRow(null);
          }}
        />
      ) : null}
    </div>
  );
}
