/** Validation is deliberately offline and never includes environment values in diagnostics. */
export type SetupEnv = Record<string, string | undefined>;
export type Diagnostic = { level: "error" | "warning"; name: string; message: string };
export const REQUIRED_ENV = [
  "DATABASE_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

function isPlaceholder(value: string): boolean {
  return /^(?:your[-_ ]|replace[-_ ]|change[-_ ]|example|<|\[)/i.test(value) ||
    /\[(?:your|project|password)|<(?:your|project|password)|your[-_]project|your[-_]password/i.test(value);
}

function parseUrl(value: string | undefined): URL | undefined {
  try { return value ? new URL(value) : undefined; } catch { return undefined; }
}

function jwtPayload(key: string): Record<string, unknown> | undefined {
  if (key.split(".").length !== 3) return undefined;
  try { return JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString()); }
  catch { return undefined; }
}

export function validateSetupEnv(env: SetupEnv): Diagnostic[] {
  const issues: Diagnostic[] = [];
  const error = (name: string, message: string) => issues.push({ level: "error", name, message });
  for (const name of REQUIRED_ENV) {
    if (!env[name]?.trim()) error(name, "값이 없습니다. .env.local에 수신측 Supabase 프로젝트 값을 입력하세요.");
    else if (isPlaceholder(env[name]!)) error(name, "예제 값을 실제 Supabase 프로젝트 값으로 바꾸세요.");
  }
  const project = parseUrl(env.NEXT_PUBLIC_SUPABASE_URL);
  if (env.NEXT_PUBLIC_SUPABASE_URL && (!project ||
      !["http:", "https:"].includes(project.protocol) || project.username || project.password ||
      project.search || project.hash || !["", "/"].includes(project.pathname))) {
    error("NEXT_PUBLIC_SUPABASE_URL", "Supabase 프로젝트의 HTTP(S) 기본 URL이어야 합니다 (경로/인증정보/쿼리 제외).");
  } else if (project && project.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(project.hostname)) {
    error("NEXT_PUBLIC_SUPABASE_URL", "로컬 개발 이외에는 HTTPS URL을 사용하세요.");
  }
  if (project && (project.hostname === "example.com" || project.hostname.endsWith(".example.com"))) {
    error("NEXT_PUBLIC_SUPABASE_URL", "예제 도메인을 실제 프로젝트 URL로 바꾸세요.");
  }
  const database = parseUrl(env.DATABASE_URL);
  if (env.DATABASE_URL && (!database || !["postgres:", "postgresql:"].includes(database.protocol) ||
      !database.username || !database.password || database.pathname.length < 2)) {
    error("DATABASE_URL", "사용자·비밀번호·DB 이름이 포함된 postgres:// 또는 postgresql:// 연결 문자열이 필요합니다. 비밀번호 특수문자는 URL 인코딩하세요.");
  }
  const projectRef = project?.hostname.match(/^([a-z0-9]+)\.supabase\.co$/)?.[1];
  const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  const dbRef = database?.hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/)?.[1] ??
    (database?.hostname.endsWith(".pooler.supabase.com") ? database.username.match(/^.+\.([a-z0-9]+)$/)?.[1] : undefined);
  if (projectRef && dbRef && projectRef !== dbRef) {
    error("DATABASE_URL", "DB 연결 문자열과 Auth URL의 Supabase 프로젝트가 다릅니다. 동일 프로젝트에서 복사하세요.");
  }
  if (project && database) {
    const localPair = localHosts.has(project.hostname) && localHosts.has(database.hostname);
    if (!localPair && (!projectRef || !dbRef || projectRef !== dbRef)) {
      error("DATABASE_URL", "설정 도구는 동일 Supabase 프로젝트의 공식 Auth URL + 직접/pooler DB 주소 또는 모두 localhost인 로컬 Supabase만 지원합니다. 혼합된 프로젝트/로컬 주소는 사용할 수 없습니다.");
    }
    if (database.pathname !== "/postgres") error("DATABASE_URL", "Supabase Auth와 같은 postgres 데이터베이스를 사용하세요.");
  }
  for (const [name, role, modernPrefix] of [
    ["NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon", "sb_publishable_"],
    ["SUPABASE_SERVICE_ROLE_KEY", "service_role", "sb_secret_"],
  ] as const) {
    const key = env[name]?.trim();
    if (!key || isPlaceholder(key)) continue;
    const payload = jwtPayload(key);
    if (!payload && !key.startsWith(modernPrefix)) {
      error(name, `Supabase의 ${role} JWT 또는 ${modernPrefix} 키를 입력하세요.`);
    } else if (payload && payload.role !== role) {
      error(name, `키 역할이 ${role}이어야 합니다. 공개 키와 서버 전용 키를 바꾸어 넣지 마세요.`);
    }
    // Payload inspection is only a typo check; --connect verifies credentials with Auth.
    if (payload?.ref && projectRef && payload.ref !== projectRef) error(name, "키와 프로젝트 URL의 project ref가 다릅니다.");
    if (typeof payload?.exp === "number" && payload.exp * 1000 <= Date.now()) error(name, "키의 JWT가 만료되었습니다. Supabase에서 현재 키를 복사하세요.");
  }
  if (env.SCOPE_MODE && !["mock", "live"].includes(env.SCOPE_MODE)) error("SCOPE_MODE", "mock 또는 live만 사용할 수 있습니다.");
  if (env.SCOPE_MODE === "live") {
    for (const name of ["SCOPE_API_BASE", "SCOPE_API_KEY"]) {
      if (!env[name]?.trim() || isPlaceholder(env[name]!)) error(name, "SCOPE_MODE=live에서는 실제 Scope 연동 값이 필요합니다. 초기 인계 확인은 SCOPE_MODE=mock으로 실행하세요.");
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(env.SCOPE_ROOT_PROJECT_ID ?? "")) {
      error("SCOPE_ROOT_PROJECT_ID", "SCOPE_MODE=live에서는 Scope 루트 프로젝트의 UUID가 필요합니다.");
    }
  } else {
    issues.push({ level: "warning", name: "SCOPE_MODE", message: "mock 모드: 측정 엔진 샘플 응답을 사용합니다. 실제 측정 데이터 연동 확인은 포함되지 않습니다." });
  }
  if (env.STANDARD_ROOT_PROJECT_ID && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(env.STANDARD_ROOT_PROJECT_ID)) {
    error("STANDARD_ROOT_PROJECT_ID", "설정한다면 프로젝트 UUID여야 합니다.");
  }
  return issues;
}

export function validateAdminEnv(env: SetupEnv, requireNewPassword = true): Diagnostic[] {
  const issues: Diagnostic[] = [];
  if (!env.SETUP_ADMIN_EMAIL || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.SETUP_ADMIN_EMAIL) || /[\x00-\x1f\x7f]/.test(env.SETUP_ADMIN_EMAIL)) {
    issues.push({ level: "error", name: "SETUP_ADMIN_EMAIL", message: "첫 관리자 이메일을 환경변수로 지정하세요." });
  }
  if (!env.SETUP_ADMIN_PASSWORD || (requireNewPassword && (env.SETUP_ADMIN_PASSWORD.length < 12 || isPlaceholder(env.SETUP_ADMIN_PASSWORD)))) {
    issues.push({ level: "error", name: "SETUP_ADMIN_PASSWORD", message: requireNewPassword
      ? "12자 이상의 새 관리자 비밀번호를 환경변수로 지정하세요. 명령행 인수로 전달하지 마세요."
      : "점검할 기존 관리자 비밀번호를 환경변수로 지정하세요. 명령행 인수로 전달하지 마세요." });
  }
  return issues;
}

export function printDiagnostics(issues: Diagnostic[]): void {
  for (const issue of issues) console.log(`${issue.level.toUpperCase()} ${issue.name}: ${issue.message}`);
}

export class SetupError extends Error {}

/** Raw upstream/SQL exceptions may contain credentials or query parameters. */
export function safeError(error: unknown): string {
  return error instanceof SetupError ? error.message : "연결 또는 처리 실패. 네트워크·Supabase 상태·키·DB 권한을 확인하세요 (비밀정보 보호를 위해 원문 오류 생략).";
}
