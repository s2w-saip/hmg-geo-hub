"use client";

import { useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Globe, ListChecks, Map, Search, Sparkles } from "lucide-react";
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
import { cn } from "@/lib/utils";
import { getPresetById } from "@/lib/keyword/location-presets";
import { countryName } from "@/lib/geo-catalog/country-name";
import { RESEARCH_PURPOSES, getSeedKeywords, type ResearchPurposeId } from "./source-model";

// S1 — research input. The keyword + purpose seed the (fake) research run.
// `defaultKeyword` lets a parent prefill from the admin's standard keyword.
// `showPurpose=false` hides the 리서치 목적(type) selector + its prompt textarea
// — the project intent flow opts out (only keyword + locale seed a run there).
export function InputView({
  defaultKeyword = "",
  allowedCountries = ["KR"],
  onStart,
  showPurpose = true,
}: {
  defaultKeyword?: string;
  /**
   * ISO alpha-2 countries the calling account may pick, server-resolved via
   * scope-policy::resolveDimensionState (the account's own country access) —
   * not a fixed sample list. Flag/label come from the shared DataForSEO
   * location catalog when available, else a localized country name
   * (lib/geo-catalog/country-name.ts) — never a bare ISO code.
   */
  allowedCountries?: readonly string[];
  onStart: (keyword: string) => void;
  showPurpose?: boolean;
}) {
  const t = useTranslations("socialScraping.input");
  const locale = useLocale();
  const [keyword, setKeyword] = useState(defaultKeyword);
  const seedKeywords = useMemo(() => getSeedKeywords(locale), [locale]);
  const locationOptions = useMemo(
    () =>
      allowedCountries.map((iso) => {
        const preset = getPresetById(iso.toLowerCase());
        return {
          id: iso,
          flag: preset?.flag ?? "🌐",
          country: (locale === "ko" ? preset?.name : preset?.nameEn) ?? countryName(iso, locale),
          language: preset?.language_code,
        };
      }),
    [allowedCountries, locale],
  );
  const [location, setLocation] = useState(locationOptions[0]?.id ?? "");
  const [purposeId, setPurposeId] = useState<ResearchPurposeId>("purchase-context");
  const [purpose, setPurpose] = useState(t("purpose.purchase-context.body"));

  function changePurpose(id: ResearchPurposeId) {
    setPurposeId(id);
    setPurpose(id === "custom" ? "" : t(`purpose.${id}.body`));
  }

  const rows = RESEARCH_PURPOSES.find((p) => p.id === purposeId)?.rows ?? 6;
  const canStart = keyword.trim().length > 0;

  const STEPS = [
    { icon: Search, key: "step1" },
    { icon: Sparkles, key: "step2" },
    { icon: Map, key: "step3" },
    { icon: ListChecks, key: "step4" },
  ] as const;

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-lg border border-border bg-card p-5">
        <div className="grid gap-4 sm:grid-cols-[1fr_180px]">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ss-keyword" className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              {t("keywordLabel")}
            </Label>
            <Input
              id="ss-keyword"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canStart) onStart(keyword.trim());
              }}
              placeholder={t("keywordPlaceholder")}
            />
            <div className="mt-1 flex flex-wrap gap-1.5">
              {seedKeywords.map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKeyword(k)}
                  className="rounded-full border border-border bg-muted/40 px-2.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-brand-700/40 hover:text-foreground"
                >
                  {k}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ss-location" className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              {t("locationLabel")}
            </Label>
            <Select value={location} onValueChange={setLocation}>
              <SelectTrigger id="ss-location">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {locationOptions.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.flag} {p.country}
                    {p.language ? ` (${p.language})` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {showPurpose ? (
          <div className="mt-4 flex flex-col gap-1.5">
            <Label htmlFor="ss-purpose-select" className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              {t("purposeLabel")}
            </Label>
            <Select value={purposeId} onValueChange={(v) => changePurpose(v as ResearchPurposeId)}>
              <SelectTrigger id="ss-purpose-select" className="w-full sm:w-72">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RESEARCH_PURPOSES.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {t(`purpose.${p.id}.label`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <textarea
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              rows={rows}
              placeholder={t("purposePlaceholder")}
              className="mt-1.5 w-full resize-none rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
          </div>
        ) : null}

        <div className="mt-4 flex justify-end">
          <Button disabled={!canStart} onClick={() => onStart(keyword.trim())}>
            <Globe className="h-4 w-4" aria-hidden />
            {t("start")}
          </Button>
        </div>
      </div>

      {/* how it works */}
      <div>
        <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {t("howItWorksTitle")}
        </h3>
        <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map(({ icon: Icon, key }, i) => (
            <li key={key} className={cn("flex flex-col gap-2 rounded-lg border border-border bg-card p-4")}>
              <div className="flex items-center gap-2">
                <span className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-50 text-brand-700">
                  <Icon className="h-4 w-4" aria-hidden />
                </span>
                <span className="text-[11px] font-semibold tabular-nums text-muted-foreground">
                  {i + 1}
                </span>
              </div>
              <p className="text-sm font-medium text-foreground">{t(`${key}.title`)}</p>
              <p className="text-xs leading-5 text-muted-foreground">{t(`${key}.desc`)}</p>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
