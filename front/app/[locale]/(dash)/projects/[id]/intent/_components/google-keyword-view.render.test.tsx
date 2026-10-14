import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";

// The server actions are not called by the static render; the write helpers below drive them.
const actions = vi.hoisted(() => ({
  addCandidate: vi.fn(),
  addCandidates: vi.fn(),
  addTrackedKeyword: vi.fn(),
  removeTrackedKeyword: vi.fn(),
  removeTrackedKeywords: vi.fn(),
}));
vi.mock("../_actions", () => actions);

const { GoogleKeywordView, addSerpRowsAsCandidates, rollbackOnThrow } = await import("./google-keyword-view");
const { withBusy } = await import("./keyword-search-start");

function render(ui: React.ReactNode) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      {ui}
    </NextIntlClientProvider>,
  );
}

describe("GoogleKeywordView smoke render", () => {
  it("renders the tab strip and the 선택 삭제 entry point", () => {
    const html = render(
      <GoogleKeywordView
        projectId="p1"
        canEdit
        projectCountry="KR"
        allowedCountries={["KR", "US"]}
        initialKeywords={[
          { id: "a", label: "아이오닉5" },
          { id: "b", label: "EV3" },
        ]}
      />,
    );
    expect(html).toContain("아이오닉5");
    expect(html).toContain("EV3");
    expect(html).toContain(ko.projectDetail.intent.googleKeyword.enterSelect);
  });

  it("hides the 선택 삭제 entry point for a read-only viewer", () => {
    const html = render(
      <GoogleKeywordView
        projectId="p1"
        canEdit={false}
        projectCountry="KR"
        allowedCountries={["KR"]}
        initialKeywords={[{ id: "a", label: "아이오닉5" }]}
      />,
    );
    expect(html).not.toContain(ko.projectDetail.intent.googleKeyword.enterSelect);
  });
});

describe("keyword writes recover their state when the server action throws", () => {
  class UnauthorizedError extends Error {}

  it("withBusy: the busy flag (add / 선택 삭제 / 검색 결과 저장 buttons) is cleared after an answer and after a throw", async () => {
    const flags: boolean[] = [];
    await expect(withBusy((b) => flags.push(b), async () => ({ ok: true }))).resolves.toEqual({ ok: true });
    expect(flags).toEqual([true, false]);

    flags.length = 0;
    const thrown = new UnauthorizedError("intent collection requires operator authority");
    await expect(
      withBusy(
        (b) => flags.push(b),
        async () => {
          throw thrown;
        },
      ),
    ).rejects.toBe(thrown);
    expect(flags).toEqual([true, false]); // was [true]: the button stayed disabled for good
  });

  it("rollbackOnThrow: the optimistically removed tab comes back when the delete throws; an answer is left to the caller", async () => {
    let tabs = ["a", "b"];
    const restore = () => {
      tabs = ["a", "b"];
    };
    tabs = ["a"]; // optimistic removal of "b"
    const thrown = new UnauthorizedError("intent collection requires operator authority");
    await expect(
      rollbackOnThrow(async () => {
        throw thrown;
      }, restore),
    ).rejects.toBe(thrown);
    expect(tabs).toEqual(["a", "b"]);

    tabs = ["a"];
    await expect(rollbackOnThrow(async () => ({ ok: false, error: "x" }), restore)).resolves.toEqual({ ok: false, error: "x" });
    expect(tabs).toEqual(["a"]); // ok:false keeps the caller's own rollback path
  });
});

describe("SERP rows to the candidate pool", () => {
  it("the checked rows go in ONE bulk action with the keyword as source, not one action per row", async () => {
    actions.addCandidates.mockResolvedValue({ ok: true, value: { count: 2, skipped: 1 } });
    const rows = [1, 2, 3].map((rank) => ({ id: `serp-${rank}`, rank, url: "u", title: "t", snippet: "s", suggestedPrompt: `Q${rank}` }));
    await expect(addSerpRowsAsCandidates("p1", "아이오닉5", rows)).resolves.toEqual({ ok: true, value: { count: 2, skipped: 1 } });
    expect(actions.addCandidates).toHaveBeenCalledTimes(1);
    expect(actions.addCandidates).toHaveBeenCalledWith("p1", "google_keyword", [
      { text: "Q1", sourceKeyword: "아이오닉5" },
      { text: "Q2", sourceKeyword: "아이오닉5" },
      { text: "Q3", sourceKeyword: "아이오닉5" },
    ]);
    expect(actions.addCandidate).not.toHaveBeenCalled();
  });
});
