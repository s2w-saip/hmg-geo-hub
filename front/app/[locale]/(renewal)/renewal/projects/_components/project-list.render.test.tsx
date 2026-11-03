import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import type { ProjectRow } from "./project-model";

vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children, prefetch: _prefetch, ...rest }: { href: string; children: ReactNode; prefetch?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { RnProjectList } = await import("./project-list");

const row = (over: Partial<ProjectRow>): ProjectRow => ({
  id: "843ecb1b-39ff-4a7c-9b3a-0c3f7f8a9e10",
  prompts: 81,
  answers: 810,
  last_measured_day: "2026-10-06",
  countries: ["US"],
  engines: ["chatgpt", "gemini"],
  languages: ["en"],
  rounds: 1,
  custom_fields: 0,
  first_prompt: "Explain the trims, prices, colors and options for the Toyota RAV4",
  ...over,
});

const html = (rows: ProjectRow[]) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      <RnProjectList rows={rows} />
    </NextIntlClientProvider>,
  );
const rowOf = (out: string, id: string) => {
  const from = out.indexOf(`data-rn-project-row="${id}"`);
  return out.slice(from, out.indexOf("</tr>", from));
};

describe("Project list", () => {
  const measured = row({});
  const recent = row({ id: "e18507da-bdea-48cb-aa32-e9974ef54ead", prompts: 8, answers: 32, last_measured_day: "2026-10-09", countries: ["GB", "US"], custom_fields: 3 });
  const never = row({ id: "31f24722-0000-4000-8000-000000000002", prompts: 5, answers: 0, last_measured_day: null, countries: [], engines: [], languages: [], rounds: 0, first_prompt: null });

  it("lists every project, last measured first, told apart by its Gold values", () => {
    const out = html([measured, recent, never]);
    expect([...out.matchAll(/data-rn-project-row="([^"]+)"/g)].map(([, id]) => id.slice(0, 8))).toEqual(["e18507da", "843ecb1b", "31f24722"]);
    const r = rowOf(out, recent.id);
    expect(r).toContain(">e18507da<");
    expect(r).toContain("영국 · 미국");
    expect(r).toContain("ChatGPT · Gemini");
    expect(r).toContain(">2026-10-09<");
    expect(rowOf(out, measured.id)).toContain(measured.first_prompt);
    // never measured: no answers, rounds or countries — "—", and no prompt at all says so
    const n = rowOf(out, never.id);
    expect(n).toContain(ko.renewal.projects.noPrompt);
    expect(n.match(/>—</g)?.length).toBe(7);
  });

  it("opens a project in the one project tab (menu option D), saying so", () => {
    const r = rowOf(html([measured]), measured.id);
    const link = /<a href="([^"]+)"([^>]*)>/.exec(r);
    expect(link?.[1]).toBe(`/renewal/projects/${measured.id}`);
    expect(link?.[2]).toContain('target="hgh-project"');
    expect(r).toContain(`aria-label="${ko.renewal.projects.newTab}"`);
  });

  it("counts the projects with and without answers, and says why there is no name", () => {
    const out = html([measured, recent, never]);
    expect(out).toContain("전체 3");
    expect(out).toContain("답변 있음 2");
    expect(out).toContain("답변 없음 1");
    expect(out).toContain(ko.renewal.projects.noteTitle);
  });

  it("tells an empty Gold apart from an empty search", () => {
    expect(html([])).toContain(ko.renewal.projects.empty);
  });
});
