"use client";

import { browserFetch as fetch } from "~/api/browser-fetch";

import { Suspense, use, useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import { useSearchParams } from "~/app/navigation";
import { RnBasisChip, RnCardHead, RnSkeleton, cx } from "@/components/renewal-ui";
import type { ComparePartsScreen } from "@/app/[locale]/(dash)/standard/answer-analysis/_data/mention-screen";
import { useServiceWeekRead } from "@/components/service-week/provider";
import { ComparePicker } from "../../../../standard/answer-analysis/mention/_components/mention-body";
import { pctTxt, posTxt, useCompare, useMention } from "../../../../standard/answer-analysis/mention/_components/mention-context";
import { InfoTip } from "../../../../standard/answer-analysis/mention/_components/mention-kit";

// 당사 대 비교 브랜드 (2026-11-02): the original Website Mention's head-to-head and type stack, both from mention/view-compare
// (back/bff/screens/mention_surfaces.py): 당사, the compare brand and the two brands next by share, on share, mention rate
// and average position; each type's mentions split into 당사 · the compare brand · the top others. Rival rows carry no
// better / worse colour. A picked brand reads through /api/scope/mention-compare, the original page's route.

export function RnSiteCompare({ initial, admin }: { initial: Promise<ComparePartsScreen>; admin: boolean }) {
  const t = useTranslations("renewal.website.mention.compare");
  return (
    <>
      <RnCardHead title={t("title")} info={<InfoTip label={t("title")} items={[[t("title"), t("desc")]]} />} />
      <Suspense fallback={<RnSkeleton className="mx-6 mb-4 h-36" />}>
        <Parts initial={initial} admin={admin} />
      </Suspense>
    </>
  );
}

/** The parts for the compare brand: the page's read when it is the page's target, else a read of its own — kept per
 * URL and read of the page, so a page read again once the service week moved reads the pick again (the page's own
 * parts meanwhile, review r3-4). */
export function usePicked(initial: ComparePartsScreen, brand: string | undefined, admin: boolean): ComparePartsScreen {
  const sp = useSearchParams()?.toString() ?? "";
  const read = useServiceWeekRead();
  const need = brand && initial.comparison?.target.brand !== brand ? brand : null;
  const key = need ? `${sp}|${read ?? ""}|${need}` : null;
  const [picked, setPicked] = useState<{ key: string; parts: ComparePartsScreen } | null>(null);
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (!key || !need) return;
    last.current = key;
    const params = new URLSearchParams(sp);
    params.set("target", need);
    params.set("surface", "website");
    if (admin) params.set("admin", "1");
    const ctrl = new AbortController();
    fetch(`/api/scope/mention-compare?${params.toString()}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? (r.json() as Promise<ComparePartsScreen>) : null))
      .then((parts) => {
        if (parts && last.current === key) setPicked({ key, parts });
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, [key, need, sp, admin]);
  return key && picked?.key === key ? picked.parts : initial;
}

function Parts({ initial, admin }: { initial: Promise<ComparePartsScreen>; admin: boolean }) {
  const t = useTranslations("renewal.website.mention.compare");
  const tC = useTranslations("answerAnalysis.mentions.compare");
  const tB = useTranslations("answerAnalysis.mentions.breakdown");
  const { compare } = useCompare();
  const { ownLabel } = useMention();
  // the picker keeps several brands for the trend; the head-to-head follows the one picked last
  const parts = usePicked(use(initial), compare.at(-1), admin);
  const { comparison, typeShare } = parts;
  const roles = comparison
    ? [
        { key: "ours", label: t("roleOurs"), name: ownLabel, row: comparison.own },
        { key: "target", label: t("roleTarget"), name: comparison.target.brand, row: comparison.target },
        ...comparison.peers.map((row) => ({ key: row.brand, label: t("rolePeer"), name: row.brand, row })),
      ]
    : [];
  const labelOf = (x: { label?: string; labelKey?: "ours" | "others" }) => (x.labelKey ? tB(x.labelKey) : (x.label ?? ""));
  return (
    <div className="flex flex-col gap-3 px-6 pb-4 [.rn-dense_&]:px-4.5">
      <ComparePicker />
      {comparison ? (
        <table className="w-full border-collapse text-rn-13" data-rn-site-compare="">
          <thead>
            <tr className="border-b border-rn-line text-rn-12 text-rn-muted">
              <th scope="col" className="py-1.5 pr-2 text-left font-semibold">{t("role")}</th>
              <th scope="col" className="px-2 py-1.5 text-left font-semibold">{t("brand")}</th>
              <th scope="col" className="px-2 py-1.5 text-right font-semibold">{tC("metric.share")}</th>
              <th scope="col" className="px-2 py-1.5 text-right font-semibold">{tC("metric.rate")}</th>
              <th scope="col" className="px-2 py-1.5 text-right font-semibold">{tC("metric.position")}</th>
            </tr>
          </thead>
          <tbody>
            {roles.map((r) => (
              <tr key={r.key} className={cx("border-b border-rn-line last:border-0", r.key === "ours" && "bg-rn-navy-25/60")}>
                <td className="py-1.5 pr-2 text-rn-12 text-rn-muted">{r.label}</td>
                <th scope="row" className={cx("px-2 py-1.5 text-left font-semibold", r.key === "ours" ? "text-rn-navy" : "text-rn-ink")}>{r.name}</th>
                <td className="px-2 py-1.5 text-right tabular-nums">{pctTxt(r.row.share)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{pctTxt(r.row.mentionRate)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{posTxt(r.row.avgPosition)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="m-0 text-rn-12 text-rn-muted">{tC("empty")}</p>
      )}
      {comparison?.ownBrands.length ? <p className="m-0 text-rn-11 text-rn-muted">{tC("oursScope", { brands: comparison.ownBrands.join(" · ") })}</p> : null}
      {typeShare ? (
        <section className="flex flex-col gap-2 border-t border-rn-line pt-3" data-rn-site-type-share="">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h3 className="m-0 text-rn-13 font-bold text-rn-ink">{t("typeTitle")}</h3>
            <RnBasisChip>{tB("typesTitle")}</RnBasisChip>
          </div>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {typeShare.rows.map((r) => (
              <li key={r.type} className="grid grid-cols-[84px_minmax(0,1fr)_84px] items-center gap-3 text-rn-12">
                <span className="text-rn-ink-2">{tB(`type.${r.type}`)}</span>
                <div className="flex h-3 overflow-hidden rounded-full bg-rn-inset" aria-hidden>
                  {r.total > 0 ? r.segs.map((s) => <div key={s.key} className={s.color} style={{ width: `${s.width}%` }} title={`${labelOf(s)}: ${s.val.toLocaleString()}`} />) : null}
                </div>
                <span className="text-right text-rn-ink tabular-nums">{tB("oursShare", { pct: r.trackedShare.toFixed(1) })}</span>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-rn-11 text-rn-muted">
            {typeShare.legend.map((item) => (
              <span key={item.color} className="inline-flex items-center gap-1">
                <span aria-hidden className={cx("size-2 rounded-sm", item.color)} />
                {labelOf(item)}
              </span>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
