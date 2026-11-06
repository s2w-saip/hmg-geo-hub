import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const connected = env.VITE_HUB_CONNECTED === "true";
  return {
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "browser-boundary",
        enforce: "pre",
        resolveId(id, importer) {
          if (importer?.includes("/src/") && /^(?:next(?:\/|$)|next-intl(?:\/|$)|server-only$|node:|postgres$|drizzle-orm(?:\/|$))/.test(id)) {
            throw new Error(`Browser source imports a server dependency: ${id} (${importer})`);
          }
          return null;
        },
      },
    ],
    resolve: {
      alias: {
        "~": fileURLToPath(new URL("./src", import.meta.url)),
        "@": fileURLToPath(new URL("./src/legacy", import.meta.url)),
      },
    },
    server: {
      host: "127.0.0.1",
      port: 3334,
      strictPort: true,
      headers: { "X-Robots-Tag": "noindex, nofollow" },
      proxy: connected ? { "/api": { target: env.HUB_PROXY_TARGET || "http://127.0.0.1:5556", changeOrigin: false } } : undefined,
    },
    build: { sourcemap: false },
  };
});
