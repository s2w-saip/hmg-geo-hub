// 골든 게이트 — **"이식 = 복사" 를 lane 쪽에서 증명한다** (스펙 §6 A1 · §6.4 게이트 ②의 논리).
//
// ── 무엇을 증명하나
//
//   코어 `lib/measurement-analysis/pure/analyze-turn.equivalence.test.ts` 가 단언하는 것과
//   **같은 13개 기대 출력**(`__fixtures__/pure/*.json`)을, lane 이 **티켓 계약을 통과시켜**
//   재현한다. 입력은 코어와 같은 픽스처이고 LLM 은 코어와 같은 결정적 스텁이므로,
//   두 경로의 차이는 **오직 경계 번역**(티켓 역직렬화 · 컨텍스트 스냅샷 재구성 · 옵션 파싱)뿐이다.
//   바이트가 다르면 그 차이는 전부 `worker/engines/core-engine.ts` 의 결함이다.
//
// ── 왜 LLM 실비가 0 인가
//
//   스텁이 붙는 자리가 **`analyzeTurnPure` 의 `deps.llm` seam** — 코어 동치성 테스트가 붙는
//   그 자리다(`CoreEngineOptions.llmDepsOverride`). 네트워크를 타지 않는다.
//   공급자 풀·재시도·타임아웃은 별도 테스트(`tests/invoker-pool.test.ts`)가 **녹화 fetch** 로 본다.
//
// ── 픽스처는 수정 금지다
//
//   `packages/analysis-core/vendor/**` 는 sha256 으로 핀돼 있다(`check:analysis-core-pin`).
//   기대 출력이 바뀌어야 하는 변경이 오면 **코어를 고치고 재동기**한다 — 여기서 값을 맞추면
//   그 순간 이 테스트가 아무것도 증명하지 않는다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { AnalysisLlmDeps } from "../packages/analysis-core/vendor/lib/measurement-analysis/pure/deps.ts";
import {
  loadPureEquivalenceCases,
  stableStringify,
  type PureEquivalenceCase,
} from "../packages/analysis-core/vendor/lib/measurement-analysis/pure/analyze-turn.fixtures.ts";
import { AnalysisReplySchema, AnalysisTicketRequestSchema, type AnalysisTicketRequest } from "../contracts/index.ts";
import type { AnalysisContextSnapshot, AnalysisEngineInput, LlmInvoker } from "../worker/engine.ts";
import { AnalysisContractError, AnalysisDeferrable } from "../worker/engine.ts";
import { buildTurnContext, createCoreAnalysisEngine, runCoreTurnPure } from "../worker/engines/core-engine.ts";
import { replyForError } from "../worker/main.ts";
import { resolveEngine } from "../worker/registry.ts";

const FIXTURES = fileURLToPath(
  new URL("../packages/analysis-core/vendor/lib/measurement-analysis/__fixtures__/pure/", import.meta.url),
);

const WORKSPACE = "44444444-4444-4444-8444-444444444444";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const CONTEXT_VERSION = `${PROJECT}:0a1b2c3d4e5f6071`;

function expectedJson(name: string): string {
  return readFileSync(`${FIXTURES}${name}.json`, "utf8");
}

/** LLM 을 절대 부르지 않는다 — 부르면 그 자체가 실패다(스텁은 `deps.llm` seam 에 붙는다). */
const forbiddenInvoker: LlmInvoker = async () => {
  throw new Error("golden gate must not reach the lane invoker — LLM stubs live at the pure deps seam");
};

/**
 * 픽스처 케이스 → 티켓. **기대 출력의 `sourceTurnHash` 를 티켓에 싣는다.**
 *
 * 픽스처 입력은 코어 인라인 (a) 경로(`rawResponse`)이고 lane 은 (b) 경로(`sourceTurnHash` 에코)다.
 * 코어가 계산한 그 해시를 티켓에 실으면 에코값이 같아져 **산출이 통째로 바이트 동일**해진다 —
 * 즉 이 한 줄이 D4(해시의 주인은 코어)를 테스트로 못박는다. 다른 값을 실으면 그 필드만
 * 달라져야 하고, 그것도 아래에서 따로 단언한다.
 */
function ticketFor(
  c: PureEquivalenceCase,
  sourceTurnHash: string,
  /** 산업 스코프 override — 골든 13개가 전부 `source:"project"` 라 그 축을 못 본다(아래 전용 테스트). */
  industry?: { ids: string[]; name: string | null; source: string },
): AnalysisTicketRequest {
  const opts = c.context.options;
  return AnalysisTicketRequestSchema.parse({
    version: 1,
    ticketId: "6f3d6f7a-2f0e-5a2f-9c1b-0d4a3b5c6d7e",
    traceId: "b2b5f0a1-7c3d-4e5f-9a8b-1c2d3e4f5a6b",
    lineage: {
      workspaceId: WORKSPACE,
      projectId: PROJECT,
      queryRunId: c.input.trace.queryRunId,
      promptRunId: c.input.trace.promptRunId,
      turnRunId: c.input.turnRunId,
      turnIndex: c.input.turnIndex,
      attemptNumber: 1,
    },
    analysisVersion: opts.analysisVersion,
    // 계약이 코어 정본과 같아져 **실물 `IndustryScopeContext` 를 그대로** 싣는다 — 초판처럼
    // `ids[0]`·`source` 를 합성하면 코어 인라인 경로와 입력이 갈린다(프롬프트 변형 게이트).
    industry: industry ?? { ids: c.context.industry.ids, name: c.context.industry.name, source: c.context.industry.source },
    // `ResolvedAnalysisOptions` 는 코어가 확정해 보낸다 — 픽스처의 옵션을 그대로 실어
    // **JSON 왕복을 태운다**(엔진이 `AnalysisOptionsSchema` 로 되파싱하는 경로를 실제로 지난다).
    options: JSON.parse(JSON.stringify(opts)) as Record<string, unknown>,
    turn: {
      turnRunId: c.input.turnRunId,
      turnIndex: c.input.turnIndex,
      promptText: c.input.promptText,
      answerText: c.input.answerText ?? "",
      sourceTurnHash,
      target: c.input.trace.target,
      region: c.input.trace.region ?? "KR",
    },
    context: { ref: `https://core.invalid/api/internal/analysis-context/${WORKSPACE}/${PROJECT}/${CONTEXT_VERSION}`, contextVersion: CONTEXT_VERSION },
    citationHostsToClassify: [],
    deadlineAt: new Date(Date.now() + 6 * 3600_000).toISOString(),
    priority: "scheduled",
    callbackUrl: null,
  });
}

/**
 * 픽스처 컨텍스트 → 스냅샷. `grouping` 은 **함수를 가진 인덱스**라 직렬화되지 않으므로
 * 코어가 원시 규칙 배열(`compiled`)로 내리고 lane 이 되세운다(스펙 §5.4) — 그 왕복을 여기서 탄다.
 * ⚠️ `JSON.parse(JSON.stringify(...))` 를 태우는 것이 요점이다: 실제 경로가 HTTP 본문이므로
 *    직렬화에서 죽는 값(함수·undefined)이 있으면 여기서 먼저 드러나야 한다.
 */
function snapshotFor(c: PureEquivalenceCase): AnalysisContextSnapshot {
  const wire = JSON.parse(
    JSON.stringify({
      // ⚠️ **스냅샷의 catalog 는 `{entities, industry}` 다**(D-6). 순수 픽스처의
      //    `c.context.catalog` 는 순수 코드가 받는 **배열**이라 그대로 실으면 코어가 실제로
      //    보내는 바이트와 다른 것을 태우게 된다 — 그 간극이 라이브 295건을 종결시켰다.
      //    코어 `toAnalysisContextSnapshot` 은 `SharedAnalysisContext.catalog`
      //    (= `loadOntologyCatalog` 의 `{entities, industry}`)를 그대로 싣는다.
      catalog: { entities: c.context.catalog, industry: c.context.industry },
      rels: c.context.rels,
      grouping: c.context.grouping.compiled,
      trackedAugmentTargets: c.context.trackedAugmentTargets,
    }),
  ) as Record<string, unknown>;
  return {
    contextVersion: CONTEXT_VERSION,
    catalog: wire.catalog,
    rels: wire.rels,
    grouping: wire.grouping,
    trackedAugmentTargets: wire.trackedAugmentTargets,
  };
}

function engineInput(
  c: PureEquivalenceCase,
  sourceTurnHash: string,
  industry?: { ids: string[]; name: string | null; source: string },
): AnalysisEngineInput {
  return {
    ticket: ticketFor(c, sourceTurnHash, industry),
    context: snapshotFor(c),
    llm: forbiddenInvoker,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    signal: new AbortController().signal,
  };
}

const cases = loadPureEquivalenceCases();

test("13 골든 케이스가 lane 경로에서 코어 기대 출력과 바이트 동일 (A1)", async () => {
  assert.equal(cases.length, 13, "6축 × astral(12) + 품질 게이트(1) = 13");
  const seen = new Map<string, string>();
  for (const c of cases) {
    const expected = expectedJson(c.name);
    const hash = (JSON.parse(expected) as { sourceTurnHash: string }).sourceTurnHash;
    const { analysis } = await runCoreTurnPure(engineInput(c, hash), () => c.llm);
    const actual = `${stableStringify(analysis)}\n`;
    if (actual !== expected) {
      let i = 0;
      while (i < actual.length && i < expected.length && actual[i] === expected[i]) i += 1;
      assert.fail(
        `${c.name}: offset ${i} 에서 갈림\n  expected …${expected.slice(Math.max(0, i - 80), i + 80)}\n  actual   …${actual.slice(Math.max(0, i - 80), i + 80)}`,
      );
    }
    seen.set(actual, c.name);
  }
  // 코어 테스트의 U-3 와 같은 교차 대조 — 같은 바이트를 내는 두 케이스가 있으면 축을 하나 못 덮은 것이다.
  assert.equal(seen.size, 13, "중복 산출 케이스가 있다 — 축 분리가 깨졌다");
});

test("(b) 경로: 티켓의 sourceTurnHash 가 그대로 에코된다 — lane 은 해시를 계산할 수 없다 (D4)", async () => {
  const c = cases[0]!;
  const ECHO = "d".repeat(64);
  const { analysis } = await runCoreTurnPure(engineInput(c, ECHO), () => c.llm);
  assert.equal(analysis.sourceTurnHash, ECHO, "요청값 에코가 아니다");

  // 그리고 **그 필드 하나만** 달라야 한다. 다른 것이 함께 움직이면 (b) 경로가 산출을 바꾼 것이다.
  const expected = JSON.parse(expectedJson(c.name)) as Record<string, unknown>;
  const actual = JSON.parse(stableStringify(analysis)) as Record<string, unknown>;
  delete expected.sourceTurnHash;
  delete actual.sourceTurnHash;
  assert.equal(stableStringify(actual), stableStringify(expected));
});

// ── 골든이 **볼 수 없는 축**: promptText ────────────────────────────────────────────
//
// (b) 경로에서 `promptText` 는 산출물 어디에도 안 남는다 — `sourceTurnHash` 는 코어가 계산해
// 보낸 값을 에코할 뿐이고(D4), `analysisForPersist` 에도 프롬프트 필드가 없다. 그런데 이 값은
// **LLM 페이로드에는 들어간다**(`llm.ts:276`·`:554`·`:761` 의 `prompt_text`). 즉:
//
//     `buildTurnInput` 에서 promptText 를 answerText 로 바꿔 써도 **골든 13개는 전부 통과한다.**
//
// 그러면 라이브에서는 세 LLM 태스크가 전부 "프롬프트 자리에 답변이 들어간" 상태로 돌고,
// 증상은 예외가 아니라 **조용한 정확도 저하**다(스펙 §4.3 이 경고하는 멀티턴 오배치와 같은 형태).
// 골든은 바이트 동일만 보므로 이 축은 **여기서 따로 못박아야 한다.**
test("(b) 경로: promptText 가 LLM 페이로드까지 턴의 프롬프트 **그대로** 흐른다 — 골든이 못 보는 축", async () => {
  const seams = { extract: 0, resolve: 0, semantics: 0 };
  /** 프롬프트가 답변과 실제로 다른 관측 — 변이가 잡히려면 이게 1개 이상이어야 한다. */
  let discriminating = 0;

  for (const c of cases) {
    const expected = expectedJson(c.name);
    const hash = (JSON.parse(expected) as { sourceTurnHash: string }).sourceTurnHash;
    const input = engineInput(c, hash);
    const wantPrompt = input.ticket.turn.promptText;
    const answerText = input.ticket.turn.answerText;

    const check = (seam: keyof typeof seams, got: string | null | undefined): void => {
      seams[seam] += 1;
      assert.equal(
        got,
        wantPrompt,
        `${c.name}/${seam}: LLM 이 받은 promptText 가 티켓의 턴 프롬프트와 다르다 ` +
          `(got=${JSON.stringify(String(got).slice(0, 60))} want=${JSON.stringify(String(wantPrompt).slice(0, 60))})`,
      );
      if (typeof wantPrompt === "string" && wantPrompt.length > 0 && wantPrompt !== answerText) discriminating += 1;
    };
    // 스텁은 **그대로 위임**한다 — 관측만 끼우고 반환값을 바꾸지 않으므로 산출은 골든과 같아야 한다.
    const spy: AnalysisLlmDeps = {
      extract: (i) => (check("extract", i.promptText), c.llm.extract(i)),
      resolve: (i) => (check("resolve", i.promptText), c.llm.resolve(i)),
      semantics: (i) => (check("semantics", i.promptText), c.llm.semantics(i)),
    };

    const { analysis } = await runCoreTurnPure(input, () => spy);
    // 관측을 끼웠는데 바이트가 달라지면 스텁이 투명하지 않은 것이다 — 위 단언의 전제가 깨진다.
    assert.equal(`${stableStringify(analysis)}\n`, expected, `${c.name}: 관측 스텁이 산출을 바꿨다`);
  }

  // 세 seam 을 **전부** 지나야 한다. 한 축이라도 0 이면 그 축은 이 테스트가 지키지 못한다
  // (프롬프트가 안 흘러도 통과하는 vacuous pass 를 막는 것이 요점이다).
  for (const [seam, n] of Object.entries(seams)) assert.ok(n > 0, `${seam} seam 을 한 번도 안 지났다 — 축이 비었다`);
  assert.ok(discriminating > 0, "프롬프트와 답변이 같은 케이스뿐이라 promptText←answerText 변이를 구분할 수 없다");
});

test("엔진 산출이 좁혀진 reply 계약을 통과한다 — 좁힘이 실제 산출을 거부하지 않는지", async () => {
  const engine = createCoreAnalysisEngine({ revision: "analysis-core@test" });
  for (const c of cases) {
    const hash = (JSON.parse(expectedJson(c.name)) as { sourceTurnHash: string }).sourceTurnHash;
    const input = engineInput(c, hash);
    const out = await createCoreAnalysisEngine({ revision: "analysis-core@test", llmDepsOverride: () => c.llm }).analyzeTurn(input);
    const reply = AnalysisReplySchema.parse({
      version: 1,
      ticketId: input.ticket.ticketId,
      traceId: input.ticket.traceId,
      status: "completed",
      finishedAt: new Date().toISOString(),
      analysisVersion: input.ticket.analysisVersion,
      result: { turn: out.turn, citationClassifications: out.citationClassifications },
      evidence: {
        llmUsage: out.llmUsage,
        runtime: { laneRevision: engine.revision, contextVersionUsed: input.context.contextVersion, parallelFlags: out.parallelFlags ?? {} },
      },
      deferred: null,
      failureReason: null,
      terminalReason: null,
    });
    assert.equal(reply.result?.turn.turnRunId, input.ticket.turn.turnRunId, `${c.name}: 턴 좌표가 티켓과 달라졌다`);
    assert.equal(reply.result?.turn.sourceTurnHash, hash, `${c.name}: 에코가 깨졌다`);
    // ⚠️ 버전 4종은 **계약에서 빠졌다**(코어 정본이 그 넷을 빼고 `.strict()`). 순수 산출물에는
    //    여전히 있고 persist 는 코어가 자기 `options` 값을 쓴다 — 계약 변환이 그 넷을 떨구는지
    //    여기서 단언한다. 다시 실으면 코어 reply 파싱이 통째로 튕긴다.
    const expected = JSON.parse(expectedJson(c.name)) as Record<string, string>;
    assert.ok(expected.analysisVersion, `${c.name}: 순수 산출물에는 버전이 있어야 한다(모수 확인)`);
    for (const k of ["analysisVersion", "promptVersion", "parserVersion", "resolverVersion"]) {
      assert.equal(
        Object.hasOwn(reply.result?.turn ?? {}, k),
        false,
        `${c.name}: reply.result.turn 에 ${k} 가 남아 있다 — 코어 AnalysisReplyTurnSchema 는 .strict() 다`,
      );
    }
    // 스텁 seam 이라 LLM 콜 원장은 비어 있어야 한다 — 여기서 행이 생기면 실제 호출이 샌 것이다.
    assert.deepEqual(out.llmUsage, [], `${c.name}: 골든 경로에서 LLM 콜이 발생했다`);
  }
});

test("ANALYSIS_ENGINE=core 가 이제 실제 엔진을 준다 — 스텁 폴백은 여전히 없다", () => {
  const core = resolveEngine("core", "0.0.0-dev");
  assert.equal(core.kind, "core");
  // `laneRevision` 은 **어느 순수 코드 바이트로 돌았나**를 말해야 한다(스펙 §6.1 런타임 관측).
  assert.match(core.revision, /^analysis-core@[0-9a-f]{12}$/, `laneRevision 이 벤더 핀을 담지 않는다: ${core.revision}`);
  assert.throws(() => resolveEngine("camoufox", "x"), /unknown ANALYSIS_ENGINE/);
  assert.equal(resolveEngine("stub", "0.0.0-dev").kind, "stub");
});

test("컨텍스트 스냅샷이 깨져 있으면 죽는다 — 빈 분석을 completed 로 올리지 않는다", async () => {
  const c = cases[0]!;
  const input = engineInput(c, "a".repeat(64));
  // G3-1 e2e 가 쓰던 자리표시자 모양(`{catalog:{entities:[]}, grouping:{rules:[]}}`)이 정확히
  // 이 경우다 — 4키는 있지만 **모양이 계약과 다르다**. 조용히 빈 카탈로그로 돌면
  // "분석은 성공, 멘션 0건" 이 된다.
  const broken: AnalysisEngineInput = {
    ...input,
    context: { contextVersion: CONTEXT_VERSION, catalog: { entities: [] }, rels: [], grouping: { rules: [] }, trackedAugmentTargets: [] },
  };
  await assert.rejects(
    () => createCoreAnalysisEngine({ revision: "r", llmDepsOverride: () => c.llm }).analyzeTurn(broken),
    /context snapshot .* is malformed/,
  );
});

test("스냅샷 malformed 는 **transient deferred** 다 — permanent 로 표본을 태우지 않는다 (D-6)", async () => {
  // 2026-09-13 06:26Z: lane 스키마가 코어 실물과 달라 잔여 **295건이 전부 failed(permanent)** 로
  // 사라졌다. 판정문이 "코어 데이터가 깨졌다" 를 전제했는데 실제 원인은 lane 이었다.
  // 배포 한 번이면 같은 티켓이 성공하는 종류이므로, 그 회수 경로를 남긴다.
  const c = cases[0]!;
  const input = engineInput(c, "a".repeat(64));
  const warned: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const broken: AnalysisEngineInput = {
    ...input,
    log: { info: () => {}, warn: () => {}, error: (event, fields = {}) => warned.push({ event, fields }) },
    // D-6 그 자체의 모양: catalog 이 **배열**(순수 코드 형태)로 온 경우.
    context: { ...input.context, catalog: c.context.catalog as unknown },
  };
  const err = await createCoreAnalysisEngine({ revision: "r", llmDepsOverride: () => c.llm })
    .analyzeTurn(broken)
    .then(
      () => null,
      (e: unknown) => e,
    );
  assert.ok(err instanceof AnalysisDeferrable, `종결 등급이 deferred 가 아니다: ${String(err)}`);
  assert.equal(err.failureClass, "transient");
  assert.ok(err.retryAfterMs > 0);
  assert.ok(!(err instanceof AnalysisContractError), "permanent 경로로 돌아갔다 — 표본이 통째로 사라진다");
  assert.match(err.message, /context snapshot .* is malformed/);

  // 정산 등급까지 본다 — 분류가 정책을 결정하는 자리는 `replyForError` 다.
  const rep = replyForError({
    ticketId: "11111111-1111-4111-8111-111111111111",
    traceId: "44444444-4444-4444-8444-444444444444",
    analysisVersion: "2026-09-13",
    attempt: 1,
    error: err,
  });
  assert.equal(rep.status, "deferred");
  assert.equal(rep.terminalReason, null);
  assert.equal(rep.deferred?.failureClass, "transient");

  // 그리고 **조용하지 않다** — 무엇이 왜 깨졌는지 로그에 남는다(값은 싣지 않는다).
  const line = warned.find((l) => l.event === "analysis_lane.context_snapshot_malformed");
  assert.ok(line, `malformed 로그가 없다 (events=${warned.map((l) => l.event).join(",")})`);
  assert.equal(line.fields.contextVersion, CONTEXT_VERSION);
  assert.ok(Array.isArray(line.fields.issues) && line.fields.issues.length > 0);
});

test("티켓 industry 와 스냅샷 catalog.industry 가 갈리면 **warn 만** 하고 티켓을 쓴다", async () => {
  const c = cases[0]!;
  const input = engineInput(c, "c".repeat(64));
  const lines: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const withDrift: AnalysisEngineInput = {
    ...input,
    log: { info: () => {}, warn: (event, fields = {}) => lines.push({ event, fields }), error: () => {} },
    context: {
      ...input.context,
      catalog: {
        entities: c.context.catalog,
        // 스냅샷은 **버전 캐시**라 프로젝트 산업이 바뀐 직후 옛 값을 들고 있을 수 있다.
        industry: { ids: ["00000000-0000-0000-0000-0000000000ff"], name: "Home Appliances", source: "env" },
      },
    },
  };
  const ctx = buildTurnContext(withDrift);
  // 규약은 그대로 — **티켓이 정본**이다(`industry`·`options` 는 캐시에 섞지 않는다).
  assert.deepEqual(ctx.industry, {
    ids: c.context.industry.ids,
    name: c.context.industry.name,
    source: c.context.industry.source,
  });
  const warn = lines.find((l) => l.event === "analysis_lane.industry_mismatch");
  assert.ok(warn, `mismatch warn 이 없다 (events=${lines.map((l) => l.event).join(",")})`);
  assert.deepEqual(warn.fields.snapshotIds, ["00000000-0000-0000-0000-0000000000ff"]);
  assert.equal(warn.fields.snapshotSource, "env");
  assert.equal(warn.fields.ticketSource, c.context.industry.source);
  // ⚠️ 산업 **이름**은 로그에 싣지 않는다(고객 산업은 값이다 — ids·source 로 추적에 충분하다).
  assert.equal("snapshotName" in warn.fields, false);
  assert.equal(JSON.stringify(warn.fields).includes("Home Appliances"), false);
});

test("industry 가 같으면 mismatch warn 이 없다 — 모수 확인", () => {
  const c = cases[0]!;
  const input = engineInput(c, "d".repeat(64));
  const lines: string[] = [];
  buildTurnContext({ ...input, log: { info: () => {}, warn: (e) => lines.push(e), error: () => {} } });
  assert.equal(lines.filter((e) => e === "analysis_lane.industry_mismatch").length, 0);
});

test("grouping 규칙이 스냅샷 왕복에서 살아남는다 — 죽으면 롤업이 조용히 달라진다", async () => {
  const c = cases[0]!;
  const input = engineInput(c, "b".repeat(64));
  const grouping = { entityRules: [{ sourceEntityId: WORKSPACE, level: "brand", rollupEntityId: PROJECT }], surfaceRules: [] };
  const withRules: AnalysisEngineInput = { ...input, context: { ...input.context, grouping } };
  // 규칙이 있어도 이 케이스의 멘션은 그 엔티티를 안 쓰므로 산출은 같아야 한다 —
  // **파싱이 통과하는지**가 요점이다(모양이 틀리면 위 테스트처럼 죽는다).
  const { analysis } = await runCoreTurnPure(withRules, () => c.llm);
  assert.ok(analysis.quality.qualityState.length > 0);
});

// ── 콜 원장이 **실패한 콜까지** 잡는가 ────────────────────────────────────────────
//
// 벤더 `llm.ts` 는 invoker 예외를 **잡아서** `failed: true` 결과로 바꾼다 — 즉 LLM 이 다 죽어도
// 티켓은 `completed` 로 끝난다(`llm_mention_failed: true` 로 표시될 뿐). 그 경로에서 실패한 콜의
// 실비가 장부에 안 남으면 **낭비 비용이 통째로 증발**한다(0003 `wasted_cost_usd` 계산 불가).

test("LLM 이 전부 5xx 여도 티켓은 completed 지만, 실패한 콜은 전부 원장에 남는다", async () => {
  const prevKey = process.env.OPENROUTER_API_KEY;
  const prevModel = process.env.LLM_TASK_MODEL_measurement_analysis_extract_mentions;
  process.env.OPENROUTER_API_KEY = "test-or";
  process.env.LLM_TASK_MODEL_measurement_analysis_extract_mentions = "openrouter/openai/gpt-5.6-luna";
  try {
    const { createPoolInvoker } = await import("../worker/invoker.ts");
    const { PoolHealth, loadPools } = await import("../worker/llm-pools.ts");
    // B 축(extract 가 실제로 도는 케이스)을 쓴다.
    const c = cases.find((x) => x.name === "b-extract-merge")!;
    const hash = (JSON.parse(expectedJson(c.name)) as { sourceTurnHash: string }).sourceTurnHash;
    let calls = 0;
    const failing = (async (): Promise<Response> => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: "upstream down" } }), { status: 503, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const input: AnalysisEngineInput = {
      ...engineInput(c, hash),
      llm: createPoolInvoker({
        pools: loadPools().filter((p) => process.env[p.apiKeyEnv]),
        health: new PoolHealth(),
        log: { info: () => {}, warn: () => {}, error: () => {} },
        sink: () => {},
        fetchImpl: failing,
        maxAttempts: () => 2,
        sleep: async () => {},
      }),
    };
    // 스텁 주입 없이 **진짜 벤더 경로**로 돈다 — 프롬프트 조립까지 지나 invoker 에서 죽는다.
    const out = await createCoreAnalysisEngine({ revision: "analysis-core@test" }).analyzeTurn(input);

    assert.equal(out.turn.extractionMetadata.llm_mention_failed, true, "벤더 코드가 실패를 삼켜 completed 로 끝나는 경로가 맞다");
    assert.ok(calls >= 2, `재시도가 안 돌았다(calls=${calls})`);
    assert.equal(out.llmUsage.length, calls, "실패한 업스트림 콜 수만큼 원장 행이 있어야 한다");
    for (const row of out.llmUsage) {
      assert.notEqual(row.outcome, "completed");
      assert.equal(row.httpStatus, 503);
      assert.equal(row.costUsd, null, "실패 콜 비용은 미계측(null)이지 0 이 아니다");
    }
  } finally {
    if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prevKey;
    if (prevModel === undefined) delete process.env.LLM_TASK_MODEL_measurement_analysis_extract_mentions;
    else process.env.LLM_TASK_MODEL_measurement_analysis_extract_mentions = prevModel;
  }
});

test("ANALYSIS_ENGINE=core + 활성 풀 0 이면 **기동 시점에** 죽는다 — 큐를 끌어다 태우지 않는다", async () => {
  const { createLaneInvokerFactory } = await import("../worker/invoker.ts");
  const { Semaphore } = await import("../worker/concurrency.ts");
  const saved = ["OPENROUTER_API_KEY", "OPENAI_API_KEY", "GOOGLE_AI_API_KEY"].map((k) => [k, process.env[k]] as const);
  for (const [k] of saved) delete process.env[k];
  try {
    const args = {
      semaphore: new Semaphore(1),
      acquireTimeoutMs: 1000,
      requestTimeoutMs: 1000,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    };
    assert.throws(() => createLaneInvokerFactory({ ...args, engine: "core" }), /requires at least one provider pool/);
    // 스텁 엔진은 LLM 을 안 부르므로 풀을 요구하지 않는다.
    assert.equal(typeof createLaneInvokerFactory({ ...args, engine: "stub" }), "function");
  } finally {
    for (const [k, v] of saved) if (v !== undefined) process.env[k] = v;
  }
});

test("엔진이 죽어도 이미 나간 콜은 예외에 실려 원장까지 간다 (worker/main.ts usageFromError 계약)", async () => {
  const prevKey = process.env.OPENROUTER_API_KEY;
  const prevModel = process.env.LLM_TASK_MODEL_measurement_analysis_extract_mentions;
  process.env.OPENROUTER_API_KEY = "test-or";
  process.env.LLM_TASK_MODEL_measurement_analysis_extract_mentions = "openrouter/openai/gpt-5.6-luna";
  try {
    const { createPoolInvoker } = await import("../worker/invoker.ts");
    const { PoolHealth, loadPools } = await import("../worker/llm-pools.ts");
    const { usageFromError, normalizeCallUsage } = await import("../worker/main.ts");
    const c = cases.find((x) => x.name === "b-extract-merge")!;
    const hash = (JSON.parse(expectedJson(c.name)) as { sourceTurnHash: string }).sourceTurnHash;
    const base = engineInput(c, hash);
    const invoke = createPoolInvoker({
      pools: loadPools().filter((p) => process.env[p.apiKeyEnv]),
      health: new PoolHealth(),
      log: { info: () => {}, warn: () => {}, error: () => {} },
      sink: () => {},
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: { message: "down" } }), { status: 503, headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
      maxAttempts: () => 1,
      sleep: async () => {},
    });
    // extract 는 5xx 로 실패하지만 벤더 코드가 삼켜 `failed:true` 로 끝난다(= 원장 행 1개 발생).
    // 그 **뒤에** 신호를 끊어 인용 분류 단계에서 엔진이 죽게 만든다 → 예외가 그 행을 들고 가야 한다.
    const ac = new AbortController();
    const input: AnalysisEngineInput = {
      ...base,
      llm: async (req, signal) => {
        const out = await invoke(req, signal);
        return out;
      },
      ticket: { ...base.ticket, citationHostsToClassify: ["unknown-host-for-llm.example"] },
      signal: ac.signal,
    };
    // extract 한 번이 끝난 뒤 끊는다.
    setTimeout(() => ac.abort(new Error("drain mid-flight")), 60);
    let caught: unknown;
    try {
      await createCoreAnalysisEngine({ revision: "r" }).analyzeTurn(input);
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, "끊긴 신호에서 엔진이 통과했다");
    const carried = usageFromError(caught);
    assert.ok(carried.length >= 1, `예외가 콜 원장을 안 들고 왔다 (rows=${carried.length}) — 실패 턴이 공짜로 보인다`);
    for (const row of carried) {
      const n = normalizeCallUsage(row);
      assert.ok(["completed", "retried", "failed", "failed_over", "drained"].includes(n.outcome), `알 수 없는 outcome: ${n.outcome}`);
      assert.notEqual(n.outcome, "completed", "전부 5xx 인데 completed 행이 있다");
      assert.equal(n.costUsd, null, "실패 콜 비용은 미계측(null)이어야 한다");
    }
  } finally {
    if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prevKey;
    if (prevModel === undefined) delete process.env.LLM_TASK_MODEL_measurement_analysis_extract_mentions;
    else process.env.LLM_TASK_MODEL_measurement_analysis_extract_mentions = prevModel;
  }
});

// ── 골든이 **볼 수 없는 축 ②**: industry ─────────────────────────────────────────
//
// 골든 13개는 **전부 `industry.source === "project"`** 이고, 케이스에 따라 `ids` 는 0~1개다.
// 게다가 스텁이 `deps.llm` seam 에 붙으므로 산업이 무엇이든 **반환값이 같다** — 즉:
//
//     `buildTurnContext` 가 `ids` 를 첫 개로 자르든, `source` 를 `"project"` 로 위조하든,
//     `name` 을 떨어뜨리든 **골든 13개는 5/5 로 전부 통과한다.**
//
// 그런데 이 셋은 조용히 틀리는 축이다:
//   · `industry.name` 은 프롬프트 변형 게이트의 입력이다(`pure/analyze-turn.ts:204,225`
//     `industryName` → `isAutomotiveIndustryName`). 값이 갈리면 **코어 인라인 경로와 다른
//     프롬프트로 다른 분석**을 한다 — 가전 워크스페이스가 Automotive 온톨로지로 분석된
//     2026-07-10 사고가 정확히 이 축이다(`industry-context.ts` 머리말).
//   · `ids` 복수는 tracked-brand 휴리스틱의 정상 산출이고, `source` 는 `env`·`tracked_brands`
//     일 수 있다. 초판 core-engine 이 그 둘을 **합성**했다(`ids:[id]` · `source:"project"`).
//
// 그래서 여기서 **LLM 없이** 순수 코드 입력을 직접 본다.
const NON_PROJECT_INDUSTRY = { ids: ["3f7a2c81-9d40-4e16-b5c2-8a0e7d1f4b69", "aa11bb22-cc33-4d44-8e55-ff6677889900"], name: null, source: "tracked_brands" } as const;

test("industry 는 티켓에서 순수 컨텍스트로 **deep-equal 그대로** 간다 — 합성·절단·위조 0 (LLM 불요)", () => {
  const c = cases[0]!;
  const input = engineInput(c, "e".repeat(64), { ...NON_PROJECT_INDUSTRY, ids: [...NON_PROJECT_INDUSTRY.ids] });

  // ① 계약이 실물 타입을 그대로 싣는다(`ids` 복수 · `name: null` · `source != "project"`).
  assert.deepEqual(input.ticket.industry, { ids: [...NON_PROJECT_INDUSTRY.ids], name: null, source: "tracked_brands" });

  // ② 경계 번역기가 그것을 **한 글자도 안 바꾸고** 순수 코드에 넘긴다.
  //    `ids.slice(0,1)`·`source:"project"` 위조·`name` 소실이 전부 여기서 죽는다.
  const ctx = buildTurnContext(input);
  assert.deepEqual(ctx.industry, input.ticket.industry, "buildTurnContext 가 industry 를 바꿔 넘겼다");
  assert.equal(ctx.industry.ids.length, 2, "ids 가 잘렸다 — tracked-brand 휴리스틱은 복수를 낸다");
  assert.notEqual(ctx.industry, input.ticket.industry, "같은 객체를 넘기면 순수 코드가 티켓을 변조할 수 있다");

  // ③ 네 가지 source 어휘 전부. 하나라도 `"project"` 로 접히면 실패한다.
  for (const source of ["project", "env", "tracked_brands", "none"] as const) {
    const i = engineInput(c, "e".repeat(64), { ids: ["x1"], name: "Home Appliances", source });
    assert.equal(buildTurnContext(i).industry.source, source, `source=${source} 가 보존되지 않았다`);
    assert.equal(buildTurnContext(i).industry.name, "Home Appliances");
  }
});

test("industry.name 이 **LLM 페이로드까지** 그대로 흐른다 — 프롬프트 변형 게이트의 입력이다", async () => {
  // extract 가 실제로 도는 축을 쓴다. 스텁은 관측만 끼우고 반환값을 안 바꾸므로 산출은 골든과 같다.
  const c = cases.find((x) => x.name === "b-extract-merge")!;
  const expected = expectedJson(c.name);
  const hash = (JSON.parse(expected) as { sourceTurnHash: string }).sourceTurnHash;
  // 골든 픽스처의 산업과 **다른** 이름을 쓴다 — 같으면 변이(name 소실·원본 참조)를 구분 못 한다.
  const WANT = "Home Appliances";
  assert.notEqual(c.context.industry.name, WANT, "모수 확인: 픽스처와 다른 이름이어야 판별력이 있다");

  const seen: Array<string | null | undefined> = [];
  const input = engineInput(c, hash, { ids: ["x1", "x2"], name: WANT, source: "env" });
  const spy: AnalysisLlmDeps = {
    extract: (i) => (seen.push(i.industryName), c.llm.extract(i)),
    resolve: (i) => (seen.push(i.industryName), c.llm.resolve(i)),
    semantics: (i) => c.llm.semantics(i),
  };
  const { analysis } = await runCoreTurnPure(input, () => spy);

  assert.ok(seen.length > 0, "industryName 을 받는 seam 을 한 번도 안 지났다 — 축이 비었다(vacuous pass)");
  for (const got of seen) assert.equal(got, WANT, `LLM 이 받은 industryName 이 티켓과 다르다: ${JSON.stringify(got)}`);
  // 그리고 **산출 바이트는 그대로다** — industry 는 `analysisForPersist` 에 남지 않는다.
  // 이게 곧 "골든이 이 축을 못 본다"의 증명이기도 하다.
  assert.equal(`${stableStringify(analysis)}\n`, expected, "산업만 바꿨는데 산출이 달라졌다 — 전제가 깨졌다");
});

// ── D-6: 미러 봉투 픽스처를 **엔진이 끝까지 소비한다** ────────────────────────────
//
//   D-6 이 숨은 이유가 바로 "픽스처를 파서만 통과시켰다" 는 것이다 — 봉투 픽스처가 lane 저작
//   이라 lane 의 틀린 가정(`catalog` 이 배열)을 그대로 재생했고, 캐시 테스트는 4키 존재만 봤다.
//   그래서 여기서는 픽스처를 **컨텍스트로 실제 주입해 분석을 돌린다**: 카탈로그가 순수 코드까지
//   닿지 않으면 결정적 매칭이 0 이 되어 이 테스트가 깨진다.
//   LLM 실비 0 — 옵션의 LLM 층을 전부 끄고, deps 는 **불리면 실패**하는 스텁이다.

const MIRROR_ENVELOPE = JSON.parse(
  readFileSync(fileURLToPath(new URL("../contracts/fixtures/core-mirror/analysis-context.200-envelope.json", import.meta.url)), "utf8"),
) as { version: string; snapshot: Record<string, unknown> };

const MIRROR_TICKET = JSON.parse(
  readFileSync(fileURLToPath(new URL("../contracts/fixtures/core-mirror/analysis-ticket-request.v1.json", import.meta.url)), "utf8"),
) as Record<string, unknown>;

/** 불리면 그 자체가 실패 — 이 테스트는 결정적 경로만 탄다. */
const noLlm: AnalysisLlmDeps = {
  extract: () => {
    throw new Error("LLM must not be called — 결정적 경로만 도는 테스트다");
  },
  resolve: () => {
    throw new Error("LLM must not be called");
  },
  semantics: () => {
    throw new Error("LLM must not be called");
  },
};

test("미러 봉투 픽스처를 컨텍스트로 **엔진이 실제 소비한다** — 카탈로그가 순수 코드까지 닿는다 (D-6)", async () => {
  const snapshot = MIRROR_ENVELOPE.snapshot as {
    catalog: { entities: Array<{ id: string; canonicalName: string; aliases: Array<{ alias: string }> }>; industry: { ids: string[]; name: string | null; source: string } };
  };
  const brand = snapshot.catalog.entities.find((e) => e.canonicalName === "Hyundai");
  assert.ok(brand, "픽스처에 기준 엔티티가 없다 — 모수 확인");

  const options = {
    ...(MIRROR_TICKET.options as Record<string, unknown>),
    // LLM 층을 끈다: 이 테스트가 보는 것은 **결정적 매칭이 카탈로그를 봤는가** 하나다.
    enableLlmMentionExtraction: false,
    enableLlmPendingResolver: false,
    enableLlmMentionSemantics: false,
    enableShortAliasLlmGate: false,
  };
  const ticket = AnalysisTicketRequestSchema.parse({
    ...MIRROR_TICKET,
    options,
    industry: snapshot.catalog.industry,
    context: { ...(MIRROR_TICKET.context as Record<string, unknown>), contextVersion: MIRROR_ENVELOPE.version },
    turn: {
      ...(MIRROR_TICKET.turn as Record<string, unknown>),
      answerText: "국내에서는 현대 투싼과 제네시스 GV70 을 많이 추천합니다. 최종 추천은 현대 투싼입니다.",
    },
    deadlineAt: new Date(Date.now() + 6 * 3600_000).toISOString(),
  });

  const input: AnalysisEngineInput = {
    ticket,
    // **봉투에서 꺼낸 스냅샷 그대로** — 캐시가 워커에 넘기는 것과 같은 값이다.
    context: { contextVersion: MIRROR_ENVELOPE.version, ...(MIRROR_ENVELOPE.snapshot as Record<string, unknown>) } as AnalysisContextSnapshot,
    llm: forbiddenInvoker,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    signal: new AbortController().signal,
  };

  const out = await createCoreAnalysisEngine({ revision: "analysis-core@fixture", llmDepsOverride: () => noLlm }).analyzeTurn(input);

  // ① 엔진이 끝까지 돌았다(계약을 통과하는 턴이 나왔다).
  assert.equal(out.turn.turnRunId, ticket.turn.turnRunId);
  assert.equal(out.turn.failed, false);
  assert.equal(out.turn.quality.qualityState, "valid_answer");

  // ② **카탈로그가 순수 코드까지 닿았다** — 결정적 매칭이 픽스처의 엔티티를 찾았다.
  //    `catalog.entities` 를 안 펴고 객체를 그대로 넘기면 여기서 0 이 된다(D-6 의 지문).
  const meta = out.turn.extractionMetadata as Record<string, unknown>;
  assert.ok(Number(meta.known_matches) > 0, `결정적 매칭이 0 이다 — 카탈로그가 안 닿았다 (meta=${JSON.stringify(meta).slice(0, 300)})`);
  assert.ok(
    out.turn.mentions.some((m) => m.entityId === brand.id),
    `픽스처 엔티티(${brand.canonicalName})가 멘션에 없다 — 카탈로그가 안 닿았다`,
  );
  // ③ LLM 은 한 번도 안 불렸다(원장 행 0).
  assert.equal(out.llmUsage.length, 0);
});

test("미러 봉투 픽스처의 스냅샷이 엔진 스키마를 통과한다 — 4키·엔티티 필드까지 (파서 층)", () => {
  const ctx = buildTurnContext({
    ticket: AnalysisTicketRequestSchema.parse({
      ...MIRROR_TICKET,
      context: { ...(MIRROR_TICKET.context as Record<string, unknown>), contextVersion: MIRROR_ENVELOPE.version },
      deadlineAt: new Date(Date.now() + 6 * 3600_000).toISOString(),
    }),
    context: { contextVersion: MIRROR_ENVELOPE.version, ...(MIRROR_ENVELOPE.snapshot as Record<string, unknown>) } as AnalysisContextSnapshot,
    llm: forbiddenInvoker,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    signal: new AbortController().signal,
  });
  // 순수 코드가 받는 것은 **배열**이다(`store.ts:569` 와 같은 자리에서 편다).
  assert.ok(Array.isArray(ctx.catalog), "catalog 이 배열로 펴지지 않았다");
  assert.equal(ctx.catalog.length, (MIRROR_ENVELOPE.snapshot as { catalog: { entities: unknown[] } }).catalog.entities.length);
  // `OntologyCatalogEntitySchema` 가 실물 4키(`id,type,aliases,canonicalName`)를 받는다.
  assert.deepEqual(Object.keys(ctx.catalog[0]!).sort(), ["aliases", "canonicalName", "id", "type"]);
  assert.equal(ctx.rels.length, 2);
  assert.equal(ctx.trackedAugmentTargets.length, 1);
});

// ── 감성 V2 게이트 전달 (벤더 재동기 64de80d2) ─────────────────────────────────────
//
// 재동기 후 벤더 `AnalysisOptionsSchema` 가 `enableLlmMentionSemanticsV2`(기본 false)를 안다. 키가 없는
// 티켓은 false 로 채워지고(순수 계층은 `=== true` 로만 분기, 골든 13개가 바이트 동일로 증명), 키가 있으면
// 값이 그대로 엔진 옵션까지 간다. V2 키 외의 옵션은 키 유무와 무관하게 같아야 한다.
test("V2 게이트: 티켓에 키가 없으면 벤더 기본값 false, 있으면 값이 엔진 옵션까지 간다", () => {
  const c = cases[0]!;
  const raw = engineInput(c, "e".repeat(64));
  // 골든 픽스처 빌더는 벤더 스키마로 옵션을 채우므로 키가 false 로 들어 있다. 라이브 제출기 off(키 생략)를
  // 재현하려고 키를 지운 티켓을 기준으로 삼는다.
  const { enableLlmMentionSemanticsV2: _absent, ...optionsWithoutKey } = raw.ticket.options as Record<string, unknown>;
  const base = { ...raw, ticket: { ...raw.ticket, options: optionsWithoutKey } } as typeof raw;
  assert.equal(Object.hasOwn(base.ticket.options, "enableLlmMentionSemanticsV2"), false, "전제: 키를 지운 티켓이어야 한다");
  const without = buildTurnContext(base).options as Record<string, unknown>;
  assert.equal(without.enableLlmMentionSemanticsV2, false, "키가 없는데 벤더 기본값 false 가 아니다");
  const { enableLlmMentionSemanticsV2: _d0, ...withoutRest } = without;
  for (const v of [true, false]) {
    const input = { ...base, ticket: { ...base.ticket, options: { ...base.ticket.options, enableLlmMentionSemanticsV2: v } } };
    const opts = buildTurnContext(input).options as Record<string, unknown>;
    assert.equal(opts.enableLlmMentionSemanticsV2, v, `값 ${v} 가 엔진 옵션까지 안 갔다`);
    const { enableLlmMentionSemanticsV2: _drop, ...rest } = opts;
    assert.deepEqual(rest, withoutRest, "V2 키 외의 옵션이 바뀌었다");
  }
});
