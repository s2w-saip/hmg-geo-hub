// 설정 — env 접두사 `ANALYSIS_`. 측정 lane `app/settings.py`(MEASURE_) 와 같은 자리.
//
// 원칙(측정과 동일): **시크릿 값은 env 로 받지 않는다 — 참조(ARN)만.** DSN 은 예외이나 그것도
// 태스크 정의가 Secrets Manager 에서 주입하며, 코드가 값을 출력하는 경로를 두지 않는다.
// ⚠️ 시크릿을 argv 로 넘기지 않는다 — `ps` 는 출력 마스킹을 지나간다(워크스페이스 룰
//    secrets-handling 6, 2026-08-06 실증).
import { hostname } from "node:os";

// ⚠️ 어휘·파서의 정본은 `worker/cache-bust.ts` 다(적용하는 쪽이 소유한다). 여기서 다시 파싱하면
//    두 벌이 조용히 갈라져 "설정은 받았는데 아무것도 안 하는 모드" 가 생긴다 — 실패가 아니라 오답.
import { loadCacheBustConfig, type CacheBustMode } from "../worker/cache-bust.ts";

function str(key: string, fallback: string): string {
  const v = process.env[key];
  return v === undefined || v === "" ? fallback : v;
}
function optStr(key: string): string | null {
  const v = process.env[key];
  return v === undefined || v === "" ? null : v;
}
function num(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${key} must be numeric, got ${JSON.stringify(v)}`);
  return n;
}
function int(key: string, fallback: number): number {
  const n = num(key, fallback);
  if (!Number.isInteger(n)) throw new Error(`${key} must be an integer, got ${n}`);
  return n;
}
function bool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}
/**
 * **설정돼 있으면 비어 있을 수 없는 문자열.** `str()` 은 `""` 를 미설정과 같게 보는데, 그 관용이
 * "잘못 접히면 오답을 내는" 값에서는 결함이다.
 *
 * ⚠️ 실제 경로(2026-09-12 지적 H3): CDK `-c engine=` → context `""` → 태스크 정의
 *    `ANALYSIS_ENGINE=""` → 여기서 `"stub"` 으로 접힘 → **워커가 조용히 스텁으로 돈다.**
 *    코어 플래그를 shadow 로 켜면 B 팔이 골격 응답을 내고 비교가 "분석이 달라졌다"로 읽힌다 —
 *    실패가 아니라 **오답**이라 알람이 안 운다. 그래서 접지 않고 **기동을 세운다**(module 로드
 *    시점 throw = 프로세스 비정상 종료). CDK 쪽 짝은 `infra/lib/analysis-stack.ts` 의 synth 가드다.
 */
function strStrict(key: string, fallback: string): string {
  const v = process.env[key];
  if (v === undefined) return fallback;
  const t = v.trim();
  if (t === "") {
    throw new Error(
      `${key} is set but blank — set it explicitly or unset it ` +
        `(blank would silently fold to ${JSON.stringify(fallback)})`,
    );
  }
  return t;
}
/**
 * **미설정이 0 이 아니라 `null` 인 정수 env.** 예산 가드처럼 "모르면 켜면 안 되는" 값에 쓴다 —
 * 0 으로 폴백하면 쿼터 0 = 워커 0 이 돼서, 값을 안 채운 것이 함대를 통째로 끄는 결과가 된다.
 * `alt` 는 접두사 없는 별칭(운영자가 계정 쿼터를 그 이름으로 주입하는 경우).
 */
function optInt(key: string, alt?: string): number | null {
  const raw = process.env[key] ?? (alt ? process.env[alt] : undefined);
  if (raw === undefined || raw === "") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${key} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  return n;
}

/**
 * DSN 조립 — **부품이 우선이다.**
 *
 * ECS 시크릿은 Secrets Manager JSON 의 **키 하나**만 env 로 주입할 수 있다. RDS 가 생성하는
 * 자격증명 JSON 에는 완성된 DSN 키가 없으므로(username·password·host·port·dbname 뿐), 통짜
 * `ANALYSIS_STORE_DSN` 을 시크릿으로 주입하려면 **누군가 평문 DSN 을 손으로 만들어 넣어야** 한다.
 * 그 순간 비밀번호가 사람 손과 툴 출력을 지나간다(워크스페이스 룰 secrets-handling).
 *
 * 그래서 비밀번호만 시크릿으로 받고 나머지는 평범한 env 로 받아 여기서 조립한다.
 * 로컬·테스트 편의를 위해 통짜 DSN 도 계속 받는다(있으면 그쪽이 이긴다).
 */
function resolveStoreDsn(): string | null {
  const whole = optStr("ANALYSIS_STORE_DSN");
  if (whole) return whole;
  const host = optStr("ANALYSIS_DB_HOST");
  const password = optStr("ANALYSIS_DB_PASSWORD");
  if (!host || !password) return null;
  const user = str("ANALYSIS_DB_USER", "analysis");
  const port = str("ANALYSIS_DB_PORT", "5432");
  const name = str("ANALYSIS_DB_NAME", "analysis");
  const sslmode = str("ANALYSIS_DB_SSLMODE", "require");
  // ⚠️ 값을 로그로 내지 않는다. 이 함수의 반환값은 드라이버로만 간다.
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${name}?sslmode=${sslmode}`;
}

/**
 * 워커 식별자 기본값 — **태스크마다 달라야 한다.**
 *
 * ⚠️ 상수 `"worker"` 였다. 태스크 정의가 이 env 를 주입하지 않으므로 함대 16대가 **전부 같은
 *    id** 로 돌았다. `leased_by` 만 쓰던 동안에는 디버깅이 불편한 정도였지만, 워커 게이지 원장
 *    (`analysis_worker_gauges`, 0005)은 `worker_id` 가 PK 라 16대가 **행 하나를 서로 덮어쓴다**:
 *    `inflightCalls` 가 마지막으로 쓴 한 대의 값이 되고 `workerCount` 가 영원히 1 이다.
 *    Fargate awsvpc 의 hostname 은 태스크 ENI 기준이라 태스크마다 다르다.
 */
function defaultWorkerId(): string {
  try {
    const h = hostname();
    return h && h !== "localhost" ? `worker-${h}` : "worker";
  } catch {
    return "worker";
  }
}

export interface Settings {
  stage: string;
  port: number;
  storeDsn: string | null;
  /**
   * Postgres 풀 크기. **워커 전용 배선**이다 — 스택이 `workerEnv` 로만 5 를 주고 api 는
   * `app/main.ts` 의 리터럴 10 으로 돈다. 함대 × 이 값 + api ≤ RDS 연결 예산(synth 가 강제).
   */
  dbPoolMax: number;
  workerId: string;
  laneRevision: string;

  // ---- 리스·재시도 (스펙 §8.1) ----
  /** 턴 입도(D1)라 1턴 최악 p95 ~256s 에 4배 이상 여유. 초판의 3,600s 는 query_run 입도 전제였다. */
  leaseTtlSeconds: number;
  leaseHeartbeatSeconds: number;
  /** 누적 상한을 넘으면 갱신을 멈춰 **포이즌 유닛이 워커를 영원히 잡지 못하게** 한다. */
  leaseCumulativeCapSeconds: number;
  /**
   * lane 안의 lease 재시도 상한. 측정은 13(만성 한도)이지만 분석 재시도는 매번 **LLM 실비**다.
   * 코어 아웃박스 원장의 `attempt ≤ 3`(D5)과 **같은 숫자·다른 층**이다 — 따로 센다.
   */
  maxAttempts: number;
  /** 픽 대상에서 제외할 최소 잔여 마감(초). 곧 마감할 티켓에 슬롯을 쓰지 않는다. */
  minRunwaySeconds: number;
  /** expire_deadlines 스탬프 후 terminal GC 까지의 유예(초). 측정 0013 의 2단계 리퍼 동형. */
  deadlineGraceSeconds: number;
  reapIntervalSeconds: number;
  /**
   * 스윕 1회의 행 상한(B7). 리퍼는 워커 poll 루프 안에서 `await` 되므로 상한이 없으면 큰 적체
   * 한 번이 그 워커의 리스를 통째로 멈춘다. 남은 것은 다음 틱이 가져간다.
   */
  sweepBatch: number;

  // ---- 보존·용량 회수 (B9 · D6) ----
  /** 터미널 티켓(`completed`/`failed`/`cancelled`)을 `finished_at` 기준 며칠 뒤 지우는가. */
  ticketRetentionDays: number;
  /** 보존 배치 1회의 티켓 수 상한. 스윕 상한과 같은 이유로 둔다. */
  retentionBatch: number;
  /** 보존·2차 캐시 절단을 도는 주기(초). 리퍼(15s)보다 훨씬 길다 — 급할 일이 아니다. */
  maintenanceIntervalSeconds: number;
  /** `analysis_contexts` 2차 캐시에 남길 행 수(LRU). 스냅샷 1행 = 14.4 MB 실측. */
  contextTableKeepRows: number;
  /** 한 주기에 지우는 2차 캐시 행 수 상한. */
  contextTableTrimBatch: number;

  // ---- 동시성 (스펙 §8.2) ----
  /** **정본 단위 = in-flight LLM 콜.** 램프 300 → 430 → 525 → 640. */
  llmTotalConcurrency: number;
  /** 턴 유닛(=티켓) 동시성. 40/task × 16 task = 640 콜이 설계 짝(§8.2). */
  unitConcurrency: number;
  /** 함대 max. **워커 수 조회 실패 시 이 값으로 나눈다**(보수적으로 작은 슬롯 — A11). */
  workerMaxCount: number;
  /** 슬롯 대기 상한. 넘으면 typed 실패(`capacity`)이지 무한 대기가 아니다. */
  llmSlotAcquireTimeoutMs: number;
  reservedManualUnits: number;

  // ---- 콜백 ----
  callbackMaxAttempts: number;
  callbackTimeoutSeconds: number;

  // ---- 코어 내부 인증 (운영 결정 2026-09-12 · 코어 G4 #645) ----
  /**
   * 토큰이 어느 시크릿에서 왔는지의 **참조**. 값이 아니다 — 진단·기동 단언용이다.
   * 설정돼 있는데 값이 안 들어왔으면(주입 실패) 기동을 세운다: 조용히 토큰 없이 돌면
   * 코어가 404 로 숨기고(`x-scope-internal-token` 불일치는 라우트 은닉) 아웃박스가
   * 5회 재시도 후 멈춘다 — 원인이 배선 누락인데 "코어가 죽었다"로 읽힌다.
   */
  internalTokenSecretArn: string | null;
  /**
   * lane → 코어 **콜백(doorbell)** 토큰. 코어 `POST /api/internal/analysis-callback` 이
   * `ANALYSIS_LANE_CALLBACK_SECRET` 과 timing-safe 비교한다(불일치는 404).
   * ⚠️ 값은 ECS `secrets:` 로 주입된다 — 코드·리포·툴출력에 없다(룰 secrets-handling 1).
   */
  internalCallbackToken: string | null;
  /**
   * lane → 코어 **컨텍스트 스냅샷 GET** 토큰. 코어
   * `GET /api/internal/analysis-context/…` 이 `ANALYSIS_LANE_CONTEXT_SECRET` 과 비교한다.
   * 콜백 토큰과 **따로 둔다** — 코어가 두 라우트에 서로 다른 env 를 쓰므로(하나로 합치는
   * 것은 코어 쪽 결정이고, 여기서 합쳐 두면 값이 달라진 순간 조용히 404 가 된다).
   */
  internalContextToken: string | null;

  // ---- 컨텍스트 캐시 (스펙 §4.5 · §14-1) ----
  /**
   * 코어 컨텍스트 GET 의 상한. **20s → 60s**(2026-09-13 라이브 실측). 응답은 JSON 14.4 MB
   * (catalog 8.4 MB)이고, 인코딩에 따라 **brotli 37.5s / gzip 3.0s / identity 3.2s** 다.
   * 20s 는 brotli 단건조차 못 덮어 `TimeoutError` 93건/5분을 냈다.
   * 근본 수정 둘은 `worker/context-cache.ts` 에 있고(① `accept-encoding: gzip` 명시 ②
   * single-flight) 이 상한은 **세 번째 방어선**이다 — 카탈로그가 더 커지면 다시 얇아진다.
   */
  contextFetchTimeoutMs: number;
  /** ⚠️ 스냅샷 원본 바이트 실측은 14.4 MB(§14-1 해소). 기본 256 MB 는 그 크기 ~18개분이다. */
  contextCacheMaxEntries: number;
  contextCacheMaxBytes: number;
  /** lane PG 2차 캐시(0004) 사용 여부. 끄면 프로세스 LRU 만 남는다. */
  contextDbCacheEnabled: boolean;

  // ---- 전역 HTTP 디스패처 (D-8) ----
  /**
   * 유휴 소켓 보유 시간(ms). 기본 4,000 은 Node 내장 undici 기본값과 **같은 값**이다 — 기본
   * 상태에서 동작을 바꾸지 않고 값을 명시·관측 가능하게 만드는 것이 1차 목적이다.
   * 업스트림이 먼저 끊는 시간보다 짧게 두어야 죽은 소켓을 다시 쓰지 않는다.
   */
  httpKeepAliveMs: number;
  /**
   * 서버의 `keep-alive: timeout=N` 광고를 받아들이는 상한(ms). ⚠️ 내장 기본값은 **600,000**
   * 이라 게이트웨이가 긴 값을 광고하면 유휴 소켓이 10분까지 남는다.
   */
  httpKeepAliveMaxMs: number;
  /**
   * 오리진당 커넥션 상한. **`null` = 무제한(현행 동작)이 기본이다.**
   * ⚠️ 유한 값을 콜 세마포어(최대 640)보다 작게 주면 lane 처리량이 조용히 여기서 막힌다.
   */
  httpConnections: number | null;

  // ---- LLM 프롬프트 캐시 무효화 (운영 결정 2026-09-13 · 게이트③) ----
  /**
   * **게이트③ 을 무캐시 상태에서 재기 위한 스위치.** 기본 `false` = 라이브 동작 무변경.
   *
   * 실측 배경과 수단 선택의 근거는 `worker/cache-bust.ts` 머리말이 정본이다. 요약:
   * lane shadow 가 인라인 직후에 돌아 **캐시 히트 이득**(실비 −55%·일치 0.978)을 받았고,
   * 그 0.987 은 품질 증거가 아니다. 컷오버 후 lane 은 혼자 도므로 그 이득이 없다.
   *
   * ⚠️ **돈을 쓰는 스위치다**(캐시 할인 소멸 = 입력 토큰 정가). 상시 운용값이 아니라
   *    게이트 측정 창에서만 켠다.
   */
  llmCacheBust: boolean;
  /** 무효화 수단(`nonce` 기본 · `params` · `both`). `llmCacheBust=false` 면 의미가 없다. */
  llmCacheBustMode: CacheBustMode;

  // ---- 엔진 ----
  /** `stub` = G3-1 골격. `core` = G3-2 가 꽂을 `@scope/analysis-core` 실행기. */
  engine: string;

  // ---- D13 측정 lane 조율 ----
  /** 측정 lane `/v1/capacity` (mTLS). 미설정이면 조율 샘플은 null 이고 예열은 큐 깊이만 본다. */
  measurementCapacityUrl: string | null;
  measurementSampleIntervalMs: number;
  measurementSampleTimeoutMs: number;
  /** 측정 큐가 이 깊이를 넘으면 웨이브가 열렸다고 보고 분석 함대를 예열한다. */
  prewarmMeasurementQueueThreshold: number;
  /** 측정 lane 의 가장 오래된 대기가 이 나이를 넘으면 큐 깊이와 무관하게 웨이브로 본다(F7). */
  prewarmMeasurementOldestAgeSeconds: number;
  prewarmWorkers: number;
  /**
   * **Fargate On-Demand vCPU 서비스 쿼터**(실값). `null` = 미확인 → 예산 가드 **비활성**.
   * ⚠️ 0 으로 폴백하지 않는다 — 그러면 "쿼터를 모른다"가 "함대 0"이 된다.
   */
  fargateVcpuQuota: number | null;
  vcpuReserve: number;
  /** 같은 Fargate 쿼터를 쓰는 **측정 lane 태스크 수**. EC2/ASG 몫은 이 축에 들어가지 않는다. */
  measurementFargateDesired: number;
  /** 측정 Fargate 태스크 1개의 vCPU. */
  measurementFargateTaskVcpu: number;
  workerVcpu: number;
  /** analysis-api 자신의 몫(상시 1 태스크). 예산에서 빼지 않으면 쿼터를 그만큼 넘긴다. */
  apiVcpu: number;

  // ---- 게이지 (F2 · F14) ----
  /** 워커가 `analysis_worker_gauges` 에 자기 in-flight 콜 수를 적는 주기. */
  workerGaugeIntervalSeconds: number;
  /** 그 행을 api 가 **신선하다**고 보는 창. 넘으면 합산에서 빼고 "미상"으로 표면화한다. */
  workerGaugeFreshnessSeconds: number;
  /** `deferred` 가 이 시간 넘게 안 움직이면 잔존으로 센다(측정 0013 흉터의 지문). */
  deferredStaleAfterSeconds: number;
}

export function loadSettings(): Settings {
  // 파서는 `worker/cache-bust.ts` 하나다 — 모르는 모드 값이면 여기서 던진다(기동 정지).
  const cacheBust = loadCacheBustConfig();
  return {
    stage: str("ANALYSIS_STAGE", "dev"),
    port: int("ANALYSIS_PORT", 8080),
    storeDsn: resolveStoreDsn(),
    // 기본 10 = 배선 전 하드코딩 값. 라이브(워커)는 스택이 주는 5 로 돈다.
    dbPoolMax: int("ANALYSIS_DB_POOL_MAX", 10),
    workerId: str("ANALYSIS_WORKER_ID", defaultWorkerId()),
    laneRevision: str("ANALYSIS_LANE_REVISION", "0.0.0-dev"),

    leaseTtlSeconds: num("ANALYSIS_LEASE_TTL_SECONDS", 1200),
    leaseHeartbeatSeconds: num("ANALYSIS_LEASE_HEARTBEAT_SECONDS", 60),
    leaseCumulativeCapSeconds: num("ANALYSIS_LEASE_CUMULATIVE_CAP_SECONDS", 2400),
    maxAttempts: int("ANALYSIS_MAX_ATTEMPTS", 3),
    minRunwaySeconds: num("ANALYSIS_MIN_RUNWAY_SECONDS", 120),
    deadlineGraceSeconds: num("ANALYSIS_DEADLINE_GRACE_SECONDS", 3600),
    reapIntervalSeconds: num("ANALYSIS_REAP_INTERVAL_SECONDS", 15),
    sweepBatch: int("ANALYSIS_SWEEP_BATCH", 500),

    ticketRetentionDays: int("ANALYSIS_TICKET_RETENTION_DAYS", 14),
    retentionBatch: int("ANALYSIS_RETENTION_BATCH", 500),
    maintenanceIntervalSeconds: int("ANALYSIS_MAINTENANCE_INTERVAL_SECONDS", 300),
    contextTableKeepRows: int("ANALYSIS_CONTEXT_TABLE_KEEP", 64),
    contextTableTrimBatch: int("ANALYSIS_CONTEXT_TABLE_TRIM_BATCH", 100),

    llmTotalConcurrency: int("ANALYSIS_LLM_TOTAL_CONCURRENCY", 300),
    unitConcurrency: int("ANALYSIS_WORKER_UNIT_CONCURRENCY", 40),
    workerMaxCount: int("ANALYSIS_WORKER_MAX_COUNT", 16),
    llmSlotAcquireTimeoutMs: int("ANALYSIS_LLM_SLOT_ACQUIRE_TIMEOUT_MS", 30_000),
    reservedManualUnits: int("ANALYSIS_RESERVED_MANUAL_UNITS", 2),

    callbackMaxAttempts: int("ANALYSIS_CALLBACK_MAX_ATTEMPTS", 5),
    callbackTimeoutSeconds: num("ANALYSIS_CALLBACK_TIMEOUT_SECONDS", 10),

    internalTokenSecretArn: optStr("ANALYSIS_LANE_INTERNAL_TOKEN_SECRET_ARN"),
    internalCallbackToken: optStr("ANALYSIS_INTERNAL_CALLBACK_TOKEN"),
    internalContextToken: optStr("ANALYSIS_INTERNAL_CONTEXT_TOKEN"),

    contextFetchTimeoutMs: int("ANALYSIS_CONTEXT_FETCH_TIMEOUT_MS", 60_000),
    contextCacheMaxEntries: int("ANALYSIS_CONTEXT_CACHE_MAX_ENTRIES", 32),
    contextCacheMaxBytes: int("ANALYSIS_CONTEXT_CACHE_MAX_BYTES", 256 * 1024 * 1024),
    contextDbCacheEnabled: bool("ANALYSIS_CONTEXT_DB_CACHE_ENABLED", true),

    httpKeepAliveMs: int("ANALYSIS_HTTP_KEEPALIVE_MS", 4_000),
    httpKeepAliveMaxMs: int("ANALYSIS_HTTP_KEEPALIVE_MAX_MS", 10_000),
    httpConnections: optInt("ANALYSIS_HTTP_CONNECTIONS"),

    llmCacheBust: cacheBust.enabled,
    llmCacheBustMode: cacheBust.mode,

    // ⚠️ `str` 이 아니라 `strStrict` 다 — 빈값(`ANALYSIS_ENGINE=""`)을 stub 로 접지 않는다.
    engine: strStrict("ANALYSIS_ENGINE", "stub"),

    measurementCapacityUrl: optStr("ANALYSIS_MEASUREMENT_CAPACITY_URL"),
    measurementSampleIntervalMs: int("ANALYSIS_MEASUREMENT_SAMPLE_INTERVAL_MS", 30_000),
    measurementSampleTimeoutMs: int("ANALYSIS_MEASUREMENT_SAMPLE_TIMEOUT_MS", 3_000),
    prewarmMeasurementQueueThreshold: int("ANALYSIS_PREWARM_MEASUREMENT_QUEUE_THRESHOLD", 24),
    prewarmMeasurementOldestAgeSeconds: int("ANALYSIS_PREWARM_MEASUREMENT_OLDEST_AGE_SECONDS", 1200),
    prewarmWorkers: int("ANALYSIS_PREWARM_WORKERS", 2),
    fargateVcpuQuota: optInt("ANALYSIS_FARGATE_VCPU_QUOTA", "FARGATE_VCPU_QUOTA"),
    vcpuReserve: int("ANALYSIS_VCPU_RESERVE", 40),
    measurementFargateDesired: int("ANALYSIS_MEASUREMENT_FARGATE_DESIRED", 0),
    measurementFargateTaskVcpu: num("ANALYSIS_MEASUREMENT_FARGATE_TASK_VCPU", 2),
    workerVcpu: num("ANALYSIS_WORKER_VCPU", 2),
    apiVcpu: num("ANALYSIS_API_VCPU", 0.5),

    workerGaugeIntervalSeconds: int("ANALYSIS_WORKER_GAUGE_INTERVAL_SECONDS", 15),
    workerGaugeFreshnessSeconds: int("ANALYSIS_WORKER_GAUGE_FRESHNESS_SECONDS", 60),
    deferredStaleAfterSeconds: int("ANALYSIS_DEFERRED_STALE_AFTER_SECONDS", 3600),
  };
}

export const settings: Settings = loadSettings();
