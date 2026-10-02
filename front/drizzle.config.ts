import { defineConfig } from "drizzle-kit";

// Schema is the source of truth (code, not dashboard). Migrations are generated
// from lib/db/schema.ts and applied to the target Postgres — portable to any
// Postgres host (incl. a future on-prem HMG install).
export default defineConfig({
  schema: "./lib/db/schema.ts",
  out: "./lib/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
});
