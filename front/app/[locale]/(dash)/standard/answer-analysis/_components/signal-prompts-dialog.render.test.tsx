import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import type { MentionsPromptLive } from "@/lib/scope/result-adapter";
import { readSignalReply, SignalPromptsBody, type SignalPromptsState } from "./signal-prompts-dialog";

// Signal drilldown dialog body (감정 분포 / Mention 유형 세그먼트), route reply -> state -> markup.
//   B008: when the route says the 50-row cap cut the list (`total` above the rows shown), one line
//         with the existing "{total}개 중 {shown}개 표시" copy follows the list. Without `total`
//         (or total = shown) the markup is the list alone, as before.

const SD = ko.answerAnalysis.mentions.signalDrilldown;
const CUT = ko.answerAnalysis.mentions.kpi.overview.unmeasuredDialog.truncated;
const cutLine = (shown: number, total: number) => CUT.replace("{total}", String(total)).replace("{shown}", String(shown));

const render = (state: SignalPromptsState) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      <SignalPromptsBody state={state} onSelect={() => undefined} />
    </NextIntlClientProvider>,
  );

const prompt = (id: string, text: string, answers = 1): MentionsPromptLive => ({
  id,
  promptText: text,
  mentions: 2,
  share: 20,
  funnelStage: null,
  providers: ["ChatGPT"],
  answers: Array.from({ length: answers }, (_, i) => ({
    jobId: `j-${id}-${i}`,
    provider: "ChatGPT",
    region: "US",
    mentionCount: 2,
    position: 1,
    highlights: { brand: [], model: [] },
    measuredAt: null,
    runs: 1,
  })),
});
const LIST = [prompt("p1", "best family SUV"), prompt("p2", "EV charging cost", 0)];

describe("readSignalReply (route 2xx body -> state)", () => {
  it("prompts only -> ready without total; a numeric total is kept; anything else is ignored", () => {
    expect(readSignalReply({ prompts: LIST })).toEqual({ status: "ready", list: LIST });
    expect(readSignalReply({})).toEqual({ status: "ready", list: [] });
    expect(readSignalReply({ prompts: LIST, total: 120 })).toEqual({ status: "ready", list: LIST, total: 120 });
    expect(readSignalReply({ prompts: LIST, total: "120" })).toEqual({ status: "ready", list: LIST });
  });
});

describe("SignalPromptsBody", () => {
  it("loading / error / empty use the existing texts", () => {
    expect(render({ status: "loading" })).toContain(SD.loading);
    expect(render({ status: "error" })).toContain(SD.error);
    expect(render({ status: "ready", list: [] })).toContain(SD.empty);
    expect(render({ status: "ready", list: [], total: 3 })).not.toContain(cutLine(0, 3));
  });

  it("a list that was not cut renders the list alone (no note), with or without total = shown", () => {
    const html = render({ status: "ready", list: LIST });
    expect(html.startsWith('<ul class="flex flex-col gap-2">')).toBe(true);
    expect(html.endsWith("</ul>")).toBe(true);
    expect(html).toContain("best family SUV");
    expect(html).toContain("EV charging cost");
    expect(render({ status: "ready", list: LIST, total: 2 })).toBe(html);
  });

  it("B008: a cut list adds the existing '{total}개 중 {shown}개 표시' line right after it", () => {
    const plain = render({ status: "ready", list: LIST });
    const cut = render({ status: "ready", list: LIST, total: 120 });
    expect(cut).toBe(`${plain}<p class="mt-2 text-[11px] text-muted-foreground">${cutLine(2, 120)}</p>`);
  });
});
