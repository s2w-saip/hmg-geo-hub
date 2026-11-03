import { describe, expect, it, vi } from "vitest";
import ko from "@/messages/ko.json";
import { text, wrap } from "../../website/_overview/_fixtures";
import type { ProjectPromptRow, ProjectPromptsView } from "./project-prompts";

// Renewal Project › Prompt (2026-11-03, P4): Gold's prompts with a column per custom tag (read only), searched, sorted
// and paged here; the original's writes and status are named as the operations DB's.

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: () => {} }), usePathname: () => "/ko/renewal/projects/x/prompt", useSearchParams: () => new URLSearchParams("") }));
const { RnProjectPrompts, listedRows } = await import("./project-prompts");

const row = (over: Partial<ProjectPromptRow> & Pick<ProjectPromptRow, "id" | "text">): ProjectPromptRow => ({
  kind: "single", lang: null, funnel: null, regions: null, targets: [], answers: 4, firstMeasured: "2026-10-06", lastMeasured: "2026-10-09",
  rounds: ["2026-10-06", "2026-10-09"], countries: ["CA"], engineAnswers: { chatgpt: 2, gemini: 2 }, custom: {}, ...over,
});
const TOPIC = "784c45ea-8b19-48f5-9d56-32555ef20f25";
const MODEL = "e6592b86-a94b-4646-ab71-d70ed224670e";
const ROWS = [
  row({ id: "a", text: "Which SUV offers OTA updates?", custom: { [TOPIC]: "Technology", [MODEL]: "NX5" } }),
  row({ id: "b", text: "Quel SUV hybride ?", lang: "fr", answers: 2, lastMeasured: "2026-10-06", custom: { [TOPIC]: "AI" } }),
  row({ id: "c", text: "Never measured", answers: 0, lastMeasured: null, firstMeasured: null, rounds: [], countries: [], engineAnswers: {} }),
];
const VIEW: ProjectPromptsView = { rows: ROWS, listed: 3, fields: [{ id: MODEL, label: "Model Depth" }, { id: TOPIC, label: "Topic_Depth1" }], rounds: ["2026-10-06", "2026-10-09"] };
const P = ko.renewal.projects.prompts;

describe("project prompt list: search and sort", () => {
  it("finds a prompt by its text or a tag value", () => {
    expect(listedRows(ROWS, "ota", { key: "lastMeasured", asc: false }).map((r) => r.id)).toEqual(["a"]);
    expect(listedRows(ROWS, "technology", { key: "lastMeasured", asc: false }).map((r) => r.id)).toEqual(["a"]);
  });

  it("sorts by a tag column, empty values last either way", () => {
    expect(listedRows(ROWS, "", { key: `cf:${TOPIC}`, asc: true }).map((r) => r.id)).toEqual(["b", "a", "c"]);
    expect(listedRows(ROWS, "", { key: `cf:${TOPIC}`, asc: false }).map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(listedRows(ROWS, "", { key: "lastMeasured", asc: false }).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
});

describe("project prompt list: the table", () => {
  const out = wrap(<RnProjectPrompts id="35ae7ec0-a80a-4c88-a431-9698470aa94b" view={VIEW} lens={[]} />);

  it("has a column per tag, in Gold's field order, each row's value or a dash", () => {
    const heads = text(out.slice(out.indexOf("<thead"), out.indexOf("</thead>")));
    expect(heads.indexOf("Model Depth")).toBeLessThan(heads.indexOf("Topic_Depth1"));
    expect(out).toMatch(new RegExp(`data-rn-project-prompt-row="a".*?data-rn-tag="${MODEL}"[^>]*>.*?NX5`));
    expect(out).toMatch(new RegExp(`data-rn-project-prompt-row="b".*?data-rn-tag="${MODEL}"[^>]*><span[^>]*>—`));
  });

  it("names a prompt never measured, and the operations DB's writes and status", () => {
    expect(text(out)).toContain(ko.website.prompts.notMeasured);
    expect(text(out)).toContain(P.note);
    expect(text(out)).toContain("프롬프트 3개");
  });

  it("says when Gold has no prompt, and when the tags leave none", () => {
    expect(text(wrap(<RnProjectPrompts id="x" view={{ ...VIEW, rows: [], listed: 0 }} lens={[]} />))).toContain(P.empty);
    expect(text(wrap(<RnProjectPrompts id="x" view={{ ...VIEW, rows: [], listed: 3 }} lens={[]} />))).toContain(P.emptyFiltered);
  });
});
