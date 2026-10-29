import type { MeasurementMention } from "./schema";

/**
 * 언급 오프셋의 **저장 기준**을 코드포인트로 맞춘다.
 *
 * ⚠️ 변환 지점은 **딱 하나** — 영속 직전 choke point 인 `store.ts` 의
 * `analysisForPersist.mentions`(`finalizeMentionOffsets`)다. 파이프라인 상류
 * (`analyzeMeasurementTurn`·`augmentTrackedBrandMentions`)에서 미리 바꾸면
 * 결정적 멘션은 코드포인트, LLM 멘션(`resolveLlmMentionSpan` 이 원문 `.indexOf`
 * 로 새로 계산)은 UTF-16 이 되어 **기준이 갈라진다** — `mentionsReferToSameSurface`
 * 의 span 겹침 판정이 어긋나 같은 표기가 멘션 둘로 쪼개진다(scope#632 최종 리뷰
 * 실증: `🚗🚗 ` 접두사만 붙이면 1건이 2건으로). 상류에서는 UTF-16 을 유지한다.
 *
 * 왜 필요한가 — 매칭기가 만드는 오프셋은 JS 문자열 인덱스, 즉 **UTF-16 code
 * unit** 이다(`buildNormalizedIndex` 의 `startMap`/`endMap` 이 `i` 를 그대로
 * 담는다). 반면 이 값을 읽는 쪽은 대부분 **코드포인트**를 센다 — Postgres
 * `substr`, 파이썬 슬라이싱, 대부분의 렌더러. 이모지처럼 서로게이트 쌍으로
 * 표현되는 문자(U+10000 이상)는 JS 에서 2, 코드포인트로는 1이라, 그런 문자가
 * 앞에 하나 나올 때마다 오프셋이 1씩 밀린다.
 *
 * 프로덕션 실측(2026-09-07, `measurement_entity_mentions` × `turn_runs`):
 *   · astral(>U+FFFF) 문자가 **없는** 답변 — `substr(answer_text, start+1, len)
 *     = surface_text` 일치율 **100.0%** (9,151건)
 *   · **있는** 답변 — 73.6% (2,104건)
 *   · 불일치 556건 중 555건이 오프셋 앞 구간에 astral 을 갖고, 그 개수만큼
 *     당기면 **555/556(99.8%)** 이 정확히 일치 — 기전이 이것 하나임을 보인다.
 *
 * 전체 경위·과거분 처리·소비자 계약은 scope#632.
 *
 * ⚠️ `end` 도 반드시 함께 변환한다. `end - start` 를 그대로 옮기면 **구간 안에**
 * 이모지가 있을 때 길이가 틀린다(하이라이트가 잘린다).
 */

/** 새로 쓰는 행에 남기는 표식. 이게 없는 과거 행은 소비자가 보정해야 한다. */
export const OFFSET_BASIS = "codepoint" as const;
export const OFFSET_BASIS_KEY = "offset_basis" as const;

/**
 * UTF-16 인덱스 → 코드포인트 인덱스 변환표.
 *
 * `map[i]` = 텍스트 앞 `[0, i)` 구간의 **코드포인트 개수**. 서로게이트 쌍의
 * 뒤쪽 절반을 가리키는 인덱스는 그 쌍의 시작과 같은 값으로 접힌다(경계 밖을
 * 가리키는 오프셋이 들어와도 값이 튀지 않는다).
 *
 * 길이는 `text.length + 1` 이라 `map[text.length]` = 전체 코드포인트 수다.
 */
export function buildCodePointIndexMap(text: string): number[] {
  const map = new Array<number>(text.length + 1);
  let cp = 0;
  let i = 0;
  while (i < text.length) {
    const code = text.codePointAt(i)!;
    const width = code > 0xffff ? 2 : 1;
    map[i] = cp;
    // 서로게이트 쌍의 뒤쪽 절반도 쌍의 시작과 같은 코드포인트 인덱스로 본다.
    if (width === 2) map[i + 1] = cp;
    i += width;
    cp++;
  }
  map[text.length] = cp;
  return map;
}

/** 하나의 UTF-16 오프셋을 코드포인트 오프셋으로. 범위 밖은 양 끝으로 클램프한다. */
export function toCodePointOffset(map: number[], utf16Index: number): number {
  if (!Number.isFinite(utf16Index)) return 0;
  if (utf16Index <= 0) return 0;
  if (utf16Index >= map.length) return map[map.length - 1]!;
  return map[utf16Index]!;
}

/**
 * 멘션 배열의 오프셋을 코드포인트 기준으로 바꾸고 표식을 남긴다.
 *
 * `extraction_metadata.source_start`/`source_end` 는 같은 값의 사본이므로 함께
 * 바꾼다 — 한쪽만 바꾸면 두 값이 갈라져 어느 쪽이 정본인지 알 수 없게 된다.
 *
 * 순서 보존: 변환은 단조증가라 `normalizeMentionOrder` 가 오프셋으로 매기는
 * 순번이 바뀌지 않는다.
 *
 * 멱등: 이미 표식이 있는 멘션은 건드리지 않는다(두 번 변환하면 값이 줄어든다).
 */
export function toCodePointMentionOffsets<T extends MeasurementMention>(
  answerText: string,
  mentions: T[],
): T[] {
  if (mentions.length === 0) return mentions;
  const map = buildCodePointIndexMap(answerText);
  return mentions.map((m) => {
    if (m.extractionMetadata?.[OFFSET_BASIS_KEY] === OFFSET_BASIS) return m;
    const start = m.sourceStart == null ? undefined : toCodePointOffset(map, m.sourceStart);
    const end = m.sourceEnd == null ? undefined : toCodePointOffset(map, m.sourceEnd);
    const meta: Record<string, unknown> = {
      ...m.extractionMetadata,
      [OFFSET_BASIS_KEY]: OFFSET_BASIS,
    };
    // 메타의 사본도 같은 값으로 — 원래 키가 있던 경우에만 덮는다.
    if ("source_start" in meta && start !== undefined) meta.source_start = start;
    if ("source_end" in meta && end !== undefined) meta.source_end = end;
    return { ...m, sourceStart: start, sourceEnd: end, extractionMetadata: meta };
  });
}

/**
 * **유일한** 변환 지점 — 영속 직전 choke point 전용 래퍼.
 *
 * 파이프라인 전체(결정적 매칭·tracked-brand 보강·LLM verbatim-extraction)가
 * UTF-16 오프셋 하나로 굴러가다가, DB 로 나가기 직전인 `store.ts` 의
 * `analysisForPersist.mentions` 에서 여기 한 번만 들른다. 값이 만들어지는 곳
 * 여러 군데를 각각 덮으면 기준이 갈라진다(파일 헤더 ⚠️ 참고) — 그래서 "값이
 * 만들어지는 곳"이 아니라 "영속되기 직전" 한 곳이다.
 *
 * 멱등(`offset_basis` 마커)이라 같은 배열을 두 번 태워도 안전하다.
 */
export function finalizeMentionOffsets<T extends MeasurementMention>(
  answerText: string,
  mentions: T[],
): T[] {
  return toCodePointMentionOffsets(answerText, mentions);
}

/**
 * 저장된 오프셋을 **코드포인트 기준 [start, end)** 로 정규화한다 — 소비자(API 조립·
 * 하이라이트)가 과거 행과 새 행을 같은 방식으로 다루게 하는 단일 관문.
 *
 * · `basis === "codepoint"` (Task 1 이후 저장된 행): 그대로.
 * · 그 외(표식 없는 과거 행): UTF-16 인덱스로 보고 변환한다. 프로덕션 실측(2026-09-07)
 *   에서 이 보정으로 불일치 556건 중 555건이 정확히 맞았다(99.8%).
 *
 * 텍스트 길이를 넘거나 빈 구간이면 `null` — 그 발생은 **칠하지 않는다.** 엉뚱한 자리를
 * 조용히 칠하는 것보다 안 칠하는 편이 검수 화면에서 덜 해롭다.
 */
export function normalizeStoredOffsets(
  answerText: string,
  start: number | null | undefined,
  end: number | null | undefined,
  basis: unknown,
): { start: number; end: number } | null {
  return makeOffsetNormalizer(answerText)(start, end, basis);
}

/**
 * 같은 답변 텍스트에 대해 **변환표를 한 번만 만드는** 정규화기.
 *
 * `normalizeStoredOffsets` 는 호출마다 `Array(n+1)` 맵과 `Array.from(text)` 를
 * 새로 만든다. 한 턴의 멘션 행이 여러 개인 `include=occurrences` 조립부에서
 * 행마다 부르면 같은 텍스트를 반복해서 훑는다(200 런 × 멘션 × 10KB 규모에서
 * 수천만 할당). 턴 키로 이 정규화기를 캐시해 재사용한다.
 *
 * 결과는 `normalizeStoredOffsets` 와 동일하다 — 그쪽이 이 함수의 얇은 래퍼다.
 */
export function makeOffsetNormalizer(
  answerText: string,
): (
  start: number | null | undefined,
  end: number | null | undefined,
  basis: unknown,
) => { start: number; end: number } | null {
  let map: number[] | null = null;
  let cpLength: number | null = null;
  return (start, end, basis) => {
    if (start == null || end == null) return null;
    let s = start;
    let e = end;
    if (basis !== OFFSET_BASIS) {
      map ??= buildCodePointIndexMap(answerText);
      s = toCodePointOffset(map, start);
      e = toCodePointOffset(map, end);
    }
    cpLength ??= Array.from(answerText).length;
    if (s < 0 || e > cpLength || e <= s) return null;
    return { start: s, end: e };
  };
}
