// WU6 — 스탠스 **송신 경로**를 엔진 끝에서 판정한다.
//
// `stance-contract.test.ts` 는 스키마를 본다. 이 파일은 그 위 한 층 — **실제로 엔진을 돌려서**
// ① 게이트가 켜지면 스탠스 콜이 lane invoker 를 타고 나가는가
// ② 그 콜이 콜 원장(`analysis_call_usage`) 행으로 `task="stance"` + flash-lite 단가로 남는가
// ③ 스탠스 invoker 가 죽어도 **턴 답장이 살아남는가**(FR6 실패 격리)
// 를 본다. LLM 실비 0 — invoker 는 스텁이다.
//
// ⚠️ 이 파일이 있어야 하는 이유는 WU6 에서 실제로 물린 결함이다: 코어 task 문자열 → lane task
//    매핑이 **두 군데** 손으로 적혀 있었고(`worker/llm-pools.ts` · `core-engine.ts`), WU2 가 한쪽만
//    넓혔다. 스키마 테스트는 전부 초록이었다 — 계약에는 아무 문제가 없었으니까.
//
//    그리고 그 결함은 **시끄럽게 죽지 않는다.** `toLaneRequest` 가 던지는 예외를 벤더 `llm.ts` 가
//    catch 해 `failed:true` 로 접고 순수 계층도 try/catch 로 받으므로, 남는 것은 **티켓
//    completed · 스탠스 0건 · 원장 0행**이다. 배포는 성공으로 보이고 데이터만 안 쌓인다.
//    `deferred` 도 `output_contract` 도 아니라서 **엔진을 돌려 보는 테스트만** 잡을 수 있었다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { AnalysisTicketRequestSchema, type AnalysisTicketRequest } from "../contracts/index.ts";
import type { AnalysisContextSnapshot, AnalysisEngineInput, LaneLogger, LlmInvokeRequest, LlmInvokeResult } from "../worker/engine.ts";
import { lookupRate } from "../worker/llm-pools.ts";
import { detectSilentLlmFailure, stanceObservation } from "../worker/main.ts";

// ⚠️ **정적 import 가 아니라 동적 import 다 — 그리고 그 이유가 이 줄 위의 env 설정이다.**
//    벤더 `llm.ts` 는 재시도 백오프를 **모듈 로드 시점의 상수**로 읽는다
//    (`const STANCE_RETRY_BASE_MS = ... process.env... ?? 400`, llm.ts:814). 정적 import 면
//    그 상수가 이 파일의 첫 줄보다 **먼저** 굳어서 `process.env` 를 나중에 바꿔도 소용이 없다
//    (실측: 그렇게 했더니 실패 격리 케이스가 여전히 3.5s/건이었다 — 설정한 줄은 있는데 아무
//    효과가 없는, 가장 나쁜 종류의 "고쳤다"). 로드 전에 세우고 그 다음 import 한다.
//
//    ⚠️ 줄이는 것은 **백오프뿐**이다. 재시도 **횟수**(4회)는 건드리지 않는다 — 그건 실패
//       경로의 모양 자체를 바꿔서, 테스트가 라이브와 다른 경로를 보게 만든다.
process.env.MEASUREMENT_ANALYSIS_STANCE_RETRY_BASE_MS = "1";
const { createCoreAnalysisEngine } = await import("../worker/engines/core-engine.ts");

const fx = (name: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../contracts/fixtures/core-mirror/${name}`, import.meta.url)), "utf8"));

const ENVELOPE = fx("analysis-context.200-envelope.json") as { version: string; snapshot: Record<string, unknown> };
const TICKET = fx("analysis-ticket-request.v1.json") as Record<string, unknown>;

/** 스탠스가 실제로 돌려면 `valid_answer` + 멘션 ≥ 1 이어야 한다(순수 계층 게이트). */
const ANSWER =
  "국내에서는 현대 투싼과 제네시스 GV70 을 많이 추천합니다. 현대 투싼은 연비가 좋지만 최근 품질 이슈가 반복된다는 후기가 있습니다.";

const STANCE_MODEL = "google/gemini-3.1-flash-lite";

function ticketWith(stanceOn: boolean): AnalysisTicketRequest {
  const snapshot = ENVELOPE.snapshot as { catalog: { industry: unknown } };
  return AnalysisTicketRequestSchema.parse({
    ...TICKET,
    options: {
      ...(TICKET.options as Record<string, unknown>),
      // 결정적 경로만 남긴다 — 이 파일이 보는 것은 스탠스 축 하나다.
      enableLlmMentionExtraction: false,
      enableLlmPendingResolver: false,
      enableLlmMentionSemantics: false,
      enableShortAliasLlmGate: false,
      enableLlmAnswerBrandStance: stanceOn,
    },
    industry: snapshot.catalog.industry,
    context: { ...(TICKET.context as Record<string, unknown>), contextVersion: ENVELOPE.version },
    turn: { ...(TICKET.turn as Record<string, unknown>), answerText: ANSWER },
    // ⚠️ **비운다.** 코어 픽스처는 미분류 호스트를 싣고 있고, `resolveCitationDomain` 은 실패해도
    //    던지지 않고 `method:"default"` 로 돌려주므로(설계) 스텁이 거부해도 **조용히 통과**한다.
    //    그러면 `calls` 에 citation 콜이 섞여 "스탠스 콜이 몇 번 나갔나" 를 셀 수 없다.
    citationHostsToClassify: [],
    deadlineAt: new Date(Date.now() + 6 * 3600_000).toISOString(),
  });
}

const silent: LaneLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** 스탠스 응답을 흉내내는 lane invoker. 부른 태스크를 기록한다. */
function stubInvoker(behavior: {
  onStance: (brands: string[]) => { text: string } | { throw: Error };
}): { llm: AnalysisEngineInput["llm"]; calls: LlmInvokeRequest[] } {
  const calls: LlmInvokeRequest[] = [];
  const llm = async (req: LlmInvokeRequest): Promise<LlmInvokeResult> => {
    calls.push(req);
    if (req.task !== "stance") throw new Error(`stance 외 콜이 나갔다: ${req.task}`);
    const payload = JSON.parse(req.prompt) as { brands_to_rate?: string[] };
    const out = behavior.onStance(payload.brands_to_rate ?? []);
    if ("throw" in out) throw out.throw;
    const inputTokens = 943;
    const outputTokens = 1062;
    const rate = lookupRate(`openrouter/${STANCE_MODEL}`)!;
    return {
      text: out.text,
      usage: {
        task: "stance",
        poolKey: "openrouter",
        modelId: STANCE_MODEL,
        inputTokens,
        outputTokens,
        // 라이브 경로와 같은 산식으로 채운다(`worker/invoker.ts` 가 하는 일).
        costUsd: (inputTokens / 1000) * rate.inputPer1k + (outputTokens / 1000) * rate.outputPer1k,
        costSource: "rate_table",
        outcome: "completed",
        latencyMs: 1200,
        attempts: 1,
      } as LlmInvokeResult["usage"],
      displayModelId: STANCE_MODEL,
      traceId: "t",
    };
  };
  return { llm, calls };
}

async function run(stanceOn: boolean, behavior: Parameters<typeof stubInvoker>[0]) {
  const { llm, calls } = stubInvoker(behavior);
  const engine = createCoreAnalysisEngine({ revision: "analysis-core@test" });
  const out = await engine.analyzeTurn({
    ticket: ticketWith(stanceOn),
    context: { contextVersion: ENVELOPE.version, ...(ENVELOPE.snapshot as Record<string, unknown>) } as AnalysisContextSnapshot,
    llm,
    log: silent,
    signal: new AbortController().signal,
  } satisfies AnalysisEngineInput);
  return { out, calls };
}

const stanceJson = (brands: string[]): string =>
  JSON.stringify({
    stances: brands.map((b) => ({
      brand: b,
      stance: "mixed",
      confidence: 0.8,
      evidence: "연비가 좋지만 최근 품질 이슈가 반복된다",
      reason_ko: "장점과 품질 우려가 함께 제시됨",
    })),
  });

// ── 게이트 ──────────────────────────────────────────────────────────────────────

test("WU6 — 게이트 off 면 스탠스 콜이 **한 번도 나가지 않고** answerStances 는 빈 배열이다", async () => {
  const { out, calls } = await run(false, {
    onStance: () => {
      throw new Error("게이트가 꺼졌는데 스탠스가 불렸다");
    },
  });
  assert.deepEqual(calls, [], "게이트 off 인데 LLM 콜이 나갔다");
  // (인용 분류를 비웠으므로 이 배열은 스탠스 콜만 담는다 — 위 `citationHostsToClassify: []` 참조)
  assert.deepEqual(out.turn.answerStances, []);
  assert.equal(out.turn.failed, false);
  assert.deepEqual(out.llmUsage, [], "콜이 없으면 원장 행도 0 이어야 한다");
});

test("WU6 — 게이트 on 이면 스탠스 콜이 나가고 답장에 스탠스가 실린다 (task 매핑 포함)", async () => {
  const { out, calls } = await run(true, { onStance: (brands) => ({ text: stanceJson(brands) }) });

  // ⚠️ 이 단언이 WU6 에서 실제로 물린 결함을 잡는다 — `core-engine.ts` 의 task 매핑에 stance 가
  //    없으면 `AnalysisContractError: vendored code asked for an unknown task` 로 여기서 죽는다.
  assert.equal(calls.length, 1, `스탠스 콜이 1회여야 한다 — 재시도가 돌았다면 응답이 파싱 안 된 것이다 (실제 ${calls.length})`);
  assert.equal(calls[0]!.task, "stance");
  assert.equal(calls[0]!.sourceTask, "measurement.analysis.answer_brand_stance", "코어 task 문자열이 원장·env 키의 재료다");

  assert.ok(out.turn.answerStances.length > 0, "스탠스가 답장에 안 실렸다");
  const s = out.turn.answerStances[0]!;
  assert.ok(["positive", "negative", "mixed", "neutral"].includes(s.stance));
  assert.equal(typeof s.brandLabel, "string");
  assert.ok(s.entityId.length > 0);
  assert.equal(out.turn.failed, false);
});

// ── 비용 원장 (요구 4) ───────────────────────────────────────────────────────────

test("WU6 — 스탠스 콜이 원장 행으로 남고 단가가 flash-lite 로 계산된다 (costUsd non-null)", async () => {
  const { out } = await run(true, { onStance: (brands) => ({ text: stanceJson(brands) }) });
  const rows = out.llmUsage.filter((u) => u.task === "stance");
  assert.equal(rows.length, 1, "task='stance' 원장 행이 1개여야 한다");
  const row = rows[0]!;
  assert.equal(row.modelId, STANCE_MODEL);
  // A10 — `costUsd=null` 이면 장부에 구멍이 난다. 0 도 아니어야 한다(0 은 위조다).
  assert.ok(row.costUsd !== null && row.costUsd !== undefined && row.costUsd > 0, `costUsd 가 비었다: ${row.costUsd}`);
  // 단가표가 실제로 flash-lite 를 쓴다 — 값까지 대조한다(키만 보면 "있는데 틀린 단가" 를 놓친다).
  const rate = lookupRate(`openrouter/${STANCE_MODEL}`);
  assert.deepEqual(rate, { inputPer1k: 0.00025, outputPer1k: 0.0015 });
  const expected = (943 / 1000) * rate!.inputPer1k + (1062 / 1000) * rate!.outputPer1k;
  assert.ok(Math.abs(row.costUsd! - expected) < 1e-9, `단가 산식이 다르다: ${row.costUsd} vs ${expected}`);
});

// ── 실패 격리 (요구 5 · FR6) ─────────────────────────────────────────────────────

test("WU6 — 스탠스 invoker 가 **100% 실패해도** 턴 답장이 살아남는다 (FR6)", async () => {
  const { out, calls } = await run(true, { onStance: () => ({ throw: new Error("upstream 503") }) });

  // 핵심: 턴이 실패하지 않는다. 스탠스만 비고 멘션·품질은 그대로 나간다.
  assert.equal(out.turn.failed, false, "스탠스 실패가 턴을 죽였다 — FR6 위반");
  assert.deepEqual(out.turn.answerStances, [], "실패했으면 빈 배열이어야 한다(부분 결과를 지어내지 않는다)");
  assert.ok(out.turn.mentions.length > 0, "멘션이 사라졌다 — 실패 격리가 아니라 전멸이다");
  assert.equal(out.turn.quality.qualityState, "valid_answer");
  assert.ok(calls.length >= 1, "스탠스를 시도조차 안 했다면 이 테스트는 아무것도 증명하지 않는다");

  // 실패가 **관측 가능**해야 한다 — 조용히 0건이 되면 "스탠스가 원래 없는 턴" 과 구분이 안 된다.
  const meta = out.turn.extractionMetadata as Record<string, unknown>;
  const stanceKeys = Object.keys(meta).filter((k) => k.includes("stance"));
  assert.ok(stanceKeys.length > 0, `실패 계수가 extractionMetadata 에 없다 (keys=${Object.keys(meta).join(",")})`);
});

test("WU6 — 스탠스 실패 턴과 게이트 off 턴의 **멘션·품질이 동일하다** (A7 동치성)", async () => {
  const off = await run(false, {
    onStance: () => {
      throw new Error("불리면 안 된다");
    },
  });
  const failed = await run(true, { onStance: () => ({ throw: new Error("upstream 503") }) });
  assert.deepEqual(failed.out.turn.mentions, off.out.turn.mentions, "스탠스 실패가 멘션을 바꿨다");
  assert.deepEqual(failed.out.turn.quality, off.out.turn.quality);
  assert.deepEqual(failed.out.turn.candidates, off.out.turn.candidates);
});

// ── 관측 (요구 F4) ──────────────────────────────────────────────────────────────

test("F4 — 게이트 off 턴은 **관측 대상이 아니다**(분모에 안 들어간다)", async () => {
  const { out } = await run(false, {
    onStance: () => {
      throw new Error("불리면 안 된다");
    },
  });
  assert.equal(stanceObservation(out), null, "안 켠 기능이 매 턴 지표를 만들면 분모가 오염된다");
});

test("F4 — 성공 턴은 분모 1 · 실패 0 으로 관측된다", async () => {
  const { out } = await run(true, { onStance: (brands) => ({ text: stanceJson(brands) }) });
  const obs = stanceObservation(out);
  assert.ok(obs, "게이트 on 인데 관측이 null 이다");
  assert.equal(obs.stanceEnabled, 1);
  assert.equal(obs.stanceFailed, 0);
  assert.equal(obs.stanceCallsFailed, 0);
  assert.ok(obs.stances > 0, "스탠스가 났는데 계수가 0 이다");
});

test("F4 — 실패 턴은 분모 1 · 실패 1 로 관측되고 **deferred 로 번지지 않는다**", async () => {
  const { out } = await run(true, { onStance: () => ({ throw: new Error("upstream 503") }) });
  const obs = stanceObservation(out);
  assert.ok(obs);
  assert.equal(obs.stanceEnabled, 1);
  assert.equal(obs.stanceFailed, 1, "실패가 관측되지 않으면 '켰는데 안 쌓인다' 를 아무도 못 본다");
  assert.equal(obs.stances, 0);

  // ⚠️ **이것이 F4 의 핵심 제약이다.** 스탠스를 `GATED_LLM_LAYERS` 에 넣었다면
  //    `detectSilentLlmFailure` 가 사유를 돌려주고 워커가 턴 전체를 `deferred` 로 되돌린다 —
  //    FR6(스탠스 실패는 턴을 실패시키지 않는다)의 정반대이고, 완주한 분석을 다시 돌려 실비만
  //    두 배로 쓴다. null 이어야 한다.
  assert.equal(
    detectSilentLlmFailure(out),
    null,
    "스탠스 실패가 deferred 판정으로 번졌다 — GATED_LLM_LAYERS 에 넣지 마라",
  );
});
