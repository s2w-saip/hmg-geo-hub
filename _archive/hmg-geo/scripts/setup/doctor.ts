import { createClient } from "@supabase/supabase-js";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import postgres from "postgres";
import * as schema from "../../lib/db/schema";
import { printDiagnostics, safeError, SetupError, validateSetupEnv } from "./config";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("Usage: npm run setup:doctor -- [--connect]\n기본: env 형식만 검증 (네트워크 없음). --connect: DB/Auth 연결 및 schema.ts 테이블·컬럼 존재 여부 확인 (읽기 전용).\n로그인 비밀번호·권한·실측 데이터까지 검증하는 명령은 아닙니다. 인계 가이드의 로그인 수동 검증도 수행하세요.");
  process.exit(0);
}
if (args.some((arg) => arg !== "--connect")) {
  console.error("알 수 없는 인수입니다. npm run setup:doctor -- --help를 확인하세요.");
  process.exit(1);
}
const issues = validateSetupEnv(process.env);
printDiagnostics(issues);
if (issues.some((issue) => issue.level === "error")) process.exit(1);
console.log("PASS 필수 환경변수 형식 (값은 출력하지 않음)");
if (!args.includes("--connect")) {
  console.log("네트워크 검사 생략. 인계받은 DB/Auth 연결 준비 후 --connect로 검증하세요.");
  process.exit(0);
}

const sql = postgres(process.env.DATABASE_URL!, {
  prepare: false, max: 1, connect_timeout: 10, idle_timeout: 10,
  connection: { statement_timeout: 15000, default_transaction_read_only: true },
});
try {
  await sql`select 1`;
  console.log("PASS PostgreSQL 연결 (읽기 전용)");
  const isPgTable = (value: unknown): value is PgTable =>
    typeof value === "object" && value !== null && Symbol.for("drizzle:Name") in value;
  const schemaValues: unknown[] = Object.values(schema);
  const tables = schemaValues.filter(isPgTable).map(getTableConfig);
  const actual = await sql<{ table_name: string; column_name: string }[]>`
    select table_name, column_name from information_schema.columns where table_schema = 'public'`;
  const columns = new Set(actual.map((row) => `${row.table_name}.${row.column_name}`));
  const missing = tables.flatMap((table) => table.columns
    .filter((column) => !columns.has(`${table.name}.${column.name}`))
    .map((column) => `${table.name}.${column.name}`));
  if (missing.length) {
    console.error(`ERROR 스키마 컬럼 ${missing.length}개 누락. 새 DB라면 인계 가이드의 DB 초기화를 먼저 수행하세요.`);
    console.error(`누락 예: ${missing.slice(0, 12).join(", ")}`);
    throw new SetupError("DB 스키마 검증 실패. docs/handover-setup.md의 초기화 단계를 확인하세요. 이 명령은 DB를 수정하지 않습니다.");
  }
  console.log(`PASS schema.ts의 ${tables.length}개 테이블·컬럼 존재 확인 (타입/인덱스/summary 계열 검증은 DB 초기화 검증 참조)`);
  const authTable = await sql<{ exists: boolean }[]>`select to_regclass('auth.users') is not null as exists`;
  if (!authTable[0].exists) throw new SetupError("auth.users가 없습니다. DATABASE_URL은 Supabase Auth와 동일 프로젝트의 DB를 가리켜야 합니다.");

  const response = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL!.replace(/\/$/, "")}/auth/v1/settings`, {
    headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY! }, signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new SetupError("공개 키를 사용한 Supabase Auth 연결 실패. URL과 NEXT_PUBLIC_SUPABASE_ANON_KEY를 확인하세요.");
  const settings = await response.json() as { external?: { email?: boolean } };
  if (settings.external?.email !== true) throw new SetupError("Supabase Auth의 이메일 로그인이 꺼져 있거나 설정을 확인할 수 없습니다. Email provider를 켜세요.");
  console.log("PASS Supabase Auth 공개 키 및 Email provider");
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: { fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(15000) }) },
  });
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1 });
  if (error) throw new SetupError("Supabase Auth 관리자 API 연결 실패. SUPABASE_SERVICE_ROLE_KEY와 프로젝트 URL을 확인하세요.");
  // When an account exists, verify DB/Auth identity without printing personal data.
  if (data.users[0]) {
    const rows = await sql`select id from auth.users where id = ${data.users[0].id}`;
    if (!rows.length) throw new SetupError("Auth에서 조회한 계정이 DB의 auth.users에 없습니다. DATABASE_URL과 Auth URL이 같은 Supabase 프로젝트인지 확인하세요.");
  }
  console.log("PASS Supabase Auth 관리자 API (개인정보 출력 없음)");
  console.log("PASS 연결 검사 완료. 인계받은 기존 계정으로 앱 로그인을 확인하세요. 새 관리자가 필요한 경우에만 setup:admin을 사용하세요.");
} catch (error) {
  console.error(safeError(error));
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
