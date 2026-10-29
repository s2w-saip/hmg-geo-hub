import { NextResponse, type NextRequest } from "next/server";
import {
  QA_COOKIE,
  checkPassword,
  hashIp,
  normalizeReviewerName,
  qaEnabled,
  signReviewerCookie,
} from "@/lib/qa/auth";
import { hit } from "@/lib/qa/rate-limit";
import { clientIp, readJson } from "@/lib/qa/route-helpers";
import { createReviewSession } from "@/lib/db/repositories/qa-review";

// 검수 콘솔의 게이트. Supabase 로그인을 쓰지 않는 이 저장소의 유일한 인증 경로다
// (설계 §4.2). 검수자 이름은 평문으로 받되 쿠키에 HMAC 서명해 담는다 — 서명이
// 없으면 검수 기록의 작성자를 브라우저에서 바꿔 쓸 수 있다.

const ATTEMPTS_PER_MINUTE = 10;

export async function POST(req: NextRequest) {
  if (!qaEnabled()) return new NextResponse(null, { status: 404 });

  const ipHash = hashIp(clientIp(req));
  if (!hit(`qa-pw:${ipHash ?? "unknown"}`, ATTEMPTS_PER_MINUTE, 60_000)) {
    return NextResponse.json({ error: "rate-limited" }, { status: 429 });
  }

  const body = await readJson(req);
  const name = normalizeReviewerName(body.name);
  if (!name) return NextResponse.json({ error: "bad-name" }, { status: 400 });

  const password = typeof body.password === "string" ? body.password : "";
  if (!checkPassword(password)) {
    return NextResponse.json({ error: "bad-credentials" }, { status: 401 });
  }

  const sessionId = await createReviewSession({
    reviewerName: name,
    userAgent: req.headers.get("user-agent"),
    ipHash,
  });

  const res = NextResponse.json({ name });
  res.cookies.set({
    name: QA_COOKIE,
    value: signReviewerCookie({ sessionId, name, issuedAt: Date.now() }),
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    // maxAge / expires 를 **주지 않는다** — 세션 쿠키라야 브라우저 종료 시 사라진다.
    // 같은 PC 를 검수자가 교대로 쓰는 운용이 이 요구사항의 이유다(설계 §4.3).
  });
  return res;
}

export async function DELETE() {
  if (!qaEnabled()) return new NextResponse(null, { status: 404 });
  const res = NextResponse.json({ ok: true });
  res.cookies.set({ name: QA_COOKIE, value: "", path: "/", maxAge: 0 });
  return res;
}
