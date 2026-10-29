// Types for the faithful port of aeorank's "Purchase Context Map" node view
// (app/sandbox/social-scraping/page.tsx). This is the *enriched* matrix shape
// the canvas graph + sidebar + detail panels consume. Mirrored verbatim from
// the source so the ported UI renders identically — data is the hardcoded
// fixture in `sample-matrix.ts` for now.

export interface EvidenceQuote {
  quote: string;
  source_title: string;
  source_url: string;
  perspective?: string;
}

export interface PerspectiveBreakdown {
  buyer: number;
  seller: number;
  neutral: number;
}

export interface EnrichedContext {
  name: string;
  mention_count: number;
  total_workers: number;
  mention_rate: number;
  evidence_quotes: EvidenceQuote[];
  unique_source_count: number;
  source_urls: string[];
  source_domains: Record<string, number>;
  perspective_breakdown: PerspectiveBreakdown;
  driven_conditions: Array<{ name: string; strength: number }>;
}

export interface EnrichedCondition {
  name: string;
  mention_count: number;
  total_workers: number;
  mention_rate: number;
  evidence_quotes: EvidenceQuote[];
  branch_labels: string[];
  related_conditions: string[];
  unique_source_count: number;
  source_urls: string[];
  source_domains: Record<string, number>;
  perspective_breakdown: PerspectiveBreakdown;
  driven_by_contexts: Array<{ name: string; strength: number }>;
  deep_evidence?: {
    claim: string;
    supporting: number;
    contradicting: number;
    neutral: number;
    total_scanned: number;
    confidence: string;
    sample_quotes: Array<{ quote: string; source: string; stance: string }>;
  };
}

// Alias kept for parity with the source (graph rendering refers to attributes).
export type EnrichedAttribute = EnrichedCondition;

export interface EnrichedCombination {
  attributes: string[];
  frequency: "high" | "medium" | "low";
  description: string;
  evidence_quotes: EvidenceQuote[];
  co_occurrence_count: number;
  total_speakers: number;
  co_occurrence_rate: number;
  unique_source_count: number;
  source_urls: string[];
  frequency_justification: string;
}

export interface EnrichedContextTheme {
  theme_name: string;
  description: string;
  contexts: EnrichedContext[];
}

export interface EnrichedConditionCategory {
  category_name: string;
  description: string;
  conditions: EnrichedCondition[];
}

export interface EnrichedContextMatrix {
  context_themes: EnrichedContextTheme[];
  condition_categories: EnrichedConditionCategory[];
  combinations: EnrichedCombination[];
  total_context_themes: number;
  total_contexts_found: number;
  total_condition_categories: number;
  total_conditions_found: number;
  enrichment_stats: {
    total_workers: number;
    total_speakers: number;
    total_sources: number;
    perspective_breakdown: PerspectiveBreakdown;
    total_relationships: number;
    deep_evidence_linked: number;
  };
}

// ─── Force-graph node/link shapes ─────────────────────────────────────────
// The `_`-prefixed fields are the per-node metadata the canvas renderer +
// click/hover handlers read off each node (kept identical to the source).
export interface GraphNode {
  id: string;
  label: string;
  type: "keyword" | "branch" | "finding" | "source" | "evidence";
  color: string;
  size: number;
  x?: number;
  y?: number;
  fx?: number;
  fy?: number;
  _ctxType?: "context_theme" | "category" | "context" | "attribute";
  _description?: string;
  _attrCount?: number;
  _mentionCount?: number;
  _totalWorkers?: number;
  _mentionRate?: number;
  _categoryName?: string;
  _categoryIndex?: number;
  _enrichedCtx?: EnrichedContext;
  _enrichedAttr?: EnrichedCondition;
  _hasDeepEvidence?: boolean;
  _perspectiveBreakdown?: PerspectiveBreakdown;
}

export interface GraphLink {
  source: string | GraphNode;
  target: string | GraphNode;
  color: string;
  _ctxType?: "driven_by" | "combination";
  _frequency?: "high" | "medium" | "low";
  _width?: number;
  _description?: string;
  _enrichedCombo?: EnrichedCombination;
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}
