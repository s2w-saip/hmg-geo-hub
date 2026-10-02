import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import type { CitationDomainLive } from "@/lib/scope/result-adapter";
import { drilldownParams, projectIdFromPath } from "./mentions-drilldown";
import {
  CitationDomainTable,
  detailNeedsLoad,
  domainDetailUrl,
  rowLoadsDetail,
  startDomainDetailLoad,
} from "./citation-domain-table";

// Unit U6 component seams: the drilldown routes' parameters (project id from the path, own-row
// target, website surface) and the citation table's lazy detail for API rows (skey).

const PROJECT = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

describe("drilldown request parameters", () => {
  it("project id from a /projects/<id>/... path only", () => {
    expect(projectIdFromPath(`/ko/projects/${PROJECT}/analysis/mention`)).toBe(PROJECT);
    expect(projectIdFromPath("/ko/website/answer-analysis/mention")).toBeNull();
    expect(projectIdFromPath(null)).toBeNull();
  });
  it("keeps the screen's URL filters, adds the target and the surface (project wins over website)", () => {
    const p = drilldownParams("geography=US&time=2026-09-01..2026-09-14", {
      brand: "Kia",
      own: { code: "Kia" },
      isWebsite: true,
      projectId: PROJECT,
    });
    expect(Object.fromEntries(p)).toEqual({
      geography: "US",
      time: "2026-09-01..2026-09-14",
      mentionBrand: "Kia",
      own: "1",
      ownCode: "Kia",
      projectId: PROJECT,
    });
  });
  it("competitor row: no own flag; merged own row: own=1 without a code; website surface", () => {
    expect(drilldownParams("", { brand: "Toyota", isWebsite: true, projectId: null }).toString()).toBe("mentionBrand=Toyota&surface=website");
    expect(drilldownParams("", { brand: "HMG", own: { code: null }, isWebsite: false, projectId: null }).toString()).toBe("mentionBrand=HMG&own=1");
  });
});

const row = (o: Partial<CitationDomainLive> = {}): CitationDomainLive => ({
  domain: "a.example",
  citations: 3,
  share: 50,
  prompts: 2,
  coverageRate: 20,
  urls: [],
  promptList: [],
  isOurs: false,
  category: null,
  subcategory: null,
  ...o,
});

describe("citation table: API rows load their drilldown when opened", () => {
  it("only rows with skey and a detail query load", () => {
    expect(rowLoadsDetail(row({ skey: "a.example" }), "mentionBrand=Kia")).toBe(true);
    expect(rowLoadsDetail(row(), "mentionBrand=Kia")).toBe(false);
    expect(rowLoadsDetail(row({ skey: "a.example" }), undefined)).toBe(false);
  });
  it("detail URL = the route with the drilldown parameters and the skey (encoded)", () => {
    expect(domainDetailUrl("mentionBrand=Kia&surface=website", "linkedin.com/hyundai-motor-group")).toBe(
      "/api/scope/brand-citations?mentionBrand=Kia&surface=website&skey=linkedin.com%2Fhyundai-motor-group",
    );
  });
  it("API row: the prompts count is a button before the detail is loaded; legacy empty list: plain number", () => {
    const render = (r: CitationDomainLive, q?: string) =>
      renderToStaticMarkup(
        <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
          <CitationDomainTable domains={[r]} detailQuery={q} />
        </NextIntlClientProvider>,
      );
    expect(render(row({ skey: "a.example" }), "mentionBrand=Kia")).toContain("aria-expanded");
    expect(render(row())).not.toContain("aria-expanded");
  });
});

// U6 verification D2: a row closed before its detail reply, then reopened, must load again. The
// harness replays useDomainDetail's effect with React semantics (effect on open, cleanup on close,
// the guard reads the state of the render) over the exported effect body.
describe("citation detail: close before the reply, then reopen (U6 verification D2)", () => {
  type St = Parameters<typeof detailNeedsLoad>[0];
  function harness() {
    let state: St = null;
    const setState = (next: St | ((prev: St) => St)) => {
      state = typeof next === "function" ? next(state) : next;
    };
    const pending: { resolve: (r: Response) => void; signal: AbortSignal }[] = [];
    const fetchImpl = ((_u: string, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const signal = init!.signal!;
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        pending.push({ resolve, signal });
      })) as unknown as typeof fetch;
    let cleanup: (() => void) | undefined;
    const open = () => {
      // useDomainDetail: `if (!url || !active || !detailNeedsLoad(state)) return;`
      cleanup = detailNeedsLoad(state) ? startDomainDetailLoad("/api/scope/brand-citations?skey=a", setState, fetchImpl) : undefined;
    };
    const close = () => {
      cleanup?.();
      cleanup = undefined;
    };
    return { open, close, pending, state: () => state };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

  it("reopening after an aborted load fetches again and reaches ready", async () => {
    const h = harness();
    h.open();
    expect([h.state()?.status, h.pending.length]).toEqual(["loading", 1]);
    h.close();
    await flush();
    expect(h.state()).toBeNull();
    h.open();
    expect(h.pending.length).toBe(2);
    h.pending[1].resolve(reply({ urls: [{ url: "https://a.example/x" }], promptList: [] }));
    await flush();
    expect(h.state()).toMatchObject({ status: "ready", urls: [{ url: "https://a.example/x" }] });
  });
  it("twice closed early, then reopened: still loads (no stuck spinner)", async () => {
    const h = harness();
    h.open();
    h.close();
    h.open();
    h.close();
    await flush();
    h.open();
    expect(h.pending.length).toBe(3);
    h.pending[2].resolve(reply({ urls: [], promptList: [] }));
    await flush();
    expect(h.state()?.status).toBe("ready");
  });
  it("a finished load is kept across close and reopen (one fetch)", async () => {
    const h = harness();
    h.open();
    h.pending[0].resolve(reply({ urls: [], promptList: [] }));
    await flush();
    h.close();
    h.open();
    expect([h.state()?.status, h.pending.length]).toEqual(["ready", 1]);
  });
  it("an error is retried on reopen, as before", async () => {
    const h = harness();
    h.open();
    h.pending[0].resolve(new Response("x", { status: 500 }));
    await flush();
    expect(h.state()?.status).toBe("error");
    h.close();
    h.open();
    expect(h.pending.length).toBe(2);
  });
});
