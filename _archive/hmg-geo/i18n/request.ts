import { getRequestConfig } from "next-intl/server";
import { hasLocale } from "next-intl";
import { routing } from "./routing";
import { DISPLAY_TIME_ZONE } from "@/lib/as-of-date";

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested)
    ? requested
    : routing.defaultLocale;

  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
    // Pin the formatter time zone + reference time so next-intl date/relative
    // formatting is identical on the server (Vercel = UTC) and in the browser
    // (KST). Without this, `toLocale*`/`Date.now()` in render diverge between
    // SSR and hydration → React #418. HMG is a Korea-based product, so KST.
    timeZone: DISPLAY_TIME_ZONE,
    now: new Date(),
  };
});
