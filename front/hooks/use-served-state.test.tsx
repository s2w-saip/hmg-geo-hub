import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLayoutEffect, type Dispatch, type SetStateAction } from "react";
import { clientRoot } from "@/test/client-root";
import { useServedState } from "./use-served-state";

// useServedState as the renewal Admin › 인용 출처 분류 lists keep Gold's latest round with the HUB's rows (교정 · 시드 ·
// 공식 소셜: hub_stores/source_overrides.py, source_lists.py, held to the service week): the page's answer first, the
// list's own reads (a reload after a save) after it. The shell re-reads the page once the service week moved
// (router.refresh(), components/service-week/sync.ts), which keeps a client component's state: with useState(initial)
// the list kept the round before under a chip naming the next week (review r2-7, 2026-11-03).

type Listing = { asOf: string; edited?: boolean };
// the lists the probe committed (what reached the screen), and its setter
const probe = vi.hoisted(() => ({ committed: [] as unknown[], set: null as unknown }));

/** A list as the managers hold it; draws nothing. */
function Probe({ served }: { served: Listing }) {
  const [list, setList] = useServedState(served);
  probe.set = setList;
  useLayoutEffect(() => {
    probe.committed.push(list);
  });
  return null;
}

const shown = () => probe.committed.at(-1);

beforeEach(() => {
  probe.committed = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useServedState", () => {
  it("a new answer of the page's takes the list's place at once; the list's own reads stay until then", async () => {
    const week1 = { asOf: "2026-10-05" };
    const root = clientRoot();
    await root.render(<Probe served={week1} />);
    expect(shown()).toBe(week1);
    // a save, then the list read again (the managers' reload)
    const saved = { asOf: "2026-10-05", edited: true };
    await root.act(() => (probe.set as Dispatch<SetStateAction<Listing>>)(saved));
    expect(shown()).toBe(saved);
    // a render of its own (a pick, a sheet opening): the same answer, the list stays
    await root.render(<Probe served={week1} />);
    expect(shown()).toBe(saved);
    // router.refresh() once the week moved: the page's answer of the next week, and no frame of the list before it
    const week2 = { asOf: "2026-10-12", edited: true };
    const before = probe.committed.length;
    await root.render(<Probe served={week2} />);
    expect(probe.committed.slice(before)).toEqual([week2]);
    await root.unmount();
  });
});
