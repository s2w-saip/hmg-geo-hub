// Local-only mock of the Supabase Auth endpoints the app touches (design 5.2).
//
//   node front/e2e/mock-auth/server.mjs      (started by front/e2e/stack.sh)
//
// Why: the app runs its real code path (Supabase cookie session -> getClaims() -> Bearer ->
// backend JWKS verification). Only the addresses in the environment change, so there is no
// test branch in app code. This server issues ES256 tokens with a key pair generated at
// start (kid "e2e-kid"); no token, key or password is ever stored in the repository.
//
// Refuses to start unless E2E_ALLOW_MOCK_AUTH=1 and the bind host is 127.0.0.1.
//
// Routes (Supabase Auth shapes, under /auth/v1):
//   GET  /auth/v1/.well-known/jwks.json          public ES256 JWK (front getClaims, backend PyJWKClient)
//   POST /auth/v1/token?grant_type=password      {email,password} against accounts.json -> session
//   POST /auth/v1/token?grant_type=refresh_token {refresh_token} -> rotated session (reuse detection below)
//   GET  /auth/v1/user                           Bearer -> user (the symmetric fallback: should stay unused)
//   POST /auth/v1/logout                         Bearer -> revokes that session's refresh tokens, 204
// Harness routes:
//   GET  /__e2e/health                           {ok, kid}
//   GET  /__e2e/stats                            request counts per route and outcome (no secrets)
//   POST /__e2e/config                           {email, exp_in} per-account token lifetime (seconds, 5..86400),
//                                                {email, exp_in: null} to clear, {reset: true} clears overrides and stats
//
// Refresh tokens follow Supabase's rotation: a token is single use; reusing it within 10 s returns the
// session's current (newest) token (parallel refresh grace), later reuse is refused (refresh_token_already_used).
//
// Logs: one line per request with method, route, status and ms. Never token, cookie or password values.
import http from "node:http";
import { createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HOST = process.env.E2E_AUTH_HOST || "127.0.0.1";
const PORT = Number(process.env.E2E_AUTH_PORT || 54399);
const ANON_KEY = process.env.E2E_ANON_KEY || "e2e-anon";
const KID = "e2e-kid";
const DEFAULT_EXP_IN = 3600;
const REFRESH_REUSE_GRACE_MS = 10_000;

if (process.env.E2E_ALLOW_MOCK_AUTH !== "1") {
  console.error("[mock-auth] refused: E2E_ALLOW_MOCK_AUTH=1 is required (local E2E only)");
  process.exit(2);
}
if (HOST !== "127.0.0.1") {
  console.error("[mock-auth] refused: bind host must be 127.0.0.1");
  process.exit(2);
}
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) {
  console.error("[mock-auth] refused: E2E_AUTH_PORT must be 1024..65535");
  process.exit(2);
}

const ISSUER = `http://${HOST}:${PORT}/auth/v1`;
const accountsPath = process.env.E2E_ACCOUNTS || fileURLToPath(new URL("../accounts.json", import.meta.url));
const accountsDoc = JSON.parse(readFileSync(accountsPath, "utf8"));
const PASSWORD = String(accountsDoc.password || "");
const ACCOUNTS = new Map(accountsDoc.accounts.map((a) => [String(a.email).toLowerCase(), a]));
if (!PASSWORD || ACCOUNTS.size === 0) {
  console.error("[mock-auth] refused: accounts.json needs a password and accounts");
  process.exit(2);
}

// ── key pair (per process) ──────────────────────────────────────────────────
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const PUBLIC_JWK = { ...publicKey.export({ format: "jwk" }), kid: KID, alg: "ES256", use: "sig", key_ops: ["verify"], ext: true };
// Round-trip once so a bad export fails at start, not on the first request.
createPublicKey({ key: PUBLIC_JWK, format: "jwk" });

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const b64uJson = (obj) => b64u(JSON.stringify(obj));

function signJwt(claims) {
  const head = b64uJson({ alg: "ES256", kid: KID, typ: "JWT" });
  const body = b64uJson(claims);
  const sig = sign("sha256", Buffer.from(`${head}.${body}`), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${head}.${body}.${b64u(sig)}`;
}

/** Verified claims of one of our tokens, or null (bad shape, signature, issuer or expired). */
function verifyJwt(token) {
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    if (header.alg !== "ES256" || header.kid !== KID) return null;
    const ok = verify("sha256", Buffer.from(`${parts[0]}.${parts[1]}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(parts[2], "base64url"));
    if (!ok) return null;
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (claims.iss !== ISSUER || typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}

// ── sessions ────────────────────────────────────────────────────────────────
const expOverride = new Map(); // email -> seconds
const refreshTokens = new Map(); // token -> { email, sessionId, usedAt, child, revoked }
const revokedSessions = new Set();

function userObject(account, nowIso) {
  return {
    id: account.id,
    aud: "authenticated",
    role: "authenticated",
    email: account.email,
    email_confirmed_at: nowIso,
    phone: "",
    confirmed_at: nowIso,
    last_sign_in_at: nowIso,
    app_metadata: { provider: "email", providers: ["email"] },
    user_metadata: {},
    identities: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: nowIso,
    is_anonymous: false,
  };
}

function issueSession(account, sessionId) {
  const now = Math.floor(Date.now() / 1000);
  const expIn = expOverride.get(account.email.toLowerCase()) ?? DEFAULT_EXP_IN;
  const claims = {
    iss: ISSUER,
    sub: account.id,
    aud: "authenticated",
    exp: now + expIn,
    iat: now,
    email: account.email,
    phone: "",
    app_metadata: { provider: "email", providers: ["email"] },
    user_metadata: {},
    role: "authenticated",
    aal: "aal1",
    amr: [{ method: "password", timestamp: now }],
    session_id: sessionId,
    is_anonymous: false,
  };
  const refresh = randomBytes(24).toString("base64url");
  const session = {
    access_token: signJwt(claims),
    token_type: "bearer",
    expires_in: expIn,
    expires_at: now + expIn,
    refresh_token: refresh,
    user: userObject(account, new Date(now * 1000).toISOString()),
  };
  refreshTokens.set(refresh, { email: account.email.toLowerCase(), sessionId, usedAt: null, child: null, session });
  return session;
}

/** The session holding the newest (unused) refresh token that descends from `entry`. */
function activeDescendant(entry) {
  let cur = entry;
  for (let i = 0; i < 1000 && cur.usedAt !== null && cur.child; i += 1) {
    const next = refreshTokens.get(cur.child.refresh_token);
    if (!next) break;
    cur = next;
  }
  return cur.session;
}

// ── stats ───────────────────────────────────────────────────────────────────
let stats = {};
function count(key) {
  stats[key] = (stats[key] || 0) + 1;
}

// ── http ────────────────────────────────────────────────────────────────────
function send(res, status, body, headers = {}) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "x-supabase-api-version": "2024-01-01",
    ...headers,
  });
  res.end(payload);
}

function authError(res, status, errorCode, msg) {
  send(res, status, { code: status, error_code: errorCode, msg });
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 64 * 1024) throw new Error("body too large");
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  const type = String(req.headers["content-type"] || "");
  if (type.includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(text));
  return JSON.parse(text);
}

function bearer(req) {
  const h = String(req.headers.authorization || "");
  return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : null;
}

function apiKeyOk(req) {
  return req.headers.apikey === ANON_KEY;
}

async function handle(req, res, url) {
  const route = url.pathname;

  if (route === "/__e2e/health" && req.method === "GET") return send(res, 200, { ok: true, kid: KID, issuer: ISSUER });
  if (route === "/__e2e/stats" && req.method === "GET") return send(res, 200, { stats, overrides: Object.fromEntries(expOverride) });
  if (route === "/__e2e/config" && req.method === "POST") {
    const body = await readBody(req);
    if (body.reset === true) {
      expOverride.clear();
      stats = {};
      return send(res, 200, { ok: true });
    }
    const email = String(body.email || "").toLowerCase();
    if (!ACCOUNTS.has(email)) return send(res, 400, { error: "unknown email" });
    if (body.exp_in === null) expOverride.delete(email);
    else {
      const n = Number(body.exp_in);
      if (!Number.isInteger(n) || n < 5 || n > 86_400) return send(res, 400, { error: "exp_in must be an integer 5..86400" });
      expOverride.set(email, n);
    }
    return send(res, 200, { ok: true });
  }

  if (route === "/auth/v1/.well-known/jwks.json" && req.method === "GET") {
    count("jwks");
    return send(res, 200, { keys: [PUBLIC_JWK] }, { "Cache-Control": "public, max-age=600" });
  }

  if (route === "/auth/v1/token" && req.method === "POST") {
    if (!apiKeyOk(req)) {
      count("token:no_apikey");
      return send(res, 401, { message: "Invalid API key" });
    }
    const grant = url.searchParams.get("grant_type");
    const body = await readBody(req);
    if (grant === "password") {
      const account = ACCOUNTS.get(String(body.email || "").toLowerCase());
      if (!account || body.password !== PASSWORD) {
        count("token:password:invalid");
        return authError(res, 400, "invalid_credentials", "Invalid login credentials");
      }
      count("token:password:ok");
      return send(res, 200, issueSession(account, randomUUID()));
    }
    if (grant === "refresh_token") {
      const entry = refreshTokens.get(String(body.refresh_token || ""));
      if (!entry || revokedSessions.has(entry.sessionId)) {
        count("token:refresh:not_found");
        return authError(res, 400, "refresh_token_not_found", "Invalid Refresh Token: Refresh Token Not Found");
      }
      const account = ACCOUNTS.get(entry.email);
      if (entry.usedAt !== null) {
        if (Date.now() - entry.usedAt <= REFRESH_REUSE_GRACE_MS && entry.child) {
          // Supabase answers a reuse inside the interval with the session's CURRENT token.
          count("token:refresh:grace");
          return send(res, 200, activeDescendant(entry));
        }
        count("token:refresh:reused");
        return authError(res, 400, "refresh_token_already_used", "Invalid Refresh Token: Already Used");
      }
      const next = issueSession(account, entry.sessionId);
      entry.usedAt = Date.now();
      entry.child = next;
      count("token:refresh:ok");
      return send(res, 200, next);
    }
    count("token:bad_grant");
    return authError(res, 400, "validation_failed", "unsupported grant_type");
  }

  if (route === "/auth/v1/user" && req.method === "GET") {
    count("user");
    const claims = verifyJwt(bearer(req));
    if (!claims) return authError(res, 403, "bad_jwt", "invalid JWT");
    const account = ACCOUNTS.get(String(claims.email || "").toLowerCase());
    if (!account) return authError(res, 404, "user_not_found", "User not found");
    return send(res, 200, userObject(account, new Date().toISOString()));
  }

  if (route === "/auth/v1/logout" && req.method === "POST") {
    count("logout");
    const claims = verifyJwt(bearer(req));
    if (claims?.session_id) revokedSessions.add(claims.session_id);
    res.writeHead(204, { "Cache-Control": "no-store" });
    return res.end();
  }

  count("not_found");
  return send(res, 404, { code: 404, error_code: "not_found", msg: "not found" });
}

const server = http.createServer(async (req, res) => {
  const t0 = performance.now();
  const url = new URL(req.url || "/", ISSUER);
  try {
    await handle(req, res, url);
  } catch (e) {
    if (!res.headersSent) send(res, 400, { code: 400, error_code: "bad_request", msg: "bad request" });
    else res.end();
    console.error(`[mock-auth] error ${req.method} ${url.pathname}: ${e instanceof Error ? e.name : "error"}`);
  }
  const grant = url.pathname === "/auth/v1/token" ? `?grant_type=${url.searchParams.get("grant_type")}` : "";
  console.log(`${new Date().toISOString()} ${req.method} ${url.pathname}${grant} ${res.statusCode} ${Math.round(performance.now() - t0)}ms`);
});

server.listen(PORT, HOST, () => {
  console.log(`[mock-auth] listening on ${HOST}:${PORT} issuer ${ISSUER} kid ${KID} accounts ${ACCOUNTS.size}`);
});
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => server.close(() => process.exit(0)));
