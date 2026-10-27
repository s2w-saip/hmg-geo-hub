"use client";

// AI 엔진 tab (engine tiles, 7-day engine share, the engine combinations that read each page,
// engine × URL 섹션 coverage, crawler bots) and 사이트 · 섹션 tab (the site benchmark with the heat
// levels the screen computed, the URL 섹션 search vs AI shares). Display only.

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { DIMENSIONS } from "@/components/dash/dimension-filter-panel";
import { rhqForCountry, rhqLabel } from "@/lib/rhq";
import { RnBasisChip, RnCard, RnCardHead, RnDeltaChip, RnSparkline, cx } from "@/components/renewal-ui";
import type { VisHeatKey, VisSite, VisView } from "../_data/screen-types";
import { CONTEXT_GREY, engineColor, useVisFmt } from "./vis-context";
import { VisShareColumns } from "./vis-charts";
import { DefTip, Legend, NoteTip, range } from "./vis-body";

const md = (d: string) => `${+d.slice(5, 7)}/${+d.slice(8)}`;

function Tag({ children }: { children: string }) {
  return <span className="rounded bg-rn-inset px-1.5 py-px text-rn-11 font-bold whitespace-nowrap text-rn-muted">{children}</span>;
}

// ══ AI 엔진 ══

function EngineTiles({ view }: { view: VisView }) {
  const t = useTranslations("renewal.visibility.engine");
  const tv = useTranslations("renewal.visibility");
  const fmt = useVisFmt(view);
  const labels = { up: tv("delta.up"), down: tv("delta.down"), flat: tv("delta.flat") };
  return (
    <RnCard aria-label={t("title")}>
      <RnCardHead title={t("title")} info={<NoteTip title={t("title")}>{t("info")}</NoteTip>} chips={<RnBasisChip>{range(tv, view.days[0], view.days[view.days.length - 1])}</RnBasisChip>} />
      <div className="grid grid-cols-2 gap-2.5 px-6 pb-5 @min-[980px]/rnpage:grid-cols-4 [.rn-dense_&]:px-4.5">
        {view.engines.map((e, i) => (
          <div key={e.engine} data-rn-engine={e.engine} className={cx("flex min-w-0 flex-col gap-2 rounded-xl bg-rn-page px-4 py-3.5", !e.on && "opacity-50")} style={{ boxShadow: `inset 0 3px 0 ${engineColor(i)}` }}>
            <div className="flex items-center gap-1.5 text-rn-13">
              <i aria-hidden className="inline-block size-2.5 rounded-sm" style={{ background: engineColor(i) }} />
              <b className="font-bold">{fmt.engine(e.engine)}</b>
              {!e.on ? <Tag>{t("offFilter")}</Tag> : !DIMENSIONS.engine.includes(e.engine) ? <Tag>{t("outsideOptions")}</Tag> : null}
            </div>
            <div>
              <b className="text-rn-24 font-bold tracking-[-0.02em] tabular-nums">{fmt.n(e.hits)}</b>
              <small className="ml-1 text-rn-12 text-rn-muted">{t("hitsShare", { share: fmt.pct(e.share, 0) })}</small>
            </div>
            <div className="grid min-h-7 grid-cols-[auto_minmax(0,1fr)] items-center gap-2">
              {view.prevOk ? <RnDeltaChip delta={e.d} format={(r) => `${Math.abs(r).toFixed(1)}%`} emptyText="−" labels={labels} /> : <span />}
              {e.spark.length > 1 ? <RnSparkline values={e.spark} className="h-7" /> : null}
            </div>
            <dl className="m-0 grid grid-cols-3 gap-1.5 border-t border-rn-line-2 pt-2">
              {([["cov", fmt.pct(e.cov, 0)], ["cov1", fmt.pct(e.cov1, 0)], ["bots", t("botsN", { n: e.bots.length })]] as const).map(([k, v]) => (
                <div key={k}>
                  <dt className="text-rn-11 text-rn-muted">{t(k)}</dt>
                  <dd className="m-0 mt-0.5 text-rn-13 font-bold tabular-nums">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </RnCard>
  );
}

function ShareCard({ view }: { view: VisView }) {
  const t = useTranslations("renewal.visibility.eshare");
  const fmt = useVisFmt(view);
  const series = view.engines.map((e, i) => ({ key: e.engine, name: fmt.engine(e.engine), color: engineColor(i), values: view.engineShare.map((s) => s[i] ?? 0) }));
  return (
    <RnCard aria-label={t("title")}>
      <RnCardHead title={t("title")} info={<NoteTip title={t("title")}>{t("info")}</NoteTip>} chips={<RnBasisChip>{t("chip", { n: view.blocks.length })}</RnBasisChip>} />
      <div className="px-6 pb-5 [.rn-dense_&]:px-4.5">
        {view.blocks.length < 2 ? (
          <p className="m-0 rounded-[10px] bg-rn-page p-3.5 text-rn-12 text-rn-muted">{t("need")}</p>
        ) : (
          <>
            <Legend items={series.map((s) => ({ key: s.key, name: s.name, color: s.color }))} />
            <VisShareColumns x={view.blocks.map((b) => md(b[1]))} series={series} height={200} title={(i) => `${view.blocks[i][0]} ~ ${view.blocks[i][1]}`} ariaLabel={t("title")} />
          </>
        )}
      </div>
    </RnCard>
  );
}

function ComboCard({ view }: { view: VisView }) {
  const t = useTranslations("renewal.visibility.combo");
  const fmt = useVisFmt(view);
  const rows = view.combos.slice(0, 8);
  const rest = view.combos.slice(8);
  const max = Math.max(1, ...rows.map((c) => c.n));
  const all = view.engines.map((e) => e.engine);
  const label = (set: string[]) =>
    !set.length ? t("none") : set.length === all.length ? t("all") : set.length === all.length - 1 && all.length > 2 ? t("without", { engine: fmt.engine(all.find((e) => !set.includes(e)) ?? "") })
      : set.length === 1 ? t("only", { engine: fmt.engine(set[0]) }) : set.map(fmt.engine).join(" + ");
  const grid = "grid grid-cols-[minmax(64px,auto)_minmax(110px,1.2fr)_minmax(60px,1fr)_40px_40px] items-center gap-2.5";
  return (
    <RnCard aria-label={t("title")}>
      <RnCardHead title={t("title")} info={<NoteTip title={t("title")}>{t("info")}</NoteTip>} chips={<RnBasisChip>{t("chip", { n: view.combos.length })}</RnBasisChip>} />
      <div className="flex flex-col px-6 pb-4.5 [.rn-dense_&]:px-4.5">
        <div className={cx(grid, "min-h-[30px] border-b border-rn-line text-rn-11 font-semibold text-rn-muted")}>
          <span className="grid justify-items-center" style={{ gridTemplateColumns: `repeat(${all.length}, 16px)` }}>
            {all.map((e) => <span key={e} title={fmt.engine(e)}>{fmt.engine(e).slice(0, 2)}</span>)}
          </span>
          <span>{t("cols.set")}</span>
          <span />
          <span className="text-right">{t("cols.pages")}</span>
          <span className="text-right">{t("cols.share")}</span>
        </div>
        {rows.map((c) => (
          <div key={c.set.join("+") || "-"} className={cx(grid, "min-h-8 border-b border-rn-line text-rn-12")}>
            <span className="grid justify-items-center" style={{ gridTemplateColumns: `repeat(${all.length}, 16px)` }}>
              {all.map((e, i) => <i key={e} aria-hidden className="inline-block size-2.5 rounded-full" style={{ background: c.set.includes(e) ? engineColor(i) : "var(--color-rn-line-2)" }} />)}
            </span>
            <span className="truncate text-rn-ink-2">{label(c.set)}</span>
            <span className="h-2 overflow-hidden rounded bg-rn-page">
              <i className="block h-full rounded" style={{ width: `${(c.n / max) * 100}%`, background: c.set.length ? "#002c5f" : "#c4482f" }} />
            </span>
            <span className="text-right font-bold tabular-nums">{c.n}</span>
            <span className="text-right text-rn-muted tabular-nums">{fmt.pct(c.share, 0)}</span>
          </div>
        ))}
        {rest.length ? <p className="m-0 mt-1.5 text-rn-11 text-rn-muted">{t("rest", { n: rest.length, pages: rest.reduce((s, c) => s + c.n, 0) })}</p> : null}
      </div>
    </RnCard>
  );
}

// one background per cell (cx joins classes, it does not resolve conflicts): the level, or the page tone
const covLevel = (v: number | null) => (v == null ? "bg-rn-page" : v >= 90 ? "bg-[color-mix(in_srgb,var(--color-rn-navy)_38%,#fff)] font-bold text-rn-navy-900" : v >= 75 ? "bg-[color-mix(in_srgb,var(--color-rn-navy)_22%,#fff)] text-rn-navy" : v >= 50 ? "bg-[color-mix(in_srgb,var(--color-rn-navy)_10%,#fff)]" : v >= 25 ? "bg-[color-mix(in_srgb,#eb6834_10%,#fff)]" : "bg-[color-mix(in_srgb,#c4482f_14%,#fff)] text-rn-danger-ink");

function EngineSectionCard({ view }: { view: VisView }) {
  const t = useTranslations("renewal.visibility.esec");
  const fmt = useVisFmt(view);
  const cols = { gridTemplateColumns: `minmax(130px,1.4fr) 52px repeat(${view.engines.length}, minmax(64px,1fr))` };
  return (
    <RnCard aria-label={t("title")}>
      <RnCardHead title={t("title")} info={<NoteTip title={t("title")}>{t("info")}</NoteTip>} />
      <div className="flex flex-col px-6 pb-4.5 [.rn-dense_&]:px-4.5">
        <div className="grid min-h-[34px] items-center gap-1.5 border-y border-rn-line text-rn-12 font-semibold whitespace-nowrap text-rn-muted" style={cols}>
          <span>{t("cols.sec")}</span>
          <span className="text-right">{t("cols.pages")}</span>
          {view.engines.map((e, i) => (
            <span key={e.engine} className="inline-flex items-center justify-center gap-1.5">
              <i aria-hidden className="inline-block size-2.5 rounded-sm" style={{ background: engineColor(i) }} />
              {fmt.engine(e.engine)}
            </span>
          ))}
        </div>
        {view.sections.map((s) => (
          <div key={s.sec} className="grid min-h-[34px] items-center gap-1.5 border-b border-rn-line text-rn-12" style={cols}>
            <span className="truncate font-semibold text-rn-ink-2">{fmt.section(s.sec)}</span>
            <span className="text-right tabular-nums">{s.pages}</span>
            {s.engCov.map((v, i) => (
              <span key={view.engines[i].engine} className={cx("flex h-7 items-center justify-center rounded-md font-semibold tabular-nums text-rn-ink-2", covLevel(v))}>{fmt.pct(v, 0)}</span>
            ))}
          </div>
        ))}
      </div>
    </RnCard>
  );
}

function BotCard({ view }: { view: VisView }) {
  const t = useTranslations("renewal.visibility.bots");
  const fmt = useVisFmt(view);
  const max = Math.max(1, ...view.engines.flatMap((e) => e.bots.map((b) => b.hits)));
  return (
    <RnCard aria-label={t("title")}>
      <RnCardHead title={t("title")} info={<NoteTip title={t("title")}>{t("info")}</NoteTip>} />
      <div role="list" className="flex flex-col px-6 pb-4.5 [.rn-dense_&]:px-4.5">
        {view.engines.flatMap((e, i) =>
          e.bots.map((b) => (
            <div key={`${e.engine}-${b.code}`} role="listitem" className={cx("grid min-h-8 grid-cols-[minmax(180px,1.2fr)_minmax(80px,2fr)_76px_52px] items-center gap-2.5 border-b border-rn-line text-rn-13", !e.on && "opacity-50")}>
              <span className="flex min-w-0 items-center gap-2 font-semibold whitespace-nowrap">
                <i aria-hidden className="inline-block size-2.5 rounded-sm" style={{ background: engineColor(i) }} />
                {b.code}
                <span className="text-rn-11 font-medium text-rn-muted">{fmt.engine(e.engine)}</span>
              </span>
              <span className="h-2 overflow-hidden rounded bg-rn-page">
                <i className="block h-full rounded" style={{ width: `${(b.hits / max) * 100}%`, background: e.on ? engineColor(i) : CONTEXT_GREY }} />
              </span>
              <span className="text-right font-bold tabular-nums">{fmt.n(b.hits)}</span>
              <span className="text-right text-rn-12 text-rn-muted tabular-nums">{fmt.pct(b.share)}</span>
            </div>
          )),
        )}
      </div>
    </RnCard>
  );
}

export function VisEngineTab({ view }: { view: VisView }) {
  return (
    <>
      <EngineTiles view={view} />
      <div className="grid grid-cols-1 gap-4 @min-[980px]/rnpage:grid-cols-2">
        <ShareCard view={view} />
        <ComboCard view={view} />
      </div>
      <EngineSectionCard view={view} />
      <BotCard view={view} />
    </>
  );
}

// ══ 사이트 · 섹션 ══

type SiteCol = "pages" | VisHeatKey;
const SITE_COLS: SiteCol[] = ["pages", "ai", "d", "cov1", "int", "read", "top10", "short"];
// good (4) ↔ bad (0); volume (ai) is navy intensity only
const GOOD_BAD = ["bg-[color-mix(in_srgb,#c4482f_14%,#fff)] text-rn-danger-ink", "bg-[color-mix(in_srgb,#eb6834_10%,#fff)]", "bg-[color-mix(in_srgb,var(--color-rn-navy)_10%,#fff)]",
  "bg-[color-mix(in_srgb,var(--color-rn-navy)_22%,#fff)] text-rn-navy", "bg-[color-mix(in_srgb,var(--color-rn-navy)_38%,#fff)] font-bold text-rn-navy-900"];
const VOLUME = ["bg-rn-heat-0", "bg-rn-heat-1", "bg-rn-heat-2", "bg-rn-heat-3 text-rn-navy", "bg-rn-heat-4 font-bold text-rn-navy-900"];

function SiteCard({ view }: { view: VisView }) {
  const t = useTranslations("renewal.visibility.bench");
  const tv = useTranslations("renewal.visibility");
  const locale = useLocale();
  const fmt = useVisFmt(view);
  const [sort, setSort] = useState<{ k: SiteCol; dir: 1 | -1 }>({ k: "ai", dir: -1 });
  const rows = [...view.sites].sort((a, b) => ((a[sort.k] ?? -1e18) - (b[sort.k] ?? -1e18)) * sort.dir || a.key - b.key);
  const value = (s: VisSite, k: SiteCol) =>
    k === "pages" ? String(s.pages) : k === "ai" ? fmt.n(s.ai) : k === "d" ? fmt.chg(s.d) : k === "int" ? fmt.rate(s.int) : k === "short" ? String(s.short) : fmt.pct(s[k], 0);
  const cell = (s: VisSite, k: SiteCol) => {
    if (k === "pages") return "justify-end";
    const lv = s.heat[k];
    return lv == null ? "bg-rn-page" : k === "ai" ? VOLUME[lv] : GOOD_BAD[lv];
  };
  const onSort = (k: SiteCol) => setSort((s) => (s.k === k ? { k, dir: s.dir === 1 ? -1 : 1 } : { k, dir: k === "top10" || k === "short" ? 1 : -1 }));
  const cols = { gridTemplateColumns: "minmax(130px,1.3fr) 52px repeat(7, minmax(72px,1fr))" };
  const rhq = (s: VisSite) => (s.brand && s.country ? rhqLabel(rhqForCountry(s.brand, s.country) ?? "", locale === "en" ? "en" : "ko") ?? "" : "");
  return (
    <RnCard aria-label={t("title")}>
      <RnCardHead title={t("title")} info={<NoteTip title={t("title")}>{t("info", { days: view.staleDays })}</NoteTip>} chips={<RnBasisChip>{t("chip", { n: rows.length })}</RnBasisChip>} />
      <div className="overflow-x-auto pb-2">
        <div className="grid min-h-[34px] min-w-[760px] items-center gap-1.5 border-y border-rn-line px-6 text-rn-12 font-semibold whitespace-nowrap text-rn-muted" style={cols}>
          <span>{t("cols.site")}</span>
          {SITE_COLS.map((k) => {
            const on = sort.k === k;
            return (
              <span key={k} role="columnheader" aria-sort={on ? (sort.dir === 1 ? "ascending" : "descending") : undefined} className="justify-self-end">
                <button type="button" onClick={() => onSort(k)} className="inline-flex cursor-pointer items-center gap-1 hover:text-rn-ink">
                  {t(`cols.${k}`)}
                  <span aria-hidden className={cx("text-rn-11", on ? "text-rn-navy" : "opacity-0")}>{on && sort.dir === 1 ? "↑" : "↓"}</span>
                </button>
              </span>
            );
          })}
        </div>
        {rows.map((s) => (
          <div key={s.key} className="grid min-h-[42px] min-w-[760px] items-center gap-1.5 border-b border-rn-line px-6 text-rn-12 hover:bg-rn-navy-25" style={cols}>
            <span className="flex min-w-0 flex-col">
              <b className="truncate text-rn-13 font-semibold">{fmt.site(s)}</b>
              <small className="text-rn-11 text-rn-muted">{rhq(s)}</small>
            </span>
            {SITE_COLS.map((k) => (
              <span key={k} className={cx("flex h-7 items-center justify-center rounded-md font-semibold tabular-nums text-rn-ink-2", cell(s, k))}>
                {value(s, k)}
                {k === "short" && s.stale1 ? <em className="ml-1.5 rounded-sm bg-white px-1 text-rn-11 font-bold not-italic text-rn-danger-ink" title={t("staleTitle", { days: view.staleDays })}>{t("staleTag", { n: s.stale1 })}</em> : null}
              </span>
            ))}
          </div>
        ))}
      </div>
      <p className="m-0 px-6 pt-1 pb-3 text-rn-11 text-rn-muted">{tv("bench.legend")}</p>
    </RnCard>
  );
}

function SectionCard({ view }: { view: VisView }) {
  const t = useTranslations("renewal.visibility.secs");
  const fmt = useVisFmt(view);
  const max = Math.max(5, ...view.sections.flatMap((s) => [s.seoShare ?? 0, s.aiShare ?? 0])) * 1.08;
  const X = (v: number | null) => ((v ?? 0) / max) * 100;
  const grid = "grid grid-cols-[minmax(130px,1.1fr)_48px_minmax(180px,2.6fr)_68px_64px_56px] items-center gap-2.5";
  return (
    <RnCard aria-label={t("title")}>
      <RnCardHead title={t("title")} info={<DefTip k="sec" />} chips={<RnBasisChip>{t("chip", { n: view.sections.length })}</RnBasisChip>} sub={t("sub")} />
      <div className="flex flex-col px-6 pb-4.5 [.rn-dense_&]:px-4.5">
        <div className={cx(grid, "min-h-[34px] border-y border-rn-line text-rn-12 font-semibold whitespace-nowrap text-rn-muted")}>
          <span>{t("cols.sec")}</span>
          <span className="text-right">{t("cols.pages")}</span>
          <span className="flex gap-3 font-medium">
            <span className="inline-flex items-center gap-1.5"><i aria-hidden className="inline-block size-2.5 rounded-full bg-[#9a928a]" />{t("seoShare")}</span>
            <span className="inline-flex items-center gap-1.5"><i aria-hidden className="inline-block size-2.5 rounded-full bg-rn-navy" />{t("aiShare")}</span>
          </span>
          <span className="text-right">{t("cols.gap")}</span>
          <span className="text-right">{t("cols.cov")}</span>
          <span className="text-right">{t("cols.int")}</span>
        </div>
        {view.sections.map((s) => {
          const a = X(s.seoShare);
          const b = X(s.aiShare);
          return (
            <div key={s.sec} className={cx(grid, "min-h-[38px] border-b border-rn-line text-rn-12")}>
              <span className="truncate text-rn-13 font-semibold text-rn-ink-2">{fmt.section(s.sec)}</span>
              <span className="text-right tabular-nums">{s.pages}</span>
              <span className="relative mx-1.5 h-[18px]" title={t("tip", { sec: fmt.section(s.sec), seo: fmt.pct(s.seoShare), ai: fmt.pct(s.aiShare) })}>
                <i className="absolute inset-x-0 top-1/2 h-px bg-rn-line" />
                <i className={cx("absolute top-1/2 h-1 -translate-y-1/2 rounded-sm", s.gap < 0 ? "bg-[color-mix(in_srgb,#eb6834_45%,#fff)]" : "bg-[color-mix(in_srgb,var(--color-rn-navy)_30%,#fff)]")}
                  style={{ left: `${Math.min(a, b)}%`, width: `${Math.abs(a - b)}%` }} />
                <i className="absolute top-1/2 size-[11px] -translate-1/2 rounded-full border-2 border-white bg-[#9a928a]" style={{ left: `${a}%` }} />
                <i className="absolute top-1/2 size-[11px] -translate-1/2 rounded-full border-2 border-white bg-rn-navy" style={{ left: `${b}%` }} />
              </span>
              <span className={cx("text-right font-bold tabular-nums", s.gap <= -3 ? "text-[#b4501f]" : s.gap >= 3 ? "text-rn-up" : "")}>{`${s.gap >= 0 ? "+" : "−"}${Math.abs(s.gap).toFixed(1)}pp`}</span>
              <span className="text-right tabular-nums">{fmt.pct(s.cov, 0)}</span>
              <span className="text-right tabular-nums">{fmt.rate(s.int)}</span>
            </div>
          );
        })}
      </div>
    </RnCard>
  );
}

export function VisSiteTab({ view }: { view: VisView }) {
  const t = useTranslations("renewal.visibility.bench");
  return (
    <>
      {view.sites.length > 1 ? <SiteCard view={view} /> : <p className="m-0 rounded-xl bg-rn-surface px-4 py-3 text-rn-12 text-rn-ink-2 shadow-rn-card">{t("single")}</p>}
      <SectionCard view={view} />
    </>
  );
}
