// Route JSON of the mention drilldowns (/api/scope/brand-mention-prompts, /signal-prompts,
// /brand-citations, /answer), built by the screens mention/drill-* (back/bff/screens/
// mention_drilldown.py). Each body is the former route JSON plus fields the browser used to compute
// (all optional here: a component also renders a list handed to it without them).
import type { TableOrders } from "@/hooks/use-ordered-table";
import type { CitationDomainLive, MentionAnswerLive, MentionsPromptLive } from "@/lib/scope/result-adapter";

/** What a screen answers to a drilldown route: the route status and its JSON body. */
export interface DrillScreenReply<T = unknown> {
  status: number;
  body: T;
}

/**
 * One highlighter surface of an answer (markdown-answer.tsx): lowercased, longest first; a model
 * surface unless a brand surface is the same text. `forms` (surfaces of 3 UTF-16 units or less) =
 * the original-case spellings, the only hits that paint.
 */
export interface HighlightTerm {
  term: string;
  kind: "brand" | "model";
  forms?: string[];
}

/** An answer reference of a drilldown row, with its highlighter terms. */
export type DrillAnswer = MentionAnswerLive & { highlightTerms?: HighlightTerm[] };

/** A prompt row of the brand prompts tab: bestRank = smallest positive answer position, topRank = bestRank <= 3. */
export type DrillPromptRow = MentionsPromptLive & {
  answers: DrillAnswer[];
  bestRank?: number | null;
  topRank?: boolean;
};

export type PromptSortKey = "prompt" | "rank" | "mentions" | "share" | "funnel" | "providers";
export type DomainSortKey = "domain" | "citations" | "share" | "prompts" | "coverageRate";

/** /api/scope/brand-mention-prompts 200 body. */
export interface BrandPromptsReply {
  prompts: DrillPromptRow[];
  total?: number;
  orders?: TableOrders<PromptSortKey>;
}

/** /api/scope/brand-citations 200 body (list). `orders` = citation-domain-table.tsx column orders. */
export interface BrandDomainsReply {
  domains: CitationDomainLive[];
  total?: number;
  orders?: TableOrders<DomainSortKey>;
}
