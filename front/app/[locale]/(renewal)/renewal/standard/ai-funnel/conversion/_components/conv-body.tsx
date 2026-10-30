"use client";

// Body of the renewal AI Conversion page: the state cards (no property, waiting for access, nothing measured
// yet, no match, source down), then one reading order — the navy 이 기간 요약 (AI vs 일반 전환율, the gap,
// conversions, sessions, session share, the site's sessions and page views, with the findings), the daily trend
// (chart or table), the AI channel among GA4's channels and the conversion change split (conv-insights.tsx),
// engines and the device · new/returning mix, landing pages with the same page's general sessions, markets and
// events split AI · general, and the raw period-user windows (2026-10-30 BI rework: nothing the original screen
// showed is left out). Display only: every value comes from the screen model.

import { useMemo, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { AlertTriangle, FilterX, Hourglass, Info, Plug, ShieldCheck } from "lucide-react";
import { ENGINE_LABEL } from "@/components/dash/dimension-filter-panel";
import { geoCodeLabel } from "@/lib/geo-catalog/geo-code-label";
import {
  RnBasisChip,
  RnButton,
  RnCard,
  RnCardHead,
  RnDeltaChip,
  RnFindingGrid,
  RnInfoTip,
  RnInfoTipItem,
  RnSparkline,
  type RnFinding,
} from "@/components/renewal-ui";
import { useRnFilterReset } from "@/app/[locale]/(renewal)/renewal/_components/overview-filters";
import type { ConvFinding, ConvStatus, ConvView, RnConvBody } from "../_data/screen-types";
import { ConvEngineCard, ConvEventCard, ConvPageCard, ConvPropCard, ConvTrendCard } from "./conv-cards";
import { ConvChangeCard, ConvChannelCard, ConvRawCard, ConvSegmentCard } from "./conv-insights";

export type T = ReturnType<typeof useTranslations<"renewal.conversion">>;

// ── formats ──────────────────────────────────────────────────────────────────

export interface ConvFmt {
  n: (v: number | null | undefined) => string;
  pct: (v: number | null | undefined, digits?: number) => string;
  /** a signed gap in pp: "+2.8" · "−0.4" (no unit) */
  gap: (v: number | null | undefined) => string;
  one: (v: number | null | undefined) => string;
  two: (v: number | null | undefined) => string;
  /** a signed whole number: "+1,234" · "−5" · "0" */
  signed: (v: number | null | undefined) => string;
  engine: (code: string) => string;
  place: (r: { country: string | null; brand: string | null }) => string;
}

export function useConvFmt(view: Pick<ConvView, "multiBrand"> | null): ConvFmt {
  const locale = useLocale();
  const t = useTranslations("renewal.conversion");
  const tf = useTranslations("dashboard.filters");
  const multiBrand = view?.multiBrand ?? false;
  return useMemo<ConvFmt>(() => {
    const nf = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
    return {
      n: (v) => (v == null ? "—" : nf.format(Math.round(v))),
      pct: (v, digits = 1) => (v == null ? "—" : `${v.toFixed(digits)}%`),
      gap: (v) => (v == null ? "—" : Math.abs(v) < 0.05 ? "0.0" : `${v > 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}`),
      one: (v) => (v == null ? "—" : v.toFixed(1)),
      two: (v) => (v == null ? "—" : v.toFixed(2)),
      signed: (v) => (v == null ? "—" : Math.round(v) === 0 ? "0" : `${v > 0 ? "+" : "−"}${nf.format(Math.abs(Math.round(v)))}`),
      engine: (code) => ENGINE_LABEL[code] ?? (code ? code.charAt(0).toUpperCase() + code.slice(1) : code),
      place: (r) => {
        const c = r.country ? geoCodeLabel(r.country, locale, (x) => tf(`value.${x}` as "value.worldwide")) : t("props.unknown");
        return multiBrand && r.brand ? `${c} · ${r.brand}` : c;
      },
    };
  }, [locale, multiBrand, t, tf]);
}

export const range = (t: T, from: string | null | undefined, to: string | null | undefined) => t("range", { from: from ?? "…", to: to ?? "…" });

// ── shared bits ──────────────────────────────────────────────────────────────

export type DefKey = "aiRate" | "genRate" | "lift" | "conv" | "sessions" | "share" | "per100" | "landing" | "ke100";

/** ⓘ with the metric's definition and formula (renewal.conversion.def.<key>). */
export function DefTip({ k, align }: { k: DefKey; align?: "start" | "end" }) {
  const t = useTranslations("renewal.conversion.def");
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

const STATUS_CLASS: Record<ConvStatus, string> = {
  active: "bg-rn-up/12 text-rn-ink-2",
  pending_grant: "bg-rn-inset text-rn-muted",
  unmapped: "bg-rn-inset text-rn-muted",
};

export function StatusTag({ status }: { status: ConvStatus }) {
  const t = useTranslations("renewal.conversion.status");
  return <span className={`inline-flex h-5 items-center rounded px-1.5 text-rn-11 font-bold whitespace-nowrap ${STATUS_CLASS[status] ?? STATUS_CLASS.unmapped}`}>{t(status)}</span>;
}

function StateCard({ icon, title, desc, children }: { icon: ReactNode; title: string; desc: string; children?: ReactNode }) {
  return (
    <section className="flex flex-col items-center gap-2.5 rounded-rn-card border-[1.5px] border-dashed border-rn-line-2 px-6 py-10 text-center">
      <span className="grid size-11 place-items-center rounded-full bg-rn-navy-50 text-rn-navy">{icon}</span>
      <h2 className="m-0 text-rn-15 font-bold text-rn-ink">{title}</h2>
      <p className="m-0 max-w-[600px] text-rn-13 leading-[1.6] break-keep text-rn-muted">{desc}</p>
      {children}
    </section>
  );
}

/** The registered properties under a state card (waiting / nothing measured yet). */
function PropList({ input }: { input: RnConvBody }) {
  const t = useTranslations("renewal.conversion.states");
  const fmt = useConvFmt({ multiBrand: new Set(input.properties.map((p) => p.brand)).size > 1 });
  if (!input.properties.length) return null;
  return (
    <ul aria-label={t("propsLabel")} className="m-0 mt-1 flex max-w-[720px] list-none flex-wrap justify-center gap-1.5 p-0">
      {input.properties.map((p) => (
        <li key={p.id} title={t("propTip", { id: p.id })} className="inline-flex items-center gap-1.5 rounded-lg bg-rn-surface px-2.5 py-1 text-rn-12 text-rn-ink-2 shadow-rn-card">
          {fmt.place(p)}
          <StatusTag status={p.status} />
        </li>
      ))}
    </ul>
  );
}

// ══ body ══

export function RnConvBody({ input }: { input: RnConvBody }) {
  const t = useTranslations("renewal.conversion");
  const reset = useRnFilterReset();
  const { view } = input;
  if (input.state !== "ok" || !view) {
    const n = input.properties.length;
    const active = input.properties.filter((p) => p.status === "active").length;
    const empty = input.period.from && input.period.to ? t("states.emptyDesc", { n: active, from: input.period.from, to: input.period.to }) : t("states.emptyDescNoDate", { n: active });
    const card = {
      down: { icon: <AlertTriangle className="size-5" aria-hidden />, title: t("states.downTitle"), desc: t("states.downDesc") },
      noprop: { icon: <Plug className="size-5" aria-hidden />, title: t("states.nopropTitle"), desc: t("states.nopropDesc") },
      pending: { icon: <ShieldCheck className="size-5" aria-hidden />, title: t("states.pendingTitle", { n }), desc: t("states.pendingDesc") },
      nomatch: { icon: <FilterX className="size-5" aria-hidden />, title: t("states.nomatchTitle"), desc: t("states.nomatchDesc") },
      empty: { icon: <Hourglass className="size-5" aria-hidden />, title: t("states.emptyTitle"), desc: empty },
      ok: { icon: <Hourglass className="size-5" aria-hidden />, title: t("states.emptyTitle"), desc: empty },
    }[input.state];
    return (
      <StateCard icon={card.icon} title={card.title} desc={card.desc}>
        {input.state === "pending" || input.state === "empty" ? <PropList input={input} /> : null}
        {input.state === "nomatch" ? <RnButton onClick={reset}>{t("states.reset")}</RnButton> : null}
      </StateCard>
    );
  }
  return (
    <div className="@container/rnpage flex flex-col gap-2.5">
      <ConvHero view={view} />
      <ConvTrendCard view={view} />
      <div className="grid grid-cols-1 gap-2.5 @min-[980px]/rnpage:grid-cols-2">
        <ConvChannelCard view={view} />
        <ConvChangeCard view={view} />
      </div>
      <div className="grid grid-cols-1 gap-2.5 @min-[980px]/rnpage:grid-cols-2">
        <ConvEngineCard view={view} />
        <ConvSegmentCard view={view} />
      </div>
      <ConvPageCard view={view} />
      <div className="grid grid-cols-1 gap-2.5 @min-[980px]/rnpage:grid-cols-2">
        <ConvPropCard view={view} />
        <ConvEventCard view={view} />
      </div>
      <ConvRawCard view={view} />
      <p className="m-0 -mt-1 px-1 text-rn-11 text-rn-muted">
        {t("foot", { from: input.period.from ?? "…", to: input.period.to ?? "…", days: view.observed, props: view.coverage.active })}
      </p>
    </div>
  );
}

// ══ 이 기간 요약 ══

function findingItems(view: ConvView, t: T, fmt: ConvFmt): RnFinding[] {
  const known = ["desktop", "mobile", "tablet"] as const;
  const deviceName = (d: string) => ((known as readonly string[]).includes(d) ? t(`segments.values.${d as (typeof known)[number]}`) : d);
  const chg = (v: number | null | undefined, unit = "%") => (v == null ? "—" : Math.abs(v) < 0.05 ? t("delta.flat") : `${v > 0 ? "▲" : "▼"}${Math.abs(v).toFixed(1)}${unit}`);
  return view.findings.map((f: ConvFinding): RnFinding => {
    switch (f.code) {
      case "lift": {
        const title = Math.abs(f.lift) < 0.05 ? "titleFlat" : f.lift > 0 ? "titleUp" : "titleDown";
        return { key: f.code, tone: f.tone, tag: t("findings.lift.tag"), title: t(`findings.lift.${title}`, { ai: fmt.pct(f.ai), gen: fmt.pct(f.gen), lift: t("unit.ppN", { n: Math.abs(f.lift).toFixed(1) }) }),
          detail: t("findings.lift.detail") };
      }
      case "coverage":
        return { key: f.code, tone: f.tone, tag: t("findings.coverage.tag"), title: t("findings.coverage.title", { active: f.active, total: f.total }), detail: t("findings.coverage.detail") };
      case "change":
        return { key: f.code, tone: f.tone, tag: t("findings.change.tag"), title: t("findings.change.title", { chg: chg(f.sessions), days: view.days.length }),
          detail: f.dConv != null && f.volume != null && f.rate != null
            ? t("findings.change.detailSplit", { chg: chg(f.conv), d: fmt.signed(f.dConv), volume: fmt.gap(f.volume), rate: fmt.gap(f.rate) })
            : t("findings.change.detail", { chg: chg(f.conv) }) };
      case "channel":
        return { key: f.code, tone: f.tone, tag: t("findings.channel.tag"), title: t("findings.channel.title", { rank: f.rank, n: f.n, share: fmt.pct(f.share, 2) }),
          detail: f.per100 != null && f.per100Rank != null ? t("findings.channel.detail", { per100: fmt.one(f.per100), rank: f.per100Rank, total: fmt.one(f.total) }) : undefined };
      case "samePage":
        return { key: f.code, tone: f.tone, tag: t("findings.samePage.tag"), title: t("findings.samePage.title", { page: view.pages[f.page]?.path ?? "—", ai: fmt.one(f.ai), gen: fmt.one(f.gen) }),
          detail: t("findings.samePage.detail") };
      case "device":
        return { key: f.code, tone: f.tone, tag: t("findings.device.tag"), title: t("findings.device.title", { device: deviceName(f.device), ai: fmt.pct(f.ai, 0), gen: fmt.pct(f.gen, 0) }),
          detail: t("findings.device.detail") };
      case "engine":
        return { key: f.code, tone: f.tone, tag: t("findings.engine.tag"), title: t("findings.engine.title", { engine: fmt.engine(f.engine), share: fmt.pct(f.share) }),
          detail: f.best === f.engine ? t("findings.engine.detailSame", { engine: fmt.engine(f.engine), per100: fmt.one(f.per100) })
            : t("findings.engine.detailBest", { best: fmt.engine(f.best), bestPer100: fmt.one(f.bestPer100), engine: fmt.engine(f.engine), per100: fmt.one(f.per100) }) };
      case "pages":
        return { key: f.code, tone: f.tone, tag: t("findings.pages.tag"), title: t("findings.pages.title", { n: f.n, share: fmt.pct(f.share, 0) }), detail: t("findings.pages.detail", { page: view.pages[f.page]?.path ?? "—" }) };
      case "share":
        return { key: f.code, tone: f.tone, tag: t("findings.share.tag"), title: t("findings.share.title", { share: fmt.pct(f.share) }),
          detail: view.prevOk ? t("findings.share.detail", { d: chg(f.d, "pp") }) : t("kpi.noPrev") };
    }
  });
}

function Kpi({ name, info, value, unit, delta, sub, spark }: { name: string; info: ReactNode; value: string; unit: string; delta: ReactNode; sub: ReactNode; spark?: (number | null)[] }) {
  return (
    <div data-rn-kpi="" className="flex min-w-0 flex-col gap-1.5 border-l border-white/14 px-3.5 py-1 first:border-l-0">
      <span className="flex min-h-8 items-center gap-1 text-rn-12 leading-[1.35] font-semibold text-white/86">
        {name}
        {info}
      </span>
      <b className="text-rn-34 leading-[1.05] font-bold tracking-[-0.03em] text-white tabular-nums">
        {value}
        {value !== "—" && unit ? <small className="ml-0.5 text-rn-13 font-semibold tracking-normal text-white/78">{unit}</small> : null}
      </b>
      <span className="flex min-h-6 flex-wrap items-center gap-1.5 text-rn-11 text-white/70">{delta}</span>
      {spark && spark.length > 1 ? <RnSparkline values={spark} tone="onDark" className="h-[30px]" /> : null}
      <span className="text-rn-11 leading-[1.4] break-keep text-white/66">{sub}</span>
    </div>
  );
}

function ConvHero({ view }: { view: ConvView }) {
  const t = useTranslations("renewal.conversion");
  const fmt = useConvFmt(view);
  const { totals: T, spark } = view;
  const labels = { up: t("delta.up"), down: t("delta.down"), flat: t("delta.flat") };
  const basis = <span>{view.prevOk ? t("kpi.prevBasis") : t("kpi.noPrev")}</span>;
  const chip = (d: number | null | undefined, unit: "%" | "pp") =>
    view.prevOk ? <RnDeltaChip onDark delta={d ?? null} format={(r) => `${Math.abs(r).toFixed(1)}${unit}`} emptyText="−" labels={labels} /> : null;
  const span = range(t, view.days[0], view.days[view.days.length - 1]);
  const noRate = T.aiRate == null || T.genRate == null;
  const note = "m-0 mx-5 mb-3 flex items-start gap-1.5 rounded-lg bg-white/8 px-3 py-2 text-rn-12 leading-[1.5] break-keep text-white/86";
  const missed = view.missing.map((m) => t("summary.missingItem", { place: fmt.place(m), n: m.days.length })).join(", ");
  return (
    <RnCard id="sec-summary" tone="hero" aria-label={t("summary.title")} className="pb-3">
      <RnCardHead
        title={t("summary.title")}
        info={<NoteTip title={t("summary.howTitle")}>{t("summary.how")}</NoteTip>}
        chips={<RnBasisChip>{view.prevOk ? t("summary.chipPrev", { range: span, days: view.days.length }) : span}</RnBasisChip>}
      />
      <div className="grid grid-cols-2 gap-y-3.5 px-2.5 pb-4 @min-[640px]/rnpage:grid-cols-3 @min-[1040px]/rnpage:grid-cols-6">
        <Kpi name={t("kpi.aiRate")} info={<DefTip k="aiRate" />} value={fmt.one(T.aiRate)} unit="%" delta={<>{chip(T.dAiRate, "pp")}{basis}</>}
          sub={T.aiUsers == null ? t("kpi.rateSubNoUsers", { conv: fmt.n(T.aiConv) }) : t("kpi.rateSub", { conv: fmt.n(T.aiConv), users: fmt.n(T.aiUsers) })} />
        <Kpi name={t("kpi.genRate")} info={<DefTip k="genRate" />} value={fmt.one(T.genRate)} unit="%" delta={<>{chip(T.dGenRate, "pp")}{basis}</>}
          sub={T.genUsers == null ? t("kpi.rateSubNoUsers", { conv: fmt.n(T.genConv) }) : t("kpi.rateSub", { conv: fmt.n(T.genConv), users: fmt.n(T.genUsers) })} />
        <Kpi name={t("kpi.lift")} info={<DefTip k="lift" />} value={fmt.gap(T.lift)} unit="pp" delta={<>{chip(T.dLift, "pp")}{basis}</>}
          sub={T.lift == null ? t("kpi.liftNone") : Math.abs(T.lift) < 0.05 ? t("kpi.liftFlat") : T.lift > 0 ? t("kpi.liftUp") : t("kpi.liftDown")} />
        <Kpi name={t("kpi.conv")} info={<DefTip k="conv" />} value={fmt.n(T.aiConv)} unit={t("unit.conv")} delta={<>{chip(T.dAiConv, "%")}{basis}</>}
          sub={t("kpi.convSub", { n: fmt.one(T.per100) })} spark={spark.conv} />
        <Kpi name={t("kpi.sessions")} info={<DefTip k="sessions" />} value={fmt.n(T.aiSessions)} unit={t("unit.sessions")} delta={<>{chip(T.dAiSessions, "%")}{basis}</>}
          sub={T.perUser == null ? t("kpi.sessionsSubNoUsers") : t("kpi.sessionsSub", { users: fmt.n(T.aiUsers), per: T.perUser.toFixed(2) })} spark={spark.sessions} />
        <Kpi name={t("kpi.share")} info={<DefTip k="share" align="end" />} value={fmt.one(T.share)} unit="%" delta={<>{chip(T.dShare, "pp")}{basis}</>}
          sub={t("kpi.shareSub", { gen: fmt.n(T.genSessions) })} />
      </div>
      <p data-rn-site="" className="m-0 mx-5 mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-white/14 pt-2.5 text-rn-12 text-white/78 tabular-nums">
        <b className="font-semibold text-white/90">{t("site.label")}</b>
        <span className="inline-flex items-center gap-1.5">{t("site.sessions", { n: fmt.n(T.siteSessions) })}{chip(T.dSite, "%")}</span>
        <span className="inline-flex items-center gap-1.5">{t("site.views", { n: fmt.n(T.pageViews) })}{chip(T.dPageViews, "%")}</span>
        <span>{t("site.genSessions", { n: fmt.n(T.genSessions) })}</span>
        <span>{t("site.genPer100", { n: fmt.one(T.genPer100) })}</span>
      </p>
      {view.missing.length ? (
        <p data-rn-missing="" className={note}>
          <Info className="mt-0.5 size-3.5 flex-none" aria-hidden />
          {t("summary.missing", { n: view.missing.length, list: missed })}
        </p>
      ) : null}
      {/* without a filter the missed days (above) are why the rates are gone, not the period-user windows */}
      {noRate && (view.filtered || !view.missing.length) ? (
        <p className={note}>
          <Info className="mt-0.5 size-3.5 flex-none" aria-hidden />
          {view.filtered ? t("summary.usersFilter") : t("summary.usersWindow")}
        </p>
      ) : null}
      <RnFindingGrid items={findingItems(view, t, fmt)} />
    </RnCard>
  );
}
