import "server-only";
import type { Ga4EventRow } from "@/lib/ga4/tracked-events-service";
import type { components } from "./api-types";
import { hghGet, hghPut } from "./client";

// GA4 conversion-event selection on the backend (BG-29 and the admin GA4 registry): the reads and
// writes of the shared events dialog action (lib/ga4/tracked-events-actions.ts).

type S = components["schemas"];
export type ApiConversionEvents = S["ConversionEventsData"];
export type ApiAdminEvents = S["EventsData"];

/** ConversionEventItem / EventItem -> Ga4EventRow. The backend order (tracked first, count desc, name) is kept. */
export function toEventRows(d: Pick<ApiConversionEvents | ApiAdminEvents, "items">): Ga4EventRow[] {
  return d.items.map((e) => ({ eventName: e.event_name, count: e.count, tracked: e.tracked }));
}

/** GET /v1/funnel/conversion/events (surface omitted: project with project_id, else website). */
export async function fetchConversionEvents(propertyId: string, projectId?: string): Promise<ApiConversionEvents> {
  const res = await hghGet("/v1/funnel/conversion/events", {
    query: { property_id: propertyId, ...(projectId ? { project_id: projectId } : {}) },
    retryOn401: true,
  });
  return res.data;
}

/** PUT /v1/funnel/conversion/events: replace the tracked set (the backend trims, dedupes, sorts). */
export async function putConversionEvents(propertyId: string, eventNames: readonly string[], projectId?: string) {
  const res = await hghPut("/v1/funnel/conversion/events", {
    query: { property_id: propertyId, ...(projectId ? { project_id: projectId } : {}) },
    body: { event_names: [...eventNames] },
    retryOn401: true,
  });
  return res.data;
}

/**
 * GET /v1/admin/ga4/properties/{id}/events: the admin GA4 registry's own read (source G7, the
 * registry screen). Admin role + admin menu group; a property outside the registry is 404.
 */
export async function fetchAdminConversionEvents(propertyId: string): Promise<ApiAdminEvents> {
  const res = await hghGet("/v1/admin/ga4/properties/{property_id}/events", {
    pathParams: { property_id: propertyId },
    retryOn401: true,
  });
  return res.data;
}

/** PUT /v1/admin/ga4/properties/{id}/events: replace the tracked set (queued: propagation pending). */
export async function putAdminConversionEvents(propertyId: string, eventNames: readonly string[]) {
  const res = await hghPut("/v1/admin/ga4/properties/{property_id}/events", {
    pathParams: { property_id: propertyId },
    body: { event_names: [...eventNames] },
    retryOn401: true,
  });
  return res.data;
}
