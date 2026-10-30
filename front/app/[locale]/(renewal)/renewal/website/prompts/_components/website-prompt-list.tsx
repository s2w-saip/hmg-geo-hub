"use client";

// Renewal Website › Prompts list (2026-10-30, W4): the original /website/prompts table in the one-line list of
// the renewal prompt pages, every original field kept — prompt, brand, site country and language (시장),
// target URL, answers with their engines, latest measurement — plus what the rows already carry: the rounds
// each prompt was measured in (a strip over the lens's rounds) and its answers by engine (a stacked bar).
// A cut-off cell shows its full text on hover; a row opens the detail sheet. State lives in
// website-prompts-view.tsx; this file draws.

import { useCallback, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ExternalLink } from "lucide-react";
import { RnDrawer, RnTag, cx, useRnTruncTip } from "@/components/renewal-ui";
import { ENGINE_LABEL } from "@/components/dash/dimension-filter-panel";
import { geoCodeLabel } from "@/lib/geo-catalog/geo-code-label";
import { languageName } from "@/lib/geo-catalog/language-name";
import { LIST_TD as TD, RnDetailField as Field, RnPromptText, RnSortHead } from "../../../_components/prompt-list";
import { byEngineOrder, engineColor, type Sort, type WebsitePromptRow, type WebsitePromptSortKey } from "./website-prompt-model";

/** A site country's name as the filter panel says it (virtual hub codes: 유럽 허브(EU), 월드와이드(글로벌), …). */
export function useGeoLabel(): (code: string) => string {
  const tf = useTranslations("dashboard.filters");
  const locale = useLocale();
  return useCallback((code: string) => geoCodeLabel(code, locale, (c) => tf(`value.${c}` as "value.worldwide")), [locale, tf]);
}

/** The labels of every sort key (column heads and the toolbar's sort). */
export function useSortLabels(): Record<WebsitePromptSortKey, string> {
  const t = useTranslations("website.prompts");
  const tc = useTranslations("renewal.website.prompts.columns");
  return {
    prompt: t("promptLabel"),
    brand: t("brandLabel"),
    country: t("countryLabel"),
    lang: t("langLabel"),
    targetUrl: t("targetUrlLabel"),
    answers: t("answersLabel"),
    lastMeasuredAt: t("lastMeasuredLabel"),
    firstMeasuredAt: tc("firstMeasured"),
    rounds: tc("rounds"),
  };
}

/** A measured day as YYYY-MM-DD (Gold sends the round date; a timestamp keeps its day). */
export function day(v: string | null): string | null {
  return v ? v.slice(0, 10) : null;
}

/** Targets carry no scheme ("kia.com/de/…"). */
export function targetHref(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

export function RnWebsitePromptTable({
  rows,
  roundAxis,
  sort,
  onSort,
  onOpen,
}: {
  rows: WebsitePromptRow[];
  roundAxis: string[];
  sort: Sort;
  onSort: (key: WebsitePromptSortKey) => void;
  onOpen: (row: WebsitePromptRow) => void;
}) {
  const t = useTranslations("website.prompts");
  const tc = useTranslations("renewal.website.prompts.columns");
  const locale = useLocale();
  const tip = useRnTruncTip();
  const geoLabel = useGeoLabel();
  const label = useSortLabels();
  // the answers bars share one scale, so a longer bar is more answers on every row of the page
  const maxAnswers = Math.max(1, ...rows.map((r) => r.answers));
  const head = (key: WebsitePromptSortKey, text: string, className?: string) => <RnSortHead sortKey={key} label={text} sort={sort} onSort={onSort} className={className} />;
  return (
    <div {...tip.bind}>
      <table className="w-full table-fixed border-separate border-spacing-0 text-rn-13" data-rn-website-prompt-table="">
        <colgroup>
          <col />
          <col className="w-[84px]" />
          <col className="w-[164px]" />
          <col className="w-[208px]" />
          <col className="w-[128px]" />
          <col className="w-[128px]" />
          <col className="w-[100px]" />
        </colgroup>
        <thead>
          <tr className="text-left text-rn-12 text-rn-muted">
            {head("prompt", label.prompt, "pl-5")}
            {head("brand", label.brand)}
            {head("country", tc("market"))}
            {head("targetUrl", label.targetUrl)}
            {head("rounds", tc("rounds"))}
            {head("answers", label.answers)}
            {head("lastMeasuredAt", label.lastMeasuredAt, "pr-5")}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.id}
              data-rn-website-prompt-row={r.id}
              // a drag that selects text is not a click on the row
              onClick={() => !window.getSelection()?.toString() && onOpen(r)}
              className="cursor-pointer hover:bg-rn-navy-25/60"
            >
              <td className={cx(TD, "pl-5")}>
                <button type="button" data-rn-tip="" className="block w-full cursor-pointer truncate text-left text-rn-ink focus-visible:outline-2 focus-visible:outline-rn-navy">
                  {r.promptText}
                </button>
              </td>
              <td className={TD}>{r.brand ? <RnTag>{r.brand}</RnTag> : <span className="text-rn-faint">—</span>}</td>
              <td className={TD}>
                <span data-rn-tip="" className="block truncate text-rn-12 text-rn-ink-2">
                  {geoLabel(r.countryCode)} · {languageName(r.langCode, locale)}
                </span>
              </td>
              <td className={TD}>
                {/* the target page is what the row is about: the link opens it, the row its sheet */}
                <a
                  href={targetHref(r.targetUrl)}
                  target="_blank"
                  rel="noreferrer noopener"
                  data-rn-tip=""
                  onClick={(e) => e.stopPropagation()}
                  className="block truncate text-rn-12 text-rn-navy underline-offset-2 hover:underline"
                >
                  {r.targetUrl}
                </a>
              </td>
              <td className={TD}>
                <RoundStrip row={r} axis={roundAxis} />
              </td>
              <td className={TD}>
                <AnswersBar row={r} max={maxAnswers} />
              </td>
              <td className={cx(TD, "pr-5 text-rn-12 whitespace-nowrap tabular-nums")}>
                {day(r.lastMeasuredAt) ?? <span className="text-rn-muted">{t("notMeasured")}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {tip.tip}
    </div>
  );
}

/** The lens's rounds, oldest first: filled where the prompt was measured. */
export function RoundStrip({ row, axis, size = "sm" }: { row: WebsitePromptRow; axis: string[]; size?: "sm" | "lg" }) {
  const tc = useTranslations("renewal.website.prompts.columns");
  const measured = new Set(row.rounds);
  const tipText = row.rounds.length
    ? tc("roundsTip", { count: row.rounds.length, total: axis.length, first: day(row.firstMeasuredAt) ?? "—", last: day(row.lastMeasuredAt) ?? "—" })
    : tc("roundsNone");
  return (
    <span data-rn-tip={tipText} data-rn-round-strip="" className={cx("flex min-w-0 items-center", size === "lg" ? "gap-[3px]" : "gap-[2px]")}>
      {axis.map((d) => (
        <i
          key={d}
          aria-hidden
          data-on={measured.has(d) || undefined}
          className={cx("block min-w-[3px] flex-1 rounded-[2px]", size === "lg" ? "h-4 max-w-[18px]" : "h-3 max-w-[7px]", measured.has(d) ? "bg-rn-navy" : "bg-rn-line-2")}
        />
      ))}
      <span className="sr-only">{tipText}</span>
    </span>
  );
}

/** The answers, stacked by engine on the page's scale, and their number. */
function AnswersBar({ row, max }: { row: WebsitePromptRow; max: number }) {
  const locale = useLocale();
  const engines = byEngineOrder(Object.keys(row.engineAnswers));
  const parts = engines.map((e) => `${ENGINE_LABEL[e] ?? e} ${row.engineAnswers[e].toLocaleString(locale)}`).join(" · ");
  return (
    <span data-rn-tip={parts || undefined} className="flex min-w-0 items-center gap-2">
      <span className="flex h-2 w-[68px] shrink-0 overflow-hidden rounded-[3px] bg-rn-inset">
        {engines.map((e) => (
          <i
            key={e}
            data-engine={e}
            className="block h-full border-r-2 border-rn-surface last:border-r-0"
            style={{ width: `${(row.engineAnswers[e] / max) * 100}%`, background: engineColor(e) }}
          />
        ))}
      </span>
      <span className="ml-auto text-rn-12 tabular-nums text-rn-ink">{row.answers > 0 ? row.answers.toLocaleString(locale) : "—"}</span>
      {parts ? <span className="sr-only">{parts}</span> : null}
    </span>
  );
}

/** The detail sheet: the full text (copyable), the row's attributes and its measurement under the lens. */
export function RnWebsitePromptDetail({ row, axis, lens, onClose }: { row: WebsitePromptRow | null; axis: string[]; lens: string[]; onClose: () => void }) {
  const t = useTranslations("website.prompts");
  const tp = useTranslations("renewal.prompts");
  const tw = useTranslations("renewal.website.prompts");
  const tc = useTranslations("renewal.website.prompts.columns");
  const locale = useLocale();
  const geoLabel = useGeoLabel();
  if (!row) return null;
  const engines = byEngineOrder(Object.keys(row.engineAnswers));
  const section = (title: string, children: ReactNode) => (
    <section>
      <h3 className="m-0 mb-2 text-rn-13 font-bold text-rn-ink">{title}</h3>
      {children}
    </section>
  );
  return (
    <RnDrawer open onClose={onClose} title={tp("detail.title")} closeLabel={tp("close")}>
      <div className="flex flex-col gap-6">
        <RnPromptText text={row.promptText} />
        {section(
          tp("detail.attributes"),
          <dl className="m-0 grid grid-cols-[112px_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-rn-13">
            <Field label={t("brandLabel")}>{row.brand ? <RnTag>{row.brand}</RnTag> : null}</Field>
            <Field label={t("countryLabel")}>{row.countryCode ? `${geoLabel(row.countryCode)} (${row.countryCode})` : null}</Field>
            <Field label={t("langLabel")}>{row.langCode ? `${languageName(row.langCode, locale)} (${row.langCode.toUpperCase()})` : null}</Field>
            <Field label={t("targetUrlLabel")}>
              {row.targetUrl ? (
                <a href={targetHref(row.targetUrl)} target="_blank" rel="noreferrer noopener" className="inline-flex items-start gap-1 break-all text-rn-navy underline-offset-2 hover:underline">
                  {row.targetUrl}
                  <ExternalLink className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                </a>
              ) : null}
            </Field>
            <Field label={tw("domainLabel")}>{row.domain || null}</Field>
          </dl>,
        )}
        {section(
          tw("measurement"),
          <>
            {lens.length ? <p className="m-0 mb-2 text-rn-12 text-rn-muted">{tw("measurementLens", { lens: lens.join(" · ") })}</p> : null}
            <dl className="m-0 grid grid-cols-[112px_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-rn-13">
              <Field label={t("answersLabel")}>{row.answers > 0 ? row.answers.toLocaleString(locale) : null}</Field>
              <Field label={t("enginesLabel")}>
                {engines.length ? (
                  <span className="flex flex-col gap-1">
                    {engines.map((e) => (
                      <span key={e} className="inline-flex items-center gap-1.5">
                        <i aria-hidden className="inline-block size-2 rounded-full" style={{ background: engineColor(e) }} />
                        {ENGINE_LABEL[e] ?? e}
                        <b className="font-semibold tabular-nums">{row.engineAnswers[e].toLocaleString(locale)}</b>
                      </span>
                    ))}
                  </span>
                ) : null}
              </Field>
              <Field label={t("lastMeasuredLabel")}>{day(row.lastMeasuredAt) ?? t("notMeasured")}</Field>
              <Field label={tc("firstMeasured")}>{day(row.firstMeasuredAt)}</Field>
              <Field label={tc("rounds")}>
                <span className="flex flex-col gap-1.5">
                  <span className="tabular-nums">{tc("roundsOf", { count: row.rounds.length, total: axis.length })}</span>
                  <RoundStrip row={row} axis={axis} size="lg" />
                  {row.rounds.length ? <span className="text-rn-12 break-words text-rn-muted tabular-nums">{row.rounds.join(" · ")}</span> : null}
                </span>
              </Field>
            </dl>
          </>,
        )}
      </div>
    </RnDrawer>
  );
}
