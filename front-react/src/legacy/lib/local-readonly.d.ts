// Type-only snapshot; no database or server implementation is included.
/** Explicit local reader mode. No account store, seed data, or cloud deployment. */
export declare function localReadOnly(env?: Record<string, string | undefined>): boolean;
/** Hosts the local mode answers: loopback plus the comma-separated HGH_LOCAL_ALLOWED_HOSTS (e.g. a VM's LAN IP).
 *  Every page on them still needs the HUB login. Next builds the middleware's req.nextUrl from the
 *  `next dev --hostname` bind address, not the Host header, so this checks where the server listens:
 *  bind to the allowed IP itself (0.0.0.0 is refused). */
export declare function localAllowedHost(hostname: string, env?: Record<string, string | undefined>): boolean;
