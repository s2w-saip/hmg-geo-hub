"use client";

// Renewal Website Overview — the two breakdowns of the KPI card's numbers (Gold values, laid out):
//   HMG 브랜드별 비교   website/brands: each brand's tiles side by side (administrators without a brand pick), the
//                       HMG total row = the KPI card's tiles; best per column and bar widths come with the screen
//   엔진별 비교         website/engines: the engine rows behind 엔진 간 일관성 (answers, five values, num / den on
//                       hover), best / worst per column and the badge's consistency row
// A row narrows the page to that brand / engine (the filter panel's own toggle).

import { use } from "react";
import { useTranslations } from "next-intl";
import { RnCard, RnCardHeader, RnEmpty, RnTag, cx, type RnTone } from "@/components/renewal-ui";
import { NO_DELTA } from "@/app/[locale]/(dash)/dashboard/_components/overview-kpi-cards";
import type { TilesView, TileView } from "@/app/[locale]/(dash)/dashboard/_data/screen-types";
import { periodChipText } from "@/lib/period-chip-text";
import {
  ENGINE_KPI_KEYS,
  WEBSITE_KPI_KEYS,
  engineLabel,
  isFlat,
  unitOf,
  useFormat,
  useShortName,
  type BrandCellView,
  type Failed,
  type WebsiteBrandsView,
  type WebsiteEnginesView,
} from "./website-format";

const TONE: Record<TileView["tone"], RnTone> = { good: "up", bad: "down", flat: "flat" };

/** A row that narrows the page (the panel's toggle); absent in tests and for a read-only row. */
export type PickRow = (value: string) => void;

function DeltaText({ cell, periodMode }: { cell: Pick<BrandCellView, "unit" | "delta" | "direction" | "tone" | "period" | "pending">; periodMode: boolean }) {
  const t = useTranslations("renewal.website.overview");
  const tR = useTranslations("renewal.overview");
  const f = useFormat();
  if (cell.pending) return null;
  if (cell.period) {
    if (!cell.period.suppressed && cell.period.value != null && isFlat(cell.period.value)) {
      return <span data-tone="flat" className="text-rn-11 font-semibold whitespace-nowrap text-rn-muted">{tR("deltaFlat")}</span>;
    }
    const tone: RnTone = cell.period.suppressed ? "none" : cell.period.direction;
    return <Mark tone={tone} dir={cell.period.direction}>{periodChipText(cell.period)}</Mark>;
  }
  // under a period compare, a cell without a period result has no Δ of that compare (its round Δ is not it)
  if (periodMode) return <span className="text-rn-11 text-rn-faint" title={t("noPeriodDelta")}>{NO_DELTA}</span>;
  if (cell.delta == null) return <span className="text-rn-11 text-rn-faint">{NO_DELTA}</span>;
  // a Δ that rounds to 0 (the renewal Overview's brand table)
  if (isFlat(cell.delta)) return <span data-tone="flat" className="text-rn-11 font-semibold whitespace-nowrap text-rn-muted">{tR("deltaFlat")}</span>;
  return <Mark tone={TONE[cell.tone]} dir={cell.direction}>{f.delta(cell.unit, cell.delta)}</Mark>;
}

function Mark({ tone, dir, children }: { tone: RnTone; dir: "up" | "down" | "flat"; children: string }) {
  return (
    <span data-tone={tone} className={cx("text-rn-11 font-semibold whitespace-nowrap tabular-nums", tone === "up" ? "text-rn-up-ink" : tone === "down" ? "text-rn-danger-ink" : "text-rn-muted")}>
      {dir === "up" ? "▲" : dir === "down" ? "▼" : "–"}
      {children}
    </span>
  );
}

// ─── HMG 브랜드별 비교 ──────────────────────────────────────────────────────

export function RnWebsiteBrands({ brands, total: totalP, onPick }: { brands: Promise<WebsiteBrandsView | Failed>; total: Promise<TilesView>; onPick?: PickRow }) {
  const t = useTranslations("renewal.website.overview");
  const tK = useTranslations("dashboard.kpi.name");
  const short = useShortName();
  const f = useFormat();
  const v = use(brands);
  const total = use(totalP);
  if (v !== "failed" && v.brands === null) return null;
  const totals = new Map(total.groups.flatMap((g) => g.tiles.map((x) => [x.key, x] as const)));
  const periodMode = total.groups.some((g) => g.tiles.some((x) => x.period));
  const cols = WEBSITE_KPI_KEYS.filter((k) => totals.has(k) || (v !== "failed" && v.brands!.some((b) => b.cells[k])));
  return (
    <RnCard aria-label={t("brandsTitle")}>
      <RnCardHeader title={t("brandsTitle")} hint={t("brandsHint")} />
      {v === "failed" ? (
        <RnEmpty className="mx-6 mb-5">{t("brandsFailed")}</RnEmpty>
      ) : (
        <div className="overflow-x-auto pb-3">
          <table className="w-full min-w-[960px] table-fixed border-separate border-spacing-0 text-rn-13" data-rn-brands="">
            <colgroup>
              <col className="w-[176px]" />
              {cols.map((k) => (
                <col key={k} />
              ))}
            </colgroup>
            <thead>
              <tr className="text-left text-rn-12 text-rn-muted">
                <th scope="col" className="border-y border-rn-line bg-rn-head py-2 pr-3 pl-6 font-semibold">{t("colBrand")}</th>
                {cols.map((k) => (
                  <th key={k} scope="col" title={tK(k)} className="border-y border-rn-line bg-rn-head px-2.5 py-2 font-semibold text-rn-ink-2">
                    {short(k)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr data-rn-brand-row="total" className="bg-rn-navy-25">
                <th scope="row" className="h-11 border-b border-rn-line pr-3 pl-6 text-left font-semibold text-rn-ink">
                  <span className="flex items-center gap-1.5 whitespace-nowrap">
                    {t("brandsTotal")}
                    <RnTag className="shrink-0 whitespace-nowrap">{t("brandsTotalTag")}</RnTag>
                  </span>
                </th>
                {cols.map((k) => {
                  const x = totals.get(k);
                  return (
                    <td key={k} className="h-11 border-b border-rn-line px-2.5">
                      {x && !x.pending && x.value != null ? (
                        <span className="flex flex-col leading-tight">
                          <b className="font-semibold text-rn-ink tabular-nums">{f.value(x.unit, x.value)}</b>
                          <DeltaText cell={x} periodMode={periodMode} />
                        </span>
                      ) : (
                        <span className="text-rn-muted">—</span>
                      )}
                    </td>
                  );
                })}
              </tr>
              {v.brands!.map((b) => (
                <tr
                  key={b.brand}
                  data-rn-brand-row={b.brand}
                  onClick={onPick ? () => onPick(b.brand) : undefined}
                  title={onPick ? t("pickBrand", { brand: b.brand }) : undefined}
                  className={cx(onPick && "cursor-pointer hover:bg-rn-page")}
                >
                  <th scope="row" className="h-11 border-b border-rn-line pr-3 pl-6 text-left font-semibold text-rn-ink">{b.brand}</th>
                  {b.state !== "ok" ? (
                    <td colSpan={cols.length} className="h-11 border-b border-rn-line px-2.5 text-rn-12 text-rn-muted">
                      {b.state === "degraded" ? t("brandsRowFailed") : t("brandsRowEmpty")}
                    </td>
                  ) : (
                    cols.map((k) => {
                      const c = b.cells[k];
                      if (!c || c.pending || c.value == null)
                        return (
                          <td key={k} className="h-11 border-b border-rn-line px-2.5 text-rn-muted">
                            —
                          </td>
                        );
                      return (
                        <td key={k} data-rn-best={c.best ? "" : undefined} className="h-11 border-b border-rn-line px-2.5">
                          <span className="flex flex-col gap-0.5 leading-tight">
                            <span className="flex items-center gap-1.5">
                              <b className={cx("tabular-nums text-rn-ink", c.best ? "font-extrabold" : "font-semibold")}>{f.value(c.unit, c.value)}</b>
                              <DeltaText cell={c} periodMode={periodMode} />
                            </span>
                            <span className="h-[4px] w-full max-w-24 overflow-hidden rounded-[2px] bg-rn-page">
                              <i className={cx("block h-full rounded-[2px]", c.best ? "bg-rn-navy" : "bg-rn-faint")} style={{ width: `${c.bar.toFixed(1)}%` }} />
                            </span>
                          </span>
                        </td>
                      );
                    })
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="m-0 px-6 pb-4 text-rn-11 leading-[1.55] break-keep text-rn-muted">{t("brandsFoot")}</p>
    </RnCard>
  );
}

// ─── 엔진별 비교 ────────────────────────────────────────────────────────────

export function RnWebsiteEngines({ engines, onPick, pickable }: { engines: Promise<WebsiteEnginesView>; onPick?: PickRow; pickable?: (engine: string) => boolean }) {
  const t = useTranslations("renewal.website.overview");
  const tK = useTranslations("dashboard.kpi.name");
  const short = useShortName();
  const f = useFormat();
  const v = use(engines);
  const canPick = (code: string) => onPick != null && (!pickable || pickable(code));
  const ratioText = (k: (typeof ENGINE_KPI_KEYS)[number], r: WebsiteEnginesView["engines"][number]["ratios"][(typeof ENGINE_KPI_KEYS)[number]]) =>
    k === "position" ? t("ratioRank", { sum: f.count(r.sum ?? 0), count: f.count(r.count ?? 0) }) : t("ratioPct", { num: f.count(r.num ?? 0), den: f.count(r.den ?? 0) });
  return (
    <RnCard aria-label={t("enginesTitle")} className="h-full min-w-0">
      <RnCardHeader title={t("enginesTitle")} hint={t("enginesHint")} />
      {v.degraded ? (
        <RnEmpty className="mx-6 mb-5">{t("enginesFailed")}</RnEmpty>
      ) : v.engines.length === 0 ? (
        <RnEmpty className="mx-6 mb-5">{t("enginesEmpty")}</RnEmpty>
      ) : (
        <div className="overflow-x-auto pb-4">
          <table className="w-full min-w-[560px] table-fixed border-separate border-spacing-0 text-rn-13" data-rn-engines="">
            <colgroup>
              <col className="w-[104px]" />
              <col className="w-[76px]" />
              {ENGINE_KPI_KEYS.map((k) => (
                <col key={k} />
              ))}
            </colgroup>
            <thead>
              <tr className="text-left text-rn-12 text-rn-muted">
                <th scope="col" className="border-y border-rn-line bg-rn-head py-2 pr-2 pl-6 font-semibold">{t("colEngine")}</th>
                <th scope="col" className="border-y border-rn-line bg-rn-head px-2 py-2 text-right font-semibold">{t("colAnswers")}</th>
                {ENGINE_KPI_KEYS.map((k) => (
                  <th key={k} scope="col" title={tK(k)} className="border-y border-rn-line bg-rn-head px-2.5 py-2 font-semibold text-rn-ink-2">
                    {short(k)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {v.engines.map((e) => (
                <tr
                  key={e.engine}
                  data-rn-engine-row={e.engine}
                  onClick={canPick(e.engine) ? () => onPick!(e.engine) : undefined}
                  title={canPick(e.engine) ? t("pickEngine", { engine: engineLabel(e.engine) }) : undefined}
                  className={cx(canPick(e.engine) && "cursor-pointer hover:bg-rn-page")}
                >
                  <th scope="row" className="h-10 border-b border-rn-line pr-2 pl-6 text-left font-semibold text-rn-ink">{engineLabel(e.engine)}</th>
                  <td className="h-10 border-b border-rn-line px-2 text-right text-rn-12 text-rn-muted tabular-nums">{f.count(e.answers)}</td>
                  {ENGINE_KPI_KEYS.map((k) => {
                    const val = e.values[k];
                    const ex = v.extremes[k];
                    // best / worst only where the shown values differ (two engines at 1.1번째 are not ranked)
                    const apart = ex && ex.best.value !== ex.worst.value;
                    const mark = apart && ex.best.engine === e.engine ? "best" : apart && ex.worst.engine === e.engine ? "worst" : undefined;
                    return (
                      <td key={k} data-rn-mark={mark} title={ratioText(k, e.ratios[k])} className="h-10 border-b border-rn-line px-2.5 tabular-nums">
                        {val == null ? (
                          <span className="text-rn-muted">—</span>
                        ) : (
                          <span className={cx(mark === "best" ? "font-extrabold text-rn-navy" : mark === "worst" ? "font-semibold text-rn-danger-ink" : "font-semibold text-rn-ink")}>
                            {f.value(unitOf(k), val)}
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
              {Object.keys(v.consistency).length ? (
                <tr data-rn-engine-row="consistency" className="bg-rn-head">
                  <th scope="row" colSpan={2} className="h-10 pr-2 pl-6 text-left text-rn-12 font-semibold text-rn-ink-2">
                    {t("consistencyRow")}
                  </th>
                  {ENGINE_KPI_KEYS.map((k) => {
                    const c = v.consistency[k];
                    return (
                      <td key={k} data-rn-widest={v.widest === k ? "" : undefined} className={cx("h-10 px-2.5 text-rn-12 tabular-nums", v.widest === k ? "font-bold text-rn-ink" : "text-rn-muted")}>
                        {c == null ? "—" : `${c.toFixed(1)}%`}
                      </td>
                    );
                  })}
                </tr>
              ) : null}
            </tbody>
          </table>
          <p className="m-0 flex flex-wrap gap-x-3 px-6 pt-2.5 text-rn-11 leading-[1.55] break-keep text-rn-muted">
            <span>
              <b className="font-extrabold text-rn-navy">{t("legendBest")}</b> · <b className="font-semibold text-rn-danger-ink">{t("legendWorst")}</b>
            </span>
            <span>{t("enginesFoot")}</span>
          </p>
        </div>
      )}
    </RnCard>
  );
}
