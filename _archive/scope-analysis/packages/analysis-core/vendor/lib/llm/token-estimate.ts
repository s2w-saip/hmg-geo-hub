// CJK-aware 입력 토큰 추정 — 프롬프트 예산을 거는 모든 곳의 단일 정본.
//
// 원래 `lib/utterance/digest/assemble.ts` 안에만 있던 `estimateDigestTokens` 를
// 여기로 올렸다. 두 번째 소비자(답변분석 카탈로그 투영, change
// ontology-catalog-snapshot 4단계)가 생겼는데, 추정식이 두 벌이 되면
// "예산 4k 이하"라는 주장이 어느 자를 쓴 것인지 알 수 없게 된다.
//
// **의도적으로 과대추정한다.** 2026-06-11 디제스트 파일럿 실측에서 한글은
// ≈1.7 tokens/char 였고, 여기서는 2 로 잡는다. 예산 판정에 쓸 때 이 방향이
// 안전하다 — 추정 N 토큰이면 실제는 N 이하이므로, "추정 ≤4k" 는 "실제 ≤4k" 를
// 함의한다. 반대 방향(과소추정)이면 예산 주장이 거짓이 될 수 있다.
//
// 비ASCII·비CJK(키릴·아랍 등)는 4 chars/token 쪽으로 떨어지는데, 실제 BPE 에서는
// 그보다 비싸다. 이 lane 의 카탈로그는 한국어/영문이 사실상 전부라 현재는 문제가
// 아니지만, 다른 스크립트 코퍼스에 이 함수를 쓰려면 그 축을 먼저 보정해야 한다.
export function estimateInputTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (
      (code >= 0xac00 && code <= 0xd7af) || // Hangul syllables
      (code >= 0x1100 && code <= 0x11ff) || // Hangul jamo
      (code >= 0x3130 && code <= 0x318f) || // Hangul compat jamo
      (code >= 0x4e00 && code <= 0x9fff) || // CJK unified
      (code >= 0x3040 && code <= 0x30ff) // kana
    ) {
      cjk += 1;
    }
  }
  const other = text.length - cjk;
  return cjk * 2 + Math.ceil(other / 4);
}
