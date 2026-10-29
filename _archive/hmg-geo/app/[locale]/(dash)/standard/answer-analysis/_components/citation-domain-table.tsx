"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import {
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  ExternalLink,
  MessageSquareText,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { displayCitationUrl } from "@/lib/url-display";
import type {
  CitationDomainLive,
  CitationPromptLive,
} from "@/lib/scope/result-adapter";
import { AnswerModal } from "./answer-modal";

// ⚠️ "도메인" 열 표기에 대하여 (운영 결정 2026-08-28)
// 이 열의 값은 **대부분 registrable domain 이지만 공식 HMG 소셜 계정 행만
// host+path** 다 (`linkedin.com/hyundai-motor-group`,
// `facebook.com/HyundaiMotorGroupNewsroom` …). 계정 단위로 나누지 않으면
// `linkedin.com` 전체가 공식(HMG)으로 분류되어 버리기 때문에 그룹 키를 넓혔고,
// 그럼에도 **열 표기를 "도메인" 그대로 두는 것은 운영 결정(2026-08-28)** 이다.
// 목록·정규화 정본은 lib/citation-categorizer/official-social.ts,
// SQL 쌍둥이는 lib/db/repositories/citation-group-key.ts (같은 주석이 세 곳에 있다).
//
// Self-contained "도메인 인용 순위" table — the same domain rollup used on the
// citation tab, packaged so the mention drilldown's 인용출처 tab can embed it
// per brand. Row click → URL list; 프롬프트 count click → prompt list → answer
// modal. (The citation tab keeps its own copy untouched; this is the shared
// embeddable version.)

type SortKey = "domain" | "citations" | "share" | "prompts" | "coverageRate";

export function CitationDomainTable({
  domains,
}: {
  domains: CitationDomainLive[];
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
}: {
  row: CitationDomainLive;
  rank: number;
  openMode: "urls" | "prompts" | null;
  onToggle: (mode: "urls" | "prompts") => void;
}) {
  const t = useTranslations("answerAnalysis.citations");
  const urls = row.urls ?? [];
  const promptList = row.promptList ?? [];
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
          {promptList.length > 0 ? (
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
            {urls.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("drilldown.noUrls")}</p>
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
          </td>
        </tr>
      ) : null}

      {openMode === "prompts" ? (
        <tr className="border-t border-border bg-muted/20">
          <td colSpan={7} className="px-4 py-4">
            <CitationPromptsDrilldown prompts={promptList} domain={row.domain} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function CitationPromptsDrilldown({
  prompts,
  domain,
}: {
  prompts: CitationPromptLive[];
  domain: string;
}) {
  const t = useTranslations("answerAnalysis.citations");
  const tMd = useTranslations("answerAnalysis.mentions.drilldown");
  const [selected, setSelected] = useState<CitationPromptLive | null>(null);

  if (prompts.length === 0) {
    return <p className="text-xs text-muted-foreground">{t("drilldown.noPrompts")}</p>;
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
