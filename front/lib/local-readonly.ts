/** Explicit local reader mode. No account store, seed data, or cloud deployment. */
export function localReadOnly(env: Record<string, string | undefined> = process.env): boolean {
  return env.HGH_LOCAL_READ_ONLY === "1" && !env.VERCEL;
}

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]", "::1"];

/** Hosts the local mode answers: loopback plus the comma-separated HGH_LOCAL_ALLOWED_HOSTS (e.g. a VM's LAN IP).
 *  Every page on them still needs the HUB login. Next builds the middleware's req.nextUrl from the
 *  `next dev --hostname` bind address, not the Host header, so this checks where the server listens:
 *  bind to the allowed IP itself (0.0.0.0 is refused). */
export function localAllowedHost(hostname: string, env: Record<string, string | undefined> = process.env): boolean {
  const extra = (env.HGH_LOCAL_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  return LOOPBACK_HOSTS.includes(hostname) || extra.includes(hostname.toLowerCase());
}
