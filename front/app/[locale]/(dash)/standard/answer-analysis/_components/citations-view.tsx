"use client";

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useTranslations, useLocale } from "next-intl";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import {
  PieChart,
  Pie,
  Cell,
  LineChart,
  Line,
  AreaChart,
  Area,
  BarChart,
  Bar,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip as RTooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import {
  Link2,
  Globe,
  FolderTree,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  ExternalLink,
  Search,
  Download,
  MessageSquareText,
  ShieldCheck,
  Store,
  Target,
  Building2,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TooltipProvider as InfoTooltipProvider } from "@/components/ui/tooltip";
import { ColInfo } from "@/components/dash/col-info";
import {
  DimensionFilterPanel,
  FILTER_SECTIONS,
  type DimensionGroup,
} from "@/components/dash/dimension-filter-panel";
import {
  joinFilterValues,
  splitFilterValues,
} from "@/components/dash/filter-encoding";
import { composeGroups } from "./filter-groups";
import { PILL_BAR_RADIUS } from "./kpi/chart-box";
// taxonomy.ts only — value strings + i18n slugs (geo-catalog/seed stay server-side).
import {
  citationCategorySlug,
  OFFICIAL_HMG_CATEGORY,
  type CitationCategory,
} from "@/lib/citation-categorizer/taxonomy";
import {
  citationDrilldownEmptyKey,
  contentDispositionFilename,
  domainDetailUrl,
  domainExportUrl,
  domainListUrl,
  isDefaultDomainQuery,
  type CitationDrilldownEmptyKey,
  type CitationSectionDegraded,
  type CitationTableSource,
  type DomainTableSortKey,
} from "../_data/citation-view";
import { toast } from "sonner";
import { dateStamp } from "@/lib/export/csv";
import { downloadXlsx } from "@/lib/export/xlsx";
import { cn } from "@/lib/utils";
import { displayCitationUrl } from "@/lib/url-display";
import { countryName } from "@/lib/geo-catalog";
import { CHART_TOOLTIP_STYLE } from "@/lib/viz/chart-tooltip";
import {
  GapAwareTooltip,
  trendGapAreas,
  trendGapBridgeLines,
  trendGapStackBands,
} from "@/components/dash/trend-gap-overlay";
import { planTrendGaps } from "@/lib/viz/trend-gap";
import { trendStackBoundaryRows } from "@/lib/viz/trend-gap-stack";
import type {
  CitationsLive,
  CitationDomainLive,
  CitationCategorySlice,
  CitationPromptLive,
  CitationTrend,
  CitationUrlLive,
  EngineCategorySlice,
} from "@/lib/scope/result-adapter";
import { PendingCard, EmptyState, weekStartMD } from "./mentions-view";
import { AnswerModal } from "./answer-modal";
import { TRUNCATED_ROW_CLASS, TruncatedNote } from "./citation-domain-table";

const PIE_COLORS = [
  "#002c5f", "#e63312", "#00aad2", "#a36b4f", "#6b89b3",
  "#1a4d8e", "#0d6e2f", "#fbbf24", "#f97316", "#a855f7",
];

// 출처 카테고리 → 고정 색 (색은 순위가 아니라 엔티티를 따른다 — 필터로 슬라이스가
// 줄어도 같은 카테고리는 같은 색). dataviz validator 통과 팔레트 (light·dark,
// 2026-07-02): 명도 밴드·채도 바닥·인접 CVD 분리·표면 대비 전항목 PASS.
const CATEGORY_COLORS: Record<string, string> = {
  "Official (HMG)": "#2563eb",
  "Official (Competitor)": "#0891b2",
  "Dealer & Marketplace": "#b45309",
  "Automotive Media": "#7c3aed",
  "News & Media": "#d97706",
  "Community & Forums": "#16a34a",
  "Social & Video": "#db2777",
  "Blogs & Reviews": "#0d9488",
  // Wiki 는 카테고리 신설(2026-08-06) 때 색이 안 들어가 회색 폴백으로 그려지고
  // 있었다. 2026-08-28 카테고리 2종이 더 늘면서 폴백 공유가 실제 충돌이 되므로
  // 여기서 함께 채운다.
  "Wiki & Reference": "#4f46e5",
  "Government & Public": "#dc2626",
  // 2026-08-28 신설. dataviz 검증기(light, surface #fcfcfb) 전항목 PASS —
  // 인접쌍 CVD·명도밴드·채도바닥·대비 모두 통과. 유일한 FAIL 은 **기존** 쌍
  // #db2777(소셜)↔#0d9488(블로그) deutan ΔE 3.8 로, 이 변경 이전부터 있던 것이다.
  // 다크모드는 이 리포에 미설치(globals.css: "We do NOT install next-themes")라
  // 다크 대비 WARN 은 적용 대상이 아니다.
  "Award & Certification": "#a21caf",
  "Academic & Research": "#0284c7",
  Other: "#6e9a3d",
};
// 택소노미 밖 문자열(레거시 scope 값 등)은 중립 회색 — 시리즈 색을 침범하지 않는다.
const CATEGORY_FALLBACK_COLOR = "#8c8578";

export function categoryColor(name: string): string {
  return CATEGORY_COLORS[name] ?? CATEGORY_FALLBACK_COLOR;
}

// 택소노미 정본을 재수출 — 문자열 복붙을 없앤다(배지·타일·드릴다운이 한 값을 본다).
export const OFFICIAL_HMG: CitationCategory = OFFICIAL_HMG_CATEGORY;
export const DEALER_MARKETPLACE = "Dealer & Marketplace";
export const OFFICIAL_COMPETITOR = "Official (Competitor)";

// ── API 원천(unit U7): 표 페이지·드릴다운을 BFF 에서 읽는다 ─────────────────────
//
// 새 백엔드는 도메인 목록을 200행 키셋 페이지로 주고(D5), 행에 드릴다운(urls·promptList)을
// 싣지 않는다(3.5 #6). `tableSource` 가 있으면(= 페이지가 API 원천):
//   · 기본 순서(검색 없음·인용 수 내림차순)는 서버가 준 첫 페이지 + "더 보기" 페이지
//   · 검색·정렬은 /api/citations/domains 가 전 행에서 한다(BG-21). 현행은 받은 전 행을 클라이언트에서
//   · 행을 펼치면 /api/citations/domains/<skey> 를 한 번 읽는다
// 없으면(legacy) 종전 그대로 클라이언트 검색·정렬·인라인 드릴다운이다.

/** 행 번호 두 벌(BG-21): rank = 경쟁사 선택 뒤·검색 전, matchRank = 검색 뒤. */
export type RankedDomainRow = CitationDomainLive & { rank?: number; matchRank?: number };

type TablePage = { rows: RankedDomainRow[]; nextCursor: string | null; total: number | null };
type TableState = TablePage & {
  key: string;
  status: "loading" | "ready" | "error";
  /** "더 보기" 요청이 나가 있다(버튼 비활성, 중복 요청 금지: U7 검증 D3). */
  more?: boolean;
};

async function readTablePage(url: string, signal?: AbortSignal): Promise<TablePage> {
  const r = await fetch(url, { signal });
  if (!r.ok) throw Object.assign(new Error("table page failed"), { status: r.status });
  const d = (await r.json()) as Partial<TablePage>;
  return { rows: d.rows ?? [], nextCursor: d.nextCursor ?? null, total: d.total ?? null };
}

/**
 * API 원천 표의 행 목록. 기본 순서면 `initial`(서버 첫 페이지) 뒤에 "더 보기" 로 받은 행을
 * 붙이고, 검색·정렬이면 서버에 그 조건의 첫 페이지를 묻는다. `source` 가 없으면 비활성.
 *
 * 요청 규칙(U7 검증 D2·D3):
 *   · "더 보기" 는 한 번에 하나만 나간다(나가 있는 동안 loadMore 는 무시, 버튼 비활성).
 *   · 조건(key)이 바뀌면 나가 있는 요청을 끊고, 끊긴 요청과 다른 key 의 응답은 버린다.
 *   · 409 cursor_stale 이면 재시작 번호를 올려 key 를 바꾼다: 그 조건의 첫 페이지를 route 로
 *     다시 읽는다. 기본 순서도 서버 렌더의 첫 페이지·커서(이미 낡음)를 버리고 route 로 읽는다.
 */
export function useServerDomainTable(opts: {
  source: CitationTableSource | null | undefined;
  initial: RankedDomainRow[];
  q: string;
  sortKey: DomainTableSortKey;
  asc: boolean;
  pageSize: number;
}): {
  active: boolean;
  rows: RankedDomainRow[];
  total: number | null;
  nextCursor: string | null;
  status: "loading" | "ready" | "error";
  /** "더 보기" 요청이 나가 있다. */
  loadingMore: boolean;
  loadMore: () => void;
} {
  const { source, initial, q, sortKey, asc, pageSize } = opts;
  const t = useMemo(() => ({ q: q.trim(), sortKey, asc }), [q, sortKey, asc]);
  const isDefault = isDefaultDomainQuery(t);
  // 409 재시작 번호. 그 409 가 난 필터 조건(source.query)에만 붙는다: 필터가 바뀌면 서버가 새
  // 첫 페이지·커서를 주므로 0 으로 돌아간다.
  const [restart, setRestart] = useState<{ query: string; n: number } | null>(null);
  const restartN = source && restart?.query === source.query ? restart.n : 0;
  // 서버 첫 페이지(initial)를 쓰는가: 기본 순서이고 그 커서가 아직 낡지 않았을 때만.
  const fromServer = isDefault && restartN === 0;
  const key = source ? JSON.stringify([source.query, isDefault ? null : t, restartN]) : "";
  const [state, setState] = useState<TableState | null>(null);
  const moreReq = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!source) return;
    const ctrl = new AbortController();
    if (!fromServer) {
      setState({ key, rows: [], nextCursor: null, total: null, status: "loading" });
      readTablePage(domainListUrl(source, t, pageSize), ctrl.signal)
        .then((p) => {
          if (!ctrl.signal.aborted) setState({ key, ...p, status: "ready" });
        })
        .catch(() => {
          if (!ctrl.signal.aborted) setState({ key, rows: [], nextCursor: null, total: null, status: "error" });
        });
    }
    return () => {
      // 조건이 바뀌었다: 이 key 의 첫 페이지와 "더 보기" 를 모두 끊는다.
      ctrl.abort();
      moreReq.current?.abort();
      moreReq.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one load per (query, search, sort, restart)
  }, [key]);

  const current: TableState | null = state?.key === key ? state : null;
  const base: TableState = fromServer
    ? {
        key,
        rows: [...initial, ...(current?.rows ?? [])],
        nextCursor: current ? current.nextCursor : (source?.nextCursor ?? null),
        total: source?.total ?? null,
        status: current?.status ?? "ready",
        more: current?.more,
      }
    : (current ?? { key, rows: [], nextCursor: null, total: null, status: "loading" });

  const loadMore = useCallback(() => {
    if (!source || !base.nextCursor || base.status !== "ready" || moreReq.current) return;
    const cursor = base.nextCursor;
    const reqKey = key;
    const ctrl = new AbortController();
    moreReq.current = ctrl;
    // 이 key 의 상태에만 쓴다. 끊긴 요청(조건 변경)은 아무것도 쓰지 않는다.
    const settle = (next: (prev: TableState) => TableState) => {
      if (ctrl.signal.aborted) return;
      if (moreReq.current === ctrl) moreReq.current = null;
      setState((prev) => (prev?.key === reqKey ? next(prev) : prev));
    };
    setState((prev) =>
      prev?.key === reqKey
        ? { ...prev, more: true }
        : { key: reqKey, rows: [], nextCursor: cursor, total: null, status: "ready", more: true },
    );
    readTablePage(domainListUrl(source, t, pageSize, cursor), ctrl.signal)
      .then((p) =>
        settle((prev) => ({
          key: reqKey,
          rows: [...prev.rows, ...p.rows],
          nextCursor: p.nextCursor,
          total: fromServer ? prev.total : p.total,
          status: "ready",
          more: false,
        })),
      )
      .catch((e: { status?: number }) => {
        if (ctrl.signal.aborted) return;
        if (e?.status === 409) {
          // 409 cursor_stale: 세대가 바뀌었다. 받은 추가 페이지를 버리고 첫 페이지부터(2.6).
          if (moreReq.current === ctrl) moreReq.current = null;
          setRestart({ query: source.query, n: restartN + 1 });
          return;
        }
        settle((prev) => ({ ...prev, status: "error", more: false }));
      });
  }, [source, base.nextCursor, base.status, t, pageSize, key, fromServer, restartN]);

  return {
    active: Boolean(source),
    rows: base.rows,
    total: fromServer ? (source?.total ?? null) : base.total,
    nextCursor: base.nextCursor,
    status: base.status,
    loadingMore: Boolean(base.more),
    loadMore,
  };
}

type DetailState = { url: string } & (
  | { status: "loading" }
  | {
      status: "ready";
      urls: CitationUrlLive[];
      promptList: CitationPromptLive[];
      /** 상세 상한(URL 10) 전 URL 수 — 상한이 목록을 잘랐을 때만(P6 B047). */
      urlTotal?: number;
      /** 상세 상한(프롬프트 12) 전 프롬프트 수 — 상한이 목록을 잘랐을 때만(P6 B047). */
      promptTotal?: number;
    }
  | { status: "error" }
);

/**
 * 펼친 행의 드릴다운 상세 한 번 읽기. 다 받은 것만 남긴다. 응답 전에 닫으면 다시 열 때
 * 다시 읽는다(중단된 "loading" 이 남아 스피너가 끝나지 않는 결함 방지, U6 검증 D2 와 같은 규칙).
 *
 * 받은 상세는 그 URL(= 필터 조건)의 것이다(U7 검증 D1): 필터를 바꿔도 페이지 클라이언트 상태는
 * 남으므로(layout-router 가 검색 파라미터 없이 키를 잡는다), URL 이 다르면 "ready" 가 아니다.
 * 열려 있으면 새 URL 로 다시 읽고, 닫혀 있으면 다음에 열 때 읽는다.
 */
export function useDomainDetail(url: string | null, open: boolean): DetailState | null {
  const [state, setState] = useState<DetailState | null>(null);
  useEffect(() => {
    if (!url || !open || (state?.url === url && state.status === "ready")) return;
    const ctrl = new AbortController();
    setState({ url, status: "loading" });
    fetch(url, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("detail failed"))))
      .then((d: { urls?: CitationUrlLive[]; promptList?: CitationPromptLive[]; urlTotal?: number; promptTotal?: number }) => {
        if (ctrl.signal.aborted) return;
        setState({
          url,
          status: "ready",
          urls: d.urls ?? [],
          promptList: d.promptList ?? [],
          ...(typeof d.urlTotal === "number" ? { urlTotal: d.urlTotal } : {}),
          ...(typeof d.promptTotal === "number" ? { promptTotal: d.promptTotal } : {}),
        });
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setState({ url, status: "error" });
      });
    return () => {
      ctrl.abort();
      setState((prev) => (prev?.status === "ready" ? prev : null));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once per url while open
  }, [url, open]);
  return state && state.url === url ? state : null;
}

/** 인용률 카드 정의 문구의 판정 단위(DC-02): legacy = 프롬프트(summary.def), API = 측정(summary.defMeasured). */
export function hitRateDefPrefix(unit: "measurement" | undefined): "summary.def" | "summary.defMeasured" {
  return unit === "measurement" ? "summary.defMeasured" : "summary.def";
}

/** API 원천 표의 한 페이지 행 수(백엔드 상한 200, 설계 3.3). */
export const API_TABLE_PAGE = 200;

/** 빈 표 자리: API 원천이 읽는 중·실패면 그 상태, 아니면 종전 빈 문구. */
export function TableStatus({ table, empty }: { table: ReturnType<typeof useServerDomainTable>; empty: string }) {
  const t = useTranslations("answerAnalysis.citations.table");
  if (table.active && table.status === "loading") {
    return (
      <span className="inline-flex items-center gap-2">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        {t("loading")}
      </span>
    );
  }
  if (table.active && table.status === "error") return <>{t("loadFailed")}</>;
  return <>{empty}</>;
}

/** 표 아래 "더 보기"(API 원천, 다음 커서가 있을 때만). */
export function LoadMoreRow({ table, colSpan }: { table: ReturnType<typeof useServerDomainTable>; colSpan: number }) {
  const t = useTranslations("answerAnalysis.citations.table");
  if (!table.active || (!table.nextCursor && table.status !== "error")) return null;
  return (
    <tr className="border-t border-border">
      <td colSpan={colSpan} className="px-3 py-2 text-center">
        {table.status === "error" ? (
          <span className="text-xs text-muted-foreground">{t("loadFailed")}</span>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={table.loadMore}
            disabled={table.loadingMore}
            aria-busy={table.loadingMore}
            className="text-xs"
          >
            {table.loadingMore ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
            {t("loadMore")}
          </Button>
        )}
      </td>
    </tr>
  );
}

// ── 내보내기(P6 B048·B049): 실패 고지·진행 중 비활성 ───────────────────────────
//
// 종전에는 `void downloadXlsx(...)`(표준·legacy) 와 `window.location.assign(내보내기 URL)`(API 원천
// website/project)이라 실패가 삼켜지거나 브라우저가 원시 JSON 오류 화면으로 이동했고, 연타마다
// 파일 생성(API 원천은 전량 재집계)이 다시 돌았다. 이제 한 번에 하나만 돌리고(버튼 비활성),
// 실패는 기존 문구(standardPromptsView.exportFailed) 토스트로 알린다. 파일 바이트·이름은 같다.

/**
 * 내보내기 한 번. 나가 있는 동안의 호출은 무시하고(guard), 실패는 onError 로 넘긴다. busy 는
 * 시작에 true, 끝(성공·실패)에 false.
 */
export async function runExportTask(
  guard: { current: boolean },
  setBusy: (busy: boolean) => void,
  task: () => Promise<void>,
  onError: (e: unknown) => void,
): Promise<void> {
  if (guard.current) return;
  guard.current = true;
  setBusy(true);
  try {
    await task();
  } catch (e) {
    onError(e);
  } finally {
    guard.current = false;
    setBusy(false);
  }
}

/** 버튼 하나의 내보내기 상태: busy(비활성 표시)와 run(한 번에 하나). */
export function useExportTask(onError: (e: unknown) => void): { busy: boolean; run: (task: () => Promise<void>) => Promise<void> } {
  const guard = useRef(false);
  const [busy, setBusy] = useState(false);
  const run = useCallback((task: () => Promise<void>) => runExportTask(guard, setBusy, task, onError), [onError]);
  return { busy, run };
}

/** 내보내기 실패 고지 — 기존 문구(표준 프롬프트 화면의 엑셀 실패 토스트와 같은 키). */
export function useExportFailedNotice(): (e: unknown) => void {
  const t = useTranslations("standardPromptsView");
  return useCallback(
    (e: unknown) => {
      // 조용히 실패하면 "버튼이 안 먹는다"로만 보인다 — 로그에 남기고 사용자에게 알린다.
      console.error("[citations] export failed:", e);
      toast.error(t("exportFailed"));
    },
    [t],
  );
}

/** 받은 파일을 a[download] 로 저장한다(브라우저 전용, lib/export/xlsx.ts 와 같은 방식). */
function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * API 원천 도메인 전체 파일(BG-22, /api/citations/domains/export)을 fetch 로 받아 저장한다. 2xx 가
 * 아니면(401·403·422·5xx·시간 초과의 JSON 오류) 던진다 — 화면을 떠나지 않고 호출부가 알린다.
 * 파일 이름은 응답 Content-Disposition(링크 이동 다운로드가 쓰던 것) 그대로다.
 */
export async function downloadDomainExport(
  url: string,
  deps: { fetchImpl?: typeof fetch; save?: (blob: Blob, filename: string) => void } = {},
): Promise<void> {
  const r = await (deps.fetchImpl ?? fetch)(url);
  if (!r.ok) throw Object.assign(new Error("export failed"), { status: r.status });
  const blob = await r.blob();
  const name = contentDispositionFilename(r.headers.get("content-disposition")) ?? `citation-sources-${dateStamp()}.xlsx`;
  (deps.save ?? saveBlob)(blob, name);
}

// 표준 > 답변 분석 > 인용 분석 (Citation Sources) — LIVE only.
//
// Fed by the root scope project (fetchStandardCitations → aggregateCitations:
// parses raw answer citations into domain rollups + URL drilldown). NO sample
// fallback. Citation category/subcategory taxonomy and the daily trend are
// scope gaps → "준비 중" placeholders / "—".

type SortKey = "domain" | "citations" | "share" | "prompts" | "coverageRate";

// 표준 기본 축 — mentions-view 와 동일 (geography + engine/promptContext +
// HMG 카탈로그 분류). 웹사이트 뷰는 override 해 language 를 넣고 카탈로그 축을 숨김.

export function CitationsView({
  data,
  lockedGroups = [],
  extraGroups = [],
  onlyGroups,
  primaryGroups,
  scope,
  catalogRows,
  geographyOptions,
  engineOptions,
  languageOptions,
  dynamicAxes,
  targetHitRate,
  selectableDates,
  hideFilterPanel = false,
  tableSource,
  dataDegraded = false,
  degradedSections,
}: {
  data: CitationsLive | null;
  lockedGroups?: DimensionGroup[];
  // 웹사이트 뷰가 admin 에게 brand(브랜드 통합) 축을 추가 노출하기 위해 사용.
  extraGroups?: DimensionGroup[];
  // 축 구성 override — 웹사이트 뷰가 geography/language/engine 만 노출하기 위해
  // 사용. 미지정 시 표준 기본값. extraGroups 는 여기에도 추가로 append 된다.
  onlyGroups?: DimensionGroup[];
  primaryGroups?: DimensionGroup[];
  scope?: import("@/lib/auth/types").AllowedScope;
  catalogRows?: import("@/components/dash/dimension-filter-panel").CatalogTaxonomyRow[];
  geographyOptions?: string[];
  // 기간 내 실제 수집 엔진(프로젝트 표면 주입) — DimensionFilterPanel.engineOptions.
  engineOptions?: string[];
  languageOptions?: string[];
  // 프로젝트 커스텀 태그를 필터 패널의 동적 축으로 주입(프로젝트 citation만).
  dynamicAxes?: import("@/components/dash/dimension-filter-panel").DynamicAxis[];
  // 프롬프트 기준 인용률 2종(자사 URL · 타겟 URL) — 웹사이트 인용 화면 전용
  // (타겟 URL 이 website_prompts 에만 있다). undefined = 카드 미노출(표준·프로젝트
  // 화면). rate/ownedRate null = 분모 0 또는 출처 카테고리 필터로 산출 불가 → "—".
  // 두 값은 **같은 SQL 문장의 같은 분모**를 쓴다(GGMD-61 수용 기준 A1) — 한쪽만
  // 그리면 화면에서 그 보장이 보이지 않으므로 둘을 나란히 낸다.
  // 타입은 구조적으로 선언한다 — 클라이언트 컴포넌트가 서버 전용 리포지토리
  // 모듈을 (타입으로도) 참조하지 않도록. 산출은 WebsiteTargetHitRateResult.
  targetHitRate?: {
    hitPrompts: number;
    ownedPrompts: number;
    measuredPrompts: number;
    rate: number | null;
    ownedRate: number | null;
    // 발행 리포트 정본 경로(`X.reportTruth`)의 출처 표식. **키가 꺼져 있으면 없다** —
    // 종전과 같은 화면이 되도록. 값이 어디서 왔는지가 바뀌는데 화면이 같으면 다음
    // 사람이 "왜 어제와 다른가" 를 추적할 수 없어 최소한의 한 줄을 툴팁에 남긴다.
    source?: "published" | "live";
    publication?: {
      cycleLabel: string | null;
      cycleLabelEn: string | null;
      roundDate: string;
      siteCount: number;
    };
    /**
     * API 원천(unit U7, DC-02): 두 비율의 판정 단위가 프롬프트가 아니라 측정(A2)이다. 있으면
     * 툴팁 정의·산식을 그 단위의 문구(summary.defMeasured)로 바꾼다. legacy 객체에는 없다.
     */
    unit?: "measurement";
  };
  // 2026-08-27 — 필터바를 이 뷰 밖(페이지의 별도 <Suspense> 경계)에서 그릴 때
  // 켠다. 답변분석 화면은 무거운 집계 하나가 화면 전체를 붙잡고 있었는데, 필터바는
  // 값싼 옵션 read 만 필요하므로 먼저 그려 **재조회 중에도 필터를 만질 수 있게** 한다.
  // 켜지면 이 뷰는 본문만 그린다(빈 상태여도 필터바는 페이지에 남는다).
  hideFilterPanel?: boolean;
  /**
   * 앵커 축(스펙 §5.1) — 회차가 있는 KST 날짜 목록. `undefined`(축 off·미적용)면
   * 달력은 종전대로 전 날짜를 연다. 계열은 그 지면의 것이다(D1).
   */
  selectableDates?: string[];
  /**
   * API 원천(unit U7)일 때만: 표의 다음 페이지·검색·정렬·파일과 행 드릴다운을 읽을 BFF 조건.
   * 없으면 종전(legacy) 그대로 받은 전 행을 클라이언트에서 검색·정렬한다.
   */
  tableSource?: CitationTableSource | null;
  /**
   * API 원천(P6 B042): `data` 의 `null` 이 데이터 없음이 아니라 일시 실패(5xx·시간 초과)인가.
   * 판정은 서버 요청 스코프의 degrade 표식(`citationsDegraded`)이라 페이지가 읽어 넘긴다. 켜지면
   * '데이터 없음' 대신 기존 지연 안내(answerAnalysis.mentions.kpi.degraded)를 낸다. 없으면 종전 그대로.
   */
  dataDegraded?: boolean;
  /** API 원천(P6 B042): 일시 실패로 빈 보조 블록 — '준비 중'·숨김 대신 같은 지연 안내. */
  degradedSections?: CitationSectionDegraded | null;
}) {
  const t = useTranslations("answerAnalysis.citations");
  const tRoot = useTranslations("answerAnalysis");
  const tKpi = useTranslations("answerAnalysis.mentions.kpi");
  const tFilter = useTranslations("answerAnalysis.filters");
  const tCat = useTranslations("citationCategories");
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [, startCategoryTransition] = useTransition();

  // 인용률 카드 2종의 **출처 한 줄**. 발행값이면 어느 회차·몇 개 모수인지, 폴백이면
  // 왜 라이브인지를 툴팁 설명 끝에 붙인다. 표식이 없으면(키 off) 빈 문자열이라
  // 종전 문구 그대로다.
  const hitRateSourceNote = useMemo(() => {
    const src = targetHitRate?.source;
    if (src === "live") return t("summary.reportTruth.live");
    if (src !== "published") return "";
    const pub = targetHitRate?.publication;
    const cycle =
      (locale === "ko" ? pub?.cycleLabel : pub?.cycleLabelEn) ??
      pub?.cycleLabel ??
      pub?.roundDate ??
      "";
    return t("summary.reportTruth.published", { cycle, sites: pub?.siteCount ?? 0 });
  }, [t, locale, targetHitRate?.source, targetHitRate?.publication]);
  const hitRateDef = hitRateDefPrefix(targetHitRate?.unit);

  // 카테고리 값(영문, 데이터 그대로) → 로케일 라벨. 택소노미 밖 문자열은 원문 유지.
  const catLabel = (name: string) => {
    const slug = citationCategorySlug(name);
    return slug ? tCat(slug) : name;
  };

  // 도넛 슬라이스 클릭 = ?source= 필터 토글 (패널의 적용 버튼과 같은 URL 계약 —
  // 서버 집계가 다시 좁혀지고 패널 체크박스도 동기화된다).
  const activeCategories = splitFilterValues(sp.get("source"));
  function toggleCategoryFilter(name: string) {
    const params = new URLSearchParams(sp.toString());
    const next = activeCategories.includes(name)
      ? activeCategories.filter((v) => v !== name)
      : [...activeCategories, name];
    if (next.length) params.set("source", joinFilterValues(next));
    else params.delete("source");
    const qs = params.toString();
    startCategoryTransition(() => {
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    });
  }

  const [search, setSearch] = useState("");
  // 입력값은 즉시 반영하되 목록 재계산은 뒤로 미룬다. 이전에는 키 입력마다
  // sorted(전체 도메인 filter+map+sort)와 전 행 리렌더가 동기로 돌아 타이핑이
  // 걸렸다(INP). deferred 값으로 무거운 쪽만 낮은 우선순위로 미루면 입력 자체는
  // 항상 즉시 반응한다 — 임의의 debounce 지연을 고르지 않아도 된다.
  const deferredSearch = useDeferredValue(search);
  const [sortKey, setSortKey] = useState<SortKey>("citations");
  const [asc, setAsc] = useState(false);
  // A row expands either to its URL list (row click) or its prompt list (프롬프트
  // count click) — the two are distinct drilldowns into the same domain.
  const [expanded, setExpanded] = useState<{
    domain: string;
    mode: "urls" | "prompts";
  } | null>(null);

  const legacySorted = useMemo(() => {
    const q = deferredSearch.trim().toLowerCase();
    const arr = (data?.domains ?? [])
      .filter((r) => !q || r.domain.toLowerCase().includes(q))
      .map((r, i) => ({ ...r, rank: i + 1 }));
    arr.sort((a, b) => {
      const dir = asc ? 1 : -1;
      if (sortKey === "domain") return dir * a.domain.localeCompare(b.domain);
      return dir * (a[sortKey] - b[sortKey]);
    });
    return arr;
  }, [data, deferredSearch, sortKey, asc]);
  // API 원천: 검색·정렬은 서버가 전 행에서 하고, '#' 은 검색 뒤 번호(matchRank)다. 현행
  // 표가 거른 뒤 매긴 번호와 같은 규칙(U7-N4).
  const table = useServerDomainTable({
    source: tableSource,
    initial: (data?.domains ?? []) as RankedDomainRow[],
    q: deferredSearch,
    sortKey,
    asc,
    pageSize: API_TABLE_PAGE,
  });
  const sorted = table.active
    ? table.rows.map((r, i) => ({ ...r, rank: r.matchRank ?? i + 1 }))
    : legacySorted;

  const ownedPromptBuckets = useMemo(() => {
    if (!data) return null;

    type PromptBucket = {
      id: string;
      promptText: string;
      funnelStage: string | null;
      citations: number;
      providers: Set<string>;
      answers: CitationPromptLive["answers"];
      ownedCitationCount: number;
    };

    const allPrompts = new Map<string, PromptBucket>();
    const ownedPromptIds = new Set<string>();

    for (const domain of data.domains) {
      for (const prompt of domain.promptList ?? []) {
        let bucket = allPrompts.get(prompt.id);
        if (!bucket) {
          bucket = {
            id: prompt.id,
            promptText: prompt.promptText,
            funnelStage: prompt.funnelStage,
            citations: 0,
            providers: new Set(),
            answers: prompt.answers,
            ownedCitationCount: 0,
          };
          allPrompts.set(prompt.id, bucket);
        }
        bucket.citations += prompt.citations;
        for (const provider of prompt.providers) bucket.providers.add(provider);
        if ((bucket.answers?.length ?? 0) === 0 && (prompt.answers?.length ?? 0) > 0) {
          bucket.answers = prompt.answers;
        }
        // 자사 판정은 **인용 행 단위**다(2026-09-08). 종전에는 `domain.isOurs`
        // (도메인 안의 어떤 인용이라도 owned 면 true)로 갈랐는데, genesis.com ·
        // hyundai.com · kia.com 처럼 국가 경로로 갈리는 공유 호스트에서는 타국·
        // 글로벌 페이지만 인용한 프롬프트까지 자사로 승격됐다. SQL 경로
        // (promptSplit)와 같은 규칙을 쓰지 않으면 소스 분류 필터를 켤 때
        // (= promptSplit 미계산 → 이 폴백) 숫자가 갈린다.
        // ownedCitations 가 없는 구 캐시 엔트리는 종전 규칙으로 폴백한다.
        const ownedHere =
          prompt.ownedCitations === undefined ? domain.isOurs : prompt.ownedCitations > 0;
        if (ownedHere) {
          ownedPromptIds.add(prompt.id);
          bucket.ownedCitationCount += prompt.ownedCitations ?? prompt.citations;
        }
      }
    }

    if (allPrompts.size === 0 || ownedPromptIds.size === 0) return null;

    const owned: CitationPromptLive[] = [];
    const uncited: CitationPromptLive[] = [];

    for (const prompt of allPrompts.values()) {
      const row: CitationPromptLive = {
        id: prompt.id,
        promptText: prompt.promptText,
        funnelStage: prompt.funnelStage,
        citations: prompt.citations,
        providers: [...prompt.providers],
        answers: prompt.answers,
      };
      if (ownedPromptIds.has(prompt.id)) owned.push(row);
      else uncited.push(row);
    }

    owned.sort((a, b) => b.citations - a.citations);
    uncited.sort((a, b) => b.citations - a.citations);

    return {
      owned,
      uncited,
      ownedCount: owned.length,
      uncitedCount: uncited.length,
    };
  }, [data]);

  // 미러(SQL) 경로는 프롬프트 분할을 서버에서 전량 계산해 promptSplit 으로 싣는다
  // — 도메인 promptList 가 top-N 캡으로 잘려도 카운트가 정확하도록. undefined
  // (live/public 경로)면 종전처럼 domains.promptList 를 스캔해 계산한다.
  const promptBuckets =
    data && data.promptSplit !== undefined ? data.promptSplit : ownedPromptBuckets;

  function clickHeader(k: SortKey) {
    if (sortKey === k) setAsc((v) => !v);
    else {
      setSortKey(k);
      setAsc(k === "domain");
    }
  }

  // 내보내기는 한 번에 하나(버튼 비활성), 실패는 기존 문구 토스트(P6 B049).
  const exportTask = useExportTask(useExportFailedNotice());

  // Export the real (server-filtered, sorted) domain rows.
  function onExport() {
    if (tableSource) {
      // API 원천: 받은 페이지가 아니라 전 행이 대상이다(현행 파일과 같은 7열, BG-22). 링크 이동 대신
      // fetch 로 받아 저장한다 — 실패가 원시 JSON 화면 이동이 아니라 화면 안의 토스트가 된다.
      const url = domainExportUrl(tableSource, { q: deferredSearch, sortKey, asc }, locale);
      void exportTask.run(() => downloadDomainExport(url));
      return;
    }
    const rows = sorted.map((r) => [
      r.rank,
      r.domain,
      r.category ? catLabel(r.category) : "",
      r.citations,
      r.share.toFixed(1),
      r.prompts,
      r.coverageRate.toFixed(1),
    ]);
    void exportTask.run(() =>
      downloadXlsx(
        `citation-sources-${dateStamp()}`,
        [
          t("table.col.rank"),
          t("table.col.domain"),
          t("table.col.category"),
          t("table.col.citations"),
          t("table.col.share"),
          t("table.col.prompts"),
          t("table.col.coverage"),
        ],
        rows,
      ),
    );
  }

  if (!data) {
    return (
      <div className="flex flex-col gap-6">
        <p className="text-sm text-muted-foreground">{t("description")}</p>
        {/* 일시 실패면 '데이터 없음'이 아니라 기존 지연 안내(P6 B042, 표준 화면 StatusBlock 과 같은 카드). */}
        {dataDegraded ? (
          <PendingCard title={tRoot("tabs.citations")} label={tKpi("degraded")} />
        ) : (
          <EmptyState label={tRoot("empty")} />
        )}
      </div>
    );
  }

  return (
    <InfoTooltipProvider delayDuration={200}>
    <div className="flex flex-col gap-6">
      {/* (a) Single header filter bar — dimensions + domain search are the one
          data driver for all content below. On the mirror path each citation maps
          to a job that carries region, so geography narrows citations too (same
          axes as the mention/overview tabs). */}
      {hideFilterPanel ? null : (
        <DimensionFilterPanel
          stage="citations"
          selectableDates={selectableDates}
          lockedGroups={lockedGroups}
          scope={scope}
          catalogRows={catalogRows}
          geographyOptions={geographyOptions}
          engineOptions={engineOptions}
          languageOptions={languageOptions}
          dynamicAxes={dynamicAxes}
          onlyGroups={composeGroups("citations", { onlyGroups, primaryGroups, extraGroups, languageOptions }).only}
          primaryGroups={
            composeGroups("citations", { onlyGroups, primaryGroups, extraGroups, languageOptions }).primary
          }
          sections={FILTER_SECTIONS}
          sticky
          asOf={data.asOf}
        />
      )}
      {/* 검색창은 필터 패널이 아니라 아래 도메인 표 헤더에 있다 — 검색이 그
          표만 거른다는 것이 위치로 드러나도록 (2026-08-06 고객 피드백). */}
      <p className="text-sm text-muted-foreground">{t("description")}</p>

      {/* (b) Summary cards — Total · Unique Domains · Categories + 카테고리 비중
          타일 2개 (공식 HMG / 딜러·마켓). 비중은 로컬 분류 기반 categories 슬라이스. */}
      <div className={cn("grid gap-3 sm:grid-cols-3", targetHitRate ? "lg:grid-cols-7" : "lg:grid-cols-5")}>
        <SummaryCard icon={Link2} label={t("summary.total")} value={data.summary.total.toLocaleString()} />
        <SummaryCard icon={Globe} label={t("summary.uniqueDomains")} value={data.summary.uniqueDomains.toLocaleString()} />
        <SummaryCard
          icon={FolderTree}
          label={t("summary.categories")}
          value={data.categories ? data.categories.length.toLocaleString() : "—"}
        />
        {data.summary.officialOwnShare !== undefined ? (
          // 공식(당사) 인용 비중 — 당사 브랜드 스코프의 owned base 판정 (KPI ⑤
          // 분자와 동일, 2026-08-05 축E 통일). 분모 0 → "—". 카테고리 파이의
          // Official (HMG) 슬라이스(전사 분류)와 정의가 다름 — 툴팁이 설명.
          <SummaryCard
            icon={ShieldCheck}
            label={t("summary.officialOwnShare")}
            value={
              data.summary.officialOwnShare == null
                ? "—"
                : `${data.summary.officialOwnShare.toFixed(1)}%`
            }
            accent={categoryColor(OFFICIAL_HMG)}
            info={{
              title: t("summary.officialOwnShare"),
              definition: t("summary.def.officialOwnShare.definition"),
              formula: t("summary.def.officialOwnShare.formula"),
            }}
          />
        ) : (
          // 폴백 — 구(officialOwnShare 이전) 캐시 엔트리: 종전 카테고리 슬라이스 타일.
          <SummaryCard
            icon={ShieldCheck}
            label={t("summary.officialShare")}
            value={formatCategoryShare(data.categories, OFFICIAL_HMG)}
            accent={categoryColor(OFFICIAL_HMG)}
          />
        )}
        <SummaryCard
          icon={Store}
          label={t("summary.dealerShare")}
          value={formatCategoryShare(data.categories, DEALER_MARKETPLACE)}
          accent={categoryColor(DEALER_MARKETPLACE)}
        />
        {/* 자사 URL·타겟 URL 인용률(웹사이트 전용) — 판정 단위가 프롬프트라 위 인용
            건수 타일들과 분모가 다르다. 타겟 쪽은 발행 인용 리포트의 동명 지표와 같은
            산식이라 화면↔리포트 대조가 된다(리포트 생성기의 `target_hit` ÷ `mp`).
            자사 쪽은 리포트에 대응 지표가 없다 — 리포트의 '오피셜 인용 답변률'은
            답변 단위다. 두 값은 **같은 분모**를 쓰므로 반드시 함께 낸다 —
            자사 ⊇ 타겟이 화면에서 읽혀야 한다. */}
        {targetHitRate ? (
          <>
            <SummaryCard
              icon={Building2}
              label={t("summary.ownedHitRate")}
              value={
                targetHitRate.ownedRate == null
                  ? "—"
                  : `${targetHitRate.ownedRate.toFixed(1)}%`
              }
              info={{
                title: t("summary.ownedHitRate"),
                definition: [t(`${hitRateDef}.ownedHitRate.definition`), hitRateSourceNote]
                  .filter(Boolean)
                  .join(" "),
                formula: t(`${hitRateDef}.ownedHitRate.formula`),
              }}
            />
            <SummaryCard
              icon={Target}
              label={t("summary.targetHitRate")}
              value={
                targetHitRate.rate == null ? "—" : `${targetHitRate.rate.toFixed(1)}%`
              }
              info={{
                title: t("summary.targetHitRate"),
                definition: [t(`${hitRateDef}.targetHitRate.definition`), hitRateSourceNote]
                  .filter(Boolean)
                  .join(" "),
                formula: t(`${hitRateDef}.targetHitRate.formula`),
              }}
            />
          </>
        ) : null}
      </div>

      {promptBuckets ? (
        <OwnedPromptSplitSection
          owned={promptBuckets.owned}
          uncited={promptBuckets.uncited}
          ownedCount={promptBuckets.ownedCount}
          uncitedCount={promptBuckets.uncitedCount}
        />
      ) : degradedSections?.split ? (
        // 일시 실패(P6 B042) — '자사 인용 없음'(섹션 숨김)과 구분해 기존 지연 안내.
        <PendingCard title={t("baseSplit.title")} label={tKpi("degraded")} />
      ) : null}

      {/* (c) Trend chart — weekly Top-10 domain citation lines. Needs ≥2 dated
          weeks (data.trend is null otherwise → 준비 중 placeholder; 일시 실패면 지연 안내). */}
      {data.trend ? (
        <CitationTrendChart title={t("trend.title")} trend={data.trend} />
      ) : (
        <PendingCard title={t("trend.title")} label={degradedSections?.trend ? tKpi("degraded") : tRoot("pending")} />
      )}

      {/* (c′) Category composition trend — weekly 100% stacked area over the
          citation-source categories (같은 ≥2주 규칙, null이면 숨김: 도메인 추이
          카드가 이미 '준비 중'을 말해주므로 중복 placeholder는 두지 않는다).
          일시 실패면 숨기지 않고 지연 안내(P6 B042). */}
      {data.categoryTrend ? (
        <CategoryCompositionTrend
          title={t("categoryTrend.title")}
          hint={t("categoryTrend.hint")}
          trend={data.categoryTrend}
          label={catLabel}
        />
      ) : degradedSections?.categoryTrend ? (
        <PendingCard title={t("categoryTrend.title")} label={tKpi("degraded")} />
      ) : null}

      {/* (d) Category donut (클릭 = ?source= 필터 토글) + 엔진별 카테고리 구성.
          분류는 lib/citation-categorizer 로컬 분류 — citations가 있으면 항상 데이터.
          도메인 순위 테이블보다 먼저 — 분류별 요약을 먼저 보고 나서 도메인 디테일로. */}
      <div className="grid gap-6 lg:grid-cols-2">
        {data.categories ? (
          <CategoryDonut
            title={t("pie.categoryTitle")}
            hint={t("pie.clickHint")}
            centerLabel={t("pie.officialCenter")}
            data={data.categories}
            activeCategories={activeCategories}
            onSliceClick={toggleCategoryFilter}
            label={catLabel}
          />
        ) : (
          <PendingCard title={t("pie.categoryTitle")} label={tRoot("pending")} />
        )}
        {data.engineCategories?.length ? (
          <EngineCategoryChart
            title={t("engineCategory.title")}
            hint={t("engineCategory.hint")}
            data={data.engineCategories}
            label={catLabel}
          />
        ) : (
          <PendingCard title={t("engineCategory.title")} label={tRoot("pending")} />
        )}
      </div>

      {/* (e) Main domains table + URL drilldown — live */}
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-semibold tracking-tight text-foreground">{t("table.title")}</h3>
            <p className="text-[11px] text-muted-foreground">{t("table.hint")}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <div className="relative w-full sm:w-56">
              <Search
                className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                id="c-search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={tFilter("domainSearchPlaceholder")}
                aria-label={tFilter("domainSearch")}
                className="h-8 pl-8 text-xs"
              />
            </div>
            {search.trim() ? (
              <span className="text-[11px] whitespace-nowrap tabular-nums text-muted-foreground">
                {tFilter("searchResultCount", {
                  matched: table.active ? (table.total ?? sorted.length) : sorted.length,
                  total: table.active ? (tableSource?.total ?? (data?.domains ?? []).length) : (data?.domains ?? []).length,
                })}
              </span>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onExport}
              disabled={sorted.length === 0 || exportTask.busy}
              aria-busy={exportTask.busy || undefined}
              className="shrink-0"
            >
              <Download className="h-3.5 w-3.5" aria-hidden />
              {tRoot("exportExcel")}
            </Button>
          </div>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/30 text-left text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
              <th className="px-3 py-2 w-12">{t("table.col.rank")}</th>
              <Th onClick={() => clickHeader("domain")}>
                {t("table.col.domain")} <SortIcon active={sortKey === "domain"} asc={asc} />
              </Th>
              <th className="px-3 py-2">{t("table.col.category")}</th>
              <Th
                onClick={() => clickHeader("citations")}
                align="right"
                info={{
                  title: t("table.col.citations"),
                  definition: t("table.colDefinition.citations"),
                  formula: t("table.colFormula.citations"),
                }}
              >
                {t("table.col.citations")} <SortIcon active={sortKey === "citations"} asc={asc} />
              </Th>
              <Th
                onClick={() => clickHeader("share")}
                align="right"
                info={{
                  title: t("table.col.share"),
                  definition: t("table.colDefinition.share"),
                  formula: t("table.colFormula.share"),
                }}
              >
                {t("table.col.share")} <SortIcon active={sortKey === "share"} asc={asc} />
              </Th>
              <Th
                onClick={() => clickHeader("prompts")}
                align="right"
                info={{
                  title: t("table.col.prompts"),
                  definition: t("table.colDefinition.prompts"),
                  formula: t("table.colFormula.prompts"),
                }}
              >
                {t("table.col.prompts")} <SortIcon active={sortKey === "prompts"} asc={asc} />
              </Th>
              <Th
                onClick={() => clickHeader("coverageRate")}
                align="right"
                info={{
                  title: t("table.col.coverage"),
                  definition: t("table.colDefinition.coverage"),
                  formula: t("table.colFormula.coverage"),
                }}
              >
                {t("table.col.coverage")} <SortIcon active={sortKey === "coverageRate"} asc={asc} />
              </Th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-sm text-muted-foreground">
                  <TableStatus table={table} empty={t("table.empty")} />
                </td>
              </tr>
            ) : (
              sorted.map((r) => (
                <DomainRow
                  key={r.domain}
                  row={r}
                  rank={r.rank}
                  detailQuery={tableSource?.query}
                  openMode={expanded?.domain === r.domain ? expanded.mode : null}
                  onToggle={(mode) =>
                    setExpanded((cur) =>
                      cur && cur.domain === r.domain && cur.mode === mode
                        ? null
                        : { domain: r.domain, mode },
                    )
                  }
                />
              ))
            )}
            {sorted.length > 0 ? <LoadMoreRow table={table} colSpan={7} /> : null}
          </tbody>
        </table>
      </div>

      <p className="rounded-md border border-dashed border-amber-400/50 bg-amber-50/50 px-4 py-3 text-xs text-amber-900 dark:bg-amber-950/20 dark:text-amber-300">
        {t("precondition")}
      </p>
    </div>
    </InfoTooltipProvider>
  );
}

function OwnedPromptSplitSection({
  owned,
  uncited,
  ownedCount,
  uncitedCount,
}: {
  owned: CitationPromptLive[];
  uncited: CitationPromptLive[];
  ownedCount: number;
  uncitedCount: number;
}) {
  const t = useTranslations("answerAnalysis.citations.baseSplit");
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-col gap-1">
        <h3 className="inline-flex items-center gap-1 text-sm font-semibold tracking-tight text-foreground">
          {t("title")}
          {/* 선정·집계 기준 명시 (2026-08-06 고객 피드백: 리스트 선정 기준과
              '인용 횟수'의 의미 불명확) */}
          <ColInfo
            title={t("title")}
            definition={t("def.definition")}
            formula={t("def.formula")}
          />
        </h3>
        <p className="text-[11px] text-muted-foreground">{t("hint")}</p>
      </div>
      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <PromptBucketCard
          title={t("ownedTitle")}
          description={t("ownedDescription")}
          prompts={owned}
          total={ownedCount}
          accentClassName="border-brand-300 bg-brand-50/40"
          countClassName="bg-brand-700 text-white"
        />
        <PromptBucketCard
          title={t("uncitedTitle")}
          description={t("uncitedDescription")}
          prompts={uncited}
          total={uncitedCount}
          accentClassName="border-amber-300 bg-amber-50/50 dark:bg-amber-950/10"
          countClassName="bg-amber-500 text-amber-950"
          emptyLabel={t("uncitedEmpty")}
        />
      </div>
    </div>
  );
}

function PromptBucketCard({
  title,
  description,
  prompts,
  total,
  accentClassName,
  countClassName,
  emptyLabel,
}: {
  title: string;
  description: string;
  prompts: CitationPromptLive[];
  total: number;
  accentClassName: string;
  countClassName: string;
  emptyLabel?: string;
}) {
  const t = useTranslations("answerAnalysis.citations.baseSplit");
  const top = prompts.slice(0, 5);
  // 클릭 시 실제 답변 본문(AnswerModal)으로 이동 — CitationPromptsDrilldown/
  // MentionsDrilldown과 동일 패턴. answers가 없으면(미러 미동기화) 클릭 비활성.
  const [selected, setSelected] = useState<CitationPromptLive | null>(null);

  return (
    <div className={cn("rounded-lg border p-3", accentClassName)}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h4 className="text-sm font-semibold text-foreground">{title}</h4>
          <p className="text-[11px] text-muted-foreground">{description}</p>
        </div>
        <span className={cn("rounded-full px-2 py-1 text-[11px] font-semibold tabular-nums", countClassName)}>
          {total.toLocaleString()}
        </span>
      </div>

      {top.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">{emptyLabel ?? t("empty")}</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {top.map((prompt) => {
            const hasAnswers = (prompt.answers?.length ?? 0) > 0;
            return (
              <li
                key={prompt.id}
                className={cn(
                  "rounded-md border border-border bg-card px-3 py-2",
                  hasAnswers && "cursor-pointer hover:bg-muted/40",
                )}
                onClick={hasAnswers ? () => setSelected(prompt) : undefined}
              >
                <p className="line-clamp-2 text-sm text-foreground">
                  {hasAnswers ? (
                    <span className="group inline-flex items-start gap-1.5 text-left">
                      <MessageSquareText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-500" aria-hidden />
                      <span className="underline-offset-2 group-hover:underline">{prompt.promptText}</span>
                    </span>
                  ) : (
                    prompt.promptText
                  )}
                </p>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                  <span>{t("citations", { count: prompt.citations })}</span>
                  <span>{t("providers", { count: prompt.providers.length })}</span>
                  {prompt.funnelStage ? (
                    <Badge variant="outline" className="h-5 text-[10px] capitalize">
                      {prompt.funnelStage}
                    </Badge>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* 리스트가 서버 캡으로 잘려 있어도 나머지 개수는 정확하도록 total 기준. */}
      {total > top.length ? (
        <p className="mt-3 text-[11px] text-muted-foreground">
          {t("more", { count: total - top.length })}
        </p>
      ) : null}

      <AnswerModal
        brand=""
        variant="citation"
        promptText={selected?.promptText ?? ""}
        answers={selected?.answers ?? []}
        open={selected !== null}
        onOpenChange={(o) => {
          if (!o) setSelected(null);
        }}
      />
    </div>
  );
}

// Weekly Top-N domain citation trend — one line per series domain over ISO
// week-starts. Replaces the "준비 중" placeholder once ≥2 dated weeks exist.
export function CitationTrendChart({ title, trend }: { title: string; trend: CitationTrend }) {
  const tRoot = useTranslations("answerAnalysis");
  const weekLabel = (v: unknown) => tRoot("weekAxis", { md: weekStartMD(String(v)) });
  // 수집 오류 주(예: 글로벌 8/25 회차 부분 수집) — 값 대신 음영 + 안내 문구를 낸다.
  // 골짜기로 찍혀 "그 주에 인용이 줄었다"로 읽히던 것이 이 오버레이의 존재 이유다.
  const gapPlan = planTrendGaps(trend.points, { xKey: "week", seriesKeys: trend.series, family: "citation" });
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4">
      <h3 className="text-sm font-semibold tracking-tight text-foreground">{title}</h3>
      <div className="h-72 min-w-0">
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 640, height: 288 }}>
          <LineChart data={gapPlan.rows} margin={{ left: -16, right: 8, top: 8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" />
            {trendGapAreas(gapPlan.areas)}
            <XAxis dataKey="week" tickFormatter={weekLabel} tick={{ fontSize: 11 }} stroke="rgba(0,0,0,0.4)" />
            <YAxis tick={{ fontSize: 11 }} stroke="rgba(0,0,0,0.4)" allowDecimals={false} />
            <RTooltip
              contentStyle={CHART_TOOLTIP_STYLE}
              labelFormatter={weekLabel}
              // 값(인용 수) 내림차순 = 그 주의 순위 순 (기본은 시리즈 등록 순).
              itemSorter={(item) => -Number(item.value ?? 0)}
              wrapperStyle={{ zIndex: 50 }}
              // 갭 슬롯은 전 시리즈 null — filterNull 기본값이면 payload 가 비어
              // content 가 마커를 못 본다. 마커를 본 GapAwareTooltip 은 **아무것도
              // 안 낸다**(2026-09-11 제품 책임자 "다른 차트에도 갭 툴팁 지워줘"). null
              // 걷어내기도 GapAwareTooltip 이 대신하므로 갭 아닌 칸은 종전 그대로다.
              filterNull={false}
              content={<GapAwareTooltip />}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            {trend.series.map((d, i) => (
              <Line
                key={d}
                type="monotone"
                dataKey={d}
                name={d}
                stroke={PIE_COLORS[i % PIE_COLORS.length]}
                strokeWidth={2}
                dot={{ r: 2.5 }}
              />
            ))}
            {/* 이웃 잇기 — 갭 슬롯 양옆 값만 실은 보조 라인. */}
            {trendGapBridgeLines(gapPlan.bridges, (key) => {
              const i = trend.series.indexOf(key);
              return i < 0 ? null : { stroke: PIE_COLORS[i % PIE_COLORS.length], strokeWidth: 2 };
            })}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function SummaryCard({
  icon: Icon,
  label,
  value,
  accent,
  info,
}: {
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  label: string;
  value: string;
  // 카테고리 비중 타일: 아이콘이 해당 카테고리의 고정 시리즈 색을 입어 도넛/뱃지와
  // 시각적으로 연결된다 (텍스트는 잉크 토큰 유지 — 색은 마크에만).
  accent?: string;
  // 지표 정의 ⓘ툴팁 — 공식(당사) 타일처럼 판정 규칙 설명이 필요한 타일에만.
  info?: { title: string; definition: string; formula?: string };
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card p-4">
      <Icon
        className={cn("h-5 w-5", !accent && "text-brand-700")}
        style={accent ? { color: accent } : undefined}
        aria-hidden
      />
      {/* mentions-view 의 SummaryCard 와 같은 규격 — min-w-0(라벨 말줄임) +
          tabular-nums(자릿수 흔들림 방지). */}
      <div className="flex min-w-0 flex-col">
        <span className="inline-flex items-center gap-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
          {label}
          {info ? <ColInfo {...info} /> : null}
        </span>
        <span className="font-head text-xl font-semibold tracking-tight tabular-nums text-foreground">
          {value}
        </span>
      </div>
    </div>
  );
}

// 카테고리 비중 (전체 인용 대비 %). 활성 sourceCategory 필터가 있으면 "필터된
// 집합 내 비중"이 된다 — 타일이 도넛과 항상 같은 데이터를 말하도록 의도된 동작.
function formatCategoryShare(
  categories: CitationCategorySlice[] | null,
  name: string,
): string {
  if (!categories?.length) return "—";
  const total = categories.reduce((s, c) => s + c.value, 0);
  if (!total) return "—";
  const v = categories.find((c) => c.name === name)?.value ?? 0;
  return `${((100 * v) / total).toFixed(1)}%`;
}

export function Th({
  children,
  onClick,
  align,
  info,
}: {
  children: React.ReactNode;
  onClick: () => void;
  align?: "right";
  // 컬럼 정의 — hover 시 아이콘으로 노출(정렬 버튼과 별도 요소라 클릭이 섞이지 않음).
  info?: { title: string; definition: string; formula: string };
}) {
  return (
    <th className="px-3 py-2">
      <div className={cn("inline-flex items-center gap-1", align === "right" && "flex w-full justify-end")}>
        <button
          type="button"
          onClick={onClick}
          className="inline-flex items-center gap-1.5 text-left hover:text-foreground"
        >
          {children}
        </button>
        {info ? <ColInfo {...info} /> : null}
      </div>
    </th>
  );
}

export function SortIcon({ active, asc }: { active: boolean; asc: boolean }) {
  if (!active) return <ArrowUpDown className="h-3 w-3 opacity-40" aria-hidden />;
  return asc ? <ArrowUp className="h-3 w-3" aria-hidden /> : <ArrowDown className="h-3 w-3" aria-hidden />;
}

export function DomainRow({
  row,
  rank,
  openMode,
  onToggle,
  drilldownTabs = false,
  hidePromptsCell = false,
  detailQuery,
}: {
  row: CitationDomainLive;
  rank: number;
  /**
   * API 원천 행(skey)의 드릴다운 조건(unit U7, 3.5 #6). 있으면 펼칠 때 상세를 한 번 읽는다.
   * 새 백엔드 목록에는 urls·promptList 가 없다. legacy 행은 종전 인라인 목록 그대로.
   */
  detailQuery?: string;
  openMode: "urls" | "prompts" | null;
  onToggle: (mode: "urls" | "prompts") => void;
  /** 피그마 571:380 표에는 프롬프트 열이 없다(드릴다운 탭이 대신) — 표준 화면만 true. */
  hidePromptsCell?: boolean;
  /**
   * 드릴다운을 "인용 URL(개수) | 프롬프트" 탭 하나로 합친다(디자인 571:380 주석
   * "인용 URL/프롬프트 탭으로 분리 · 기본값: 인용 URL", 2026-09-02). 표준 인용
   * 화면만 켠다 — website/project 는 종전 두 갈래 드릴다운 그대로.
   */
  drilldownTabs?: boolean;
}) {
  const t = useTranslations("answerAnalysis.citations");
  const tCat = useTranslations("citationCategories");
  const locale = useLocale();
  const lazy = Boolean(row.skey && detailQuery !== undefined);
  const detail = useDomainDetail(lazy ? domainDetailUrl(detailQuery!, row.skey!) : null, openMode !== null);
  const loaded = detail?.status === "ready" ? detail : null;
  const urls = lazy ? (loaded?.urls ?? []) : (row.urls ?? []);
  const promptList = lazy ? (loaded?.promptList ?? []) : (row.promptList ?? []);
  // API 행은 펼치기 전 프롬프트 목록을 모른다: 프롬프트 수(citing_prompts)가 있으면 연다.
  const promptsClickable = lazy ? row.prompts > 0 : promptList.length > 0;
  const pending =
    lazy && detail?.status !== "ready" ? (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        {detail?.status === "error" ? (
          t("drilldown.loadFailed")
        ) : (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            {t("drilldown.loading")}
          </>
        )}
      </p>
    ) : null;
  const categorySlug = row.category ? citationCategorySlug(row.category) : null;
  // "리스트가 비었다"의 의미가 행마다 다르다(상위 N / 공식 꼬리 = URL만 /
  // 미제공). 분기 정본은 _data/citation-view.ts 한 곳 — 렌더 지점이 3곳이라
  // 복붙하면 한 곳만 어긋난다.
  const noUrlsKey = citationDrilldownEmptyKey(row, "urls");
  const noPromptsKey = citationDrilldownEmptyKey(row, "prompts");
  return (
    <>
      {/* Row click → URL list. The 프롬프트 count cell → prompt-list drilldown.
          Owned (HMG) domains get a subtle row tint + badge so 자사 출처가 한눈에. */}
      <tr
        className={cn(
          "cursor-pointer border-t border-border first:border-t-0 hover:bg-muted/40",
          row.isOurs && "bg-brand-50/50",
        )}
        onClick={() => onToggle("urls")}
      >
        <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">{rank}</td>
        <td className="px-3 py-2.5 font-medium text-foreground">
          <span className="inline-flex items-center gap-1.5">
            {row.domain}
            {row.isOurs ? (
              <span className="inline-flex items-center rounded bg-brand-700 px-1 py-0.5 text-[9px] font-bold tracking-wide text-white">
                HMG
              </span>
            ) : null}
          </span>
        </td>
        <td className="px-3 py-2.5">
          {row.category ? (
            drilldownTabs ? (
              // 피그마 571:380: 카테고리 색 15% 틴트 pill(20px, 10px medium) — 텍스트는 잉크.
              <span
                className="inline-flex h-5 items-center rounded-full px-2.5 text-[10px] font-medium text-foreground"
                style={{ background: `${categoryColor(row.category)}26` }}
              >
                {categorySlug ? tCat(categorySlug) : row.category}
              </span>
            ) : (
              <Badge variant="outline" className="gap-1.5 text-[10px] font-normal">
                {/* 시리즈 색 점 — 도넛/트렌드와 같은 고정 카테고리 색 (텍스트는 잉크). */}
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: categoryColor(row.category) }}
                  aria-hidden
                />
                {categorySlug ? tCat(categorySlug) : row.category}
              </Badge>
            )
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          )}
        </td>
        <td className="px-3 py-2.5 text-right tabular-nums text-foreground">{row.citations.toLocaleString()}</td>
        <td className="px-3 py-2.5 text-right tabular-nums text-foreground">{row.share.toFixed(1)}%</td>
        {hidePromptsCell ? null : (
        <td className="px-3 py-2.5 text-right tabular-nums">
          {promptsClickable ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggle("prompts");
              }}
              aria-expanded={openMode === "prompts"}
              className={cn(
                "inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium underline-offset-2 hover:underline",
                openMode === "prompts" ? "text-brand-700" : "text-foreground",
              )}
            >
              <MessageSquareText className="h-3.5 w-3.5 text-brand-500" aria-hidden />
              {row.prompts.toLocaleString()}
            </button>
          ) : (
            <span className="text-foreground">{row.prompts.toLocaleString()}</span>
          )}
        </td>
        )}
        <td className="px-3 py-2.5 text-right tabular-nums text-foreground">{row.coverageRate.toFixed(1)}%</td>
      </tr>

      {openMode === "urls" && drilldownTabs ? (
        <tr className="border-t border-border bg-muted/20">
          <td colSpan={hidePromptsCell ? 6 : 7} className="px-4 py-4">
            <Tabs defaultValue="urls">
              <TabsList>
                <TabsTrigger value="urls">{t("v2.drilldownTabs.urls", { n: urls.length })}</TabsTrigger>
                <TabsTrigger value="prompts">{t("v2.drilldownTabs.prompts")}</TabsTrigger>
              </TabsList>
              <TabsContent value="urls">
                {pending ? (
                  pending
                ) : urls.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t(noUrlsKey)}</p>
                ) : (
                  <>
                    <UrlList urls={urls} />
                    <TruncatedNote shown={urls.length} total={loaded?.urlTotal} className={DRILLDOWN_TRUNCATED_CLASS} />
                  </>
                )}
              </TabsContent>
              <TabsContent value="prompts">
                {pending ?? (
                  <CitationPromptsDrilldown
                    prompts={promptList}
                    domain={row.domain}
                    totalCitations={row.citations}
                    emptyKey={noPromptsKey}
                    total={loaded?.promptTotal}
                  />
                )}
              </TabsContent>
            </Tabs>
          </td>
        </tr>
      ) : null}

      {openMode === "urls" && !drilldownTabs ? (
        <tr className="border-t border-border bg-muted/20">
          <td colSpan={7} className="px-4 py-4">
            {pending ? (
              pending
            ) : urls.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t(noUrlsKey)}</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {urls.map((u) => (
                  <li key={u.url} className="flex flex-col gap-1 rounded border border-border bg-card px-3 py-2">
                    <div className="flex items-start justify-between gap-3">
                      <span className="min-w-0 line-clamp-2 text-sm font-medium text-foreground">{u.title}</span>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {u.country ? (
                          <span
                            className="inline-flex items-center gap-1 rounded bg-brand-50 px-1.5 py-0.5 text-[10px] font-medium text-brand-700"
                            title={t("siteCountry")}
                          >
                            <Globe className="h-2.5 w-2.5" aria-hidden />
                            {countryName(u.country, locale)}
                          </span>
                        ) : null}
                        <span className="rounded bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                          {u.aiProvider}
                        </span>
                      </div>
                    </div>
                    <a
                      href={u.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-start gap-1 text-[11px] text-brand-700 hover:underline"
                    >
                      {/* break-all so long query-string URLs wrap instead of
                          overflowing the card; icon stays pinned, never shrinks.
                          displayCitationUrl drops scheme + #:~:text= fragment from
                          the label; href above keeps the full deep-link. */}
                      <span className="min-w-0 break-all">{displayCitationUrl(u.url)}</span>
                      <ExternalLink className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                    </a>
                    {u.promptText ? (
                      <p className="text-[11px] text-muted-foreground">
                        &ldquo;{u.promptText}&rdquo; · {u.count.toLocaleString()} {t("drilldown.cites")}
                      </p>
                    ) : (
                      <p className="text-[11px] text-muted-foreground">{u.count.toLocaleString()} {t("drilldown.cites")}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {!pending && urls.length > 0 ? (
              <TruncatedNote shown={urls.length} total={loaded?.urlTotal} className={DRILLDOWN_TRUNCATED_CLASS} />
            ) : null}
          </td>
        </tr>
      ) : null}

      {openMode === "prompts" ? (
        <tr className="border-t border-border bg-muted/20">
          <td colSpan={7} className="px-4 py-4">
            {pending ?? (
              <CitationPromptsDrilldown prompts={promptList} domain={row.domain} emptyKey={noPromptsKey} total={loaded?.promptTotal} />
            )}
          </td>
        </tr>
      ) : null}
    </>
  );
}

/** URL 목록 아래 절단 고지 한 줄(P6 B047, 언급 드릴다운 citation-domain-table 과 같은 모양). */
const DRILLDOWN_TRUNCATED_CLASS = "mt-2 text-[11px] text-muted-foreground";

/** 도메인 드릴다운의 URL 목록 — 두 드릴다운 형태(종전 인라인 / 탭)가 같은 마크업을 쓴다. */
function UrlList({ urls }: { urls: CitationDomainLive["urls"] }) {
  const t = useTranslations("answerAnalysis.citations");
  const locale = useLocale();
  return (
              <ul className="flex flex-col gap-2">
                {urls.map((u) => (
                  <li key={u.url} className="flex flex-col gap-1 rounded border border-border bg-card px-3 py-2">
                    <div className="flex items-start justify-between gap-3">
                      <span className="min-w-0 line-clamp-2 text-sm font-medium text-foreground">{u.title}</span>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {u.country ? (
                          <span
                            className="inline-flex items-center gap-1 rounded bg-brand-50 px-1.5 py-0.5 text-[10px] font-medium text-brand-700"
                            title={t("siteCountry")}
                          >
                            <Globe className="h-2.5 w-2.5" aria-hidden />
                            {countryName(u.country, locale)}
                          </span>
                        ) : null}
                        <span className="rounded bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                          {u.aiProvider}
                        </span>
                      </div>
                    </div>
                    <a
                      href={u.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-start gap-1 text-[11px] text-brand-700 hover:underline"
                    >
                      {/* break-all so long query-string URLs wrap instead of
                          overflowing the card; icon stays pinned, never shrinks.
                          displayCitationUrl drops scheme + #:~:text= fragment from
                          the label; href above keeps the full deep-link. */}
                      <span className="min-w-0 break-all">{displayCitationUrl(u.url)}</span>
                      <ExternalLink className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                    </a>
                    {u.promptText ? (
                      <p className="text-[11px] text-muted-foreground">
                        &ldquo;{u.promptText}&rdquo; · {u.count.toLocaleString()} {t("drilldown.cites")}
                      </p>
                    ) : (
                      <p className="text-[11px] text-muted-foreground">{u.count.toLocaleString()} {t("drilldown.cites")}</p>
                    )}
                  </li>
                ))}
              </ul>
  );
}

// Prompt-list drilldown for one domain — the prompts whose answers cited it.
// Clicking a prompt opens the real AnswerModal (the same chat-transcript view the
// mention tab uses), so the path is domain → prompt → actual answer.
function CitationPromptsDrilldown({
  prompts,
  domain,
  totalCitations,
  emptyKey = "drilldown.noPrompts",
  total,
}: {
  prompts: CitationPromptLive[];
  domain: string;
  /** 점유율 분모 — 이 도메인의 전체 인용 수(표준 화면 탭 드릴다운, 피그마 571:380 주석). */
  totalCitations?: number;
  /** 빈 목록 문구 키 — 호출부가 행 상태로 결정한다(citationDrilldownEmptyKey). */
  emptyKey?: CitationDrilldownEmptyKey;
  /** 상세 상한(12) 전 프롬프트 수 — 상한이 목록을 잘랐을 때만(P6 B047). */
  total?: number;
}) {
  const t = useTranslations("answerAnalysis.citations");
  const tMd = useTranslations("answerAnalysis.mentions.drilldown");
  const [selected, setSelected] = useState<CitationPromptLive | null>(null);
  const [sort, setSort] = useState<{ key: "prompt" | "citations" | "share"; asc: boolean }>({ key: "citations", asc: false });

  if (prompts.length === 0) {
    return <p className="text-xs text-muted-foreground">{t(emptyKey)}</p>;
  }
  const withShare = totalCitations != null && totalCitations > 0;
  const share = (p: CitationPromptLive) => (withShare ? (100 * p.citations) / totalCitations : null);
  const ranked = [...prompts].sort((a, b) => {
    const dir = sort.asc ? 1 : -1;
    if (sort.key === "prompt") return dir * a.promptText.localeCompare(b.promptText);
    return dir * (a.citations - b.citations);
  });
  const clickSort = (key: "prompt" | "citations" | "share") =>
    setSort((cur) => (cur.key === key ? { key, asc: !cur.asc } : { key, asc: key === "prompt" }));

  return (
    <div className="flex flex-col gap-2">
      {withShare ? (
        <p className="text-[11px] text-muted-foreground">{t("v2.drilldownTabs.promptsCaption")}</p>
      ) : null}
      <div className="overflow-hidden rounded-md border border-border bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/30 text-left text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
              <th className="px-3 py-2">
                <button type="button" onClick={() => clickSort("prompt")} className="inline-flex items-center gap-1 hover:text-foreground">
                  {tMd("col.prompt")} <SortIcon active={sort.key === "prompt"} asc={sort.asc} />
                </button>
              </th>
              <th className="px-3 py-2 w-20 text-right">
                <button type="button" onClick={() => clickSort("citations")} className="inline-flex items-center gap-1 hover:text-foreground">
                  {t("table.col.citations")} <SortIcon active={sort.key === "citations"} asc={sort.asc} />
                </button>
              </th>
              {withShare ? (
                <th className="px-3 py-2 w-20 text-right">
                  <button type="button" onClick={() => clickSort("share")} className="inline-flex items-center gap-1 hover:text-foreground">
                    {t("table.col.share")} <SortIcon active={sort.key === "share"} asc={sort.asc} />
                  </button>
                </th>
              ) : null}
              <th className="px-3 py-2 w-24">{tMd("col.funnel")}</th>
              <th className="px-3 py-2 w-28 text-right">{tMd("col.providers")}</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((p) => {
              const hasAnswers = (p.answers?.length ?? 0) > 0;
              return (
                <tr
                  key={p.id}
                  className={cn(
                    "border-t border-border first:border-t-0",
                    hasAnswers && "cursor-pointer hover:bg-muted/40",
                  )}
                  onClick={hasAnswers ? () => setSelected(p) : undefined}
                >
                  <td className="px-3 py-2 text-foreground">
                    {hasAnswers ? (
                      <span className="group inline-flex items-start gap-1.5 text-left">
                        <MessageSquareText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-500" aria-hidden />
                        <span className="underline-offset-2 group-hover:underline">{p.promptText}</span>
                      </span>
                    ) : (
                      p.promptText
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-foreground">{p.citations.toLocaleString()}</td>
                  {withShare ? (
                    <td className="px-3 py-2 text-right tabular-nums text-foreground">{`${(share(p) ?? 0).toFixed(1)}%`}</td>
                  ) : null}
                  <td className="px-3 py-2">
                    {p.funnelStage ? (
                      <Badge variant="outline" className="text-[10px] capitalize">{p.funnelStage}</Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right text-[10px] text-muted-foreground">
                    {p.providers.join(", ") || "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <TruncatedNote shown={prompts.length} total={total} className={TRUNCATED_ROW_CLASS} />
      </div>

      <AnswerModal
        brand={domain}
        variant="citation"
        promptText={selected?.promptText ?? ""}
        answers={selected?.answers ?? []}
        open={selected !== null}
        onOpenChange={(o) => {
          if (!o) setSelected(null);
        }}
      />
    </div>
  );
}

// Category donut — 고정 카테고리 색, 슬라이스 클릭 = ?source= 필터 토글 (활성
// 필터가 있으면 비활성 슬라이스는 흐려진다). 중앙 스탯은 Official (HMG) 비중.
export function CategoryDonut({
  title,
  hint,
  centerLabel,
  data,
  total: totalOverride,
  activeCategories,
  onSliceClick,
  label,
  variant = "default",
}: {
  title: string;
  hint?: string;
  centerLabel: string;
  data: CitationCategorySlice[];
  /**
   * 중앙 비중의 분모. 생략 = `data` 합. 글로벌 인용 탭은 경쟁사 선택 중에도 **전체 인용 수**를
   * 넘겨 중앙 공식(HMG) 비중이 인용 현황 카드·Overview ⑤ 와 같게 유지한다(제품 책임자 2026-09-29).
   */
  total?: number;
  activeCategories: string[];
  onSliceClick: (name: string) => void;
  label: (name: string) => string;
  /**
   * `standard` = 피그마 571:380 도넛: 아이콘·범례·힌트 없음(범례는 좌측 막대 목록이 대신),
   * 중앙은 라벨 → 값 순서(12px / 20px semibold). website/project 는 기본형 그대로.
   */
  variant?: "default" | "standard";
}) {
  const standard = variant === "standard";
  const chartData = data.map((d) => ({ ...d, label: label(d.name) }));
  const total = totalOverride ?? data.reduce((s, c) => s + c.value, 0);
  const official = data.find((c) => c.name === OFFICIAL_HMG)?.value ?? 0;
  // 인용 현황 카드(categoryShare)와 같은 반올림 — toFixed(1) 은 x.x5 경계에서 0.1 갈린다(247/2000: 12.3 대 12.4)
  const officialPct = total > 0 ? (Math.round(((100 * official) / total) * 10) / 10).toFixed(1) : null;
  const dimmed = (name: string) =>
    activeCategories.length > 0 && !activeCategories.includes(name);
  return (
    // QA 2차 #6 — standard(571:380 "인용 비중") 카드는 좌측 "출처 카테고리별 인용 수"
    // 카드와 grid stretch 로 같은 높이를 받으므로, h-full + justify-center 로 도넛을
    // 키운 만큼 세로 중앙에 채운다. default(website/project)는 그대로 상단 정렬.
    <div className={cn("flex flex-col gap-2 rounded-lg border border-border bg-card p-4", standard && "h-full justify-center")}>
      <div className="flex items-center gap-2">
        {standard ? null : <FolderTree className="h-4 w-4 text-muted-foreground" aria-hidden />}
        <h3 className={standard ? "text-[15px] font-medium text-ink-700" : "text-sm font-semibold tracking-tight text-foreground"}>{title}</h3>
      </div>
      {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
      {/* 도넛 영역과 범례를 분리한다 — recharts <Legend> 를 차트 안에 두면
          범례 줄 수만큼 플롯 영역이 줄어 도넛이 위로 밀리고, 중앙 스탯이
          어긋난다. 범례를 HTML 로 빼면 차트 높이가 고정돼 중앙 정렬이 항상
          정확하다 (2026-09-05). standard 는 범례가 없으므로 도넛 영역을
          h-56→h-72·outerRadius 86→104 로 키운다(QA 2차 #6, 3차 범례 제거). */}
      <div className={cn("relative min-w-0", standard ? "h-72" : "h-56")}>
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 360, height: standard ? 288 : 224 }}>
          <PieChart>
            <Pie
              data={chartData}
              dataKey="value"
              nameKey="label"
              cx="50%"
              cy="50%"
              innerRadius={standard ? 68 : 56}
              outerRadius={standard ? 104 : 86}
              paddingAngle={1}
              onClick={(_, idx) => onSliceClick(chartData[idx].name)}
              className="cursor-pointer"
            >
              {chartData.map((d) => (
                <Cell
                  key={d.name}
                  fill={categoryColor(d.name)}
                  fillOpacity={dimmed(d.name) ? 0.3 : 1}
                  stroke="var(--card, #ffffff)"
                  strokeWidth={2}
                />
              ))}
            </Pie>
            <RTooltip
              contentStyle={CHART_TOOLTIP_STYLE} itemSorter={(item) => -Number(item.value ?? 0)} wrapperStyle={{ zIndex: 50 }}
              formatter={(v) => (typeof v === "number" ? v.toLocaleString() : String(v ?? ""))}
            />
          </PieChart>
        </ResponsiveContainer>
        {officialPct !== null ? (
          // 중앙 스탯 — 도넛 구멍 정중앙(차트 영역에 범례가 없으므로 컨테이너
          // 중앙 = cy). Official (HMG) 인용 비중.
          standard ? (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-xs text-muted-foreground">{centerLabel}</span>
              <span className="text-xl font-semibold tracking-tight text-foreground tabular-nums">{officialPct}%</span>
            </div>
          ) : (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="font-head text-lg font-semibold tracking-tight tabular-nums text-foreground">
              {officialPct}%
            </span>
            <span className="text-[10px] text-muted-foreground">{centerLabel}</span>
          </div>
          )
        ) : null}
      </div>
      {/* HTML 범례 — 슬라이스와 같은 고정 카테고리 색, 클릭 = 슬라이스 클릭과
          동일한 필터 토글. standard 는 범례를 **아예 두지 않는다**(2026-09-09 제품 책임자:
          14개 항목이 도넛보다 커 보여 제거) — 카테고리는 좌측 표가 이미 보여준다. */}
      {standard ? null : (
        <ul className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 px-2">
          {chartData.map((d) => (
            <li key={d.name}>
              <button
                type="button"
                onClick={() => onSliceClick(d.name)}
                className={cn(
                  "inline-flex w-full items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground",
                  dimmed(d.name) && "opacity-40",
                )}
              >
                <span className="h-2.5 w-2.5 shrink-0 rounded-[2px]" style={{ backgroundColor: categoryColor(d.name) }} aria-hidden />
                <span>{d.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// 주간 카테고리 구성 추이 — 100% stacked area (stackOffset="expand"). 시리즈
// 색은 도넛/뱃지와 같은 고정 카테고리 색. 누락 주차 키는 0으로 채워 스택 유지.
export function CategoryCompositionTrend({
  title,
  hint,
  trend,
  label,
  hideLegend = false,
  absolute = false,
  variant = "default",
}: {
  title: string;
  hint?: string;
  trend: CitationTrend;
  label: (name: string) => string;
  /** 표준 화면은 섹션 하단 공용 범례를 쓰므로 차트 자체 범례를 끈다(피그마 571:380). */
  hideLegend?: boolean;
  /** 카테고리 1개만 활성일 때 100% 스택 대신 절대값(인용 수)으로(구성비 100% 한 덩어리 방지). */
  absolute?: boolean;
  variant?: "default" | "standard";
}) {
  const tRoot = useTranslations("answerAnalysis");
  const weekLabel = (v: unknown) => tRoot("weekAxis", { md: weekStartMD(String(v)) });
  const zeroFilled = useMemo(
    () =>
      trend.points.map((p) => ({
        ...Object.fromEntries(trend.series.map((s) => [s, 0])),
        ...p,
      })),
    [trend],
  );
  // 수집 오류 주(예: 글로벌 8/25 회차 부분 수집) — 값 대신 음영 + 안내 문구를 낸다.
  // 라인 차트와 다른 점은 **이웃 연결**이다: 여기서 한 카테고리는 선이 아니라 연속한
  // 두 누적 경계 사이의 띠이므로, 갭 창도 닫힌 밴드로 채워야 이어져 보인다.
  // 경계 값은 recharts 의 스택 계산을 그대로 재현한다(lib/viz/trend-gap-stack.ts 헤더).
  const gapPlan = useMemo(() => {
    const stack = trendStackBoundaryRows(zeroFilled, {
      xKey: "week",
      seriesKeys: trend.series,
      normalize: !absolute,
    });
    return { ...planTrendGaps(stack.rows, { xKey: "week", seriesKeys: stack.boundaryKeys }), stack };
  }, [zeroFilled, trend.series, absolute]);
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4">
      <h3 className={variant === "standard" ? "text-[15px] font-medium text-ink-700" : "text-sm font-semibold tracking-tight text-foreground"}>{title}</h3>
      {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
      <div className="h-72 min-w-0">
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 640, height: 288 }}>
          <AreaChart data={zeroFilled} stackOffset={absolute ? "none" : "expand"} margin={{ left: -16, right: 8, top: 8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" />
            {trendGapAreas(gapPlan.areas)}
            <XAxis dataKey="week" tickFormatter={weekLabel} tick={{ fontSize: 11 }} stroke="rgba(0,0,0,0.4)" />
            <YAxis
              tick={{ fontSize: 11 }}
              stroke="rgba(0,0,0,0.4)"
              tickFormatter={(v) => (absolute ? Number(v).toLocaleString() : `${Math.round(Number(v) * 100)}%`)}
            />
            {/* stackOffset=expand여도 recharts 툴팁 값은 원본 count — 그대로 표기 */}
            <RTooltip
              contentStyle={CHART_TOOLTIP_STYLE} labelFormatter={weekLabel} itemSorter={(item) => -Number(item.value ?? 0)} wrapperStyle={{ zIndex: 50 }}
              formatter={(v) => (typeof v === "number" ? v.toLocaleString() : String(v ?? ""))}
              // 갭 슬롯은 전 시리즈 null — filterNull 기본값이면 payload 가 비어
              // content 가 마커를 못 본다. 마커를 본 GapAwareTooltip 은 **아무것도
              // 안 낸다**(2026-09-11 제품 책임자 "다른 차트에도 갭 툴팁 지워줘"). null
              // 걷어내기도 GapAwareTooltip 이 대신하므로 갭 아닌 칸은 종전 그대로다.
              filterNull={false}
              content={<GapAwareTooltip />}
            />
            {hideLegend ? null : <Legend wrapperStyle={{ fontSize: 11 }} />}
            {trend.series.map((s) => (
              <Area
                key={s}
                type="monotone"
                dataKey={s}
                name={label(s)}
                stackId="1"
                stroke={categoryColor(s)}
                strokeWidth={1}
                fill={categoryColor(s)}
                fillOpacity={0.85}
                dot={{ r: 2.5 }}
              />
            ))}
            {/* 이웃 잇기 — 갭 창을 카테고리 색으로 채운 닫힌 밴드(본 영역과 같은 층·같은
                투명도). 갭 슬롯에는 값을 만들지 않으므로 점·범례·툴팁 항목은 안 늘어난다. */}
            {trendGapStackBands(
              gapPlan.bridges,
              gapPlan.stack.boundaryKeys,
              (i) => {
                const s = trend.series[i];
                return s === undefined
                  ? null
                  : { fill: categoryColor(s), fillOpacity: 0.85, stroke: categoryColor(s), strokeWidth: 1 };
              },
              // 밴드가 넘어설 수 없는 데이터 범위 — 누적 값은 음수가 없고(0), 100% 정규화
              // 모드에서는 맨 위 경계가 1 을 넘을 수 없다. absolute 모드에는 상한이 없다.
              { min: 0, max: absolute ? undefined : 1 },
            )}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// 엔진별 출처 카테고리 구성 — 엔진당 한 줄의 100% 가로 스택 바. "어떤 엔진이
// 어떤 유형의 출처를 인용하는가"를 한눈에 (GEO 콘텐츠 전략 축).
export function EngineCategoryChart({
  title,
  hint,
  data,
  label,
  absolute = false,
  variant = "default",
}: {
  title: string;
  hint?: string;
  data: EngineCategorySlice[];
  label: (name: string) => string;
  /** 카테고리 1개만 활성일 때 100% 스택 대신 절대값(인용 수). */
  absolute?: boolean;
  variant?: "default" | "standard";
}) {
  // byCategory 유니온 → 전체 합 내림차순 시리즈 (색·범례 순서 고정 기준).
  const series = useMemo(() => {
    const totals = new Map<string, number>();
    for (const e of data) {
      for (const [c, v] of Object.entries(e.byCategory)) {
        totals.set(c, (totals.get(c) ?? 0) + v);
      }
    }
    return [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  }, [data]);
  const rows = useMemo(
    () =>
      data.map((e) => ({
        engine: e.engine,
        ...Object.fromEntries(series.map((s) => [s, e.byCategory[s] ?? 0])),
      })),
    [data, series],
  );
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4">
      <h3 className={variant === "standard" ? "text-[15px] font-medium text-ink-700" : "text-sm font-semibold tracking-tight text-foreground"}>{title}</h3>
      {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
      <div className="h-72 min-w-0">
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 360, height: 288 }}>
          <BarChart data={rows} layout="vertical" stackOffset={absolute ? "none" : "expand"} margin={{ left: 8, right: 8, top: 8, bottom: 0 }} barSize={26}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" horizontal={false} />
            <XAxis
              type="number"
              tick={{ fontSize: 11 }}
              stroke="rgba(0,0,0,0.4)"
              tickFormatter={(v) => (absolute ? Number(v).toLocaleString() : `${Math.round(Number(v) * 100)}%`)}
            />
            <YAxis type="category" dataKey="engine" width={72} tick={{ fontSize: 11 }} stroke="rgba(0,0,0,0.4)" />
            <RTooltip
              contentStyle={CHART_TOOLTIP_STYLE} itemSorter={(item) => -Number(item.value ?? 0)} wrapperStyle={{ zIndex: 50 }}
              formatter={(v) => (typeof v === "number" ? v.toLocaleString() : String(v ?? ""))}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            {series.map((s) => (
              <Bar
                key={s}
                dataKey={s}
                name={label(s)}
                stackId="1"
                fill={categoryColor(s)}
                stroke="var(--card, #ffffff)"
                strokeWidth={1}
                radius={PILL_BAR_RADIUS}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
