import { CONNECTED } from "./client";
import { previewEndpoint } from "./preview";

/** Preserve the copied fetch contracts while preventing every backend read/write in UI preview. */
export const browserFetch: typeof fetch = async (input, init) => {
  if (CONNECTED) return globalThis.fetch(input, init);
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin);
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  const body = method.toUpperCase() === "GET" ? previewEndpoint(url.pathname) : undefined;
  return new Response(JSON.stringify(body ?? { error: { code: "hub_not_connected" } }), { status: body === undefined ? 503 : 200, headers: { "Content-Type": "application/json" } });
};
