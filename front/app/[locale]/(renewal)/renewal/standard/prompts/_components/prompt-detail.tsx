"use client";

// Prompt detail sheet of the renewal Global prompts list (2026-10-28). The list keeps one line per
// prompt, so a row opens this sheet with all the row carries — the full text (copyable), every
// attribute, every target market — and the prompt's change history (RnPromptTimeline).

import type { ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Copy, Globe, Tag } from "lucide-react";
import { RnButton, RnDrawer, RnTag, cx, useRnToast } from "@/components/renewal-ui";
import { languageName } from "@/lib/geo-catalog/language-name";
import { isPseudoRegion } from "@/lib/standards/prompt-markets";
import type { PromptRow } from "@/app/[locale]/(dash)/standard/prompts/_data/screen-types";
import { RnPromptTimeline } from "./prompt-history";

export function RnPromptDetail({
  row,
  taxonomy,
  marketLabel,
  onClose,
}: {
  row: PromptRow | null;
  /** The row's taxonomy levels in order (list type, Depth1–4 present in the scope); null = unset. */
  taxonomy: (r: PromptRow) => { label: string; value: string | null }[];
  marketLabel: (code: string) => string;
  onClose: () => void;
}) {
  const t = useTranslations("standardPromptsView");
  const tVal = useTranslations("dashboard.filters.value");
  const tp = useTranslations("renewal.prompts");
  const locale = useLocale();
  const toast = useRnToast();
  if (!row) return null;
  const markets = [...row.markets.real, ...row.markets.pseudo];
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(row.text);
      toast(tp("detail.copied"));
    } catch {
      toast(tp("detail.copyFailed"));
    }
  };
  return (
    <RnDrawer open onClose={onClose} title={tp("detail.title")} closeLabel={tp("close")}>
      <div className="flex flex-col gap-6">
        <section className="flex flex-col gap-2">
          <p className="m-0 rounded-xl bg-rn-page px-4 py-3 text-rn-15 leading-relaxed break-words whitespace-pre-wrap text-rn-ink">{row.text}</p>
          <RnButton size="sm" className="self-start" onClick={copy}>
            <Copy className="size-3.5" aria-hidden />
            {tp("detail.copy")}
          </RnButton>
        </section>
        <section>
          <h3 className="m-0 mb-2 text-rn-13 font-bold text-rn-ink">{tp("detail.attributes")}</h3>
          <dl className="m-0 grid grid-cols-[112px_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-rn-13">
            <Field label={t("brandLabel")}>
              <RnTag className={row.common ? "bg-rn-inset text-rn-ink-2" : undefined}>{row.common ? t("common") : row.brand}</RnTag>
            </Field>
            <Field label={t("presenceLabel")}>{row.presence ? tVal(row.presence) : null}</Field>
            <Field label={t("langLabel")}>{row.lang ? `${languageName(row.lang, locale)} (${row.lang.toUpperCase()})` : null}</Field>
            {taxonomy(row).map((l) => (
              <Field key={l.label} label={l.label}>
                {l.value}
              </Field>
            ))}
            <Field label={t("funnelLabel")}>{row.funnelStage}</Field>
            <Field label={t("marketLabel")}>
              {markets.length ? (
                <span className="flex flex-wrap gap-1">
                  {markets.map((code) => (
                    <span
                      key={code}
                      className={cx(
                        "inline-flex items-center gap-1 rounded-md px-1.5 py-px text-rn-12",
                        isPseudoRegion(code) ? "border border-dashed border-rn-faint text-rn-muted" : "bg-rn-inset text-rn-ink-2",
                      )}
                    >
                      {isPseudoRegion(code) ? <Tag className="size-3" aria-hidden /> : null}
                      {marketLabel(code)}
                    </span>
                  ))}
                </span>
              ) : (
                <span className="flex flex-col items-start gap-1">
                  <span className="inline-flex items-center gap-1 rounded-md bg-rn-inset px-1.5 py-px text-rn-12 text-rn-ink-2">
                    <Globe className="size-3" aria-hidden />
                    {t("marketAll")}
                  </span>
                  <span className="text-rn-12 text-rn-muted">{t("marketAllHint")}</span>
                </span>
              )}
            </Field>
            <Field label={t("kindLabel")}>{row.kind === "acr" ? t("kindAcr") : t("kindSingle")}</Field>
            <Field label={t("statusLabel")}>
              {row.scopePromptId === null ? (
                <span className="flex flex-col gap-1">
                  <span>{t("statusUnmeasured")}</span>
                  <span className="text-rn-12 text-rn-muted">{t("statusUnmeasuredHint")}</span>
                </span>
              ) : (
                t("statusMeasured")
              )}
            </Field>
          </dl>
        </section>
        <section>
          <h3 className="m-0 mb-3 text-rn-13 font-bold text-rn-ink">{tp("detail.history")}</h3>
          <RnPromptTimeline id={row.id} />
        </section>
      </div>
    </RnDrawer>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-rn-12 font-semibold text-rn-muted">{label}</dt>
      <dd className="m-0 min-w-0 break-words text-rn-ink">{children ?? <span className="text-rn-faint">—</span>}</dd>
    </>
  );
}
