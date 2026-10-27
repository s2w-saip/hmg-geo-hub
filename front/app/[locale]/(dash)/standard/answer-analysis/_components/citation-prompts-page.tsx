"use client";

// 하위 페이지 — 공식 도메인 인용/미인용 프롬프트 전량 목록(디자인 580:1146).
// 탭·검색·페이지는 URL(`tab` · `q` · `page`)이 소유한다(필터 파라미터는 그대로 실려 온다).
// 행 클릭 → 기존 AnswerModal(citation variant).

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Loader2, MessageSquareText, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  FilterContentDim,
  FilterTransitionProvider,
  useFilterTransition,
} from "@/components/dash/filter-transition";
import type { CitationOwnedPromptPage } from "@/lib/db/repositories/scope-aggregates";
import { cn } from "@/lib/utils";
import type { PageWindow } from "../_data/citation-view";
import {
  applySearchEvent,
  buildSubpageHref,
  initSearchSync,
  receiveServerQuery,
  settleWithServerQuery,
  type SearchEventDeps,
} from "../_data/subpage-search";
import { AnswerModal } from "./answer-modal";

/**
 * API 원천(unit U7, D5)의 페이지: 오프셋 대신 키셋 커서다. `nextCursor` 가 실려 있으면 이 페이지는
 * 커서 모드로 넘긴다(다음 = 그 커서, 이전 = 이 화면이 기억한 커서 또는 첫 페이지, U7-N7).
 * `win` = 화면 API 가 계산한 페이지 창(페이지 수·표시 범위, pageWindow).
 */
export type CursorAware<P> = P & { nextCursor?: string | null; win: PageWindow };

export function CitationPromptsPage(props: {
  tab: "owned" | "uncited";
  page: CursorAware<CitationOwnedPromptPage> | null;
  q: string;
  ownedCount: number | null;
  uncitedCount: number | null;
}) {
  // 하위 페이지의 모든 URL 전이(검색·탭·스위치·페이저)가 **한 transition** 을 공유한다 →
  // 목록이 흐려지고 "재조회 중" 필이 뜬다(대시보드 필터 적용과 같은 짝).
  return (
    <FilterTransitionProvider>
      <PromptsView {...props} />
    </FilterTransitionProvider>
  );
}

function PromptsView({
  tab,
  page,
  q,
  ownedCount,
  uncitedCount,
}: {
  tab: "owned" | "uncited";
  page: CursorAware<CitationOwnedPromptPage> | null;
  q: string;
  ownedCount: number | null;
  uncitedCount: number | null;
}) {
  const t = useTranslations("answerAnalysis.citations.v2.promptsPage");
  const tKpi = useTranslations("answerAnalysis.mentions.kpi");
  const nav = useSubpageNav();
  const [selected, setSelected] = useState<CitationOwnedPromptPage["rows"][number] | null>(null);
  const win = page?.win ?? null;
  const cursorNav = useCursorPaging(page);

  return (
    <div className="flex flex-col gap-4">
      <Link href={nav.backHref} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> {t("back")}
      </Link>
      <div className="flex gap-1 border-b border-border">
        <TabLink active={tab === "owned"} href={nav.href({ tab: "owned", page: "1" })}>{t("ownedTab", { n: ownedCount ?? "—" })}</TabLink>
        <TabLink active={tab === "uncited"} href={nav.href({ tab: "uncited", page: "1" })}>{t("uncitedTab", { n: uncitedCount ?? "—" })}</TabLink>
      </div>
      {/* 컨트롤 행(검색·범위)은 **dim 밖**이다 — 왕복 중에도 계속 입력할 수 있어야
          한다(대시보드 필터바가 dim 밖인 것과 같은 이유). 흐려지는 것은 옛 숫자를
          보여주는 목록·페이저뿐이다. */}
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SubpageSearchBox q={q} label={t("search")} />
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
            <table className="w-full text-sm">
              <thead>
                {/* 피그마 580:1146: '프롬프트' 단일 컬럼(제품 결정 Q42 — 행 클릭 모달 유지). */}
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
        {win && win.pages > 1 ? (
          <Pager win={win} onPage={cursorNav ? cursorNav.go : (p) => nav.push({ page: String(p) })} hasNext={cursorNav?.hasNext} />
        ) : null}
          </div>
        </FilterContentDim>
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

/**
 * 하위 페이지 검색창 — **Enter 또는 검색 버튼**으로 URL 에 반영한다(2026-09-17 제품 결정).
 *
 * 타이핑만으로는 서버 왕복을 만들지 않는다(종전 250ms 디바운스 폐지). 예외: 입력을
 * **다 지우면** 즉시 빈 값을 커밋해 필터 해제를 반영한다 — 2026-09-16 GGMD QA
 * "검색어 삭제 시 바로 반영이 안 됨"의 재발 방지. 이미 커밋된 값과 같으면 왕복하지
 * 않는다(버튼 중복 클릭 무해). 규약과 그 테스트는 `../_data/subpage-search.ts`.
 *
 * 전량이 클라이언트에 있지 않다(서버 페이징 50건/쪽) — 그래서 로컬 필터가 아니라
 * 서버 재조회다. 대신 왕복 동안 `FilterContentDim` 이 목록을 흐리고 이 입력창이
 * 스피너를 보여준다("안 바뀐다"는 오인 방지).
 */
export function SubpageSearchBox({ q, label }: { q: string; label: string }) {
  const t = useTranslations("answerAnalysis.citations.v2.subpageSearch");
  const nav = useSubpageNav();
  const [sync, setSync] = useState(() => initSearchSync(q));
  // 이벤트 핸들러가 같은 틱에 연달아 읽을 수 있게 최신 상태를 ref 로도 든다.
  const syncRef = useRef(sync);
  syncRef.current = sync;

  // 핸들러 본문(상태 반영·push 조건)은 `applySearchEvent` 가 전부 갖는다 — 행동 테스트는
  // subpage-search.test.ts, 두 핸들러가 그것을 부른다는 배선은 렌더 테스트가 고정한다.
  const deps: SearchEventDeps = { ref: syncRef, setSync, push: nav.push };

  // 서버가 준 q 를 입력창에 반영한다.
  // - 전이 중(pending): 우리 커밋의 왕복이 진행 중이므로, 다른 q 가 오면 늦게 온
  //   옛 응답으로 보고 무시한다(최신 입력을 덮지 않는다).
  // - 전이가 끝났으면: 우리 커밋은 더는 진행 중이 아니다 → in-flight 를 풀고 그
  //   시점의 서버 q 를 채택한다. 이래야 in-flight 중에 들어온 뒤로가기도 회수된다.
  const pending = nav.pending;
  useEffect(() => {
    setSync((s) => (pending ? receiveServerQuery(s, q) : settleWithServerQuery(s, q)));
  }, [q, pending]);

  return (
    <form
      role="search"
      className="flex w-full items-center gap-2 sm:w-auto"
      onSubmit={(e) => {
        e.preventDefault();
        applySearchEvent({ kind: "submit" }, deps);
      }}
    >
      <div className="relative min-w-0 flex-1 sm:w-72 sm:flex-none">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          value={sync.draft}
          // 다 지운 순간만 즉시 커밋 — 그 외 타이핑은 Enter·버튼을 기다린다(리듀서 규약).
          onChange={(e) => applySearchEvent({ kind: "input", value: e.target.value }, deps)}
          placeholder={label}
          aria-label={label}
          className="h-8 pr-8 pl-8 text-xs"
        />
        {pending ? (
          <Loader2 className="pointer-events-none absolute top-1/2 right-2.5 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-brand-700" aria-hidden />
        ) : null}
      </div>
      <Button type="submit" variant="outline" size="sm" className="text-xs">
        {t("submit")}
      </Button>
    </form>
  );
}

/**
 * 하위 페이지의 URL 소유권. 모든 전이는 transition 안에서 일어나므로 `pending` 하나로
 * 입력창 스피너와 본문 dim 이 같은 상태를 본다. 프로바이더가 있으면 그것을 공유하고
 * (탭·스위치·검색이 한 상태), 없으면 로컬로 떨어진다 — dimension-filter-panel 과 동일.
 */
export function useSubpageNav() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const shared = useFilterTransition();
  const [localPending, localStart] = useTransition();
  const pending = shared?.isPending ?? localPending;
  const startTransition = shared?.startTransition ?? localStart;
  const search = sp.toString();
  // 커서(API 원천, D5)는 그 커서를 만든 검색·탭·스위치에만 유효하다: 커서를 명시하지 않은
  // 전이는 전부 커서를 지운다(남기면 백엔드가 422 cursor_invalid). legacy URL 에는 커서가 없다.
  const href = (extra: Record<string, string>) =>
    buildSubpageHref(pathname, search, "cursor" in extra ? extra : { ...extra, cursor: "" });
  const parent = pathname.replace(/\/(prompts|tone-urls)$/, "");
  const backParams = new URLSearchParams(search);
  for (const k of ["tab", "tone", "q", "page", "by", "cursor"]) backParams.delete(k);
  const backQs = backParams.toString();
  return {
    href,
    pending,
    push: (extra: Record<string, string>) => {
      startTransition(() => {
        router.replace(href(extra), { scroll: false });
      });
    },
    // 탭 이동 — 종전 `<Link>` 기본 동작(상단 스크롤)을 유지한다. `push` 와 달리
    // scroll 옵션을 넘기지 않는다(검증자 F4).
    navigate: (to: string) => {
      startTransition(() => {
        router.push(to);
      });
    },
    backHref: backQs ? `${parent}?${backQs}` : parent,
  };
}

export function TabLink({ active, href, children }: { active: boolean; href: string; children: React.ReactNode }) {
  const nav = useSubpageNav();
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      // 평범한 좌클릭만 가로채 공유 transition 으로 보낸다 — 그래야 탭 이동도 본문
      // dim·스피너가 뜬다(QA: "탭 이동 시 반응 속도가 느려 버그로 오인"). 새 탭 열기
      // (⌘/Ctrl/Shift/Alt·가운데 클릭)는 그대로 브라우저에 맡긴다.
      onClick={(e) => {
        if (active || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        nav.navigate(href);
      }}
      className={cn("-mb-px border-b-2 px-3 py-2 text-sm", active ? "border-foreground font-semibold text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}
    >
      {children}
    </Link>
  );
}

export function Pager({
  win,
  onPage,
  hasNext,
}: {
  win: PageWindow;
  onPage: (p: number) => void;
  /** 커서 모드: 다음 커서가 있는가(없으면 총계로 판정하는 종전 규칙). */
  hasNext?: boolean;
}) {
  const t = useTranslations("answerAnalysis.citations.v2.pager");
  const nextDisabled = hasNext === undefined ? win.page >= win.pages : !hasNext;
  return (
    <div className="flex items-center justify-end gap-2 text-xs">
      <Button type="button" variant="outline" size="sm" disabled={win.page <= 1} onClick={() => onPage(win.page - 1)}>{t("prev")}</Button>
      <span className="tabular-nums text-muted-foreground">{t("page", { page: win.page, pages: win.pages })}</span>
      <Button type="button" variant="outline" size="sm" disabled={nextDisabled} onClick={() => onPage(win.page + 1)}>{t("next")}</Button>
    </div>
  );
}

/**
 * 커서 페이지 이동(API 원천). 다음 = 서버가 준 커서, 이전 = 이 화면에서 지나온 커서(검색·탭·필터가
 * 바뀌면 비운다). 직접 연 URL 처럼 기억이 없으면 이전은 첫 페이지로 간다(U7-N7). 페이지 번호는
 * 범위 표시(from~to / 총계)를 위해 커서와 함께 URL 에 싣는다. legacy 페이지(nextCursor 없음)면 null.
 */
export function useCursorPaging(page: { page: number; nextCursor?: string | null } | null): {
  go: (p: number) => void;
  hasNext: boolean;
} | null {
  const nav = useSubpageNav();
  const sp = useSearchParams();
  const current = sp.get("cursor");
  const baseParams = new URLSearchParams(sp.toString());
  baseParams.delete("cursor");
  baseParams.delete("page");
  const base = baseParams.toString();
  const memory = useRef<{ base: string; cursors: (string | null)[] }>({ base, cursors: [] });
  if (memory.current.base !== base) memory.current = { base, cursors: [] };
  if (!page || page.nextCursor === undefined) return null;
  const next = page.nextCursor;
  return {
    hasNext: Boolean(next),
    go: (p: number) => {
      const step = cursorPagingStep({ page: page.page, next, current, cursors: memory.current.cursors }, p);
      if (!step) return;
      if (step.remember) memory.current.cursors[step.remember.index] = step.remember.cursor;
      nav.push(step.push);
    },
  };
}

/**
 * 커서 페이지 이동 한 걸음(순수 함수, useCursorPaging 이 쓴다). 다음 = 서버 커서로 가고 지금
 * 커서를 기억한다(`cursors[i]` = i+1 쪽을 연 커서, 첫 쪽은 null). 이전 = 기억한 커서, 기억이
 * 없으면(직접 연 URL) 첫 페이지. 다음 커서가 없거나 같은 쪽이면 null(이동 없음).
 */
export function cursorPagingStep(
  s: { page: number; next: string | null; current: string | null; cursors: readonly (string | null)[] },
  p: number,
): { push: { cursor: string; page: string }; remember?: { index: number; cursor: string | null } } | null {
  if (p > s.page) {
    if (!s.next) return null;
    return { push: { cursor: s.next, page: String(s.page + 1) }, remember: { index: s.page - 1, cursor: s.current } };
  }
  if (p < s.page) {
    const back = s.cursors[p - 1];
    if (p <= 1 || back === undefined) return { push: { cursor: "", page: "1" } };
    return { push: { cursor: back ?? "", page: String(p) } };
  }
  return null;
}
