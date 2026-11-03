import "server-only";
import { createHash } from "node:crypto";
import { screenGet } from "@/lib/screen";
import type { ServiceWeekView } from "@/lib/service-week";

/**
 * The service week (screen shared/service-week, back/bff/screens/shared.py) for the request's account. The shells'
 * layouts start it without waiting for it (the page never waits on the week) and hand the promise to their client
 * provider; a page that reads it too shares the one request (screenGet dedupes per request). Rejects with the
 * screen's HghApiError: 503 when the BFF could not read the week and has none to fall back on. `sites` = a Website
 * page's site picks (brand · geography · language · engine, as its URL has them): the notes are then those sites'; a
 * layout has none.
 */
export function readServiceWeek(sites: Readonly<Record<string, string>> = {}): Promise<ServiceWeekView> {
  return screenGet<ServiceWeekView>("shared/service-week", sites);
}

/**
 * The key of a page body that keeps its first server answer in state while its own reads replace it (a list with
 * its search, order and pages): that answer's fingerprint. Once the week moves the shell re-reads the page
 * (components/service-week/sync.ts: router.refresh()), which keeps a client component's state while its type and key
 * stay, so a body keyed by its URL alone went on with the week before under a header and a chip naming the new one
 * (review r2-7, 2026-11-03). A new answer mounts it again with that answer; the same answer keeps it (its page, an open
 * row). The body's own answer, not the week's read: the two are separate requests, and a page read as the BFF moved
 * on can hold the week before in one of them (review r1-16) — the re-read it then gets brings the answer of the week.
 */
export function answerKey(...answers: unknown[]): string {
  return createHash("sha1").update(JSON.stringify(answers)).digest("base64url").slice(0, 16);
}
