"use client";

// 브랜드 언급 순위 표 — mentions-view.tsx 에서 추출(2026-09-02). 검색(useDeferredValue
// INP 패턴)·정렬·고정 순번·Excel 내보내기·행 클릭 드릴다운은 종전 그대로다.
// website/project mention 화면은 이 컴포넌트를 기본 옵션으로 쓰므로 마크업이 바뀌지
// 않고, 표준 공통 하단(디자인 327:116)만 아래 두 옵션을 켠다:
//   · multiToggle — "브랜드 복수 언급": 한 답변 안에서 2회 이상 언급된 답변 기준으로
//     언급 수·프롬프트·언급률·점유율을 전환(값은 서버 집계의 multi 필드)
//   · showRank   — 드릴다운 프롬프트 표에 순위 열 + "언급 TOP 3 이내" 배지
//   · limit      — 상위 N 행(디자인 "상위 100")
//
// 세 표면 공통(종전 표면별 차이 없음):
//   · total      — 전량 목록이 서버 상한(10,000)에서 잘렸을 때만 잘리기 전 브랜드 수(B039).
//                  표 아래에 기존 "{total}개 중 {shown}개 표시" 한 줄(TruncatedNote). 안 잘렸으면
//                  마크업은 종전 그대로다.
//   · Excel      — 생성 실패는 기존 exportFailed 토스트로 알리고, 생성 중에는 버튼을 막는다(B040,
//                  standard/prompts prompt-list-readonly.tsx 의 내보내기와 같은 패턴).

import { useDeferredValue, useMemo, useRef, useState, type ReactNode } from "react";
import { useOrderedTable } from "@/hooks/use-ordered-table";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, ArrowUpDown, Download, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ColInfo } from "@/components/dash/col-info";
import { dateStamp } from "@/lib/export/csv";
import { downloadXlsx } from "@/lib/export/xlsx";
import { cn } from "@/lib/utils";
import type { MentionsBrandLive, MentionsPromptLive } from "@/lib/scope/result-adapter";
import type { BrandRowValues, BrandSortKey, BrandTableView } from "../_data/mention-screen";
import { TRUNCATED_ROW_CLASS, TruncatedNote } from "./citation-domain-table";
import { MentionsDrilldown } from "./mentions-drilldown";

/**
 * The own-row target of the brand drilldown (unit U6, BG-17): an own row drills by "own" (the
 * perspective brands), and a row of a split perspective (D13) by its brand code. The API source
 * puts that code on the row as `ownBrandCode` (lib/hgh/adapters/mentions.ts); legacy rows have
 * none and their route ignores the flag (drilldown by name, as before).
 */
function ownTargetOf(row: MentionsBrandLive): { code: string | null } | null {
  if (!row.isTracked) return null;
  const code = (row as MentionsBrandLive & { ownBrandCode?: unknown }).ownBrandCode;
  return { code: typeof code === "string" && code ? code : null };
}

type SortKey = BrandSortKey;

const ASC_BY_DEFAULT: SortKey[] = ["brand"];

export function BrandRankTable({
  brands,
  table,
  perBrandPrompts,
  isWebsite = false,
  lazyPrompts = false,
  multiToggle = false,
  showRank = false,
  limit,
  initialMulti = false,
  total,
}: {
  brands: MentionsBrandLive[];
  /** 행별 값(일반·복수 언급)·기본 순번·열별 정렬 순서 — 화면이 계산해 보낸다(`brands` 와 같은 순서). */
  table: BrandTableView;
  perBrandPrompts: Record<string, MentionsPromptLive[]>;
  isWebsite?: boolean;
  lazyPrompts?: boolean;
  multiToggle?: boolean;
  showRank?: boolean;
  limit?: number;
  /** 렌더 테스트 seam — 토글 초기값. 화면 기본은 꺼짐. */
  initialMulti?: boolean;
  /** 서버 상한에서 잘린 전량 목록의 잘리기 전 브랜드 수(B039). 안 잘렸으면 미전달. */
  total?: number;
}) {
  const t = useTranslations("answerAnalysis.mentions");
  const tRoot = useTranslations("answerAnalysis");
  const tFilter = useTranslations("answerAnalysis.filters");
  // 내보내기 실패 문구는 글로벌 프롬프트 화면의 기존 문구를 그대로 쓴다(새 문자열 없음).
  const tExport = useTranslations("standardPromptsView");

  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [multi, setMulti] = useState(multiToggle && initialMulti);

  // 행과 화면 값(순번·일반·복수 언급 값)을 짝지어 둔다 — 정렬 순서는 이 배열의 인덱스다.
  const items = useMemo(() => brands.map((row, i) => ({ row, view: table.rows[i] })), [brands, table]);
  const { sorted: ordered, sortKey, asc, toggleSort } = useOrderedTable(items, table.orders, {
    defaultKey: "mentions",
    ascByDefault: ASC_BY_DEFAULT,
  });

  // 검색은 이미 정렬된 목록 위의 표시 필터(입력 문자열)이고, 상한은 그 앞부분만 보여 준다.
  const sorted = useMemo(() => {
    const q = deferredSearch.trim().toLowerCase();
    const arr = q ? ordered.filter((it) => it.row.brand.toLowerCase().includes(q)) : ordered;
    return limit != null ? arr.slice(0, limit) : arr;
  }, [ordered, deferredSearch, limit]);

  function clickHeader(k: SortKey) {
    toggleSort(k);
  }

  const [exporting, setExporting] = useState(false);
  const exportingRef = useRef(false);

  // Export the real (server-filtered, sorted) brand rows.
  async function onExport() {
    if (exportingRef.current) return;
    exportingRef.current = true;
    setExporting(true);
    const fmt = (n: number | null, digits = 0) => (n == null ? "" : digits ? n.toFixed(digits) : n);
    try {
      await downloadXlsx(
        `brand-mentions-${dateStamp()}`,
        [
          t("table.col.brand"),
          t("table.col.mentions"),
          t("table.col.share"),
          t("table.col.position"),
          t("table.col.prompts"),
          t("table.col.rate"),
        ],
        sorted.map(({ row: r, view }) => {
          const v = view.values;
          return [
            r.brand,
            fmt(v.mentions),
            fmt(v.share, 1),
            r.avgPosition != null ? r.avgPosition.toFixed(1) : "",
            fmt(v.prompts),
            fmt(v.mentionRate, 1),
          ];
        }),
      );
    } catch (err) {
      // 조용히 실패하면 "버튼이 안 먹는다"로만 보인다 — exceljs 청크 로드 실패나 워크북 생성
      // 오류를 사용자에게 알리고 로그에 남긴다(prompt-list-readonly.tsx 와 같은 처리).
      console.error("[answer-analysis/mentions] export failed:", err);
      toast.error(tExport("exportFailed"));
    } finally {
      exportingRef.current = false;
      setExporting(false);
    }
  }

  const multiUnavailable = multi && table.multiUnavailable;

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex flex-col gap-1">
          <h3 className="text-[15px] font-semibold tracking-tight text-foreground">{t("table.title")}</h3>
          <p className="text-[11px] text-muted-foreground">{t("table.hint")}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {multiToggle ? (
            <label className="inline-flex cursor-pointer items-center gap-2.5 text-[13px] font-medium text-foreground" title={t("table.multiHint")}>
              {t("table.multiToggle")}
              <button
                type="button"
                role="switch"
                aria-checked={multi}
                onClick={() => setMulti((v) => !v)}
                className={cn("relative h-[18px] w-[34px] rounded-full transition-colors", multi ? "bg-brand-700" : "bg-ink-300")}
              >
                <span
                  className={cn(
                    "absolute top-[2px] left-[2px] h-3.5 w-3.5 rounded-full bg-card shadow transition-transform",
                    multi && "translate-x-4",
                  )}
                />
              </button>
            </label>
          ) : null}
          <div className="relative w-full sm:w-56">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              id="m-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={tFilter("brandSearchPlaceholder")}
              aria-label={tFilter("brandSearch")}
              className="h-8 pl-8 text-xs"
            />
          </div>
          {search.trim() ? (
            <span className="text-[11px] whitespace-nowrap tabular-nums text-muted-foreground">
              {tFilter("searchResultCount", { matched: sorted.length, total: brands.length })}
            </span>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onExport}
            disabled={exporting || sorted.length === 0}
            className="shrink-0"
          >
            <Download className="h-3.5 w-3.5" aria-hidden />
            {tRoot("exportExcel")}
          </Button>
        </div>
      </div>
      {multi && multiUnavailable ? (
        <p className="border-b border-border/60 px-4 py-2 text-[11px] text-muted-foreground">
          {t("table.multiUnavailable")}
        </p>
      ) : null}
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/30 text-left text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
            <Th align="right" info={{ title: t("table.col.rank"), definition: t("table.colDefinition.rank") }}>
              #
            </Th>
            <Th onClick={() => clickHeader("brand")}>
              {t("table.col.brand")} <SortIcon active={sortKey === "brand"} asc={asc} />
            </Th>
            <Th
              onClick={() => clickHeader("mentions")}
              align="right"
              info={{ title: t("table.col.mentions"), definition: t("table.colDefinition.mentions") }}
            >
              {t("table.col.mentions")} <SortIcon active={sortKey === "mentions"} asc={asc} />
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
              onClick={() => clickHeader("avgPosition")}
              align="right"
              info={{ title: t("table.col.position"), definition: t("table.colDefinition.position") }}
            >
              {t("table.col.position")} <SortIcon active={sortKey === "avgPosition"} asc={asc} />
            </Th>
            <Th
              onClick={() => clickHeader("prompts")}
              align="right"
              info={{ title: t("table.col.prompts"), definition: t("table.colDefinition.prompts") }}
            >
              {t("table.col.prompts")} <SortIcon active={sortKey === "prompts"} asc={asc} />
            </Th>
            <Th
              onClick={() => clickHeader("mentionRate")}
              align="right"
              info={{
                title: t("table.col.rate"),
                definition: t("table.colDefinition.rate"),
                formula: t("table.colFormula.rate"),
              }}
            >
              {t("table.col.rate")} <SortIcon active={sortKey === "mentionRate"} asc={asc} />
            </Th>
            {multi ? (
              <>
                <Th
                  onClick={() => clickHeader("multiMentions")}
                  align="right"
                  info={{ title: t("table.col.multiMentions"), definition: t("table.colDefinition.multiMentions") }}
                >
                  {t("table.col.multiMentions")} <SortIcon active={sortKey === "multiMentions"} asc={asc} />
                </Th>
                <Th
                  onClick={() => clickHeader("multiRate")}
                  align="right"
                  info={{ title: t("table.col.multiRate"), definition: t("table.colDefinition.multiRate") }}
                >
                  {t("table.col.multiRate")} <SortIcon active={sortKey === "multiRate"} asc={asc} />
                </Th>
              </>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 ? (
            <tr>
              <td colSpan={multi ? 9 : 7} className="px-3 py-6 text-center text-sm text-muted-foreground">
                {t("table.empty")}
              </td>
            </tr>
          ) : (
            sorted.map(({ row: r, view }) => (
              <BrandRow
                key={r.brand}
                row={r}
                values={view.values}
                multiValues={multi ? view.multiValues : null}
                rank={view.rank}
                prompts={perBrandPrompts[r.brand] ?? []}
                open={expanded === r.brand}
                onToggle={() => setExpanded((cur) => (cur === r.brand ? null : r.brand))}
                isWebsite={isWebsite}
                lazyPrompts={lazyPrompts}
                showRank={showRank}
              />
            ))
          )}
        </tbody>
      </table>
      {/* B039: 전량 목록이 서버 상한에서 잘렸을 때만 한 줄(`total` 미전달·잘리지 않음 = 없음). */}
      <TruncatedNote shown={brands.length} total={total} className={TRUNCATED_ROW_CLASS} />
    </div>
  );
}

function Th({
  children,
  onClick,
  align,
  info,
}: {
  children: ReactNode;
  // 미지정 = 정렬 불가 컬럼 (#순번처럼 표시 전용).
  onClick?: () => void;
  align?: "right";
  // 컬럼 정의 — hover 시 아이콘으로 노출(정렬 버튼과 별도 요소라 클릭이 안 섞임).
  info?: { title: string; definition: string; formula?: string };
}) {
  return (
    <th className="px-3 py-2">
      <div className={cn("inline-flex items-center gap-1", align === "right" && "flex w-full justify-end")}>
        {onClick ? (
          <button
            type="button"
            onClick={onClick}
            className="inline-flex items-center gap-1.5 text-left hover:text-foreground"
          >
            {children}
          </button>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-left">{children}</span>
        )}
        {info ? <ColInfo {...info} /> : null}
      </div>
    </th>
  );
}

function SortIcon({ active, asc }: { active: boolean; asc: boolean }) {
  if (!active) return <ArrowUpDown className="h-3 w-3 opacity-40" aria-hidden />;
  return asc ? <ArrowUp className="h-3 w-3" aria-hidden /> : <ArrowDown className="h-3 w-3" aria-hidden />;
}

const dash = <span className="text-muted-foreground">—</span>;

function BrandRow({
  row,
  values,
  multiValues,
  rank,
  prompts,
  open,
  onToggle,
  isWebsite,
  lazyPrompts,
  showRank,
}: {
  row: MentionsBrandLive;
  values: BrandRowValues;
  /** 복수 언급 토글 ON 일 때만 — 추가 2열(복수 언급 수·복수 언급률). */
  multiValues: BrandRowValues | null;
  /** 언급 수 기준 기본 순번 — 정렬을 바꿔도 바뀌지 않는다 (2026-08-12 피드백 ③). */
  rank: number;
  prompts: MentionsPromptLive[];
  open: boolean;
  onToggle: () => void;
  isWebsite: boolean;
  lazyPrompts: boolean;
  showRank: boolean;
}) {
  return (
    <>
      <tr className="cursor-pointer border-t border-border first:border-t-0 hover:bg-muted/40" onClick={onToggle}>
        <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">{rank}</td>
        <td className="px-3 py-2.5 font-medium text-foreground">{row.brand}</td>
        <td className="px-3 py-2.5 text-right tabular-nums text-foreground">
          {values.mentions == null ? dash : values.mentions.toLocaleString()}
        </td>
        <td className="px-3 py-2.5 text-right tabular-nums text-foreground">
          {values.share == null ? dash : `${values.share.toFixed(1)}%`}
        </td>
        <td className="px-3 py-2.5 text-right tabular-nums text-foreground">
          {row.avgPosition != null ? row.avgPosition.toFixed(1) : "—"}
        </td>
        <td className="px-3 py-2.5 text-right tabular-nums text-foreground">
          {values.prompts == null ? dash : values.prompts.toLocaleString()}
        </td>
        <td className="px-3 py-2.5 text-right tabular-nums text-foreground">
          {values.mentionRate == null ? dash : `${values.mentionRate.toFixed(1)}%`}
        </td>
        {multiValues ? (
          <>
            <td className="px-3 py-2.5 text-right tabular-nums text-foreground">
              {multiValues.mentions == null ? dash : multiValues.mentions.toLocaleString()}
            </td>
            <td className="px-3 py-2.5 text-right tabular-nums text-foreground">
              {multiValues.mentionRate == null ? dash : `${multiValues.mentionRate.toFixed(1)}%`}
            </td>
          </>
        ) : null}
      </tr>
      {open ? (
        <tr className="border-t border-border bg-muted/20">
          <td colSpan={multiValues ? 9 : 7} className="px-4 py-4">
            <MentionsDrilldown
              brand={row.brand}
              own={ownTargetOf(row)}
              prompts={prompts}
              isWebsite={isWebsite}
              lazyPrompts={lazyPrompts}
              showRank={showRank}
            />
          </td>
        </tr>
      ) : null}
    </>
  );
}
