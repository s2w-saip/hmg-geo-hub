// 본문 상한 — 두 층이 있고 **역할이 다르다**(스펙 §4.5).
//
//  ① 인그레스 `client_max_body_size 2m` (deploy/ingress/nginx.conf) — 측정 lane 과 동일.
//     네트워크 경계에서 거대한 요청을 앱에 닿기 전에 끊는다.
//  ② 계약 레벨 `turn` 직렬화 1 MiB — 앱이 `400` 으로 끝낸다.
//
// ⚠️ 초판에 있던 "초과분은 코어가 턴을 쪼개 복수 티켓으로 낸다" 폴백은 **삭제됐다**.
//    입도가 이미 턴이라 더 쪼갤 것이 없다(D1). 그 크기의 턴 하나는 데이터 이상이므로 `400` 이 곧
//    최종 판정이고, 코어는 그 턴을 `persistTurnFailure`(output_contract)로 닫는다.
//    계약 위반을 워커까지 보내 슬롯을 낭비하지 않는다 — 측정 lane 설계 §3.1 의 원칙 그대로.

/** 계약 레벨 `turn` 상한. 초과 = 400, 재발행 없음. */
export const ANALYSIS_TURN_BODY_MAX_BYTES = 1_048_576; // 1 MiB

/** 인그레스 상한(참조용 — 집행은 nginx). 값을 바꾸면 nginx.conf 도 함께 고쳐야 한다. */
export const ANALYSIS_INGRESS_BODY_MAX_BYTES = 2 * 1_048_576; // 2 MiB = client_max_body_size 2m

export function turnBodyBytes(turn: unknown): number {
  return Buffer.byteLength(JSON.stringify(turn ?? null), "utf8");
}
