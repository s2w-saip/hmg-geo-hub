import type { Read } from "./bundle";
import { emptyAcrView, emptyCitationVm } from "./preview-models";
import type { TilesView } from "@/app/[locale]/(dash)/dashboard/_data/screen-types";
import type { HubUser } from "~/app/session";

// Presentation-only scope. This is never installed as a session or sent to a server.
export const previewViewer: HubUser = { id: "", login: "", email: null, displayName: null, role: "local_reader", scope: { all: true }, mustChangePassword: false };
export const pendingPreview: Promise<never> = new Promise(() => {});
const options = { catalogRows: [], geographyOptions: [], languageOptions: [], engineOptions: [], optionMatrix: [], selectableDates: [], collectionStartDay: null, latestAnchorDay: null };
const catalog = { rows: [], total: 0, count: 0, offset: 0, limit: 25, page: 1, pages: 0, rangeFrom: 0, rangeTo: 0, facets: { listType: [], depth1: [], depth2: [], depth3: [], depth4: [], funnel: [], lang: [], market: [], marketSort: [], presence: [], kind: [], status: [] }, columns: [], collation: "ko" };
const listing = { items: [], published: null };
export const previewTiles: TilesView = { groups: [
  { category: "content", tiles: ["visibility", "shareOfVoice", "sentiment", "position"].map(key => ({ key, unit: key === "position" ? "rank" : "percent", value: null, pending: false, delta: null, direction: "flat", tone: "flat", period: null })) },
  { category: "source", tiles: ["ownedUrlRate", "targetUrlRate", "citationShare", "citationAccuracy"].map(key => ({ key, unit: "percent", value: null, pending: false, delta: null, direction: "flat", tone: "flat", period: null })) },
  { category: "conversion", tiles: [{ key: "trafficConversion", unit: "percent", value: null, pending: false, delta: null, direction: "flat", tone: "flat", period: null }] },
] as TilesView["groups"], suppressionCaption: null };
const measurement = { item: { version: 0, brands: [], countries: [], engines: [], cadence: null, acrRepeats: null, webUnits: [], ownedUrls: [], trackedUrls: [], trackedTargets: [], origin: null, recordedAt: null }, options: { brands: [], countries: [], engines: [] }, editing: false };

/** Empty UI inputs only: no measurements, rounds, projects or accounts are invented. Unknown reads stay pending. */
export function previewRead(read: Read): unknown {
  const name = read.name;
  if (read.kind === "hub") {
    if (name === "accounts") return { items: [], roles: [] };
    if (name === "global-prompts/options") return { kinds: [], language: [], regions: [], taxonomy: [], funnel: [], brandPresence: [], listType: [], depth1: [], depth2: [], depth3: [], depth4: [] };
    if (name === "global-prompts") return { items: [], page: { total: 0, limit: 50, offset: 0 }, counts: { total: 0, hub: 0, gold: 0, archived: 0, removed: 0 } };
    if (name === "source-codes") return { categories: [], layers: [] };
    if (name === "source-overrides" || name === "source-seeds") return { ...listing, asOf: null, categories: [], limit: 100 };
    if (name === "source-socials") return { ...listing, snapshot: null };
    if (name === "interest-sources") return { ...listing, snapshot: null };
    if (["ga4-properties", "entity-roles", "interest-keywords", "source-overrides", "source-seeds"].includes(name)) return listing;
    return undefined;
  }
  if (name === "shared/service-week") return { state: "unconfigured", week: null, delay: null, checkedAt: null, recordedAt: null, notes: [] };
  if (["overview/filters", "shared/panel-options", "shared/filter-dates", "projects/filters", "website/prompts-options"].includes(name)) return options;
  if (name === "citation/filter-bar") return { options, dates: options };
  if (name.endsWith("as-of") || name.endsWith("asof")) return { asOf: null, competitorOptions: [] };
  if (name.endsWith("renewal-header")) return null;
  if (name === "overview/card-trend") return { degraded: false, cards: {} };
  if (name === "overview/brand-matrix") return { rows: [], cols: ["visibility", "shareOfVoice", "sentiment", "position", "citationShare"].map(key => ({ key, best: null, max: null, standing: null })) };
  if (name === "overview/geo") return { geo: { markets: [], pending: [], ourLabel: "HMG", countryOrder: [], countryGroups: [], domains: { visibility: null, shareOfVoice: null, sentiment: null, position: null, citationShare: null } }, degraded: false };
  if (name === "mention/rn-compare") return { covered: [] };
  if (name === "overview/cards") return { state: "empty" };
  if (name.endsWith("/summary") || name.endsWith("/summary-deferred") || /projects\/dash-summary/.test(name)) return { state: "empty" };
  if (name === "mention/rn-page") return { ownLabel: "HMG", period: null };
  if (name === "mention/rn-shell") return { measured: false, degraded: false, ownBrands: [], ownSum: [], drawer: [] };
  if (name === "citation/standard" || name === "citation/website" || name === "citation/project") return { live: null, dataDegraded: false, sectionDegraded: [], prevCategories: null, toneSummary: null, tableSource: null, periodView: null, rn: emptyCitationVm, ...(name === "citation/website" ? { own: null, reach: { status: "none" } } : {}) };
  if (name === "citation/prompts") return { tab: "owned", page: { rows: [], total: 0, win: { page: 1, pages: 0, limit: 50, offset: 0, from: 0, to: 0 } }, q: "", ownedCount: null, uncitedCount: null };
  if (name === "citation/tone-urls") return { tone: "positive", page: { rows: [], total: 0, win: { page: 1, pages: 0, limit: 50, offset: 0, from: 0, to: 0 } }, q: "", byDomain: false, counts: null };
  if (name === "acr/renewal") return { props: { ...options, stage: "acr" }, body: { measured: false, filtered: false, acrPromptCount: 0, roundBuckets: true, period: false, asOf: null, ownLabel: "HMG", totals: { prompts: 0, promptRuns: 0, iterations: 0, engines: [] }, view: emptyAcrView } };
  if (name === "catalog/prompts-page") return { ...catalog, collation: read.query?.collation ?? "ko" };
  if (name === "catalog/prompts-header") return { period: null };
  if (name === "catalog/prompts-history") return { available: false, shown: 0, groups: [] };
  if (name === "website/prompts-page") return { ...catalog, listed: 0, pageSize: 50, sort: "lastMeasuredAt", dir: "desc", roundAxis: [] };
  if (name === "website/prompts-insights") return { prompts: 0, engines: [], rounds: [], engineSets: [], brands: [], markets: [], langCount: 0, siteCount: 0 };
  if (name === "projects/list") return { items: [] };
  if (name === "projects/prompts") return { rows: [], listed: 0, fields: [], editable: false, languages: [], rounds: [] };
  if (name === "projects/settings") return { identity: { projectId: null, scopeProjectId: null, regions: null }, measured: null, fields: [], targets: 0, measurement };
  return undefined;
}

/** Browser calls made by copied UI also obey the disconnected mode. No interception of global fetch. */
export function previewEndpoint(path: string): unknown {
  if (path === "/api/hub/saved-filters") return { data: { items: [] } };
  if (path === "/api/standard/prompts/page") return previewRead({ name: "catalog/prompts-page" });
  if (path === "/api/standard/prompts/header") return previewRead({ name: "catalog/prompts-header" });
  if (path === "/api/standard/prompts/history") return previewRead({ name: "catalog/prompts-history" });
  if (path.startsWith("/api/website/prompts/")) return previewRead({ name: `website/prompts-${path.split("/").at(-1)}` });
  if (path.startsWith("/api/hub/")) {
    const value = previewRead({ name: path.slice("/api/hub/".length), kind: "hub" });
    return value === undefined ? undefined : { data: value };
  }
  return undefined;
}
