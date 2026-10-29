// analysis-api 엔트리포인트. 상시 desired 1 — 오토스케일 없음(스펙 §8.6 D10 · L3).
//
// 접수가 죽으면 코어 submitter 의 `to_submit` 가 쌓인다. 그래서 이 서비스는 **worker 와 생사가
// 분리돼야** 하고, worker desired 0 에서도 큐가 쌓이는 것이 A12(a) 시험의 전제다.
import { serve } from "@hono/node-server";

import { createPostgresDb, type Db } from "./db.ts";
import { errorFields, log } from "./log.ts";
import { migrate } from "./migrate.ts";
import { createServer } from "./server.ts";
import { settings } from "./settings.ts";
import * as T from "./tickets.ts";
import { buildCoordination, CoordinationSampler, isVcpuBudgetEnforced, type CoordinationState } from "../worker/coordination.ts";

const GAUGE_INTERVAL_MS = 60_000;

/**
 * 게이지를 **구조화 로그로** 주기 발행한다. 오토스케일과 알람의 유일한 입력이다.
 *
 * 왜 /metrics 가 아니라 로그인가: CloudWatch 로 올리려면 Prometheus 텍스트를 긁는 주체가
 * 따로 필요하다(사이드카 또는 ADOT). 측정 lane 은 **로그 메트릭 필터**로 같은 문제를 이미
 * 풀었고(`measurement_stack.py` 의 필터들), 그 배선은 구독자 0인 유령 토픽을 만들지 않는다
 * (워크스페이스 룰 alert-routing 4). `/metrics` 는 사람이 curl 로 보는 용도로 남는다.
 *
 * ⚠️ 실패해도 **삼키고 로그만** 남긴다 — 게이지 발행이 접수를 죽이면 안 된다.
 */
function startGaugeLoop(db: Db, coordination: () => CoordinationState): NodeJS.Timeout {
  const tick = async (): Promise<void> => {
    try {
      const snap = await T.queueSnapshot(db, settings.minRunwaySeconds, settings.maxAttempts);
      const dup = await T.duplicateCompletions1d(db);
      const health = await T.laneHealthGauges(db, settings.deferredStaleAfterSeconds);
      const workers = await T.workerGauges(db, settings.workerGaugeFreshnessSeconds);
      const coord = buildCoordination(settings, coordination());
      log.info("analysis_lane.gauges", {
        queueDepth: snap.queueDepth,
        leasedUnits: snap.leasedUnits,
        // ⚠️ 대기 티켓이 없으면 `null` 이다 — 0 으로 위조하면 "방금 들어온 티켓" 과 구분이 안 된다.
        //    CloudWatch 필터의 defaultValue 0 은 **행이 아예 없을 때**만 적용된다.
        oldestQueuedAgeSeconds: snap.oldestQueuedAgeSeconds,
        duplicateCompletions1d: dup,
        // F14 — 끝난 실패·안 끝나는 대기. 둘 다 queueDepth 축에서는 안 보인다.
        failedTerminal1d: health.failedTerminal1d,
        deferredBacklog: health.deferredBacklog,
        deferredStale: health.deferredStale,
        // F2 — 램프의 유일한 판정 입력. **미상이면 필드를 아예 내지 않는다**(0 위조 금지).
        //      CDK `InflightCallsFilter` 가 보는 필드가 바로 이것이다.
        ...(workers.known ? { inflightCalls: workers.inflightCalls, workerCount: workers.workerCount } : {}),
        workerGaugeStale: workers.staleWorkers,
        prewarmDesiredWorkers: coord.prewarmDesiredWorkers,
        measurementQueueDepth: coord.measurementQueueDepth,
        vcpuMaxWorkers: coord.vcpuBudget.analysisMaxWorkers,
      });
    } catch (e) {
      log.error("analysis_lane.gauge_failed", errorFields(e));
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), GAUGE_INTERVAL_MS);
  timer.unref?.();
  return timer;
}

async function main(): Promise<void> {
  if (!settings.storeDsn) {
    log.error("analysis_lane.missing_dsn", { hint: "ANALYSIS_STORE_DSN required" });
    process.exit(2);
  }
  const db = createPostgresDb(settings.storeDsn, { max: 10 });
  // 측정 lane 과 같은 관례: api 기동이 마이그레이션을 적용한다(`app/main.py` lifespan).
  // 한 트랜잭션 + advisory lock 이라 api 가 여럿이어도 안전하다.
  const applied = await migrate(db);
  if (applied.length > 0) log.info("analysis_lane.migrated", { applied });

  // ⚠️ 예산 가드가 **꺼진 채로 도는 것**을 조용히 두지 않는다(F6). 쿼터 실값이 없으면 워커 상한은
  //    설정값 그대로이고, 그 사실이 기동 로그에 남아야 다음 사람이 `analysisMaxWorkers` 를
  //    "예산이 허락한 값" 으로 오해하지 않는다.
  if (!isVcpuBudgetEnforced(settings)) {
    log.warn("analysis_lane.vcpu_budget_guard_disabled", {
      hint: "ANALYSIS_FARGATE_VCPU_QUOTA (or FARGATE_VCPU_QUOTA) unset — worker max is NOT clamped by the shared Fargate quota",
      workerMaxCount: settings.workerMaxCount,
      workerVcpu: settings.workerVcpu,
    });
  }

  const sampler = new CoordinationSampler(settings);
  sampler.start();

  const gauges = startGaugeLoop(db, () => sampler.state);
  const app = createServer({ db, coordination: () => sampler.state });
  const server = serve({ fetch: app.fetch, port: settings.port, hostname: "0.0.0.0" }, (info) => {
    log.info("analysis_lane.api_start", { port: info.port, stage: settings.stage });
  });

  const shutdown = (sig: string) => {
    log.info("analysis_lane.api_stop", { signal: sig });
    sampler.stop();
    clearInterval(gauges);
    server.close(() => void db.close().then(() => process.exit(0)));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((e) => {
  log.error("analysis_lane.api_crashed", errorFields(e));
  process.exit(1);
});
