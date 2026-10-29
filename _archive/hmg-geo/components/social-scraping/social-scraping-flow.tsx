"use client";

import { useMemo, useState } from "react";
import { useLocale } from "next-intl";
import { InputView } from "./input-view";
import { ExploringView } from "./exploring-view";
import { ContextMapView } from "./context-map-view";
import { getSampleMatrix } from "./sample-data";
import {
  pageSampleCombinations,
  pageSampleConditions,
  pageSampleContexts,
  sampleStats,
} from "@/lib/social-scraping/page-matrix";
import type {
  CombinationListRow,
  ConditionListRow,
  ContextListRow,
  ContextMapStats,
  ContextMatrix,
  GeneratedPrompt,
  Paged,
} from "./types";

type Stage = "input" | "exploring" | "context-map";

// Page size for the in-memory sample fixture. Larger than the live page (50)
// only because the whole fixture is a handful of rows — this just avoids a
// pointless pager under an 8-row table.
const SAMPLE_PAGE_SIZE = 50;

function sampleInitialPages(matrix: ContextMatrix) {
  const base = { page: 0, size: SAMPLE_PAGE_SIZE, dir: "desc" as const };
  return {
    contexts: pageSampleContexts(matrix, { ...base, sort: "mentions" }),
    conditions: pageSampleConditions(matrix, { ...base, sort: "mentions" }),
    combinations: pageSampleCombinations(matrix, { ...base, sort: "cooccurrence" }),
  };
}

// Orchestrates the social-scraping userflow as a self-contained state machine:
//   INPUT → EXPLORING (simulated stream) → CONTEXT-MAP (구매 맥락 지도) → 프롬프트 후보
//
// Adapted from the standalone research agent (docs/social-scraping-screen-design.md):
// the standalone RESULTS markdown-report view is dropped — in hmg-geo the
// matrix's job is to feed the prompt candidate pool, not to produce a report.
//
// `mode` only changes the final "send candidates" copy (project pool vs.
// standard prompt catalog). All data is the fake fixture for now.
export function SocialScrapingFlow({
  mode = "standard",
  projectId,
  defaultKeyword,
  allowedCountries,
  readOnly = false,
  showPurpose = true,
  startAtContextMap = false,
  stats,
  initialPages,
  generatedPrompts,
  addedTexts,
}: {
  mode?: "standard" | "admin";
  /**
   * Present only on the project intent route. Enables the 프롬프트 카탈로그
   * 추가 table's send action to actually persist selected prompts to the
   * project's candidate pool. When absent (admin/standard read-only), the
   * send button falls back to a demo toast.
   */
  projectId?: string;
  defaultKeyword?: string;
  /**
   * Forwarded to the INPUT stage's location select — the calling account's own
   * country access (scope-policy::resolveDimensionState), not a fixed sample
   * list. Unused when `readOnly` (INPUT stage is skipped).
   */
  allowedCountries?: readonly string[];
  /**
   * Read-only mode skips the INPUT and EXPLORING stages and lands directly on
   * the context-map. The 표준 customer-interest route uses this — that surface
   * is read & export only, not a place to spawn new researches.
   */
  readOnly?: boolean;
  /**
   * Forwarded to the INPUT stage. `false` hides the 리서치 목적(type) selector +
   * its prompt textarea — the project intent flow seeds runs with keyword only.
   */
  showPurpose?: boolean;
  /**
   * Lands directly on the context-map like `readOnly` and hides the "처음으로"
   * back button — this surface is a lookup-only view of the shared
   * industry-wide sample matrix, not a per-run research result, so there is
   * no INPUT stage to go back to. Unlike `readOnly`, the 프롬프트 카탈로그
   * 추가 table (write access) stays visible.
   */
  startAtContextMap?: boolean;
  /**
   * Live corpus stats + the first page of each tab, fetched server-side from
   * the scope_context_* mirror. When present the view is LIVE: page turns and
   * searches go to /api/context-map, and the fake sample matrix is unused.
   * The project intent route is the only caller today.
   *
   * When absent the view is SAMPLE: the fixture is paged in memory
   * (lib/social-scraping/page-matrix.ts). Same paged interface either way —
   * ContextMapView does not branch on data source beyond picking a fetcher.
   */
  stats?: ContextMapStats;
  initialPages?: {
    contexts: Paged<ContextListRow>;
    conditions: Paged<ConditionListRow>;
    combinations: Paged<CombinationListRow>;
  };
  /**
   * Server-generated candidate prompts (decision B, 2026-07-09) for the
   * project intent route — real, brand-differentiated, built from the context
   * matrix via OpenRouter. Forwarded to ContextMapView's 프롬프트 카탈로그 추가
   * table. Absent elsewhere → that table falls back to the sample fixture.
   */
  generatedPrompts?: GeneratedPrompt[];
  /**
   * Candidate texts already in the project's pool — the 프롬프트 카탈로그 추가
   * table marks matching prompts as "이미 추가됨" (not re-sendable).
   */
  addedTexts?: string[];
}) {
  const locale = useLocale();
  const sampleMatrix = useMemo(() => getSampleMatrix(locale), [locale]);
  const [stage, setStage] = useState<Stage>(
    readOnly || startAtContextMap ? "context-map" : "input",
  );
  const [keyword, setKeyword] = useState(defaultKeyword ?? sampleMatrix.keyword);

  // Live when the server handed us pages; sample otherwise. The fake matrix is
  // fixed content, so reflect the entered keyword in its header.
  const live = Boolean(stats && initialPages);
  const matrix = useMemo(() => ({ ...sampleMatrix, keyword }), [sampleMatrix, keyword]);

  if (stage === "input" && !readOnly) {
    return (
      <InputView
        defaultKeyword={defaultKeyword}
        allowedCountries={allowedCountries}
        showPurpose={showPurpose}
        onStart={(kw) => {
          setKeyword(kw);
          setStage("exploring");
        }}
      />
    );
  }

  if (stage === "exploring" && !readOnly) {
    return <ExploringView keyword={keyword} onComplete={() => setStage("context-map")} />;
  }

  return (
    <ContextMapView
      // Live: server pages + /api/context-map for turns. Sample: the fixture,
      // paged in memory (there is no endpoint to page a fixture against).
      keyword={live ? undefined : matrix.keyword}
      sampleMatrix={live ? undefined : matrix}
      stats={stats ?? sampleStats(matrix)}
      initialPages={initialPages ?? sampleInitialPages(matrix)}
      mode={mode}
      projectId={projectId}
      generatedPrompts={generatedPrompts}
      addedTexts={addedTexts}
      readOnly={readOnly}
      genericTitle={startAtContextMap}
      onBack={readOnly || startAtContextMap ? undefined : () => setStage("input")}
    />
  );
}
