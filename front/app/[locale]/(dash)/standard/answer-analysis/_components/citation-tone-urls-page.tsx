"use client";

// 하위 페이지 — 긍정/부정 답변에 인용된 URL(디자인 585:1820). 탭(`tone`)·검색(`q`)·
// 도메인별 보기(`by=domain`)·페이지(`page`)는 URL 이 소유한다.
//
// B045: 탭 카운트는 탭·검색·페이지·커서·도메인 보기와 무관하다(같은 필터면 같은 값, BG-27). 서버는
// 화면 안의 커서·검색 이동에는 카운트를 다시 세지 않고 `counts` 를 null 로 넘긴다 → 이 화면이 같은
// 필터로 받은 마지막 카운트를 그대로 그린다(마운트 동안은 ref, 뒤로·앞으로 가기로 다시 마운트되면
// 탭 단위 sessionStorage). 기억이 없으면 종전 degrade 표기("—")다. URL 계약은 그대로다.

import Link from "next/link";
import { useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
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
import { categoryColor } from "./citations-view";
import { Pager, SubpageSearchBox, TabLink, useCursorPaging, useSubpageNav, type CursorAware } from "./citation-prompts-page";

/** 두 톤 탭의 카운트. 값 null = 일시 실패("—"). */
export type ToneCounts = { positive: number | null; negative: number | null };

type ToneUrlsProps = {
  tone: CitationTone;
  page: CursorAware<CitationToneUrlPage> | null;
  q: string;
  byDomain: boolean;
  /** null = 서버가 세지 않았다(B045): 같은 필터로 이미 받은 카운트를 다시 쓴다. */
  counts: ToneCounts | null;
};

const NO_COUNTS: ToneCounts = { positive: null, negative: null };
const COUNTS_STORE_PREFIX = "hgh.toneUrlCounts:";

/** 카운트를 정하는 URL 부분(필터). 탭·검색·페이지·커서·도메인 보기는 빼고 정렬한다. */
export function toneCountsKey(search: string): string {
  const p = new URLSearchParams(search);
  for (const k of ["tone", "q", "page", "by", "cursor"]) p.delete(k);
  p.sort();
  return p.toString();
}

function countsStore(): Storage | null {
  if (typeof window === "undefined") return null; // 서버 렌더에서는 기억을 읽지도 쓰지도 않는다
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** 받은 카운트를 탭 단위로 기억한다(둘 다 숫자일 때만 — degrade 값으로 좋은 기억을 덮지 않는다). */
export function rememberToneCounts(key: string, counts: ToneCounts): void {
  if (typeof counts.positive !== "number" || typeof counts.negative !== "number") return;
  try {
    countsStore()?.setItem(COUNTS_STORE_PREFIX + key, JSON.stringify(counts));
  } catch {
    // 저장 불가(차단·용량): 마운트 동안의 ref 기억만 남는다.
  }
}

export function recallToneCounts(key: string): ToneCounts | null {
  try {
    const raw = countsStore()?.getItem(COUNTS_STORE_PREFIX + key);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Record<keyof ToneCounts, unknown>>;
    return typeof v.positive === "number" && typeof v.negative === "number" ? { positive: v.positive, negative: v.negative } : null;
  } catch {
    return null;
  }
}

/** 그릴 카운트: 서버 값, 없으면(null) 같은 필터로 받은 마지막 값, 그것도 없으면 "—". */
function useShownToneCounts(served: ToneCounts | null): ToneCounts {
  const sp = useSearchParams();
  const key = toneCountsKey(sp.toString());
  const last = useRef<{ key: string; counts: ToneCounts } | null>(null);
  if (served && typeof served.positive === "number" && typeof served.negative === "number") {
    last.current = { key, counts: served };
  }
  useEffect(() => {
    if (served) rememberToneCounts(key, served);
  }, [key, served]);
  if (served) return served;
  if (last.current?.key === key) return last.current.counts;
  return recallToneCounts(key) ?? NO_COUNTS;
}

export function CitationToneUrlsPage(props: ToneUrlsProps) {
  // 검색·탭·도메인 스위치·페이저가 **한 transition** 을 공유한다 → 왕복 동안 목록이
  // 흐려지고 "재조회 중" 필이 뜬다(2026-09-16 GGMD QA: 느린 왕복을 버그로 오인).
  return (
    <FilterTransitionProvider>
      <ToneUrlsView {...props} />
    </FilterTransitionProvider>
  );
}

function ToneUrlsView({ tone, page, q, byDomain, counts: served }: ToneUrlsProps) {
  const counts = useShownToneCounts(served);
  const t = useTranslations("answerAnalysis.citations.v2.toneUrlsPage");
  const tKpi = useTranslations("answerAnalysis.mentions.kpi");
  const tCat = useTranslations("citationCategories");
  const nav = useSubpageNav();
  const win = page?.win ?? null;
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
