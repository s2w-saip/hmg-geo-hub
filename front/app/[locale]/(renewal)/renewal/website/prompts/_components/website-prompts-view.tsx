"use client";

// Renewal Website › Prompts body (2026-10-30, W4): the list's insights over the listed prompts, then the list.
// The first page and the insights come with the page render (the panel's filters are the URL's); search,
// order, page, page size and the list's own picks read again through GET /api/website/prompts/*
// (website-prompts-read.ts). The URL keeps q · sort · dir · size and the picks (m · rd · last · eset · ans), so
// a link restores the list; the page number stays out of it (a new query starts at page 1). A new server
// render (the panel applied a pick) remounts this body with its answer (page.tsx keys it).
// Engine and period are a lens (the original's rule): they choose the answers a row counts, never the rows.

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { ArrowDownWideNarrow, ArrowUpNarrowWide, Download, Loader2, RotateCw } from "lucide-react";
import { RnButton, RnCard, RnEmpty, RnIconButton, RnNote, RnSearchField, RnSelect, RnTextButton, RnToken, useRnToast } from "@/components/renewal-ui";
import { ENGINE_LABEL } from "@/components/dash/dimension-filter-panel";
import { splitFilterValues } from "@/components/dash/filter-encoding";
import { languageName } from "@/lib/geo-catalog/language-name";
import { downloadXlsx } from "@/lib/export/xlsx";
import { exportFilename } from "@/app/[locale]/(dash)/standard/prompts/_components/prompt-export";
import { RnListPager } from "../../../_components/prompt-list";
import { useRnFilterToggle } from "../../../_components/overview-filters";
import { RnWebsitePromptInsights } from "./website-prompt-insights";
import { RnWebsitePromptDetail, RnWebsitePromptTable, day, useGeoLabel, useSortLabels } from "./website-prompt-list";
import {
  DRILL_KEYS,
  PAGE_SIZES,
  byEngineOrder,
  engineColor,
  readDrill,
  withList,
  type Drill,
  type DrillKey,
  type Sort,
  type WebsitePromptInsights,
  type WebsitePromptRow,
  type WebsitePromptSortKey,
  type WebsitePromptsPage,
} from "./website-prompt-model";
import { readWebsitePromptInsights, readWebsitePromptRows, readWebsitePromptsPage } from "./website-prompts-read";

const SORTS: readonly WebsitePromptSortKey[] = ["lastMeasuredAt", "answers", "rounds", "firstMeasuredAt", "prompt", "brand", "country", "lang", "targetUrl"];
// a new text column sorts A→Z first, a count or date the largest / latest first
const firstAsc = (k: WebsitePromptSortKey) => !["answers", "lastMeasuredAt", "firstMeasuredAt", "rounds"].includes(k);
const READ_DEBOUNCE_MS = 200;
const OPEN_KEY = "rn-website-prompts-insights";
const LIST_ID = "rn-website-prompt-list";

export function RnWebsitePrompts({
  initial,
  initialInsights,
  read = readWebsitePromptsPage,
  readRows = readWebsitePromptRows,
  readInsights = readWebsitePromptInsights,
}: {
  initial: WebsitePromptsPage;
  initialInsights: WebsitePromptInsights;
  read?: typeof readWebsitePromptsPage;
  readRows?: typeof readWebsitePromptRows;
  readInsights?: typeof readWebsitePromptInsights;
}) {
  const t = useTranslations("website.prompts");
  const tp = useTranslations("renewal.prompts");
  const tw = useTranslations("renewal.website.prompts");
  const tStd = useTranslations("standardPromptsView");
  const locale = useLocale();
  const toast = useRnToast();
  const sp = useSearchParams();
  const geoLabel = useGeoLabel();
  const sortLabel = useSortLabels();
  const toggleFilter = useRnFilterToggle();

  const [search, setSearch] = useState(() => sp.get("q") ?? "");
  const [sort, setSort] = useState<Sort>({ key: initial.sort, asc: initial.dir === "asc" });
  const [size, setSize] = useState(initial.pageSize);
  const [page, setPage] = useState(initial.page);
  const [drill, setDrill] = useState<Drill>(() => readDrill(sp));
  const [data, setData] = useState(initial);
  const [insights, setInsights] = useState(initialInsights);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [detail, setDetail] = useState<WebsitePromptRow | null>(null);
  const [open, setOpen] = useState(true);
  useEffect(() => {
    try {
      if (window.localStorage.getItem(OPEN_KEY) === "closed") setOpen(false);
    } catch {
      // storage unavailable: the insights stay open
    }
  }, []);
  const toggleOpen = () =>
    setOpen((v) => {
      try {
        window.localStorage.setItem(OPEN_KEY, v ? "closed" : "open");
      } catch {
        // storage unavailable: this visit only
      }
      return !v;
    });

  const query = (pageNo?: number) => withList(window.location.search, { q: search, sort, size, page: pageNo, drill }).toString();

  // ── reads: debounced, the latest wins; none when the answer on screen is this query's (the first render's,
  // or a read's — a pick cleared back to the first query reads again, its answer is no longer on screen) ──
  const pageKey = JSON.stringify({ q: search.trim(), sort, size, page, drill, retry });
  const shownPage = useRef(pageKey);
  useEffect(() => {
    if (pageKey === shownPage.current) return;
    let active = true;
    setBusy(true);
    const timer = setTimeout(() => {
      read(query(page))
        .then((res) => {
          if (!active) return;
          shownPage.current = pageKey;
          setData(res);
          setFailed(false);
          setBusy(false);
        })
        .catch((e: unknown) => {
          if (!active) return;
          console.error("[renewal/website/prompts] read failed:", e);
          setFailed(true);
          setBusy(false);
        });
    }, READ_DEBOUNCE_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageKey, read]);
  // the insights count the listed prompts: only the search changes them here (the panel re-renders the page)
  const insightsKey = JSON.stringify({ q: search.trim(), retry });
  const shownInsights = useRef(insightsKey);
  useEffect(() => {
    if (insightsKey === shownInsights.current) return;
    let active = true;
    const timer = setTimeout(() => {
      readInsights(withList(window.location.search, { q: search, sort, size }).toString())
        .then((res) => {
          if (!active) return;
          shownInsights.current = insightsKey;
          setInsights(res);
        })
        .catch((e: unknown) => {
          if (!active) return;
          console.error("[renewal/website/prompts] insights read failed:", e);
          setFailed(true);
        });
    }, READ_DEBOUNCE_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [insightsKey, readInsights]);

  // The URL mirrors the list's own params (shallow, no server round trip); the panel's commits carry them on.
  useEffect(() => {
    const next = withList(window.location.search, { q: search, sort, size, drill }).toString();
    if (next !== window.location.search.replace(/^\?/, "")) window.history.replaceState(null, "", `${window.location.pathname}${next ? `?${next}` : ""}`);
  }, [search, sort, size, drill]);

  const changeSort = (next: Sort) => {
    setSort(next);
    setPage(1);
  };
  const onHead = (key: WebsitePromptSortKey) => changeSort(sort.key === key ? { key, asc: !sort.asc } : { key, asc: firstAsc(key) });
  const onDrill = useCallback((key: DrillKey, value: string | number) => {
    setDrill((d) => {
      const next = { ...d };
      if (d[key] === value) delete next[key];
      else (next as Record<DrillKey, string | number>)[key] = value;
      return next;
    });
    setPage(1);
  }, []);
  const clearDrill = (key?: DrillKey) => {
    setDrill((d) => {
      if (!key) return {};
      const next = { ...d };
      delete next[key];
      return next;
    });
    setPage(1);
  };

  // ── the lens in force (the panel's engine / period picks) ──
  const engines = splitFilterValues(sp.get("engine"));
  const period = sp.get("time")?.split("..") ?? null;
  const lens = [
    ...engines.map((e) => ENGINE_LABEL[e] ?? e),
    ...(period && (period[0] || period[1]) ? [`${period[0] || "…"} ~ ${period[1] || "…"}`] : []),
  ];

  const drillText = (key: DrillKey): string => {
    const v = drill[key];
    if (key === "m") return v === "1" ? tw("drill.m1") : tw("drill.m0");
    if (key === "rd") return tw("drill.rd", { date: String(v) });
    if (key === "last") return v === "none" ? tw("drill.lastNone") : tw("drill.last", { date: String(v) });
    if (key === "eset") return v === "none" ? tw("drill.esetNone") : tw("drill.eset", { engines: byEngineOrder(String(v).split("~")).map((e) => ENGINE_LABEL[e] ?? e).join(" · ") });
    return tw("drill.ans", { count: Number(v) });
  };
  const drillKeys = DRILL_KEYS.filter((k) => drill[k] !== undefined);

  // ── export: every row of the list (its picks included) in list order: the original's eight columns, then what
  // each row carries besides (first measurement, measured rounds, answers by engine) ──
  const [exporting, setExporting] = useState(false);
  async function handleExport() {
    if (exporting || data.total === 0) return;
    setExporting(true);
    try {
      const { rows, roundAxis } = await readRows(query());
      const engineCols = byEngineOrder([...new Set(rows.flatMap((r) => Object.keys(r.engineAnswers)))]);
      const headers = [
        t("promptLabel"), t("brandLabel"), t("countryLabel"), t("langLabel"), t("targetUrlLabel"), t("answersLabel"), t("lastMeasuredLabel"), t("enginesLabel"),
        sortLabel.firstMeasuredAt, tw("export.roundsCount", { total: roundAxis.length }), tw("export.rounds"),
        ...engineCols.map((e) => tw("export.engineAnswers", { engine: ENGINE_LABEL[e] ?? e })),
      ];
      const cells = rows.map((r) => [
        r.promptText, r.brand, geoLabel(r.countryCode), languageName(r.langCode, locale), r.targetUrl, r.answers, day(r.lastMeasuredAt) ?? "",
        byEngineOrder(r.engines).map((e) => ENGINE_LABEL[e] ?? e).join(", "),
        day(r.firstMeasuredAt) ?? "", r.rounds.length, r.rounds.join(", "),
        ...engineCols.map((e) => r.engineAnswers[e] ?? 0),
      ]);
      await downloadXlsx(exportFilename(t("exportFilename"), new Date()), headers, cells, t("exportSheetName"));
    } catch (err) {
      console.error("[renewal/website/prompts] export failed:", err);
      toast(tStd("exportFailed"));
    } finally {
      setExporting(false);
    }
  }

  const num = (n: number) => n.toLocaleString(locale);
  const { rows, total } = data;
  const legend = byEngineOrder(insights.engines.map((e) => e.engine));

  return (
    <>
      <RnWebsitePromptInsights
        data={insights}
        open={open}
        onToggle={toggleOpen}
        drill={drill}
        onDrill={onDrill}
        onPanel={toggleFilter}
        onSite={(domain) => {
          setSearch((q) => (q === domain ? "" : domain));
          setPage(1);
        }}
        picked={{ geography: splitFilterValues(sp.get("geography")), language: splitFilterValues(sp.get("language")), q: search.trim() }}
        geoLabel={geoLabel}
        narrowed={drillKeys.length ? { count: total, onJump: () => document.getElementById(LIST_ID)?.scrollIntoView({ behavior: "smooth", block: "start" }) } : undefined}
      />
      <RnCard id={LIST_ID} busy={busy} aria-label={tw("count", { count: num(total) })} className="scroll-mt-2">
        <div className="flex flex-wrap items-center gap-2 border-b border-rn-line px-5 py-3">
          <RnSearchField
            id="rn-website-prompt-search"
            className="w-full max-w-[320px] min-w-[200px] flex-1"
            value={search}
            onChange={(v) => {
              setSearch(v);
              setPage(1);
            }}
            placeholder={t("searchPlaceholder")}
            label={t("searchPlaceholder")}
          />
          <RnSelect
            label={tp("sortLabel")}
            value={sort.key}
            onChange={(e) => {
              const key = e.target.value as WebsitePromptSortKey;
              changeSort({ key, asc: firstAsc(key) });
            }}
            options={SORTS.map((k) => ({ value: k, label: sortLabel[k] }))}
          />
          <RnIconButton label={sort.asc ? tp("sortAsc") : tp("sortDesc")} onClick={() => changeSort({ key: sort.key, asc: !sort.asc })}>
            {sort.asc ? <ArrowUpNarrowWide className="size-4" aria-hidden /> : <ArrowDownWideNarrow className="size-4" aria-hidden />}
          </RnIconButton>
          <span className="ml-auto flex items-center gap-2.5 text-rn-12 text-rn-muted" data-rn-engine-legend="">
            {legend.map((e) => (
              <span key={e} className="inline-flex items-center gap-1">
                <i aria-hidden className="inline-block size-2 rounded-full" style={{ background: engineColor(e) }} />
                {ENGINE_LABEL[e] ?? e}
              </span>
            ))}
          </span>
          <span className="text-rn-12 text-rn-muted tabular-nums">
            {drillKeys.length ? tw("countOf", { count: num(total), listed: num(data.listed) }) : tw("count", { count: num(total) })}
          </span>
          <RnButton size="sm" onClick={handleExport} disabled={exporting || total === 0}>
            {exporting ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Download className="size-3.5" aria-hidden />}
            {t("exportLabel")}
          </RnButton>
        </div>
        {drillKeys.length ? (
          <div data-rn-drill="" aria-live="polite" className="flex flex-wrap items-center gap-2 border-b border-rn-line px-5 py-2 text-rn-12">
            <span className="font-semibold text-rn-muted">{tw("drill.label")}</span>
            {drillKeys.map((k) => (
              <RnToken key={k} label={tw(`drill.key.${k}`)} value={drillText(k)} removeLabel={tw("drill.remove", { label: drillText(k) })} onRemove={() => clearDrill(k)} />
            ))}
            <RnTextButton onClick={() => clearDrill()}>{tw("drill.clear")}</RnTextButton>
          </div>
        ) : null}
        {lens.length ? (
          <p data-rn-lens="" className="m-0 border-b border-rn-line px-5 py-2 text-rn-12 text-rn-muted">
            <b className="font-semibold text-rn-ink-2">
              {t("lensTitle")} · {lens.join(" · ")}
            </b>{" "}
            — {t("lensHint")}
          </p>
        ) : null}
        {failed ? (
          <RnNote className="m-5">
            <span>{tw("readFailed")}</span>
            <RnButton size="sm" onClick={() => setRetry((n) => n + 1)}>
              <RotateCw className="size-3.5" aria-hidden />
              {tw("retry")}
            </RnButton>
          </RnNote>
        ) : null}
        {total === 0 ? (
          <RnEmpty className="m-5">{tp("emptyFiltered")}</RnEmpty>
        ) : (
          <RnWebsitePromptTable rows={rows} roundAxis={data.roundAxis} sort={sort} onSort={onHead} onOpen={setDetail} />
        )}
        {total > 0 ? (
          <RnListPager
            rangeFrom={data.rangeFrom}
            rangeTo={data.rangeTo}
            total={total}
            page={data.page}
            pages={data.pages}
            pageSize={size}
            pageSizes={PAGE_SIZES}
            onPageSize={(n) => {
              setSize(n);
              setPage(1);
            }}
            onPage={setPage}
          />
        ) : null}
      </RnCard>
      <RnWebsitePromptDetail row={detail} axis={data.roundAxis} lens={lens} onClose={() => setDetail(null)} />
    </>
  );
}
