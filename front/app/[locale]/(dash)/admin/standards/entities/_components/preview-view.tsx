"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { OWN_BRANDS, type OwnBrand } from "@/lib/hgh/ecat-model";
import type { KpiRowView, PreviewSampleView, PreviewView } from "@/lib/hgh/adapters/admin-entities";
import { fmtDelta, fmtInt, fmtPct, fmtPos, fmtSignedInt, fmtTime, Highlighted, Notice } from "./ecat-shared";

// Apply preview (design 3절 ③, 7절 미리보기·반영): impact counts, exposed rounds in range,
// approximation counts, the own-brand KPI before -> after per round and per round x country x
// engine (changed groups only, largest change first), the competitor brands that move most, and
// the added / removed / moved mention samples with their context. The backend computes all of it
// over the whole affected set (not a sample); this view only formats.

type Metric = "vis" | "sov" | "pos";
const METRICS: Metric[] = ["vis", "sov", "pos"];

function pair(k: KpiRowView["brands"][OwnBrand], m: Metric): [number | null, number | null] {
  return m === "vis" ? [k.visBefore, k.visAfter] : m === "sov" ? [k.sovBefore, k.sovAfter] : [k.posBefore, k.posAfter];
}

function cell(row: KpiRowView, brand: OwnBrand, m: Metric, cardLabel: string) {
  const [b, a] = pair(row.brands[brand], m);
  const fmt = m === "pos" ? fmtPos : fmtPct;
  const card = row.card ? pair(row.card.brands[brand], m) : null;
  const d = fmtDelta(b, a, m === "pos" ? 2 : 1);
  const moved = d !== "" && Number(d) !== 0;
  return (
    <div className="flex flex-col items-end leading-tight">
      <span className="tabular-nums">
        {fmt(b)} <span aria-hidden>{"→"}</span> {fmt(a)}
      </span>
      {moved ? (
        <span
          className={cn(
            "text-[10px] tabular-nums",
            // Position: lower is better, so an increase is the worse direction.
            (m === "pos" ? Number(d) < 0 : Number(d) > 0) ? "text-positive" : "text-danger",
          )}
        >
          {d}
        </span>
      ) : null}
      {card ? (
        // Frozen round the apply re-freezes: the card shows the frozen value until then, the new-version value after.
        <span className="text-[10px] text-muted-foreground tabular-nums" data-testid="ecat-kpi-card">
          {cardLabel} {fmt(card[0])} <span aria-hidden>{"→"}</span> {fmt(card[1])}
        </span>
      ) : null}
    </div>
  );
}

function KpiTable({ rows, grouped, brand, testId }: { rows: KpiRowView[]; grouped: boolean; brand: OwnBrand; testId: string }) {
  const t = useTranslations("adminEcat.preview");
  const tsf = useTranslations("adminEcat.surface");
  return (
    <Table data-testid={testId}>
      <TableHeader>
        <TableRow>
          <TableHead>{t("colRound")}</TableHead>
          {grouped ? null : <TableHead>{t("colCountry")}</TableHead>}
          {grouped ? null : <TableHead>{t("colEngine")}</TableHead>}
          <TableHead className="text-right">{t("colAnswers")}</TableHead>
          {METRICS.map((m) => (
            <TableHead key={m} className="text-right">
              {t(`metric.${m}`)}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.key}>
            <TableCell className="text-xs">
              <span className="tabular-nums">{r.roundDate ?? ""}</span>{" "}
              <span className="text-muted-foreground">{r.surface ? tsf(r.surface) : ""}</span>
              {r.exposed ? <Badge className="ml-1 bg-sentiment-mixed/30 text-[10px] text-ink-700">{t("exposed")}</Badge> : null}
            </TableCell>
            {grouped ? null : <TableCell className="text-xs">{r.geo ?? ""}</TableCell>}
            {grouped ? null : <TableCell className="text-xs">{r.engine ?? ""}</TableCell>}
            <TableCell className="text-right text-xs tabular-nums">
              {r.answersBefore === r.answersAfter ? fmtInt(r.answersAfter) : `${fmtInt(r.answersBefore)} → ${fmtInt(r.answersAfter)}`}
            </TableCell>
            {METRICS.map((m) => (
              <TableCell key={m} className="text-right text-xs">
                {cell(r, brand, m, t("cardLabel"))}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function SampleList({ items, testId }: { items: PreviewSampleView[]; testId: string }) {
  const t = useTranslations("adminEcat.preview");
  if (!items.length) return <p className="text-xs text-muted-foreground">{t("samplesNone")}</p>;
  return (
    <ul className="flex flex-col gap-2" data-testid={testId}>
      {items.map((s, i) => (
        <li key={`${s.answerKey}:${i}`} className="rounded-md border border-border bg-bg-soft px-3 py-2 text-xs">
          <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <Badge variant="outline" className="text-[10px]">
              {t(`change.${s.change}`)}
            </Badge>
            {s.name ? <span className="font-medium text-ink-700">{s.name}</span> : null}
            {s.surface ? <span>{s.surface}</span> : null}
            {s.approx ? <span className="text-accent-gold">{t("approxBadge")}</span> : null}
          </div>
          <p className="leading-relaxed whitespace-pre-wrap text-ink-700">
            {s.context ? <Highlighted text={s.context} range={s.highlight} /> : <span className="text-muted-foreground">{t("noContext")}</span>}
          </p>
        </li>
      ))}
    </ul>
  );
}

export function PreviewPanel({ preview }: { preview: PreviewView }) {
  const t = useTranslations("adminEcat.preview");
  const tsf = useTranslations("adminEcat.surface");
  const [brand, setBrand] = useState<OwnBrand>("Hyundai");
  const [exposedOnly, setExposedOnly] = useState(false);
  const top = useMemo(() => (exposedOnly ? preview.kpiTop.filter((r) => r.exposed) : preview.kpiTop), [preview.kpiTop, exposedOnly]);
  const im = preview.impact;

  return (
    <div className="flex flex-col gap-6" data-testid="ecat-preview">
      <p className="text-xs text-muted-foreground">{t("computedAt", { at: fmtTime(preview.computedAt) })}</p>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {(
          [
            ["impactedAnswers", im.impactedAnswers],
            ["changedAnswers", im.changedAnswers],
            ["entities", im.entities],
            ["surfaces", im.blockSurfaces + im.addSurfaces],
          ] as const
        ).map(([k, v]) => (
          <div key={k} className="rounded-md border border-border px-3 py-2">
            <dt className="text-[11px] text-muted-foreground">{t(`impact.${k}`)}</dt>
            <dd className="text-lg font-semibold tabular-nums" data-testid={`ecat-impact-${k}`}>
              {fmtInt(v)}
            </dd>
          </div>
        ))}
      </dl>
      <p className="text-[11px] text-muted-foreground">
        {t("impactDetail", {
          work: fmtInt(im.workAnswers),
          runs: fmtInt(im.promptRuns),
          orphans: fmtInt(im.orphanPromptRuns),
          block: im.blockSurfaces,
          add: im.addSurfaces,
          rounds: preview.cycles.inScope,
        })}
      </p>

      {preview.cycles.exposed.length ? (
        <Notice tone="warn" testId="ecat-preview-exposed">
          <p className="font-semibold">{t("exposedTitle", { count: preview.cycles.exposed.length })}</p>
          <p className="mt-1">
            {preview.cycles.exposed
              .slice(0, 30)
              .map((c) => `${c.roundDate} ${c.surface ? tsf(c.surface) : ""}`.trim())
              .join(", ")}
            {preview.cycles.exposed.length > 30 ? ` ${t("andMore", { count: preview.cycles.exposed.length - 30 })}` : ""}
          </p>
        </Notice>
      ) : (
        <Notice testId="ecat-preview-unexposed">{t("noExposed")}</Notice>
      )}

      {preview.refreeze?.applies && preview.refreeze.count > 0 ? (
        <Notice tone="warn" testId="ecat-preview-refreeze">
          <p className="font-semibold">{t("refreezeTitle", { exposed: preview.refreeze.exposed, count: preview.refreeze.count })}</p>
          <p className="mt-1">{t("refreezeBody")}</p>
          {preview.refreeze.approx ? (
            <p className="mt-1" data-testid="ecat-preview-refreeze-approx">
              {t("refreezeApprox")}
            </p>
          ) : null}
        </Notice>
      ) : null}

      {preview.approx.noOccurrenceAnswers || preview.approx.acrAnswers ? (
        <Notice testId="ecat-preview-approx">
          {t("approx", { noOcc: fmtInt(preview.approx.noOccurrenceAnswers), acr: fmtInt(preview.approx.acrAnswers) })}
        </Notice>
      ) : null}

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">{t("kpiTitle")}</h3>
          <div className="flex flex-wrap items-center gap-1" role="tablist" aria-label={t("brandLabel")}>
            {OWN_BRANDS.map((b) => (
              <button
                key={b}
                type="button"
                role="tab"
                aria-selected={brand === b}
                onClick={() => setBrand(b)}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs",
                  brand === b ? "border-brand-700 bg-brand-700 text-white" : "border-border text-ink-700 hover:bg-bg-subtle",
                )}
              >
                {b}
              </button>
            ))}
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">{t("kpiNote")}</p>
        {preview.kpiByRound.length ? (
          <KpiTable rows={preview.kpiByRound} grouped brand={brand} testId="ecat-kpi-round" />
        ) : (
          <p className="text-xs text-muted-foreground">{t("kpiNone")}</p>
        )}
        {preview.kpiTop.length ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-xs font-semibold text-ink-700">
                {t("kpiTopTitle", { shown: top.length, total: fmtInt(preview.kpiGroupsChanged) })}
              </h4>
              <label className="inline-flex items-center gap-1.5 text-xs">
                <input type="checkbox" checked={exposedOnly} onChange={(e) => setExposedOnly(e.target.checked)} />
                {t("exposedOnly")}
              </label>
            </div>
            {preview.kpiTruncated ? <Notice tone="warn">{t("kpiTruncated")}</Notice> : null}
            <KpiTable rows={top} grouped={false} brand={brand} testId="ecat-kpi-top" />
          </>
        ) : null}
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold">{t("brandsTitle")}</h3>
        {preview.brands.length ? (
          <Table data-testid="ecat-preview-brands">
            <TableHeader>
              <TableRow>
                <TableHead>{t("colBrand")}</TableHead>
                <TableHead className="text-right">{t("colMentions")}</TableHead>
                <TableHead className="text-right">{t("colBrandAnswers")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {preview.brands.map((b) => (
                <TableRow key={b.bare}>
                  <TableCell className="text-xs font-medium">{b.bare}</TableCell>
                  <TableCell className="text-right text-xs tabular-nums">
                    {fmtInt(b.beforeMentions)} {"→"} {fmtInt(b.afterMentions)}{" "}
                    <span className={b.deltaMentions < 0 ? "text-danger" : "text-positive"}>({fmtSignedInt(b.deltaMentions)})</span>
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums">
                    {fmtInt(b.beforeAnswers)} {"→"} {fmtInt(b.afterAnswers)}{" "}
                    <span className={b.deltaAnswers < 0 ? "text-danger" : "text-positive"}>({fmtSignedInt(b.deltaAnswers)})</span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="text-xs text-muted-foreground">{t("brandsNone")}</p>
        )}
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">{t("samplesRemoved", { count: preview.samples.removed.length })}</h3>
          <SampleList items={preview.samples.removed} testId="ecat-samples-removed" />
        </div>
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">{t("samplesAdded", { count: preview.samples.added.length })}</h3>
          <SampleList items={preview.samples.added} testId="ecat-samples-added" />
        </div>
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">{t("samplesMoved", { count: preview.samples.moved.length })}</h3>
          <SampleList items={preview.samples.moved} testId="ecat-samples-moved" />
        </div>
      </section>
    </div>
  );
}
