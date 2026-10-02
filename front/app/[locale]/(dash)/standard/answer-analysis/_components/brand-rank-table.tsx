"use client";

// 브랜드 언급 순위 표 — mentions-view.tsx 에서 추출(2026-09-02). 검색(useDeferredValue
// INP 패턴)·정렬·고정 순번·Excel 내보내기·행 클릭 드릴다운은 종전 그대로다.
// website/project mention 화면은 이 컴포넌트를 기본 옵션으로 쓰므로 마크업이 바뀌지
// 않고, 표준 공통 하단(디자인 327:116)만 아래 두 옵션을 켠다:
//   · multiToggle — "브랜드 복수 언급": 한 답변 안에서 2회 이상 언급된 답변 기준으로
//     언급 수·프롬프트·언급률·점유율을 전환(값은 서버 집계의 multi 필드)
//   · showRank   — 드릴다운 프롬프트 표에 순위 열 + "언급 TOP 3 이내" 배지
//   · limit      — 상위 N 행(디자인 "상위 100")

import { useDeferredValue, useMemo, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { ArrowDown, ArrowUp, ArrowUpDown, Download, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ColInfo } from "@/components/dash/col-info";
import { dateStamp } from "@/lib/export/csv";
import { downloadXlsx } from "@/lib/export/xlsx";
import { cn } from "@/lib/utils";
import type { MentionsBrandLive, MentionsPromptLive } from "@/lib/scope/result-adapter";
import { brandRowValues, type BrandRowValues } from "../_data/prompt-rank";
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

type SortKey =
  | "brand"
  | "mentions"
  | "share"
  | "avgPosition"
  | "prompts"
  | "mentionRate"
  | "multiMentions"
  | "multiRate";

export function BrandRankTable({
  brands,
  perBrandPrompts,
  isWebsite = false,
  lazyPrompts = false,
  multiToggle = false,
  showRank = false,
  limit,
  totalAnswers = null,
  initialMulti = false,
}: {
  brands: MentionsBrandLive[];
  perBrandPrompts: Record<string, MentionsPromptLive[]>;
  isWebsite?: boolean;
  lazyPrompts?: boolean;
  multiToggle?: boolean;
  showRank?: boolean;
  limit?: number;
  /** 복수 언급 모드의 언급률 분모(측정 답변 수). 없으면 그 열은 "—". */
  totalAnswers?: number | null;
  /** 렌더 테스트 seam — 토글 초기값. 화면 기본은 꺼짐. */
  initialMulti?: boolean;
}) {
  const t = useTranslations("answerAnalysis.mentions");
  const tRoot = useTranslations("answerAnalysis");
  const tFilter = useTranslations("answerAnalysis.filters");

  const [search, setSearch] = useState("");
  // 입력은 즉시, 목록 재계산(filtered→sorted→전 행 리렌더)은 낮은 우선순위로 —
  // 키 입력마다 동기 재계산이 돌던 INP 병목(citations-view 와 동일).
  const deferredSearch = useDeferredValue(search);
  const [sortKey, setSortKey] = useState<SortKey>("mentions");
  const [asc, setAsc] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [multi, setMulti] = useState(multiToggle && initialMulti);

  // 복수 언급 모드의 점유율 분모 — 전 브랜드 복수 언급 합(검색 전).
  const multiTotal = useMemo(
    () => brands.reduce((s, b) => s + (b.multi?.mentions ?? 0), 0),
    [brands],
  );
  // 기본 열은 토글과 무관하게 **항상 전체 기준**이다(2026-09-02 피그마 1:1, 제품 결정 Q42):
  // 복수 언급 ON 은 값을 갈아끼우는 것이 아니라 '브랜드 복수 언급 수'·'복수 언급률' 2열을
  // **추가**한다 — 두 값을 나란히 비교할 수 있고 안내 행이 필요 없다.
  const valuesOf = useMemo(() => {
    const m = new Map<string, BrandRowValues>();
    for (const b of brands) m.set(b.brand, brandRowValues(b, { multi: false, multiTotalMentions: multiTotal, totalAnswers }));
    return m;
  }, [brands, multiTotal, totalAnswers]);
  const multiOf = useMemo(() => {
    const m = new Map<string, BrandRowValues>();
    for (const b of brands) m.set(b.brand, brandRowValues(b, { multi: true, multiTotalMentions: multiTotal, totalAnswers }));
    return m;
  }, [brands, multiTotal, totalAnswers]);

  const filtered = useMemo(() => {
    const q = deferredSearch.trim().toLowerCase();
    return brands.filter((r) => !q || r.brand.toLowerCase().includes(q));
  }, [brands, deferredSearch]);

  // #순번 — 서버 기본 정렬(언급 수 desc) 기준의 고정 순번. 사용자가 다른 컬럼으로
  // 재정렬해도 각 행의 순번은 유지된다(줄만 다시 선다, 2026-08-12 피드백 ③).
  const rankByBrand = useMemo(() => {
    const m = new Map<string, number>();
    brands.forEach((b, i) => m.set(b.brand, i + 1));
    return m;
  }, [brands]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    const v = (r: MentionsBrandLive) => valuesOf.get(r.brand)!;
    const mv = (r: MentionsBrandLive) => multiOf.get(r.brand)!;
    arr.sort((a, b) => {
      const dir = asc ? 1 : -1;
      if (sortKey === "brand") return dir * a.brand.localeCompare(b.brand);
      if (sortKey === "avgPosition") {
        return dir * ((a.avgPosition ?? Infinity) - (b.avgPosition ?? Infinity));
      }
      // 값 없음(null)은 정렬 방향과 무관하게 맨 뒤.
      const key = sortKey === "multiMentions" ? "mentions" : sortKey === "multiRate" ? "mentionRate" : sortKey;
      const src = sortKey === "multiMentions" || sortKey === "multiRate" ? mv : v;
      const av = src(a)[key];
      const bv = src(b)[key];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return dir * (av - bv);
    });
    return limit != null ? arr.slice(0, limit) : arr;
  }, [filtered, sortKey, asc, valuesOf, multiOf, limit]);

  function clickHeader(k: SortKey) {
    if (sortKey === k) setAsc((v) => !v);
    else {
      setSortKey(k);
      setAsc(k === "brand");
    }
  }

  // Export the real (server-filtered, sorted) brand rows.
  function onExport() {
    const fmt = (n: number | null, digits = 0) => (n == null ? "" : digits ? n.toFixed(digits) : n);
    void downloadXlsx(
      `brand-mentions-${dateStamp()}`,
      [
        t("table.col.brand"),
        t("table.col.mentions"),
        t("table.col.share"),
        t("table.col.position"),
        t("table.col.prompts"),
        t("table.col.rate"),
      ],
      sorted.map((r) => {
        const v = valuesOf.get(r.brand)!;
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
  }

  const multiUnavailable = multi && brands.some((b) => !b.multi);

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
            disabled={sorted.length === 0}
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
            sorted.map((r) => (
              <BrandRow
                key={r.brand}
                row={r}
                values={valuesOf.get(r.brand)!}
                multiValues={multi ? multiOf.get(r.brand) ?? null : null}
                rank={rankByBrand.get(r.brand) ?? 0}
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
