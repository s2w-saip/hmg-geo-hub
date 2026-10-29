// D13 — 측정 lane 조율. 여기서 지키려는 것은 **실패 방향**이다.
import assert from "node:assert/strict";
import { test } from "node:test";

import { loadSettings, type Settings } from "../app/settings.ts";
import {
  CoordinationSampler,
  SAMPLE_TTL_MS,
  buildCoordination,
  computePrewarmWorkers,
  computeVcpuBudget,
  isMeasurementWaveOpen,
  isSampleFresh,
  isVcpuBudgetEnforced,
  type MeasurementCapacitySample,
} from "../worker/coordination.ts";

// 축은 **Fargate vCPU 쿼터 하나**다. 측정 몫도 Fargate 태스크만 센다(EC2/ASG 는 다른 쿼터).
const base: Settings = {
  ...loadSettings(),
  fargateVcpuQuota: 300,
  vcpuReserve: 40,
  measurementFargateDesired: 20, // 20 × 2 = 40 vCPU
  measurementFargateTaskVcpu: 2,
  workerVcpu: 2,
  apiVcpu: 0.5,
  workerMaxCount: 16,
};
const sample = (queueDepth: number, oldestQueuedAgeSeconds: number | null = null): MeasurementCapacitySample => ({
  queueDepth,
  leasedSlots: 4,
  oldestQueuedAgeSeconds,
  completedPerMin: null,
  sampledAt: new Date().toISOString(),
});

test("vCPU budget: 축은 Fargate 쿼터 하나 — 측정 Fargate 와 api 몫까지 뺀다", () => {
  const b = computeVcpuBudget(base);
  // 300 − 40(여유) − 40(측정 Fargate 20×2) − 0.5(api) = 219.5 → floor 219
  assert.equal(b.analysisMaxVcpu, 219);
  assert.equal(b.measurementAssumed, 40, "측정 몫은 Fargate 태스크만 — EC2 primary/ASG 는 이 쿼터를 안 쓴다");
  assert.equal(b.analysisMaxWorkers, 16, "min(설정 16, floor(219/2)=109)");
  assert.ok(b.measurementAssumed + b.analysisMaxVcpu + b.reserve <= b.quota);
});

test("api 몫을 빼지 않으면 쿼터를 넘는다 — 경계값에서 드러난다", () => {
  // 쿼터 44, 여유 0, 측정 0, api 0.5 → 43.5 → floor 43 → 워커 21 (21×2=42, +api 0.5 = 42.5 ≤ 44)
  const b = computeVcpuBudget({ ...base, fargateVcpuQuota: 44, vcpuReserve: 0, measurementFargateDesired: 0, workerMaxCount: 64 });
  assert.equal(b.analysisMaxVcpu, 43);
  assert.equal(b.analysisMaxWorkers, 21);
  assert.ok(b.analysisMaxWorkers * base.workerVcpu + base.apiVcpu <= 44, "함대 + api 가 쿼터를 넘으면 안 된다");
});

test("budget only ever LOWERS the worker max — never raises it above the configured value", () => {
  const tight = computeVcpuBudget({ ...base, measurementFargateDesired: 125 }); // 250 vCPU → 남는 9
  assert.equal(tight.analysisMaxWorkers, 4); // floor(9/2)
  const roomy = computeVcpuBudget({ ...base, fargateVcpuQuota: 10_000 });
  assert.equal(roomy.analysisMaxWorkers, 16, "a huge quota must not exceed the configured max");
});

test("budget exhaustion closes to zero rather than going negative", () => {
  const b = computeVcpuBudget({ ...base, measurementFargateDesired: 200 }); // 400 vCPU
  assert.equal(b.analysisMaxVcpu, 0);
  assert.equal(b.analysisMaxWorkers, 0);
});

test("쿼터 미설정은 0 이 아니라 '가드 비활성' 이다 — 값을 안 채운 것이 함대를 끄면 안 된다", () => {
  // ⚠️ 실값(스펙 §14-14 · 승인 L13)이 아직 없다. null 을 0 으로 폴백하면 analysisMaxWorkers=0 이
  //    되어 배포와 동시에 함대가 통째로 멈춘다 — "모름" 의 안전한 방향은 그쪽이 아니다.
  const off = { ...base, fargateVcpuQuota: null };
  assert.equal(isVcpuBudgetEnforced(off), false);
  const b = computeVcpuBudget(off);
  assert.equal(b.analysisMaxWorkers, off.workerMaxCount, "가드가 꺼지면 상한은 설정값 그대로다");
  assert.equal(b.quota, 0, "quota 0 + analysisMaxWorkers=설정max 가 '비활성' 의 지문이다");
  assert.equal(isVcpuBudgetEnforced(base), true);
});

test("prewarm fires only once the measurement wave gate opens", () => {
  const s = { ...base, prewarmMeasurementQueueThreshold: 24, prewarmWorkers: 2 };
  assert.equal(computePrewarmWorkers(s, sample(23)), 0);
  assert.equal(computePrewarmWorkers(s, sample(24)), 2);
});

test("웨이브 판정에 나이 분기가 있다 — 측정 measure_queue_depth_batch 와 같은 술어", () => {
  // 깊이만 보면 소량 잔여가 묵어서 여는 웨이브를 통째로 놓친다(= 예열이 필요한 바로 그 순간).
  const s = { ...base, prewarmMeasurementQueueThreshold: 24, prewarmMeasurementOldestAgeSeconds: 1200, prewarmWorkers: 2 };
  assert.equal(isMeasurementWaveOpen(s, sample(3, 1199)), false);
  assert.equal(isMeasurementWaveOpen(s, sample(3, 1200)), true, "깊이가 낮아도 나이가 임계면 웨이브다");
  assert.equal(computePrewarmWorkers(s, sample(3, 1200)), 2);
  // 큐가 비면 나이는 의미가 없다 — 측정 쪽도 그때 null 을 준다.
  assert.equal(isMeasurementWaveOpen(s, sample(0, 99_999)), false);
  assert.equal(isMeasurementWaveOpen(s, sample(3, null)), false);
});

test("prewarm 은 0 ↔ 양수를 오간다 (A26 '0→양수 전이')", () => {
  const s = { ...base, prewarmMeasurementQueueThreshold: 24, prewarmWorkers: 2 };
  const seq = [sample(0), sample(30), sample(30), sample(1)].map((x) => computePrewarmWorkers(s, x));
  assert.deepEqual(seq, [0, 2, 2, 0], "웨이브가 계속 열려 있어도 값이 누적되지 않는다 — 하한이지 래칫이 아니다");
});

test("no sample → no prewarm, and null is never coerced to 0", () => {
  // ⚠️ 여기가 이 파일의 핵심이다. 샘플 없음을 0 으로 위조하면 "측정 큐가 비었다"로 읽혀
  //    예열이 영원히 안 걸린다 — 측정 lane 의 "미측정은 null" 규율과 같은 이유.
  assert.equal(computePrewarmWorkers(base, null), 0);
  const c = buildCoordination(base, { sample: null, error: "TimeoutError: fetch" });
  assert.equal(c.measurementQueueDepth, null);
  assert.equal(c.measurementLeasedSlots, null);
  assert.equal(c.measurementCompletedPerMin, null);
  assert.equal(c.measurementSampleError, "TimeoutError: fetch");
  assert.equal(c.prewarmDesiredWorkers, 0);
});

test("prewarm is clamped by the vCPU budget — coordination cannot exceed the shared quota", () => {
  const s = { ...base, measurementFargateDesired: 130, prewarmWorkers: 8 }; // 260 vCPU → 남는 0
  assert.equal(computePrewarmWorkers(s, sample(100)), 0);
});

test("completedPerMin stays null until the measurement contract exposes it", () => {
  // 측정 lane CapacityV1 에 완료율 필드가 없다. 필드를 미리 뚫어 두되 값을 지어내지 않는다.
  const c = buildCoordination(base, { sample: sample(50), error: null });
  assert.equal(c.measurementCompletedPerMin, null);
  assert.equal(c.measurementQueueDepth, 50);
});

test("샘플러는 실패해도 직전 샘플을 유지한다 — 한 번의 타임아웃이 스파이크 순간 보호를 꺼뜨리면 안 된다", async () => {
  let next: { sample: MeasurementCapacitySample | null; error: string | null } = { sample: sample(50), error: null };
  const s = new CoordinationSampler(base, async () => next);

  await s.tick();
  assert.equal(s.state.sample?.queueDepth, 50);

  next = { sample: null, error: "TimeoutError: fetch" };
  await s.tick();
  assert.equal(s.state.sample?.queueDepth, 50, "직전 샘플은 살아남는다");
  assert.equal(s.state.error, "TimeoutError: fetch", "다만 오류는 표면화한다");
});

test("그 유지는 TTL 까지다 — '마지막 값' 을 무기한 들고 있으면 조율이 아니라 낭비다 (F8)", async () => {
  // ⚠️ TTL 이 없으면 측정 lane 이 죽은 뒤에도 그 순간의 큐 깊이가 영원히 '지금 값' 으로 남는다.
  //    예열이 켜진 채였다면 워커 2대(2 × 2 vCPU)가 아무도 모르게 상시 켜져 있고, 꺼진 채였다면
  //    측정이 복구돼도 예열이 영영 안 걸린다. 어느 쪽이든 "낡은 값 > 모름" 은 틀렸다.
  const stale: MeasurementCapacitySample = {
    ...sample(100),
    sampledAt: new Date(Date.now() - SAMPLE_TTL_MS - 1_000).toISOString(),
  };
  assert.equal(isSampleFresh(stale), false);
  assert.equal(isSampleFresh(sample(100)), true);

  const s = new CoordinationSampler(base, async () => ({ sample: stale, error: null }));
  await s.tick();
  assert.equal(s.state.sample, null, "TTL 을 넘긴 샘플은 null(= 모름) 로 돌아간다");
  assert.match(String(s.state.error), /older than/);
  assert.equal(buildCoordination(base, s.state).prewarmDesiredWorkers, 0, "모르면 예열하지 않는다");
});

test("URL 미설정이면 샘플도 오류도 없다 — 조율은 최적화이지 정확성이 아니다", async () => {
  const s = new CoordinationSampler({ ...base, measurementCapacityUrl: null });
  await s.tick();
  assert.equal(s.state.sample, null);
  assert.equal(s.state.error, null);
});
