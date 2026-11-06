// Type-only snapshot; no database or server implementation is included.
import type { FirstPositionRow } from "@/lib/db/repositories/scope-aggregates";
/**
 * 순위표 모집단 = **언급 수 상위 N 브랜드(자사 포함)**. 우선 노출도 탭 순위표·래더·추이
 * 시리즈의 상한이고(미러 `KPI_TAB_DEFAULT_TOP_BRANDS`, 집계층 `fetchStandardKpiFirstPosition`
 * 의 `cap`), 경쟁사 미니값 4개(Overview 카드·탭 히어로)의 후보 모집단이다
 * (`lib/scope/competitor-row.ts::competitorCandidates` position 분기, 2026-09-29).
 * 세 곳이 이 값 하나를 읽는다. 타일이 순위표 밖 브랜드를 고르지 않게.
 */
export declare const RANK_TABLE_TOP_BRANDS = 10;
export declare function rankFirstPositionRows(rows: ReadonlyArray<Omit<FirstPositionRow, "rank"> & {
    rank?: number | null;
}>): FirstPositionRow[];
