// `npm run db:drift` 전용 설정 — 운영/대상 DB 를 **읽기만** 해서(introspect)
// .drizzle-introspect/ 로 스냅샷을 뽑는다. 이 설정으로는 generate/migrate 를 돌리지
// 않는다(out 이 lib/db/migrations 가 아님에 주의).
//
// DATABASE_URL 은 env 로만 받는다 — argv 로 넘기면 `ps` 에 비밀번호가 노출된다.
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./lib/db/schema.ts",
  out: "./.drizzle-introspect",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
