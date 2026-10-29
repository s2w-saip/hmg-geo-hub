import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

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
    ignores: [".next/**", "node_modules/**", "lib/viz/**"],
  },
];

export default eslintConfig;
