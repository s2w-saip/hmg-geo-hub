// 티켓 API — stateless. 계약 검증은 `parseAnalysisTicketRequestV1` 하나.
// **인증은 mTLS 인그레스에서 종단한다 — 앱은 인증을 모른다**(측정 lane `app/main.py:1` 과 같은 관례).
//
// 라우트 표면은 측정 모듈과 **동형**이다(경로 이름만 analysis-tickets):
//
//   POST   /v1/analysis-tickets            202 접수 (멱등 replay)
//   GET    /v1/analysis-tickets/{id}       상태
//   GET    /v1/analysis-tickets/{id}/reply 답장 본문(없으면 204) ← 코어가 되읽는 권위 경로
//   DELETE /v1/analysis-tickets/{id}       취소
//   GET    /v1/capacity                    용량 + D13 조율 블록
//   GET    /healthz  /readyz  /metrics
//
// ⚠️ **접수(api)와 소비(worker)가 별 서비스다**(스펙 §8.6 D10). 이 서비스는 상시 1 이고
//    worker 는 0~16 이다 — worker desired 0 에서도 큐가 쌓이려면 접수 주체가 살아 있어야 한다
//    (A12(a) 의 전제).
import { Hono } from "hono";

import { errorFields, log } from "./log.ts";
import { settings } from "./settings.ts";
import * as T from "./tickets.ts";
import type { Db } from "./db.ts";
import {
  ANALYSIS_TURN_BODY_MAX_BYTES,
  AnalysisTicketRequestSchema,
  turnBodyBytes,
} from "../contracts/index.ts";
import { buildCoordination, type CoordinationState } from "../worker/coordination.ts";

export interface ServerDeps {
  db: Db;
  /** D13 조율 샘플 홀더. api 서비스가 측정 lane 을 샘플링하고 그 값을 `/v1/capacity` 로 노출한다. */
  coordination: () => CoordinationState;
}

/**
 * 워커 게이지 읽기 — `analysis_worker_gauges`(0005)의 **신선한 행만** 합산한다(F2).
 *
 * ⚠️ 초판은 `deps.inflightCalls` 가 아예 배선되지 않아 `/v1/capacity` 와 `/metrics` 가 항상
 *    **0 을 냈다**. 0 은 "상한을 하나도 안 쓰고 있다" 는 뜻이라, 램프(300 → 640)의 유일한 판정
 *    입력이 "언제나 여유롭다" 로 고정돼 있었다. CDK 의 `InflightCallsFilter` 도 게이지 로그에
 *    없는 필드를 보고 있었으므로 CloudWatch 쪽도 같이 비어 있었다.
 */
async function readWorkerGauges(db: Db): Promise<T.WorkerGaugeSnapshot> {
  return T.workerGauges(db, settings.workerGaugeFreshnessSeconds);
}

export function createServer(deps: ServerDeps): Hono {
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.get("/readyz", async (c) => {
    const ok = await deps.db.ping();
    return c.json({ ready: ok, store: ok ? "ok" : "down", stage: settings.stage }, ok ? 200 : 503);
  });

  app.post("/v1/analysis-tickets", async (c) => {
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ error: "contract", issues: [{ loc: [], msg: "body is not valid json", type: "json" }] }, 400);
    }

    // ⚠️ 본문 상한은 **파싱보다 먼저** 본다. 계약 위반을 워커까지 보내 슬롯을 낭비하지 않는다는
    //    측정 lane 원칙(설계 §3.1) 그대로이고, 여기서 400 이 **곧 최종 판정**이다 — 턴 입도(D1)
    //    라 더 쪼갤 것이 없고, 코어는 그 턴을 `persistTurnFailure`(output_contract)로 닫는다.
    const turn = (payload as { turn?: unknown } | null)?.turn;
    const bytes = turnBodyBytes(turn);
    if (bytes > ANALYSIS_TURN_BODY_MAX_BYTES) {
      log.warn("analysis_lane.turn_body_too_large", { bytes, limit: ANALYSIS_TURN_BODY_MAX_BYTES });
      return c.json({ error: "contract", issues: [{ loc: ["turn"], msg: `turn exceeds ${ANALYSIS_TURN_BODY_MAX_BYTES} bytes (${bytes})`, type: "too_big" }] }, 400);
    }

    const parsed = AnalysisTicketRequestSchema.safeParse(payload);
    if (!parsed.success) {
      return c.json(
        {
          error: "contract",
          issues: parsed.error.issues.map((i) => ({ loc: i.path.map(String), msg: i.message, type: i.code })),
        },
        400,
      );
    }
    const req = parsed.data;

    const idem = c.req.header("idempotency-key");
    if (idem !== undefined && idem !== req.ticketId) {
      return c.json({ error: "Idempotency-Key must equal ticketId" }, 400);
    }

    const { accepted, replay } = await deps.db.begin((tx) => T.accept(tx, req));
    if (idem === undefined) {
      c.header("Warning", '199 - "Idempotency-Key header missing; ticketId used as key"');
    }
    if (replay) c.header("X-Idempotent-Replay", "true");
    return c.json(accepted, 202);
  });

  app.get("/v1/analysis-tickets/:id", async (c) => {
    const st = await T.status(deps.db, c.req.param("id"));
    if (!st) return c.json({ error: "unknown ticket" }, 404);
    return c.json(st);
  });

  app.get("/v1/analysis-tickets/:id/reply", async (c) => {
    const id = c.req.param("id");
    const rep = await T.reply(deps.db, id);
    if (rep === null) {
      if (!(await T.exists(deps.db, id))) return c.json({ error: "unknown ticket" }, 404);
      return c.body(null, 204);
    }
    return c.json(rep);
  });

  app.delete("/v1/analysis-tickets/:id", async (c) => {
    const id = c.req.param("id");
    const st = await deps.db.begin((tx) => T.cancel(tx, id));
    if (st === null) return c.json({ error: "unknown ticket" }, 404);
    return c.json({ ticketId: id, status: st });
  });

  app.get("/v1/capacity", async (c) => {
    const g = await readWorkerGauges(deps.db);
    const cap = await T.capacity(deps.db, {
      minRunwaySeconds: settings.minRunwaySeconds,
      maxAttempts: settings.maxAttempts,
      unitConcurrency: settings.unitConcurrency,
      reservedManualUnits: settings.reservedManualUnits,
      totalCallSlots: settings.llmTotalConcurrency,
      inflightCalls: g.inflightCalls,
      workerCount: g.workerCount,
      coordination: buildCoordination(settings, deps.coordination()),
    });
    // ⚠️ 계약이 두 값을 **비널 정수**로 못박고 있어(`AnalysisCapacitySchema`) "모름" 을 본문으로
    //    표현할 자리가 없다. 그래서 미상일 때는 헤더로 표면화한다 — 코어가 이 헤더를 보면
    //    `inflightCalls=0` 을 "여유롭다" 로 읽지 않는다. (계약에 nullable 을 더하는 것은 코어와
    //    동시 변경이라 이 커밋의 경계 밖 — G3-2 와 함께 간다.)
    if (!g.known) c.header("X-Worker-Gauges", `stale; staleWorkers=${g.staleWorkers}`);
    return c.json(cap);
  });

  // Prometheus text. 오토스케일(큐 깊이 타깃추적)·알람의 입력.
  app.get("/metrics", async (c) => {
    const snap = await T.queueSnapshot(deps.db, settings.minRunwaySeconds, settings.maxAttempts);
    const dup = await T.duplicateCompletions1d(deps.db);
    const health = await T.laneHealthGauges(deps.db, settings.deferredStaleAfterSeconds);
    const g0 = await readWorkerGauges(deps.db);
    const coord = buildCoordination(settings, deps.coordination());
    const lines: string[] = [];
    const g = (name: string, value: number | null, help: string) => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
      // ⚠️ null 은 **행을 내지 않는다**. 0 으로 내면 "측정 큐가 비었다"로 읽혀 예열이 영원히
      //    안 걸린다 — 측정 lane 의 "미측정은 null" 규율과 같은 이유.
      if (value !== null) lines.push(`${name} ${value}`);
    };
    g("analysis_queue_depth", snap.queueDepth, "pickable tickets (deadline/attempt filtered)");
    g("analysis_leased_units", snap.leasedUnits, "leased+running tickets");
    g("analysis_oldest_queued_age_seconds", snap.oldestQueuedAgeSeconds, "age of oldest pickable ticket");
    g("analysis_llm_total_call_slots", settings.llmTotalConcurrency, "global in-flight LLM call ceiling (spec 8.2)");
    // ⚠️ 워커 보고가 **미상**이면 행 자체를 내지 않는다 — 0 을 내면 "상한을 안 쓰고 있다" 로
    //    읽혀 램프가 근거 없이 다음 단계로 간다. 함대가 0 인 것(행 없음)과는 구분된다.
    g("analysis_inflight_calls", g0.known ? g0.inflightCalls : null, "in-flight LLM calls reported by workers");
    g("analysis_worker_count", g0.known ? g0.workerCount : null, "workers with a fresh gauge report");
    g("analysis_worker_call_slots", g0.known ? g0.callSlots : null, "sum of per-worker semaphore limits");
    g("analysis_worker_gauge_stale", g0.staleWorkers, "worker rows whose report is older than the freshness window");
    // 0 이 정상. >0 이면 **이중 LLM 지출이 진행 중**이다(측정 lane duplicate_completions_1d 동형).
    g("analysis_duplicate_completions_1d", dup, "turns analyzed more than once today");
    // F14 — 끝난 실패와 안 끝나는 대기. 큐 깊이 축에서는 둘 다 안 보인다.
    g("analysis_failed_terminal_1d", health.failedTerminal1d, "tickets closed as terminal failed today (LLM spend already gone)");
    g("analysis_failed_cap_exhausted_1d", health.failedCapExhausted1d, "…of which exhausted the lane attempt cap");
    g("analysis_failed_deadline_exceeded_1d", health.failedDeadlineExceeded1d, "…of which blew the deadline");
    g("analysis_deferred_backlog", health.deferredBacklog, "tickets currently deferred (normal backoff included)");
    // 0 이 정상. >0 = 리퍼가 못 걷어내는 잔존(측정 lane 0013 의 deferred(deadline) 4,260건 지문).
    g("analysis_deferred_stale", health.deferredStale, "deferred tickets untouched beyond the stale window");
    g("analysis_measurement_queue_depth", coord.measurementQueueDepth, "D13: measurement lane queue depth sample");
    g("analysis_prewarm_desired_workers", coord.prewarmDesiredWorkers, "D13: prewarm floor for analysis worker desired");
    g("analysis_vcpu_max_workers", coord.vcpuBudget.analysisMaxWorkers, "D13: worker max allowed by shared vCPU budget");
    for (const [status, n] of Object.entries(snap.statusCounts)) {
      lines.push(`analysis_tickets_by_status{status="${status}"} ${n}`);
    }
    return c.text(lines.join("\n") + "\n");
  });

  app.onError((err, c) => {
    log.error("analysis_lane.api_error", { path: c.req.path, ...errorFields(err) });
    return c.json({ error: "internal" }, 500);
  });

  return app;
}
