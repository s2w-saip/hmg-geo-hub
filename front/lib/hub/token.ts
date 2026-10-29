import "server-only";
import { cookies } from "next/headers";
import { HUB_SESSION_COOKIE } from "./cookie";

// The HUB session token of the request being served (2026-10-29): every BFF call of the local mode carries it
// (screens, /v1 reads, HUB writes), and the BFF reads that account's scope from it. No imports beyond the cookie
// name, so lib/screen.ts and lib/hgh/client.ts can use it without a cycle through lib/hub/client.ts.

/** The cookie's token, or null without one or outside a request (cookies() throws there). */
export async function hubRequestToken(): Promise<string | null> {
  try {
    return (await cookies()).get(HUB_SESSION_COOKIE)?.value || null;
  } catch {
    return null;
  }
}
