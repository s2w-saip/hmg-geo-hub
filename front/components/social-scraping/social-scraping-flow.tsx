"use client";
import { useTranslations } from "next-intl";
import { EmptyState } from "@/components/empty-state";
import { ContextMapView } from "./context-map-view";
import type { CombinationListRow, ConditionListRow, ContextListRow, ContextMapStats, GeneratedPrompt, Paged } from "./types";

export function SocialScrapingFlow({
  mode = "standard",
  projectId,
  defaultKeyword: _defaultKeyword,
  allowedCountries: _allowedCountries,
  readOnly = false,
  showPurpose: _showPurpose = true,
  startAtContextMap = false,
  stats,
  initialPages,
  generatedPrompts,
  addedTexts,
}: {
  mode?: "standard" | "admin";
  projectId?: string;
  defaultKeyword?: string;
  allowedCountries?: readonly string[];
  readOnly?: boolean;
  showPurpose?: boolean;
  startAtContextMap?: boolean;
  stats?: ContextMapStats;
  initialPages?: {
    contexts: Paged<ContextListRow>;
    conditions: Paged<ConditionListRow>;
    combinations: Paged<CombinationListRow>;
  };
  generatedPrompts?: GeneratedPrompt[];
  addedTexts?: string[];
}) {
  const t = useTranslations("gold");
  if (!stats || !initialPages) return <EmptyState title={t("noData")} description={t("noDataDescription")} />;
  return <ContextMapView stats={stats} initialPages={initialPages} mode={mode} projectId={projectId} generatedPrompts={generatedPrompts ?? []} addedTexts={addedTexts} readOnly={readOnly} genericTitle={startAtContextMap} />;
}
