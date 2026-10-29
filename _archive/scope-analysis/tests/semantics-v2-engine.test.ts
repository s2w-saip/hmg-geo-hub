// 감성 판별 V2 **엔진 끝 배선** (벤더 재동기 core 64de80d2 = 코어 PR #710).
//
// `semantics-v2-accept.test.ts` 는 lane 쪽 수용(계약 키·json_schema 전송)을 본다. 이 파일은 그 위 한 층,
// **실제로 엔진을 돌려서** 아래를 판정한다. LLM 실비 0, invoker 는 스텁이다.
//   ① 티켓 옵션 `enableLlmMentionSemanticsV2: true` 가 벤더 순수 코드의 V2 분기까지 도달하는가
//   ② lane 엔진이 새 seam `deps.llm.semanticsV2` 를 주입하는가(없으면 현행 semantics 로 돌고
//      `measurement_analysis.semantics_v2.seam_missing` 경고만 남는다: 켰는데 V2 가 아닌 조용한 결손)
//   ③ V2 요청이 json_schema(mention_type 포함)와 코어 #710 시스템 프롬프트 원문으로 나가는가
//   ④ 결과 3필드가 멘션 `extractionMetadata` 에 실리고 답장 계약(`AnalysisReplySchema`)을 통과하는가
//   ⑤ V2 업스트림 전멸이 regex_line 폴백 completed 로 묻히지 않고 무음 실패 게이트에 걸리는가
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { AnalysisReplySchema, AnalysisTicketRequestSchema, toReplyUsage, type AnalysisTicketRequest } from "../contracts/index.ts";
import type { AnalysisContextSnapshot, AnalysisEngineInput, LaneLogger, LlmInvokeRequest, LlmInvokeResult } from "../worker/engine.ts";

// 벤더 `llm.ts` 는 백오프를 모듈 로드 시점 상수로 읽는다(stance-engine.test.ts 머리 주석과 같은 이유).
// 줄이는 것은 백오프뿐이고 재시도 횟수는 라이브 값 그대로 둔다.
process.env.MEASUREMENT_ANALYSIS_SEMANTICS_RETRY_BASE_MS = "1";
const { createCoreAnalysisEngine, buildPureLlmDeps } = await import("../worker/engines/core-engine.ts");
const { detectSilentLlmFailure } = await import("../worker/main.ts");
const { MENTION_SEMANTICS_V2_SYSTEM_PROMPT } = await import(
  "../packages/analysis-core/vendor/lib/measurement-analysis/llm.ts"
);

const fx = (name: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../contracts/fixtures/core-mirror/${name}`, import.meta.url)), "utf8"));

const ENVELOPE = fx("analysis-context.200-envelope.json") as { version: string; snapshot: Record<string, unknown> };
const TICKET = fx("analysis-ticket-request.v1.json") as Record<string, unknown>;

const ANSWER =
  "국내에서는 현대 투싼과 제네시스 GV70 을 많이 추천합니다. 현대 투싼은 연비가 좋지만 최근 품질 이슈가 반복된다는 후기가 있습니다.";
const EVIDENCE = "현대 투싼은 연비가 좋지만 최근 품질 이슈가 반복된다는 후기가 있습니다.";

/** 코어 #710 시스템 프롬프트(mention_type 포함판) sha256 앞 12자. 코어와 lane 이 같은 원문을 쓰는지의 지문이다. */
const V2_PROMPT_SHA12 = "fd539c3bfc22";

type V2Key = "absent" | true | false;

function ticketWith(v2: V2Key): AnalysisTicketRequest {
  const snapshot = ENVELOPE.snapshot as { catalog: { industry: unknown } };
  return AnalysisTicketRequestSchema.parse({
    ...TICKET,
    options: {
      ...(TICKET.options as Record<string, unknown>),
      // 결정적 경로 + semantics 축만 남긴다(V2 는 semantics 가 켜져 있어야 게이트가 열린다).
      enableLlmMentionExtraction: false,
      enableLlmPendingResolver: false,
      enableLlmMentionSemantics: true,
      enableShortAliasLlmGate: false,
      enableLlmAnswerBrandStance: false,
      ...(v2 === "absent" ? {} : { enableLlmMentionSemanticsV2: v2 }),
    },
    industry: snapshot.catalog.industry,
    context: { ...(TICKET.context as Record<string, unknown>), contextVersion: ENVELOPE.version },
    turn: { ...(TICKET.turn as Record<string, unknown>), answerText: ANSWER },
    citationHostsToClassify: [],
    deadlineAt: new Date(Date.now() + 6 * 3600_000).toISOString(),
  });
}

function capturingLog(): { log: LaneLogger; lines: Array<{ level: string; event: string }> } {
  const lines: Array<{ level: string; event: string }> = [];
  const push = (level: string) => (event: string) => {
    lines.push({ level, event });
  };
  return { log: { info: push("info"), warn: push("warn"), error: push("error") } as LaneLogger, lines };
}

type Behavior = "answer" | "throw";

function stubInvoker(behavior: Behavior): { llm: AnalysisEngineInput["llm"]; calls: LlmInvokeRequest[] } {
  const calls: LlmInvokeRequest[] = [];
  const llm = async (req: LlmInvokeRequest): Promise<LlmInvokeResult> => {
    calls.push(req);
    if (req.task !== "semantics") throw new Error(`semantics 외 콜이 나갔다: ${req.task}`);
    if (behavior === "throw") throw new Error("upstream 503");
    const payload = JSON.parse(req.prompt) as { mentions: Array<{ index: number }> };
    const isV2 = req.systemPrompt === MENTION_SEMANTICS_V2_SYSTEM_PROMPT;
    const text = JSON.stringify({
      semantics: payload.mentions.map((m) =>
        isV2
          ? { index: m.index, sentiment: "mixed", mention_type: "compare", evidence: EVIDENCE, reason: "장점과 품질 우려가 함께 제시됨" }
          : { index: m.index, sentiment: "positive", mention_type: "recommend" },
      ),
    });
    return {
      text,
      usage: {
        task: "semantics",
        poolKey: "openrouter",
        modelId: "openai/gpt-5.6-luna",
        inputTokens: 100,
        outputTokens: 100,
        costUsd: 0.001,
        costSource: "rate_table",
        outcome: "completed",
        latencyMs: 10,
        attempts: 1,
      } as LlmInvokeResult["usage"],
      displayModelId: "openai/gpt-5.6-luna",
      traceId: "t",
    };
  };
  return { llm, calls };
}

async function run(v2: V2Key, behavior: Behavior) {
  const { llm, calls } = stubInvoker(behavior);
  const { log, lines } = capturingLog();
  const engine = createCoreAnalysisEngine({ revision: "analysis-core@test" });
  const input = {
    ticket: ticketWith(v2),
    context: { contextVersion: ENVELOPE.version, ...(ENVELOPE.snapshot as Record<string, unknown>) } as AnalysisContextSnapshot,
    llm,
    log,
    signal: new AbortController().signal,
  } satisfies AnalysisEngineInput;
  const out = await engine.analyzeTurn(input);
  return { out, calls, lines, input, engine };
}

const V2_META_KEYS = ["sentiment_evidence", "sentiment_reason", "sentiment_source"] as const;

// ── seam 주입 ───────────────────────────────────────────────────────────────────

test("V2 seam: lane 라이브 deps 가 semanticsV2 를 주입한다", () => {
  const { llm } = stubInvoker("answer");
  const deps = buildPureLlmDeps({ llm, log: capturingLog().log, signal: new AbortController().signal } as unknown as AnalysisEngineInput);
  assert.equal(typeof deps.semanticsV2, "function", "semanticsV2 seam 이 비어 있다: 옵션을 켜도 현행 semantics 로 돈다");
});

// ── V2 on ──────────────────────────────────────────────────────────────────────

test("V2 on: 티켓 옵션 true 가 벤더 V2 분기까지 도달하고 요청이 json_schema + 코어 프롬프트 원문으로 나간다", async () => {
  const { calls, lines } = await run(true, "answer");
  assert.equal(
    lines.some((l) => l.event === "measurement_analysis.semantics_v2.seam_missing"),
    false,
    "seam_missing 경고가 났다: lane 이 semanticsV2 를 주입하지 않았다",
  );
  assert.ok(lines.some((l) => l.event === "measurement_analysis.semantics_v2.llm_start"), "V2 분기에 도달하지 않았다");
  assert.equal(lines.some((l) => l.event === "measurement_analysis.semantics.llm_start"), false, "V2 on 인데 현행 semantics 패스도 돌았다");

  assert.equal(calls.length, 1, `V2 콜이 1회여야 한다 (실제 ${calls.length})`);
  const req = calls[0]!;
  assert.equal(req.sourceTask, "measurement.analysis.mention_semantics");
  assert.equal(
    createHash("sha256").update(req.systemPrompt ?? "").digest("hex").slice(0, 12),
    V2_PROMPT_SHA12,
    "시스템 프롬프트가 코어 #710 원문이 아니다",
  );
  const js = req.jsonSchema as { name: string; strict: boolean; schema: { properties: { semantics: { items: { required: string[]; properties: Record<string, { enum?: string[] }> } } } } };
  assert.ok(js, "jsonSchema 가 lane 요청에서 사라졌다");
  assert.equal(js.name, "semantics");
  assert.equal(js.strict, true);
  const item = js.schema.properties.semantics.items;
  assert.deepEqual(item.required, ["index", "sentiment", "mention_type", "evidence", "reason"]);
  assert.deepEqual(item.properties.mention_type!.enum, ["mention_only", "recommend", "final_choice", "compare", "reject", "definition"]);
  const payload = JSON.parse(req.prompt) as { mentions: Array<{ line: string }> };
  assert.ok(payload.mentions.length > 0, "V2 대상(Brand·Product) 멘션이 0 이라 이 테스트가 아무것도 증명하지 않는다");
  assert.ok(payload.mentions.every((m) => typeof m.line === "string" && m.line.length > 0), "line 입력이 비었다");
});

test("V2 on: 결과 3필드가 멘션 extractionMetadata 에 실리고 답장 계약 strict 파싱을 통과한다", async () => {
  const { out, input, engine } = await run(true, "answer");
  const v2Mentions = out.turn.mentions.filter(
    (m) => (m.extractionMetadata as Record<string, unknown>).sentiment_source === "llm_semantics_v2",
  );
  assert.ok(v2Mentions.length > 0, "llm_semantics_v2 출처 멘션이 0 이다");
  for (const m of v2Mentions) {
    const meta = m.extractionMetadata as Record<string, unknown>;
    assert.equal(meta.sentiment_evidence, EVIDENCE, "원문 부분문자열 evidence 가 검증을 통과해 저장돼야 한다");
    assert.equal(meta.sentiment_reason, "장점과 품질 우려가 함께 제시됨");
    assert.equal(m.sentiment, "mixed", "V2 판정이 sentiment 를 덮지 않았다");
    assert.equal(meta.llm_mention_type, "compare");
  }
  for (const m of out.turn.mentions) {
    const meta = m.extractionMetadata as Record<string, unknown>;
    for (const k of V2_META_KEYS) assert.ok(Object.hasOwn(meta, k), `V2 on 턴의 멘션에 ${k} 가 없다`);
  }
  const turnMeta = out.turn.extractionMetadata as Record<string, unknown>;
  assert.equal(turnMeta.llm_mention_semantics_v2_enabled, true);
  assert.equal(turnMeta.llm_mention_semantics_v2_failed, false);

  const reply = AnalysisReplySchema.parse({
    version: 1,
    ticketId: input.ticket.ticketId,
    traceId: input.ticket.traceId,
    status: "completed",
    finishedAt: new Date().toISOString(),
    analysisVersion: input.ticket.analysisVersion,
    result: { turn: out.turn, citationClassifications: out.citationClassifications },
    evidence: {
      // 워커가 답장을 조립할 때와 같이 원장 행을 답장 계약 모양으로 좁힌다.
      llmUsage: out.llmUsage.map(toReplyUsage),
      runtime: { laneRevision: engine.revision, contextVersionUsed: input.context.contextVersion, parallelFlags: out.parallelFlags ?? {} },
    },
    deferred: null,
    failureReason: null,
    terminalReason: null,
  });
  const replied = reply.result!.turn.mentions.find(
    (m) => (m.extractionMetadata as Record<string, unknown>).sentiment_source === "llm_semantics_v2",
  );
  assert.ok(replied, "답장 파싱 후 V2 3필드가 사라졌다");
  assert.equal((replied.extractionMetadata as Record<string, unknown>).sentiment_evidence, EVIDENCE);
  assert.equal(detectSilentLlmFailure(out), null, "성공 턴이 무음 실패로 판정됐다");
});

// ── V2 off 동치 ────────────────────────────────────────────────────────────────

test("V2 off: 키 없음과 false 는 산출이 같고 현행 semantics 로 돌며 V2 키가 하나도 없다", async () => {
  const absent = await run("absent", "answer");
  const off = await run(false, "answer");
  for (const r of [absent, off]) {
    assert.equal(r.calls.length, 1);
    assert.notEqual(r.calls[0]!.systemPrompt, MENTION_SEMANTICS_V2_SYSTEM_PROMPT, "V2 off 인데 V2 프롬프트가 나갔다");
    assert.equal(Object.hasOwn(r.calls[0]!, "jsonSchema"), false, "V2 off 인데 json_schema 가 실렸다");
    assert.equal(r.lines.some((l) => l.event.startsWith("measurement_analysis.semantics_v2.")), false);
    for (const m of r.out.turn.mentions) {
      const meta = m.extractionMetadata as Record<string, unknown>;
      for (const k of V2_META_KEYS) assert.equal(Object.hasOwn(meta, k), false, `V2 off 인데 멘션에 ${k} 가 있다`);
    }
    const turnMeta = r.out.turn.extractionMetadata as Record<string, unknown>;
    assert.equal(Object.keys(turnMeta).some((k) => k.includes("semantics_v2")), false, "V2 off 인데 턴 진단 키가 생겼다");
  }
  assert.deepEqual(absent.out.turn.mentions, off.out.turn.mentions);
  assert.deepEqual(absent.out.turn.quality, off.out.turn.quality);
});

// ── 무음 실패 ──────────────────────────────────────────────────────────────────

test("V2 on + 업스트림 전멸: 턴은 regex_line 폴백으로 남지만 무음 실패 게이트가 사유를 돌려준다", async () => {
  const { out, calls } = await run(true, "throw");
  assert.ok(calls.length >= 1, "V2 를 시도조차 안 했다");
  const turnMeta = out.turn.extractionMetadata as Record<string, unknown>;
  assert.equal(turnMeta.llm_mention_semantics_v2_failed, true);
  assert.equal(turnMeta.llm_mention_semantics_failed, false, "전제: V2 턴은 현행 실패 키가 false 라 기존 게이트로는 안 보인다");
  assert.ok(
    out.turn.mentions.every((m) => (m.extractionMetadata as Record<string, unknown>).sentiment_source === "regex_line"),
    "전멸인데 LLM 출처가 남았다",
  );
  const reason = detectSilentLlmFailure(out);
  assert.ok(reason && reason.includes("llm_mention_semantics_v2_failed"), `V2 전멸이 게이트에 안 걸렸다: ${reason}`);
});
