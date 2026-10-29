// 공급자 풀 — 정의·모델 해석·단가표·헬스 게이팅 (스펙 §8.3 · §8.5).
//
// ── 이 파일이 존재하는 이유
//
//   코어 `lib/llm/invoke.ts` 는 공급자 분기 + cost_ledger 쓰기 + Bedrock SDK 를 **한 몸**으로
//   갖고 있다. lane 이 그것을 벤더하면 `@/lib/db` 가 따라 들어와 G3 경계가 깨진다(그래서
//   `shims/llm-invoke.ts` 는 타입만 준다). 그러니 **전송 계층은 lane 이 자기 것으로 만든다** —
//   단 아래 셋은 코어와 한 글자도 다르면 안 된다:
//
//     1. 모델 해석 규칙  — `LLM_TASK_MODEL_<task_snake>` → provider-prefixed id → alias 기본값
//                          (코어 `invoke.ts:106 resolveModel` + `env.ts:148 getTaskModelOverrides`)
//     2. 요청 바디       — `/chat/completions` + `response_format` + `reasoning` + `usage.include`
//                          (코어 `openrouter.ts:159~180`)
//     3. 단가표          — `OPENROUTER_RATES` (코어 `cost.ts:57~161`) · BYOK 우선순위
//
//   1 이 어긋나면 "코어와 같은 모델로 돌았다"는 A/B 근거가 죽고, 3 이 어긋나면 장부가 샌다.
//
// ── 스케일 주의 (이 파일이 라이브에서 640 in-flight 로 돈다)
//
//   헬스 창을 이벤트 배열로 두면 분당 수백 건이 5분간 쌓인다. **분 단위 버킷 5개**로 고정해
//   메모리가 콜 수와 무관하게 상수가 되게 한다. 풀 수도 상수이므로 전체가 O(풀 × 5) 다.
import type { AnalysisTask } from "../contracts/index.ts";

// ─────────────────────────────────────────────────────────────────────────────
// 태스크 이름 — 코어 것을 그대로 쓴다
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 벤더 코드가 `ClaudeRequest.task` 로 보내는 값 그대로. **이 문자열이 env 키의 재료**라
 * 축약하면 안 된다(코어 `env.ts:160 taskModelEnvKey` — dot → underscore).
 *
 * ⚠️ `measurement.analysis.unknown_discovery` 는 없다 — unknown-discovery 는 코어 store.ts 에
 *    남았고(스펙 §5.1) lane 의 순수 그래프가 그 함수를 부르지 않는다. 들어오면 알 수 없는
 *    태스크로 **명시적으로 죽는다**(조용한 기본값 금지).
 */
export const CORE_TASK_TO_LANE_TASK: Record<string, AnalysisTask> = {
  "measurement.analysis.extract_mentions": "extract",
  "measurement.analysis.resolve_pending_mentions": "resolve",
  "measurement.analysis.mention_semantics": "semantics",
  "measurement.analysis.classify_citation_domain": "citation",
  // 답변 단위 브랜드 스탠스(스펙 `scope-answer-brand-stance-spec-2026-09-14.md` §4.1).
  //
  // ⚠️ **벤더 순수 코드는 아직 이 태스크를 부르지 않는다**(스탠스 패스는 코어 WU3). 그런데도
  //    WU2 에서 먼저 등재하는 이유는 이 표가 `CORE_TASK_POOL_ENV_KEYS` 와
  //    `assertTaskModelParity` 의 **모수**이기 때문이다: 여기 없으면 모델 env 가 비어도
  //    기동이 통과하고, WU6 에서 배선이 붙는 순간 alias 기본값(haiku)으로 접힌다 —
  //    haiku 는 스탠스 토큰 프로파일에서 라이브 모델(gemini-3.1-flash-lite)의 **3.42배**다
  //    (스펙 §7.2 · 2026-09-15 모델 전환 후 재환산). 즉 이 한 줄이 B2 재발(단가 17배·조용한
  //    오답)을 WU6 이전에 막는 가드다.
  "measurement.analysis.answer_brand_stance": "stance",
  // 감성 V2 **섀도 병행** 패스의 원장 태스크(PR-L1).
  // 정본: `(내부 설계 문서)` §3.2.
  //
  // ⚠️ **코어에 이 태스크 문자열은 없다.** 앞의 다섯은 벤더 코드가 `ClaudeRequest.task` 로 실제로
  //    보내는 값이지만, 이것은 lane 이 **원장 분리를 위해 만든** 문자열이다. 섀도 V2 의 벤더 요청
  //    task 는 현행과 같은 `mention_semantics` 이고, 그대로 두면 V0 감성 비용과 섀도 비용이 같은
  //    행 종류로 뭉개져 플랜 §5 수용 기준 6 을 판정할 수 없다. PR-L2 에서 `withTaskOverride`
  //    (`worker/engines/core-engine.ts`)가 섀도 호출에만 이 문자열을 씌운다.
  //
  // ⚠️ **모델·풀 env 는 새로 요구하지 않는다** — `TASK_ROUTING_ALIAS` 가 이 태스크의 모델·풀
  //    해석을 `mention_semantics` 로 되돌린다. 여기 등재하면서 라우팅까지 새 축으로 열면
  //    `assertTaskModelParity` 가 `LLM_TASK_MODEL_…mention_semantics_shadow` 를 요구하고,
  //    그 키는 cdk.json 에도 코어 TD 에도 없으므로 **워커가 기동에서 죽는다** — B2 가드가
  //    B2 와 같은 모양의 사고로 되돌아오는 자리다(README §B2). `tests/semantics-shadow.test.ts`
  //    가 "새 env 없이 기동 경로가 통과한다" 로 그것을 고정한다.
  "measurement.analysis.mention_semantics_shadow": "semantics_shadow",
};

/**
 * **라우팅 별칭 — "원장은 따로, 모델·풀은 같이".**
 *
 * `CORE_TASK_TO_LANE_TASK` 가 "이 태스크의 원장 행을 무엇으로 적나" 라면, 이 표는 "이 태스크의
 * 모델·풀을 **누구의 배선으로** 정하나" 다. 둘을 같은 축으로 두면 원장을 나누는 순간 배선 축이
 * 함께 늘어나고, 그 새 env 가 비면 폴백 금지 가드(`assertTaskModelParity`)가 **함대를 세운다.**
 * 섀도는 "같은 모델로 같은 답변을 다시 채점한다" 가 전제라 라우팅을 나눌 이유도 없다.
 *
 * ⚠️ 별칭은 `taskModelEnvKey`·`taskPoolsEnvKey` **안에 넣지 않았다.** 그 둘은 코어
 *    `lib/env.ts:160·170` 산식의 사본이고, 사본에 lane 전용 규칙을 섞으면 "코어와 같은 산식"
 *    이라는 명제가 조용히 거짓이 된다. 별칭은 **쓰는 자리**(모델 해석·풀 가중치·기동 단언·
 *    풀 env 키 목록)에서만 적용한다.
 */
export const TASK_ROUTING_ALIAS: Readonly<Record<string, string>> = {
  "measurement.analysis.mention_semantics_shadow": "measurement.analysis.mention_semantics",
};

/** 이 태스크의 모델·풀 배선을 정하는 태스크. 별칭이 없으면 자기 자신이다. */
export function routingTaskFor(coreTask: string): string {
  return TASK_ROUTING_ALIAS[coreTask] ?? coreTask;
}

export function laneTaskFor(coreTask: string): AnalysisTask {
  const hit = CORE_TASK_TO_LANE_TASK[coreTask];
  if (!hit) {
    const known = Object.keys(CORE_TASK_TO_LANE_TASK);
    throw new Error(
      `unknown analysis task ${JSON.stringify(coreTask)} — lane 은 ${known.length}태스크만 안다 ` +
        `(${known.join(", ")}). 새 태스크가 생겼다면 여기와 계약 어휘를 함께 넓혀라.`,
    );
  }
  return hit;
}

/** 코어 `lib/env.ts:160` 과 같은 산식. */
export function taskModelEnvKey(coreTask: string): string {
  return `LLM_TASK_MODEL_${coreTask.replace(/\./g, "_")}`;
}

/** 코어 `lib/env.ts:170` 관례를 태스크→풀 가중치로 옮긴 것. 스펙 §8.3 의 `LLM_TASK_POOLS_<task>`. */
export function taskPoolsEnvKey(coreTask: string): string {
  return `LLM_TASK_POOLS_${coreTask.replace(/\./g, "_")}`;
}

/**
 * **lane 이 실제로 부르는 태스크**(= `CORE_TASK_TO_LANE_TASK` 전부)의 풀 env 키.
 * `CORE_TASK_MODEL_ENV_KEYS` 와 달리 `unknown_discovery` 가 없다 — 모델 env 는 "코어 TD 와
 * 바이트로 같게" 두려고 안 부르는 태스크까지 싣지만, `LLM_TASK_POOLS_*` 는 **lane 에만 있는 축**이라 코어 TD 와 맞출 대상이 없고
 * 안 부르는 태스크에 적어 두면 그냥 죽은 설정이다(읽는 코드가 없다).
 *
 * 배포 합성(`infra/lib/analysis-stack.ts` context `llmTaskPools`)이 이 목록으로 오타를 죽인다.
 *
 * ⚠️ **별칭을 적용하고 중복을 접는다.** `semantics_shadow` 는 `mention_semantics` 의 풀 배선을
 *    그대로 타므로 자기 키를 갖지 않는다 — 접지 않으면 같은 키가 두 번 들어가고, 이 목록을
 *    허용 키 화이트리스트로 쓰는 `infra/lib/analysis-stack.ts` 의 오타 가드가 흐려진다.
 */
export const CORE_TASK_POOL_ENV_KEYS: readonly string[] = [
  ...new Set(Object.keys(CORE_TASK_TO_LANE_TASK).map((t) => taskPoolsEnvKey(routingTaskFor(t)))),
];

// ─────────────────────────────────────────────────────────────────────────────
// 모델 해석 — 코어 `resolveModel` 과 같은 우선순위
// ─────────────────────────────────────────────────────────────────────────────

/** 코어 `invoke.ts:34~40`. env override 가 없을 때만 쓰인다. */
const BUILT_IN_DEFAULTS: Record<string, string> = {
  haiku: "openrouter/anthropic/claude-haiku-4.5",
  sonnet: "openrouter/anthropic/claude-sonnet-4.6",
};

export interface ResolvedLaneModel {
  /** `<vendor>/<model>` — 풀과 무관한 **모델의 정체**. 스펙 §8.3: 모델은 절대 안 바뀐다. */
  slug: string;
  /** 코어 단가표 키 — `openrouter/<vendor>/<model>`. 풀이 달라도 같은 모델이면 같은 키다. */
  canonicalId: string;
}

/**
 * 태스크 + alias → 모델. 코어 `resolveModel(task, model)` 의 우선순위 그대로:
 *   ① 호출자가 provider prefix 를 주면 그대로  ② `LLM_TASK_MODEL_<task>`  ③ alias 기본값
 *
 * ⚠️ `bedrock:` 은 **명시적으로 거부**한다. lane 에는 AWS SDK 가 없고(경계 테스트가 의존성을
 *    금지한다), 조용히 OpenRouter 로 떨어뜨리면 "코어와 같은 모델" 전제가 말없이 깨진다.
 */
export function resolveLaneModel(
  coreTask: string,
  alias: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedLaneModel {
  // 별칭이 있으면 **그쪽 env 를 읽는다** — 섀도 태스크가 `mention_semantics` 와 같은 모델로 돌아야
  // "같은 모델로 같은 답변을 다시 채점했다" 가 참이 된다(`TASK_ROUTING_ALIAS` 머리말).
  // 아래 에러 메시지도 routed 키를 말한다 — 사람이 고쳐야 하는 키가 그것이기 때문이다.
  const routedTask = routingTaskFor(coreTask);
  const explicit = alias && (alias.startsWith("openrouter/") || alias.startsWith("bedrock:")) ? alias : null;
  const override = env[taskModelEnvKey(routedTask)];
  const target = explicit ?? (override && override.length > 0 ? override : null) ?? BUILT_IN_DEFAULTS[alias ?? ""];
  if (!target) {
    throw new Error(
      `unknown model alias ${JSON.stringify(alias)} for task ${coreTask} — ` +
        `alias(haiku|sonnet) 또는 provider-prefixed id 를 주거나 ${taskModelEnvKey(routedTask)} 를 설정하라`,
    );
  }
  if (target.startsWith("bedrock:")) {
    throw new Error(
      `${taskModelEnvKey(routedTask)}=${target} — 분석 lane 은 Bedrock 을 돌리지 않는다(SDK 의존성 금지). ` +
        `openrouter/<vendor>/<model> 형태로 지정하라.`,
    );
  }
  if (!target.startsWith("openrouter/")) {
    throw new Error(`invalid model id ${JSON.stringify(target)} for task ${coreTask} — expected openrouter/<vendor>/<model>`);
  }
  const slug = target.slice("openrouter/".length);
  if (!slug.includes("/")) {
    throw new Error(`invalid model id ${JSON.stringify(target)} — expected openrouter/<vendor>/<model>`);
  }
  return { slug, canonicalId: target };
}

// ─────────────────────────────────────────────────────────────────────────────
// 모델 정합 게이트 — "코어와 다른 모델로 조용히 돈다" 를 구조적으로 막는다 (B2)
// ─────────────────────────────────────────────────────────────────────────────
//
// ⚠️ **이것이 alias 기본값의 함정이다.** `resolveLaneModel` 은 env override 가 없으면
//    `BUILT_IN_DEFAULTS`(haiku/sonnet)로 접힌다 — 코어와 같은 규칙이므로 그 자체는 옳다.
//    그런데 lane 워커 태스크 정의에 `LLM_TASK_MODEL_*` 가 **하나도 없었다**(라이브 TD rev 9 실측).
//    그래서 라이브가 extract·semantics 를 `anthropic/claude-haiku-4.5` 로,
//    resolve 를 `anthropic/claude-sonnet-4.6` 으로 돌았다. 코어 measurement-worker TD 는
//    같은 태스크를 `openai/gpt-5.6-luna` · `google/gemini-3.1-flash-lite` 로 돌린다.
//
//    결과는 실패가 아니라 **오답**이다: 턴 체류 2.3배(extract p50 37.0s vs 코어 16.1s),
//    단가 17배(턴 $0.0706 vs $0.0040), 그리고 "같은 모델로 돌았다" 를 전제하는 shadow A/B 가
//    무효가 된다. 알람은 울지 않는다 — 콜은 전부 200 이었다.
//
//    그래서 폴백을 **금지**한다. `engine≠stub` 인데 태스크 모델 env 가 비어 있으면 워커는
//    기동에서 죽는다(첫 티켓이 아니라). 배선은 `infra/lib/analysis-stack.ts` 가 `cdk.json`
//    context `llmTaskModels` 를 그대로 펼쳐서 한다 — **synth 가 같은 조건을 먼저 막는다.**

/**
 * 워커 TD 에 싣는 태스크 모델 env 키. 앞 5개는 코어 `measurement-worker-staging` TD 가 실제로
 * 주는 값이고(2026-09-13 라이브 정본), 6번째(`answer_brand_stance`)는 **코어보다 앞선 선행값**이다
 * (스탠스 태스크는 코어 WU3 에서 생긴다 — citation 이 2026-09-13 에 그랬던 것과 같은 자리).
 *
 * ⚠️ lane 이 **부르는** 태스크는 이 중 5개다(`CORE_TASK_TO_LANE_TASK` — unknown_discovery 는
 *    코어 store.ts 에 남았다). 안 부르는 것을 TD 에 함께 싣는 이유는 **코어 TD 와 바이트로
 *    같게** 두기 위해서다: 그 태스크가 나중에 lane 으로 넘어올 때 "env 는 없는데 코드는 있다" 로
 *    alias 폴백이 되는 창을 미리 닫는다. 런타임 단언은 부르는 것만 요구한다 —
 *    안 부르는 태스크 때문에 함대를 세우면 그건 가드가 아니라 사고다.
 */
export const CORE_TASK_MODEL_ENV_KEYS: readonly string[] = [
  "LLM_TASK_MODEL_measurement_analysis_extract_mentions",
  "LLM_TASK_MODEL_measurement_analysis_mention_semantics",
  "LLM_TASK_MODEL_measurement_analysis_resolve_pending_mentions",
  "LLM_TASK_MODEL_measurement_analysis_unknown_discovery",
  "LLM_TASK_MODEL_measurement_analysis_classify_citation_domain",
  // ⚠️ **코어 TD 에 아직 없는 6번째 키다**(스탠스 태스크는 코어 WU3 에서 생긴다). citation 이
  //    한때 그랬던 것처럼 lane 이 **합의된 목표값으로 선행**하는 자리다 — 코어가 이 태스크를
  //    갖게 되면 `describe-task-definition` 재실측으로 값을 맞춘다
  //    (`tests/model-parity.test.ts` `CORE_TD_TASK_MODELS` 각주).
  //
  //    이 키는 `CORE_TASK_TO_LANE_TASK` 에 stance 가 있으므로 **런타임 단언의 대상이다**:
  //    비어 있으면 워커가 기동에서 죽는다(스펙 A9). 배선은 `infra/cdk.json` context
  //    `llmTaskModels` 가 하고, synth 가 그 누락을 배포 전에 먼저 죽인다.
  "LLM_TASK_MODEL_measurement_analysis_answer_brand_stance",
];

export interface TaskModelResolution {
  coreTask: string;
  laneTask: AnalysisTask;
  envKey: string;
  /** `openrouter/<vendor>/<model>` — 코어 `cost_ledger.model_id` 와 같은 키. */
  canonicalId: string;
  /** 단가표에 있나. 없으면 `costUsd=null`(미계측)로 올라가 장부에 구멍이 난다. */
  rated: boolean;
}

/**
 * **lane 이 부르는 태스크(`CORE_TASK_TO_LANE_TASK`)가 전부 env 로 고정돼 있는지** 단언한다.
 * 하나라도 비면 던진다 —
 * 그 태스크는 alias 기본값으로 접혀 코어와 다른 모델로 돌 것이기 때문이다.
 *
 * 스텁 엔진은 예외다(LLM 을 안 부른다). `worker/main.ts` 가 **DB·마이그레이션보다 먼저**,
 * 그리고 `createLaneInvokerFactory`(= `pools_ready` 로그)보다 **먼저** 부른다.
 *
 * 값이 있는데 형식이 틀리면(`bedrock:` · prefix 없음) `resolveLaneModel` 의 기존 메시지로 죽는다.
 */
export function assertTaskModelParity(args: { engine: string; env?: NodeJS.ProcessEnv }): TaskModelResolution[] {
  const env = args.env ?? process.env;
  if (args.engine === "stub") return [];
  const missing: string[] = [];
  const out: TaskModelResolution[] = [];
  for (const [coreTask, laneTask] of Object.entries(CORE_TASK_TO_LANE_TASK)) {
    // ⚠️ **routed 키를 본다.** 별칭 태스크(`semantics_shadow`)에 자기 env 를 요구하면 그 키는
    //    cdk.json 에도 코어 TD 에도 없으므로 **워커가 기동에서 죽는다** — 원장을 나눈 대가로
    //    함대를 세우는 것은 가드가 아니라 사고다(B2 가드 머리말의 마지막 문단과 같은 원칙).
    //    routed 키가 비면 그때는 여전히 죽는다 = 섀도도 폴백으로 접히지 않는다.
    const envKey = taskModelEnvKey(routingTaskFor(coreTask));
    const raw = env[envKey];
    if (raw === undefined || raw.trim().length === 0) {
      missing.push(envKey);
      continue;
    }
    const model = resolveLaneModel(coreTask, undefined, env);
    out.push({ coreTask, laneTask, envKey, canonicalId: model.canonicalId, rated: lookupRate(model.canonicalId) !== null });
  }
  if (missing.length > 0) {
    // 별칭 때문에 같은 키가 두 번 들어올 수 있다(semantics + semantics_shadow) — 사람이 고칠
    // 키는 하나이므로 한 번만 말한다.
    const uniqueMissing = [...new Set(missing)];
    throw new Error(
      `ANALYSIS_ENGINE=${args.engine} requires an explicit model per analysis task; missing: ${uniqueMissing.join(", ")}. ` +
        "비어 있으면 alias 기본값(haiku/sonnet)으로 접혀 **코어와 다른 모델**로 돈다 — 콜은 전부 200 이라 " +
        "알람이 울지 않고 shadow A/B 만 조용히 무효가 된다. 값은 코어 measurement-worker TD 정본과 같아야 하고, " +
        "배선은 cdk.json context `llmTaskModels` 가 한다(`infra/lib/analysis-stack.ts`).",
    );
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 풀 정의
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **요청 바디의 방언.** 세 풀이 전부 `/chat/completions` 를 말하지만 *같은 필드를 받지는
 * 않는다* — OpenRouter 의 통합 확장(`usage.include` · `reasoning`)은 벤더 직결에서
 * **400(validation)** 이다. 400 은 재시도 불가라, 페일오버가 필요한 그 순간에 standby 가
 * 한 번도 답을 못 내고 죽는다. 그래서 필드 집합을 풀 속성으로 못박는다.
 *
 *   `openrouter`    — 통합 확장 전부 (현행 동작. 이 PR 이 한 바이트도 안 바꾼다)
 *   `openai`        — OpenAI 직결. `usage.include`·`reasoning` 없음, 프롬프트 캐시 파라미터는 있음.
 *                     **출력 상한은 `max_completion_tokens` 이고 `temperature` 는 안 보낸다**(아래 실측)
 *   `openai_compat` : OpenAI 호환 서드파티(Gemini `/v1beta/openai`). OpenRouter 확장 두 개와 프롬프트 캐시
 *                     파라미터는 없음. 공통 필드는 그대로. `response_format` json_schema 는 **내장
 *                     `google_direct` 에서만** 보낸다(2026-09-17 검증자가 V2 strict 스키마로
 *                     실콜해 HTTP 200 을 보고. lane 키가 아닌 별도 키). 같은 방언의
 *                     커스텀 풀은 실측 전까지 json_object 로 강등한다(`PoolConfig.jsonSchema` 참조)
 *
 * ── **라이브 스모크 실측 (2026-09-13 23:55 KST · lane 바디 그대로 1콜씩)**
 *
 *   OpenAI 직결 `gpt-5.6-luna` @ `api.openai.com/v1/chat/completions`
 *     · `max_tokens`                      → **400** "Unsupported parameter: 'max_tokens' is not
 *                                           supported with this model. Use 'max_completion_tokens'"
 *     · `max_completion_tokens` + `temperature: 0`
 *                                         → **400** "'temperature' does not support 0 with this
 *                                           model. Only the default (1) value is supported."
 *     · `max_completion_tokens` + `response_format` + temperature **생략** → **200**
 *   Google 직결 `gemini-3.1-flash-lite` @ `…/v1beta/openai/chat/completions`
 *     · `max_tokens` + `temperature: 0` + `response_format` → **200** (현행 유지)
 *
 *   ⚠️ 이 둘이 없으면 **페일오버 창 전량이 400** 이다 — standby 는 정의상 primary 가 아플 때만
 *      도는데, 그때 처음으로 400 을 만난다. 평시에는 한 번도 안 보인다.
 *   ⚠️ 대가: openai 직결 콜은 `temperature` **기본값(1)** 으로 돈다. 스펙 §6.3 의 결정성 전제
 *      (분석 4태스크 전부 0)가 그 콜에서만 깨진다 — 모델이 0 을 거부하므로 선택지가 없다
 *      (보내면 400 = 답 없음). 품질 각주는 README standby 절.
 *
 * ⚠️ 모르는 풀(`LLM_POOL_KEYS` 로 선언한 커스텀)의 기본값은 **가장 좁은 `openai_compat`** 이다.
 *    없는 필드를 보내면 400 으로 죽지만, 안 보내서 생기는 차이는 *답이 나온 뒤의* 차이다.
 *    같은 이유로 커스텀 풀은 json_schema 도 기본으로 안 보낸다(`jsonSchema: false`). 방언이
 *    openai_compat 여도 "그 엔드포인트가 json_schema 를 받는다" 는 실측된 적이 없기 때문이다.
 *    OpenRouter 같은 집계자를 새로 붙이면 `LLM_POOL_<KEY>_DIALECT=openrouter` 로 명시한다.
 */
export const POOL_DIALECTS = ["openrouter", "openai", "openai_compat"] as const;
export type PoolDialect = (typeof POOL_DIALECTS)[number];

export interface PoolWireFields {
  /** OpenRouter 전용 확장. 켜면 응답 `usage` 에 실비가 실린다. */
  usageInclude: boolean;
  /** OpenRouter **통합** 파라미터(`{max_tokens, exclude}`). 벤더 직결에는 같은 이름의 필드가 없다. */
  reasoning: boolean;
  /** `prompt_cache_key` · `prompt_cache_options` — OpenAI 계열 전용(게이트③ `params` 모드). */
  promptCacheParams: boolean;
  /** 출력 상한 필드 이름. OpenAI 직결의 luna 는 `max_tokens` 를 **400 으로 거부**한다(위 실측). */
  maxTokensField: "max_tokens" | "max_completion_tokens";
  /** `temperature` 를 보내나. OpenAI 직결의 luna 는 기본값(1) 외를 **400 으로 거부**한다(위 실측). */
  temperature: boolean;
  /**
   * `response_format: { type: "json_schema", json_schema }` 를 보내나. false 면 invoker 가
   * json_object 로 **강등**하고 `analysis_lane.json_schema_degraded` 를 남긴다(조용한 드롭 금지).
   *
   * openrouter · openai_compat 만 true 다(명세 PR-Lane 2). openai 직결은 OpenAI 자기 API 라
   * 지원할 것으로 보이지만 **이 lane 바디 그대로의 라이브 실측이 없다**. standby 는 장애 창에서만
   * 돌기 때문에, 거기서 처음 400 을 만나는 것보다 스키마 없이 json_object 로 답을 받는 편이 낫다.
   * 실측으로 확인되면 여기만 true 로 바꾼다.
   */
  jsonSchema: boolean;
}

const DIALECT_WIRE_FIELDS: Record<PoolDialect, PoolWireFields> = {
  openrouter: { usageInclude: true, reasoning: true, promptCacheParams: true, maxTokensField: "max_tokens", temperature: true, jsonSchema: true },
  openai: { usageInclude: false, reasoning: false, promptCacheParams: true, maxTokensField: "max_completion_tokens", temperature: false, jsonSchema: false },
  openai_compat: { usageInclude: false, reasoning: false, promptCacheParams: false, maxTokensField: "max_tokens", temperature: true, jsonSchema: true },
};

export function poolWireFields(pool: PoolConfig): PoolWireFields {
  const byDialect = DIALECT_WIRE_FIELDS[pool.dialect];
  // 풀 단위 `jsonSchema: false` 는 방언이 허용해도 **끈다**(좁히기만 한다. 방언이 false 면 켤 수 없다).
  if (pool.jsonSchema === false && byDialect.jsonSchema) return { ...byDialect, jsonSchema: false };
  return byDialect;
}

export interface PoolConfig {
  key: string;
  baseUrl: string;
  apiKeyEnv: string;
  maxInflight: number;
  extraHeaders: Record<string, string>;
  /** OpenRouter 는 `usage.total_cost`/`cost_details` 를 준다. 직결 풀은 안 준다 → 단가표. */
  vendorReportsCost: boolean;
  /**
   * wire 모델 id 만드는 법.
   *   `slug`  = `<vendor>/<model>` 그대로 (OpenRouter)
   *   `model` = 마지막 세그먼트만    (벤더 직결 — `openai/gpt-5.6-luna` → `gpt-5.6-luna`)
   * `LLM_POOL_<KEY>_MODEL_<VENDOR>_<MODEL>` 로 개별 override 할 수 있다.
   */
  wireIdStyle: "slug" | "model";
  /** 요청 바디 방언. `LLM_POOL_<KEY>_DIALECT` 로 override. */
  dialect: PoolDialect;
  /**
   * **이 풀이 실어 나를 수 있는 모델 벤더**(`<vendor>/<model>` 의 앞 토막). `null` = 제약 없음
   * (집계자). `LLM_POOL_<KEY>_MODEL_VENDORS="openai,google"` 또는 `"*"`(=제약 없음)로 override.
   *
   * ⚠️ **이게 없으면 standby 가 조용히 404 를 만든다.** 풀이 바뀌어도 모델은 안 바뀌므로
   *    (스펙 §8.3) `google/gemini-3.1-flash-lite` 를 `openai_direct` 로 넘기면 wire id 가
   *    `gemini-3.1-flash-lite` 가 되어 OpenAI 에 그런 모델이 없다. 실패 자체는 typed 로
   *    올라오지만, 그 실패는 **OpenRouter 가 아플 때만** 나타나서 평시 테스트에 안 잡힌다.
   */
  modelVendors: readonly string[] | null;
  /**
   * json_schema 전송을 **풀 단위로 끄는** 스위치. 생략 = 방언 정본(`DIALECT_WIRE_FIELDS`)을 따른다.
   * `false` 면 방언이 허용해도 json_object 로 강등하고 `analysis_lane.json_schema_degraded` 를 남긴다.
   * 방언이 허용하지 않는 풀을 이 값으로 켤 수는 없다(좁히기 전용).
   *
   * 커스텀 풀(`LLM_POOL_KEYS`)의 기본은 `false` 다. 실측 후 `LLM_POOL_<KEY>_JSON_SCHEMA=true` 로 연다.
   *
   * ⚠️ **내장 풀(openrouter · openai_direct · google_direct)에도 같은 env 스위치가 적용된다. 의도다.**
   *    `LLM_POOL_OPENROUTER_JSON_SCHEMA=false` 면 openrouter 도 json_object 로 강등된다. 공급자가
   *    json_schema 를 거부하기 시작했을 때 코드 배포 없이 끄는 **운영 킬스위치**로 쓴다. 대가로 이
   *    env 에 잘못된 값이 들어가면 내장 풀도 **기동에서** 죽는다(파싱 규칙은 `poolJsonSchemaFromEnv`).
   */
  jsonSchema?: boolean;
}

const DEFAULT_POOLS: PoolConfig[] = [
  {
    key: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    maxInflight: 0,
    // 코어 `openrouter.ts:163~165` 와 같은 attribution 헤더. 운영 대시보드가 이걸로 식별한다.
    extraHeaders: { "HTTP-Referer": "https://scope.answer.so", "X-Title": "scope" },
    vendorReportsCost: true,
    wireIdStyle: "slug",
    dialect: "openrouter",
    // 집계자다 — 벤더를 가리지 않는다.
    modelVendors: null,
  },
  {
    key: "openai_direct",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    maxInflight: 0,
    extraHeaders: {},
    vendorReportsCost: false,
    wireIdStyle: "model",
    dialect: "openai",
    modelVendors: ["openai"],
  },
  {
    key: "google_direct",
    // Google AI Studio 의 OpenAI 호환 엔드포인트(스펙 §8.3 현실 경로 (b)).
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKeyEnv: "GOOGLE_AI_API_KEY",
    maxInflight: 0,
    extraHeaders: {},
    vendorReportsCost: false,
    wireIdStyle: "model",
    dialect: "openai_compat",
    modelVendors: ["google"],
  },
];

/**
 * 배포 합성(`infra/lib/analysis-stack.ts` context `llmTaskPools`)이 **이 정본**으로 풀 키와
 * 벤더 제약을 검사한다. 스택이 자기 목록을 따로 들면 그 사본이 낡는 날 synth 는 통과하고
 * 라이브만 틀린다 — 그 드리프트를 만들지 않으려고 내보낸다(읽기 전용).
 */
export const BUILT_IN_POOLS: readonly PoolConfig[] = DEFAULT_POOLS;

function poolDialectFromEnv(raw: string | undefined, fallback: PoolDialect, poolKey: string): PoolDialect {
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = raw.trim();
  if (!(POOL_DIALECTS as readonly string[]).includes(v)) {
    throw new Error(
      `LLM_POOL_${poolKey.toUpperCase()}_DIALECT=${JSON.stringify(raw)} — ${POOL_DIALECTS.join(" | ")} 중 하나여야 한다.`,
    );
  }
  return v as PoolDialect;
}

/** `"*"` = 제약 없음(집계자). 빈 값은 내장 기본값을 유지한다. */
function poolVendorsFromEnv(raw: string | undefined, fallback: readonly string[] | null): readonly string[] | null {
  if (raw === undefined || raw.trim() === "") return fallback;
  if (raw.trim() === "*") return null;
  const vendors = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return vendors.length > 0 ? vendors : fallback;
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${key} must be a non-negative integer, got ${JSON.stringify(v)}`);
  return n;
}

/**
 * 환경에서 풀을 읽는다. **키가 없는 풀은 비활성**이다 — 키 없는 풀로 라우팅하면 매 콜이
 * 401 이고, 그건 페일오버가 아니라 그냥 실패다.
 */
export function loadPools(env: NodeJS.ProcessEnv = process.env): PoolConfig[] {
  const declared = (env.LLM_POOL_KEYS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const base = new Map(DEFAULT_POOLS.map((p) => [p.key, { ...p, extraHeaders: { ...p.extraHeaders } }]));
  for (const key of declared) {
    if (!base.has(key)) {
      base.set(key, {
        key,
        baseUrl: "",
        apiKeyEnv: `LLM_POOL_${key.toUpperCase()}_API_KEY`,
        maxInflight: 0,
        extraHeaders: {},
        vendorReportsCost: false,
        wireIdStyle: "model",
        // 모르는 엔드포인트에는 **가장 좁은 필드 집합**을 보낸다(위 POOL_DIALECTS 머리말).
        dialect: "openai_compat",
        // 모르는 풀에 벤더 제약을 걸면 기존 배선이 조용히 끊긴다 — 제약은 명시해야 생긴다.
        modelVendors: null,
        // json_schema 수용은 실측 전까지 가정하지 않는다(강등 + 로그).
        jsonSchema: false,
      });
    }
  }
  const out: PoolConfig[] = [];
  for (const pool of base.values()) {
    const prefix = `LLM_POOL_${pool.key.toUpperCase()}`;
    const baseUrl = env[`${prefix}_BASE_URL`] ?? pool.baseUrl;
    const apiKeyEnv = env[`${prefix}_API_KEY_ENV`] ?? pool.apiKeyEnv;
    const headersRaw = env[`${prefix}_HEADERS`];
    let extraHeaders = pool.extraHeaders;
    if (headersRaw) {
      const parsed: unknown = JSON.parse(headersRaw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`${prefix}_HEADERS must be a JSON object`);
      }
      extraHeaders = { ...pool.extraHeaders, ...(parsed as Record<string, string>) };
    }
    if (!baseUrl) continue; // 주소 없는 풀은 존재하지 않는 것과 같다
    out.push({
      key: pool.key,
      baseUrl,
      apiKeyEnv,
      maxInflight: envInt(`${prefix}_MAX_INFLIGHT`, pool.maxInflight),
      extraHeaders,
      vendorReportsCost: (env[`${prefix}_VENDOR_COST`] ?? String(pool.vendorReportsCost)) === "true",
      wireIdStyle: (env[`${prefix}_WIRE_ID_STYLE`] as PoolConfig["wireIdStyle"] | undefined) ?? pool.wireIdStyle,
      dialect: poolDialectFromEnv(env[`${prefix}_DIALECT`], pool.dialect, pool.key),
      modelVendors: poolVendorsFromEnv(env[`${prefix}_MODEL_VENDORS`], pool.modelVendors),
      ...poolJsonSchemaFromEnv(env[`${prefix}_JSON_SCHEMA`], pool.jsonSchema, pool.key),
    });
  }
  return out;
}

/**
 * `LLM_POOL_<KEY>_JSON_SCHEMA` 파싱 규칙(확정, `tests/semantics-v2-accept.test.ts` 가 고정한다).
 *
 *   `"true"`            : 방언이 허용하면 연다
 *   `"false"`           : 끈다(강등)
 *   미설정 · `""`        : 풀 기본값(내장 = 방언 정본, 커스텀 = false)
 *   그 외 전부           : **기동 throw**. 대소문자 변형(`"TRUE"`), 앞뒤 공백(`" true"`), `"1"`/`"0"`,
 *                         `"yes"`, 공백만(`"   "`) 포함
 *
 * ⚠️ `_DIALECT`·`_MODEL_VENDORS` 파서와 **의도적으로 다르다.** 그쪽은 trim 하고 공백만인 값을 미설정으로
 *    본다. 이 스위치는 킬스위치라 값의 뜻이 한 글자라도 모호하면 추측하지 않고 죽는다: `" false"` 를
 *    trim 해 받아 주는 것은 무해해 보이지만, 공백만인 값을 미설정으로 접으면 "끄려고 넣은 값이 템플릿
 *    치환 실패로 비었다" 가 조용히 기본값(열림)이 된다. 빈 문자열 `""` 만 미설정으로 보는 이유는 CDK·TD
 *    가 키를 비워 두는 관례(값 없음)와 맞추기 위해서다.
 */
function poolJsonSchemaFromEnv(raw: string | undefined, fallback: boolean | undefined, key: string): { jsonSchema?: boolean } {
  if (raw === undefined || raw === "") return fallback === undefined ? {} : { jsonSchema: fallback };
  if (raw === "true") return { jsonSchema: true };
  if (raw === "false") return { jsonSchema: false };
  throw new Error(`LLM_POOL_${key.toUpperCase()}_JSON_SCHEMA must be "true" or "false", got ${JSON.stringify(raw)}`);
}

export function poolApiKey(pool: PoolConfig, env: NodeJS.ProcessEnv = process.env): string | null {
  const v = env[pool.apiKeyEnv];
  return v && v.length > 0 ? v : null;
}

export function wireModelId(pool: PoolConfig, model: ResolvedLaneModel, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env[`LLM_POOL_${pool.key.toUpperCase()}_MODEL_${model.slug.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`];
  if (explicit) return explicit;
  if (pool.wireIdStyle === "slug") return model.slug;
  const last = model.slug.split("/").at(-1);
  return last ?? model.slug;
}

/** 코어 `displayId` 자리 — `cost_ledger.model_id` 에 풀을 포함시키기 위한 표시 id(스펙 §8.5). */
export function displayModelId(poolKey: string, model: ResolvedLaneModel): string {
  return `${poolKey}/${model.slug}`;
}

/** `<vendor>/<model>` 의 앞 토막. 단가표 키가 아니라 **라우팅 판정용**이다. */
export function modelVendorOf(model: ResolvedLaneModel): string {
  return model.slug.split("/")[0] ?? "";
}

/** 이 풀로 이 모델을 보낼 수 있나. 집계자(`modelVendors === null`)는 전부 받는다. */
export function poolAcceptsModel(pool: PoolConfig, model: ResolvedLaneModel): boolean {
  if (pool.modelVendors === null) return true;
  return pool.modelVendors.includes(modelVendorOf(model));
}

export interface PoolCompatibility {
  /** 이 모델을 실제로 실어 나를 수 있는 풀만. 순서는 입력 그대로. */
  weights: PoolWeight[];
  /** 벤더가 안 맞아 빠진 것 — **조용히 빼지 않기 위해** 호출자가 로그로 남긴다. */
  dropped: Array<{ poolKey: string; poolVendors: readonly string[]; modelVendor: string }>;
}

/**
 * 가중치 목록에서 **모델을 못 받는 풀을 뺀다.**
 *
 * ⚠️ standby 만이 아니라 weight>0 도 똑같이 뺀다 — `openai_direct:1` 에 anthropic 모델을
 *    태우는 배선은 평시에도 매 콜이 404 다. "명시했으니 존중한다" 로 두면 그 404 를
 *    공급자 장애로 읽게 된다.
 */
export function compatiblePoolWeights(weights: PoolWeight[], model: ResolvedLaneModel, pools: PoolConfig[]): PoolCompatibility {
  const byKey = new Map(pools.map((p) => [p.key, p]));
  const out: PoolWeight[] = [];
  const dropped: PoolCompatibility["dropped"] = [];
  for (const w of weights) {
    const pool = byKey.get(w.poolKey);
    if (!pool) continue; // 활성 풀이 아니다 — taskPoolWeights 가 이미 걸렀어야 한다
    if (poolAcceptsModel(pool, model)) {
      out.push(w);
      continue;
    }
    dropped.push({ poolKey: pool.key, poolVendors: pool.modelVendors ?? [], modelVendor: modelVendorOf(model) });
  }
  return { weights: out, dropped };
}

// ─────────────────────────────────────────────────────────────────────────────
// 태스크별 가중치
// ─────────────────────────────────────────────────────────────────────────────

export interface PoolWeight {
  poolKey: string;
  weight: number;
}

/**
 * `LLM_TASK_POOLS_<task> = "openrouter:70,openai_direct:30"` (스펙 §8.3).
 * **미설정이면 현행 단일 경로** — 즉 활성 풀 중 `openrouter` 하나다. 기본값으로 분산을
 * 켜지 않는 이유: 분산은 실비·품질 근거가 필요한 변경이라 env 로 명시해야 한다.
 *
 * ── **weight 0 = standby** (운영 결정 2026-09-13)
 *
 *   `"openrouter:1,openai_direct:0"` 는 "openai_direct 를 빼라" 가 아니라 **"평시 트래픽은
 *   0, OpenRouter 가 못 받을 때만 쓴다"** 이다. 초판은 여기서 0 을 버렸고, 그러면 standby 를
 *   표현할 방법이 `30%` 같은 **평시 분산**밖에 없다 — 그건 다른 결정이다(실비·품질 근거가
 *   필요하고, 직결 풀은 단가를 안 줘서 장부가 단가표 추정으로 바뀐다).
 *
 *   그래서 0 을 **보관**하고 선택 순서로 의미를 준다(`pickPool`). 음수·NaN 은 그대로 던진다 —
 *   0 에 뜻이 생겼으므로 "그 밖의 이상한 값" 은 더더욱 조용히 통과하면 안 된다.
 */
export function taskPoolWeights(coreTask: string, enabled: PoolConfig[], env: NodeJS.ProcessEnv = process.env): PoolWeight[] {
  // 모델과 같은 이유로 **routed 키를 읽는다**(`TASK_ROUTING_ALIAS`) — 섀도가 V0 와 다른 풀로 가면
  // 같은 답변을 같은 조건으로 다시 채점한다는 전제가 깨지고, 풀별 헬스 게이팅도 둘로 갈린다.
  const routedTask = routingTaskFor(coreTask);
  const raw = env[taskPoolsEnvKey(routedTask)];
  const enabledKeys = new Set(enabled.map((p) => p.key));
  if (!raw) {
    const fallback = enabled.find((p) => p.key === "openrouter") ?? enabled[0];
    return fallback ? [{ poolKey: fallback.key, weight: 1 }] : [];
  }
  const out: PoolWeight[] = [];
  for (const part of raw.split(",")) {
    const [key, w] = part.split(":").map((s) => s.trim());
    if (!key) continue;
    if (!enabledKeys.has(key)) continue; // 키 없는 풀은 조용히 빠진다 — 가중치만 남으면 라우팅이 죽는다
    const weight = w === undefined ? 1 : Number(w);
    if (!Number.isFinite(weight) || weight < 0) {
      throw new Error(`${taskPoolsEnvKey(routedTask)}: invalid weight ${JSON.stringify(w)} for pool ${key}`);
    }
    // ⚠️ **0 을 버리지 않는다** — standby 다(위 머리말). 버리면 `pickPool` 이 그 풀의 존재를
    //    영영 모르고, "켜 뒀는데 장애 때 안 넘어갔다" 가 된다.
    out.push({ poolKey: key, weight });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 헬스 게이팅 — 5분 창 429/5xx > 10% → 가중치 0, 쿨다운 60s (스펙 §8.3)
// ─────────────────────────────────────────────────────────────────────────────

const HEALTH_WINDOW_MINUTES = 5;
const HEALTH_MIN_SAMPLE = 20;
const HEALTH_BAD_RATIO = 0.1;
const HEALTH_COOLDOWN_MS = 60_000;

interface Bucket {
  minute: number;
  calls: number;
  bad: number;
}

/**
 * 풀별 최근 5분 실패율. **버킷 5개 고정** — 콜 수가 늘어도 메모리가 늘지 않는다
 * (분당 수백 건 × 5분을 이벤트로 쌓으면 그것 자체가 스케일 결함이다).
 */
export class PoolHealth {
  #buckets = new Map<string, Bucket[]>();
  #cooldownUntil = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  record(poolKey: string, bad: boolean): void {
    const minute = Math.floor(this.now() / 60_000);
    const arr = this.#buckets.get(poolKey) ?? [];
    let b = arr.find((x) => x.minute === minute);
    if (!b) {
      b = { minute, calls: 0, bad: 0 };
      arr.push(b);
    }
    b.calls += 1;
    if (bad) b.bad += 1;
    const cutoff = minute - (HEALTH_WINDOW_MINUTES - 1);
    this.#buckets.set(
      poolKey,
      arr.filter((x) => x.minute >= cutoff),
    );
    if (bad) {
      const { calls, badCalls } = this.window(poolKey);
      if (calls >= HEALTH_MIN_SAMPLE && badCalls / calls > HEALTH_BAD_RATIO) {
        this.#cooldownUntil.set(poolKey, this.now() + HEALTH_COOLDOWN_MS);
      }
    }
  }

  window(poolKey: string): { calls: number; badCalls: number } {
    const minute = Math.floor(this.now() / 60_000);
    const cutoff = minute - (HEALTH_WINDOW_MINUTES - 1);
    let calls = 0;
    let badCalls = 0;
    for (const b of this.#buckets.get(poolKey) ?? []) {
      if (b.minute < cutoff) continue;
      calls += b.calls;
      badCalls += b.bad;
    }
    return { calls, badCalls };
  }

  /** 쿨다운 중이면 가중치 0 취급. */
  isGated(poolKey: string): boolean {
    const until = this.#cooldownUntil.get(poolKey);
    return until !== undefined && this.now() < until;
  }

  snapshot(): Array<{ poolKey: string; calls: number; badCalls: number; gated: boolean }> {
    return [...this.#buckets.keys()].map((k) => ({ poolKey: k, ...remap(this.window(k)), gated: this.isGated(k) }));
  }
}

function remap(w: { calls: number; badCalls: number }): { calls: number; badCalls: number } {
  return w;
}

/**
 * 가중 랜덤 선택 — **standby 를 마지막에 둔다**(운영 결정 2026-09-13).
 *
 *   ① 게이팅 안 된 **weight>0** 풀에서 가중 랜덤        ← 평시. 여기서 끝난다
 *   ② 없으면 게이팅 안 된 **standby(weight 0)** 에서 균등 ← OpenRouter 가 아플 때만
 *   ③ 그래도 없으면 원래 가중치 풀 전체에서 (게이팅 무시)  ← 기존 동작 그대로
 *
 * ②가 ③보다 **먼저**인 것이 이 설계의 전부다. 순서를 뒤집으면 "전부 게이팅" 판정이 먼저
 * 걸려 아픈 primary 로 다시 던지고, 멀쩡한 standby 는 영영 안 쓰인다.
 *
 * ③을 남기는 이유는 초판과 같다 — "전부 아프다"에서 아무것도 안 고르면 분석이 통째로
 * 멈춘다. 아픈 풀에 던져 보는 쪽이 낫다(실패는 typed 로 올라간다).
 * standby 를 균등으로 고르는 이유: weight 0 끼리는 비교할 가중치가 없다. 0 을 확률로 쓰면
 * 아무도 안 뽑힌다.
 */
export function pickPool(weights: PoolWeight[], health: PoolHealth, rand: () => number = Math.random): string | null {
  if (weights.length === 0) return null;
  const primary = weights.filter((w) => w.weight > 0);
  const standby = weights.filter((w) => w.weight <= 0).map((w) => ({ poolKey: w.poolKey, weight: 1 }));
  const openPrimary = primary.filter((w) => !health.isGated(w.poolKey));
  if (openPrimary.length > 0) return weightedPick(openPrimary, rand);
  const openStandby = standby.filter((w) => !health.isGated(w.poolKey));
  if (openStandby.length > 0) return weightedPick(openStandby, rand);
  if (primary.length > 0) return weightedPick(primary, rand);
  return weightedPick(standby, rand);
}

/** 가중치가 전부 양수인 목록에서 하나. (호출자가 standby 를 1 로 정규화해서 넘긴다.) */
function weightedPick(pool: PoolWeight[], rand: () => number): string | null {
  const total = pool.reduce((a, w) => a + w.weight, 0);
  if (total <= 0) return pool[0]?.poolKey ?? null;
  let r = rand() * total;
  for (const w of pool) {
    r -= w.weight;
    if (r <= 0) return w.poolKey;
  }
  return pool.at(-1)?.poolKey ?? null;
}

export interface TaskStandbySummary {
  coreTask: string;
  envKey: string;
  /** 평시 트래픽을 받는 풀(weight > 0). 비어 있으면 그 태스크는 standby 만으로 돈다. */
  primary: string[];
  /** 선언된 standby 중 **키가 있어 실제로 활성**인 것. */
  standby: string[];
  /**
   * 선언은 됐는데 **활성 풀에 없어서 빠진 것**. 키가 비었거나 base URL 이 없다는 뜻이고,
   * 그 태스크는 "standby 를 켜 뒀다" 는 믿음만 남는다 — 페일오버는 일어나지 않는다.
   *
   * ⚠️ 이 축이 CDK 가드의 사각지대다. 합성은 "context 에 키 **필드 이름**이 있나" 까지만 본다;
   *    시크릿의 그 JSON 필드가 **빈 값**이면 TD 는 정상이고 env 도 들어오는데 `poolApiKey` 가
   *    null 이라 풀이 비활성이 된다. 배포는 성공하고 아무 알람도 안 운다.
   */
  declaredButInactive: string[];
}

/**
 * 기동 요약용 — 태스크별 standby 선언과 **실제 활성 여부**. 던지지 않는다: standby 가 없다고
 * 함대를 세우는 것은 과잉이다(그 태스크는 openrouter 단독으로 정상 동작한다). 대신 **보이게** 한다.
 */
export function summarizeTaskStandby(pools: PoolConfig[], env: NodeJS.ProcessEnv = process.env): TaskStandbySummary[] {
  const activeKeys = new Set(pools.map((p) => p.key));
  const out: TaskStandbySummary[] = [];
  // ⚠️ 별칭 태스크는 **건너뛴다** — 자기 풀 env 가 없고(라우팅을 `mention_semantics` 와 공유한다),
  //    그대로 돌면 같은 선언이 두 줄로 요약에 뜬다. "standby 를 켰는데 키가 없다" 를 두 번 말하면
  //    기동 로그가 실제 배선보다 넓어 보인다.
  for (const coreTask of Object.keys(CORE_TASK_TO_LANE_TASK)) {
    if (routingTaskFor(coreTask) !== coreTask) continue;
    const envKey = taskPoolsEnvKey(coreTask);
    const raw = env[envKey];
    if (!raw || raw.trim() === "") continue; // 미설정 = openrouter 단독. 보고할 것이 없다
    const declared: Array<{ key: string; weight: number }> = [];
    for (const part of raw.split(",")) {
      const [key, w] = part.split(":").map((s) => s.trim());
      if (!key) continue;
      const weight = w === undefined ? 1 : Number(w);
      declared.push({ key, weight: Number.isFinite(weight) ? weight : 0 });
    }
    out.push({
      coreTask,
      envKey,
      primary: declared.filter((d) => d.weight > 0 && activeKeys.has(d.key)).map((d) => d.key),
      standby: declared.filter((d) => d.weight <= 0 && activeKeys.has(d.key)).map((d) => d.key),
      declaredButInactive: declared.filter((d) => !activeKeys.has(d.key)).map((d) => d.key),
    });
  }
  return out;
}

/** 이 태스크에서 `poolKey` 가 standby(평시 트래픽 0)인가. 원장·로그 표기에 쓴다. */
export function isStandbyPool(weights: PoolWeight[], poolKey: string): boolean {
  const hit = weights.find((w) => w.poolKey === poolKey);
  return hit !== undefined && hit.weight <= 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// 단가표 — 코어 `lib/llm/cost.ts` OPENROUTER_RATES 복제 (2026-09-12 c522cf86)
// ─────────────────────────────────────────────────────────────────────────────
//
// ⚠️ **손으로 복사한 유일한 자산이다.** 벤더 트리에 넣지 않은 이유: `cost.ts` 는 첫 줄이
//    `@/lib/db` 라 값으로 들어오면 경계가 깨진다(플랜 §1.3 L1). 그래서 표만 옮긴다.
//    코어가 단가를 고치면 여기가 낡는다 — 그 드리프트는 `tests/invoker-pool.test.ts` 의
//    "코어 단가표와 키 집합이 같다" 가 잡지 못한다(코어를 읽을 수 없으므로). **재동기 때
//    사람이 확인하는 항목**으로 README 에 적어 둔다.
//    미등재 모델은 0 이 아니라 **`null`(미계측)** 로 올린다 — 0 으로 위조하면 장부가 조용히 샌다.

export const LANE_MODEL_RATES: Record<string, { inputPer1k: number; outputPer1k: number }> = {
  "openrouter/anthropic/claude-haiku-4.5": { inputPer1k: 0.001, outputPer1k: 0.005 },
  "openrouter/anthropic/claude-sonnet-4.5": { inputPer1k: 0.003, outputPer1k: 0.015 },
  "openrouter/anthropic/claude-sonnet-4.6": { inputPer1k: 0.003, outputPer1k: 0.015 },
  "openrouter/~anthropic/claude-sonnet-latest": { inputPer1k: 0.003, outputPer1k: 0.015 },
  "openrouter/anthropic/claude-sonnet-5": { inputPer1k: 0.002, outputPer1k: 0.01 },
  "openrouter/anthropic/claude-opus-4.5": { inputPer1k: 0.015, outputPer1k: 0.075 },
  "openrouter/anthropic/claude-opus-4.8": { inputPer1k: 0.005, outputPer1k: 0.025 },
  "openrouter/anthropic/claude-4.8-opus": { inputPer1k: 0.005, outputPer1k: 0.025 },
  "openrouter/deepseek/deepseek-v4-pro": { inputPer1k: 0.000435, outputPer1k: 0.00087 },
  "openrouter/deepseek/deepseek-v4-flash": { inputPer1k: 0.0000679, outputPer1k: 0.000168 },
  "openrouter/openai/gpt-5-mini": { inputPer1k: 0.00015, outputPer1k: 0.0006 },
  "openrouter/openai/gpt-5": { inputPer1k: 0.0025, outputPer1k: 0.01 },
  "openrouter/openai/gpt-5.4-mini": { inputPer1k: 0.00075, outputPer1k: 0.0045 },
  // extract·resolve 의 라이브 모델(스펙 §8.3). BYOK 실단가 $0.20/$1.20 per 1M.
  "openrouter/openai/gpt-5.6-luna": { inputPer1k: 0.0002, outputPer1k: 0.0012 },
  "openrouter/google/gemini-2.5-flash": { inputPer1k: 0.00015, outputPer1k: 0.0006 },
  // semantics·citation 의 라이브 모델(스펙 §8.3 "lite31").
  "openrouter/google/gemini-3.1-flash-lite": { inputPer1k: 0.00025, outputPer1k: 0.0015 },
  "openrouter/google/gemini-3.5-flash": { inputPer1k: 0.0015, outputPer1k: 0.009 },
  "openrouter/google/gemini-3.5-flash-lite": { inputPer1k: 0.0003, outputPer1k: 0.0025 },
  "openrouter/qwen/qwen3.7-plus": { inputPer1k: 0.0004, outputPer1k: 0.0016 },
};

/** 코어 `cost.ts:169 normalizeOpenRouterModelId` 와 같은 산식(`:nitro` 변종·날짜 스냅샷 접미사). */
export function normalizeModelId(displayId: string): string {
  const lastSlash = displayId.lastIndexOf("/");
  if (lastSlash === -1) return displayId;
  const head = displayId.slice(0, lastSlash + 1);
  let tail = displayId.slice(lastSlash + 1);
  const colon = tail.indexOf(":");
  if (colon !== -1) tail = tail.slice(0, colon);
  tail = tail.replace(/-\d{8}$/, "");
  return head + tail;
}

export function lookupRate(canonicalId: string): { inputPer1k: number; outputPer1k: number } | null {
  const exact = LANE_MODEL_RATES[canonicalId];
  if (exact) return exact;
  const normalized = normalizeModelId(canonicalId);
  if (normalized !== canonicalId) return LANE_MODEL_RATES[normalized] ?? null;
  return null;
}

export type LaneCostSource = "vendor_reported" | "rate_table";

export interface LaneCost {
  /** **null = 미계측**이다. 0 이 아니다 — 0 으로 위조하면 비용이 조용히 과소 집계된다. */
  costUsd: number | null;
  source: LaneCostSource | null;
  unregisteredModelId?: string;
}

/**
 * 코어 `resolveOpenRouterCost`(cost.ts:260~) 의 우선순위 그대로:
 *   ① BYOK 실비(`cost_details.upstream_inference_cost`) ② 크레딧 실청구액(`total_cost`) ③ 단가표
 * ⚠️ BYOK 계정에서 `total_cost` 는 **항상 0** 이다 — 0 을 "무료" 로 읽으면 안 된다.
 */
export function resolveLaneCost(input: {
  canonicalId: string;
  inputTokens: number;
  outputTokens: number;
  totalCostUsd?: number;
  upstreamInferenceCostUsd?: number;
}): LaneCost {
  const upstream = input.upstreamInferenceCostUsd;
  if (typeof upstream === "number" && !Number.isNaN(upstream) && upstream > 0) {
    return { costUsd: upstream, source: "vendor_reported" };
  }
  const total = input.totalCostUsd;
  if (typeof total === "number" && !Number.isNaN(total) && total > 0) {
    return { costUsd: total, source: "vendor_reported" };
  }
  const rate = lookupRate(input.canonicalId);
  if (!rate) return { costUsd: null, source: null, unregisteredModelId: input.canonicalId };
  const cost = (input.inputTokens / 1000) * rate.inputPer1k + (input.outputTokens / 1000) * rate.outputPer1k;
  return { costUsd: cost, source: "rate_table" };
}
