// Type-only snapshot; no database or server implementation is included.
export type Sentiment = "positive" | "negative" | "mixed" | "neutral";
export interface OccurrenceInput {
    entityId: string;
    brandRollupEntityId: string | null;
    brandName: string | null;
    sourceStart: number;
    sourceEnd: number;
    surfaceText: string;
    sentiment: Sentiment;
    assertion: string | null;
    contextSnippet: string | null;
    descriptors: string[];
    criteria: string[];
    turnIndex: number | null;
}
export interface SentimentEvidence {
    brandName: string | null;
    sentiment: Sentiment;
    assertion: string | null;
    descriptors: string[];
    criteria: string[];
    contextSnippet: string | null;
}
export interface SentimentSpan {
    start: number;
    end: number;
    sentiment: Sentiment;
    evidence: SentimentEvidence[];
}
export declare function sentenceBounds(cp: string[], start: number, end: number): {
    start: number;
    end: number;
};
export declare function buildSentimentSpans(answerText: string, occurrences: OccurrenceInput[], trackedEntityIds: Set<string>): {
    spans: SentimentSpan[];
    skipped: number;
};
