"use client";

// Renewal Website Overview — the KPI card: 핵심 요약 (findings, server-built from the screens' values) on top,
// then the website tiles by category (답변의 내용 · 출처 · 전환): value, Δ, engine badge, numerator / denominator,
// 경쟁사 대비 SOV, provenance. Each tile opens its website analysis page in a new tab.
//   tiles   website/summary (card speed) → website/summary-deferred (Δ + engine badge merged in)
// Δ tone and direction are the screen's; a Δ that rounds to 0 reads 변화 없음 (the renewal Overview's brand table,
// Mention), a tile the screen sends no Δ for says so in muted text, not as an empty chip.
// Design pass (2026-10-30, W6): the category name sits on its rule and the engine badge, the ratio and 경쟁사 대비 SOV
// read as one list under the value, so the card is shorter with every value kept.
// Under a period compare the header names the screen's compare label (renewal audit 3-5: it said '바로 앞 같은 길이의
// 기간' for a calendar month too); when the tiles compare different rounds each tile names its own (the renewal
// Overview's rule, audit 3-4).

import { Suspense, use, type ReactNode } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { ArrowUpRight } from "lucide-react";
import { RnCard, RnCardHeader, RnInfoTip, RnInfoTipItem, RnSkeleton, RnToneChip, type RnTone } from "@/components/renewal-ui";
import type { TilesView, TileView } from "@/app/[locale]/(dash)/dashboard/_data/screen-types";
import { periodChipText } from "@/lib/period-chip-text";
import { isFlat, useFormat, websiteDetailHref } from "./website-format";

const TONE: Record<TileView["tone"], RnTone> = { good: "up", bad: "down", flat: "flat" };
/** A row of the value's base list: label left, number right. */
const ROW = "flex items-baseline justify-between gap-2";

// ─── KPI ────────────────────────────────────────────────────────────────────

/** The tiles at card speed, then the same tiles with Δ and the engine badge (no layout jump: same card). */
export function RnWebsiteKpis({ tiles, deferred, qs, findings }: { tiles: TilesView; deferred: Promise<TilesView>; qs: string; findings?: ReactNode }) {
  return (
    <Suspense fallback={<KpiCard view={tiles} qs={qs} findings={findings} />}>
      <DeferredKpis deferred={deferred} qs={qs} findings={findings} />
    </Suspense>
  );
}

function DeferredKpis({ deferred, qs, findings }: { deferred: Promise<TilesView>; qs: string; findings?: ReactNode }) {
  return <KpiCard view={use(deferred)} qs={qs} findings={findings} deltas />;
}

export function KpiCard({ view, qs, deltas = false, findings }: { view: TilesView; qs: string; deltas?: boolean; findings?: ReactNode }) {
  const t = useTranslations("renewal.website.overview");
  const tO = useTranslations("dashboard.overview");
  const tCat = useTranslations("dashboard.kpi.category");
  const tR = useTranslations("renewal.overview");
  const tP = useTranslations("periodCompare");
  const period = view.groups.some((g) => g.tiles.some((x) => x.period));
  const shared = view.compareTitle;
  const perCard = period && !shared;
  const compare = !period ? tO("compare") : shared ? tP(shared.key as "label.weekly", shared.params) : tR("comparePerCard");
  const caption = view.suppressionCaption && view.suppressionCaption.key !== "window" ? view.suppressionCaption : null;
  return (
    <RnCard tone="hero" className="@container/rnwkpi" aria-label={t("kpiTitle")}>
      <RnCardHeader title={t("kpiTitle")} hint={t("kpiHintDelta", { compare })} />
      {findings ? <div className="pb-3">{findings}</div> : null}
      <div className="flex flex-col pb-3">
        {view.groups.map((g) => (
          <div key={g.category} data-rn-kpi-group={g.category} className="px-2.5 pt-2 pb-1 first:pt-0">
            <h3 className="m-0 flex items-center gap-3 px-4 pb-1 text-rn-11 font-bold tracking-[0.08em] text-rn-sky">
              {tCat(g.category)}
              <span aria-hidden className="h-px flex-1 bg-white/14" />
            </h3>
            <div className="grid grid-cols-4 @max-[760px]/rnwkpi:grid-cols-2 @max-[760px]/rnwkpi:gap-y-3">
              {g.tiles.map((tile, i) => (
                <Tile key={tile.key} tile={tile} qs={qs} deltas={deltas} end={i % 4 >= 2} periodMode={period} perCard={perCard} />
              ))}
            </div>
          </div>
        ))}
      </div>
      {caption ? (
        <p data-rn-period-reason={caption.key.replace(/^reason\./, "")} className="m-0 px-6 pb-4 text-rn-12 text-white/72">
          {tP(caption.key, caption.params)}
        </p>
      ) : null}
    </RnCard>
  );
}

function Tile({ tile, qs, deltas, end, periodMode, perCard }: { tile: TileView; qs: string; deltas: boolean; end: boolean; periodMode: boolean; perCard: boolean }) {
  const tR = useTranslations("renewal.overview");
  const tKpi = useTranslations("dashboard.kpi");
  const locale = useLocale();
  const f = useFormat();
  const t = useTranslations("renewal.website.overview");
  const tP = useTranslations("periodCompare");
  const name = tKpi(`name.${tile.key}`);
  const hasRatio = tile.ratio?.numerator != null && tile.ratio.denominator != null;
  // the original's copy variant: an "api" tile reads its label and tip from dashboard.kpi.api.* when it has them
  const copyKey = (k: string) => (tile.copyVariant === "api" && tKpi.has(`api.${k}`) ? `api.${k}` : k);
  return (
    <div data-rn-kpi={tile.key} className="group/kpi relative flex min-w-0 flex-col gap-1 border-l border-white/14 px-4 py-0.5 first:border-l-0 @max-[760px]/rnwkpi:nth-[2n+1]:border-l-0">
      <span className="flex items-center gap-1 text-rn-13 font-bold text-white/86">
        <span className="truncate">{name}</span>
        {/* above the tile's link, so ⓘ shows its tip instead of opening the page */}
        <span className="relative z-[1] inline-flex">
          <RnInfoTip label={tR("infoLabel", { name })} align={end ? "end" : "start"}>
            <RnInfoTipItem label={tR("definition")}>{tKpi(copyKey(`definition.${tile.key}`) as "definition.visibility")}</RnInfoTipItem>
            <RnInfoTipItem label={tR("formula")}>{tKpi(copyKey(`formula.${tile.key}`) as "formula.visibility")}</RnInfoTipItem>
          </RnInfoTip>
        </span>
      </span>
      <span className="flex min-h-8 flex-wrap items-center gap-x-2.5 gap-y-1">
        <KpiValue tile={tile} />
        {tile.pending ? null : <TileDelta tile={tile} deltas={deltas} periodMode={periodMode} />}
        {perCard && tile.period && tile.periodLabel ? (
          <span data-rn-compare-label="" className="text-rn-11 text-white/72">
            {tP(tile.periodLabel.key as "label.weekly", tile.periodLabel.params)}
          </span>
        ) : null}
      </span>
      {/* the value's base, one list: 엔진 간 일관성, numerator / denominator, KPI #16 경쟁사 대비 SOV (the
          shareOfVoice tile's extra row, the reference brand named) */}
      {tile.engineConsistency != null || hasRatio || tile.competitorSov ? (
        <dl className="m-0 flex flex-col gap-px border-t border-white/10 pt-1 text-rn-12">
          {tile.engineConsistency != null ? (
            <div data-rn-engine={tile.key} className={ROW}>
              <dt className="flex min-w-0 items-center gap-1 text-white/72">
                <span className="truncate">{tKpi("sub.engineConsistency")}</span>
                <span className="relative z-[1] inline-flex">
                  <RnInfoTip label={tR("infoLabel", { name: tKpi("sub.engineConsistency") })} align={end ? "end" : "start"}>
                    <RnInfoTipItem label={tR("definition")}>{tKpi("sub.def.engineConsistency.definition")}</RnInfoTipItem>
                    <RnInfoTipItem label={tR("formula")}>{tKpi("sub.def.engineConsistency.formula")}</RnInfoTipItem>
                  </RnInfoTip>
                </span>
              </dt>
              <dd className="m-0 font-semibold text-white tabular-nums">{tile.engineConsistency.toFixed(1)}%</dd>
            </div>
          ) : null}
          {hasRatio ? (
            <>
              <div data-rn-ratio={`${tile.key}.num`} className={ROW}>
                <dt className="truncate text-white/72">{tKpi(copyKey(`ratio.${tile.key}.num`) as "ratio.visibility.num")}</dt>
                <dd className="m-0 font-semibold text-white tabular-nums">{f.count(tile.ratio!.numerator!)}</dd>
              </div>
              <div data-rn-ratio={`${tile.key}.den`} className={ROW}>
                <dt className="truncate text-white/72">{tKpi(copyKey(`ratio.${tile.key}.den`) as "ratio.visibility.den")}</dt>
                <dd className="m-0 font-semibold text-white tabular-nums">{f.count(tile.ratio!.denominator!)}</dd>
              </div>
            </>
          ) : null}
          {tile.competitorSov ? (
            <div data-rn-competitor-sov="" className={ROW}>
              <dt className="truncate text-white/72">{tKpi("competitorSov", { brand: tile.competitorSov.brand })}</dt>
              {/* the same ratio (legacy KPI #16, own ÷ rival mentions × 100) read as a multiple: 41067.2% = 410.7배 */}
              <dd className="m-0 font-semibold text-white tabular-nums" title={tile.competitorSov.value == null ? undefined : `${tile.competitorSov.value.toFixed(1)}%`}>
                {/* no value (no 당사 numerator, or a reference without mentions): a dash (renewal audit 3-3) */}
                {tile.competitorSov.value == null ? "—" : t("timesOf", { n: (tile.competitorSov.value / 100).toFixed(1) })}
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}
      {tile.coverage ? <span className="text-rn-12 text-white/72">{tKpi("coverageLabel", { measured: tile.coverage.measured, total: tile.coverage.total })}</span> : null}
      {tile.provenance ? (
        <span data-rn-provenance={tile.provenance.source} className="text-rn-11 leading-snug text-white/60">
          {tile.provenance.source === "published"
            ? tKpi("provenance.published", {
                cycle: (locale === "ko" ? tile.provenance.cycleLabel : tile.provenance.cycleLabelEn) ?? tile.provenance.cycleLabel ?? tile.provenance.roundDate ?? "",
                sites: tile.provenance.siteCount ?? 0,
              })
            : tKpi("provenance.live")}
        </span>
      ) : null}
      {/* The whole tile opens its website analysis page in a new tab (the renewal Overview's cards): the link
          covers the tile, last so it lies above the tile's parts; hover lightens it and shows ↗. */}
      <Link
        prefetch={false}
        href={websiteDetailHref(tile.key, locale, qs)}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={tR("detailLabel", { name })}
        className="absolute inset-0 rounded-[10px] transition-colors hover:bg-white/6 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-rn-sky"
      />
      <ArrowUpRight aria-hidden className="pointer-events-none absolute top-1.5 right-3 size-4 text-rn-sky opacity-0 transition-opacity group-focus-within/kpi:opacity-100 group-hover/kpi:opacity-100" />
    </div>
  );
}

function KpiValue({ tile }: { tile: TileView }) {
  const tO = useTranslations("dashboard.overview");
  const f = useFormat();
  if (tile.pending || tile.value == null) return <span className="text-rn-15 leading-9 font-semibold text-white/72">{tO("cardEmpty")}</span>;
  const full = f.value(tile.unit, tile.value);
  // the number big, its unit (%, 번째) small — the renewal Overview's card
  const n = tile.unit === "count" ? full : tile.value.toFixed(1);
  const at = full.indexOf(n);
  return (
    <span data-rn-value={tile.key} className="text-rn-28 font-bold tracking-[-0.03em] whitespace-nowrap text-white tabular-nums">
      {at >= 0 ? (
        <>
          {full.slice(0, at)}
          {n}
          <small className="ml-px text-[13px] font-semibold text-white/80">{full.slice(at + n.length)}</small>
        </>
      ) : (
        full
      )}
    </span>
  );
}

/** The period chip when a period is compared, else the trend Δ (tone and direction as the screen sent them). Under a
 * period compare a tile without a period result (no compare metric for it) says so: its round Δ is not that compare. */
function TileDelta({ tile, deltas, periodMode }: { tile: TileView; deltas: boolean; periodMode: boolean }) {
  const t = useTranslations("renewal.website.overview");
  const tR = useTranslations("renewal.overview");
  const f = useFormat();
  if (tile.period) {
    if (!tile.period.suppressed && tile.period.value != null && isFlat(tile.period.value)) {
      return (
        <RnToneChip tone="flat" icon="flat" title={tR("deltaFlat")} onDark>
          {tR("deltaFlat")}
        </RnToneChip>
      );
    }
    return (
      <RnToneChip tone={tile.period.suppressed ? "none" : tile.period.direction} onDark>
        {periodChipText(tile.period)}
      </RnToneChip>
    );
  }
  if (periodMode) {
    return (
      <span data-rn-no-delta="" className="text-rn-12 text-white/60">
        {t("noPeriodDelta")}
      </span>
    );
  }
  // the card-speed tiles have no Δ yet: hold its place
  if (!deltas) return <RnSkeleton className="h-6 w-14 bg-white/14" />;
  if (tile.delta == null) {
    return (
      <span data-rn-no-delta="" className="text-rn-12 text-white/60">
        {t("noDelta")}
      </span>
    );
  }
  if (isFlat(tile.delta)) {
    return (
      <RnToneChip tone="flat" icon="flat" title={tR("deltaFlat")} onDark>
        {tR("deltaFlat")}
      </RnToneChip>
    );
  }
  const tone = TONE[tile.tone];
  const title = tone === "up" ? tR("deltaUp") : tone === "down" ? tR("deltaDown") : tR("deltaFlat");
  return (
    <RnToneChip tone={tone} icon={tile.direction} title={title} onDark>
      {f.delta(tile.unit, tile.delta)}
    </RnToneChip>
  );
}
