"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { exportCatalogPages, reuseCatalogMeta, type CatalogPageQuery, type RemoteCatalog } from "@/lib/standards/catalog-page";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  Search,
  Eye,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Swords,
  History,
  Tag,
  Globe,
  CircleDot,
  CircleDashed,
  Info,
  Download,
} from "lucide-react";
import { PromptAuditTimeline } from "@/components/standards/prompt-audit-timeline";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSortableTable } from "@/hooks/use-sortable-table";
import { SortableHeader } from "@/components/ui/sortable-header";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { brandPresenceOf, UMBRELLA_BRAND } from "@/lib/scope/brand-presence";
import { countryName } from "@/lib/geo-catalog/country-name";
import { languageName } from "@/lib/geo-catalog/language-name";
import {
  isPseudoRegion,
  isMarketUnset,
  marketFilterOptions,
  matchesMarket,
  pseudoRegionLabelKey,
  splitMarkets,
} from "@/lib/standards/prompt-markets";
import type { Role } from "@/lib/auth/types";
import { downloadXlsx } from "@/lib/export/xlsx";
import {
  buildStandardPromptSheet,
  exportFilename,
  type StandardPromptExportLabels,
} from "./prompt-export";

const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 50;

// Read-only row — a subset of StandardCatalogRow. The operational columns
// (scopePromptId / tracking state / stats) from the admin view are dropped;
// this is a browse surface, not a management one.
export interface StandardPromptViewRow {
  id: string;
  text: string;
  brand: string | null;
  brandPresence: string | null;
  listType: string | null;
  depth1: string | null;
  depth2: string | null;
  depth3: string | null;
  depth4: string | null;
  funnelStage: string | null;
  // 측정 종류 ('single' | 'acr') — 열람용 배지. 전환은 admin 카탈로그 전용.
  kind: string;
  // 대상 시장 (migration 0047). 실국가 ISO alpha-2 + `x:` 접두 의사코드.
  // NULL·빈 배열 = 미지정(상속) — 화면은 '전체' 배지로 명시한다(빈칸 금지).
  // ⚠️ 계정 권한 스코프(scopeRegions/scopeCountries)와 다른 축.
  regions: string[] | null;
  // 프롬프트 언어 (migration 0047) — 번역 시트 탭 코드(대문자 ISO 639-1).
  lang: string | null;
  // scope 링크. null = 아직 발행 안 됨 → '미측정' 상태 배지 (D15).
  scopePromptId: string | null;
}

type SortKey =
  | "text"
  | "brand"
  | "presence"
  | "listType"
  | "depth1"
  | "depth2"
  | "depth3"
  | "depth4"
  | "funnel"
  | "kind"
  | "market"
  | "lang"
  | "status";

const ALL = "all";

// The deferred filter state — selects edit a `draft`; the table reads `applied`.
// They diverge until the user presses 적용(Apply); 리셋(Reset) clears both.
export interface FilterState {
  listType: string;
  depth1: string;
  depth2: string;
  depth3: string;
  depth4: string;
  funnel: string;
  presence: string;
  kind: string;
  // 대상 시장 (실국가 또는 지리 의사코드 1개) — 권한 스코프와 무관한 카탈로그 축.
  market: string;
  lang: string;
  // 측정 상태 — MEASURED(scope 링크 있음) / UNMEASURED(없음). 기본값 전체.
  status: string;
}

export const EMPTY_FILTER: FilterState = {
  listType: ALL,
  depth1: ALL,
  depth2: ALL,
  depth3: ALL,
  depth4: ALL,
  funnel: ALL,
  presence: ALL,
  kind: ALL,
  market: ALL,
  lang: ALL,
  status: ALL,
};

// 측정 상태 필터 값 — scope_prompt_id 유무 (D15).
export const STATUS_MEASURED = "measured";
export const STATUS_UNMEASURED = "unmeasured";

// 행 배지 접힘 임계 — 상위 N개만 보이고 나머지는 `+N`(툴팁에 전체).
const MARKET_BADGE_LIMIT = 3;

// A row is "공통" (common, visible to every brand-scoped user) when it carries
// no brand or the umbrella brand tag. Mirrors standardPromptInScope.
function isCommon(brand: string | null): boolean {
  return brand == null || brand === UMBRELLA_BRAND;
}

function sortedUnique(values: (string | null)[]): string[] {
  const set = new Set<string>();
  for (const v of values) if (v) set.add(v);
  return [...set].sort();
}

// 필터 술어 — 순수 함수로 빼 테스트에서 직접 돌린다(브라우저 없이 3축 검증).
export function filterRows(
  rows: StandardPromptViewRow[],
  applied: FilterState,
  query: string,
): StandardPromptViewRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter((r) => {
    if (applied.listType !== ALL && r.listType !== applied.listType) return false;
    if (applied.depth1 !== ALL && r.depth1 !== applied.depth1) return false;
    if (applied.depth2 !== ALL && r.depth2 !== applied.depth2) return false;
    if (applied.depth3 !== ALL && r.depth3 !== applied.depth3) return false;
    if (applied.depth4 !== ALL && r.depth4 !== applied.depth4) return false;
    if (applied.funnel !== ALL && r.funnelStage !== applied.funnel) return false;
    if (applied.presence !== ALL && brandPresenceOf(r.brand, r.brandPresence) !== applied.presence)
      return false;
    if (applied.kind !== ALL && r.kind !== applied.kind) return false;
    // 대상 시장: 행의 regions 배열에 그 코드가 있는가 (미지정 행은 안 걸린다).
    if (applied.market !== ALL && !matchesMarket(r.regions, applied.market)) return false;
    if (applied.lang !== ALL && r.lang !== applied.lang) return false;
    if (applied.status !== ALL) {
      const measured = r.scopePromptId !== null;
      if (applied.status === STATUS_MEASURED && !measured) return false;
      if (applied.status === STATUS_UNMEASURED && measured) return false;
    }
    if (q && !r.text.toLowerCase().includes(q)) return false;
    return true;
  });
}

// 행의 대상 시장 셀. 실국가 = solid 배지(국가명), 의사코드 = outline + 태그
// 아이콘으로 **시각적으로 분리**한다(D4). 미지정은 빈칸이 아니라 '전체' 배지 —
// 빈칸으로 두면 "설정 안 됨 = 측정 안 됨"으로 오독된다(§3-2).
function MarketCell({
  regions,
  labelOf,
  allLabel,
  allHint,
  moreHint,
}: {
  regions: string[] | null;
  labelOf: (code: string) => string;
  allLabel: string;
  allHint: string;
  moreHint: string;
}) {
  if (isMarketUnset(regions)) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="secondary" className="text-[10px] font-normal">
            <Globe className="h-3 w-3" aria-hidden />
            {allLabel}
          </Badge>
        </TooltipTrigger>
        <TooltipContent className="max-w-64">{allHint}</TooltipContent>
      </Tooltip>
    );
  }
  const { real, pseudo } = splitMarkets(regions);
  // 접는 것은 **실국가뿐**이다. 의사코드(x:*)는 개수가 5종으로 묶여 있고 "이 행이
  // 글로벌인가/중동인가" 같은 성격 정보라 항상 보여야 한다 — 접기를 배열 순서대로
  // 하면 실국가가 많은 행에서 의사코드가 통째로 `+N` 뒤로 숨어(2026-08-29 렌더
  // 실측: regions 14개 EN 행이 "오스트레일리아·캐나다·영국 +11" 로만 보이고
  // x:EU·x:ME·x:NBRAND·x:WW 4종이 전부 사라졌다) D4 의 "별도 배지로 구분 표시"가
  // 정작 구분할 대상이 화면에 없는 상태로 무력화된다.
  const shownReal = real.slice(0, MARKET_BADGE_LIMIT);
  const hidden = real.slice(MARKET_BADGE_LIMIT);
  const shown = [...shownReal, ...pseudo];
  const ordered = [...real, ...pseudo];
  return (
    <div className="flex flex-wrap items-center gap-1">
      {shown.map((code) =>
        isPseudoRegion(code) ? (
          <Badge
            key={code}
            variant="outline"
            className="border-dashed text-[10px] font-normal text-muted-foreground"
          >
            <Tag className="h-3 w-3" aria-hidden />
            {labelOf(code)}
          </Badge>
        ) : (
          <Badge key={code} variant="secondary" className="text-[10px] font-normal">
            {labelOf(code)}
          </Badge>
        ),
      )}
      {hidden.length ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge
              variant="ghost"
              className="cursor-default border-border text-[10px] font-normal text-muted-foreground tabular-nums"
              aria-label={moreHint}
            >
              +{hidden.length}
            </Badge>
          </TooltipTrigger>
          <TooltipContent className="max-w-72">
            {ordered.map((c) => labelOf(c)).join(" · ")}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}

export function StandardPromptReadonlyList({
  rows,
  remote,
  scopeAll,
  scopeRole,
  scopeBrands,
  scopeRegions,
  scopeCountries,
}: {
  rows: StandardPromptViewRow[];
  remote?: RemoteCatalog;
  scopeAll: boolean;
  scopeRole: Role;
  scopeBrands: string[];
  scopeRegions: string[];
  scopeCountries: string[];
}) {
  // country 계정은 자국(countries)이 스코프의 leaf 축 — 그 위 권역(RHQ)까지 함께
  // 노출하면 "권역 필터가 살아있는 것처럼" 어색하다. 가장 구체적인 축만 보여주도록
  // country 역할에서는 권역 배지를 숨긴다(region/hq는 권역이 실제 스코프라 유지).
  // 이 저장소는 region 계정도 countries가 확장 저장돼 있어 role로만 구분 가능.
  const showRegions = scopeRole !== "country" && scopeRegions.length > 0;
  const t = useTranslations("standardPromptsView");
  const tVal = useTranslations("dashboard.filters.value");
  const locale = useLocale();

  // 의사코드 라벨 — ISO/의사 코드는 messages 에 넣지 않는다(코드 → 라벨 키 매핑은
  // lib/standards/prompt-markets.ts 가 정본). 미등록 코드는 원문 코드로 폴백.
  const marketLabel = useMemo(
    () => (code: string) => {
      if (!isPseudoRegion(code)) return countryName(code, locale);
      const key = pseudoRegionLabelKey(code);
      return key ? tVal(key) : code;
    },
    [locale, tVal],
  );

  const [query, setQuery] = useState("");
  // Two-tier filter state: `draft` follows the selects, `applied` drives the
  // table. They only sync when the user presses 적용.
  const [draft, setDraft] = useState<FilterState>(EMPTY_FILTER);
  const [applied, setApplied] = useState<FilterState>(EMPTY_FILTER);
  const [remotePage, setRemotePage] = useState(remote?.initial);
  const [readError, setReadError] = useState<Error | null>(null);
  const firstRead = useRef(true);
  // 변경 이력 타임라인 다이얼로그 (catalog-prompt-audit — 열람 전용).
  const [timelineRow, setTimelineRow] = useState<{ id: string; text: string } | null>(null);

  // ── Cascading option lists — each depth narrows by the PENDING (draft)
  // parent selection so the dropdowns react immediately, even before 적용.
  const listTypeOptions = useMemo(
    () => remotePage?.facets.listType ?? sortedUnique(rows.map((r) => r.listType)),
    [rows, remotePage],
  );
  const depth1Options = useMemo(
    () =>
      remotePage?.facets.depth1 ?? sortedUnique(
        rows
          .filter((r) => draft.listType === ALL || r.listType === draft.listType)
          .map((r) => r.depth1),
      ),
    [rows, draft.listType, remotePage],
  );
  const depth2Options = useMemo(
    () =>
      remotePage?.facets.depth2 ?? sortedUnique(
        rows
          .filter(
            (r) =>
              (draft.listType === ALL || r.listType === draft.listType) &&
              (draft.depth1 === ALL || r.depth1 === draft.depth1),
          )
          .map((r) => r.depth2),
      ),
    [rows, draft.listType, draft.depth1, remotePage],
  );
  const depth3Options = useMemo(
    () =>
      remotePage?.facets.depth3 ?? sortedUnique(
        rows
          .filter(
            (r) =>
              (draft.listType === ALL || r.listType === draft.listType) &&
              (draft.depth1 === ALL || r.depth1 === draft.depth1) &&
              (draft.depth2 === ALL || r.depth2 === draft.depth2),
          )
          .map((r) => r.depth3),
      ),
    [rows, draft.listType, draft.depth1, draft.depth2, remotePage],
  );
  const depth4Options = useMemo(
    () =>
      remotePage?.facets.depth4 ?? sortedUnique(
        rows
          .filter(
            (r) =>
              (draft.listType === ALL || r.listType === draft.listType) &&
              (draft.depth1 === ALL || r.depth1 === draft.depth1) &&
              (draft.depth2 === ALL || r.depth2 === draft.depth2) &&
              (draft.depth3 === ALL || r.depth3 === draft.depth3),
          )
          .map((r) => r.depth4),
      ),
    [rows, draft.listType, draft.depth1, draft.depth2, draft.depth3, remotePage],
  );
  const funnelOptions = useMemo(
    () => remotePage?.facets.funnel ?? sortedUnique(rows.map((r) => r.funnelStage)),
    [rows, remotePage],
  );
  // 시장·언어 옵션은 **표시되는 행 전체**에서 파생한다 — 미측정 행까지 포함(D15).
  // 별도 어휘 조회 없이 rows 만으로 만든다(기존 funnelStage 패턴과 동일).
  const marketOptions = useMemo(
    () => remotePage?.facets.market ?? marketFilterOptions(rows.map((r) => r.regions)),
    [rows, remotePage],
  );
  const langOptions = useMemo(() => remotePage?.facets.lang ?? sortedUnique(rows.map((r) => r.lang)), [rows, remotePage]);

  // Picking a parent invalidates its children — reset them to "all".
  function updateDraft(patch: Partial<FilterState>) {
    setDraft((prev) => {
      const next = { ...prev, ...patch };
      if (patch.listType !== undefined)
        Object.assign(next, { depth1: ALL, depth2: ALL, depth3: ALL, depth4: ALL });
      if (patch.depth1 !== undefined)
        Object.assign(next, { depth2: ALL, depth3: ALL, depth4: ALL });
      if (patch.depth2 !== undefined) Object.assign(next, { depth3: ALL, depth4: ALL });
      if (patch.depth3 !== undefined) Object.assign(next, { depth4: ALL });
      return next;
    });
  }

  const filtered = useMemo(
    () => filterRows(rows, applied, query),
    [rows, query, applied],
  );

  const { sorted, sortKey, asc, headerProps } = useSortableTable<StandardPromptViewRow, SortKey>(
    filtered,
    {
      text: (r) => r.text,
      brand: (r) => r.brand ?? "",
      // common rows sort first so the brand-agnostic block groups together.
      presence: (r) => brandPresenceOf(r.brand, r.brandPresence) ?? "~",
      listType: (r) => r.listType ?? "~",
      depth1: (r) => r.depth1 ?? "~",
      depth2: (r) => r.depth2 ?? "~",
      depth3: (r) => r.depth3 ?? "~",
      depth4: (r) => r.depth4 ?? "~",
      funnel: (r) => r.funnelStage ?? "~",
      kind: (r) => (r.kind === "acr" ? 1 : 0),
      // 시장은 첫 배지(실국가 우선 정렬) 기준 — 미지정 행은 뒤로 민다.
      market: (r) => {
        const { real, pseudo } = splitMarkets(r.regions);
        const first = real[0] ?? pseudo[0];
        return first ? marketLabel(first) : "~";
      },
      lang: (r) => r.lang ?? "~",
      // 미측정이 먼저 오도록(운영자가 결손을 먼저 본다).
      status: (r) => (r.scopePromptId === null ? 0 : 1),
    },
    {
      defaultKey: "depth1",
      defaultAsc: true,
      ascByDefault: [
        "text",
        "brand",
        "presence",
        "listType",
        "depth1",
        "depth2",
        "depth3",
        "depth4",
        "funnel",
        "market",
        "lang",
        "status",
      ],
    },
  );

  // Keep the existing pager controls. Remote mode reads only the requested page;
  // filters, search and sort still reset the visible page to the first one.
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [page, setPage] = useState(1);
  const total = remotePage?.total ?? sorted.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const sortedKey = remote ? JSON.stringify([query, applied, sortKey, asc]) : sorted.map((r) => r.id).join("|");
  useEffect(() => {
    setPage(1);
  }, [sortedKey, pageSize]);
  const safePage = Math.min(page, pages);
  const pageRows = useMemo(
    () => remotePage?.rows ?? sorted.slice((safePage - 1) * pageSize, safePage * pageSize),
    [sorted, safePage, pageSize, remotePage],
  );
  const rangeFrom = total === 0 ? 0 : (remotePage?.offset ?? (safePage - 1) * pageSize) + 1;
  const rangeTo = Math.min(rangeFrom + pageRows.length - 1, total);
  const readQuery: CatalogPageQuery = { filters: applied, draft, search: query, sort: sortKey, asc,
    offset: (safePage - 1) * pageSize, limit: pageSize,
    collation: Intl.Collator().resolvedOptions().locale.startsWith("ko") ? "ko" : "en",
    market_labels: Object.fromEntries((remotePage?.facets.marketSort ?? marketOptions).map(code => [code, marketLabel(code)])) };
  const readKey = JSON.stringify(readQuery);
  // Same draft → rows and total only; facets stay from the last read.
  const load = useMemo(() => (remote ? reuseCatalogMeta(remote) : undefined), [remote]);
  useEffect(() => {
    if (!load) return;
    // Initial SQL uses English ICU. Match the browser's existing Korean comparator after hydration.
    if (firstRead.current) { firstRead.current = false; if (JSON.parse(readKey).collation !== "ko") return; }
    let active = true;
    const timer = setTimeout(() => {
      load(JSON.parse(readKey)).then(result => {
        if (active) { setRemotePage(result); setReadError(null); }
      }).catch(error => { if (active) setReadError(error instanceof Error ? error : new Error("Catalog read failed")); });
    }, 120);
    return () => { active = false; clearTimeout(timer); };
  }, [readKey, load]);

  // ── 엑셀 내보내기 ────────────────────────────────────────────────────────
  // Export follows every filtered page in server order, never only visible rows.
  const [exporting, setExporting] = useState(false);
  async function handleExport() {
    if (exporting || total === 0) return;
    setExporting(true);
    try {
      const labels: StandardPromptExportLabels = {
        text: t("textLabel"),
        brand: t("brandLabel"),
        listType: t("filterListType"),
        depth1: t("filterDepth1"),
        depth2: t("filterDepth2"),
        depth3: t("filterDepth3"),
        depth4: t("filterDepth4"),
        funnel: t("funnelLabel"),
        market: t("marketLabel"),
        lang: t("langLabel"),
        presence: t("presenceLabel"),
        kind: t("kindLabel"),
        status: t("statusLabel"),
        common: t("common"),
        marketAll: t("marketAll"),
        branded: tVal("branded"),
        unbranded: tVal("unbranded"),
        kindAcr: t("kindAcr"),
        kindSingle: t("kindSingle"),
        statusMeasured: t("statusMeasured"),
        statusUnmeasured: t("statusUnmeasured"),
      };
      const exportRows = remote ? await exportCatalogPages(remote.rows ?? remote.load, readQuery) : sorted;
      const columnRows = remotePage ? [Object.fromEntries(remotePage.columns.map(key => [key, "present"]))] as unknown as StandardPromptViewRow[] : rows;
      const sheet = buildStandardPromptSheet(exportRows, columnRows, labels, {
        market: marketLabel,
        language: (code) => languageName(code, locale),
      });
      await downloadXlsx(
        exportFilename(t("exportFilename"), new Date()),
        sheet.headers,
        sheet.rows,
        t("exportSheetName"),
      );
    } catch (err) {
      // 조용히 실패하면 "버튼이 안 먹는다"로만 보인다 — exceljs 청크 로드 실패나
      // 워크북 생성 오류를 사용자에게 알리고 로그에 남긴다.
      console.error("[standard/prompts] export failed:", err);
      toast.error(t("exportFailed"));
    } finally {
      setExporting(false);
    }
  }

  const draftDirty = useMemo(
    () => (Object.keys(EMPTY_FILTER) as (keyof FilterState)[]).some((k) => draft[k] !== applied[k]),
    [draft, applied],
  );
  const hasActiveFilter =
    query.trim() !== "" ||
    (Object.keys(EMPTY_FILTER) as (keyof FilterState)[]).some((k) => applied[k] !== ALL);

  // ── Compact scope summary (badge text). Many countries are collapsed to a
  // count so the strip stays short; the full list lives in the dropdown.
  const scopeSummary = useMemo(() => {
    if (scopeAll) return t("scopeAll");
    const parts: string[] = [];
    if (scopeBrands.length) parts.push(scopeBrands.join(" · "));
    if (showRegions) parts.push(scopeRegions.join(" · "));
    if (scopeCountries.length) {
      parts.push(
        scopeCountries.length <= 2
          ? scopeCountries.join(" · ")
          : t("scopeCountryCount", { count: scopeCountries.length }),
      );
    }
    return parts.join("  ·  ") || t("scopeAll");
  }, [scopeAll, scopeBrands, showRegions, scopeRegions, scopeCountries, t]);

  // Depth table columns render only when at least one row carries a value at
  // that level — same policy as the depth filter selects below.
  const depthColumns = useMemo(
    () =>
      (
        [
          { key: "depth1", label: t("filterDepth1") },
          { key: "depth2", label: t("filterDepth2") },
          { key: "depth3", label: t("filterDepth3") },
          { key: "depth4", label: t("filterDepth4") },
        ] as const
      ).filter((c) => remotePage ? remotePage.columns.includes(c.key) : rows.some((r) => r[c.key])),
    [rows, t, remotePage],
  );

  // depth selects render only when the current parent yields ≥1 real option,
  // so empty levels (e.g. depth4, currently unpopulated) don't clutter the row.
  const depthSelects: {
    key: keyof FilterState;
    id: string;
    label: string;
    options: string[];
    minW: string;
  }[] = [
    { key: "depth1", id: "sp-view-d1", label: t("filterDepth1"), options: depth1Options, minW: "min-w-48" },
    { key: "depth2", id: "sp-view-d2", label: t("filterDepth2"), options: depth2Options, minW: "min-w-44" },
    { key: "depth3", id: "sp-view-d3", label: t("filterDepth3"), options: depth3Options, minW: "min-w-40" },
    { key: "depth4", id: "sp-view-d4", label: t("filterDepth4"), options: depth4Options, minW: "min-w-36" },
  ];

  if (readError) throw readError;
  return (
    // 배지 툴팁(대상 시장 접힘·미측정 사유)이 이 서브트리 안에서 뜬다.
    <TooltipProvider delayDuration={200}>
    <div className="flex flex-col gap-5">
      {/* ─ Scope dropdown + filter strip ─ */}
      <div className="flex flex-col gap-2.5 rounded-md border border-border bg-card px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="inline-flex items-center gap-1.5 font-semibold text-foreground">
            <Eye className="h-3.5 w-3.5 text-brand-700" aria-hidden />
            {t("scopeLabel")}
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 px-2.5 font-normal"
              >
                <span className="max-w-[18rem] truncate">{scopeSummary}</span>
                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-80 w-64 overflow-y-auto">
              {scopeAll ? (
                <DropdownMenuLabel className="font-normal text-muted-foreground">
                  {t("scopeAll")}
                </DropdownMenuLabel>
              ) : (
                <>
                  {scopeBrands.length ? (
                    <>
                      <DropdownMenuLabel>{t("brandLabel")}</DropdownMenuLabel>
                      <div className="flex flex-wrap gap-1 px-2 pb-2">
                        {scopeBrands.map((b) => (
                          <Badge key={b} variant="secondary" className="font-normal">
                            {b}
                          </Badge>
                        ))}
                      </div>
                    </>
                  ) : null}
                  {showRegions ? (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuLabel>{t("scopeRegionLabel")}</DropdownMenuLabel>
                      <div className="flex flex-wrap gap-1 px-2 pb-2">
                        {scopeRegions.map((rg) => (
                          <Badge key={rg} variant="secondary" className="font-normal">
                            {rg}
                          </Badge>
                        ))}
                      </div>
                    </>
                  ) : null}
                  {scopeCountries.length ? (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuLabel>
                        {t("scopeCountryLabel")} ({scopeCountries.length})
                      </DropdownMenuLabel>
                      <div className="flex flex-wrap gap-1 px-2 pb-2">
                        {scopeCountries.map((c) => (
                          <Badge key={c} variant="outline" className="font-normal text-muted-foreground">
                            {c}
                          </Badge>
                        ))}
                      </div>
                    </>
                  ) : null}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          {!scopeAll ? (
            <span className="text-[11px] text-muted-foreground">
              {t("scopeCommonHint")}
            </span>
          ) : null}
          {/* B1(2026-09-03): 행이 계정 국가로도 좁혀진다는 사실을 화면에 적는다 —
              칩만 보고 "왜 우리 시장 프롬프트가 적지"를 되묻지 않게 한다. */}
          {!scopeAll && scopeCountries.length ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex cursor-help items-center gap-1 text-[11px] text-muted-foreground underline decoration-dotted underline-offset-2">
                  <Info className="h-3 w-3" aria-hidden />
                  {t("scopeMarketHint")}
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs text-xs">
                {t("scopeMarketHintDetail")}
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>

        <div className="flex flex-wrap items-end gap-2">
          {/* search stays live */}
          <div className="relative">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("searchPlaceholder")}
              className="h-8 w-56 pl-8 text-sm"
              aria-label={t("searchPlaceholder")}
            />
          </div>

          {/* list type */}
          {listTypeOptions.length ? (
            <div className="flex flex-col gap-0.5">
              <Label
                htmlFor="sp-view-lt"
                className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase"
              >
                {t("filterListType")}
              </Label>
              <Select
                value={draft.listType}
                onValueChange={(v) => updateDraft({ listType: v })}
              >
                <SelectTrigger id="sp-view-lt" size="sm" className="w-fit min-w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>{t("filterAll")}</SelectItem>
                  {listTypeOptions.map((opt) => (
                    <SelectItem key={opt} value={opt}>
                      {opt}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          {/* depth1 → depth4 cascade */}
          {depthSelects.map(({ key, id, label, options, minW }) =>
            options.length ? (
              <div key={id} className="flex flex-col gap-0.5">
                <Label
                  htmlFor={id}
                  className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase"
                >
                  {label}
                </Label>
                <Select
                  value={draft[key]}
                  onValueChange={(v) => updateDraft({ [key]: v } as Partial<FilterState>)}
                >
                  <SelectTrigger id={id} size="sm" className={`w-fit ${minW}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>{t("filterAll")}</SelectItem>
                    {options.map((opt) => (
                      <SelectItem key={opt} value={opt}>
                        {opt}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null,
          )}

          {/* funnel */}
          {funnelOptions.length ? (
            <div className="flex flex-col gap-0.5">
              <Label
                htmlFor="sp-view-funnel"
                className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase"
              >
                {t("filterFunnel")}
              </Label>
              <Select value={draft.funnel} onValueChange={(v) => updateDraft({ funnel: v })}>
                <SelectTrigger id="sp-view-funnel" size="sm" className="w-fit min-w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>{t("filterAll")}</SelectItem>
                  {funnelOptions.map((f) => (
                    <SelectItem key={f} value={f}>
                      {f}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          {/* brand presence */}
          <div className="flex flex-col gap-0.5">
            <Label
              htmlFor="sp-view-presence"
              className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase"
            >
              {t("presenceLabel")}
            </Label>
            <Select
              value={draft.presence}
              onValueChange={(v) => updateDraft({ presence: v })}
            >
              <SelectTrigger id="sp-view-presence" size="sm" className="w-fit min-w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{t("filterAll")}</SelectItem>
                <SelectItem value="branded">{tVal("branded")}</SelectItem>
                <SelectItem value="unbranded">{tVal("unbranded")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* 측정 종류 (ACR / 단발) */}
          <div className="flex flex-col gap-0.5">
            <Label
              htmlFor="sp-view-kind"
              className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase"
            >
              {t("kindLabel")}
            </Label>
            <Select value={draft.kind} onValueChange={(v) => updateDraft({ kind: v })}>
              <SelectTrigger id="sp-view-kind" size="sm" className="w-fit min-w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{t("filterAll")}</SelectItem>
                <SelectItem value="acr">{t("kindAcr")}</SelectItem>
                <SelectItem value="single">{t("kindSingle")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* 대상 시장 (프롬프트 속성 — 계정 권한 스코프와 다른 축) */}
          {marketOptions.length ? (
            <div className="flex flex-col gap-0.5">
              <Label
                htmlFor="sp-view-market"
                className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase"
              >
                {t("marketLabel")}
              </Label>
              <Select value={draft.market} onValueChange={(v) => updateDraft({ market: v })}>
                <SelectTrigger id="sp-view-market" size="sm" className="w-fit min-w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  <SelectItem value={ALL}>{t("filterAll")}</SelectItem>
                  {marketOptions.map((code) => (
                    <SelectItem key={code} value={code}>
                      {marketLabel(code)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          {/* 언어 */}
          {langOptions.length ? (
            <div className="flex flex-col gap-0.5">
              <Label
                htmlFor="sp-view-lang"
                className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase"
              >
                {t("langLabel")}
              </Label>
              <Select value={draft.lang} onValueChange={(v) => updateDraft({ lang: v })}>
                <SelectTrigger id="sp-view-lang" size="sm" className="w-fit min-w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  <SelectItem value={ALL}>{t("filterAll")}</SelectItem>
                  {langOptions.map((code) => (
                    <SelectItem key={code} value={code}>
                      {languageName(code, locale)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          {/* 측정 상태 (D15) — 기본값은 전체 표시 */}
          <div className="flex flex-col gap-0.5">
            <Label
              htmlFor="sp-view-status"
              className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase"
            >
              {t("statusLabel")}
            </Label>
            <Select value={draft.status} onValueChange={(v) => updateDraft({ status: v })}>
              <SelectTrigger id="sp-view-status" size="sm" className="w-fit min-w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{t("filterAll")}</SelectItem>
                <SelectItem value={STATUS_MEASURED}>{t("statusMeasured")}</SelectItem>
                <SelectItem value={STATUS_UNMEASURED}>{t("statusUnmeasured")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* apply / reset */}
          <Button
            type="button"
            size="sm"
            onClick={() => setApplied(draft)}
            disabled={!draftDirty}
            className="h-8"
          >
            {t("filterApply")}
            {draftDirty ? <span className="ml-1 h-1.5 w-1.5 rounded-full bg-current" aria-hidden /> : null}
          </Button>
          {hasActiveFilter || draftDirty || query.trim() !== "" ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setQuery("");
                setDraft(EMPTY_FILTER);
                setApplied(EMPTY_FILTER);
              }}
              className="h-8 text-muted-foreground"
            >
              {t("filterReset")}
            </Button>
          ) : null}

          {/* 내보내기 — 화면에 적용된 필터 그대로, 현재 페이지가 아니라 전량. */}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleExport}
            disabled={exporting || total === 0}
            className="h-8"
          >
            <Download className="h-3.5 w-3.5" aria-hidden />
            {t("exportLabel")}
          </Button>

          <span className="ml-auto self-center text-[11px] tabular-nums text-muted-foreground">
            {t("filteredCount", { shown: total, total: remotePage?.count ?? rows.length })}
          </span>
        </div>
      </div>

      {total === 0 ? (
        <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          {t("empty")}
        </p>
      ) : (
        // 컬럼(측정 종류 등)이 늘어 좁은 뷰포트에서 넘칠 수 있다 — 잘리는 대신
        // 테이블 자체 가로 스크롤 (페이지 body는 스크롤 안 생김). 프롬프트
        // 텍스트 컬럼에 min-w를 줘 다른 컬럼에 밀려 뭉개지지 않게 한다.
        <div className="overflow-x-auto rounded-md border border-border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30 text-left text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                <th className="min-w-64 px-3 py-2">
                  <SortableHeader {...headerProps("text")}>{t("textLabel")}</SortableHeader>
                </th>
                <th className="w-24 px-3 py-2">
                  <SortableHeader {...headerProps("brand")}>{t("brandLabel")}</SortableHeader>
                </th>
                {listTypeOptions.length ? (
                  <th className="w-28 px-3 py-2">
                    <SortableHeader {...headerProps("listType")}>
                      {t("filterListType")}
                    </SortableHeader>
                  </th>
                ) : null}
                {depthColumns.map((c) => (
                  <th key={c.key} className="w-32 px-3 py-2">
                    <SortableHeader {...headerProps(c.key)}>{c.label}</SortableHeader>
                  </th>
                ))}
                <th className="w-28 px-3 py-2">
                  <SortableHeader {...headerProps("funnel")}>{t("funnelLabel")}</SortableHeader>
                </th>
                <th className="w-44 px-3 py-2">
                  <SortableHeader {...headerProps("market")}>{t("marketLabel")}</SortableHeader>
                </th>
                <th className="w-24 px-3 py-2">
                  <SortableHeader {...headerProps("lang")}>{t("langLabel")}</SortableHeader>
                </th>
                <th className="w-32 px-3 py-2">
                  <SortableHeader {...headerProps("presence")}>{t("presenceLabel")}</SortableHeader>
                </th>
                <th className="w-24 px-3 py-2">
                  <SortableHeader {...headerProps("kind")}>{t("kindLabel")}</SortableHeader>
                </th>
                <th className="w-28 px-3 py-2">
                  <SortableHeader {...headerProps("status")}>{t("statusLabel")}</SortableHeader>
                </th>
                <th className="w-12 px-3 py-2 text-right">{t("historyColumn")}</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((r) => (
                <tr
                  key={r.id}
                  className="border-t border-border align-top first:border-t-0"
                >
                  <td className="px-3 py-3 text-sm text-foreground">{r.text}</td>
                  <td className="px-3 py-3">
                    {isCommon(r.brand) ? (
                      <Badge variant="outline" className="text-[10px] text-muted-foreground">
                        {t("common")}
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-[10px]">
                        {r.brand}
                      </Badge>
                    )}
                  </td>
                  {listTypeOptions.length ? (
                    <td className="px-3 py-3">
                      {r.listType ? (
                        <span className="text-[10px] tracking-wide text-muted-foreground uppercase">
                          {r.listType}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                  ) : null}
                  {depthColumns.map((c) => (
                    <td key={c.key} className="px-3 py-3">
                      {r[c.key] ? (
                        <span className="text-xs leading-snug text-foreground">
                          {r[c.key]}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                  ))}
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
                    <MarketCell
                      regions={r.regions}
                      labelOf={marketLabel}
                      allLabel={t("marketAll")}
                      allHint={t("marketAllHint")}
                      moreHint={t("marketMoreHint")}
                    />
                  </td>
                  <td className="px-3 py-3 text-xs whitespace-nowrap text-muted-foreground">
                    {r.lang ? languageName(r.lang, locale) : "—"}
                  </td>
                  <td className="px-3 py-3">
                    {brandPresenceOf(r.brand, r.brandPresence) === "branded" ? (
                      <Badge variant="secondary" className="text-[10px]">
                        {tVal("branded")}
                      </Badge>
                    ) : brandPresenceOf(r.brand, r.brandPresence) === "unbranded" ? (
                      <Badge variant="outline" className="text-[10px] text-muted-foreground">
                        {tVal("unbranded")}
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-3 py-3">
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
                  </td>
                  <td className="px-3 py-3">
                    {r.scopePromptId === null ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Badge
                            variant="outline"
                            className="border-dashed text-[10px] font-normal text-muted-foreground"
                          >
                            <CircleDashed className="h-3 w-3" aria-hidden />
                            {t("statusUnmeasured")}
                          </Badge>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-64">
                          {t("statusUnmeasuredHint")}
                        </TooltipContent>
                      </Tooltip>
                    ) : (
                      <Badge variant="outline" className="text-[10px] font-normal">
                        <CircleDot className="h-3 w-3 text-brand-700" aria-hidden />
                        {t("statusMeasured")}
                      </Badge>
                    )}
                  </td>
                  <td className="px-3 py-3 text-right">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0 text-muted-foreground"
                      aria-label={t("historyColumn")}
                      title={t("historyColumn")}
                      onClick={() => setTimelineRow({ id: r.id, text: r.text })}
                    >
                      <History className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {total > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className="tabular-nums">
              {t("pageRange", { from: rangeFrom, to: rangeTo, total })}
            </span>
            <span className="text-border">·</span>
            <Label htmlFor="sp-page-size" className="text-[11px] font-normal text-muted-foreground">
              {t("pageSize")}
            </Label>
            <Select value={String(pageSize)} onValueChange={(v) => setPageSize(Number(v))}>
              <SelectTrigger id="sp-page-size" size="sm" className="h-7 w-[72px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAGE_SIZE_OPTIONS.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {pages > 1 ? (
            <div className="flex items-center gap-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8"
                disabled={safePage <= 1}
                onClick={() => setPage(safePage - 1)}
              >
                <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
                {t("prev")}
              </Button>
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {t("pageOf", { page: safePage, pages })}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8"
                disabled={safePage >= pages}
                onClick={() => setPage(safePage + 1)}
              >
                {t("next")}
                <ChevronRight className="h-3.5 w-3.5" aria-hidden />
              </Button>
            </div>
          ) : null}
        </div>
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
    </TooltipProvider>
  );
}
