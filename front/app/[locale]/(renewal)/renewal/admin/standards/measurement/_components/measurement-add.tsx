"use client";

// Admin › 측정 설정 › 프로젝트 만들기 (T6.3): the fields of the legacy /projects/new form; the hub server writes the project, its first version and its first
// settings in one transaction (back/hub_server/inputs/projects.py). The sheet then shows the new project's settings.

import { useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { RnButton, RnSelect } from "@/components/renewal-ui";
import { countryName } from "@/lib/geo-catalog/country-name";
import { aiEngineLabel } from "@/lib/scope/engines";
import { Choices, Field, MEASUREMENT_INPUT } from "../../../../projects/_components/project-measurement";
import type { MeasurementListing } from "./measurement-model";

export function MeasurementAdd({ options, disabled, onAdded }: { options: MeasurementListing["options"]; disabled: boolean; onAdded: (projectId: string) => void }) {
  const t = useTranslations("hubMeasurement");
  const tf = useTranslations("projectNew.form");
  const tm = useTranslations("renewal.projects.setting.measurement");
  const locale = useLocale();
  const [form, setForm] = useState({ name: "", description: "", domain: "", brand: "", country: "" });
  const [engines, setEngines] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (key: keyof typeof form, value: string) => setForm((f) => ({ ...f, [key]: value }));
  const countries = useMemo(
    () => options.countries.map((value) => ({ value, label: `${countryName(value, locale)} (${value})` })).sort((a, b) => a.label.localeCompare(b.label, locale)),
    [options.countries, locale],
  );

  async function save() {
    if (!form.name.trim()) return setError(tf("titleRequired"));
    if (!form.country) return setError(tf("countryRequired"));
    if (!engines.length) return setError(tf("aiEnginesRequired"));
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/hub/projects", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: form.name, description: form.description || null, domain: form.domain || null, brand: form.brand || null, country: form.country, engines }),
      });
      const body = (await res.json().catch(() => null)) as { data?: { projectId?: string }; error?: { code?: string } } | null;
      if (!res.ok || !body?.data?.projectId) {
        setError(t(body?.error?.code === "invalid_value" ? "addErrors.invalid" : body?.error?.code === "unknown_code" ? "addErrors.unknown" : "addErrors.failed"));
        return;
      }
      onAdded(body.data.projectId);
    } catch {
      setError(t("addErrors.failed"));
    } finally {
      setSaving(false);
    }
  }

  const off = disabled || saving;
  return (
    <div data-hub-measurement-add="">
      <dl className="m-0 grid grid-cols-[120px_minmax(0,1fr)] gap-x-4 gap-y-0 text-rn-13">
        <Field label={tf("name")}>
          <input aria-label={tf("name")} value={form.name} disabled={off} placeholder={tf("namePlaceholder")} onChange={(e) => set("name", e.target.value)} className={`${MEASUREMENT_INPUT} h-[30px]`} />
        </Field>
        <Field label={tf("description")}>
          <textarea aria-label={tf("description")} rows={2} value={form.description} disabled={off} placeholder={tf("descriptionPlaceholder")} onChange={(e) => set("description", e.target.value)} className={`${MEASUREMENT_INPUT} py-1.5`} />
        </Field>
        <Field label={tf("domain")} hint={t("addDomainHint")}>
          <input aria-label={tf("domain")} value={form.domain} disabled={off} onChange={(e) => set("domain", e.target.value)} className={`${MEASUREMENT_INPUT} h-[30px]`} />
        </Field>
        <Field label={tf("brand")}>
          <RnSelect
            className="self-start"
            label={tf("brand")}
            value={form.brand}
            disabled={off}
            onChange={(e) => set("brand", e.target.value)}
            options={[{ value: "", label: tf("brandPlaceholder") }, ...options.brands.map((value) => ({ value, label: tm.has(`brandNames.${value}`) ? tm(`brandNames.${value}`) : value }))]}
          />
        </Field>
        <Field label={tf("country")}>
          <RnSelect className="self-start" label={tf("country")} value={form.country} disabled={off} onChange={(e) => set("country", e.target.value)} options={[{ value: "", label: tf("countryPlaceholder") }, ...countries]} />
        </Field>
        <Field label={tf("aiEngines")} hint={t("addEnginesHint")}>
          <Choices options={options.engines} selected={engines} label={tf("aiEngines")} disabled={off} onToggle={(v) => setEngines((e) => (e.includes(v) ? e.filter((x) => x !== v) : [...e, v]))} labelOf={aiEngineLabel} />
        </Field>
      </dl>
      <div className="mt-3 flex items-center justify-end gap-3 border-t border-rn-line pt-3">
        {error ? <span role="alert" className="mr-auto text-rn-12 font-semibold text-rn-danger-ink">{error}</span> : null}
        <RnButton variant="primary" disabled={off} onClick={() => void save()}>
          {saving ? <Loader2 aria-hidden className="size-4 animate-spin" /> : null}
          {tf("submit")}
        </RnButton>
      </div>
    </div>
  );
}
