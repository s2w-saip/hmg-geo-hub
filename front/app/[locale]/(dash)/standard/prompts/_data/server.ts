import "server-only";
import { headers } from "next/headers";
import { screenGet } from "@/lib/screen";
import { collationOf } from "@/lib/standards/catalog-page";
import { historyParams, listParams } from "./screen-query";
import type { PromptsHeader, PromptsHistory, PromptsPage } from "./screen-types";

/** The first render sorts in the browser's language (Accept-Language), so hydration need not read again. */
async function requestCollation(): Promise<"ko" | "en"> {
  try {
    return collationOf((await headers()).get("accept-language"));
  } catch {
    return "en";
  }
}

/** The Global prompts pages' server reads: the first list page, the header period and the 90-day history. */
export async function loadPromptsScreens() {
  const collation = await requestCollation();
  const [catalog, header, history] = await Promise.all([
    screenGet<PromptsPage>("catalog/prompts-page", listParams({ collation })),
    screenGet<PromptsHeader>("catalog/prompts-header"),
    screenGet<PromptsHistory>("catalog/prompts-history", historyParams({ days: "90", event: "all" })),
  ]);
  return { catalog, header, history };
}
