import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReviewSession } from "./review-session";

const jobId = "11111111-1111-4111-8111-111111111111";
const json = (body: unknown, status = 200) => Response.json(body, { status });
const saved = () => json({ status: "ok", reviewerName: "Reviewer" });
const sessions: ReturnType<typeof createReviewSession>[] = [];

function fixture() {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ ok: true }));
  const changed = vi.fn();
  const refresh = vi.fn();
  const session = createReviewSession(jobId, { answer: "ok" }, changed, refresh, fetcher);
  sessions.push(session);
  return { session, fetcher, changed, refresh };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  sessions.splice(0).forEach((session) => session.dispose());
  vi.useRealTimers();
});

describe("QA lock lifecycle", () => {
  it("requires an acknowledged lock before editing/saving or sending heartbeat", async () => {
    const { session, fetcher } = fixture();
    const acquisition = deferred<Response>();
    fetcher.mockReturnValueOnce(acquisition.promise);
    const start = session.start();
    session.setFlag("answer", "issue");
    await session.save();
    expect(session.getState()).toMatchObject({ lock: "acquiring", flags: { answer: "ok" } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    acquisition.resolve(json({ ok: true }));
    await start;
    expect(session.getState().lock).toBe("held");
    expect(fetcher.mock.calls[0]).toEqual(["/api/qa/lock", expect.objectContaining({
      method: "POST", body: JSON.stringify({ jobId }),
    })]);
  });

  it.each([401, 403, 422, 500])("fails closed on acquisition HTTP %i", async (status) => {
    const { session, fetcher } = fixture();
    fetcher.mockResolvedValueOnce(json({ error: "unavailable" }, status));
    await session.start();
    expect(session.getState()).toMatchObject({ lock: "error", error: "lock" });
    await session.save();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("preserves the existing other-reviewer read-only state on 409", async () => {
    const { session, fetcher } = fixture();
    fetcher.mockResolvedValueOnce(json({ ok: false, heldBy: { reviewerName: "Other reviewer" } }, 409));
    await session.start();
    expect(session.getState()).toMatchObject({ lock: "blocked", lockHolder: "Other reviewer", error: null });
  });

  it.each([{}, { ok: false }, { ok: "true" }, null])("rejects malformed successful lock bodies: %j", async (body) => {
    const { session, fetcher } = fixture();
    fetcher.mockResolvedValueOnce(json(body));
    await session.start();
    expect(session.getState().lock).toBe("error");
  });

  it("handles acquisition network failure without an unhandled rejection", async () => {
    const { session, fetcher } = fixture();
    fetcher.mockRejectedValueOnce(new TypeError("offline"));
    await expect(session.start()).resolves.toBeUndefined();
    expect(session.getState().error).toBe("lock");
  });

  it.each([
    [200, { held: false }, "lost"],
    [200, {}, "error"],
    [500, { held: true }, "error"],
    [401, { error: "unauthorized" }, "error"],
  ])("blocks editing after heartbeat %i %j", async (status, body, expected) => {
    const { session, fetcher } = fixture();
    await session.start();
    fetcher.mockResolvedValueOnce(json(body, status));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(session.getState().lock).toBe(expected);
    session.setFlag("answer", "issue");
    await session.save();
    expect(session.getState().flags).toEqual({ answer: "ok" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("handles heartbeat network failure and preserves input", async () => {
    const { session, fetcher } = fixture();
    await session.start();
    session.setFlag("citations", "issue");
    fetcher.mockRejectedValueOnce(new TypeError("offline"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(session.getState()).toMatchObject({ lock: "error", flags: { citations: "issue" } });
  });

  it("does not let a delayed healthy heartbeat reopen a lock lost while saving", async () => {
    const { session, fetcher } = fixture();
    await session.start();
    const beat = deferred<Response>();
    fetcher.mockReturnValueOnce(beat.promise);
    await vi.advanceTimersByTimeAsync(30_000);
    fetcher.mockResolvedValueOnce(json({ error: "lock-lost" }, 409));
    await session.save();
    beat.resolve(json({ held: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(session.getState().lock).toBe("lost");
  });
});

describe("QA verdict save", () => {
  it("preserves the verdict payload and refreshes only on acknowledged success", async () => {
    const { session, fetcher, refresh } = fixture();
    await session.start();
    session.setFlag("citations", "issue");
    fetcher.mockResolvedValueOnce(json({ status: "issue", reviewerName: "Reviewer" }));
    await session.save();
    expect(fetcher.mock.calls[1]).toEqual(["/api/qa/review", expect.objectContaining({
      method: "PUT", body: JSON.stringify({ jobId, sectionFlags: { answer: "ok", citations: "issue" } }),
    })]);
    expect(session.getState().savedAt).not.toBeNull();
    expect(refresh).toHaveBeenCalledTimes(1);
    session.setFlag("citations", "issue");
    expect(session.getState().flags.citations).toBeUndefined();
    expect(session.getState().savedAt).toBeNull();
  });

  it.each([401, 403, 409, 422, 500])("clears old success, retains flags and handles save HTTP %i", async (status) => {
    const { session, fetcher, refresh } = fixture();
    await session.start();
    fetcher.mockResolvedValueOnce(saved());
    await session.save();
    expect(session.getState().savedAt).not.toBeNull();
    fetcher.mockResolvedValueOnce(json({ error: "failure" }, status));
    await session.save();
    const state = session.getState();
    expect(state).toMatchObject({ savedAt: null, saving: false, flags: { answer: "ok" } });
    expect(refresh).toHaveBeenCalledTimes(1);
    if (status === 409) expect(state.lock).toBe("lost");
    else if ([401, 403].includes(status)) expect(state).toMatchObject({ lock: "error", error: "lock" });
    else expect(state).toMatchObject({ lock: "held", error: "save" });
  });

  it("retains input on network error and allows an explicit retry without automatically writing again", async () => {
    const { session, fetcher, refresh } = fixture();
    await session.start();
    fetcher.mockRejectedValueOnce(new TypeError("offline"));
    await expect(session.save()).resolves.toBeUndefined();
    expect(session.getState()).toMatchObject({ error: "save", saving: false, flags: { answer: "ok" } });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(refresh).not.toHaveBeenCalled();
    fetcher.mockResolvedValueOnce(saved());
    await session.save();
    expect(session.getState()).toMatchObject({ error: null, saving: false });
    expect(session.getState().savedAt).not.toBeNull();
  });

  it.each([{}, { status: "issue", reviewerName: "Reviewer" }, { status: "ok" }])("rejects an invalid success acknowledgement: %j", async (body) => {
    const { session, fetcher, refresh } = fixture();
    await session.start();
    fetcher.mockResolvedValueOnce(json(body));
    await session.save();
    expect(session.getState()).toMatchObject({ error: "save", savedAt: null });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("handles non-JSON failure responses", async () => {
    const { session, fetcher } = fixture();
    await session.start();
    fetcher.mockResolvedValueOnce(new Response("<html>gateway failure</html>", { status: 502 }));
    await session.save();
    expect(session.getState()).toMatchObject({ error: "save", saving: false });
  });

  it("coalesces repeated save events and never marks newer edits as saved", async () => {
    const { session, fetcher, refresh } = fixture();
    await session.start();
    const pending = deferred<Response>();
    fetcher.mockReturnValueOnce(pending.promise);
    const first = session.save();
    await session.save();
    expect(fetcher).toHaveBeenCalledTimes(2);
    session.setFlag("answer", "issue");
    pending.resolve(saved());
    await first;
    expect(session.getState()).toMatchObject({ savedAt: null, saving: false, flags: { answer: "issue" } });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("unblocks the button on a timed-out request without an automatic retry", async () => {
    const { session, fetcher, refresh } = fixture();
    await session.start();
    fetcher.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Timeout", "AbortError")));
    }));
    const saving = session.save();
    await vi.advanceTimersByTimeAsync(15_000);
    await saving;
    expect(session.getState()).toMatchObject({ error: "save", saving: false, savedAt: null });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("ignores delayed completion after leaving a detail page", async () => {
    const { session, fetcher, changed, refresh } = fixture();
    await session.start();
    const pending = deferred<Response>();
    fetcher.mockReturnValueOnce(pending.promise);
    const saving = session.save();
    session.dispose();
    changed.mockClear();
    pending.resolve(saved());
    await saving;
    expect(changed).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(fetcher.mock.calls[1][1]?.signal?.aborted).toBe(true);
  });
});
