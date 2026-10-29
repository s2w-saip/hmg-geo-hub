// 답변 단위 브랜드 스탠스 — **계약 수신 확장(WU2)의 가드.**
//
// 정본: (내부 설계 문서)
//       §1.5(양방향 strict) · §4.1(task·env) · §8.0(배포 순서) · §8.2 WU2
//
// ── 이 파일이 지키는 명제는 넷이다
//
//   ① **옵션 미포함 요청이 그대로 통과한다.** 코어는 아직 11필드만 보낸다(WU1/WU3 미머지).
//      12번째를 required 로 두면 그 창의 티켓이 **전량 400** 이다 — 2026-09-13 `industry`
//      드리프트와 같은 모양의 사고를 "넓히다가" 만드는 것.
//   ② **옵션이 들어와도 동작이 안 바뀐다.** 이 PR 은 받기만 넓힌다.
//   ③ **답장에 `answerStances` 가 저절로 실리지 않는다.** 코어 `AnalysisReplyTurnSchema` 는
//      아직 그 키를 모르고 `.strict()` 다 → 실리는 순간 완주한 분석이 전량 `output_contract`
//      로 버려진다(스펙 RK1). `.default([])` 와 `.optional()` 의 차이가 여기서 라이브의 생사다.
//   ④ **task 어휘의 두 사본이 안 갈린다.** zod enum 과 `analysis_call_usage.task` CHECK.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { migrate } from "../app/migrate.ts";
import {
  AnalysisAnswerBrandStanceAspectSchema,
  AnalysisAnswerBrandStanceSchema,
  AnalysisReplySchema,
  AnalysisTaskSchema,
  AnalysisTicketRequestSchema,
  ResolvedAnalysisOptionsSchema,
} from "../contracts/index.ts";
import {
  STANCE_ASPECT_CAP,
  STANCE_ASPECT_LABEL_CAP,
} from "../packages/analysis-core/vendor/lib/measurement-analysis/schema.ts";
import { CORE_TASK_MODEL_ENV_KEYS, CORE_TASK_TO_LANE_TASK, laneTaskFor, lookupRate, taskModelEnvKey } from "../worker/llm-pools.ts";
import { createPgliteDb } from "./helpers/pglite-db.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CORE_MIRROR = fileURLToPath(new URL("../contracts/fixtures/core-mirror/", import.meta.url));
const coreTicket = (): Record<string, unknown> =>
  JSON.parse(readFileSync(`${CORE_MIRROR}analysis-ticket-request.v1.json`, "utf8")) as Record<string, unknown>;
const coreReply = (): Record<string, unknown> =>
  JSON.parse(readFileSync(`${CORE_MIRROR}analysis-reply.completed.json`, "utf8")) as Record<string, unknown>;

const live = (raw: Record<string, unknown>): Record<string, unknown> => ({
  ...raw,
  deadlineAt: new Date(Date.now() + 6 * 3600_000).toISOString(),
});

// ── ① 옵션 미포함 요청 (= 지금의 라이브 코어) ─────────────────────────────────────

test("WU6 — 코어가 보내는 **12필드** options 가 그대로 통과한다 (제출기 PR #690 이후)", () => {
  const raw = coreTicket();
  const opts = raw.options as Record<string, unknown>;
  assert.equal(Object.keys(opts).length, 12, "코어 픽스처가 12필드가 아니다 — 이 테스트의 모수가 바뀌었다");
  assert.equal(opts.enableLlmAnswerBrandStance, false, "코어 픽스처의 기본은 게이트 off 다");
  assert.equal(AnalysisTicketRequestSchema.parse(live(raw)).options.enableLlmAnswerBrandStance, false);
});

test("WU6 — 필드가 **없는** 요청도 여전히 통과한다 (배포 창의 in-flight 티켓)", () => {
  // ⚠️ `.default(false)` 를 `z.boolean()` 으로 좁히고 싶은 유혹이 있는 자리다 — 코어 제출기가
  //    이제 항상 채우니까. 좁히지 않는다:
  //      ① 코어 정본이 아직 `.optional()` 이다(`contracts.ts` @ cc245ed9). lane 이 코어보다
  //         **좁으면** 코어가 보낼 수 있는 값을 lane 이 400 으로 거부한다 — 방향이 반대인 사고.
  //      ② 제출기 배포 **이전에 큐에 들어간 티켓**은 11필드다. 좁히면 그 창의 티켓이 전량 400.
  const raw = coreTicket();
  const opts = { ...(raw.options as Record<string, unknown>) };
  delete opts.enableLlmAnswerBrandStance;
  const parsed = AnalysisTicketRequestSchema.parse({ ...live(raw), options: opts });
  assert.equal(parsed.options.enableLlmAnswerBrandStance, false, "부재 시 기본값이 false 가 아니면 안 보내는 창에 스탠스가 켜진다");
});

test("WU6 — 게이트가 켜진 12필드도 통과한다", () => {
  const raw = coreTicket();
  const widened = {
    ...live(raw),
    options: { ...(raw.options as Record<string, unknown>), enableLlmAnswerBrandStance: true },
  };
  const parsed = AnalysisTicketRequestSchema.parse(widened);
  assert.equal(parsed.options.enableLlmAnswerBrandStance, true);
});

test("WU2 — `.strict()` 경계는 그대로다 (오타 키·실행 필드는 여전히 거부)", () => {
  const raw = live(coreTicket());
  const opts = (coreTicket().options as Record<string, unknown>);
  // 새 필드의 오타
  assert.equal(
    AnalysisTicketRequestSchema.safeParse({ ...raw, options: { ...opts, enableLlmAnswerBrandStances: true } }).success,
    false,
    "오타난 키가 통과하면 게이트가 조용히 안 켜진다",
  );
  // 타입도 좁다
  assert.equal(
    AnalysisTicketRequestSchema.safeParse({ ...raw, options: { ...opts, enableLlmAnswerBrandStance: "true" } }).success,
    false,
  );
  // 실행 필드는 12필드가 된 뒤에도 거부된다(경계 회귀)
  assert.equal(AnalysisTicketRequestSchema.safeParse({ ...raw, options: { ...opts, model: "haiku" } }).success, false);
});

test("WU6 — 스키마와 코어 픽스처의 옵션 키 집합이 **정확히 같다** (면제 만료의 증거)", () => {
  const opts = coreTicket().options as Record<string, unknown>;
  const parsed = ResolvedAnalysisOptionsSchema.parse(opts);
  assert.deepEqual(Object.keys(parsed).sort(), Object.keys(opts).sort(), "옵션 키가 코어 픽스처와 다르다");
});

// ── ② 동작 무변경 — 이 PR 은 스탠스를 계산하지도 보내지도 않는다 ────────────────────

test("WU6 — 스탠스 송신은 **옵션 게이트 뒤에만** 있다 (게이트를 lane 이 따로 들지 않는다)", () => {
  // WU2 의 "송신 0" 전수 grep 을 **조건부**로 바꾼 자리다. 이제 lane 은 스탠스를 보낸다 —
  // 코어 `AnalysisReplyTurnSchema` 가 `answerStances: z.array(...).default([])` 로 받기 때문이다
  // (Kongventures/scope `6a5e67a9`). 대신 지켜야 할 것이 바뀌었다:
  //
  //   **게이트는 한 곳뿐이어야 한다.** 판단은 핀된 순수 계층이 하고(`options
  //   .enableLlmAnswerBrandStance && deps.llm.stance && quality==="valid_answer" &&
  //   mentions>0`), lane 은 invoker 주입만 한다. lane 이 자기 쪽에서 옵션을 한 번 더 보면
  //   게이트가 둘이 되고, 코어가 조건을 바꿀 때 lane 만 낡는다 — 그 드리프트는 실패가 아니라
  //   **결손**으로 나타난다("안 도는데 아무도 모른다").
  const engineRaw = readFileSync(`${ROOT}worker/engines/core-engine.ts`, "utf8");
  assert.match(engineRaw, /stance: \(i\) => classifyAnswerBrandStanceWithLlm\(\{ \.\.\.i, invokeFn \}\)/, "stance invoker 주입이 없다");
  // ⚠️ **주석을 먼저 지운다.** 왜 게이트를 안 드는지를 설명하려면 그 식별자를 인용해야 하고,
  //    인용을 금지하면 근거가 코드에서 사라진다(`tests/boundary.test.ts` 의 마이그레이션 검사가
  //    `--` 주석을 빼는 것과 같은 이유). 보는 것은 **코드**지 설명이 아니다.
  const engine = engineRaw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.doesNotMatch(
    engine,
    /enableLlmAnswerBrandStance/,
    "lane 이 옵션 게이트를 **자기 쪽에서** 다시 본다 — 게이트는 순수 계층 한 곳뿐이어야 한다",
  );
  // 순수 계층이 실제로 그 셋을 보는지(= 게이트가 거기 있는지)까지 확인한다. 벤더는 핀돼 있어
  // 여기서 깨지면 코어가 조건을 바꿨다는 뜻이고, 그건 재동기 때 사람이 봐야 할 변경이다.
  const pure = readFileSync(`${ROOT}packages/analysis-core/vendor/lib/measurement-analysis/pure/analyze-turn.ts`, "utf8");
  for (const cond of ["options.enableLlmAnswerBrandStance", "deps.llm.stance", 'analysis.quality.qualityState === "valid_answer"']) {
    assert.ok(pure.includes(cond), `순수 계층의 스탠스 게이트에서 ${cond} 가 사라졌다`);
  }
});

test("WU6 — 답장에 `answerStances` 가 **항상 실린다**(없으면 빈 배열) — 코어가 받는다", () => {
  // WU2 에서는 정반대를 단언했다: "키가 **없어야** 한다". 코어가 그 키를 몰랐고 `.strict()` 라
  // 실리는 순간 전량 `output_contract` 였기 때문이다(RK1). 코어가 `.default([])` 로 받는 지금은
  // 항상 실리는 쪽이 낫다 — "안 실은 것" 과 "빈 것" 이 같은 값이라 소비 측 분기가 사라진다.
  const parsed = AnalysisReplySchema.parse(coreReply());
  const turn = (parsed.result as { turn: Record<string, unknown> }).turn;
  assert.deepEqual(turn.answerStances, [], "코어 픽스처에 스탠스가 없으면 빈 배열로 채워져야 한다");
  assert.ok(JSON.stringify(parsed).includes('"answerStances"'), "직렬화 바이트에 키가 없다");
});

test("WU6 — 스탠스를 실은 답장이 파싱되고, 원소는 `.strict()` + aspects·modelSlug 를 받는다", () => {
  const raw = coreReply();
  const result = raw.result as { turn: Record<string, unknown> };
  const stance = {
    entityId: "3f7a2c81-9d40-4e16-b5c2-8a0e7d1f4b69",
    brandLabel: "Hyundai",
    isTracked: true,
    stance: "mixed",
    confidence: 0.82,
    evidenceText: "장점은 분명하지만 품질 이슈가 반복된다",
    evidenceStart: 412,
    evidenceEnd: 434,
    reason: "장점과 품질 우려가 함께 제시됨",
    modelSlug: "google/gemini-3.1-flash-lite",
    extractionMetadata: { evidence_match: "exact", offset_basis: "codepoint" },
    aspects: [
      { aspect: "품질", stance: "negative", evidence_text: "품질 이슈가 반복", evidence_start: 420, evidence_end: 428, evidence_verified: true },
    ],
  };
  const withStance = AnalysisReplySchema.parse({
    ...raw,
    result: { ...result, turn: { ...result.turn, answerStances: [stance] } },
  });
  const turn = (withStance.result as { turn: { answerStances: unknown[] } }).turn;
  assert.equal(turn.answerStances.length, 1);

  // 어휘는 발생 단위 감성과 **같은 4값**(FR2).
  assert.equal(AnalysisAnswerBrandStanceSchema.safeParse({ ...stance, stance: "bullish" }).success, false);
  for (const v of ["positive", "negative", "mixed", "neutral"]) {
    assert.equal(AnalysisAnswerBrandStanceSchema.safeParse({ ...stance, stance: v }).success, true, `${v} 가 거부됐다`);
  }
  // 코어보다 넓으면 답장이 통째로 버려진다 — 코어에 없는 키는 여기서 죽어야 한다.
  assert.equal(AnalysisAnswerBrandStanceSchema.safeParse({ ...stance, aspectS: [] }).success, false);
  // modelSlug·aspects 는 **이제 받는다**(WU6). 부재도 허용 — 코어가 optional/default 다.
  const bare = AnalysisAnswerBrandStanceSchema.parse({
    entityId: stance.entityId,
    brandLabel: stance.brandLabel,
    isTracked: false,
    stance: "neutral",
  });
  assert.deepEqual(
    { c: bare.confidence, t: bare.evidenceText, s: bare.evidenceStart, e: bare.evidenceEnd, r: bare.reason, m: bare.extractionMetadata, a: bare.aspects },
    { c: null, t: null, s: null, e: null, r: null, m: {}, a: [] },
  );

  // confidence 범위 — 코어와 같은 [0,1].
  for (const bad of [1.5, -0.1, 2, -1]) {
    assert.equal(AnalysisAnswerBrandStanceSchema.safeParse({ ...stance, confidence: bad }).success, false, `confidence=${bad} 가 통과했다`);
  }
  for (const ok of [0, 0.5, 1]) {
    assert.equal(AnalysisAnswerBrandStanceSchema.safeParse({ ...stance, confidence: ok }).success, true);
  }

  // 오프셋 쌍 불변식(FR4) — 브랜드 축.
  const offsets = (start: number | null, end: number | null) =>
    AnalysisAnswerBrandStanceSchema.safeParse({ ...stance, evidenceStart: start, evidenceEnd: end }).success;
  for (const [st, en] of [[5, null], [null, 5], [5, 5], [5, 4]] as Array<[number | null, number | null]>) {
    assert.equal(offsets(st, en), false, `evidenceStart=${st}/evidenceEnd=${en} 가 통과했다`);
  }
  assert.equal(offsets(null, null), true);
  assert.equal(offsets(5, 6), true);
});

test("WU6 — aspects 원소가 코어와 같은 제약을 갖는다 (상한·snake_case·오프셋 불변식)", () => {
  const ok = { aspect: "소음", stance: "negative", evidence_text: null, evidence_start: null, evidence_end: null, evidence_verified: false };
  assert.equal(AnalysisAnswerBrandStanceAspectSchema.safeParse(ok).success, true);
  // camelCase 로 "정리" 하면 코어 `.strict()` 가 전량 튕긴다 — jsonb 블롭이라 snake_case 가 맞다.
  assert.equal(AnalysisAnswerBrandStanceAspectSchema.safeParse({ ...ok, evidenceText: null }).success, false);
  // 라벨 상한·빈 문자열
  assert.equal(AnalysisAnswerBrandStanceAspectSchema.safeParse({ ...ok, aspect: "" }).success, false);
  assert.equal(AnalysisAnswerBrandStanceAspectSchema.safeParse({ ...ok, aspect: "가".repeat(STANCE_ASPECT_LABEL_CAP) }).success, true);
  assert.equal(AnalysisAnswerBrandStanceAspectSchema.safeParse({ ...ok, aspect: "가".repeat(STANCE_ASPECT_LABEL_CAP + 1) }).success, false);
  // 오프셋 쌍 불변식은 브랜드 축과 **같은 규칙**이다.
  assert.equal(AnalysisAnswerBrandStanceAspectSchema.safeParse({ ...ok, evidence_start: 5, evidence_end: null }).success, false);
  assert.equal(AnalysisAnswerBrandStanceAspectSchema.safeParse({ ...ok, evidence_start: 5, evidence_end: 5 }).success, false);
  assert.equal(AnalysisAnswerBrandStanceAspectSchema.safeParse({ ...ok, evidence_start: 5, evidence_end: 6 }).success, true);
  // 개수 상한 — 코어 `STANCE_ASPECT_CAP` 과 **같은 상수**를 쓴다(손으로 옮겨 적지 않는다).
  const stanceWith = (n: number) => ({
    entityId: "3f7a2c81-9d40-4e16-b5c2-8a0e7d1f4b69", brandLabel: "X", isTracked: false, stance: "neutral",
    aspects: Array.from({ length: n }, (_, i) => ({ ...ok, aspect: `a${i}` })),
  });
  assert.equal(AnalysisAnswerBrandStanceSchema.safeParse(stanceWith(STANCE_ASPECT_CAP)).success, true);
  assert.equal(AnalysisAnswerBrandStanceSchema.safeParse(stanceWith(STANCE_ASPECT_CAP + 1)).success, false);
});

// ── ④ task 어휘 — zod enum 과 DB CHECK 의 두 사본 ────────────────────────────────

/** 마이그레이션 전체를 순서대로 훑어 `analysis_call_usage.task` CHECK 의 **최종** 어휘를 뽑는다. */
function taskCheckVocabularyFromMigrations(): string[] {
  const dir = `${ROOT}migrations`;
  let last: string[] | null = null;
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(`${dir}/${name}`, "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    for (const m of sql.matchAll(/task\s+IN\s*\(([^)]*)\)/gi)) {
      // ⚠️ 0009 는 `EXECUTE '… task IN (''extract'', …)'` 안에 있다 — SQL 문자열 리터럴 안이라
      //    작은따옴표가 **두 번씩** 적혀 있다. 먼저 되돌리지 않으면 `'extract'` 가 값으로 잡혀
      //    어휘 비교가 조용히 어긋난다(따옴표까지 포함한 문자열과 비교하게 된다).
      last = m[1]!.split(",").map((v) => v.trim().replace(/''/g, "'").replace(/^'|'$/g, ""));
    }
  }
  assert.ok(last, "마이그레이션에서 task CHECK 어휘를 못 찾았다 — 파서가 낡았다");
  return last;
}

test("WU2 — task 어휘의 두 사본이 같다 (zod enum == 마이그레이션 CHECK)", () => {
  assert.deepEqual(
    taskCheckVocabularyFromMigrations().sort(),
    [...AnalysisTaskSchema.options].sort(),
    "zod 만 넓히면 그 태스크의 콜 원장 INSERT 가 라이브에서 check violation 으로 죽는다(실비는 이미 나간 뒤)",
  );
});

test("WU2 — 마이그레이션을 실제로 적용하면 CHECK 가 stance 를 받는다 (PGlite)", async () => {
  const db = await createPgliteDb();
  try {
    await migrate(db);
    const rows = await db.query<{ def: string }>(
      "SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c " +
        "JOIN pg_class t ON t.oid = c.conrelid WHERE t.relname = 'analysis_call_usage' AND c.contype = 'c' AND pg_get_constraintdef(c.oid) ILIKE '%task%'",
    );
    assert.equal(rows.length, 1, `task CHECK 가 ${rows.length}개다 — 0009 의 DROP 이 옛 제약을 못 지웠으면 stance 가 여전히 거부된다`);
    for (const v of AnalysisTaskSchema.options) {
      assert.ok(rows[0]!.def.includes(`'${v}'`), `CHECK 에 ${v} 가 없다: ${rows[0]!.def}`);
    }
  } finally {
    await db.close();
  }
});

// ── 배선 (A9 · A10 의 선행 조건) ────────────────────────────────────────────────

test("WU2 — stance 태스크가 코어 task 문자열·env 키·단가표까지 이어져 있다", () => {
  const coreTask = "measurement.analysis.answer_brand_stance";
  assert.equal(laneTaskFor(coreTask), "stance");
  assert.equal(taskModelEnvKey(coreTask), "LLM_TASK_MODEL_measurement_analysis_answer_brand_stance");
  assert.ok(CORE_TASK_MODEL_ENV_KEYS.includes(taskModelEnvKey(coreTask)), "env 키가 단언 목록에 없으면 alias 로 조용히 접힌다");
  assert.ok(Object.keys(CORE_TASK_TO_LANE_TASK).includes(coreTask));
  // A10 — 단가표에 없으면 `costUsd=null` 로 장부에 구멍이 난다. **실제로 주입되는 모델**을 본다
  // (2026-09-15 전환: gemini-2.5-flash → flash-lite. 이제 semantics·citation 과 같은 모델이다).
  assert.deepEqual(lookupRate("openrouter/google/gemini-3.1-flash-lite"), { inputPer1k: 0.00025, outputPer1k: 0.0015 });
  // 옛 모델도 단가표에 **남아 있어야 한다** — 그 모델로 돌던 과거 행의 비용 재계산이 샌다.
  assert.deepEqual(lookupRate("openrouter/google/gemini-2.5-flash"), { inputPer1k: 0.00015, outputPer1k: 0.0006 });
});
