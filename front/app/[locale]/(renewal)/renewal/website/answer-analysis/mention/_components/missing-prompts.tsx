"use client";

import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { RnDrawer, RnSearchField, RnSegmented, RnTag } from "@/components/renewal-ui";
import type { MentionsPromptLive } from "@/lib/scope/result-adapter";
import { AnswerModal } from "@/app/[locale]/(dash)/standard/answer-analysis/_components/answer-modal";

// The 미언급 프롬프트 list (2026-10-30): the members of the KPI breakdown's 미언급 프롬프트 count — measured prompts
// where 당사 is in no answer, under the page's filters (/api/scope/missing-prompts → mention/drill-missing-prompts →
// Gold mentions/missing-prompts). Each row carries its answers in the window and the brand mentions those answers
// hold, so the list splits into prompts where the AI named other brands and prompts where it named none. A row opens
// the original answer view.

/** A row of the list: the prompt with its answers in the window and the brand mentions they hold (Gold sums). */
export interface MissingPromptRow extends MentionsPromptLive {
  answersTotal: number;
  brandMentions: number;
}

export type MissingSegment = "all" | "withBrands" | "noBrands";

type ListState = { status: "loading" } | { status: "error" } | { status: "ready"; rows: MissingPromptRow[]; total: number; counts?: { withBrands: number; noBrands: number } };

/** The route query: the page's filters on the website surface. */
export function missingPromptsQuery(spStr: string): string {
  const params = new URLSearchParams(spStr);
  params.set("surface", "website");
  return params.toString();
}

/** The rows of a segment matching the search (the list keeps the screen's order: most brand mentions first). */
export function segmentRows(rows: readonly MissingPromptRow[], segment: MissingSegment, search: string): MissingPromptRow[] {
  const q = search.trim().toLowerCase();
  return rows.filter(
    (r) =>
      (segment === "all" || (segment === "withBrands" ? r.brandMentions > 0 : r.brandMentions === 0)) &&
      (!q || r.promptText.toLowerCase().includes(q)),
  );
}

export function RnMissingPrompts({ open, onClose, ownLabel }: { open: boolean; onClose: () => void; ownLabel: string }) {
  const t = useTranslations("renewal.website.mention.missing");
  const tDrawer = useTranslations("renewal.mention.drawer");
  const tS = useTranslations("answerAnalysis.mentions.signalDrilldown");
  const tCut = useTranslations("answerAnalysis.mentions.kpi.overview.unmeasuredDialog");
  const sp = useSearchParams();
  const query = missingPromptsQuery(sp?.toString() ?? "");
  const [state, setState] = useState<ListState>({ status: "loading" });
  const [segment, setSegment] = useState<MissingSegment>("all");
  const [search, setSearch] = useState("");
  const deferred = useDeferredValue(search);
  const [answer, setAnswer] = useState<MissingPromptRow | null>(null);
  // the sheet comes back one task after the answer closes (the Escape that closed it does not reach the sheet)
  const [sheetHidden, setSheetHidden] = useState(false);

  useEffect(() => {
    if (!open) return;
    setState({ status: "loading" });
    const ctrl = new AbortController();
    fetch(`/api/scope/missing-prompts?${query}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("failed"))))
      .then((d: { prompts?: MissingPromptRow[]; total?: number; counts?: { withBrands: number; noBrands: number } }) =>
        setState({ status: "ready", rows: d.prompts ?? [], total: typeof d.total === "number" ? d.total : (d.prompts ?? []).length, counts: d.counts }),
      )
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setState({ status: "error" });
      });
    return () => ctrl.abort();
  }, [open, query]);

  const rows = useMemo(() => (state.status === "ready" ? state.rows : []), [state]);
  // the segments over every member (the screen's counts), not the loaded rows (the list stops at its limit)
  const counts = useMemo(() => {
    const whole = state.status === "ready" ? state.counts : undefined;
    return whole
      ? { all: whole.withBrands + whole.noBrands, ...whole }
      : { all: rows.length, withBrands: rows.filter((r) => r.brandMentions > 0).length, noBrands: rows.filter((r) => r.brandMentions === 0).length };
  }, [rows, state]);
  const shown = useMemo(() => segmentRows(rows, segment, deferred), [rows, segment, deferred]);
  const openAnswer = useCallback((r: MissingPromptRow) => {
    setSheetHidden(true);
    setAnswer(r);
  }, []);
  const closeAnswer = useCallback((o: boolean) => {
    if (o) return;
    setAnswer(null);
    setTimeout(() => setSheetHidden(false), 0);
  }, []);

  return (
    <>
      <RnDrawer open={open && !sheetHidden} onClose={onClose} closeLabel={tDrawer("close")} title={t("title")} subtitle={t("subtitle")}>
        {state.status === "loading" ? (
          <p className="m-0 rounded-lg bg-rn-page px-4 py-6 text-center text-rn-12 text-rn-muted">{tS("loading")}</p>
        ) : state.status === "error" ? (
          <p className="m-0 rounded-lg bg-rn-page px-4 py-6 text-center text-rn-12 text-rn-muted">{tS("error")}</p>
        ) : rows.length === 0 ? (
          <p className="m-0 rounded-lg bg-rn-page px-4 py-6 text-center text-rn-12 text-rn-muted">{t("empty")}</p>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <RnSegmented
                label={t("segment")}
                value={segment}
                onChange={setSegment}
                items={(["all", "withBrands", "noBrands"] as const).map((s) => ({
                  value: s,
                  label: (
                    <>
                      {t(s)} <span className="tabular-nums">{t("count", { count: counts[s].toLocaleString() })}</span>
                    </>
                  ),
                }))}
              />
              <RnSearchField value={search} onChange={setSearch} placeholder={t("search")} label={t("search")} className="min-w-[200px] flex-1" />
            </div>
            <p className="m-0 text-rn-11 text-rn-muted">
              {segment === "all" ? t("order") : t(segment === "withBrands" ? "withBrandsHint" : "noBrandsHint")}
            </p>
            {state.total > rows.length ? (
              <p className="m-0 text-rn-11 text-rn-muted">{tCut("truncated", { shown: rows.length, total: state.total })}</p>
            ) : null}
            {shown.length === 0 ? (
              <p className="m-0 rounded-lg bg-rn-page px-4 py-6 text-center text-rn-12 text-rn-muted">{t("noMatch")}</p>
            ) : (
              <ul className="m-0 flex list-none flex-col p-0">
                {shown.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      data-rn-missing={r.id}
                      onClick={() => openAnswer(r)}
                      className="flex w-full cursor-pointer flex-col gap-1 border-b border-rn-line px-1 py-2.5 text-left hover:bg-rn-navy-25 focus-visible:outline-2 focus-visible:outline-rn-navy"
                    >
                      <span className="text-rn-13 text-rn-ink">{r.promptText}</span>
                      <span className="flex flex-wrap items-center gap-1.5 text-rn-11 text-rn-muted tabular-nums">
                        {r.providers.map((p) => (
                          <RnTag key={p}>{p}</RnTag>
                        ))}
                        <span>{t("answers", { count: r.answersTotal.toLocaleString() })}</span>
                        <span aria-hidden>·</span>
                        <span className={r.brandMentions > 0 ? "font-semibold text-rn-ink-2" : undefined}>
                          {t("brandMentions", { count: r.brandMentions.toLocaleString() })}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </RnDrawer>
      {/* the original answer view (the answers named no 당사, so its count reads 0) */}
      <AnswerModal brand={ownLabel} promptText={answer?.promptText ?? ""} answers={answer?.answers ?? []} open={answer !== null} onOpenChange={closeAnswer} />
    </>
  );
}
