import { defineRouting } from "next-intl/routing";

// Locales: ko (default) + en. Adding a new locale = add it here and drop in
// messages/<locale>.json — no other code changes (see localization spec).
export const routing = defineRouting({
  locales: ["ko", "en"],
  defaultLocale: "ko",
});

export type Locale = (typeof routing.locales)[number];
