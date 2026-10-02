/**
 * 프롬프트 시장·언어 축의 **순수 규칙** (H5).
 *
 * 서버 액션·벌크 임포트·UI 프리뷰가 전부 이 파일을 지난다. 규칙을 세 곳에
 * 복제하면 하나만 어긋나는 결함이 생기고, 이 리포는 그 형태로 이미 값을 치렀다
 * (docs/development-guide.md "수치를 두 곳에 적지 말 것").
 *
 * ── 두 축을 혼동하지 말 것 ──────────────────────────────────────────────
 *  · `prompts.regions`  = 이 프롬프트가 **겨냥하는 시장** (편집 대상)
 *  · `scope_answers.region` = 실제로 **측정된 지역** (관측값, 편집 불가)
 * 같은 ISO 코드를 쓰지만 다른 축이다.
 *
 * ── NULL 의 의미 ────────────────────────────────────────────────────────
 * NULL·빈 배열 = **미지정 = 상속**(프로젝트/스케줄 범위 전체). "아무 시장도 아님"이
 * 아니다. 그래서 빈 셀은 "지우기"가 아니라 "건드리지 않음/전체"로 읽어야 하고,
 * 정규화 결과가 빈 배열이면 `null` 로 접는다.
 */

/** ISO 3166-1 alpha-2 (실국가) 또는 `x:` 접두 의사코드. */
const REGION_CODE = /^(?:[A-Z]{2}|x:[A-Z0-9]{2,8})$/;

export interface RegionNormalizeResult {
  /** 저장할 값. `null` = 미지정(상속). */
  value: string[] | null;
  /** 형식이 코드가 아닌 입력. */
  invalid: string[];
  /** 형식은 맞지만 어휘(=루트 프로젝트 시장) 밖인 입력. */
  outOfVocabulary: string[];
}

/**
 * 입력 시장 목록을 정규화한다 — 트림·대문자화·중복 제거·정렬, 그리고 두 종류의
 * 거절 사유를 **구분해서** 돌려준다.
 *
 * 형식 오류와 어휘 밖을 뭉뚱그리면 사용자가 오타인지 권한 밖인지 알 수 없다.
 * 벌크 임포트에서는 이 구분이 곧 "행을 고치면 되는가 / 프로젝트 설정을 바꿔야
 * 하는가"의 차이가 된다.
 *
 * 정렬하는 이유: 감사 로그의 `changes` 가 `String(v)` 직렬화라, 순서만 다른 같은
 * 집합이 **다른 변경으로 기록되는 것**을 막는다.
 */
export function normalizePromptRegions(
  input: readonly string[] | null | undefined,
  vocabulary: readonly string[] | null | undefined,
): RegionNormalizeResult {
  if (input == null) return { value: null, invalid: [], outOfVocabulary: [] };
  const allowed = vocabulary && vocabulary.length > 0 ? new Set(vocabulary) : null;
  const invalid: string[] = [];
  const outOfVocabulary: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const code = String(raw ?? "").trim().toUpperCase().replace(/^X:/, "x:");
    if (!code) continue;
    if (!REGION_CODE.test(code)) {
      if (!invalid.includes(code)) invalid.push(code);
      continue;
    }
    // 어휘가 주어지지 않으면(루트 프로젝트가 시장을 안 정한 상태) 상한이 없다 —
    // 그때는 형식만 본다. 없는 상한을 있는 것처럼 굴면 정상 입력을 막는다.
    if (allowed && !allowed.has(code)) {
      if (!outOfVocabulary.includes(code)) outOfVocabulary.push(code);
      continue;
    }
    if (seen.has(code)) continue;
    seen.add(code);
  }
  const value = [...seen].sort();
  return { value: value.length === 0 ? null : value, invalid, outOfVocabulary };
}

/** ISO 639-1 을 대문자로 쓰는 시트 코드(EN·KO·ES·AR·…). */
const LANG_CODE = /^[A-Z]{2}$/;

/** 언어 코드 정규화. 빈 값 = `null`(미지정). 형식이 아니면 `invalid`. */
export function normalizePromptLang(
  input: string | null | undefined,
): { value: string | null; invalid: string | null } {
  if (input == null) return { value: null, invalid: null };
  const code = String(input).trim().toUpperCase();
  if (!code) return { value: null, invalid: null };
  if (!LANG_CODE.test(code)) return { value: null, invalid: code };
  return { value: code, invalid: null };
}

/**
 * 감사 로그용 직렬화 — `computeChanges` 가 `String(v)` 를 쓰므로 배열을 그대로
 * 넘기면 순서 차이가 가짜 변경이 된다. 정렬 CSV 로 고정한다.
 * `null`(상속)은 빈 문자열이 아니라 `null` 로 남겨 "전체"와 "빈 값"을 구분한다.
 */
export function regionsForAudit(regions: readonly string[] | null | undefined): string | null {
  if (regions == null || regions.length === 0) return null;
  return [...regions].sort().join(",");
}

/**
 * 두 시장 집합이 같은가 — 순서·중복·대소문자 무시. 변경 없음을 조기 반환해
 * 빈 감사 로그가 쌓이는 것을 막는다.
 */
export function sameRegions(
  a: readonly string[] | null | undefined,
  b: readonly string[] | null | undefined,
): boolean {
  return regionsForAudit(a) === regionsForAudit(b);
}
