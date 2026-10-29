// ScopeAnalysis-<stage> — 분석 lane 스택.
//
// ── 측정 lane 스택과 왜 다른가 (스펙 §8.6)
//
//   | 축        | 측정 lane (primary EC2 + ASG 웜풀 25)      | 분석 lane (**Fargate**)            |
//   | 기동 지연 | camoufox 이미지 pull + 부팅 수십 초        | 브라우저가 없다 — 컨테이너 초 단위 |
//   | 슬롯 회계 | 인스턴스당 브라우저 4 = 물리 자원이 슬롯   | 콜은 네트워크 대기 — 물리 자원 무관 |
//   | 상태      | 계정 풀·쿠키 = 사라지면 안 되는 상태        | **무상태.** 티켓 상태만 PG 에      |
//
//   웜풀은 camoufox 부팅 지연의 대가였다. 분석에는 그 지연이 없고 상태도 없다.
//
// ── 서비스가 둘인 이유 (D10)
//
//   `analysis-api`(접수, 상시 1)와 `analysis-worker`(소비, 0~16)가 **생사가 분리돼야** 한다.
//   worker desired 0 에서도 큐가 쌓이려면 접수 주체가 살아 있어야 하고, 그것이 A12(a) 의 전제다.
//
// ⚠️ **VPC 는 `fromVpcAttributes` 로 받는다 — `fromLookup` 이 아니다.** lookup 은 synth 시점에
//    AWS 자격증명을 요구해서 CI 의 `cdk synth` 게이트가 자격증명 없이는 돌지 못한다. 속성은
//    `cdk.json` context 로 준다(측정 lane 은 `cdk.context.json` 캐시에 의존하는데, 그 캐시가
//    비면 같은 문제가 생긴다).
import {
  Duration,
  RemovalPolicy,
  Stack,
  CfnOutput,
  type StackProps,
  aws_applicationautoscaling as appscaling,
  aws_cloudwatch as cw,
  aws_ec2 as ec2,
  aws_ecr as ecr,
  aws_ecs as ecs,
  aws_elasticloadbalancingv2 as elbv2,
  aws_iam as iam,
  aws_logs as logs,
  aws_rds as rds,
  aws_secretsmanager as sm,
} from "aws-cdk-lib";
import type { Construct } from "constructs";

// ⚠️ **런타임 코드에서 가져온다 — 여기서 다시 적지 않는다.** 두 곳에 같은 산식·같은 키 목록을
//    적으면 드리프트가 생기고, 그 드리프트는 "synth 는 통과했는데 워커가 기동에서 죽는다" 로
//    나타난다. `worker/concurrency.ts` · `worker/llm-pools.ts` 둘 다 의존성 0(또는 타입 전용)이라
//    CDK 앱이 가져와도 무거워지지 않는다.
import { computeWorkerCallSlots } from "../../worker/concurrency.ts";
import { BUILT_IN_POOLS, CORE_TASK_MODEL_ENV_KEYS, CORE_TASK_POOL_ENV_KEYS } from "../../worker/llm-pools.ts";

export interface AnalysisStackProps extends StackProps {
  stage: string;
}

/**
 * 태스크 사이징 — 값 하나를 바꾸면 짝도 바꿔야 하는 것들을 한곳에 모은다.
 *
 * ── 2026-09-14: 2 vCPU/8 GiB × 24 → **1 vCPU/4 GiB × 48** (합계 vCPU 동일) ──────────────
 *
 * 워커는 **단일 Node 스레드**다. 라이브 실측(04:55 KST): 워커 CPU 가 유닛 8·16·24 어디서나
 * **51%/2 vCPU** 로 붙어 있었다 — 정확히 한 코어 포화다(유휴 3.6%). 유닛을 16 → 24 로 올렸을 때
 * InflightCalls ~210 · 회신 250~300/분으로 **개선이 0** 이었고, 워커를 16 → 24 로 올렸을 때만
 * +50%(239 → 310~323/분)였다. 즉 lane 처리량 = **워커 수 × 1 코어**이고 두 번째 vCPU 는 놀았다.
 * 메모리도 8%(≈650 MB / 8 GiB)라 병목은 힙이 아니라 코어다.
 *
 * ⇒ 같은 Fargate vCPU 쿼터 안에서 남은 축은 **Node 프로세스 수를 2배로 만드는 것** 하나다.
 *   48 × 1 = 48 vCPU 는 24 × 2 = 48 과 **같다** — 쿼터 산술이 바뀌지 않는다(README "Fargate vCPU 쿼터").
 *
 * ⚠️ 메모리는 vCPU 에 종속이다(Fargate 1 vCPU 의 허용 범위는 2~8 GiB, 1 GiB 단위). 4 GiB 는 실측
 *   사용량(≈650 MB)의 6배 여유이고, 컨텍스트 스냅샷 14.4 MB × 캐시 상한 256 MB 를 더해도 남는다.
 *   힙은 그 75%(3,072 MiB)이고 `deploy/Dockerfile.worker` 와 **짝이다**(테스트가 그 비율을 단언한다).
 */
const WORKER_CPU = 1024; // 1 vCPU — 워커는 단일 Node 스레드다(위 블록)
const WORKER_MEMORY_MIB = 4096; // ⚠️ Dockerfile.worker 의 --max-old-space-size=3072 와 짝(75%)
const WORKER_MAX_COUNT_DEFAULT = 16; // 코드 기본값(상주값은 cdk.json 의 48) — 16 × 1 vCPU = 16 vCPU
/**
 * 워커 1대가 여는 Postgres 풀 크기. **함대를 키우면 CPU 보다 먼저 터지는 축이다.**
 *
 * `worker/main.ts` 가 10 으로 **하드코딩**하고 있었다(배선 없음 — 드레인 예산과 같은 모양의 결함).
 * 함대 48 이면 48 × 10 = 480 커넥션이고 lane RDS 는 db.t4g.medium · `max_connections` **400**
 * (2026-09-14 실측)이다 → 함대가 다 뜨는 순간 뒤쪽 워커가 `too many connections` 로 **기동에서
 * 죽는다**. 24 × 10 = 240 이던 동안은 이 결함이 보이지 않았다.
 */
const WORKER_DB_POOL_MAX_DEFAULT = 5;
/** api 컨테이너의 풀 크기 — `app/main.ts` 의 리터럴과 **짝**이고 테스트가 그 줄을 단언한다. */
const API_DB_POOL_MAX = 10;
/** lane RDS(db.t4g.medium) 실측 `max_connections`. 인스턴스 급을 바꾸면 **실측값으로** 갱신한다. */
const RDS_MAX_CONNECTIONS = 400;
/** 연결 예산 = 위의 87.5%. 나머지는 마이그레이션(`max: 2`)·psql·리퍼 재접속 여유다. */
const RDS_CONNECTION_BUDGET = 350;
/**
 * 컨테이너 `stopTimeout`. **Fargate 런치 타입의 상한이 120초다** — 더 크게 적으면 배포가 거부되고,
 * 이보다 긴 드레인 예산을 워커에 믿게 하면 SIGKILL 이 리스를 끊는다(B8/A6). 아래 드레인 예산은
 * 이 값보다 **작아야** 하고, synth 가 그 부등식을 강제한다.
 */
const WORKER_STOP_TIMEOUT_SECONDS = 120;
/** 드레인 예산 기본값. `stopTimeout` 에서 SIGTERM 전달·정리 여유 10초를 뺀 값. */
const WORKER_DRAIN_GRACE_SECONDS_DEFAULT = 110;
const API_CPU = 512;
const API_MEMORY_MIB = 1024;
/**
 * 기본 이미지 태그. **`latest` 가 아니다** — `.github/workflows/push-images-stage.yml` 은
 * `stage-current` 와 커밋 sha 만 민다. 기본값을 `latest` 로 두면 존재하지 않는 태그를 당겨
 * 서비스 생성이 `CannotPullContainerError` 로 실패하고, circuit breaker 가 롤백한다
 * (그런데 ECR·RDS 는 RETAIN 이라 고아로 남아 재배포를 막는다 — apiDesired 게이트와 같은 함정).
 * 특정 sha 로 배포하려면 `-c apiImageTag=<sha>` 처럼 명시한다.
 */
const DEFAULT_IMAGE_TAG = "stage-current";
/**
 * 인그레스 기본 태그. **api 리포에 접두사로 공존한다**(리포를 3개로 나누지 못하는 이유는
 * `repoApi` 주석 참조). 접두사를 빼면 api 이미지의 `stage-current` 와 충돌해 인그레스 push 가
 * api 를 덮어쓴다 — 그러면 api 컨테이너가 nginx 로 기동한다(포트도 프로세스도 전부 어긋남).
 */
const DEFAULT_INGRESS_IMAGE_TAG = "ingress-stage-current";

export class AnalysisStack extends Stack {
  constructor(scope: Construct, id: string, props: AnalysisStackProps) {
    super(scope, id, props);
    const { stage } = props;
    const ctx = (k: string): string | undefined => this.node.tryGetContext(k) as string | undefined;

    const vpcId = ctx("vpcId") ?? "vpc-REPLACE";
    const azs = (ctx("availabilityZones") ?? "us-west-2a,us-west-2b").split(",");
    const privateSubnetIds = (ctx("privateSubnetIds") ?? "subnet-REPLACE-A,subnet-REPLACE-B").split(",");
    const publicSubnetIds = (ctx("publicSubnetIds") ?? privateSubnetIds.join(",")).split(",");
    const coreClientSgId = ctx("coreClientSecurityGroupId") ?? "";
    const workerMax = Number(ctx("workerMax") ?? WORKER_MAX_COUNT_DEFAULT);
    // ---- 워커 함대의 크기는 **오토스케일이 소유한다** (A1/A2) -------------------------
    //
    // ⚠️ **`desiredCount` 를 서비스에 주지 않는다.** 초판은 `desiredCount: workerDesired` 였고
    //    `cdk.json` 상주값이 `"0"` 이었다 — 즉 **모든 `cdk deploy` 가 함대를 0 으로 되돌렸다.**
    //    오토스케일이 다시 올리기까지 알람 평가 주기만큼 소비가 멈춘다(2026-09-12 실측 공백 44분).
    //    `apiDesired` 가 "0 을 상주값으로 적으면 접수가 조용히 꺼진다" 였던 것과 **같은 함정**이고,
    //    이쪽은 그 0 이 실제로 상주값이었다는 점만 다르다.
    //    CDK 는 `desiredCount` 미지정 시 CFN 템플릿에서 `DesiredCount` 를 **빼므로** ECS 가 현재
    //    값을 유지한다(생성 시에만 1). 그래서 배포가 함대 크기를 만지지 않는다.
    //
    // 하한은 **스케일러블 타깃의 `minCapacity`** 하나뿐이다(`workerMin`, 기본 1). 0 이 아니라 1 인
    // 이유: 큐에 티켓이 있는데 워커가 0 이면 아무도 깨우지 못한다 — 타깃추적의 스케일아웃 알람은
    // `depth / IF(tasks>0, tasks, 1)` 이 임계를 넘어야 울고, 그 사이 티켓은 그냥 늙는다.
    // **함대를 재우는(0 으로 내리는) 정책은 이 스택에 없다** — 정지는 사람이 `-c workerMin=0` 으로
    // 명시해야 한다(README "함대 정지").
    const workerMin = Number(ctx("workerMin") ?? 1);
    if (!Number.isInteger(workerMin) || workerMin < 0 || workerMin > workerMax) {
      throw new Error(`context workerMin=${ctx("workerMin")} 이 0..workerMax(${workerMax}) 범위의 정수가 아니다.`);
    }
    // ⚠️ 낡은 `workerDesired` 는 **조용히 무시하지 않고 죽인다.** 그 값은 이제 아무 데도 안 쓰이는데,
    //    `-c workerDesired=2` 로 램프를 밟으려던 손이 "명령은 성공했는데 함대가 안 늘었다" 를
    //    겪는다(런북 옛 표 ⑥ 의 명령이 정확히 그것이다). 모르는 `llmTaskModels` 키를 죽이는 것과
    //    같은 이유 — 조용한 무시가 가장 나쁘다.
    if (ctx("workerDesired") !== undefined) {
      throw new Error(
        "context workerDesired 는 폐기됐다(A1/A2) — `desiredCount` 는 오토스케일이 소유한다. " +
          "함대 하한을 바꾸려면 `-c workerMin=<n>` 을, 정지하려면 `-c workerMin=0` 배포 후 " +
          "`aws ecs update-service --desired-count 0` 순서로 한다(README '함대 정지').",
      );
    }
    // ⚠️ **api 도 desired 를 context 로 받는다** — worker 와 같은 이유가 아니라 *배포 순서* 때문이다.
    //    ECR 은 이 스택이 만들고 태스크는 그 ECR 의 `latest` 를 당긴다. 즉 최초 배포 시점에
    //    이미지가 존재할 수 없고, `circuitBreaker` 가 켜져 있어 pull 실패 3회면 서비스 생성이
    //    실패한다 → CFN ROLLBACK. 그런데 ECR(RETAIN)·RDS(RETAIN + deletionProtection)는
    //    롤백에서 **삭제되지 않고 고아로 남아** 다음 배포를 "already exists" 로 막는다.
    //    그래서 1단계는 `apiDesired=0`(껍데기만) → 이미지 push → mTLS 배선 → `apiDesired=1` 이다.
    const apiDesired = Number(ctx("apiDesired") ?? 1);
    // 태스크당 목표 대기 티켓 = 턴 유닛 동시성 × 2(스펙 §8.6). 스케일아웃이 한 배치 앞서 돈다.
    const queueDepthPerTaskTarget = Number(ctx("queueDepthPerTaskTarget") ?? 80);

    const vpc = ec2.Vpc.fromVpcAttributes(this, "Vpc", {
      vpcId,
      availabilityZones: azs,
      privateSubnetIds,
      publicSubnetIds,
    });
    const privateSubnets: ec2.SubnetSelection = { subnets: privateSubnetIds.map((s, i) => ec2.Subnet.fromSubnetId(this, `PrivSubnet${i}`, s)) };

    // ---- 이미지 --------------------------------------------------------------------
    // ⚠️ 이 리포는 **두 계보**를 담는다 — api 이미지(`stage-current`·`<sha>`)와 mTLS 인그레스
    //    이미지(`ingress-stage-current`·`ingress-<sha>`). 리포를 3개로 나누지 않은 이유는
    //    권한이다: 코어 OIDC 롤(`github-deploy-scope-analysis-ecr`)의 push 허용 대상이
    //    `scope-analysis/api-stage` · `scope-analysis/worker-stage` **2개뿐**이라, 3번째 리포를
    //    만들면 그 롤로 밀 수 없다(롤 확장 = 코어 배포 = 이 lane 의 작업 경계 밖).
    //    ⇒ `maxImageCount` 를 20 → 40 으로 올린다. 한 리포에 계보가 둘이면 같은 20 은
    //    **이력 깊이가 절반**이 된다(푸시 1회에 이미지 2개). 지금 돌고 있는 태그가 만료로
    //    사라지면 태스크 교체가 pull 실패로 죽는다.
    const repoApi = new ecr.Repository(this, "RepoApi", {
      repositoryName: `scope-analysis/api-${stage}`,
      imageScanOnPush: true,
      lifecycleRules: [{ maxImageCount: 40 }],
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const repoWorker = new ecr.Repository(this, "RepoWorker", {
      repositoryName: `scope-analysis/worker-${stage}`,
      imageScanOnPush: true,
      lifecycleRules: [{ maxImageCount: 20 }],
      removalPolicy: RemovalPolicy.RETAIN,
    });
    // ---- 네트워크 ------------------------------------------------------------------
    // ⚠️ **`description` 은 CloudFormation 에서 불변이다 — 문구만 고쳐도 SG 가 교체된다.**
    //    `AWS::EC2::SecurityGroup.GroupDescription` 은 update 를 지원하지 않아 replace 가 되고,
    //    `securityGroupName` 이 고정돼 있으니 교체는 "같은 이름이 이미 있다" 로 **실패**한다
    //    (이름 없는 SG 라면 조용히 새 id 가 생기고, 코어가 자기 아웃바운드 규칙에서 참조하던
    //    옛 id 는 남아 트래픽이 새 SG 로 오지 않는다 — 그 실패는 "타깃 unhealthy" 로 보인다).
    //    ⇒ 이 문구는 **손대지 않는다.** 설명을 바꿔야 하면 SG 교체 = NLB 타깃 재등록 + 코어 쪽
    //       참조 갱신까지 한 세트로 계획하고, 배포 전 `cdk diff` 로 replace 여부를 확인한다
    //       (같은 제약이 `DbSg`·`WorkerSg` 에도 적용된다).
    const apiSg = new ec2.SecurityGroup(this, "ApiSg", {
      vpc,
      allowAllOutbound: true,
      securityGroupName: `scope-analysis-api-${stage}`,
      // ⚠️ 이 문구는 **라이브 SG 의 Description 과 바이트 단위로 같아야 한다.** 위 경고대로
      //    `GroupDescription` 은 불변이라 한 글자만 달라도 replace 가 걸리고, 고정 이름 때문에
      //    그 replace 는 "같은 이름이 이미 있다" 로 **배포를 실패시킨다**(2026-09-12 실측:
      //    `cdk diff` 가 `ApiSg … replace / GroupDescription (requires replacement)`). 아래 F9
      //    헬스체크 규칙을 추가할 때 설명에 "and the NLB health checker" 를 덧붙였던 것이
      //    정확히 그 실패였다 — 규칙 추가는 in-place 이고 설명 변경만 교체다.
      description: "analysis-api: inbound only 8443 mTLS from the scope core client SG",
    });
    if (coreClientSgId) {
      const coreSg = ec2.SecurityGroup.fromSecurityGroupId(this, "CoreClientSg", coreClientSgId, { mutable: false });
      apiSg.addIngressRule(coreSg, ec2.Port.tcp(8443), "scope core to analysis ticket API (mTLS)");
    }
    // ⚠️ **NLB 헬스체크가 들어올 길이 없었다**(F9). 타깃 타입이 `ip`(awsvpc)라 NLB 는 자기
    //    서브넷의 ENI 주소에서 타깃 IP:8443 으로 **직접** 친다 — 그 트래픽에는 소스 SG 가 없고
    //    보안그룹 참조 규칙으로는 절대 매치되지 않는다. 코어 클라이언트 SG 규칙 하나만 있으면
    //    헬스체크가 전부 막혀 타깃이 **영원히 unhealthy** 이고, 그러면 서비스가 배포 때마다
    //    순환 교체되다 circuit breaker 로 롤백된다(= 스택은 뜨는데 API 가 안 뜬다).
    //    자리표시자(`vpc-REPLACE`) 여부와 무관하게 **템플릿에 규칙이 있어야** 한다.
    const vpcCidr = ctx("vpcCidr") ?? "10.0.0.0/16";
    apiSg.addIngressRule(
      ec2.Peer.ipv4(vpcCidr),
      ec2.Port.tcp(8443),
      "NLB health checks (target type ip: no source SG) + in-VPC mTLS clients",
    );
    const workerSg = new ec2.SecurityGroup(this, "WorkerSg", {
      vpc,
      allowAllOutbound: true, // LLM 공급자로 나가는 egress. 인바운드는 없다.
      securityGroupName: `scope-analysis-worker-${stage}`,
      description: "analysis-worker: no inbound; egress to LLM providers and the lane RDS",
    });

    // ---- lane 전용 RDS (승인 L2 ⓐ) -------------------------------------------------
    // ⚠️ 측정 lane RDS 공유(ⓑ)는 기각이다 — staging t4g.micro 가 분당 수백 LLM 콜 원장 쓰기를
    //    받게 된다(스펙 §3.3 ④). 그리고 공유하면 이 스펙이 풀려는 결합을 저장소 축에서 되만든다.
    const dbSg = new ec2.SecurityGroup(this, "DbSg", {
      vpc,
      allowAllOutbound: false,
      securityGroupName: `scope-analysis-db-${stage}`,
      description: "analysis lane RDS: 5432 from api/worker SGs only",
    });
    dbSg.addIngressRule(apiSg, ec2.Port.tcp(5432), "analysis-api");
    dbSg.addIngressRule(workerSg, ec2.Port.tcp(5432), "analysis-worker");

    const dbSecret = new sm.Secret(this, "DbSecret", {
      secretName: `scope-analysis/${stage}/db`,
      description: "analysis lane postgres credentials (generated; never read into a session)",
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: "analysis", database: "analysis" }),
        generateStringKey: "password",
        excludePunctuation: true,
        passwordLength: 32,
      },
    });

    const db = new rds.DatabaseInstance(this, "Ledger", {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
      instanceType: new ec2.InstanceType(ctx("rdsInstanceType") ?? "t4g.medium"),
      vpc,
      vpcSubnets: privateSubnets,
      securityGroups: [dbSg],
      multiAz: false,
      // 스토리지 오토스케일은 **반드시** 켠다. 소진 = 쓰기 정지 = 무음 손실이고, 이 원장은
      // LLM 콜 1회당 1행이라 티켓 원장보다 빨리 큰다(측정 lane 0014 의 증가 속도 주석 참조).
      allocatedStorage: Number(ctx("rdsAllocatedGb") ?? 50),
      maxAllocatedStorage: Number(ctx("rdsMaxAllocatedGb") ?? 200),
      storageType: rds.StorageType.GP3,
      credentials: rds.Credentials.fromSecret(dbSecret),
      databaseName: "analysis",
      backupRetention: Duration.days(7),
      deletionProtection: true,
      storageEncrypted: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // ---- ECS -----------------------------------------------------------------------
    const cluster = new ecs.Cluster(this, "Cluster", { vpc, clusterName: `scope-analysis-${stage}`, containerInsights: true });
    const logGroup = new logs.LogGroup(this, "Logs", {
      logGroupName: `/scope-analysis/${stage}`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const commonEnv: Record<string, string> = {
      ANALYSIS_STAGE: stage,
      ANALYSIS_LANE_REVISION: ctx("laneRevision") ?? "0.0.0-dev",
      ANALYSIS_WORKER_MAX_COUNT: String(workerMax),
      // ⚠️ 램프(300 → 430 → 525 → 640 → 800)는 **이 값을 바꿔 밟는다**(승인 L6). 각 단계에서 분당
      //    persist · LLM p95 · 429 비율을 실측한 뒤 다음으로 간다. 800 은 1 vCPU × 48 전환의 짝이다
      //    (슬롯 floor((800 − 32) / 48) = 16 = 유닛 16 — 위 `WORKER_CPU` 블록).
      ANALYSIS_LLM_TOTAL_CONCURRENCY: ctx("llmTotalConcurrency") ?? "300",
      ANALYSIS_WORKER_UNIT_CONCURRENCY: ctx("unitConcurrency") ?? "40",
      // Hosting 인라인 2경로의 고정 몫. Hosting 동시 인스턴스 수는 **미확인**(스펙 §14-4).
      ANALYSIS_LLM_HOSTING_INFLIGHT: ctx("hostingInflight") ?? "32",
      // D13 — 값은 스테이징 실측 후 확정한다.
      ANALYSIS_VCPU_RESERVE: ctx("vcpuReserve") ?? "40",
      // ⚠️ 측정 몫은 **Fargate 태스크만** 센다(F6). 측정 lane 의 primary EC2 + ASG 웜풀은 Fargate
      //    쿼터를 쓰지 않으므로 이 축에 들어오면 안 된다 — 초판은 그 200 vCPU 를 빼고 있었고,
      //    그래서 존재하지 않는 경합 때문에 함대가 근거 없이 조여 있었다.
      ANALYSIS_MEASUREMENT_FARGATE_DESIRED: ctx("measurementFargateDesired") ?? "0",
      ANALYSIS_WORKER_VCPU: String(WORKER_CPU / 1024),
      ANALYSIS_API_VCPU: String(API_CPU / 1024),
      ANALYSIS_PREWARM_WORKERS: ctx("prewarmWorkers") ?? "2",
      ANALYSIS_PREWARM_MEASUREMENT_QUEUE_THRESHOLD: ctx("prewarmMeasurementQueueThreshold") ?? "24",
      ANALYSIS_PREWARM_MEASUREMENT_OLDEST_AGE_SECONDS: ctx("prewarmMeasurementOldestAgeSeconds") ?? "1200",
      // ⚠️ **배선돼 있지 않던 값이다.** `app/settings.ts` 에 `ANALYSIS_CONTEXT_FETCH_TIMEOUT_MS`
      //    가 있는데 태스크 정의가 주지 않아, 라이브는 코드 기본값으로만 돌았고 그 값을 바꾸려면
      //    이미지를 다시 구워야 했다. 컨텍스트 응답이 **14.4 MB**(2026-09-13 실측, gzip 3.4 MB ·
      //    catalog 8.4 MB · 로컬 3.0s)라 이 상한은 램프에서 조일 축이다 — context 로 뺀다.
      ANALYSIS_CONTEXT_FETCH_TIMEOUT_MS: ctx("contextFetchTimeoutMs") ?? "60000",
    };

    // ── B4: 유닛 동시성 ≤ 워커당 콜 슬롯 ────────────────────────────────────────────
    //
    // 워커 1대가 쓸 수 있는 **콜 슬롯**은 전역 상한을 함대로 나눈 값이다
    // (`worker/concurrency.ts` computeWorkerCallSlots — 여기서 그 함수를 그대로 부른다):
    //
    //     슬롯 = floor( (llmTotalConcurrency − hostingInflight) / workerMax )
    //           = floor( (800 − 32) / 48 ) = 16     ← 2026-09-14 상주값(1 vCPU × 48)
    //
    // `unitConcurrency` 는 워커 1대가 **동시에 처리하는 티켓 수**이고 티켓 하나는 최소 콜 하나를
    // 잡는다. 그래서 유닛 > 슬롯이면 그 초과분은 세마포어 대기열에 줄을 선다. 40 이면 2.5배
    // 초과구독이고, 대기 34.7s 가 `llmSlotAcquireTimeoutMs`(30s)를 넘겨 `CapacityTimeoutError`
    // → `deferred` → 3회 재시도 소진으로 이어진다. **초과구독은 처리량을 늘리지 않는다** —
    // 상한은 전역에 있으므로, 늘어나는 것은 대기와 실패뿐이다.
    //
    // ⚠️ 분모가 `workerMax` 인 것은 보수적 선택이 아니라 **현재의 라이브 동작**이다:
    //    `ANALYSIS_WORKER_COUNT` 가 배선돼 있지 않아 런타임이 항상 max 로 나눈다(후속 B5).
    //    그러니 synth 가 쓰는 산식과 라이브 산식이 여기서는 정확히 같다.
    const llmTotalConcurrency = Number(commonEnv.ANALYSIS_LLM_TOTAL_CONCURRENCY);
    const hostingInflight = Number(commonEnv.ANALYSIS_LLM_HOSTING_INFLIGHT);
    const unitConcurrency = Number(commonEnv.ANALYSIS_WORKER_UNIT_CONCURRENCY);
    for (const [name, value] of [
      ["llmTotalConcurrency", llmTotalConcurrency],
      ["hostingInflight", hostingInflight],
      ["unitConcurrency", unitConcurrency],
    ] as const) {
      if (!Number.isInteger(value) || value < 1) {
        throw new Error(`context ${name} 이 양의 정수가 아니다(${JSON.stringify(value)}). 용량 산식이 성립하지 않는다.`);
      }
    }
    const callSlotsPerWorker = computeWorkerCallSlots({
      total: llmTotalConcurrency,
      hostingInflight,
      workerCount: null, // ANALYSIS_WORKER_COUNT 미배선 → 런타임도 max 로 나눈다(후속 B5)
      maxWorkerCount: workerMax,
    });
    if (unitConcurrency > callSlotsPerWorker) {
      throw new Error(
        `context unitConcurrency=${unitConcurrency} 가 워커당 콜 슬롯 ${callSlotsPerWorker} 를 넘는다 ` +
          `(floor((llmTotalConcurrency ${llmTotalConcurrency} − hostingInflight ${hostingInflight}) / workerMax ${workerMax})). ` +
          "초과구독은 처리량이 아니라 슬롯 대기를 늘리고, 대기가 llmSlotAcquireTimeoutMs 를 넘으면 " +
          "CapacityTimeoutError → deferred → 재시도 소진이다. 유닛을 슬롯 이하로 내리거나 " +
          "llmTotalConcurrency 를 램프 규칙에 따라 올려라(승인 L6).",
      );
    }
    // ⚠️ **쿼터는 실값일 때만 준다.** 미설정이면 앱이 예산 가드를 끄고 그 사실을 기동 로그로
    //    남긴다(`app/main.ts`). 자리표시자 숫자를 넣으면 "가드가 도는 것처럼 보이는데 근거가
    //    없는" 최악의 상태가 된다 — 실값은 Service Quotas 조회로 채운다(승인 L13 · 스펙 §14-14).
    const fargateVcpuQuota = ctx("fargateVcpuQuota");
    if (fargateVcpuQuota) commonEnv.ANALYSIS_FARGATE_VCPU_QUOTA = fargateVcpuQuota;
    // DB 부품(비밀번호 제외). 비밀번호는 위 `secrets:` 로만 들어온다.
    commonEnv.ANALYSIS_DB_HOST = db.dbInstanceEndpointAddress;
    commonEnv.ANALYSIS_DB_PORT = db.dbInstanceEndpointPort;
    commonEnv.ANALYSIS_DB_NAME = "analysis";
    commonEnv.ANALYSIS_DB_USER = "analysis";

    const measurementCapacityUrl = ctx("measurementCapacityUrl");
    if (measurementCapacityUrl) commonEnv.ANALYSIS_MEASUREMENT_CAPACITY_URL = measurementCapacityUrl;

    // ---- analysis-api (상시 1) ------------------------------------------------------
    const apiTask = new ecs.FargateTaskDefinition(this, "ApiTask", {
      cpu: API_CPU,
      memoryLimitMiB: API_MEMORY_MIB,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
    });
    const apiContainer = apiTask.addContainer("api", {
      image: ecs.ContainerImage.fromEcrRepository(repoApi, ctx("apiImageTag") ?? DEFAULT_IMAGE_TAG),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "api", logGroup }),
      environment: { ...commonEnv, ANALYSIS_PORT: "8080" },
      // ⚠️ **비밀번호만 시크릿으로** 주입하고 DSN 은 앱이 조립한다(app/settings.ts resolveStoreDsn).
      //    통짜 DSN 을 시크릿에 넣으려면 사람이 평문 DSN 을 손으로 만들어야 하고, 그 순간
      //    비밀번호가 사람 손과 툴 출력을 지나간다(룰 secrets-handling). 그리고 argv 로는
      //    절대 넘기지 않는다 — `ps` 는 출력 마스킹을 지나간다(같은 룰 6).
      secrets: { ANALYSIS_DB_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret, "password") },
      portMappings: [{ containerPort: 8080 }],
      essential: true,
    });
    // mTLS 인그레스는 **사이드카**다 — 측정 lane 이 nginx 로 종단하는 것과 같은 자리이고,
    // ALB 가 아니라 NLB 를 쓰는 이유도 그것이다(ALB 는 TLS 를 스스로 끝내 클라이언트 인증서가
    // 앱 경계까지 오지 않는다).
    //
    // ⚠️ **stock nginx 가 아니다**(운영 결정 ⓐ, 2026-09-12). stock 이미지는 리포의 nginx.conf 도
    //    인증서도 갖지 않아 80 만 듣고 8443 을 안 듣는다 → NLB TCP:8443 영구 unhealthy →
    //    태스크 교체 → circuit breaker. 이미지는 **설정만** 굽고 인증서는 entrypoint 가 기동 시
    //    태스크 롤로 받는다(deploy/Dockerfile.ingress · deploy/ingress/entrypoint.sh).
    //
    // 시크릿은 **이 스택이 만들지 않는다** — 값을 사람이 넣어야 하고(같은 CA 발급본), 빈 껍데기를
    // 만들어 두면 "있다"고 읽혀 기동 실패의 원인이 흐려진다. 참조만 한다.
    // 주입 절차: README "시크릿 주입 절차".
    //
    // ⚠️ **완전 ARN 을 우선한다**(M2). 이름(`fromSecretNameV2`)은 부분 ARN 이라 태스크 롤 정책이
    //    `-??????` 와일드카드를 쓸 수밖에 없고, 그 와일드카드는 **같은 이름 접두사를 가진 다른
    //    시크릿까지** 읽을 수 있게 한다. ARN 이 주어지면 접미사까지 고정해 대상이 정확히 1개가
    //    된다. 접미사는 비밀이 아니다(AWS 가 붙이는 리소스 식별자). 이름 경로는 ARN 을 아직
    //    모르는 새 스테이지용 폴백으로 남긴다.
    const ingressCertSecretArn = ctx("ingressCertSecretArn");
    const ingressCertSecretName = ctx("ingressCertSecretName") ?? `scope-analysis/${stage}/ingress-cert`;
    // entrypoint 의 `aws secretsmanager get-secret-value --secret-id` 는 이름도 ARN 도 받는다.
    const ingressCertSecretId = ingressCertSecretArn ?? ingressCertSecretName;
    const ingressContainer = apiTask.addContainer("ingress", {
      // api 리포의 `ingress-` 접두사 태그. **리포가 아니라 태그로 계보를 가른다**(위 주석).
      image: ecs.ContainerImage.fromEcrRepository(repoApi, ctx("ingressImageTag") ?? DEFAULT_INGRESS_IMAGE_TAG),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "ingress", logGroup }),
      portMappings: [{ containerPort: 8443 }],
      essential: true,
      environment: {
        // 값이 아니라 **참조**다. entrypoint 가 태스크 롤로 읽는다(룰 secrets-handling 1·5).
        ANALYSIS_INGRESS_CERT_SECRET_ID: ingressCertSecretId,
        // ⚠️ ECS 는 태스크에 AWS_REGION 을 자동으로 넣지 않는다(Lambda 와 다르다). 없으면
        //    aws cli 가 "You must specify a region" 으로 죽고, 그 메시지는 권한 문제로 오진된다.
        AWS_REGION: this.region,
      },
      // 컨테이너 헬스체크는 **루프백 stub_status(8081)** 다 — 8443 을 치면 클라이언트 인증서가
      // 없어 `ssl_verify_client on` 이 400 을 돌려주므로 영구 실패한다. NLB 쪽은 TCP:8443
      // (핸드셰이크 전 단계)이라 정상 판정된다 — 두 헬스체크가 보는 층이 다른 것이 설계다.
      healthCheck: {
        command: ["CMD-SHELL", "wget -q -O- http://127.0.0.1:8081/nginx_status >/dev/null 2>&1 || exit 1"],
        interval: Duration.seconds(15),
        timeout: Duration.seconds(3),
        retries: 3,
        startPeriod: Duration.seconds(15),
      },
    });
    ingressContainer.addContainerDependencies({ container: apiContainer, condition: ecs.ContainerDependencyCondition.START });

    // 태스크 롤에 **이 시크릿 하나만** GetSecretValue.
    //   · ARN 경로: 대상이 정확히 1개다(와일드카드 없음).
    //   · 이름 경로(폴백): `fromSecretNameV2` 는 난수 접미사가 없는 ARN 을 만들므로 `-??????` 로
    //     와일드카드한다(코어 hosting-stack 과 같은 관례) — 같은 접두사의 다른 시크릿도 읽힌다.
    // ⚠️ ListSecrets·PutSecretValue 는 주지 않는다. **DescribeSecret 도 이 문장에는 없다** —
    //    entrypoint 는 `get-secret-value` 하나만 부른다. (워커 쪽은 다르다: `ecs.Secret.
    //    fromSecretsManager` 가 **실행 롤**에 CDK `grantRead` 를 붙이고 그것은 GetSecretValue +
    //    **DescribeSecret 을 함께** 준다 — 아래 `workerSecrets` 주석 참조. 두 층을 같은 문장으로
    //    설명하면 "태스크 롤에 Describe 가 없다" 를 "lane 어디에도 없다" 로 오독하게 된다.)
    const ingressCertSecret = ingressCertSecretArn
      ? sm.Secret.fromSecretCompleteArn(this, "IngressCertSecret", ingressCertSecretArn)
      : sm.Secret.fromSecretNameV2(this, "IngressCertSecret", ingressCertSecretName);
    apiTask.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: "IngressCertRead",
        actions: ["secretsmanager:GetSecretValue"],
        resources: [ingressCertSecretArn ? ingressCertSecret.secretArn : `${ingressCertSecret.secretArn}-??????`],
      }),
    );

    const apiService = new ecs.FargateService(this, "ApiService", {
      cluster,
      serviceName: `analysis-api-${stage}`,
      taskDefinition: apiTask,
      desiredCount: apiDesired, // 승인 L3 ⓐ 는 상시 1 — 접수가 죽으면 코어 submitter 의 to_submit 가 쌓인다.
      // 0 은 **배포 순서를 위한 일시 상태**이지 운영 값이 아니다(위 apiDesired 주석).
      securityGroups: [apiSg],
      vpcSubnets: privateSubnets,
      assignPublicIp: false,
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
    });

    const nlb = new elbv2.NetworkLoadBalancer(this, "Nlb", {
      vpc,
      internetFacing: false,
      vpcSubnets: privateSubnets,
      loadBalancerName: `scope-analysis-${stage}`,
    });
    nlb
      .addListener("Mtls", { port: 8443, protocol: elbv2.Protocol.TCP })
      .addTargets("ApiTargets", {
        port: 8443,
        protocol: elbv2.Protocol.TCP,
        targets: [apiService.loadBalancerTarget({ containerName: "ingress", containerPort: 8443 })],
        // ⚠️ 헬스체크는 TCP 다 — HTTP 로 하면 NLB 가 클라이언트 인증서 없이 치므로 nginx 가
        //    `ssl_verify_client on` 에서 400 을 돌려주고 타깃이 영원히 unhealthy 가 된다.
        healthCheck: { protocol: elbv2.Protocol.TCP, interval: Duration.seconds(30) },
        deregistrationDelay: Duration.seconds(30),
      });

    // ---- analysis-worker (0 ~ max) --------------------------------------------------
    const workerTask = new ecs.FargateTaskDefinition(this, "WorkerTask", {
      cpu: WORKER_CPU,
      memoryLimitMiB: WORKER_MEMORY_MIB,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
    });
    // 코어 내부 토큰(`x-scope-internal-token`) — **워커만** 코어를 호출한다(콜백 doorbell +
    // 컨텍스트 스냅샷 GET). api 는 코어로 나가지 않으므로 주지 않는다.
    //
    // ⚠️ **완전 ARN 이 필요하다.** ECS `secrets` 의 JSON 키 형태(`…:secret:name:key::`)는 6자
    //    난수 접미사를 포함한 완전 ARN 을 요구해서 `fromSecretNameV2`(부분 ARN)로는 태스크
    //    기동이 `Invalid ARN` 으로 죽는다. 그래서 이름이 아니라 **context 로 ARN** 을 받는다.
    //    시크릿은 이 스택이 만들지 않는다(값은 사람이 넣는다 — README "시크릿 주입 절차").
    //    ARN 접미사는 비밀이 아니다(AWS 가 붙이는 리소스 식별자).
    //
    // context 미설정이면 배선하지 않는다 — 1단계(worker desired 0 · engine stub · 코어 플래그
    // off)는 코어를 호출하지 않으므로 토큰이 없어도 정상이다. **플래그를 켜기 전의 선행 조건**이고,
    // 그 점은 워커가 기동에서 단언한다(worker/internal-token.ts checkTokenWiring).
    const internalTokenSecretArn = ctx("internalTokenSecretArn");
    // ⚠️ 기본값은 **`stub` 으로 남긴다** — 새 스테이지·새 계정에서 키 배선 없이 core 로 뜨면
    //    워커가 기동에서 죽는다. 스테이징은 `cdk.json` context 가 `core` 를 **명시**한다(런북 C6).
    //
    // ⚠️ **빈 문자열은 stub 로 접지 않는다 — 합성에서 죽인다.** `-c engine=` 는 context 값을
    //    `""` 로 만들고 `?? "stub"` 은 null/undefined 만 막으므로, `""` 가 그대로 태스크 정의
    //    env(`ANALYSIS_ENGINE=""`)로 내려간다. 그 다음 런타임 `str("ANALYSIS_ENGINE","stub")` 이
    //    빈값을 기본값으로 접어 **워커가 조용히 스텁으로 돈다** — C6 가 막으려던 바로 그 오답
    //    (shadow 비교가 "분석이 달라졌다"로 읽힌다)이고, 이쪽은 synth 산출물에도 흔적이 없다
    //    (`Value: ""`). 런타임 쪽 방어는 `app/settings.ts` 의 `strStrict` 가 짝으로 맡는다.
    const engineRaw = ctx("engine");
    if (engineRaw !== undefined && engineRaw !== null && String(engineRaw).trim() === "") {
      throw new Error(
        "context engine 이 빈/공백 문자열이다(`-c engine=`). 빈값은 런타임에서 stub 으로 접히므로 " +
          "합성에서 막는다 — `-c engine=core` 또는 `-c engine=stub` 으로 **명시**하라.",
      );
    }
    const engine = engineRaw ?? "stub";
    const workerEnv: Record<string, string> = { ...commonEnv, ANALYSIS_ENGINE: engine };
    // ---- 드레인 예산 (B8/A6) — **배선돼 있지 않던 값** -------------------------------
    //
    // `worker/main.ts:42` 는 `ANALYSIS_DRAIN_GRACE_SECONDS ?? 600` 이고 태스크 정의는 그 env 를
    // 주지 않았다. 그래서 라이브 워커는 SIGTERM 후 **600초** 동안 정리할 수 있다고 믿었는데,
    // Fargate 는 `stopTimeout` 120초 뒤에 SIGKILL 한다. 믿는 값과 실제가 5배 어긋나 있었고,
    // 그 차이는 "드레인 로그를 남기고 조용히 살해당한 유닛" 으로만 나타난다(재처리·이중 실비).
    const drainGraceSeconds = Number(ctx("drainGraceSeconds") ?? WORKER_DRAIN_GRACE_SECONDS_DEFAULT);
    if (!Number.isInteger(drainGraceSeconds) || drainGraceSeconds <= 0 || drainGraceSeconds >= WORKER_STOP_TIMEOUT_SECONDS) {
      throw new Error(
        `context drainGraceSeconds=${ctx("drainGraceSeconds")} 는 1..${WORKER_STOP_TIMEOUT_SECONDS - 1} 의 정수여야 한다 — ` +
          `Fargate stopTimeout(${WORKER_STOP_TIMEOUT_SECONDS}s) 이상이면 워커가 못 지키는 예산을 믿고 드레인을 시작한다.`,
      );
    }
    workerEnv.ANALYSIS_DRAIN_GRACE_SECONDS = String(drainGraceSeconds);

    // ---- RDS 연결 예산 (2026-09-14 · 1 vCPU × 48 전환의 선행 조건) --------------------
    //
    // ⚠️ **함대를 키우면 여기가 CPU 보다 먼저 터진다.** 산술은 위 `WORKER_DB_POOL_MAX_DEFAULT`
    //    블록에 있다 — 48 × 10(구 하드코딩) + api 10 = 490 > max_connections 400.
    //
    // ⇒ 풀 크기를 env 로 빼고 스택이 **5** 를 준다: 48 × 5 + api 10 = 250(정원의 62.5%).
    //   워커는 단일 스레드라 유닛 16 이 동시에 잡는 커넥션이 10 까지 가지 않는다 — DB 구간은
    //   컨텍스트 준비·persist 로 짧고, 그 사실이 CPU 51%/2 vCPU 실측으로 이미 보였다.
    //
    // ⚠️ 부등식을 **synth 가 강제한다** — B4 슬롯 부등식과 같은 이유다. 값이 셋(함대·풀·api)으로
    //    흩어져 있어 하나만 올리면 "배포는 성공했는데 워커 절반이 안 뜬다" 가 된다. 그 실패는
    //    기동 시점이라 시끄럽지만, 시끄러운 것이 램프 창을 태우는 것은 C8 에서 이미 겪었다.
    const workerDbPoolMax = Number(ctx("workerDbPoolMax") ?? WORKER_DB_POOL_MAX_DEFAULT);
    if (!Number.isInteger(workerDbPoolMax) || workerDbPoolMax < 1) {
      throw new Error(`context workerDbPoolMax=${ctx("workerDbPoolMax")} 는 1 이상의 정수여야 한다.`);
    }
    const dbConnectionsAtMax = workerMax * workerDbPoolMax + API_DB_POOL_MAX;
    if (dbConnectionsAtMax > RDS_CONNECTION_BUDGET) {
      throw new Error(
        `함대 최대치의 RDS 연결 ${dbConnectionsAtMax} 가 예산 ${RDS_CONNECTION_BUDGET} 를 넘는다 ` +
          `(workerMax ${workerMax} × workerDbPoolMax ${workerDbPoolMax} + api ${API_DB_POOL_MAX}; ` +
          `lane RDS max_connections ${RDS_MAX_CONNECTIONS} 의 ` +
          `${Math.round((RDS_CONNECTION_BUDGET / RDS_MAX_CONNECTIONS) * 100)}%). 넘으면 함대가 다 뜨는 ` +
          "순간 뒤쪽 워커가 `too many connections` 로 기동에서 죽는다 — 풀을 줄이거나" +
          "(`-c workerDbPoolMax=<n>`) 함대를 줄여라. RDS 급을 올렸다면 RDS_MAX_CONNECTIONS 를 " +
          "**실측값으로** 갱신한다(추정 금지 — fargateVcpuQuota 와 같은 원칙).",
      );
    }
    // ⚠️ **workerEnv 다**(commonEnv 아님). api 는 `app/main.ts` 의 리터럴 10 으로 돈다 — 태스크가
    //    1대뿐이라 함대 산술에 안 들어가고, 여기서 같이 내리면 접수 지연이 된다.
    workerEnv.ANALYSIS_DB_POOL_MAX = String(workerDbPoolMax);

    // ---- 게이트③ 프롬프트 캐시 무효화 (운영 결정 2026-09-13) ------------------------
    //
    // ⚠️ api 컨테이너에는 넣지 않는다(`commonEnv` 가 아니라 `workerEnv`) — LLM 을 부르는 것은
    //    워커뿐이다. 기본 "false" = 라이브 동작 무변경.
    //
    // ⚠️ **빈 문자열은 합성에서 죽인다** — `engine` 과 같은 자리의 같은 결함이다. `-c
    //    llmCacheBust=` 는 context 를 `""` 로 만들고 `?? "false"` 는 null/undefined 만 막으므로
    //    `ANALYSIS_LLM_CACHE_BUST=""` 가 그대로 내려가 런타임이 기본값(false)으로 접는다.
    //    게이트 창을 켰다고 믿는데 안 켜진 상태 = **실패가 아니라 오답**이고, synth 산출물에도
    //    `Value: ""` 밖에 안 남아 아무도 못 잡는다.
    const cacheBustRaw = ctx("llmCacheBust");
    if (cacheBustRaw !== undefined && cacheBustRaw !== null && String(cacheBustRaw).trim() === "") {
      throw new Error(
        "context llmCacheBust 가 빈/공백 문자열이다(`-c llmCacheBust=`). 빈값은 런타임에서 false 로 " +
          "접히므로 합성에서 막는다 — `-c llmCacheBust=true` 또는 `-c llmCacheBust=false` 로 **명시**하라.",
      );
    }
    workerEnv.ANALYSIS_LLM_CACHE_BUST = String(cacheBustRaw ?? "false").trim();
    // 모드는 **설정됐을 때만** 내린다 — 코드 기본값(`nonce`)이 정본이고, 태스크 정의가 빈 문자열을
    // 주면 런타임 파서가 그것을 또 기본값으로 접어야 한다(같은 종류의 조용한 폴백을 하나 더 만든다).
    const cacheBustMode = ctx("llmCacheBustMode");
    if (cacheBustMode !== undefined && cacheBustMode !== null && String(cacheBustMode).trim() !== "") {
      workerEnv.ANALYSIS_LLM_CACHE_BUST_MODE = String(cacheBustMode).trim();
    }
    const workerSecrets: Record<string, ecs.Secret> = {
      ANALYSIS_DB_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret, "password"),
    };
    if (internalTokenSecretArn) {
      const tokenSecret = sm.Secret.fromSecretCompleteArn(this, "InternalTokenSecret", internalTokenSecretArn);
      // 필드 계약 = README "시크릿 주입 절차". 코어는 두 라우트에 **서로 다른 env** 를 쓰므로
      // (`ANALYSIS_LANE_CALLBACK_SECRET` · `ANALYSIS_LANE_CONTEXT_SECRET`) 필드도 둘로 둔다 —
      // 한 값으로 합쳐 두면 코어가 둘을 따로 로테이션한 순간 조용히 404 가 된다.
      workerSecrets.ANALYSIS_INTERNAL_CALLBACK_TOKEN = ecs.Secret.fromSecretsManager(tokenSecret, "callback_token");
      workerSecrets.ANALYSIS_INTERNAL_CONTEXT_TOKEN = ecs.Secret.fromSecretsManager(tokenSecret, "context_token");
      // 값이 아니라 **출처**다. 기동 단언과 진단 로그가 쓴다(값은 로그에 안 나온다 — 지문만).
      workerEnv.ANALYSIS_LANE_INTERNAL_TOKEN_SECRET_ARN = internalTokenSecretArn;
    }
    // ---- 공급자 키 (런북 C8) --------------------------------------------------------
    //
    // `worker/llm-pools.ts` 의 DEFAULT_POOLS 는 **env 에서** 키를 읽고(`OPENROUTER_API_KEY` ·
    // `OPENAI_API_KEY` · `GOOGLE_AI_API_KEY`), 키 없는 풀은 비활성이다. 활성 풀이 0 이면
    // `engine=core` 워커는 **기동에서 죽는다**(tests/silent-failure-gate.test.ts (a)) — 키 없이
    // 떠서 큐를 끌어다 전부 실패시키고 재시도 예산을 태우는 것보다 낫다는 설계다.
    //
    // 시크릿은 **만들지 않는다.** 코어 `infra/stacks/secrets-stack.ts` 가 만든
    // `scope/<stage>/llm`(설명: "OPENROUTER_API_KEY and related env (JSON)")을 ARN 으로 참조한다.
    // ⚠️ ECS `secrets` 의 JSON 키 형태는 **완전 ARN** 을 요구한다(부분 ARN → `Invalid ARN`).
    // ⚠️ 주입은 **실행 롤(execution role)** 이 한다 — `fromSecretsManager` 가 그 롤에만 이 ARN
    //    한정으로 권한을 붙인다. 태스크 롤에는 **주지 않는다**: 앱이 env 로 받으므로 런타임 SDK
    //    조회 경로가 없고, 주면 기능 없는 잉여 권한이 된다.
    // ⚠️ 붙는 액션은 `GetSecretValue` **하나가 아니다** — CDK `grantRead` 가
    //    `["secretsmanager:GetSecretValue","secretsmanager:DescribeSecret"]` 를 **함께** 준다
    //    (2026-09-12 synth 실측: WorkerTaskExecutionRoleDefaultPolicy 의 세 문장 전부 2액션).
    //    좁힐 수 없는 자리다(ECS 주입이 요구한다). 인그레스 태스크 롤은 직접 쓴 PolicyStatement 라
    //    Get 하나뿐이고, 두 층을 같은 문장으로 설명하면 "lane 어디에도 Describe 가 없다" 로 오독된다.
    const llmSecretArn = ctx("llmSecretArn");
    if (engine !== "stub" && !llmSecretArn) {
      // 배포가 아니라 **synth** 에서 죽인다 — 그래야 "함대가 안 뜬다"를 라이브에서 겪지 않는다.
      throw new Error(
        `engine=${engine} 인데 context llmSecretArn 이 없다. 공급자 키가 하나도 없으면 워커는 ` +
          "기동에서 죽는다(활성 풀 0). `-c llmSecretArn=<완전 ARN>` 을 주거나 `-c engine=stub` 으로 내려라.",
      );
    }
    // ---- 태스크별 모델 (B2) ----------------------------------------------------------
    //
    // ⚠️ **lane 워커 TD(rev 9)에 `LLM_TASK_MODEL_*` 가 하나도 없었다**(2026-09-13
    //    `describe-task-definition` 실측). 그래서 `worker/llm-pools.ts` 의 override 가 비어
    //    `BUILT_IN_DEFAULTS`(alias haiku/sonnet)로 접혔고, 라이브가 extract·semantics 를
    //    `anthropic/claude-haiku-4.5`, resolve 를 `anthropic/claude-sonnet-4.6` 으로 돌았다.
    //    코어 `measurement-worker-staging:238` 은 같은 태스크를 `openai/gpt-5.6-luna` ·
    //    `google/gemini-3.1-flash-lite` 로 돌린다. 실패가 아니라 **오답**이다 — 콜은 전부 200 이고
    //    남는 것은 턴 체류 2.3배(extract p50 37.0s vs 16.1s)·단가 17배($0.0706 vs $0.0040)·
    //    "같은 모델" 을 전제하는 shadow A/B 의 무효화다.
    //
    // 값은 **context `llmTaskModels` 객체**로 받아 그대로 펼친다(키 = 코어 env 이름). 코어 TD
    // 정본이 바뀌면 `cdk.json` 한 줄만 고치면 된다 — **이미지 재빌드 불필요**.
    //
    // ⚠️ api 컨테이너에는 넣지 않는다(그래서 `commonEnv` 가 아니라 `workerEnv` 다). api 는 LLM 을
    //    부르지 않으므로 거기 있는 모델 설정은 "api 도 분석을 한다" 는 오독만 만든다. 가드도
    //    엔진 조건부인데 엔진은 워커 축이다.
    const llmTaskModelsRaw = this.node.tryGetContext("llmTaskModels") as unknown;
    if (llmTaskModelsRaw !== undefined && (typeof llmTaskModelsRaw !== "object" || llmTaskModelsRaw === null || Array.isArray(llmTaskModelsRaw))) {
      throw new Error("context llmTaskModels 는 { 코어 env 이름: 모델 id } 객체여야 한다.");
    }
    const llmTaskModels = (llmTaskModelsRaw ?? {}) as Record<string, unknown>;
    // 오타난 키는 **조용히 무시되어 폴백이 된다** — 그래서 모르는 키를 죽인다.
    const unknownModelKeys = Object.keys(llmTaskModels).filter((k) => !CORE_TASK_MODEL_ENV_KEYS.includes(k));
    if (unknownModelKeys.length > 0) {
      throw new Error(
        `context llmTaskModels 에 알 수 없는 키가 있다: ${unknownModelKeys.join(", ")}. ` +
          `허용 키는 ${CORE_TASK_MODEL_ENV_KEYS.length}개뿐이다(${CORE_TASK_MODEL_ENV_KEYS.join(", ")}) — ` +
          "오타난 키는 주입되지 않아 그 태스크가 조용히 alias 기본값으로 접힌다.",
      );
    }
    const missingModelKeys: string[] = [];
    for (const key of CORE_TASK_MODEL_ENV_KEYS) {
      const raw = llmTaskModels[key];
      const value = typeof raw === "string" ? raw.trim() : "";
      if (value === "") {
        missingModelKeys.push(key);
        continue;
      }
      // lane 은 Bedrock 을 돌리지 않는다(SDK 의존성 금지) — 형식도 여기서 막는다. 런타임
      // `resolveLaneModel` 이 같은 것을 던지지만, 그건 **함대가 안 뜨는** 형태로 나타난다.
      if (!/^openrouter\/[^/\s]+\/[^/\s]+$/.test(value)) {
        throw new Error(
          `context llmTaskModels["${key}"]=${JSON.stringify(value)} 형식이 틀렸다 — ` +
            "`openrouter/<vendor>/<model>` 이어야 한다(lane 은 bedrock: 을 돌리지 않는다).",
        );
      }
      workerEnv[key] = value;
    }
    if (engine !== "stub" && missingModelKeys.length > 0) {
      // llmSecretArn 가드와 **같은 자리·같은 이유** — 배포가 아니라 synth 에서 죽인다.
      throw new Error(
        `engine=${engine} 인데 context llmTaskModels 에 ${missingModelKeys.join(", ")} 가 없다. ` +
          "비어 있으면 워커가 alias 기본값(haiku/sonnet)으로 접혀 **코어와 다른 모델**로 돈다 — " +
          "콜은 전부 200 이라 알람이 울지 않는다. 코어 measurement-worker TD 정본의 값을 " +
          "`cdk.json` context `llmTaskModels` 에 적거나 `-c engine=stub` 으로 내려라.",
      );
    }

    // 직결 풀은 **그 필드가 있다고 확인된 경우에만** 켠다 — ECS 는 없는 JSON 키를 주입하려 하면
    // 태스크 기동을 실패시킨다. 미설정 = 미주입 = 그 풀 비활성(openrouter 만 돈다).
    // ⚠️ 아래 `llmTaskPools` 가드가 이 두 값을 읽으므로 **시크릿 배선보다 먼저** 꺼낸다 —
    //    "standby 를 켰는데 키가 안 들어간다"(= 페일오버가 영영 안 일어난다) 를 synth 에서 막는다.
    const openaiField = ctx("llmSecretOpenaiKeyField");
    const googleField = ctx("llmSecretGoogleKeyField");

    // ---- 태스크별 공급자 풀 — **직결 standby 페일오버** (운영 결정 2026-09-13) ----------
    //
    // `LLM_TASK_POOLS_<코어 태스크> = "openrouter:1,openai_direct:0"` 의 **0 은 standby** 다:
    // 평시 트래픽은 OpenRouter 100% 이고, OpenRouter 가 헬스 게이팅되거나(5분 창 429/5xx>10%)
    // 그 콜이 실패했을 때만 직결로 넘어간다(`worker/llm-pools.ts` `pickPool`).
    //
    // ⚠️ **미설정이 기본이고, 미설정이면 openrouter 단독이다**(`taskPoolWeights`). 즉 이 context 를
    //    안 주면 이 배선은 라이브 동작을 한 바이트도 바꾸지 않는다.
    //
    // 여기서 막는 것 셋 — 전부 **라이브에서 "아무 일도 안 일어나는" 모양**으로 나타나는 것들이다:
    //   ① 오타난 키          → 주입 안 됨 → standby 가 없는데 있다고 믿는다
    //   ② 모델↔풀 벤더 불일치 → 넘어간 콜이 404(모델 없음). **OpenRouter 가 아플 때만** 보인다
    //   ③ 키 필드 미주입      → 그 풀이 비활성이라 `taskPoolWeights` 가 조용히 뺀다
    const llmTaskPoolsRaw = this.node.tryGetContext("llmTaskPools") as unknown;
    if (llmTaskPoolsRaw !== undefined && (typeof llmTaskPoolsRaw !== "object" || llmTaskPoolsRaw === null || Array.isArray(llmTaskPoolsRaw))) {
      throw new Error('context llmTaskPools 는 { LLM_TASK_POOLS_<코어 태스크>: "openrouter:1,openai_direct:0" } 객체여야 한다.');
    }
    const llmTaskPools = (llmTaskPoolsRaw ?? {}) as Record<string, unknown>;
    const unknownPoolTaskKeys = Object.keys(llmTaskPools).filter((k) => !CORE_TASK_POOL_ENV_KEYS.includes(k));
    if (unknownPoolTaskKeys.length > 0) {
      throw new Error(
        `context llmTaskPools 에 알 수 없는 키가 있다: ${unknownPoolTaskKeys.join(", ")}. ` +
          `허용 키는 lane 이 부르는 ${CORE_TASK_POOL_ENV_KEYS.length}태스크뿐이다(${CORE_TASK_POOL_ENV_KEYS.join(", ")}) — ` +
          "오타난 키는 주입되지 않아 그 태스크가 조용히 openrouter 단독으로 돈다(= standby 없음).",
      );
    }
    /** 풀 키 → 그 풀의 키 필드 context 이름. 직결 풀만 있다(openrouter 는 항상 주입된다). */
    const directKeyFieldOf: Record<string, { ctxKey: string; value: string | undefined }> = {
      openai_direct: { ctxKey: "llmSecretOpenaiKeyField", value: openaiField },
      google_direct: { ctxKey: "llmSecretGoogleKeyField", value: googleField },
    };
    for (const key of CORE_TASK_POOL_ENV_KEYS) {
      const raw = llmTaskPools[key];
      if (raw === undefined) continue; // 미설정 = openrouter 단독. 그것이 기본값이다
      const value = typeof raw === "string" ? raw.trim() : "";
      if (value === "") {
        throw new Error(
          `context llmTaskPools["${key}"] 가 비었다. 런타임은 빈 값을 **미설정**(openrouter 단독)으로 ` +
            "접으므로 '켰다고 믿는데 안 켜진' 상태가 된다 — 켤 생각이 없으면 키 자체를 지워라.",
        );
      }
      // 이 태스크의 모델 벤더. `llmTaskModels` 값은 `openrouter/<vendor>/<model>` 로 이미 검증됐다.
      const modelId = String(llmTaskModels[key.replace("LLM_TASK_POOLS_", "LLM_TASK_MODEL_")] ?? "");
      const modelVendor = modelId.split("/")[1] ?? "";
      for (const part of value.split(",")) {
        const [poolKey, weightRaw] = part.split(":").map((s) => s.trim());
        if (!poolKey) throw new Error(`context llmTaskPools["${key}"]=${JSON.stringify(value)} 형식이 틀렸다 — "pool:weight,pool:weight".`);
        const pool = BUILT_IN_POOLS.find((x) => x.key === poolKey);
        if (!pool) {
          throw new Error(
            `context llmTaskPools["${key}"] 의 풀 ${JSON.stringify(poolKey)} 는 내장 풀이 아니다 ` +
              `(${BUILT_IN_POOLS.map((x) => x.key).join(", ")}). 런타임은 모르는 풀을 **조용히 뺀다** — ` +
              "오타면 그 태스크가 가중치 없이 돌고, 진짜 새 풀이면 `LLM_POOL_KEYS` 배선이 먼저다.",
          );
        }
        const weight = weightRaw === undefined ? 1 : Number(weightRaw);
        if (!Number.isFinite(weight) || weight < 0) {
          throw new Error(`context llmTaskPools["${key}"]: ${poolKey} 의 가중치 ${JSON.stringify(weightRaw)} 가 0 이상의 수가 아니다.`);
        }
        // ② 모델↔풀 벤더. **풀이 바뀌어도 모델은 안 바뀌므로**(스펙 §8.3) 벤더가 안 맞으면
        //    그 풀에는 그 모델이 존재하지 않는다 — 런타임도 같은 판정을 하지만(라우팅에서 뺀다)
        //    여기서 죽는 편이 낫다. 런타임 제거는 "standby 를 켰는데 안 넘어간다" 로 보인다.
        if (modelVendor !== "" && pool.modelVendors !== null && !pool.modelVendors.includes(modelVendor)) {
          throw new Error(
            `context llmTaskPools["${key}"] 가 ${poolKey} 를 지목했는데 그 풀은 ` +
              `${pool.modelVendors.join("|")} 벤더만 받는다(이 태스크 모델 = ${modelId}). ` +
              "풀이 바뀌어도 모델은 안 바뀐다 — 넘어간 콜이 404(모델 없음)로 죽고, 그 실패는 " +
              "**OpenRouter 가 아플 때만** 나타나서 평시에 한 번도 안 보인다.",
          );
        }
        // ③ 키 필드. 키가 안 들어가면 그 풀은 비활성이고 `taskPoolWeights` 가 조용히 뺀다 =
        //    "standby 를 켜 뒀다" 는 믿음만 남는다.
        const direct = directKeyFieldOf[poolKey];
        if (engine !== "stub" && direct && !direct.value) {
          throw new Error(
            `context llmTaskPools["${key}"] 가 ${poolKey} 를 켰는데 context ${direct.ctxKey} 가 비었다. ` +
              "키가 주입되지 않으면 그 풀은 **비활성**이라 페일오버가 영영 일어나지 않는다 — " +
              `시크릿에 그 JSON 필드가 있는지 확인하고 \`-c ${direct.ctxKey}=<필드명>\` 을 함께 줘라.`,
          );
        }
      }
      workerEnv[key] = value;
    }

    if (llmSecretArn) {
      const llmSecret = sm.Secret.fromSecretCompleteArn(this, "LlmSecret", llmSecretArn);
      workerSecrets.OPENROUTER_API_KEY = ecs.Secret.fromSecretsManager(llmSecret, "OPENROUTER_API_KEY");
      if (openaiField) workerSecrets.OPENAI_API_KEY = ecs.Secret.fromSecretsManager(llmSecret, openaiField);
      if (googleField) workerSecrets.GOOGLE_AI_API_KEY = ecs.Secret.fromSecretsManager(llmSecret, googleField);
    }

    workerTask.addContainer("worker", {
      image: ecs.ContainerImage.fromEcrRepository(repoWorker, ctx("workerImageTag") ?? DEFAULT_IMAGE_TAG),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "worker", logGroup }),
      environment: workerEnv,
      secrets: workerSecrets,
      essential: true,
      // SIGTERM → drain(새 리스 중지, 보유분만 완료).
      //
      // ⚠️ **120s 가 Fargate 의 천장이다** — `stopTimeout` 은 Fargate 런치 타입에서 최대 120초이고,
      //    그 뒤엔 SIGKILL 이 온다. 그런데 `worker/main.ts:42` 의 `DRAIN_GRACE_MS` 기본값은
      //    **600s** 였고 태스크 정의는 `ANALYSIS_DRAIN_GRACE_SECONDS` 를 주지 않았다(B8/A6) —
      //    즉 워커는 "10분 동안 정리할 수 있다"고 믿으며 드레인을 시작하는데 실제로는 2분 뒤에
      //    죽었다. 초과분은 SIGKILL 이 리스를 끊고, 그 유닛은 **처음부터** 다시 돌아 LLM 실비를
      //    또 태운다 — 완주 못 한 값을 믿는 것이 아니라 **믿는 값이 거짓**인 것이 문제다.
      //    ⇒ 여기서 값을 내려 **정직화**한다. 아래 `ANALYSIS_DRAIN_GRACE_SECONDS` 와 짝이고,
      //    synth 가 `drainGrace < stopTimeout` 을 강제한다.
      //    (in-flight 가 120s 안에 안 끝나는 경우의 진짜 해법은 Task Scale-In Protection 이다 —
      //     권한은 아래에서 이미 주지만 워커 구현은 이 커밋 밖이다.)
      stopTimeout: Duration.seconds(WORKER_STOP_TIMEOUT_SECONDS),
    });
    // Task Scale-In Protection 은 태스크가 **자기 자신을** 보호하는 API 다. 권한만 먼저 준다.
    // ⚠️ 워커 쪽 구현(in-flight > 0 이면 보호, 만료 20분·5분마다 갱신)은 **이 커밋에 없다** —
    //    스펙 §8.6 의 항목이고 램프 전에 붙인다.
    workerTask.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({ sid: "TaskScaleInProtection", actions: ["ecs:UpdateTaskProtection"], resources: ["*"] }),
    );

    const workerService = new ecs.FargateService(this, "WorkerService", {
      cluster,
      serviceName: `analysis-worker-${stage}`,
      taskDefinition: workerTask,
      // ⚠️ **`desiredCount` 없음 — 의도다**(A1/A2, 위 `workerMin` 주석). CDK 가 이 값을 생략하면
      //    CFN 템플릿에 `DesiredCount` 가 안 실리고, ECS 는 업데이트 때 **현재 값을 유지**한다.
      //    여기에 숫자를 다시 적는 순간 모든 배포가 함대를 그 숫자로 되돌린다.
      securityGroups: [workerSg],
      vpcSubnets: privateSubnets,
      assignPublicIp: false,
      // ⚠️ **0 이 아니다**(B8/A6). 0 이면 ECS 가 롤링 배포에서 **전량을 동시에** 종료할 수 있다 —
      //    무상태 소비자라 큐는 보관되지만, 보관되지 않는 것은 **그 순간 in-flight 였던 LLM 콜**이다
      //    (드레인 예산 안에 못 끝나면 리스가 끊기고 유닛이 처음부터 다시 돈다 = 실비 재지출).
      //    50 이면 한 번에 절반까지만 내려가므로 재처리 폭이 절반으로 준다.
      minHealthyPercent: 50,
      // ⚠️ **200(기본)이 아니다** — 롤링이 desired 를 넘지 않게 한다(2026-09-14). `desiredCount` 는
      //    오토스케일이 소유하므로 배포 순간의 desired 가 그대로 분모다: 16 워커에서 기본 200% 는
      //    old 16 + new 16 = 64 vCPU 로 Fargate vCPU 쿼터(64) 전부를 요구했고, ECS 는
      //    "unable to place a task … limit on the number of vCPUs" 를 반복하다 서킷브레이커로
      //    **두 번 롤백**했다(배포 14 · 재시도). `-c workerMax=8` 축소 배포도 안 먹었다 — max 를
      //    내려도 desired 는 스케일인 쿨다운(300s) 뒤에나 내려가고 롤링은 즉시 시작하기 때문이다.
      //    100 이면 ECS 가 먼저 절반(minHealthyPercent 50)을 멈추고 그 자리에 새 태스크를 올린 뒤
      //    나머지 절반을 간다 — 피크 태스크 수 = desired. 대가는 배포 중 ~5분 처리량 절반과,
      //    STOPPING 태스크도 100% 안에 세므로 `stopTimeout`(120s) 만큼 느린 배포다. 무상태
      //    소비자라 큐는 보관되고, 끊기는 것은 minHealthyPercent 50 이 이미 감수한 in-flight 뿐이다.
      //    ⚠️ **1 vCPU 전환(2026-09-14) 후에도 100 이다** — 태스크 수는 2배(48)지만 태스크당 vCPU 가
      //    절반이라 피크 vCPU 는 48 로 그대로다. 전환 배포 자체도 이 상한 덕에 쿼터 안에서 끝난다:
      //    desired 24(2 vCPU)에서 시작해 ECS 가 먼저 절반(12 × 2 = 24 vCPU)을 비우고 그 자리에 새
      //    1 vCPU 태스크를 올리므로 어느 순간에도 old + new ≤ 48 vCPU 다.
      //    쿼터가 128 로 오르면(요청 CASE_OPENED 2026-09-14) 150 으로 되돌려 배포를 빠르게 할 수
      //    있다 — 48 × 1 × 1.5 = 72 vCPU 로 128 안이다(2 vCPU 였다면 144 로 다시 넘었다).
      maxHealthyPercent: 100,
      // ⚠️ **AZ 리밸런싱은 maximumPercent ≤ 100 을 거부한다**(ECS 검증). 2026-09-14 배포 2c9a9cf 가
      //    "Availability Zone Rebalancing does not support maximumPercent <= 100 %" 로 롤백됐다 —
      //    CDK 2.269 `FargateService` 의 기본값이 ENABLED 라 **미지정이면 켜지고**, CDK 의 synth 검증은
      //    명시적 ENABLED 일 때만 100 을 잡으므로 배포에서야 드러난다. 무상태 큐 소비자에게 AZ 균형은
      //    의미가 없다(AZ 하나가 죽으면 나머지 AZ 가 오토스케일로 메운다) — 롤링 상한 100 이 우선이다.
      availabilityZoneRebalancing: ecs.AvailabilityZoneRebalancing.DISABLED,
      // 기동 실패가 3시간 뒤에 드러나지 않게 한다.
      circuitBreaker: { rollback: true },
    });

    // ---- 오토스케일 ------------------------------------------------------------------
    //
    // 신호는 **큐 깊이 ÷ 러닝 태스크** 다. 큐 깊이만 보면 태스크가 늘어도 지표가 안 내려가
    // 계속 확대한다(측정 lane 이 같은 함정을 배치 게이트로 다뤘다).
    //
    // ⚠️ 게이지는 **구조화 로그에서 뽑는다** — api 가 60초마다 `analysis_lane.gauges` 를 찍고
    //    메트릭 필터가 그것을 CloudWatch 로 올린다(측정 lane 의 로그 메트릭 필터와 같은 방식).
    const NS = "ScopeAnalysis";
    /**
     * `defaultValue` 는 **그 기간에 매칭 로그가 하나도 없을 때** 쓰인다.
     * 값이 0 이어도 되는 게이지에만 준다 — "api 가 로그를 못 냈다" 와 "값이 0 이다" 를 같은
     * 숫자로 만들면 안 되는 축(F2 의 InflightCalls 가 정확히 그 경우)에는 주지 않는다.
     */
    const gaugeFilter = (id: string, metricName: string, jsonField: string, defaultValue?: number) =>
      logGroup.addMetricFilter(id, {
        filterPattern: logs.FilterPattern.exists(`$.${jsonField}`),
        metricNamespace: NS,
        metricName,
        metricValue: `$.${jsonField}`,
        ...(defaultValue === undefined ? {} : { defaultValue }),
      });
    // ⚠️ **`defaultValue` 를 주지 않는다**(C-11). 큐 깊이는 타깃추적의 **분자**다 — api 가 게이지를
    //    못 찍은 기간(api 사망·로그 드라이버 장애·메트릭 필터 오타)에 0 이 채워지면 그 0 이
    //    "큐가 비었다" 로 읽혀 **스케일인**이 돈다. 즉 관측이 끊긴 바로 그 순간 함대를 재운다.
    //    데이터가 없으면 타깃추적 알람은 `INSUFFICIENT_DATA` 가 되고, Application Auto Scaling 은
    //    그 상태에서 **스케일인하지 않는다** — "모른다" 가 "0" 으로 둔갑하지 않는 쪽이 맞다.
    //    `InflightCalls`·`WorkerCount` 가 이미 같은 이유로 defaultValue 를 안 받는다(F2).
    gaugeFilter("QueueDepthFilter", "QueueDepth", "queueDepth");
    gaugeFilter("OldestQueuedFilter", "OldestQueuedAgeSeconds", "oldestQueuedAgeSeconds", 0);
    // F2 — 이 필드는 **초판 게이지 로그에 존재하지 않았다**: 필터가 영영 매칭되지 않았고
    // defaultValue 0 이 "상한을 하나도 안 쓴다" 를 계속 내보냈다. 이제 api 가 워커 원장
    // (`analysis_worker_gauges`)을 읽어 찍는다. **미상이면 필드를 안 내므로 defaultValue 도 없다** —
    // 데이터 없음이 0 으로 둔갑하면 램프(300 → 640)가 근거 없이 다음 단계로 간다.
    gaugeFilter("InflightCallsFilter", "InflightCalls", "inflightCalls");
    gaugeFilter("WorkerCountFilter", "WorkerCount", "workerCount");
    // D13 — 예열 하한 **관측**. ⚠️ 이 게이지에 붙어 있던 스텝 정책 2개는 제거됐다(A4/B6, 아래
    // "예열" 주석). 값은 여전히 앱이 계산하고 `/metrics`·계약에 실리므로 필터는 남긴다 —
    // 램프에서 "웨이브가 실제로 열렸는가" 를 보는 축이고, 정책을 다시 붙일지의 근거가 된다.
    gaugeFilter("PrewarmFilter", "PrewarmDesiredWorkers", "prewarmDesiredWorkers", 0);
    // 0 이 정상. >0 이면 **이중 LLM 지출이 진행 중**이다.
    gaugeFilter("DuplicateFilter", "DuplicateCompletions1d", "duplicateCompletions1d", 0);
    // F14 — 끝난 실패와 안 끝나는 대기. 큐 깊이 축에서는 둘 다 안 보인다.
    gaugeFilter("FailedTerminalFilter", "FailedTerminal1d", "failedTerminal1d", 0);
    gaugeFilter("DeferredBacklogFilter", "DeferredBacklog", "deferredBacklog", 0);
    gaugeFilter("DeferredStaleFilter", "DeferredStale", "deferredStale", 0);
    // 직결 standby 발화 건수 — **0 이 정상**이고 >0 이면 OpenRouter 가 못 받고 있다는 뜻이다.
    // ⚠️ 게이지가 아니라 **이벤트 카운트**다: 워커가 standby 를 고른 콜마다
    //    `analysis_lane.pool_standby { standbyCall: 1 }` 를 찍고 여기서 합산한다.
    //    `defaultValue: 0` 을 주는 이유는 `DuplicateCompletions1d` 와 같다 — 사건이 없으면
    //    로그 줄 자체가 없으므로, 0 을 안 채우면 **정상 구간이 "데이터 없음"** 이 되어
    //    이 축으로는 아무것도 못 본다(스케일 분모처럼 0 이 위험한 축이 아니다).
    gaugeFilter("PoolStandbyFilter", "PoolStandbyCalls", "standbyCall", 0);
    // WU6 F4 — 스탠스 패스 관측. **사건 카운트**다(게이지가 아니다) — 워커가 게이트 켜진 턴마다
    // `analysis_lane.stance_observed` 를 찍고 여기서 합산한다.
    //
    // ⚠️ 세 축을 **따로** 올린다. 비율의 분모가 있어야 "실패가 늘었다" 와 "물량이 늘었다" 가
    //    구분된다: `StanceTurns`(켜진 턴 = 분모) · `StanceFailedTurns`(패스 실패) ·
    //    `StanceFailedCalls`(업스트림 콜 실패). 분모 없이 실패 수만 보면 램프 중에 항상 빨갛다.
    //    `defaultValue: 0` 은 `PoolStandbyCalls` 와 같은 이유 — 사건이 없으면 로그 줄 자체가
    //    없으므로 0 을 안 채우면 **정상 구간이 "데이터 없음"** 이 된다(스케일 분모가 아니라 안전).
    gaugeFilter("StanceTurnsFilter", "StanceTurns", "stanceEnabled", 0);
    gaugeFilter("StanceFailedTurnsFilter", "StanceFailedTurns", "stanceFailed", 0);
    gaugeFilter("StanceFailedCallsFilter", "StanceFailedCalls", "stanceCallsFailed", 0);
    // PR-L1 — 감성 V2 **섀도 병행** 패스 관측. 스탠스와 같은 구조다(사건 카운트 · 분모 포함 ·
    // defaultValue 0). 워커가 게이트 켜진 턴마다 `analysis_lane.semantics_v2_shadow_observed` 를
    // 찍고 여기서 합산한다.
    //
    // ⚠️ **알람을 만들지 않는다**(룰 alert-routing: 목적지를 늘리지 않는다). 섀도 실패는 라이브
    //    장애가 아니라 코드 경로 결손이므로 목적지는 GitHub Issue 이고, 여기는 그 판단의 근거가
    //    되는 **지표**만 남긴다.
    // ⚠️ 필드 이름은 `worker/main.ts` `semanticsV2ShadowObservation` 이 찍는 것과 같아야 한다 —
    //    갈리면 필터가 영영 매칭되지 않고 지표가 조용히 0 으로 굳는다(F2 전례).
    gaugeFilter("SemanticsShadowTurnsFilter", "SemanticsShadowTurns", "semanticsShadowEnabled", 0);
    gaugeFilter("SemanticsShadowFailedTurnsFilter", "SemanticsShadowFailedTurns", "semanticsShadowFailed", 0);
    gaugeFilter("SemanticsShadowFailedCallsFilter", "SemanticsShadowFailedCalls", "semanticsShadowCallsFailed", 0);

    const queueDepth = new cw.Metric({ namespace: NS, metricName: "QueueDepth", statistic: "Maximum", period: Duration.minutes(1) });
    /**
     * 러닝 태스크 수 = 타깃추적 수식의 **분모**.
     *
     * ⚠️ **네임스페이스는 `ECS/ContainerInsights` 다 — `AWS/ECS` 가 아니다**(B1). 초판은
     *    `AWS/ECS` + `RunningTaskCount` 였는데 **그 조합은 존재하지 않는다.** 2026-09-13 실측:
     *      list-metrics --namespace AWS/ECS             → CPUUtilization · MemoryUtilization · LiveTaskCount
     *      list-metrics --namespace ECS/ContainerInsights --metric-name RunningTaskCount
     *                                                   → ClusterName=scope-analysis-stage,
     *                                                     ServiceName=analysis-worker-stage  ✅
     *    존재하지 않는 메트릭은 **에러가 아니라 침묵**이다: 수식의 `tasks` 가 영영 비고, 그래서
     *    타깃추적 알람 2개가 생성(2026-09-12 21:57) 이후 **한 번도 전이하지 않은 채**
     *    `INSUFFICIENT_DATA` 로 서 있었다(같은 날 `describe-alarms` 실측). 즉 **오토스케일이
     *    존재하지만 작동한 적이 없다** — 배포도 synth 도 통과했고 알람만 조용히 굶었다.
     *    Container Insights 는 클러스터에 켜져 있다(`containerInsights: enabled`, 위 cluster 정의).
     *
     * ⚠️ `AWS/ECS` 의 `LiveTaskCount` 로 바꾸지 않은 이유 — 그건 **실재하는 대안이다**(2026-09-13
     *    실측: 이 서비스 차원으로 존재하고 Container Insights 와 무관하게 나온다). 기각 근거는
     *    가용성이 아니라 **의미**다: PENDING 까지 함께 세므로(= "떠 있는 것") 분모로 쓰면 아직
     *    리스를 못 잡는 태스크가 처리량으로 계산돼 스케일아웃이 늦어진다. 분모는 **실제로 리스를
     *    잡는 수**여야 한다.
     *    ⇒ 대신 `ECS/ContainerInsights` 는 **클러스터 설정에 의존한다**. 누가 Container Insights 를
     *      끄면 이 메트릭이 사라지고 B1 이 그대로 재발한다 — `tests/deploy-context.test.ts` 가
     *      클러스터의 그 설정까지 함께 단언하는 이유다.
     */
    const runningTasks = new cw.Metric({
      namespace: "ECS/ContainerInsights",
      metricName: "RunningTaskCount",
      dimensionsMap: { ClusterName: cluster.clusterName, ServiceName: workerService.serviceName },
      statistic: "Maximum",
      period: Duration.minutes(1),
    });
    // 하한은 `workerMin`(기본 1). **0 이 아니다** — 위 `workerMin` 주석 참조.
    const scaling = workerService.autoScaleTaskCount({ minCapacity: workerMin, maxCapacity: workerMax });

    // ⚠️ **L1 이스케이프 해치를 쓴다.** CDK 의 `scaleToTrackCustomMetric` 은 단일 메트릭만 받고
    //    MathExpression 을 거부한다(`DirectMetricsSupportedTargetTracking`). Application Auto
    //    Scaling 자체는 수식 메트릭 타깃추적을 지원하므로, L2 의 제약 때문에 **설계를 바꾸지 않고**
    //    L1 으로 같은 정책을 낸다. 대안(수식 없이 큐 깊이만 타깃추적)은 태스크가 늘어도 지표가
    //    안 내려가 계속 확대하는 구조라 기각이다.
    const targetTracking = new appscaling.CfnScalingPolicy(this, "QueueDepthPerTaskPolicy", {
      policyName: `scope-analysis-worker-depth-per-task-${stage}`,
      policyType: "TargetTrackingScaling",
      serviceNamespace: "ecs",
      scalableDimension: "ecs:service:DesiredCount",
      resourceId: `service/${cluster.clusterName}/${workerService.serviceName}`,
      targetTrackingScalingPolicyConfiguration: {
        targetValue: queueDepthPerTaskTarget,
        scaleOutCooldown: 60,
        // 스케일인이 느린 것은 의도다 — 유닛당 최대 1,200s lease 를 도는 중일 수 있다.
        scaleInCooldown: 300,
        customizedMetricSpecification: {
          metrics: [
            {
              id: "depth",
              returnData: false,
              metricStat: {
                metric: { namespace: queueDepth.namespace, metricName: queueDepth.metricName },
                stat: "Maximum",
              },
            },
            {
              id: "tasks",
              returnData: false,
              metricStat: {
                metric: {
                  namespace: runningTasks.namespace,
                  metricName: runningTasks.metricName,
                  dimensions: [
                    { name: "ClusterName", value: cluster.clusterName },
                    { name: "ServiceName", value: workerService.serviceName },
                  ],
                },
                stat: "Maximum",
              },
            },
            // 태스크가 0 이면 나눗셈이 죽는다 — `IF(tasks > 0, tasks, 1)` 이 그 바닥이다.
            //
            // ⚠️ **`MAX([tasks, 1])` 로 쓰지 마라 — synth 는 통과하고 배포가 죽는다.**
            //    2026-09-12 첫 배포 실측: `CREATE_FAILED QueueDepthPerTaskPolicy` —
            //      Error in expression 'ratio': Unsupported operand type(s) for MAX:
            //      '[Array[TimeSeries, Scalar]]'
            //    CloudWatch 의 `MAX` 는 시계열 하나의 **시간축 집계**이고, 시계열과 스칼라를
            //    섞은 배열의 원소별 최대가 아니다. 그리고 이 실패는 스택 전체를 롤백시키는데
            //    ECR·RDS 가 RETAIN 이라 **고아가 남아 재배포를 막는다**(README "배포" 절).
            //    대안은 라이브 `put-metric-alarm`(타깃추적이 쓰는 같은 검증기)으로 확인했다:
            //      FAIL  depth / MAX([tasks, 1])
            //      PASS  depth / IF(tasks > 0, tasks, 1)      ← 채택(의미 동일·가장 짧다)
            //      PASS  depth / MAX([tasks, FILL(METRICS(), 1)])
            //      PASS  IF(tasks > 0, depth / tasks, depth)
            { id: "ratio", returnData: true, expression: "depth / IF(tasks > 0, tasks, 1)" },
          ],
        },
      },
    });
    targetTracking.node.addDependency(scaling);

    // ---- 예열(D13) — **스텝 정책 2개를 제거했다** (A4/B6) ----------------------------
    //
    // 있던 것: `scaleOnMetric("PrewarmOnMeasurementWave")` + `EXACT_CAPACITY`, 스텝 둘
    //   ① `{ upper: 0, change: 0 }`  → CDK 가 **Lower 알람**(`PrewarmDesiredWorkers <= 0`)으로 낸다
    //   ② `{ lower: 1, change: 2 }`  → **Upper 알람**(`>= 1`)
    //
    // 라이브에서 그 둘이 한 방향으로만 섰다(2026-09-13 실측):
    //   · `ANALYSIS_MEASUREMENT_CAPACITY_URL` 이 **미배선**이다(`measurementCapacityUrl` context
    //     없음 → env 미주입). `worker/coordination.ts` 는 URL 이 없으면 샘플을 `null` 로 두고
    //     `computePrewarmWorkers` 가 **항상 0** 을 낸다.
    //   · ⇒ Upper 알람은 영구 `OK`(2026-09-13T00:02 이후 그대로), Lower 알람은 영구 `ALARM`
    //     (00:03 이후 그대로). `describe-alarms` 실측.
    //   · ⇒ Lower 정책(EXACT_CAPACITY **0**)이 계속 발동한다. `describe-scaling-activities`:
    //     `12:48:27 Setting desired count to 0. Cause: … LowerAlarm … in state ALARM triggered
    //     policy … LowerPolicy`. **타깃추적이 올린 용량을 이 정책이 되돌린다.**
    //
    // 즉 "예열(깨우기)" 으로 만든 것이 실제로는 **재우는 정책 하나**로만 작동했다. 배선이 없는
    // 신호에 `EXACT_CAPACITY 0` 을 매단 것이 근본 원인이다 — 미배선은 "0" 이 아니라 "모름" 인데,
    // 스텝 정책에는 "모름" 을 표현할 자리가 없다(알람은 OK/ALARM 둘 중 하나로만 선다).
    //
    // ── 무엇으로 대체했나 (두 안 중 택일 — PR 본문에 근거)
    //   (기각) `QueueDepth >= 1 AND WorkerCount == 0` 을 잡는 "깨우기" 스텝 정책.
    //          수식 알람이 필요한데 `scaleOnMetric` 은 단일 메트릭만 받아 또 L1 이스케이프
    //          해치가 되고, **같은 실패 모드**(신호가 굶으면 알람이 한쪽으로 굳는다)를 다시
    //          들인다. 게다가 그 정책이 지키려는 것은 결국 "하한 1" 이다.
    //   (채택) **스케일러블 타깃 `minCapacity = workerMin`(기본 1).** 알람도 정책도 없으므로
    //          굶을 신호가 없다. 큐에 티켓이 있으면 상주 워커 1대가 즉시 집고, 나머지는
    //          타깃추적이 올린다. 재우는 정책은 **없다** — 정지는 사람이 명시한다.
    //   비용: 상주 1대 = 2 vCPU·8GB Fargate ARM ≈ **$0.11/시간 (~$80/월)**. 그 대가로 얻는 것이
    //   "큐가 있는데 아무도 안 깨어난다" 의 구조적 제거다.
    //
    // 예열 게이지 자체(`PrewarmDesiredWorkers`)와 앱 쪽 계산은 **그대로 둔다** — 관측은 유효하고,
    // `measurementCapacityUrl` 이 배선된 뒤 값이 실제로 0↔양수를 오가는 것이 확인되면 그때
    // 스케일**아웃 전용** 정책(하한을 올리기만 하는 쪽)으로 다시 판단한다.

    // ---- 알람 ------------------------------------------------------------------------
    // ⚠️ **목적지를 여기서 정하지 않는다.** 워크스페이스 룰 alert-routing: 목적지는 둘뿐이고
    //    (코드·빌드 = GitHub Issue / 라이브 = 잔디), **토픽만 만들고 구독하지 않는 것을 금지**한다
    //    (2026-08-15 실측 유령 토픽 16개). 배선은 도달을 실증할 수 있을 때 한다.
    //    그때까지 이 알람들은 액션 없는 **지표**다.
    //    ⚠️ 다만 **미정으로 남겨 두지도 않는다**: 목적지는 **램프 전(스펙 §9 단계 8) 에 확정**하고
    //    강제 전이로 도달을 실증한다(룰 alert-routing 4). 기한과 담당은 README "알람 목적지" 참조.
    new cw.Alarm(this, "DuplicateCompletionsAlarm", {
      alarmName: `scope-analysis-duplicate-completions-${stage}`,
      alarmDescription:
        "같은 턴이 오늘 두 번 이상 완주했다 = 이중 LLM 지출 진행 중. 0 이 정상. " +
        "각 티켓은 정상 완주라 사람 눈에도 다른 게이지에도 안 걸린다 — 비용에서만 뒤늦게 보인다.",
      metric: new cw.Metric({ namespace: NS, metricName: "DuplicateCompletions1d", statistic: "Maximum", period: Duration.minutes(5) }),
      threshold: 0,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
    });
    new cw.Alarm(this, "QueueStaleAlarm", {
      alarmName: `scope-analysis-queue-stale-${stage}`,
      alarmDescription: "가장 오래된 대기 티켓이 30분을 넘겼다 = 소비가 멈췄거나 함대가 안 깨어난다.",
      metric: new cw.Metric({ namespace: NS, metricName: "OldestQueuedAgeSeconds", statistic: "Maximum", period: Duration.minutes(5) }),
      threshold: 1800,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 2,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
    });

    // F14 — 끝난 실패. 큐 깊이는 이것을 **빼고** 세므로 큐만 보면 "건강해졌다" 로 읽힌다.
    // 하루 terminal failed 가 임계를 넘었다 = 그만큼의 LLM 실비가 결과 없이 나갔다는 뜻이다.
    new cw.Alarm(this, "TerminalFailuresAlarm", {
      alarmName: `scope-analysis-terminal-failures-${stage}`,
      alarmDescription:
        "오늘 terminal failed 로 닫힌 티켓이 임계를 넘었다 = 결과 없이 태운 LLM 실비. " +
        "queueDepth 에서는 이미 빠져 있어 큐 게이지로는 보이지 않는다.",
      metric: new cw.Metric({ namespace: NS, metricName: "FailedTerminal1d", statistic: "Maximum", period: Duration.minutes(5) }),
      threshold: Number(ctx("terminalFailureThreshold") ?? 50),
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 2,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
    });
    // F14 — 안 끝나는 대기. 측정 lane 0013 의 흉터: `deferred(deadline)` 4,260건이 **아무 게이지에도
    // 안 잡힌 채** 쌓여 있었다. 2단계 리퍼가 멈추면(리더 클레임 실패·워커 0) 같은 형태가 재발한다.
    new cw.Alarm(this, "DeferredResidueAlarm", {
      alarmName: `scope-analysis-deferred-residue-${stage}`,
      alarmDescription:
        "오래 움직이지 않은 deferred 티켓이 있다 = 리퍼가 못 걷어내는 잔존. 0 이 정상. " +
        "측정 lane 0013(deferred(deadline) 4,260건 영구 적체)의 같은 지문이다.",
      metric: new cw.Metric({ namespace: NS, metricName: "DeferredStale", statistic: "Maximum", period: Duration.minutes(5) }),
      threshold: 0,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 2,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
    });

    // ---- 출력 ------------------------------------------------------------------------
    new CfnOutput(this, "TicketApiEndpoint", { value: `https://${nlb.loadBalancerDnsName}:8443` });
    new CfnOutput(this, "RdsEndpoint", { value: db.dbInstanceEndpointAddress });
    new CfnOutput(this, "ApiRepositoryUri", { value: repoApi.repositoryUri });
    new CfnOutput(this, "WorkerRepositoryUri", { value: repoWorker.repositoryUri });
    new CfnOutput(this, "WorkerVcpuAtMax", {
      value: String((workerMax * WORKER_CPU) / 1024),
      description:
        "worker max × 태스크 vCPU(WORKER_CPU/1024). 2026-09-14: **24 × 2 → 48 × 1** — 태스크 수는 2배지만 " +
        "합계는 48 vCPU 로 **같다**(워커가 단일 Node 스레드라 두 번째 vCPU 가 놀았다). Fargate On-Demand " +
        "vCPU 쿼터(L-3032A538) = **64**, 코어 Fargate 동거인 9.0 + api 0.5 → 정상 상태 57.5(여유 6.5). " +
        "코어 measurement-worker 피크(10태스크 = 20 vCPU)와 겹치면 75.5 로 쿼터를 넘어 측정 버스트 배치가 " +
        "지연된다 — 128 증량 요청 CASE_OPENED(2026-09-14). 롤링은 maxHealthyPercent 100 이라 desired 를 " +
        "넘지 않는다. 함대 최대치의 RDS 연결은 48 × 5 + api 10 = 250 / max_connections 400.",
    });
  }
}
