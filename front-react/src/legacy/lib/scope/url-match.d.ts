// Type-only snapshot; no database or server implementation is included.
export declare function normalizeUrlForMatch(raw: string | null | undefined): string;
/** 추적 정규화가 끝난 두 값(C, T)의 타겟 일치. 어느 쪽이든 비면 항상 false. */
export declare function matchesTargetUrlNorm(citedNorm: string, targetNorm: string): boolean;
/** 원본 URL 두 개를 받아 정규화 후 타겟 일치를 본다(verify 스크립트·테스트용). */
export declare function matchesTargetUrl(citedRaw: string, targetRaw: string): boolean;
export declare function domainHost(raw: string | null | undefined): string;
