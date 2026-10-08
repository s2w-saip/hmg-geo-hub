import type { QaSectionFlags, QaSectionKey } from "./types";

const HEARTBEAT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;

export type ReviewState = {
  flags: QaSectionFlags;
  lock: "acquiring" | "held" | "blocked" | "lost" | "error";
  lockHolder: string | null;
  saving: boolean;
  savedAt: string | null;
  error: "lock" | "save" | null;
};

export function initialReviewState(flags: QaSectionFlags): ReviewState {
  return { flags: { ...flags }, lock: "acquiring", lockHolder: null, saving: false, savedAt: null, error: null };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

class ResponseError extends Error {
  constructor(readonly status: number, readonly body: Record<string, unknown>) {
    super(`QA request failed (${status})`);
  }
}

/** Client request/state coordination only; existing endpoints, payloads and verdict rules are unchanged. */
export function createReviewSession(
  jobId: string,
  flags: QaSectionFlags,
  onChange: (state: ReviewState) => void,
  onSaved: () => void,
  fetcher: typeof fetch = fetch,
) {
  let state = initialReviewState(flags);
  let active = true;
  let started = false;
  let revision = 0;
  let heartbeatBusy = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const requests = new Set<AbortController>();

  function update(patch: Partial<ReviewState>) {
    if (!active) return;
    state = { ...state, ...patch };
    onChange(state);
  }

  function stopHeartbeat() {
    clearInterval(heartbeat);
    heartbeat = undefined;
  }

  function loseLock(lock: "lost" | "error") {
    stopHeartbeat();
    update({ lock, lockHolder: null, savedAt: null, error: lock === "error" ? "lock" : null });
  }

  async function request(path: string, method: string, body: object) {
    const controller = new AbortController();
    requests.add(controller);
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetcher(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      // Preserve HTTP failure even when a gateway returns HTML instead of JSON.
      const data = record(await response.json().catch(() => null));
      if (!response.ok) throw new ResponseError(response.status, data);
      return data;
    } finally {
      clearTimeout(timeout);
      requests.delete(controller);
    }
  }

  async function renewLock() {
    if (!active || state.lock !== "held" || heartbeatBusy) return;
    heartbeatBusy = true;
    try {
      const data = await request("/api/qa/lock", "PATCH", { jobId });
      if (!active || state.lock !== "held") return;
      if (data.held === false) loseLock("lost");
      else if (data.held !== true) loseLock("error");
    } catch {
      if (active && state.lock === "held") loseLock("error");
    } finally {
      heartbeatBusy = false;
    }
  }

  return {
    getState: () => state,

    async start() {
      if (!active || started) return;
      started = true;
      try {
        const data = await request("/api/qa/lock", "POST", { jobId });
        if (!active) return;
        if (data.ok !== true) throw new Error("Invalid lock acknowledgement");
        update({ lock: "held" });
        heartbeat = setInterval(() => { void renewLock(); }, HEARTBEAT_MS);
      } catch (error) {
        if (!active) return;
        const holder = error instanceof ResponseError && error.status === 409
          ? record(error.body.heldBy).reviewerName
          : null;
        if (typeof holder === "string" && holder.length > 0) {
          update({ lock: "blocked", lockHolder: holder });
        } else {
          loseLock("error");
        }
      }
    },

    setFlag(key: QaSectionKey, value: "ok" | "issue") {
      if (!active || state.lock !== "held") return;
      revision += 1;
      update({
        flags: { ...state.flags, [key]: state.flags[key] === value ? undefined : value },
        savedAt: null,
      });
    },

    async save() {
      // Gate synchronously: clicks/shortcuts before React's next render cannot submit twice.
      if (!active || state.lock !== "held" || state.saving) return;
      const submittedRevision = revision;
      const submittedFlags = { ...state.flags };
      update({ saving: true, savedAt: null, error: null });
      try {
        const data = await request("/api/qa/review", "PUT", { jobId, sectionFlags: submittedFlags });
        if (!active) return;
        const expectedStatus = Object.values(submittedFlags).includes("issue") ? "issue" : "ok";
        if (data.status !== expectedStatus || typeof data.reviewerName !== "string") {
          throw new Error("Invalid review acknowledgement");
        }
        if (state.lock === "held" && revision === submittedRevision) {
          update({ savedAt: new Date().toISOString() });
        }
        // Refresh server data without replacing edits made while the request was in flight.
        onSaved();
      } catch (error) {
        if (!active) return;
        if (error instanceof ResponseError && error.status === 409) {
          loseLock("lost");
        } else if (error instanceof ResponseError && [401, 403].includes(error.status)) {
          loseLock("error");
        } else if (state.lock === "held") {
          update({ error: "save" });
        }
      } finally {
        update({ saving: false });
      }
    },

    dispose() {
      active = false;
      stopHeartbeat();
      for (const controller of requests) controller.abort();
      requests.clear();
    },
  };
}
