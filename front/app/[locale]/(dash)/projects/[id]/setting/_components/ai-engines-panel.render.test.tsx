import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";

// Setting > AI 엔진 panel, static markup (#16). Engines outside the front vocabulary (`kept`) are carried
// without a control: the panel draws the same checkboxes, hint and history whether or not it carries them.
// The "collection stops" warning counts them only with keptCollects (api: the backend schedule measures
// them); legacy pushes only the front vocabulary to Scope, so no checkbox still stops collection there.
// The save path (kept sent back, state after the save) is in ai-engines-panel.save.test.tsx.

vi.mock("../_actions", () => ({ updateProjectEngines: vi.fn() }));
const { AiEnginesPanel } = await import("./ai-engines-panel");

const AE = ko.projectDetail.setting.aiEngines;
const HISTORY = [{ id: "h1", engines: ["chatgpt", "gemini"], changedAt: "2026-08-03T00:00:00.000Z" }];

function render(props: Partial<Parameters<typeof AiEnginesPanel>[0]> = {}) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      <AiEnginesPanel projectId="p1" initial={["chatgpt"]} explicit history={HISTORY} {...props} />
    </NextIntlClientProvider>,
  );
}

describe("AiEnginesPanel markup with and without kept engines (#16)", () => {
  it("same controls, hint, button and history: no kept prop, kept [], kept outside the vocabulary", () => {
    const before = render();
    expect(before).toContain('id="ps-engine-chatgpt"');
    expect(before).toContain('id="ps-engine-gemini"');
    expect(before).toContain('id="ps-engine-deepseek"');
    expect(before).toContain(AE.save);
    expect(render({ kept: [] })).toBe(before);
    expect(render({ kept: ["claude-web", "perplexity"] })).toBe(before);
    // No control or label for a kept code.
    expect(render({ kept: ["claude-web"] })).not.toContain("claude-web");
    // Read-only and legacy (not yet saved) states: unchanged too.
    expect(render({ kept: ["claude-web"], disabled: true })).toBe(render({ disabled: true }));
    expect(render({ kept: ["claude-web"], explicit: false })).toBe(render({ explicit: false }));
  });

  it("the 'collection stops' warning: shown when nothing is measured; not while a kept engine still is (api)", () => {
    expect(render({ initial: [] })).toContain(AE.noneWarning);
    expect(render({ initial: [], kept: [] })).toContain(AE.noneWarning);
    expect(render({ initial: [], kept: ["claude-web"], keptCollects: true })).not.toContain(AE.noneWarning);
    expect(render({ initial: [], kept: [], keptCollects: true })).toContain(AE.noneWarning);
    // legacy: Scope gets the front vocabulary only, so no checkbox stops collection even with kept engines
    expect(render({ initial: [], kept: ["claude-web"] })).toContain(AE.noneWarning);
    expect(render({ initial: ["gemini"] })).not.toContain(AE.noneWarning);
  });
});
