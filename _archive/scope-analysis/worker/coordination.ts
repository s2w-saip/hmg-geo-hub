// D13 — **측정 lane 과의 유기적 조율** (운영 추가 요구 2026-09-12. 스펙 문서에는 없다.)
//
// ── 문제
//
//   분석 수요는 **측정 완료에서 나온다.** 오토스케일 신호를 lane 큐 깊이 하나로 두면 항상 한
//   박자 늦는다: 측정이 막 완주한 순간에는 아직 분석 티켓이 없고, 티켓이 쌓이기 시작한 뒤에야
//   워커가 뜬다. Fargate 기동은 초 단위라 측정 lane 의 웜풀 25대만큼 비싸지는 않지만, 웨이브가
//   여는 순간의 스파이크는 그 몇 초에 다 몰린다.
//
// ── 셋을 함께 본다 (구현은 훅·설정, **값은 스테이징 실측 후**)
//
//   1. **선행 지표** — 측정 lane 의 `/v1/capacity` 를 샘플링한다. 코어가 티켓에 힌트를 실어
//      보내는 방식은 **채택하지 않았다**: 티켓 `options` 는 코어 소유의 분석 옵션이고 실행
//      필드를 금지하는 계약이라(§4.3 "없는 것"), 거기에 스케일 힌트를 넣으면 경계가 샌다.
//      lane 이 lane 에게 묻는 것이 계약을 건드리지 않는 유일한 경로다.
//   2. **예열** — 측정 큐가 임계를 넘으면(= 웨이브 게이트가 측정 함대를 깨우는 그 순간)
//      분석 워커 desired 의 하한을 `prewarmWorkers` 로 올린다.
//   3. **공용 vCPU 예산 가드** — 측정 + 분석 ≤ 쿼터 − 여유. 쿼터는 ~300 vCPU 로 상향됐다.
//      worker max 16 × 2 vCPU = 32 vCPU 는 이 문서가 인용해 온 옛 한계(~30)를 넘었던 값이라
//      (§8.6 D6 · L13), 상한이 코드에도 있어야 다음 사람이 max 를 올릴 때 쿼터를 같이 본다.
//
// ── 실패 방향을 못박는다
//
//   측정 샘플을 못 얻으면 `null` 이고 **0 이 아니다.** 0 으로 위조하면 "측정 큐가 비었다" 로
//   읽혀 예열이 영원히 안 걸린다 — 측정 lane 의 "미측정은 null" 규율과 같은 원칙.
//   그리고 샘플 실패가 **분석을 막지 않는다**: 조율은 최적화이지 정확성이 아니다.
import type { AnalysisCoordination } from "../contracts/index.ts";
import type { Settings } from "../app/settings.ts";

export interface MeasurementCapacitySample {
  queueDepth: number;
  leasedSlots: number;
  /**
   * 측정 lane 의 가장 오래된 대기 유닛 나이. **웨이브 판정의 두 번째 분기**다(F7) — 측정의
   * `measure_queue_depth_batch` 가 "깊이 ≥ batch_min **또는** 나이 ≥ 1,200s" 로 배치를 여는데,
   * 깊이만 보면 소량 잔여가 오래 묵어 여는 웨이브(= 측정이 곧 완주 → 분석 수요 발생)를 통째로
   * 놓친다. 값이 없으면 `null` 이고 0 이 아니다 — 0 은 "방금 들어온 티켓" 과 구분이 안 된다.
   */
  oldestQueuedAgeSeconds: number | null;
  /** 측정 완료율의 프록시. 측정 lane `/v1/capacity` 에는 없는 값이라 현재는 항상 null 이다(아래 ⚠️). */
  completedPerMin: number | null;
  sampledAt: string;
}

export interface CoordinationState {
  sample: MeasurementCapacitySample | null;
  error: string | null;
}

/**
 * 샘플 유효기간. 실패해도 직전 샘플을 버리지 않지만(스파이크 순간에 보호가 사라지면 안 된다),
 * **영원히 들고 있지는 않는다** — 30분 전 큐 깊이로 예열을 켜 두면 그건 조율이 아니라 낭비다.
 */
export const SAMPLE_TTL_MS = 5 * 60_000;

export function isSampleFresh(sample: MeasurementCapacitySample, now: number = Date.now()): boolean {
  const t = Date.parse(sample.sampledAt);
  return Number.isFinite(t) && now - t <= SAMPLE_TTL_MS;
}

/**
 * 공용 vCPU 예산 — **축은 Fargate On-Demand vCPU 쿼터 하나다.**
 *
 * ⚠️ 초판은 축이 섞여 있었다: `ANALYSIS_MEASUREMENT_ASSUMED_VCPU=200` 을 빼고 있었는데 그것은
 *    측정 lane 의 **EC2 primary + ASG 웜풀** 몫이다. EC2 는 Fargate 쿼터를 쓰지 않는다(별 쿼터,
 *    별 계정 한도). 즉 존재하지 않는 경합을 빼고 있었고, 그 결과 `analysisMaxVcpu` 가 60 으로
 *    깎여 **예산 가드가 근거 없이 함대를 조이는** 방향이었다. 반대로 진짜 같은 쿼터를 쓰는 것들
 *    (analysis-api 자신, 측정 lane 이 Fargate 로 돌리는 태스크)은 **하나도 안 빼고 있었다.**
 *
 * 이 축에 들어가는 것:
 *   + `fargateVcpuQuota`            계정·리전의 Fargate On-Demand vCPU 쿼터 (실값 env)
 *   − `vcpuReserve`                 다른 Fargate 워크로드·버스트 여유
 *   − 측정 Fargate (desired × 2)    같은 쿼터를 실제로 먹는 유일한 측정 몫
 *   − `apiVcpu`                     analysis-api 상시 1 태스크 (0.5)
 *   = 분석 워커가 쓸 수 있는 vCPU  → ÷ 태스크당 vCPU = 워커 상한
 *
 * ⚠️ **쿼터 미설정(`null`)이면 가드를 끈다 — 0 으로 폴백하지 않는다.** 쿼터 실값은 아직 미확인
 *    (스펙 §14-14 · 승인 L13)이고, 모르는 것을 0 으로 적으면 `analysisMaxWorkers=0` 이 돼서
 *    "값을 안 채운 것" 이 곧 "함대 전면 정지" 가 된다. 가드가 꺼졌다는 사실은 호출부가 로그로
 *    표면화한다(`app/main.ts`) — 조용히 꺼지는 가드가 가장 나쁘다.
 *    계약(`AnalysisVcpuBudgetSchema`)이 정수 비널이므로 비활성의 지문은 **`quota === 0` 이면서
 *    `analysisMaxWorkers === workerMaxCount`** 다.
 */
export function computeVcpuBudget(s: Settings): AnalysisCoordination["vcpuBudget"] {
  const measurementFargate = Math.max(0, s.measurementFargateDesired) * Math.max(0, s.measurementFargateTaskVcpu);
  const perWorker = Math.max(1, s.workerVcpu);
  if (s.fargateVcpuQuota === null) {
    return {
      quota: 0, // 0 = 미설정(가드 비활성). 실제 쿼터 0 이라는 뜻이 아니다 — 위 ⚠️.
      reserve: s.vcpuReserve,
      measurementAssumed: Math.floor(measurementFargate),
      analysisMaxVcpu: Math.floor(s.workerMaxCount * perWorker),
      analysisMaxWorkers: s.workerMaxCount,
    };
  }
  const analysisMaxVcpu = Math.max(0, Math.floor(s.fargateVcpuQuota - s.vcpuReserve - measurementFargate - s.apiVcpu));
  const byBudget = Math.floor(analysisMaxVcpu / perWorker);
  return {
    quota: s.fargateVcpuQuota,
    reserve: s.vcpuReserve,
    measurementAssumed: Math.floor(measurementFargate),
    analysisMaxVcpu,
    // 설정된 max 와 예산이 허용하는 max 중 **작은 쪽**. 예산이 상한을 내리는 방향으로만 작동한다.
    analysisMaxWorkers: Math.max(0, Math.min(s.workerMaxCount, byBudget)),
  };
}

/** 예산 가드가 실제로 걸려 있는가. false 면 `analysisMaxWorkers` 는 설정값 그대로다. */
export function isVcpuBudgetEnforced(s: Settings): boolean {
  return s.fargateVcpuQuota !== null;
}

/**
 * 측정 웨이브가 열렸는가 — **측정 lane 의 배치 게이트와 같은 술어**(F7).
 *
 * 측정은 `measure_queue_depth_batch` 에서 "깊이 ≥ batch_min **또는** 가장 오래된 대기 ≥ 1,200s"
 * 로 웨이브를 연다. 분석 예열이 깊이 분기만 보면, 소량 잔여가 묵어서 열리는 웨이브를 못 보고
 * **정확히 그때 한 박자 늦는다**(예열의 존재 이유가 그 한 박자다).
 */
export function isMeasurementWaveOpen(s: Settings, sample: MeasurementCapacitySample | null): boolean {
  if (!sample) return false;
  if (sample.queueDepth >= s.prewarmMeasurementQueueThreshold) return true;
  // 나이 분기는 **대기가 실제로 있을 때만** 의미가 있다 — 큐가 비면 나이도 null 이다.
  return (
    sample.queueDepth > 0 &&
    sample.oldestQueuedAgeSeconds !== null &&
    sample.oldestQueuedAgeSeconds >= s.prewarmMeasurementOldestAgeSeconds
  );
}

/**
 * 예열 desired. 웨이브가 열려 있으면 `prewarmWorkers`, 아니면 0.
 * 이 값은 **하한**이고 실제 desired 는 `max(큐 깊이 타깃추적 산출, prewarm)` 이다 — 오토스케일
 * 정책을 대체하지 않는다(CDK 의 타깃추적이 정본).
 *
 * ⚠️ 양수 ↔ 0 을 **오가야 한다**(A26 "0→양수 전이"). 초판의 CDK 정책은 스케일인 스텝이 없는
 *    `CHANGE_IN_CAPACITY +2` 라 웨이브가 열려 있는 매 주기마다 +2 씩 **누적**됐고 내려오는 길이
 *    없었다 — 그건 하한이 아니라 래칫이다. 지금은 스택이 `EXACT_CAPACITY` 로 이 값을 그대로
 *    desired 하한에 박고, 0 으로 떨어지면 타깃추적에 자리를 돌려준다(`infra/lib/analysis-stack.ts`).
 */
export function computePrewarmWorkers(s: Settings, sample: MeasurementCapacitySample | null): number {
  if (!isMeasurementWaveOpen(s, sample)) return 0;
  const budget = computeVcpuBudget(s);
  return Math.max(0, Math.min(s.prewarmWorkers, budget.analysisMaxWorkers));
}

export function buildCoordination(s: Settings, state: CoordinationState): AnalysisCoordination {
  const sample = state.sample;
  return {
    measurementQueueDepth: sample ? sample.queueDepth : null,
    measurementLeasedSlots: sample ? sample.leasedSlots : null,
    measurementCompletedPerMin: sample ? sample.completedPerMin : null,
    measurementSampledAt: sample ? sample.sampledAt : null,
    measurementSampleError: state.error ? state.error.slice(0, 256) : null,
    prewarmDesiredWorkers: computePrewarmWorkers(s, sample),
    vcpuBudget: computeVcpuBudget(s),
  };
}

/**
 * 측정 lane `/v1/capacity` 샘플러.
 *
 * ⚠️ **측정 lane 의 `CapacityV1` 에는 완료율이 없다**(`totalSlots`·`leasedSlots`·
 * `reservedManualSlots`·`queueDepth`·`oldestQueuedAgeSeconds` 뿐 — `contracts/v1.py`).
 * 그래서 `completedPerMin` 은 현재 **항상 null** 이고, 채우려면 둘 중 하나가 선행한다:
 *   ⓐ 측정 lane `/metrics` 의 `measure_completed_15m` 게이지를 함께 읽는다(추가 엔드포인트·권한)
 *   ⓑ 측정 lane `CapacityV1` 에 additive 필드를 하나 더한다(그쪽 계약 변경 — 별건 승인)
 * **지금 고르지 않는다.** 필드를 미리 뚫어 두고 값은 null 로 둔다 — 예열 판정은 큐 깊이만으로도
 * 성립하고, 완료율은 램프 실측에서 그 값이 실제로 필요한지가 먼저 밝혀져야 한다.
 *
 * mTLS 는 인그레스가 종단하므로 이 fetch 는 **클라이언트 인증서를 들고 가야 한다**(L4 — 측정
 * lane 과 같은 CA). 인증서 배선은 태스크 정의가 주입하는 `NODE_EXTRA_CA_CERTS` + undici 의
 * 커넥터 옵션으로 하며, 그 배선 자체는 스택 배포(단계 3) 시점의 일이다.
 */
export async function sampleMeasurementCapacity(s: Settings): Promise<CoordinationState> {
  if (!s.measurementCapacityUrl) return { sample: null, error: null };
  try {
    const res = await fetch(s.measurementCapacityUrl, {
      signal: AbortSignal.timeout(s.measurementSampleTimeoutMs),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return { sample: null, error: `http ${res.status}` };
    const body = (await res.json()) as Record<string, unknown>;
    const queueDepth = Number(body.queueDepth);
    const leasedSlots = Number(body.leasedSlots);
    if (!Number.isFinite(queueDepth) || !Number.isFinite(leasedSlots)) {
      return { sample: null, error: "capacity payload missing queueDepth/leasedSlots" };
    }
    // 측정 `CapacityV1.oldestQueuedAgeSeconds` — 대기 티켓이 없으면 그쪽도 null 을 준다.
    const oldest = body.oldestQueuedAgeSeconds;
    const oldestNum = oldest === null || oldest === undefined ? null : Number(oldest);
    return {
      sample: {
        queueDepth: Math.max(0, Math.trunc(queueDepth)),
        leasedSlots: Math.max(0, Math.trunc(leasedSlots)),
        oldestQueuedAgeSeconds: oldestNum !== null && Number.isFinite(oldestNum) ? Math.max(0, oldestNum) : null,
        completedPerMin: null, // ⚠️ 위 주석 — 측정 계약에 그 값이 없다
        sampledAt: new Date().toISOString(),
      },
      error: null,
    };
  } catch (e) {
    return { sample: null, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }
}

/**
 * 프로세스 수명 동안 최신 샘플을 들고 있는 홀더. 실패해도 **직전 샘플을 버리지 않는다** —
 * 다만 **TTL(5분)까지만**이다(F8).
 *
 * ⚠️ 초판은 TTL 이 없어서 마지막 성공 샘플을 **무기한** 들고 있었다. 측정 lane 이 죽거나 URL 이
 *    바뀌면 그 순간의 큐 깊이가 영원히 "지금 값" 으로 남고, 예열이 켜진 채였다면 워커 2대가
 *    **아무도 모르게 상시 켜져 있게** 된다(Fargate 2 × 2 vCPU 상시 = 조용한 청구서). 반대로 꺼진
 *    채였다면 측정이 복구돼도 예열이 영영 안 걸린다. 어느 쪽이든 "낡은 값 > 모름" 은 틀렸다.
 *    TTL 이 지나면 **null(= 모름)** 로 돌아가고 예열은 0 이 된다 — 안전한 실패 방향이다.
 */
export class CoordinationSampler {
  #state: CoordinationState = { sample: null, error: null };
  #timer: NodeJS.Timeout | null = null;

  /**
   * `sampleFn` 은 테스트 주입점이다 — 이 클래스가 지키는 것(직전 샘플 유지 · TTL 만료 · 실패
   * 격리)은 **시간과 실패**의 함수라 네트워크로는 재현할 수 없다. 기본값은 실제 샘플러다.
   */
  constructor(
    private readonly s: Settings,
    private readonly sampleFn: (s: Settings) => Promise<CoordinationState> = sampleMeasurementCapacity,
  ) {}

  get state(): CoordinationState {
    const { sample, error } = this.#state;
    if (sample && !isSampleFresh(sample)) {
      return { sample: null, error: error ?? `last measurement sample is older than ${SAMPLE_TTL_MS}ms` };
    }
    return this.#state;
  }

  async tick(): Promise<void> {
    const next = await this.sampleFn(this.s);
    if (next.sample) {
      this.#state = next;
    } else {
      // 실패해도 직전 샘플을 유지한다 — 한 번의 타임아웃이 예열을 꺼뜨리면 스파이크 순간에
      // 정확히 그 보호가 사라진다. 다만 오류는 표면화하고, TTL 이 지나면 위 getter 가 버린다.
      this.#state = { sample: this.#state.sample, error: next.error };
    }
  }

  start(): void {
    if (this.#timer || !this.s.measurementCapacityUrl) return;
    void this.tick();
    this.#timer = setInterval(() => void this.tick(), this.s.measurementSampleIntervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }
}
