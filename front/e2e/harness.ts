import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserContext, Page, Request, Response } from "@playwright/test";

// Shared pieces of the local E2E harness (design 5.3, 5.4): paths, screens.json types,
// file slicing for the server-side logs, browser collectors and the check helpers.
// Nothing here prints token, cookie or password values: cookies are reduced to names,
// the Bearer token to its JWT header (by the tap), response bodies to selected values.

export const E2E_DIR = dirname(fileURLToPath(import.meta.url));
export const RUN_DIR = join(E2E_DIR, ".run");
export const OUT_ROOT = join(E2E_DIR, ".out");
const port = (name: string, fallback: string) => process.env[name] || fallback;
export const FRONT_URL = `http://127.0.0.1:${port("E2E_FRONT_PORT", "3100")}`;
export const AUTH_URL = `http://127.0.0.1:${port("E2E_AUTH_PORT", "54399")}`;
export const TAP_URL = `http://127.0.0.1:${port("E2E_TAP_PORT", "18081")}`;

// ── screens.json ─────────────────────────────────────────────────────────────

export type Flow = "visit" | "login" | "qaGate" | "qaNote" | "qaLogout" | "refresh";
export type Outcome = "ok" | "no-access" | "not-found" | "login" | "login-error" | "qa-gate" | "qa-error";

export interface ValueCheck {
  /** Route template as the client traces it, e.g. "/v1/projects/{project_id}". */
  route: string;
  /** Simple JSON path into the response (client.ts selectTraceValues): "data.name", "data.length". */
  jsonPath: string;
  selector: string;
  /** contains: element text contains the value (whitespace-normalised, first `prefix` chars); equals; count: element count equals the number. */
  match: "contains" | "equals" | "count";
  prefix?: number;
}

export interface Resolve {
  /** Placeholder name in `path`, e.g. "jobId" for {jobId}. */
  var: string;
  /** Page that makes the call carrying the value (visited first when no trace has it yet). */
  from: string;
  route: string;
  jsonPath: string;
}

export interface CaseDef {
  /** Unique within the screen; default = account key (or "anonymous"). */
  name?: string;
  /** accounts.json key, "QA" (ADMIN session + QA reviewer cookie) or null (no session). */
  account: string | null;
  expect: Outcome;
  path?: string;
  /** Expected final path for flows that navigate (login landing, QA gate). */
  landing?: string;
  password?: "wrong";
  errorText?: string;
  /** Replaces the screen's `apis` for this case. */
  apis?: string[];
  /** Expected non-2xx statuses: "GET /v1/auth/me": 401. */
  apiStatus?: Record<string, number>;
  /** Expected query parameters on a call: {"GET /v1/qa/answers": {"no_mentions": ["true"]}}. */
  query?: Record<string, Record<string, string[]>>;
  /** Expected GNB rail tab destinations (path suffixes, order kept). */
  rail?: string[];
  resolve?: Resolve;
  reviewer?: string;
  noteBody?: string;
  /** refresh flow: token lifetime for the account (seconds). */
  expIn?: number;
}

export interface ScreenDef {
  id: string;
  unit: string;
  title: string;
  flow: Flow;
  path: string;
  /** The page content under the layout belongs to a later unit (legacy data path). */
  leaf?: "legacy";
  apis?: string[];
  relay?: "bearer" | "qa";
  ready?: string[];
  markers?: string[];
  values?: ValueCheck[];
  /**
   * Most backend (/v1) calls in flight at once while the page loads (visit cases expecting ok),
   * from the tap's [start, end) spans; default `defaults.serverCallBudget`. Design G-25: five or
   * more concurrent calls per screen saturate the backend (D6: essentials first, the rest after).
   * The total number of calls and their waves are recorded in the result, not judged.
   */
  serverCallBudget?: number;
  /** Why a screen's serverCallBudget differs from the default (shown in the check detail). */
  budgetNote?: string;
  cases: CaseDef[];
  note?: string;
}

export interface ScreensDoc {
  sourceFlags: string[];
  /** serverCallBudget: see ScreenDef.serverCallBudget (concurrent backend calls, not a call count). */
  defaults: { locale: string; serverCallBudget: number };
  screens: ScreenDef[];
}

export interface Account {
  key: string;
  id: string;
  email: string;
  role: string;
  menuGroups: string[] | null;
  status: string;
}

export interface AllowEntry {
  id: string;
  pattern: string;
  /** Screens the entry applies to (all when absent). */
  screens?: string[];
  /** Only when the screen declares leaf "legacy" and the case expects ok. */
  when?: "legacyLeaf";
  reason: string;
}

const readJson = <T>(name: string): T => JSON.parse(readFileSync(join(E2E_DIR, name), "utf8")) as T;
export const loadScreens = () => readJson<ScreensDoc>("screens.json");
export const loadAccounts = () => readJson<{ password: string; accounts: Account[] }>("accounts.json");
export const loadAllowConsole = () => readJson<{ entries: AllowEntry[] }>("allow-console.json").entries;

export function buildTraceSelect(doc: ScreensDoc): Record<string, string[]> {
  const sel: Record<string, string[]> = {};
  const add = (route: string, path: string) => {
    const list = (sel[route] ??= []);
    if (!list.includes(path)) list.push(path);
  };
  for (const s of doc.screens) {
    for (const v of s.values ?? []) add(v.route, v.jsonPath);
    for (const c of s.cases) if (c.resolve) add(c.resolve.route, c.resolve.jsonPath);
  }
  return sel;
}

export function readMessage(key: string, locale = "ko"): string {
  const doc = JSON.parse(readFileSync(join(E2E_DIR, "..", "messages", `${locale}.json`), "utf8")) as Record<string, unknown>;
  let cur: unknown = doc;
  for (const k of key.split(".")) cur = (cur as Record<string, unknown> | undefined)?.[k];
  if (typeof cur !== "string") throw new Error(`message ${key} not found`);
  return cur;
}

// ── server-side files: slice what one case produced ─────────────────────────

function sizeOf(file: string): number {
  return existsSync(file) ? statSync(file).size : 0;
}

export class FileSlice {
  private readonly start: number;
  constructor(private readonly file: string) {
    this.start = sizeOf(file);
  }
  text(): string {
    const end = sizeOf(this.file);
    if (end <= this.start) return "";
    const buf = Buffer.alloc(end - this.start);
    const fd = openSync(this.file, "r");
    try {
      readSync(fd, buf, 0, buf.length, this.start);
    } finally {
      closeSync(fd);
    }
    return buf.toString("utf8");
  }
  lines(): string[] {
    return this.text().split("\n").filter((l) => l.trim() !== "");
  }
  jsonl<T>(): T[] {
    const out: T[] = [];
    for (const l of this.lines()) {
      try {
        out.push(JSON.parse(l) as T);
      } catch {
        // a line still being written; the next slice has it
      }
    }
    return out;
  }
}

export interface TraceEntry {
  ts: string;
  requestId: string;
  attempt: number;
  method: string;
  route: string;
  path: string;
  query: Record<string, string[]>;
  status: number;
  ms: number;
  code?: string;
  values?: Record<string, string | number | boolean | null>;
}

export interface TapEntry {
  ts: string;
  requestId: string | null;
  method: string;
  path: string;
  status: number;
  ms: number;
  headerNames: string[];
  cookieNames: string[];
  auth: { scheme: string; alg?: string | null; kid?: string | null; malformed?: boolean } | null;
  setCookieNames?: string[];
  error?: string;
  /** Epoch ms, sub-ms precision: request received by the tap / upstream answer ended. */
  startMs?: number;
  endMs?: number;
}

export interface Span {
  api: string;
  start: number;
  end: number;
}

/** A tap line's [start, end) in epoch ms (startMs/endMs; a line without them: ts + ms, about 1 ms). */
export function tapSpan(e: TapEntry): Span {
  const start = e.startMs ?? Date.parse(e.ts);
  const end = e.endMs ?? start + e.ms;
  // a zero-length span still was in flight for an instant
  return { api: `${e.method} ${e.path}`, start, end: Math.max(end, start + 0.001) };
}

/**
 * The most spans open at one instant and the calls open at the first such instant. Spans are
 * half-open [start, end): a call that starts exactly when another ends does not overlap it.
 */
export function peakConcurrency(spans: readonly Span[]): { max: number; at: string[] } {
  const events = spans
    .flatMap((s, i) => [
      { t: s.start, open: true, i },
      { t: s.end, open: false, i },
    ])
    .sort((a, b) => a.t - b.t || Number(a.open) - Number(b.open));
  const open = new Set<number>();
  let max = 0;
  let at: string[] = [];
  for (const ev of events) {
    if (ev.open) open.add(ev.i);
    else open.delete(ev.i);
    if (open.size > max) {
      max = open.size;
      at = [...open].map((i) => spans[i].api);
    }
  }
  return { max, at };
}

export interface Slices {
  trace: FileSlice;
  tap: FileSlice;
  back: FileSlice;
  front: FileSlice;
  auth: FileSlice;
}

export function openSlices(): Slices {
  return {
    trace: new FileSlice(join(RUN_DIR, "api-trace.jsonl")),
    tap: new FileSlice(join(RUN_DIR, "tap.jsonl")),
    back: new FileSlice(join(RUN_DIR, "back.log")),
    front: new FileSlice(join(RUN_DIR, "front.log")),
    auth: new FileSlice(join(RUN_DIR, "auth.log")),
  };
}

/** Wait until the server-side run files stop growing (quiet `quietMs`, at most `maxMs`). */
export async function quiesce(quietMs = 600, maxMs = 8_000): Promise<void> {
  const files = ["api-trace.jsonl", "tap.jsonl", "back.log", "front.log"].map((f) => join(RUN_DIR, f));
  const snap = () => files.map(sizeOf).join(",");
  let last = snap();
  let stableSince = Date.now();
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    await new Promise((r) => setTimeout(r, 150));
    const now = snap();
    if (now !== last) {
      last = now;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= quietMs) return;
  }
}

/** Latest traced value of `route`/`jsonPath` in the whole run trace (for placeholders). */
export function latestTraceValue(route: string, jsonPath: string): string | number | boolean | null {
  const lines = readFileSync(join(RUN_DIR, "api-trace.jsonl"), "utf8").split("\n").reverse();
  for (const l of lines) {
    if (!l.trim()) continue;
    try {
      const e = JSON.parse(l) as TraceEntry;
      if (e.route === route && e.values && jsonPath in e.values && e.values[jsonPath] !== null) return e.values[jsonPath];
    } catch {
      // skip partial line
    }
  }
  return null;
}

// ── mock auth ────────────────────────────────────────────────────────────────

export async function authStats(): Promise<Record<string, number>> {
  const res = await fetch(`${AUTH_URL}/__e2e/stats`);
  return ((await res.json()) as { stats: Record<string, number> }).stats;
}

export async function authConfig(body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${AUTH_URL}/__e2e/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`mock auth config refused (${res.status})`);
}

// ── browser collectors ───────────────────────────────────────────────────────

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export interface BrowserLog {
  console: Array<{ type: string; text: string }>;
  pageErrors: string[];
  requestFailed: Array<{ method: string; url: string; failure: string }>;
  apiResponses: Array<{ method: string; path: string; status: number; setCookieNames: string[] }>;
  documents: Array<{ url: string; status: number }>;
  external: string[];
  firstApiRequestAt: number | null;
  pending: Array<Promise<void>>;
}

/** Blocks every non-loopback request of the context (no external network) and records its host. */
export async function blockExternal(context: BrowserContext, log: BrowserLog): Promise<void> {
  await context.route(
    (url) => (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "ws:" || url.protocol === "wss:") && !LOOPBACK.has(url.hostname),
    async (route) => {
      log.external.push(new URL(route.request().url()).hostname);
      await route.abort("blockedbyclient");
    },
  );
}

/**
 * Per-context browser state that is not under test: the (dash) "beta notice" popup opens once per
 * browser session (sessionStorage flag) and would cover every capture. Marked as already shown.
 */
export async function prepareContext(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    try {
      window.sessionStorage.setItem("ggmd-beta-notice-shown", "1");
    } catch {
      // storage unavailable: the popup just shows
    }
  });
}

export function newBrowserLog(): BrowserLog {
  return { console: [], pageErrors: [], requestFailed: [], apiResponses: [], documents: [], external: [], firstApiRequestAt: null, pending: [] };
}

const pathOf = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
};

export function attachCollectors(page: Page, log: BrowserLog): void {
  page.on("console", (m) => {
    if (m.type() !== "error" && m.type() !== "warning") return;
    const entry = { type: m.type(), text: m.text().slice(0, 500) };
    log.console.push(entry);
    // React dev warnings arrive as a format string ("... key, `%s`. ...") plus arguments; m.text()
    // leaves the placeholders unfilled. Fill them from the arguments (the key, the component
    // stack) so a failure names what it is about.
    if (/%[sdoOic]/.test(m.text())) {
      log.pending.push(
        Promise.all(m.args().map((a) => a.jsonValue().catch(() => "?")))
          .then(([fmt, ...rest]) => {
            if (typeof fmt !== "string") return;
            let i = 0;
            const filled = fmt.replace(/%[sdoOic]/g, () => (i < rest.length ? String(rest[i++]) : ""));
            const tail = rest.slice(i).map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" ");
            entry.text = `${filled}${tail ? ` ${tail}` : ""}`.slice(0, 1500);
          })
          .catch(() => undefined),
      );
    }
  });
  page.on("pageerror", (e) => log.pageErrors.push(`${e.name}: ${e.message}`.slice(0, 500)));
  page.on("request", (r: Request) => {
    if (log.firstApiRequestAt === null && new URL(r.url()).pathname.startsWith("/api/")) log.firstApiRequestAt = Date.now();
  });
  page.on("requestfailed", (r: Request) => {
    log.requestFailed.push({ method: r.method(), url: pathOf(r.url()), failure: r.failure()?.errorText ?? "unknown" });
  });
  page.on("response", (res: Response) => {
    const req = res.request();
    const u = new URL(res.url());
    if (req.isNavigationRequest() && req.frame() === page.mainFrame()) log.documents.push({ url: pathOf(res.url()), status: res.status() });
    if (u.pathname.startsWith("/api/")) {
      log.pending.push(
        res
          .headerValues("set-cookie")
          .then((lines) => {
            log.apiResponses.push({
              method: req.method(),
              path: u.pathname,
              status: res.status(),
              setCookieNames: lines.flatMap((l) => l.split("\n")).map((l) => l.split("=")[0].trim()).filter(Boolean),
            });
          })
          .catch(() => {
            log.apiResponses.push({ method: req.method(), path: u.pathname, status: res.status(), setCookieNames: [] });
          }),
      );
    }
  });
}

/** Next dev overlay state: open error dialog and the issues badge count (null when absent). */
export async function nextOverlay(page: Page): Promise<{ dialog: boolean; issues: number | null }> {
  return page.evaluate(() => {
    const root = document.querySelector("nextjs-portal")?.shadowRoot;
    if (!root) return { dialog: false, issues: null };
    const dialog = Boolean(root.querySelector("[data-nextjs-dialog], [data-nextjs-dialog-overlay]"));
    const badge = root.querySelector("[data-issues-count]") ?? root.querySelector("[data-nextjs-dev-tools-button] [data-issues]");
    const n = badge ? Number((badge.textContent ?? "").replace(/\D+/g, "")) : null;
    return { dialog, issues: n !== null && Number.isFinite(n) ? n : null };
  });
}

// ── checks and results ───────────────────────────────────────────────────────

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

export const apiKey = (e: { method: string; route: string }) => `${e.method.toUpperCase()} ${e.route}`;
export const is2xx = (s: number) => s >= 200 && s < 300;
export const norm = (s: string) => s.replace(/\s+/g, " ").trim();

export function writeResult(runId: string, file: string, result: unknown): void {
  const dir = join(OUT_ROOT, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${file}.json`), `${JSON.stringify(result, null, 2)}\n`);
  appendFileSync(join(dir, "results.jsonl"), `${JSON.stringify(result)}\n`);
}

export function statePath(account: string): string {
  return join(RUN_DIR, "state", `${account}.json`);
}

export function qaPassword(): string {
  return readFileSync(join(RUN_DIR, "qa-password"), "utf8").trim();
}
