// Local-only header tap between next dev and the backend (design 5.3/5.4 relay checks).
//
//   next dev --HGH_API_BASE_URL--> tap :18081 --> uvicorn :18080
//
// It forwards every request unchanged and writes one JSONL line per request with what the
// screen checks need and nothing secret:
//   ts, requestId (X-Request-Id), method, path, status, ms,
//   startMs, endMs   epoch ms with sub-ms precision: request received, upstream answer ended
//                    (the harness's concurrency judgment; ts/ms are rounded to the ms)
//   headerNames      request header names (lowercase, sorted), never values
//   cookieNames      names in the Cookie header, never values
//   auth             null | { scheme, alg, kid, typ } from the Bearer JWT HEADER only
//                    (the path check for D1: which signature algorithm reached the backend)
//   setCookieNames   names in the response Set-Cookie lines, never values
//
// Why a tap: the app's own trace (HGH_API_TRACE_FILE) records calls and statuses but not
// which credentials went out. The QA relay rule (design 1.4: Cookie raw_data_qa only, no
// Authorization, no sb-* cookies) can only be checked on the wire.
//
// Refuses to start unless E2E_ALLOW_MOCK_AUTH=1 and the bind host is 127.0.0.1.
import http from "node:http";
import { appendFileSync } from "node:fs";

const HOST = process.env.E2E_TAP_HOST || "127.0.0.1";
const PORT = Number(process.env.E2E_TAP_PORT || 18081);
const UPSTREAM = new URL(process.env.E2E_TAP_UPSTREAM || "http://127.0.0.1:18080");
const LOG = process.env.E2E_TAP_LOG || "";

if (process.env.E2E_ALLOW_MOCK_AUTH !== "1") {
  console.error("[tap] refused: E2E_ALLOW_MOCK_AUTH=1 is required (local E2E only)");
  process.exit(2);
}
if (HOST !== "127.0.0.1" || UPSTREAM.hostname !== "127.0.0.1") {
  console.error("[tap] refused: bind host and upstream must be 127.0.0.1");
  process.exit(2);
}
if (!LOG) {
  console.error("[tap] refused: E2E_TAP_LOG is required");
  process.exit(2);
}

function cookieNames(header) {
  if (!header) return [];
  const list = Array.isArray(header) ? header.join(";") : String(header);
  return list
    .split(";")
    .map((p) => p.split("=")[0].trim())
    .filter(Boolean)
    .sort();
}

function authSummary(header) {
  if (!header) return null;
  const value = String(header);
  const space = value.indexOf(" ");
  const scheme = space < 0 ? value : value.slice(0, space);
  const out = { scheme };
  if (scheme.toLowerCase() === "bearer") {
    const token = value.slice(space + 1).trim();
    const head = token.split(".")[0] || "";
    try {
      const h = JSON.parse(Buffer.from(head, "base64url").toString("utf8"));
      out.alg = typeof h.alg === "string" ? h.alg : null;
      out.kid = typeof h.kid === "string" ? h.kid : null;
      out.typ = typeof h.typ === "string" ? h.typ : null;
    } catch {
      out.alg = null;
      out.kid = null;
      out.malformed = true;
    }
  }
  return out;
}

function record(entry) {
  try {
    appendFileSync(LOG, `${JSON.stringify(entry)}\n`);
  } catch {
    console.error("[tap] log write failed");
  }
}

const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });

// Epoch ms with sub-ms precision (timeOrigin + monotonic clock), for [startMs, endMs) spans.
const epochMs = () => Math.round((performance.timeOrigin + performance.now()) * 1000) / 1000;

const server = http.createServer((req, res) => {
  const t0 = performance.now();
  const startMs = epochMs();
  const url = new URL(req.url || "/", "http://tap.local");
  const entry = {
    ts: new Date().toISOString(),
    requestId: typeof req.headers["x-request-id"] === "string" ? req.headers["x-request-id"] : null,
    method: req.method,
    path: url.pathname,
    headerNames: Object.keys(req.headers).sort(),
    cookieNames: cookieNames(req.headers.cookie),
    auth: authSummary(req.headers.authorization),
  };
  const headers = { ...req.headers, host: UPSTREAM.host };
  const upstream = http.request(
    { host: UPSTREAM.hostname, port: UPSTREAM.port, method: req.method, path: req.url, headers, agent },
    (up) => {
      const setCookies = up.headers["set-cookie"] || [];
      res.writeHead(up.statusCode || 502, up.rawHeaders);
      up.pipe(res);
      up.on("end", () => {
        record({
          ...entry,
          status: up.statusCode,
          ms: Math.round(performance.now() - t0),
          startMs,
          endMs: epochMs(),
          setCookieNames: setCookies.map((l) => l.split("=")[0].trim()),
        });
      });
    },
  );
  upstream.on("error", (e) => {
    record({ ...entry, status: 0, ms: Math.round(performance.now() - t0), startMs, endMs: epochMs(), error: e.code || e.name });
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { code: "tap_upstream", message: "backend unreachable" } }));
  });
  req.pipe(upstream);
});

server.listen(PORT, HOST, () => {
  console.log(`[tap] listening on ${HOST}:${PORT} -> ${UPSTREAM.host}`);
});
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => server.close(() => process.exit(0)));
