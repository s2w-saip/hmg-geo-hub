import { getRequestConfig } from "next-intl/server";
import { hasLocale } from "next-intl";
import { routing } from "./routing";
import { DISPLAY_TIME_ZONE } from "@/lib/as-of-date";

// Messages = messages/<locale>.json deep-merged with per-unit files
// messages/units/<unit>.<locale>.json (API migration units U1..U12, design 4.1-3).
// Each unit adds or overrides keys only in its own file, so parallel units never edit
// the shared dictionaries. Merge order: base, then UNIT_MESSAGE_FILES in order (a later
// unit wins on the same key). Objects merge recursively; any other value replaces.
// A unit file that does not exist is skipped; a file that exists but fails to load
// (bad JSON) throws, so a broken dictionary cannot ship silently.
export const UNIT_MESSAGE_FILES = [
  "u1",
  "u2",
  "u3",
  "u4",
  "u5",
  "u6",
  "u7",
  "u8",
  "u9",
  "u10",
  "u11",
  "u12",
] as const;

export type Messages = { [key: string]: unknown };

const isPlainObject = (v: unknown): v is Messages =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Deep merge without mutating either input (the base module object is shared across requests). */
export function deepMergeMessages(base: Messages, overlay: Messages): Messages {
  const out: Messages = { ...base };
  for (const key of Object.keys(overlay)) {
    const next = overlay[key];
    const prev = out[key];
    out[key] = isPlainObject(prev) && isPlainObject(next) ? deepMergeMessages(prev, next) : next;
  }
  return out;
}

/**
 * "This unit file is absent" across bundlers. webpack (next build/dev) and Vite (vitest)
 * both turn the template import into a map of the files that exist at build time and
 * reject other names: webpack with code MODULE_NOT_FOUND, Vite with "Unknown variable
 * dynamic import". Node ESM uses ERR_MODULE_NOT_FOUND.
 */
export function isMissingModuleError(e: unknown): boolean {
  const err = e as { code?: unknown; message?: unknown } | null;
  if (err?.code === "MODULE_NOT_FOUND" || err?.code === "ERR_MODULE_NOT_FOUND") return true;
  const msg = typeof err?.message === "string" ? err.message : "";
  return /Cannot find module|Unknown variable dynamic import|Failed to load url/.test(msg);
}

async function importUnit(unit: string, locale: string): Promise<Messages | null> {
  try {
    return (await import(`../messages/units/${unit}.${locale}.json`)).default as Messages;
  } catch (e) {
    if (isMissingModuleError(e)) return null;
    throw e;
  }
}

export async function loadMessages(locale: string): Promise<Messages> {
  let messages = (await import(`../messages/${locale}.json`)).default as Messages;
  for (const unit of UNIT_MESSAGE_FILES) {
    const overlay = await importUnit(unit, locale);
    if (overlay) messages = deepMergeMessages(messages, overlay);
  }
  return messages;
}

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested)
    ? requested
    : routing.defaultLocale;

  return {
    locale,
    messages: await loadMessages(locale),
    // Pin the formatter time zone + reference time so next-intl date/relative
    // formatting is identical on the server (Vercel = UTC) and in the browser
    // (KST). Without this, `toLocale*`/`Date.now()` in render diverge between
    // SSR and hydration → React #418. HMG is a Korea-based product, so KST.
    timeZone: DISPLAY_TIME_ZONE,
    now: new Date(),
  };
});
