import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { provisionAdmin, type AdminAdapter, type AdminProfile } from "./admin-core";
import { printDiagnostics, safeError, SetupError, validateAdminEnv, validateSetupEnv } from "./config";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("Usage: npm run setup:admin -- [--yes] [--promote-existing]\n기본: 읽기 전용 계획. --yes: 새 관리자 생성. --promote-existing: 기존 Auth 계정을 관리자/전체 범위/global 운영자로 승격 (비밀번호 유지).\n필수 env: DATABASE_URL, NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, SETUP_ADMIN_EMAIL, SETUP_ADMIN_PASSWORD");
  process.exit(0);
}
if (args.some((arg) => !["--yes", "--promote-existing"].includes(arg))) {
  console.error("알 수 없는 인수입니다. npm run setup:admin -- --help를 확인하세요. 비밀번호는 환경변수로만 전달하세요.");
  process.exit(1);
}
const issues = [...validateSetupEnv(process.env), ...validateAdminEnv(process.env)];
printDiagnostics(issues);
if (issues.some((issue) => issue.level === "error")) process.exit(1);

const db = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1, connect_timeout: 10, idle_timeout: 10, connection: { statement_timeout: 15000 } });
const auth = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(15000) }) },
});
const profileColumns = db`id, email, role, scope_all as "scopeAll", operator, menu_groups as "menuGroups"`;
const adapter: AdminAdapter = {
  async findAuthByEmail(email) {
    for (let page = 1; page <= 10000; page++) {
      const { data, error } = await auth.auth.admin.listUsers({ page, perPage: 100 });
      if (error) throw new SetupError("Auth 계정 조회 실패. SUPABASE_SERVICE_ROLE_KEY와 프로젝트 URL을 확인하세요.");
      const account = data.users.find((user) => user.email?.toLowerCase() === email);
      if (account) return { id: account.id, email: account.email! };
      if (data.users.length < 100) return null;
    }
    throw new SetupError("Auth 계정 조회 한도를 초과했습니다. 관리자가 대상 계정을 직접 확인해야 합니다.");
  },
  async findProfile(id) {
    const rows = await db<AdminProfile[]>`select ${profileColumns} from public.profiles where id = ${id}`;
    return rows[0] ?? null;
  },
  async findProfilesByEmail(email) {
    return await db<AdminProfile[]>`select ${profileColumns} from public.profiles where lower(email) = ${email}`;
  },
  async createAuth(email, password) {
    const { data, error } = await auth.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) throw new SetupError("Auth 계정 생성 실패. 이메일 중복, 비밀번호 정책, Service role 키를 확인하세요. 기존 계정은 변경하지 않았습니다.");
    return { id: data.user.id, email: data.user.email ?? email };
  },
  async authExistsInDatabase(id) {
    const rows = await db`select id from auth.users where id = ${id}`;
    return rows.length === 1;
  },
  async deleteCreatedAuth(id) {
    const { error } = await auth.auth.admin.deleteUser(id);
    if (error) throw new SetupError("방금 생성한 Auth 계정을 정리하지 못했습니다.");
  },
  async insertAdmin(id, email) {
    const rows = await db`insert into public.profiles (id, email, role, scope_all, operator, brands, regions, countries, menu_groups)
      values (${id}, ${email}, 'admin', true, 'global', null, null, null, null)
      on conflict (id) do nothing returning id`;
    if (!rows.length) throw new SetupError("profiles 행이 동시에 생성되어 덮어쓰지 않았습니다.");
  },
  async promoteAdmin(id, email) {
    await db`insert into public.profiles (id, email, role, scope_all, operator, brands, regions, countries, menu_groups)
      values (${id}, ${email}, 'admin', true, 'global', null, null, null, null)
      on conflict (id) do update set email = excluded.email, role = 'admin', scope_all = true,
        operator = 'global', brands = null, regions = null, countries = null, menu_groups = null, updated_at = now()`;
  },
};
try {
  const result = await provisionAdmin(adapter, {
    email: process.env.SETUP_ADMIN_EMAIL!, password: process.env.SETUP_ADMIN_PASSWORD!,
    write: args.includes("--yes"), promoteExisting: args.includes("--promote-existing"),
  });
  console.log(`${result.status}: email=${result.email}${result.id ? ` id=${result.id}` : ""}`);
  console.log("관리자 설정: role=admin, scope_all=true, operator=global, menu_groups=null");
  if (!args.includes("--yes")) console.log("읽기 전용으로 종료했습니다. 생성/승격을 적용하려면 --yes를 추가하세요.");
} catch (error) {
  console.error(safeError(error));
  process.exitCode = 1;
} finally {
  await db.end({ timeout: 5 });
}
