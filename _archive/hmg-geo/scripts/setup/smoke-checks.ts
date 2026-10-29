import { SetupError } from "./config";

export function smokeBaseUrl(value: string | undefined): URL {
  let url: URL;
  try { url = new URL(value || "http://127.0.0.1:3000"); }
  catch { throw new SetupError("SETUP_SMOKE_BASE_URL은 실행 중인 앱의 HTTP(S) 기본 URL이어야 합니다."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new SetupError("SETUP_SMOKE_BASE_URL에는 앱의 HTTP(S) 기본 URL만 지정하세요 (인증정보/경로/쿼리 제외).");
  }
  return url;
}

export function assertRenderedPage(path: string, status: number, contentType: string, html: string): void {
  if (status !== 200) throw new SetupError(`${path}: HTTP ${status}. 앱 로그와 관리자 프로필을 확인하세요.`);
  if (!contentType.includes("text/html") || html.length < 500) throw new SetupError(`${path}: 정상 HTML 페이지를 받지 못했습니다.`);
  // Next can send HTTP 200 before a streamed Server Component fails. Detect
  // both raw RSC rows and rows escaped inside self.__next_f.push(...).
  if (/NEXT_REDIRECT|NEXT_HTTP_ERROR_FALLBACK|:E\{\\?"digest\\?":|Application error: a server-side exception/i.test(html)) {
    throw new SetupError(`${path}: 페이지 스트림에 redirect/error가 있습니다. 앱 서버 로그를 확인하세요.`);
  }
}

export function isLoginRedirect(status: number, location: string | null, base: URL): boolean {
  if (![303, 307, 308].includes(status) || !location) return false;
  let target: URL;
  try { target = new URL(location, base); } catch { return false; }
  const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);
  // Next's local server can canonicalize 127.0.0.1 to localhost. Only accept
  // this for an unauthenticated response at the same port/protocol; no cookies
  // are sent to the redirect destination by the smoke script.
  const sameLocalApp = loopback.has(base.hostname) && loopback.has(target.hostname) &&
    base.port === target.port && base.protocol === target.protocol;
  return target.pathname === "/ko/login" && (target.origin === base.origin || sameLocalApp);
}
