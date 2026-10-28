import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { isHghApiError } from "@/lib/hgh/errors";

// Shared rules of the /api/hub/* route handlers (HUB login and Global prompt editing, 2026-10-27).
// They are the local mode's only writes (middleware.ts): a write must come from this site's own pages.

export const NO_STORE = { "Cache-Control": "no-store" } as const;

export function hubFail(status: number, code: string): NextResponse {
  return NextResponse.json({ error: { code } }, { status, headers: NO_STORE });
}

/** A write's Origin must be this host (the cookie is SameSite=Strict as well). */
export function sameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function secureRequest(req: NextRequest): boolean {
  return req.nextUrl.protocol === "https:";
}

export async function jsonBody(req: NextRequest): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

/** A BFF refusal as the browser sees it: the code, the message and details (the BFF's own words, no data). */
export function hubErrorResponse(e: unknown): NextResponse {
  if (!isHghApiError(e)) {
    console.error("[hub] route handler failure", e instanceof Error ? e.name : typeof e);
    return hubFail(500, "internal");
  }
  const status = e.status >= 400 && e.status <= 599 ? e.status : 502;
  return NextResponse.json({ error: { code: e.code, message: e.message, details: e.details ?? undefined } }, { status, headers: NO_STORE });
}
