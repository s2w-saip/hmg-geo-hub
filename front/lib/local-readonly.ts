/** Explicit local reader mode. No account store, seed data, or cloud deployment. */
export function localReadOnly(env: Record<string, string | undefined> = process.env): boolean {
  return env.HGH_LOCAL_READ_ONLY === "1" && !env.VERCEL;
}
