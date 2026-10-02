import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";
import { computeMirrorSourceHash } from "./scripts/mirror-cache-generation.mjs";
import { fileURLToPath } from "node:url";

const withNextIntl = createNextIntlPlugin();

const nextConfig: NextConfig = {
  env: {
    // Mirror-cache generation, derived from the transitive import closure of
    // lib/scope/server.ts (see scripts/mirror-cache-generation.mjs). Computed
    // once per build/dev startup; inlined into the bundle, so any deploy that
    // changes the aggregation surface automatically invalidates every mirror
    // cache cell. Replaces the hand-bumped generation discipline that was
    // violated twice on 2026-08-29 (PR #113, #114).
    MIRROR_CACHE_SOURCE_HASH: computeMirrorSourceHash(
      fileURLToPath(new URL(".", import.meta.url)),
    ),
  },
  // Belt-and-braces with app/robots.ts + layout metadata: the header also
  // covers responses that render no <head> (redirects, 404s, API routes).
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      },
    ];
  },
  experimental: {
    // Barrel-file optimization. These packages re-export everything from one
    // index, so a single named import (`import { Loader2 } from "lucide-react"`,
    // `import { forceCollide } from "d3"`) pulls the whole module graph into the
    // route chunk. Next rewrites them to per-module deep imports at build time.
    // recharts is the big one — it is imported by 11 client components.
    optimizePackageImports: [
      "recharts",
      "lucide-react",
      "d3",
      "d3-geo",
      "topojson-client",
    ],
  },
};

export default withNextIntl(nextConfig);
