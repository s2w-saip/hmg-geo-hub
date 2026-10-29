// Known crawler user-agent tokens. Internal dashboard: none of them has any
// business here. Matched case-insensitively as substrings; deliberately NOT a
// generic "bot" match so uptime monitors and Vercel's own checks are not caught.
//
// Two groups, because permanent de-indexing needs different robots.txt
// treatment (Google: "don't use robots.txt as a blocking mechanism" — a
// crawler that is disallowed can never observe the 410/noindex that would
// drop the URL from its index, so the stale entry lingers as "blocked by
// robots.txt"):
//   - SEARCH_ENGINE_CRAWLERS: robots.txt *allows* them, middleware answers 410
//     Gone. They recrawl, see 410, and remove the URL for good.
//   - SCRAPER_CRAWLERS (AI trainers / answer engines / SEO tools): robots.txt
//     disallows them AND middleware answers 410 — belt and braces, no index
//     entry to clean up.
export const SEARCH_ENGINE_CRAWLERS = [
  "Googlebot", "Google-InspectionTool", "Storebot-Google", "GoogleOther",
  "AdsBot-Google", "bingbot", "BingPreview", "Slurp", "DuckDuckBot",
  "Baiduspider", "YandexBot", "Yeti", "NaverBot", "Daum", "kakaotalk-scrap",
  "SeznamBot", "Sogou", "360Spider", "PetalBot", "Applebot", "Qwantify",
  "coccocbot",
] as const;

export const SCRAPER_CRAWLERS = [
  // AI crawlers / answer engines
  "GPTBot", "ChatGPT-User", "OAI-SearchBot", "ClaudeBot", "Claude-Web",
  "Claude-User", "Claude-SearchBot", "anthropic-ai", "PerplexityBot",
  "Perplexity-User", "Google-Extended", "CCBot", "Bytespider", "Amazonbot",
  "meta-externalagent", "meta-externalfetcher", "FacebookBot", "cohere-ai",
  "Diffbot", "Applebot-Extended", "YouBot", "DuckAssistBot", "MistralAI-User",
  "TikTokSpider", "PanguBot", "Timpibot", "omgili", "ImagesiftBot",
  "img2dataset", "AI2Bot", "Ai2Bot-Dolma", "iaskspider",
  // archive / SEO scrapers
  "ia_archiver", "archive.org_bot", "AhrefsBot", "SemrushBot", "MJ12bot",
  "DotBot", "DataForSeoBot", "BLEXBot", "Screaming Frog", "SiteAuditBot",
  "Barkrowler", "serpstatbot", "MegaIndex",
] as const;

export const BLOCKED_CRAWLER_TOKENS = [
  ...SEARCH_ENGINE_CRAWLERS,
  ...SCRAPER_CRAWLERS,
] as const;

const NEEDLES = BLOCKED_CRAWLER_TOKENS.map((t) => t.toLowerCase());

export function isBlockedCrawler(userAgent: string | null): boolean {
  if (!userAgent) return false;
  const ua = userAgent.toLowerCase();
  return NEEDLES.some((n) => ua.includes(n));
}
