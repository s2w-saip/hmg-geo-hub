"use client";

// Renewal Citation sub pages — 공식(당사) URL 인용/미인용 프롬프트 and 긍정/부정 답변에 인용된 URL.
// Same URL contract and behaviour as the originals (citation-prompts-page.tsx /
// citation-tone-urls-page.tsx): tab · q · page · by · cursor live in the URL, search commits on
// Enter or the button (or at once when cleared), cursor paging on the api source, tone tab counts
// reused across in-page moves (B045). Only the presentation is the renewal card anatomy.

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { ArrowLeft, ExternalLink, Loader2, MessageSquareText, Search } from "lucide-react";
import { RnButton, RnCard, RnCardHead, RnTag, cx } from "@/components/renewal-ui";
import { FilterContentDim, FilterTransitionProvider } from "@/components/dash/filter-transition";
import { AnswerModal } from "@/app/[locale]/(dash)/standard/answer-analysis/_components/answer-modal";
import { useCursorPaging, useSubpageNav, type CursorAware } from "@/app/[locale]/(dash)/standard/answer-analysis/_components/citation-prompts-page";
import { recallToneCounts, rememberToneCounts, toneCountsKey, type ToneCounts } from "@/app/[locale]/(dash)/standard/answer-analysis/_components/citation-tone-urls-page";
import type { PageWindow } from "@/app/[locale]/(dash)/standard/answer-analysis/_data/citation-view";
import { applySearchEvent, initSearchSync, receiveServerQuery, settleWithServerQuery, type SearchEventDeps } from "@/app/[locale]/(dash)/standard/answer-analysis/_data/subpage-search";
import type { CitationOwnedPromptPage, CitationTone, CitationToneUrlPage } from "@/lib/db/repositories/scope-aggregates";
import { displayCitationUrl } from "@/lib/url-display";
import { engineLabel, useCatLabel } from "./citation-context";
import { numTxt } from "../../mention/_components/mention-context";
import { useDegradedText } from "../../mention/_components/mention-kit";

// ── shared pieces ────────────────────────────────────────────────────────────

function Back({ label }: { label: string }) {
  const nav = useSubpageNav();
  return (
    <Link prefetch={false} href={nav.backHref} className="inline-flex w-fit items-center gap-1 text-rn-12 font-semibold text-rn-muted no-underline hover:text-rn-ink">
      <ArrowLeft className="size-3.5" aria-hidden />
      {label}
    </Link>
  );
}

/** Tabs as links (the original TabLink: plain left clicks go through the shared transition). */
function SubTabs({ items, label }: { items: ReadonlyArray<{ key: string; active: boolean; href: string; label: ReactNode }>; label: string }) {
  const nav = useSubpageNav();
  return (
    <nav aria-label={label} className="inline-flex w-fit rounded-[9px] bg-rn-inset p-[3px]">
      {items.map((it) => (
        <Link prefetch={false}
          key={it.key}
          href={it.href}
          data-rn-subtab={it.key}
          aria-current={it.active ? "page" : undefined}
          onClick={(e) => {
            if (it.active || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
            e.preventDefault();
            nav.navigate(it.href);
          }}
          className={cx(
            "inline-flex h-8 items-center rounded-md px-3.5 text-rn-13 whitespace-nowrap no-underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-rn-navy",
            it.active ? "bg-rn-surface font-bold text-rn-ink shadow-rn-1" : "font-medium text-rn-muted hover:text-rn-ink",
          )}
        >
          {it.label}
        </Link>
      ))}
    </nav>
  );
}

/** The original SubpageSearchBox's rules (subpage-search.ts) in renewal dress. */
function SubSearch({ q, label }: { q: string; label: string }) {
  const t = useTranslations("answerAnalysis.citations.v2.subpageSearch");
  const nav = useSubpageNav();
  const [sync, setSync] = useState(() => initSearchSync(q));
  const syncRef = useRef(sync);
  syncRef.current = sync;
  const deps: SearchEventDeps = { ref: syncRef, setSync, push: nav.push };
  const pending = nav.pending;
  useEffect(() => {
    setSync((s) => (pending ? receiveServerQuery(s, q) : settleWithServerQuery(s, q)));
  }, [q, pending]);
  return (
    <form
      role="search"
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        applySearchEvent({ kind: "submit" }, deps);
      }}
    >
      <span className="relative inline-flex w-[280px] max-w-full items-center">
        <Search aria-hidden className="pointer-events-none absolute left-2.5 size-3.5 text-rn-muted" />
        <input
          value={sync.draft}
          onChange={(e) => applySearchEvent({ kind: "input", value: e.target.value }, deps)}
          placeholder={label}
          aria-label={label}
          className="h-8 w-full rounded-md border border-rn-line-2 bg-rn-surface pr-8 pl-8 text-rn-13 text-rn-ink outline-none focus:border-rn-navy focus:ring-3 focus:ring-rn-navy/12"
        />
        {pending ? <Loader2 aria-hidden className="pointer-events-none absolute right-2.5 size-3.5 animate-spin text-rn-navy" /> : null}
      </span>
      <RnButton type="submit">{t("submit")}</RnButton>
    </form>
  );
}

function SubPager({ win, onPage, hasNext }: { win: PageWindow; onPage: (p: number) => void; hasNext?: boolean }) {
  const t = useTranslations("answerAnalysis.citations.v2.pager");
  const locale = useLocale();
  const nextDisabled = hasNext === undefined ? win.page >= win.pages : !hasNext;
  return (
    <div className="flex items-center justify-end gap-2 px-6 pb-4 text-rn-12">
      <RnButton disabled={win.page <= 1} onClick={() => onPage(win.page - 1)}>
        {t("prev")}
      </RnButton>
      <span className="text-rn-muted tabular-nums">{t("page", { page: numTxt(win.page, locale), pages: numTxt(win.pages, locale) })}</span>
      <RnButton disabled={nextDisabled} onClick={() => onPage(win.page + 1)}>
        {t("next")}
      </RnButton>
    </div>
  );
}

const EMPTY = "m-0 px-6 py-10 text-center text-rn-13 text-rn-muted";

/** "4,951–5,000 / 총 5,646개": the window and total grouped like the tab counts (an ICU simple argument prints a
 * number as String(n), "총 5646개"). */
function rangeArgs(win: PageWindow, total: number, locale: string) {
  return { from: numTxt(win.from, locale), to: numTxt(win.to, locale), total: numTxt(total, locale) };
}

// ── 공식(당사) URL 인용/미인용 프롬프트 ─────────────────────────────────────────

type PromptRow = CitationOwnedPromptPage["rows"][number];

export function RnCitationPromptsView(props: { tab: "owned" | "uncited"; page: CursorAware<CitationOwnedPromptPage> | null; q: string; ownedCount: number | null; uncitedCount: number | null }) {
  return (
    <FilterTransitionProvider>
      <PromptsView {...props} />
    </FilterTransitionProvider>
  );
}

function PromptsView({ tab, page, q, ownedCount, uncitedCount }: { tab: "owned" | "uncited"; page: CursorAware<CitationOwnedPromptPage> | null; q: string; ownedCount: number | null; uncitedCount: number | null }) {
  const t = useTranslations("answerAnalysis.citations.v2.promptsPage");
  const tR = useTranslations("renewal.citation.sub");
  const degradedText = useDegradedText();
  const locale = useLocale();
  const nav = useSubpageNav();
  const [selected, setSelected] = useState<PromptRow | null>(null);
  const win = page?.win ?? null;
  const cursorNav = useCursorPaging(page);
  return (
    <div className="flex flex-col gap-4">
      <Back label={t("back")} />
      <SubTabs
        label={t("title")}
        items={[
          { key: "owned", active: tab === "owned", href: nav.href({ tab: "owned", page: "1" }), label: t("ownedTab", { n: numTxt(ownedCount, locale) }) },
          { key: "uncited", active: tab === "uncited", href: nav.href({ tab: "uncited", page: "1" }), label: t("uncitedTab", { n: numTxt(uncitedCount, locale) }) },
        ]}
      />
      <RnCard aria-label={t("title")}>
        <RnCardHead title={tR(tab === "owned" ? "ownedTitle" : "uncitedTitle")} sub={tR(tab === "owned" ? "ownedSub" : "uncitedSub")} />
        <div className="flex flex-wrap items-center justify-between gap-3 px-6 pb-3">
          <SubSearch q={q} label={t("search")} />
          {win ? <span className="text-rn-12 text-rn-muted tabular-nums">{t("range", rangeArgs(win, page!.total, locale))}</span> : null}
        </div>
        <FilterContentDim>
          {page == null ? (
            <p className={EMPTY}>{degradedText.all}</p>
          ) : page.rows.length === 0 ? (
            <p className={EMPTY}>{t("empty")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] border-collapse text-rn-13" data-rn-subtable="prompts">
                <thead className="border-y border-rn-line bg-rn-page">
                  <tr>
                    <th scope="col" className="px-6 py-2 text-left text-rn-12 font-semibold text-rn-muted">{t("col.prompt")}</th>
                    <th scope="col" title={tR("colCitationsTip")} className="w-28 px-3 py-2 text-right text-rn-12 font-semibold text-rn-muted">
                      {tR("colCitations")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {page.rows.map((r) => {
                    const has = r.answers.length > 0;
                    return (
                      <tr
                        key={r.id}
                        data-rn-prow={r.id}
                        tabIndex={has ? 0 : undefined}
                        onClick={has ? () => setSelected(r) : undefined}
                        onKeyDown={
                          has
                            ? (e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  setSelected(r);
                                }
                              }
                            : undefined
                        }
                        className={cx("border-b border-rn-line", has && "cursor-pointer hover:bg-rn-navy-25 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-rn-navy")}
                      >
                        <td className="px-6 py-2.5">
                          <span className="flex min-w-0 flex-col gap-1">
                            <span className="inline-flex items-start gap-1.5 text-rn-ink">
                              {has ? <MessageSquareText className="mt-0.5 size-3.5 shrink-0 text-rn-navy" aria-hidden /> : null}
                              {r.promptText}
                            </span>
                            <span className="flex flex-wrap gap-1 text-rn-11 text-rn-muted">
                              {r.funnelStage ? <RnTag className="bg-rn-page text-rn-ink-2">{r.funnelStage}</RnTag> : null}
                              {r.providers.map((p) => (
                                <span key={p} className="rounded bg-rn-page px-1.5">
                                  {engineLabel(p)}
                                </span>
                              ))}
                            </span>
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-right font-semibold text-rn-ink tabular-nums">{numTxt(r.citations, locale)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {win && win.pages > 1 ? <div className="pt-3.5"><SubPager win={win} onPage={cursorNav ? cursorNav.go : (p) => nav.push({ page: String(p) })} hasNext={cursorNav?.hasNext} /></div> : <div className="h-3" />}
        </FilterContentDim>
      </RnCard>
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

// ── 긍정/부정 답변에 인용된 URL ───────────────────────────────────────────────

const NO_COUNTS: ToneCounts = { positive: null, negative: null };

/** Counts to draw: the server's, else the last ones for the same filters (B045), else "—". */
function useShownToneCounts(served: ToneCounts | null): ToneCounts {
  const sp = useSearchParams();
  const key = toneCountsKey(sp.toString());
  const last = useRef<{ key: string; counts: ToneCounts } | null>(null);
  if (served && typeof served.positive === "number" && typeof served.negative === "number") last.current = { key, counts: served };
  useEffect(() => {
    if (served) rememberToneCounts(key, served);
  }, [key, served]);
  if (served) return served;
  if (last.current?.key === key) return last.current.counts;
  return recallToneCounts(key) ?? NO_COUNTS;
}

type ToneProps = { tone: CitationTone; page: CursorAware<CitationToneUrlPage> | null; q: string; byDomain: boolean; counts: ToneCounts | null };

export function RnCitationToneUrlsView(props: ToneProps) {
  return (
    <FilterTransitionProvider>
      <ToneView {...props} />
    </FilterTransitionProvider>
  );
}

function ToneView({ tone, page, q, byDomain, counts: served }: ToneProps) {
  const counts = useShownToneCounts(served);
  const t = useTranslations("answerAnalysis.citations.v2.toneUrlsPage");
  const tR = useTranslations("renewal.citation.sub");
  const degradedText = useDegradedText();
  const locale = useLocale();
  const cat = useCatLabel();
  const nav = useSubpageNav();
  const win = page?.win ?? null;
  const cursorNav = useCursorPaging(page);
  return (
    <div className="flex flex-col gap-4">
      <Back label={t("back")} />
      <SubTabs
        label={t("title")}
        items={[
          { key: "positive", active: tone === "positive", href: nav.href({ tone: "positive", page: "1" }), label: t("positiveTab", { n: numTxt(counts.positive, locale) }) },
          { key: "negative", active: tone === "negative", href: nav.href({ tone: "negative", page: "1" }), label: t("negativeTab", { n: numTxt(counts.negative, locale) }) },
        ]}
      />
      <RnCard aria-label={t("title")}>
        <RnCardHead title={tR(tone === "positive" ? "positiveTitle" : "negativeTitle")} sub={tR(tone === "positive" ? "positiveSub" : "negativeSub")} />
        <div className="flex flex-wrap items-center justify-between gap-3 px-6 pb-3">
          <span className="flex flex-wrap items-center gap-3.5">
            <SubSearch q={q} label={t("search")} />
            <label className="inline-flex cursor-pointer items-center gap-2 text-rn-13 font-semibold text-rn-ink-2">
              {t("byDomain")}
              <button
                type="button"
                role="switch"
                aria-checked={byDomain}
                aria-label={t("byDomain")}
                data-rn-bydomain=""
                onClick={() => nav.push({ by: byDomain ? "" : "domain", page: "1" })}
                className={cx("relative h-[18px] w-[34px] cursor-pointer rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rn-navy", byDomain ? "bg-rn-navy" : "bg-rn-line-2")}
              >
                <span className={cx("absolute top-[2px] left-[2px] size-3.5 rounded-full bg-white shadow transition-transform", byDomain && "translate-x-4")} />
              </button>
            </label>
          </span>
          {win ? <span className="text-rn-12 text-rn-muted tabular-nums">{t("range", rangeArgs(win, page!.total, locale))}</span> : null}
        </div>
        <FilterContentDim>
          {page == null ? (
            <p className={EMPTY}>{degradedText.all}</p>
          ) : page.rows.length === 0 ? (
            <p className={EMPTY}>{t("empty")}</p>
          ) : (
            <ul className="m-0 flex list-none flex-col border-t border-rn-line p-0" data-rn-subtable="tone">
              {page.rows.map((r, i) => (
                <li key={`${r.domain}|${r.url ?? ""}|${i}`} className="flex flex-col gap-1 border-b border-rn-line px-6 py-2.5">
                  <span className="flex items-start justify-between gap-3">
                    <span className="line-clamp-2 min-w-0 text-rn-13 font-semibold text-rn-ink">{r.title || r.domain}</span>
                    <span className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                      <span className="rounded bg-rn-page px-1.5 py-0.5 text-rn-11 text-rn-ink-2">{r.category ? cat(r.category) : "—"}</span>
                      {r.providers.map((p) => (
                        <span key={p} className="rounded bg-rn-page px-1.5 py-0.5 text-rn-11 text-rn-muted">
                          {engineLabel(p)}
                        </span>
                      ))}
                    </span>
                  </span>
                  {r.url ? (
                    <a href={r.url} target="_blank" rel="noopener noreferrer" className="flex items-start gap-1 text-rn-12 break-all text-rn-navy hover:underline">
                      <span className="min-w-0">{displayCitationUrl(r.url)}</span>
                      <ExternalLink className="mt-0.5 size-3 shrink-0" aria-hidden />
                    </a>
                  ) : (
                    <span className="text-rn-12 text-rn-muted">
                      {t("col.domain")}: {r.domain}
                    </span>
                  )}
                  <span className="text-rn-11 text-rn-muted">
                    {r.promptText ? `“${r.promptText}” · ` : ""}
                    {t("cites", { n: numTxt(r.citations, locale) })}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {win && win.pages > 1 ? <div className="pt-3.5"><SubPager win={win} onPage={cursorNav ? cursorNav.go : (p) => nav.push({ page: String(p) })} hasNext={cursorNav?.hasNext} /></div> : <div className="h-3" />}
        </FilterContentDim>
      </RnCard>
    </div>
  );
}
