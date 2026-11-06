"use client";

// Admin › 고객 관심 데이터 관리 (2026-11-02): what the two tabs share — error text, the brand picks and labels, the form's
// failure and buttons — and the collection conditions a keyword picks from the DataForSEO presets.
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useLocale, useTranslations } from "use-intl";
import { RnButton, RnCheckRow, RnGroupHeader, RnSearchField, RnTextButton, RnToken, cx } from "@/components/renewal-ui";
import { LOCATION_LANGUAGE_PRESETS } from "@/lib/keyword/location-presets";
import { SourceRequestError } from "../../citation-sources/_components/source-overrides-api";
import { INTEREST_BRANDS, type InterestBrand, type KeywordCondition } from "./interest-api";
import { REGION_KEYS, conditionKey, conditionLabel } from "./interest-model";

const KNOWN = ["invalid_value", "not_found", "unauthorized", "forbidden", "source_unavailable"];

export function useInterestError() {
  const t = useTranslations("hubInterest");
  return useCallback(
    (e: unknown) => {
      const err = e instanceof SourceRequestError ? e : new SourceRequestError(0, "failed");
      return t(`error.${KNOWN.includes(err.code) ? (err.code as "failed") : "failed"}`, { fields: (err.details?.fields ?? []).join(", ") || "—" });
    },
    [t],
  );
}

/** 공통 when no brand is picked (common to every brand). */
export function useBrandsLabel() {
  const t = useTranslations("hubInterest");
  return useCallback((brands: readonly string[]) => (brands.length ? brands.join(", ") : t("brandCommon")), [t]);
}

export function BrandPicks({ value, onChange }: { value: readonly InterestBrand[]; onChange: (v: InterestBrand[]) => void }) {
  const t = useTranslations("hubInterest");
  return (
    <div className="flex flex-col" data-hub-interest-brands="">
      {INTEREST_BRANDS.map((b) => (
        <RnCheckRow key={b} checked={value.includes(b)} label={b} onToggle={() => onChange(INTEREST_BRANDS.filter((x) => (x === b ? !value.includes(b) : value.includes(x))))} />
      ))}
      <p className="m-0 mt-1 text-rn-11 text-rn-muted">{t("brandHint")}</p>
    </div>
  );
}

/** The presets by region, the picks as chips. A stored condition outside the presets stays a chip that can be removed. */
export function ConditionPicker({ value, onChange, invalid }: { value: readonly KeywordCondition[]; onChange: (v: KeywordCondition[]) => void; invalid?: boolean }) {
  const t = useTranslations("hubInterest");
  const tr = useTranslations("renewal.filters");
  const locale = useLocale();
  const [q, setQ] = useState("");
  const picked = useMemo(() => new Set(value.map(conditionKey)), [value]);
  const query = q.trim().toLowerCase();
  const groups = useMemo(() => {
    const shown = LOCATION_LANGUAGE_PRESETS.filter((p) => !query || `${p.name} ${p.nameEn} ${p.language_code}`.toLowerCase().includes(query));
    const regions = [...new Set(shown.map((p) => p.region))];
    return regions.map((region) => ({ region, presets: shown.filter((p) => p.region === region) }));
  }, [query]);
  const toggle = (c: KeywordCondition) =>
    onChange(picked.has(conditionKey(c)) ? value.filter((x) => conditionKey(x) !== conditionKey(c)) : [...value, { location_code: c.location_code, language_code: c.language_code }]);
  return (
    <div className="flex flex-col gap-2" data-hub-interest-conditions="">
      {value.length ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {value.map((c) => {
            const label = conditionLabel(c, locale);
            return <RnToken key={conditionKey(c)} label={t("conditionToken")} value={label} removeLabel={t("conditionRemove", { condition: label })} onRemove={() => toggle(c)} />;
          })}
          <RnTextButton className="ml-1" onClick={() => onChange([])}>
            {t("conditionClear")}
          </RnTextButton>
        </div>
      ) : null}
      <div className={cx("rounded-rn-control border", invalid ? "border-rn-danger-ink" : "border-rn-line-2")}>
        <div className="border-b border-rn-line p-1.5">
          <RnSearchField value={q} onChange={setQ} placeholder={t("conditionSearch")} label={t("conditionSearch")} />
        </div>
        <div role="group" aria-label={t("field.conditions")} className="max-h-[232px] overflow-y-auto overscroll-contain p-1">
          {groups.length === 0 ? <p className="m-0 px-2.5 py-2 text-rn-12 text-rn-muted">—</p> : null}
          {groups.map((g) => {
            const anyIn = g.presets.some((p) => picked.has(conditionKey(p)));
            const keys = new Set(g.presets.map(conditionKey));
            return (
              <div key={g.region}>
                <RnGroupHeader
                  label={t(`region.${REGION_KEYS[g.region] as "asia"}`)}
                  active={anyIn}
                  title={anyIn ? tr("groupClear") : tr("groupSelectAll")}
                  onToggle={() =>
                    onChange(
                      anyIn
                        ? value.filter((c) => !keys.has(conditionKey(c)))
                        : [...value, ...g.presets.filter((p) => !picked.has(conditionKey(p))).map((p) => ({ location_code: p.location_code, language_code: p.language_code }))],
                    )
                  }
                />
                {g.presets.map((p) => (
                  <RnCheckRow key={p.id} checked={picked.has(conditionKey(p))} label={locale === "ko" ? p.name : p.nameEn} meta={p.language_code} onToggle={() => toggle(p)} />
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function FormFoot({ failure, pending, onCancel }: { failure: string | null; pending: boolean; onCancel: () => void }) {
  const t = useTranslations("hubInterest");
  return (
    <>
      {failure ? (
        <p role="alert" className="m-0 rounded-[10px] bg-rn-page p-3.5 text-rn-12 text-rn-danger-ink">
          {failure}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <RnButton onClick={onCancel}>{t("cancel")}</RnButton>
        <RnButton type="submit" variant="primary" disabled={pending}>
          {t("save")}
        </RnButton>
      </div>
    </>
  );
}

export function Problem({ children, attr }: { children: ReactNode; attr: string }) {
  return (
    <p className="m-0 mt-1 text-rn-11 text-rn-danger-ink" data-hub-interest-problem={attr}>
      {children}
    </p>
  );
}
