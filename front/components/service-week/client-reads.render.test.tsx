import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { ServiceWeekView } from "@/lib/service-week";
import { clientRoot, type ClientRoot } from "@/test/client-root";

// Review r3-4 (2026-11-03): what the browser reads on top of a page's answer, as the shell's re-read meets it. Once the
// week moved the shell reads the page again (sync.ts: router.refresh): the same URL, a new answer, the client state
// kept — and reads kept by the URL (a 분포 sheet, a picked brand's compare) went on showing the week before under a
// chip naming the next one. They are kept by the page's read (provider.tsx useServiceWeekRead), which only the page's
// new render moves: the chip's view moving first reads nothing again. The citation table and a row's detail are
// citations-view.hooks.test.tsx's. Run in React DOM's client with the shell's provider; the probes draw nothing.

const nav = vi.hoisted(() => ({ path: "/ko/renewal/website/answer-analysis/mention", search: "geography=US", refresh: (() => {}) as () => void }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.path,
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ refresh: () => nav.refresh(), replace: () => {}, push: () => {}, prefetch: () => {} }),
}));

const React = await import("react");
const { RnServiceWeekProvider, useServiceWeekReadState } = await import("./provider");
const { useAcrSheet } = await import("@/app/[locale]/(renewal)/renewal/standard/ai-funnel/acr/_components/acr-detail");
const { usePicked } = await import("@/app/[locale]/(renewal)/renewal/website/answer-analysis/mention/_components/site-compare");
const { useShownCompare } = await import("@/app/[locale]/(dash)/standard/answer-analysis/_components/mentions-view");

type Week = "W1" | "W2";
const VIEWS: Record<Week, ServiceWeekView> = {
  W1: { state: "ok", week: { start: "2026-10-05", end: "2026-10-11", month: 10, nth: 2 }, delay: null, checkedAt: null, recordedAt: null, notes: [] },
  W2: { state: "ok", week: { start: "2026-10-12", end: "2026-10-18", month: 10, nth: 3 }, delay: null, checkedAt: null, recordedAt: null, notes: [] },
};
/** the week Gold's reads answer now (the BFF's), and the reads the probes made */
let gold: Week = "W1";
let reads: string[] = [];
/** a compare read answers once this settles (held open: what shows while the pick is read again) */
let gate: Promise<void> = Promise.resolve();
const hold = () => {
  let open!: () => void;
  gate = new Promise<void>((r) => (open = r));
  return () => root.act(() => open());
};
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const parts = (brand: string, week: Week) => ({
  comparison: { own: { brand: "HMG", share: 50 }, target: { brand, share: week === "W1" ? 11.1 : 22.2 }, peers: [], mode: "manual", options: [], ownBrands: [] },
  typeShare: null,
});

const probe = vi.hoisted(() => ({ value: undefined as unknown }));
let root: ClientRoot;

/** the shell over `body`, the layout's read `week` (a new promise = the layout rendered anew: the page read again) */
const shell = (week: Promise<ServiceWeekView | null>, body: ReactNode) => <RnServiceWeekProvider week={week}>{body}</RnServiceWeekProvider>;

async function settle() {
  for (let i = 0; i < 6; i += 1) await React.act(async () => void (await new Promise((r) => setTimeout(r, 0))));
}

/** the cron moved the week and the tab came back: the shell shows the next week and asks for the page again */
async function moveWeek() {
  gold = "W2";
  await root.turn("hidden");
  await root.turn("visible");
  await settle();
}

beforeEach(() => {
  gold = "W1";
  reads = [];
  gate = Promise.resolve();
  probe.value = undefined;
  nav.refresh = vi.fn();
  root = clientRoot();
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.startsWith("/api/service-week")) return json(VIEWS[gold]);
    const week = gold;
    reads.push(`${week} ${url.split("?")[0]}`);
    if (url.startsWith("/api/standard/acr/sheet")) return json({ sheet: { key: new URLSearchParams(url.split("?")[1]).get("sheet"), rows: [], label: `${week}-sheet` } });
    if (url.startsWith("/api/scope/mention-compare")) {
      await gate;
      return json(parts(new URLSearchParams(url.split("?")[1]).get("target") ?? "", week));
    }
    return new Response("{}", { status: 404 });
  });
});

afterEach(async () => {
  await root.unmount();
  vi.unstubAllGlobals();
});

describe("ACR 분포: a sheet read on the answer before (useAcrSheet)", () => {
  function Sheet({ first }: { first: { key: string; label: string } }) {
    const { read } = useAcrSheet(first as never, "|gemini");
    probe.value = read && "sheet" in read ? (read.sheet as unknown as { label: string } | null)?.label : read;
    return null;
  }

  it("is read again for the page's new answer, not when the chip moves", async () => {
    const w1 = Promise.resolve(VIEWS.W1);
    await root.render(shell(w1, <Sheet first={{ key: "|chatgpt", label: "W1-first" }} />));
    await settle();
    expect(probe.value).toBe("W1-sheet");
    await moveWeek();
    expect(nav.refresh).toHaveBeenCalledTimes(1);
    expect(reads).toEqual(["W1 /api/standard/acr/sheet"]);
    // router.refresh lands: the layout and the page anew, W2's first sheet with them
    await root.render(shell(Promise.resolve(VIEWS.W2), <Sheet first={{ key: "|chatgpt", label: "W2-first" }} />));
    await settle();
    expect(probe.value).toBe("W2-sheet");
    expect(reads).toEqual(["W1 /api/standard/acr/sheet", "W2 /api/standard/acr/sheet"]);
  });
});

describe("Website Mention 당사 대 비교: a picked brand's compare (usePicked)", () => {
  function Compare({ initial }: { initial: ReturnType<typeof parts> }) {
    const shown = usePicked(initial as never, "BMW", false);
    probe.value = shown.comparison?.target;
    return null;
  }

  it("the page's own head-to-head until the new answer's read of the pick lands, then that read", async () => {
    const w1 = Promise.resolve(VIEWS.W1);
    await root.render(shell(w1, <Compare initial={parts("Toyota", "W1")} />));
    await settle();
    expect(probe.value).toEqual({ brand: "BMW", share: 11.1 });
    await moveWeek();
    expect(reads).toEqual(["W1 /api/scope/mention-compare"]);
    const open = hold();
    await root.render(shell(Promise.resolve(VIEWS.W2), <Compare initial={parts("Toyota", "W2")} />));
    await settle();
    // the pick is read again: meanwhile the new answer's own, never the week before's pick
    expect(probe.value).toEqual({ brand: "Toyota", share: 22.2 });
    await open();
    await settle();
    expect(probe.value).toEqual({ brand: "BMW", share: 22.2 });
    expect(reads).toEqual(["W1 /api/scope/mention-compare", "W2 /api/scope/mention-compare"]);
  });
});

describe("the original Mention head-to-head: a picked target (useShownCompare)", () => {
  function HeadToHead({ vm }: { vm: ReturnType<typeof parts> }) {
    probe.value = useShownCompare(vm as never, { surface: "website" }, "BMW").comparison?.target ?? null;
    return null;
  }

  it("the new answer's own until the pick is read again for it, never the week before's pick", async () => {
    const w1 = Promise.resolve(VIEWS.W1);
    await root.render(shell(w1, <HeadToHead vm={parts("Toyota", "W1")} />));
    await settle();
    expect(probe.value).toEqual({ brand: "BMW", share: 11.1 });
    await moveWeek();
    expect(probe.value).toEqual({ brand: "BMW", share: 11.1 }); // the chip moved; the page is still the week before's
    const open = hold();
    await root.render(shell(Promise.resolve(VIEWS.W2), <HeadToHead vm={parts("Toyota", "W2")} />));
    await settle();
    expect(probe.value).toEqual({ brand: "Toyota", share: 22.2 });
    await open();
    await settle();
    expect(probe.value).toEqual({ brand: "BMW", share: 22.2 });
    expect(reads).toEqual(["W1 /api/scope/mention-compare", "W2 /api/scope/mention-compare"]);
  });

  it("a filter change keeps the comparison shown before until the pick answers again (as before)", async () => {
    const w1 = Promise.resolve(VIEWS.W1);
    await root.render(shell(w1, <HeadToHead vm={parts("Toyota", "W1")} />));
    await settle();
    const open = hold();
    nav.search = "geography=US&engine=gemini";
    await root.render(shell(w1, <HeadToHead vm={parts("Toyota", "W1")} />));
    await settle();
    expect(probe.value).toEqual({ brand: "BMW", share: 11.1 });
    await open();
    await settle();
    expect(reads).toEqual(["W1 /api/scope/mention-compare", "W1 /api/scope/mention-compare"]);
  });
});

describe("useServiceWeekReadState: a sheet opened over the page's answer", () => {
  const sheet = vi.hoisted(() => ({ open: null as null | ((row: string | null) => void) }));
  function Page() {
    const [row, setRow] = useServiceWeekReadState<string | null>(null);
    sheet.open = setRow;
    probe.value = row;
    return null;
  }

  it("closes when the page is read again; stays on a page change, a read of the week and the chip's move", async () => {
    const w1 = Promise.resolve(VIEWS.W1);
    await root.render(shell(w1, <Page />));
    await settle();
    await root.act(() => sheet.open!("kia.com"));
    expect(probe.value).toBe("kia.com");
    nav.search = "geography=US&engine=gemini";
    await root.render(shell(w1, <Page />));
    await settle();
    await moveWeek();
    expect(probe.value).toBe("kia.com");
    // the page read again: its numbers and reads were the week before's
    const w2 = Promise.resolve(VIEWS.W2);
    await root.render(shell(w2, <Page />));
    expect(probe.value).toBeNull();
    await root.act(() => sheet.open!("hyundai.com"));
    await root.render(shell(w2, <Page />));
    expect(probe.value).toBe("hyundai.com");
  });

  it("is useState without the shell", async () => {
    await root.render(<Page />);
    await root.act(() => sheet.open!("kia.com"));
    await root.render(<Page />);
    expect(probe.value).toBe("kia.com");
  });
});
