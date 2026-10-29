import { type NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import createIntlMiddleware from "next-intl/middleware";
import { routing } from "./i18n/routing";
import { isBlockedCrawler } from "./lib/crawlers";

const intlMiddleware = createIntlMiddleware(routing);

// Paths that don't require a session (relative to the locale prefix).
// /raw-data-qa 는 검수 콘솔 — GGMD 계정이 없는 외부 검수자가 쓰므로 Supabase 로그인
// 게이트를 면제하고, 자체 쿠키 게이트(lib/qa/auth.ts)가 대신 막는다. 이 표면이
// role 스코프 밖이라는 점은 의도된 트레이드오프이며 근거는
// docs/superpowers/specs/2026-09-04-raw-data-qa-console-design.md §3 에 있다.
const PUBLIC_PATHS = ["/login", "/raw-data-qa"];

export async function middleware(req: NextRequest) {
  // 0. Known crawlers (search, AI, SEO scrapers) get 410 Gone. robots.txt and
  // noindex are advisory; this is enforcement — and 410 is the status Google
  // treats as "remove from index permanently", which 403 is not guaranteed to
  // be. robots.txt itself is outside the matcher (has a dot), so bots can
  // still read it (see app/robots.ts for who is allowed to crawl and why).
  if (isBlockedCrawler(req.headers.get("user-agent"))) {
    return new NextResponse("Gone", {
      status: 410,
      headers: { "X-Robots-Tag": "noindex, nofollow" },
    });
  }

  // 1. next-intl handles locale routing; build the auth work on its response.
  const res = intlMiddleware(req);

  // 2. Refresh the Supabase auth session, persisting cookies on the response.
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return req.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            res.cookies.set(name, value, options),
          );
        },
      },
    },
  );
  // getClaims() verifies the JWT locally (WebCrypto) when the project uses
  // asymmetric signing keys — no Auth-server round-trip on the hot path that
  // runs for EVERY navigation. It still refreshes the session (persisting
  // cookies via the adapter above) when the access token is near expiry, and
  // falls back to a network check only for legacy symmetric secrets.
  const { data } = await supabase.auth.getClaims();
  const user = data?.claims ?? null;

  // 3. Auth gate: unauthenticated users may only reach public paths.
  const segments = req.nextUrl.pathname.split("/").filter(Boolean);
  const locale = routing.locales.includes(
    segments[0] as (typeof routing.locales)[number],
  )
    ? segments[0]
    : routing.defaultLocale;
  const rest = "/" + segments.slice(1).join("/");
  const isPublic = PUBLIC_PATHS.some(
    (p) => rest === p || rest.startsWith(p + "/"),
  );

  if (!isPublic && !user) {
    const url = req.nextUrl.clone();
    url.pathname = `/${locale}/login`;
    return NextResponse.redirect(url);
  }

  // 4. Expose the current pathname to server components (DashLayout) so the
  // route-policy guard can decide without re-parsing the URL. Layout reads
  // this with `headers().get("x-pathname")`.
  res.headers.set("x-pathname", req.nextUrl.pathname);

  return res;
}

export const config = {
  matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"],
};
