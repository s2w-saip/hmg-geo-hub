import "server-only";
import { getGa4AccessToken } from "./auth";

// Minimal Data API runReport — server-side only. Mirrors the probe.ts retry
// policy: this property (KIA-EU 469542848) intermittently 502s on heavy
// queries (cardinality + prior-year), so we back off and retry transient
// gateway errors.

export type RunReportBody = Record<string, unknown>;
export type GaRow = {
  dimensionValues?: { value: string }[];
  metricValues?: { value: string }[];
};
export type GaReport = {
  rows?: GaRow[];
  metricHeaders?: { name: string }[];
};

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runReport(
  propertyId: string,
  body: RunReportBody,
): Promise<GaReport> {
  const token = await getGa4AccessToken();
  if (!token) throw new Error("GA4: no OAuth credentials configured");
  const url = `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`;
  const maxAttempts = 4;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (res.ok) return res.json() as Promise<GaReport>;
    const detail = await res.text();
    if (RETRYABLE.has(res.status) && attempt < maxAttempts) {
      const waitMs = Math.min(8000, 1000 * 2 ** (attempt - 1));
      await sleep(waitMs);
      continue;
    }
    throw new Error(`GA4 runReport ${propertyId} failed (${res.status}): ${detail}`);
  }
}

// "AI 유입" = GA4 native "AI Assistant" default channel group
// (sessionDefaultChannelGroup). GA4 auto-classifies a session when its
// referrer matches its AI-assistant list (ChatGPT, Gemini, Perplexity,
// Copilot, Claude, …). This is the product definition agreed on
// 2026-06-12 — broader than chatgpt.com alone, and the canonical category
// GA4 will keep extending. Caveat documented in
// docs/kia-italy-ga4-claude-context.md §2: this channel started 2026-06-05
// on the Kia/IT property, so YoY/long-trend analysis is not yet possible.
//
// AI_SESSION_SOURCE (chatgpt.com) is kept exported as a back-compat anchor
// for scripts/ga4/probe.ts and its docs/data/2-extract/ga4/. Runtime KPIs use
// AI_CHANNEL_GROUP only.
export const AI_CHANNEL_GROUP = "AI Assistant";
export const AI_SESSION_SOURCE = "chatgpt.com";

export function isoToGa4(d: string): string {
  // GA4 returns dates as "YYYYMMDD"; the rest of the app uses ISO.
  return d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d;
}

export function dateNDaysAgo(days: number): { start: string; end: string } {
  // Use GA4's relative-date tokens so we don't depend on the server clock.
  return { start: `${days}daysAgo`, end: "today" };
}
