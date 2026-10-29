/**
 * Google Search Console connectivity probe — PoC, NOT wired into the app.
 *
 * AI Funnel Visibility의 SEO 축(GSC 노출/클릭) 실데이터 타진 (2026-07-02 결정:
 * Kia Italy PoC — GSC 권한 확인부터). GA4 probe(scripts/ga4/probe.ts)와 동일한
 * OAuth 패턴이되 scope가 달라(webmasters.readonly) 첫 실행에서 브라우저 재동의
 * 1회가 필요하다 (marketing@answer.global 로 로그인). 같은 Google Cloud OAuth
 * 클라이언트를 재사용하므로 그 프로젝트에 "Search Console API" 활성화 필요.
 *
 *   npm run gsc:probe                          # 사이트 목록 + kia.com 후보 자동 감지
 *   npm run gsc:probe -- --site sc-domain:kia.com --path /it/   # 특정 property 조회
 *   npm run gsc:probe -- --days 7
 *
 * Requires in .env.local (server-only, never NEXT_PUBLIC_):
 *   GA4_OAUTH_CLIENT_ID / GA4_OAUTH_CLIENT_SECRET  (GA4 probe와 공유)
 *
 * Refresh token은 .gsc-token.json에 캐시 (gitignored) — 이후 실행은 비대화식.
 */
import http from "node:http";
import fs from "node:fs";
import { exec } from "node:child_process";
import { OAuth2Client } from "google-auth-library";

const SCOPES = [
  "https://www.googleapis.com/auth/webmasters.readonly",
  "openid",
  "email",
];
const TOKEN_PATH = ".gsc-token.json";
const PORT = Number(process.env.GA4_OAUTH_PORT ?? 53682);
const REDIRECT_URI = `http://localhost:${PORT}`;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name} — set it in .env.local`);
  return v;
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function openBrowser(url: string) {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start \"\""
        : "xdg-open";
  exec(`${cmd} "${url}"`, () => {
    /* best-effort; the URL is also printed for manual opening */
  });
}

function persistTokens(incoming: Record<string, unknown>) {
  const existing = fs.existsSync(TOKEN_PATH)
    ? JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"))
    : {};
  const merged = { ...existing, ...incoming };
  // Google omits refresh_token on refresh responses — keep the one we have.
  if (!merged.refresh_token && existing.refresh_token) {
    merged.refresh_token = existing.refresh_token;
  }
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(merged, null, 2));
}

function waitForCode(authUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", REDIRECT_URI);
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      if (error) {
        res.end(`Auth error: ${error}. You can close this tab.`);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }
      if (!code) {
        res.statusCode = 400;
        res.end("Waiting for the OAuth redirect…");
        return;
      }
      res.end("✅ Search Console authorized. Close this tab and return to the terminal.");
      server.close();
      resolve(code);
    });
    server.on("error", reject);
    server.listen(PORT, () => {
      console.log(
        `\nAuthorize access (log in as marketing@answer.global):\n\n${authUrl}\n`,
      );
      openBrowser(authUrl);
    });
  });
}

async function authorize(): Promise<OAuth2Client> {
  const oauth = new OAuth2Client({
    clientId: requireEnv("GA4_OAUTH_CLIENT_ID"),
    clientSecret: requireEnv("GA4_OAUTH_CLIENT_SECRET"),
    redirectUri: REDIRECT_URI,
  });
  oauth.on("tokens", (t) => persistTokens(t as Record<string, unknown>));

  if (fs.existsSync(TOKEN_PATH)) {
    oauth.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8")));
    try {
      await oauth.getAccessToken(); // refreshes if expired
      return oauth;
    } catch {
      console.warn("Cached token unusable — re-authenticating…");
    }
  }

  // 기존 GA4 토큰(.ga4-token.json) 재사용 시도 — Google OAuth 토큰은 동의 시점의
  // scope로 고정되므로, GA4 동의가 webmasters scope 없이 이뤄졌다면 GSC 호출은
  // 403이 난다. 그래도 먼저 시도해서 "재동의가 정말 필요한지"를 실측으로 판별
  // (계정에 이미 넓은 동의가 있었으면 그대로 통과 → 브라우저 절차 생략).
  const GA4_TOKEN_PATH = ".ga4-token.json";
  if (fs.existsSync(GA4_TOKEN_PATH)) {
    const ga4Oauth = new OAuth2Client({
      clientId: requireEnv("GA4_OAUTH_CLIENT_ID"),
      clientSecret: requireEnv("GA4_OAUTH_CLIENT_SECRET"),
      redirectUri: REDIRECT_URI,
    });
    ga4Oauth.setCredentials(JSON.parse(fs.readFileSync(GA4_TOKEN_PATH, "utf8")));
    try {
      const t = (await ga4Oauth.getAccessToken()).token;
      const res = await fetch("https://www.googleapis.com/webmasters/v3/sites", {
        headers: { Authorization: `Bearer ${t}` },
      });
      if (res.ok) {
        console.log("GA4 토큰으로 GSC 접근 가능 — 재동의 불필요, 그대로 사용.\n");
        return ga4Oauth;
      }
      console.warn(
        `GA4 토큰으로 GSC 호출 → ${res.status} (scope 부족) — webmasters.readonly 재동의 필요.\n`,
      );
    } catch (e) {
      console.warn("GA4 토큰 재사용 실패:", e instanceof Error ? e.message : e);
    }
  }

  const authUrl = oauth.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
  });
  const { tokens } = await oauth.getToken(await waitForCode(authUrl));
  oauth.setCredentials(tokens);
  persistTokens(tokens as Record<string, unknown>);
  return oauth;
}

async function api<T>(token: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`GSC API failed (${res.status}) ${url}:\n${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

/** Best-effort: which Google account does this token belong to? */
async function whoAmI(token: string): Promise<string | null> {
  try {
    const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const info = (await res.json()) as { email?: string };
    return info.email ?? null;
  } catch {
    return null;
  }
}

interface SiteEntry {
  siteUrl: string;
  permissionLevel: string;
}
interface SearchAnalyticsRow {
  keys?: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

async function main() {
  const days = Number(argValue("--days") ?? 28);
  const siteArg = argValue("--site");
  const pathFilter = argValue("--path") ?? "/it/";

  const oauth = await authorize();
  const token = (await oauth.getAccessToken()).token;
  if (!token) throw new Error("No access token");

  const email = await whoAmI(token);
  if (email) console.log(`Authorized as: ${email}\n`);

  // 1) 접근 가능한 property 전수 — 권한 확인의 본체.
  const sites = await api<{ siteEntry?: SiteEntry[] }>(
    token,
    "https://www.googleapis.com/webmasters/v3/sites",
  );
  const entries = sites.siteEntry ?? [];
  console.log(`Accessible Search Console properties: ${entries.length}`);
  for (const s of entries) {
    console.log(`  ${s.permissionLevel.padEnd(22)} ${s.siteUrl}`);
  }
  if (entries.length === 0) {
    console.log(
      "\n→ 이 계정에 GSC property가 없습니다. kia.com property 소유자에게 권한(최소 '제한된' 읽기)을 요청하세요.",
    );
    return;
  }

  // 2) kia 후보 property에 searchanalytics 쿼리 — 데이터가 실제로 열리는지.
  const site =
    siteArg ??
    entries.find((s) => s.siteUrl.includes("kia"))?.siteUrl ??
    entries[0].siteUrl;
  const end = new Date();
  const start = new Date(end.getTime() - days * 86_400_000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  console.log(`\nQuerying ${site} — top pages (${iso(start)} ~ ${iso(end)}, path contains "${pathFilter}")`);

  const q = await api<{ rows?: SearchAnalyticsRow[] }>(
    token,
    `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`,
    {
      startDate: iso(start),
      endDate: iso(end),
      dimensions: ["page"],
      rowLimit: 15,
      dimensionFilterGroups: [
        {
          filters: [
            { dimension: "page", operator: "contains", expression: pathFilter },
          ],
        },
      ],
    },
  );
  const rows = q.rows ?? [];
  if (rows.length === 0) {
    console.log("  (no rows — path filter를 조정하거나 --path '' 로 전체 조회)");
    return;
  }
  console.log(
    `  ${"clicks".padStart(8)} ${"impressions".padStart(12)} ${"ctr".padStart(7)} ${"pos".padStart(6)}  page`,
  );
  for (const r of rows) {
    console.log(
      `  ${String(r.clicks).padStart(8)} ${String(r.impressions).padStart(12)} ${(100 * r.ctr).toFixed(1).padStart(6)}% ${r.position.toFixed(1).padStart(6)}  ${r.keys?.[0] ?? ""}`,
    );
  }
  console.log(
    "\n→ 여기까지 나오면 Visibility SEO 축(GSC) 배선 가능 — GA4 property-map 패턴으로 진행.",
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
