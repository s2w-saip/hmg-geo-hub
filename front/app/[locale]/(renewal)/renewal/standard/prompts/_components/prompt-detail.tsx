"use client";

// Prompt detail sheet of the renewal Global prompts list (2026-10-28). The list keeps one line per
// prompt, so a row opens this sheet with all the row carries — the full text (copyable), every
// attribute, every target market — and the prompt's change history (RnPromptTimeline).

import { useLocale, useTranslations } from "next-intl";
import { RnDrawer, RnTag } from "@/components/renewal-ui";
import { languageName } from "@/lib/geo-catalog/language-name";
import type { PromptRow } from "@/app/[locale]/(dash)/standard/prompts/_data/screen-types";
import { RnDetailField as Field, RnMarketList, RnPromptText } from "../../../_components/prompt-list";
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
  if (!row) return null;
  return (
    <RnDrawer open onClose={onClose} title={tp("detail.title")} closeLabel={tp("close")}>
      <div className="flex flex-col gap-6">
        <RnPromptText text={row.text} />
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
              <RnMarketList codes={[...row.markets.real, ...row.markets.pseudo]} labelOf={marketLabel} allLabel={t("marketAll")} allHint={t("marketAllHint")} />
            </Field>
            <Field label={t("kindLabel")}>{row.kind === "acr" ? t("kindAcr") : t("kindSingle")}</Field>
            <Field label={t("statusLabel")}>
              {row.scopePromptId === null ? (
                <span className="flex flex-col gap-1">
                  <span>{t("statusUnmeasured")}</span>
                  <span className="text-rn-12 text-rn-muted">{tp("unmeasuredHint")}</span>
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

