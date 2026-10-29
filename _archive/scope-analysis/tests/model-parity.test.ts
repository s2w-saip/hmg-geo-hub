// 태스크 모델 정합 (B2) — **lane 이 코어와 같은 모델로 도는가.**
//
// ── 왜 이 파일이 따로 있나
//
//   `invoker-pool.test.ts` 는 "override 가 있으면 그 모델로 해석된다" 를 본다. 그건 해석 규칙의
//   테스트지 **배선의 테스트가 아니다.** 라이브에서 깨진 것은 규칙이 아니라 배선이었다:
//   lane 워커 TD(rev 9)에 `LLM_TASK_MODEL_*` 가 하나도 없어서 override 가 비었고,
//   `BUILT_IN_DEFAULTS`(alias haiku/sonnet)로 접혀 코어와 **다른 모델**로 돌았다.
//
//   그 실패는 조용하다 — 콜은 전부 200 이다. 남는 지문은 턴 체류 2.3배(extract p50 37.0s vs
//   코어 16.1s)·단가 17배(턴 $0.0706 vs $0.0040)뿐이고, "같은 모델로 돌았다" 를 전제하는
//   shadow A/B 는 그 사이 내내 무효였다.
//
//   그래서 세 축을 **한 파일에서** 묶는다:
//     ① cdk.json 의 값이 코어 TD 정본과 같은가 (드리프트)
//     ② 그 값이 env 로 들어왔을 때 lane 4태스크가 코어 모델로 해석되는가 (해석)
//     ③ 비면 **기동에서 죽는가** (폴백 금지)
//   ③ 의 *실배선*(`worker/main.ts` 가 실제로 부르는가)은 `silent-failure-gate.test.ts` (a″) 가
//   자식 프로세스로 판정한다 — 이 파일은 함수만 부르므로 "가드가 존재한다" 까지만 증명한다.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CORE_TASK_MODEL_ENV_KEYS,
  CORE_TASK_POOL_ENV_KEYS,
  CORE_TASK_TO_LANE_TASK,
  assertTaskModelParity,
  loadPools,
  lookupRate,
  resolveLaneModel,
  routingTaskFor,
  taskModelEnvKey,
  taskPoolWeights,
} from "../worker/llm-pools.ts";

// ⚠️ **라우팅 별칭을 쓰는 태스크**(자기 모델·풀 env 가 없고 다른 태스크의 배선을 타는 것)에
//    "태스크마다 env 키가 있다" 를 그대로 요구하면, 존재하지 않는 키(cdk.json·코어 TD 둘 다에
//    없다)를 요구하게 되어 **가드가 함대를 세운다** — B2 를 막는 것이 아니라 B2 와 같은 모양의
//    사고다. 그래서 이 파일의 B2 단언들은 `routingTaskFor()` 로 **routed 키를 본다.**
//    정본: `worker/llm-pools.ts` `TASK_ROUTING_ALIAS`.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const cdkContext = (
  JSON.parse(readFileSync(`${ROOT}infra/cdk.json`, "utf8")) as { context: Record<string, unknown> }
).context;

/**
 * 코어 측정 워커 TD **`measurement-worker-staging:238`** 의 실값(2026-09-13
 * `describe-task-definition` 실측). 값은 비밀이 아니다 — 모델 id 다.
 *
 * ⚠️ 이 상수가 **정본의 사본**이다. 코어가 모델을 바꾸면 여기가 낡고, 그 드리프트는
 *    아무도 못 잡는다(lane 은 코어 TD 를 읽을 수 없다). 재동기 때 사람이 확인하는 항목 —
 *    `LANE_MODEL_RATES` 의 단가표와 같은 성격이다.
 *
 * ⚠️ **citation 은 정본보다 앞서 있다**(2026-09-13 운영 결정: lane 은 luna/flash-lite 만).
 *    코어 TD rev 238 은 아직 `anthropic/claude-haiku-4.5` 이고 코어도 flash-lite 로 전환 중이다.
 *    즉 이 한 줄은 "실측된 코어 값" 이 아니라 **합의된 목표값**이며, 코어 전환이 끝나면
 *    `describe-task-definition` 재실측으로 확인하고 이 각주를 지운다. 나머지 4키는 실측값 그대로다.
 */
const CORE_TD_TASK_MODELS: Record<string, string> = {
  LLM_TASK_MODEL_measurement_analysis_extract_mentions: "openrouter/openai/gpt-5.6-luna",
  LLM_TASK_MODEL_measurement_analysis_mention_semantics: "openrouter/google/gemini-3.1-flash-lite",
  LLM_TASK_MODEL_measurement_analysis_resolve_pending_mentions: "openrouter/openai/gpt-5.6-luna",
  LLM_TASK_MODEL_measurement_analysis_unknown_discovery: "openrouter/openai/gpt-5.6-luna",
  // ⚠️ 위 각주 — 코어보다 앞선 값이다(haiku → flash-lite).
  LLM_TASK_MODEL_measurement_analysis_classify_citation_domain: "openrouter/google/gemini-3.1-flash-lite",
  // ⚠️ **코어 TD 에 아직 이 태스크 자체가 없다**(스탠스 패스는 코어 WU3 — 스펙
  //    `scope-answer-brand-stance-spec-2026-09-14.md` §8.2). citation 과 같은 성격의
  //    **선행값**이다. 코어가 이 태스크를 갖게 되면 `describe-task-definition` 재실측으로
  //    확인하고 이 각주를 지운다.
  //
  // ⚠️ **2026-09-15: gemini-2.5-flash → flash-lite**(운영 요청). 사유는 비용이 아니라 모델
  //    규칙이다 — 2026-09-13 "lane 은 luna/flash-lite 만" 에서 2.5-flash 는 레거시다.
  //    이제 lane 의 google 태스크 셋(semantics·citation·stance)이 한 모델로 모인다.
  //    **코어 PR 도 같은 값으로 동시 전환 중**이므로 이 줄은 citation 과 마찬가지로 잠시
  //    "합의된 목표값" 이고, 코어 전환이 끝나면 실측으로 확인한다.
  //    단가는 2.35배 오른다(답변당 $0.000779 → $0.001829, 파일럿 토큰 프로파일 환산) —
  //    그래도 haiku 의 1/3.42 다. 근거·재검증 계획은 `infra/cdk.json`
  //    (내부 결정 기록).
  LLM_TASK_MODEL_measurement_analysis_answer_brand_stance: "openrouter/google/gemini-3.1-flash-lite",
};

/** cdk.json 이 주입하는 값을 그대로 env 로 만든 것 — 라이브 워커가 받을 모양. */
function liveEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...CORE_TD_TASK_MODELS };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

// ── ① 드리프트 ──────────────────────────────────────────────────────────────────

test("B2 — cdk.json 의 llmTaskModels 가 코어 TD 정본과 **정확히** 같다", () => {
  assert.deepEqual(
    cdkContext.llmTaskModels,
    CORE_TD_TASK_MODELS,
    "cdk.json 이 코어 measurement-worker TD 와 다른 모델을 주입한다 — lane 이 다른 모델로 돈다",
  );
});

test("B2 — 키 목록의 정본은 코드(CORE_TASK_MODEL_ENV_KEYS)이고 cdk.json 이 그것을 다 채운다", () => {
  assert.deepEqual([...CORE_TASK_MODEL_ENV_KEYS].sort(), Object.keys(CORE_TD_TASK_MODELS).sort());
  assert.deepEqual(Object.keys(cdkContext.llmTaskModels as object).sort(), [...CORE_TASK_MODEL_ENV_KEYS].sort());
});

test("B2 — lane 이 부르는 태스크는 모두 그 키 목록 안에 있다 (태스크가 늘면 여기서 깨진다)", () => {
  // 새 태스크를 `CORE_TASK_TO_LANE_TASK` 에 넣고 env 키를 안 넣으면 그 태스크만 조용히
  // alias 로 접힌다 — 정확히 B2 의 재발 경로다.
  for (const coreTask of Object.keys(CORE_TASK_TO_LANE_TASK)) {
    // 별칭 태스크는 **routed 키**가 목록에 있어야 한다(자기 키는 존재하지 않는다).
    assert.ok(
      CORE_TASK_MODEL_ENV_KEYS.includes(taskModelEnvKey(routingTaskFor(coreTask))),
      `${coreTask} 의 모델 env 키가 CORE_TASK_MODEL_ENV_KEYS 에 없다 — 그 태스크는 alias 로 접힌다`,
    );
  }
  // 역방향은 성립하지 않는다: unknown_discovery 는 코어 store.ts 에 남아 lane 이 부르지 않는다.
  //
  // ⚠️ **개수를 손으로 적지 않는다**(F3). 초판은 `4`·`5` 를 박아 뒀고 태스크가 늘 때마다
  //    사람이 같이 고쳐야 했다 — 그 숫자는 "무엇이 맞는지" 를 말하지 않고 "지난번엔 몇 개였나"
  //    만 말한다. 정본은 **벤더 소스에 실제로 있는 task 리터럴 집합**이고, 아래 두 값은 거기서
  //    파생된다. 코어가 태스크를 늘리면 이 테스트가 **자동으로** 새 기대값을 갖는다.
  const vendorTasks = vendorTaskLiterals();
  assert.deepEqual(
    Object.keys(CORE_TASK_TO_LANE_TASK)
      .filter((t) => !(LANE_ONLY_TASKS as readonly string[]).includes(t))
      .sort(),
    vendorTasks.filter((t) => !(UNREACHABLE_TASKS as readonly string[]).includes(t)).sort(),
    "lane 이 부르는 태스크 집합이 벤더 소스의 리터럴과 다르다",
  );
  assert.equal(CORE_TASK_MODEL_ENV_KEYS.length, vendorTasks.length, "env 키 수가 벤더 태스크 수와 다르다");
});

// ── F3: 벤더 소스가 진짜 부르는 태스크 ⊆ 배선된 태스크 ──────────────────────────
//
//   `CORE_TASK_TO_LANE_TASK` 는 **손으로 적은 목록**이다. 벤더 코드가 새 task 문자열을 보내기
//   시작하면 그 목록이 조용히 낡고, `toLaneRequest` 가 던지는 예외는 벤더 `llm.ts` 의 catch 가
//   `failed:true` 로 접는다 → **티켓 completed · 결과 0건 · 원장 0행의 조용한 결손**이다.
//   (WU6 에서 실제로 그 상태였다 — stance 가 `core-engine.ts` 쪽 사본에 빠져 있었다.)
//   그래서 목록을 **벤더 소스에서 역으로 확인**한다.

/** `unknown_discovery` 는 코어 store.ts 에 남아 lane 의 순수 그래프가 부르지 않는다(도달 불가). */
const UNREACHABLE_TASKS = ["measurement.analysis.unknown_discovery"] as const;

/**
 * **lane 이 만든 태스크 문자열** — 코어에도 벤더에도 없다. 따라서 "벤더 리터럴 == 배선" 양방향
 * 대조의 **예외**다.
 *
 * `mention_semantics_shadow` 는 감성 V2 섀도 병행 호출의 **원장 축**이다: 벤더 요청 task 는 현행
 * 그대로 `mention_semantics` 이고(벤더 무수정), lane 이 `withTaskOverride` 로 원장 태스크만 갈아
 * 끼운다(`worker/engines/core-engine.ts`). 모델·풀은 `TASK_ROUTING_ALIAS` 가 `mention_semantics`
 * 로 되돌린다. 정본: `(내부 설계 문서)` §3.2.
 *
 * ⚠️ **이 목록을 "벤더에 없는 것을 넣어 두는 서랍" 으로 쓰지 마라.** 아래 테스트가 각 항목에
 *    대해 ① 벤더에 정말 없고 ② 라우팅 별칭을 갖는다 를 함께 단언한다 — 별칭 없이 여기 들어오면
 *    그건 B2(모델 env 없는 태스크)를 가드에서 숨기는 것이다.
 */
const LANE_ONLY_TASKS = ["measurement.analysis.mention_semantics_shadow"] as const;

/** 벤더 트리 전체에서 `"measurement.analysis.*"` 리터럴을 전수 추출한다. */
function vendorTaskLiterals(): string[] {
  const root = fileURLToPath(new URL("../packages/analysis-core/vendor", import.meta.url));
  const out = new Set<string>();
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = `${dir}/${e.name}`;
      if (e.isDirectory()) { walk(abs); continue; }
      if (!e.name.endsWith(".ts")) continue;
      for (const m of readFileSync(abs, "utf8").matchAll(/"(measurement\.analysis\.[a-z_]+)"/g)) out.add(m[1]!);
    }
  };
  walk(root);
  return [...out].sort();
}

test("F3 — 벤더 소스의 task 리터럴이 **전부** 배선돼 있다 (도달 불가 목록 제외)", () => {
  const vendorTasks = vendorTaskLiterals();
  assert.ok(vendorTasks.length >= 5, `벤더에서 task 리터럴을 못 찾았다 — 추출기가 낡았다 (${vendorTasks.length}개)`);

  const wired = new Set(Object.keys(CORE_TASK_TO_LANE_TASK));
  const unwired = vendorTasks.filter((t) => !wired.has(t) && !(UNREACHABLE_TASKS as readonly string[]).includes(t));
  assert.deepEqual(
    unwired,
    [],
    `벤더가 부르는데 배선이 없는 태스크: ${unwired.join(", ")} — ` +
      "이 상태의 실패는 조용하다(티켓 completed · 결과 0건 · 원장 0행). " +
      "`CORE_TASK_TO_LANE_TASK` 와 `CORE_TASK_MODEL_ENV_KEYS` · cdk.json 을 함께 넓혀라.",
  );

  // 반대 방향 — 배선은 했는데 벤더가 안 부르는 태스크도 드러낸다(죽은 설정).
  // lane 전용 태스크는 정의상 벤더에 없다 — 아래에서 **그 예외가 정당한지**를 따로 단언한다.
  const dead = [...wired].filter((t) => !vendorTasks.includes(t) && !(LANE_ONLY_TASKS as readonly string[]).includes(t));
  assert.deepEqual(dead, [], `벤더가 부르지 않는데 배선된 태스크: ${dead.join(", ")} — 죽은 설정이다`);

  // lane 전용 예외의 자격 심사 — 서랍이 되지 않게.
  for (const t of LANE_ONLY_TASKS) {
    assert.ok(wired.has(t), `${t} 가 배선돼 있지 않다 — lane 전용 목록에서 빼라`);
    assert.ok(!vendorTasks.includes(t), `${t} 가 벤더에 생겼다 — 이제 lane 전용이 아니다`);
    assert.notEqual(
      routingTaskFor(t),
      t,
      `${t} 에 라우팅 별칭이 없다 — 자기 모델 env 를 요구하게 되고, 그 키는 cdk.json 에 없다(B2 재발)`,
    );
  }

  // 도달 불가 목록이 **실제로 도달 불가인지**까지 본다. `unknown_discovery` 가 벤더에
  // 리터럴로는 있지만(타입·상수) `CORE_TASK_TO_LANE_TASK` 에 없는 것이 현재 상태다.
  for (const t of UNREACHABLE_TASKS) {
    assert.ok(vendorTasks.includes(t), `${t} 가 벤더에서 사라졌다 — 도달 불가 목록을 줄여라`);
    assert.ok(!wired.has(t), `${t} 가 배선됐다 — 도달 불가 목록에서 빼라`);
  }
});

// ── ② 해석 ─────────────────────────────────────────────────────────────────────

test("B2 — env 키가 전부 들어오면 lane 이 부르는 태스크가 **코어 값**으로 해석된다", () => {
  const env = liveEnv();
  const got = Object.fromEntries(
    Object.keys(CORE_TASK_TO_LANE_TASK).map((coreTask) => [
      coreTask,
      // alias 는 벤더 코드가 보내는 것(haiku/sonnet) — override 가 그것을 이겨야 한다.
      resolveLaneModel(coreTask, "haiku", env).canonicalId,
    ]),
  );
  assert.deepEqual(got, {
    "measurement.analysis.extract_mentions": "openrouter/openai/gpt-5.6-luna",
    "measurement.analysis.resolve_pending_mentions": "openrouter/openai/gpt-5.6-luna",
    "measurement.analysis.mention_semantics": "openrouter/google/gemini-3.1-flash-lite",
    "measurement.analysis.classify_citation_domain": "openrouter/google/gemini-3.1-flash-lite",
    "measurement.analysis.answer_brand_stance": "openrouter/google/gemini-3.1-flash-lite",
    // 별칭 태스크 — 자기 env 가 없는데도 **V0 감성과 같은 모델**로 해석된다. 이것이
    // `TASK_ROUTING_ALIAS` 의 존재 이유이자, 섀도 A/B 가 "같은 모델로 다시 채점" 인 근거다.
    "measurement.analysis.mention_semantics_shadow": "openrouter/google/gemini-3.1-flash-lite",
  });
  // 별칭이 실제로 **같은 값**으로 접히는지 직접 대조한다(위 표는 값을 손으로 적은 것이라
  // 둘이 동시에 틀리면 못 본다).
  assert.equal(
    resolveLaneModel("measurement.analysis.mention_semantics_shadow", "haiku", env).canonicalId,
    resolveLaneModel("measurement.analysis.mention_semantics", "haiku", env).canonicalId,
  );
  // 풀에 실리는 wire id 도 vendor 접두사를 유지한다(OpenRouter slug 규약).
  assert.equal(resolveLaneModel("measurement.analysis.extract_mentions", "haiku", env).slug, "openai/gpt-5.6-luna");
});

test("B2 — env 가 비면 **이것으로 접혔다**: 라이브가 실제로 돌던 alias 기본값 (회귀 증거)", () => {
  const empty: NodeJS.ProcessEnv = {};
  assert.equal(
    resolveLaneModel("measurement.analysis.extract_mentions", "haiku", empty).canonicalId,
    "openrouter/anthropic/claude-haiku-4.5",
  );
  assert.equal(
    resolveLaneModel("measurement.analysis.mention_semantics", "haiku", empty).canonicalId,
    "openrouter/anthropic/claude-haiku-4.5",
  );
  assert.equal(
    resolveLaneModel("measurement.analysis.resolve_pending_mentions", "sonnet", empty).canonicalId,
    "openrouter/anthropic/claude-sonnet-4.6",
  );
  // 규칙 자체는 코어와 같다(`lib/llm/invoke.ts` resolveModel ③ built-in default) — 고칠 것은
  // 규칙이 아니라 **배선**이다. 그래서 이 테스트는 폴백을 버그로 단언하지 않고 기록만 한다.
});

test("B2 — 주입한 모델은 전부 단가표에 있다 (미등재면 costUsd=null 로 장부에 구멍)", () => {
  // 코어 `lib/llm/cost.ts` OPENROUTER_RATES 실값(2026-08-02 BYOK 프로브). 값까지 대조한다 —
  // 키만 보면 "있는데 틀린 단가" 를 놓친다.
  const CORE_RATES: Record<string, { inputPer1k: number; outputPer1k: number }> = {
    "openrouter/openai/gpt-5.6-luna": { inputPer1k: 0.0002, outputPer1k: 0.0012 },
    "openrouter/google/gemini-3.1-flash-lite": { inputPer1k: 0.00025, outputPer1k: 0.0015 },
    // citation 이 flash-lite 로 옮겨가 **주입 모델 집합에는 더 이상 없다.** 그래도 남겨 둔다 —
    // alias 폴백(`BUILT_IN_DEFAULTS`)이 여전히 이 모델로 접히므로 단가표에서 빠지면 그 경로의
    // 비용이 `costUsd=null` 로 샌다. 아래 루프는 주입 집합만 도므로 이 줄은 그 루프의 대상이 아니다.
    "openrouter/anthropic/claude-haiku-4.5": { inputPer1k: 0.001, outputPer1k: 0.005 },
    // stance 가 2026-09-15 에 여기로 옮겨 왔다(2.5-flash → flash-lite). 이제 semantics·
    // citation 과 **같은 모델**이라 위 flash-lite 줄이 그 단가를 겸한다.
    // 2.5-flash 는 더 이상 주입 집합에 없지만 단가표에는 남아 있어야 한다(A10) — 아래 루프는
    // 주입 집합만 돌므로 여기서 빼도 통과하지만, 빼면 그 모델로 돌던 과거 행의 비용 재계산이
    // `costUsd=null` 로 샌다. citation 이 haiku 를 남겨 둔 것과 같은 이유.
    "openrouter/google/gemini-2.5-flash": { inputPer1k: 0.00015, outputPer1k: 0.0006 },
  };
  for (const canonicalId of new Set(Object.values(CORE_TD_TASK_MODELS))) {
    const rate = lookupRate(canonicalId);
    assert.ok(rate, `${canonicalId} 가 LANE_MODEL_RATES 에 없다 — 그 모델의 비용이 미계측으로 샌다`);
    assert.deepEqual(rate, CORE_RATES[canonicalId], `${canonicalId} 단가가 코어 cost.ts 와 다르다`);
  }
});

// ── ③ 폴백 금지 ─────────────────────────────────────────────────────────────────

test("B2 — engine=core + 키 전부 주입 → 통과하고 해석 요약을 돌려준다", () => {
  const out = assertTaskModelParity({ engine: "core", env: liveEnv() });
  assert.equal(out.length, 6, "lane 이 부르는 태스크만 요약에 나와야 한다");
  assert.deepEqual(
    out.map((m) => `${m.laneTask}=${m.canonicalId}`).sort(),
    [
      "citation=openrouter/google/gemini-3.1-flash-lite",
      "extract=openrouter/openai/gpt-5.6-luna",
      "resolve=openrouter/openai/gpt-5.6-luna",
      "semantics=openrouter/google/gemini-3.1-flash-lite",
      // 별칭 태스크도 요약에 **보인다**(숨기지 않는다) — 기동 로그 `analysis_lane.task_models` 가
      // "섀도가 무엇으로 도는지" 를 말해야 원장이 갈린 뒤에도 A/B 전제를 확인할 수 있다.
      "semantics_shadow=openrouter/google/gemini-3.1-flash-lite",
      "stance=openrouter/google/gemini-3.1-flash-lite",
    ],
  );
  assert.deepEqual(out.filter((m) => !m.rated), [], "단가표에 없는 모델이 섞였다");
});

test("B2 — engine=core 인데 키가 **하나라도** 비면 던진다 (키마다 개별로 본다)", () => {
  for (const coreTask of Object.keys(CORE_TASK_TO_LANE_TASK)) {
    // routed 키를 지운다 — 별칭 태스크는 자기 키가 없고, 그 사실 자체가 가드를 무르게 하면 안 된다
    // (routed 키를 지우면 **두 태스크가 함께** 죽는다. 그것이 의도다).
    const key = taskModelEnvKey(routingTaskFor(coreTask));
    assert.throws(
      () => assertTaskModelParity({ engine: "core", env: liveEnv({ [key]: undefined }) }),
      new RegExp(key),
      `${key} 가 없는데 통과했다 — 그 태스크는 alias 로 접혀 코어와 다른 모델로 돈다`,
    );
    // 빈 문자열·공백도 **미설정과 같다.** `-c` 나 시크릿 배선이 빈값을 내리는 경로가 실재한다
    // (H3 의 `ANALYSIS_ENGINE=""` 와 같은 부류).
    assert.throws(() => assertTaskModelParity({ engine: "core", env: liveEnv({ [key]: "" }) }), new RegExp(key));
    assert.throws(() => assertTaskModelParity({ engine: "core", env: liveEnv({ [key]: "   " }) }), new RegExp(key));
  }
  // 전부 비면 한 번에 알려준다 — 한 개씩 고치며 여러 번 재배포하지 않게.
  assert.throws(
    () => assertTaskModelParity({ engine: "core", env: {} }),
    /extract_mentions[\s\S]*classify_citation_domain|classify_citation_domain[\s\S]*extract_mentions/,
  );
});

test("B2 — lane 이 안 부르는 unknown_discovery 가 비어도 기동은 막지 않는다", () => {
  // TD 에는 싣지만(코어와 같게) 런타임이 그것 때문에 함대를 세우면 그건 가드가 아니라 사고다.
  const out = assertTaskModelParity({
    engine: "core",
    env: liveEnv({ LLM_TASK_MODEL_measurement_analysis_unknown_discovery: undefined }),
  });
  assert.equal(out.length, 6);
});

// ── 라우팅 별칭(PR-L1) — "원장은 따로, 모델·풀은 같이" ──────────────────────────────

test("PR-L1 — 섀도 태스크는 **새 env 를 요구하지 않는다**(요구하면 워커가 기동에서 죽는다)", () => {
  const shadow = "measurement.analysis.mention_semantics_shadow";
  // ① 자기 키는 존재하지 않고, 목록에도 없다.
  assert.equal(taskModelEnvKey(shadow), "LLM_TASK_MODEL_measurement_analysis_mention_semantics_shadow");
  assert.equal(CORE_TASK_MODEL_ENV_KEYS.includes(taskModelEnvKey(shadow)), false, "cdk.json·코어 TD 에 없는 키를 목록에 넣었다");
  assert.equal(Object.keys(cdkContext.llmTaskModels as object).includes(taskModelEnvKey(shadow)), false);

  // ② 그런데도 라이브 env(= cdk.json 이 펼치는 6키)만으로 기동 단언이 통과한다.
  assert.doesNotThrow(() => assertTaskModelParity({ engine: "core", env: liveEnv() }));

  // ③ 그 키를 **명시적으로 비워도** 아무 일이 없다 — 읽지 않기 때문이다.
  assert.doesNotThrow(() =>
    assertTaskModelParity({ engine: "core", env: liveEnv({ [taskModelEnvKey(shadow)]: undefined }) }),
  );

  // ④ 반대로 routed 키가 비면 여전히 죽는다 = 섀도도 alias 폴백으로 접히지 않는다.
  assert.throws(
    () => assertTaskModelParity({ engine: "core", env: liveEnv({ LLM_TASK_MODEL_measurement_analysis_mention_semantics: undefined }) }),
    /LLM_TASK_MODEL_measurement_analysis_mention_semantics/,
  );
});

test("PR-L1 — 섀도 태스크의 **모델·풀이 V0 감성과 같은 값**으로 풀린다", () => {
  const shadow = "measurement.analysis.mention_semantics_shadow";
  const semantics = "measurement.analysis.mention_semantics";
  assert.equal(routingTaskFor(shadow), semantics);
  // 모델 — 라이브 env 에서도, env 가 빈 상태에서도(alias 폴백 규칙까지) 같다.
  for (const env of [liveEnv(), {} as NodeJS.ProcessEnv]) {
    assert.deepEqual(resolveLaneModel(shadow, "haiku", env), resolveLaneModel(semantics, "haiku", env));
  }
  // 풀 env 키도 별도 축을 만들지 않는다.
  assert.equal(CORE_TASK_POOL_ENV_KEYS.includes("LLM_TASK_POOLS_measurement_analysis_mention_semantics_shadow"), false);
  assert.equal(
    CORE_TASK_POOL_ENV_KEYS.filter((k) => k === "LLM_TASK_POOLS_measurement_analysis_mention_semantics").length,
    1,
    "별칭 때문에 같은 풀 키가 두 번 들어갔다 — 합성 가드의 화이트리스트가 흐려진다",
  );

  // ── 풀 **가중치**까지 같은가 (env 키 목록만으로는 못 본다)
  //
  // ⚠️ 이 단언이 없으면 `taskPoolWeights` 안에서만 별칭을 되돌린 변이가 **살아남는다**
  //    (검증자 실측: 408 tests 전부 통과). 라이브 결과는 조용한 비대칭이다 — 섀도만
  //    존재하지 않는 `LLM_TASK_POOLS_…_mention_semantics_shadow` 를 읽어 openrouter 단독
  //    폴백으로 접히고, V0 semantics 는 선언된 standby(google_direct)로 살아남는다.
  //    OpenRouter 가 아픈 구간에 **섀도만 죽고** 아무도 그것을 실패로 보지 않는다.
  const pools = loadPools();
  // ① 선언이 있는 경우 — 여기서 갈린다(standby 포함 가중치가 그대로 따라와야 한다).
  const declaredEnv: NodeJS.ProcessEnv = {
    LLM_TASK_POOLS_measurement_analysis_mention_semantics: "openrouter:1,google_direct:0",
  };
  assert.deepEqual(
    taskPoolWeights(shadow, pools, declaredEnv),
    taskPoolWeights(semantics, pools, declaredEnv),
    "섀도가 V0 감성과 다른 풀 가중치로 돈다 — standby 페일오버가 섀도에만 안 걸린다",
  );
  assert.deepEqual(taskPoolWeights(shadow, pools, declaredEnv), [
    { poolKey: "openrouter", weight: 1 },
    { poolKey: "google_direct", weight: 0 },
  ]);
  // ② 선언이 없는 경우 — 둘 다 같은 폴백(openrouter 단독)이어야 한다.
  const bareEnv: NodeJS.ProcessEnv = {};
  assert.deepEqual(taskPoolWeights(shadow, pools, bareEnv), taskPoolWeights(semantics, pools, bareEnv));
  // ③ 섀도 이름의 풀 env 는 **읽히지 않는다** — 읽히면 라우팅이 두 축으로 갈린 것이다.
  assert.deepEqual(
    taskPoolWeights(shadow, pools, { LLM_TASK_POOLS_measurement_analysis_mention_semantics_shadow: "google_direct:1" }),
    taskPoolWeights(semantics, pools, bareEnv),
    "섀도 전용 풀 env 가 먹었다 — 별칭이 뚫렸다",
  );
});

// ── 스탠스(WU2) — A9 의 lane 쪽 절반 ────────────────────────────────────────────

test("A9 — stance 모델 env 가 없으면 워커가 **기동에서 죽는다**", () => {
  // 스펙 A9. 비면 alias 기본값(haiku)으로 접히는데, haiku 는 스탠스 토큰 프로파일에서
  // 라이브 모델(gemini-3.1-flash-lite)의 **3.42배**다(§7.2 재환산) — 콜은 전부 200 이라
  // 알람이 안 운다.
  const key = "LLM_TASK_MODEL_measurement_analysis_answer_brand_stance";
  assert.throws(() => assertTaskModelParity({ engine: "core", env: liveEnv({ [key]: undefined }) }), new RegExp(key));
  assert.throws(() => assertTaskModelParity({ engine: "core", env: liveEnv({ [key]: "" }) }), new RegExp(key));
  // 폴백이 실제로 haiku 라는 것(= 무엇을 막고 있는지)을 함께 박아 둔다.
  assert.equal(
    resolveLaneModel("measurement.analysis.answer_brand_stance", "haiku", {}).canonicalId,
    "openrouter/anthropic/claude-haiku-4.5",
  );
});

test("B2 — 스텁 엔진은 예외다 (LLM 을 안 부른다)", () => {
  assert.deepEqual(assertTaskModelParity({ engine: "stub", env: {} }), []);
});

test("B2 — 형식이 틀린 값은 기존 메시지로 죽는다 (bedrock: · prefix 없음)", () => {
  const key = "LLM_TASK_MODEL_measurement_analysis_extract_mentions";
  assert.throws(
    () => assertTaskModelParity({ engine: "core", env: liveEnv({ [key]: "bedrock:haiku" }) }),
    /Bedrock/,
    "lane 에는 AWS SDK 가 없다 — 조용히 OpenRouter 로 떨어뜨리면 '코어와 같은 모델' 전제가 말없이 깨진다",
  );
  assert.throws(
    () => assertTaskModelParity({ engine: "core", env: liveEnv({ [key]: "haiku" }) }),
    /expected openrouter/,
  );
  assert.throws(
    () => assertTaskModelParity({ engine: "core", env: liveEnv({ [key]: "openrouter/gpt-5.6-luna" }) }),
    /expected openrouter/,
  );
});
