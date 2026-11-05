import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import ko from "@/messages/ko.json";
import { TILES, part, settled, text, wrap } from "../../website/_overview/_fixtures";
import type { ProjectStatusView } from "./project-dashboard";
import { FEEDBACK_EMAIL_TEXT } from "@/lib/support-contact";

// Renewal Project › Dashboard (2026-11-03, P2): the website Overview's sections on the project surface. The tiles open
// the project's own analysis pages in the project tab (one tab per project, menu option D); ⑤ reads the project's own
// URLs (Gold: project 자사 = loc_owned); the original tiles Gold does not have say 데이터 없음.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  usePathname: () => "/ko/renewal/projects/35ae7ec0-a80a-4c88-a431-9698470aa94b",
  useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children, prefetch: _prefetch, ...rest }: { href: string; children: ReactNode; prefetch?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { RnFilterRuntime } = await import("../../_components/filter-runtime");
const { RnOverviewFilters } = await import("../../_components/overview-filters");
const { RnProjectDashboardBody, RnProjectStatus, projectDetailHref } = await import("./project-dashboard");

const ID = "35ae7ec0-a80a-4c88-a431-9698470aa94b";
const STATUS: ProjectStatusView = {
  facts: { prompts: 96, measuredPrompts: 96, answers: 384, rounds: 2, countries: ["CA"], engines: ["chatgpt", "gemini"], customFields: 5, lastMeasuredDay: "2026-10-09" },
  recent: [{ promptId: "p1", text: "Which SUV offers the safest and most reliable AI-powered features?", answers: 4, lastMeasuredDay: "2026-10-09" }],
};
const D = ko.renewal.projects.dashboard;

function body() {
  return wrap(
    <RnFilterRuntime>
      <RnOverviewFilters props={{ surface: "project", scope: { all: true }, geographyOptions: ["CA"], engineOptions: ["chatgpt", "gemini"] }} savedFilters={{ page: "project-dashboard", userId: "t", initial: [] }}>
        <RnProjectDashboardBody
          id={ID}
          tiles={TILES}
          qs="engine=gemini"
          reads={{
            deferred: settled(TILES),
            engines: settled({ engines: [], consistency: {}, extremes: {}, widest: null, degraded: false }),
            trend: settled({ trend: null }),
            composition: settled({ topics: [], sources: [{ domain: "caranddriver.com", citations: 315, share: 7.9, isOurs: false }], degraded: false }),
            status: settled(STATUS),
          }}
        />
      </RnOverviewFilters>
    </RnFilterRuntime>,
  );
}

describe("renewal Project Dashboard", () => {
  const out = body();

  it("opens each tile's project analysis page in this tab, with the filters", () => {
    const v = part(out, "data-rn-kpi", "visibility");
    expect(v).toContain(`href="/ko/renewal/projects/${ID}/analysis/mention?kpi=exposure&amp;engine=gemini"`);
    expect(v).not.toContain('target="_blank"');
    expect(part(out, "data-rn-kpi", "citationAccuracy")).toContain(`href="/ko/renewal/projects/${ID}/analysis/citation?engine=gemini"`);
    expect(projectDetailHref(ID, "trafficConversion", "")).toBe(`/renewal/projects/${ID}/ai-funnel/conversion`);
  });

  it("links the source composition to the project's Citation page in this tab", () => {
    const head = out.slice(out.indexOf(ko.renewal.website.overview.sourcesDetail) - 400, out.indexOf(ko.renewal.website.overview.sourcesDetail));
    expect(head).toContain(`href="/ko/renewal/projects/${ID}/analysis/citation?engine=gemini"`);
    expect(head).not.toContain('target="_blank"');
  });

  it("shows the project status: Gold's facts, 데이터 없음 for what only the operations DB has, the latest prompts", () => {
    const s = text(out.slice(out.indexOf("data-rn-project-status")));
    expect(s).toContain(`${D.facts.prompts}96${"측정 96개"}`);
    expect(s).toContain(`${D.facts.answers}384${"2회차"}`);
    expect(s).toContain(`${D.facts.last}2026-10-09`);
    for (const k of ["candidates", "members", "status"] as const) expect(s).toContain(`${D.facts[k]}${D.noData}`);
    expect(s).toContain("Which SUV offers the safest and most reliable AI-powered features?답변 42026-10-09");
    expect(out).toContain(`href="/renewal/projects/${ID}/prompt"`);
  });
});

describe("renewal Project Dashboard: status card", () => {
  it("says it could not read the status", () => {
    expect(text(wrap(<RnProjectStatus id={ID} status={settled("failed" as const)} />))).toContain(D.statusFailed.replace("{contact}", FEEDBACK_EMAIL_TEXT));
  });
});
