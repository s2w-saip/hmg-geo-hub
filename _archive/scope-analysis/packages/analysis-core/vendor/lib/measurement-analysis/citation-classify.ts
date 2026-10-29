// Citation domain classification — deterministic host parse + maintained lookup
// table + LLM fallback (cached per host by the store). A citation's host is
// classified once into a fixed category set + free-text subcategory and reused
// across every answer that cites that host. change
// measurement-llm-sentiment-citation-classification.

import { z } from "zod";

// ⚠️ **타입 전용 import 다** — 값으로 가져오면 `@/lib/llm/invoke` →
// `lib/llm/cost.ts` → `@/lib/db` + `@/db/schema` 가 딸려 온다(플랜 §1.3 L2).
import type { ClaudeRequest, ClaudeResponse } from "@/lib/llm/invoke";
import {
  CitationCategorySchema,
  type CitationCategory,
  type CitationDomainClassification,
} from "./schema";

import { registrableDomain } from "@/lib/public-suffix";

/**
 * Full normalized hostname from a citation url — lowercase, trailing dot and a
 * leading `www.` stripped, everything else preserved. Tolerates bare hosts and
 * a missing scheme. Returns null when nothing host-like can be parsed.
 *
 * `www.` is folded because `www.X` and `X` are the same site everywhere in
 * practice; deeper labels are NOT folded because they routinely denote separate
 * businesses under one registrable domain (`bestshop.lge.co.kr` = LG 베스트샵
 * the retailer vs `www.lge.co.kr` = LG닷컴 the manufacturer).
 */
export function normalizedHostname(
  rawUrl: string | null | undefined,
): string | null {
  if (!rawUrl || typeof rawUrl !== "string") return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  let hostname: string | null = null;
  try {
    hostname = new URL(trimmed).hostname;
  } catch {
    try {
      hostname = new URL(`https://${trimmed}`).hostname;
    } catch {
      hostname = null;
    }
  }
  if (!hostname) return null;
  let host = hostname.toLowerCase().replace(/^www\./, "");
  if (host.endsWith(".")) host = host.slice(0, -1);
  return host || null;
}

/**
 * Registrable domain (eTLD+1) from a citation url. Tolerates bare hosts and a
 * missing scheme. Returns null only when nothing host-like can be parsed.
 *
 * The public suffix comes from the Public Suffix List (lib/public-suffix), not
 * a hand-maintained set. The previous hardcoded list of 24 multi-part suffixes
 * silently mis-folded everything it omitted — measured on live data
 * (2026-07-26): 184 suffixes / 11,203 citations / 1,042 hosts, so e.g. all 122
 * distinct `.co.il` sites (2,292 citations) collapsed into a single `co.il`
 * row. A curated list also cannot express PSL wildcard rules at all (`*.mm`),
 * which is why this is a replacement rather than more entries.
 *
 * This changes leaderboard row GROUPING only. Owned-domain judgement is
 * unaffected: no project's owned host set moves, so `citationShare` and the
 * risk index's `ownedCitationAbsent` are unchanged for every project. (Under
 * change citation-owned-host-precision the four affected project domains hit
 * the sub-host branch precisely BECAUSE this list was wrong, so their owned
 * judgement was already accidentally correct — this change makes it correct by
 * design instead.)
 *
 * When the host has no registrable domain — it IS a public suffix (`co.uk`), a
 * single label, or an IP literal — we return the normalized host itself rather
 * than null, so the citation still gets a stable leaderboard row instead of
 * being silently dropped. That matches the old function's behaviour for <=2
 * label hosts; for IPv4 it is a fix (the old code folded `192.168.0.1` to
 * `0.1`, bucketing unrelated IPs together). Guarded by
 * citation-owned-host.test.ts — deleting the fallback silently drops those
 * citations from the leaderboard.
 */
export function registrableHost(rawUrl: string | null | undefined): string | null {
  const host = normalizedHostname(rawUrl);
  if (!host) return null;
  return registrableDomain(host) ?? host;
}

/**
 * Host keying + owned judgement for citation analytics, derived from a
 * project's configured domains (`projects.domain`, generic — never
 * brand-hardcoded).
 *
 * Two ownership precisions, decided per configured domain:
 *
 * - **Registrable-level** (`lge.co.kr`) — everything under the registrable
 *   domain is owned and stays folded into one leaderboard row. This is the
 *   historical behaviour and remains the default, so projects that never set a
 *   sub-host are unaffected.
 * - **Host-level** (`bestshop.lge.co.kr`) — only that host and its own
 *   subdomains are owned. Sibling hosts (`www.lge.co.kr`, `jammy.lge.co.kr`)
 *   and the bare registrable domain are NOT owned. Because a folded
 *   `lge.co.kr` row could no longer answer "is this us?", the whole registrable
 *   domain is then **split to hostname precision** in the leaderboard so the
 *   retailer and the manufacturer are separate rows.
 *
 * Only registrable domains a project actually claims a sub-host of are split —
 * every other domain in every other project keeps registrable-domain rows.
 */
export interface CitationHostResolver {
  /**
   * Grouping key for a citation url: the registrable domain, except under a
   * split registrable domain where it is the full normalized hostname.
   */
  hostKey(rawUrl: string | null | undefined): string | null;
  /** Does this host key belong to the project? */
  isOwned(hostKey: string): boolean;
  /** Registrable domains rendered at hostname precision (diagnostics/tests). */
  readonly splitDomains: ReadonlySet<string>;
}

export function buildCitationHostResolver(
  projectDomains: readonly string[] = [],
): CitationHostResolver {
  // Registrable domains owned in full (everything beneath them is ours).
  const ownedRegistrable = new Set<string>();
  // Exact hosts owned (that host + its own subdomains, nothing sideways).
  const ownedHosts = new Set<string>();
  const splitDomains = new Set<string>();

  for (const domain of projectDomains) {
    const hostname = normalizedHostname(domain);
    const registrable = registrableHost(domain);
    if (!hostname || !registrable) continue;
    if (hostname === registrable) {
      ownedRegistrable.add(registrable);
      continue;
    }
    ownedHosts.add(hostname);
    splitDomains.add(registrable);
  }

  const under = (host: string, parent: string): boolean =>
    host === parent || host.endsWith(`.${parent}`);

  return {
    splitDomains,
    hostKey(rawUrl) {
      const registrable = registrableHost(rawUrl);
      if (!registrable) return null;
      if (!splitDomains.has(registrable)) return registrable;
      return normalizedHostname(rawUrl) ?? registrable;
    },
    isOwned(hostKey) {
      if (!hostKey) return false;
      for (const domain of ownedRegistrable) {
        if (under(hostKey, domain)) return true;
      }
      for (const host of ownedHosts) {
        if (under(hostKey, host)) return true;
      }
      return false;
    },
  };
}

interface TableEntry {
  category: CitationCategory;
  subcategory: string;
}

// Maintained lookup of common KR + global hosts. Not exhaustive — unknown hosts
// fall back to the LLM and are then cached, so this only saves calls on the
// obvious recurring ones.
const DOMAIN_CATEGORY_TABLE: Record<string, TableEntry> = {
  // Auto media
  "motortrend.com": { category: "Auto media", subcategory: "Industry magazine" },
  "caranddriver.com": { category: "Auto media", subcategory: "Industry magazine" },
  "edmunds.com": { category: "Auto media", subcategory: "Buyer guide" },
  "kbb.com": { category: "Auto media", subcategory: "Buyer guide" },
  "autoblog.com": { category: "Auto media", subcategory: "Industry blog" },
  "thedrive.com": { category: "Auto media", subcategory: "Industry blog" },
  "jalopnik.com": { category: "Auto media", subcategory: "Industry blog" },
  "carbuzz.com": { category: "Auto media", subcategory: "Industry blog" },
  "motor1.com": { category: "Auto media", subcategory: "Industry blog" },
  "topgear.com": { category: "Auto media", subcategory: "Industry magazine" },
  "autocar.co.uk": { category: "Auto media", subcategory: "Industry magazine" },
  "autoview.co.kr": { category: "Auto media", subcategory: "Industry magazine" },
  "motorgraph.com": { category: "Auto media", subcategory: "Industry magazine" },
  "autodaily.co.kr": { category: "Auto media", subcategory: "Industry news" },
  "global-autonews.com": { category: "Auto media", subcategory: "Industry news" },
  // News
  "nytimes.com": { category: "News", subcategory: "Mainstream news" },
  "reuters.com": { category: "News", subcategory: "Wire service" },
  "apnews.com": { category: "News", subcategory: "Wire service" },
  "bloomberg.com": { category: "News", subcategory: "Business news" },
  "cnbc.com": { category: "News", subcategory: "Business news" },
  "bbc.com": { category: "News", subcategory: "Mainstream news" },
  "cnn.com": { category: "News", subcategory: "Mainstream news" },
  "theguardian.com": { category: "News", subcategory: "Mainstream news" },
  "forbes.com": { category: "News", subcategory: "Business news" },
  "yna.co.kr": { category: "News", subcategory: "Wire service" },
  "chosun.com": { category: "News", subcategory: "Mainstream news" },
  "joongang.co.kr": { category: "News", subcategory: "Mainstream news" },
  "donga.com": { category: "News", subcategory: "Mainstream news" },
  "hani.co.kr": { category: "News", subcategory: "Mainstream news" },
  "mk.co.kr": { category: "News", subcategory: "Business news" },
  "hankyung.com": { category: "News", subcategory: "Business news" },
  "edaily.co.kr": { category: "News", subcategory: "Business news" },
  // Social
  "youtube.com": { category: "Social", subcategory: "Video" },
  "twitter.com": { category: "Social", subcategory: "Microblog" },
  "x.com": { category: "Social", subcategory: "Microblog" },
  "instagram.com": { category: "Social", subcategory: "Photo/Video" },
  "facebook.com": { category: "Social", subcategory: "Social network" },
  "tiktok.com": { category: "Social", subcategory: "Video" },
  "threads.net": { category: "Social", subcategory: "Microblog" },
  // Community / forums
  "reddit.com": { category: "Community", subcategory: "Forum" },
  "quora.com": { category: "Community", subcategory: "Q&A" },
  "dcinside.com": { category: "Community", subcategory: "Forum" },
  "bobaedream.co.kr": { category: "Community", subcategory: "Auto forum" },
  "clien.net": { category: "Community", subcategory: "Forum" },
  "fmkorea.com": { category: "Community", subcategory: "Forum" },
  "ruliweb.com": { category: "Community", subcategory: "Forum" },
  "ppomppu.co.kr": { category: "Community", subcategory: "Forum" },
  "blog.naver.com": { category: "Community", subcategory: "Blog" },
  // Brand owned (customer + common marques)
  "hyundai.com": { category: "Brand owned", subcategory: "Manufacturer site" },
  "kia.com": { category: "Brand owned", subcategory: "Manufacturer site" },
  "genesis.com": { category: "Brand owned", subcategory: "Manufacturer site" },
  "hyundai.co.kr": { category: "Brand owned", subcategory: "Manufacturer site" },
  "kia.co.kr": { category: "Brand owned", subcategory: "Manufacturer site" },
  "toyota.com": { category: "Brand owned", subcategory: "Manufacturer site" },
  "tesla.com": { category: "Brand owned", subcategory: "Manufacturer site" },
  "bmw.com": { category: "Brand owned", subcategory: "Manufacturer site" },
  // PR
  "prnewswire.com": { category: "PR", subcategory: "Press release wire" },
  "businesswire.com": { category: "PR", subcategory: "Press release wire" },
  "newswire.co.kr": { category: "PR", subcategory: "Press release wire" },
};

// Suffix-only heuristics — government domains.
function classifyBySuffix(host: string): TableEntry | null {
  if (
    host.endsWith(".gov") ||
    host.endsWith(".go.kr") ||
    host.endsWith(".gov.uk") ||
    host.endsWith(".gov.au") ||
    host.endsWith(".go.jp")
  ) {
    return { category: "Government", subcategory: "Government" };
  }
  return null;
}

// Deterministic classification from the table / suffix rules. Null → caller
// should fall back to the LLM.
export function classifyHostFromTable(
  host: string,
): { category: CitationCategory; subcategory: string } | null {
  const direct = DOMAIN_CATEGORY_TABLE[host];
  if (direct) return direct;
  return classifyBySuffix(host);
}

const CitationDomainLlmSchema = z.object({
  category: z.string(),
  subcategory: z.string().optional().nullable(),
});

export type CitationDomainInvoker = (
  request: ClaudeRequest,
) => Promise<ClaudeResponse>;

// LLM fallback for a single unknown host. Always returns a classification —
// `Other` when the model is unsure or the call/parse fails.
export async function classifyCitationDomainWithLlm(
  host: string,
  invokeFn: CitationDomainInvoker,
): Promise<CitationDomainClassification> {
  const system = [
    "You classify a website host (registrable domain) into a fixed category for a consumer purchase-decision citation index.",
    'Return JSON only: {"category":"Auto media|News|Social|Community|Brand owned|PR|Government|Other","subcategory":"<short label>"}.',
    "Auto media = automotive magazines/blogs/buyer guides. News = general or business news outlets and wire services. Social = social networks / video / microblogs. Community = forums, Q&A, blogs, user communities. Brand owned = a manufacturer's or retailer's own site. PR = press-release wires. Government = government domains. Other = anything that does not clearly fit.",
    "subcategory is a short human label (e.g. 'Industry magazine', 'Mainstream news', 'Auto forum', 'Manufacturer site'). When unsure, use category 'Other'.",
  ].join(" ");
  const payload = {
    host,
    required_schema: {
      category:
        "Auto media|News|Social|Community|Brand owned|PR|Government|Other",
      subcategory: "short label",
    },
  };

  let res: ClaudeResponse;
  try {
    res = await invokeFn({
      task: "measurement.analysis.classify_citation_domain",
      model: "haiku",
      temperature: 0,
      maxTokens: 200,
      responseFormat: { type: "json_object" },
      reasoning: { max_tokens: 128, exclude: true },
      system,
      messages: [{ role: "user", content: JSON.stringify(payload) }],
    });
  } catch {
    return { host, category: "Other", subcategory: null, method: "default" };
  }

  try {
    const parsed = CitationDomainLlmSchema.parse(parseJsonObject(res.text));
    const categoryResult = CitationCategorySchema.safeParse(parsed.category);
    const category: CitationCategory = categoryResult.success
      ? categoryResult.data
      : "Other";
    return {
      host,
      category,
      subcategory: parsed.subcategory?.slice(0, 80) ?? null,
      method: "llm",
      modelSlug: res.modelId,
    };
  } catch {
    return {
      host,
      category: "Other",
      subcategory: null,
      method: "default",
      modelSlug: res.modelId,
    };
  }
}

// Resolve one host to a classification: table first, else LLM. Never throws.
export async function resolveCitationDomain(
  host: string,
  invokeFn: CitationDomainInvoker,
): Promise<CitationDomainClassification> {
  const tableHit = classifyHostFromTable(host);
  if (tableHit) {
    return {
      host,
      category: tableHit.category,
      subcategory: tableHit.subcategory,
      method: "table",
    };
  }
  return classifyCitationDomainWithLlm(host, invokeFn);
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("```")) {
    return parseJsonObject(
      trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim(),
    );
  }
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw error;
  }
}

export type CitationClassMap = Map<
  string,
  { category: CitationCategory; subcategory: string | null }
>;

// Enrich one raw citation object with {host, category, subcategory}, preserving
// the original provider fields. Unknown host → category "Other".
export function enrichCitation(
  citation: unknown,
  classMap: CitationClassMap,
): unknown {
  if (!citation || typeof citation !== "object") return citation;
  const url = (citation as { url?: unknown }).url;
  const host = registrableHost(typeof url === "string" ? url : null);
  const cls = host ? classMap.get(host) : undefined;
  return {
    ...(citation as Record<string, unknown>),
    host: host ?? null,
    category: cls?.category ?? "Other",
    subcategory: cls?.subcategory ?? null,
  };
}

// Enrich a raw citations array (jsonb) with classification fields.
export function enrichCitations(
  citations: unknown,
  classMap: CitationClassMap,
): unknown[] {
  if (!Array.isArray(citations)) return [];
  return citations.map((citation) => enrichCitation(citation, classMap));
}

// Extract the distinct registrable hosts from a raw citations array (jsonb).
export function hostsFromCitations(citations: unknown): string[] {
  if (!Array.isArray(citations)) return [];
  const hosts = new Set<string>();
  for (const citation of citations) {
    if (!citation || typeof citation !== "object") continue;
    const url = (citation as { url?: unknown }).url;
    const host = registrableHost(typeof url === "string" ? url : null);
    if (host) hosts.add(host);
  }
  return [...hosts];
}
