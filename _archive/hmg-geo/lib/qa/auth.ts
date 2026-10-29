import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

// Raw Data QA Console 의 인증 — 이 저장소에서 Supabase 세션을 쓰지 않는 **유일한** 표면.
// 설계·수용된 리스크: docs/superpowers/specs/2026-09-04-raw-data-qa-console-design.md §3~§4
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

const MAX_NAME_LEN = 40;

export type QaReviewer = { sessionId: string; name: string; issuedAt: number };

export class QaUnauthorizedError extends Error {
  constructor() {
    super("qa: unauthorized");
    this.name = "QaUnauthorizedError";
  }
}

function secret(): string {
  if (!qaEnabled()) throw new QaUnauthorizedError();
  return process.env.RAW_DATA_QA_SECRET!;
}

// 상시 킬 스위치. 이 콘솔은 role 스코프 밖이라 "필요할 때만 켠다"가 기본 운용이다.
export function qaEnabled(): boolean {
  return process.env.RAW_DATA_QA_ENABLED === "1" &&
    Boolean(process.env.RAW_DATA_QA_PASSWORD?.trim()) &&
    Boolean(process.env.RAW_DATA_QA_SECRET?.trim());
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
  if (!qaEnabled() || !raw) return null;
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
  if (!qaEnabled()) return false;
  const expected = process.env.RAW_DATA_QA_PASSWORD!;
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

// 모든 /raw-data-qa 페이지와 /api/qa 라우트의 첫 관문.
export async function requireReviewer(): Promise<QaReviewer> {
  if (!qaEnabled()) throw new QaUnauthorizedError();
  const jar = await cookies();
  const reviewer = verifyReviewerCookie(jar.get(QA_COOKIE)?.value);
  if (!reviewer) throw new QaUnauthorizedError();
  return reviewer;
}
