"use client";

// Renewal Website › Prompts insights (2026-10-30, W4): what the listed prompts hold, counted — the KPI strip
// and five cards (measured prompts per round, answer depth and engine sets, site country × brand, languages,
// target sites). The latest-round card left (2026-10-30, the user): the prompts it set apart are registered
// (web_reg) yet have no job after July, a coverage question for the pipeline, not one this reader can act on;
// each row's 최근 측정 stays in the list (column, sort, the `last` pick of a shared URL). Every number is a count
// or a sum of the rows' Gold values (website/prompts-insights); no estimate, rate of change or verdict is added.
// A mark narrows the list below (its own picks) or applies the panel filter it names (국가 · 언어); a target site
// searches for it.

import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ArrowDown, ChevronDown, ChevronUp } from "lucide-react";
import { RnBasisChip, RnCard, RnCardHead, RnInfoTip, RnTextButton, cx, useRnTruncTip } from "@/components/renewal-ui";
import { ENGINE_LABEL } from "@/components/dash/dimension-filter-panel";
import { languageName } from "@/lib/geo-catalog/language-name";
import { byEngineOrder, engineColor, engineSetKey, shortDay, type Drill, type DrillKey, type WebsitePromptInsights } from "./website-prompt-model";

const TOP = 8;

export interface InsightActions {
  drill: Drill;
  /** Toggle one of the list's picks (the same value again clears it). */
  onDrill: (key: DrillKey, value: string | number) => void;
  /** Toggle a panel filter value (국가 · 언어). */
  onPanel: (axis: "geography" | "language", value: string) => void;
  /** Search the list for a target site. */
  onSite: (domain: string) => void;
  picked: { geography: readonly string[]; language: readonly string[]; q: string };
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
  const locale = useLocale();
  const tip = useRnTruncTip();
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
        <div className="grid grid-cols-4 gap-3" data-rn-website-insights="">
          <RoundsCard data={data} act={act} />
          <DepthCard data={data} act={act} />
          <MarketsCard data={data} act={act} />
          <BarsCard kind="langs" data={data} act={act} />
          <BarsCard kind="sites" data={data} act={act} />
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

function Card({ title, info, actions, className, children }: { title: string; info: string; actions?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <RnCard className={cx("flex min-w-0 flex-col", className)}>
      <RnCardHead title={title} info={<RnInfoTip label={info}>{info}</RnInfoTip>} actions={actions} />
      <div className="flex min-h-0 flex-1 flex-col px-4.5 pb-3.5">{children}</div>
    </RnCard>
  );
}

// ── KPI strip ────────────────────────────────────────────────────────────────

function KpiStrip({ data, act }: { data: WebsitePromptInsights; act: InsightActions }) {
  const t = useTranslations("renewal.website.prompts.kpi");
  const { n, pct } = useFmt();
  const axis = data.roundAxis;
  const latest = data.rounds.at(-1);
  const unmeasured = data.prompts - data.measured;
  const engines = byEngineOrder(data.engines.map((e) => e.engine)).map((code) => data.engines.find((e) => e.engine === code)!);
  return (
    <RnCard className="grid grid-cols-5 divide-x divide-rn-line" data-rn-website-kpis="">
      <Kpi label={t("prompts")} value={n(data.prompts)} sub={t("promptsSub", { sites: n(data.sites.length), countries: n(data.markets.length), langs: n(data.langs.length) })} />
      <Kpi
        label={t("measured")}
        value={
          <Mark on={act.drill.m === "1"} tip={t("measuredTip")} onClick={() => act.onDrill("m", "1")} className="rounded-md text-left hover:text-rn-navy">
            {n(data.measured)}
          </Mark>
        }
        sub={
          <>
            {t("ofList", { pct: pct(data.measured, data.prompts) })} ·{" "}
            <Mark on={act.drill.m === "0"} tip={t("unmeasuredTip")} onClick={() => act.onDrill("m", "0")} className={cx("rounded underline-offset-2 hover:underline", act.drill.m === "0" && "font-bold text-rn-navy")}>
              {t("unmeasured", { count: n(unmeasured) })}
            </Mark>
          </>
        }
      />
      <Kpi
        label={t("answers")}
        value={n(data.answers)}
        sub={
          <span className="flex flex-wrap gap-x-2.5">
            {engines.map((e) => (
              <span key={e.engine} className="inline-flex items-center gap-1 whitespace-nowrap">
                <i aria-hidden className="inline-block size-2 rounded-full" style={{ background: engineColor(e.engine) }} />
                {ENGINE_LABEL[e.engine] ?? e.engine} {n(e.answers)}
              </span>
            ))}
          </span>
        }
      />
      <Kpi label={t("rounds")} value={t("roundsValue", { count: n(axis.length) })} sub={axis.length ? t("roundsRange", { from: axis[0], to: axis[axis.length - 1] }) : "—"} />
      <Kpi
        label={t("latest")}
        value={
          latest ? (
            <Mark on={act.drill.rd === latest.date} tip={t("latestTip", { date: latest.date })} onClick={() => act.onDrill("rd", latest.date)} className="rounded-md text-left hover:text-rn-navy">
              {n(latest.prompts)}
            </Mark>
          ) : (
            "—"
          )
        }
        sub={latest ? t("latestSub", { date: latest.date, pct: pct(latest.prompts, data.prompts) }) : "—"}
      />
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

// ── measured prompts per round ───────────────────────────────────────────────

function RoundsCard({ data, act }: { data: WebsitePromptInsights; act: InsightActions }) {
  const t = useTranslations("renewal.website.prompts.rounds");
  const { n, pct } = useFmt();
  const list = Math.max(1, data.prompts);
  const picked = act.drill.rd;
  const last = data.rounds.length - 1;
  return (
    <Card title={t("title")} info={t("info")} className="col-span-3">
      <div className="relative mt-5 flex h-[120px] items-end gap-1.5 border-b border-rn-line-2" data-rn-rounds-chart="">
        {/* the list's size: a bar reaching it measured every listed prompt that round */}
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 border-t border-dashed border-rn-navy-300" />
        <span className="pointer-events-none absolute -top-[18px] right-0 text-rn-11 text-rn-muted tabular-nums">{t("listLine", { count: n(data.prompts) })}</span>
        {data.rounds.map((r, i) => (
          <div key={r.date} className="relative flex h-full min-w-0 flex-1 items-end">
            {i === last ? <span className="absolute inset-x-0 text-center text-rn-11 font-semibold text-rn-ink-2 tabular-nums" style={{ bottom: `calc(${(r.prompts / list) * 100}% + 2px)` }}>{n(r.prompts)}</span> : null}
            <Mark
              on={picked === r.date}
              dim={!!picked && picked !== r.date}
              tip={t("tip", { date: r.date, count: n(r.prompts), pct: pct(r.prompts, data.prompts) })}
              onClick={() => act.onDrill("rd", r.date)}
              // a round with none measured keeps a faint stub: it is a round of the lens, 0 is its value
              className={cx("w-full rounded-t-[4px]", r.prompts ? "bg-rn-navy hover:bg-rn-navy-500" : "bg-rn-line-2")}
              style={{ height: r.prompts ? `max(2px, ${(r.prompts / list) * 100}%)` : "2px" }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-1.5" aria-hidden>
        {data.rounds.map((r) => (
          <span key={r.date} className="min-w-0 flex-1 truncate text-center text-rn-11 text-rn-muted tabular-nums">
            {shortDay(r.date)}
          </span>
        ))}
      </div>
    </Card>
  );
}

// ── latest round per prompt ──────────────────────────────────────────────────

function HBar({ label, value, max, on, dim, tip, onClick, muted }: { label: string; value: number; max: number; on?: boolean; dim?: boolean; tip: string; onClick: () => void; muted?: boolean }) {
  const { n } = useFmt();
  return (
    <Mark on={on} dim={dim} tip={tip} onClick={onClick} className="group grid grid-cols-[minmax(0,92px)_minmax(0,1fr)_52px] items-center gap-2 rounded-md px-1 py-0.5 text-left hover:bg-rn-navy-25">
      <span className={cx("truncate text-rn-12 tabular-nums", on ? "font-bold text-rn-navy" : "text-rn-ink-2")}>{label}</span>
      <span className="h-2.5 overflow-hidden rounded-[3px] bg-rn-inset">
        <i className={cx("block h-full rounded-[3px]", muted ? "bg-rn-faint" : "bg-rn-navy group-hover:bg-rn-navy-500")} style={{ width: `${(value / max) * 100}%` }} />
      </span>
      <span className="text-right text-rn-12 tabular-nums text-rn-ink">{n(value)}</span>
    </Mark>
  );
}

// ── answers per prompt, engine sets ──────────────────────────────────────────

function DepthCard({ data, act }: { data: WebsitePromptInsights; act: InsightActions }) {
  const t = useTranslations("renewal.website.prompts.depth");
  const { n, pct } = useFmt();
  const top = data.depth.at(-1)?.answers ?? 0;
  const counts = new Map(data.depth.map((d) => [d.answers, d.prompts]));
  const slots = Array.from({ length: top + 1 }, (_, a) => ({ answers: a, prompts: counts.get(a) ?? 0 }));
  const max = Math.max(1, ...slots.map((s) => s.prompts));
  const picked = act.drill.ans;
  const ticks = new Set([0, top, ...slots.filter((s) => s.answers % 10 === 0).map((s) => s.answers)]);
  return (
    <Card title={t("title")} info={t("info")}>
      <div className="flex h-[64px] items-end gap-px border-b border-rn-line-2" data-rn-depth-chart="">
        {slots.map((s) => (
          <div key={s.answers} className="flex h-full min-w-0 flex-1 items-end">
            {s.prompts ? (
              <Mark
                on={picked === s.answers}
                dim={picked !== undefined && picked !== s.answers}
                tip={t("tip", { answers: n(s.answers), count: n(s.prompts), pct: pct(s.prompts, data.prompts) })}
                onClick={() => act.onDrill("ans", s.answers)}
                className="w-full rounded-t-[2px] bg-rn-navy hover:bg-rn-navy-500"
                style={{ height: `max(2px, ${(s.prompts / max) * 100}%)` }}
              />
            ) : null}
          </div>
        ))}
      </div>
      <div className="mt-0.5 flex gap-px text-rn-11 text-rn-muted tabular-nums" aria-hidden>
        {slots.map((s) => (
          <span key={s.answers} className="min-w-0 flex-1 overflow-visible text-center whitespace-nowrap">
            {ticks.has(s.answers) ? s.answers : ""}
          </span>
        ))}
      </div>
      <h3 className="m-0 mt-3 mb-1 text-rn-12 font-semibold text-rn-muted">{t("sets")}</h3>
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
    </Card>
  );
}

// ── site country × brand ─────────────────────────────────────────────────────

const HEAT = ["bg-rn-heat-0", "bg-rn-heat-1", "bg-rn-heat-2", "bg-rn-heat-3", "bg-rn-heat-4"];

function MarketsCard({ data, act }: { data: WebsitePromptInsights; act: InsightActions }) {
  const t = useTranslations("renewal.website.prompts.markets");
  const { n } = useFmt();
  const [all, setAll] = useState(false);
  const brands = data.brands.map((b) => b.brand);
  const max = Math.max(1, ...data.markets.flatMap((m) => Object.values(m.brands)));
  const shown = all ? data.markets : data.markets.slice(0, TOP);
  const brandName = (b: string) => b || t("noBrand");
  return (
    <Card
      title={t("title")}
      info={t("info")}
      className="col-span-2"
      actions={data.markets.length > TOP ? <RnTextButton onClick={() => setAll((v) => !v)}>{all ? t("less") : t("more", { count: n(data.markets.length) })}</RnTextButton> : undefined}
    >
      <div className={cx("overflow-auto", all && "max-h-[312px]")}>
        <table className="w-full table-fixed border-separate border-spacing-[2px] text-rn-12" data-rn-markets-table="">
          <thead>
            <tr className="text-left text-rn-11 text-rn-muted">
              <th scope="col" className="sticky top-0 bg-rn-surface px-1.5 py-1 font-semibold">{t("country")}</th>
              {brands.map((b) => (
                <th key={b} scope="col" className="sticky top-0 w-[84px] bg-rn-surface px-1.5 py-1 text-right font-semibold">{brandName(b)}</th>
              ))}
              <th scope="col" className="sticky top-0 w-[76px] bg-rn-surface px-1.5 py-1 text-right font-semibold">{t("total")}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((m) => {
              const on = act.picked.geography.includes(m.country);
              const name = act.geoLabel(m.country);
              return (
                <tr key={m.country}>
                  <th scope="row" className="px-0 py-0 text-left font-normal">
                    <Mark on={on} tip={t("countryTip", { country: name })} onClick={() => act.onPanel("geography", m.country)} className={cx("block w-full truncate rounded px-1.5 py-1 text-left hover:bg-rn-navy-25", on ? "font-bold text-rn-navy" : "text-rn-ink-2")}>
                      {name}
                    </Mark>
                  </th>
                  {brands.map((b) => {
                    const v = m.brands[b] ?? 0;
                    return (
                      <td key={b} data-rn-tip={t("cellTip", { country: name, brand: brandName(b), count: n(v) })} className={cx("rounded px-1.5 py-1 text-right tabular-nums", v ? cx(HEAT[Math.min(4, Math.ceil((v / max) * 4))], "text-rn-ink") : "text-rn-faint")}>
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
      {/* the colour scale: quarters of the largest cell (display only), no colour for 0 */}
      <p className="m-0 mt-2 flex flex-wrap items-center gap-1.5 text-rn-11 text-rn-muted" data-rn-markets-legend="">
        {[1, 2, 3, 4].map((i) => (
          <span key={i} aria-hidden className={cx("inline-block h-3 w-5 rounded-[2px]", HEAT[i])} />
        ))}
        <span>{t("legend", { max: n(max) })}</span>
      </p>
    </Card>
  );
}

// ── languages · target sites ─────────────────────────────────────────────────

function BarsCard({ kind, data, act }: { kind: "langs" | "sites"; data: WebsitePromptInsights; act: InsightActions }) {
  const t = useTranslations(`renewal.website.prompts.${kind}`);
  const tb = useTranslations("renewal.website.prompts.insights");
  const tm = useTranslations("renewal.website.prompts.markets");
  const locale = useLocale();
  const { n } = useFmt();
  const [all, setAll] = useState(false);
  const items = kind === "langs" ? data.langs.map((l) => ({ key: l.lang, label: languageName(l.lang, locale), ...l })) : data.sites.map((s) => ({ key: s.domain, label: s.domain || "—", ...s }));
  const max = Math.max(1, ...items.map((i) => i.prompts));
  const shown = all ? items : items.slice(0, TOP);
  const isOn = (key: string) => (kind === "langs" ? act.picked.language.includes(key) : act.picked.q === key);
  return (
    <Card title={t("title")} info={t("info")} actions={items.length > TOP ? <RnTextButton onClick={() => setAll((v) => !v)}>{all ? tm("less") : tm("more", { count: n(items.length) })}</RnTextButton> : undefined}>
      <div className={cx("flex flex-col gap-1", all && "max-h-[312px] overflow-auto")} data-rn-bars={kind}>
        {shown.map((i) => (
          <HBar
            key={i.key}
            label={i.label}
            value={i.prompts}
            max={max}
            on={isOn(i.key)}
            tip={tb("barTip", { label: i.label, prompts: n(i.prompts), measured: n(i.measured), answers: n(i.answers) })}
            onClick={() => (kind === "langs" ? act.onPanel("language", i.key) : act.onSite(i.key))}
          />
        ))}
      </div>
    </Card>
  );
}
