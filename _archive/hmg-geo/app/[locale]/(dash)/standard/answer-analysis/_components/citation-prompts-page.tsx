"use client";

// 하위 페이지 — 공식 도메인 인용/미인용 프롬프트 전량 목록(디자인 580:1146).
// 탭·검색·페이지는 URL(`tab` · `q` · `page`)이 소유한다(필터 파라미터는 그대로 실려 온다).
// 행 클릭 → 기존 AnswerModal(citation variant).

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, MessageSquareText, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { CitationOwnedPromptPage } from "@/lib/db/repositories/scope-aggregates";
import { cn } from "@/lib/utils";
import { pageWindow } from "../_data/citation-view";
import { AnswerModal } from "./answer-modal";

export function CitationPromptsPage({
  tab,
  page,
  q,
  ownedCount,
  uncitedCount,
}: {
  tab: "owned" | "uncited";
  page: CitationOwnedPromptPage | null;
  q: string;
  ownedCount: number | null;
  uncitedCount: number | null;
}) {
  const t = useTranslations("answerAnalysis.citations.v2.promptsPage");
  const tKpi = useTranslations("answerAnalysis.mentions.kpi");
  const nav = useSubpageNav();
  const [selected, setSelected] = useState<CitationOwnedPromptPage["rows"][number] | null>(null);
  const [draft, setDraft] = useState(q);
  const win = page ? pageWindow(page.total, page.page, page.pageSize) : null;

  return (
    <div className="flex flex-col gap-4">
      <Link href={nav.backHref} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> {t("back")}
      </Link>
      <div className="flex gap-1 border-b border-border">
        <TabLink active={tab === "owned"} href={nav.href({ tab: "owned", page: "1" })}>{t("ownedTab", { n: ownedCount ?? "—" })}</TabLink>
        <TabLink active={tab === "uncited"} href={nav.href({ tab: "uncited", page: "1" })}>{t("uncitedTab", { n: uncitedCount ?? "—" })}</TabLink>
      </div>
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <form
            className="relative w-full sm:w-72"
            onSubmit={(e) => { e.preventDefault(); nav.push({ q: draft, page: "1" }); }}
          >
            <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={t("search")} aria-label={t("search")} className="h-8 pl-8 text-xs" />
          </form>
          {win ? <span className="text-[11px] tabular-nums text-muted-foreground">{t("range", { from: win.from, to: win.to, total: page!.total })}</span> : null}
        </div>
        {page == null ? (
          <p className="py-8 text-center text-xs text-muted-foreground">{tKpi("degraded")}</p>
        ) : page.rows.length === 0 ? (
          <p className="py-8 text-center text-xs text-muted-foreground">{t("empty")}</p>
        ) : (
          <div className="overflow-hidden rounded-md border border-border">
            <table className="w-full text-sm">
              <thead>
                {/* 피그마 580:1146: '프롬프트' 단일 컬럼(운영 결정 Q42 — 행 클릭 모달 유지). */}
                <tr className="border-b border-border bg-bg-soft text-left text-[13px] font-semibold text-muted-foreground">
                  <th className="px-3 py-2">{t("col.prompt")}</th>
                </tr>
              </thead>
              <tbody>
                {page.rows.map((r) => {
                  const hasAnswers = r.answers.length > 0;
                  return (
                    <tr key={r.id} className={cn("border-t border-border first:border-t-0", hasAnswers && "cursor-pointer hover:bg-muted/40")} onClick={hasAnswers ? () => setSelected(r) : undefined}>
                      <td className="px-3 py-2 text-foreground">
                        <span className="group inline-flex items-start gap-1.5 text-left">
                          <MessageSquareText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-500" aria-hidden />
                          <span className={cn(hasAnswers && "underline-offset-2 group-hover:underline")}>{r.promptText}</span>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {win && win.pages > 1 ? <Pager win={win} onPage={(p) => nav.push({ page: String(p) })} /> : null}
      </div>
      <AnswerModal
        brand=""
        variant="citation"
        promptText={selected?.promptText ?? ""}
        answers={selected?.answers ?? []}
        open={selected !== null}
        onOpenChange={(o) => { if (!o) setSelected(null); }}
      />
    </div>
  );
}

export function useSubpageNav() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const href = (extra: Record<string, string>) => {
    const params = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(extra)) { if (v) params.set(k, v); else params.delete(k); }
    const qs = params.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  };
  const parent = pathname.replace(/\/(prompts|tone-urls)$/, "");
  const backParams = new URLSearchParams(sp.toString());
  for (const k of ["tab", "tone", "q", "page", "by"]) backParams.delete(k);
  const backQs = backParams.toString();
  return {
    href,
    push: (extra: Record<string, string>) => router.replace(href(extra), { scroll: false }),
    backHref: backQs ? `${parent}?${backQs}` : parent,
  };
}

export function TabLink({ active, href, children }: { active: boolean; href: string; children: React.ReactNode }) {
  return (
    <Link href={href} aria-current={active ? "page" : undefined} className={cn("-mb-px border-b-2 px-3 py-2 text-sm", active ? "border-foreground font-semibold text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
      {children}
    </Link>
  );
}

export function Pager({ win, onPage }: { win: ReturnType<typeof pageWindow>; onPage: (p: number) => void }) {
  const t = useTranslations("answerAnalysis.citations.v2.pager");
  return (
    <div className="flex items-center justify-end gap-2 text-xs">
      <Button type="button" variant="outline" size="sm" disabled={win.page <= 1} onClick={() => onPage(win.page - 1)}>{t("prev")}</Button>
      <span className="tabular-nums text-muted-foreground">{t("page", { page: win.page, pages: win.pages })}</span>
      <Button type="button" variant="outline" size="sm" disabled={win.page >= win.pages} onClick={() => onPage(win.page + 1)}>{t("next")}</Button>
    </div>
  );
}
