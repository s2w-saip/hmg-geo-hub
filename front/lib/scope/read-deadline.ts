import type { ScopeClient, ScopeReadOptions } from "./client";
import { assertScopeDeadline, ScopeDeadlineExceededError } from "./paging";

// Only mirror GET methods are bounded. Mutations are never raced/cancelled here.
const optionsIndex = new Map<PropertyKey, number>([
  ["listPrompts", 2],
  ["listMeasurementRuns", 2],
  ["getMeasurementRun", 2],
  ["listRunJobs", 3],
  ["getQueryRun", 1],
]);

/** A request-local view: the shared client and other callers are not modified. */
export function withScopeReadDeadline(client: ScopeClient, deadlineAt: number): ScopeClient {
  if (deadlineAt === Number.POSITIVE_INFINITY) return client;
  if (!Number.isFinite(deadlineAt)) throw new RangeError("Invalid Scope read deadline");
  return new Proxy(client, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== "function") return value;
      const index = optionsIndex.get(key);
      if (index === undefined) return value.bind(target);
      return async (...args: unknown[]) => {
        assertScopeDeadline(deadlineAt);
        const controller = new AbortController();
        const original = args[index] as ScopeReadOptions | undefined;
        original?.signal?.throwIfAborted();
        const signal = original?.signal
          ? AbortSignal.any([controller.signal, original.signal])
          : controller.signal;
        args[index] = { ...original, signal };
        const timer = setTimeout(
          () => controller.abort(new ScopeDeadlineExceededError()),
          Math.min(deadlineAt - Date.now(), 2_147_483_647),
        );
        let onAbort: () => void = () => {};
        const aborted = new Promise<never>((_, reject) => {
          onAbort = () => reject(signal.reason);
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        });
        try {
          const result = await Promise.race([value.apply(target, args), aborted]);
          assertScopeDeadline(deadlineAt);
          return result;
        } finally {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
        }
      };
    },
  });
}
