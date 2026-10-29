import { createHash } from "node:crypto";

const COMPACT_DROP_RE = /[\s\u200b\u200c\u200d\-_/()[\]{}.,:;'"`|·•]+/gu;

export function normalizeSurface(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replace(/\s+/g, " ")
    .trim();
}

export function compactSurface(value: string): string {
  return normalizeSurface(value).replace(COMPACT_DROP_RE, "");
}

export function surfaceHash(value: string): string {
  return createHash("sha256").update(normalizeSurface(value)).digest("hex");
}

export function turnHash(parts: {
  promptText?: string | null;
  answerText?: string | null;
  rawResponse?: string | null;
}): string {
  return createHash("sha256")
    .update(parts.promptText ?? "")
    .update("\n---answer---\n")
    .update(parts.answerText ?? "")
    .update("\n---raw---\n")
    .update(parts.rawResponse ?? "")
    .digest("hex");
}

export function inferSurfaceLanguage(value: string): string {
  if (/[가-힣]/u.test(value)) return "ko";
  if (/[ぁ-んァ-ン]/u.test(value)) return "ja";
  if (/[\p{Script=Han}]/u.test(value)) return "zh";
  if (/[A-Za-z]/.test(value)) return "en";
  return "und";
}

/**
 * 임의 오프셋으로 자를 때 **서로게이트 쌍을 반토막 내지 않는** slice.
 *
 * JS 문자열은 UTF-16 이라 이모지 같은 astral 문자가 코드유닛 2칸을 차지한다.
 * `text.slice(i, j)` 의 i·j 가 그 쌍 한가운데 떨어지면 결과 문자열에 **짝 없는
 * 서로게이트**가 남는다. 이것은 `JSON.stringify` 를 거쳐 `\ud83d` 이스케이프가
 * 되고, PostgreSQL 의 jsonb 파서가 거부한다 (22P02, "Unicode low surrogate must
 * follow a high surrogate"). 같은 문자열이 text 컬럼으로 갈 때는 드라이버가
 * U+FFFD 로 **조용히 치환**해서 티가 안 난다 — 그래서 이 결함은 jsonb 를 쓰는
 * 후보(measurement_entity_candidates) 삽입에서만 터졌다.
 *
 * 경계를 코드포인트 단위로 스냅해서, 잘린 조각이 항상 well-formed 이게 한다.
 * 안쪽으로만(범위가 넓어지지 않게) 조정한다.
 */
export function sliceAtCodePointBoundary(
  text: string,
  start: number,
  end: number,
): string {
  let s = Math.max(0, Math.min(start, text.length));
  let e = Math.max(s, Math.min(end, text.length));
  // 시작이 low surrogate 위 = 앞 문자의 쌍을 쪼갠 것 → 한 칸 뒤로.
  if (isLowSurrogate(text.charCodeAt(s))) s += 1;
  // 끝 직전이 high surrogate = 뒤 문자의 쌍을 쪼갠 것 → 한 칸 앞으로.
  if (e > s && isHighSurrogate(text.charCodeAt(e - 1))) e -= 1;
  return text.slice(s, e);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

export function contextSnippet(
  text: string,
  start: number,
  end: number,
  radius = 90,
): string {
  return sliceAtCodePointBoundary(text, start - radius, end + radius)
    .replace(/\s+/g, " ")
    .trim();
}

export function isAlphaNum(char: string | undefined): boolean {
  return !!char && /[A-Za-z0-9]/.test(char);
}
