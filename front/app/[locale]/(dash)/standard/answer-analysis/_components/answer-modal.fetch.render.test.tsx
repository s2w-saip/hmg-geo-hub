import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 답변 모달의 원문 지연 로딩(/api/scope/answer) → 본문 상태(BodyState) 렌더 계약 (백로그 B001).
//
// 고정하는 것: 라우트 응답 상태별로 모달이 그리는 기존 상태 넷 중 하나.
//   200 본문              → ready(MarkdownAnswer)
//   200 {available:false} → '원문 없음'(Unavailable, noAnswer) — 미수집·mock
//   403·404 {available:false} → '원문 없음' — 존재 은폐(게이트·스코프 밖·없음) 설계 그대로
//   401·5xx {error}        → 오류 상태(loadError). 종전에는 r.ok 를 보지 않아 5xx {error:{code}} 가
//                            available 없음 = '원문 미수집'으로 위장됐다. 현행(legacy) 라우트는 throw →
//                            비 JSON 500 → r.json() 실패 → 같은 오류 상태였다(아래 비 JSON 사례).
//
// 이 저장소에는 DOM 렌더러가 없다(jsdom·testing library 없음). citations-view.hooks.test.tsx 와 같은
// 최소 훅 런타임(상태 갱신 = 마이크로태스크 재렌더, deps 가 바뀐 effect 만 재실행)으로 AnswerModal 을
// 그대로 돌리고, 돌려준 요소 트리에서 본문 상태를 읽는다. 하위 컴포넌트(Dialog·MarkdownAnswer 등)는
// 호출하지 않는다 — 요소의 type·props 로 판정한다. 문구 키는 next-intl 대신 키 그대로 돌려준다.

type Deps = readonly unknown[] | undefined;
type Slot = { v?: unknown; deps?: Deps; cleanup?: (() => void) | void };

const rt = vi.hoisted(() => {
  let slots: Slot[] = [];
  let idx = 0;
  let pending: { i: number; fn: () => (() => void) | void; deps: Deps }[] = [];
  let renderFn: (() => void) | null = null;
  let scheduled = false;
  const changed = (a: Deps, b: Deps) => !a || !b || a.length !== b.length || a.some((x, k) => !Object.is(x, b[k]));
  const schedule = () => {
    if (scheduled || !renderFn) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      renderFn?.();
    });
  };
  function useState<T>(init: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void] {
    const i = idx++;
    if (!slots[i]) slots[i] = { v: typeof init === "function" ? (init as () => T)() : init };
    const s = slots[i];
    const set = (next: T | ((prev: T) => T)) => {
      const v = typeof next === "function" ? (next as (prev: T) => T)(s.v as T) : next;
      if (Object.is(v, s.v)) return;
      s.v = v;
      schedule();
    };
    return [s.v as T, set];
  }
  function useEffect(fn: () => (() => void) | void, deps?: Deps) {
    const i = idx++;
    const prev = slots[i];
    if (!prev || changed(deps, prev.deps)) pending.push({ i, fn, deps });
  }
  function memoSlot<T>(fn: () => T, deps: Deps): T {
    const i = idx++;
    const prev = slots[i];
    if (!prev || changed(deps, prev.deps)) slots[i] = { v: fn(), deps };
    return slots[i].v as T;
  }
  function callbackSlot<T>(fn: T, deps: Deps): T {
    return memoSlot(() => fn, deps);
  }
  function useRef<T>(init: T): { current: T } {
    const i = idx++;
    if (!slots[i]) slots[i] = { v: { current: init } };
    return slots[i].v as { current: T };
  }
  function mount<P, R>(hook: (p: P) => R, props: NoInfer<P>) {
    slots = [];
    scheduled = false;
    const result = { current: undefined as R };
    renderFn = () => {
      idx = 0;
      pending = [];
      result.current = hook(props);
      const effects = pending;
      for (const e of effects) slots[e.i]?.cleanup?.();
      for (const e of effects) slots[e.i] = { deps: e.deps, cleanup: e.fn() };
    };
    renderFn();
    return { result };
  }
  return { useState, useEffect, useMemo: memoSlot, useCallback: callbackSlot, useRef, mount };
});

const nav = vi.hoisted(() => ({ pathname: "/ko/standard/answer-analysis/mention", search: "engine=chatgpt" }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: rt.useState,
    useEffect: rt.useEffect,
    useMemo: rt.useMemo,
    useCallback: rt.useCallback,
    useRef: rt.useRef,
  };
});
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ replace: () => {}, push: () => {} }),
}));

const { AnswerModal } = await import("./answer-modal");
const { MarkdownAnswer } = await import("./markdown-answer");

const JOB = "3f2b8c1e-0000-4000-8000-00000000abcd";
const PROJECT = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const ANSWER = {
  jobId: JOB,
  provider: "ChatGPT",
  region: "US",
  mentionCount: 2,
  position: 1,
  highlights: { brand: ["Hyundai"], model: ["Ioniq 5"] },
  measuredAt: "2026-09-14T03:00:00.000Z",
  runs: 1,
};
const PROPS = { brand: "Hyundai", promptText: "best EV", answers: [ANSWER], open: true, onOpenChange: () => {} };

let calls: string[] = [];
let reply: () => Promise<Response>;
const json = (status: number, body: unknown) => () =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

beforeEach(() => {
  calls = [];
  nav.pathname = "/ko/standard/answer-analysis/mention";
  vi.stubGlobal("fetch", (url: string) => {
    calls.push(url);
    return reply();
  });
});
afterEach(() => vi.unstubAllGlobals());

const flush = async () => {
  for (let k = 0; k < 20; k++) await new Promise((r) => setTimeout(r, 0));
};

type El = { type: unknown; props: Record<string, unknown> };
const isEl = (n: unknown): n is El => typeof n === "object" && n !== null && "props" in n && "type" in n;
function nodes(n: unknown, out: unknown[] = []): unknown[] {
  if (n == null || typeof n === "boolean") return out;
  if (Array.isArray(n)) {
    for (const c of n) nodes(c, out);
    return out;
  }
  out.push(n);
  if (isEl(n)) nodes(n.props.children, out);
  return out;
}

/** The body state the modal drew (the four existing states). */
function drawn(tree: unknown): "ready" | "unavailable" | "error" | "loading" | null {
  const all = nodes(tree);
  if (all.some((n) => isEl(n) && n.type === MarkdownAnswer)) return "ready";
  if (all.includes("loadError")) return "error";
  if (all.includes("loading")) return "loading";
  if (all.some((n) => isEl(n) && n.props.label === "noAnswer")) return "unavailable";
  return null;
}

async function open(): Promise<{ state: ReturnType<typeof drawn>; tree: unknown }> {
  const h = rt.mount((p: typeof PROPS) => AnswerModal(p), PROPS);
  expect(drawn(h.result.current)).toBe("loading");
  await flush();
  return { state: drawn(h.result.current), tree: h.result.current };
}

describe("AnswerModal: route status -> body state (B001)", () => {
  it("200 body -> ready (MarkdownAnswer with the answer text)", async () => {
    reply = json(200, { available: true, answerText: "Hyundai Ioniq 5 leads.", citations: [], brandMentions: [], modelMentions: [] });
    const { state, tree } = await open();
    expect(state).toBe("ready");
    const md = nodes(tree).find((n) => isEl(n) && n.type === MarkdownAnswer) as El;
    expect(md.props.text).toBe("Hyundai Ioniq 5 leads.");
  });

  it("200 {available:false} (not collected / mock) -> '원문 없음'", async () => {
    reply = json(200, { available: false });
    expect((await open()).state).toBe("unavailable");
  });

  it.each([403, 404])("%i {available:false} (existence hidden) -> '원문 없음' as before", async (status) => {
    reply = json(status, { available: false });
    expect((await open()).state).toBe("unavailable");
  });

  it.each([500, 502, 503, 504])("%i {error:{code}} -> the error state, not '원문 미수집'", async (status) => {
    reply = json(status, { error: { code: status === 504 ? "timeout" : "upstream" } });
    expect((await open()).state).toBe("error");
  });

  it("401 {error:'unauthorized'} -> the error state", async () => {
    reply = json(401, { error: "unauthorized" });
    expect((await open()).state).toBe("error");
  });

  it("legacy route failure (thrown -> non-JSON 500) and a network failure -> the same error state", async () => {
    reply = () => Promise.resolve(new Response("<!doctype html><title>500</title>", { status: 500, headers: { "content-type": "text/html" } }));
    expect((await open()).state).toBe("error");
    reply = () => Promise.reject(new TypeError("Failed to fetch"));
    expect((await open()).state).toBe("error");
  });

  it("request: the screen's URL filters + jobId; a project screen adds its projectId, website adds surface=website", async () => {
    reply = json(200, { available: false });
    await open();
    nav.pathname = `/ko/projects/${PROJECT}/analysis/mention`;
    await open();
    nav.pathname = "/ko/website/answer-analysis/citation";
    await open();
    const qs = calls.map((u) => new URLSearchParams(u.slice(u.indexOf("?") + 1)));
    expect(calls.every((u) => u.startsWith("/api/scope/answer?"))).toBe(true);
    expect(qs.map((q) => [q.get("jobId"), q.get("engine"), q.get("projectId"), q.get("surface")])).toEqual([
      [JOB, "chatgpt", null, null],
      [JOB, "chatgpt", PROJECT, null],
      [JOB, "chatgpt", null, "website"],
    ]);
  });
});

describe("AnswerModal: precomputed values reach the renderers", () => {
  const TERMS = [{ term: "ioniq 5", kind: "model" as const }, { term: "hyundai", kind: "brand" as const }];
  const BODY = {
    available: true,
    answerText: "Hyundai Ioniq 5 leads.",
    citations: [],
    sources: [{ url: "https://kia.com/x", host: "kia.com" }],
    brandMentions: [{ name: "Hyundai", count: 2, tracked: true }, { name: "Toyota", count: 1, tracked: false }],
    ownBrandMentions: [{ name: "Hyundai", count: 2, tracked: true }],
    competitorBrandMentions: [{ name: "Toyota", count: 1, tracked: false }],
    modelMentions: [{ name: "Ioniq 5", count: 1, brand: "Hyundai", label: "Hyundai Ioniq 5" }],
    sentiment: { spans: [{ start: 0, end: 7, sentiment: "positive", evidence: [], text: "Hyundai" }], skipped: 0 },
  };

  async function drawnWith(answer: typeof ANSWER & { highlightTerms?: typeof TERMS }) {
    reply = json(200, BODY);
    const h = rt.mount((p: typeof PROPS) => AnswerModal(p), { ...PROPS, answers: [answer] });
    await flush();
    return nodes(h.result.current);
  }

  it("the answer's highlightTerms and the spans (with their sentence) go to MarkdownAnswer", async () => {
    const md = (await drawnWith({ ...ANSWER, highlightTerms: TERMS })).find((n) => isEl(n) && n.type === MarkdownAnswer) as El;
    expect(md.props.highlightTerms).toEqual(TERMS);
    expect(md.props.sentimentSpans).toEqual(BODY.sentiment.spans);
    const plain = (await drawnWith(ANSWER)).find((n) => isEl(n) && n.type === MarkdownAnswer) as El;
    expect(plain.props.highlightTerms).toBeUndefined(); // MarkdownAnswer then reads brandTerms / modelTerms
    expect(plain.props.brandTerms).toEqual(["Hyundai"]);
  });

  it("the route's sources / own-competitor split / model labels reach the blocks", async () => {
    const els = (await drawnWith(ANSWER)).filter(isEl);
    const cites = els.find((n) => typeof n.type === "function" && n.type.name === "AnswerCitations") as El;
    expect(cites.props.sources).toEqual(BODY.sources);
    const stats = els.find((n) => typeof n.type === "function" && n.type.name === "MentionStats") as El;
    expect([stats.props.ownBrandMentions, stats.props.competitorBrandMentions, stats.props.modelMentions]).toEqual([
      BODY.ownBrandMentions,
      BODY.competitorBrandMentions,
      BODY.modelMentions,
    ]);
  });
});
