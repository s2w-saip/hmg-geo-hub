import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { TooltipProvider } from "@/components/ui/tooltip";
import ko from "@/messages/ko.json";
import type { CitationDomainLive, CitationPromptLive, MentionsPromptLive } from "@/lib/scope/result-adapter";
import { BrandCitationsPanel, BrandPromptsPanel, startListLoad, type ListState } from "./mentions-drilldown";
import { CitationPromptsDrilldown, startDomainDetailLoad, TruncatedNote, TRUNCATED_ROW_CLASS } from "./citation-domain-table";

// Brand drilldown tabs, route reply -> rendered state (no DOM in this repo: the effect bodies are
// exported and run with an injected fetch, the resulting state is rendered statically).
//   B005: a reply that is not 2xx (5xx JSON, 403 / 400 with the empty shape) is the existing error
//         state; only a 2xx empty list is "no prompts / no sources" (before: r.json() of any reply,
//         so an error body rendered as "no data").
//   B008: a list the route cut carries `total` and the table adds the existing
//         "{total}개 중 {shown}개 표시" line; without `total` (or total = shown) the markup is unchanged.

const DD = ko.answerAnalysis.mentions.drilldown;
const CUT = ko.answerAnalysis.mentions.kpi.overview.unmeasuredDialog.truncated;
const cutLine = (shown: number, total: number) => CUT.replace("{total}", String(total)).replace("{shown}", String(shown));

const render = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      <TooltipProvider>{node}</TooltipProvider>
    </NextIntlClientProvider>,
  );

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Run one list load with a canned route reply; the state it settles on. */
async function load<T>(key: "prompts" | "domains", res: Response): Promise<ListState<T>> {
  const seen: ListState<T>[] = [];
  startListLoad<T>("/api/scope/x", key, (s) => seen.push(s), (async () => res) as unknown as typeof fetch);
  await new Promise((r) => setTimeout(r, 0));
  expect(seen[0]).toEqual({ status: "loading" });
  return seen[seen.length - 1];
}

const prompt = (id: string, text: string): MentionsPromptLive => ({
  id,
  promptText: text,
  mentions: 3,
  share: 30,
  funnelStage: null,
  providers: ["ChatGPT"],
  answers: [
    { jobId: `j-${id}`, provider: "ChatGPT", region: "US", mentionCount: 3, position: 1, highlights: { brand: [], model: [] }, measuredAt: null, runs: 1 },
  ],
});
const domain = (skey: string): CitationDomainLive => ({
  domain: skey,
  citations: 4,
  share: 40,
  prompts: 2,
  coverageRate: 20,
  urls: [],
  promptList: [],
  isOurs: false,
  category: null,
  subcategory: null,
  skey,
});

const promptsHtml = (s: ListState<MentionsPromptLive>) => render(<BrandPromptsPanel state={s} brand="Toyota" />);
const citationsHtml = (s: ListState<CitationDomainLive>) => render(<BrandCitationsPanel state={s} detailQuery="mentionBrand=Toyota" />);

describe("B005 prompts tab: route reply -> state -> markup", () => {
  it("200 with prompts -> the table", async () => {
    const s = await load<MentionsPromptLive>("prompts", reply(200, { prompts: [prompt("p1", "best EV")] }));
    expect(s).toEqual({ status: "ready", list: [prompt("p1", "best EV")] });
    const html = promptsHtml(s);
    expect(html).toContain("best EV");
    expect(html).not.toContain(DD.promptsError);
    expect(html).not.toContain(DD.noPrompts);
  });
  it("5xx JSON, 403 {prompts:[]} and 400 {prompts:[]} -> the existing error state, not 'no prompts'", async () => {
    for (const res of [
      reply(500, { error: { code: "internal" } }),
      reply(503, { error: { code: "unavailable" } }),
      reply(403, { prompts: [] }),
      reply(400, { prompts: [] }),
    ]) {
      const s = await load<MentionsPromptLive>("prompts", res);
      expect(s).toEqual({ status: "error" });
      const html = promptsHtml(s);
      expect(html).toContain(DD.promptsError);
      expect(html).not.toContain(DD.noPrompts);
    }
  });
  it("200 with an empty list (brand_not_found included) -> 'no prompts'", async () => {
    const s = await load<MentionsPromptLive>("prompts", reply(200, { prompts: [] }));
    expect(promptsHtml(s)).toContain(DD.noPrompts);
  });
});

describe("B005 citation sources tab: route reply -> state -> markup", () => {
  it("200 with sources -> the domain table (rows named by skey)", async () => {
    const s = await load<CitationDomainLive>("domains", reply(200, { domains: [domain("linkedin.com/hyundai-motor-group"), domain("linkedin.com")] }));
    const html = citationsHtml(s);
    expect(html).toContain("linkedin.com/hyundai-motor-group");
    expect(html).not.toContain(DD.citationsError);
  });
  it("5xx JSON and 403 {domains:[]} -> the existing error state, not 'no sources'", async () => {
    for (const res of [reply(502, { error: { code: "bad_gateway" } }), reply(403, { domains: [] })]) {
      const s = await load<CitationDomainLive>("domains", res);
      const html = citationsHtml(s);
      expect(html).toContain(DD.citationsError);
      expect(html).not.toContain(DD.noCitations);
    }
  });
  it("200 with an empty list -> 'no sources'", async () => {
    expect(citationsHtml(await load<CitationDomainLive>("domains", reply(200, { domains: [] })))).toContain(DD.noCitations);
  });
});

describe("B008 truncation line: only when the route cut the list", () => {
  it("prompts: total > shown -> one line; no total or total = shown -> the same markup as before", async () => {
    const list = [prompt("p1", "best EV"), prompt("p2", "best SUV")];
    const cut = await load<MentionsPromptLive>("prompts", reply(200, { prompts: list, total: 250 }));
    expect(cut).toEqual({ status: "ready", list, total: 250 });
    const plain = promptsHtml({ status: "ready", list });
    expect(promptsHtml(cut)).toContain(cutLine(2, 250));
    expect(plain).not.toContain(cutLine(2, 250));
    expect(promptsHtml({ status: "ready", list, total: 2 })).toBe(plain);
    expect(promptsHtml(cut).replace(`<p class="${TRUNCATED_ROW_CLASS}">${cutLine(2, 250)}</p>`, "")).toBe(plain);
  });
  it("citation sources: the same rule under the domain table", async () => {
    const list = [domain("a.example")];
    const cut = await load<CitationDomainLive>("domains", reply(200, { domains: list, total: 900 }));
    expect(citationsHtml(cut)).toContain(cutLine(1, 900));
    expect(citationsHtml({ status: "ready", list })).toBe(citationsHtml({ status: "ready", list, total: 1 }));
    expect(citationsHtml({ status: "ready", list })).not.toContain(cutLine(1, 900));
  });
  it("row detail: urlTotal / promptTotal reach the state; the prompts list adds the line only when cut", async () => {
    let state: unknown = null;
    const setState = (next: unknown) => {
      state = typeof next === "function" ? (next as (p: unknown) => unknown)(state) : next;
    };
    startDomainDetailLoad("/api/scope/brand-citations?skey=a", setState as never, (async () =>
      reply(200, { urls: [{ url: "https://a.example/x" }], promptList: [], urlTotal: 37, promptTotal: 250 })) as unknown as typeof fetch);
    await new Promise((r) => setTimeout(r, 0));
    expect(state).toMatchObject({ status: "ready", urlTotal: 37, promptTotal: 250 });
    startDomainDetailLoad("/api/scope/brand-citations?skey=b", setState as never, (async () =>
      reply(200, { urls: [], promptList: [] })) as unknown as typeof fetch);
    await new Promise((r) => setTimeout(r, 0));
    expect(state).toEqual({ status: "ready", urls: [], promptList: [] });

    const p: CitationPromptLive = { id: "p1", promptText: "best EV", funnelStage: null, citations: 3, ownedCitations: 0, providers: ["Gemini"], answers: [] };
    const plain = render(<CitationPromptsDrilldown prompts={[p]} domain="a.example" />);
    expect(render(<CitationPromptsDrilldown prompts={[p]} domain="a.example" total={250} />)).toContain(cutLine(1, 250));
    expect(render(<CitationPromptsDrilldown prompts={[p]} domain="a.example" total={1} />)).toBe(plain);
    expect(render(<TruncatedNote shown={10} total={37} className="x" />)).toBe(`<p class="x">${cutLine(10, 37)}</p>`);
    expect(render(<TruncatedNote shown={10} className="x" />)).toBe("");
  });
});
