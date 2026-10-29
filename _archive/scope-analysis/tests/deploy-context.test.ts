// 배포 context 불변식 — 런북 C6(엔진 기본값)·C8(공급자 키 주입).
//
// ⚠️ 두 항목 다 **조용히 틀리는** 종류다:
//    C6 — `engine` 이 `stub` 인 채 코어 플래그를 shadow 로 켜면 **B 팔이 골격 응답**이 되고,
//         shadow 비교가 "분석이 달라졌다"로 읽힌다. 실패가 아니라 **오답**이라 알람이 안 운다.
//    C8 — 공급자 키가 없으면 활성 풀 0 → `engine=core` 워커가 기동에서 죽는다. 이건 시끄럽지만
//         **함대가 안 뜨는 것**이라 램프 창을 태운다. 그래서 synth 에서 먼저 막는다.
//
// 여기서는 CDK 스택을 **실제로 합성**해 본다 — cdk.json 을 눈으로 읽는 대신 스택이 그 context 로
// 무엇을 내는지 본다(자격증명 불필요: VPC 는 fromVpcAttributes).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";

import { loadSettings } from "../app/settings.ts";
import { AnalysisStack } from "../infra/lib/analysis-stack.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const cdkJson = JSON.parse(readFileSync(`${ROOT}infra/cdk.json`, "utf8")) as {
  context: Record<string, string>;
};
const ctx = cdkJson.context;
// ⚠️ context 값이 전부 문자열은 아니다 — `llmTaskModels` 만 **객체**다(태스크 모델 5키를 한
//    덩어리로 받는다: 키를 하나씩 흩어 두면 "넷은 있고 하나가 없다" 가 눈에 안 띈다).
//    위 문자열 맵 타입 밖이라 따로 꺼낸다.
const ctxTaskModels = (cdkJson.context as unknown as Record<string, unknown>).llmTaskModels as Record<string, string>;
/** `llmTaskPools` 도 객체다 — 태스크별 `"pool:weight,…"`(0 = standby). */
const ctxTaskPools = (cdkJson.context as unknown as Record<string, unknown>).llmTaskPools as Record<string, string>;

/**
 * cdk.json 의 실제 context 로 합성한다 — 테스트가 자기 값으로 지어내지 않게.
 * `undefined` 를 넘기면 그 키를 **미설정**으로 만든다(코드 기본값을 동작으로 보기 위해).
 */
function synth(overrides: Record<string, unknown> = {}): Template {
  const app = new App({ context: { ...ctx, ...overrides } });
  const stack = new AnalysisStack(app, "ScopeAnalysis-test", { stage: "stage" });
  return Template.fromStack(stack as Stack);
}

function containerNamed(t: Template, name: string): Record<string, unknown> {
  for (const props of Object.values(t.findResources("AWS::ECS::TaskDefinition"))) {
    const containers = (props as { Properties: { ContainerDefinitions: Array<Record<string, unknown>> } })
      .Properties.ContainerDefinitions;
    const hit = containers.find((c) => c.Name === name);
    if (hit) return hit;
  }
  throw new Error(`${name} 컨테이너를 찾지 못했다`);
}

function workerContainer(t: Template): Record<string, unknown> {
  const defs = t.findResources("AWS::ECS::TaskDefinition");
  for (const props of Object.values(defs)) {
    const containers = (props as { Properties: { ContainerDefinitions: Array<Record<string, unknown>> } })
      .Properties.ContainerDefinitions;
    const worker = containers.find((c) => c.Name === "worker");
    if (worker) return worker;
  }
  throw new Error("worker 컨테이너를 찾지 못했다");
}

/** 워커/ api 컨테이너를 가진 태스크 정의의 Properties — 사이징(Cpu·Memory) 단언용. */
function taskDefWith(t: Template, container: string): { Cpu: string; Memory: string } {
  for (const props of Object.values(t.findResources("AWS::ECS::TaskDefinition"))) {
    const p = (props as { Properties: { Cpu: string; Memory: string; ContainerDefinitions: Array<{ Name: string }> } })
      .Properties;
    if (p.ContainerDefinitions.some((c) => c.Name === container)) return p;
  }
  throw new Error(`${container} 태스크 정의를 찾지 못했다`);
}

const envOf = (c: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(
    ((c.Environment ?? []) as Array<{ Name: string; Value: unknown }>).map((e) => [e.Name, String(e.Value)]),
  );
const secretNames = (c: Record<string, unknown>): string[] =>
  ((c.Secrets ?? []) as Array<{ Name: string }>).map((s) => s.Name).sort();

// ── C6: 엔진 ────────────────────────────────────────────────────────────────────

test("C6 — 스테이징 context 는 engine=core 이고 그것이 worker env 로 간다", () => {
  assert.equal(ctx.engine, "core", "cdk.json 의 engine 이 core 가 아니다 (stub 로 shadow 를 켜면 B 팔이 골격 응답이 된다)");
  assert.equal(envOf(workerContainer(synth())).ANALYSIS_ENGINE, "core");
});

test("C6 — stub 은 **명시 context 로만** 나온다 (기본값은 그대로 stub 이어야 한다)", () => {
  // 명시하면 내려간다.
  assert.equal(envOf(workerContainer(synth({ engine: "stub" }))).ANALYSIS_ENGINE, "stub");
  // 코드 기본값은 여전히 stub — 새 스테이지·새 계정에서 키 배선 없이 core 로 뜨면 기동에서 죽는다.
  // (cdk.json 이 core 를 **명시**하는 것과 코드 기본값이 stub 인 것은 서로 반대가 아니다.)
  // ⚠️ 소스 문자열 grep 이 아니라 **동작**으로 본다 — grep 은 `?? "stub"` 을 감싸는 리팩터
  //    (H3 가드 추가)에서 깨지면서 정작 기본값은 그대로였다. 키를 미설정으로 만들어 합성한다.
  //    engine 이 stub 면 llmSecretArn 가드도 안 걸리므로 키도 함께 내린다.
  const defaults = envOf(workerContainer(synth({ engine: undefined, llmSecretArn: undefined })));
  assert.equal(defaults.ANALYSIS_ENGINE, "stub");
});

test("H3 — `-c engine=`(빈/공백)은 **synth 가 죽인다** — 런타임에서 stub 으로 접히기 때문", () => {
  // 실제 경로: context "" → 태스크 정의 ANALYSIS_ENGINE="" → 런타임 str() 이 stub 으로 폴백 →
  // 워커가 조용히 스텁으로 돈다. synth 산출물에도 `Value: ""` 밖에 안 남아 아무도 못 잡는다.
  assert.throws(() => synth({ engine: "" }), /engine 이 빈\/공백 문자열이다/);
  assert.throws(() => synth({ engine: "   " }), /engine 이 빈\/공백 문자열이다/);
  // 명시값은 그대로 통과한다 — 가드는 "빈값" 만 막는다.
  assert.equal(envOf(workerContainer(synth({ engine: "core" }))).ANALYSIS_ENGINE, "core");
});

test("H3 — 런타임 settings 도 빈 ANALYSIS_ENGINE 을 stub 로 접지 않는다 (기동을 세운다)", () => {
  // CDK 가드와 **짝**이다. 태스크 정의만 고치면 로컬·compose·수동 실행 경로가 그대로 남는다.
  const prev = process.env.ANALYSIS_ENGINE;
  try {
    process.env.ANALYSIS_ENGINE = "";
    assert.throws(() => loadSettings(), /ANALYSIS_ENGINE is set but blank/);
    process.env.ANALYSIS_ENGINE = "   ";
    assert.throws(() => loadSettings(), /ANALYSIS_ENGINE is set but blank/);
    // 명시값은 통과하고 공백만 다듬는다.
    process.env.ANALYSIS_ENGINE = " core ";
    assert.equal(loadSettings().engine, "core");
    // **미설정**은 여전히 stub — "모르는 값" 과 "빈값" 은 다른 명제다.
    delete process.env.ANALYSIS_ENGINE;
    assert.equal(loadSettings().engine, "stub");
  } finally {
    if (prev === undefined) delete process.env.ANALYSIS_ENGINE;
    else process.env.ANALYSIS_ENGINE = prev;
  }
});

test("C6 — 이미지 기본값(stub)은 태스크 정의 env 가 덮는다", () => {
  // Dockerfile 의 ENV 는 로컬 편의값이다. 태스크 정의가 같은 이름을 주면 그쪽이 이긴다 —
  // 둘이 어긋나면 "이미지에 stub 이 박혀 있어서" 라는 오진이 나오므로 관계를 테스트로 남긴다.
  const dockerfile = readFileSync(`${ROOT}deploy/Dockerfile.worker`, "utf8");
  assert.match(dockerfile, /ENV ANALYSIS_ENGINE=stub/);
  assert.equal(envOf(workerContainer(synth())).ANALYSIS_ENGINE, "core");
});

// ── C8: 공급자 키 ───────────────────────────────────────────────────────────────

test("C8 — worker 에 OPENROUTER_API_KEY 가 기존 코어 시크릿에서 주입된다", () => {
  const c = workerContainer(synth());
  assert.ok(secretNames(c).includes("OPENROUTER_API_KEY"), "OPENROUTER_API_KEY 가 주입되지 않는다 (활성 풀 0 → 기동 사망)");
  const secrets = (c.Secrets ?? []) as Array<{ Name: string; ValueFrom: unknown }>;
  const openrouter = secrets.find((s) => s.Name === "OPENROUTER_API_KEY")!;
  const valueFrom = JSON.stringify(openrouter.ValueFrom);
  // ⚠️ JSON 키 형태(`:<field>::`)는 **완전 ARN** 을 요구한다 — 부분 ARN 이면 태스크가 Invalid ARN.
  assert.match(valueFrom, /secret:scope\/staging\/llm-[A-Za-z0-9]{6}:OPENROUTER_API_KEY::/);
  // 새 시크릿을 만들지 않는다 — 코어 secrets-stack.ts 의 것을 참조만 한다.
  assert.equal(Object.keys(synth().findResources("AWS::SecretsManager::Secret")).length, 1, "lane 이 만드는 시크릿은 DB 하나뿐이어야 한다");
});

test("C8 — 주입은 실행 롤에만, 그 ARN 한정. 태스크 롤에는 주지 않는다", () => {
  const t = synth();
  const policies = t.findResources("AWS::IAM::Policy");
  const llmStatements: Array<{ logicalId: string; resource: string }> = [];
  for (const [logicalId, props] of Object.entries(policies)) {
    const doc = (props as { Properties: { PolicyDocument: { Statement: Array<Record<string, unknown>> } } })
      .Properties.PolicyDocument.Statement;
    for (const st of doc) {
      const res = JSON.stringify(st.Resource ?? "");
      if (res.includes("scope/staging/llm")) llmStatements.push({ logicalId, resource: res });
    }
  }
  assert.equal(llmStatements.length, 1, `llm 시크릿 권한이 1곳이 아니다: ${JSON.stringify(llmStatements)}`);
  // 실행 롤이 주입 주체다. 앱은 env 로 받으므로 태스크 롤에는 런타임 조회 경로가 없다.
  assert.match(llmStatements[0]!.logicalId, /Worker.*ExecutionRole/);
  assert.ok(!/TaskRole/.test(llmStatements[0]!.logicalId), "태스크 롤에 붙었다 — 기능 없는 잉여 권한이다");
  // 와일드카드 금지.
  assert.ok(!llmStatements[0]!.resource.includes("scope/staging/*"), "시크릿 권한이 와일드카드다");
  assert.ok(!llmStatements[0]!.resource.includes("llm-??????"), "완전 ARN 이 아니라 와일드카드 접미사다");
});

test("C8 — 직결 풀 키는 **필드를 확인한 뒤** 상주로 켰다 (2026-09-13 · standby 페일오버의 선행 조건)", () => {
  // ⚠️ 내부 토큰 2개가 함께 있는 것은 M2 결과다 — `internalTokenSecretArn` 을 cdk.json 상주값으로
  //    올렸으므로 기본 합성에서도 배선된다(공급자 키와 **다른 축**이다).
  assert.equal(ctx.llmSecretOpenaiKeyField, "OPENAI_API_KEY");
  assert.equal(ctx.llmSecretGoogleKeyField, "GOOGLE_AI_API_KEY");
  // 앱이 읽는 env 이름(worker/llm-pools.ts DEFAULT_POOLS)으로 들어가야 한다.
  assert.deepEqual(secretNames(workerContainer(synth())), [
    "ANALYSIS_DB_PASSWORD",
    "ANALYSIS_INTERNAL_CALLBACK_TOKEN",
    "ANALYSIS_INTERNAL_CONTEXT_TOKEN",
    "GOOGLE_AI_API_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
  ]);
  // 필드명을 비우면 다시 미주입이다 — ECS 는 없는 JSON 키를 주입하려 하면 태스크 기동을
  // 실패시키므로, 시크릿에서 필드가 사라지면 여기를 비우는 것이 복구 경로다.
  // ⚠️ 그때는 `llmTaskPools` 의 직결 standby 도 같이 내려야 한다(아래 가드가 강제한다) —
  //    키 없는 풀은 비활성이라 "켜 뒀는데 안 넘어간다"가 되기 때문이다.
  const off = workerContainer(
    synth({ llmSecretOpenaiKeyField: "", llmSecretGoogleKeyField: "", llmTaskPools: undefined }),
  );
  assert.deepEqual(secretNames(off), [
    "ANALYSIS_DB_PASSWORD",
    "ANALYSIS_INTERNAL_CALLBACK_TOKEN",
    "ANALYSIS_INTERNAL_CONTEXT_TOKEN",
    "OPENROUTER_API_KEY",
  ]);
});

test("C8 — engine≠stub 인데 llmSecretArn 이 없으면 **synth 가 죽는다**", () => {
  // 배포에서 "함대가 안 뜬다"로 발견하지 않게, 합성 단계에서 막는다.
  assert.throws(() => synth({ llmSecretArn: "" }), /llmSecretArn/);
  // stub 으로 내리면 **공급자 키**가 필요 없다 — 가드는 엔진 조건부다.
  // 내부 토큰은 엔진과 무관한 축이므로 그대로 남는다(M2 상주 ARN).
  const c = workerContainer(synth({ llmSecretArn: "", engine: "stub" }));
  assert.deepEqual(secretNames(c), [
    "ANALYSIS_DB_PASSWORD",
    "ANALYSIS_INTERNAL_CALLBACK_TOKEN",
    "ANALYSIS_INTERNAL_CONTEXT_TOKEN",
  ]);
});

test("C8 — 앱이 읽는 env 이름과 주입 이름이 같다", () => {
  // 여기가 어긋나면 키는 들어갔는데 풀은 비활성이다(그리고 engine=core 는 기동에서 죽는다).
  const pools = readFileSync(`${ROOT}worker/llm-pools.ts`, "utf8");
  for (const envName of ["OPENROUTER_API_KEY", "OPENAI_API_KEY", "GOOGLE_AI_API_KEY"]) {
    assert.ok(pools.includes(`apiKeyEnv: "${envName}"`), `llm-pools.ts 가 ${envName} 를 안 읽는다`);
  }
});

// ── M2: 상주 context 값과 시크릿 참조 형태 ──────────────────────────────────────
//
// ⚠️ 세 항목 다 "한 번 성공한 뒤 조용히 되돌아가는" 종류다:
//    apiDesired — 배포 순서용 0 을 상주값으로 두면 이후 아무 배포가 접수를 다시 끈다
//    두 ARN     — 배포마다 `-c` 로 손으로 붙이는 구조는 한 번 잊으면 배선이 사라지고,
//                 그 실패는 각각 "코어가 죽었다"(토큰)·"타깃 unhealthy"(인증서)로 위장한다

test("M2 — cdk.json 은 apiDesired 를 상주값으로 갖지 않는다 (운영값 1 이 스택 기본)", () => {
  assert.ok(
    !("apiDesired" in ctx),
    "cdk.json 이 apiDesired 를 고정한다 — 0 은 배포 순서용 일시 상태이지 상주 기본값이 아니다",
  );
  const desired = (t: Template): number => {
    const [, props] = Object.entries(t.findResources("AWS::ECS::Service")).find(([lid]) =>
      lid.startsWith("ApiService"),
    )!;
    return (props as { Properties: { DesiredCount: number } }).Properties.DesiredCount;
  };
  assert.equal(desired(synth()), 1, "스택 기본이 운영값 1 이 아니다 (승인 L3 ⓐ)");
  // 1단계는 **명령줄에서 명시**한다. README 배포 순서 표가 그 명시를 적어 둔다.
  assert.equal(desired(synth({ apiDesired: "0" })), 0);
  assert.match(
    readFileSync(`${ROOT}README.md`, "utf8"),
    /-c apiDesired=0/,
    "README 배포 순서 표에 `-c apiDesired=0` 이 없다 — 1단계를 재현할 방법이 사라진다",
  );
});

test("M2 — 내부 토큰이 상주 ARN 으로 worker TD 에 주입된다 (완전 ARN · JSON 키 형태)", () => {
  assert.match(
    ctx.internalTokenSecretArn ?? "",
    /^arn:aws:secretsmanager:us-west-2:371056712389:secret:scope-analysis\/stage\/internal-token-[A-Za-z0-9]{6}$/,
    "internalTokenSecretArn 이 상주 완전 ARN 이 아니다 (부분 ARN 이면 태스크가 Invalid ARN 으로 죽는다)",
  );
  const c = workerContainer(synth());
  const valueFrom = Object.fromEntries(
    ((c.Secrets ?? []) as Array<{ Name: string; ValueFrom: unknown }>).map((s) => [s.Name, JSON.stringify(s.ValueFrom)]),
  );
  // 두 라우트의 토큰은 **따로** 간다 — 코어가 서로 다른 env 로 비교한다(합치면 조용히 404).
  assert.match(valueFrom.ANALYSIS_INTERNAL_CALLBACK_TOKEN ?? "", /internal-token-[A-Za-z0-9]{6}:callback_token::/);
  assert.match(valueFrom.ANALYSIS_INTERNAL_CONTEXT_TOKEN ?? "", /internal-token-[A-Za-z0-9]{6}:context_token::/);
  // 값이 아니라 **출처**가 env 로도 간다(기동 단언·진단 지문용).
  assert.equal(envOf(c).ANALYSIS_LANE_INTERNAL_TOKEN_SECRET_ARN, ctx.internalTokenSecretArn);
  // api 는 코어로 나가지 않으므로 토큰을 받지 않는다.
  assert.deepEqual(secretNames(containerNamed(synth(), "api")), ["ANALYSIS_DB_PASSWORD"]);
  // 미설정으로 내리면 배선이 사라진다 — 1단계(코어 플래그 off)에서 정상인 상태.
  const off = secretNames(workerContainer(synth({ internalTokenSecretArn: "" })));
  assert.ok(!off.includes("ANALYSIS_INTERNAL_CALLBACK_TOKEN"), "미설정인데 토큰이 배선됐다");
});

test("M2 — 인그레스 인증서는 완전 ARN 으로 참조하고 태스크 롤 정책에 와일드카드가 없다", () => {
  assert.match(
    ctx.ingressCertSecretArn ?? "",
    /^arn:aws:secretsmanager:us-west-2:371056712389:secret:scope-analysis\/stage\/ingress-cert-[A-Za-z0-9]{6}$/,
    "ingressCertSecretArn 이 상주 완전 ARN 이 아니다",
  );
  const t = synth();
  // 컨테이너에는 **값이 아니라 그 ARN** 이 간다(entrypoint 의 --secret-id).
  assert.equal(
    envOf(containerNamed(t, "ingress")).ANALYSIS_INGRESS_CERT_SECRET_ID,
    ctx.ingressCertSecretArn,
  );
  // 태스크 롤 정책 = GetSecretValue 하나 · 대상은 정확히 그 ARN 1개.
  const found: Array<{ logicalId: string; actions: string[]; resource: string }> = [];
  for (const [logicalId, props] of Object.entries(t.findResources("AWS::IAM::Policy"))) {
    const doc = (props as { Properties: { PolicyDocument: { Statement: Array<Record<string, unknown>> } } })
      .Properties.PolicyDocument.Statement;
    for (const st of doc) {
      if (st.Sid !== "IngressCertRead") continue;
      const a = st.Action;
      found.push({
        logicalId,
        actions: Array.isArray(a) ? (a as string[]) : [a as string],
        resource: JSON.stringify(st.Resource ?? ""),
      });
    }
  }
  assert.equal(found.length, 1, `IngressCertRead 문장이 1개가 아니다: ${JSON.stringify(found)}`);
  assert.deepEqual(found[0]!.actions, ["secretsmanager:GetSecretValue"]);
  assert.match(found[0]!.logicalId, /ApiTaskTaskRole/, "태스크 롤이 아니라 다른 롤에 붙었다");
  assert.equal(found[0]!.resource, JSON.stringify(ctx.ingressCertSecretArn));
  assert.ok(!found[0]!.resource.includes("??????"), "완전 ARN 인데 와일드카드 접미사가 남았다");
  // 이름 폴백 경로는 여전히 와일드카드다 — 새 스테이지용이고, 그래서 ARN 을 쓰는 것이다.
  const byName = JSON.stringify(
    synth({ ingressCertSecretArn: "" }).findResources("AWS::IAM::Policy"),
  );
  assert.ok(byName.includes("ingress-cert-??????"), "이름 폴백 경로가 사라졌다");
});

// ⚠️ **SG 설명 문구는 라이브 SG 와 바이트 단위로 같아야 한다.**
//    `AWS::EC2::SecurityGroup.GroupDescription` 은 CloudFormation 불변 속성이라 한 글자만
//    달라도 **replace** 가 되고, `securityGroupName` 이 고정이라 그 replace 는 "같은 이름이
//    이미 있다" 로 **배포를 실패시킨다**. 실제로 그 사고가 났다 — F9 헬스체크 규칙을 추가할 때
//    설명에 "and the NLB health checker" 를 덧붙여, 2026-09-12 `cdk diff` 가
//    `ApiSg … replace / GroupDescription (requires replacement)` 를 냈다(배포 전 차단).
//    규칙 추가는 in-place 이고 **설명 변경만** 교체다 → 문구는 얼린다. 바꿔야 하면
//    SG 교체 + NLB 타깃 재등록 + 참조 갱신을 한 세트로 계획하고 이 상수를 같이 고친다.
const LIVE_SG_DESCRIPTIONS: Record<string, string> = {
  "scope-analysis-api-stage": "analysis-api: inbound only 8443 mTLS from the scope core client SG",
  "scope-analysis-worker-stage": "analysis-worker: no inbound; egress to LLM providers and the lane RDS",
  "scope-analysis-db-stage": "analysis lane RDS: 5432 from api/worker SGs only",
};

test("F9/SG — SG 설명은 라이브 값으로 얼려 둔다 (문구 변경 = 교체 = 배포 실패)", () => {
  const t = synth();
  const seen: Record<string, string> = {};
  for (const props of Object.values(t.findResources("AWS::EC2::SecurityGroup"))) {
    const p = (props as { Properties: { GroupName?: string; GroupDescription?: string } }).Properties;
    if (p.GroupName) seen[p.GroupName] = p.GroupDescription ?? "";
  }
  assert.deepEqual(seen, LIVE_SG_DESCRIPTIONS);
});

test("F9 — NLB 헬스체크(타깃 타입 ip)가 들어올 인그레스 규칙이 api SG 에 있다", () => {
  const t = synth();
  const api = Object.values(t.findResources("AWS::EC2::SecurityGroup")).find(
    (props) => (props as { Properties: { GroupName?: string } }).Properties.GroupName === "scope-analysis-api-stage",
  ) as { Properties: { SecurityGroupIngress?: Array<Record<string, unknown>> } } | undefined;
  const rules = api?.Properties.SecurityGroupIngress ?? [];
  const cidrRule = rules.find((r) => r.CidrIp === "10.0.0.0/16");
  assert.ok(cidrRule, `VPC CIDR 인그레스가 없다 — 타깃이 영원히 unhealthy 가 된다: ${JSON.stringify(rules)}`);
  assert.equal(cidrRule!.FromPort, 8443);
  assert.equal(cidrRule!.ToPort, 8443);
  assert.equal(cidrRule!.IpProtocol, "tcp");
});

// ── 컨텍스트 fetch 상한 — **배선돼 있지 않던 값**(2026-09-13) ───────────────────
//
// `app/settings.ts` 에 `ANALYSIS_CONTEXT_FETCH_TIMEOUT_MS` 가 있는데 태스크 정의가 주지 않아
// 라이브는 코드 기본값으로만 돌았고, 값을 바꾸려면 이미지를 다시 구워야 했다. 컨텍스트 응답이
// 14.4 MB(brotli 37.5s / gzip 3.0s 실측)라 이 상한은 램프에서 조일 축이다.

test("컨텍스트 fetch 상한이 태스크 정의 env 로 내려간다 (worker·api 둘 다)", () => {
  const t = synth();
  assert.equal(ctx.contextFetchTimeoutMs, "60000", "cdk.json 의 contextFetchTimeoutMs 가 60000 이 아니다");
  for (const name of ["worker", "api"]) {
    assert.equal(
      envOf(containerNamed(t, name)).ANALYSIS_CONTEXT_FETCH_TIMEOUT_MS,
      "60000",
      `${name} 컨테이너에 상한이 안 내려갔다 — 코드 기본값으로만 도는 상태로 되돌아간다`,
    );
  }
});

test("context 미설정이어도 코드 기본값 60000 이 내려간다 — 배선이 context 존재에 의존하지 않는다", () => {
  // `-c contextFetchTimeoutMs` 를 지운 새 스테이지에서도 20s 로 되돌아가면 안 된다.
  const t = synth({ contextFetchTimeoutMs: undefined });
  assert.equal(envOf(containerNamed(t, "worker")).ANALYSIS_CONTEXT_FETCH_TIMEOUT_MS, "60000");
});

// ── B2: 태스크별 모델 — **배선돼 있지 않던 값**(2026-09-13 라이브 TD rev 9) ──────────
//
// `worker/llm-pools.ts` 의 override 가 비면 `BUILT_IN_DEFAULTS`(alias haiku/sonnet)로 접힌다.
// 규칙은 코어와 같지만 **배선이 없어서** lane 이 코어와 다른 모델로 돌았다:
// extract·semantics=`claude-haiku-4.5` · resolve=`claude-sonnet-4.6`
// (코어 `measurement-worker-staging:238` 은 `gpt-5.6-luna` · `gemini-3.1-flash-lite`).
// 콜은 전부 200 이라 실패로 안 보이고, 턴 체류 2.3배·단가 17배·shadow A/B 무효만 남았다.

/** cdk.json 이 주입하는 모델 키 — `tests/model-parity.test.ts` 가 코어 TD 정본과 대조한다. */
const TASK_MODEL_KEYS = Object.keys(ctxTaskModels);

test("B2 — 태스크 모델 키가 전부 worker 태스크 정의 env 로 내려간다 (cdk.json 값 그대로)", () => {
  const env = envOf(workerContainer(synth()));
  assert.deepEqual(
    Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith("LLM_TASK_MODEL_"))),
    ctxTaskModels,
    "worker TD 의 모델 env 가 cdk.json 과 다르다 — 이게 비면 alias 기본값으로 접힌다",
  );
  // 2026-09-14 WU2: 답변 단위 브랜드 스탠스 태스크가 6번째 키다(스펙 §4.1).
  // 개수의 **정본은 코드**(`CORE_TASK_MODEL_ENV_KEYS`)이고 cdk.json 이 그것을 다 채워야 한다 —
  // 그 대조는 `tests/model-parity.test.ts` 가 한다. 여기서는 synth 가 하나도 흘리지 않는지만 본다.
  assert.equal(TASK_MODEL_KEYS.length, 6);
});

test("B2 — api 에는 넣지 않는다 (LLM 을 부르지 않는다 — commonEnv 가 아니라 workerEnv 인 이유)", () => {
  const env = envOf(containerNamed(synth(), "api"));
  assert.deepEqual(
    Object.keys(env).filter((k) => k.startsWith("LLM_TASK_MODEL_")),
    [],
    "api 에 모델 설정이 들어갔다 — 'api 도 분석을 한다' 는 오독만 만든다",
  );
});

test("B2 — engine≠stub 인데 llmTaskModels 가 비면 **synth 가 죽는다**", () => {
  // llmSecretArn 가드와 같은 자리·같은 이유 — 배포에서 "모델이 다르다"를 겪지 않게.
  assert.throws(() => synth({ llmTaskModels: undefined }), /llmTaskModels/);
  assert.throws(() => synth({ llmTaskModels: {} }), /llmTaskModels/);
  // 키 하나만 빠져도 죽는다 — 그 태스크 **하나만** 조용히 다른 모델로 도는 것이 최악이다.
  for (const key of TASK_MODEL_KEYS) {
    const partial = { ...ctxTaskModels };
    delete partial[key];
    assert.throws(() => synth({ llmTaskModels: partial }), new RegExp(key), `${key} 가 빠졌는데 synth 가 통과했다`);
    assert.throws(() => synth({ llmTaskModels: { ...ctxTaskModels, [key]: "" } }), new RegExp(key));
  }
});

test("B2 — stub 엔진은 예외다 (LLM 을 안 부르므로 모델을 요구하지 않는다)", () => {
  const c = workerContainer(synth({ llmTaskModels: undefined, engine: "stub", llmSecretArn: "" }));
  assert.deepEqual(Object.keys(envOf(c)).filter((k) => k.startsWith("LLM_TASK_MODEL_")), []);
});

test("B2 — 형식이 틀린 값·모르는 키는 synth 가 죽인다 (오타난 키는 조용히 폴백이 된다)", () => {
  const base = ctxTaskModels;
  const key = TASK_MODEL_KEYS[0]!;
  assert.throws(() => synth({ llmTaskModels: { ...base, [key]: "bedrock:haiku" } }), /형식이 틀렸다/);
  assert.throws(() => synth({ llmTaskModels: { ...base, [key]: "haiku" } }), /형식이 틀렸다/);
  assert.throws(() => synth({ llmTaskModels: { ...base, [key]: "openrouter/gpt-5.6-luna" } }), /형식이 틀렸다/);
  // 오타난 키를 조용히 무시하면 그 태스크는 alias 로 접힌다 — 그래서 모르는 키도 죽인다.
  assert.throws(
    () => synth({ llmTaskModels: { ...base, LLM_TASK_MODEL_measurement_analysis_extract_mention: "openrouter/openai/gpt-5.6-luna" } }),
    /알 수 없는 키/,
  );
  assert.throws(() => synth({ llmTaskModels: "openrouter/openai/gpt-5.6-luna" }), /객체여야 한다/);
});

// ── P18: 직결 풀 standby 페일오버 (운영 결정 2026-09-13) ────────────────────────
//
// ⚠️ 이 배선의 실패 모드는 전부 **"아무 일도 안 일어난다"** 이다 — standby 는 정의상
//    OpenRouter 가 아플 때만 발화하므로, 잘못 배선해도 평시에는 아무 증상이 없다.
//    그래서 합성이 셋을 죽인다: 오타 키 · 모델↔풀 벤더 불일치 · 키 필드 미주입.

test("P18 — cdk.json 의 태스크 풀이 worker env 로 가고, 평시 가중치는 openrouter 단독이다", () => {
  const env = envOf(workerContainer(synth()));
  for (const [key, value] of Object.entries(ctxTaskPools)) {
    assert.equal(env[key], value, `${key} 가 worker TD 로 안 갔다`);
    // **평시 트래픽은 OpenRouter 100%** — weight>0 인 풀이 openrouter 하나여야 한다.
    const positive = value
      .split(",")
      .map((part) => part.split(":").map((s) => s.trim()))
      .filter(([, w]) => Number(w ?? 1) > 0)
      .map(([k]) => k);
    assert.deepEqual(positive, ["openrouter"], `${key} 가 직결에 평시 트래픽을 준다 — 그건 페일오버가 아니라 분산이다`);
  }
  // api 컨테이너에는 안 들어간다 — LLM 을 부르는 것은 워커뿐이다(모델 env 와 같은 축).
  const api = envOf(containerNamed(synth(), "api"));
  assert.deepEqual(Object.keys(api).filter((k) => k.startsWith("LLM_TASK_POOLS_")), []);
});

test("P18 — 태스크마다 **그 모델의 벤더 직결만** standby 다 (풀이 바뀌어도 모델은 안 바뀐다)", () => {
  const VENDOR_POOL: Record<string, string> = { openai: "openai_direct", google: "google_direct" };
  for (const [poolKey, spec] of Object.entries(ctxTaskPools)) {
    const modelKey = poolKey.replace("LLM_TASK_POOLS_", "LLM_TASK_MODEL_");
    const vendor = String(ctxTaskModels[modelKey]).split("/")[1]!;
    const standby = spec
      .split(",")
      .map((part) => part.split(":").map((s) => s.trim()))
      .filter(([, w]) => Number(w ?? 1) === 0)
      .map(([k]) => k);
    // 2026-09-14: standby 가 없는 태스크(openrouter 단독)도 허용한다 — extract·resolve 는 openai_direct 가
    // temperature 1 만 받아 게이트③ 조건과 달라서 뺐다(cdk.json (내부 결정 기록)).
    if (standby.length === 0) continue;
    assert.deepEqual(standby, [VENDOR_POOL[vendor]], `${poolKey}: 모델 벤더(${vendor})와 다른 직결 풀이 걸렸다 — 404 다`);
  }
});

test("P18 — 미설정이면 `LLM_TASK_POOLS_*` env 가 **하나도 없다**(= 이 PR 이전 동작)", () => {
  const env = envOf(workerContainer(synth({ llmTaskPools: undefined })));
  assert.deepEqual(Object.keys(env).filter((k) => k.startsWith("LLM_TASK_POOLS_")), []);
  // 모델 env 는 그대로 있어야 한다 — 두 축은 독립이다.
  assert.equal(env.LLM_TASK_MODEL_measurement_analysis_extract_mentions, ctxTaskModels.LLM_TASK_MODEL_measurement_analysis_extract_mentions);
});

test("P18 — 오타난 태스크 키는 **synth 가 죽인다**(조용히 무시되면 standby 가 없는데 있다고 믿는다)", () => {
  assert.throws(
    () => synth({ llmTaskPools: { LLM_TASK_POOLS_measurement_analysis_extract_mention: "openrouter:1" } }),
    /알 수 없는 키/,
  );
  // lane 이 안 부르는 태스크도 오타와 같다 — 읽는 코드가 없다.
  assert.throws(
    () => synth({ llmTaskPools: { LLM_TASK_POOLS_measurement_analysis_unknown_discovery: "openrouter:1" } }),
    /알 수 없는 키/,
  );
  assert.throws(() => synth({ llmTaskPools: "openrouter:1" }), /객체여야 한다/);
});

test("P18 — 빈 값·모르는 풀·음수 가중치는 synth 가 죽인다", () => {
  const base = ctxTaskPools;
  const key = "LLM_TASK_POOLS_measurement_analysis_extract_mentions";
  // 빈 값은 런타임이 **미설정으로 접는다** — '켰다고 믿는데 안 켜진' 상태.
  assert.throws(() => synth({ llmTaskPools: { ...base, [key]: "  " } }), /비었다/);
  assert.throws(() => synth({ llmTaskPools: { ...base, [key]: "openrouter:1,acme:0" } }), /내장 풀이 아니다/);
  assert.throws(() => synth({ llmTaskPools: { ...base, [key]: "openrouter:1,openai_direct:-1" } }), /가중치/);
  assert.throws(() => synth({ llmTaskPools: { ...base, [key]: "openrouter:1,openai_direct:x" } }), /가중치/);
});

test("P18 — 모델↔풀 벤더 불일치는 synth 가 죽인다 (라이브에선 OpenRouter 가 아플 때만 보인다)", () => {
  const base = ctxTaskPools;
  // extract 는 luna(openai) 다 — google_direct 로 넘기면 wire id 가 `gpt-5.6-luna` 인 채 404.
  assert.throws(
    () =>
      synth({
        llmTaskPools: { ...base, LLM_TASK_POOLS_measurement_analysis_extract_mentions: "openrouter:1,google_direct:0" },
      }),
    /벤더만 받는다/,
  );
  // semantics 는 flash-lite(google) 다 — 반대 방향도 같다.
  assert.throws(
    () =>
      synth({
        llmTaskPools: { ...base, LLM_TASK_POOLS_measurement_analysis_mention_semantics: "openrouter:1,openai_direct:0" },
      }),
    /벤더만 받는다/,
  );
});

test("P18 — standby 를 켰는데 그 키 필드가 비면 synth 가 죽인다 (키 없는 풀은 비활성이다)", () => {
  // 2026-09-14: 상주 cdk.json 은 openai_direct standby 를 쓰지 않으므로 OpenAI 필드를 비워도 죽지 않는다.
  // standby 로 참조되는 풀(google_direct)의 필드가 비면 여전히 죽는다.
  assert.doesNotThrow(() => synth({ llmSecretOpenaiKeyField: "" }));
  assert.throws(() => synth({ llmSecretGoogleKeyField: "" }), /llmSecretGoogleKeyField 가 비었다/);
  // openai_direct 를 standby 로 다시 켜면 그 필드 부재는 synth 가 죽인다(가드 자체는 살아 있다).
  assert.throws(
    () => synth({ llmSecretOpenaiKeyField: "", llmTaskPools: { ...ctxTaskPools, LLM_TASK_POOLS_measurement_analysis_extract_mentions: "openrouter:1,openai_direct:0" } }),
    /llmSecretOpenaiKeyField 가 비었다/,
  );
  // 둘 다 내리려면 standby 도 함께 내려야 한다 — 그 조합은 통과한다(= openrouter 단독).
  assert.doesNotThrow(() => synth({ llmSecretOpenaiKeyField: "", llmSecretGoogleKeyField: "", llmTaskPools: undefined }));
});

test("WU6 F4 — 스탠스 관측 3축이 메트릭 필터로 나온다 (분모 포함)", () => {
  const filters = Object.values(synth().findResources("AWS::Logs::MetricFilter")).map(
    (props) => (props as { Properties: { MetricTransformations: Array<Record<string, unknown>>; FilterPattern: string } }).Properties,
  );
  // ⚠️ **분모(StanceTurns)가 같이 있어야 한다.** 실패 수만 올리면 램프 중에 항상 빨갛고,
  //    "실패가 늘었다" 와 "물량이 늘었다" 가 구분되지 않는다.
  const expected: Array<[string, string]> = [
    ["StanceTurns", "stanceEnabled"],
    ["StanceFailedTurns", "stanceFailed"],
    ["StanceFailedCalls", "stanceCallsFailed"],
  ];
  for (const [metric, field] of expected) {
    const hit = filters.find((f) => (f.MetricTransformations[0] as { MetricName: string }).MetricName === metric);
    assert.ok(hit, `${metric} 필터가 없다 — 스탠스 결손이 조용해진다`);
    // 워커가 찍는 필드 이름과 같아야 한다(`worker/main.ts` `analysis_lane.stance_observed`).
    // 이름이 갈리면 필터가 영영 매칭되지 않고 지표가 0 으로 굳는다(F2 의 InflightCalls 전례).
    assert.match(hit.FilterPattern, new RegExp(field), `${metric} 의 필드 이름이 워커와 다르다`);
    assert.equal((hit.MetricTransformations[0] as { DefaultValue?: number }).DefaultValue, 0, `${metric} 은 사건 카운트라 defaultValue 0 이어야 한다`);
  }
});

test("PR-L1 — 감성 V2 섀도 관측 3축이 메트릭 필터로 나온다 (분모 포함, 알람은 없다)", () => {
  const synthed = synth();
  const filters = Object.values(synthed.findResources("AWS::Logs::MetricFilter")).map(
    (props) => (props as { Properties: { MetricTransformations: Array<Record<string, unknown>>; FilterPattern: string } }).Properties,
  );
  const expected: Array<[string, string]> = [
    ["SemanticsShadowTurns", "semanticsShadowEnabled"],
    ["SemanticsShadowFailedTurns", "semanticsShadowFailed"],
    ["SemanticsShadowFailedCalls", "semanticsShadowCallsFailed"],
  ];
  for (const [metric, field] of expected) {
    const hit = filters.find((f) => (f.MetricTransformations[0] as { MetricName: string }).MetricName === metric);
    assert.ok(hit, `${metric} 필터가 없다 — 섀도 결손이 조용해진다`);
    // 워커가 찍는 필드 이름과 같아야 한다(`worker/main.ts` `analysis_lane.semantics_v2_shadow_observed`).
    // 이름이 갈리면 필터가 영영 매칭되지 않고 지표가 0 으로 굳는다(F2 의 InflightCalls 전례).
    assert.match(hit.FilterPattern, new RegExp(field), `${metric} 의 필드 이름이 워커와 다르다`);
    assert.equal((hit.MetricTransformations[0] as { DefaultValue?: number }).DefaultValue, 0, `${metric} 은 사건 카운트라 defaultValue 0 이어야 한다`);
  }
  // ⚠️ **알람을 만들지 않는다**(룰 alert-routing: 목적지를 늘리지 않는다). 섀도 실패의 목적지는
  //    GitHub Issue 이고, 여기는 판단의 근거가 되는 지표만 남긴다.
  const alarmNames = Object.values(synthed.findResources("AWS::CloudWatch::Alarm")).map(
    (props) => String((props as { Properties: { AlarmName?: string } }).Properties.AlarmName ?? ""),
  );
  assert.deepEqual(
    alarmNames.filter((n) => n.toLowerCase().includes("shadow")),
    [],
    "섀도 알람이 생겼다 — 이 PR 은 알림 목적지를 늘리지 않는다",
  );
});

test("P18 — standby 발화가 CloudWatch 메트릭으로 나온다 (원장은 티켓이 끝나야 적재된다)", () => {
  const filters = Object.values(synth().findResources("AWS::Logs::MetricFilter")).map(
    (props) => (props as { Properties: { MetricTransformations: Array<Record<string, unknown>>; FilterPattern: string } }).Properties,
  );
  const hit = filters.find((f) => (f.MetricTransformations[0] as { MetricName: string }).MetricName === "PoolStandbyCalls");
  assert.ok(hit, "PoolStandbyCalls 필터가 없다 — 진행 중인 페일오버를 볼 축이 사라진다");
  // 워커가 찍는 필드 이름과 같아야 한다(`worker/invoker.ts` `analysis_lane.pool_standby`).
  assert.match(hit.FilterPattern, /standbyCall/);
  // 0 이 정상인 사건 카운트다 — defaultValue 가 없으면 정상 구간이 통째로 '데이터 없음'이다.
  assert.equal((hit.MetricTransformations[0] as { DefaultValue?: number }).DefaultValue, 0);
});

// ── B4: unitConcurrency ≤ 워커당 콜 슬롯 ────────────────────────────────────────
//
// 슬롯 = floor((llmTotalConcurrency − hostingInflight) / workerMax) = floor((640−32)/24) = 25 ≥ 유닛 24
// (2026-09-14 램프 1단계는 floor((420−32)/24) = 16 = 유닛 16, 그 전은 floor((300−32)/16) = 16.)
// (`worker/concurrency.ts` computeWorkerCallSlots — 스택이 **그 함수를 그대로** 부른다).
// 상주값 40 은 2.5배 초과구독이었다: 24개가 세마포어 대기열에 서고, 대기 34.7s 가
// `llmSlotAcquireTimeoutMs` 30s 를 넘겨 CapacityTimeoutError → deferred → 재시도 3회 소진.

test("B4 — cdk.json 상주 unitConcurrency(16) 가 워커당 콜 슬롯(16)과 같다", () => {
  // 2026-09-14 램프 3단계(1 vCPU × 48): workerMax 48 · llmTotalConcurrency 800 · 유닛 16.
  // 셋이 같이 움직여야 한다 — 하나만 바꾸면 슬롯이 16 에서 벗어나 아래 부등식이 synth 를 죽인다.
  assert.equal(ctx.workerMax, "48", "상주 workerMax 가 48 이 아니다 — 1 vCPU × 48 전환이 되돌려졌다");
  assert.equal(ctx.llmTotalConcurrency, "800", "상주 llmTotalConcurrency 가 800 이 아니다 — 슬롯 산식이 바뀐다");
  assert.equal(envOf(workerContainer(synth())).ANALYSIS_WORKER_MAX_COUNT, "48");
  assert.equal(envOf(workerContainer(synth())).ANALYSIS_LLM_TOTAL_CONCURRENCY, "800");
  assert.equal(ctx.unitConcurrency, "16", "상주값이 슬롯(16)을 넘거나 램프 3단계(16)에서 벗어났다");
  assert.equal(envOf(workerContainer(synth())).ANALYSIS_WORKER_UNIT_CONCURRENCY, "16");
  // floor((800 − 32) / 48) = 16 — **딱 맞는다**(나머지 0). 유닛을 더 올리면 synth 가 죽는다.
  assert.equal(Math.floor((800 - 32) / 48), 16);
  // 유닛 24 → 16 은 처리량 손실이 아니다: 유닛은 **워커당** 값이고 워커가 2배다(576 → 768).
  assert.ok(48 * 16 > 24 * 24, "총 유닛이 줄었다 — 전환의 전제가 깨졌다");
  // 라이브가 `-c unitConcurrency=8` 로 상주값을 피해 가던 경로 — 명시값은 그대로 내려간다.
  assert.equal(envOf(workerContainer(synth({ unitConcurrency: "8" }))).ANALYSIS_WORKER_UNIT_CONCURRENCY, "8");
});

test("B4 — 슬롯을 넘는 unitConcurrency 는 **synth 가 죽인다**", () => {
  assert.throws(() => synth({ unitConcurrency: "17" }), /워커당 콜 슬롯 16/);
  assert.throws(() => synth({ unitConcurrency: "40" }), /워커당 콜 슬롯 16/);
  // 부등식은 세 값의 함수다 — 상한을 올리면(램프 L6) 유닛도 같이 올릴 수 있다.
  // (workerMax 를 명시해 상주값(24)과 독립으로 둔다 — 상주값이 바뀌어도 이 산술은 그대로다.)
  assert.equal(
    envOf(workerContainer(synth({ workerMax: "16", llmTotalConcurrency: "640", unitConcurrency: "38" })))
      .ANALYSIS_WORKER_UNIT_CONCURRENCY,
    "38",
  );
  // floor((640−32)/16)=38 이므로 39 는 죽는다.
  assert.throws(
    () => synth({ workerMax: "16", llmTotalConcurrency: "640", unitConcurrency: "39" }),
    /워커당 콜 슬롯 38/,
  );
  // 상주값(800, 48)에서 슬롯 16 을 꽉 채우는 유닛 16 은 허용(= 상주값 그대로).
  assert.equal(envOf(workerContainer(synth({ unitConcurrency: "16" }))).ANALYSIS_WORKER_UNIT_CONCURRENCY, "16");
  // 함대를 줄이면 워커당 슬롯은 늘어난다(전역 상한은 그대로): floor((800−32)/2)=384.
  assert.equal(envOf(workerContainer(synth({ workerMax: "2", unitConcurrency: "384" }))).ANALYSIS_WORKER_UNIT_CONCURRENCY, "384");
  assert.throws(() => synth({ workerMax: "2", unitConcurrency: "385" }), /워커당 콜 슬롯 384/);
});

test("B4 — 용량 셋이 양의 정수가 아니면 synth 가 죽는다 (산식이 성립하지 않는다)", () => {
  assert.throws(() => synth({ unitConcurrency: "0" }), /양의 정수가 아니다/);
  assert.throws(() => synth({ llmTotalConcurrency: "abc" }), /양의 정수가 아니다/);
  assert.throws(() => synth({ hostingInflight: "1.5" }), /양의 정수가 아니다/);
});

test("런타임 settings 기본값도 60s 다 — 태스크 정의 밖 경로(로컬·compose)와 어긋나지 않게", () => {
  const prev = process.env.ANALYSIS_CONTEXT_FETCH_TIMEOUT_MS;
  try {
    delete process.env.ANALYSIS_CONTEXT_FETCH_TIMEOUT_MS;
    assert.equal(loadSettings().contextFetchTimeoutMs, 60_000);
    process.env.ANALYSIS_CONTEXT_FETCH_TIMEOUT_MS = "12345";
    assert.equal(loadSettings().contextFetchTimeoutMs, 12_345, "env 가 기본값을 못 덮는다");
  } finally {
    if (prev === undefined) delete process.env.ANALYSIS_CONTEXT_FETCH_TIMEOUT_MS;
    else process.env.ANALYSIS_CONTEXT_FETCH_TIMEOUT_MS = prev;
  }
});

// ── B1 · A1/A2 · A4/B6 · B8/A6 — 오토스케일·배포 안전 (설계 리뷰 인프라 P0/P1) ────────
//
// 네 결함의 공통점: **synth 도 배포도 통과했고, 라이브에서만 조용히 틀렸다.**
//   B1    존재하지 않는 메트릭(AWS/ECS RunningTaskCount) → 타깃추적 알람이 굶어 영구
//         INSUFFICIENT_DATA → **오토스케일이 한 번도 작동한 적 없음**
//   A1/A2 `desiredCount: workerDesired`(상주 "0") → 모든 배포가 함대를 0 으로 되돌림
//   A4/B6 예열 Lower 스텝(EXACT_CAPACITY 0)이 영구 ALARM → 타깃추적이 올린 용량을 되돌림
//   B8/A6 워커가 믿는 드레인 예산 600s vs Fargate stopTimeout 120s
// 그래서 전부 **합성 산출물에 대한 단언**으로 박는다 — 소스 grep 은 리팩터에서 깨진다.

/** 스케일러블 타깃(worker) 한 개를 꺼낸다. */
function scalableTarget(t: Template): { MinCapacity: number; MaxCapacity: number } {
  const found = Object.values(t.findResources("AWS::ApplicationAutoScaling::ScalableTarget"));
  assert.equal(found.length, 1, "스케일러블 타깃이 1개가 아니다");
  return (found[0] as { Properties: { MinCapacity: number; MaxCapacity: number } }).Properties;
}

/** 스케일링 정책 전부 — `{logicalId, PolicyType, …}`. */
function scalingPolicies(t: Template): Array<{ logicalId: string; props: Record<string, unknown> }> {
  return Object.entries(t.findResources("AWS::ApplicationAutoScaling::ScalingPolicy")).map(([logicalId, props]) => ({
    logicalId,
    props: (props as { Properties: Record<string, unknown> }).Properties,
  }));
}

function serviceNamed(t: Template, prefix: string): Record<string, unknown> {
  const hit = Object.entries(t.findResources("AWS::ECS::Service")).find(([lid]) => lid.startsWith(prefix));
  assert.ok(hit, `${prefix} 로 시작하는 ECS 서비스가 없다`);
  return (hit![1] as { Properties: Record<string, unknown> }).Properties;
}

test("B1 — 타깃추적 분모는 **ECS/ContainerInsights** 의 RunningTaskCount 다 (AWS/ECS 에는 없다)", () => {
  // 2026-09-13 라이브 실측:
  //   list-metrics --namespace AWS/ECS → CPUUtilization · MemoryUtilization · LiveTaskCount **뿐**
  //   list-metrics --namespace ECS/ContainerInsights --metric-name RunningTaskCount
  //     → ClusterName=scope-analysis-stage · ServiceName=analysis-worker-stage ✅
  // 존재하지 않는 메트릭은 에러가 아니라 침묵이다 — 알람이 INSUFFICIENT_DATA 로 굳고
  // 오토스케일은 "있는데 안 도는" 상태가 된다(생성 2026-09-12 21:57 이후 전이 0회).
  const t = synth();
  const tt = scalingPolicies(t).filter((p) => p.props.PolicyType === "TargetTrackingScaling");
  assert.equal(tt.length, 1, "타깃추적 정책이 1개가 아니다");
  const metrics = (
    tt[0]!.props.TargetTrackingScalingPolicyConfiguration as {
      CustomizedMetricSpecification: { Metrics: Array<Record<string, any>> };
    }
  ).CustomizedMetricSpecification.Metrics;
  const tasks = metrics.find((m) => m.Id === "tasks");
  assert.ok(tasks, "분모 메트릭(tasks)이 없다");
  assert.equal(tasks!.MetricStat.Metric.Namespace, "ECS/ContainerInsights");
  assert.equal(tasks!.MetricStat.Metric.MetricName, "RunningTaskCount");
  // 차원 2개(ClusterName·ServiceName)가 없으면 클러스터 전체를 세거나 아무것도 못 센다.
  const dimNames = (tasks!.MetricStat.Metric.Dimensions as Array<{ Name: string }>).map((d) => d.Name).sort();
  assert.deepEqual(dimNames, ["ClusterName", "ServiceName"]);
  // 분자는 lane 자기 게이지.
  assert.equal(metrics.find((m) => m.Id === "depth")!.MetricStat.Metric.Namespace, "ScopeAnalysis");
  // 템플릿 어디에도 `AWS/ECS` 가 남아 있으면 안 된다 — 같은 오타가 다른 알람으로 되살아난다.
  assert.ok(
    !JSON.stringify(t.toJSON()).includes('"AWS/ECS"'),
    "템플릿에 AWS/ECS 네임스페이스가 남아 있다 (RunningTaskCount 는 그 네임스페이스에 없다)",
  );
  // ⚠️ **이 메트릭은 클러스터 설정에 의존한다.** Container Insights 를 끄면 분모가 다시 굶고
  //    B1 이 그대로 재발한다 — 그래서 네임스페이스와 **같은 테스트에서** 설정까지 붙잡는다.
  const clusters = Object.values(t.findResources("AWS::ECS::Cluster"));
  assert.equal(clusters.length, 1);
  const settings = (clusters[0] as { Properties: { ClusterSettings?: Array<{ Name: string; Value: string }> } })
    .Properties.ClusterSettings;
  assert.deepEqual(settings, [{ Name: "containerInsights", Value: "enabled" }], "Container Insights 가 꺼졌다 — 타깃추적 분모가 사라진다");
});

test("C-11 — QueueDepth 메트릭 필터에 defaultValue 가 없다 (게이지 실패가 0 으로 둔갑하면 스케일인)", () => {
  const filters = Object.values(synth().findResources("AWS::Logs::MetricFilter")).map(
    (props) => (props as { Properties: { MetricTransformations: Array<Record<string, unknown>> } }).Properties.MetricTransformations[0]!,
  );
  const byName = Object.fromEntries(filters.map((f) => [f.MetricName as string, f]));
  assert.ok(byName.QueueDepth, "QueueDepth 필터가 없다");
  assert.ok(
    !("DefaultValue" in byName.QueueDepth!),
    "QueueDepth 에 defaultValue 가 있다 — api 가 로그를 못 낸 기간이 '큐가 비었다'로 읽혀 함대를 재운다",
  );
  // 같은 이유로 이미 defaultValue 가 없는 축들 — 함께 얼려 둔다(F2).
  for (const name of ["InflightCalls", "WorkerCount"]) {
    assert.ok(!("DefaultValue" in byName[name]!), `${name} 에 defaultValue 가 생겼다`);
  }
});

test("A1/A2 — 워커 서비스에 **DesiredCount 가 없다** (오토스케일이 소유한다)", () => {
  const t = synth();
  const worker = serviceNamed(t, "WorkerService");
  assert.ok(
    !("DesiredCount" in worker),
    `워커 서비스에 DesiredCount 가 있다 — 모든 배포가 함대를 그 값으로 되돌린다: ${JSON.stringify(worker.DesiredCount)}`,
  );
  // api 는 반대다. 접수는 오토스케일 대상이 아니므로 desired 를 스택이 소유한다(승인 L3 ⓐ).
  assert.equal(serviceNamed(t, "ApiService").DesiredCount, 1);
});

test("A1/A2 — `workerDesired` context 는 폐기됐고 **synth 가 죽인다** (조용한 무시 금지)", () => {
  assert.ok(!("workerDesired" in ctx), "cdk.json 이 아직 workerDesired 를 갖고 있다");
  assert.throws(() => synth({ workerDesired: "2" }), /workerDesired 는 폐기됐다/);
  assert.throws(() => synth({ workerDesired: "0" }), /workerDesired 는 폐기됐다/);
});

test("A4/B6 — 스텝 스케일링 정책이 **하나도 없다** (예열 EXACT_CAPACITY 0 제거)", () => {
  const t = synth();
  const steps = scalingPolicies(t).filter((p) => p.props.PolicyType === "StepScaling");
  assert.deepEqual(
    steps.map((p) => p.logicalId),
    [],
    "스텝 정책이 남아 있다 — 라이브에서 Lower(EXACT_CAPACITY 0)가 영구 ALARM 으로 함대를 재웠다",
  );
  // 정책이 없으므로 그 정책이 달고 오던 알람도 없다. 남은 알람은 F14 게이지 4종뿐이다.
  const alarmNames = Object.values(t.findResources("AWS::CloudWatch::Alarm"))
    .map((props) => (props as { Properties: { AlarmName?: string } }).Properties.AlarmName)
    .filter((n): n is string => typeof n === "string")
    .sort();
  assert.deepEqual(alarmNames, [
    "scope-analysis-deferred-residue-stage",
    "scope-analysis-duplicate-completions-stage",
    "scope-analysis-queue-stale-stage",
    "scope-analysis-terminal-failures-stage",
  ]);
  // 예열 **게이지**는 남는다 — 관측은 유효하고, 정책을 다시 붙일지의 근거가 된다.
  const filterNames = Object.values(t.findResources("AWS::Logs::MetricFilter")).map(
    (props) =>
      (props as { Properties: { MetricTransformations: Array<{ MetricName: string }> } }).Properties
        .MetricTransformations[0]!.MetricName,
  );
  assert.ok(filterNames.includes("PrewarmDesiredWorkers"), "예열 게이지 필터까지 지웠다 — 관측을 잃는다");
});

test("A4/B6 — 함대 하한은 `workerMin`(기본 1)이고 **재우는 정책은 없다**", () => {
  assert.ok(!("workerMin" in ctx), "cdk.json 이 workerMin 을 고정한다 — 0 은 정지용 일시 상태다(apiDesired 와 같은 이유)");
  const cap = scalableTarget(synth());
  assert.deepEqual({ MinCapacity: cap.MinCapacity, MaxCapacity: cap.MaxCapacity }, { MinCapacity: 1, MaxCapacity: 48 });
  // 정지는 사람이 **명시**한다.
  assert.equal(scalableTarget(synth({ workerMin: "0" })).MinCapacity, 0);
  assert.equal(scalableTarget(synth({ workerMin: "4" })).MinCapacity, 4);
  // 상한을 넘는 하한은 배포가 거부한다 — synth 에서 먼저 잡는다.
  assert.throws(() => synth({ workerMin: "49" }), /workerMin/); // workerMax 48 초과
  assert.equal(scalableTarget(synth({ workerMin: "48" })).MinCapacity, 48, "상한과 같은 하한은 유효하다");
  assert.throws(() => synth({ workerMin: "-1" }), /workerMin/);
  assert.throws(() => synth({ workerMin: "1.5" }), /workerMin/);
  // README 가 정지 절차를 갖고 있어야 한다 — 없으면 다음 사람이 desired 만 0 으로 내리고
  // 오토스케일이 곧바로 min 으로 되올린다(그리고 "왜 안 멈추지" 를 겪는다).
  assert.match(readFileSync(`${ROOT}README.md`, "utf8"), /-c workerMin=0/, "README 에 함대 정지 절차가 없다");
});

test("B8/A6 — 드레인 예산이 태스크 정의 env 로 내려가고 stopTimeout 보다 **작다**", () => {
  const t = synth();
  const worker = workerContainer(t);
  const grace = Number(envOf(worker).ANALYSIS_DRAIN_GRACE_SECONDS);
  const stop = Number(worker.StopTimeout);
  assert.equal(stop, 120, "Fargate stopTimeout 상한은 120s 다");
  assert.equal(grace, 110);
  assert.ok(grace < stop, `드레인 예산(${grace}s)이 stopTimeout(${stop}s) 이상이다 — 워커가 못 지킬 값을 믿는다`);
  // 코드 기본값(600s)으로 되돌아가는 경로를 막는다: env 가 없으면 워커는 600 을 믿는다.
  assert.match(readFileSync(`${ROOT}worker/main.ts`, "utf8"), /ANALYSIS_DRAIN_GRACE_SECONDS \?\? 600/);
  // api 에는 필요 없다(리스를 잡지 않는다).
  assert.equal(envOf(containerNamed(t, "api")).ANALYSIS_DRAIN_GRACE_SECONDS, undefined);
});

test("B8/A6 — stopTimeout 이상의 드레인 예산은 **synth 가 죽인다**", () => {
  assert.throws(() => synth({ drainGraceSeconds: "120" }), /drainGraceSeconds/);
  assert.throws(() => synth({ drainGraceSeconds: "600" }), /drainGraceSeconds/);
  assert.throws(() => synth({ drainGraceSeconds: "0" }), /drainGraceSeconds/);
  assert.equal(envOf(workerContainer(synth({ drainGraceSeconds: "60" }))).ANALYSIS_DRAIN_GRACE_SECONDS, "60");
});

test("B8/A6 — 워커 minHealthyPercent 가 50 이상이다 (배포가 전량을 동시에 죽이지 않게)", () => {
  const dc = serviceNamed(synth(), "WorkerService").DeploymentConfiguration as { MinimumHealthyPercent: number };
  assert.ok(
    dc.MinimumHealthyPercent >= 50,
    `워커 minHealthyPercent=${dc.MinimumHealthyPercent} — 0 이면 롤링 배포가 in-flight LLM 콜을 전량 동시에 끊는다`,
  );
});

// ── 롤링 상한 — 롤링이 desired 를 넘지 않는다 (2026-09-14) ────────────────────────────
//
// Fargate vCPU 쿼터 64 에서 워커 16 대의 기본 200% 롤링은 old 16 + new 16 = 64 vCPU 를 요구해
// "unable to place a task … limit on the number of vCPUs" → 서킷브레이커 롤백이 **두 번** 났다
// (배포 14 · 재시도). desired 는 오토스케일 소유라 `-c workerMax=8` 축소 배포도 안 먹었다.
// 100 이면 피크 태스크 수 = desired 라 정상 상태가 쿼터 안이면 배포도 쿼터 안이다.

test("롤링 상한 — 워커 maxHealthyPercent 가 100 이다 (피크 태스크 수 = desired, vCPU 쿼터 안에서 재배포)", () => {
  const t = synth();
  const dc = serviceNamed(t, "WorkerService").DeploymentConfiguration as {
    MinimumHealthyPercent: number;
    MaximumPercent: number;
  };
  assert.equal(dc.MaximumPercent, 100, `워커 maxHealthyPercent=${dc.MaximumPercent} — 200 이면 48 워커 롤링이 96 vCPU 를 요구한다`);
  // ECS 는 AZ 리밸런싱이 켜진 서비스에 maximumPercent ≤ 100 을 거부한다(2026-09-14 배포 2c9a9cf 롤백:
  // "Availability Zone Rebalancing does not support maximumPercent <= 100 %"). CDK 기본값이 ENABLED 라
  // **명시적으로 꺼야** 하고, CDK synth 는 명시적 ENABLED 만 잡으므로 템플릿 값을 직접 단언한다.
  const svc = serviceNamed(t, "WorkerService") as { AvailabilityZoneRebalancing?: string };
  assert.equal(svc.AvailabilityZoneRebalancing, "DISABLED", "워커 AZ 리밸런싱이 DISABLED 가 아니다 — maximumPercent 100 배포가 ECS 검증에서 죽는다");
  // min 50 < max 100 이어야 롤링이 진행된다(같으면 ECS 가 아무것도 못 바꾼다).
  assert.ok(dc.MinimumHealthyPercent < dc.MaximumPercent);
  // 정상 상태(48 × 1 = 48) + api 0.5 + 코어 동거인 9.0 = 57.5 ≤ 64 — 롤링 피크가 이 값과 같다.
  //
  // ⚠️ 태스크당 vCPU 를 **템플릿에서 읽는다**(`WORKER_CPU / 1024` 가 그대로 내려온 env). 여기에
  //    숫자 2 를 다시 적어 두면 1 vCPU 전환 같은 변경에서 테스트가 **옛 산술로 통과**한다 —
  //    스택이 `computeWorkerCallSlots` 를 런타임에서 import 하는 것과 같은 이유다(산식 두 벌 금지).
  const workerMax = Number(ctx.workerMax);
  const workerVcpu = Number(envOf(workerContainer(t)).ANALYSIS_WORKER_VCPU);
  assert.equal(workerVcpu, 1, "태스크당 vCPU 가 1 이 아니다 — 1 vCPU × 48 전환이 되돌려졌다");
  const rollingPeak = workerMax * workerVcpu * (dc.MaximumPercent / 100) + 0.5 + 9.0;
  assert.ok(rollingPeak <= 64, `롤링 피크 ${rollingPeak} vCPU 가 Fargate vCPU 쿼터 64 를 넘는다`);
  // 전환 배포(옛 desired 24 × 2 vCPU → 새 48 × 1)도 같은 상한 덕에 쿼터 안이다: ECS 가 먼저 절반
  // (12 × 2 = 24 vCPU)을 비우고 그 자리에 1 vCPU 태스크를 올리므로 어느 순간에도 old+new ≤ 48.
  assert.ok(
    workerMax * workerVcpu <= 24 * 2,
    "새 함대의 정상 상태가 옛 함대(24 × 2 = 48 vCPU)보다 크다 — 전환 배포의 피크가 현재를 넘는다",
  );
});

// ── 태스크 사이징 — 1 vCPU × 48 (2026-09-14) ────────────────────────────────────────
//
// 워커는 **단일 Node 스레드**다. 라이브 실측(04:55 KST): CPU 가 유닛 8·16·24 어디서나 51%/2 vCPU
// (= 한 코어 포화, 유휴 3.6%), 유닛 16 → 24 는 회신 개선 **0**, 워커 16 → 24 만 +50%
// (239 → 310~323/분). 그래서 같은 쿼터 안에서 **프로세스 수를 2배**로 만든다 — 48 × 1 = 24 × 2 = 48 vCPU.

test("사이징 — 워커 태스크가 1 vCPU / 4 GiB 이고 힙이 그 75% 다 (Dockerfile 과 짝)", () => {
  const td = taskDefWith(synth(), "worker");
  assert.equal(td.Cpu, "1024", "워커 태스크가 1 vCPU 가 아니다 — 두 번째 코어는 실측에서 놀았다");
  assert.equal(td.Memory, "4096", "워커 태스크 메모리가 4 GiB 가 아니다(Fargate 1 vCPU 는 2~8 GiB)");
  // ⚠️ 힙 상한은 **다른 파일**(이미지)에 있다. 둘을 따로 두면 한쪽만 움직여 OOM 또는 낭비가 된다 —
  //    2026-09-08 `exit 134` 4회가 정확히 그 실패 모드였다. 여기서 비율을 단언해 짝을 강제한다.
  const heap = Number(/--max-old-space-size=(\d+)/.exec(readFileSync(`${ROOT}deploy/Dockerfile.worker`, "utf8"))?.[1]);
  assert.equal(heap, 3072, "Dockerfile.worker 힙이 3072 MiB 가 아니다");
  assert.equal(heap, Math.floor(Number(td.Memory) * 0.75), "힙이 태스크 메모리의 75% 가 아니다");
  // api 는 안 건드린다 — 접수는 CPU 바운드가 아니고 태스크도 1대다.
  assert.equal(taskDefWith(synth(), "api").Cpu, "512");
});

// ── RDS 연결 예산 — 함대 × 풀 + api ≤ 350 (2026-09-14) ──────────────────────────────
//
// ⚠️ **함대를 키우면 CPU 보다 먼저 터지는 축이다.** 워커 풀은 `worker/main.ts` 가 10 으로
//    **하드코딩**하고 있었다(배선 없음 — 드레인 예산과 같은 모양). 함대 48 이면 480 커넥션이고
//    lane RDS 는 db.t4g.medium · `max_connections` 400 이라 뒤쪽 워커가 **기동에서** 죽는다.
//    24 × 10 = 240 이던 동안은 보이지 않았다 — 그래서 synth 가 부등식을 들고 있어야 한다.

test("RDS 예산 — 워커 풀 크기가 태스크 정의 env 로 내려간다 (api 에는 없다)", () => {
  const t = synth();
  assert.equal(envOf(workerContainer(t)).ANALYSIS_DB_POOL_MAX, "5");
  assert.equal(
    envOf(containerNamed(t, "api")).ANALYSIS_DB_POOL_MAX,
    undefined,
    "api 에도 내려갔다 — 접수가 좁아진다(태스크 1대라 함대 산술에 안 들어간다)",
  );
  assert.equal(envOf(workerContainer(synth({ workerDbPoolMax: "3" }))).ANALYSIS_DB_POOL_MAX, "3");
  // 48 × 5 + api 10 = 250 (정원 400 의 62.5%).
  assert.equal(Number(ctx.workerMax) * 5 + 10, 250);
});

test("RDS 예산 — 예산을 넘는 조합은 **synth 가 죽인다** (함대·풀 어느 쪽을 올려도)", () => {
  // 구 하드코딩(10)을 그대로 뒀다면: 48 × 10 + 10 = 490 > 350.
  assert.throws(() => synth({ workerDbPoolMax: "10" }), /RDS 연결 490 가 예산 350/);
  // 함대 쪽으로도 같은 벽이다. 유닛을 슬롯 이하로 내려 B4 를 먼저 통과시킨다
  // (floor((800−32)/70) = 10) — 그래야 **이 가드가** 판정하는 것을 본다.
  assert.throws(() => synth({ workerMax: "70", unitConcurrency: "10" }), /RDS 연결 360 가 예산 350/);
  // 경계 — 68 × 5 + 10 = 350 은 통과한다(예산과 같음). floor((800−32)/68) = 11 이라 유닛 11.
  assert.equal(envOf(workerContainer(synth({ workerMax: "68", unitConcurrency: "11" }))).ANALYSIS_DB_POOL_MAX, "5");
  assert.throws(() => synth({ workerDbPoolMax: "0" }), /workerDbPoolMax/);
  assert.throws(() => synth({ workerDbPoolMax: "1.5" }), /workerDbPoolMax/);
});

test("RDS 예산 — 런타임이 그 env 를 읽는다 (하드코딩 10 으로 되돌아가는 경로를 막는다)", () => {
  assert.match(
    readFileSync(`${ROOT}worker/main.ts`, "utf8"),
    /createPostgresDb\(settings\.storeDsn, \{ max: settings\.dbPoolMax \}\)/,
    "워커가 풀 크기를 다시 하드코딩했다 — 함대를 키우면 조용히 max_connections 를 넘는다",
  );
  // api 는 리터럴 10 이고 **스택 상수가 그 값을 전제로 예산을 센다** — 짝이 깨지면 예산이 거짓이 된다.
  assert.match(
    readFileSync(`${ROOT}app/main.ts`, "utf8"),
    /createPostgresDb\(settings\.storeDsn, \{ max: 10 \}\)/,
    "api 풀이 10 이 아니다 — 스택의 API_DB_POOL_MAX 와 어긋난다",
  );
  assert.match(readFileSync(`${ROOT}infra/lib/analysis-stack.ts`, "utf8"), /const API_DB_POOL_MAX = 10;/);
  // 코드 기본값은 **배선 전 값(10) 그대로** — 로컬·compose 경로가 갑자기 좁아지지 않게.
  const prev = process.env.ANALYSIS_DB_POOL_MAX;
  try {
    delete process.env.ANALYSIS_DB_POOL_MAX;
    assert.equal(loadSettings().dbPoolMax, 10);
    process.env.ANALYSIS_DB_POOL_MAX = "5";
    assert.equal(loadSettings().dbPoolMax, 5, "env 가 기본값을 못 덮는다");
  } finally {
    if (prev === undefined) delete process.env.ANALYSIS_DB_POOL_MAX;
    else process.env.ANALYSIS_DB_POOL_MAX = prev;
  }
});

// ── 게이트③ 프롬프트 캐시 무효화 (운영 결정 2026-09-13) ─────────────────────────────
//
// ⚠️ 이 스위치의 실패 모드는 **조용하다**: 켰다고 믿는데 안 켜져 있으면 게이트③ 은 캐시 히트가
//    섞인 실비·일치율을 "무캐시 결과" 로 읽는다. 실패가 아니라 오답이라 알람이 안 운다.

test("게이트③ — 상주 기본은 false 이고 그것이 worker env 로 간다 (api 에는 없다)", () => {
  const cdkDefault = (cdkJson.context as unknown as Record<string, unknown>).llmCacheBust;
  assert.equal(cdkDefault, "false", "cdk.json 의 llmCacheBust 상주값이 false 가 아니다 — 상시 무캐시는 돈을 태운다");
  const t = synth();
  assert.equal(envOf(workerContainer(t)).ANALYSIS_LLM_CACHE_BUST, "false");
  // LLM 을 부르는 것은 워커뿐이다.
  assert.equal(envOf(containerNamed(t, "api")).ANALYSIS_LLM_CACHE_BUST, undefined);
});

test("게이트③ — `-c llmCacheBust=true` 가 그대로 내려간다 (게이트 창을 여는 유일한 경로)", () => {
  assert.equal(envOf(workerContainer(synth({ llmCacheBust: "true" }))).ANALYSIS_LLM_CACHE_BUST, "true");
  // 키를 아예 안 줘도 코드 기본값(false)이 내려간다 — "미설정" 이 "켜짐" 이 되는 경로는 없다.
  assert.equal(envOf(workerContainer(synth({ llmCacheBust: undefined }))).ANALYSIS_LLM_CACHE_BUST, "false");
});

test("게이트③ — `-c llmCacheBust=`(빈/공백)은 **synth 가 죽인다** (engine 과 같은 결함)", () => {
  // 빈값은 태스크 정의로 `ANALYSIS_LLM_CACHE_BUST=""` 로 내려가 런타임이 false 로 접는다.
  // synth 산출물에는 `Value: ""` 밖에 안 남아 아무도 못 잡는다.
  assert.throws(() => synth({ llmCacheBust: "" }), /llmCacheBust 가 빈\/공백 문자열이다/);
  assert.throws(() => synth({ llmCacheBust: "   " }), /llmCacheBust 가 빈\/공백 문자열이다/);
});

test("게이트③ — 모드는 **설정했을 때만** 내려간다 (빈 env 로 조용한 폴백을 하나 더 만들지 않는다)", () => {
  assert.equal(envOf(workerContainer(synth())).ANALYSIS_LLM_CACHE_BUST_MODE, undefined);
  assert.equal(envOf(workerContainer(synth({ llmCacheBustMode: "" }))).ANALYSIS_LLM_CACHE_BUST_MODE, undefined);
  assert.equal(envOf(workerContainer(synth({ llmCacheBustMode: "both" }))).ANALYSIS_LLM_CACHE_BUST_MODE, "both");
});

test("게이트③ — 런타임 settings 가 같은 env 이름을 읽고 모르는 모드는 기동을 세운다", () => {
  // CDK 가드와 **짝**이다(H3 와 같은 구조). 태스크 정의만 고치면 로컬·compose 경로가 남는다.
  const prevOn = process.env.ANALYSIS_LLM_CACHE_BUST;
  const prevMode = process.env.ANALYSIS_LLM_CACHE_BUST_MODE;
  try {
    delete process.env.ANALYSIS_LLM_CACHE_BUST;
    delete process.env.ANALYSIS_LLM_CACHE_BUST_MODE;
    assert.equal(loadSettings().llmCacheBust, false);
    assert.equal(loadSettings().llmCacheBustMode, "nonce");
    process.env.ANALYSIS_LLM_CACHE_BUST = "true";
    assert.equal(loadSettings().llmCacheBust, true);
    process.env.ANALYSIS_LLM_CACHE_BUST_MODE = "params";
    assert.equal(loadSettings().llmCacheBustMode, "params");
    process.env.ANALYSIS_LLM_CACHE_BUST_MODE = "nonc";
    assert.throws(() => loadSettings(), /ANALYSIS_LLM_CACHE_BUST_MODE must be one of/);
  } finally {
    if (prevOn === undefined) delete process.env.ANALYSIS_LLM_CACHE_BUST;
    else process.env.ANALYSIS_LLM_CACHE_BUST = prevOn;
    if (prevMode === undefined) delete process.env.ANALYSIS_LLM_CACHE_BUST_MODE;
    else process.env.ANALYSIS_LLM_CACHE_BUST_MODE = prevMode;
  }
});
