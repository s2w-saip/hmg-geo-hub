// 감성 V2 **섀도 병행** 준비 (PR-L1). 코어 PR-C1 보다 **먼저** 배포된다.
//
// 정본: (내부 설계 문서) §3.2 · §4 · §5
//
// 이 파일이 지키는 명제는 넷이다.
//
//   ① 계약이 `enableLlmMentionSemanticsV2Shadow` 를 키 있음·없음 모두 받고, 없으면 파싱 결과에도
//      없다. `.strict()` 경계(오타 키·비불리언)는 그대로다.
//   ② 섀도 실패가 **티켓을 재시도로 돌리지 않는다**: `semanticsV2ShadowObservation` 이 계수만 하고,
//      `detectSilentLlmFailure` 는 섀도 키에 대해 아무것도 판정하지 않는다. 이것이 PR-L1 에서
//      가장 중요한 명제다 — 반대면 완주한 V0 분석을 다시 돌려 실비를 두 배로 쓴다(플랜 §2 원칙 2).
//   ③ 원장 태스크 `semantics_shadow` 가 계약 어휘·DB CHECK·lane 매핑까지 이어져 있다.
//   ④ `withTaskOverride` 가 **task 만** 바꾸고 원 요청을 변형하지 않는다(PR-L2 seam 배선의 부품).
//
// LLM 실비 0 — 이 파일은 순수 함수와 스키마만 부른다(엔진을 돌리지 않는다).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  AnalysisTaskSchema,
  AnalysisTicketRequestSchema,
  ResolvedAnalysisOptionsSchema,
  type AnalysisCallUsage,
} from "../contracts/index.ts";
import type { ClaudeRequest, ClaudeResponse } from "../packages/analysis-core/shims/llm-invoke.ts";
import type { AnalysisEngineOutput } from "../worker/engine.ts";
import { withTaskOverride } from "../worker/engines/core-engine.ts";
import { CORE_TASK_TO_LANE_TASK, laneTaskFor, routingTaskFor } from "../worker/llm-pools.ts";
import { GATED_LLM_LAYERS, detectSilentLlmFailure, semanticsV2ShadowObservation, stanceObservation } from "../worker/main.ts";

const CORE_MIRROR = fileURLToPath(new URL("../contracts/fixtures/core-mirror/", import.meta.url));
const SHADOW_CORE_TASK = "measurement.analysis.mention_semantics_shadow";

// ── ① 계약 수용 ──────────────────────────────────────────────────────────────────

const coreTicket = (): Record<string, unknown> =>
  JSON.parse(readFileSync(`${CORE_MIRROR}analysis-ticket-request.v1.json`, "utf8")) as Record<string, unknown>;
const live = (raw: Record<string, unknown>): Record<string, unknown> => ({
  ...raw,
  deadlineAt: new Date(Date.now() + 6 * 3600_000).toISOString(),
});

test("섀도 ① 키가 없는 티켓(코어 제출기 off = 라이브 전부)이 통과하고 **키 집합이 변하지 않는다**", () => {
  const raw = coreTicket();
  assert.equal(
    Object.hasOwn(raw.options as object, "enableLlmMentionSemanticsV2Shadow"),
    false,
    "코어 픽스처 모수가 바뀌었다 — 이 테스트가 증명하려는 창(코어 미배포)이 이미 끝났다",
  );
  const before = Object.keys(ResolvedAnalysisOptionsSchema.parse(raw.options)).sort();
  const parsed = AnalysisTicketRequestSchema.parse(live(raw));
  assert.equal(
    Object.hasOwn(parsed.options, "enableLlmMentionSemanticsV2Shadow"),
    false,
    "기본값을 주입하면 코어 픽스처와 키 집합이 갈린다(`.default(false)` 가 아니라 `.optional()` 인 이유)",
  );
  // 키 집합 전체가 불변이어야 한다 — 섀도 키 하나만 보면 다른 키가 같이 생긴 것을 못 본다.
  assert.deepEqual(Object.keys(parsed.options).sort(), before);
});

test("섀도 ① 키가 true·false 로 들어와도 통과하고 값이 보존된다", () => {
  const raw = coreTicket();
  for (const v of [true, false]) {
    const parsed = AnalysisTicketRequestSchema.parse({
      ...live(raw),
      options: { ...(raw.options as Record<string, unknown>), enableLlmMentionSemanticsV2Shadow: v },
    });
    assert.equal(parsed.options.enableLlmMentionSemanticsV2Shadow, v);
  }
});

test("섀도 ① 대체 모드 키와 **함께** 와도 둘 다 보존된다 (lane 은 우선순위를 판정하지 않는다)", () => {
  // 동시 true 면 대체가 이긴다는 규칙의 정본은 코어 순수 계층이다(플랜 §2 원칙 1). lane 이 여기서
  // 하나를 떨어뜨리면 그 판정이 두 곳이 되고, 코어가 규칙을 바꿀 때 lane 만 낡는다.
  const raw = coreTicket();
  const parsed = AnalysisTicketRequestSchema.parse({
    ...live(raw),
    options: {
      ...(raw.options as Record<string, unknown>),
      enableLlmMentionSemanticsV2: true,
      enableLlmMentionSemanticsV2Shadow: true,
    },
  });
  assert.equal(parsed.options.enableLlmMentionSemanticsV2, true);
  assert.equal(parsed.options.enableLlmMentionSemanticsV2Shadow, true);
});

test("섀도 ① .strict() 경계는 그대로다 (오타 키·비불리언 거부)", () => {
  const opts = coreTicket().options as Record<string, unknown>;
  for (const typo of ["enableLlmMentionSemanticsShadow", "enableLlmMentionSemanticsV2shadow", "enableLlmMentionSemanticV2Shadow"]) {
    assert.equal(ResolvedAnalysisOptionsSchema.safeParse({ ...opts, [typo]: true }).success, false, `${typo} 가 통과했다`);
  }
  for (const bad of ["true", 1, null]) {
    assert.equal(ResolvedAnalysisOptionsSchema.safeParse({ ...opts, enableLlmMentionSemanticsV2Shadow: bad }).success, false);
  }
  assert.equal(ResolvedAnalysisOptionsSchema.safeParse({ ...opts, enableLlmMentionSemanticsV2Shadow: true }).success, true);
});

// ── ② 관측 — 실패가 티켓을 재시도로 돌리지 않는다 ────────────────────────────────

/** `detectSilentLlmFailure`·관측 함수가 읽는 최소 입력. 엔진을 돌리지 않는다. */
function outWith(
  meta: Record<string, unknown>,
  llmUsage: Array<Pick<AnalysisCallUsage, "task" | "outcome">> = [],
): Pick<AnalysisEngineOutput, "turn" | "llmUsage"> {
  return {
    turn: { extractionMetadata: meta } as unknown as AnalysisEngineOutput["turn"],
    llmUsage: llmUsage as unknown as AnalysisEngineOutput["llmUsage"],
  };
}

test("섀도 ② 메타 키가 **없는** 턴(현재 라이브 창)은 관측 대상이 아니다", () => {
  // 코어 PR-C1 배포 전에는 이 키가 아예 없다. 예외 없이 조용한 no-op 이어야 한다 —
  // 안 켠 기능이 매 턴 지표를 만들면 분모가 오염된다.
  assert.equal(semanticsV2ShadowObservation(outWith({})), null);
  assert.equal(semanticsV2ShadowObservation(outWith({ llm_mention_semantics_enabled: true })), null);
  // `extractionMetadata` 자체가 없어도 던지지 않는다.
  assert.equal(
    semanticsV2ShadowObservation({
      turn: {} as unknown as AnalysisEngineOutput["turn"],
      llmUsage: [] as unknown as AnalysisEngineOutput["llmUsage"],
    }),
    null,
  );
});

test("섀도 ② enabled=false 턴도 관측 대상이 아니다", () => {
  assert.equal(semanticsV2ShadowObservation(outWith({ llm_mention_semantics_v2_shadow_enabled: false })), null);
});

test("섀도 ② enabled=true · 성공 턴은 분모 1 · 실패 0", () => {
  const obs = semanticsV2ShadowObservation(
    outWith({ llm_mention_semantics_v2_shadow_enabled: true, llm_mention_semantics_v2_shadow_failed: false }, [
      { task: "semantics", outcome: "completed" },
      { task: "semantics_shadow", outcome: "completed" },
    ]),
  );
  assert.ok(obs, "게이트 on 인데 관측이 null 이다");
  assert.equal(obs.semanticsShadowEnabled, 1);
  assert.equal(obs.semanticsShadowFailed, 0);
  assert.equal(obs.semanticsShadowCallsFailed, 0);
});

test("섀도 ② failed=true 는 **관측**되고, 콜 실패는 별도 축으로 센다", () => {
  const obs = semanticsV2ShadowObservation(
    outWith({ llm_mention_semantics_v2_shadow_enabled: true, llm_mention_semantics_v2_shadow_failed: true }, [
      { task: "semantics", outcome: "completed" },
      { task: "semantics_shadow", outcome: "failed" },
      { task: "semantics_shadow", outcome: "failed" },
    ]),
  );
  assert.ok(obs);
  assert.equal(obs.semanticsShadowFailed, 1, "실패가 관측되지 않으면 '켰는데 안 쌓인다' 를 아무도 못 본다");
  assert.equal(obs.semanticsShadowCallsFailed, 2);
});

test("섀도 ② V0 감성 콜 실패는 섀도 축에 **섞이지 않는다**(원장 태스크가 갈라진 이유)", () => {
  const obs = semanticsV2ShadowObservation(
    outWith({ llm_mention_semantics_v2_shadow_enabled: true, llm_mention_semantics_v2_shadow_failed: false }, [
      { task: "semantics", outcome: "failed" },
      { task: "semantics_shadow", outcome: "completed" },
    ]),
  );
  assert.ok(obs);
  assert.equal(obs.semanticsShadowCallsFailed, 0, "V0 실패가 섀도 실패로 계상되면 비용·품질 판정이 둘 다 틀어진다");
});

test("섀도 ② **핵심**: 섀도 전멸이 `detectSilentLlmFailure` 를 발화시키지 않는다 (티켓이 재시도로 안 돈다)", () => {
  // 게이트 목록에 넣었다면 여기서 사유 문자열이 나오고 워커가 턴 전체를 deferred(transient) 로
  // 되돌린다 — 플랜 §2 원칙 2 의 정반대이고, 완주한 V0 분석을 다시 돌려 실비만 두 배로 쓴다.
  const worst = outWith(
    {
      llm_mention_semantics_v2_shadow_enabled: true,
      llm_mention_semantics_v2_shadow_failed: true,
      // V0 는 정상 완주했다 — 이 턴은 completed 로 나가야 한다.
      llm_mention_semantics_enabled: true,
      llm_mention_semantics_failed: false,
    },
    // 섀도의 성공한 업스트림 콜이 **0** 인, 인프라 전멸 모양 그대로.
    [{ task: "semantics", outcome: "completed" }],
  );
  assert.equal(detectSilentLlmFailure(worst), null, "섀도 실패가 턴을 deferred 로 끌고 내려간다 — 게이트 목록에서 빼라");
  // 관측은 그래도 된다 — 조용히 넘어가는 것이 아니라 계수만 한다.
  assert.equal(semanticsV2ShadowObservation(worst)?.semanticsShadowFailed, 1);
});

test("섀도 ② **구조 단언**: 게이트 목록의 어떤 항목도 섀도 축을 집지 않는다", () => {
  // ⚠️ 행동 단언만으로는 부족했다(검증자 실측). 섀도를 `task: "semantics"` 로 끼워 넣은 변이는
  //    V0 의 성공한 `semantics` 콜이 원장에 있으면 `upstreamOk` 가 참이 되어 **행동 테스트를
  //    통과한다** — 그러고도 라이브에서는 V0 콜이 0행인 턴(멘션 0·게이트 off 등)에서 섀도 실패
  //    하나로 턴 전체가 deferred 가 된다. 그래서 **목록의 모양 자체**를 본다: 어떤 task 로
  //    넣든, 섀도 키를 집는 항목이 생기면 여기서 죽는다.
  for (const layer of GATED_LLM_LAYERS) {
    for (const key of [layer.enabledKey, layer.failedKey]) {
      assert.equal(
        key.includes("shadow"),
        false,
        `게이트 목록이 섀도 축(${key})을 집는다 — 섀도 실패가 턴을 deferred 로 끌고 내려간다(플랜 §2 원칙 2 위반)`,
      );
    }
  }
  // ── 목록 **전체의 스냅샷**. 크기만 세면 부족하다(검증자 실측).
  //
  // ⚠️ 초판은 `length === 4` 만 봤고, 그래서 **기존 항목의 `task` 를 바꾼 변이가 살아남았다**:
  //    대체 모드 V2 항목을 `task: "semantics"` → `"semantics_shadow"` 로 바꾸면 크기도 4 그대로고
  //    키에 shadow 도 안 들어가지만, 라이브에서는 대체 모드 V2 의 **콘텐츠 실패**(모델이 깨진
  //    JSON 을 최대 시도만큼 돌려준 경우 — 원장에 `semantics/completed` 가 남는다)를 인프라
  //    실패로 오판한다. 찾을 태스크가 `semantics_shadow` 로 바뀌어 성공한 콜을 못 찾기 때문이다.
  //    결과는 `deferred(transient)` → 완주한 분석을 버리고 같은 턴을 다시 유료로 돌린다.
  //    `detectSilentLlmFailure` 머리말의 "콘텐츠 실패는 코어 인라인 경로도 그대로 persist 한다"
  //    는 구분선이 그 변이에서 무너진다.
  //
  // ⚠️ **이 목록에 항목을 더하거나 고치는 PR 은 이 스냅샷을 함께 고치면서 그 의도를 설명해야
  //    한다.** 그것이 이 단언의 목적이다 — 게이트 목록은 "완주한 턴을 버릴지" 를 정하는 자리라
  //    조용한 변경이 가장 비싸다. 새 항목이 섀도 축이면 위 shadow 단언이 먼저 죽는다.
  assert.deepEqual(
    GATED_LLM_LAYERS.map((l) => ({ task: l.task, enabledKey: l.enabledKey, failedKey: l.failedKey })),
    [
      { task: "extract", enabledKey: "llm_mention_enabled", failedKey: "llm_mention_failed" },
      { task: "resolve", enabledKey: "llm_pending_resolver_enabled", failedKey: "llm_pending_resolver_failed" },
      { task: "semantics", enabledKey: "llm_mention_semantics_enabled", failedKey: "llm_mention_semantics_failed" },
      // 대체 모드 V2 — **원장 태스크는 `semantics` 다**(벤더 요청 task 가 `mention_semantics`).
      // 여기를 `semantics_shadow` 로 바꾸면 성공한 콜을 영영 못 찾아 콘텐츠 실패마다 deferred 가 된다.
      { task: "semantics", enabledKey: "llm_mention_semantics_v2_enabled", failedKey: "llm_mention_semantics_v2_failed" },
    ],
    "게이트 목록이 바뀌었다 — 스냅샷을 고치면서 '왜 완주한 턴을 버리는 조건을 바꾸는가' 를 PR 에 설명하라",
  );
});

test("섀도 ② 행동 단언(V0 콜 0행): 섀도 실패만으로는 deferred 가 되지 않는다", () => {
  // 위 구조 단언의 짝. `task: "semantics"` 변이는 **이 입력에서** 행동으로도 드러난다 —
  // 원장에 성공한 semantics 콜이 없기 때문이다(멘션 0 턴 등 정상 경로가 이 모양이다).
  const out = outWith(
    {
      llm_mention_semantics_v2_shadow_enabled: true,
      llm_mention_semantics_v2_shadow_failed: true,
      // V0 는 정상이다 — 게이트가 발화할 이유가 없다.
      llm_mention_semantics_enabled: true,
      llm_mention_semantics_failed: false,
    },
    [],
  );
  assert.equal(detectSilentLlmFailure(out), null, "섀도 실패가 턴을 deferred 로 끌고 내려간다 — 게이트 목록에서 빼라");
});

test("섀도 ② **대체 모드** V2 게이트는 무변경이다 (섀도 때문에 무르게 만들지 않았다)", () => {
  // 대체 모드는 semantics 패스를 갈아치우므로 전멸이 곧 감성 데이터 전멸이다 — 이쪽은 여전히
  // deferred 로 가야 한다. 두 축은 키 이름이 다르고(`…_v2_enabled` vs `…_v2_shadow_enabled`)
  // 의미도 반대다.
  const replaced = outWith({ llm_mention_semantics_v2_enabled: true, llm_mention_semantics_v2_failed: true }, []);
  assert.notEqual(detectSilentLlmFailure(replaced), null, "대체 모드 V2 게이트가 사라졌다");
  // 그리고 대체 모드 키는 섀도 관측을 켜지 않는다(키 이름 오독 방지).
  assert.equal(semanticsV2ShadowObservation(replaced), null);
});

test("섀도 ② 스탠스 관측과 서로 간섭하지 않는다 (같은 메타에서 각자 자기 축만 본다)", () => {
  const both = outWith({
    llm_answer_brand_stance_enabled: true,
    llm_answer_brand_stance_failed: true,
    llm_mention_semantics_v2_shadow_enabled: true,
    llm_mention_semantics_v2_shadow_failed: false,
  });
  assert.equal(stanceObservation(both)?.stanceFailed, 1);
  assert.equal(semanticsV2ShadowObservation(both)?.semanticsShadowFailed, 0);
});

// ── ③ 원장 태스크 ────────────────────────────────────────────────────────────────

test("섀도 ③ `semantics_shadow` 가 계약 어휘·lane 매핑까지 이어져 있다", () => {
  assert.ok(AnalysisTaskSchema.options.includes("semantics_shadow"), "계약 어휘에 없으면 원장 행이 스키마에서 거부된다");
  assert.equal(laneTaskFor(SHADOW_CORE_TASK), "semantics_shadow");
  assert.equal(CORE_TASK_TO_LANE_TASK[SHADOW_CORE_TASK], "semantics_shadow");
  // V0 감성과 **다른** 원장 값이어야 한다 — 같으면 수용 기준 6(비용 분리)이 성립하지 않는다.
  assert.notEqual(laneTaskFor("measurement.analysis.mention_semantics"), laneTaskFor(SHADOW_CORE_TASK));
  // 그런데 라우팅은 같다.
  assert.equal(routingTaskFor(SHADOW_CORE_TASK), "measurement.analysis.mention_semantics");
});

// DB CHECK 와의 대조는 `stance-contract.test.ts` 의 "task 어휘의 두 사본이 같다" 와
// "마이그레이션을 실제로 적용하면 CHECK 가 받는다"(PGlite)가 **어휘 전체**에 대해 본다 —
// 여기서 같은 것을 다시 적으면 사본이 셋이 된다.

// ── ④ withTaskOverride (PR-L2 부품) ──────────────────────────────────────────────

const claudeReq = (): ClaudeRequest => ({
  task: "measurement.analysis.mention_semantics",
  model: "haiku",
  system: "semantics",
  messages: [{ role: "user", content: '{"mentions":[]}' }],
  maxTokens: 9600,
  temperature: 0,
});

const noopResponse: ClaudeResponse = { text: "{}", tokenUsage: { input: 1, output: 1 }, costUsd: 0, modelId: "m", traceId: "t" };

test("섀도 ④ withTaskOverride 는 task **만** 바꾼다", async () => {
  const seen: ClaudeRequest[] = [];
  const wrapped = withTaskOverride(async (r) => {
    seen.push(r);
    return noopResponse;
  }, SHADOW_CORE_TASK);
  const req = claudeReq();
  await wrapped(req);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.task, SHADOW_CORE_TASK);
  // 나머지 필드는 글자 그대로 같다 — 프롬프트가 달라지면 "같은 조건으로 다시 채점" 이 거짓이 된다.
  assert.deepEqual({ ...seen[0]!, task: req.task }, req);
});

test("섀도 ④ 원 요청을 **변형하지 않는다** (V0 경로와 객체를 공유해도 안전하다)", async () => {
  const req = claudeReq();
  const snapshot = JSON.parse(JSON.stringify(req)) as ClaudeRequest;
  await withTaskOverride(async () => noopResponse, SHADOW_CORE_TASK)(req);
  assert.deepEqual(req, snapshot, "제자리에서 고치면 V0 콜의 원장 태스크까지 오염된다");
});

test("섀도 ④ 응답과 예외는 그대로 통과한다 (래퍼가 실패를 삼키지 않는다)", async () => {
  const passed = await withTaskOverride(async () => ({ ...noopResponse, text: "ok" }), SHADOW_CORE_TASK)(claudeReq());
  assert.equal(passed.text, "ok");
  await assert.rejects(
    () =>
      withTaskOverride(async () => {
        throw new Error("upstream 503");
      }, SHADOW_CORE_TASK)(claudeReq()),
    /upstream 503/,
    "래퍼가 예외를 먹으면 섀도 실패가 '성공한 빈 결과' 로 둔갑한다",
  );
});
