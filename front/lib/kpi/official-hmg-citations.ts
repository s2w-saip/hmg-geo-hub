import {
  resolveCitationCategory,
  type CitationOverrideMap,
} from "@/lib/citation-categorizer";
import { OFFICIAL_HMG_CATEGORY } from "@/lib/citation-categorizer/taxonomy";

// ════════════════════════════════════════════════════════════════════════════
// 글로벌 ⑤ "AI 인용 점유율" 의 분자 = 출처 카테고리 `Official (HMG)` 인용 수
// (제품 책임자 2026-09-29 결정)
// ════════════════════════════════════════════════════════════════════════════
//
// 표준(글로벌) 표면의 세 값이 한 산식이 된다:
//   ① Overview ⑤ 카드(값·Δ·추이선)
//   ② 답변 분석 > 인용 "인용 현황" 의 공식(HMG) 인용 비중
//   ③ 같은 탭 "출처 카테고리별 현황" 의 Official (HMG) 비중
//
//   공식(HMG) 인용 비중 = (카테고리가 Official (HMG) 인 인용 수) ÷ (그 모집단 전체 인용 수) × 100
//
// 분류는 **출처 카테고리 차트와 같은 함수·같은 오버라이드 맵**이다
// (`resolveCitationCategory`, `lib/citation-categorizer`). 여기서 두 번째 분류 어휘를
// 만들지 않는다 — SQL 경로는 이 모듈이 고른 group_key 목록을 `= ANY($keys)` 로 받기만 한다.
//
// ── 표면 분기 ────────────────────────────────────────────────────────────────
//
// 종전 분자(KPI ⑤ base URL prefix 행 단위 매칭, `citationOwnedClause`)는 website·project
// 표면에서 **그대로다**. 그래서 집계 타입에 필드를 **덧붙이고**(`officialHmgCitations`)
// 글로벌 리더만 채운다. 소비자는 `overview-card-values.ts::citationShareNumerator` 하나로
// 읽는다 — 필드가 있으면 새 정의, 없으면 종전 정의. website·project 리더는 이 필드를 만들지 않는다.
//
// ⚠️ 이 모듈은 분류기(`lib/citation-categorizer` → public-suffix 스냅샷 147KB)를 끌고 온다.
//    클라이언트 번들이 닿는 모듈(`overview-card-values.ts` 등)에서 import 하지 말 것 —
//    분자 선택 함수는 그래서 저쪽에 따로 있다.

export { OFFICIAL_HMG_CATEGORY };

/** 그룹 키 하나가 공식(HMG)인가 — 카테고리 차트와 같은 판정(`rowCategory` 없음 = 사실표 경로). */
export function isOfficialHmgGroupKey(
  key: string | null | undefined,
  overrides: CitationOverrideMap | null | undefined,
  rowCategory: string | null = null,
): boolean {
  if (!key) return false;
  return resolveCitationCategory(rowCategory, key, overrides) === OFFICIAL_HMG_CATEGORY;
}

/**
 * 후보 그룹 키 → 공식(HMG) 키 목록(중복 제거·정렬). SQL `= ANY($keys)` 의 입력이다.
 * 정렬은 캐시 셀 내용과 바인드 값이 입력 순서에 흔들리지 않게 하려는 것이다.
 */
export function officialHmgGroupKeys(
  candidates: Iterable<string | null | undefined>,
  overrides: CitationOverrideMap | null | undefined,
): string[] {
  const out = new Set<string>();
  for (const k of candidates) {
    if (k && isOfficialHmgGroupKey(k, overrides)) out.add(k);
  }
  return [...out].sort();
}

/** group_key 단위 행 → 공식(HMG) 인용 수. 사실표 S1 read 의 `group` 축에 쓴다. */
export function officialHmgCitationsOf(
  rows: Iterable<{ key: string | null; citations: number }>,
  overrides: CitationOverrideMap | null | undefined,
): number {
  let n = 0;
  for (const r of rows) if (isOfficialHmgGroupKey(r.key, overrides)) n += r.citations;
  return n;
}
