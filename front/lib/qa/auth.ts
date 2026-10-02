import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { hghSource, sourceGroupFor } from "@/lib/hgh/client";

// Raw Data QA Console 의 인증 — 이 저장소에서 Supabase 세션을 쓰지 않는 **유일한** 표면.
// 설계·수용된 리스크: docs/specs/2026-09-04-raw-data-qa-console-design.md §3~§4
//
// 검수자는 GGMD 계정이 없는 외부 인력이다. 그래서 "이름(평문) + 공유 비밀번호"만으로
// 통과시키고, 통과 증표는 HMAC 서명된 **세션 쿠키**로 준다. 이름을 쿠키에 담되 굳이
// 서명하는 이유는 하나다 — 서명이 없으면 검수 기록의 작성자를 브라우저에서 마음대로
// 바꿔 쓸 수 있고, 그러면 "누가 검수했나"가 아무 의미도 없어진다.

export const QA_COOKIE = "raw_data_qa";

// 세션 쿠키(브라우저 종료 시 소멸)가 1차 방어, 이 하드 만료가 2차다.
// 브라우저의 "종료 시 탭 복원" 설정은 세션 쿠키를 살려두므로 — 서버가 막을 수 없는
// 영역이다 — 상한을 서버가 강제한다. 같은 PC 를 검수자가 교대로 쓰는 운용이라
// 이 상한이 실제로 의미가 있다.
export const QA_MAX_AGE_MS = 12 * 60 * 60 * 1000;

const DEFAULT_PASSWORD = "qa-default-redacted";
const MAX_NAME_LEN = 40;

export type QaReviewer = { sessionId: string; name: string; issuedAt: number };

export class QaUnauthorizedError extends Error {
  constructor() {
    super("qa: unauthorized");
    this.name = "QaUnauthorizedError";
  }
}

// 시크릿 미설정 시 프로세스 부팅마다 랜덤 — 재배포하면 모든 세션이 무효가 된다.
// 취약한 고정 기본값보다 이쪽이 낫다는 판단이며, 운영에서는 반드시 env 를 채운다.
let ephemeralSecret: string | null = null;
function secret(): string {
  const env = process.env.RAW_DATA_QA_SECRET;
  if (env) return env;
  if (!ephemeralSecret) {
    ephemeralSecret = randomBytes(32).toString("hex");
    console.warn(
      "[qa] RAW_DATA_QA_SECRET 미설정 — 프로세스 수명 동안만 유효한 임시 키를 씁니다.",
    );
  }
  return ephemeralSecret;
}

// 상시 킬 스위치. 이 콘솔은 role 스코프 밖이라 "필요할 때만 켠다"가 기본 운용이다.
export function qaEnabled(): boolean {
  return process.env.RAW_DATA_QA_ENABLED === "1";
}

function hmac(input: string): string {
  return createHmac("sha256", secret()).update(input).digest("base64url");
}

export function signReviewerCookie(r: QaReviewer): string {
  const payload = Buffer.from(JSON.stringify(r)).toString("base64url");
  return `${payload}.${hmac(payload)}`;
}

export function verifyReviewerCookie(
  raw: string | undefined,
  now: number = Date.now(),
): QaReviewer | null {
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expected = hmac(payload);
  // 길이가 다르면 timingSafeEqual 이 던진다 — 먼저 거른다.
  if (sig.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const { sessionId, name, issuedAt } = parsed as Record<string, unknown>;
  if (typeof sessionId !== "string" || typeof name !== "string" || typeof issuedAt !== "number") {
    return null;
  }
  if (now - issuedAt > QA_MAX_AGE_MS) return null;
  return { sessionId, name, issuedAt };
}

export function checkPassword(input: string): boolean {
  const expected = process.env.RAW_DATA_QA_PASSWORD || DEFAULT_PASSWORD;
  const a = Buffer.from(input ?? "", "utf8");
  const b = Buffer.from(expected, "utf8");
  // 길이 비교가 먼저 새어나가지만(timingSafeEqual 이 길이 불일치에 던지므로 불가피),
  // 비밀번호 길이는 비밀이 아니다.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// 제어문자 제거 후 trim. 이름은 그대로 검수 기록·노트·락 배지에 박히므로,
// 깨진 문자가 들어가면 화면과 CSV 가 함께 망가진다.
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

export function normalizeReviewerName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(CONTROL_CHARS, "").trim();
  if (!cleaned) return null;
  if (cleaned.length > MAX_NAME_LEN) return null;
  return cleaned;
}

// 원문 IP 를 저장하지 않기 위한 단방향 해시. rate limit 키와 세션 감사 양쪽에 쓴다.
export function hashIp(ip: string | null): string | null {
  if (!ip) return null;
  return hmac(`ip:${ip}`);
}

// ─── 데이터 원천 전환 (D8, U12) ─────────────────────────────────────────────
//
// HGH_SOURCE_G7 = api | legacy (기본 legacy, sourceGroupFor("qa") = G7). 요청마다 읽으므로
// 플래그만 바꾸면 코드 변경 없이 되돌릴 수 있다. api 일 때 이 파일의 서명·비밀번호·hashIp 는
// 쓰이지 않는다: 쿠키 발급·검증·시도 상한은 백엔드(/v1/qa/*)가 하고, 프론트는 raw_data_qa
// 쿠키를 양방향으로 중계만 한다(lib/hgh/adapters/qa.ts). 킬 스위치 qaEnabled 는 두 원천 공통이다.
export function qaApiSource(): boolean {
  return hghSource(sourceGroupFor("qa")) === "api";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 쿠키 payload 의 sessionId 를 **서명 검증 없이** 읽는다(API 원천 로그아웃 경로 전용: 백엔드
 * PATCH /v1/qa/sessions/{session_id} 가 경로에 id 를 요구한다). 판정에 쓰지 않는다: 위조한 id 는
 * 백엔드가 쿠키 서명과 대조해 거절한다(403 session_forbidden 또는 401).
 */
export function readSessionIdUnverified(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const [payload] = raw.split(".");
  if (!payload) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const id = (parsed as { sessionId?: unknown } | null)?.sessionId;
    return typeof id === "string" && UUID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

// 모든 /raw-data-qa 페이지와 /api/qa 라우트의 첫 관문.
export async function requireReviewer(): Promise<QaReviewer> {
  if (!qaEnabled()) throw new QaUnauthorizedError();
  const jar = await cookies();
  const reviewer = verifyReviewerCookie(jar.get(QA_COOKIE)?.value);
  if (!reviewer) throw new QaUnauthorizedError();
  return reviewer;
}
