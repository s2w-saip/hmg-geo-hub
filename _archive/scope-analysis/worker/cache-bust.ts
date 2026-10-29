// LLM 프롬프트 캐시 **무효화**(cache bust) — 게이트③ 을 무캐시 상태에서 재기 위한 장치.
// 운영 결정 2026-09-13: 게이트③ 은 "시간 창" 이 아니라 **제공자 프롬프트 캐시를 끈 상태**에서 잰다.
//
// ── 왜 필요한가 (실측)
//
//   같은 번들을 몇 분 간격으로 두 번 재실행하니 luna 콜 실비가 **−55%**(OpenAI 프롬프트 캐시
//   히트)였고 결과 일치가 **0.978** 로 뛰었다. 캐시가 식은 뒤(수 시간 뒤) 재면 **0.857** 이다.
//   lane shadow 는 인라인 몇 분 뒤에 돌아 그 이득을 그대로 받아 **0.987** 을 냈다 — 품질 증거가
//   아니라 **캐시 증거**다. 컷오버 후 lane 은 혼자 도므로 그 이득이 없다. 그래서 게이트 구간에는
//   lane 의 LLM 콜이 캐시에 **맞지 않게** 만들어야 한다.
//
// ── 수단 두 가지와 **왜 nonce 가 기본값인가** (문서 인용, 2026-09-13 확인)
//
//   ① 공급자 명시 opt-out (`params`)
//      · OpenAI: **끄는 파라미터가 없다.** "Prompt caching is enabled by default for supported
//        OpenAI models." 가장 가까운 것이 `prompt_cache_options.mode`:
//        "Set `prompt_cache_options.mode` to `explicit` to use only developer-selected
//        breakpoints" — breakpoint 를 하나도 안 주면 암묵 캐시가 안 걸린다. **GPT-5.6+ 전용**이다.
//      · `prompt_cache_key` 는 opt-out 이 **아니다**: "Keys influence routing; they do not pin
//        requests to a machine or guarantee a cache hit." 즉 무작위 키는 히트 확률을 낮출 뿐
//        **미스를 보장하지 않는다**. (OpenRouter 는 이 값을 "the sticky routing key" 로 쓴다 —
//        무작위면 끈적임이 사라지므로 보조 수단으로는 유효하다.)
//      · Gemini: **대응 파라미터가 아예 없다.** "Implicit caching is enabled by default for all
//        Gemini 2.5 and newer models." 이고 요청 단위 비활성 방법이 문서에 없다.
//      · OpenRouter 통과 여부: 문서가 열거한 파라미터 목록에 이 둘은 **없고**, 통과 보장은
//        "OpenRouter will also transmit some provider-specific parameters, such as `safe_prompt`
//        for Mistral or `raw_mode` for Hyperbolic" 라는 **화이트리스트** 문장뿐이다.
//        `prompt_cache_key` 만 별도로 "the sticky routing key" 로 해석한다고 적혀 있다.
//
//   ② 접두 nonce (`nonce`) ← **기본값**
//      캐시는 **접두 정확 일치**로만 걸린다. OpenAI: "Cache reuse requires the entire rendered
//      prefix to match." Gemini: "Try putting large and common contents at the beginning of your
//      prompt". 그러므로 **맨 앞 한 줄**을 요청마다 다르게 만들면 두 공급자 모두에서 접두가
//      깨져 **히트가 구조적으로 불가능**해진다. 공급자·게이트웨이 무관하게 성립하고 400 위험도
//      없다(본문은 그냥 프롬프트 텍스트다).
//
//   그래서 기본은 `nonce` 다. ①은 (a) Gemini 를 못 덮고 (b) OpenRouter 통과가 문서로 보장되지
//   않으며 (c) 미지원 파라미터가 400(validation)으로 돌아오면 **게이트 창 전체가 죽는다**.
//   ①을 쓰고 싶으면 `params`(프롬프트 바이트 무변경) 또는 `both` 로 명시한다.
//
// ⚠️ **돈을 쓰는 스위치다.** 캐시 할인이 사라지므로 입력 토큰이 정가로 붙는다. 상시 운용값이
//    아니라 **게이트 측정 창에서만** 켠다(기본 `false`).
import { randomUUID } from "node:crypto";

export const CACHE_BUST_MODES = ["nonce", "params", "both"] as const;
export type CacheBustMode = (typeof CACHE_BUST_MODES)[number];

export interface CacheBustConfig {
  enabled: boolean;
  mode: CacheBustMode;
}

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/**
 * env → 설정. **파서는 여기 하나뿐이다** — `app/settings.ts`(기동 요약·로그)와
 * `worker/invoker.ts`(실제 적용)가 같은 함수를 부른다. 두 벌로 두면 한쪽만 고쳤을 때
 * "설정은 받았는데 아무것도 안 하는 모드" 가 생기고, 그건 실패가 아니라 **오답**이다.
 *
 * ⚠️ 모르는 모드 값은 **기본값으로 접지 않고 던진다**(`app/settings.ts` `strStrict` 와 같은 규율).
 *    `ANALYSIS_LLM_CACHE_BUST_MODE=nonc` 가 조용히 `nonce` 로 접히는 것 자체는 무해해 보이지만,
 *    반대로 `parms`(오타)가 `nonce` 로 접히면 "프롬프트를 안 바꾸기로 했는데 바꿨다" 가 된다.
 */
export function loadCacheBustConfig(env: NodeJS.ProcessEnv = process.env): CacheBustConfig {
  const rawEnabled = env.ANALYSIS_LLM_CACHE_BUST;
  const enabled = rawEnabled === undefined || rawEnabled === "" ? false : TRUTHY.has(rawEnabled.trim().toLowerCase());
  const rawMode = env.ANALYSIS_LLM_CACHE_BUST_MODE;
  if (rawMode === undefined || rawMode.trim() === "") return { enabled, mode: "nonce" };
  const mode = rawMode.trim() as CacheBustMode;
  if (!CACHE_BUST_MODES.includes(mode)) {
    throw new Error(
      `ANALYSIS_LLM_CACHE_BUST_MODE must be one of ${CACHE_BUST_MODES.join("|")}, got ${JSON.stringify(rawMode)}`,
    );
  }
  return { enabled, mode };
}

/** 요청 1회의 무효화 토큰. 짧고(접두 1줄) 사람이 로그에서 알아볼 수 있는 모양이다. */
export function cacheBustNonce(uuid: string = randomUUID()): string {
  return `[nocache ${uuid}]`;
}

/**
 * **맨 앞 한 줄**로 붙인다 — 뒤나 가운데는 소용이 없다(접두 일치가 캐시 조건이므로).
 * 원문은 한 글자도 고치지 않는다(줄바꿈 하나만 사이에 둔다).
 */
export function prefixWithNonce(text: string, nonce: string): string {
  return `${nonce}\n${text}`;
}

/**
 * 공급자 파라미터 opt-out. 요청 바디에 **merge** 한다.
 *
 * ⚠️ `prompt_cache_options.mode="explicit"` 은 breakpoint 를 **하나도 주지 않는 것**과 짝이다 —
 *    lane 은 `cache_control`·`prompt_cache_breakpoint` 를 어디에도 넣지 않으므로 그대로 성립한다.
 *    (넣는 날이 오면 이 함수와 그 코드를 함께 봐야 한다.)
 */
export function cacheBustParams(uuid: string = randomUUID()): Record<string, unknown> {
  return {
    // 무작위 = OpenRouter 의 sticky routing 이 안 걸린다. OpenAI 쪽에서는 라우팅 힌트일 뿐
    // 미스 보장이 아니다(머리말 인용) — 그래서 이것만으로는 부족하고, 아래와 함께 쓴다.
    prompt_cache_key: uuid,
    prompt_cache_options: { mode: "explicit" },
  };
}

/**
 * 답장 `evidence.runtime` 에 **병합할 조각**. 코어 gate3 가 shadow 행의
 * `runtime->>'cacheBust'` 를 읽는다(코어 #661).
 *
 * ⚠️ **off 면 빈 객체다 — `false` 를 싣지 않는다.** 코어 `evidence.runtime` 은 `.strict()` 이고,
 *    이 필드를 아직 모르는 코어(측정 워커 TD 240)가 받으면 **답장 전체를 거부**한다. 완주한
 *    분석이 `output_contract` 로 버려지고 실비만 나간다. 배포 순서가 고정인 이유가 이것이다:
 *    **코어 PR-h 머지 + 워커 재배포 → lane 배포.** 그 사이에도 lane 이 기본 태세(off)로 도는
 *    한 이 조각이 비어 있어 **구버전 코어와 그대로 호환된다**.
 */
export function cacheBustReplyMark(enabled: boolean): { cacheBust?: true } {
  return enabled ? { cacheBust: true } : {};
}

/** 이 모드가 프롬프트 바이트를 바꾸는가. */
export function modeUsesNonce(mode: CacheBustMode): boolean {
  return mode === "nonce" || mode === "both";
}

/** 이 모드가 요청 파라미터를 더하는가. */
export function modeUsesParams(mode: CacheBustMode): boolean {
  return mode === "params" || mode === "both";
}
