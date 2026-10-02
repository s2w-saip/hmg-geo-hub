import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { knownFailurePattern } from "./test/hgh-known-upstream-failures";

// Tiny config: enables the `@/*` path alias (mirrors tsconfig.json) so test
// files can import from app/ and lib/ with the same paths the runtime uses.
// No env / setup file needed yet — pure-function tests dominate.
export default defineConfig({
  // Components are authored against the automatic JSX runtime (Next injects it;
  // nothing imports React just to render). esbuild defaults to the classic
  // transform, which would fail those files with "React is not defined" the
  // moment a test imports one — so match the app's runtime here.
  esbuild: { jsx: "automatic" },
  // hub: upstream tests that fail on the vendored upstream tree itself, isolated by full name
  // (list, reasons, upstream commits and release: test/hgh-known-upstream-failures.ts).
  // HGH_RUN_KNOWN_FAILURES=1 runs them (check at each sync whether upstream fixed them).
  test: {
    testNamePattern: process.env.HGH_RUN_KNOWN_FAILURES === "1" ? undefined : knownFailurePattern(),
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
      // `server-only` is a build-time guard with no runtime/vitest module;
      // alias it to an empty shim so tests can load real server modules.
      "server-only": fileURLToPath(
        new URL("./test/shims/server-only.ts", import.meta.url),
      ),
    },
  },
});
