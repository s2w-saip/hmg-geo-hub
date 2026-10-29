// 콜백 발송기 — 아웃박스를 당겨 POST. at-least-once, 지수 백오프, 상한 후엔 남겨두고 로그만.
// 측정 lane `worker/callbacks.py` 의 이식본(배치 10 · 리스 60s · `min(600, 5·2^n)`).
//
// ⚠️ **콜백 본문에 결과를 싣지만 그것이 권위는 아니다.** 콜백은 doorbell 신호이고, 코어는
//    `GET /v1/analysis-tickets/{id}/reply` 로 본문을 **되읽는다**(스펙 §7.3 ②). 그래서
//    콜백 본문에 서명이 없다는 사실이 무해해진다 — 콜백은 "뭔가 끝났다"만 말하고 권위 있는
//    본문은 mTLS GET 으로 온다. 측정 lane 이 이미 그렇게 해결한 문제를 되풀이하지 않는다.
//
// ⚠️ **본문 서명이 없는 것과 호출자 인증이 없는 것은 다른 문제다**(운영 결정 2026-09-12).
//    코어 → lane 은 mTLS 인그레스가 인증하지만 lane → 코어는 그 앞에 인그레스가 없다.
//    그래서 이 POST 에 `x-scope-internal-token` 헤더를 붙인다 — 코어 라우트가 timing-safe
//    비교하고 불일치는 **404**(라우트 은닉)다. 근거·비대칭의 이유는 `worker/internal-token.ts`.
//
// ⚠️ 상한(5회)을 넘긴 행은 **지우지 않는다.** 코어의 폴링 백스톱이 `submitted` 인 채 오래된 행을
//    주기적으로 GET 하므로(스펙 §7.3), 아웃박스에 남아 있는 것이 "배달 못 함"의 유일한 증거다.
import { settings } from "../app/settings.ts";
import { fromJsonb, type Db } from "../app/db.ts";
import { internalAuthHeaders } from "./internal-token.ts";

export interface PumpResult {
  sent: number;
  failed: number;
}

export async function pumpOnce(
  db: Db,
  now: () => number = Date.now,
  // 기본값은 라이브 설정. 인자로 빼 둔 것은 테스트가 **env 를 만지지 않고**(settings 는 import
  // 시점에 얼어붙는다) 헤더 유무 양쪽을 볼 수 있게 하려는 것이다.
  internalToken: string | null = settings.internalCallbackToken,
): Promise<PumpResult> {
  const token = crypto.randomUUID();
  const rows = await db.query<{
    ticket_id: string;
    url: string;
    body: unknown;
    attempts: number;
    lease_token: string;
  }>(
    `UPDATE analysis_callback_outbox o
        SET lease_token=$1, leased_until=now()+interval '60 seconds'
      WHERE ticket_id IN (
        SELECT ticket_id FROM analysis_callback_outbox
         WHERE delivered_at IS NULL AND next_at<=now()
           AND (leased_until IS NULL OR leased_until<now())
           AND attempts < $2
         ORDER BY next_at
         FOR UPDATE SKIP LOCKED LIMIT 10)
      RETURNING ticket_id, url, body, attempts, lease_token`,
    [token, settings.callbackMaxAttempts],
  );

  let sent = 0;
  let failed = 0;
  for (const r of rows) {
    let err: string | null = null;
    const startedAt = now();
    try {
      const res = await fetch(r.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-ticket-id": r.ticket_id,
          // 토큰이 없으면 **헤더 자체가 없다** — 빈 값을 보내면 코어에서 불일치 404 가 되고
          // "미배선"과 "값이 틀림"이 로그에서 구분되지 않는다(internal-token.ts).
          ...internalAuthHeaders(internalToken),
        },
        // ⚠️ `fromJsonb` 선행 — 이중 인코딩된 아웃박스 행은 드라이버가 **문자열**을 준다.
        //    그대로 stringify 하면 코어에 JSON 문자열 리터럴이 날아가 본문이 거부된다
        //    (`app/db.ts` jsonb 바인딩 규약).
        body: JSON.stringify(fromJsonb(r.body)),
        signal: AbortSignal.timeout(settings.callbackTimeoutSeconds * 1000),
      });
      if (res.status >= 300) err = `http ${res.status}`;
    } catch (e) {
      err = e instanceof Error ? e.name : String(e);
    }
    if (err === null) {
      await db.query(
        `UPDATE analysis_callback_outbox
            SET delivered_at=now(), attempts=attempts+1, lease_token=NULL, leased_until=NULL, last_error=NULL
          WHERE ticket_id=$1 AND lease_token=$2`,
        [r.ticket_id, r.lease_token],
      );
      sent += 1;
    } else {
      const backoffSeconds = Math.min(600, 5 * 2 ** Number(r.attempts));
      await db.query(
        `UPDATE analysis_callback_outbox
            SET attempts=attempts+1, next_at=now()+make_interval(secs => $3), last_error=$4,
                lease_token=NULL, leased_until=NULL
          WHERE ticket_id=$1 AND lease_token=$2`,
        [r.ticket_id, r.lease_token, backoffSeconds, `${err} (${now() - startedAt}ms)`.slice(0, 200)],
      );
      failed += 1;
    }
  }
  return { sent, failed };
}

/**
 * 펌프 백오프. 측정 lane 실측: `pump_once` 를 **매 루프(~1s)** 무조건 돌리면 아웃박스가 비어도
 * `UPDATE … FOR UPDATE SKIP LOCKED` 왕복이 나가 0행에 인덱스 스캔이 100만+ 누적된다.
 *
 * 백오프만 넣으면 콜백이 최대 5초 늦어지므로, 아웃박스에 행이 **들어간 직후**(settle·
 * expire_deadlines) `nudge()` 로 간격을 되돌려 지연 증가를 0 으로 만든다.
 * 캡 4s: 최악 지연 = 캡 + 루프 입도(~1s) ≤ 5s. 5 로 두면 6s 가 되어 SLA 를 넘는다.
 */
export class CallbackPump {
  static MIN_INTERVAL_MS = 1_000;
  static MAX_INTERVAL_MS = 4_000;

  #intervalMs = CallbackPump.MIN_INTERVAL_MS;
  #nextAt = 0;
  #nudged = false;

  nudge(): void {
    this.#nudged = true;
  }

  async maybePump(
    db: Db,
    now: () => number = Date.now,
    internalToken: string | null = settings.internalCallbackToken,
  ): Promise<PumpResult | null> {
    if (this.#nudged) {
      this.#nudged = false;
      this.#intervalMs = CallbackPump.MIN_INTERVAL_MS;
    } else if (now() < this.#nextAt) {
      return null;
    }
    const res = await pumpOnce(db, now, internalToken);
    if (res.sent > 0 || res.failed > 0) {
      this.#intervalMs = CallbackPump.MIN_INTERVAL_MS;
      this.#nextAt = now() + CallbackPump.MIN_INTERVAL_MS;
    } else {
      // **이번 간격만큼 쉬고** 그 다음을 위해 2배로. 순서를 바꾸면 첫 백오프가 1s 가 아니라 2s 가 된다.
      this.#nextAt = now() + this.#intervalMs;
      this.#intervalMs = Math.min(CallbackPump.MAX_INTERVAL_MS, this.#intervalMs * 2);
    }
    return res;
  }
}
