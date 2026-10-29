// 결정적 ticketId — 같은 (workspace, turn_run, analysis_version, attempt) 는 같은 티켓.
// 코어의 재발행·중복 배달이 lane 에 중복 실행을 만들지 않는다(lane 은 멱등 replay 로 202).
//
// 산식·구분자 관례는 측정 lane `lib/measurement-ticket/ticket-id.ts` 와 **동일**하다.
// ⚠️ 네임스페이스만 **새로 발급**한다 — 같은 네임스페이스를 쓰면 id 가 겹치는 순간 측정 티켓과
//    충돌한다(스펙 §4.2).
import { createHash } from "node:crypto";

/** 분석 lane 전용 uuid5 네임스페이스. 2026-09-12 이 리포에서 발급. **절대 바꾸지 않는다.** */
export const NS_ANALYSIS = "03f28e69-d29b-40a7-9eec-b16b15bbcd36";

function uuidToBytes(u: string): Buffer {
  return Buffer.from(u.replace(/-/g, ""), "hex");
}

/** UUIDv5 (SHA-1). Python `uuid.uuid5(NS, name)` 과 동일 산식. */
export function uuid5(namespace: string, name: string): string {
  const h = createHash("sha1").update(uuidToBytes(namespace)).update(Buffer.from(name, "utf8")).digest();
  h[6] = ((h[6] ?? 0) & 0x0f) | 0x50;
  h[8] = ((h[8] ?? 0) & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * `uuid5(NS_ANALYSIS, "<workspaceId>:<turnRunId>:<analysisVersion>:<attempt>")`
 *
 * ⚠️ **`attempt` 가 이름에 들어가는 것이 핵심이다.** 원장 UNIQUE 는
 * `(workspace_id, turn_run_id, analysis_version)` 이고 attempt 는 **그 행의 카운터**이므로
 * ("행은 하나, 시도는 여럿", 스펙 §4.2), attempt 를 이름에 넣지 않으면 같은 버전 재발행이
 * **같은 티켓으로 접혀 재분석 자체가 불가능**해진다. 측정 lane 의 pooled 통합 §2.3 이 기록한
 * 같은 함정이다.
 *
 * ⚠️ `analysisVersion` 에 `:` 가 들어가면 구분자가 모호해진다 — 코어가 그런 버전 문자열을 쓰지
 * 않는 것이 전제이고, 여기서 방어적으로 거부한다(조용한 충돌보다 즉시 실패가 낫다).
 */
export function deterministicAnalysisTicketId(
  workspaceId: string,
  turnRunId: string,
  analysisVersion: string,
  attempt: number,
): string {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error(`attempt must be a positive integer, got ${attempt}`);
  }
  if (analysisVersion.includes(":")) {
    throw new Error("analysisVersion must not contain ':' (ticket id separator)");
  }
  return uuid5(NS_ANALYSIS, `${workspaceId}:${turnRunId}:${analysisVersion}:${attempt}`);
}
