// 코어 내부 인증 토큰 — lane → 코어 두 경로에 붙는 `x-scope-internal-token` 헤더.
//
// ── 왜 콜백에만 토큰이고 티켓 API 는 아닌가 (비대칭이 의도다)
//
//   방향이 반대다.
//     코어 → lane (티켓 POST·상태 GET·reply 되읽기) : **mTLS 가 인증한다.** 인그레스가
//       `ssl_verify_client on` 으로 CA 검증을 종단하고 앱은 인증을 모른다
//       (deploy/ingress/nginx.conf). 그 위에 토큰을 더하면 자격증명이 두 벌이 되고
//       로테이션 절차도 두 벌이 되는데, 막는 공격자는 하나도 늘지 않는다.
//     lane → 코어 (콜백 doorbell·컨텍스트 스냅샷 GET) : 코어는 **Next.js Lambda/Hosting** 이고
//       그 앞에 mTLS 인그레스가 없다. 그래서 이쪽만 토큰이 필요하다 — 코어 라우트가
//       `x-scope-internal-token` 을 timing-safe 비교하고 불일치는 **404**(라우트 은닉)다.
//       근거: 코어 `app/api/internal/analysis-callback/route.ts` ·
//             `app/api/internal/analysis-context/[workspaceId]/[projectId]/[version]/route.ts`
//             (`/api/internal/cadence-tick` 동형 — 코어 G4 #645).
//
// ── 값이 코드·리포에 없는 이유
//
//   토큰은 ECS `secrets:` 로 주입된다(태스크 정의에는 시크릿 ARN 만 남는다). 이 파일이 아는
//   것은 env 이름뿐이고, **로그에도 값을 내지 않는다** — 동일성 확인이 필요하면 sha256 앞
//   8자 지문만 쓴다(룰 secrets-handling 1·4: URL·로그에 시크릿을 두지 않는다. 마스킹은
//   자기가 만든 출력만 가린다).
import { createHash } from "node:crypto";

import { settings, type Settings } from "../app/settings.ts";

export const INTERNAL_TOKEN_HEADER = "x-scope-internal-token";

/**
 * 토큰 지문 — **값이 아니다.** 양쪽이 같은 값을 들고 있는지 사람이 대조할 때만 쓴다.
 * 8자(32비트)는 대조에 충분하고 역산에 쓸모없다. 토큰이 없으면 `none` 이다 —
 * 빈 문자열을 찍으면 "붙었는데 비었다"와 "안 붙었다"가 구분되지 않는다.
 */
export function tokenFingerprint(token: string | null | undefined): string {
  if (!token) return "none";
  return createHash("sha256").update(token, "utf8").digest("hex").slice(0, 8);
}

/**
 * 콜백 POST 에 실을 헤더. 토큰이 없으면 **헤더를 만들지 않는다**(빈 값 헤더는 코어에서
 * 불일치로 404 가 되는데, 그것이 "미배선"인지 "값이 틀림"인지 구분되지 않는다).
 */
export function internalAuthHeaders(token: string | null): Record<string, string> {
  return token ? { [INTERNAL_TOKEN_HEADER]: token } : {};
}

export interface TokenWiringProblem {
  env: string;
  reason: "missing_value";
}

/**
 * 배선 단언 — **시크릿 참조가 있는데 값이 없으면 문제로 본다.**
 *
 * 이 순서가 아니면 사고가 조용해진다: 토큰 없이 콜백을 POST 하면 코어가 404 를 돌려주고
 * (라우트 은닉), lane 아웃박스는 그것을 배달 실패로 5회 재시도한 뒤 행을 남긴다. 로그에는
 * `http 404` 만 남아 **"코어 라우트가 배포되지 않았다"로 오진**된다 — 실제 원인은 이쪽의
 * 시크릿 주입 누락이다.
 *
 * 반대로 참조 자체가 없으면(로컬·compose·테스트) 토큰 없는 것이 정상이다 — 문제 아님.
 */
export function checkTokenWiring(s: Settings = settings): TokenWiringProblem[] {
  if (!s.internalTokenSecretArn) return [];
  const problems: TokenWiringProblem[] = [];
  if (!s.internalCallbackToken) problems.push({ env: "ANALYSIS_INTERNAL_CALLBACK_TOKEN", reason: "missing_value" });
  if (!s.internalContextToken) problems.push({ env: "ANALYSIS_INTERNAL_CONTEXT_TOKEN", reason: "missing_value" });
  return problems;
}

/** 기동 로그 1줄용 요약. **지문만** 들어간다. */
export function tokenWiringSummary(s: Settings = settings): Record<string, string | boolean> {
  return {
    secretRefConfigured: Boolean(s.internalTokenSecretArn),
    callbackTokenFingerprint: tokenFingerprint(s.internalCallbackToken),
    contextTokenFingerprint: tokenFingerprint(s.internalContextToken),
  };
}
