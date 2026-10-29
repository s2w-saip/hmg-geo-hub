"use client";

// Body of the renewal AI Visibility page: the state cards, the tab in view and the 요약 tab
// (five derived metrics on the navy hero with the findings, engine trend, 우선순위별 몫, 읽힌 빈도,
// 집중도, 기기). The other tabs: vis-pages.tsx (페이지 진단), vis-more.tsx (AI 엔진 · 사이트 · 섹션).

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { AlertTriangle, FilterX, Hourglass, Plug } from "lucide-react";
import {
  RnBasisChip,
  RnButton,
  RnCard,
  RnCardHead,
  RnDeltaChip,
  RnFindingGrid,
  RnInfoTip,
  RnInfoTipItem,
  RnLineChart,
  RnSparkline,
  cx,
  type RnFinding,
} from "@/components/renewal-ui";
import { useRnFilterReset } from "@/app/[locale]/(renewal)/renewal/_components/overview-filters";
import type { RnVisBody, VisFinding, VisView } from "../_data/screen-types";
import { CONTEXT_GREY, engineColor, useVisFmt, useVisPage, type VisFmt } from "./vis-context";
import { VisLorenz, VisStackChart } from "./vis-charts";
import { VisPageTab } from "./vis-pages";
import { VisEngineTab, VisSiteTab } from "./vis-more";

type T = ReturnType<typeof useTranslations<"renewal.visibility">>;

export function RnVisBody({ input }: { input: RnVisBody }) {
  const t = useTranslations("renewal.visibility");
  const reset = useRnFilterReset();
  const { tab } = useVisPage();
  const { view } = input;
  if (input.state !== "ok" || !view) {
    const card = {
      down: { icon: <AlertTriangle className="size-5" aria-hidden />, title: t("states.downTitle"), desc: t("states.downDesc") },
      empty: { icon: <Hourglass className="size-5" aria-hidden />, title: t("states.emptyTitle"), desc: t("states.emptyDesc", { n: input.sites, from: input.period.from ?? "…", to: input.period.to ?? "…" }) },
      nomatch: { icon: <FilterX className="size-5" aria-hidden />, title: t("states.nomatchTitle"), desc: t("states.nomatchDesc") },
      nosite: { icon: <Plug className="size-5" aria-hidden />, title: t("states.nositeTitle"), desc: t("states.nositeDesc") },
      ok: { icon: <Hourglass className="size-5" aria-hidden />, title: t("states.emptyTitle"), desc: t("states.emptyDesc", { n: input.sites, from: input.period.from ?? "…", to: input.period.to ?? "…" }) },
    }[input.state];
    return (
      <StateCard icon={card.icon} title={card.title} desc={card.desc}>
        {input.state === "nomatch" ? <RnButton onClick={reset}>{t("states.reset")}</RnButton> : null}
      </StateCard>
    );
  }
  return (
    <div className="@container/rnpage flex flex-col gap-2.5">
      {view.totals.incomplete > 0 ? (
        <p className="m-0 rounded-xl bg-rn-surface px-4 py-3 text-rn-12 text-rn-ink-2 shadow-rn-card">{t("summary.incomplete", { n: view.totals.incomplete })}</p>
      ) : null}
      {tab === "page" ? <VisPageTab view={view} /> : tab === "engine" ? <VisEngineTab view={view} /> : tab === "site" ? <VisSiteTab view={view} /> : <VisSumTab view={view} />}
      <p className="m-0 -mt-1 px-1 text-rn-11 text-rn-muted">
        {t("foot", { from: input.period.from ?? "…", to: input.period.to ?? "…", days: view.observed, sites: view.totals.sites, pages: view.totals.pages })}
      </p>
    </div>
  );
}

export function StateCard({ icon, title, desc, children }: { icon: ReactNode; title: string; desc: string; children?: ReactNode }) {
  return (
    <section className="flex flex-col items-center gap-2.5 rounded-rn-card border-[1.5px] border-dashed border-rn-line-2 px-6 py-10 text-center">
      <span className="grid size-11 place-items-center rounded-full bg-rn-navy-50 text-rn-navy">{icon}</span>
      <h2 className="m-0 text-rn-15 font-bold text-rn-ink">{title}</h2>
      <p className="m-0 max-w-[600px] text-rn-13 leading-[1.6] break-keep text-rn-muted">{desc}</p>
      {children}
    </section>
  );
}

/** ⓘ with the metric's definition and formula (renewal.visibility.def.<key>). */
export function DefTip({ k, align }: { k: "seo" | "ai" | "cov" | "int" | "read" | "stale" | "exp" | "top" | "sec"; align?: "start" | "end" }) {
  const t = useTranslations("renewal.visibility.def");
  return (
    <RnInfoTip label={t("label")} align={align}>
      <RnInfoTipItem label={t("definition")}>{t(`${k}.d`)}</RnInfoTipItem>
      <RnInfoTipItem label={t("formula")}>{t(`${k}.f`)}</RnInfoTipItem>
    </RnInfoTip>
  );
}

export function NoteTip({ title, children, align }: { title: string; children: ReactNode; align?: "start" | "end" }) {
  return (
    <RnInfoTip label={title} align={align}>
      <RnInfoTipItem label={title}>{children}</RnInfoTipItem>
    </RnInfoTip>
  );
}

export const range = (t: T, from: string | null, to: string | null) => t("range", { from: from ?? "…", to: to ?? "…" });

// ══ 요약 ══

function findingItems(view: VisView, t: T, fmt: VisFmt): RnFinding[] {
  const ref = (id: number) => {
    const r = view.rows[id];
    return t("findings.ref", { page: fmt.page(r), site: fmt.site(r) });
  };
  return view.findings.map((f: VisFinding): RnFinding => {
    switch (f.code) {
      case "stale":
        return { key: f.code, tone: f.tone, tag: t("findings.stale.tag"), title: t("findings.stale.title", { n: f.n, days: f.days }),
          detail: t("findings.stale.detail", { pages: f.rows.map(ref).join(" · "), more: f.n > f.rows.length ? t("findings.more", { n: f.n - f.rows.length }) : "" }) };
      case "section":
        return { key: f.code, tone: f.tone, tag: t("findings.section.tag"), title: t("findings.section.title", { sec: fmt.section(f.sec), seo: fmt.pct(f.seoShare, 0), ai: fmt.pct(f.aiShare, 0) }),
          detail: t("findings.section.detail", { int: fmt.rate(f.int), total: fmt.rate(f.totalInt), cov: fmt.pct(f.cov, 0) }) };
      case "shortfall":
        return { key: f.code, tone: f.tone, tag: t("findings.shortfall.tag"), title: t("findings.shortfall.title", { n: f.n }), detail: t("findings.shortfall.detail", { sum: fmt.n(f.sum), page: ref(f.row) }) };
      case "engineCoverage":
        return { key: f.code, tone: f.tone, tag: t("findings.engineCoverage.tag"),
          title: t("findings.engineCoverage.title", { low: fmt.engine(f.low), lowCov: fmt.pct(f.lowCov, 0), high: fmt.engine(f.high), highCov: fmt.pct(f.highCov, 0) }),
          detail: t("findings.engineCoverage.detail", { low: fmt.pct(f.lowCov1, 0), high: fmt.pct(f.highCov1, 0) }) };
      case "change":
        return { key: f.code, tone: f.tone, tag: t("findings.change.tag"), title: t("findings.change.title", { days: view.totals.days, chg: fmt.chg(f.dAi) }), detail: t("findings.change.detail", { fresh: f.fresh, lost: f.lost }) };
      case "concentration":
        return { key: f.code, tone: f.tone, tag: t("findings.concentration.tag"), title: t("findings.concentration.title", { top: fmt.pct(f.top10, 0), n: f.topN }),
          detail: t("findings.concentration.detail", { gini: f.gini == null ? "—" : f.gini.toFixed(2) }) };
    }
  });
}

function Kpi({ name, info, value, unit, delta, sub, spark, invert }: { name: string; info: ReactNode; value: string; unit: string; delta: ReactNode; sub: string; spark?: (number | null)[]; invert?: boolean }) {
  return (
    <div data-rn-kpi="" className="flex min-w-0 flex-col gap-1.5 border-l border-white/14 px-3.5 py-1 first:border-l-0">
      <span className="flex min-h-8 items-center gap-1 text-rn-12 leading-[1.35] font-semibold text-white/86">
        {name}
        {info}
      </span>
      <b className="text-rn-34 leading-[1.05] font-bold tracking-[-0.03em] text-white tabular-nums">
        {value}
        <small className="ml-0.5 text-rn-13 font-semibold tracking-normal text-white/78">{unit}</small>
      </b>
      <span className="flex flex-wrap items-center gap-1.5 text-rn-11 text-white/70">{delta}</span>
      {spark && spark.length > 1 ? <RnSparkline values={spark} tone="onDark" invert={invert} className="h-[30px]" /> : null}
      <span className="text-rn-11 leading-[1.4] text-white/66 [.rn-dense_&]:hidden">{sub}</span>
    </div>
  );
}

function VisHero({ view }: { view: VisView }) {
  const t = useTranslations("renewal.visibility");
  const fmt = useVisFmt(view);
  const { totals: T, spark } = view;
  const labels = { up: t("delta.up"), down: t("delta.down"), flat: t("delta.flat") };
  const basis = <span>{view.prevOk ? t("kpi.prevBasis") : t("kpi.noPrev")}</span>;
  const pctDelta = (d: number | null | undefined, lowerIsBetter = false) =>
    view.prevOk ? <RnDeltaChip onDark delta={d ?? null} lowerIsBetter={lowerIsBetter} format={(r) => `${Math.abs(r).toFixed(1)}%`} emptyText="−" labels={labels} /> : null;
  return (
    <RnCard id="sec-summary" tone="hero" aria-label={t("summary.title")} className="pb-[18px] [.rn-dense_&]:pb-3">
      <RnCardHead
        title={t("summary.title")}
        info={<NoteTip title={t("summary.howTitle")}>{t("summary.how")}</NoteTip>}
        chips={<RnBasisChip>{view.prevOk ? t("summary.chipPrev", { range: range(t, view.days[0], view.days[view.days.length - 1]), days: T.days }) : range(t, view.days[0], view.days[view.days.length - 1])}</RnBasisChip>}
      />
      <div className="grid grid-cols-2 gap-y-3.5 px-2.5 pb-4.5 @min-[1040px]/rnpage:grid-cols-5 @min-[640px]/rnpage:grid-cols-3">
        <Kpi name={t("kpi.cov1")} info={<DefTip k="cov" />} value={T.cov1 == null ? "—" : T.cov1.toFixed(1)} unit="%"
          delta={<>{view.prevOk ? <RnDeltaChip onDark delta={T.dCov1 ?? null} format={(r) => `${Math.abs(r).toFixed(1)}pp`} emptyText="−" labels={labels} /> : null}{basis}</>}
          sub={t("kpi.cov1Sub", { cov: fmt.pct(T.cov) })} spark={spark.cov1} />
        <Kpi name={t("kpi.ai")} info={<DefTip k="ai" />} value={fmt.n(T.ai)} unit={t("unit.times")} delta={<>{pctDelta(T.dAi)}{basis}</>}
          sub={t("kpi.aiSub", { seo: T.seo == null ? "—" : fmt.k(T.seo), chg: fmt.chg(T.dSeo) })} spark={spark.ai} />
        <Kpi name={t("kpi.int")} info={<DefTip k="int" />} value={fmt.rate(T.int)} unit={t("unit.times")} delta={<>{pctDelta(T.dInt)}{basis}</>} sub={t("kpi.intSub")} spark={spark.int} />
        <Kpi name={t("kpi.stale", { days: view.staleDays })} info={<DefTip k="stale" />} value={String(T.stale1)} unit={`/ ${T.p1}`} delta={basis} sub={t("kpi.staleSub")} spark={spark.stale1} invert />
        <Kpi name={t("kpi.top")} info={<DefTip k="top" />} value={T.top10 == null ? "—" : T.top10.toFixed(0)} unit="%" delta={basis}
          sub={t("kpi.topSub", { n: T.topN, gini: T.gini == null ? "—" : T.gini.toFixed(2) })} />
      </div>
      <RnFindingGrid items={findingItems(view, t, fmt)} />
    </RnCard>
  );
}

function TrendCard({ view }: { view: VisView }) {
  const t = useTranslations("renewal.visibility");
  const fmt = useVisFmt(view);
  const x = view.days.map((d) => `${+d.slice(5, 7)}/${+d.slice(8)}`);
  const series = view.engines.map((e, i) => ({ key: e.engine, name: fmt.engine(e.engine), color: e.on ? engineColor(i) : CONTEXT_GREY, values: view.trend.engines[i] }));
  return (
    <RnCard aria-label={t("trend.title")}>
      <RnCardHead title={t("trend.title")} info={<NoteTip title={t("howToRead")}>{t("trend.info")}</NoteTip>} chips={<RnBasisChip>{range(t, view.days[0], view.days[view.days.length - 1])}</RnBasisChip>} />
      <div className="px-6 pb-5 [.rn-dense_&]:px-4.5">
        <Legend items={series.map((s) => ({ key: s.key, name: s.name, color: s.color }))} />
        <VisStackChart x={x} series={series} height={200} yTick={fmt.k} value={(v) => t("unit.timesN", { n: fmt.n(v) })} title={(i) => view.days[i]} totalLabel={t("trend.total")} ariaLabel={t("trend.title")} />
        <h3 className="m-0 mt-2.5 mb-1 text-rn-12 font-bold text-rn-muted">{t("trend.seo")}</h3>
        <RnLineChart x={x} series={[{ key: "seo", name: t("trend.seoName"), color: "#7a736b", values: view.trend.seo, own: true }]} height={104} yTick={fmt.k}
          value={(v) => t("unit.timesN", { n: fmt.n(v) })} tooltipTitle={(d) => view.days[x.indexOf(d)] ?? d} ariaLabel={t("trend.seo")} />
      </div>
    </RnCard>
  );
}

export function Legend({ items }: { items: { key: string; name: string; color: string }[] }) {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-3.5 gap-y-1 text-rn-12 text-rn-ink-2">
      {items.map((s) => (
        <span key={s.key} className="inline-flex items-center gap-1.5 whitespace-nowrap">
          <i aria-hidden className="inline-block size-2.5 rounded-sm" style={{ background: s.color }} />
          {s.name}
        </span>
      ))}
    </div>
  );
}

const TIER_COLORS = ["#002c5f", "#5a85b3", "#c9d6e6", "#e3dcd3"];
const FREQ_COLORS = ["#002c5f", "#5a85b3", "#aec6df", "#e3dcd3"];
const FREQ_KEYS = ["daily", "often", "rare", "none"] as const;

function StackBar({ parts }: { parts: { key: string; w: number; color: string; label?: string; tip: string; dark?: boolean }[] }) {
  return (
    <span className="flex h-[26px] gap-0.5 overflow-hidden rounded-md bg-rn-page">
      {parts.map((p) => (
        <i key={p.key} title={p.tip} style={{ width: `${p.w}%`, background: p.color }}
          className={cx("flex h-full items-center justify-center text-rn-11 font-bold not-italic tabular-nums", p.dark ? "text-white" : "text-rn-ink-2")}>
          {p.w >= 9 ? p.label : null}
        </i>
      ))}
    </span>
  );
}

function TierCard({ view }: { view: VisView }) {
  const t = useTranslations("renewal.visibility.tier");
  const fmt = useVisFmt(view);
  const name = (p: number | null) => (p == null ? t("noPrio") : t("prio", { p }));
  const rows = [["pageShare", t("rows.pages")], ["seoShare", t("rows.seo")], ["aiShare", t("rows.ai")]] as const;
  const t1 = view.tiers.find((x) => x.prio === 1);
  return (
    <RnCard aria-label={t("title")}>
      <RnCardHead title={t("title")} info={<NoteTip title={t("title")}>{t("info")}</NoteTip>} />
      <div className="flex flex-col gap-3 px-6 pb-5 [.rn-dense_&]:px-4.5">
        {rows.map(([k, label]) => (
          <div key={k} className="grid grid-cols-[84px_minmax(0,1fr)] items-center gap-3">
            <span className="text-rn-12 font-semibold text-rn-ink-2">{label}</span>
            <StackBar parts={view.tiers.map((x, i) => ({ key: String(x.prio), w: x[k] ?? 0, color: TIER_COLORS[i], label: fmt.pct(x[k], 0), tip: `${name(x.prio)} · ${label} ${fmt.pct(x[k])}`, dark: i < 2 }))} />
          </div>
        ))}
        <Legend items={view.tiers.map((x, i) => ({ key: String(x.prio), name: t("legend", { name: name(x.prio), n: x.pages }), color: TIER_COLORS[i] }))} />
        {t1 ? <p className="m-0 text-rn-12 leading-[1.55] text-rn-ink-2">{t.rich("note", { pages: fmt.pct(t1.pageShare, 0), seo: fmt.pct(t1.seoShare, 0), ai: fmt.pct(t1.aiShare, 0), b: (c) => <b className="text-rn-ink">{c}</b> })}</p> : null}
      </div>
    </RnCard>
  );
}

function FreqCard({ view }: { view: VisView }) {
  const t = useTranslations("renewal.visibility.freq");
  const tt = useTranslations("renewal.visibility.tier");
  return (
    <RnCard aria-label={t("title")}>
      <RnCardHead title={t("title")} info={<DefTip k="read" />} chips={<RnBasisChip>{t("chip", { n: view.observed })}</RnBasisChip>} />
      <div className="flex flex-col gap-3 px-6 pb-5 [.rn-dense_&]:px-4.5">
        {view.tiers.map((x) => (
          <div key={String(x.prio)} className="grid grid-cols-[84px_minmax(0,1fr)] items-center gap-3">
            <span className="text-rn-12 font-semibold text-rn-ink-2">{x.prio == null ? tt("noPrio") : tt("prio", { p: x.prio })}</span>
            <StackBar parts={FREQ_KEYS.map((k, i) => ({ key: k, w: (x.freq[i] / x.pages) * 100, color: FREQ_COLORS[i], label: String(x.freq[i]), tip: t("tip", { bucket: t(`buckets.${k}`), n: x.freq[i], of: x.pages }), dark: i < 2 }))} />
          </div>
        ))}
        <Legend items={FREQ_KEYS.map((k, i) => ({ key: k, name: t(`buckets.${k}`), color: FREQ_COLORS[i] }))} />
      </div>
    </RnCard>
  );
}

function LorenzCard({ view }: { view: VisView }) {
  const t = useTranslations("renewal.visibility.lorenz");
  const fmt = useVisFmt(view);
  const L = view.lorenz;
  const stats: [string, string][] = [[t("top1"), fmt.pct(L.top1, 0)], [t("top10"), fmt.pct(L.top10, 0)], [t("top50"), fmt.pct(L.top50, 0)], [t("gini"), view.totals.gini == null ? "—" : view.totals.gini.toFixed(2)]];
  return (
    <RnCard aria-label={t("title")}>
      <RnCardHead title={t("title")} info={<DefTip k="top" />} />
      <div className="grid grid-cols-[minmax(0,1fr)_104px] items-center gap-4 px-6 pb-4.5 [.rn-dense_&]:px-4.5">
        <VisLorenz points={L.points} mark={L.top10} height={220} equalLabel={t("equal")} xTitle={t("x")} ariaLabel={t("title")} />
        <dl className="m-0 flex flex-col gap-2.5">
          {stats.map(([k, v]) => (
            <div key={k}>
              <dt className="text-rn-11 text-rn-muted">{k}</dt>
              <dd className="m-0 text-rn-20 font-bold tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </RnCard>
  );
}

const DEVICE_COLORS = ["#002c5f", "#5a85b3", "#aec6df", "#d7cfc6"];

function DeviceCard({ view }: { view: VisView }) {
  const t = useTranslations("renewal.visibility.device");
  const tf = useTranslations("dashboard.filters");
  const fmt = useVisFmt(view);
  const label = (d: string) => (["mobile", "desktop", "tablet"].includes(d) ? tf(`value.${d}` as "value.mobile") : d);
  return (
    <RnCard aria-label={t("title")}>
      <RnCardHead title={t("title")} info={<NoteTip title={t("title")}>{t("info")}</NoteTip>} />
      <div className="flex flex-col gap-3 px-6 pb-4.5 [.rn-dense_&]:px-4.5">
        <span className="flex h-3 gap-0.5 overflow-hidden rounded-md bg-rn-page">
          {view.devices.map((d, i) => (
            <i key={d.device} title={`${label(d.device)} · ${fmt.pct(d.share)}`} style={{ width: `${d.share ?? 0}%`, background: d.on ? DEVICE_COLORS[i] ?? CONTEXT_GREY : CONTEXT_GREY }} />
          ))}
        </span>
        <div>
          {view.devices.map((d, i) => (
            <div key={d.device} className={cx("grid min-h-[34px] grid-cols-[minmax(90px,1fr)_auto_52px] items-center gap-2.5 border-b border-rn-line text-rn-13 last:border-b-0", !d.on && "opacity-50")}>
              <span className="flex items-center gap-2">
                <i aria-hidden className="inline-block size-2.5 rounded-sm" style={{ background: DEVICE_COLORS[i] ?? CONTEXT_GREY }} />
                {label(d.device)}
                {d.on ? null : <span className="rounded bg-rn-inset px-1.5 text-rn-11 font-bold text-rn-muted">{t("off")}</span>}
              </span>
              <span className="text-right font-bold tabular-nums">{fmt.n(d.imp)}</span>
              <span className="text-right text-rn-12 text-rn-muted tabular-nums">{fmt.pct(d.share)}</span>
            </div>
          ))}
        </div>
      </div>
    </RnCard>
  );
}

function VisSumTab({ view }: { view: VisView }) {
  return (
    <>
      <VisHero view={view} />
      <TrendCard view={view} />
      <div className="grid grid-cols-1 gap-4 @min-[980px]/rnpage:grid-cols-2">
        <TierCard view={view} />
        <FreqCard view={view} />
      </div>
      <div className="grid grid-cols-1 gap-4 @min-[980px]/rnpage:grid-cols-2">
        <LorenzCard view={view} />
        <DeviceCard view={view} />
      </div>
    </>
  );
}
