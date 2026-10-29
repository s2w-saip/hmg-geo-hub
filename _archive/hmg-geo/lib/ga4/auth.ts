import "server-only";
import fs from "node:fs";
import { OAuth2Client } from "google-auth-library";

// Server-only OAuth bridge for the GA4 Data API.
//
// PoC (scripts/ga4/probe.ts) authorized a user account interactively and
// cached the refresh token in `.ga4-token.json` (gitignored). For runtime use
// (BFF + server components) we lift the refresh token into an env var so prod
// (Vercel) can run headless. .ga4-token.json stays a dev convenience —
// `GA4_OAUTH_REFRESH_TOKEN` wins when set.
//
// Required env (server-only — NEVER NEXT_PUBLIC_):
//   GA4_OAUTH_CLIENT_ID
//   GA4_OAUTH_CLIENT_SECRET
//   GA4_OAUTH_REFRESH_TOKEN   (preferred; fallback: .ga4-token.json)

const TOKEN_PATH = ".ga4-token.json";

function readFileRefreshToken(): string | null {
  try {
    if (!fs.existsSync(TOKEN_PATH)) return null;
    const raw = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8")) as {
      refresh_token?: string;
    };
    return raw.refresh_token ?? null;
  } catch {
    return null;
  }
}

let cached: { client: OAuth2Client; expiresAt: number } | null = null;

export async function getGa4AccessToken(): Promise<string | null> {
  const clientId = process.env.GA4_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GA4_OAUTH_CLIENT_SECRET;
  const refreshToken =
    process.env.GA4_OAUTH_REFRESH_TOKEN ?? readFileRefreshToken();
  if (!clientId || !clientSecret || !refreshToken) return null;

  // Reuse the OAuth client across invocations; google-auth-library refreshes
  // the access token automatically when getAccessToken() is called after
  // expiry. We add a small TTL guard so the same Lambda warm-start reuses
  // an unexpired token instead of refreshing on every request.
  const now = Date.now();
  if (cached && cached.expiresAt > now + 60_000) {
    const t = (await cached.client.getAccessToken()).token;
    return t ?? null;
  }
  const client = new OAuth2Client({ clientId, clientSecret });
  client.setCredentials({ refresh_token: refreshToken });
  const { token } = await client.getAccessToken();
  cached = { client, expiresAt: now + 50 * 60_000 };
  return token ?? null;
}
