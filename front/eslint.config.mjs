import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

// App code must never import the local E2E harness (mock auth server, Playwright specs).
// Type-only imports are banned too: e2e/ is excluded from deployments (.vercelignore).
// Regex, not globs: the source may be aliased (@/e2e), relative at any depth (../../e2e)
// or local (./e2e from middleware.ts).
const E2E_IMPORT_BAN = {
  regex: "^(?:@/|(?:\\.\\./)+|\\./)?e2e(?:/.*)?$",
  message: "App code must not import the E2E harness (front/e2e is local-only and not deployed).",
};

// New backend-API code (lib/hgh/**) must not call the legacy data layer at runtime.
// Types may still be imported from there until the closing clean-up (design 2.1, 4.4).
// Matches the alias (@/lib/db, @/lib/scope/server, with or without .ts/.js) and relative
// sources at any depth, with or without the lib/ segment (../db, ../../lib/db/client,
// ../../../lib/scope/server.ts).
const LEGACY_DATA_BAN = {
  regex: "^(?:@/lib/|(?:\\.\\./)+(?:lib/)?)(?:db(?:\\.[jt]sx?)?(?:/.*)?|scope/server(?:\\.[jt]sx?)?)$",
  allowTypeImports: true,
  message:
    "lib/hgh talks to the backend API only. Import types with `import type`, never runtime code from lib/db or lib/scope/server.",
};

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // data-access-security: the raw DB client is reachable only through the
      // repository layer in lib/db. Everywhere else must import a repository,
      // not the client — this keeps the scope-enforcement choke point intact.
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/lib/db",
              message:
                "Import a repository from lib/db/repositories instead of the raw DB client.",
            },
          ],
        },
      ],
    },
  },
  {
    // Inside lib/db the client import is expected (repositories, scoped helpers).
    files: ["lib/db/**"],
    rules: { "no-restricted-imports": "off" },
  },
  {
    files: ["app/**", "components/**", "hooks/**", "lib/**", "utils/**", "i18n/**", "middleware.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", { patterns: [E2E_IMPORT_BAN] }],
    },
  },
  {
    // Later block wins for the same rule: lib/hgh gets both bans. Tests are exempt from the
    // legacy ban only (parity tests may call the legacy function they replace).
    files: ["lib/hgh/**"],
    ignores: ["lib/hgh/**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", { patterns: [E2E_IMPORT_BAN, LEGACY_DATA_BAN] }],
    },
  },
  {
    ignores: [".next/**", "node_modules/**", "lib/viz/**", "lib/hgh/api-types.ts"],
  },
];

export default eslintConfig;
