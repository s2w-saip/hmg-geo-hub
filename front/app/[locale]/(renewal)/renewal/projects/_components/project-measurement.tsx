"use client";

// Project › Setting (2026-11-06): the measurement settings as a form. They live in the input store (back/bff/hub_stores/measurement.py)
// and 수집 reads them through the prompt and reference API, so saving changes the source and no number on this page.

import { useRouter } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { RnButton, RnCard, RnCardHeader, RnNote, RnSelect, RnToastProvider, cx, useRnToast } from "@/components/renewal-ui";
import { countryName } from "@/lib/geo-catalog/country-name";
import { languageName } from "@/lib/geo-catalog/language-name";
import { aiEngineLabel } from "@/lib/scope/engines";

export interface MeasurementTarget {
  kind: "brand" | "model";
  name: string;
  brand?: string | null;
}

export interface Measurement {
  /** 0: the project has no version yet */
  version: number;
  brands: string[];
  countries: string[];
  engines: string[];
  cadence: "weekly" | "biweekly" | "monthly" | null;
  acrRepeats: number | null;
  webUnits: { fileSeq: number | null; langCodes: string[]; base: string | null }[];
  ownedUrls: string[];
  trackedUrls: string[];
  trackedTargets: MeasurementTarget[];
  origin: "gold_import" | "hub" | null;
  recordedAt: string | null;
}

export interface MeasurementView {
  item: Measurement;
  options: { brands: string[]; countries: string[]; engines: string[] };
  /** the API holds the editor's connection */
  editing: boolean;
}

const CADENCES = ["weekly", "biweekly", "monthly"] as const;
const INPUT = "rounded-md border border-rn-line-2 bg-rn-surface px-2.5 text-rn-13 text-rn-ink outline-none focus:border-rn-navy focus:ring-3 focus:ring-rn-navy/12";

function lines(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/** A list of codes as typed: split on commas or spaces. */
export function codes(text: string): string[] {
  return text.split(/[\s,]+/).map((c) => c.trim().toUpperCase()).filter(Boolean);
}

/** One model per line: "Tesla / Model Y", or the model alone. */
export function modelsOf(text: string): MeasurementTarget[] {
  return lines(text).map((line) => {
    const at = line.indexOf("/");
    if (at < 0) return { kind: "model" as const, name: line };
    const brand = line.slice(0, at).trim();
    const name = line.slice(at + 1).trim();
    return { kind: "model" as const, name: name || brand, ...(brand && name ? { brand } : {}) };
  });
}

function modelLine(t: MeasurementTarget): string {
  return t.brand ? `${t.brand} / ${t.name}` : t.name;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <>
      <dt className="border-t border-rn-line py-3 text-rn-12 font-semibold text-rn-muted">{label}</dt>
      <dd className="m-0 flex min-w-0 flex-col gap-1.5 border-t border-rn-line py-2.5 text-rn-13 text-rn-ink">
        {children}
        {hint ? <span className="text-rn-12 text-rn-muted">{hint}</span> : null}
      </dd>
    </>
  );
}

function Choices({ options, selected, label, disabled, onToggle, labelOf }: { options: string[]; selected: string[]; label: string; disabled: boolean; onToggle: (value: string) => void; labelOf: (value: string) => string }) {
  return (
    <span role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const on = selected.includes(o);
        return (
          <button
            key={o}
            type="button"
            aria-pressed={on}
            disabled={disabled}
            onClick={() => onToggle(o)}
            className={cx("h-[30px] cursor-pointer rounded-md border px-2.5 text-rn-12 font-semibold", on ? "border-rn-navy bg-rn-navy/8 text-rn-navy" : "border-rn-line-2 bg-rn-surface text-rn-ink-2 hover:border-rn-faint")}
          >
            {labelOf(o)}
          </button>
        );
      })}
    </span>
  );
}

export function RnProjectMeasurement(props: { projectId: string; view: MeasurementView }) {
  return (
    <RnToastProvider>
      <MeasurementForm {...props} />
    </RnToastProvider>
  );
}

function MeasurementForm({ projectId, view }: { projectId: string; view: MeasurementView }) {
  const t = useTranslations("renewal.projects.setting.measurement");
  const locale = useLocale();
  const router = useRouter();
  const toast = useRnToast();
  const { item, options } = view;
  const initial = useMemo(
    () => ({
      brands: item.brands,
      countries: item.countries.join(", "),
      engines: item.engines,
      cadence: item.cadence ?? "",
      acrRepeats: item.acrRepeats === null ? "" : String(item.acrRepeats),
      ownedUrls: item.ownedUrls.join("\n"),
      trackedUrls: item.trackedUrls.join("\n"),
      trackedBrands: item.trackedTargets.filter((x) => x.kind === "brand").map((x) => x.name).join("\n"),
      trackedModels: item.trackedTargets.filter((x) => x.kind === "model").map(modelLine).join("\n"),
    }),
    [item],
  );
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));
  const toggle = (key: "brands" | "engines", value: string) =>
    setForm((f) => ({ ...f, [key]: f[key].includes(value) ? f[key].filter((v) => v !== value) : [...f[key], value] }));
  const typedCountries = codes(form.countries);
  const unknownCountries = options.countries.length ? typedCountries.filter((c) => !options.countries.includes(c)) : [];
  const repeats = form.acrRepeats.trim() === "" ? null : Number(form.acrRepeats);
  const badRepeats = repeats !== null && !(Number.isInteger(repeats) && repeats >= 1 && repeats <= 100);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/hub/projects/${projectId}/measurement`, {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedVersion: item.version,
          brands: form.brands,
          countries: typedCountries,
          engines: form.engines,
          cadence: form.cadence || null,
          acrRepeats: repeats,
          webUnits: item.webUnits,
          ownedUrls: lines(form.ownedUrls),
          trackedUrls: lines(form.trackedUrls),
          trackedTargets: [...lines(form.trackedBrands).map((name) => ({ kind: "brand" as const, name })), ...modelsOf(form.trackedModels)],
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
        const code = body?.error?.code;
        setError(t(code === "version_conflict" ? "errors.conflict" : code === "unknown_code" ? "errors.unknown" : code === "invalid_value" ? "errors.invalid" : "errors.failed"));
        return;
      }
      toast(t("saved"));
      router.refresh();
    } catch {
      setError(t("errors.failed"));
    } finally {
      setSaving(false);
    }
  }

  const disabled = !view.editing || saving;
  return (
    <RnCard aria-label={t("title")} data-rn-project-measurement="">
      <RnCardHeader title={t("title")} hint={t("hint")} />
      <dl className="m-0 grid grid-cols-[200px_minmax(0,1fr)] gap-x-6 gap-y-0 px-6 pb-2 text-rn-13">
        <Field label={t("brands")}>
          <Choices options={options.brands} selected={form.brands} label={t("brands")} disabled={disabled} onToggle={(v) => toggle("brands", v)} labelOf={(v) => t.has(`brandNames.${v}`) ? t(`brandNames.${v}`) : v} />
        </Field>
        <Field label={t("countries")} hint={unknownCountries.length ? t("unknownCountries", { codes: unknownCountries.join(", ") }) : t("countriesHint")}>
          <input aria-label={t("countries")} value={form.countries} disabled={disabled} onChange={(e) => set("countries", e.target.value)} className={cx(INPUT, "h-[30px] w-full")} placeholder="KR, US" />
          {typedCountries.length ? <span className="text-rn-12 text-rn-ink-2">{typedCountries.map((c) => countryName(c, locale)).join(", ")}</span> : null}
        </Field>
        <Field label={t("engines")}>
          <Choices options={options.engines} selected={form.engines} label={t("engines")} disabled={disabled} onToggle={(v) => toggle("engines", v)} labelOf={aiEngineLabel} />
        </Field>
        <Field label={t("cadence")}>
          <RnSelect
            className="self-start"
            label={t("cadence")}
            value={form.cadence}
            disabled={disabled}
            onChange={(e) => set("cadence", e.target.value as typeof form.cadence)}
            options={[{ value: "", label: t("cadenceNone") }, ...CADENCES.map((value) => ({ value, label: t(`cadences.${value}`) }))]}
          />
        </Field>
        <Field label={t("acrRepeats")} hint={badRepeats ? t("acrRepeatsBad") : t("acrRepeatsHint")}>
          <input aria-label={t("acrRepeats")} inputMode="numeric" value={form.acrRepeats} disabled={disabled} onChange={(e) => set("acrRepeats", e.target.value)} className={cx(INPUT, "h-[30px] w-24 tabular-nums")} />
        </Field>
        {item.webUnits.length ? (
          <Field label={t("webUnits")} hint={t("webUnitsHint")}>
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {item.webUnits.map((u, i) => (
                <li key={u.fileSeq ?? i}>
                  {u.langCodes.map((l) => languageName(l, locale)).join(", ") || t("none")} · {u.base ?? t("noBase")}
                </li>
              ))}
            </ul>
          </Field>
        ) : null}
        <Field label={t("ownedUrls")} hint={t("urlsHint")}>
          <textarea aria-label={t("ownedUrls")} rows={3} value={form.ownedUrls} disabled={disabled} onChange={(e) => set("ownedUrls", e.target.value)} className={cx(INPUT, "w-full py-1.5")} />
        </Field>
        <Field label={t("trackedUrls")} hint={t("urlsHint")}>
          <textarea aria-label={t("trackedUrls")} rows={3} value={form.trackedUrls} disabled={disabled} onChange={(e) => set("trackedUrls", e.target.value)} className={cx(INPUT, "w-full py-1.5")} />
        </Field>
        <Field label={t("trackedBrands")} hint={t("trackedBrandsHint")}>
          <textarea aria-label={t("trackedBrands")} rows={3} value={form.trackedBrands} disabled={disabled} onChange={(e) => set("trackedBrands", e.target.value)} className={cx(INPUT, "w-full py-1.5")} />
        </Field>
        <Field label={t("trackedModels")} hint={t("trackedModelsHint")}>
          <textarea aria-label={t("trackedModels")} rows={3} value={form.trackedModels} disabled={disabled} onChange={(e) => set("trackedModels", e.target.value)} className={cx(INPUT, "w-full py-1.5")} />
        </Field>
      </dl>
      <div className="flex items-center justify-end gap-3 border-t border-rn-line px-6 py-3">
        {error ? <span role="alert" className="mr-auto text-rn-12 font-semibold text-rn-danger-ink">{error}</span> : <span className="mr-auto text-rn-12 text-rn-muted">{item.version ? t("version", { version: item.version, origin: t(`origin.${item.origin ?? "hub"}`) }) : t("noVersion")}</span>}
        <RnButton variant="primary" disabled={disabled || !dirty || badRepeats || unknownCountries.length > 0} onClick={() => void save()}>
          {saving ? <Loader2 aria-hidden className="size-4 animate-spin" /> : null}
          {t("save")}
        </RnButton>
      </div>
      {!view.editing ? <div className="px-6 pb-4"><RnNote>{t("notEditing")}</RnNote></div> : null}
    </RnCard>
  );
}
