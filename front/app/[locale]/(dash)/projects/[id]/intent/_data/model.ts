// Shared view types and explicit empty states. All values are supplied by Gold.
export type KeywordTrendPoint = {
    week: string;
    primary: number;
    compare: number;
};
export type SerpPromptRow = {
    id: string;
    rank: number;
    url: string;
    title: string;
    snippet: string;
    suggestedPrompt: string;
    applied: boolean;
};
export type Keyword = {
    id: string;
    label: string;
    avgInterest: number;
    trend: KeywordTrendPoint[];
    serp: SerpPromptRow[];
};
export const EMPTY_KEYWORDS: Keyword[] = [];
export const DEFAULT_KEYWORD_TERMS: string[] = [];
export type SocialMetric = {
    key: string;
    label: string;
    value: number;
};
export const EMPTY_SOCIAL_METRICS: SocialMetric[] = [];
export type SocialContextRow = {
    id: string;
    topic: string;
    context: string;
    mentions: number;
    sentiment: number;
    intent: "buyer" | "seller" | "neutral";
};
export const EMPTY_SOCIAL_CONTEXTS: SocialContextRow[] = [];
export type PurchaseCondition = {
    id: string;
    label: string;
    share: number;
};
export const EMPTY_PURCHASE_CONDITIONS: PurchaseCondition[] = [];
export type CombinationPattern = {
    id: string;
    pair: [
        string,
        string
    ];
    cooccurrence: number;
};
export const EMPTY_COMBINATION_PATTERNS: CombinationPattern[] = [];
export type SearchIntent = "transactional" | "informational" | "navigational" | "commercial";
export type RelatedKeyword = {
    id: string;
    term: string;
    languages: number;
    volume: number;
    intent: SearchIntent;
    children?: RelatedKeyword[];
};
export const RELATED_FOUND_COUNT = 0;
export const EMPTY_RELATED_KEYWORDS: RelatedKeyword[] = [];
export function createKeywordFromTerm(_term: string): Keyword {
    throw new Error("Synthetic keyword generation was removed; read stored Gold keywords");
}
