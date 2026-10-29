import { createServerClient } from "@supabase/ssr";
import { printDiagnostics, safeError, SetupError, validateAdminEnv, validateSetupEnv } from "./config";
import { assertRenderedPage, isLoginRedirect, smokeBaseUrl } from "./smoke-checks";

if (process.argv.slice(2).includes("--help")) {
  console.log("Usage: npm run setup:smoke\n실행 중인 앱 + Supabase에 관리자 테스트 세션으로 접속합니다. env: SETUP_ADMIN_EMAIL, SETUP_ADMIN_PASSWORD, SETUP_SMOKE_BASE_URL (기본 http://127.0.0.1:3000).\n로그인 폼 UI는 별도 브라우저 확인이 필요합니다. 테스트 세션만 종료하며 계정/데이터를 생성하지 않습니다.");
  process.exit(0);
}
if (process.argv.length > 2) {
  console.error("인수 대신 SETUP_SMOKE_BASE_URL 환경변수를 지정하세요. --help를 참고하세요.");
  process.exit(1);
}
const issues = [...validateSetupEnv(process.env), ...validateAdminEnv(process.env, false)];
printDiagnostics(issues);
if (issues.some((issue) => issue.level === "error")) process.exit(1);

const jar = new Map<string, string>();
const client = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
  cookies: {
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    setAll: (cookies) => {
      for (const { name, value, options } of cookies) {
        if (options.maxAge === 0) jar.delete(name);
        else jar.set(name, value);
      }
    },
  },
  global: { fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(15000) }) },
});
let signedIn = false;
try {
  const base = smokeBaseUrl(process.env.SETUP_SMOKE_BASE_URL);
  const login = await fetch(new URL("/ko/login", base), { redirect: "manual", signal: AbortSignal.timeout(30000) });
  assertRenderedPage("/ko/login", login.status, login.headers.get("content-type") ?? "", await login.text());
  console.log("PASS /ko/login 공개 로그인 페이지");

  const anonymous = await fetch(new URL("/ko/dashboard", base), { redirect: "manual", signal: AbortSignal.timeout(30000) });
  if (!isLoginRedirect(anonymous.status, anonymous.headers.get("location"), base)) {
    throw new SetupError("로그인 전 /ko/dashboard가 로그인 페이지로 리디렉션되지 않았습니다.");
  }
  await anonymous.body?.cancel();
  console.log("PASS 로그인 전 대시보드 접근 보호");

  const { data, error } = await client.auth.signInWithPassword({
    email: process.env.SETUP_ADMIN_EMAIL!, password: process.env.SETUP_ADMIN_PASSWORD!,
  });
  if (error || !data.user || !data.session || !jar.size) throw new SetupError("Supabase 테스트 로그인 실패. 관리자 이메일/비밀번호와 Auth 설정을 확인하세요.");
  signedIn = true;
  console.log(`PASS Supabase 로그인 email=${data.user.email} id=${data.user.id}`);
  const cookie = [...jar].map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join("; ");
  for (const path of ["/ko/dashboard", "/ko/projects", "/ko/website", "/ko/admin", "/ko/standard/ai-funnel/acr", "/en/dashboard"]) {
    const response = await fetch(new URL(path, base), {
      headers: { cookie }, redirect: "manual", signal: AbortSignal.timeout(45000),
    });
    assertRenderedPage(path, response.status, response.headers.get("content-type") ?? "", await response.text());
    console.log(`PASS ${path} 로그인 후 HTML 렌더링`);
  }
  console.log("PASS HTTP 재현 검사 완료. 로그인 폼 UI 및 실제 측정 데이터는 별도 확인하세요.");
} catch (error) {
  console.error(safeError(error));
  process.exitCode = 1;
} finally {
  if (signedIn) {
    const { error } = await client.auth.signOut({ scope: "local" });
    if (error) {
      console.error("테스트 세션 종료 실패. 앱/계정 정보는 변경하지 않았습니다.");
      process.exitCode = 1;
    } else console.log("PASS 해당 테스트 세션 종료");
  }
  jar.clear();
}
