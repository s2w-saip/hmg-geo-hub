// mTLS 인그레스 이미지 — **파일 3개의 정합**을 본다(운영 결정 ⓐ, 2026-09-12).
//
//   deploy/ingress/nginx.conf      인증서 경로 · ssl_verify_client · 본문 상한
//   deploy/ingress/entrypoint.sh   같은 경로에 파일을 쓴다 · 시크릿 필드 이름
//   deploy/Dockerfile.ingress      같은 경로를 만든다 · conf·entrypoint 를 COPY
//
// ⚠️ 이 정합이 깨지면 **기동에서만** 드러나고, 그 실패는 "NLB 타깃 unhealthy" 로 보인다 —
//    설정 실패가 네트워크 문제로 위장한다. 로컬에서 docker 를 띄우지 않고 잡을 수 있는
//    유일한 층이 여기다(Docker 기동은 CI 의 `images` 잡이 처음 한다).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string): string => readFileSync(`${ROOT}${p}`, "utf8");

const nginxConf = read("deploy/ingress/nginx.conf");
const entrypoint = read("deploy/ingress/entrypoint.sh");
const dockerfile = read("deploy/Dockerfile.ingress");
const compose = read("deploy/compose.yml");
const stack = read("infra/lib/analysis-stack.ts");

/** 인증서 디렉토리 정본. 세 파일이 같은 값을 써야 한다. */
const CERT_DIR = "/etc/nginx/certs";

test("nginx.conf 의 인증서 경로 = entrypoint 가 쓰는 경로 = Dockerfile 이 만드는 경로", () => {
  for (const f of ["server.crt", "server.key", "ca.crt"]) {
    assert.ok(
      nginxConf.includes(`${CERT_DIR}/${f}`),
      `nginx.conf 가 ${CERT_DIR}/${f} 를 참조하지 않는다`,
    );
  }
  // entrypoint 는 기본값을 변수로 갖는다(컨테이너 env 로 덮을 수 있게).
  assert.ok(
    entrypoint.includes(`ANALYSIS_INGRESS_CERT_DIR:-${CERT_DIR}`),
    `entrypoint 의 CERT_DIR 기본값이 ${CERT_DIR} 가 아니다`,
  );
  assert.ok(dockerfile.includes(`mkdir -p ${CERT_DIR}`), "Dockerfile 이 인증서 디렉토리를 만들지 않는다");
  // 측정 lane 의 호스트 bind mount 경로(`/certs`)가 남아 있으면 한쪽만 옮긴 것이다.
  assert.ok(!/ssl_certificate\s+\/certs\//.test(nginxConf), "nginx.conf 에 옛 /certs 경로가 남았다");
});

test("mTLS 가 실제로 켜져 있다 (ssl_verify_client on · 본문 상한 2m)", () => {
  // 이 둘이 빠지면 인그레스가 "그냥 TLS 프록시" 가 된다 — 클라이언트 인증서 검증이 사라지고
  // 승인 L4(측정 lane 과 같은 CA 로 mTLS 종단)가 조용히 무효화된다.
  assert.match(nginxConf, /ssl_verify_client\s+on;/);
  assert.match(nginxConf, /client_max_body_size\s+2m;/);
  assert.match(nginxConf, /listen\s+8443\s+ssl;/);
  // 검증 결과를 앱으로 넘기는 헤더 — 측정 lane 과 같은 이름이어야 도구·감사 술어가 공유된다.
  assert.ok(nginxConf.includes("X-Client-Cert-DN"), "X-Client-Cert-DN 헤더가 없다");
  assert.ok(nginxConf.includes("X-Client-Verify"), "X-Client-Verify 헤더가 없다");
});

test("업스트림은 서비스명이 아니라 127.0.0.1 — 태스크가 awsvpc 다", () => {
  // ⚠️ `awsvpc` 에서는 같은 태스크의 컨테이너가 **네트워크 namespace 를 공유**하고 localhost 로
  //    통신한다. `links` 는 지원되지 않으므로 컨테이너 이름이 DNS 로 풀리지 않는다 —
  //    `server api:8080;` 이면 `nginx -t` 가 `host not found in upstream "api"` 로 기동을 세운다.
  //    측정 lane conf 는 `api:8080` 인데 그쪽은 EC2 + compose bridge 라 서비스명 DNS 가 된다.
  //    **lane 이 다르면 이식되지 않는 자리**이고, 그래서 테스트로 박는다.
  assert.match(nginxConf, /server\s+127\.0\.0\.1:8080;/);
  assert.ok(!/server\s+api:8080;/.test(nginxConf), "업스트림이 서비스명이다 — awsvpc 에서 풀리지 않는다");
  assert.match(stack, /NetworkMode|CpuArchitecture/); // Fargate 태스크(awsvpc 고정)임을 문서화
  // 로컬 compose 도 같은 namespace 를 써야 로컬이 라이브와 같은 경로를 탄다.
  assert.ok(compose.includes('network_mode: "service:api"'), "compose 가 api 의 네트워크 namespace 를 공유하지 않는다");
  // namespace 공유 컨테이너는 자기 ports 를 못 가진다 → 8443 은 api 서비스가 발행한다.
  assert.ok(/ports:\s*\["8080:8080",\s*"127\.0\.0\.1:8443:8443"\]/.test(compose), "8443 발행이 api 서비스로 옮겨지지 않았다");
});

test("컨테이너 헬스체크는 8443 이 아니라 루프백 stub_status(8081) 를 본다", () => {
  // 8443 을 치면 클라이언트 인증서가 없어 `ssl_verify_client on` 이 400 → 헬스체크 영구 실패.
  // NLB 쪽은 TCP:8443(핸드셰이크 전)이라 그쪽은 정상 판정된다 — 층이 다른 것이 설계다.
  assert.ok(nginxConf.includes("listen 127.0.0.1:8081;"), "stub_status 서버가 없다");
  assert.ok(dockerfile.includes("127.0.0.1:8081/nginx_status"), "Dockerfile HEALTHCHECK 가 stub_status 를 안 본다");
  assert.ok(stack.includes("127.0.0.1:8081/nginx_status"), "CDK 컨테이너 헬스체크가 stub_status 를 안 본다");
  assert.ok(
    /healthCheck:\s*\{\s*protocol:\s*elbv2\.Protocol\.TCP/.test(stack),
    "NLB 헬스체크가 TCP 가 아니다 (HTTP 로 치면 400 → 영구 unhealthy)",
  );
});

test("이미지에 인증서가 굽히지 않는다 — 설정만 COPY 한다", () => {
  // 비밀키가 ECR 레이어에 들어가면 로테이션이 "재빌드+배포" 가 되고 과거 태그 전부가
  // 유효한 키를 들고 영구 보관된다(룰 secrets-handling 1·3).
  assert.ok(!/COPY\s+\S*certs/.test(dockerfile), "Dockerfile 이 certs 를 COPY 한다");
  assert.ok(!/\.pem|\.key|\.crt/.test(dockerfile.replace(/#.*$/gm, "")), "Dockerfile 코드 라인에 인증서 파일 참조가 있다");
  assert.ok(dockerfile.includes("COPY deploy/ingress/nginx.conf"), "conf 를 COPY 하지 않는다");
  assert.ok(dockerfile.includes("COPY deploy/ingress/entrypoint.sh"), "entrypoint 를 COPY 하지 않는다");
});

test("시크릿 필드 계약이 entrypoint·CDK·README 에서 같다", () => {
  const fields = ["server_cert_pem", "server_key_pem", "client_ca_pem"];
  const readme = read("README.md");
  for (const f of fields) {
    assert.ok(entrypoint.includes(f), `entrypoint 가 ${f} 를 읽지 않는다`);
    assert.ok(readme.includes(f), `README 주입 절차에 ${f} 가 없다`);
  }
  // CDK 는 값이 아니라 **참조**만 준다 — 이름은 ANALYSIS_INGRESS_CERT_SECRET_ID 로 넘어간다.
  assert.ok(stack.includes("ANALYSIS_INGRESS_CERT_SECRET_ID"), "CDK 가 시크릿 참조 env 를 주지 않는다");
  assert.ok(entrypoint.includes("ANALYSIS_INGRESS_CERT_SECRET_ID"), "entrypoint 가 참조 env 를 읽지 않는다");
  // AWS_REGION 은 ECS 가 자동으로 넣어주지 않는다 — 태스크 정의가 줘야 한다.
  assert.match(stack, /AWS_REGION:\s*this\.region/);
});

/** 비밀값을 담는 셸 변수. 이 이름들이 로그 싱크로 가는 줄이 하나라도 있으면 실패다. */
const SECRET_VARS = ["SERVER_KEY", "SERVER_CERT", "CLIENT_CA", "SECRET_JSON"];
/**
 * 출력을 내는 **주체 전부**. 초판은 `echo|log|printf` 뿐이라 **`die` 가 빠져 있었다** —
 * `die` 는 `log` 를, `log` 는 `echo … >&2` 를 부르므로 `die "…: $SECRET_JSON"` 한 줄이면
 * 비밀키/시크릿 원문이 CloudWatch 로 간다(2026-09-12 변이 A 로 실증: 초판 가드는 통과했다).
 * ⚠️ 새 로거 함수를 만들면 이 목록이 낡는다 → 바로 아래 "함수 집합" 테스트가 강제로 깨진다.
 */
const OUTPUT_CALLERS = ["echo", "printf", "log", "die"];
/** entrypoint 가 정의하는 함수 전부. 새 함수가 생기면 로거인지 판정하고 위 목록을 갱신한다. */
const ENTRYPOINT_FUNCTIONS = ["assert_pem", "die", "extract", "log"];

test("entrypoint 의 함수 집합이 고정돼 있다 — 새 로거가 leak 가드를 조용히 우회하지 못하게", () => {
  // ⚠️ 들여쓰기를 허용한다 — `extract`·`assert_pem` 은 `if [ -n "$SECRET_ID" ]` 블록 안에 있다.
  const defined = [...entrypoint.matchAll(/^[ \t]*([A-Za-z_][A-Za-z0-9_]*)\(\)\s*\{/gm)].map((m) => m[1]!).sort();
  assert.deepEqual(
    defined,
    [...ENTRYPOINT_FUNCTIONS].sort(),
    "entrypoint 의 함수가 바뀌었다. 새 함수가 출력을 내면 OUTPUT_CALLERS 에 넣고, 아니면 이 목록만 갱신하라",
  );
});

test("entrypoint 는 실패 시 기동을 중단하고, 값을 출력하는 분기가 없다", () => {
  assert.match(entrypoint, /^set -eu$/m, "set -eu 가 없다 — 실패가 조용히 지나간다");
  assert.ok(entrypoint.includes("exit 1"), "die 가 종료 코드를 내지 않는다");
  assert.ok(entrypoint.includes("nginx -t"), "exec 전에 설정을 검증하지 않는다");
  assert.ok(entrypoint.includes("umask 077"), "키 파일이 생성 순간부터 좁지 않다");
  // set -x 는 모든 변수 전개를 stderr 로 흘린다 — 비밀키가 CloudWatch 로 간다.
  assert.ok(!/^\s*set -x/m.test(entrypoint), "set -x 가 켜져 있다");

  const codeLines = entrypoint.split("\n").filter((l) => !l.trim().startsWith("#"));

  // ⚠️ **`2>&1` 금지.** aws 의 stderr 를 stdout 에 합쳐 한 변수로 받으면 그 변수는 성공 경로에서
  //    **비밀키를 담는 변수**가 된다 — 한 변수가 두 역할을 하는 순간 "실패 때 에러만 찍는다" 는
  //    보장이 사라진다(변이 A2). stderr 는 별 파일(`ERR_FILE`)로 받는다.
  const merged = codeLines.filter((l) => /2>&1/.test(l)).map((l) => l.trim());
  assert.deepEqual(merged, [], `stderr 를 stdout 에 합치는 줄이 있다 — 그 변수가 비밀값을 담는다: ${merged.join(" | ")}`);

  for (const v of SECRET_VARS) {
    const leak = new RegExp(`(?:${OUTPUT_CALLERS.join("|")})\\b[^\\n]*\\$\\{?${v}\\b`);
    for (const line of codeLines) {
      // 예외는 **목적지가 로그가 아닌 두 형태**뿐이다:
      //   ① 파일로 쓰기   printf '%s\n' "$SERVER_KEY" > "$CERT_DIR/server.key"
      //   ② jq stdin 파싱 echo "$SECRET_JSON" | jq …
      // ⚠️ `>&2`·`>&1` 는 예외가 **아니다.** 초판은 `line.includes(">")` 로 리다이렉트가 있는
      //    줄을 전부 건너뛰어 `echo "$SERVER_KEY" >&2` 같은 직행 누출을 통과시켰다.
      const writesToFile = />\s*"?(?:\$|\/)/.test(line);
      const pipesToJq = /\|\s*jq\b/.test(line);
      if (writesToFile || pipesToJq) continue;
      assert.ok(!leak.test(line), `값이 출력될 수 있다: ${line.trim()}`);
    }
  }
});

test("compose 도 같은 이미지·같은 경로를 쓴다 (로컬과 라이브가 갈라지지 않게)", () => {
  assert.ok(compose.includes("deploy/Dockerfile.ingress"), "compose 가 stock nginx 를 쓰고 있다");
  assert.ok(compose.includes(`:${CERT_DIR}:ro`), `compose 가 인증서를 ${CERT_DIR} 로 마운트하지 않는다`);
  // 로컬은 시크릿 ID 를 주지 않는다 → entrypoint 의 "이미 배치된 인증서" 경로.
  assert.ok(!compose.includes("ANALYSIS_INGRESS_CERT_SECRET_ID"), "로컬 compose 가 AWS 시크릿을 요구한다");
});

test("CDK 인그레스 컨테이너는 stock nginx 가 아니라 lane ECR 을 쓴다", () => {
  assert.ok(
    !/fromRegistry\("nginx/.test(stack),
    "CDK 가 아직 stock nginx:1.27-alpine 을 쓴다 (리포의 conf·인증서가 태스크에 들어가지 않는다)",
  );
  // ⚠️ 리포는 **2개뿐**이다 — 코어 OIDC 롤(github-deploy-scope-analysis-ecr)의 push 허용
  //    대상이 api-stage · worker-stage 뿐이라 3번째 리포는 밀 수 없다. 인그레스는 api 리포의
  //    `ingress-` 접두사 태그로 공존한다.
  assert.ok(!stack.includes("repoIngress"), "3번째 ECR 리포가 되살아났다 (롤이 그 리포에 push 못 한다)");
  assert.ok(!/scope-analysis\/ingress-/.test(stack), "ingress 전용 리포 이름이 남았다");
  assert.match(stack, /fromEcrRepository\(repoApi, ctx\("ingressImageTag"\)/);
  // 태스크 롤은 이 시크릿 **읽기 하나만** 갖는다.
  assert.ok(stack.includes('sid: "IngressCertRead"'), "태스크 롤에 시크릿 읽기 정책이 없다");
  assert.match(stack, /actions:\s*\["secretsmanager:GetSecretValue"\]/);
  for (const banned of ["secretsmanager:PutSecretValue", "secretsmanager:ListSecrets", "secretsmanager:*"]) {
    assert.ok(!stack.includes(banned), `태스크 롤에 ${banned} 가 들어갔다`);
  }
});

test("기본 이미지 태그가 워크플로가 미는 태그와 같다 (접두사 포함)", () => {
  // `latest` 기본값은 존재하지 않는 태그다 — 워크플로는 `stage-current` 와 sha 만 민다.
  // 어긋나면 desired 1 배포가 CannotPullContainerError 로 죽고, RETAIN 리소스가 고아로 남는다.
  const workflow = read(".github/workflows/push-images-stage.yml");
  assert.match(stack, /const DEFAULT_IMAGE_TAG = "stage-current";/);
  assert.match(stack, /const DEFAULT_INGRESS_IMAGE_TAG = "ingress-stage-current";/);
  assert.ok(!/\?\?\s*"latest"/.test(stack), "이미지 태그 기본값에 latest 가 남았다");
  // 접두사 정본이 한 곳(workflow env)이고 CDK 기본값이 그것과 맞아야 한다.
  assert.ok(workflow.includes("INGRESS_TAG_PREFIX: ingress-"), "워크플로의 접두사 정본이 바뀌었다");
  // 세 이미지 전부 민다 — 인그레스는 api 리포에.
  for (const f of ["deploy/Dockerfile.api", "deploy/Dockerfile.worker", "deploy/Dockerfile.ingress"]) {
    assert.ok(workflow.includes(`file: ${f}`), `${f} 를 굽지 않는다`);
  }
  // 인그레스 태그는 **api 리포 + 접두사**여야 한다(접두사가 빠지면 api 태그를 덮는다).
  assert.ok(
    workflow.includes("${{ env.REPO_API }}:${{ env.INGRESS_TAG_PREFIX }}stage-current"),
    "인그레스를 api 리포의 접두사 태그로 굽지 않는다",
  );
  // ⚠️ `docker buildx build` 를 run: 에서 직접 쓰면 `--cache-to type=gha` 가 죽는다 —
  //    ACTIONS_RUNTIME_TOKEN·ACTIONS_CACHE_URL 은 액션에만 노출된다. 공식 액션을 쓴다.
  assert.ok(workflow.includes("docker/build-push-action@v6"), "공식 빌드 액션을 쓰지 않는다");
  // ⚠️ 주석 줄은 뺀다 — 왜 그런지를 적으려면 금지 구문을 인용해야 하고, 인용을 못 하게 하면
  //    근거가 파일에서 사라진다(boundary.test.ts 와 같은 관례).
  const workflowCode = workflow
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");
  assert.ok(
    !workflowCode.includes("docker buildx build"),
    "run: 스텝에서 docker buildx build 를 직접 부른다 (type=gha 캐시가 인증 없이 죽는다)",
  );
  // 에뮬레이션 전제 — QEMU 없이 arm64 를 굽으면 x86 이미지가 조용히 올라간다.
  assert.ok(workflow.includes("docker/setup-qemu-action@v3"), "QEMU 설정이 없다");
  assert.ok(workflow.includes("platforms: linux/arm64"), "arm64 플랫폼 지정이 없다");
  // api 리포가 두 계보를 담으므로 lifecycle 이력 깊이를 올려 뒀는지 본다(20 이면 절반이 된다).
  assert.match(stack, /lifecycleRules:\s*\[\{\s*maxImageCount:\s*40\s*\}\]/);
});

test("arm64 단언은 기본 출력이 아니라 config 의 architecture 를 본다 (단일 플랫폼 매니페스트)", () => {
  // ⚠️ 초판 판정식 `imagetools inspect <ref> | grep linux/arm64` 는 **정상 이미지에서도 반드시
  //    실패한다.** `platforms: linux/arm64` + `provenance: false` 면 buildx 가 index 가 아니라
  //    plain manifest 를 밀고, `Platform:` 줄은 index 의 자식 디스크립터에만 찍힌다
  //    (2026-09-12 실측: nginx:1.27-alpine 의 arm64 자식을 digest 로 inspect → grep 0건).
  //    그러면 push 는 됐는데 워크플로가 빨갛고, 사람은 "arm64 가 아니다" 로 오진한다.
  const workflow = read(".github/workflows/push-images-stage.yml");
  const code = workflow
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");
  assert.ok(
    !/imagetools inspect [^\n]*\|\s*tee/.test(code) && !/grep -q 'linux\/arm64'/.test(code),
    "옛 판정식(기본 출력 grep)이 남았다 — 단일 플랫폼 매니페스트에는 platform 줄이 없다",
  );
  // config 를 읽는 형태 + architecture 값 판정.
  assert.ok(code.includes("--format '{{json .Image}}'"), "config(.Image) 를 읽는 판정식이 없다");
  assert.match(code, /"architecture"\[\[:space:\]\]\*:\[\[:space:\]\]\*"arm64"/);
  // 레지스트리 config 는 blob 이라 ecr:GetDownloadUrlForLayer 를 요구하는데 롤에 그것이 없다
  // (2026-09-12 iam get-role-policy 실측) → 권한 불필요한 차단 게이트가 **함께** 있어야 한다.
  assert.match(code, /containerimage\.descriptor/, "빌드 디스크립터 게이트가 없다");
  assert.match(code, /\.platform\.architecture == "arm64"/);
  // 그리고 **증명 없는 통과가 없어야** 한다 — 두 경로가 다 막히면 실패시킨다.
  assert.match(code, /PROVEN/, "arm64 증명 여부를 추적하지 않는다");
  // 빌드 스텝에 id 가 있어야 metadata 를 받을 수 있다.
  for (const id of ["id: api", "id: worker", "id: ingress"]) {
    assert.ok(code.includes(id), `빌드 스텝에 ${id} 가 없다 — steps.<id>.outputs.metadata 를 못 읽는다`);
  }
});

test("워크플로는 사용자 입력을 run: 본문에 직접 펼치지 않는다 (env 경유)", () => {
  const workflow = read(".github/workflows/push-images-stage.yml");
  // `${{ inputs.* }}` 는 셸이 보기 전에 문자열 치환이라 값이 스크립트를 바꿀 수 있다.
  // 표현식은 `env:` 블록에만 둔다 — 거기서는 값이 환경변수로 전달돼 치환이 일어나지 않는다.
  const runBodies = workflow
    .split("\n")
    .filter((l) => !l.trim().startsWith("#") && !/^\s{6,}[A-Z_]+:\s*\$\{\{/.test(l))
    .join("\n");
  assert.ok(!/\$\{\{\s*inputs\./.test(runBodies), "inputs.* 표현식이 env: 밖(run 본문)에 있다");
  assert.ok(workflow.includes("IMAGE_TAG: ${{ inputs.image_tag }}"), "입력이 env 로 넘어가지 않는다");
  assert.ok(workflow.includes('TAG="$IMAGE_TAG"'), "run 본문이 셸 변수로 읽지 않는다");
});

test("OIDC 배선 — 롤 ARN 고정 · main 전용 게이트 · id-token 권한", () => {
  const workflow = read(".github/workflows/push-images-stage.yml");
  assert.ok(
    workflow.includes("arn:aws:iam::371056712389:role/github-deploy-scope-analysis-ecr"),
    "확정된 OIDC 롤 ARN 이 없다",
  );
  assert.ok(workflow.includes("role-to-assume: ${{ env.OIDC_ROLE_ARN }}"), "role-to-assume 가 배선되지 않았다");
  // id-token: write 가 없으면 토큰 요청이 403 이고 메시지는 자격증명 문제처럼 보인다.
  assert.match(workflow, /permissions:\s*\n\s*id-token: write/);
  // 신뢰 조건이 main 전용이라 다른 ref 는 STS 거부 — 그 전에 멈춰야 한다.
  assert.ok(workflow.includes('!= "refs/heads/main"'), "ref 게이트가 없다 (다른 브랜치에서 STS 거부로 죽는다)");
  // 셀프호스트 잔존물이 없어야 한다.
  assert.ok(!workflow.includes("self-hosted"), "셀프호스트 러너 지정이 남았다");
  assert.ok(!workflow.includes("AWS_PROFILE"), "러너 로컬 프로필 사용이 남았다");
});
