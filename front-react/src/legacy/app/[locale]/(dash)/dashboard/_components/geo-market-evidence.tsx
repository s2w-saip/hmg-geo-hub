"use client";

import { browserFetch as fetch } from "~/api/browser-fetch";

// The renewal Overview's 근거 drawer (2026-11-05, D-12 step 3, the mockup in f9c0fcd · design-rules
// '숫자를 누르면'): a KPI cell of the 시장별 현황 table opens the answers behind its value. The sample line is the row's
// own counts (num / den = the value); the tabs are the KPI's split of the market's representative answers — the
// answers in its numerator and the rest of its denominator — each with its answer count; 50 rows a page, prompt order.
// A row shows the answer's own mark for the KPI and an excerpt around 당사's first occurrence (Gold's offsets) and opens
// the original answer view. /api/scope/market-evidence → overview/market-evidence → Gold answers (split · marks).

import { useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "use-intl";
import { useSearchParams } from "~/app/navigation";
import { RnButton, RnDrawer, RnTabs } from "@/components/renewal-ui";
import { SUPPORT } from "@/lib/support-contact";
import { countryName } from "@/lib/geo-catalog";
import { AnswerModal } from "@/app/[locale]/(dash)/standard/answer-analysis/_components/answer-modal";
import type { DrillAnswer } from "@/app/[locale]/(dash)/standard/answer-analysis/_data/drilldown-screen-types";
import type { GeoKpiCount } from "../_data/screen-types";
import type { OverviewKpiKey } from "../_data/overview-metrics";

export type EvidenceSide = "num" | "rest";

/** What a pressed cell opens: the KPI, the market's countries (a region row: all of its countries) and its row. */
export interface MarketEvidenceTarget {
  kpi: OverviewKpiKey;
  codes: string[];
  /** the market's name (a country, or a region with its country count) */
  market: string;
  value: number | null;
  counts: GeoKpiCount | null;
}

/** A drawer row (overview/market-evidence). */
export interface EvidenceRow {
  id: string;
  prompt: string;
  engine: string;
  country: string | null;
  lang: string | null;
  measuredAt: string | null;
  ownMentions: number;
  brandMentions: number;
  rank: number | null;
  sentiment: { positive: number | null; negative: number | null; all: number | null };
  citations: { official: number; all: number };
  excerpt: { before: string; mark: string | null; after: string; cutStart: boolean; cutEnd: boolean } | null;
  answer: DrillAnswer;
}

type Page = { items: EvidenceRow[]; total: number; nextCursor: string | null; counts?: Record<EvidenceSide, number> };
type ListState = { status: "loading" } | { status: "error" } | { status: "ready"; rows: EvidenceRow[]; total: number; next: string | null; more: "idle" | "loading" | "error" };

/** The route query: the page's filters (the table's view keys left out) + the market's countries, the KPI, the tab. */
export function marketEvidenceQuery(spStr: string, target: Pick<MarketEvidenceTarget, "kpi" | "codes">, side: EvidenceSide, cursor = "0"): string {
  const params = new URLSearchParams(spStr);
  for (const k of ["mkt", "mktDir", "mktView", "market", "kpi", "side", "cursor"]) params.delete(k);
  for (const code of target.codes) params.append("market", code);
  params.set("kpi", target.kpi);
  params.set("side", side);
  if (cursor !== "0") params.set("cursor", cursor);
  return params.toString();
}

const KST_DAY = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" });
const dayOf = (iso: string | null) => (iso ? KST_DAY.format(new Date(iso)) : null);
const n0 = (n: number | null | undefined) => (n ?? 0).toLocaleString("ko-KR");

export function GeoMarketEvidence({ target, ownLabel, onClose }: { target: MarketEvidenceTarget | null; ownLabel: string; onClose: () => void }) {
  const t = useTranslations("renewal.overview.markets.evidence");
  const tKpi = useTranslations("dashboard.kpi.name");
  const tUnit = useTranslations("metricUnit");
  const tDrawer = useTranslations("renewal.mention.drawer");
  const locale = useLocale();
  const sp = useSearchParams();
  const spStr = sp?.toString() ?? "";
  const [side, setSide] = useState<EvidenceSide>("num");
  const [counts, setCounts] = useState<Record<EvidenceSide, number> | null>(null);
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [answer, setAnswer] = useState<EvidenceRow | null>(null);
  // the sheet comes back one task after the answer closes (the Escape that closed it does not reach the sheet)
  const [sheetHidden, setSheetHidden] = useState(false);
  const open = target !== null;

  // a new cell opens on its numerator tab
  useEffect(() => {
    setSide("num");
    setCounts(null);
  }, [target]);

  useEffect(() => {
    if (!target) return;
    setList({ status: "loading" });
    const ctrl = new AbortController();
    fetch(`/api/scope/market-evidence?${marketEvidenceQuery(spStr, target, side)}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("failed"))))
      .then((d: Page) => {
        if (d.counts) setCounts(d.counts);
        setList({ status: "ready", rows: d.items ?? [], total: d.total ?? 0, next: d.nextCursor ?? null, more: "idle" });
      })
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setList({ status: "error" });
      });
    return () => ctrl.abort();
  }, [target, side, spStr]);

  const loadMore = useCallback(() => {
    if (!target || list.status !== "ready" || !list.next) return;
    const cursor = list.next;
    setList({ ...list, more: "loading" });
    fetch(`/api/scope/market-evidence?${marketEvidenceQuery(spStr, target, side, cursor)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("failed"))))
      .then((d: Page) =>
        setList((cur) => (cur.status === "ready" ? { status: "ready", rows: [...cur.rows, ...(d.items ?? [])], total: d.total ?? cur.total, next: d.nextCursor ?? null, more: "idle" } : cur)),
      )
      .catch(() => setList((cur) => (cur.status === "ready" ? { ...cur, more: "error" } : cur)));
  }, [target, list, spStr, side]);

  const openAnswer = useCallback((r: EvidenceRow) => {
    setSheetHidden(true);
    setAnswer(r);
  }, []);
  const closeAnswer = useCallback((o: boolean) => {
    if (o) return;
    setAnswer(null);
    setTimeout(() => setSheetHidden(false), 0);
  }, []);

  if (!target) return null;
  const kpi = target.kpi;
  const fmt = (v: number | null) => (v == null ? "—" : kpi === "position" ? tUnit("position", { n: v.toFixed(1) }) : `${v.toFixed(1)}%`);
  const c = target.counts;
  const sample =
    c == null
      ? null
      : "sum" in c
        ? t("sample.position", { count: n0(c.count), value: fmt(target.value) })
        : t(`sample.${kpi as Exclude<OverviewKpiKey, "position">}`, { num: n0(c.num), den: n0(c.den), value: fmt(target.value), own: ownLabel });
  const mark = (r: EvidenceRow) => {
    switch (kpi) {
      case "visibility":
        return r.ownMentions > 0 ? t("mark.mentions", { n: n0(r.ownMentions) }) : t("mark.noOwn", { n: n0(r.brandMentions) });
      case "shareOfVoice":
        return t("mark.share", { own: n0(r.ownMentions), total: n0(r.brandMentions) });
      case "sentiment":
        return t("mark.sentiment", { all: n0(r.sentiment.all), positive: n0(r.sentiment.positive), negative: n0(r.sentiment.negative) });
      case "position":
        return r.rank != null ? t("mark.rank", { n: r.rank }) : t("mark.noRank");
      case "citationShare":
        return t("mark.citations", { own: ownLabel, official: n0(r.citations.official), all: n0(r.citations.all) });
    }
  };

  return (
    <>
      <RnDrawer
        open={open && !sheetHidden}
        onClose={onClose}
        closeLabel={tDrawer("close")}
        wide
        title={t("title")}
        subtitle={t("subtitle", { kpi: tKpi(kpi), own: ownLabel, market: target.market })}
      >
        <div className="flex flex-col gap-3" data-rn-market-evidence={kpi}>
          {sample ? <p className="m-0 text-rn-14 font-semibold text-rn-ink tabular-nums" data-rn-evidence-sample="">{sample}</p> : null}
          <RnTabs<EvidenceSide>
            label={t("tabs")}
            value={side}
            onChange={setSide}
            items={(["num", "rest"] as const).map((s) => ({
              value: s,
              label: t(`tab.${kpi}.${s}`, { own: ownLabel }),
              count: counts ? t("count", { n: n0(counts[s]) }) : undefined,
            }))}
          />
          <p className="m-0 text-rn-11 text-rn-muted">
            {kpi === "shareOfVoice" || kpi === "sentiment" || kpi === "citationShare" ? `${t("unitNote")} ` : null}
            {t("order")}
          </p>
          {list.status === "loading" ? (
            <p className="m-0 rounded-lg bg-rn-page px-4 py-6 text-center text-rn-12 text-rn-muted">{t("loading")}</p>
          ) : list.status === "error" ? (
            <p role="alert" className="m-0 rounded-lg bg-rn-page px-4 py-6 text-center text-rn-12 text-rn-ink-2">{t("error", SUPPORT)}</p>
          ) : list.rows.length === 0 ? (
            <p className="m-0 rounded-lg bg-rn-page px-4 py-6 text-center text-rn-12 text-rn-muted">{t("empty")}</p>
          ) : (
            <>
              <ul className="m-0 flex list-none flex-col p-0">
                {list.rows.map((r) => (
                  <li key={r.id} className="border-b border-rn-line">
                    <button
                      type="button"
                      data-rn-evidence-row={r.id}
                      onClick={() => openAnswer(r)}
                      className="flex w-full cursor-pointer flex-col gap-1 px-1 py-2.5 text-left hover:bg-rn-navy-25 focus-visible:outline-2 focus-visible:outline-rn-navy"
                    >
                      <span className="truncate text-rn-13 font-semibold text-rn-ink">{r.prompt}</span>
                      <span className="flex flex-wrap items-center gap-x-2 text-rn-11 text-rn-muted tabular-nums">
                        <span>{[r.engine, r.country ? countryName(r.country, locale) : null, r.lang, dayOf(r.measuredAt)].filter(Boolean).join(" · ")}</span>
                        <span className="font-semibold text-rn-navy">{mark(r)}</span>
                      </span>
                      {r.excerpt ? (
                        <span className="line-clamp-2 text-rn-12 text-rn-ink-2" data-rn-evidence-excerpt="">
                          {r.excerpt.cutStart ? "… " : null}
                          {r.excerpt.before}
                          {r.excerpt.mark ? <mark className="rounded-[3px] bg-rn-navy-25 px-px font-bold text-rn-navy">{r.excerpt.mark}</mark> : null}
                          {r.excerpt.after}
                          {r.excerpt.cutEnd ? " …" : null}
                        </span>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
              <div className="flex items-center justify-between gap-3">
                <span className="text-rn-11 text-rn-muted tabular-nums">{t("shown", { shown: n0(list.rows.length), total: n0(list.total) })}</span>
                {list.next ? (
                  <RnButton size="sm" onClick={loadMore} disabled={list.more === "loading"}>
                    {list.more === "loading" ? t("loading") : t("more")}
                  </RnButton>
                ) : null}
              </div>
              {list.more === "error" ? <p role="alert" className="m-0 text-rn-12 text-rn-ink-2">{t("error", SUPPORT)}</p> : null}
            </>
          )}
        </div>
      </RnDrawer>
      <AnswerModal brand={ownLabel} promptText={answer?.prompt ?? ""} answers={answer ? [answer.answer] : []} open={answer !== null} onOpenChange={closeAnswer} />
    </>
  );
}
