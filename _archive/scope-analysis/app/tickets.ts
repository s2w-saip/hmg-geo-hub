// 티켓 상태기계 — 전이는 전부 여기. 계약(`contracts/v1.ts`)이 모양을, 이 모듈이 시간을 책임진다.
// 측정 lane `app/tickets.py` 의 TS 이식본(스펙 §3.1 "그대로 이식").
//
//   queued → leased → running → completed | deferred | failed | cancelled
//   deferred → queued (next_eligible_at 도달 시 pull 대상 — 별도 redrive 없이 픽 쿼리가 잡는다)
//   leased/running 의 lease 만료 → queued (리퍼)
//
// ⚠️ 파라미터 바인딩 규약: jsonb 는 **객체 그대로 + `::jsonb` 캐스트**(`JSON.stringify` 금지),
//    시각은 **ISO 문자열 + `::timestamptz`**, 간격은 **`make_interval(secs => $n)`** 로만 넘긴다.
//    캐스트를 붙이는 이유는 같다 — 컬럼 추론에 기대면 테스트가 통과한 SQL 과 라이브가 도는
//    SQL 이 갈린다.
//
//    ⚠️ jsonb 만 규약이 **뒤집혔다**(2026-09-13). 초판은 "JSON 문자열 + 캐스트" 였고 그것이
//    라이브 전량 실패의 원인이었다: postgres.js 가 `$n::jsonb` 로 해소된 OID 를 보고 **문자열을
//    한 번 더 직렬화**해 jsonb 문자열 스칼라를 저장한다. PGlite 는 그 추론이 없어 테스트가
//    통과한다 — 근거·실측은 `app/db.ts` 상단 "jsonb 바인딩 규약".
import {
  AnalysisReplySchema,
  AnalysisTicketAcceptedSchema,
  AnalysisTicketStatusViewSchema,
  type AnalysisCoordination,
  type AnalysisCapacity,
  type AnalysisFailureClass,
  type AnalysisReply,
  type AnalysisTicketAccepted,
  type AnalysisTicketRequest,
  type AnalysisTicketStatusView,
  type AnalysisTerminalReason,
} from "../contracts/index.ts";
import { fromJsonb, one, type Queryable, type Row } from "./db.ts";

const iso = (d: Date): string => d.toISOString();
const toIso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

export interface LeaseOptions {
  workerId: string;
  ttlSeconds: number;
  allowScheduled: boolean;
  limit: number;
  minRunwaySeconds: number;
  maxAttempts: number;
}

export interface LeasedTicket extends Row {
  ticket_id: string;
  trace_id: string;
  request: unknown;
  attempt_count: number;
  deadline_at: unknown;
  callback_url: string | null;
  lease_token: string;
  lease_elapsed_s: string | number;
  context_version: string;
  turn_run_id: string;
  analysis_version: string;
}

// ---- API 쪽 ---------------------------------------------------------------

/**
 * 202 접수. 같은 `ticketId` 는 실행을 늘리지 않는다(`ON CONFLICT DO NOTHING` → replay).
 *
 * 좌표(workspace/turn_run/analysis_version …)를 request jsonb 에서 파내지 않고 컬럼으로 승격해
 * 함께 쓴다 — 중복 판정·꼬리 집계·관측이 전부 그 축이다(`migrations/0001` 주석).
 */
export async function accept(
  tx: Queryable,
  req: AnalysisTicketRequest,
): Promise<{ accepted: AnalysisTicketAccepted; replay: boolean }> {
  const inserted = one(
    await tx.query<{ created_at: unknown }>(
      `INSERT INTO analysis_tickets (
         ticket_id, trace_id, status, priority,
         workspace_id, project_id, query_run_id, prompt_run_id, turn_run_id, turn_index,
         analysis_version, context_version, request, deadline_at, callback_url
       ) VALUES ($1,$2,'queued',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::timestamptz,$14)
       ON CONFLICT (ticket_id) DO NOTHING
       RETURNING created_at`,
      [
        req.ticketId,
        req.traceId,
        req.priority,
        req.lineage.workspaceId,
        req.lineage.projectId,
        req.lineage.queryRunId,
        req.lineage.promptRunId,
        req.lineage.turnRunId,
        req.lineage.turnIndex,
        req.analysisVersion,
        req.context.contextVersion,
        req,
        req.deadlineAt,
        req.callbackUrl,
      ],
    ),
  );
  if (inserted) {
    await tx.query(
      "INSERT INTO analysis_ticket_events (ticket_id, actor, from_status, to_status) VALUES ($1,'api',NULL,'queued')",
      [req.ticketId],
    );
    return {
      accepted: AnalysisTicketAcceptedSchema.parse({
        ticketId: req.ticketId,
        status: "queued",
        acceptedAt: toIso(inserted.created_at),
        idempotentReplay: false,
      }),
      replay: false,
    };
  }
  const existing = one(
    await tx.query<{ created_at: unknown }>("SELECT created_at FROM analysis_tickets WHERE ticket_id=$1", [req.ticketId]),
  );
  if (!existing) throw new Error(`ticket ${req.ticketId} neither inserted nor found`);
  return {
    accepted: AnalysisTicketAcceptedSchema.parse({
      ticketId: req.ticketId,
      status: "queued",
      acceptedAt: toIso(existing.created_at),
      idempotentReplay: true,
    }),
    replay: true,
  };
}

export async function status(q: Queryable, ticketId: string): Promise<AnalysisTicketStatusView | null> {
  const r = one(
    await q.query<Row>(
      `SELECT status, updated_at, failure_class, next_eligible_at, attempt_count, failure_reason
         FROM analysis_tickets WHERE ticket_id=$1`,
      [ticketId],
    ),
  );
  if (!r) return null;
  const deferred =
    r.status === "deferred"
      ? {
          failureClass: String(r.failure_class ?? "transient") as AnalysisFailureClass,
          nextEligibleAt: toIso(r.next_eligible_at),
          attemptCount: Math.max(1, Number(r.attempt_count)),
          detail: r.failure_reason === null || r.failure_reason === undefined ? null : String(r.failure_reason).slice(0, 512),
        }
      : null;
  return AnalysisTicketStatusViewSchema.parse({
    ticketId,
    status: r.status,
    updatedAt: toIso(r.updated_at),
    deferred,
  });
}

/**
 * 콜백과 **동일 본문**. 아직 답장이 없으면 null(라우트가 204).
 *
 * ⚠️ `fromJsonb` 를 지나간다 — 이 경로는 코어가 **권위 있는 본문**을 되읽는 자리다(스펙 §7.3 ②).
 *    이중 인코딩 기간에 저장된 행을 그대로 돌려주면 코어가 객체 대신 **문자열**을 받아 답장을
 *    통째로 거부한다. 새 행에는 무동작이다(`app/db.ts` jsonb 바인딩 규약).
 */
export async function reply(q: Queryable, ticketId: string): Promise<unknown | null> {
  const r = one(await q.query<{ reply: unknown }>("SELECT reply FROM analysis_tickets WHERE ticket_id=$1", [ticketId]));
  if (!r) return null;
  return fromJsonb(r.reply) ?? null;
}

export async function exists(q: Queryable, ticketId: string): Promise<boolean> {
  return one(await q.query("SELECT 1 AS ok FROM analysis_tickets WHERE ticket_id=$1", [ticketId])) !== null;
}

/**
 * 강제 종결 답장 본문 — 워커의 terminal 답장과 **같은 계약**.
 *
 * ⚠️ 이 함수의 존재 이유 = **재시도 증폭 차단**. 측정 lane 2026-08-26 실측: 리퍼가 컬럼만 바꾸고
 * (`status='failed'`) `reply` 를 그대로 뒀더니, 직전 답장이 deferred 면 원장의 답장이 deferred 로
 * 잔존했다. 코어는 종결 판정을 **상태 컬럼이 아니라 답장 본문의 status** 로 하므로 그 티켓을
 * retryable 로 읽고 재발행했고, 재발행은 attempt 를 올려 **새 티켓 = 모듈의 시도 예산 리셋**이었다.
 * 즉 lane 이 "포기했다"고 쓴 캡이 코어 계층에서 통째로 무력화됐다(리스 150,965회 / 완주 7,268건).
 *
 * ⚠️ `finishedAt` 은 반드시 **UTC 로 정규화**한다 — 코어 스키마가 offset 을 불허(`Z` 만)하므로
 * DB 세션 타임존이 UTC 가 아니면 계약 파싱이 깨진다.
 */
export function terminalReplyBody(args: {
  ticketId: string;
  traceId: string;
  analysisVersion: string;
  status: "failed" | "cancelled";
  finishedAt: Date;
  failureReason: string | null;
  terminalReason?: AnalysisTerminalReason;
}): AnalysisReply {
  return AnalysisReplySchema.parse({
    version: 1,
    ticketId: args.ticketId,
    traceId: args.traceId,
    status: args.status,
    finishedAt: iso(args.finishedAt),
    analysisVersion: args.analysisVersion,
    result: null,
    evidence: null,
    deferred: null,
    failureReason: (args.failureReason ?? "terminated by analysis lane").slice(0, 512),
    terminalReason: args.terminalReason ?? "permanent",
  });
}

/**
 * 아웃박스에 싣는 **doorbell 본문**(C-8).
 *
 * ⚠️ 초판은 답장 **전체**를 실었다. 그건 `worker/callbacks.ts` 머리말("콜백은 신호일 뿐이고
 *    권위 있는 본문은 코어가 `GET …/reply` 로 되읽는다", 스펙 §7.3 ②)과 어긋나는 코드였고,
 *    대가가 셋이다:
 *      ① **결과 본문이 한 벌 더 저장된다** — `analysis_tickets.reply`(완주 답장은 턴 분석 전체)와
 *         같은 것이 `analysis_callback_outbox.body` 에 복제된다. 티켓 수만큼.
 *      ② **그 본문이 인그레스 없는 방향(lane → 코어)의 HTTP 바디로 나간다.** 신호에 결과를
 *         실을 이유가 없다 — 코어 라우트는 `{ticketId,status}` 만 읽고 나머지는 passthrough 로
 *         버린다(`app/api/internal/analysis-callback/route.ts` `CallbackBodySchema`).
 *      ③ 답장이 클수록 콜백 POST 가 느려지고, 재시도 5회가 그만큼 곱해진다.
 *
 * 그래서 **코어가 실제로 읽는 것 + 상관관계 축(traceId)** 만 보낸다. `version` 은 계약 봉투를
 * 유지하려고 남긴다(코어 스키마는 `.passthrough()` 라 여분 필드를 허용한다).
 */
export function callbackBody(rep: AnalysisReply): {
  version: 1;
  ticketId: string;
  traceId: string;
  status: AnalysisReply["status"];
} {
  return { version: 1, ticketId: rep.ticketId, traceId: rep.traceId, status: rep.status };
}

/** 아웃박스 upsert — 본문은 `callbackBody`(신호)다. 두 호출자(writeReply·settle)가 같은 것을 쓴다. */
async function enqueueCallback(tx: Queryable, ticketId: string, url: string, rep: AnalysisReply): Promise<void> {
  // 아웃박스 규약(at-least-once, 코어는 ticketId 로 멱등).
  await tx.query(
    `INSERT INTO analysis_callback_outbox (ticket_id, url, body) VALUES ($1,$2,$3::jsonb)
       ON CONFLICT (ticket_id) DO UPDATE SET body=EXCLUDED.body, attempts=0, next_at=now(), delivered_at=NULL, last_error=NULL`,
    [ticketId, url, callbackBody(rep)],
  );
}

async function writeReply(tx: Queryable, ticketId: string, body: AnalysisReply, callbackUrl: string | null): Promise<void> {
  await tx.query("UPDATE analysis_tickets SET reply=$2::jsonb WHERE ticket_id=$1", [ticketId, body]);
  if (callbackUrl) await enqueueCallback(tx, ticketId, callbackUrl, body);
}

export async function cancel(tx: Queryable, ticketId: string): Promise<string | null> {
  const r = one(
    await tx.query<Row>(
      `UPDATE analysis_tickets
          SET status='cancelled', updated_at=now(), finished_at=now(),
              terminal_reason='permanent',
              failure_reason=coalesce(failure_reason,'cancelled by core')
        WHERE ticket_id=$1 AND status IN ('queued','deferred','leased','running')
        RETURNING trace_id, analysis_version, callback_url, finished_at, failure_reason`,
      [ticketId],
    ),
  );
  if (!r) {
    const cur = one(await tx.query<{ status: string }>("SELECT status FROM analysis_tickets WHERE ticket_id=$1", [ticketId]));
    return cur ? cur.status : null; // 이미 터미널이면 그 상태를 그대로 돌려준다(멱등)
  }
  const body = terminalReplyBody({
    ticketId,
    traceId: String(r.trace_id),
    analysisVersion: String(r.analysis_version),
    status: "cancelled",
    finishedAt: new Date(toIso(r.finished_at)),
    failureReason: r.failure_reason === null || r.failure_reason === undefined ? null : String(r.failure_reason),
  });
  await writeReply(tx, ticketId, body, (r.callback_url as string | null) ?? null);
  await tx.query(
    "INSERT INTO analysis_ticket_events (ticket_id, actor, from_status, to_status, detail) VALUES ($1,'api',NULL,'cancelled',$2::jsonb)",
    [ticketId, { reason: "core cancel" }],
  );
  return "cancelled";
}

// ---- 워커 쪽 ---------------------------------------------------------------

/** 픽 후보에서 제외하는 상태 술어는 `migrations/0002` 의 부분 인덱스와 **글자 그대로** 같아야 한다. */
export async function leaseBatch(tx: Queryable, opts: LeaseOptions): Promise<LeasedTicket[]> {
  const token = crypto.randomUUID();
  const rows = await tx.query<LeasedTicket>(
    `WITH cand AS (
       (SELECT ticket_id FROM analysis_tickets
         WHERE status='queued'
           AND deadline_at > now() + make_interval(secs => $5)
           AND attempt_count < $6
           AND ($3 OR priority='manual')
         ORDER BY (priority='manual') DESC, next_eligible_at, created_at LIMIT $4)
       UNION ALL
       (SELECT ticket_id FROM analysis_tickets
         WHERE status='deferred' AND next_eligible_at<=now()
           AND deadline_at > now() + make_interval(secs => $5)
           AND attempt_count < $6
           AND ($3 OR priority='manual')
         ORDER BY next_eligible_at, (priority='manual') DESC, created_at LIMIT $4)
     ), pick AS (
       SELECT ticket_id FROM analysis_tickets
        WHERE ticket_id IN (SELECT ticket_id FROM cand)
        ORDER BY (priority='manual') DESC, next_eligible_at, created_at
        FOR UPDATE SKIP LOCKED
        LIMIT $4
     )
     UPDATE analysis_tickets t
        SET status='leased', lease_token=$1, leased_until=now()+make_interval(secs => $7),
            leased_by=$2, attempt_count=attempt_count+1, updated_at=now()
       FROM pick WHERE t.ticket_id=pick.ticket_id
     RETURNING t.ticket_id, t.trace_id, t.request, t.attempt_count, t.deadline_at, t.callback_url,
               t.lease_token, t.lease_elapsed_s, t.context_version, t.turn_run_id, t.analysis_version`,
    [token, opts.workerId, opts.allowScheduled, opts.limit, opts.minRunwaySeconds, opts.maxAttempts, opts.ttlSeconds],
  );
  // ⚠️ `request` 의 **유일한 읽기 지점**이다 — 여기서 정규화해야 워커의 `…Schema.parse(row.request)`
  //    가 이중 인코딩된 과거 행에서도 산다(그 parse 가 라이브 전량 실패의 지점이었다).
  const normalized = rows.map((r) => ({ ...r, request: fromJsonb(r.request) }));
  const kept = await dropDuplicatesOfCompleted(tx, normalized, opts.workerId);
  for (const r of kept) {
    await tx.query(
      "INSERT INTO analysis_ticket_events (ticket_id, actor, from_status, to_status, detail) VALUES ($1,$2,NULL,'leased',$3::jsonb)",
      [r.ticket_id, opts.workerId, { attempt: Number(r.attempt_count), batch: kept.length }],
    );
  }
  return kept;
}

/**
 * **이미 완주한 턴의 재발행분은 실행 전에 끊는다 (비용 0).**
 *
 * 측정 lane 이 `_drop_duplicates_of_completed` 로 같은 문을 닫았다 — 거기서는 중복 완주가 프록시
 * GB 와 브라우저 시간이었고, 여기서는 **유료 LLM 콜**이다. 각 티켓은 정상 완주하므로 사람 눈에도
 * 기존 게이지에도 안 걸리고 **비용에서만 뒤늦게 보인다**(측정 `duplicate_completions_1d` 의 경위).
 *
 * ⚠️ 이것은 exactly-once 가드가 **아니다** — 그것은 코어 아웃박스 원장의 UNIQUE 가 맡는다
 * (스펙 §7.1 가드 3겹 ①). 여기는 **비용 가드**이고, 코어가 정당하게 attempt 를 올려 재발행한
 * 경우와 구분할 수 없으므로 **보수적으로 판정한다**: 같은 (turn_run_id, analysis_version) 이
 * 최근 창 안에 `completed` 로 끝나 있을 때만 취소한다.
 *
 * ⚠️ **`manual` 은 이 가드의 대상이 아니다** (측정 lane 동일). manual 은 사람이 "저 턴을 다시
 *    분석해 달라" 고 누른 것이라 **직전 완주가 존재하는 것이 정상**이다 — 그것을 중복으로 보고
 *    취소하면 재분석 기능이 조용히 죽는다(티켓은 `cancelled` 로 정상 종결되고 답장도 계약을
 *    지키므로 코어도 사람도 실패로 못 읽는다. 정확히 잡기 어려운 형태의 결함이다).
 *    스케줄 재발행만 끊는다 — 거기엔 사람의 의도가 없다.
 *
 * ⚠️ 룩백 창은 **24h**(측정 lane 동일). 6h 는 케이던스 하루 한 번 축과 어긋나 "어제 완주한 턴의
 *    오늘 재발행"을 통과시킨다 — 잡으려는 것이 바로 그것이다.
 */
export const DUPLICATE_LOOKBACK_SECONDS = 24 * 3600;
export const DUPLICATE_CANCEL_REASON = "duplicate of completed turn analysis";

export async function dropDuplicatesOfCompleted(
  tx: Queryable,
  rows: LeasedTicket[],
  workerId: string,
): Promise<LeasedTicket[]> {
  if (rows.length === 0) return rows;
  const ids = rows.map((r) => r.ticket_id);
  const dups = await tx.query<{ ticket_id: string }>(
    `SELECT t.ticket_id FROM analysis_tickets t
      WHERE t.ticket_id = ANY($1::uuid[])
        AND t.priority = 'scheduled'
        AND EXISTS (
          SELECT 1 FROM analysis_tickets d
           WHERE d.status='completed'
             AND d.finished_at > now() - make_interval(secs => $2)
             AND d.ticket_id <> t.ticket_id
             AND d.turn_run_id = t.turn_run_id
             AND d.analysis_version = t.analysis_version)`,
    [ids, DUPLICATE_LOOKBACK_SECONDS],
  );
  if (dups.length === 0) return rows;
  const dupIds = new Set(dups.map((d) => d.ticket_id));
  for (const tid of dupIds) {
    const r = one(
      await tx.query<Row>(
        `UPDATE analysis_tickets
            SET status='cancelled', updated_at=now(), finished_at=now(),
                terminal_reason='permanent', failure_reason=$2
          WHERE ticket_id=$1 AND status IN ('queued','deferred','leased','running')
          RETURNING trace_id, analysis_version, callback_url, finished_at`,
        [tid, DUPLICATE_CANCEL_REASON],
      ),
    );
    if (!r) continue;
    await writeReply(
      tx,
      tid,
      terminalReplyBody({
        ticketId: tid,
        traceId: String(r.trace_id),
        analysisVersion: String(r.analysis_version),
        status: "cancelled",
        finishedAt: new Date(toIso(r.finished_at)),
        failureReason: DUPLICATE_CANCEL_REASON,
      }),
      (r.callback_url as string | null) ?? null,
    );
    await tx.query(
      "INSERT INTO analysis_ticket_events (ticket_id, actor, from_status, to_status, detail) VALUES ($1,$2,'leased','cancelled',$3::jsonb)",
      [tid, workerId, { reason: DUPLICATE_CANCEL_REASON }],
    );
  }
  return rows.filter((r) => !dupIds.has(r.ticket_id));
}

export async function markRunning(tx: Queryable, ticketId: string, token: string): Promise<boolean> {
  const r = one(
    await tx.query(
      "UPDATE analysis_tickets SET status='running', updated_at=now() WHERE ticket_id=$1 AND lease_token=$2 AND status='leased' RETURNING 1 AS ok",
      [ticketId, token],
    ),
  );
  if (r) {
    await tx.query(
      "INSERT INTO analysis_ticket_events (ticket_id, actor, from_status, to_status) VALUES ($1,'worker','leased','running')",
      [ticketId],
    );
  }
  return r !== null;
}

/**
 * 리스 갱신. 실패(= 다른 주인/취소됨/누적 상한 초과)면 워커는 **실행을 중단해야 한다**.
 *
 * 누적 상한(`lease_elapsed_s > cap`)이 이 함수 안에 있는 이유: 갱신을 멈추는 판정은 DB 가
 * 원자적으로 해야 한다. 워커 프로세스가 자기 메모리로 세면 재기동 때 카운터가 0 으로 돌아가
 * 포이즌 유닛이 영원히 산다.
 *
 * ⚠️ **누적에 더하는 값은 하트비트 간격(60s)이지 리스 TTL(1,200s)이 아니다.**
 *    초판은 TTL 을 더했다 — 60초마다 1,200 을 적립하니 **2분 만에** 누적 2,400s 상한에 닿아
 *    갱신이 끊겼다. 그 다음은 리스 만료 → 리퍼가 큐로 복귀 → attempt+1 → 재실행이고, 재실행은
 *    매번 **유료 LLM 콜**이다. 즉 "포이즌 유닛이 워커를 영원히 잡는 것"을 막으려던 가드가
 *    정상 유닛(1턴 최악 p95 ~256s)까지 2분에서 끊어 **실비를 곱하는** 장치가 돼 있었다.
 *    두 값은 **다른 축**이다: TTL 은 "언제까지 내 것인가"(`leased_until`), 누적은 "실제로
 *    얼마나 오래 쥐고 있었나". 그래서 더하는 값은 **갱신 사이에 실제로 흐른 시간**의 대리값인
 *    하트비트 간격이다. 정직하게: 틱이 밀리면 누적이 실제보다 **적게** 잡힌다(상한이 늦게
 *    걸리는 방향 = 안전한 쪽). 정확한 벽시계가 필요해지면 `lease_started_at` 컬럼을 추가해
 *    `now() - lease_started_at` 으로 바꾼다 — 지금은 컬럼 하나를 더 만들 값이 없다.
 */
export async function heartbeat(
  tx: Queryable,
  ticketId: string,
  token: string,
  ttlSeconds: number,
  cumulativeCapSeconds: number,
  heartbeatSeconds: number,
): Promise<boolean> {
  const r = one(
    await tx.query(
      `UPDATE analysis_tickets
          SET leased_until=now()+make_interval(secs => $3), updated_at=now(),
              lease_elapsed_s = lease_elapsed_s + $5
        WHERE ticket_id=$1 AND lease_token=$2 AND status IN ('leased','running')
          AND lease_elapsed_s < $4
        RETURNING 1 AS ok`,
      [ticketId, token, ttlSeconds, cumulativeCapSeconds, heartbeatSeconds],
    ),
  );
  return r !== null;
}

/**
 * 답장 확정 + 아웃박스 적재 — **한 트랜잭션**. 리스 주인만 가능.
 *
 * `deferred` 는 `retryAfterMs` 를 절대 시각으로 바꿔 `next_eligible_at` 에 넣는다
 * (계약의 두 자료형이 갈리는 지점 — `contracts/v1.ts` 의 두 deferred 스키마 주석 참조).
 */
export async function settle(
  tx: Queryable,
  ticketId: string,
  token: string,
  rep: AnalysisReply,
): Promise<boolean> {
  if (rep.status === "deferred") {
    if (!rep.deferred) throw new Error("deferred reply requires deferred info");
    // ⚠️ 시도 횟수는 **원장이 정본**이다. 답장의 `deferred` 에는 `attemptCount` 가 없다
    //    (코어 정본 `AnalysisDeferredInfoSchema` 3필드) — 초판은 답장에서 읽었다.
    const r = one(
      await tx.query<{ attempt_count: number }>(
        `UPDATE analysis_tickets
            SET status='deferred', next_eligible_at=now()+make_interval(secs => $3),
                failure_class=$4, failure_reason=$5, reply=$6::jsonb,
                lease_token=NULL, leased_until=NULL, updated_at=now()
          WHERE ticket_id=$1 AND lease_token=$2 AND status IN ('leased','running')
          RETURNING attempt_count`,
        [ticketId, token, rep.deferred.retryAfterMs / 1000, rep.deferred.failureClass, rep.deferred.detail, rep],
      ),
    );
    if (!r) return false;
    await tx.query(
      "INSERT INTO analysis_ticket_events (ticket_id, actor, from_status, to_status, detail) VALUES ($1,'worker','running','deferred',$2::jsonb)",
      [ticketId, { failureClass: rep.deferred.failureClass, attempt: Math.max(1, Number(r.attempt_count)) }],
    );
  } else {
    const r = one(
      await tx.query(
        `UPDATE analysis_tickets
            SET status=$3, finished_at=$4::timestamptz, failure_reason=$5, terminal_reason=$6,
                reply=$7::jsonb, lease_token=NULL, leased_until=NULL, updated_at=now()
          WHERE ticket_id=$1 AND lease_token=$2 AND status IN ('leased','running')
          RETURNING 1 AS ok`,
        [ticketId, token, rep.status, rep.finishedAt, rep.failureReason, rep.terminalReason, rep],
      ),
    );
    if (!r) return false;
    await tx.query(
      "INSERT INTO analysis_ticket_events (ticket_id, actor, from_status, to_status, detail) VALUES ($1,'worker','running',$2,$3::jsonb)",
      [ticketId, rep.status, { terminalReason: rep.terminalReason }],
    );
  }
  const cb = one(
    await tx.query<{ callback_url: string | null }>("SELECT callback_url FROM analysis_tickets WHERE ticket_id=$1", [ticketId]),
  );
  if (cb?.callback_url) await enqueueCallback(tx, ticketId, cb.callback_url, rep);
  return true;
}

// ---- 리퍼 ------------------------------------------------------------------

/**
 * 전역 스윕 클레임. try-lock 은 **동시성**만 막는다 — 워커 타이머가 기동 시점 기준이라 fleet 에서
 * 엇갈리고, 리퍼 트랜잭션은 ~ms 라 엇갈린 틱이 전부 완주한다(측정 lane 0.2s 차 2틱 실증).
 * 이 UPDATE 가 "마지막 전역 스윕 후 interval 경과"를 원자적으로 클레임한다.
 *
 * ⚠️ **세션 스코프 `pg_try_advisory_lock` 을 쓰면 안 된다** — RDS Proxy 가 그 커넥션을 DB
 * 커넥션에 영구 피닝한다. 트랜잭션 스코프는 커밋에서 풀려 피닝을 유발하지 않는다.
 */
export const REAPER_LEADER_LOCK = 0x5ea9e13;

export async function claimSweep(tx: Queryable, intervalSeconds: number): Promise<boolean> {
  const got = one(await tx.query<{ got: boolean }>("SELECT pg_try_advisory_xact_lock($1) AS got", [REAPER_LEADER_LOCK]));
  if (!got?.got) return false;
  const claimed = one(
    await tx.query(
      `UPDATE analysis_reaper_state SET last_sweep_at = now()
        WHERE id = 1 AND last_sweep_at <= now() - make_interval(secs => $1)
        RETURNING 1 AS ok`,
      [intervalSeconds * 0.9],
    ),
  );
  return claimed !== null;
}

/**
 * **스윕 1회의 행 상한**(B7). 네 스윕 전부가 이것을 받는다.
 *
 * ⚠️ 왜 필요한가: 리퍼는 워커 poll 루프 안에서 `await` 된다(`worker/main.ts` 의 `reapOnce`).
 *    상한이 없으면 적체가 큰 순간 — 장애 복구 직후, 대량 마감 초과, 함대 재기동 — 한 틱이
 *    **원장 전체를 한 트랜잭션에서** 돌면서 그동안 그 워커는 **리스를 하나도 집지 못한다.**
 *    게다가 세 스윕은 행마다 답장 UPDATE + 아웃박스 upsert + 이벤트 INSERT 를 하므로 비용이
 *    행 수에 선형이다(1행 = 쿼리 3~4개). 남은 것은 다음 틱이 가져간다 — 리퍼는 **진행하기만
 *    하면 되고 한 번에 끝낼 이유가 없다**(각 스윕은 처리한 행을 자기 술어 밖으로 내보내므로
 *    다음 틱이 반드시 다른 행을 본다 = 라이브락이 없다).
 */
export const DEFAULT_SWEEP_BATCH = 500;

/** 만료된 리스를 큐로 되돌린다. **attempt 는 되돌리지 않는다** — 실비가 이미 나갔을 수 있다. */
export async function reapExpiredLeases(tx: Queryable, limit: number = DEFAULT_SWEEP_BATCH): Promise<number> {
  const rows = await tx.query<{ ticket_id: string }>(
    `UPDATE analysis_tickets
        SET status='queued', lease_token=NULL, leased_until=NULL, updated_at=now()
      WHERE ticket_id IN (
        SELECT ticket_id FROM analysis_tickets
         WHERE status IN ('leased','running') AND leased_until < now()
         ORDER BY leased_until
         LIMIT $1)
      RETURNING ticket_id`,
    [limit],
  );
  for (const r of rows) {
    await tx.query(
      "INSERT INTO analysis_ticket_events (ticket_id, actor, from_status, to_status, detail) VALUES ($1,'reaper','leased','queued',$2::jsonb)",
      [r.ticket_id, { reason: "lease expired" }],
    );
  }
  return rows.length;
}

/**
 * 마감 초과분에 `deferred(deadline)` 답장을 쓴다. **terminal 로 만들지 않는다** — 코어가
 * 취소·재발행할 여지를 남긴다. 그 여지를 코어가 안 쓰면 `reapExpired` 가 grace 후 GC 한다
 * (측정 lane 이 이 2단계를 안 두었다가 `deferred(deadline)` 4,260건이 영원히 쌓인 전례 — 0013).
 */
export async function expireDeadlines(tx: Queryable, limit: number = DEFAULT_SWEEP_BATCH): Promise<number> {
  const rows = await tx.query<Row>(
    // ⚠️ 서브쿼리 술어는 `migrations/0005` 의 `analysis_tickets_deadline_sweep_all_idx` 와
    //    **글자 그대로** 같아야 한다(플래너의 함의 증명은 동일 표현식에서만 확실하다).
    //    `ORDER BY deadline_at` 도 그 인덱스 키와 같다 — LIMIT 을 정렬 비용으로 되갚지 않는다.
    `UPDATE analysis_tickets
        SET status='deferred', failure_class='deadline',
            failure_reason=coalesce(failure_reason,'deadline exceeded'),
            lease_token=NULL, leased_until=NULL, updated_at=now()
      WHERE ticket_id IN (
        SELECT ticket_id FROM analysis_tickets
         WHERE status IN ('queued','deferred','leased','running')
           AND deadline_at <= now()
           AND failure_class IS DISTINCT FROM 'deadline'
         ORDER BY deadline_at
         LIMIT $1)
      RETURNING ticket_id, trace_id, analysis_version, callback_url, attempt_count`,
    [limit],
  );
  for (const r of rows) {
    const body = AnalysisReplySchema.parse({
      version: 1,
      ticketId: r.ticket_id,
      traceId: r.trace_id,
      status: "deferred",
      finishedAt: iso(new Date()),
      analysisVersion: String(r.analysis_version),
      result: null,
      evidence: null,
      deferred: {
        failureClass: "deadline",
        retryAfterMs: 0,
        detail: "deadline exceeded",
      },
      failureReason: null,
      terminalReason: null,
    });
    await writeReply(tx, String(r.ticket_id), body, (r.callback_url as string | null) ?? null);
    await tx.query(
      "INSERT INTO analysis_ticket_events (ticket_id, actor, from_status, to_status, detail) VALUES ($1,'reaper',NULL,'deferred',$2::jsonb)",
      [r.ticket_id, { failureClass: "deadline" }],
    );
  }
  return rows.length;
}

/** grace 지난 `deferred(deadline)` 을 terminal 로 GC (측정 0013 의 `reap_expired` 동형). */
export async function reapExpired(
  tx: Queryable,
  graceSeconds: number,
  limit: number = DEFAULT_SWEEP_BATCH,
): Promise<number> {
  const rows = await tx.query<Row>(
    // 술어는 `migrations/0002` 의 `analysis_tickets_expired_sweep_idx` 와 같은 표현식이다.
    `UPDATE analysis_tickets
        SET status='failed', finished_at=now(), terminal_reason='deadline_exceeded', updated_at=now()
      WHERE ticket_id IN (
        SELECT ticket_id FROM analysis_tickets
         WHERE status IN ('queued','deferred')
           AND failure_class = 'deadline'
           AND deadline_at <= now() - make_interval(secs => $1)
         ORDER BY deadline_at
         LIMIT $2)
      RETURNING ticket_id, trace_id, analysis_version, callback_url, finished_at, failure_reason`,
    [graceSeconds, limit],
  );
  for (const r of rows) {
    await writeReply(
      tx,
      String(r.ticket_id),
      terminalReplyBody({
        ticketId: String(r.ticket_id),
        traceId: String(r.trace_id),
        analysisVersion: String(r.analysis_version),
        status: "failed",
        finishedAt: new Date(toIso(r.finished_at)),
        failureReason: (r.failure_reason as string | null) ?? "deadline exceeded",
        terminalReason: "deadline_exceeded",
      }),
      (r.callback_url as string | null) ?? null,
    );
    await tx.query(
      "INSERT INTO analysis_ticket_events (ticket_id, actor, from_status, to_status, detail) VALUES ($1,'reaper',NULL,'failed',$2::jsonb)",
      [r.ticket_id, { terminalReason: "deadline_exceeded" }],
    );
  }
  return rows.length;
}

/**
 * lane `maxAttempts` 소진분을 terminal 로 닫는다 — `terminalReason='cap_exhausted'`.
 * **"재제출하면 성공할 수 있다"** 는 뜻이고, 코어는 원장 `attempt ≤ 3` 안에서만 재발행한다(D5).
 */
export async function reapChronic(
  tx: Queryable,
  maxAttempts: number,
  limit: number = DEFAULT_SWEEP_BATCH,
): Promise<number> {
  const rows = await tx.query<Row>(
    // 술어는 `migrations/0002` 의 `analysis_tickets_chronic_sweep_idx` 와 같은 표현식이다.
    `UPDATE analysis_tickets
        SET status='failed', finished_at=now(), terminal_reason='cap_exhausted', updated_at=now()
      WHERE ticket_id IN (
        SELECT ticket_id FROM analysis_tickets
         WHERE status IN ('queued','deferred') AND attempt_count >= $1
         ORDER BY attempt_count
         LIMIT $2)
      RETURNING ticket_id, trace_id, analysis_version, callback_url, finished_at, failure_reason, attempt_count`,
    [maxAttempts, limit],
  );
  for (const r of rows) {
    await writeReply(
      tx,
      String(r.ticket_id),
      terminalReplyBody({
        ticketId: String(r.ticket_id),
        traceId: String(r.trace_id),
        analysisVersion: String(r.analysis_version),
        status: "failed",
        finishedAt: new Date(toIso(r.finished_at)),
        failureReason: `lane attempts exhausted (${Number(r.attempt_count)})`,
        terminalReason: "cap_exhausted",
      }),
      (r.callback_url as string | null) ?? null,
    );
    await tx.query(
      "INSERT INTO analysis_ticket_events (ticket_id, actor, from_status, to_status, detail) VALUES ($1,'reaper',NULL,'failed',$2::jsonb)",
      [r.ticket_id, { terminalReason: "cap_exhausted", attempts: Number(r.attempt_count) }],
    );
  }
  return rows.length;
}

export interface SweepCounts {
  leases: number;
  deadlines: number;
  expired: number;
  chronic: number;
  /**
   * **네 스윕 중 하나라도 상한까지 채웠다** = 아직 남았다(B7). 이 틱에서 더 밀지 않고 다음 틱에
   * 넘긴다 — 리퍼는 진행하기만 하면 되고, 그 사이 워커는 리스를 집는다.
   * ⚠️ "정확히 상한" 은 **남았다는 보장이 아니라 남았을 수 있다는 신호**다. 딱 맞아떨어진
   *    경우에도 true 가 되지만, 그 오검지의 비용은 다음 틱의 빈 스윕 하나뿐이다.
   */
  remaining: boolean;
}

export interface SweepOptions {
  reapIntervalSeconds: number;
  deadlineGraceSeconds: number;
  maxAttempts: number;
  /** 스윕 1회의 행 상한. 미지정이면 `DEFAULT_SWEEP_BATCH`. */
  batchLimit?: number;
}

/**
 * 리퍼 1회 — 클레임부터 네 스윕까지 **한 트랜잭션**. 클레임이 실패하면 `null`(이번 틱은 남의 것).
 *
 * ⚠️ **순서가 판정을 바꾼다: `reapExpired`(마감) → `reapChronic`(attempt 소진).**
 *    한 티켓이 둘 다 해당할 수 있다 — 마감을 넘긴 채 재시도를 소진한 티켓. 어느 쪽이 먼저
 *    잡느냐가 `terminal_reason` 을 결정하고, 그 값이 **코어의 재발행 여부**를 가른다:
 *      · `cap_exhausted`  = "재제출하면 성공할 수 있다" → 코어가 원장 attempt ≤ 3 안에서 재발행
 *      · `deadline_exceeded` = 그 창은 이미 지났다 → 재발행해도 같은 자리에서 또 죽는다
 *    chronic 이 먼저 돌면 마감 초과분이 `cap_exhausted` 로 표시돼 **코어가 죽은 티켓을 다시
 *    발행하고 LLM 실비를 또 태운다.** 초판이 그 순서였다(`worker/main.ts` reapOnce).
 *    마감이 더 강한 사실이므로 먼저 쓴다.
 *
 * `expireDeadlines`(스탬프) → `reapExpired`(grace 후 GC)의 2단계 순서도 그대로다(측정 0013).
 */
export async function sweep(tx: Queryable, opts: SweepOptions): Promise<SweepCounts | null> {
  if (!(await claimSweep(tx, opts.reapIntervalSeconds))) return null;
  const limit = Math.max(1, Math.trunc(opts.batchLimit ?? DEFAULT_SWEEP_BATCH));
  const leases = await reapExpiredLeases(tx, limit);
  const deadlines = await expireDeadlines(tx, limit);
  const expired = await reapExpired(tx, opts.deadlineGraceSeconds, limit);
  const chronic = await reapChronic(tx, opts.maxAttempts, limit);
  return {
    leases,
    deadlines,
    expired,
    chronic,
    remaining: leases >= limit || deadlines >= limit || expired >= limit || chronic >= limit,
  };
}

// ---- 보존(retention) -------------------------------------------------------

/**
 * 터미널 티켓 GC 의 **리더 락**(B9/D6). 리퍼 리더 락(`REAPER_LEADER_LOCK`)과 **따로 둔다** —
 * 보존 배치가 리퍼를 막으면 안 되고, 그 반대도 마찬가지다.
 *
 * ⚠️ 세션 스코프 `pg_try_advisory_lock` 을 쓰지 않는다(RDS Proxy 영구 피닝). 트랜잭션 스코프만.
 */
export const RETENTION_LEADER_LOCK = 0x5ea9e14;

export interface RetentionOptions {
  /** `finished_at` 이 이보다 오래된 터미널 티켓을 지운다. */
  retentionDays: number;
  /** 1틱 1배치의 티켓 수 상한. */
  batchLimit: number;
}

export interface RetentionCounts {
  tickets: number;
  events: number;
  callUsage: number;
  outbox: number;
  /** 배치를 가득 채웠다 = 더 남았다. 다음 틱이 이어간다. */
  remaining: boolean;
}

/** 보존 배치의 리더 클레임. 함대에서 **한 번에 한 워커만** 지운다. */
export async function claimRetention(tx: Queryable): Promise<boolean> {
  const got = one(await tx.query<{ got: boolean }>("SELECT pg_try_advisory_xact_lock($1) AS got", [RETENTION_LEADER_LOCK]));
  return got?.got === true;
}

/**
 * 터미널 티켓과 그 부속 행을 **배치로** 지운다 (B9/D6).
 *
 * ⚠️ **자식 먼저, 부모 나중.** 세 자식 테이블(`analysis_ticket_events`·`analysis_call_usage`·
 *    `analysis_callback_outbox`)의 FK 에 `ON DELETE CASCADE` 가 **없다**(migrations 0001·0003).
 *    티켓부터 지우면 전량이 `foreign_key_violation` 으로 롤백된다 — 즉 보존 잡이 "돌긴 도는데
 *    아무것도 안 지워지는" 상태가 되고, 그건 원장이 무한히 자라는 것과 같다.
 *
 * ⚠️ 아웃박스 행도 **같이** 지운다. 미배달 행이 남아 있는 티켓은 애초에 대상이 아니다
 *    (`delivered_at IS NULL` 이면 코어가 아직 못 받았다는 유일한 증거다 — `worker/callbacks.ts`
 *    머리말). 그래서 후보 술어에서 그런 티켓을 **제외**한다.
 *
 * ⚠️ 원장 손실의 성격: `analysis_call_usage` 는 lane **운영용**이고 과금 정본은 코어
 *    `cost_ledger` 다(migrations 0003 의 뷰 COMMENT). 보존 기간을 넘긴 행을 지우는 것이
 *    "비용 기록을 버리는 것" 이 아니라는 근거가 그것이다.
 */
export async function purgeTerminalTickets(tx: Queryable, opts: RetentionOptions): Promise<RetentionCounts> {
  const limit = Math.max(1, Math.trunc(opts.batchLimit));
  const ids = (
    await tx.query<{ ticket_id: string }>(
      `SELECT ticket_id FROM analysis_tickets
        WHERE status IN ('completed','failed','cancelled')
          AND finished_at IS NOT NULL
          AND finished_at < now() - make_interval(days => $1::int)
          AND NOT EXISTS (
            SELECT 1 FROM analysis_callback_outbox o
             WHERE o.ticket_id = analysis_tickets.ticket_id AND o.delivered_at IS NULL)
        ORDER BY finished_at
        LIMIT $2`,
      [opts.retentionDays, limit],
    )
  ).map((r) => String(r.ticket_id));
  if (ids.length === 0) return { tickets: 0, events: 0, callUsage: 0, outbox: 0, remaining: false };

  const events = await tx.query("DELETE FROM analysis_ticket_events WHERE ticket_id = ANY($1::uuid[]) RETURNING 1 AS ok", [ids]);
  const usage = await tx.query("DELETE FROM analysis_call_usage WHERE ticket_id = ANY($1::uuid[]) RETURNING 1 AS ok", [ids]);
  const outbox = await tx.query("DELETE FROM analysis_callback_outbox WHERE ticket_id = ANY($1::uuid[]) RETURNING 1 AS ok", [ids]);
  const tickets = await tx.query("DELETE FROM analysis_tickets WHERE ticket_id = ANY($1::uuid[]) RETURNING 1 AS ok", [ids]);
  return {
    tickets: tickets.length,
    events: events.length,
    callUsage: usage.length,
    outbox: outbox.length,
    remaining: ids.length >= limit,
  };
}

// ---- 용량·관측 --------------------------------------------------------------

export interface QueueSnapshot {
  queueDepth: number;
  leasedUnits: number;
  oldestQueuedAgeSeconds: number | null;
  statusCounts: Record<string, number>;
}

export async function queueSnapshot(q: Queryable, minRunwaySeconds: number, maxAttempts: number): Promise<QueueSnapshot> {
  const rows = await q.query<{ status: string; n: string | number }>(
    "SELECT status, count(*) n FROM analysis_tickets GROUP BY status",
  );
  const statusCounts: Record<string, number> = {};
  for (const r of rows) statusCounts[r.status] = Number(r.n);

  // ⚠️ queueDepth 는 "지금 픽 가능한 것" 이다 — 만성 실패·마감 초과는 빼야 오토스케일이
  //    영원히 안 꺼지는 유령 깊이를 안 본다(측정 lane `queue_breakdown` 의 경위).
  const depth = one(
    await q.query<{ n: string | number; oldest: string | number | null }>(
      `SELECT count(*) n, max(extract(epoch from (now() - created_at))) oldest
         FROM analysis_tickets
        WHERE (status='queued' OR (status='deferred' AND next_eligible_at<=now()))
          AND deadline_at > now() + make_interval(secs => $1)
          AND attempt_count < $2`,
      [minRunwaySeconds, maxAttempts],
    ),
  );
  return {
    queueDepth: Number(depth?.n ?? 0),
    leasedUnits: (statusCounts.leased ?? 0) + (statusCounts.running ?? 0),
    oldestQueuedAgeSeconds: depth?.oldest === null || depth?.oldest === undefined ? null : Number(depth.oldest),
    statusCounts,
  };
}

export async function capacity(
  q: Queryable,
  args: {
    minRunwaySeconds: number;
    maxAttempts: number;
    unitConcurrency: number;
    reservedManualUnits: number;
    totalCallSlots: number;
    inflightCalls: number;
    workerCount: number;
    coordination: AnalysisCoordination;
  },
): Promise<AnalysisCapacity> {
  const snap = await queueSnapshot(q, args.minRunwaySeconds, args.maxAttempts);
  return {
    totalCallSlots: args.totalCallSlots,
    inflightCalls: args.inflightCalls,
    unitSlots: args.unitConcurrency * Math.max(1, args.workerCount),
    leasedUnits: snap.leasedUnits,
    reservedManualUnits: args.reservedManualUnits,
    queueDepth: snap.queueDepth,
    oldestQueuedAgeSeconds: snap.oldestQueuedAgeSeconds,
    workerCount: args.workerCount,
    coordination: args.coordination,
  };
}

/**
 * 오늘 **중복 완주한 턴 수**. 0 이 정상이고 >0 이면 이중 LLM 지출이 진행 중이다.
 * 측정 lane `duplicate_completions_1d` 동형 — "각 티켓은 정상 완주라 게이지가 없으면 비용에서만
 * 드러나고, 그때는 이미 하루치를 태운 뒤" 라는 같은 이유.
 */
export async function duplicateCompletions1d(q: Queryable): Promise<number> {
  const r = one(
    await q.query<{ n: string | number }>(
      `WITH g AS (
         SELECT turn_run_id, analysis_version, count(*) n
           FROM analysis_tickets
          WHERE status='completed' AND finished_at >= date_trunc('day', now())
          GROUP BY 1,2)
       SELECT count(*) n FROM g WHERE n > 1`,
    ),
  );
  return Number(r?.n ?? 0);
}

/**
 * **터미널·잔존 게이지** (골격 검증 F14).
 *
 * 기존 게이지는 전부 "지금 얼마나 밀렸나"(queueDepth·oldestQueuedAge)를 본다. 그 축은
 * **끝난 실패와 영원히 안 끝나는 대기를 못 본다**:
 *   · `failed` 터미널 — 재시도 예산을 다 태우고 죽은 유닛. 전부 **LLM 실비가 나간 뒤**다.
 *     queueDepth 에서는 이미 빠져 있어 큐만 보면 "건강해졌다" 로 읽힌다.
 *   · `deferred` 잔존 — 측정 lane 0013 의 흉터. `deferred(deadline)` 4,260건이 **아무 게이지에도
 *     안 잡힌 채** 쌓여 있었다. 여기서는 2단계 리퍼가 GC 하지만, 그 리퍼가 멈추면(리더 클레임
 *     실패·워커 0) 같은 형태가 다시 조용히 자란다. 그것을 보는 눈이 이 게이지다.
 */
export interface LaneHealthGauges {
  /** 오늘 terminal `failed` 로 닫힌 티켓 수(사유 무관). */
  failedTerminal1d: number;
  /** 사유별 — `cap_exhausted` 가 늘면 재시도 정책이, `deadline_exceeded` 가 늘면 처리율이 문제다. */
  failedCapExhausted1d: number;
  failedDeadlineExceeded1d: number;
  /** 지금 `deferred` 인 전부(정상적인 백오프 대기 포함). */
  deferredBacklog: number;
  /** 그중 **오래 움직이지 않은 것** — 0 이 정상이고 >0 이면 리퍼가 놓치고 있다. */
  deferredStale: number;
}

export async function laneHealthGauges(q: Queryable, staleAfterSeconds: number): Promise<LaneHealthGauges> {
  const r = one(
    await q.query<Record<string, string | number>>(
      `SELECT
         count(*) FILTER (WHERE status='failed' AND finished_at >= date_trunc('day', now())) AS failed_1d,
         count(*) FILTER (WHERE status='failed' AND finished_at >= date_trunc('day', now())
                            AND terminal_reason='cap_exhausted') AS failed_cap_1d,
         count(*) FILTER (WHERE status='failed' AND finished_at >= date_trunc('day', now())
                            AND terminal_reason='deadline_exceeded') AS failed_deadline_1d,
         count(*) FILTER (WHERE status='deferred') AS deferred_total,
         count(*) FILTER (WHERE status='deferred' AND updated_at <= now() - make_interval(secs => $1)) AS deferred_stale
       FROM analysis_tickets`,
      [staleAfterSeconds],
    ),
  );
  return {
    failedTerminal1d: Number(r?.failed_1d ?? 0),
    failedCapExhausted1d: Number(r?.failed_cap_1d ?? 0),
    failedDeadlineExceeded1d: Number(r?.failed_deadline_1d ?? 0),
    deferredBacklog: Number(r?.deferred_total ?? 0),
    deferredStale: Number(r?.deferred_stale ?? 0),
  };
}

// ---- 워커 게이지 (F2) --------------------------------------------------------
//
// api 는 워커의 세마포어를 볼 수 없다. 워커가 원장(`analysis_worker_gauges`, 0005)에 적고
// api 가 **신선한 행만** 합산한다. 경로 선택 근거는 0005 헤더 참조.

export interface WorkerGaugeSnapshot {
  /** 신선한 보고를 낸 워커 수. */
  workerCount: number;
  /** 신선한 보고들의 in-flight LLM 콜 합. */
  inflightCalls: number;
  /** 같은 워커들이 쥔 세마포어 상한 합(= 함대가 실제로 낼 수 있는 콜 수). */
  callSlots: number;
  leasedUnits: number;
  /** 창 밖 보고(= 죽었거나 멈춘 워커). >0 이면 아래 `known` 이 false 다. */
  staleWorkers: number;
  /**
   * 값을 **믿어도 되는가**. false = "모른다" 이지 0 이 아니다.
   *   · 행이 아예 없다 → 함대가 0 이다(정상. desired 0 이 기본 상태다) → known
   *   · 신선한 행이 있다 → 그 합이 실값 → known
   *   · stale 행만 있다 → 워커가 살아 있는지조차 모른다 → **미상**. 게이지는 행을 내지 않는다.
   */
  known: boolean;
}

/** 워커가 자기 게이지를 적는다(upsert). 실패해도 분석을 죽이면 안 된다 — 호출부가 삼킨다. */
export async function reportWorkerGauges(
  q: Queryable,
  args: { workerId: string; inflightCalls: number; callSlots: number; leasedUnits: number; laneRevision: string },
): Promise<void> {
  await q.query(
    `INSERT INTO analysis_worker_gauges (worker_id, inflight_calls, call_slots, leased_units, lane_revision, reported_at)
     VALUES ($1,$2,$3,$4,$5, now())
     ON CONFLICT (worker_id) DO UPDATE
        SET inflight_calls=EXCLUDED.inflight_calls, call_slots=EXCLUDED.call_slots,
            leased_units=EXCLUDED.leased_units, lane_revision=EXCLUDED.lane_revision, reported_at=now()`,
    [args.workerId, Math.max(0, Math.trunc(args.inflightCalls)), Math.max(0, Math.trunc(args.callSlots)), Math.max(0, Math.trunc(args.leasedUnits)), args.laneRevision],
  );
}

/** 정상 종료한 워커는 자기 행을 지운다 — 스케일인된 태스크가 영원히 stale 로 남지 않게. */
export async function clearWorkerGauge(q: Queryable, workerId: string): Promise<void> {
  await q.query("DELETE FROM analysis_worker_gauges WHERE worker_id=$1", [workerId]);
}

export async function workerGauges(q: Queryable, freshnessSeconds: number): Promise<WorkerGaugeSnapshot> {
  const r = one(
    await q.query<Record<string, string | number | null>>(
      `SELECT
         count(*) FILTER (WHERE reported_at > now() - make_interval(secs => $1))                AS fresh_workers,
         count(*) FILTER (WHERE reported_at <= now() - make_interval(secs => $1))               AS stale_workers,
         coalesce(sum(inflight_calls) FILTER (WHERE reported_at > now() - make_interval(secs => $1)), 0) AS inflight,
         coalesce(sum(call_slots)     FILTER (WHERE reported_at > now() - make_interval(secs => $1)), 0) AS slots,
         coalesce(sum(leased_units)   FILTER (WHERE reported_at > now() - make_interval(secs => $1)), 0) AS units
       FROM analysis_worker_gauges`,
      [freshnessSeconds],
    ),
  );
  const fresh = Number(r?.fresh_workers ?? 0);
  const stale = Number(r?.stale_workers ?? 0);
  return {
    workerCount: fresh,
    inflightCalls: Number(r?.inflight ?? 0),
    callSlots: Number(r?.slots ?? 0),
    leasedUnits: Number(r?.units ?? 0),
    staleWorkers: stale,
    known: fresh > 0 || stale === 0,
  };
}
