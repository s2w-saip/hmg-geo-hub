"use client";

import { use, type ReactNode } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { usePathname, useSearchParams } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { RnBasisChip, RnCardHead, cx } from "@/components/renewal-ui";
import type { CitationPromptLive } from "@/lib/scope/result-adapter";
import { CitationCardActions, useCitation } from "./citation-context";
import { DegradedNote, DeltaChip, InfoTip, useDegradedText } from "../../mention/_components/mention-kit";
import { numTxt, pctTxt } from "../../mention/_components/mention-context";
import type { RnCitationVm, RnCitationWebsite, RnUrlFunnel, RnUrlReach } from "./citation-input";

// The website page's own cards (2026-10-30, W3): the URL funnel per prompt (사이트 인용 도달) and the
// 공식(당사) URL cited / uncited prompt lists (the original page's inline lists). Every number is a Gold value or a
// difference of two counts of one Gold answer (owned − target, measured − owned); nothing is judged here.

const OWNED_COLOR = "var(--color-rn-navy-300)";
const TARGET_COLOR = "var(--color-rn-navy)";

/** Sub page link carrying the page's filters (as citation-body useSubpageHref). */
function useSubHref(): (sub: "prompts", extra: Record<string, string>) => string {
  const pathname = usePathname();
  const sp = useSearchParams();
  return (sub, extra) => {
    const params = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(extra)) params.set(k, v);
    const qs = params.toString();
    return `${pathname}/${sub}${qs ? `?${qs}` : ""}`;
  };
}

// ── 사이트 인용 도달 ─────────────────────────────────────────────────────────

export function ReachCard({ website }: { website: Promise<RnCitationWebsite> }) {
  const { input, live } = useCitation();
  const t = useTranslations("renewal.website.citation.reach");
  const tS = useTranslations("answerAnalysis.citations.summary");
  const locale = useLocale();
  const dg = useDegradedText();
  const r = use(website).reach;
  const isPeriod = Boolean(input.period);
  const head = (chips: ReactNode, actions?: ReactNode) => (
    <RnCardHead
      title={t("title")}
      info={<InfoTip label={t("title")} items={[[t("infoLabel"), t("info")], [t("defOwned"), tS("def.ownedHitRate.definition")], [t("defTarget"), tS("def.targetHitRate.definition")]]} />}
      chips={chips}
      actions={actions}
      sub={t("sub")}
    />
  );
  if (r.status !== "ok") {
    const reason = r.status === "degraded" ? dg.all : t(r.status);
    return (
      <>
        {head(null)}
        <div className="px-6 pb-5 [.rn-dense_&]:px-4.5">{r.status === "degraded" ? <DegradedNote>{reason}</DegradedNote> : <p className="m-0 rounded-[10px] bg-rn-page p-3.5 text-rn-12 text-rn-muted">{reason}</p>}</div>
      </>
    );
  }
  const pub = r.publication;
  const cycle = (locale === "ko" ? pub?.cycleLabel : pub?.cycleLabelEn) ?? pub?.cycleLabel ?? pub?.roundDate ?? "";
  const source = r.source === "published" ? tS("reportTruth.published", { cycle, sites: pub?.siteCount ?? 0 }) : r.source === "live" ? tS("reportTruth.live") : null;
  const d = r.delta;
  const basis =
    d.basis === "period" && d.from && d.date
      ? t("chipDeltaPeriod", { from: d.from.slice(0, 10), to: d.date.slice(0, 10) })
      : d.basis === "round" && d.date
        ? t("chipDelta", { date: d.date.slice(0, 10) })
        : null;
  const csv = () => ({
    name: "website-citation-reach",
    rows: [
      [t("colEngine"), t("colMeasured"), t("colOwned"), t("colOwnedRate"), t("colTarget"), t("colTargetRate")],
      ...[{ engine: t("all"), ...r }, ...r.engines].map((e) => [e.engine, e.measured, e.owned, e.ownedRate ?? "", e.target, e.targetRate ?? ""]),
    ],
  });
  return (
    <>
      {head(
        <>
          <RnBasisChip>{isPeriod ? t("chipPeriod") : t("chipSnapshot", { date: live.asOf?.slice(0, 10) ?? "—" })}</RnBasisChip>
          {basis ? <RnBasisChip>{basis}</RnBasisChip> : null}
        </>,
        <CitationCardActions section="sec-reach" csv={csv} />,
      )}
      <div className="grid grid-cols-1 gap-x-8 gap-y-5 px-6 pb-5 @min-[960px]/rnpage:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] [.rn-dense_&]:px-4.5 [.rn-dense_&]:pb-4" data-rn-reach="">
        <Funnel r={r} />
        <EngineReach r={r} />
      </div>
      {/* where the values come from, said once (the footnote: the report cycle, or why it is a live read) */}
      {source ? <p className="m-0 border-t border-rn-line px-6 py-2.5 text-rn-11 text-rn-muted [.rn-dense_&]:px-4.5">{source}</p> : null}
    </>
  );
}

/** measured → owned URL → target page, bars on the measured scale, the two drops between them. */
function Funnel({ r }: { r: Extract<RnUrlReach, { status: "ok" }> }) {
  const t = useTranslations("renewal.website.citation.reach");
  const prevTip = (rate: number | null | undefined, n: number | undefined) =>
    r.prev && rate != null && n != null ? t("tipPrev", { rate: pctTxt(rate), n: numTxt(n), measured: numTxt(r.prev.measured) }) : undefined;
  const step = (kind: "measured" | "owned" | "target", n: number, rate: number | null, delta: number | null, color: string, tip?: string) => (
    <div className="flex flex-col gap-1" data-rn-step={kind} title={tip}>
      <span className="flex items-baseline gap-2">
        <span className="text-rn-13 font-bold text-rn-ink">{t(`step.${kind}`)}</span>
        <span className="ml-auto text-rn-20 font-bold tracking-[-0.01em] text-rn-ink tabular-nums">{numTxt(n)}</span>
        {kind === "measured" ? (
          <span className="w-[132px] text-right text-rn-12 text-rn-muted">{t("unitPrompts")}</span>
        ) : (
          <span className="flex w-[132px] items-center justify-end gap-1.5">
            <b className="text-rn-15 font-bold text-rn-ink tabular-nums">{pctTxt(rate)}</b>
            <DeltaChip value={delta} />
          </span>
        )}
      </span>
      <span className="relative h-3 overflow-hidden rounded-[3px] bg-rn-inset" aria-hidden>
        <i className="absolute inset-y-0 left-0 rounded-[3px]" style={{ width: `${r.measured > 0 ? (n / r.measured) * 100 : 0}%`, background: color }} />
      </span>
    </div>
  );
  const drop = (kind: "dropOwned" | "dropTarget", n: number) => (
    <span className="flex items-center gap-1.5 pl-3 text-rn-12 text-rn-muted" data-rn-drop={kind}>
      <span aria-hidden className="h-3 w-2 rounded-bl border-b border-l border-rn-line-2" />
      {t(kind, { n: numTxt(n) })}
    </span>
  );
  return (
    <div className="flex flex-col gap-2" role="group" aria-label={t("funnelLabel")}>
      {step("measured", r.measured, null, null, "var(--color-rn-line-2)")}
      {drop("dropOwned", r.measured - r.owned)}
      {step("owned", r.owned, r.ownedRate, r.delta.ownedRate, OWNED_COLOR, prevTip(r.prev?.ownedRate, r.prev?.owned))}
      {drop("dropTarget", r.owned - r.target)}
      {step("target", r.target, r.targetRate, r.delta.targetRate, TARGET_COLOR, prevTip(r.prev?.targetRate, r.prev?.target))}
    </div>
  );
}

/** The same funnel per engine: 전체 first (a prompt once whichever engine cited it), then the engines by measured. */
function EngineReach({ r }: { r: Extract<RnUrlReach, { status: "ok" }> }) {
  const t = useTranslations("renewal.website.citation.reach");
  const dg = useDegradedText();
  const rows: (RnUrlFunnel & { engine: string; all?: boolean })[] = [{ ...r, engine: t("all"), all: true }, ...r.engines];
  const bar = (rate: number | null, color: string) => (
    <span className="flex items-center gap-2">
      <span className="relative h-2 flex-1 rounded-full bg-rn-inset" aria-hidden>
        <i className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${rate ?? 0}%`, background: color }} />
      </span>
      <b className="w-12 text-right text-rn-13 font-bold text-rn-ink tabular-nums">{pctTxt(rate)}</b>
    </span>
  );
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-rn-13 font-bold text-rn-ink">{t("enginesTitle")}</span>
      <table className="w-full border-collapse text-rn-12" data-rn-engines="">
        <thead>
          <tr className="text-rn-11 text-rn-muted">
            <th scope="col" className="py-1.5 pr-2 text-left font-semibold">{t("colEngine")}</th>
            <th scope="col" className="py-1.5 pr-3 text-right font-semibold">{t("colMeasured")}</th>
            <th scope="col" className="py-1.5 pr-3 text-left font-semibold">
              <span className="inline-flex items-center gap-1.5">
                <i aria-hidden className="h-2 w-3 rounded-[2px]" style={{ background: OWNED_COLOR }} />
                {t("colOwnedRate")}
              </span>
            </th>
            <th scope="col" className="py-1.5 text-left font-semibold">
              <span className="inline-flex items-center gap-1.5">
                <i aria-hidden className="h-2 w-3 rounded-[2px]" style={{ background: TARGET_COLOR }} />
                {t("colTargetRate")}
              </span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => (
            <tr
              key={e.engine}
              data-rn-engine={e.all ? "all" : e.engine}
              className={cx("border-t border-rn-line", e.all && "bg-rn-page")}
              title={t("tipEngine", { engine: e.engine, owned: numTxt(e.owned), target: numTxt(e.target), measured: numTxt(e.measured) })}
            >
              <th scope="row" className={cx("py-2 pr-2 text-left whitespace-nowrap", e.all ? "font-bold text-rn-ink" : "font-semibold text-rn-ink-2")}>
                {e.engine}
              </th>
              <td className="py-2 pr-3 text-right text-rn-ink-2 tabular-nums">{numTxt(e.measured)}</td>
              <td className="w-[38%] py-2 pr-3">{bar(e.ownedRate, OWNED_COLOR)}</td>
              <td className="w-[38%] py-2">{bar(e.targetRate, TARGET_COLOR)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="m-0 text-rn-11 text-rn-muted">{t("enginesNote")}</p>
      {r.enginesDegraded ? <DegradedNote>{dg.all}</DegradedNote> : null}
    </div>
  );
}

// ── 프롬프트: 공식(당사) URL 인용 / 미인용 (the original's inline lists) ─────────

export function WebsitePromptsCard() {
  const { input, live } = useCitation();
  const t = useTranslations("renewal.website.citation.prompts");
  const tL = useTranslations("renewal.citation.lens");
  const dg = useDegradedText();
  const rn = use(input.rn) as RnCitationVm;
  const s = rn.lens.split;
  const head = <RnCardHead title={t("title")} info={<InfoTip label={t("title")} items={[[t("infoLabel"), t("info")]]} />} sub={t("sub")} />;
  if (s.kind !== "ok") {
    const reason = s.kind === "degraded" ? dg.all : tL(`split.${s.kind}`);
    return (
      <>
        {head}
        <div className="px-6 pb-5 [.rn-dense_&]:px-4.5">
          <p className="m-0 rounded-[10px] bg-rn-page p-3.5 text-rn-12 text-rn-muted">{reason}</p>
        </div>
      </>
    );
  }
  const split = live.promptSplit;
  return (
    <>
      {head}
      {/* two columns of the one card, a rule between them (no card inside the card) */}
      <div className="grid grid-cols-1 gap-y-4 px-6 pb-5 @min-[960px]/rnpage:grid-cols-2 @min-[960px]/rnpage:gap-y-0 [.rn-dense_&]:px-4.5 [.rn-dense_&]:pb-4">
        <PromptBucket kind="owned" n={s.owned} pct={s.ownedPct ?? null} prompts={split?.owned ?? []} />
        <PromptBucket kind="uncited" n={s.uncited} pct={s.uncitedPct ?? null} prompts={split?.uncited ?? []} />
      </div>
    </>
  );
}

function PromptBucket({ kind, n, pct, prompts }: { kind: "owned" | "uncited"; n: number; pct: number | null; prompts: CitationPromptLive[] }) {
  const t = useTranslations("renewal.website.citation.prompts");
  const href = useSubHref();
  return (
    <div
      className={cx(
        "flex min-w-0 flex-col gap-2",
        kind === "owned" ? "@min-[960px]/rnpage:pr-6" : "border-t border-rn-line pt-4 @min-[960px]/rnpage:border-t-0 @min-[960px]/rnpage:border-l @min-[960px]/rnpage:pt-0 @min-[960px]/rnpage:pl-6",
      )}
      data-rn-bucket={kind}
    >
      <span className="flex items-baseline gap-2">
        <span className="text-rn-13 font-bold text-rn-ink">{t(`${kind}.name`)}</span>
        <span className="ml-auto text-rn-20 font-bold text-rn-ink tabular-nums">{numTxt(n)}</span>
        <span className="text-rn-13 font-bold text-rn-muted tabular-nums">{pct != null ? `${pct}%` : "—"}</span>
      </span>
      <span className="text-rn-11 break-keep text-rn-muted">{t(`${kind}.question`)}</span>
      {prompts.length ? (
        <ol className="m-0 flex list-none flex-col p-0">
          {prompts.map((p, i) => (
            <li key={p.id} className="flex items-start gap-2 border-t border-rn-line py-1.5 text-rn-12">
              <span className="w-4 shrink-0 text-right text-rn-muted tabular-nums">{i + 1}</span>
              <span className="line-clamp-2 min-w-0 flex-1 text-rn-ink-2" title={p.promptText}>
                {p.promptText}
              </span>
              <span className="shrink-0 text-right text-rn-11 whitespace-nowrap text-rn-muted tabular-nums">
                {t("cites", { n: numTxt(p.citations) })} · {t("engines", { n: p.providers.length })}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="m-0 text-rn-12 text-rn-muted">{t("empty")}</p>
      )}
      <Link prefetch={false} href={href("prompts", { tab: kind })} className="mt-auto inline-flex items-center gap-0.5 self-start text-rn-12 font-semibold text-rn-navy no-underline hover:underline">
        {t("more", { n: numTxt(n) })}
        <ChevronRight className="size-3" aria-hidden />
      </Link>
    </div>
  );
}
