"use client";

// 하위 페이지 — 긍정/부정 답변에 인용된 URL(디자인 585:1820). 탭(`tone`)·검색(`q`)·
// 도메인별 보기(`by=domain`)·페이지(`page`)는 URL 이 소유한다.

import Link from "next/link";
import { useTranslations } from "next-intl";
import { ArrowLeft, ExternalLink } from "lucide-react";
import {
  FilterContentDim,
  FilterTransitionProvider,
} from "@/components/dash/filter-transition";
import type { CitationTone, CitationToneUrlPage } from "@/lib/db/repositories/scope-aggregates";
import { citationCategorySlug } from "@/lib/citation-categorizer/taxonomy";
import { displayCitationUrl } from "@/lib/url-display";
import { cn } from "@/lib/utils";
import { pageWindow } from "../_data/citation-view";
import { categoryColor } from "./citations-view";
import { Pager, SubpageSearchBox, TabLink, useCursorPaging, useSubpageNav, type CursorAware } from "./citation-prompts-page";

type ToneUrlsProps = {
  tone: CitationTone;
  page: CursorAware<CitationToneUrlPage> | null;
  q: string;
  byDomain: boolean;
  counts: { positive: number | null; negative: number | null };
};

export function CitationToneUrlsPage(props: ToneUrlsProps) {
  // 검색·탭·도메인 스위치·페이저가 **한 transition** 을 공유한다 → 왕복 동안 목록이
  // 흐려지고 "재조회 중" 필이 뜬다(2026-09-16 GGMD QA: 느린 왕복을 버그로 오인).
  return (
    <FilterTransitionProvider>
      <ToneUrlsView {...props} />
    </FilterTransitionProvider>
  );
}

function ToneUrlsView({ tone, page, q, byDomain, counts }: ToneUrlsProps) {
  const t = useTranslations("answerAnalysis.citations.v2.toneUrlsPage");
  const tKpi = useTranslations("answerAnalysis.mentions.kpi");
  const tCat = useTranslations("citationCategories");
  const nav = useSubpageNav();
  const win = page ? pageWindow(page.total, page.page, page.pageSize) : null;
  const cursorNav = useCursorPaging(page);
  const label = (name: string) => { const s = citationCategorySlug(name); return s ? tCat(s) : name; };

  return (
    <div className="flex flex-col gap-4">
      <Link href={nav.backHref} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> {t("back")}
      </Link>
      <div className="flex gap-1 border-b border-border">
        <TabLink active={tone === "positive"} href={nav.href({ tone: "positive", page: "1" })}>{t("positiveTab", { n: counts.positive ?? "—" })}</TabLink>
        <TabLink active={tone === "negative"} href={nav.href({ tone: "negative", page: "1" })}>{t("negativeTab", { n: counts.negative ?? "—" })}</TabLink>
      </div>
      {/* 컨트롤 행(검색·도메인 스위치·범위)은 **dim 밖**이다 — 왕복 중에도 계속
          입력·클릭할 수 있어야 한다(대시보드 필터바가 dim 밖인 것과 같은 이유).
          흐려지는 것은 옛 숫자를 보여주는 목록·페이저뿐이다. */}
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <SubpageSearchBox q={q} label={t("search")} />
            <label className="inline-flex cursor-pointer items-center gap-2.5 text-[13px] font-medium text-foreground">
              {t("byDomain")}
              <button type="button" role="switch" aria-checked={byDomain} onClick={() => nav.push({ by: byDomain ? "" : "domain", page: "1" })}
                className={cn("relative h-[18px] w-[34px] rounded-full transition-colors", byDomain ? "bg-brand-700" : "bg-ink-300")}>
                <span className={cn("absolute top-[2px] left-[2px] h-3.5 w-3.5 rounded-full bg-card shadow transition-transform", byDomain && "translate-x-4")} />
              </button>
            </label>
          </div>
          {win ? <span className="text-[11px] tabular-nums text-muted-foreground">{t("range", { from: win.from, to: win.to, total: page!.total })}</span> : null}
        </div>
        <FilterContentDim>
          <div className="flex flex-col gap-3">
        {page == null ? (
          <p className="py-8 text-center text-xs text-muted-foreground">{tKpi("degraded")}</p>
        ) : page.rows.length === 0 ? (
          <p className="py-8 text-center text-xs text-muted-foreground">{t("empty")}</p>
        ) : (
          <div className="overflow-hidden rounded-md border border-border">
            {/* 피그마 585:1820: 목록 위 헤더 행(URL / 도메인). */}
            <div className="border-b border-border bg-bg-soft px-3 py-2 text-[13px] font-semibold text-muted-foreground">
              {byDomain ? t("col.domain") : t("col.url")}
            </div>
          <ul className="flex flex-col divide-y divide-border">
            {page.rows.map((r, i) => (
              <li key={`${r.domain}|${r.url ?? ""}|${i}`} className="flex flex-col gap-1 px-3 py-2.5">
                <div className="flex items-start justify-between gap-3">
                  <span className="min-w-0 line-clamp-2 text-sm font-medium text-foreground">{r.title || r.domain}</span>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      <span className="h-2 w-2 rounded-full" style={{ background: categoryColor(r.category) }} aria-hidden />
                      {label(r.category)}
                    </span>
                    {r.providers.map((p) => (
                      <span key={p} className="rounded bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">{p}</span>
                    ))}
                  </div>
                </div>
                {r.url ? (
                  <a href={r.url} target="_blank" rel="noopener noreferrer" className="flex items-start gap-1 text-[11px] text-brand-700 hover:underline">
                    <span className="min-w-0 break-all">{displayCitationUrl(r.url)}</span>
                    <ExternalLink className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                  </a>
                ) : (
                  <span className="text-[11px] text-muted-foreground">{t("col.domain")}: {r.domain}</span>
                )}
                <p className="text-[11px] text-muted-foreground">
                  {r.promptText ? <>&ldquo;{r.promptText}&rdquo; · </> : null}
                  {t("cites", { n: r.citations.toLocaleString() })}
                </p>
              </li>
            ))}
          </ul>
          </div>
        )}
        {win && win.pages > 1 ? (
          <Pager win={win} onPage={cursorNav ? cursorNav.go : (p) => nav.push({ page: String(p) })} hasNext={cursorNav?.hasNext} />
        ) : null}
          </div>
        </FilterContentDim>
      </div>
    </div>
  );
}
