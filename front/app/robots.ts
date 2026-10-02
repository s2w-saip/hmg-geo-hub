import type { MetadataRoute } from "next";
import { SCRAPER_CRAWLERS, SEARCH_ENGINE_CRAWLERS } from "@/lib/crawlers";

// Internal customer dashboard — nothing here should be indexed.
//
// Search engines are ALLOWED to crawl on purpose: middleware answers them with
// 410 Gone, which is what permanently drops an already-indexed URL (Google's
// removal guidance: 404/410 or noindex must be *observable*; a robots.txt
// disallow prevents that and leaves the stale entry in the index). Everyone
// else — AI trainers, answer engines, SEO tools, and the wildcard — is
// disallowed here and also gets 410 from middleware.

// 검수 콘솔(설계 §3 완화책). 로케일 접두가 붙으므로 두 경로 모두 막는다.
const QA_CONSOLE_PATHS = ["/raw-data-qa", "/*/raw-data-qa"];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      // 검색엔진에는 allow 를 주되 /raw-data-qa 만은 명시적으로 뺀다. 위 410 논리는
      // "이미 색인된 URL 을 지우려면 크롤이 관측돼야 한다"는 것인데, 검수 콘솔은
      // 애초에 색인된 적이 없어 지울 것이 없고 — 크롤 자체를 막는 편이 낫다.
      ...SEARCH_ENGINE_CRAWLERS.map((userAgent) => ({
        userAgent,
        allow: "/",
        disallow: QA_CONSOLE_PATHS,
      })),
      ...SCRAPER_CRAWLERS.map((userAgent) => ({ userAgent, disallow: "/" })),
      { userAgent: "*", disallow: "/" },
    ],
  };
}
