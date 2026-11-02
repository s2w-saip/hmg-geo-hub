"use client";

// Renewal Website › Prompts insights (2026-10-30, W4; cut 2026-11-02): what is measured, where and how steadily. The
// KPI strip (the list, the latest round's measured and missing prompts, the engine sets), the prompts measured per
// round and the country × brand table. The depth, language and domain cards and the 측정된 프롬프트 · 측정 횟수 · 측정
// 회차 KPIs left: they repeated these or never moved, and the rows keep their values (scored on the live data, W4's
// cards were every axis the rows have). Every number is a count of the rows' Gold values
// (website/prompts-insights); no estimate, rate of change or verdict is added. A mark narrows the list below (its own
// picks) or applies the country filter it names.

import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ArrowDown, ChevronDown, ChevronUp } from "lucide-react";
import { RnBasisChip, RnCard, RnCardHead, RnInfoTip, RnSegmented, RnTextButton, cx, useRnTruncTip } from "@/components/renewal-ui";
import { ENGINE_LABEL } from "@/components/dash/dimension-filter-panel";
import { byEngineOrder, engineColor, engineSetKey, shortDay, type Drill, type DrillKey, type WebsitePromptInsights } from "./website-prompt-model";

export interface InsightActions {
  drill: Drill;
  /** Toggle one of the list's picks (the same value again clears it). */
  onDrill: (key: DrillKey, value: string) => void;
  /** Toggle a country of the panel filter. */
  onCountry: (code: string) => void;
  countries: readonly string[];
  geoLabel: (code: string) => string;
}

export function RnWebsitePromptInsights({
  data,
  open,
  onToggle,
  narrowed,
  ...act
}: InsightActions & {
  data: WebsitePromptInsights;
  open: boolean;
  onToggle: () => void;
  /** The list narrowed by its picks: its size and a jump to it (the list sits below the cards). */
  narrowed?: { count: number; onJump: () => void };
}) {
  const t = useTranslations("renewal.website.prompts.insights");
  const tip = useRnTruncTip();
  const locale = useLocale();
  return (
    <section aria-label={t("title")} className="flex flex-col gap-3" {...tip.bind}>
      {/* the section head of the other renewal pages (RnSectionHead: 20px title, the basis as its chip) */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <h2 className="m-0 text-rn-20 font-bold tracking-[-0.02em] text-rn-ink">{t("title")}</h2>
        <RnBasisChip>{t("basis")}</RnBasisChip>
        {narrowed ? (
          <RnTextButton data-rn-jump="" className="ml-auto inline-flex items-center gap-1" onClick={narrowed.onJump}>
            {t("jump", { count: narrowed.count.toLocaleString(locale) })}
            <ArrowDown className="size-3.5" aria-hidden />
          </RnTextButton>
        ) : null}
        <RnTextButton className={cx("inline-flex items-center gap-1", !narrowed && "ml-auto")} onClick={onToggle} aria-expanded={open}>
          {open ? <ChevronUp className="size-3.5" aria-hidden /> : <ChevronDown className="size-3.5" aria-hidden />}
          {open ? t("collapse") : t("expand")}
        </RnTextButton>
      </div>
      <KpiStrip data={data} act={act} />
      {open ? (
        <div className="grid grid-cols-2 gap-3" data-rn-website-insights="">
          <RoundsCard data={data} act={act} />
          <MarketsCard data={data} act={act} />
        </div>
      ) : null}
      {tip.tip}
    </section>
  );
}

// ── shared bits ──────────────────────────────────────────────────────────────

function useFmt() {
  const locale = useLocale();
  return useMemo(() => {
    const n = (v: number) => v.toLocaleString(locale);
    const pct = (v: number, of: number) => (of > 0 ? `${((v / of) * 100).toFixed(1)}%` : "—");
    return { n, pct };
  }, [locale]);
}

/** A mark that narrows or filters: a button with its tip; `on` = the pick in force, `dim` = another pick is. */
function Mark({ on, dim, tip, onClick, className, style, children, label }: { on?: boolean; dim?: boolean; tip: string; onClick: () => void; className?: string; style?: CSSProperties; children?: ReactNode; label?: string }) {
  return (
    <button
      type="button"
      data-rn-tip={tip}
      aria-label={label ?? tip}
      aria-pressed={on || undefined}
      onClick={onClick}
      style={style}
      className={cx("cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-rn-navy", dim && "opacity-35", className)}
    >
      {children}
    </button>
  );
}

function Card({ title, info, chips, controls, children }: { title: string; info: string; chips?: ReactNode; controls?: ReactNode; children: ReactNode }) {
  return (
    <RnCard className="flex min-w-0 flex-col">
      <RnCardHead title={title} info={<RnInfoTip label={info}>{info}</RnInfoTip>} chips={chips} controls={controls} />
      <div className="flex min-h-0 flex-1 flex-col px-4.5 pb-3.5">{children}</div>
    </RnCard>
  );
}

// ── KPI strip ────────────────────────────────────────────────────────────────

function KpiStrip({ data, act }: { data: WebsitePromptInsights; act: InsightActions }) {
  const t = useTranslations("renewal.website.prompts.kpi");
  const { n, pct } = useFmt();
  const latest = data.rounds.at(-1);
  const measured = latest?.prompts ?? 0;
  const missing = data.prompts - measured;
  return (
    <RnCard className="grid grid-cols-4 divide-x divide-rn-line" data-rn-website-kpis="">
      <Kpi label={t("prompts")} value={n(data.prompts)} sub={t("promptsSub", { sites: n(data.siteCount), countries: n(data.markets.length), langs: n(data.langCount) })} />
      <Kpi
        label={t("latest")}
        value={
          latest ? (
            <Mark on={act.drill.rd === latest.date} tip={t("latestTip", { date: latest.date })} onClick={() => act.onDrill("rd", latest.date)} className="rounded-md text-left hover:text-rn-navy">
              {n(measured)}
            </Mark>
          ) : (
            "—"
          )
        }
        sub={latest ? t("latestSub", { date: latest.date, pct: pct(measured, data.prompts) }) : "—"}
      />
      <Kpi
        label={t("missing")}
        value={
          !latest ? (
            "—"
          ) : missing ? (
            <Mark on={act.drill.miss === latest.date} tip={t("missingTip", { date: latest.date })} onClick={() => act.onDrill("miss", latest.date)} className="rounded-md text-left hover:text-rn-navy">
              {n(missing)}
            </Mark>
          ) : (
            "0"
          )
        }
        sub={latest ? t("latestSub", { date: latest.date, pct: pct(missing, data.prompts) }) : "—"}
      />
      <EngineSets data={data} act={act} />
    </RnCard>
  );
}

function Kpi({ label, value, sub }: { label: string; value: ReactNode; sub: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 px-4.5 py-3">
      <span className="text-rn-12 font-semibold text-rn-muted">{label}</span>
      <span className="text-rn-24 font-bold tabular-nums text-rn-ink">{value}</span>
      <span className="min-w-0 text-rn-12 text-rn-muted tabular-nums">{sub}</span>
    </div>
  );
}

// ── engine sets (the strip's last cell: a short list, on the page's first screen) ──

function EngineSets({ data, act }: { data: WebsitePromptInsights; act: InsightActions }) {
  const t = useTranslations("renewal.website.prompts.engineSets");
  const { n, pct } = useFmt();
  return (
    <div className="flex min-w-0 flex-col gap-1 px-3.5 py-3">
      <span className="flex items-center gap-1.5 px-1 text-rn-12 font-semibold text-rn-muted">
        {t("title")}
        <RnInfoTip label={t("info")}>{t("info")}</RnInfoTip>
      </span>
      <div className="flex flex-col gap-0.5">
        {data.engineSets.map((s) => {
          const key = engineSetKey(s.engines);
          const names = s.engines.length ? byEngineOrder(s.engines).map((e) => ENGINE_LABEL[e] ?? e).join(" · ") : t("noEngine");
          return (
            <Mark
              key={key}
              on={act.drill.eset === key}
              dim={!!act.drill.eset && act.drill.eset !== key}
              tip={t("setTip", { engines: names, count: n(s.prompts), pct: pct(s.prompts, data.prompts) })}
              onClick={() => act.onDrill("eset", key)}
              className="flex items-center gap-2 rounded-md px-1 py-0.5 text-left text-rn-12 hover:bg-rn-navy-25"
            >
              <span className="inline-flex shrink-0 gap-0.5">
                {byEngineOrder(s.engines).map((e) => (
                  <i key={e} aria-hidden className="inline-block size-2 rounded-full" style={{ background: engineColor(e) }} />
                ))}
              </span>
              <span className={cx("min-w-0 flex-1 truncate", act.drill.eset === key ? "font-bold text-rn-navy" : "text-rn-ink-2")}>{names}</span>
              <span className="tabular-nums text-rn-ink">{n(s.prompts)}</span>
            </Mark>
          );
        })}
      </div>
    </div>
  );
}

// ── measured prompts per round ───────────────────────────────────────────────

function RoundsCard({ data, act }: { data: WebsitePromptInsights; act: InsightActions }) {
  const t = useTranslations("renewal.website.prompts.rounds");
  const { n, pct } = useFmt();
  const list = Math.max(1, data.prompts);
  const picked = act.drill.rd;
  const last = data.rounds.length - 1;
  return (
    <Card title={t("title")} info={t("info")}>
      <div className="relative mt-5 flex h-[196px] items-end gap-1 border-b border-rn-line-2" data-rn-rounds-chart="">
        {/* the list's size: a bar reaching it measured every listed prompt that round */}
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 border-t border-dashed border-rn-navy-300" />
        <span className="pointer-events-none absolute -top-[18px] left-0 text-rn-11 text-rn-muted tabular-nums">{t("listLine", { count: n(data.prompts) })}</span>
        {data.rounds.map((r, i) => (
          <div key={r.date} className="relative flex h-full min-w-0 flex-1 items-end">
            {i === last && r.prompts != null ? <span className="absolute inset-x-0 text-center text-rn-11 font-semibold text-rn-ink-2 tabular-nums" style={{ bottom: `calc(${(r.prompts / list) * 100}% + 2px)` }}>{n(r.prompts)}</span> : null}
            {r.prompts == null ? (
              // a week with no round: its place stays open, the bars do not close up over it
              <span data-rn-tip={t("gapTip", { date: r.date })} data-rn-round-gap="" className="block h-full w-full rounded-t-[4px] bg-rn-inset" />
            ) : (
              <Mark
                on={picked === r.date}
                dim={!!picked && picked !== r.date}
                tip={t("tip", { date: r.date, count: n(r.prompts), pct: pct(r.prompts, data.prompts) })}
                onClick={() => act.onDrill("rd", r.date)}
                // a round with none measured keeps a faint stub: it is a round of the lens, 0 is its value
                className={cx("w-full rounded-t-[4px]", r.prompts ? "bg-rn-navy hover:bg-rn-navy-500" : "bg-rn-line-2")}
                style={{ height: r.prompts ? `max(2px, ${(r.prompts / list) * 100}%)` : "2px" }}
              />
            )}
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-1" aria-hidden>
        {data.rounds.map((r) => (
          <span key={r.date} className={cx("min-w-0 flex-1 text-center text-rn-11 whitespace-nowrap tabular-nums", r.prompts == null ? "text-rn-faint" : "text-rn-muted")}>
            {shortDay(r.date)}
          </span>
        ))}
      </div>
    </Card>
  );
}

// ── country × brand ──────────────────────────────────────────────────────────

type MarketOrder = "gaps" | "prompts";

function MarketsCard({ data, act }: { data: WebsitePromptInsights; act: InsightActions }) {
  const t = useTranslations("renewal.website.prompts.markets");
  const { n } = useFmt();
  // a coverage table: the pairs with no prompts come first (by total, the first 8 markets held 1 of 93 blanks)
  const [order, setOrder] = useState<MarketOrder>("gaps");
  const brands = data.brands;
  const blanks = (m: WebsitePromptInsights["markets"][number]) => brands.filter((b) => !m.brands[b]).length;
  const rows = order === "gaps" ? [...data.markets].sort((a, b) => blanks(b) - blanks(a) || b.prompts - a.prompts || a.country.localeCompare(b.country)) : data.markets;
  const pairs = data.markets.reduce((sum, m) => sum + Object.keys(m.brands).length, 0);
  const brandName = (b: string) => b || t("noBrand");
  return (
    <Card
      title={t("title")}
      info={t("info")}
      chips={<RnBasisChip>{t("chip", { markets: n(data.markets.length), pairs: n(pairs) })}</RnBasisChip>}
      controls={
        <RnSegmented
          label={t("orderLabel")}
          value={order}
          onChange={setOrder}
          items={[
            { value: "gaps", label: t("orderGaps") },
            { value: "prompts", label: t("orderPrompts") },
          ]}
        />
      }
    >
      <div className="h-[236px] overflow-auto">
        <table className="w-full table-fixed border-separate border-spacing-[2px] text-rn-12" data-rn-markets-table="">
          <thead>
            <tr className="text-left text-rn-11 text-rn-muted">
              <th scope="col" className="sticky top-0 bg-rn-surface px-1.5 py-1 font-semibold">{t("country")}</th>
              {brands.map((b) => (
                <th key={b} scope="col" className="sticky top-0 w-[72px] bg-rn-surface px-1.5 py-1 text-right font-semibold">{brandName(b)}</th>
              ))}
              <th scope="col" className="sticky top-0 w-[60px] bg-rn-surface px-1.5 py-1 text-right font-semibold">{t("total")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => {
              const on = act.countries.includes(m.country);
              const name = act.geoLabel(m.country);
              return (
                <tr key={m.country}>
                  <th scope="row" className="px-0 py-0 text-left font-normal">
                    <Mark on={on} tip={t("countryTip", { country: name })} onClick={() => act.onCountry(m.country)} className={cx("block w-full truncate rounded px-1.5 py-1 text-left hover:bg-rn-navy-25", on ? "font-bold text-rn-navy" : "text-rn-ink-2")}>
                      {name}
                    </Mark>
                  </th>
                  {brands.map((b) => {
                    const v = m.brands[b] ?? 0;
                    return (
                      <td key={b} data-rn-tip={t("cellTip", { country: name, brand: brandName(b), count: n(v) })} className={cx("rounded px-1.5 py-1 text-right tabular-nums", v ? "bg-rn-navy-25 text-rn-ink" : "text-rn-faint")}>
                        {v ? n(v) : "·"}
                      </td>
                    );
                  })}
                  <td className="px-1.5 py-1 text-right font-semibold tabular-nums text-rn-ink">{n(m.prompts)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
