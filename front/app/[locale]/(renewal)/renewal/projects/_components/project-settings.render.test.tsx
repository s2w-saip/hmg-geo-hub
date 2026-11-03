import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import type { ProjectSettingsView } from "./project-settings";

// Renewal Project › Setting › General and Member (2026-11-03, read part): Gold's values under the original sections,
// 데이터 없음 for what only the operations DB holds; nothing editable (D-7).

vi.mock("next-intl/server", async () => {
  const { createTranslator } = await import("next-intl");
  const messages = (await import("@/messages/ko.json")).default;
  return {
    getLocale: async () => "ko",
    getTranslations: async (namespace: string) => createTranslator({ locale: "ko", messages, namespace: namespace as never }),
  };
});
const { RnProjectGeneral, RnProjectMember } = await import("./project-settings");

const VIEW: ProjectSettingsView = {
  identity: { projectId: "35ae7ec0-a80a-4c88-a431-9698470aa94b", scopeProjectId: "73fe7c0f-1b83-4d0b-88de-a94f7f58895e", regions: null },
  measured: { countries: ["CA"], engines: ["chatgpt", "gemini"], languages: [], rounds: 2, prompts: 96, answers: 384, lastMeasuredDay: "2026-10-09" },
  fields: [{ id: "f1", label: "Topic_Depth1", values: ["AI", "Design"], prompts: 96 }],
  targets: 0,
};
const S = ko.renewal.projects.setting;
const html = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>,
  );
const text = (s: string) => s.replace(/<[^>]+>/g, "");

describe("project Setting › General", () => {
  it("shows Gold's ids, measured values and tag fields, and 데이터 없음 for the operations DB's", async () => {
    const out = text(html(await RnProjectGeneral({ view: VIEW })));
    expect(out).toContain(`${S.general.name}${S.noData}`);
    expect(out).toContain(`${S.general.brand}${S.noData}`);
    expect(out).toContain("73fe7c0f-1b83-4d0b-88de-a94f7f58895e");
    expect(out).toContain(`${S.scope.regions}${S.scope.regionsNone}`);
    expect(out).toContain(`${S.scope.countries}캐나다 (CA)`);
    expect(out).toContain(`${S.engines.measured}ChatGPT, Gemini`);
    expect(out).toContain(`${S.tracked.owned}${S.noData}`);
    expect(out).toContain("타겟 URL을 지정한 프롬프트 0개");
    expect(out).toContain("Topic_Depth1AIDesign값 2개 · 프롬프트 96개");
    expect(out).toContain(S.note);
  });

  it("says when the project has no custom tag", async () => {
    expect(text(html(await RnProjectGeneral({ view: { ...VIEW, fields: [] } })))).toContain(S.tags.none);
  });
});

describe("project Setting › Member", () => {
  it("has no member data anywhere", async () => {
    const out = text(html(await RnProjectMember()));
    const M = ko.renewal.projects.member;
    for (const k of ["list", "roles", "invite", "audit"] as const) expect(out).toContain(`${M[k]}${M.noData}`);
    expect(out).toContain(M.note);
  });
});
