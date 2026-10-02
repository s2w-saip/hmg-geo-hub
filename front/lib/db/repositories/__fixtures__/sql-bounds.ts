/**
 * 컴파일된 SQL 에서 **하한 술어를 전수 추출**하는 헬퍼 — 테스트 전용.
 *
 * 검증자가 B1 을 반증할 때 쓴 방법과 같다: 하한이 여러 곳에서 오고 AND 로 결합되면
 * **좁은 쪽이 이기므로**, 한 곳만 보면 실효 창을 못 본다.
 *
 * ⚠️ 괄호로 끊으면 안 된다 — `hmg_anchor_today()` 의 닫는 괄호에서 잘려 상수 바닥이
 *    `hmg_anchor_today(` 로 보이고, 일수를 못 읽어 **빈 배열이 조용히 통과**한다.
 *    `AND` 또는 문장 끝까지 잡는다.
 */
export function roundDateLowerBounds(text: string): string[] {
  const flat = text.replace(/\s+/g, " ");
  return [...flat.matchAll(/\bca\d*\.round_date >= (.+?)(?= AND |$)/g)].map((m) => m[1].trim());
}

/** `measured_at` 하한 전수 — `round_date` 쪽과 같은 자세. */
export function measuredAtLowerBounds(text: string): string[] {
  const flat = text.replace(/\s+/g, " ");
  return [...flat.matchAll(/\ba\.measured_at >= (.+?)(?= AND |$)/g)].map((m) => m[1].trim());
}

/** 상수 바닥(`hmg_anchor_today() - N`)의 N 만. 기간 술어·바인드면 제외된다. */
export function floorDaysOf(bounds: readonly string[]): number[] {
  return bounds
    .map((b) => /hmg_anchor_today\(\)\s*-\s*(\d+)/.exec(b)?.[1])
    .filter((d): d is string => d !== undefined)
    .map(Number);
}
