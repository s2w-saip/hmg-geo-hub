import { describe, expect, it, vi } from "vitest";
import ko from "@/messages/ko.json";
import { text, wrap } from "../../website/_overview/_fixtures";
import type { ProjectPromptRow, ProjectPromptsView } from "./project-prompts";

// Renewal Project › Prompt (2026-11-03): the HUB's prompts (the 정본) with a column per custom tag, each compared with Gold,
// searched, sorted, filtered by status and paged here; the original's writes where the HUB holds the project, Gold's rows read
// only where it does not.

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: () => {}, refresh: () => {} }), usePathname: () => "/ko/renewal/projects/x/prompt", useSearchParams: () => new URLSearchParams("") }));
const { RnProjectPrompts, inTab, isEditable, listedRows } = await import("./project-prompts");

const row = (over: Partial<ProjectPromptRow> & Pick<ProjectPromptRow, "id" | "text">): ProjectPromptRow => ({
  kind: "single", lang: null, funnel: null, regions: null, targets: [], answers: 4, firstMeasured: "2026-10-06", lastMeasured: "2026-10-09",
  rounds: ["2026-10-06", "2026-10-09"], countries: ["CA"], engineAnswers: { chatgpt: 2, gemini: 2 }, custom: {}, status: "active", state: "applied",
  version: 1, origin: "gold", ...over,
});
const TOPIC = "784c45ea-8b19-48f5-9d56-32555ef20f25";
const MODEL = "e6592b86-a94b-4646-ab71-d70ed224670e";
const ROWS = [
  row({ id: "a", text: "Which SUV offers OTA updates?", custom: { [TOPIC]: "Technology", [MODEL]: "NX5" } }),
  row({ id: "b", text: "Quel SUV hybride ?", lang: "fr", answers: 2, lastMeasured: "2026-10-06", custom: { [TOPIC]: "AI" }, state: "pending" }),
  row({ id: "c", text: "Never measured", answers: 0, lastMeasured: null, firstMeasured: null, rounds: [], countries: [], engineAnswers: {}, status: "draft", state: "draft", origin: "hub" }),
];
const FIELDS: ProjectPromptsView["fields"] = [
  { id: MODEL, label: "Model Depth", archived: false, state: "applied" },
  { id: TOPIC, label: "Topic_Depth1", archived: false, state: "applied" },
  { id: "gone", label: "Old tag", archived: true, state: "pending" },
];
const VIEW: ProjectPromptsView = { rows: ROWS, listed: 3, fields: FIELDS, editable: true, languages: ["en", "ko"], rounds: ["2026-10-06", "2026-10-09"] };
const P = ko.renewal.projects.prompts;

describe("project prompt list: status, search and sort", () => {
  it("finds a prompt by its text or a tag value", () => {
    expect(listedRows(ROWS, "ota", { key: "lastMeasured", asc: false }).map((r) => r.id)).toEqual(["a"]);
    expect(listedRows(ROWS, "technology", { key: "lastMeasured", asc: false }).map((r) => r.id)).toEqual(["a"]);
  });

  it("sorts by a tag column, empty values last either way, and by status (drafts first)", () => {
    expect(listedRows(ROWS, "", { key: `cf:${TOPIC}`, asc: true }).map((r) => r.id)).toEqual(["b", "a", "c"]);
    expect(listedRows(ROWS, "", { key: `cf:${TOPIC}`, asc: false }).map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(listedRows(ROWS, "", { key: "lastMeasured", asc: false }).map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(listedRows(ROWS, "", { key: "status", asc: true }).map((r) => r.id)).toEqual(["c", "a", "b"]);
  });

  it("puts drafts, measured and paused prompts under 전체 and deleted ones apart; only live HUB rows are writable", () => {
    expect(["draft", "active", "paused"].every((s) => inTab(s as ProjectPromptRow["status"], "live"))).toBe(true);
    expect(inTab("archived", "live") || inTab("removed", "live")).toBe(false);
    expect(inTab("archived", "deleted") && inTab("removed", "deleted")).toBe(true);
    expect(isEditable(ROWS[0])).toBe(true);
    expect(isEditable({ ...ROWS[0], status: "archived" })).toBe(false);
    expect(isEditable({ ...ROWS[0], version: null, state: "upstream" })).toBe(false);
  });
});

describe("project prompt list: the editable table", () => {
  const out = wrap(<RnProjectPrompts id="35ae7ec0-a80a-4c88-a431-9698470aa94b" view={{ ...VIEW, rows: [...ROWS, row({ id: "d", text: "Deleted one", status: "archived" })] }} lens={[]} />);

  it("has a column per unarchived tag, in the HUB's order, each row's value or a dash, editable in place", () => {
    const heads = text(out.slice(out.indexOf("<thead"), out.indexOf("</thead>")));
    expect(heads.indexOf("Model Depth")).toBeLessThan(heads.indexOf("Topic_Depth1"));
    expect(heads).not.toContain("Old tag");
    expect(out).toMatch(new RegExp(`data-rn-project-prompt-row="a".*?data-rn-tag="${MODEL}"[^>]*><button[^>]*data-rn-tag-cell[^>]*>.*?NX5`));
    expect(out).toMatch(new RegExp(`data-rn-project-prompt-row="b".*?data-rn-tag="${MODEL}"[^>]*><button[^>]*><span[^>]*>—`));
  });

  it("shows the HUB status, the rows not yet in Gold, and leaves deleted rows to their tab", () => {
    expect(out).toMatch(/data-rn-project-prompt-row="c"[^>]*data-rn-status="draft".*?초안/);
    expect(out).toMatch(/data-rn-project-prompt-row="b".*?data-rn-prompt-state="pending"[^>]*>.*?반영 대기/);
    const rowA = out.slice(out.indexOf('data-rn-project-prompt-row="a"'), out.indexOf("</tr>", out.indexOf('data-rn-project-prompt-row="a"')));
    expect(rowA).not.toContain("data-rn-prompt-state");   // applied: nothing to say
    expect(out).not.toContain('data-rn-project-prompt-row="d"');
    expect(text(out)).toContain("전체 3");
    expect(text(out)).toContain("삭제됨 1");
    expect(text(out)).toContain("프롬프트 3개");
  });

  it("offers the original's writes: add, tags, a checkbox per live row; the Scope run waits", () => {
    for (const attr of ["data-rn-project-prompt-add-open", "data-rn-project-tags-open", 'data-rn-select-row="a"', "data-rn-select-page"]) expect(out).toContain(attr);
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*data-rn-project-run=""/);
    expect(text(out)).toContain("초안 1개");
    expect(text(out)).toContain(P.runTip);
    expect(text(out)).toContain(P.note.slice(0, 40));
  });

  it("says when the project has no prompt, and when the tags leave none", () => {
    expect(text(wrap(<RnProjectPrompts id="x" view={{ ...VIEW, rows: [], listed: 0 }} lens={[]} />))).toContain(P.empty);
    expect(text(wrap(<RnProjectPrompts id="x" view={{ ...VIEW, rows: [], listed: 3 }} lens={[]} />))).toContain(P.emptyFiltered);
  });
});

describe("project prompt messages", () => {
  it("never quote a placeholder (ICU reads '{x}' as literal text)", () => {
    const strings = (o: unknown): string[] => (typeof o === "string" ? [o] : o && typeof o === "object" ? Object.values(o).flatMap(strings) : []);
    expect(strings(P).filter((s) => /'\{|\}'/.test(s))).toEqual([]);
  });
});

describe("project prompt list: Gold's rows read only", () => {
  const out = wrap(<RnProjectPrompts id="x" view={{ ...VIEW, editable: false, rows: ROWS.map((r) => ({ ...r, version: null })) }} lens={[]} />);

  it("has no write control and says why", () => {
    for (const attr of ["data-rn-project-prompt-add-open", "data-rn-project-tags-open", "data-rn-select-row", "data-rn-tag-cell", "data-rn-project-run"]) expect(out).not.toContain(attr);
    expect(text(out)).toContain(P.noteReadOnly.slice(0, 40));
    expect(text(out)).toContain(ko.website.prompts.notMeasured);
  });
});
