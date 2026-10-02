"use client";

import { useState, useMemo, useTransition } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { countryName } from "@/lib/geo-catalog/country-name";
import {
  rhqRegionsForBrand,
  countriesForRhq,
  rhqLabel,
  type RhqLocale,
} from "@/lib/rhq";
import { Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AiEngineCheckboxes } from "@/components/dash/ai-engine-checkboxes";
import { DEFAULT_AI_ENGINES, type AiEngineId } from "@/lib/scope/engines";
import { createProject } from "./_actions";

// Simple 5-input form (v23 resolution 2026-06-02). Wizard dropped. Brand
// and Country dropdowns receive scope-filtered options from the server.
// Submission is a server action that re-validates the scope on the
// authoritative side and inserts both Project + Owner ProjectMember.
export function NewProjectForm({
  locale,
  allowedBrands,
  allowedCountries,
  brandLocked = false,
}: {
  locale: string;
  allowedBrands: readonly string[];
  allowedCountries: readonly string[];
  // 브랜드 스코프 계정(어드민 제외) → 브랜드 드롭다운을 자기 브랜드로 고정·비활성.
  brandLocked?: boolean;
}) {
  const t = useTranslations("projectNew.form");
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [domain, setDomain] = useState("");
  // 잠금 상태면 스코프 브랜드로 초기화(권역·국가 cascade가 바로 좁혀지도록).
  const [brand, setBrand] = useState<string>(
    brandLocked ? (allowedBrands[0] ?? "") : "",
  );
  const [region, setRegion] = useState<string>(""); // RHQ region id
  const [country, setCountry] = useState<string>("");
  // 답변을 수집할 AI 엔진 — 필수(≥1). 기본값은 scope 기본 타깃(chatgpt·gemini)
  // 으로 미리 체크해 두어, 엔진을 의식하지 않은 생성이 기존과 같은 측정을 갖게.
  const [aiEngines, setAiEngines] = useState<AiEngineId[]>([...DEFAULT_AI_ENGINES]);

  const rhqLocale: RhqLocale = locale === "en" ? "en" : "ko";
  const allowedSet = useMemo(() => new Set(allowedCountries), [allowedCountries]);

  // 선택 브랜드의 RHQ 권역 중 scope 국가를 하나라도 가진 것만 노출.
  // 브랜드 미선택 시 권역 선택은 비활성(브랜드가 권역 어휘를 결정).
  const regionOptions = useMemo(() => {
    if (!brand) return [];
    return rhqRegionsForBrand(brand).filter((r) =>
      countriesForRhq(r.id).some((c) => allowedSet.has(c)),
    );
  }, [brand, allowedSet]);

  // 권역 선택 시 그 권역 하위 국가 ∩ scope, 미선택 시 브랜드 전체(∩ scope).
  const countryOptions = useMemo(() => {
    if (region) {
      return countriesForRhq(region).filter((c) => allowedSet.has(c));
    }
    if (brand) {
      const brandSet = new Set(
        rhqRegionsForBrand(brand).flatMap((r) => countriesForRhq(r.id)),
      );
      return allowedCountries.filter((c) => brandSet.has(c));
    }
    return allowedCountries;
  }, [region, brand, allowedCountries, allowedSet]);

  function handleBrandChange(next: string) {
    setBrand(next);
    // 브랜드가 바뀌면 권역·국가 어휘가 달라지므로 하위 선택을 초기화.
    setRegion("");
    setCountry("");
  }

  function handleRegionChange(next: string) {
    setRegion(next);
    // 권역이 바뀌면 현재 국가가 새 권역 밖일 수 있으므로 초기화.
    const inRegion = new Set(countriesForRhq(next));
    if (country && !inRegion.has(country)) setCountry("");
  }

  const noRegionAllowed = brand !== "" && regionOptions.length === 0;
  const noCountryAllowed = countryOptions.length === 0;

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!name.trim()) {
      toast.error(t("titleRequired"));
      return;
    }
    if (!country) {
      toast.error(t("countryRequired"));
      return;
    }
    if (aiEngines.length === 0) {
      toast.error(t("aiEnginesRequired"));
      return;
    }
    const formData = new FormData();
    formData.set("locale", locale);
    formData.set("name", name);
    formData.set("description", description);
    formData.set("domain", domain);
    formData.set("brand", brand);
    formData.set("country", country);
    for (const e of aiEngines) formData.append("aiEngines", e);
    startTransition(async () => {
      const r = await createProject(formData);
      // On success the action redirects; if we're here it's an error result.
      if (!r.ok) toast.error(r.error);
    });
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5">
      <Field
        id="np-name"
        label={t("name") + " *"}
        required
        value={name}
        onChange={setName}
        placeholder={t("namePlaceholder")}
      />
      <Field
        id="np-description"
        label={t("description")}
        value={description}
        onChange={setDescription}
        placeholder={t("descriptionPlaceholder")}
      />
      <Field
        id="np-domain"
        label={t("domain")}
        value={domain}
        onChange={setDomain}
        placeholder="example.com"
      />

      <div className="flex flex-col gap-2">
        <Label htmlFor="np-brand">{t("brand")}</Label>
        <Select
          value={brand}
          onValueChange={handleBrandChange}
          disabled={brandLocked || allowedBrands.length === 0}
        >
          <SelectTrigger id="np-brand">
            <SelectValue placeholder={t("brandPlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            {allowedBrands.map((b) => (
              <SelectItem key={b} value={b}>
                {b}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {allowedBrands.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {t("noBrandHint")}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="np-region">{t("region")}</Label>
        <Select
          value={region}
          onValueChange={handleRegionChange}
          disabled={!brand || noRegionAllowed}
        >
          <SelectTrigger id="np-region">
            <SelectValue placeholder={t("regionPlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            {regionOptions.map((r) => (
              <SelectItem key={r.id} value={r.id}>
                {rhqLabel(r.id, rhqLocale) ?? r.id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="np-country">{t("country") + " *"}</Label>
        <Select
          value={country}
          onValueChange={setCountry}
          disabled={noCountryAllowed}
        >
          <SelectTrigger id="np-country">
            <SelectValue placeholder={t("countryPlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            {countryOptions.map((c) => (
              <SelectItem key={c} value={c}>
                {countryName(c, locale)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {noCountryAllowed ? (
          <p className="text-xs text-destructive">
            {t("noCountryHint")}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <Label>{t("aiEngines") + " *"}</Label>
        <AiEngineCheckboxes
          idPrefix="np-engine"
          value={aiEngines}
          onChange={setAiEngines}
        />
        <p className="text-xs text-muted-foreground">{t("aiEnginesHint")}</p>
        {aiEngines.length === 0 ? (
          <p className="text-xs text-destructive">{t("aiEnginesRequired")}</p>
        ) : null}
      </div>

      <div className="flex justify-end pt-2">
        <Button
          type="submit"
          disabled={
            pending || !name.trim() || !country || noCountryAllowed || aiEngines.length === 0
          }
        >
          <Save className="h-4 w-4" aria-hidden />
          {t("submit")}
        </Button>
      </div>
    </form>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  placeholder,
  required,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        required={required}
      />
    </div>
  );
}
