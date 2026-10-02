// Shapes the Raw Data QA console screens consume, independent of the data source.
//
// The legacy repository (lib/db/repositories/qa-review.ts) defined these next to its SQL;
// the screens imported them from there. The API adapter (lib/hgh/adapters/qa.ts, unit U12)
// builds the same shapes from /v1/qa/*, so the types live here and both sources are checked
// against them (the legacy objects must stay assignable: lib/hgh/adapters/qa.test.ts).
// Pure types plus the section key list: no server or React dependency, so client
// components may import this module.
import type { QaSeverity, QaSurface, QaTargetKind } from "./filters";

export type QaReviewState = "unreviewed" | "ok" | "issue";

export type QaProgress = { total: number; reviewed: number; issues: number; notes: number };

export type QaSectionKey = "answer" | "prompt" | "mentions" | "citations" | "acr" | "meta";
export const QA_SECTION_KEYS: readonly QaSectionKey[] = [
  "answer",
  "prompt",
  "mentions",
  "citations",
  "acr",
  "meta",
];
export type QaSectionFlags = Partial<Record<QaSectionKey, "ok" | "issue">>;

export type QaMentionGranule = {
  entityId: string;
  brand: string | null;
  entityType: string | null;
  mentionCount: number;
  sentimentPositive: number;
  sentimentNeutral: number;
  sentimentNegative: number;
  sentimentMixed: number;
  avgPosition: number | null;
  surfaces: string[] | null;
  brandRollupEntityId: string | null;
  rollupParentName: string | null;
  typeMention: number;
  typeRecommendation: number;
  typeComparison: number;
  typeDefinition: number;
  typeFinalChoice: number;
  registryRole: string | null;
  isOwn: boolean;
  isExcluded: boolean;
};

export type QaCitationGranule = {
  /** Row key. Legacy: scope_citations.id; API: the citation ordinal in the answer. */
  id: number;
  /**
   * Note target key of this citation. API: 'job_id:ord' (backend DDL convention). Absent on
   * the legacy source, whose notes are keyed String(id) (granule-tables falls back to that).
   */
  targetKey?: string | null;
  refIndex: number | null;
  url: string | null;
  domain: string | null;
  title: string | null;
  storedCategory: string | null;
  overrideCategory: string | null;
  effectiveCategory: string | null;
  urlNorm: string | null;
  urlHost: string | null;
  urlBaseNorm: string | null;
};

export type QaAcrGranule = {
  /** Legacy: Scope prompt_run_id. API: prompt_run_id when the backend sends it, else "acr_cell:<acr_cell_key>". */
  promptRunId: string;
  entityId: string;
  brand: string | null;
  parentBrand: string | null;
  rollupLevel: string | null;
  entityType: string | null;
  plannedIterations: number;
  validTurn1Iterations: number;
  validAcrIterations: number;
  appearanceCount: number;
  choiceCount: number;
  conditionalChoiceCount: number;
  offShortlistChoiceCount: number;
  unresolvedChoiceCount: number;
  genericChoiceCount: number;
  appearanceRate: number | null;
  acr: number | null;
  overallChoiceShare: number | null;
  coSingleEntity: number;
  coConditionalMultiple: number;
  coGenericCategory: number;
  coResolvedOffShortlist: number;
  coUnresolvedChoice: number;
  coNone: number;
};

export type QaPromptCatalog = {
  brand: string | null;
  brandPresence: string | null;
  listType: string | null;
  depth1: string | null;
  depth2: string | null;
  depth3: string | null;
  depth4: string | null;
  funnelStage: string | null;
  kind: string | null;
  promptType: string | null;
  category: string | null;
};

export type QaAnswerDetail = {
  answer: {
    jobId: string;
    /** Scope run id. null on the API source until the backend sends it (core request R1). */
    runId: string | null;
    promptId: string | null;
    target: string;
    /** Scope region. null on the API source until the backend sends it (core request R1). */
    region: string | null;
    status: string | null;
    measuredAt: Date | null;
    modelSlug: string | null;
    answerText: string | null;
    surface: QaSurface;
    brand: string | null;
    country: string | null;
  };
  prompt: {
    text: string | null;
    funnelStage: string | null;
    lang: string | null;
    regions: string[] | null;
    isKorean: boolean | null;
    catalog: QaPromptCatalog | null;
  };
  mentions: QaMentionGranule[];
  citations: QaCitationGranule[];
  acr: QaAcrGranule[];
  derived: {
    anchor: { anchor: string; sourceMeasuredAt: Date | null; reason: string | null } | null;
    drop: { sourceMeasuredAt: Date | null; reason: string; droppedAt: Date | null } | null;
  };
};

// ── serialized forms (server -> client component boundary: dates are ISO strings) ──

/** Detail as the detail screen takes it (answers/[jobId]/_components/types.ts SerializedDetail). */
export type QaSerializedDetail = {
  answer: Omit<QaAnswerDetail["answer"], "measuredAt"> & { measuredAt: string | null };
  prompt: QaAnswerDetail["prompt"];
  mentions: QaMentionGranule[];
  citations: QaCitationGranule[];
  acr: QaAcrGranule[];
  derived: {
    anchor: { anchor: string; sourceMeasuredAt: string | null; reason: string | null } | null;
    drop: { sourceMeasuredAt: string | null; reason: string; droppedAt: string | null } | null;
  };
};

export type QaSerializedNote = {
  id: string;
  targetKind: QaTargetKind;
  targetKey: string | null;
  targetLabel: string | null;
  severity: QaSeverity;
  body: string;
  reviewerName: string;
  createdAt: string | null;
  resolvedAt: string | null;
};

export type QaSerializedReview = {
  status: "ok" | "issue";
  sectionFlags: Partial<Record<QaSectionKey, "ok" | "issue">>;
  reviewerName: string;
  reviewedAt: string | null;
} | null;

/** Answer list row as answers/_components/answer-list.tsx takes it (AnswerListRow). */
export type QaAnswerListRowData = {
  jobId: string;
  promptText: string | null;
  surface: QaSurface;
  brand: string | null;
  country: string | null;
  engine: string;
  lang: string | null;
  measuredAt: string | null;
  mentionCount: number;
  citationCount: number;
  noteCount: number;
  reviewStatus: QaReviewState;
  reviewerName: string | null;
  lock: { reviewerName: string } | null;
};

/** Note list row as notes/_components/note-list.tsx takes it (NoteListRow). */
export type QaNoteListRowData = {
  id: string;
  jobId: string;
  targetKind: QaTargetKind;
  targetLabel: string | null;
  severity: QaSeverity;
  body: string;
  reviewerName: string;
  createdAt: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  promptText: string | null;
  surface: QaSurface;
};

/** Lock as the /api/qa/* routes return it (legacy JSON of a QaLock row: dates as ISO strings). */
export type QaLockJson = {
  jobId: string;
  sessionId: string;
  reviewerName: string;
  acquiredAt: string;
  heartbeatAt: string;
};

/** Note as the /api/qa/note route returns it and the detail screen keeps it. */
export type QaNoteJson = {
  id: string;
  jobId: string;
  targetKind: QaTargetKind;
  targetKey: string | null;
  targetLabel: string | null;
  severity: QaSeverity;
  body: string;
  reviewerName: string;
  createdAt: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
};
