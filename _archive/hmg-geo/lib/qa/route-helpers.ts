import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { QaUnauthorizedError, qaEnabled, requireReviewer, type QaReviewer } from "./auth";

// /api/qa/* 가 공유하는 전처리. 순서가 중요하다:
//   1) 킬 스위치가 꺼져 있으면 **404** — 401 을 주면 "여기 뭔가 있다"를 알려준다.
//   2) 그다음 쿠키 검증 → 401.
export type Guarded =
  | { ok: true; reviewer: QaReviewer }
  | { ok: false; response: NextResponse };

export async function guard(): Promise<Guarded> {
  if (!qaEnabled()) {
    return { ok: false, response: new NextResponse(null, { status: 404 }) };
  }
  try {
    return { ok: true, reviewer: await requireReviewer() };
  } catch (err) {
    if (err instanceof QaUnauthorizedError) {
      return {
        ok: false,
        response: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
      };
    }
    throw err;
  }
}

// body 가 없거나 JSON 이 아니어도 라우트가 500 으로 죽지 않게.
// (sendBeacon 은 Blob 을 보내므로 Content-Type 이 기대와 다를 수 있다.)
export async function readJson(req: NextRequest): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await req.json();
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

// 클라이언트 IP — Vercel/프록시 뒤에서는 x-forwarded-for 의 첫 항목이 원 IP 다.
export function clientIp(req: NextRequest): string | null {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim() || null;
  return req.headers.get("x-real-ip");
}
