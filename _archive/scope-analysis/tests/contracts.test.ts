// 계약 fixture 동치 — **계약 진화 회귀 가드**.
//
// 측정 lane 은 JSON Schema 왕복으로 두 언어(pydantic ↔ zod)를 맞췄지만, 분석은 스키마가 한 벌이라
// fixture 의 역할이 다르다: "필드를 지우거나 이름을 바꾸면 **테스트가 먼저 깨진다**"
// (스펙 §4.4 · `contracts/README.md`). 관례는 측정 `lib/measurement-ticket/test-units.ts:36~39`.
//
// 단언은 둘이다:
//   ① fixture 가 현행 zod 를 **통과한다**            (필드를 지우면 깨진다)
//   ② 현행 zod 산출물이 fixture 와 **키 집합 동일**   (더하거나 이름을 바꾸면 깨진다)
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ANALYSIS_TURN_BODY_MAX_BYTES,
  AnalysisCallUsageSchema,
  AnalysisCapacitySchema,
  AnalysisLlmUsageSchema,
  AnalysisReplySchema,
  AnalysisTicketAcceptedSchema,
  AnalysisTicketRequestSchema,
  AnalysisTicketStatusViewSchema,
  BANNED_OPTION_KEYS,
  isLaneSafeUrl,
  parseContextVersionProjectId,
  toReplyUsage,
  turnBodyBytes,
} from "../contracts/index.ts";

const FIXTURES = fileURLToPath(new URL("../contracts/fixtures/", import.meta.url));
const fx = (name: string): unknown => JSON.parse(readFileSync(FIXTURES + name, "utf8"));

/** 중첩 키 경로 집합. 배열은 **첫 원소만** 본다 — 원소끼리 모양이 같은 것이 계약의 전제다. */
function keyPaths(value: unknown, prefix = ""): Set<string> {
  const out = new Set<string>();
  if (Array.isArray(value)) {
    if (value.length > 0) for (const p of keyPaths(value[0], `${prefix}[]`)) out.add(p);
    return out;
  }
  if (value === null || typeof value !== "object") return out;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    out.add(path);
    for (const p of keyPaths(v, path)) out.add(p);
  }
  return out;
}

function assertRoundTrip(name: string, schema: { parse: (v: unknown) => unknown }): void {
  const raw = fx(name);
  const parsed = schema.parse(raw);
  const rawKeys = keyPaths(raw);
  const parsedKeys = keyPaths(parsed);
  // ⚠️ 자유 JSON 필드 안쪽은 계약이 모양을 정하지 않는다 — 그 하위 경로만 비교에서 뺀다.
  //    G3-2 에서 `quality`·`mentions[]`·`candidates[]` 는 **더 이상 자유 JSON 이 아니다**
  //    (벤더된 코어 타입으로 좁혔다) → opaque 목록에서 뺐다. 그래서 이제 이 테스트가
  //    멘션·후보의 필드 집합까지 실제로 지킨다. 남는 자유 JSON 은 셋뿐이다:
  //      · `extractionMetadata`(턴·멘션 양쪽) — 코어 store.ts:896~952 가 자유 키를 채운다
  //      · `metricImpact`(후보)               — 같은 이유
  //      · `options`                          — `ResolvedAnalysisOptions` 는 코어 소유다
  const opaque = ["extractionMetadata.", "metricImpact.", "options.", "quality.qualityState."];
  const trim = (s: Set<string>) => new Set([...s].filter((p) => !opaque.some((o) => p.includes(o))));
  assert.deepEqual([...trim(parsedKeys)].sort(), [...trim(rawKeys)].sort(), `${name}: key set drift`);
}

test("ticket request fixture round-trips", () => {
  assertRoundTrip("analysis-ticket-request.v1.json", AnalysisTicketRequestSchema);
});

test("reply fixtures round-trip (completed / deferred / failed)", () => {
  assertRoundTrip("analysis-reply.completed.json", AnalysisReplySchema);
  assertRoundTrip("analysis-reply.deferred.json", AnalysisReplySchema);
  assertRoundTrip("analysis-reply.failed.json", AnalysisReplySchema);
});

test("accepted / status / capacity fixtures round-trip", () => {
  assertRoundTrip("analysis-ticket-accepted.v1.json", AnalysisTicketAcceptedSchema);
  assertRoundTrip("analysis-ticket-status.v1.json", AnalysisTicketStatusViewSchema);
  assertRoundTrip("analysis-capacity.v1.json", AnalysisCapacitySchema);
});

test("execution fields in options are rejected — the boundary the contract exists for", () => {
  // ⚠️ 거부의 **주체가 바뀌었다.** 초판은 `options` 가 자유 레코드여서 `BANNED_OPTION_KEYS`
  //    superRefine 이 걸렀지만, 코어 정본과 동기화하면서 `options` 가 11필드 `.strict()` 가 됐다 —
  //    이제 zod 의 `Unrecognized key` 가 먼저 잡는다. 경계는 같고 메시지만 다르다.
  const bad = AnalysisTicketRequestSchema.safeParse(fx("analysis-ticket-request.invalid-execution-field.json"));
  assert.equal(bad.success, false);
  assert.ok(
    bad.error?.issues.some((i) => i.path[0] === "options"),
    `rejection must point at options, got: ${JSON.stringify(bad.error?.issues.map((i) => i.path))}`,
  );

  // 금지 키 전수 — 하나라도 새면 "어떻게"가 티켓으로 흘러 경계가 무너진다.
  // (코어와 같은 11필드를 채운 **정상 options** 에 금지 키 하나만 얹어 본다.)
  const base = fx("analysis-ticket-request.v1.json") as Record<string, unknown>;
  const goodOptions = base.options as Record<string, unknown>;
  assert.equal(AnalysisTicketRequestSchema.safeParse(base).success, true, "기준 픽스처가 먼저 통과해야 한다");
  for (const key of BANNED_OPTION_KEYS) {
    const probe = { ...base, options: { ...goodOptions, [key]: "x" } };
    assert.equal(AnalysisTicketRequestSchema.safeParse(probe).success, false, `options.${key} must be rejected`);
  }
  // 오타난 옵션 키도 거부된다 — 자유 레코드였을 때는 조용히 통과하던 자리다.
  assert.equal(
    AnalysisTicketRequestSchema.safeParse({ ...base, options: { ...goodOptions, followupMode: "x" } }).success,
    false,
    "코어에 없는 옵션 키는 거부돼야 한다(드리프트가 조용히 지나가지 않게)",
  );
  // 코어에 **있는** 키가 빠져도 거부된다 — 발행부가 필드를 떨어뜨리면 여기서 드러난다.
  const missing = { ...goodOptions };
  delete missing.followUpMode;
  assert.equal(AnalysisTicketRequestSchema.safeParse({ ...base, options: missing }).success, false);
});

// ── 교차 리포 계약 가드 (재발 방지) ──────────────────────────────────────────────
//
// 2026-09-13: 코어가 보낸 티켓이 **전부 400** 이었다. lane 계약이 스펙 표의 축약 표기
// (`industry: {id, name}`)를 그대로 스키마로 옮겼는데 코어 정본은 `{ids, name, source}` 였다.
// 픽스처가 **lane 안에서만** 왕복하니 두 리포가 갈린 것을 아무 테스트도 못 봤다 —
// 위의 라운드트립 테스트는 "lane 이 자기 픽스처를 파싱한다"만 증명한다.
//
// 그래서 코어 픽스처의 **바이트 사본**을 `contracts/fixtures/core-mirror/` 에 두고, 그것이
// lane 스키마를 통과하는지 + 키 집합이 같은지를 CI 의 `contracts` 단계에서 본다.
// 사본이므로 코어를 import 하지 않는다(경계 테스트 A8 유지).
//
// 출처: Kongventures/scope `lib/measurement-analysis-ticket/__fixtures__/` @ cc245ed9
//        (2026-09-15 WU6 재동기. 이전 사본은 11122457 — 그 사이 바뀐 것은 티켓 요청 픽스처
//         하나뿐이고, `options` 가 11 → **12필드**가 됐다(제출기 PR #690). 답장 픽스처 3종과
//         컨텍스트 2종은 **바이트 그대로**라 해시가 안 바뀌었다.)
//        2026-09-18 감성 V2 벤더 재동기(코어 64de80d2 = PR #710) 때 7개 파일 전부를
//        `git show 64de80d2:<path> | cmp` 로 대조해 바이트 동일을 확인했다. 해시 표 무변경.
// sha256 (복사 시점, `shasum -a 256` 실측):
//   analysis-ticket-request.v1.json  d4dd620d03be90ca45beef134981781eaceb523ff9faa4d569a24623bcdbb05a
//   analysis-reply.completed.json    ac7ccb8ac52ba49b529bf10b69ce02345f3ff0c312c857bcff82d56a6478def8
//   analysis-reply.deferred.json     5ff1ee095b2fd0f0019b5e9d8da0a3e85792582f24e045b08547024c548aecf0
//   analysis-reply.failed.json       caeaca30060b67e619f023b9813a37ce8a51bba34ee779f807c8f541ccd371f1
//
// ⚠️ 이 해시는 **사본이 바뀌었는지**를 말할 뿐 코어가 바뀌었는지는 말하지 못한다. 코어가
//    픽스처를 고치면 여기 사본을 다시 복사하고 해시를 갱신하는 것이 재동기 절차다.
//
// ⚠️ `analysis-context.*.json` 두 개는 **코어가 자기 타입으로 생성한** 픽스처의 사본이다
//    (코어 `lib/measurement-analysis-ticket/context-fixture.ts` + `write-analysis-context-fixtures.ts`,
//    Kongventures/scope#654 @ 4c87f115). 한때 lane 저작이었고 그 예외가 D-5·D-6 의 전파
//    경로였다 — lane 이 지은 픽스처가 lane 의 틀린 가정을 재생해 테스트는 초록, 라이브만 죽었다.
//    이제 코어 CI(`pnpm test:analysis-lane-contract`)가 "커밋된 바이트 == 코어 타입 생성 결과"를
//    먼저 판정하고, 여기 사본은 그 바이트를 그대로 들고 있다.
//   analysis-context.200-envelope.json         312e5e0cebf10c958679113e370bf70dc045f9aa2a5d14c94170e391412d8331
//   analysis-context.409-version-mismatch.json 695919ef9688f89740d57d969f2114a1f5b98c80f070a9d097d3e315987ef22b
const CORE_MIRROR = fileURLToPath(new URL("../contracts/fixtures/core-mirror/", import.meta.url));
const CORE_FIXTURE_SHA256: Record<string, string> = {
  "analysis-ticket-request.v1.json": "8bf64e6315c1b1aea7e12a06fef56b1ef56b4643050854a89c89cef419b9787e",
  "analysis-reply.completed.json": "ac7ccb8ac52ba49b529bf10b69ce02345f3ff0c312c857bcff82d56a6478def8",
  // WU6 — 스탠스가 **실제로 담긴** 답장 픽스처(코어 cc245ed9 신규). 위 `completed` 는 여전히
  // 스탠스 키가 없으므로, lane 이 코어가 보낼 수 있는 **최대 모양**을 파싱하는지는 이 파일만 증명한다.
  "analysis-reply.completed.stances.json": "09c0bfa6f156aea9df9305ff8c2ad1732e746ae6dfe355bf038701434b47a37f",
  "analysis-reply.deferred.json": "5ff1ee095b2fd0f0019b5e9d8da0a3e85792582f24e045b08547024c548aecf0",
  "analysis-reply.failed.json": "caeaca30060b67e619f023b9813a37ce8a51bba34ee779f807c8f541ccd371f1",
  // 코어 #654(4c87f115) 가 생성한 봉투·409 본문. lane 은 **읽기만** 한다 — 고칠 일이 생기면
  // 코어의 생성기를 고치고 `pnpm tsx scripts/measurement-analysis/write-analysis-context-fixtures.ts`.
  "analysis-context.200-envelope.json": "312e5e0cebf10c958679113e370bf70dc045f9aa2a5d14c94170e391412d8331",
  "analysis-context.409-version-mismatch.json": "695919ef9688f89740d57d969f2114a1f5b98c80f070a9d097d3e315987ef22b",
};
const coreRaw = (name: string): Buffer => readFileSync(CORE_MIRROR + name);
const coreFx = (name: string): unknown => JSON.parse(coreRaw(name).toString("utf8"));

test("core-mirror 사본이 주석에 적힌 sha256 그대로다 — 어느 시점 사본인지 추적 가능해야 한다", () => {
  for (const [name, sha] of Object.entries(CORE_FIXTURE_SHA256)) {
    assert.equal(createHash("sha256").update(coreRaw(name)).digest("hex"), sha, `${name}: 사본이 바뀌었다`);
  }
});

/**
 * **lane 이 코어보다 먼저 넓힌 수신 필드.** 여기 있는 경로는 코어 픽스처에 아직 없고 lane 파싱
 * 결과에만 나타나므로(기본값 주입) 키 집합 비교에서 뺀다.
 *
 * ⚠️ **WU6(2026-09-15)에서 요청 쪽 면제는 만료시켰다.** 코어 `cc245ed9`(제출기 PR #690)가
 *    티켓 요청 픽스처를 재생성해 `options` 가 **12필드**가 됐고
 *    (`enableLlmAnswerBrandStance: false`), 사본을 그 바이트로 재동기했다 — 그래서
 *    `options.enableLlmAnswerBrandStance` 는 더 이상 면제가 아니다. 이제 코어 발행부가 그
 *    필드를 떨어뜨리면 이 테스트가 잡는다.
 *
 * ⚠️ **답장 쪽 하나는 남는다.** 같은 커밋에서 `analysis-reply.completed.json` 은 **바이트가
 *    그대로다**(sha256 미변경 — 아래 표가 그 증거다): 코어 스키마는 `answerStances` 를
 *    `.default([])` 로 받지만 픽스처 생성물이 아직 그 키를 안 낸다. 재동기할 바이트가 없고,
 *    지우면 lane 이 주입하는 기본값 때문에 테스트가 깨진다.
 *
 * ⚠️ 그러므로 이 목록은 **여전히 일시적이다.** 코어가 답장 픽스처를 재생성하면 ① 사본을 다시
 *    복사하고 sha256 을 갱신하며 ② 여기서 그 경로를 지운다. 지우지 않으면 "코어가 필드를
 *    떨어뜨렸다" 를 이 테스트가 더 이상 못 잡는다 — 면제는 반드시 만료되어야 한다.
 *
 * ⚠️ **만료를 기계가 알려주지 않는다.** 드리프트 감시(`.github/workflows/contract-mirror-check.yml`)는
 *    코어가 private 이라 `GITHUB_TOKEN` 으로 못 읽어 **스케줄이 꺼져 있고 `workflow_dispatch` 뿐**이다
 *    (스펙 §1.5). 그래서 아래 두 테스트의 **"초과 면제" 역단언**이 유일한 기계 장치다 —
 *    코어가 픽스처를 넓히는 순간 그 역단언이 깨져서 만료 시점을 알려 준다.
 *
 * 근거: 스펙 §8.0 — 요청 `options` 는 **lane 이 먼저** 넓힌다(반대로 하면 전량 400).
 * 정본: (내부 설계 문서)
 */
const PENDING_CORE_WIDENING: readonly string[] = [
  // 요청 방향(`options.enableLlmAnswerBrandStance`)은 **만료됐다** — 코어 cc245ed9 가 픽스처를
  // 12필드로 재생성했고 사본이 그 바이트다. 되살리지 마라: 되살리면 발행부 결손이 안 보인다.
  "result.turn.answerStances", // 답장 방향 — 코어 스키마는 받지만 픽스처가 아직 안 낸다
];

test("코어 티켓 픽스처를 lane 요청 스키마가 파싱한다 (라이브 400 의 재현·수정 확증)", () => {
  const raw = coreFx("analysis-ticket-request.v1.json") as Record<string, unknown>;
  const parsed = AnalysisTicketRequestSchema.parse(raw);
  // 키 집합 동일 — lane 이 필드를 더하거나 빼면(=계약 드리프트) 여기서 깨진다.
  const opaque = ["extractionMetadata.", "metricImpact."];
  const trim = (s: Set<string>) =>
    new Set([...s].filter((p) => !opaque.some((o) => p.includes(o)) && !PENDING_CORE_WIDENING.includes(p)));
  assert.deepEqual([...trim(keyPaths(parsed))].sort(), [...trim(keyPaths(raw))].sort(), "core request: key set drift");

  // 면제가 **실제로 그 필드 하나뿐**인지 — 면제 목록이 드리프트를 통째로 가리지 않게 한다.
  assert.deepEqual(
    [...keyPaths(parsed)].filter((p) => !keyPaths(raw).has(p)).sort(),
    [...PENDING_CORE_WIDENING].filter((p) => p.startsWith("options.")).sort(),
    "코어 픽스처에 없는데 lane 파싱 결과에 있는 키가 면제 목록과 다르다",
  );

  // 라이브 발행은 `deadlineAt` 이 미래다 — 마감만 바꿔도 통과해야 한다(스키마에 시각 제약은 없다).
  const live = { ...raw, deadlineAt: new Date(Date.now() + 6 * 3600_000).toISOString() };
  const liveParsed = AnalysisTicketRequestSchema.parse(live);
  assert.deepEqual(liveParsed.industry, { ids: ["3f7a2c81-9d40-4e16-b5c2-8a0e7d1f4b69"], name: "Home Appliances", source: "project" });
  assert.equal(liveParsed.lineage.projectId, "5d3b7e10-8a49-4c2f-9b06-3e1d8f5a2c74");
});

test("코어가 보낼 수 있는 가장자리 값도 통과한다 — bare query_run(projectId·answerText·region null)", () => {
  const raw = coreFx("analysis-ticket-request.v1.json") as Record<string, unknown>;
  const lineage = { ...(raw.lineage as Record<string, unknown>), projectId: null, promptRunId: null };
  const turn = { ...(raw.turn as Record<string, unknown>), answerText: null, region: null };
  const bare = {
    ...raw,
    lineage,
    turn,
    // bare 경로의 컨텍스트 네임스페이스는 uuid 가 아니다(코어 `context-snapshot.ts:100`).
    context: { ...(raw.context as Record<string, unknown>), contextVersion: "unscoped:a1b2c3d4e5f60718" },
    industry: { ids: [], name: null, source: "none" },
  };
  const parsed = AnalysisTicketRequestSchema.parse(bare);
  assert.equal(parsed.lineage.projectId, null);
  assert.equal(parsed.turn.answerText, null);
  assert.equal(parsed.turn.region, null);
  assert.equal(parseContextVersionProjectId(parsed.context.contextVersion), null, "uuid 가 아닌 접두사는 null 이어야 한다");
  assert.equal(
    parseContextVersionProjectId("5d3b7e10-8a49-4c2f-9b06-3e1d8f5a2c74:a1b2c3d4e5f60718"),
    "5d3b7e10-8a49-4c2f-9b06-3e1d8f5a2c74",
  );
  // tracked-brand 휴리스틱은 ids 를 복수로 낸다 — 초판은 첫 개만 쓰고 source 를 위조했다.
  const multi = AnalysisTicketRequestSchema.parse({
    ...raw,
    industry: { ids: ["a", "b"], name: "Home Appliances", source: "tracked_brands" },
  });
  assert.deepEqual(multi.industry.ids, ["a", "b"]);
  assert.equal(multi.industry.source, "tracked_brands");
});

test("코어 답장 픽스처 3종을 lane 답장 스키마가 파싱한다 — 양방향 계약", () => {
  // 코어 클라이언트가 GET reply 를 파싱하는 스키마와 **같은 모양**이어야 한다. lane 이 만든
  // 답장이 코어에서 튕기면(= `AnalysisTicketApiError("contract")`) 완주한 분석이 버려진다.
  const opaque = ["extractionMetadata.", "metricImpact."];
  const trim = (s: Set<string>) =>
    new Set([...s].filter((p) => !opaque.some((o) => p.includes(o)) && !PENDING_CORE_WIDENING.includes(p)));
  for (const name of ["analysis-reply.completed.json", "analysis-reply.deferred.json", "analysis-reply.failed.json"]) {
    const raw = coreFx(name);
    const parsed = AnalysisReplySchema.parse(raw);
    assert.deepEqual([...trim(keyPaths(parsed))].sort(), [...trim(keyPaths(raw))].sort(), `${name}: key set drift`);
    // 면제가 **실제로 그 목록뿐**인지 — 면제가 드리프트를 통째로 가리지 않게 한다.
    // `result: null` 인 deferred·failed 는 추가 키가 0이므로 빈 배열과 비교된다.
    const extra = [...keyPaths(parsed)].filter((p) => !keyPaths(raw).has(p)).sort();
    const allowed = PENDING_CORE_WIDENING.filter((p) => p.startsWith("result.") && extra.includes(p)).sort();
    assert.deepEqual(extra, allowed, `${name}: 코어 픽스처에 없는데 lane 파싱 결과에 있는 키가 면제 목록 밖이다`);
  }
});

test("WU6 — 스탠스가 **담긴** 코어 답장 픽스처를 lane 이 파싱한다 (코어가 보낼 수 있는 최대 모양)", () => {
  // ⚠️ `analysis-reply.completed.json` 은 스탠스 키가 **없는** 픽스처다 — 그것만으로는
  //    "lane 이 스탠스를 받을 수 있다" 가 증명되지 않는다(빈 배열로 채워질 뿐이다).
  //    코어 cc245ed9 가 스탠스를 실제로 담은 별도 픽스처를 냈고, 이 테스트가 그 바이트를 쓴다.
  const raw = coreFx("analysis-reply.completed.stances.json") as Record<string, unknown>;
  const parsed = AnalysisReplySchema.parse(raw);
  const turn = (parsed.result as { turn: { answerStances: Array<Record<string, unknown>> } }).turn;

  assert.equal(turn.answerStances.length, 2, "코어 픽스처의 스탠스 수와 다르다 — 모수가 바뀌었다");
  for (const st of turn.answerStances) {
    assert.ok(["positive", "negative", "mixed", "neutral"].includes(st.stance as string));
    assert.ok(typeof st.entityId === "string" && (st.entityId as string).length > 0);
    // 코어 픽스처는 `aspects` 를 안 싣는다 → `.default([])` 가 채운다. 그 기본값이 **배열**이어야
    // 소비 측에 `undefined` 분기가 안 생긴다.
    assert.deepEqual(st.aspects, [], "aspects 기본값이 빈 배열이 아니다");
  }

  // 키 집합 — 코어 픽스처에 없는데 lane 이 만들어 낸 키는 `aspects` **하나뿐**이어야 한다.
  // (`modelSlug` 는 픽스처가 이미 싣고 있다 — 위 원소 키 확인 참조.)
  const opaque = ["extractionMetadata.", "metricImpact."];
  const trim = (x: Set<string>) => new Set([...x].filter((p) => !opaque.some((o) => p.includes(o))));
  const extra = [...trim(keyPaths(parsed))].filter((p) => !trim(keyPaths(raw)).has(p)).sort();
  assert.deepEqual(extra, ["result.turn.answerStances[].aspects"], `예상 밖의 키가 생겼다: ${extra.join(", ")}`);
});

test("lane 이 만드는 답장 조각이 코어 모양이다 — 원장 축은 evidence 로 나가지 않는다", () => {
  // 원장 행(lane 전용 13필드) → 코어 8필드 투영. 여분 축이 남으면 코어 `.strict()` 가 튕긴다.
  const row = AnalysisCallUsageSchema.parse({
    task: "extract",
    poolKey: "openrouter",
    modelId: "openai/gpt-5.6-luna",
    inputTokens: null, // 미계측
    outputTokens: 318,
    latencyMs: 21_000,
    costUsd: null, // 미계측
    attempts: 1,
    outcome: "failed_over",
    costSource: null,
    httpStatus: 429,
    errorClass: "rate_limited",
    startedAt: "2026-09-13T06:02:01.000Z",
    finishedAt: "2026-09-13T06:02:22.000Z",
  });
  const projected = toReplyUsage(row);
  assert.deepEqual(Object.keys(projected).sort(), [
    "attempts",
    "costUsd",
    "inputTokens",
    "latencyMs",
    "modelId",
    "outputTokens",
    "poolKey",
    "task",
  ]);
  // ⚠️ 코어 계약은 null(미계측)을 표현하지 못한다 — 키를 빼면 코어가 0 으로 채운다.
  //    미계측/0 구분은 lane 원장에만 남는다(코어 계약 확장은 코어 쪽 후속).
  assert.equal(projected.inputTokens, 0);
  assert.equal(projected.costUsd, 0);
  assert.equal(projected.outputTokens, 318);
  // 투영 결과가 실제 답장에 들어가도 스키마가 받는다.
  const reply = AnalysisReplySchema.parse({
    ...(coreFx("analysis-reply.completed.json") as Record<string, unknown>),
    evidence: {
      llmUsage: [projected],
      runtime: { laneRevision: "analysis-core@aee0b9b16875", contextVersionUsed: "unscoped:a1b2c3d4e5f60718", parallelFlags: {} },
    },
  });
  assert.equal(reply.evidence?.llmUsage.length, 1);
});

test("unknown top-level fields are rejected (strict)", () => {
  const base = fx("analysis-ticket-request.v1.json") as Record<string, unknown>;
  assert.equal(AnalysisTicketRequestSchema.safeParse({ ...base, rawResponse: "x" }).success, false);
  assert.equal(AnalysisTicketRequestSchema.safeParse({ ...base, model: "gpt" }).success, false);
});

test("turn coordinates must match lineage — ticket 1건 = 턴 1건 (D1)", () => {
  const base = fx("analysis-ticket-request.v1.json") as Record<string, unknown>;
  const turn = { ...(base.turn as Record<string, unknown>), turnIndex: 2 };
  assert.equal(AnalysisTicketRequestSchema.safeParse({ ...base, turn }).success, false);
});

test("reply cross-validation mirrors the measurement contract", () => {
  const completed = fx("analysis-reply.completed.json") as Record<string, unknown>;
  // completed 인데 result/evidence 가 없으면 거부
  assert.equal(AnalysisReplySchema.safeParse({ ...completed, result: null }).success, false);
  assert.equal(AnalysisReplySchema.safeParse({ ...completed, evidence: null }).success, false);
  // terminalReason 은 failed/cancelled 전용
  assert.equal(AnalysisReplySchema.safeParse({ ...completed, terminalReason: "permanent" }).success, false);
  // deferred 인데 deferred 블록이 없으면 거부
  const deferred = fx("analysis-reply.deferred.json") as Record<string, unknown>;
  assert.equal(AnalysisReplySchema.safeParse({ ...deferred, deferred: null }).success, false);
});

test("turn 본문 상한이 코어와 같은 값이다 — 한쪽만 올리면 코어는 보내고 lane 은 400 이다", () => {
  // 코어 `lib/measurement-analysis-ticket/contracts.ts` `ANALYSIS_TICKET_TURN_MAX_BYTES = 1_048_576`.
  // 코어 발행부가 `isAnalysisTurnOverLimit` 으로 **보내기 전에** 같은 산식으로 자른다 —
  // 값이 갈리면 그 사이 구간의 턴이 발행은 되고 접수는 안 되는 사각이 생긴다.
  assert.equal(ANALYSIS_TURN_BODY_MAX_BYTES, 1_048_576);
});

test("turn body cap is enforced at the contract layer, not only at nginx", () => {
  const base = fx("analysis-ticket-request.v1.json") as Record<string, unknown>;
  const turn = base.turn as Record<string, unknown>;
  assert.ok(turnBodyBytes(turn) < ANALYSIS_TURN_BODY_MAX_BYTES);
  const huge = { ...turn, answerText: "가".repeat(400_000) }; // UTF-8 3B/자 → ~1.2 MB
  assert.ok(turnBodyBytes(huge) > ANALYSIS_TURN_BODY_MAX_BYTES);
});

// ── `context.ref` 스킴 좁힘 (2026-09-13) ────────────────────────────────────────
//
// `callbackUrl` 과 같은 SSRF 면인데 **노출은 더 크다**: lane 은 `ref` 로 갈 때 내부 토큰
// (`x-scope-internal-token`)을 헤더에 싣는다 — 그 토큰 하나가 워크스페이스 전체 카탈로그를 연다
// (코어 `context-snapshot.ts:104~` "이 응답이 워크스페이스 전체 카탈로그이기 때문이다").
// 초판은 `z.url()` 뿐이라 `http://10.0.0.5/…`·`ftp://`·`file://` 가 전부 통과했다.

test("context.ref 는 https 이거나 루프백 http 뿐이다 — 내부 토큰이 실려 나가는 주소다", () => {
  const base = fx("analysis-ticket-request.v1.json") as Record<string, unknown>;
  const ctxRef = base.context as Record<string, unknown>;
  const withRef = (ref: string) => ({ ...base, context: { ...ctxRef, ref } });
  const ok = (ref: string) => AnalysisTicketRequestSchema.safeParse(withRef(ref)).success;

  // 통과해야 하는 것: https(코어 발행부가 만드는 유일한 모양) + compose 로컬 루프백.
  assert.equal(ok("https://scope.example.internal/api/internal/analysis-context/w/p/v"), true);
  assert.equal(ok("http://localhost:8080/api/internal/analysis-context/w/p/v"), true);
  assert.equal(ok("http://127.0.0.1:8080/ctx"), true);
  assert.equal(ok("http://analysis-api:8080/ctx"), true);

  // 거부해야 하는 것 — 전부 "토큰이 그 주소로 평문 배달" 이다.
  for (const bad of [
    "http://10.0.0.5/api/internal/analysis-context/w/p/v", // VPC 내부 평문
    "http://169.254.169.254/latest/meta-data/", // IMDS
    "http://evil.example.com/ctx",
    "ftp://scope.example.internal/ctx",
    "file:///etc/passwd",
  ]) {
    assert.equal(ok(bad), false, `거부돼야 하는 ref 가 통과했다: ${bad}`);
  }

  // `isLaneSafeUrl` 은 두 필드가 **같은 술어**를 쓴다는 사실의 정본이다(어휘가 갈리면 한쪽만 샌다).
  assert.equal(isLaneSafeUrl("https://x.example/y"), true);
  assert.equal(isLaneSafeUrl("http://10.0.0.5/y"), false);
  assert.equal(isLaneSafeUrl("not a url"), false);
});

test("코어 발행부가 만드는 ref·callbackUrl 이 그 좁힘을 통과한다 — 정상 트래픽을 거부하지 않는다", () => {
  // 코어 픽스처(= 코어가 실제로 보내는 모양)를 그대로 태운다. 코어 베이스는
  // `ANALYSIS_LANE_CONTEXT_BASE_URL`(미설정 시 `APP_BASE_URL`) = https CloudFront 이고
  // (`infra/stacks/measurement-worker-stack.ts:636`), 경로는 `analysisContextRef` 가 붙인다.
  const raw = coreFx("analysis-ticket-request.v1.json") as Record<string, unknown>;
  const parsed = AnalysisTicketRequestSchema.parse(raw);
  assert.match(parsed.context.ref, /^https:\/\//, "코어 픽스처의 ref 가 https 가 아니다 — 모수 확인");
  assert.equal(isLaneSafeUrl(parsed.context.ref), true);
  assert.ok(parsed.callbackUrl && isLaneSafeUrl(parsed.callbackUrl));

  // ⚠️ 이 좁힘은 **코어 env 를 검사하지 못한다.** 코어 `analysisCallbackUrl`·`analysisContextRef`
  //    는 베이스의 스킴을 그대로 전파하므로, env 가 http 로 배선되면 lane 이 400 으로 전량
  //    거부한다 — 원인은 코어 env 인데 "lane 이 티켓을 거부한다" 로 읽힌다(계약 주석에 명시).
  //    그 상황을 여기서 못박아 둔다: 거부는 **의도된 동작**이고 조용한 평문 송신보다 낫다.
  const httpBase = { ...raw, callbackUrl: "http://internal-host/api/internal/analysis-callback?w=x" };
  assert.equal(AnalysisTicketRequestSchema.safeParse(httpBase).success, false);
});


// ── 검증자 잔여 리스크 하드닝 ① : 비정수 usage 가 완주한 분석을 버리게 두지 않는다 ──────
//
//   `worker/invoker.ts` 는 공급자 usage 를 `typeof === "number"` 로만 받는다 — 값의 주인은
//   업스트림 JSON 이다. 소수가 흐르면 초판은 `toReplyUsage` 의 `z.number().int()` 가 던졌고,
//   그 ZodError 는 `processTicket` 의 catch 가 **transient deferred** 로 바꾼다: LLM 실비를
//   다 쓰고 얻은 결과를 버린 뒤 같은 턴을 또 유료로 돌린다(3회 뒤 `cap_exhausted`).
//   토큰 수 하나가 소수점이라는 이유로 치르기에는 터무니없는 값이라, **거부 대신 반올림**한다.

const LEDGER_ROW = {
  task: "extract",
  poolKey: "openrouter",
  modelId: "openai/gpt-5.6-luna",
  inputTokens: 1234,
  outputTokens: 318,
  latencyMs: 21_000,
  costUsd: 0.0042,
  attempts: 1,
  outcome: "completed",
  costSource: "vendor_reported",
  httpStatus: 200,
  errorClass: null,
} as const;

test("비정수 토큰·지연은 **반올림**된다 — 원장 스키마도 투영도 던지지 않는다", () => {
  const row = AnalysisCallUsageSchema.parse({
    ...LEDGER_ROW,
    inputTokens: 1234.4,
    outputTokens: 317.6,
    latencyMs: 21_000.7,
    attempts: 1.2,
  });
  assert.equal(row.inputTokens, 1234);
  assert.equal(row.outputTokens, 318);
  assert.equal(row.latencyMs, 21_001);
  assert.equal(row.attempts, 1);
  assert.equal(row.costUsd, 0.0042, "비용은 반올림 대상이 아니다 — 센트 이하가 의미 있는 값이다");

  // 스키마를 우회해 손으로 만든 행(엔진·미래 코드)도 투영에서 접힌다.
  const projected = toReplyUsage({ ...LEDGER_ROW, inputTokens: 1234.4, latencyMs: 21_000.7 } as never);
  assert.equal(projected.inputTokens, 1234);
  assert.equal(projected.latencyMs, 21_001);
  // **코어 정본 스키마가 그 값을 받는다** = 답장이 코어에서 안 튕긴다(그게 이 하드닝의 목적).
  assert.deepEqual(AnalysisLlmUsageSchema.parse(projected), projected);
});

test("NaN·Infinity 는 키 누락으로 접힌다 — 코어 기본값 0, 그래도 던지지 않는다", () => {
  const projected = toReplyUsage({
    ...LEDGER_ROW,
    inputTokens: Number.NaN,
    outputTokens: Number.POSITIVE_INFINITY,
    latencyMs: Number.NaN,
    attempts: Number.NaN,
    costUsd: Number.POSITIVE_INFINITY,
  } as never);
  assert.equal(projected.inputTokens, 0);
  assert.equal(projected.outputTokens, 0);
  assert.equal(projected.latencyMs, 0);
  assert.equal(projected.attempts, 0);
  assert.equal(projected.costUsd, 0);
  assert.deepEqual(AnalysisLlmUsageSchema.parse(projected), projected);
});

test("미계측(null)은 여전히 0 이 아니라 **키 누락**이다 — 반올림이 그 규율을 먹지 않았다", () => {
  const projected = toReplyUsage(AnalysisCallUsageSchema.parse({ ...LEDGER_ROW, inputTokens: null, costUsd: null }));
  // 코어 계약이 null 을 표현하지 못해 0 으로 채워지는 것은 기존 동작 그대로다(원장에만 null 이 남는다).
  assert.equal(projected.inputTokens, 0);
  assert.equal(projected.costUsd, 0);
  assert.equal(projected.outputTokens, 318, "다른 축은 그대로다");
});
