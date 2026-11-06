// Admin › GA4 연동 (2026-10-29): the shapes the BFF answers (back/bff/hub_stores/ga4_registry.py) and the browser's
// calls through /api/hub/ga4-properties (app/api/hub/ga4-properties/[[...rest]]/route.ts).

export const GA4_BRANDS = ["Hyundai", "Kia", "Genesis"] as const;
export const GA4_BASES = ["key_events", "events"] as const;
export type Ga4Basis = (typeof GA4_BASES)[number];

/** The collector's last result for the property (analytics.ga4_collect_status), as it left it. */
export type Ga4CollectStatus = "collected" | "pending_grant" | "failed" | "stopped";

export interface Ga4Property {
  propertyId: string;
  brand: string;
  /** ISO 3166-1 alpha-2 */
  country: string;
  basis: Ga4Basis;
  /** the GA4 events counted as conversions; only with the `events` basis */
  events: string[];
  /** collected (false: stopped on this screen) */
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  /** the property as this answer saw it; an edit sends it back (expectedVersion) */
  version: string;
  collection: {
    /** null: the collector has not run for it yet */
    status: Ga4CollectStatus | null;
    checkedAt: string | null;
    error: string | null;
    /** the last successful collection and its last day */
    collectedAt: string | null;
    collectedTo: string | null;
    /** the registry changed after that run (or it never ran), so the change is not on the AI Conversion screen yet */
    pending: boolean;
  };
}

export interface Ga4PropertyEvent {
  id: number;
  action: "create" | "update" | "stop" | "resume";
  at: string;
  actor: { login: string; displayName: string | null } | null;
  /** field -> [before, after] */
  changes: Record<string, [unknown, unknown]>;
}

export interface Ga4PropertyDetail {
  item: Ga4Property;
  history: Ga4PropertyEvent[];
}

/** The events the collector stored for the property: its last `days` collected days up to `to` (none before its first collection). */
export interface Ga4StoredEvents {
  days: number;
  to: string | null;
  events: { name: string; count: number; keyEvent: boolean }[];
}

export interface Ga4Draft {
  propertyId: string;
  brand: string;
  country: string;
  basis: Ga4Basis;
  events: string[];
}

export function draftOf(item: Ga4Property | null): Ga4Draft {
  return {
    propertyId: item?.propertyId ?? "",
    brand: item?.brand ?? "",
    country: item?.country ?? "",
    basis: item?.basis ?? "key_events",
    events: item?.events ?? [],
  };
}

export function toBody(d: Ga4Draft) {
  return { brand: d.brand, country: d.country, basis: d.basis, events: d.basis === "events" ? d.events : [] };
}

export const PROPERTY_PATTERN = /^[0-9]{1,20}$/;
/** GA4's event name rule: a letter, then letters, digits and _ (at most 40). */
export const EVENT_PATTERN = /^\p{L}[\p{L}\p{N}_]{0,39}$/u;

/** The fields the BFF would refuse, checked before sending (the BFF checks again). */
export function missingFields(d: Ga4Draft, creating: boolean): string[] {
  const out: string[] = [];
  if (creating && !PROPERTY_PATTERN.test(d.propertyId.trim())) out.push("propertyId");
  if (!d.brand) out.push("brand");
  if (!/^[A-Z]{2}$/.test(d.country)) out.push("country");
  if (d.basis === "events" && (!d.events.length || d.events.some((e) => !EVENT_PATTERN.test(e)))) out.push("events");
  return out;
}

export class Ga4RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details?: { fields?: string[]; propertyId?: string },
  ) {
    super(code);
  }
}

async function call<T>(path: string, method: "GET" | "POST" | "PUT" = "GET", body?: unknown): Promise<T> {
  const res = await fetch(`/api/hub/ga4-properties${path}`, {
    method,
    cache: "no-store",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as { data?: T; error?: { code?: string; details?: Ga4RequestError["details"] } } | null;
  if (!res.ok || !json?.data) throw new Ga4RequestError(res.status, json?.error?.code ?? "failed", json?.error?.details);
  return json.data;
}

export type Ga4Action = "stop" | "resume";

export const ga4Api = {
  list: () => call<{ items: Ga4Property[] }>(""),
  detail: (id: string) => call<Ga4PropertyDetail>(`/${id}`),
  events: (id: string) => call<Ga4StoredEvents>(`/${id}/events`),
  create: (d: Ga4Draft) => call<{ item: Ga4Property }>("", "POST", { propertyId: d.propertyId.trim(), ...toBody(d) }),
  update: (item: Ga4Property, d: Ga4Draft) => call<{ item: Ga4Property }>(`/${item.propertyId}`, "PUT", { ...toBody(d), expectedVersion: item.version }),
  act: (id: string, action: Ga4Action) => call<{ item: Ga4Property }>(`/${id}/${action}`, "POST"),
};
