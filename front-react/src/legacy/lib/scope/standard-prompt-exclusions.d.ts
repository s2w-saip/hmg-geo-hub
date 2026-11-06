// Type-only snapshot; no database or server implementation is included.
export declare const EXCLUDED_STANDARD_PROMPT_IDS: readonly string[];
export declare const EXCLUDED_STANDARD_PROMPT_TEXTS: readonly string[];
export declare function isExcludedStandardPrompt(row: {
    id: string;
    text: string;
}): boolean;
