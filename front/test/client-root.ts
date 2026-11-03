import * as React from "react";
import { createRoot } from "react-dom/client";
import { vi } from "vitest";

// React DOM's client in a test without a DOM (the front has no DOM library for its tests): a root over a container it
// never draws in, for components that draw nothing — a stub of a page body that keeps its answer in state as the body
// does, a probe of a hook. What it shows is React's reconciliation as router.refresh() meets it: a new server tree
// rendered into the same root keeps the state of a client component of the same type and key, and mounts one of
// another key afresh (review r2-7, 2026-11-03). Globals are stubbed here: unstub them after each test
// (vi.unstubAllGlobals()). The document keeps its listeners, so a test can turn the tab's visibility (`turn`) as the
// shells' service week provider reads it (review r3-5); the provider's own test (components/service-week/
// provider.test.tsx) keeps its own document.

export interface ClientRoot {
  /** renders `node` into the root, as a server render's payload reaches the client */
  render(node: React.ReactNode): Promise<void>;
  /** runs a state change (a client read landing) */
  act(fn: () => void): Promise<void>;
  /** the tab turns hidden or visible: document.visibilityState and a visibilitychange event */
  turn(state: "visible" | "hidden"): Promise<void>;
  unmount(): Promise<void>;
}

export function clientRoot(): ClientRoot {
  const listeners = new Map<string, Set<() => void>>();
  const doc = {
    activeElement: null,
    body: null,
    defaultView: null as unknown,
    visibilityState: "visible" as "visible" | "hidden",
    addEventListener(type: string, fn: () => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: () => void) {
      listeners.get(type)?.delete(fn);
    },
  };
  doc.defaultView = { document: doc, event: undefined, HTMLIFrameElement: class {} };
  vi.stubGlobal("window", doc.defaultView);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = { nodeType: 1, nodeName: "DIV", tagName: "DIV", textContent: "", ownerDocument: doc, addEventListener() {}, removeEventListener() {} };
  const root = createRoot(container as unknown as Element);
  return {
    render: async (node) => {
      await React.act(async () => root.render(node));
    },
    act: async (fn) => {
      await React.act(async () => fn());
    },
    turn: async (state) => {
      doc.visibilityState = state;
      await React.act(async () => {
        for (const fn of [...(listeners.get("visibilitychange") ?? [])]) fn();
      });
    },
    unmount: async () => {
      await React.act(async () => root.unmount());
    },
  };
}
