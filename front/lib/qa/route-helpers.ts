import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { readQaCookie } from "@/lib/hgh/auth";
import { QaUnauthorizedError, qaEnabled, requireReviewer, type QaReviewer } from "./auth";
import { QA_SEVERITIES, QA_TARGET_KINDS, type QaSeverity, type QaTargetKind } from "./filters";
import { QA_SECTION_KEYS, type QaSectionFlags } from "./types";

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
      return { ok: false, response: unauthorized() };
    }
    throw err;
  }
}

// 검수 쿠키가 없거나 무효일 때 /api/qa/* 가 돌려주는 본문. 두 원천(legacy·api) 공통이다:
// 클라이언트는 이 모양만 안다.
export function unauthorized(): NextResponse {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

// API 원천(HGH_SOURCE_G7=api)의 전처리. guard() 와 같은 순서: 킬 스위치 404 → 쿠키 없음 401.
// 쿠키 서명·만료·세션 행 확인은 백엔드가 한다(무효면 401 qa_unauthorized → 라우트가 unauthorized()).
// 프론트는 쿠키 값을 읽어 넘기기만 한다(Cookie: raw_data_qa=<값> 하나, Authorization 없음).
export type ApiGuarded =
  | { ok: true; cookie: string }
  | { ok: false; response: NextResponse };

export async function apiGuard(): Promise<ApiGuarded> {
  if (!qaEnabled()) {
    return { ok: false, response: new NextResponse(null, { status: 404 }) };
  }
  const cookie = await readQaCookie();
  if (!cookie) return { ok: false, response: unauthorized() };
  return { ok: true, cookie };
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

// ─── 요청 본문 검증 규칙 (두 원천 공통, 라우트에서 옮겨 왔다: 동작 동일) ─────────

// 블록별 판정: 아는 섹션 키의 "ok"·"issue" 만 남긴다(나머지 키·값은 버린다).
export function readSectionFlags(raw: unknown): QaSectionFlags {
  if (!raw || typeof raw !== "object") return {};
  const src = raw as Record<string, unknown>;
  const out: QaSectionFlags = {};
  for (const k of QA_SECTION_KEYS) {
    const v = src[k];
    if (v === "ok" || v === "issue") out[k] = v;
  }
  return out;
}

export const MAX_NOTE_BODY = 4000;

export function noteKind(v: unknown): QaTargetKind | null {
  return typeof v === "string" && (QA_TARGET_KINDS as readonly string[]).includes(v)
    ? (v as QaTargetKind)
    : null;
}

// 어휘 밖 severity 는 거절하지 않고 "issue" 로 둔다(현행 동작).
export function noteSeverity(v: unknown): QaSeverity {
  return typeof v === "string" && (QA_SEVERITIES as readonly string[]).includes(v)
    ? (v as QaSeverity)
    : "issue";
}

// 노트 본문: trim 후 4,000자 절단. 문자열이 아니면 "".
export function noteText(v: unknown): string {
  return typeof v === "string" ? v.trim().slice(0, MAX_NOTE_BODY) : "";
}

// 클라이언트 IP — Vercel/프록시 뒤에서는 x-forwarded-for 의 첫 항목이 원 IP 다.
export function clientIp(req: NextRequest): string | null {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim() || null;
  return req.headers.get("x-real-ip");
}
