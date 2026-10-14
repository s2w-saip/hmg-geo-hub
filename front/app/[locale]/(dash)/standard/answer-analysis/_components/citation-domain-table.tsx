"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import {
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  ExternalLink,
  Loader2,
  MessageSquareText,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { displayCitationUrl } from "@/lib/url-display";
import {
  citationDrilldownEmptyKey,
  type CitationDrilldownEmptyKey,
} from "../_data/citation-view";
import type {
  CitationDomainLive,
  CitationPromptLive,
  CitationUrlLive,
} from "@/lib/scope/result-adapter";
import { AnswerModal } from "./answer-modal";

// ⚠️ "도메인" 열 표기에 대하여 (제품 결정 2026-08-28)
// 이 열의 값은 **대부분 registrable domain 이지만 공식 HMG 소셜 계정 행만
// host+path** 다 (`linkedin.com/hyundai-motor-group`,
// `facebook.com/HyundaiMotorGroupNewsroom` …). 계정 단위로 나누지 않으면
// `linkedin.com` 전체가 공식(HMG)으로 분류되어 버리기 때문에 그룹 키를 넓혔고,
// 그럼에도 **열 표기를 "도메인" 그대로 두는 것은 제품 결정(2026-08-28)** 이다.
// 목록·정규화 정본은 lib/citation-categorizer/official-social.ts,
// SQL 쌍둥이는 lib/db/repositories/citation-group-key.ts (같은 주석이 세 곳에 있다).
//
// Self-contained "도메인 인용 순위" table — the same domain rollup used on the
// citation tab, packaged so the mention drilldown's 인용출처 tab can embed it
// per brand. Row click → URL list; 프롬프트 count click → prompt list → answer
// modal. (The citation tab keeps its own copy untouched; this is the shared
// embeddable version.)

type SortKey = "domain" | "citations" | "share" | "prompts" | "coverageRate";

// Unit U6 (API source, design 3.5 #5): rows of the new backend carry `skey` and no urls /
// promptList (the list endpoint has no drilldown; the detail is one call per source). With
// `detailQuery` (the drilldown's route parameters) an opened row loads its detail from
// /api/scope/brand-citations?<detailQuery>&skey=<skey> once, then renders exactly as before.
// Legacy rows (no skey) keep the inline urls / promptList.
//
// B008: when the route cut a list (the list itself, a row's URLs or its prompts), it sends the count
// before the cap (total / urlTotal / promptTotal) and the table adds one line with the existing
// "{total}개 중 {shown}개 표시" copy (TruncatedNote). A list that fits renders exactly as before.

type DetailState =
  | { status: "loading" }
  | { status: "ready"; urls: CitationUrlLive[]; promptList: CitationPromptLive[]; urlTotal?: number; promptTotal?: number }
  | { status: "error" };

/**
 * The one-line notice under a list the route cut (B008): the existing unmeasured-dialog copy
 * "{total}개 중 {shown}개 표시". Nothing when the list was not cut (total absent or not larger).
 */
export function TruncatedNote({ shown, total, className }: { shown: number; total?: number; className: string }) {
  const t = useTranslations("answerAnalysis.mentions.kpi.overview.unmeasuredDialog");
  if (total === undefined || total <= shown) return null;
  return <p className={className}>{t("truncated", { shown, total })}</p>;
}

/** Class of the notice inside a bordered table box (the unmeasured dialog's line). */
export const TRUNCATED_ROW_CLASS = "border-t border-border px-3 py-2 text-[11px] text-muted-foreground";

/** Whether a row's drilldown comes from the detail call (API rows) rather than inline data. */
export function rowLoadsDetail(row: Pick<CitationDomainLive, "skey">, detailQuery: string | undefined): boolean {
  return Boolean(row.skey && detailQuery !== undefined);
}

/** The detail URL of a row (the route's skey branch). */
export function domainDetailUrl(detailQuery: string, skey: string): string {
  const params = new URLSearchParams(detailQuery);
  params.set("skey", skey);
  return `/api/scope/brand-citations?${params.toString()}`;
}

type DetailSetter = (next: DetailState | null | ((prev: DetailState | null) => DetailState | null)) => void;

/**
 * Whether an opened row must (re)load its detail: only a finished load is kept. A load cut off by
 * closing the row (or opening another) before the reply must run again on reopen (U6 verification
 * D2: the old guard kept a stale "loading" and the spinner never ended).
 */
export function detailNeedsLoad(state: DetailState | null): boolean {
  return state?.status !== "ready";
}

/**
 * One detail load (the effect body of useDomainDetail). Returns the cleanup: it aborts the request
 * and drops a state that is not "ready", so an aborted load never stays "loading".
 */
export function startDomainDetailLoad(
  url: string,
  setState: DetailSetter,
  fetchImpl: typeof fetch = fetch,
): () => void {
  const ctrl = new AbortController();
  setState({ status: "loading" });
  fetchImpl(url, { signal: ctrl.signal })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error("failed"))))
    .then((d: { urls?: CitationUrlLive[]; promptList?: CitationPromptLive[]; urlTotal?: number; promptTotal?: number }) => {
      if (ctrl.signal.aborted) return;
      setState({
        status: "ready",
        urls: d.urls ?? [],
        promptList: d.promptList ?? [],
        ...(typeof d.urlTotal === "number" ? { urlTotal: d.urlTotal } : {}),
        ...(typeof d.promptTotal === "number" ? { promptTotal: d.promptTotal } : {}),
      });
    })
    .catch((e: unknown) => {
      if (ctrl.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
      setState({ status: "error" });
    });
  return () => {
    ctrl.abort();
    setState((prev) => (prev?.status === "ready" ? prev : null));
  };
}

function useDomainDetail(url: string | null, active: boolean): DetailState | null {
  const [state, setState] = useState<DetailState | null>(null);
  useEffect(() => {
    if (!url || !active || !detailNeedsLoad(state)) return;
    return startDomainDetailLoad(url, setState);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once per url while open
  }, [url, active]);
  return state;
}

export function CitationDomainTable({
  domains,
  detailQuery,
  total,
}: {
  domains: CitationDomainLive[];
  /** API rows (skey): the drilldown route parameters used to load a row's detail when it opens. */
  detailQuery?: string;
  /** Sources before the route's cap, only when it cut the list (B008). */
  total?: number;
}) {
  const t = useTranslations("answerAnalysis.citations");
  const [sortKey, setSortKey] = useState<SortKey>("citations");
  const [asc, setAsc] = useState(false);
  const [expanded, setExpanded] = useState<{
    domain: string;
    mode: "urls" | "prompts";
  } | null>(null);

  // rank reflects the incoming (citations-desc) order; the table may re-sort by
  // any column while rank stays the citation rank.
  const sorted = useMemo(() => {
    const arr = domains.map((r, i) => ({ ...r, rank: i + 1 }));
    arr.sort((a, b) => {
      const dir = asc ? 1 : -1;
      if (sortKey === "domain") return dir * a.domain.localeCompare(b.domain);
      return dir * (a[sortKey] - b[sortKey]);
    });
    return arr;
  }, [domains, sortKey, asc]);

  function clickHeader(k: SortKey) {
    if (sortKey === k) setAsc((v) => !v);
    else {
      setSortKey(k);
      setAsc(k === "domain");
    }
  }

  return (
    <div className="overflow-hidden rounded-md border border-border bg-card">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/30 text-left text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
            <th className="px-3 py-2 w-12">{t("table.col.rank")}</th>
            <Th onClick={() => clickHeader("domain")}>
              {t("table.col.domain")} <SortIcon active={sortKey === "domain"} asc={asc} />
            </Th>
            <th className="px-3 py-2">{t("table.col.category")}</th>
            <Th onClick={() => clickHeader("citations")} align="right">
              {t("table.col.citations")} <SortIcon active={sortKey === "citations"} asc={asc} />
            </Th>
            <Th onClick={() => clickHeader("share")} align="right">
              {t("table.col.share")} <SortIcon active={sortKey === "share"} asc={asc} />
            </Th>
            <Th onClick={() => clickHeader("prompts")} align="right">
              {t("table.col.prompts")} <SortIcon active={sortKey === "prompts"} asc={asc} />
            </Th>
            <Th onClick={() => clickHeader("coverageRate")} align="right">
              {t("table.col.coverage")} <SortIcon active={sortKey === "coverageRate"} asc={asc} />
            </Th>
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 ? (
            <tr>
              <td colSpan={7} className="px-3 py-6 text-center text-sm text-muted-foreground">
                {t("table.empty")}
              </td>
            </tr>
          ) : (
            sorted.map((r) => (
              <DomainRow
                key={r.domain}
                row={r}
                rank={r.rank}
                detailQuery={detailQuery}
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
        </tbody>
      </table>
      <TruncatedNote shown={domains.length} total={total} className={TRUNCATED_ROW_CLASS} />
    </div>
  );
}

function Th({
  children,
  onClick,
  align,
}: {
  children: React.ReactNode;
  onClick: () => void;
  align?: "right";
}) {
  return (
    <th className="px-3 py-2">
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "inline-flex items-center gap-1.5 text-left hover:text-foreground",
          align === "right" && "ml-auto flex w-full justify-end",
        )}
      >
        {children}
      </button>
    </th>
  );
}

function SortIcon({ active, asc }: { active: boolean; asc: boolean }) {
  if (!active) return <ArrowUpDown className="h-3 w-3 opacity-40" aria-hidden />;
  return asc ? <ArrowUp className="h-3 w-3" aria-hidden /> : <ArrowDown className="h-3 w-3" aria-hidden />;
}

function DomainRow({
  row,
  rank,
  openMode,
  onToggle,
  detailQuery,
}: {
  row: CitationDomainLive;
  rank: number;
  openMode: "urls" | "prompts" | null;
  onToggle: (mode: "urls" | "prompts") => void;
  detailQuery?: string;
}) {
  const t = useTranslations("answerAnalysis.citations");
  const tMd = useTranslations("answerAnalysis.mentions.drilldown");
  const lazy = rowLoadsDetail(row, detailQuery);
  const detail = useDomainDetail(lazy ? domainDetailUrl(detailQuery!, row.skey!) : null, openMode !== null);
  const loaded = detail?.status === "ready" ? detail : null;
  const urls = lazy ? (loaded?.urls ?? []) : (row.urls ?? []);
  const promptList = lazy ? (loaded?.promptList ?? []) : (row.promptList ?? []);
  // API rows: the prompt list is not known before the detail call, so the count opens it
  // whenever the row has prompts (legacy: only when the inline list was non-empty).
  const promptsClickable = lazy ? row.prompts > 0 : promptList.length > 0;
  const pending =
    lazy && detail?.status !== "ready" ? (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        {detail?.status === "error" ? (
          tMd("citationsError")
        ) : (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            {tMd("citationsLoading")}
          </>
        )}
      </p>
    ) : null;
  // 이 표는 **브랜드 인용출처 탭**(mention 드릴다운 안)에도 쓰인다. 그 경로의
  // 도메인 행은 `buildCitationDomains` 가 순위 캡 없이 전량 urls 를 채우므로
  // urls 가 0 이면 정말로 없는 것이고, 캐시 예산이 드릴다운을 떨군 경우에만
  // `drilldownOmitted` 가 붙는다(slimBrandCitationDomainsForCache 의 최후 안전판).
  // 표준 인용 표(미러 집계)도 상한 초과분에 같은 플래그를 붙인다 — 그래서 두
  // 경로가 같은 분기 함수 하나를 쓴다(_data/citation-view.ts).
  const noUrlsKey = citationDrilldownEmptyKey(row, "urls");
  const noPromptsKey = citationDrilldownEmptyKey(row, "prompts");
  return (
    <>
      <tr
        className="cursor-pointer border-t border-border first:border-t-0 hover:bg-muted/40"
        onClick={() => onToggle("urls")}
      >
        <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">{rank}</td>
        <td className="px-3 py-2.5 font-medium text-foreground">
          {row.domain}
          {row.isOurs ? <span className="ml-1.5 text-[10px] font-semibold text-brand-700">HMG</span> : null}
        </td>
        <td className="px-3 py-2.5 text-xs text-muted-foreground">{row.category ?? "—"}</td>
        <td className="px-3 py-2.5 text-right tabular-nums text-foreground">{row.citations.toLocaleString()}</td>
        <td className="px-3 py-2.5 text-right tabular-nums text-foreground">{row.share.toFixed(1)}%</td>
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
        <td className="px-3 py-2.5 text-right tabular-nums text-foreground">{row.coverageRate.toFixed(1)}%</td>
      </tr>

      {openMode === "urls" ? (
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
                      <span className="shrink-0 rounded bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                        {u.aiProvider}
                      </span>
                    </div>
                    <a
                      href={u.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-start gap-1 text-[11px] text-brand-700 hover:underline"
                    >
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
              <TruncatedNote shown={urls.length} total={loaded?.urlTotal} className="mt-2 text-[11px] text-muted-foreground" />
            ) : null}
          </td>
        </tr>
      ) : null}

      {openMode === "prompts" ? (
        <tr className="border-t border-border bg-muted/20">
          <td colSpan={7} className="px-4 py-4">
            {pending ?? (
              <CitationPromptsDrilldown
                prompts={promptList}
                domain={row.domain}
                emptyKey={noPromptsKey}
                total={loaded?.promptTotal}
              />
            )}
          </td>
        </tr>
      ) : null}
    </>
  );
}

export function CitationPromptsDrilldown({
  prompts,
  domain,
  emptyKey = "drilldown.noPrompts",
  total,
}: {
  prompts: CitationPromptLive[];
  domain: string;
  /** 빈 목록 문구 키 — 호출부가 행 상태로 결정한다(citationDrilldownEmptyKey). */
  emptyKey?: CitationDrilldownEmptyKey;
  /** 상세 상한 전 프롬프트 수 — 상한이 목록을 잘랐을 때만(B008). */
  total?: number;
}) {
  const t = useTranslations("answerAnalysis.citations");
  const tMd = useTranslations("answerAnalysis.mentions.drilldown");
  const [selected, setSelected] = useState<CitationPromptLive | null>(null);

  if (prompts.length === 0) {
    return <p className="text-xs text-muted-foreground">{t(emptyKey)}</p>;
  }
  const ranked = [...prompts].sort((a, b) => b.citations - a.citations);

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-hidden rounded-md border border-border bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/30 text-left text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
              <th className="px-3 py-2">{tMd("col.prompt")}</th>
              <th className="px-3 py-2 w-16 text-right">{t("table.col.citations")}</th>
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
